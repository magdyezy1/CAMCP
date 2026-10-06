import test from 'node:test';
import assert from 'node:assert/strict';
import {wooSourceFixture} from './fixtures/woocommerce-source-data.mjs';
import {wooCommerceSources} from '../dist/src/woocommerce-source.js';
import {actionContracts} from '../dist/src/action-contracts.js';

const run = (f, args = {}, actor = f.actor) =>
  f.service.call('commerce_native_action', {operation: 'woocommerce_list_stores', arguments: args}, actor);
const noEffects = f => {
  assert.equal(f.calls.length, 0);
  for (const kind of ['campaign', 'write_review', 'report', 'commerce_snapshot'])
    assert.equal(f.store.documents(f.actor.tenantId, kind).length, 0);
};
for (const role of ['reader', 'operator', 'admin'])
  test(role + ' discovers configured store identity without decrypting credentials or provider access', async () => {
    const f = wooSourceFixture({role});
    try {
      const before = f.store.listConnections(f.actor.tenantId);
      f.store.connectionCredentials = () => {
        throw Error('Credentials must not be opened');
      };
      const out = await run(f);
      assert.equal(out.success, true, JSON.stringify(out));
      assert.equal(out.data.record_kind, 'configured_woocommerce_stores');
      assert.deepEqual(out.data.stores, [
        {
          connection_id: 'woo-login',
          account_id: 'store-1',
          label: 'Synthetic store',
          store_origin: 'https://shop.example.test',
          configuration_enabled: true,
        },
      ]);
      assert.equal(out.data.coverage.live_access_verified, false);
      assert.equal(out.data.coverage.removed_configuration_history, false);
      assert.equal(out.data.provider_mutations, 0);
      assert.equal(out.data.credentials_disclosed, false);
      assert.equal(out.data.network_requests, 0);
      assert.doesNotMatch(JSON.stringify(out), /synthetickey|syntheticsecret|consumerKey|consumerSecret/);
      assert.deepEqual(f.store.listConnections(f.actor.tenantId), before);
      noEffects(f);
    } finally {
      f.close();
    }
  });

test('optional disabled configurations remain explicit; the original website projection stays unchanged', async () => {
  const f = wooSourceFixture();
  try {
    f.store.putConnection(
      {...f.actor, role: 'admin'},
      {...f.connection, id: 'woo-disabled', accounts: ['disabled-store'], enabled: false},
      f.credentials,
    );
    const original = wooCommerceSources(f.store, f.actor);
    assert.equal(original.items.length, 1);
    assert.equal(Object.hasOwn(original.items[0], 'configuration_enabled'), false);
    assert.equal((await run(f)).data.stores.length, 1);
    const out = await run(f, {include_disconnected: true});
    assert.equal(out.success, true);
    assert.equal(out.data.stores.length, 2);
    assert.equal(out.data.stores.find(s => s.connection_id === 'woo-disabled').configuration_enabled, false);
    assert.equal(out.data.coverage.includes_disabled, true);
    assert.equal(out.data.coverage.removed_configuration_history, false);
    noEffects(f);
  } finally {
    f.close();
  }
});

test('foreign tenants, unsupported versions, missing read scopes and non-HTTPS origins are excluded', async () => {
  const f = wooSourceFixture();
  try {
    for (const extra of [
      {id: 'old-version', apiVersion: 'wc/v2'},
      {id: 'write-only', scopes: ['write']},
      {id: 'bad-origin', baseUrl: 'http://shop.example.test'},
    ])
      f.store.putConnection(
        {...f.actor, role: 'admin'},
        {...f.connection, ...extra, label: 'EXCLUDED-WOO'},
        f.credentials,
      );
    const foreign = {...f.actor, tenantId: 'foreign-woo-discovery', role: 'admin'};
    f.store.putConnection(
      foreign,
      {...f.connection, tenantId: foreign.tenantId, id: 'foreign', label: 'FOREIGN-WOO'},
      f.credentials,
    );
    const out = await run(f, {include_disconnected: true});
    assert.equal(out.success, true);
    assert.equal(out.data.stores.length, 1);
    assert.doesNotMatch(JSON.stringify(out), /FOREIGN-WOO|EXCLUDED-WOO/);
    noEffects(f);
  } finally {
    f.close();
  }
});

test('authority revoked during the metadata read refuses before returning store identities', async () => {
  const f = wooSourceFixture({role: 'operator'});
  try {
    const key = f.store.createKey(f.actor),
      actor = f.store.authenticate(key),
      list = f.store.listConnections.bind(f.store);
    f.store.listConnections = tenant => {
      const rows = list(tenant);
      f.store.revokeKey(key);
      return rows;
    };
    const out = await run(f, {}, actor);
    assert.equal(out.success, false);
    assert.equal(out.data, undefined);
    assert.doesNotMatch(JSON.stringify(out), /Synthetic store|shop\.example/);
    noEffects(f);
  } finally {
    f.close();
  }
});

test('1,000 configurations fit; an over-limit collection is wholly refused', async () => {
  const f = wooSourceFixture();
  try {
    const rows = Array.from({length: 1001}, (_, i) => ({...f.connection, id: 'woo-' + i, accounts: ['store-' + i]}));
    f.store.listConnections = () => rows.slice(0, 1000);
    assert.equal((await run(f)).data.stores.length, 1000);
    f.store.listConnections = () => rows;
    const out = await run(f);
    assert.equal(out.success, false);
    assert.equal(out.error.code, 'REPORT_COLLECTION_LIMIT');
    assert.equal(out.error.details.maximum_stores, 1000);
    assert.equal(out.data, undefined);
    noEffects(f);
  } finally {
    f.close();
  }
});

test('UTF-8 response bytes impose an independent whole-response bound', async () => {
  const f = wooSourceFixture();
  try {
    f.store.listConnections = () =>
      Array.from({length: 1000}, (_, i) => ({
        ...f.connection,
        id: ('woo-' + i).padEnd(160, '_'),
        accounts: [('store-' + i).padEnd(160, '_')],
        label: 'م'.repeat(200),
        baseUrl: 'https://' + ('a'.repeat(63) + '.').repeat(3) + 'b'.repeat(50) + '.test',
      }));
    const out = await run(f);
    assert.equal(out.success, false);
    assert.equal(out.error.code, 'REPORT_COLLECTION_LIMIT');
    assert.equal(out.error.details.maximum_bytes, 1048576);
    assert.equal(out.data, undefined);
    noEffects(f);
  } finally {
    f.close();
  }
});

test('captured inputs stay strict and unrelated commerce operations remain unqualified', async () => {
  const f = wooSourceFixture();
  try {
    for (const args of [
      {include_disconnected: 'true'},
      {url: 'https://other.example.test'},
      {consumer_secret: 'UNUSED-SECRET'},
    ])
      assert.equal((await run(f, args)).success, false);
    const out = await f.service.call(
      'commerce_native_action',
      {operation: 'woocommerce_store_ops', arguments: {action: 'LIST_PRODUCTS', label: 'Synthetic store'}},
      f.actor,
    );
    assert.equal(out.success, false);
    assert.equal(out.error.code, 'WORKFLOW_ADAPTER_REQUIRED');
    const rows = actionContracts(f.service.registry).filter(r => r.gateway === 'commerce_native_action');
    assert.equal(rows.length, 31);
    assert.equal(rows.filter(r => r.status === 'local_workflow').length, 1);
    assert.equal(rows.filter(r => r.status === 'unmapped').length, 30);
    assert.equal(rows.find(r => r.operation === 'woocommerce_list_stores').method, null);
    noEffects(f);
  } finally {
    f.close();
  }
});

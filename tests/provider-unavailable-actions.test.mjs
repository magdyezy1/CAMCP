import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {unsupportedProviderAliases} from '../dist/src/retired-provider-actions.js';
const registry = new Registry(),
  gateway = 'google_ads_native_action',
  actor = {tenantId: 'unsupported', userId: 'reader', role: 'reader'};
test('Unsupported customizer update does not retire its valid create/remove RPC or legacy aliases', async () => {
  const store = new Store(':memory:');
  try {
    const service = new MirrorService(
      registry,
      store,
      new NativeTransport(async () => {
        throw Error('No egress');
      }),
    );
    for (const args of [
      {
        action: 'CREATE_CUSTOMIZER_ATTRIBUTE',
        account_id: '123',
        payload: {resource: {name: 'Replacement', type: 'TEXT'}},
      },
      {action: 'REMOVE_CUSTOMIZER_ATTRIBUTE', account_id: '123', payload: {entity_id: '77'}},
      {
        action: 'google_ads_v23_customizer_attribute_mutate_customizer_attributes',
        account_id: '123',
        payload: {
          operations: [{create: {name: 'Replacement', type: 'TEXT'}}],
          partialFailure: false,
          validateOnly: false,
        },
      },
    ]) {
      const out = await service.call('amcp_write', {action: 'inspect', gateway, arguments: args}, actor);
      assert.equal(out.success, true, JSON.stringify(out));
      assert.equal(out.data.review_contract_supported, true, JSON.stringify(out));
      assert.equal(out.data.network_requests, 0);
      const row = actionContracts(registry).find(r => r.gateway === gateway && r.action === args.action);
      assert.equal(row.status, 'reviewed_write_family');
    }
  } finally {
    store.close();
  }
});
test('Google customizer update is explicitly provider unsupported before credentials or network', async () => {
  const store = new Store(':memory:');
  let calls = 0;
  try {
    const service = new MirrorService(
      registry,
      store,
      new NativeTransport(async () => {
        calls++;
        throw Error('No egress');
      }),
    );
    const args = {
      action: 'UPDATE_CUSTOMIZER_ATTRIBUTE',
      account_id: '123',
      payload: {entity_id: '77', resource: {name: 'Revised'}, update_mask: 'name'},
      dry_run: false,
    };
    const result = await service.call(gateway, args, actor);
    assert.equal(result.error.code, 'PROVIDER_ACTION_UNSUPPORTED', JSON.stringify(result));
    assert.match(result.error.details.source, /customizer_attribute_service/);
    assert.match(result.error.details.replacement, /new attribute/i);
    const inspect = await service.call('amcp_write', {action: 'inspect', gateway, arguments: args}, actor);
    assert.equal(inspect.data.review_contract_supported, false);
    assert.equal(inspect.data.error.code, 'PROVIDER_ACTION_UNSUPPORTED');
    assert.equal(
      actionContracts(registry).find(r => r.gateway === gateway && r.action === args.action).status,
      'provider_unsupported',
    );
    assert.equal(calls, 0);
  } finally {
    store.close();
  }
});
test('Every captured Google legacy MUTATE alias is checked against its native operation union', () => {
  const mapping = JSON.parse(fs.readFileSync('src/google-legacy-mapping.json', 'utf8')),
    d = mapping.googleProto.descriptors,
    unsupported = [];
  const entries = mapping.entries.filter(e => e.kind === 'MUTATE');
  assert.equal(entries.length, 95);
  for (const entry of entries) {
    const request = d[mapping.googleProto.rpcRequests[entry.canonical]],
      field = request?.fields?.operations ?? request?.fields?.operation;
    assert.ok(field, entry.name);
    const operation = d[field.type] ?? d['google.ads.googleads.v25.services.' + field.type];
    assert.ok(operation, entry.name);
    if (!operation.fields[entry.verb]) unsupported.push(entry.name);
  }
  // The MUTATE aliases refused by name are exactly those whose verb the union lacks; the others the list refuses
  // (lifecycle goals, campaign brand safety) lost their operation in Google Ads v25 (tests/google-version.test.mjs).
  assert.deepEqual(
    unsupported.sort(),
    unsupportedProviderAliases
      .filter(a => a.gateway === gateway && entries.some(e => e.name === a.action))
      .map(a => a.action)
      .sort(),
  );
  const evidence = JSON.parse(fs.readFileSync('tests/fixtures/audience-availability-evidence.json', 'utf8'));
  assert.deepEqual(evidence.google.supported_verbs, ['create', 'remove']);
});

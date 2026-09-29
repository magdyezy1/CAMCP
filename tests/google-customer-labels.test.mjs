import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Removing manager labels from a Google Ads customer (CustomerLabelService.MutateCustomerLabels, Google Ads API v25
 * discovery document pinned in .mirror/VENDOR/google-ads-v25.json): a remove names
 * `customers/{customer_id}/customerLabels/{label_id}`. Creation stays refused: the same document marks both fields of
 * CustomerLabel output only and gives a create no resource name.
 */
const gateway = 'google_ads_native_action',
  registry = new Registry(),
  action = 'google_ads_v23_customer_label_mutate_customer_labels';
const actor = {tenantId: 'google-customer-labels', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const rn = id => 'customers/123/customerLabels/' + id;
function fixture(mode = '') {
  const store = new Store(':memory:', Buffer.alloc(32, 87).toString('base64')),
    calls = [];
  let writes = 0;
  store.putConnection(
    owner,
    {
      id: 'g',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Google',
      scopes: ['https://www.googleapis.com/auth/adwords'],
      accountLoginCustomers: {123: '999'},
    },
    {accessToken: 'synthetic'},
  );
  const labels = new Map(
    ['41', '42', '43'].map(id => [
      rn(id),
      {resourceName: rn(id), customer: 'customers/123', label: 'customers/999/labels/' + id},
    ]),
  );
  const transport = new NativeTransport(
    async (url, init) => {
      const path = new URL(String(url)).pathname,
        body = JSON.parse(String(init.body)),
        headers = new Headers(init.headers);
      calls.push({path, body, login: headers.get('login-customer-id')});
      if (path === '/v25/customers/123/googleAds:search') {
        if (mode === 'foreign')
          return Response.json({
            results: [{customerLabel: {resourceName: 'customers/555/customerLabels/41', customer: 'customers/555'}}],
          });
        const rows = [...labels.values()].filter(l => body.query.includes("'" + l.resourceName + "'"));
        return Response.json({
          ...(rows.length ? {results: rows.map(l => ({customerLabel: {...l}}))} : {}),
          fieldMask: 'x',
        });
      }
      if (path !== '/v25/customers/123/customerLabels:mutate') throw new Error('Unexpected ' + path);
      writes++;
      if (mode !== 'ignore') for (const op of body.operations) labels.delete(op.remove);
      return Response.json({results: body.operations.map(op => ({resourceName: op.remove}))});
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    100,
  );
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const prepare = (operations, extra = {}) =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action, account_id: '123', payload: {operations, ...extra}}},
      actor,
    );
  const execute = p =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true},
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, labels, prepare, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('removing manager labels from the customer reads them, removes them atomically and verifies they are gone', async () => {
  const f = fixture();
  try {
    const p = ok(await f.prepare([{remove: rn('41')}, {remove: rn('42')}]));
    assert.equal(p.data.request.destructive, true);
    assert.equal(p.data.creative_impact.scope, 'customer_label');
    assert.deepEqual(
      p.data.creative_impact.labels.map(l => l.label),
      ['customers/999/labels/41', 'customers/999/labels/42'],
    );
    assert.equal(f.writes(), 0);
    ok(await f.execute(p));
    assert.deepEqual([...f.labels.keys()], [rn('43')]);
    // Reads and the removal go out under the manager that owns the labels.
    assert.ok(f.calls.every(c => c.login === '999'));
    const v = ok(await f.verify(p));
    assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 900));
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
  const o = fixture();
  try {
    saveSpendPolicy(o.store, owner, {gateway, account_id: '123', confirmed: true, policy: {allow_deletion: false}});
    assert.equal((await o.prepare([{remove: rn('41')}])).error?.code, 'POLICY_DELETION_FORBIDDEN');
  } finally {
    o.store.close();
  }
});

test('creation, other customers, partial failure, validation-only and duplicates are refused before any request', async () => {
  for (const [label, ops, extra] of [
    ['create', [{create: {label: 'customers/999/labels/41'}}], {}],
    ['create beside remove', [{remove: rn('41')}, {create: {}}], {}],
    ['other customer', [{remove: 'customers/555/customerLabels/41'}], {}],
    ['malformed id', [{remove: rn('4a')}], {}],
    ['duplicate', [{remove: rn('41')}, {remove: rn('41')}], {}],
    ['partial failure', [{remove: rn('41')}], {partialFailure: true}],
    ['validate only', [{remove: rn('41')}], {validateOnly: true}],
    ['update mask', [{remove: rn('41'), updateMask: 'label'}], {}],
    ['empty', [], {}],
  ]) {
    const f = fixture();
    try {
      const r = await f.prepare(ops, extra);
      assert.equal(r.success, false, label);
      assert.equal(f.calls.length, 0, label + ': ' + JSON.stringify(r).slice(0, 300));
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    const r = await f.prepare([{create: {label: 'customers/999/labels/41'}}]);
    assert.equal(r.error?.code, 'WRITE_CONTRACT_UNAVAILABLE', JSON.stringify(r).slice(0, 400));
  } finally {
    f.store.close();
  }
});

test('a label the customer does not carry, or a row of another customer, is refused after reading', async () => {
  const f = fixture();
  try {
    const r = await f.prepare([{remove: rn('41')}, {remove: rn('77')}]);
    assert.equal(r.error?.code, 'STATE_NOT_FOUND', JSON.stringify(r).slice(0, 400));
    assert.deepEqual(r.error.details.missing, [rn('77')]);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
  const g = fixture('foreign');
  try {
    assert.equal((await g.prepare([{remove: rn('41')}])).success, false);
    assert.equal(g.writes(), 0);
  } finally {
    g.store.close();
  }
});

test('an ignored removal is not verified, and the ledger lists the write under its family', async () => {
  const g = fixture('ignore');
  try {
    const p = ok(await g.prepare([{remove: rn('41')}]));
    ok(await g.execute(p));
    assert.notEqual(ok(await g.verify(p)).data.status, 'verified');
  } finally {
    g.store.close();
  }
  const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.action === action);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'reviewed_write_family');
  assert.equal(rows[0].family, 'google_customer_labels');
});

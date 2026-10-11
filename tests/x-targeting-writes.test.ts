import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import type {JsonObject} from '../src/types.js';
const registry = new Registry(),
  actor = {tenantId: 'xtargeting', userId: 'u', role: 'operator' as const},
  admin = {...actor, role: 'admin' as const};
const gateway = 'x_ads_native_action',
  policy = {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true};
const criterion = {
  line_item_id: 'xm3fw',
  targeting_type: 'LOCATION',
  targeting_value: '01bf5c1e56ac186d',
  operator_type: 'EQ',
};

function setup(lineItemStatus = 'PAUSED') {
  const store = new Store(':memory:', Buffer.alloc(32, 72).toString('base64'));
  store.putConnection(
    admin,
    {
      id: 'x',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['18ce55vrgri'],
      writeAccounts: ['18ce55vrgri'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic', consumerKey: 'synthetic', consumerSecret: 'synthetic', tokenSecret: 'synthetic'},
  );
  let writes = 0,
    reads = 0;
  const calls: JsonObject[] = [];
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(async (url, init) => {
      const path = new URL(String(url)).pathname,
        method = init?.method ?? 'GET';
      calls.push({path, method});
      if (method === 'GET') {
        reads++;
        const id = path.split('/').at(-1)!;
        return Response.json({
          data: path.includes('/line_items/')
            ? {id, entity_status: lineItemStatus, campaign_id: 'p994w'}
            : {id, line_item_id: 'xm3fw', targeting_type: 'LOCATION', targeting_value: '01bf5c1e56ac186d'},
        });
      }
      writes++;
      return Response.json({
        data: {
          id: '1evd48o',
          line_item_id: 'xm3fw',
          targeting_type: 'LOCATION',
          targeting_value: '01bf5c1e56ac186d',
          deleted: method === 'DELETE',
        },
      });
    }),
    undefined,
    policy,
  );
  const prepare = (args: JsonObject) =>
    service.call('amcp_write', {action: 'prepare', gateway, arguments: {account_id: '18ce55vrgri', ...args}}, actor);
  return {
    store,
    service,
    calls,
    writes: () => writes,
    reads: () => reads,
    prepare,
    setLineItemStatus: (status: string) => (lineItemStatus = status),
  };
}
const create = (payload: JsonObject = criterion) => ({
  action: 'x_accounts_account_id_targeting_criteria_post',
  payload,
});

test('X reviewed targeting create reads the parent line item, executes once and replays', async () => {
  const x = setup();
  try {
    const p = (await x.prepare(create())) as any;
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal(x.writes(), 0);
    assert.equal(x.reads(), 1);
    // The before-state read must resolve the PARENT line item, not the account.
    assert.match(String((x.calls[0] as any).path), /\/line_items\/xm3fw$/);
    const args = {
      action: 'execute',
      review_id: p.data.review_id,
      idempotency_key: p.data.idempotency_key,
      confirmed: true,
    };
    // A criterion carries no monetary field and its parent is required to be paused, so unlike
    // Google's bid-bearing criteria this is not a spend-affecting write.
    const result = (await x.service.call('amcp_write', args, actor)) as any;
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(x.writes(), 1);
    assert.equal(((await x.service.call('amcp_write', args, actor)) as any).data.replayed, true);
    assert.equal(x.writes(), 1);
  } finally {
    x.store.close();
  }
});

test('X refuses targeting on a serving line item because criteria apply one at a time, and runs once it is paused', async () => {
  const x = setup('ACTIVE');
  try {
    const p = (await x.prepare(create())) as any;
    assert.equal(p.success, false);
    assert.equal(p.error.code, 'TARGETING_PARENT_NOT_PAUSED', JSON.stringify(p));
    assert.equal(p.error.details.entity_status, 'ACTIVE');
    assert.equal(x.writes(), 0);
    // QA-02 exit: once the line item is paused (its own reviewed change), the same targeting change reviews and runs.
    x.setLineItemStatus('PAUSED');
    const paused = (await x.prepare(create())) as any;
    assert.equal(paused.success, true, JSON.stringify(paused));
    const run = (await x.service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: paused.data.review_id,
        idempotency_key: paused.data.idempotency_key,
        confirmed: true,
      },
      actor,
    )) as any;
    assert.equal(run.success, true, JSON.stringify(run));
    assert.equal(x.writes(), 1);
  } finally {
    x.store.close();
  }
});

test('X targeting bodies are validated before any provider read', async () => {
  const x = setup();
  try {
    const bad: JsonObject[] = [
      {...criterion, line_item_id: 'XM3FW'}, // not a native lowercase id
      {...criterion, targeting_type: 'location'}, // not a native type token
      {...criterion, targeting_value: '   '}, // empty after trim
      {...criterion, operator_type: 'LIKE'}, // unsupported operator
      {...criterion, negative: true}, // unqualified field
    ];
    for (const payload of bad) {
      const p = (await x.prepare(create(payload))) as any;
      assert.equal(p.success, false, JSON.stringify(payload));
      assert.equal(p.error.code, 'INVALID_TARGETING_MUTATION', JSON.stringify(p));
    }
    assert.equal(x.reads(), 0);
    assert.equal(x.writes(), 0);
  } finally {
    x.store.close();
  }
});

test('X targeting deletes are reviewed against the exact criterion, and PUT remains refused', async () => {
  const x = setup();
  try {
    const p = (await x.prepare({
      action: 'x_accounts_account_id_targeting_criteria_targeting_criterion_id_delete',
      params: {targeting_criterion_id: '1evd48o'},
    })) as any;
    assert.equal(p.success, true, JSON.stringify(p));
    assert.match(String((x.calls[0] as any).path), /\/targeting_criteria\/1evd48o$/);
    // Identity changes must go through delete plus create, matching the Google contract.
    const put = (await x.prepare({
      action: 'x_accounts_account_id_targeting_criteria_targeting_criterion_id_put',
      params: {targeting_criterion_id: '1evd48o'},
      payload: {targeting_value: 'other'},
    })) as any;
    assert.equal(put.error.code, 'WRITE_CONTRACT_UNAVAILABLE', JSON.stringify(put));
    // Batch input now reaches its separate closed contract.
    const batch = (await x.prepare({
      action: 'x_batch_accounts_account_id_targeting_criteria_post',
      payload: [{operation_type: 'Update', params: criterion}],
    })) as any;
    assert.equal(batch.error.code, 'INVALID_X_TARGETING_BATCH', JSON.stringify(batch));
  } finally {
    x.store.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * TikTok change log download tasks ("Create a change log download task", "Check the status of a download task"; API for
 * Business v1.3, checked 2026-09-28).
 */
const TIKTOK = '39393939-3939-4393-8393-393939393939',
  gateway = 'tiktok_native_action',
  account = '123',
  action = 'tiktok_changelog_task_create',
  registry = new Registry();
const actor = {tenantId: 'tiktok-change-logs', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 106).toString('base64');
const week = {start_time: '2026-09-01 00:00:00', end_time: '2026-09-08 00:00:00'};
function fixture(o = {}) {
  const store = new Store(':memory:', key),
    connection = {
      id: TIKTOK,
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic TikTok',
      scopes: [],
    };
  store.putConnection(owner, connection, {accessToken: 'synthetic'});
  const campaigns = ['1801', '1802'],
    adgroups = ['2801'],
    ads = ['3801'];
  let status = o.status ?? 'SUCCESS';
  let writes = 0,
    n = 0;
  const requests = [];
  const ok = data => Response.json({code: 0, message: 'OK', request_id: 'r' + ++n, data});
  const transport = new NativeTransport(async (raw, init = {}) => {
    const u = new URL(String(raw)),
      path = u.pathname.replace(/^\/open_api/, ''),
      method = init.method ?? 'GET',
      q = k => u.searchParams.get(k);
    requests.push(method + ' ' + path);
    if (method === 'GET' && path === '/v1.3/advertiser/info/') {
      assert.deepEqual(JSON.parse(q('advertiser_ids')), [account]);
      assert.deepEqual(JSON.parse(q('fields')), ['advertiser_id', 'name', 'timezone', 'status']);
      return ok({
        list: [{advertiser_id: account, name: 'Synthetic brand', timezone: 'Etc/GMT+8', status: 'STATUS_ENABLE'}],
      });
    }
    const listed = {
      '/v1.3/campaign/get/': ['campaign_ids', 'campaign_id', campaigns],
      '/v1.3/adgroup/get/': ['adgroup_ids', 'adgroup_id', adgroups],
      '/v1.3/ad/get/': ['ad_ids', 'ad_id', ads],
    }[path];
    if (method === 'GET' && listed) {
      assert.equal(q('advertiser_id'), account);
      const [filter, id, owned] = listed,
        ids = JSON.parse(q('filtering'))[filter];
      const rows = ids
        .filter(x => owned.includes(x))
        .map(x => ({[id]: x, advertiser_id: account, operation_status: 'ENABLE'}));
      return ok({list: rows, page_info: {page: 1, page_size: 100, total_number: rows.length, total_page: 1}});
    }
    if (method === 'GET' && path === '/v1.3/changelog/task/check/') {
      assert.equal(q('advertiser_id'), account);
      assert.equal(q('task_id'), '6917870916856709125');
      return ok({status});
    }
    if (method === 'POST' && path === '/v1.3/changelog/task/create/') {
      const b = JSON.parse(init.body);
      writes++;
      assert.equal(b.advertiser_id, account);
      if (o.mode === 'error')
        return Response.json({code: 40002, message: 'Too many tasks', request_id: 'r' + ++n, data: {}});
      return ok({task_id: '6917870916856709125'});
    }
    throw new Error('Unexpected TikTok request ' + method + ' ' + path);
  });
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const prepare = payload =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        connection_id: TIKTOK,
        arguments: {action, account_id: account, payload: {advertiser_id: account, ...payload}},
      },
      actor,
    );
  const execute = p =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true},
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {
    store,
    requests,
    prepare,
    execute,
    verify,
    writes: () => writes,
    setStatus: s => {
      status = s;
    },
  };
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('a task filtered to two campaigns starts and verifies once it succeeds; an unfiltered task reads only the advertiser; a replay sends nothing', async () => {
  const f = fixture({status: 'PROCESSING'});
  try {
    const p = ok(
      await f.prepare({
        ...week,
        timezone: 'Etc/GMT+8',
        module: 'BUDGET',
        object_type: 'CAMPAIGN',
        object_ids: ['1801', '1802'],
        operation_types: ['UPDATE', 'STATUS'],
      }),
    );
    assert.equal(p.data.creative_impact.operation, 'export');
    assert.equal(p.data.creative_impact.may_affect_serving, false);
    assert.equal(p.data.creative_impact.advertiser.timezone, 'Etc/GMT+8');
    assert.ok(f.requests.includes('GET /v1.3/campaign/get/'));
    ok(await f.execute(p));
    assert.notEqual(ok(await f.verify(p)).data.status, 'verified', 'a PROCESSING task is not verified yet');
    f.setStatus('SUCCESS');
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    ok(await g.prepare({...week, operation_types: ['DELETE']}));
    assert.deepEqual(g.requests, ['GET /v1.3/advertiser/info/']);
    ok(await g.prepare({...week, object_type: 'ADGROUP', object_ids: ['2801']}));
    ok(await g.prepare({...week, object_type: 'ADVERTISER', object_ids: [account]}));
  } finally {
    g.store.close();
  }
});

test('malformed tasks are refused before any request; objects of other advertisers after reading', async () => {
  const cases = [
    ['no end_time', {start_time: week.start_time}, 'INVALID_TIKTOK_CHANGE_LOG_TASK'],
    ['an ISO time', {...week, start_time: '2026-09-01T00:00:00'}, 'INVALID_TIKTOK_CHANGE_LOG_TASK'],
    ['a date that does not exist', {...week, start_time: '2026-02-30 00:00:00'}, 'INVALID_TIKTOK_CHANGE_LOG_TASK'],
    [
      'an end before the start',
      {start_time: week.end_time, end_time: week.start_time},
      'INVALID_TIKTOK_CHANGE_LOG_TASK',
    ],
    [
      'a 31-day window',
      {start_time: '2026-08-01 00:00:00', end_time: '2026-09-01 00:00:01'},
      'INVALID_TIKTOK_CHANGE_LOG_TASK',
    ],
    ['an unknown module', {...week, module: 'CREATIVE'}, 'INVALID_TIKTOK_CHANGE_LOG_TASK'],
    ['an unknown object type', {...week, object_type: 'PIXEL'}, 'INVALID_TIKTOK_CHANGE_LOG_TASK'],
    ['an unknown operation', {...week, operation_types: ['RENAME']}, 'INVALID_TIKTOK_CHANGE_LOG_TASK'],
    ['a repeated operation', {...week, operation_types: ['UPDATE', 'UPDATE']}, 'INVALID_TIKTOK_CHANGE_LOG_TASK'],
    ['IDs without a type', {...week, object_ids: ['1801']}, 'INVALID_TIKTOK_CHANGE_LOG_TASK'],
    [
      '101 IDs',
      {...week, object_type: 'CAMPAIGN', object_ids: Array.from({length: 101}, (_, i) => String(5000 + i))},
      'INVALID_TIKTOK_CHANGE_LOG_TASK',
    ],
    [
      'instant form IDs',
      {...week, object_type: 'INSTANT_FORM', object_ids: ['7001']},
      'INVALID_TIKTOK_CHANGE_LOG_TASK',
    ],
    [
      'another advertiser as object',
      {...week, object_type: 'ADVERTISER', object_ids: ['999']},
      'INVALID_TIKTOK_CHANGE_LOG_TASK',
    ],
    ['ordering', {...week, order_fields: ['create_time']}, 'INVALID_TIKTOK_CHANGE_LOG_TASK'],
    ['an unknown field', {...week, lang: 'en'}, 'INVALID_TIKTOK_CHANGE_LOG_TASK'],
    ['another advertiser', {...week, advertiser_id: '999'}, 'ACCOUNT_SCOPE_MISMATCH'],
  ];
  for (const [label, payload, code] of cases) {
    const f = fixture();
    try {
      const r = await f.prepare(payload);
      assert.equal(r.error?.code, code, label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(f.requests.length, 0, label);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    const r = await f.prepare({...week, object_type: 'CAMPAIGN', object_ids: ['1801', '1899']});
    assert.equal(r.error?.code, 'STATE_NOT_FOUND');
    assert.match(r.error?.message ?? '', /1899/);
    assert.equal((await f.prepare({...week, object_type: 'AD', object_ids: ['3899']})).error?.code, 'STATE_NOT_FOUND');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('an error reply is never resubmitted, a FAILED task is not verified, and the ledger lists the row', async () => {
  const e = fixture({mode: 'error'});
  try {
    const p = ok(await e.prepare(week));
    assert.equal((await e.execute(p)).success, false);
    assert.equal((await e.execute(p)).success, false);
    assert.equal(e.writes(), 1);
  } finally {
    e.store.close();
  }
  const g = fixture({status: 'FAILED'});
  try {
    const p = ok(await g.prepare(week));
    ok(await g.execute(p));
    assert.notEqual(ok(await g.verify(p)).data.status, 'verified');
  } finally {
    g.store.close();
  }
  const row = actionContracts(registry).find(r => r.gateway === gateway && r.action === action);
  assert.equal(row?.status, 'reviewed_write_family');
  assert.equal(row.family, 'tiktok_change_log_tasks');
});

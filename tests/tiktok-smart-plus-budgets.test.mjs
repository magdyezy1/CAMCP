import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';

/**
 * Upgraded Smart+ ad group budgets (API for Business v1.3, checked 2026-09-26): `budget` updates take effect
 * immediately for up to 20 ad groups; scheduled budgets are allowlist-only. Each amount is compared with its own ad
 * group's current budget under the owner spending policy.
 */
const TIKTOK = '18181818-1818-4181-8181-181818181818',
  gateway = 'tiktok_native_action',
  account = '123';
const actor = {tenantId: 'tiktok-smart-plus-budgets', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 75).toString('base64');
const seed = () =>
  new Map(
    Object.entries({
      400: {
        adgroup_id: '400',
        adgroup_name: 'Smart+ daily',
        campaign_id: '40',
        budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
        budget: 100,
        operation_status: 'ENABLE',
      },
      401: {
        adgroup_id: '401',
        adgroup_name: 'Smart+ lifetime',
        campaign_id: '40',
        budget_mode: 'BUDGET_MODE_TOTAL',
        budget: 2000,
        operation_status: 'DISABLE',
      },
      402: {
        adgroup_id: '402',
        adgroup_name: 'Smart+ goal-based',
        campaign_id: '41',
        budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
        budget: 80,
        budget_auto_adjust_strategy: 'AUTO_BUDGET_INCREASE',
        current_budget: 96,
        operation_status: 'ENABLE',
      },
      403: {
        adgroup_id: '403',
        adgroup_name: 'Under CBO',
        campaign_id: '42',
        min_budget: 20,
        operation_status: 'ENABLE',
      },
    }),
  );
function fixture({readDrift} = {}) {
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
  const groups = seed(),
    requests = [],
    writes = [];
  let n = 0,
    mode = '';
  const ok = data => Response.json({code: 0, message: 'OK', request_id: 'r' + ++n, data});
  const transport = new NativeTransport(async (raw, init = {}) => {
    const url = new URL(String(raw)),
      path = url.pathname.replace(/^\/open_api/, ''),
      method = init.method ?? 'GET';
    requests.push(method + ' ' + path);
    if (method === 'GET' && path === '/v1.3/smart_plus/adgroup/get/') {
      const ids = JSON.parse(url.searchParams.get('filtering')).adgroup_ids;
      const list = ids.filter(id => groups.has(id)).map(id => ({...groups.get(id), ...(readDrift?.[id] ?? {})}));
      return ok({list, page_info: {page: 1, page_size: 100, total_number: list.length, total_page: 1}});
    }
    if (method === 'POST' && path === '/v1.3/smart_plus/adgroup/budget/update/') {
      const b = JSON.parse(init.body);
      writes.push(b);
      for (const r of b.budget) groups.set(r.adgroup_id, {...groups.get(r.adgroup_id), budget: r.budget});
      if (mode === 'lost') throw new Error('Synthetic accepted response lost');
      return mode === 'error'
        ? Response.json({code: 40002, message: 'Budget below minimum', request_id: 'r' + ++n, data: {}})
        : ok({});
    }
    throw new Error('Unexpected TikTok request ' + method + ' ' + path);
  });
  const start = () =>
    new MirrorService(new Registry(), store, transport, undefined, {
      allowWrites: true,
      requireBeforeState: true,
      maxBudgetChange: 0,
    });
  let service = start();
  const call = (tool, input) => service.call(tool, input, actor);
  const args = payload => ({action: 'tiktok_smart_plus_adgroup_budget_update', account_id: account, payload});
  const prepare = payload =>
    call('amcp_write', {action: 'prepare', gateway, connection_id: TIKTOK, arguments: args(payload)});
  const execute = (id, extra = {spend_change_confirmed: true}) =>
    call('amcp_write', {action: 'execute', review_id: id, idempotency_key: id, confirmed: true, ...extra});
  const verify = id => call('amcp_campaign', {action: 'verify', review_id: id});
  return {
    store,
    groups,
    requests,
    writes,
    call,
    args,
    prepare,
    execute,
    verify,
    mode: v => {
      mode = v;
    },
    restart: () => {
      service = start();
    },
  };
}

test('the Smart+ ad group budget route is a reviewed TikTok family', async () => {
  const f = fixture();
  try {
    const r = await f.call('amcp_write', {
      action: 'inspect',
      gateway,
      connection_id: TIKTOK,
      arguments: f.args({budget: [{adgroup_id: '400', budget: 120}]}),
    });
    assert.equal(r.data.review_contract_supported, true, JSON.stringify(r));
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('only 1 to 20 unique ad groups with positive two-decimal budgets are accepted, before any request', async () => {
  const f = fixture();
  try {
    const cases = {
      'scheduled': {scheduled_budget: [{adgroup_id: '400', scheduled_budget: 120}]},
      'both': {
        budget: [{adgroup_id: '400', budget: 120}],
        scheduled_budget: [{adgroup_id: '400', scheduled_budget: 120}],
      },
      'none': {},
      'empty': {budget: []},
      'twenty-one': {budget: Array.from({length: 21}, (_, i) => ({adgroup_id: String(500 + i), budget: 10}))},
      'duplicate': {
        budget: [
          {adgroup_id: '400', budget: 120},
          {adgroup_id: '400', budget: 130},
        ],
      },
      'non-numeric': {budget: [{adgroup_id: 'ag400', budget: 120}]},
      'zero': {budget: [{adgroup_id: '400', budget: 0}]},
      'three decimals': {budget: [{adgroup_id: '400', budget: 120.125}]},
      'text amount': {budget: [{adgroup_id: '400', budget: '120'}]},
      'extra key': {budget: [{adgroup_id: '400', budget: 120, budget_mode: 'BUDGET_MODE_TOTAL'}]},
    };
    for (const [name, payload] of Object.entries(cases)) {
      const r = await f.prepare(payload);
      assert.equal(
        r.error?.code,
        'INVALID_TIKTOK_SMART_PLUS_BUDGET',
        name + ': ' + JSON.stringify(r.error ?? r.data).slice(0, 300),
      );
    }
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('budgets for two ad groups need spending confirmation, change once and verify', async () => {
  const f = fixture();
  try {
    const p = await f.prepare({
      budget: [
        {adgroup_id: '400', budget: 150},
        {adgroup_id: '401', budget: 1800.5},
      ],
    });
    assert.equal(p.success, true, JSON.stringify(p));
    assert.deepEqual(
      p.data.state_reads.map(r => r.path),
      ['/v1.3/smart_plus/adgroup/get/'],
    );
    assert.deepEqual(
      p.data.creative_impact.changes.map(c => [c.adgroup_id, c.before, c.after]),
      [
        ['400', 100, 150],
        ['401', 2000, 1800.5],
      ],
    );
    assert.equal((await f.execute(p.data.review_id, {})).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal(f.writes.length, 0);
    assert.equal((await f.execute(p.data.review_id)).success, true);
    const v = await f.verify(p.data.review_id);
    assert.equal(v.data.status, 'verified', JSON.stringify(v));
    assert.equal(v.data.checks.length, 2);
    assert.equal((await f.execute(p.data.review_id)).data.replayed, true);
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
});

test('goal-based increase is explained, and ad groups without their own budget or missing are refused', async () => {
  const f = fixture();
  try {
    const p = await f.prepare({budget: [{adgroup_id: '402', budget: 90}]});
    assert.equal(p.success, true, JSON.stringify(p));
    assert.match(p.data.creative_impact.changes[0].goal_based_increase, /initial daily budget/);
    const cbo = await f.prepare({budget: [{adgroup_id: '403', budget: 50}]});
    assert.equal(cbo.error?.code, 'INVALID_TIKTOK_SMART_PLUS_BUDGET', JSON.stringify(cbo));
    assert.match(cbo.error.message, /campaign budget/);
    const missing = await f.prepare({budget: [{adgroup_id: '499', budget: 50}]});
    assert.equal(missing.error?.code, 'STATE_TARGET_MISMATCH', JSON.stringify(missing));
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

test('each ad group is compared with its own current budget under the owner spending policy', async () => {
  const f = fixture();
  try {
    saveSpendPolicy(f.store, owner, {
      scope: 'workspace',
      confirmed: true,
      policy: {enforcement: 'block', max_budget_increase_percent: 50},
    });
    const raised = await f.prepare({
      budget: [
        {adgroup_id: '401', budget: 1500},
        {adgroup_id: '400', budget: 200},
      ],
    });
    assert.equal(raised.error?.code, 'POLICY_INCREASE_LIMIT', JSON.stringify(raised));
    assert.equal(
      (
        await f.prepare({
          budget: [
            {adgroup_id: '400', budget: 140},
            {adgroup_id: '401', budget: 1500},
          ],
        })
      ).success,
      true,
      'a 40% raise and a decrease fit the policy',
    );
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

test('a drifted read-back is inconclusive; rejected or lost updates are never resubmitted', async () => {
  const d = fixture({readDrift: {400: {budget: 149}}});
  try {
    const p = await d.prepare({budget: [{adgroup_id: '401', budget: 1900}]});
    await d.execute(p.data.review_id);
    const q = await d.prepare({budget: [{adgroup_id: '400', budget: 150}]});
    assert.equal(q.success, true, JSON.stringify(q));
    await d.execute(q.data.review_id);
    const v = await d.verify(q.data.review_id);
    assert.equal(v.data.status, 'inconclusive', JSON.stringify(v));
    assert.deepEqual(v.data.checks[0].changed_fields, ['/budget']);
  } finally {
    d.store.close();
  }
  for (const [mode, first, again] of [
    // r25-m2-refusal (Q16): TikTok’s refusal here is code 40002 with no data in an HTTP 200 answer, which its return-code table defines as a refusal of the request: the review is rejected and its key retired (WRITE_REJECTED), not uncertain. A lost response stays uncertain.
    ['error', 'PLATFORM_ERROR', 'WRITE_REJECTED'],
    ['lost', 'WRITE_OUTCOME_UNCERTAIN', 'WRITE_OUTCOME_UNCERTAIN'],
  ]) {
    const f = fixture();
    try {
      const p = await f.prepare({budget: [{adgroup_id: '400', budget: 120}]});
      f.mode(mode);
      assert.equal((await f.execute(p.data.review_id)).error?.code, first, mode);
      f.mode('');
      f.restart();
      assert.equal((await f.execute(p.data.review_id)).error?.code, again, mode);
      assert.equal(f.writes.length, 1, mode);
    } finally {
      f.store.close();
    }
  }
  const g = fixture();
  try {
    const p = await g.prepare({budget: [{adgroup_id: '400', budget: 120}]});
    const results = await Promise.all([g.execute(p.data.review_id), g.execute(p.data.review_id)]);
    assert.ok(results.some(r => r.success));
    assert.equal(g.writes.length, 1);
    g.restart();
    assert.equal((await g.execute(p.data.review_id)).data.replayed, true);
  } finally {
    g.store.close();
  }
});

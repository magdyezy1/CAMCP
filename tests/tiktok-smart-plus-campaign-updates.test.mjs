import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';

/**
 * Upgraded Smart+ campaign edits (API for Business v1.3, checked 2026-09-26): name, campaign budget and PO number.
 * A budget edit is compared with the campaign's current budget under the owner spending policy.
 */
const TIKTOK = '21212121-2121-4212-8212-212121212121',
  gateway = 'tiktok_native_action',
  account = '123';
const actor = {tenantId: 'tiktok-smart-plus-campaign-updates', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 78).toString('base64');
const seed = () => ({
  80: {
    campaign_id: '80',
    campaign_name: 'CBO web',
    objective_type: 'WEB_CONVERSIONS',
    sales_destination: 'WEBSITE',
    budget_optimize_on: true,
    budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
    budget: 500,
    operation_status: 'ENABLE',
  },
  81: {
    campaign_id: '81',
    campaign_name: 'Ad group budgets',
    objective_type: 'WEB_CONVERSIONS',
    sales_destination: 'WEBSITE',
    budget_optimize_on: false,
    budget_mode: 'BUDGET_MODE_INFINITE',
    budget: 0,
    operation_status: 'ENABLE',
  },
  82: {
    campaign_id: '82',
    campaign_name: 'Daily limit',
    objective_type: 'WEB_CONVERSIONS',
    sales_destination: 'WEBSITE',
    budget_optimize_on: false,
    budget_mode: 'BUDGET_MODE_DAY',
    budget: 900,
    operation_status: 'DISABLE',
  },
  85: {
    campaign_id: '85',
    campaign_name: 'Goal-based',
    objective_type: 'LEAD_GENERATION',
    budget_optimize_on: true,
    budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
    budget_auto_adjust_strategy: 'AUTO_BUDGET_INCREASE',
    budget: 300,
    current_budget: 360,
    operation_status: 'ENABLE',
  },
});
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
  const campaigns = seed(),
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
    if (method === 'GET' && path === '/v1.3/smart_plus/campaign/get/') {
      const list = JSON.parse(url.searchParams.get('filtering'))
        .campaign_ids.filter(id => campaigns[id])
        .map(id => (readDrift ? readDrift(structuredClone(campaigns[id])) : structuredClone(campaigns[id])));
      return ok({list, page_info: {page: 1, page_size: 100, total_number: list.length, total_page: 1}});
    }
    if (method === 'POST' && path === '/v1.3/smart_plus/campaign/update/') {
      const b = JSON.parse(init.body);
      writes.push(b);
      const {advertiser_id, campaign_id, ...changes} = b;
      campaigns[campaign_id] = {...campaigns[campaign_id], ...changes};
      if (mode === 'lost') throw new Error('Synthetic accepted response lost');
      return mode === 'error'
        ? Response.json({code: 40002, message: 'Budget below minimum', request_id: 'r' + ++n, data: {}})
        : ok(structuredClone(campaigns[campaign_id]));
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
  const args = (payload, action = 'tiktok_smart_plus_campaign_update') => ({action, account_id: account, payload});
  const prepare = (payload, action) =>
    call('amcp_write', {action: 'prepare', gateway, connection_id: TIKTOK, arguments: args(payload, action)});
  const execute = (id, extra = {}) =>
    call('amcp_write', {action: 'execute', review_id: id, idempotency_key: id, confirmed: true, ...extra});
  const verify = id => call('amcp_campaign', {action: 'verify', review_id: id});
  return {
    store,
    campaigns,
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

test('Smart+ campaign edits are a reviewed TikTok family under both action names', async () => {
  const f = fixture();
  try {
    for (const action of ['tiktok_smart_plus_campaign_update', 'tiktok_smart_campaign_update']) {
      const r = await f.call('amcp_write', {
        action: 'inspect',
        gateway,
        connection_id: TIKTOK,
        arguments: f.args({campaign_id: '80', campaign_name: 'Renamed'}, action),
      });
      assert.equal(r.data.review_contract_supported, true, action + ' ' + JSON.stringify(r));
    }
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('only documented name, budget and PO edits are accepted, before any request', async () => {
  const f = fixture();
  try {
    const cases = {
      'no campaign': {campaign_name: 'x'},
      'nothing to change': {campaign_id: '80'},
      'emoji name': {campaign_id: '80', campaign_name: 'Web 🚀'},
      'long name': {campaign_id: '80', campaign_name: 'x'.repeat(513)},
      'zero budget': {campaign_id: '80', budget: 0},
      'three decimals': {campaign_id: '80', budget: 500.005},
      'text budget': {campaign_id: '80', budget: '600'},
      'goal-based': {campaign_id: '80', budget_auto_adjust_strategy: 'AUTO_BUDGET_INCREASE'},
      'status': {campaign_id: '80', operation_status: 'DISABLE'},
      'long PO': {campaign_id: '80', po_number: 'P'.repeat(101)},
    };
    for (const [name, payload] of Object.entries(cases)) {
      const r = await f.prepare(payload);
      assert.equal(
        r.error?.code,
        'INVALID_TIKTOK_SMART_PLUS_CAMPAIGN_UPDATE',
        name + ': ' + JSON.stringify(r.error ?? r.data).slice(0, 300),
      );
    }
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('a rename needs no spending confirmation, changes once and verifies', async () => {
  const f = fixture();
  try {
    const p = await f.prepare({campaign_id: '80', campaign_name: 'CBO web Q4', po_number: 'PO-2026-10'});
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal(p.data.creative_impact.may_affect_serving, false);
    assert.deepEqual(p.data.creative_impact.changes.campaign_name, {before: 'CBO web', after: 'CBO web Q4'});
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.equal(f.writes.length, 1);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
    assert.equal((await f.execute(p.data.review_id)).data.replayed, true);
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
});

test('a campaign budget edit needs confirmation and is compared with the current budget under the owner policy', async () => {
  const f = fixture();
  try {
    saveSpendPolicy(f.store, owner, {scope: 'workspace', confirmed: true, policy: {max_budget_increase_percent: 50}});
    assert.equal((await f.prepare({campaign_id: '80', budget: 800})).error?.code, 'POLICY_INCREASE_LIMIT');
    const p = await f.prepare({campaign_id: '80', budget: 700});
    assert.equal(p.success, true, JSON.stringify(p));
    assert.deepEqual(p.data.creative_impact.changes.budget, {before: 500, after: 700});
    assert.equal((await f.execute(p.data.review_id)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal(f.writes.length, 0);
    assert.equal((await f.execute(p.data.review_id, {spend_change_confirmed: true})).success, true);
    const v = await f.verify(p.data.review_id);
    assert.equal(v.data.status, 'verified', JSON.stringify(v));
  } finally {
    f.store.close();
  }
});

test('campaigns without a campaign budget are refused, limits and goal-based budgets are explained', async () => {
  const f = fixture();
  try {
    const none = await f.prepare({campaign_id: '81', budget: 100});
    assert.equal(none.error?.code, 'INVALID_TIKTOK_SMART_PLUS_CAMPAIGN_UPDATE', JSON.stringify(none));
    assert.match(none.error.message, /no campaign budget/);
    const limit = await f.prepare({campaign_id: '82', budget: 950});
    assert.equal(limit.success, true, JSON.stringify(limit));
    assert.match(limit.data.creative_impact.effect, /limit on the total/);
    const goal = await f.prepare({campaign_id: '85', budget: 320});
    assert.equal(goal.success, true, JSON.stringify(goal));
    assert.match(goal.data.creative_impact.effect, /initial daily budget/);
    assert.equal((await f.prepare({campaign_id: '89', campaign_name: 'Missing'})).error?.code, 'STATE_TARGET_MISMATCH');
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

test('a drifted read-back is inconclusive; rejected or lost edits are never resubmitted', async () => {
  const d = fixture({
    readDrift: r =>
      r.campaign_id === '80' && r.campaign_name === 'CBO web Q4' ? {...r, campaign_name: 'CBO web q4'} : r,
  });
  try {
    const p = await d.prepare({campaign_id: '80', campaign_name: 'CBO web Q4'});
    await d.execute(p.data.review_id);
    const v = await d.verify(p.data.review_id);
    assert.equal(v.data.status, 'inconclusive', JSON.stringify(v));
    assert.deepEqual(v.data.checks[0].changed_fields, ['/campaign_name']);
  } finally {
    d.store.close();
  }
  for (const [mode, first, again] of [
    ['error', 'PLATFORM_ERROR', 'WRITE_OUTCOME_UNCERTAIN'],
    ['lost', 'WRITE_OUTCOME_UNCERTAIN', 'WRITE_OUTCOME_UNCERTAIN'],
  ]) {
    const f = fixture();
    try {
      const p = await f.prepare({campaign_id: '80', budget: 550});
      f.mode(mode);
      assert.equal((await f.execute(p.data.review_id, {spend_change_confirmed: true})).error?.code, first, mode);
      f.mode('');
      f.restart();
      assert.equal((await f.execute(p.data.review_id, {spend_change_confirmed: true})).error?.code, again, mode);
      assert.equal(f.writes.length, 1, mode);
    } finally {
      f.store.close();
    }
  }
  const g = fixture();
  try {
    const p = await g.prepare({campaign_id: '80', campaign_name: 'Parallel'});
    const results = await Promise.all([g.execute(p.data.review_id), g.execute(p.data.review_id)]);
    assert.ok(results.some(r => r.success));
    assert.equal(g.writes.length, 1);
    g.restart();
    assert.equal((await g.execute(p.data.review_id)).data.replayed, true);
  } finally {
    g.store.close();
  }
});

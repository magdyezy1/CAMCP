import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';

/**
 * Paused Upgraded Smart+ campaigns (API for Business v1.3, checked 2026-09-26): TikTok enables new campaigns by
 * default, requires a 64-bit request_id, and applies campaign budget optimization with a dynamic daily budget
 * unless told otherwise.
 */
const TIKTOK = '19191919-1919-4191-8191-191919191919',
  gateway = 'tiktok_native_action',
  account = '123';
const actor = {tenantId: 'tiktok-smart-plus-campaigns', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 76).toString('base64');
const campaign = (extra = {}) => ({
  request_id: '700100200300',
  operation_status: 'DISABLE',
  objective_type: 'WEB_CONVERSIONS',
  sales_destination: 'WEBSITE',
  campaign_name: 'Smart+ KSA web',
  special_industries: ['EMPLOYMENT', 'CREDIT'],
  budget: 250,
  ...extra,
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
  const campaigns = new Map(),
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
    if (method === 'GET' && path === '/v1.3/advertiser/info/')
      return ok({
        list: [
          {
            advertiser_id: account,
            name: 'Synthetic advertiser',
            currency: 'SAR',
            timezone: 'Asia/Riyadh',
            status: 'STATUS_ENABLE',
          },
        ],
      });
    if (method === 'GET' && path === '/v1.3/smart_plus/campaign/get/') {
      const ids = JSON.parse(url.searchParams.get('filtering')).campaign_ids;
      const list = ids
        .filter(id => campaigns.has(id))
        .map(id => (readDrift ? readDrift(structuredClone(campaigns.get(id))) : structuredClone(campaigns.get(id))));
      return ok({list, page_info: {page: 1, page_size: 100, total_number: list.length, total_page: 1}});
    }
    if (method === 'POST' && path === '/v1.3/smart_plus/campaign/create/') {
      const b = JSON.parse(init.body);
      writes.push(b);
      const cbo = b.budget_optimize_on ?? true;
      // TikTok stores defaults, returns sets in its own order and adds read-only fields.
      const row = {
        advertiser_id: account,
        campaign_id: '1800000000000001',
        create_time: '2026-09-26 13:00:00',
        modify_time: '2026-09-26 13:00:00',
        campaign_type: 'REGULAR_CAMPAIGN',
        is_search_campaign: false,
        catalog_enabled: false,
        objective_type: b.objective_type,
        ...(b.sales_destination ? {sales_destination: b.sales_destination} : {}),
        campaign_name: b.campaign_name,
        special_industries: [...(b.special_industries ?? [])].reverse(),
        budget_optimize_on: cbo,
        budget_mode: b.budget_mode ?? (cbo ? 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET' : 'BUDGET_MODE_INFINITE'),
        budget: b.budget ?? 0,
        operation_status: b.operation_status ?? 'ENABLE',
        secondary_status: 'CAMPAIGN_STATUS_DISABLE',
        ...(b.po_number ? {po_number: b.po_number} : {}),
      };
      campaigns.set(row.campaign_id, row);
      if (mode === 'lost') throw new Error('Synthetic accepted response lost');
      return mode === 'error'
        ? Response.json({code: 40002, message: 'Budget below minimum', request_id: 'r' + ++n, data: {}})
        : ok(structuredClone(row));
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
  const args = (payload, action = 'tiktok_smart_plus_campaign_create') => ({action, account_id: account, payload});
  const prepare = payload =>
    call('amcp_write', {action: 'prepare', gateway, connection_id: TIKTOK, arguments: args(payload)});
  const execute = (id, extra = {spend_change_confirmed: true}) =>
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

test('paused Smart+ campaign creation is a reviewed TikTok family; campaign copies stay blocked', async () => {
  const f = fixture();
  try {
    const r = await f.call('amcp_write', {
      action: 'inspect',
      gateway,
      connection_id: TIKTOK,
      arguments: f.args(campaign()),
    });
    assert.equal(r.data.review_contract_supported, true, JSON.stringify(r));
    const u = await f.call('amcp_write', {
      action: 'inspect',
      gateway,
      connection_id: TIKTOK,
      arguments: f.args(
        {request_id: '4001', campaign_id: '1800000000000001', operation_status: 'DISABLE'},
        'tiktok_smart_plus_campaign_copy_task_create',
      ),
    });
    assert.notEqual(u.data?.review_contract_supported, true, JSON.stringify(u));
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('only paused website and lead campaigns with documented budgets are accepted, before any request', async () => {
  const f = fixture();
  try {
    const drop = k => {
      const v = campaign();
      delete v[k];
      return v;
    };
    const cases = {
      'no request_id': drop('request_id'),
      'text request_id': campaign({request_id: 'abc'}),
      'huge request_id': campaign({request_id: '9223372036854775808'}),
      'enabled': campaign({operation_status: 'ENABLE'}),
      'default status': drop('operation_status'),
      'app objective': campaign({objective_type: 'APP_PROMOTION'}),
      'app destination': campaign({sales_destination: 'APP'}),
      'no destination': drop('sales_destination'),
      'lead with destination': campaign({objective_type: 'LEAD_GENERATION'}),
      'iOS campaign': campaign({campaign_type: 'IOS14_CAMPAIGN'}),
      'catalog': campaign({catalog_enabled: true}),
      'search': campaign({is_search_campaign: true}),
      'goal-based increase': campaign({budget_auto_adjust_strategy: 'AUTO_BUDGET_INCREASE'}),
      'rta': campaign({rta_id: '1'}),
      'emoji name': campaign({campaign_name: 'Smart+ 🚀'}),
      'long name': campaign({campaign_name: 'x'.repeat(513)}),
      'wide name': campaign({campaign_name: '広告'.repeat(129)}),
      'unknown industry': campaign({special_industries: ['GAMBLING']}),
      'duplicate industry': campaign({special_industries: ['CREDIT', 'CREDIT']}),
      'CBO daily limit': campaign({budget_mode: 'BUDGET_MODE_DAY'}),
      'limit dynamic mode': campaign({budget_optimize_on: false, budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET'}),
      'unlimited with budget': campaign({budget_optimize_on: false}),
      'dynamic without budget': drop('budget'),
      'three decimals': campaign({budget: 250.005}),
      'text budget': campaign({budget: '250'}),
      'long PO': campaign({po_number: 'P'.repeat(101)}),
    };
    for (const [name, payload] of Object.entries(cases)) {
      const r = await f.prepare(payload);
      assert.equal(
        r.error?.code,
        'INVALID_TIKTOK_SMART_PLUS_CAMPAIGN',
        name + ': ' + JSON.stringify(r.error ?? r.data).slice(0, 300),
      );
    }
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('a paused campaign with a shared budget is created once and verifies', async () => {
  const f = fixture();
  try {
    const p = await f.prepare(campaign());
    assert.equal(p.success, true, JSON.stringify(p));
    assert.deepEqual(
      p.data.state_reads.map(r => r.path),
      ['/v1.3/advertiser/info/'],
    );
    const impact = p.data.creative_impact;
    assert.equal(impact.scope, 'smart_plus_campaigns');
    assert.equal(impact.may_affect_serving, false);
    assert.equal(impact.campaign.budget_mode, 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET');
    assert.equal(impact.campaign.currency, 'SAR');
    assert.equal((await f.execute(p.data.review_id, {})).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal(f.writes.length, 0);
    const done = await f.execute(p.data.review_id);
    assert.equal(done.success, true, JSON.stringify(done));
    assert.equal(f.writes.length, 1);
    const {advertiser_id, ...sent} = f.writes[0];
    assert.deepEqual(sent, campaign());
    const v = await f.verify(p.data.review_id);
    assert.equal(v.data.status, 'verified', JSON.stringify(v));
    assert.equal(v.data.checks[0].resource_id, '1800000000000001');
    assert.equal((await f.execute(p.data.review_id)).data.replayed, true);
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
});

test('a lead campaign without a campaign budget verifies, and the owner budget cap applies to campaign budgets', async () => {
  const f = fixture();
  try {
    const {special_industries, budget, sales_destination, ...base} = campaign();
    const lead = {...base, objective_type: 'LEAD_GENERATION', budget_optimize_on: false, campaign_name: 'Smart+ leads'};
    const p = await f.prepare(lead);
    assert.equal(p.success, true, JSON.stringify(p));
    assert.match(p.data.creative_impact.budget_meaning, /each ad group/);
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    saveSpendPolicy(g.store, owner, {
      scope: 'workspace',
      confirmed: true,
      policy: {max_budget_native: 200, allow_activation: false},
    });
    assert.equal((await g.prepare(campaign())).error?.code, 'POLICY_BUDGET_LIMIT');
    const p = await g.prepare(campaign({budget: 150}));
    assert.equal(
      p.success,
      true,
      'a paused campaign within the cap passes a no-activation policy: ' + JSON.stringify(p),
    );
    assert.equal(g.writes.length, 0);
  } finally {
    g.store.close();
  }
});

test('a campaign that reads back differently stays inconclusive', async () => {
  for (const [name, drift, field] of [
    ['enabled', r => ({...r, operation_status: 'ENABLE'}), '/operation_status'],
    ['budget', r => ({...r, budget: 300}), '/budget'],
    ['industries', r => ({...r, special_industries: ['CREDIT']}), '/special_industries'],
  ]) {
    const f = fixture({readDrift: drift});
    try {
      const p = await f.prepare(campaign());
      await f.execute(p.data.review_id);
      const v = await f.verify(p.data.review_id);
      assert.equal(v.data.status, 'inconclusive', name + ' ' + JSON.stringify(v));
      assert.deepEqual(v.data.checks[0].changed_fields, [field], name);
    } finally {
      f.store.close();
    }
  }
});

test('rejected or lost creations are never resubmitted, and claims survive restart and concurrency', async () => {
  for (const [mode, first, again] of [
    ['error', 'PLATFORM_ERROR', 'WRITE_OUTCOME_UNCERTAIN'],
    ['lost', 'WRITE_OUTCOME_UNCERTAIN', 'WRITE_OUTCOME_UNCERTAIN'],
  ]) {
    const f = fixture();
    try {
      const p = await f.prepare(campaign());
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
    const p = await g.prepare(campaign());
    const results = await Promise.all([g.execute(p.data.review_id), g.execute(p.data.review_id)]);
    assert.ok(results.some(r => r.success));
    assert.equal(g.writes.length, 1);
    g.restart();
    assert.equal((await g.execute(p.data.review_id)).data.replayed, true);
  } finally {
    g.store.close();
  }
});

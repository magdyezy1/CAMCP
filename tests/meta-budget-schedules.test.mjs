import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {assertWriteShape} from '../dist/src/write-shape.js';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * Meta budget scheduling (high demand periods), opened by the owner on 2026-09-29 on conditions. Meta's references (read
 * 2026-09-29): POST /{campaign_id}/budget_schedules and /{ad_set_id}/budget_schedules take budget_value ("unit defined by
 * BudgetValueType (e.g. 140 could be $140 or 140%)"), budget_value_type ABSOLUTE or MULTIPLIER, time_start and time_end
 * (Unix times) and answer {id}; updating and deleting: "You can't perform this operation on this endpoint". The account
 * needs CAN_USE_BUDGET_SCHEDULING_API; daily budgets only; at most 50 periods; at most 8 times the daily budget; at least
 * 3 hours.
 */
const gateway = 'meta_native_action',
  registry = new Registry();
const actor = {tenantId: 'meta-budget-schedules', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const hour = 3600;
// 06:00 in Riyadh (03:00 UTC) three days ahead, so a 6-hour period stays within one local day whatever the time now.
const startAt = Math.floor(Date.now() / 1000 / 86400) * 86400 + 3 * 86400 + 3 * hour;
function fixture(options = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 88).toString('base64'));
  store.putConnection(
    owner,
    {
      id: 'm',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Meta',
      scopes: ['ads_management'],
    },
    {accessToken: 'synthetic'},
  );
  if (options.policy !== null)
    saveSpendPolicy(store, owner, {
      gateway,
      account_id: '123',
      confirmed: true,
      policy: options.policy ?? {enforcement: 'block', max_budget_native: 100000},
    });
  const account = {
    id: 'act_123',
    currency: options.currency === null ? undefined : (options.currency ?? 'USD'),
    ...(options.timezone === null ? {} : {timezone_name: options.timezone ?? 'Asia/Riyadh'}),
    capabilities: options.capable === false ? ['CAN_USE_REACH_AND_FREQUENCY'] : ['CAN_USE_BUDGET_SCHEDULING_API'],
  };
  const objects = new Map([
    ['111', {id: '111', account_id: '123', name: 'Always on', daily_budget: '10000', status: 'ACTIVE'}],
    ['112', {id: '112', account_id: '123', name: 'Lifetime', lifetime_budget: '500000', status: 'PAUSED'}],
    [
      '113',
      {id: '113', account_id: '123', name: 'App', daily_budget: '10000', smart_promotion_type: 'SMART_APP_PROMOTION'},
    ],
    ['221', {id: '221', account_id: '123', name: 'Ad set', daily_budget: '5000', campaign_id: '111'}],
  ]);
  const schedules = new Map([
    ['111', options.full ? Array.from({length: 50}, (_, i) => ({id: String(8000 + i)})) : (options.existing ?? [])],
    ['112', []],
    ['113', []],
    ['221', []],
  ]);
  const iso = s => new Date(s * 1000).toISOString().replace('.000Z', '+0000');
  const calls = [];
  let writes = 0;
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        path = u.pathname,
        method = init.method;
      calls.push({method, path, query: Object.fromEntries(u.searchParams)});
      if (method === 'GET') {
        if (path === '/v26.0/act_123/campaigns' || path === '/v26.0/act_123/adsets')
          return Response.json({
            data: [...objects.values()]
              .filter(o => (path.endsWith('adsets') ? o.campaign_id : !o.campaign_id))
              .map(o => ({id: o.id, name: o.name})),
          });
        if (path === '/v26.0/act_123') return Response.json(account);
        const list = /^\/v26\.0\/(\d+)\/budget_schedules$/.exec(path);
        if (list)
          return Response.json({
            data: schedules.get(list[1]).map(p => ({
              ...p,
              ...(p.time_start ? {time_start: iso(p.time_start), time_end: iso(p.time_end)} : {}),
            })),
          });
        const node = /^\/v26\.0\/(\d+)$/.exec(path);
        if (node && objects.has(node[1])) return Response.json(objects.get(node[1]));
        return Response.json(
          {error: {message: 'Unsupported get request', code: 100, error_subcode: 33}},
          {status: 400},
        );
      }
      writes++;
      const target = /^\/v26\.0\/(\d+)\/budget_schedules$/.exec(path)[1],
        b = Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
      const id = String(9000 + writes);
      if (!options.ignore)
        schedules.get(target).push({
          id,
          budget_value: Number(b.budget_value),
          budget_value_type: b.budget_value_type,
          recurrence_type: 'ONE_TIME',
          time_start: Number(b.time_start),
          time_end: Number(b.time_end),
        });
      return Response.json({id});
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
  const discover = async edge =>
    service.call(
      gateway,
      {action: 'meta_ad_account_id_' + edge + '_get', account_id: '123', params: {fields: 'id,name'}},
      actor,
    );
  const prepare = (target, payload, level = 'campaign') =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          action:
            level === 'campaign'
              ? 'meta_campaign_id_budget_schedules_create'
              : 'meta_ad_set_id_budget_schedules_create',
          account_id: '123',
          params: {[level === 'campaign' ? 'campaign_id' : 'ad_set_id']: target},
          payload,
        },
      },
      actor,
    );
  const execute = (p, extra = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: p.data.review_id,
        idempotency_key: p.data.idempotency_key,
        confirmed: true,
        ...extra,
      },
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, schedules, discover, prepare, execute, verify, writes: () => writes};
}
const period = (extra = {}) => ({
  budget_value: 20,
  budget_value_type: 'ABSOLUTE',
  time_start: startAt,
  time_end: startAt + 6 * hour,
  ...extra,
});
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 1200));
  return r;
};

test('a scheduled increase is reviewed in the account time zone with its maximum extra spend, needs spending confirmation and reads back from the schedule list', async () => {
  const f = fixture();
  try {
    ok(await f.discover('campaigns'));
    const p = ok(await f.prepare('111', period()));
    const impact = p.data.creative_impact;
    assert.equal(impact.scope, 'budget_schedule');
    assert.equal(impact.timezone, 'Asia/Riyadh');
    assert.match(impact.starts, /^\d{4}-\d{2}-\d{2} \d{2}:00/);
    assert.equal(impact.daily_budget_native, 10000);
    assert.equal(impact.increase_native, 2000);
    assert.equal(impact.peak_daily_budget_native, 12000);
    assert.equal(impact.max_extra_spend_native, 2000);
    assert.match(impact.cancellation, /cannot cancel/i);
    assert.equal(p.data.execute_requirements.spend_change_confirmed, true);
    assertRefused(await f.execute(p), 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal(f.writes(), 0);
    ok(await f.execute(p, {spend_change_confirmed: true}));
    assert.equal(f.writes(), 1);
    const v = ok(await f.verify(p));
    assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 1200));
    assert.equal((await f.execute(p, {spend_change_confirmed: true})).data.replayed, true);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('a percentage increase is counted from the daily budget, and ad sets work the same way', async () => {
  const f = fixture();
  try {
    ok(await f.discover('adsets'));
    const p = ok(await f.prepare('221', period({budget_value: 50, budget_value_type: 'MULTIPLIER'}), 'adset'));
    assert.equal(p.data.creative_impact.increase_native, 2500);
    assert.equal(p.data.creative_impact.peak_daily_budget_native, 7500);
  } finally {
    f.store.close();
  }
});

test('an account without a spending policy is refused, with advice', async () => {
  const f = fixture({policy: null});
  try {
    ok(await f.discover('campaigns'));
    const r = await f.prepare('111', period());
    assert.equal(r.error?.code, 'POLICY_REQUIRED', JSON.stringify(r).slice(0, 500));
    assert.match(r.error.remedy.action, /Nothing was submitted.*save_spend_policy/);
    assert.match(r.error.message, /save_spend_policy/);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('the full scheduled increase counts against the owner caps when the change is prepared', async () => {
  for (const [policy, code] of [
    [{enforcement: 'block', max_budget_native: 11000}, 'POLICY_BUDGET_LIMIT'],
    [{enforcement: 'block', max_budget_increase_percent: 10}, 'POLICY_INCREASE_LIMIT'],
    [{enforcement: 'block', max_daily_increase_native: 1000}, 'POLICY_DAILY_INCREASE_LIMIT'],
  ]) {
    const f = fixture({policy});
    try {
      ok(await f.discover('campaigns'));
      const r = await f.prepare('111', period());
      assert.equal(r.error?.code, code, JSON.stringify(policy) + ': ' + JSON.stringify(r).slice(0, 500));
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});

test('a period that overlaps an existing one is held against the caps with both increases, and listed in the review', async () => {
  const existing = [
    // Overlaps the new period: 30 USD more from its second to its fourth hour.
    {
      id: '8100',
      budget_value: 30,
      budget_value_type: 'ABSOLUTE',
      time_start: startAt + hour,
      time_end: startAt + 4 * hour,
    },
    // After the new period ends: not counted.
    {
      id: '8101',
      budget_value: 700,
      budget_value_type: 'MULTIPLIER',
      time_start: startAt + 10 * hour,
      time_end: startAt + 14 * hour,
    },
  ];
  const f = fixture({existing, policy: {enforcement: 'block', max_budget_native: 14000}});
  try {
    ok(await f.discover('campaigns'));
    const r = await f.prepare('111', period());
    assert.equal(r.error?.code, 'POLICY_BUDGET_LIMIT', JSON.stringify(r).slice(0, 600));
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
  const g = fixture({existing, policy: {enforcement: 'block', max_budget_native: 16000}});
  try {
    ok(await g.discover('campaigns'));
    const r = ok(await g.prepare('111', period()));
    const impact = r.data.creative_impact;
    assert.deepEqual(impact.overlapping_periods, [{id: '8100', increase_native: 3000}]);
    assert.equal(impact.peak_daily_budget_native, 15000);
    assert.equal(impact.increase_native, 2000);
    assert.match(impact.effect, /15000 with the 1 period\(s\) already scheduled/);
  } finally {
    g.store.close();
  }
});

test('the review needs the account time zone and currency from Meta; it never assumes UTC', async () => {
  for (const options of [{timezone: null}, {timezone: 'Not/AZone'}, {currency: null}]) {
    const f = fixture(options);
    try {
      ok(await f.discover('campaigns'));
      const r = await f.prepare('111', period());
      assert.equal(r.error?.code, 'INCOMPLETE_STATE', JSON.stringify(options) + ': ' + JSON.stringify(r).slice(0, 500));
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});

test("Meta's limits are refused before the request: capability, daily budgets only, 50 periods, 8x, 3 hours, Advantage+ App", async () => {
  const cases = [
    [{capable: false}, '111', period(), 'BUDGET_SCHEDULING_UNAVAILABLE'],
    [{}, '112', period(), 'BUDGET_SCHEDULING_UNAVAILABLE'],
    [{full: true}, '111', period(), 'BUDGET_SCHEDULING_UNAVAILABLE'],
    [{}, '113', period(), 'BUDGET_SCHEDULING_UNAVAILABLE'],
    [{}, '111', period({budget_value: 701}), 'INVALID_META_BUDGET_SCHEDULE'],
  ];
  for (const [options, target, payload, code] of cases) {
    const f = fixture(options);
    try {
      ok(await f.discover('campaigns'));
      const r = await f.prepare(target, payload);
      assert.equal(r.error?.code, code, JSON.stringify([options, target]) + ': ' + JSON.stringify(r).slice(0, 500));
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
  for (const [label, payload] of [
    ['under 3 hours', period({time_end: startAt + 2 * hour})],
    ['in the past', period({time_start: startAt - 96 * hour, time_end: startAt - 90 * hour})],
    ['end before start', period({time_end: startAt - hour})],
    ['multiplier over 700%', period({budget_value: 701, budget_value_type: 'MULTIPLIER'})],
    ['zero increase', period({budget_value: 0})],
    ['fractional value', period({budget_value: 2.5})],
    ['unknown type', period({budget_value_type: 'PERCENT'})],
    ['recurrence', period({recurrence_type: 'WEEKLY'})],
    ['missing end', period({time_end: undefined})],
  ]) {
    const f = fixture();
    try {
      ok(await f.discover('campaigns'));
      const before = f.calls.length,
        r = await f.prepare('111', JSON.parse(JSON.stringify(payload)));
      assert.equal(r.error?.code, 'INVALID_META_BUDGET_SCHEDULE', label + ': ' + JSON.stringify(r).slice(0, 400));
      assert.equal(f.calls.length, before, label);
    } finally {
      f.store.close();
    }
  }
});

test('campaign and ad set requests cannot carry budget_schedule_specs past this review, and the ledger lists both writes', () => {
  const plan = (path, body) => ({
    gateway,
    accountId: '123',
    action: path.endsWith('campaigns') ? 'meta_ad_account_id_campaigns_create' : 'meta_ad_account_id_adsets_create',
    method: 'POST',
    path,
    query: {},
    headers: {},
    body,
    readOnly: false,
    destructive: false,
    requiresConfirmation: true,
    evidence: 'synthetic',
    warnings: [],
  });
  const specs = [{time_start: startAt, time_end: startAt + 6 * hour, budget_value: 100, budget_value_type: 'ABSOLUTE'}];
  for (const p of [
    plan('/v26.0/act_123/campaigns', {
      name: 'C',
      objective: 'OUTCOME_SALES',
      status: 'PAUSED',
      is_adset_budget_sharing_enabled: false,
      budget_schedule_specs: specs,
    }),
    plan('/v26.0/act_123/adsets', {name: 'S', campaign_id: '111', status: 'PAUSED', budget_schedule_specs: specs}),
  ])
    assert.throws(
      () => assertWriteShape(p),
      e => e.code === 'WRITE_CONTRACT_UNAVAILABLE' && /budget_schedules/.test(e.message),
    );
  const rows = actionContracts(registry).filter(
    r =>
      r.gateway === gateway &&
      ['meta_campaign_id_budget_schedules_create', 'meta_ad_set_id_budget_schedules_create'].includes(r.action),
  );
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.family, 'meta_budget_schedules', row.action);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * Budget overrides of Criteo Retail Media campaigns and line items, API 2026-07 (pinned OpenAPI document and the "Budget
 * Overrides" guide, checked 2026-09-27).
 */
const gateway = 'criteo_native_action',
  prefix = '/2026-07/retail-media',
  registry = new Registry();
const actor = {tenantId: 'criteo-overrides', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const actions = {campaign: 'UPDATE_CAMPAIGN_BUDGET_OVERRIDES', line: 'UPDATE_LINE_ITEM_BUDGET_OVERRIDES'};
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const addMonths = (v, n) => {
  const [y, mo] = v.split('-').map(Number),
    t = y * 12 + mo - 1 + n;
  return String(Math.floor(t / 12)) + '-' + String((t % 12) + 1).padStart(2, '0');
};
const shapes = {
  daily: {start: 'startDate', cap: 'maxDailySpend', unit: 'D', add: addDays, today: '2026-09-27'},
  monthly: {start: 'startMonth', cap: 'maxMonthlySpend', unit: 'M', add: addMonths, today: '2026-09'},
};
const names = {
  campaign: {daily: 'dailyBudgetOverrides', monthly: 'monthlyBudgetOverrides', type: 'CampaignBudgetOverrides'},
  line: {
    daily: 'dailyLineItemBudgetOverrides',
    monthly: 'monthlyLineItemBudgetOverrides',
    type: 'LineItemBudgetOverrides',
  },
};
// Criteo fills a null start from the previous override and, as in the guide's line item example, stores back-to-back
// overrides with equal caps as one.
function keep(list, shape) {
  const {start, cap, add} = shapes[shape],
    out = [];
  for (const o of list) {
    const last = out.at(-1),
      from = o[start] ?? add(last.end, 1),
      n = parseInt(o.duration);
    if (last && last.cap === o[cap] && add(last.end, 1) === from) {
      last.n += n;
      last.end = add(last.from, last.n - 1);
    } else out.push({from, n, cap: o[cap], end: add(from, n - 1)});
  }
  return out;
}
// Read-back omits the start of an override that follows the previous one, as in the guide's examples; status is computed.
function show(list, shape) {
  const {start, cap, unit, add, today} = shapes[shape];
  return list.map((o, i) => ({
    ...(i && add(list[i - 1].end, 1) === o.from ? {} : {[start]: o.from}),
    duration: o.n + unit,
    [cap]: o.cap,
    status: o.end < today ? 'Expired' : o.from <= today ? 'Active' : 'Upcoming',
  }));
}
function fixture(mode = '') {
  const store = new Store(':memory:', Buffer.alloc(32, 102).toString('base64'));
  store.putConnection(
    owner,
    {
      id: 'criteo',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Criteo',
      scopes: ['RetailMedia_Accounts_Read', 'RetailMedia_Campaign_Read', 'RetailMedia_Campaign_Manage'],
    },
    {accessToken: 'synthetic'},
  );
  const overrides = {
    campaign: {
      456: {
        daily: keep(
          [
            ...(mode === 'expired' ? [{startDate: '2026-01-10', duration: '2D', maxDailySpend: 50}] : []),
            {startDate: '2030-10-01', duration: '3D', maxDailySpend: 200},
          ],
          'daily',
        ),
        monthly: [],
      },
    },
    line: {
      789: {daily: [], monthly: keep([{startMonth: '2030-11', duration: '2M', maxMonthlySpend: 9000}], 'monthly')},
    },
  };
  const body = (kind, id) => {
    const n = names[kind],
      o = overrides[kind][id];
    return {
      data: {
        type: n.type,
        attributes: {
          [n.daily]: show(o.daily, 'daily').map(e =>
            kind === 'campaign' && e.startDate ? {...e, startDate: e.startDate + 'T00:00:00'} : e,
          ),
          [n.monthly]: show(o.monthly, 'monthly'),
        },
      },
      errors: [],
      warnings: [],
    };
  };
  let writes = 0;
  const calls = [];
  const page = rows => ({
    data: rows,
    metadata: {
      currentPageIndex: 0,
      currentPageSize: 2,
      totalItemsAcrossAllPages: rows.length,
      totalPages: 1,
      nextPage: null,
      previousPage: null,
    },
    errors: [],
    warnings: [],
  });
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        method = init.method;
      calls.push({path: u.pathname, method});
      const m =
          /^\/2026-07\/retail-media\/(?:campaigns\/(\d+)\/campaign-budget-overrides|line-items\/(\d+)\/line-item-budget-overrides)$/.exec(
            u.pathname,
          ),
        kind = m?.[1] ? 'campaign' : 'line',
        target = m?.[1] ?? m?.[2];
      if (method === 'GET') {
        if (u.pathname === prefix + '/accounts')
          return Response.json(
            page([
              {
                id: '123',
                type: 'RetailMediaAccount',
                attributes: {name: 'Account', type: 'demand', currency: 'USD', timeZone: 'America/New_York'},
              },
            ]),
          );
        if (u.pathname === prefix + '/accounts/123/campaigns')
          return Response.json(
            page(
              u.searchParams
                .getAll('limitToId')
                .filter(id => id === '456')
                .map(id => ({
                  id,
                  type: 'RetailMediaCampaignV202301',
                  attributes: {name: 'Summer', accountId: '123', type: 'auction', status: 'active'},
                })),
            ),
          );
        if (u.pathname === prefix + '/accounts/123/line-items')
          return Response.json(
            page(
              u.searchParams
                .getAll('limitToId')
                .filter(id => id === '789')
                .map(id => ({
                  id,
                  type: 'RetailMediaLineItem',
                  attributes: {campaignId: '456', name: 'Line', type: 'auction', status: 'active'},
                })),
            ),
          );
        if (m) return Response.json(body(kind, target));
        throw new Error('Unexpected read ' + u.pathname);
      }
      writes++;
      if (method !== 'PUT' || !m) throw new Error('Unexpected write ' + method + ' ' + u.pathname);
      if (mode === 'warn') return Response.json({data: null, errors: [], warnings: [{code: 'x'}]}, {status: 201});
      const b = JSON.parse(String(init.body)).data.attributes,
        n = names[kind];
      if (mode !== 'ignore')
        overrides[kind][target] = {daily: keep(b[n.daily], 'daily'), monthly: keep(b[n.monthly], 'monthly')};
      // The documented 201 answer carries the overrides as stored.
      return Response.json(body(kind, target), {status: 201});
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    10000,
  );
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const discover = (kind, id) =>
    service.call(
      gateway,
      kind === 'campaign'
        ? {
            operation: 'criteo_campaign_ops',
            arguments: {
              action: 'GET_CAMPAIGNS_BY_ACCOUNT_ID',
              account_id: '123',
              params: {limitToId: [id], pageIndex: 0, pageSize: 2},
            },
          }
        : {
            operation: 'criteo_line_item_ops',
            arguments: {
              action: 'GET_LINE_ITEMS_BY_ACCOUNT_ID',
              account_id: '123',
              params: {limitToId: [id], pageIndex: 0, pageSize: 2},
            },
          },
      actor,
    );
  const put = (kind, id, attributes) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          operation: kind === 'campaign' ? 'criteo_campaign_ops' : 'criteo_line_item_ops',
          arguments: {
            action: actions[kind],
            account_id: '123',
            params: kind === 'campaign' ? {campaignId: id} : {lineItemId: id},
            payload: {data: {attributes}},
          },
        },
      },
      actor,
    );
  const execute = (p, extra = {spend_change_confirmed: true}) =>
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
  return {store, calls, overrides, discover, put, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};
const campaignOverrides = (extra = {}) => ({
  dailyBudgetOverrides: [
    {startDate: '2030-10-01', duration: '3D', maxDailySpend: 250},
    {startDate: null, duration: '2D', maxDailySpend: 120},
  ],
  monthlyBudgetOverrides: [{startMonth: '2030-12', duration: '1M', maxMonthlySpend: 6000}],
  ...extra,
});

test('campaign overrides are replaced once after spending confirmation and verify, with null starts following the previous override', async () => {
  const f = fixture();
  try {
    ok(await f.discover('campaign', '456'));
    const p = ok(await f.put('campaign', '456', campaignOverrides())),
      impact = p.data.creative_impact;
    assert.equal(impact.scope, 'campaign_budget_overrides');
    assert.equal(impact.currency, 'USD');
    assert.deepEqual(
      impact.after.daily.map(r => r.start),
      ['2030-10-01', '2030-10-04'],
    );
    assert.match(impact.effect, /left out of the request are removed/);
    assert.equal((await f.execute(p, {})).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    ok(await f.execute(p));
    assert.equal(f.writes(), 1);
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('line item overrides are replaced and verify; back-to-back equal caps compare as Criteo merges them; clearing every override is allowed', async () => {
  const f = fixture();
  try {
    ok(await f.discover('line', '789'));
    const daily = [{startDate: '2030-10-10', duration: '1D', maxDailySpend: 0}];
    const p = ok(
      await f.put('line', '789', {
        dailyLineItemBudgetOverrides: daily,
        monthlyLineItemBudgetOverrides: [
          {startMonth: '2031-01', duration: '3M', maxMonthlySpend: 12},
          {startMonth: '2031-04', duration: '3m', maxMonthlySpend: 12},
        ],
      }),
    );
    ok(await f.execute(p));
    assert.equal(f.overrides.line[789].monthly.length, 1);
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.match(
      (
        await f.put('line', '789', {
          dailyLineItemBudgetOverrides: daily,
          monthlyLineItemBudgetOverrides: [{startMonth: '2031-01', duration: '6M', maxMonthlySpend: 12}],
        })
      ).error?.message ?? '',
      /already has exactly these overrides/,
    );
    const clear = ok(
      await f.put('line', '789', {dailyLineItemBudgetOverrides: [], monthlyLineItemBudgetOverrides: []}),
    );
    ok(await f.execute(clear));
    assert.equal(ok(await f.verify(clear)).data.status, 'verified');
    assert.equal(f.writes(), 2);
  } finally {
    f.store.close();
  }
});

test('malformed overrides are refused before any request', async () => {
  const cases = [
    ['missing monthly list', {dailyBudgetOverrides: []}],
    ['first start missing', campaignOverrides({dailyBudgetOverrides: [{duration: '2D', maxDailySpend: 10}]})],
    [
      'overlap',
      campaignOverrides({
        dailyBudgetOverrides: [
          {startDate: '2030-10-01', duration: '5D', maxDailySpend: 10},
          {startDate: '2030-10-03', duration: '1D', maxDailySpend: 10},
        ],
      }),
    ],
    [
      'out of order',
      campaignOverrides({
        monthlyBudgetOverrides: [
          {startMonth: '2030-12', duration: '1M', maxMonthlySpend: 1},
          {startMonth: '2030-11', duration: '1M', maxMonthlySpend: 1},
        ],
      }),
    ],
    [
      'bad duration unit',
      campaignOverrides({dailyBudgetOverrides: [{startDate: '2030-10-01', duration: '3M', maxDailySpend: 10}]}),
    ],
    [
      'negative cap',
      campaignOverrides({dailyBudgetOverrides: [{startDate: '2030-10-01', duration: '3D', maxDailySpend: -1}]}),
    ],
    [
      'status sent',
      campaignOverrides({
        dailyBudgetOverrides: [{startDate: '2030-10-01', duration: '3D', maxDailySpend: 10, status: 'Active'}],
      }),
    ],
    [
      'date with time',
      campaignOverrides({
        dailyBudgetOverrides: [{startDate: '2030-10-01T00:00:00', duration: '3D', maxDailySpend: 10}],
      }),
    ],
    [
      'impossible date',
      campaignOverrides({dailyBudgetOverrides: [{startDate: '2030-02-30', duration: '3D', maxDailySpend: 10}]}),
    ],
    ['line item list names', {dailyLineItemBudgetOverrides: [], monthlyLineItemBudgetOverrides: []}],
  ];
  for (const [label, attributes] of cases) {
    const f = fixture();
    try {
      await f.discover('campaign', '456');
      const before = f.calls.length;
      const r = await f.put('campaign', '456', attributes);
      assert.equal(r.error?.code, 'INVALID_CRITEO_BUDGET_OVERRIDE', label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(f.calls.length, before, label);
    } finally {
      f.store.close();
    }
  }
});

test('undiscovered targets, unchanged overrides and monetary owner policies are refused without writes; activation policies do not apply', async () => {
  const f = fixture();
  try {
    assert.equal((await f.put('campaign', '456', campaignOverrides())).error?.code, 'RESOURCE_SCOPE_REQUIRED');
    ok(await f.discover('campaign', '456'));
    assert.match(
      (
        await f.put('campaign', '456', {
          dailyBudgetOverrides: [{startDate: '2030-10-01', duration: '3D', maxDailySpend: 200}],
          monthlyBudgetOverrides: [],
        })
      ).error?.message ?? '',
      /already has exactly these overrides/,
    );
    saveSpendPolicy(f.store, owner, {gateway, account_id: '123', confirmed: true, policy: {allow_activation: false}});
    ok(await f.put('campaign', '456', campaignOverrides()));
    saveSpendPolicy(f.store, owner, {
      gateway,
      account_id: '123',
      confirmed: true,
      policy: {enforcement: 'block', max_budget_native: 10000},
    });
    assert.equal((await f.put('campaign', '456', campaignOverrides())).error?.code, 'POLICY_AMOUNT_UNSUPPORTED');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('expired overrides are kept as stored: leaving one out or changing its cap is refused, and kept it verifies with the rest', async () => {
  const f = fixture('expired');
  try {
    ok(await f.discover('campaign', '456'));
    const dropped = await f.put('campaign', '456', campaignOverrides());
    assert.equal(dropped.error?.code, 'INVALID_CRITEO_BUDGET_OVERRIDE');
    assert.match(dropped.error.message, /expired daily override from 2026-01-10/);
    const changed = await f.put(
      'campaign',
      '456',
      campaignOverrides({
        dailyBudgetOverrides: [
          {startDate: '2026-01-10', duration: '2D', maxDailySpend: 60},
          ...campaignOverrides().dailyBudgetOverrides,
        ],
      }),
    );
    assert.equal(changed.error?.code, 'INVALID_CRITEO_BUDGET_OVERRIDE');
    assert.equal(f.writes(), 0);
    const p = ok(
      await f.put(
        'campaign',
        '456',
        campaignOverrides({
          dailyBudgetOverrides: [
            {startDate: '2026-01-10', duration: '1D', maxDailySpend: 50},
            {startDate: null, duration: '1D', maxDailySpend: 50},
            ...campaignOverrides().dailyBudgetOverrides,
          ],
        }),
      ),
    );
    ok(await f.execute(p));
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('a response with warnings is a failure that is never resubmitted, an ignored PUT is not verified, and the ledger lists both writes', async () => {
  const warn = fixture('warn');
  try {
    ok(await warn.discover('campaign', '456'));
    const p = ok(await warn.put('campaign', '456', campaignOverrides()));
    assertRefused(await warn.execute(p), 'WRITE_PARTIAL_OR_FAILED');
    assertRefused(await warn.execute(p), 'WRITE_PARTIAL_OR_FAILED');
    assert.equal(warn.writes(), 1);
  } finally {
    warn.store.close();
  }
  const ignored = fixture('ignore');
  try {
    ok(await ignored.discover('campaign', '456'));
    const p = ok(await ignored.put('campaign', '456', campaignOverrides()));
    ok(await ignored.execute(p));
    assert.notEqual(ok(await ignored.verify(p)).data.status, 'verified');
  } finally {
    ignored.store.close();
  }
  const d = JSON.parse(readFileSync('.mirror/VENDOR/criteo-retail-2026-07.json', 'utf8')),
    S = (d.document ?? d).components.schemas;
  assert.deepEqual([...S.CampaignBudgetOverrides.required].sort(), ['dailyBudgetOverrides', 'monthlyBudgetOverrides']);
  assert.deepEqual([...S.LineItemBudgetOverrides.required].sort(), [
    'dailyLineItemBudgetOverrides',
    'monthlyLineItemBudgetOverrides',
  ]);
  for (const action of Object.values(actions)) {
    const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.action === action);
    assert.equal(rows.length, 1, action);
    assert.equal(rows[0].status, 'reviewed_write_family', action);
    assert.equal(rows[0].family, 'criteo_budget_overrides', action);
  }
});

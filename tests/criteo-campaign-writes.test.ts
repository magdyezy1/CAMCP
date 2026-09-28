import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {actionContracts} from '../src/action-contracts.js';
import {criteoCampaignFields} from '../src/criteo-campaign-writes.js';
import {DelegatedNativeCompiler} from '../src/delegated-native.js';
import {removeTestDirectory} from './temp.js';
import type {Connection, JsonObject} from '../src/types.js';

const gateway = 'criteo_native_action',
  prefix = '/2026-01/retail-media',
  registry = new Registry();
const actor = {tenantId: 'criteo-campaign-test', userId: 'operator', role: 'operator' as const},
  owner = {...actor, role: 'admin' as const},
  key = Buffer.alloc(32, 52).toString('base64');
const attributes = (): JsonObject => ({
  name: 'Summer campaign',
  budget: 1000,
  dailyPacing: 25,
  monthlyPacing: 500,
  isAutoDailyPacing: false,
  startDate: '2030-08-01T00:00:00Z',
  endDate: '2030-08-31T23:59:59Z',
  clickAttributionWindow: '30D',
  viewAttributionWindow: '1D',
  clickAttributionScope: 'sameSkuCategory',
  viewAttributionScope: 'sameSku',
  companyName: 'Test advertiser',
  onBehalfCompanyName: null,
});
const native = (kind = 'create', a = attributes()): JsonObject => ({
  operation: 'criteo_campaign_ops',
  arguments: {
    action: kind === 'create' ? 'CREATE_CAMPAIGNS_BY_ACCOUNT_ID' : 'UPDATE_CAMPAIGN_BY_CAMPAIGN_ID',
    account_id: '123',
    ...(kind === 'update' ? {params: {campaignId: '456'}} : {}),
    payload: {
      data: {
        type: 'Campaign',
        ...(kind === 'update' ? {id: '456'} : {}),
        attributes: kind === 'create' ? {...a, type: 'auction', drawableBalanceIds: ['987']} : a,
      },
    },
  },
});
function fixture(
  file = ':memory:',
  data: JsonObject = {
    writes: 0,
    campaign: {
      id: '456',
      type: 'RetailMediaCampaignV202301',
      attributes: {
        ...attributes(),
        accountId: '123',
        type: 'auction',
        drawableBalanceIds: ['987'],
        promotedBrandIds: [],
        retailerId: null,
        status: 'inactive',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    },
    lines: [
      {
        id: '789',
        type: 'SponsoredProductsLineItem',
        attributes: {
          campaignId: '456',
          targetRetailerId: '55',
          name: 'Product line',
          status: 'paused',
          budget: 200,
          dailyPacing: 10,
          monthlyPacing: 100,
          isAutoDailyPacing: false,
          startDate: '2030-08-01T00:00:00Z',
          endDate: '2030-08-31T23:59:59Z',
          bidStrategy: 'manual',
          targetBid: 1,
          maxBid: 2,
        },
      },
    ],
  },
  allowWrites = true,
) {
  let store = new Store(file, key);
  const c: Connection = {
    id: '22222222-2222-4222-8222-222222222222',
    tenantId: actor.tenantId,
    gateway,
    accounts: ['123'],
    writeAccounts: ['123'],
    label: 'Synthetic campaign login',
    enabled: true,
    scopes: [
      'RetailMedia_Accounts_Read',
      'RetailMedia_Campaign_Read',
      'RetailMedia_Campaign_Manage',
      'RetailMedia_Balance_Read',
    ],
  };
  if (!store.listConnections(actor.tenantId).length) store.putConnection(owner, c, {accessToken: 'synthetic'});
  const calls: JsonObject[] = [];
  let mode = '',
    hook: (() => void) | undefined;
  const page = (rows: JsonObject[], u: URL) => ({
    data: rows,
    metadata: {
      currentPageIndex: 0,
      currentPageSize: Number(u.searchParams.get('pageSize') ?? 25),
      totalItemsAcrossAllPages: rows.length,
      totalPages: 1,
      nextPage: mode === 'incomplete' ? 'https://foreign.invalid/next' : null,
    },
    errors: [],
    warnings: [],
  });
  const transport = new NativeTransport(
    async (raw, init) => {
      const u = new URL(String(raw)),
        method = init!.method;
      assert.equal(u.origin, 'https://api.criteo.com');
      assert.equal(init?.redirect, 'error');
      calls.push({
        path: u.pathname,
        query: [...u.searchParams],
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (method === 'POST' || method === 'PUT') {
        data.writes++;
        const b = JSON.parse(String(init?.body));
        data.campaign = {
          id: method === 'POST' ? '457' : '456',
          type: 'RetailMediaCampaignV202301',
          attributes: {
            ...data.campaign.attributes,
            ...b.data.attributes,
            accountId: '123',
            retailerId: null,
            status: 'inactive',
          },
        };
        if (method === 'POST') data.lines = [];
        if (mode === 'lost') throw Error('Response lost after acceptance');
        if (mode === 'wrong_receipt')
          return Response.json(
            {data: {...data.campaign, attributes: {...data.campaign.attributes, accountId: '999'}}},
            {status: method === 'POST' ? 201 : 200},
          );
        return Response.json(
          {data: data.campaign, errors: mode === 'partial' ? [{code: 'partial'}] : [], warnings: []},
          {status: method === 'POST' ? 201 : 200},
        );
      }
      hook?.();
      if (u.pathname === prefix + '/accounts')
        return Response.json(
          page(
            [
              {
                id: '123',
                type: 'RetailMediaAccount',
                attributes: {
                  currency: 'USD',
                  timeZone: 'America/New_York',
                  type: 'demand',
                  name: 'Account ' + calls.length,
                },
              },
            ],
            u,
          ),
        );
      if (u.pathname === prefix + '/accounts/123/campaigns') {
        const rows = u.searchParams.getAll('limitToId').includes(data.campaign.id)
          ? [structuredClone(data.campaign)]
          : [];
        if (rows[0]) {
          rows[0].attributes.budgetSpent = calls.length;
          rows[0].attributes.budgetRemaining = 1000 - calls.length;
          rows[0].attributes.updatedAt = new Date().toISOString();
          rows[0].attributes.status = data.lines.some((r: JsonObject) => r.attributes.status === 'active')
            ? 'active'
            : 'inactive';
          if (mode === 'foreign') rows[0].attributes.accountId = '999';
        }
        return Response.json(page(rows, u));
      }
      if (u.pathname === prefix + '/accounts/123/balances')
        return Response.json(
          page(
            u.searchParams.getAll('limitToId').map(balance => ({
              id: mode === 'foreign_balance' ? '999' : balance,
              type: 'Balance',
              attributes: {
                name: 'Fund',
                balanceType: 'capped',
                deposited: data.deposited ?? 10000,
                spent: calls.length,
                remaining: 10000 - calls.length,
                spendType: 'Onsite',
                privateMarketBillingType: 'notApplicable',
                startDate: '2026-01-01',
                endDate: null,
                status: 'active',
              },
            })),
            u,
          ),
        );
      if (/\/campaigns\/\d+\/campaign-budget-overrides$/.test(u.pathname))
        return Response.json({
          data: {
            type: 'CampaignBudgetOverrides',
            attributes: {
              dailyBudgetOverrides:
                mode === 'overrides' ? [{startDate: '2030-08-01', duration: '1D', maxDailySpend: 100}] : [],
              monthlyBudgetOverrides: [],
            },
          },
          errors: [],
          warnings: [],
        });
      if (/\/campaigns\/\d+\/auction-line-items$/.test(u.pathname)) {
        const limit = Number(u.searchParams.get('limit')),
          offset = Number(u.searchParams.get('offset')),
          rows = structuredClone(data.lines.slice(offset, offset + limit));
        if (mode === 'short_page') rows.splice(1);
        if (mode === 'duplicate_lines' && rows.length) rows.push(structuredClone(rows[0]));
        if (mode === 'foreign_line' && rows.length) rows[0].attributes.campaignId = '999';
        return Response.json({
          data: rows,
          metadata: {
            limit,
            offset: mode === 'wrong_offset' ? offset + 1 : offset,
            count: mode === 'page_count' ? rows.length : mode === 'missing_count' ? null : data.lines.length,
          },
          errors: mode === 'line_error' ? [{code: 'partial'}] : [],
          warnings: [],
        });
      }
      assert.fail('Unexpected provider request ' + u.pathname);
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    10000,
  );
  const build = () =>
    new MirrorService(registry, store, transport, undefined, {
      allowWrites,
      requireBeforeState: true,
      maxBudgetChange: 0,
    });
  let service = build();
  const discover = () =>
    service.call(
      gateway,
      {
        operation: 'criteo_campaign_ops',
        arguments: {
          action: 'GET_CAMPAIGNS_BY_ACCOUNT_ID',
          account_id: '123',
          params: {limitToId: ['456'], pageIndex: 0, pageSize: 2},
        },
      },
      actor,
    );
  const prepare = (kind = 'create', a = attributes()) =>
    service.call('amcp_write', {action: 'prepare', gateway, arguments: native(kind, a)}, actor);
  const execute = (p: JsonObject, extra: JsonObject = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: p.data.review_id,
        idempotency_key: p.data.idempotency_key,
        confirmed: true,
        spend_change_confirmed: true,
        ...extra,
      },
      actor,
    );
  const verify = (p: JsonObject) =>
    service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {
    get store() {
      return store;
    },
    get service() {
      return service;
    },
    c,
    calls,
    data,
    prepare,
    execute,
    verify,
    discover,
    mode: (s: string) => {
      mode = s;
    },
    hook: (h: typeof hook) => {
      hook = h;
    },
    restart: () => {
      store.close();
      store = new Store(file, key);
      service = build();
    },
  };
}
for (const kind of ['create', 'update'])
  test('Criteo ' + kind + ' campaign uses a frozen review, one submission and scoped read-back', async () => {
    const f = fixture();
    try {
      if (kind === 'update') assert.equal((await f.discover()).success, true);
      const a = attributes();
      a.name = 'Reviewed ' + kind;
      const p = await f.prepare(kind, a);
      assert.equal(p.success, true, JSON.stringify(p));
      assert.equal(f.data.writes, 0);
      const r = await f.execute(p);
      assert.equal(r.success, true, JSON.stringify(r));
      assert.equal(f.data.writes, 1);
      const v = await f.verify(p);
      assert.equal(v.success, true, JSON.stringify(v));
      assert.equal(v.data.status, 'verified', JSON.stringify(v));
      assert.equal((await f.execute(p)).success, true);
      assert.equal(f.data.writes, 1);
    } finally {
      f.store.close();
    }
  });
test('campaign routes, complete PUT fields and scopes agree with the pinned native schema', () => {
  const compiler = new DelegatedNativeCompiler(),
    spec = JSON.parse(readFileSync('.mirror/VENDOR/criteo-retail-2026-01.json', 'utf8')).document;
  assert.deepEqual(
    [...criteoCampaignFields].sort(),
    Object.keys(spec.components.schemas.EditableCampaignAttributesV202301.properties).sort(),
  );
  for (const kind of ['create', 'update']) {
    const n = native(kind),
      p = compiler.compile(gateway, n);
    assert.equal(p.method, kind === 'create' ? 'POST' : 'PUT');
    assert.deepEqual(p.body, n.arguments.payload);
    assert.equal(
      actionContracts(registry).find(r => r.gateway === gateway && r.action === n.arguments.action)?.family,
      'criteo_campaigns',
    );
  }
  const collection = spec.paths[prefix + '/accounts/{account-id}/campaigns'].post,
    update = spec.paths[prefix + '/campaigns/{campaignId}'].put;
  assert.deepEqual(collection.security, [{oauth: ['RetailMedia_Campaign_Manage']}]);
  assert.deepEqual(update.security, collection.security);
  assert.ok(collection.responses['201']);
  assert.ok(update.responses['200']);
  assert.equal(spec.components.schemas.CampaignAttributesV202301.properties.budget.type, 'number');
});
test('PUT refuses missing limits and unqualified fields before any provider request', async () => {
  const changes: Array<(a: JsonObject) => void> = [
    a => {
      delete a.budget;
    },
    a => {
      delete a.dailyPacing;
    },
    a => {
      delete a.companyName;
    },
    a => {
      a.budget = null;
    },
    a => {
      a.monthlyPacing = null;
    },
    a => {
      a.dailyPacing = -1;
    },
    a => {
      a.dailyPacing = 0;
    },
    a => {
      a.companyName = 'x'.repeat(256);
    },
    a => {
      a.budget = '1000';
    },
    a => {
      a.budget = Number.MAX_SAFE_INTEGER + 1;
    },
    a => {
      a.isAutoDailyPacing = true;
    },
    a => {
      a.startDate = '2030-02-30T00:00:00Z';
    },
    a => {
      a.startDate = '2030-08-01';
    },
    a => {
      a.endDate = a.startDate;
    },
    a => {
      a.viewAttributionWindow = '30D';
      a.clickAttributionWindow = '7D';
    },
    a => {
      a.status = 'active';
    },
    a => {
      a.type = 'preferred';
    },
    a => {
      a.drawableBalanceIds = [];
    },
    a => {
      a.retailerId = 55;
    },
  ];
  for (const change of changes) {
    const f = fixture();
    try {
      await f.discover();
      const a = attributes();
      change(a);
      const calls = f.calls.length,
        r = await f.prepare('update', a);
      assert.equal(r.success, false, JSON.stringify(a));
      assert.equal(f.calls.length, calls, JSON.stringify(r));
      assert.equal(f.data.writes, 0);
    } finally {
      f.store.close();
    }
  }
});
test('creation refuses preferred campaigns, guessed balances, wrong resource IDs and request overrides', async () => {
  const variants: Array<(n: JsonObject) => void> = [
    n => {
      n.arguments.payload.data.attributes.type = 'preferred';
    },
    n => {
      n.arguments.payload.data.attributes.drawableBalanceIds = ['987', '987'];
    },
    n => {
      n.arguments.payload.data.attributes.retailerId = 55;
    },
    n => {
      n.arguments.payload.data.id = '456';
    },
    n => {
      n.arguments.payload.data.attributes.accountId = '999';
    },
    n => {
      n.arguments.headers = {authorization: 'untrusted'};
    },
  ];
  for (const change of variants) {
    const f = fixture();
    try {
      const n = native();
      change(n);
      const r = await f.service.call('amcp_write', {action: 'prepare', gateway, arguments: n}, actor);
      assert.equal(r.success, false);
      assert.equal(f.calls.length, 0, JSON.stringify(r));
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    f.mode('foreign_balance');
    const r = await f.prepare();
    assert.equal(r.error?.code, 'CRITEO_CAMPAIGN_STATE_UNVERIFIED');
    assert.equal(f.data.writes, 0);
  } finally {
    f.store.close();
  }
});
test('state hashes ignore spending telemetry and membership order, while preserving ordered arrays', async () => {
  const f = fixture();
  try {
    f.data.lines.push({...structuredClone(f.data.lines[0]), id: '790'});
    f.data.campaign.attributes.drawableBalanceIds = ['987', '988'];
    await f.discover();
    const p = await f.prepare('update');
    assert.equal(p.success, true, JSON.stringify(p));
    f.data.lines.reverse();
    f.data.campaign.attributes.drawableBalanceIds.reverse();
    assert.equal((await f.execute(p)).success, true);
    assert.equal(f.data.writes, 1);
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    g.data.lines[0].attributes.flightSchedule = {
      legs: [
        {dayOfWeek: 'monday', startTime: '08:00', endTime: '12:00'},
        {dayOfWeek: 'friday', startTime: '14:00', endTime: '18:00'},
      ],
    };
    await g.discover();
    const p = await g.prepare('update');
    assert.equal(p.success, true);
    g.data.lines[0].attributes.flightSchedule.legs.reverse();
    const r = await g.execute(p);
    assert.equal(r.error?.code, 'STATE_CHANGED');
    assert.ok(r.error.details.changed_fields.some((s: string) => s.includes('legs')));
    assert.equal(g.data.writes, 0);
  } finally {
    g.store.close();
  }
});
test('real campaign, balance, bid, schedule, attribution and parent changes invalidate the review', async () => {
  const changes: Array<[string, (d: JsonObject) => void]> = [
    [
      'budget',
      d => {
        d.campaign.attributes.budget = 1200;
      },
    ],
    [
      'dailyPacing',
      d => {
        d.campaign.attributes.dailyPacing = 30;
      },
    ],
    [
      'name',
      d => {
        d.campaign.attributes.name = 'External edit';
      },
    ],
    [
      'startDate',
      d => {
        d.campaign.attributes.startDate = '2030-07-01T00:00:00Z';
      },
    ],
    [
      'clickAttributionWindow',
      d => {
        d.campaign.attributes.clickAttributionWindow = '14D';
      },
    ],
    [
      'deposited',
      d => {
        d.deposited = 12000;
      },
    ],
    [
      'maxBid',
      d => {
        d.lines[0].attributes.maxBid = 3;
      },
    ],
    [
      'status',
      d => {
        d.lines[0].attributes.status = 'active';
      },
    ],
  ];
  for (const [field, change] of changes) {
    const f = fixture();
    try {
      await f.discover();
      const p = await f.prepare('update');
      assert.equal(p.success, true, JSON.stringify(p));
      change(f.data);
      const r = await f.execute(p);
      assert.equal(r.error?.code, 'STATE_CHANGED', JSON.stringify(r));
      assert.ok(
        r.error.details.changed_fields.some((s: string) => s.includes(field)),
        JSON.stringify(r),
      );
      assert.equal(f.data.writes, 0);
    } finally {
      f.store.close();
    }
  }
});
test('foreign, partial, changing and override-bearing dependencies cannot authorize a campaign PUT', async () => {
  for (const mode of [
    'foreign',
    'incomplete',
    'overrides',
    'foreign_line',
    'wrong_offset',
    'line_error',
    'duplicate_lines',
  ]) {
    const f = fixture();
    try {
      await f.discover();
      f.mode(mode);
      const r = await f.prepare('update');
      assert.equal(r.error?.code, 'CRITEO_CAMPAIGN_STATE_UNVERIFIED', JSON.stringify({mode, r}));
      assert.equal(f.data.writes, 0);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    await f.discover();
    let reads = 0;
    f.hook(() => {
      if (++reads === 6) f.data.campaign.attributes.name = 'Changed during collection';
    });
    const r = await f.prepare('update');
    assert.equal(r.error?.code, 'CRITEO_CAMPAIGN_STATE_UNVERIFIED', JSON.stringify(r));
  } finally {
    f.store.close();
  }
});
test('pagination proves an empty terminal page and supports nullable or per-page metadata counts', async () => {
  for (const mode of ['', 'short_page', 'page_count', 'missing_count']) {
    const f = fixture();
    try {
      f.data.lines.push({...structuredClone(f.data.lines[0]), id: '790'});
      await f.discover();
      f.mode(mode);
      const p = await f.prepare('update');
      assert.equal(p.success, true, JSON.stringify({mode, p}));
      const pages = f.calls.filter(c => c.path.endsWith('/auction-line-items'));
      assert.ok(pages.some(c => c.query.some(([k, v]: string[]) => k === 'offset' && v === '2')));
      assert.equal((await f.execute(p)).success, true);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    const line = f.data.lines[0];
    f.data.lines = Array.from({length: 501}, (_, i) => ({...structuredClone(line), id: String(10000 + i)}));
    await f.discover();
    const p = await f.prepare('update');
    assert.equal(p.success, true, JSON.stringify(p));
    assert.ok(f.calls.some(c => c.query.some(([k, v]: string[]) => k === 'offset' && v === '501')));
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    g.data.lines = Array.from({length: 1001}, (_, i) => ({...structuredClone(g.data.lines[0]), id: String(10000 + i)}));
    await g.discover();
    assert.equal((await g.prepare('update')).error?.code, 'CRITEO_CAMPAIGN_STATE_UNVERIFIED');
  } finally {
    g.store.close();
  }
});
test('all three native monetary limits obey absolute, percentage and cumulative owner policies', async () => {
  for (const field of ['budget', 'dailyPacing', 'monthlyPacing']) {
    const f = fixture();
    try {
      await f.discover();
      saveSpendPolicy(f.store, owner, {
        scope: 'workspace',
        confirmed: true,
        policy: {max_budget_native: 1000, max_budget_increase_percent: 10},
      });
      const a = attributes();
      a[field] *= 1.5;
      const r = await f.prepare('update', a);
      assert.equal(
        r.error?.code,
        field === 'budget' ? 'POLICY_BUDGET_LIMIT' : 'POLICY_INCREASE_LIMIT',
        JSON.stringify({field, r}),
      );
      assert.equal(f.data.writes, 0);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    saveSpendPolicy(f.store, owner, {
      scope: 'workspace',
      confirmed: true,
      policy: {max_budget_native: 1000, max_budget_increase_percent: 0, max_daily_increase_native: 1524},
    });
    assert.equal((await f.prepare()).error?.code, 'POLICY_DAILY_INCREASE_LIMIT');
    saveSpendPolicy(f.store, owner, {
      scope: 'workspace',
      confirmed: true,
      policy: {max_budget_native: 1000, max_budget_increase_percent: 0, max_daily_increase_native: 1525},
    });
    const p = await f.prepare();
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal((await f.execute(p)).success, true);
    const reservation = f.store.document(actor.tenantId, 'spend_reservation', p.data.review_id);
    assert.equal(reservation.increase_native, 1525);
  } finally {
    f.store.close();
  }
});
test('PUT uses the campaign baseline, never a child budget, and does not net decreases against increases', async () => {
  const f = fixture();
  try {
    await f.discover();
    saveSpendPolicy(f.store, owner, {
      scope: 'workspace',
      confirmed: true,
      policy: {max_budget_increase_percent: 10, max_daily_increase_native: 3},
    });
    const a = attributes();
    a.dailyPacing = 27;
    a.monthlyPacing = 400;
    const p = await f.prepare('update', a);
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal((await f.execute(p)).success, true);
    assert.equal(f.store.document(actor.tenantId, 'spend_reservation', p.data.review_id).increase_native, 2);
    a.dailyPacing = 29;
    assert.equal((await f.prepare('update', a)).error?.code, 'POLICY_DAILY_INCREASE_LIMIT');
    assert.equal(f.data.writes, 1);
  } finally {
    f.store.close();
  }
});
test('owner activation policy, spend confirmation and native/deployment bypass controls remain enforced', async () => {
  const f = fixture();
  try {
    saveSpendPolicy(f.store, owner, {scope: 'workspace', confirmed: true, policy: {allow_activation: false}});
    assert.equal((await f.prepare()).error?.code, 'POLICY_ACTIVATION_FORBIDDEN');
    saveSpendPolicy(f.store, owner, {scope: 'workspace', confirmed: true, policy: {allow_activation: true}});
    const p = await f.prepare();
    assert.equal(p.success, true);
    assert.equal((await f.execute(p, {spend_change_confirmed: false})).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    const n = native();
    n.arguments.dry_run = false;
    n.arguments.confirmed = true;
    const r = await f.service.call(gateway, n, actor);
    assert.equal(r.error?.code, 'IDEMPOTENCY_REQUIRED', JSON.stringify(r));
    const plan = new DelegatedNativeCompiler().compile(gateway, n);
    await assert.rejects(
      () =>
        f.service.runPlan(
          plan,
          {
            dry_run: false,
            confirmed: true,
            spend_change_confirmed: true,
            idempotency_key: 'bypass',
            skip_preflight: true,
            before_state: {},
          },
          actor,
        ),
      {code: 'WRITE_REVIEW_REQUIRED'},
    );
    assert.equal(f.data.writes, 0);
  } finally {
    f.store.close();
  }
  const g = fixture(':memory:', undefined, false);
  try {
    const p = await g.prepare();
    assert.equal(p.error?.code, 'LIVE_WRITES_DISABLED');
    assert.equal(g.calls.length, 0);
    assert.equal(g.data.writes, 0);
  } finally {
    g.store.close();
  }
});
test('guessed IDs, another login and revoked or replaced credentials do not inherit campaign authority', async () => {
  const f = fixture();
  try {
    assert.equal((await f.prepare('update')).error?.code, 'RESOURCE_SCOPE_REQUIRED');
    await f.discover();
    const other = {...f.c, id: '33333333-3333-4333-8333-333333333333'};
    f.store.putConnection(owner, other, {accessToken: 'synthetic-other'});
    const n = native('update');
    n.arguments.connection_id = other.id;
    assert.equal(
      (await f.service.call('amcp_write', {action: 'prepare', gateway, arguments: n}, actor)).error?.code,
      'RESOURCE_SCOPE_REQUIRED',
    );
  } finally {
    f.store.close();
  }
  for (const mode of ['scope', 'writeGrant', 'credentials']) {
    const f = fixture();
    try {
      await f.discover();
      f.hook(() => {
        f.hook(undefined);
        f.store.putConnection(
          owner,
          {
            ...f.c,
            ...(mode === 'scope'
              ? {scopes: f.c.scopes.filter(s => s !== 'RetailMedia_Campaign_Manage')}
              : mode === 'writeGrant'
                ? {writeAccounts: []}
                : {}),
          },
          {accessToken: mode === 'credentials' ? 'replacement' : 'synthetic'},
        );
      });
      const r = await f.prepare('update');
      assert.equal(r.success, false, JSON.stringify(mode));
      assert.equal(f.data.writes, 0);
    } finally {
      f.store.close();
    }
  }
});
test('parallel execution of one review makes one mutation and two reviews cannot exceed the daily reservation', async () => {
  const f = fixture();
  try {
    const p = await f.prepare();
    assert.equal(p.success, true);
    const rs = await Promise.all([f.execute(p), f.execute(p)]);
    assert.ok(rs.some(r => r.success));
    assert.equal(f.data.writes, 1);
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    await g.discover();
    saveSpendPolicy(g.store, owner, {scope: 'workspace', confirmed: true, policy: {max_daily_increase_native: 3}});
    const a = attributes();
    a.dailyPacing = 27;
    const p = await g.prepare('update', a),
      q = await g.prepare('update', a);
    assert.equal(p.success, true);
    assert.equal(q.success, true);
    await Promise.all([g.execute(p), g.execute(q)]);
    assert.equal(g.data.writes, 1);
  } finally {
    g.store.close();
  }
});
test('lost and partial receipts survive process restart without permitting a second mutation', async () => {
  for (const mode of ['lost', 'partial', 'wrong_receipt']) {
    const dir = mkdtempSync(join(tmpdir(), 'amcp-criteo-campaign-')),
      f = fixture(join(dir, 'state.sqlite'));
    try {
      const p = await f.prepare();
      assert.equal(p.success, true);
      f.mode(mode);
      const r = await f.execute(p);
      assert.equal(r.success, false, JSON.stringify({mode, r}));
      assert.equal(f.data.writes, 1);
      assert.equal(f.store.ownsResource(f.c, '123', 'criteo-report-target/campaigns/457'), false);
      f.restart();
      assert.equal((await f.execute(p)).success, false);
      assert.equal(f.data.writes, 1);
    } finally {
      f.store.close();
      removeTestDirectory(dir, 'amcp-criteo-campaign-');
    }
  }
});
test('a creation receipt grants no ownership until independent account read-back verifies the requested fields', async () => {
  const f = fixture();
  try {
    const p = await f.prepare();
    assert.equal(p.success, true);
    assert.equal((await f.execute(p)).success, true);
    assert.equal(f.store.ownsResource(f.c, '123', 'criteo-report-target/campaigns/457'), false);
    f.data.campaign.attributes.dailyPacing = 99;
    assert.equal((await f.verify(p)).data.status, 'inconclusive');
    assert.equal(f.store.ownsResource(f.c, '123', 'criteo-report-target/campaigns/457'), false);
    f.data.campaign.attributes.dailyPacing = 25;
    assert.equal((await f.verify(p)).data.status, 'verified');
    assert.equal(f.store.ownsResource(f.c, '123', 'criteo-report-target/campaigns/457'), true);
    const n = native('update');
    n.arguments.params.campaignId = '457';
    n.arguments.payload.data.id = '457';
    assert.equal((await f.service.call('amcp_write', {action: 'prepare', gateway, arguments: n}, actor)).success, true);
  } finally {
    f.store.close();
  }
});
test('read-back accepts computed budget-hit recovery but detects a separate manual status change', async () => {
  for (const prior of ['budgetHit', 'paused']) {
    const f = fixture();
    try {
      f.data.lines[0].attributes.status = prior;
      await f.discover();
      const p = await f.prepare('update');
      assert.equal(p.success, true);
      assert.equal((await f.execute(p)).success, true);
      f.data.lines[0].attributes.status = 'active';
      assert.equal((await f.verify(p)).data.status, prior === 'budgetHit' ? 'verified' : 'inconclusive');
    } finally {
      f.store.close();
    }
  }
});
test('returned read instructions execute and verification needs current read rights, not retained write rights', async () => {
  const f = fixture();
  try {
    const p = await f.prepare();
    assert.equal(p.success, true);
    assert.equal((await f.execute(p)).success, true);
    f.store.putConnection(
      owner,
      {...f.c, scopes: f.c.scopes.filter(s => s !== 'RetailMedia_Campaign_Manage')},
      {accessToken: 'synthetic'},
    );
    const v = await f.verify(p);
    assert.equal(v.data.status, 'verified', JSON.stringify(v));
    const next = v.data.verified_resources[0].read_result;
    assert.equal(next.arguments.arguments.connection_id, f.c.id);
    const r = await f.service.call(next.tool, next.arguments, actor);
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.data.data[0].id, '457');
    f.store.putConnection(
      owner,
      {...f.c, scopes: f.c.scopes.filter(s => s !== 'RetailMedia_Campaign_Read')},
      {accessToken: 'synthetic'},
    );
    assert.equal((await f.verify(p)).error?.code, 'INSUFFICIENT_SCOPE');
  } finally {
    f.store.close();
  }
});
test('an administrator binding and forged internal context cannot substitute for observed campaign membership', async () => {
  const f = fixture();
  try {
    f.store.putConnection(
      owner,
      {...f.c, resourceBindings: [{accountId: '123', pathPrefix: prefix + '/campaigns/456'}]},
      {accessToken: 'synthetic'},
    );
    assert.equal((await f.prepare('update')).error?.code, 'RESOURCE_SCOPE_REQUIRED');
    const n = native('update');
    n.arguments.scopeContext = {criteoVerifiedCampaignId: '456'};
    n.arguments.criteoCampaignDeadline = Number.MAX_SAFE_INTEGER;
    const r = await f.service.call(gateway, n, actor);
    assert.equal(r.error?.code, 'INVALID_ARGUMENT');
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('pinned response schemas reject missing required fields and wrong native IDs without compiler exceptions', () => {
  const c = new DelegatedNativeCompiler(),
    p = c.compile(gateway, native());
  const row = {
    id: '457',
    type: 'RetailMediaCampaignV202301',
    attributes: {
      ...attributes(),
      accountId: '123',
      type: 'auction',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  };
  assert.doesNotThrow(() => c.validateResponse(p, {data: row}, 201));
  for (const field of ['accountId', 'createdAt', 'name']) {
    const bad = structuredClone(row) as JsonObject;
    delete bad.attributes[field];
    assert.throws(() => c.validateResponse(p, {data: bad}, 201), {code: 'UPSTREAM_RESPONSE_INVALID'});
  }
  assert.throws(() => c.validateResponse(p, {data: {...row, id: '9223372036854775808'}}, 201), {
    code: 'UPSTREAM_RESPONSE_INVALID',
  });
  assert.throws(() => c.validateResponse(p, {data: row}, 200), {code: 'UPSTREAM_RESPONSE_INVALID'});
});
test('campaign dependency deadlines abort a slow fetch and prevent any retry or already-expired read', async () => {
  const f = fixture();
  try {
    let calls = 0,
      signal: AbortSignal | undefined;
    const transport = new NativeTransport(
      async (_u, init) => {
        calls++;
        signal = init!.signal!;
        await new Promise((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), {once: true}));
        throw Error('unreachable');
      },
      async () => {},
    );
    const p = {
      ...new DelegatedNativeCompiler().compile(gateway, native()),
      action: 'AMCP_CRITEO_CAMPAIGN_READ',
      path: prefix + '/accounts',
      method: 'GET',
      body: undefined,
      query: {limitToId: ['123'], pageIndex: 0, pageSize: 2},
      readOnly: true,
      criteoCampaignDeadline: performance.now() - 1,
    };
    await assert.rejects(() => transport.request(p, f.c, {accessToken: 'synthetic'}), {
      code: 'CRITEO_CAMPAIGN_STATE_UNVERIFIED',
    });
    assert.equal(calls, 0);
    p.criteoCampaignDeadline = performance.now() + 200;
    const keepAlive = setTimeout(() => {}, 2000);
    try {
      await assert.rejects(() => transport.request(p, f.c, {accessToken: 'synthetic'}), {
        code: 'CRITEO_CAMPAIGN_STATE_UNVERIFIED',
      });
    } finally {
      clearTimeout(keepAlive);
    }
    assert.ok(calls <= 1);
    if (calls) assert.equal(signal!.aborted, true);
  } finally {
    f.store.close();
  }
});

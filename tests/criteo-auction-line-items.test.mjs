import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {offerParkedProviders} from './helpers/parked-providers.mjs';

// Criteo is parked (ARC-01, P9): this suite exercises it, so it offers it like a
// deployment whose AMCP_PROVIDERS names it.
offerParkedProviders('criteo');

/**
 * Criteo Retail Media auction line items, API 2026-07 (pinned OpenAPI document and the "Onsite Sponsored Products Line
 * Items" guide, checked 2026-09-26): draft creation and the complete PUT.
 */
const gateway = 'criteo_native_action',
  prefix = '/2026-07/retail-media',
  registry = new Registry();
const actor = {tenantId: 'criteo-line-items', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
// Criteo returns instants in UTC with an explicit offset.
const utc = v => (v == null ? null : new Date(v).toISOString().replace('.000Z', '+00:00'));
const defaults = {
  endDate: null,
  budget: null,
  monthlyPacing: null,
  dailyPacing: null,
  isAutoDailyPacing: false,
  bidStrategy: 'manual',
  optimizationStrategy: 'conversion',
  targetBid: null,
  maxBid: null,
  flightSchedule: null,
};
/** What Criteo stores and returns: UTC instants, 0 for no bid ceiling, a calculated daily pace and reordered legs. */
function stored(a) {
  const s = {
    ...a,
    startDate: utc(a.startDate),
    endDate: utc(a.endDate),
    maxBid: a.maxBid ?? 0,
    flightSchedule: a.flightSchedule?.legs?.length ? {legs: [...a.flightSchedule.legs].reverse()} : null,
  };
  if (s.isAutoDailyPacing) s.dailyPacing = 13.33;
  return s;
}
const existing = () => ({
  campaignId: '456',
  targetRetailerId: '55',
  name: 'Existing line',
  startDate: '2030-08-01T04:00:00+00:00',
  endDate: '2030-09-01T03:59:59+00:00',
  budget: 200,
  monthlyPacing: 100,
  dailyPacing: 10,
  isAutoDailyPacing: false,
  bidStrategy: 'manual',
  optimizationStrategy: 'conversion',
  targetBid: 1,
  maxBid: 2,
  flightSchedule: null,
  keywordStrategy: 'genericAndBranded',
  status: 'paused',
  budgetSpent: 12,
  budgetRemaining: 188,
  createdAt: '2026-01-01T00:00:00+00:00',
  updatedAt: '2026-01-01T00:00:00+00:00',
});
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 61).toString('base64')),
    c = {
      id: 'criteo',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Criteo',
      scopes: ['RetailMedia_Accounts_Read', 'RetailMedia_Campaign_Read', 'RetailMedia_Campaign_Manage'],
    };
  store.putConnection(owner, c, {accessToken: 'synthetic'});
  const campaigns = {
    '456': {name: 'Summer', type: 'auction', retailerId: null},
    '457': {name: 'Retailer billed', type: 'auction', retailerId: 77},
    '458': {name: 'Deals', type: 'preferred', retailerId: null},
  };
  // Line 789 promotes products; 791 has none and stays in draft.
  const lines = new Map([
    ['789', {attributes: existing(), products: true}],
    ['791', {attributes: {...existing(), name: 'Draft line', status: 'draft'}, products: false}],
  ]);
  let writes = 0,
    next = 790,
    mode = '';
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
  const detail = (id, l) => ({
    id,
    type: 'SponsoredProductsLineItem',
    attributes: {...l.attributes, ...(mode === 'extra' ? {newSetting: true} : {})},
  });
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        method = init.method;
      calls.push({path: u.pathname, method, query: [...u.searchParams]});
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
                .filter(id => campaigns[id])
                .map(id => ({
                  id,
                  type: 'RetailMediaCampaignV202301',
                  attributes: {
                    ...campaigns[id],
                    accountId: mode === 'foreign' ? '999' : '123',
                    budget: 5000,
                    monthlyPacing: 2000,
                    dailyPacing: 100,
                    isAutoDailyPacing: false,
                    status: 'active',
                    budgetSpent: calls.length,
                  },
                })),
            ),
          );
        if (u.pathname === prefix + '/accounts/123/line-items')
          return Response.json(
            page(
              u.searchParams
                .getAll('limitToId')
                .filter(id => lines.has(id))
                .map(id => {
                  const a = lines.get(id).attributes;
                  return {
                    id,
                    type: 'RetailMediaLineItem',
                    attributes: {
                      campaignId: a.campaignId,
                      targetRetailerId: a.targetRetailerId,
                      name: a.name,
                      type: 'auction',
                      status: a.status,
                      startDate: a.startDate.slice(0, 10),
                      budget: a.budget,
                      budgetSpent: 0,
                    },
                  };
                }),
            ),
          );
        let m = /^\/2026-07\/retail-media\/auction-line-items\/(\d+)$/.exec(u.pathname);
        if (m) {
          const l = lines.get(m[1]);
          return l
            ? Response.json({data: detail(m[1], l), errors: [], warnings: []})
            : Response.json({errors: [{code: 'not-found'}]}, {status: 404});
        }
        m = /^\/2026-07\/retail-media\/campaigns\/(\d+)\/auction-line-items$/.exec(u.pathname);
        if (m) {
          const limit = Number(u.searchParams.get('limit')),
            offset = Number(u.searchParams.get('offset'));
          let rows = [...lines].filter(([, l]) => l.attributes.campaignId === m[1]).map(([id, l]) => detail(id, l));
          if (mode === 'many')
            rows = Array.from({length: 1001}, (_, i) => ({
              id: String(10000 + i),
              type: 'SponsoredProductsLineItem',
              attributes: {...existing(), campaignId: m[1], name: 'Line ' + i},
            }));
          return Response.json({
            data: rows.slice(offset, offset + limit),
            metadata: {limit, offset, count: rows.length},
            errors: [],
            warnings: [],
          });
        }
        throw new Error('Unexpected read ' + u.pathname);
      }
      writes++;
      const body = JSON.parse(String(init.body)),
        a = body.data.attributes;
      let m = /^\/2026-07\/retail-media\/campaigns\/(\d+)\/auction-line-items$/.exec(u.pathname);
      if (method === 'POST' && m) {
        let id = String(next++);
        while (lines.has(id)) id = String(next++);
        const attributes = stored({
          ...defaults,
          keywordStrategy: 'genericAndBranded',
          ...a,
          campaignId: m[1],
          status: 'draft',
          budgetSpent: 0,
          budgetRemaining: a.budget,
          createdAt: '2026-09-27T00:00:00+00:00',
          updatedAt: '2026-09-27T00:00:00+00:00',
        });
        // The 2026.01 guide shows capitalized days ("Weekends") in a read sample.
        if (mode === 'capitalized' && attributes.flightSchedule)
          attributes.flightSchedule.legs = attributes.flightSchedule.legs.map(l => ({
            ...l,
            dayOfWeek: l.dayOfWeek[0].toUpperCase() + l.dayOfWeek.slice(1),
          }));
        lines.set(id, {attributes, products: false});
        return Response.json(
          {
            data: {id, type: 'SponsoredProductsLineItem', attributes},
            errors: [],
            warnings: mode === 'warning' ? [{code: 'conquesting-review', detail: 'Keyword strategy needs review'}] : [],
          },
          {status: 201},
        );
      }
      m = /^\/2026-07\/retail-media\/auction-line-items\/(\d+)$/.exec(u.pathname);
      if (method === 'PUT' && m) {
        const l = lines.get(m[1]),
          kept = {
            campaignId: l.attributes.campaignId,
            targetRetailerId: l.attributes.targetRetailerId,
            keywordStrategy: l.attributes.keywordStrategy,
          };
        // A complete PUT: fields left out return to null or their default.
        l.attributes = stored({
          ...defaults,
          ...a,
          ...kept,
          ...(mode === 'drop_budget' ? {budget: null} : {}),
          status: a.status === 'paused' ? 'paused' : l.products ? 'scheduled' : 'draft',
          budgetSpent: 12,
          budgetRemaining: null,
          createdAt: l.attributes.createdAt,
          updatedAt: '2026-09-27T00:00:00+00:00',
        });
        return Response.json({data: detail(m[1], l), errors: [], warnings: []});
      }
      throw new Error('Unexpected write ' + method + ' ' + u.pathname);
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
              params: {limitToId: [id], limitToType: 'Auction', pageIndex: 0, pageSize: 2},
            },
          },
      actor,
    );
  const prepare = (action, params, attributes) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          operation: 'criteo_line_item_ops',
          arguments: {
            action,
            account_id: '123',
            params,
            payload: {data: {type: 'SponsoredProductsLineItem', attributes}},
          },
        },
      },
      actor,
    );
  const create = (attributes, campaignId = '456') => prepare('CREATE_AUCTION_LINE_ITEM', {campaignId}, attributes);
  const update = (lineItemId, attributes) => prepare('UPDATE_AUCTION_LINE_ITEM', {lineItemId}, attributes);
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
  return {
    store,
    calls,
    lines,
    discover,
    create,
    update,
    execute,
    verify,
    writes: () => writes,
    mode: m => {
      mode = m;
    },
  };
}
const draft = () => ({
  name: 'Q4 weekend evenings',
  targetRetailerId: '55',
  startDate: '2030-10-01T00:00:00-04:00',
  endDate: '2030-12-31T23:59:59-05:00',
  budget: 1000,
  monthlyPacing: 400,
  dailyPacing: null,
  isAutoDailyPacing: true,
  bidStrategy: 'manual',
  optimizationStrategy: 'conversion',
  targetBid: 1.2,
  maxBid: null,
  flightSchedule: {
    legs: [
      {dayOfWeek: 'friday', startTime: '18:00', endTime: '23:59'},
      {dayOfWeek: 'weekends', startTime: '18:00', endTime: '23:59'},
    ],
  },
});
/** The current configuration of line 789 as a complete PUT. */
const current = (changes = {}) => {
  const {campaignId, targetRetailerId, keywordStrategy, budgetSpent, budgetRemaining, createdAt, updatedAt, ...a} =
    existing();
  return {...a, startDate: '2030-08-01T00:00:00-04:00', endDate: '2030-08-31T23:59:59-04:00', ...changes};
};
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('a draft line item is created once after spending confirmation and verifies against Criteo UTC dates and defaults', async () => {
  const f = fixture();
  try {
    ok(await f.discover('campaign', '456'));
    const p = ok(await f.create(draft())),
      impact = p.data.creative_impact;
    assert.equal(impact.scope, 'auction_line_item');
    assert.equal(impact.operation, 'create');
    assert.equal(impact.may_affect_serving, false);
    assert.equal(impact.currency, 'USD');
    assert.equal(impact.keyword_strategy, 'genericAndBranded');
    assert.match(impact.effect, /draft/);
    assert.equal((await f.execute(p)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal(f.writes(), 0);
    ok(await f.execute(p, {spend_change_confirmed: true}));
    assert.equal(f.writes(), 1);
    const v = ok(await f.verify(p));
    assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 900));
    assert.equal((await f.execute(p, {spend_change_confirmed: true})).data.replayed, true);
    assert.equal(f.writes(), 1);
    // The verified line item belongs to the account now, so it can be edited without another listing.
    const {targetRetailerId, ...rest} = draft();
    ok(await f.update('790', {...rest, name: 'Q4 evenings', status: 'paused'}));
    // Days read back capitalized still match the lower-case days sent.
    const q = ok(await f.create({...draft(), name: 'Capitalized days'}));
    f.mode('capitalized');
    ok(await f.execute(q, {spend_change_confirmed: true}));
    assert.equal(f.lines.get('792').attributes.name, 'Capitalized days');
    assert.equal(f.lines.get('792').attributes.flightSchedule.legs[0].dayOfWeek, 'Weekends');
    assert.equal(ok(await f.verify(q)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});

test('a complete PUT verifies; activating a draft line item leaves its status unobserved until products are added', async () => {
  const f = fixture();
  try {
    for (const id of ['789', '791']) ok(await f.discover('line', id));
    const p = ok(await f.update('789', current({budget: 260, status: 'active'}))),
      impact = p.data.creative_impact;
    assert.equal(impact.current_status, 'paused');
    assert.equal(impact.requested_status, 'active');
    assert.equal(impact.may_affect_serving, true);
    assert.equal(impact.before.budget, 200);
    assert.equal(impact.after.budget, 260);
    ok(await f.execute(p, {spend_change_confirmed: true}));
    const v = ok(await f.verify(p));
    assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 900));
    assert.equal(f.lines.get('789').attributes.status, 'scheduled');
    const d = ok(await f.update('791', current({name: 'Draft line', targetBid: 1.5, status: 'active'})));
    assert.match(d.data.creative_impact.effect, /stays in draft/);
    ok(await f.execute(d, {spend_change_confirmed: true}));
    const w = ok(await f.verify(d));
    assert.equal(w.data.status, 'verified', JSON.stringify(w).slice(0, 900));
    assert.deepEqual(w.data.checks[0].unobservable_fields, ['status']);
    assert.equal(f.lines.get('791').attributes.status, 'draft');
  } finally {
    f.store.close();
  }
});

test('left-out, invalid and unqualified fields fail before any request', async () => {
  const {status, ...createBase} = {...current(), targetRetailerId: '55'};
  const without = (o, k) => {
    const c = {...o};
    delete c[k];
    return c;
  };
  for (const [label, kind, attributes] of [
    ['missing endDate', 'create', without(createBase, 'endDate')],
    ['short name', 'create', {...createBase, name: 'Q'}],
    ['date-only start', 'create', {...createBase, startDate: '2030-08-01'}],
    ['end before start', 'create', {...createBase, endDate: '2030-07-01T00:00:00Z'}],
    ['zero budget', 'create', {...createBase, budget: 0}],
    ['automatic and fixed daily pace', 'create', {...createBase, isAutoDailyPacing: true}],
    [
      'automatic pace without limits',
      'create',
      {...createBase, isAutoDailyPacing: true, dailyPacing: null, budget: null, monthlyPacing: null},
    ],
    ['manual without target bid', 'create', {...createBase, targetBid: null}],
    ['automated without ceiling', 'create', {...createBase, bidStrategy: 'automated', maxBid: null}],
    ['ceiling below 0.1', 'create', {...createBase, maxBid: 0.05}],
    [
      'leg ends before it starts',
      'create',
      {...createBase, flightSchedule: {legs: [{dayOfWeek: 'monday', startTime: '20:00', endTime: '08:00'}]}},
    ],
    ['unknown keyword strategy', 'create', {...createBase, keywordStrategy: 'broad'}],
    ['status on creation', 'create', {...createBase, status: 'active'}],
    ['retailer in an update', 'update', {...current(), targetRetailerId: '55'}],
    ['draft status', 'update', current({status: 'draft'})],
    ['missing flight schedule', 'update', without(current(), 'flightSchedule')],
  ]) {
    const f = fixture();
    try {
      const r = kind === 'create' ? await f.create(attributes) : await f.update('789', attributes);
      assert.equal(r.error?.code, 'INVALID_CRITEO_LINE_ITEM', label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    const r = await f.update('789', current({status: 'draft'}));
    assert.match(r.error.message, /active or paused/);
    const s = await f.update('789', {...current(), targetRetailerId: '55'});
    assert.match(s.error.message, /fixed at creation/);
  } finally {
    f.store.close();
  }
});

test('the review refuses duplicate names, the wrong retailer or campaign type, unknown line items and unchanged or unknown configuration', async () => {
  const f = fixture();
  try {
    assert.equal((await f.create(draft())).error?.code, 'RESOURCE_SCOPE_REQUIRED');
    assert.equal(f.calls.length, 0);
    assert.equal((await f.update('789', current({budget: 300}))).error?.code, 'RESOURCE_SCOPE_REQUIRED');
    for (const id of ['456', '457', '458']) ok(await f.discover('campaign', id));
    ok(await f.discover('line', '789'));
    const dup = await f.create({...draft(), name: 'EXISTING LINE'});
    assert.equal(dup.error?.code, 'CONFIGURATION_EXISTS');
    assert.equal(dup.error.details.line_item_id, '789');
    assert.match((await f.create(draft(), '457')).error?.message ?? '', /billed to retailer 77/);
    ok(await f.create({...draft(), targetRetailerId: '77'}, '457'));
    assert.match((await f.create(draft(), '458')).error?.message ?? '', /auction campaigns/);
    const same = await f.update('789', current());
    assert.equal(same.error?.code, 'INVALID_CRITEO_LINE_ITEM');
    assert.match(same.error.message, /already matches/);
    f.mode('extra');
    const extra = await f.update('789', current({budget: 300}));
    assert.equal(extra.error?.code, 'INCOMPLETE_STATE');
    assert.deepEqual(extra.error.details.fields, ['newSetting']);
    f.mode('foreign');
    assert.equal((await f.update('789', current({budget: 300}))).error?.code, 'STATE_TARGET_MISMATCH');
    f.mode('many');
    assert.equal((await f.create(draft())).error?.code, 'INCOMPLETE_STATE');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('owner policies: activation, budget maximums, uncapped limits and increases', async () => {
  const f = fixture();
  try {
    ok(await f.discover('campaign', '456'));
    ok(await f.discover('line', '789'));
    saveSpendPolicy(f.store, owner, {
      gateway,
      account_id: '123',
      confirmed: true,
      policy: {allow_deletion: true, allow_activation: false},
    });
    assert.equal(
      (await f.update('789', current({budget: 260, status: 'active'}))).error?.code,
      'POLICY_ACTIVATION_FORBIDDEN',
    );
    ok(await f.update('789', current({budget: 260})));
    ok(await f.create(draft()));
    saveSpendPolicy(f.store, owner, {
      gateway,
      account_id: '123',
      confirmed: true,
      policy: {enforcement: 'block', allow_activation: true, max_budget_native: 500},
    });
    assert.equal((await f.create(draft())).error?.code, 'POLICY_BUDGET_LIMIT');
    assert.equal(
      (await f.create({...draft(), budget: null, isAutoDailyPacing: false, dailyPacing: 20})).error?.code,
      'POLICY_AMOUNT_UNSUPPORTED',
    );
    ok(await f.create({...draft(), budget: 450}));
    // WRT-01: a line item without a lifetime budget used to be refused as unsupported with its paces unchecked; under
    // confirm the monthly pace above the cap is now named beside it.
    saveSpendPolicy(f.store, owner, {
      gateway,
      account_id: '123',
      confirmed: true,
      policy: {allow_activation: true, max_budget_native: 500},
    });
    const uncapped = await f.create({
      ...draft(),
      budget: null,
      monthlyPacing: 900,
      isAutoDailyPacing: false,
      dailyPacing: 20,
    });
    assert.deepEqual(uncapped.data.spend_policy.exceeded.map(x => x.rule + ' ' + x.field).sort(), [
      'POLICY_AMOUNT_UNSUPPORTED /data/attributes/budget',
      'POLICY_BUDGET_LIMIT /data/attributes/monthlyPacing',
    ]);
    saveSpendPolicy(f.store, owner, {
      gateway,
      account_id: '123',
      confirmed: true,
      policy: {enforcement: 'block', allow_activation: true, max_budget_increase_percent: 10},
    });
    assert.equal((await f.update('789', current({budget: 250}))).error?.code, 'POLICY_INCREASE_LIMIT');
    ok(await f.update('789', current({budget: 210})));
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('a creation with warnings is not resubmitted, a line item changed after review stops execution, and a differing read-back is inconclusive', async () => {
  {
    const f = fixture();
    try {
      ok(await f.discover('campaign', '456'));
      const p = ok(await f.create(draft()));
      f.mode('warning');
      assert.equal((await f.execute(p, {spend_change_confirmed: true})).success, false);
      assert.equal((await f.execute(p, {spend_change_confirmed: true})).data.replayed, true);
      assert.equal(f.writes(), 1);
      assert.equal((await f.verify(p)).error?.code, 'WRITE_PARTIAL_OR_FAILED');
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    ok(await f.discover('line', '789'));
    const p = ok(await f.update('789', current({budget: 260})));
    f.lines.get('789').attributes.targetBid = 1.4;
    assert.equal((await f.execute(p, {spend_change_confirmed: true})).error?.code, 'STATE_CHANGED');
    assert.equal(f.writes(), 0);
    const q = ok(await f.update('789', current({targetBid: 1.4, budget: 260})));
    f.mode('drop_budget');
    ok(await f.execute(q, {spend_change_confirmed: true}));
    const v = ok(await f.verify(q));
    assert.equal(v.data.status, 'inconclusive');
    assert.deepEqual(v.data.checks[0].changed_fields, ['/line/budget']);
  } finally {
    f.store.close();
  }
});

test('the qualified fields match the pinned create and update models', async () => {
  const {criteoLineItemFields} = await import('../dist/src/criteo-auction-line-items.js');
  const spec = JSON.parse(readFileSync('.mirror/VENDOR/criteo-retail-2026-07.json', 'utf8')).document.components
    .schemas;
  const create = spec.SponsoredProductsLineItemCreateRequestModel,
    update = spec.SponsoredProductsLineItemUpdateRequestModel;
  assert.deepEqual(
    Object.keys(create.properties).sort(),
    [...criteoLineItemFields, 'targetRetailerId', 'keywordStrategy'].sort(),
  );
  assert.deepEqual(Object.keys(update.properties).sort(), [...criteoLineItemFields, 'status'].sort());
  assert.deepEqual([...create.required].sort(), ['name', 'startDate', 'targetRetailerId']);
  assert.deepEqual([...update.required].sort(), ['isAutoDailyPacing', 'name', 'startDate', 'status']);
  assert.deepEqual(update.properties.status.enum, ['active', 'paused', 'draft']);
  // Campaigns name their retailer with an int32; line items with a long-id string.
  assert.deepEqual(
    [
      spec.CampaignV202301.properties.retailerId.type,
      spec.SponsoredProductsLineItemCreateRequestModel.properties.targetRetailerId.type,
    ],
    ['integer', 'string'],
  );
  const routes = JSON.parse(readFileSync('generated/vendor-routes.json', 'utf8')).routes.filter(
    r => r.gateway === gateway && ['CREATE_AUCTION_LINE_ITEM', 'UPDATE_AUCTION_LINE_ITEM'].includes(r.action),
  );
  assert.deepEqual(routes.map(r => [r.action, r.method, r.path]).sort(), [
    ['CREATE_AUCTION_LINE_ITEM', 'POST', prefix + '/campaigns/{campaignId}/auction-line-items'],
    ['UPDATE_AUCTION_LINE_ITEM', 'PUT', prefix + '/auction-line-items/{lineItemId}'],
  ]);
  const paths = JSON.parse(readFileSync('.mirror/VENDOR/criteo-retail-2026-07.json', 'utf8')).document.paths;
  for (const [path, method] of [
    [prefix + '/campaigns/{campaignId}/auction-line-items', 'post'],
    [prefix + '/auction-line-items/{lineItemId}', 'put'],
  ])
    assert.deepEqual(paths[path][method].security, [{oauth: ['RetailMedia_Campaign_Manage']}]);
});

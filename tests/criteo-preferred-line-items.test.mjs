import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {offerParkedProviders} from './helpers/parked-providers.mjs';

// Criteo is parked (ARC-01, P9): this suite exercises it, so it offers it like a
// deployment whose AMCP_PROVIDERS names it.
offerParkedProviders('criteo');

/**
 * Criteo Retail Media preferred (onsite display) line items, API 2026-07 (pinned OpenAPI document, checked 2026-09-27):
 * creation in a preferred campaign and the complete PUT.
 */
const gateway = 'criteo_native_action',
  prefix = '/2026-07/retail-media',
  registry = new Registry();
const actor = {tenantId: 'criteo-preferred', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const existing = () => ({
  campaignId: '458',
  targetRetailerId: '55',
  name: 'Homepage takeover',
  startDate: '2030-08-01',
  endDate: '2030-08-31',
  status: 'paused',
  budget: 5000,
  pacing: 'standard',
  capping: {type: 'day', count: 3},
  creativeId: '901',
  page: {pageType: 'home'},
  budgetSpent: 0,
  budgetRemaining: 5000,
  createdAt: '2026-01-01T00:00:00+00:00',
  updatedAt: '2026-01-01T00:00:00+00:00',
});
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 92).toString('base64'));
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
  const campaigns = {
    '458': {name: 'Display deals', type: 'preferred', retailerId: null},
    '459': {name: 'Retailer display', type: 'preferred', retailerId: 77},
    '456': {name: 'Sponsored products', type: 'auction', retailerId: null},
  };
  const creatives = {
    '901': {name: 'Banner', retailerId: 55, status: 'Ready'},
    '902': {name: 'Other retailer', retailerId: 66, status: 'Ready'},
    '903': {name: 'Old', retailerId: 55, status: 'Archived'},
  };
  const lines = new Map([['7001', existing()]]);
  let writes = 0,
    next = 7100,
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
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        method = init.method;
      calls.push({path: u.pathname, method});
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
                    accountId: '123',
                    isAutoDailyPacing: false,
                    status: 'active',
                    createdAt: 'x',
                    updatedAt: 'x',
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
                  const a = lines.get(id);
                  return {
                    id,
                    type: 'RetailMediaLineItem',
                    attributes: {
                      campaignId: a.campaignId,
                      targetRetailerId: a.targetRetailerId,
                      name: a.name,
                      type: 'preferred',
                      status: a.status,
                      startDate: a.startDate,
                      budget: a.budget,
                    },
                  };
                }),
            ),
          );
        let m = /^\/2026-07\/retail-media\/preferred-line-items\/(\d+)$/.exec(u.pathname);
        if (m) {
          const a = lines.get(m[1]);
          return a
            ? Response.json({data: {id: m[1], type: 'PreferredLineItem', attributes: a}, errors: [], warnings: []})
            : Response.json({errors: [{code: 'not-found'}]}, {status: 404});
        }
        m = /^\/2026-07\/retail-media\/accounts\/123\/creatives\/(\d+)$/.exec(u.pathname);
        if (m) {
          const c = creatives[m[1]];
          return c
            ? Response.json({
                data: {
                  id: m[1],
                  type: 'Creative',
                  attributes: {
                    ...c,
                    creativeFormatV2Type: 'Showcase',
                    environments: [],
                    formatId: 1,
                    templateId: 2,
                    templateName: 'T',
                    templateVariableValues: [],
                  },
                },
                errors: [],
                warnings: [],
              })
            : Response.json({errors: [{code: 'not-found'}]}, {status: 404});
        }
        throw new Error('Unexpected read ' + u.pathname);
      }
      writes++;
      const a = JSON.parse(String(init.body)).data.attributes;
      let m = /^\/2026-07\/retail-media\/campaigns\/(\d+)\/preferred-line-items$/.exec(u.pathname);
      if (method === 'POST' && m) {
        const id = String(next++);
        const stored = {
          ...a,
          campaignId: m[1],
          status: a.status ?? 'draft',
          capping: a.capping ?? null,
          creativeId: a.creativeId ?? null,
          page: {...a.page, ...(a.page.categories ? {categories: [...a.page.categories].reverse()} : {})},
          budgetSpent: 0,
          budgetRemaining: a.budget,
          createdAt: 'n',
          updatedAt: 'n',
        };
        if (mode !== 'ignore') lines.set(id, stored);
        return Response.json(
          {data: {id, type: 'PreferredLineItem', attributes: stored}, errors: [], warnings: []},
          {status: 201},
        );
      }
      m = /^\/2026-07\/retail-media\/preferred-line-items\/(\d+)$/.exec(u.pathname);
      if (method === 'PUT' && m) {
        const l = lines.get(m[1]);
        const stored = {
          ...l,
          ...a,
          campaignId: l.campaignId,
          targetRetailerId: l.targetRetailerId,
          status: a.status === 'active' ? 'scheduled' : 'paused',
        };
        if (mode !== 'ignore') lines.set(m[1], stored);
        return Response.json({
          data: {id: m[1], type: 'PreferredLineItem', attributes: stored},
          errors: [],
          warnings: [],
        });
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
              params: {limitToId: [id], limitToType: 'Preferred', pageIndex: 0, pageSize: 2},
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
          arguments: {action, account_id: '123', params, payload: {data: {type: 'PreferredLineItem', attributes}}},
        },
      },
      actor,
    );
  const create = (attributes, campaignId = '458') =>
    prepare('CREATE_PREFERRED_LINE_ITEM_BY_CAMPAIGN_ID', {campaignId}, attributes);
  const update = (lineItemId, attributes) =>
    prepare('UPDATE_PREFERRED_LINE_ITEM_BY_LINE_ITEM_ID', {lineItemId}, attributes);
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
const draft = (extra = {}) => ({
  name: 'Category spotlight',
  targetRetailerId: '55',
  startDate: '2030-10-01',
  endDate: '2030-10-31',
  budget: 2500,
  pacing: 'accelerated',
  page: {pageType: 'category', categories: [{categoryId: 'shoes', includeChildren: true}, {categoryId: 'boots'}]},
  capping: {type: 'session', count: 2},
  creativeId: '901',
  ...extra,
});
const current = (changes = {}) => {
  const {campaignId, targetRetailerId, budgetSpent, budgetRemaining, createdAt, updatedAt, ...a} = existing();
  return {...a, ...changes};
};
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('a preferred line item is created once in a preferred campaign and verifies; it starts draft', async () => {
  const f = fixture();
  try {
    await f.discover('campaign', '458');
    const p = ok(await f.create(draft())),
      impact = p.data.creative_impact;
    assert.equal(impact.scope, 'preferred_line_item');
    assert.equal(impact.after.page.pageType, 'category');
    assert.equal(impact.currency, 'USD');
    assert.match(impact.effect, /spends nothing until/);
    ok(await f.execute(p, {spend_change_confirmed: true}));
    assert.equal(f.writes(), 1);
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal((await f.execute(p, {spend_change_confirmed: true})).data.replayed, true);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('the complete PUT verifies; activation needs confirmation and is an activation under owner policy', async () => {
  const f = fixture();
  try {
    await f.discover('line', '7001');
    const rename = ok(await f.update('7001', current({name: 'Homepage takeover v2', budget: 6000})));
    assert.deepEqual(rename.data.creative_impact.budget_change, {from: 5000, to: 6000});
    ok(await f.execute(rename, {spend_change_confirmed: true}));
    assert.equal(ok(await f.verify(rename)).data.status, 'verified');
    const on = ok(await f.update('7001', current({name: 'Homepage takeover v2', budget: 6000, status: 'active'})));
    assert.match(on.data.creative_impact.effect, /Activates/);
    assert.equal((await f.execute(on)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    saveSpendPolicy(f.store, owner, {gateway, account_id: '123', confirmed: true, policy: {allow_activation: false}});
    assert.equal(
      (await f.update('7001', current({name: 'Homepage takeover v2', budget: 6000, status: 'active'}))).error?.code,
      'POLICY_ACTIVATION_FORBIDDEN',
    );
  } finally {
    f.store.close();
  }
});

test('malformed preferred line items are refused before any request', async () => {
  const cases = [
    [
      'missing budget',
      (() => {
        const {budget, ...a} = draft();
        return a;
      })(),
      'create',
    ],
    ['timestamp date', draft({startDate: '2030-10-01T00:00:00Z'}), 'create'],
    ['end before start', draft({endDate: '2030-09-30'}), 'create'],
    ['unknown pacing', draft({pacing: 'even'}), 'create'],
    ['categories on the home page', draft({page: {pageType: 'home', categories: [{categoryId: 'x'}]}}), 'create'],
    ['keywords on a category page', draft({page: {pageType: 'category', searchKeywords: ['boots']}}), 'create'],
    [
      'repeated category',
      draft({page: {pageType: 'category', categories: [{categoryId: 'x'}, {categoryId: 'x'}]}}),
      'create',
    ],
    ['unknown page type', draft({page: {pageType: 'unknown'}}), 'create'],
    ['bad capping', draft({capping: {type: 'week', count: 2}}), 'create'],
    ['active at creation', draft({status: 'active'}), 'create'],
    ['negative budget', draft({budget: -1}), 'create'],
    ['partial PUT', {name: 'x', startDate: '2030-08-01', endDate: '2030-08-31', status: 'paused'}, 'update'],
    ['retailer in PUT', current({targetRetailerId: '55'}), 'update'],
    ['draft status in PUT', current({status: 'draft'}), 'update'],
  ];
  for (const [label, attributes, kind] of cases) {
    const f = fixture();
    try {
      await f.discover('campaign', '458');
      await f.discover('line', '7001');
      const before = f.calls.length;
      const r = kind === 'create' ? await f.create(attributes) : await f.update('7001', attributes);
      assert.equal(r.error?.code, 'INVALID_CRITEO_PREFERRED_LINE_ITEM', label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(f.calls.length, before, label);
    } finally {
      f.store.close();
    }
  }
});

test('auction campaigns, other retailers, archived or foreign creatives and unchanged PUTs are refused after reading, without writes', async () => {
  const f = fixture();
  try {
    for (const id of ['456', '459']) await f.discover('campaign', id);
    await f.discover('campaign', '458');
    await f.discover('line', '7001');
    assert.match((await f.create(draft(), '456')).error?.message ?? '', /preferred campaigns/);
    assert.match((await f.create(draft(), '459')).error?.message ?? '', /serves retailer 77/);
    assert.match((await f.create(draft({creativeId: '902'}))).error?.message ?? '', /retailer 66/);
    assert.match((await f.create(draft({creativeId: '903'}))).error?.message ?? '', /Archived/);
    assert.equal((await f.create(draft({creativeId: '999'}))).success, false);
    assert.match((await f.update('7001', current())).error?.message ?? '', /already matches/);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('writes need account-scoped membership first, and an ignored write is not verified', async () => {
  const f = fixture();
  try {
    assert.equal((await f.create(draft())).error?.code, 'RESOURCE_SCOPE_REQUIRED');
    assert.equal((await f.update('7001', current({name: 'x2'}))).error?.code, 'RESOURCE_SCOPE_REQUIRED');
    await f.discover('line', '7001');
    f.mode('ignore');
    const p = ok(await f.update('7001', current({name: 'Ignored rename'})));
    ok(await f.execute(p, {spend_change_confirmed: true}));
    assert.notEqual(ok(await f.verify(p)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});

test('the models match the pinned OpenAPI document, and the ledger lists both writes in the family', () => {
  const d = JSON.parse(readFileSync('.mirror/VENDOR/criteo-retail-2026-07.json', 'utf8')),
    doc = d.document ?? d,
    S = doc.components.schemas;
  assert.deepEqual(S.PreferredLineItemCreateModelV2.required, [
    'name',
    'startDate',
    'endDate',
    'pacing',
    'page',
    'targetRetailerId',
    'budget',
  ]);
  assert.deepEqual(S.PreferredLineItemUpdateModelV2.required, ['name', 'startDate', 'endDate', 'status']);
  assert.deepEqual(S.LineItemCappingV2.properties.type.enum, ['unknown', 'day', 'session']);
  assert.ok(S.CampaignV202301.properties.type.enum.includes('preferred'));
  const rows = actionContracts(registry).filter(
    r => r.gateway === gateway && /PREFERRED_LINE_ITEM_BY/.test(r.action) && /^(CREATE|UPDATE)/.test(r.action),
  );
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.status, 'reviewed_write_family', r.action);
    assert.equal(r.family, 'criteo_preferred_line_items', r.action);
  }
});

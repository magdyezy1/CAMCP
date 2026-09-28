import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * X campaign and line item batches, Ads API v12 (Campaign Management reference; checked 2026-09-28).
 */
const registry = new Registry(),
  gateway = 'x_ads_native_action',
  account = 'acct1';
const actor = {tenantId: 'x-entity-batches', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const secret = {
  accessToken: 'synthetic-token',
  consumerKey: 'synthetic-key',
  consumerSecret: 'synthetic-secret',
  tokenSecret: 'synthetic-token-secret',
};
const actions = {
  campaigns: 'x_batch_accounts_account_id_campaigns_post',
  line_items: 'x_batch_accounts_account_id_line_items_post',
};
const copy = x => structuredClone(x);
function setup(mode = '') {
  const store = new Store(':memory:', Buffer.alloc(32, 97).toString('base64'));
  store.putConnection(
    owner,
    {
      id: 'x',
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    secret,
  );
  const funding = {
    fi1: {
      id: 'fi1',
      account_id: account,
      entity_status: 'ACTIVE',
      able_to_fund: true,
      reasons_not_able_to_fund: [],
      currency: 'USD',
      type: 'CREDIT_CARD',
      description: 'Visa ending in 0650',
      credit_limit_local_micro: 200000000,
      deleted: false,
    },
    fi2: {
      id: 'fi2',
      account_id: account,
      entity_status: 'ACTIVE',
      able_to_fund: false,
      reasons_not_able_to_fund: ['EXPIRED'],
      currency: 'USD',
      type: 'CREDIT_CARD',
      deleted: false,
    },
  };
  const campaign = (id, extra = {}) => ({
    id,
    name: 'Campaign ' + id,
    funding_instrument_id: 'fi1',
    entity_status: 'PAUSED',
    budget_optimization: 'LINE_ITEM',
    daily_budget_amount_local_micro: 5000000,
    total_budget_amount_local_micro: 50000000,
    purchase_order_number: null,
    currency: 'USD',
    servable: false,
    reasons_not_servable: ['PAUSED_BY_ADVERTISER'],
    effective_status: 'UNKNOWN',
    deleted: false,
    ...extra,
  });
  const line = (id, extra = {}) => ({
    id,
    campaign_id: 'c1',
    name: 'Line ' + id,
    objective: 'ENGAGEMENTS',
    product_type: 'PROMOTED_TWEETS',
    placements: ['ALL_ON_TWITTER'],
    bid_strategy: 'MAX',
    bid_amount_local_micro: 1000000,
    daily_budget_amount_local_micro: null,
    total_budget_amount_local_micro: 20000000,
    entity_status: 'PAUSED',
    start_time: '2026-10-01T00:00:00Z',
    end_time: null,
    categories: [],
    goal: 'ENGAGEMENT',
    pay_by: 'ENGAGEMENT',
    deleted: false,
    ...extra,
  });
  const entities = {
    campaigns: {
      c1: campaign('c1'),
      c2: campaign('c2', {
        entity_status: 'ACTIVE',
        daily_budget_amount_local_micro: 10000000,
        total_budget_amount_local_micro: null,
      }),
      c3: campaign('c3', {deleted: true}),
    },
    line_items: {
      l1: line('l1'),
      l2: line('l2', {entity_status: 'ACTIVE', bid_strategy: 'AUTO', bid_amount_local_micro: null}),
      l3: line('l3', {deleted: true}),
    },
  };
  const calls = [],
    sent = [];
  let writes = 0,
    next = 1;
  const transport = new NativeTransport(async (url, init) => {
    const u = new URL(String(url)),
      method = init?.method ?? 'GET';
    calls.push({method, path: u.pathname, query: Object.fromEntries(u.searchParams)});
    const reply = (data, extra = {}) =>
      Response.json({data: copy(data), request: {params: {account_id: account}}, ...extra});
    const missing = () =>
      Response.json({errors: [{code: 'NOT_FOUND', message: 'Not found'}], request: {params: {}}}, {status: 404});
    if (method === 'GET') {
      const suffix = u.pathname.replace('/12/accounts/' + account, ''),
        withDeleted = u.searchParams.get('with_deleted') === 'true';
      if (u.pathname === '/12/accounts/' + account)
        return reply({
          id: account,
          name: 'Account',
          approval_status: 'ACCEPTED',
          timezone: 'America/New_York',
          deleted: false,
        });
      let m = /^\/funding_instruments\/(\w+)$/.exec(suffix);
      if (m) return funding[m[1]] ? reply(funding[m[1]]) : missing();
      m = /^\/(campaigns|line_items)\/(\w+)$/.exec(suffix);
      if (m) {
        const row = entities[m[1]][m[2]];
        return row && (!row.deleted || withDeleted) ? reply(row) : missing();
      }
      return missing();
    }
    writes++;
    assert.match(new Headers(init.headers).get('content-type') ?? '', /^application\/json/, 'batch routes take JSON');
    const m = /^\/12\/batch\/accounts\/acct1\/(campaigns|line_items)$/.exec(u.pathname);
    if (method !== 'POST' || !m) throw Error('Unexpected write ' + method + ' ' + u.pathname);
    const ops = JSON.parse(String(init.body)),
      kind = m[1];
    sent.push(ops);
    if (mode === 'error')
      return Response.json(
        {errors: [{code: 'INVALID_PARAMETER', message: 'Invalid budget'}], request: {params: {}}},
        {status: 400},
      );
    const rows = [];
    for (const o of ops) {
      const p = {...o.params};
      for (const k of ['placements', 'categories']) if (typeof p[k] === 'string') p[k] = p[k].split(',');
      if (o.operation_type === 'Create') {
        const id = 'n' + next++,
          row =
            kind === 'campaigns'
              ? campaign(id, {
                  ...p,
                  daily_budget_amount_local_micro: p.daily_budget_amount_local_micro ?? null,
                  total_budget_amount_local_micro: p.total_budget_amount_local_micro ?? null,
                })
              : line(id, {...p, bid_amount_local_micro: p.bid_amount_local_micro ?? null});
        if (mode !== 'ignore') entities[kind][id] = mode === 'drift' ? {...row, name: 'Changed by X'} : row;
        rows.push(row);
        continue;
      }
      const id = p[kind === 'campaigns' ? 'campaign_id' : 'line_item_id'];
      delete p.campaign_id;
      delete p.line_item_id;
      const row = {...entities[kind][id], ...(o.operation_type === 'Delete' ? {deleted: true} : p)};
      if (mode !== 'ignore' && mode !== 'items') entities[kind][id] = row;
      rows.push(row);
    }
    if (mode === 'short') rows.pop();
    // Every item echoed in order; with an item error X reports it beside the items and applies none.
    const errors =
      mode === 'items'
        ? {operation_errors: ops.map((_, i) => (i ? [{code: 'INVALID_PARAMETER', message: 'Bad value'}] : []))}
        : {};
    return reply(rows, {request: ops.map(o => ({...o, params: {...o.params, account_id: account}})), ...errors});
  });
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const prepare = (kind, payload) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {action: actions[kind], account_id: account, payload: JSON.parse(JSON.stringify(payload))},
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
  return {store, calls, sent, entities, funding, prepare, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};
const create = params => ({operation_type: 'Create', params});
const update = (key, id, params) => ({operation_type: 'Update', params: {[key]: id, ...params}});
const remove = (key, id) => ({operation_type: 'Delete', params: {[key]: id}});
const pausedCampaign = (extra = {}) =>
  create({
    funding_instrument_id: 'fi1',
    name: 'Spring',
    entity_status: 'PAUSED',
    daily_budget_amount_local_micro: 5000000,
    total_budget_amount_local_micro: 50000000,
    ...extra,
  });
const pausedLine = (extra = {}) =>
  create({
    campaign_id: 'c1',
    objective: 'ENGAGEMENTS',
    product_type: 'PROMOTED_TWEETS',
    placements: 'ALL_ON_TWITTER,TWITTER_SEARCH',
    bid_strategy: 'MAX',
    bid_amount_local_micro: 1500000,
    entity_status: 'PAUSED',
    start_time: '2026-10-01T00:00:00Z',
    end_time: '2026-10-31T00:00:00Z',
    name: 'Search',
    ...extra,
  });

test('paused campaigns and line items are created in one batch each, entities are updated and deleted, each verifies; a replay sends nothing', async () => {
  const f = setup();
  try {
    const c = ok(
      await f.prepare('campaigns', [
        pausedCampaign(),
        pausedCampaign({
          name: 'Summer',
          daily_budget_amount_local_micro: 2000000,
          total_budget_amount_local_micro: undefined,
        }),
      ]),
    );
    assert.equal(c.data.creative_impact.operation, 'create_batch');
    assert.equal(c.data.creative_impact.may_affect_serving, false);
    assert.equal(
      f.calls.some(x => x.path === '/12/accounts/acct1/funding_instruments/fi1'),
      true,
      'the funding instrument is read',
    );
    assert.equal(
      JSON.stringify(f.store.document(actor.tenantId, 'write_review', c.data.review_id)).includes('Visa ending'),
      false,
      'the card description is not kept',
    );
    assert.equal((await f.execute(c)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    ok(await f.execute(c, {spend_change_confirmed: true}));
    assert.deepEqual(
      f.sent[0].map(o => o.operation_type),
      ['Create', 'Create'],
    );
    assert.equal(ok(await f.verify(c)).data.status, 'verified');
    assert.equal((await f.execute(c, {spend_change_confirmed: true})).data.replayed, true);
    assert.equal(f.writes(), 1);
    const l = ok(
      await f.prepare('line_items', [
        pausedLine(),
        pausedLine({name: 'Timeline', placements: 'TWITTER_TIMELINE', start_time: '2026-10-01T02:00:00+02:00'}),
      ]),
    );
    assert.equal(
      f.calls.some(x => x.path === '/12/accounts/acct1/campaigns/c1'),
      true,
      'the parent campaign is read',
    );
    ok(await f.execute(l, {spend_change_confirmed: true}));
    assert.equal(ok(await f.verify(l)).data.status, 'verified', 'placements and times compare as sets and instants');
    const u = ok(
      await f.prepare('line_items', [
        update('line_item_id', 'l1', {bid_amount_local_micro: 1200000, name: 'Renamed'}),
        update('line_item_id', 'l2', {entity_status: 'PAUSED'}),
      ]),
    );
    assert.equal(u.data.creative_impact.may_affect_serving, true);
    assert.deepEqual(u.data.creative_impact.items[0].changes.bid_amount_local_micro, {from: 1000000, to: 1200000});
    ok(await f.execute(u, {spend_change_confirmed: true}));
    assert.equal(f.entities.line_items.l2.entity_status, 'PAUSED');
    assert.equal(ok(await f.verify(u)).data.status, 'verified');
    const r = ok(
      await f.prepare('campaigns', [
        update('campaign_id', 'c1', {name: 'Spring renamed', purchase_order_number: 'PO-7'}),
      ]),
    );
    assert.equal(r.data.creative_impact.may_affect_serving, false);
    ok(await f.execute(r));
    assert.equal(ok(await f.verify(r)).data.status, 'verified', 'a rename needs no spending confirmation');
    const d = ok(await f.prepare('campaigns', [remove('campaign_id', 'c2')]));
    assert.equal(d.data.creative_impact.may_affect_serving, true, 'an ACTIVE campaign stops serving');
    ok(await f.execute(d));
    assert.equal(f.entities.campaigns.c2.deleted, true);
    assert.equal(ok(await f.verify(d)).data.status, 'verified');
    assert.equal(f.writes(), 5);
  } finally {
    f.store.close();
  }
});

test('malformed batches are refused before any request; missing, unfunded, deleted and unchanged entities and the owner policy after reading', async () => {
  const cases = [
    ['mixed operation types', 'campaigns', [pausedCampaign(), remove('campaign_id', 'c1')]],
    ['21 operations', 'campaigns', Array.from({length: 21}, (_, i) => pausedCampaign({name: 'C' + i}))],
    ['no operations', 'campaigns', []],
    ['an account_id', 'campaigns', [pausedCampaign({account_id: account})]],
    ['an ACTIVE create', 'campaigns', [pausedCampaign({entity_status: 'ACTIVE'})]],
    ['a create without status', 'campaigns', [pausedCampaign({entity_status: undefined})]],
    ['a deprecated campaign field', 'campaigns', [pausedCampaign({standard_delivery: true})]],
    ['a line item field on a campaign', 'campaigns', [pausedCampaign({objective: 'REACH'})]],
    ['no funding instrument', 'campaigns', [pausedCampaign({funding_instrument_id: undefined})]],
    ['a daily budget above the total', 'campaigns', [pausedCampaign({daily_budget_amount_local_micro: 60000000})]],
    ['a fractional budget', 'campaigns', [pausedCampaign({daily_budget_amount_local_micro: 5.5})]],
    ['an unknown placement', 'line_items', [pausedLine({placements: 'EVERYWHERE'})]],
    ['a time without zone', 'line_items', [pausedLine({start_time: '2026-10-01T00:00:00'})]],
    ['an end before the start', 'line_items', [pausedLine({end_time: '2026-09-01T00:00:00Z'})]],
    ['a bid with AUTO', 'line_items', [pausedLine({bid_strategy: 'AUTO'})]],
    [
      'a duplicate update',
      'line_items',
      [update('line_item_id', 'l1', {name: 'A'}), update('line_item_id', 'l1', {name: 'B'})],
    ],
    ['an update without changes', 'line_items', [{operation_type: 'Update', params: {line_item_id: 'l1'}}]],
    ['an undocumented update field', 'line_items', [update('line_item_id', 'l1', {placements: 'TWITTER_SEARCH'})]],
    ['a delete with fields', 'line_items', [{operation_type: 'Delete', params: {line_item_id: 'l1', name: 'x'}}]],
    ['an unknown operation', 'line_items', [{operation_type: 'Upsert', params: {line_item_id: 'l1'}}]],
    ['an extra item key', 'line_items', [{...remove('line_item_id', 'l1'), note: 'x'}]],
  ];
  for (const [label, kind, ops] of cases) {
    const f = setup();
    try {
      const r = await f.prepare(kind, ops);
      assert.equal(r.error?.code, 'INVALID_X_ENTITY_BATCH', label + ': ' + JSON.stringify(r).slice(0, 400));
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
  const f = setup();
  try {
    assert.equal(
      (await f.prepare('campaigns', [pausedCampaign({funding_instrument_id: 'fi9'})])).error?.code,
      'STATE_NOT_FOUND',
    );
    assert.match(
      (await f.prepare('campaigns', [pausedCampaign({funding_instrument_id: 'fi2'})])).error?.message ?? '',
      /cannot fund campaigns \(EXPIRED\)/,
    );
    assert.equal((await f.prepare('line_items', [pausedLine({campaign_id: 'c3'})])).error?.code, 'STATE_NOT_FOUND');
    assert.equal((await f.prepare('line_items', [remove('line_item_id', 'l3')])).error?.code, 'STATE_NOT_FOUND');
    assert.match(
      (await f.prepare('line_items', [update('line_item_id', 'l1', {name: 'Line l1'})])).error?.message ?? '',
      /already has these values/,
    );
    assert.match(
      (await f.prepare('line_items', [update('line_item_id', 'l2', {bid_amount_local_micro: 900000})])).error
        ?.message ?? '',
      /AUTO ignores/,
    );
    assert.match(
      (await f.prepare('campaigns', [update('campaign_id', 'c1', {daily_budget_amount_local_micro: 60000000})])).error
        ?.message ?? '',
      /must not exceed/,
    );
    saveSpendPolicy(f.store, owner, {
      gateway,
      account_id: account,
      confirmed: true,
      policy: {enforcement: 'block', max_budget_increase_percent: 10},
    });
    assert.equal(
      (
        await f.prepare('campaigns', [
          update('campaign_id', 'c1', {daily_budget_amount_local_micro: 5250000}),
          update('campaign_id', 'c2', {daily_budget_amount_local_micro: 12000000}),
        ])
      ).error?.code,
      'POLICY_INCREASE_LIMIT',
      'c2 rises 20% against its own budget',
    );
    ok(
      await f.prepare('campaigns', [
        update('campaign_id', 'c1', {daily_budget_amount_local_micro: 5250000}),
        update('campaign_id', 'c2', {daily_budget_amount_local_micro: 10500000}),
      ]),
    );
    saveSpendPolicy(f.store, owner, {
      gateway,
      account_id: account,
      confirmed: true,
      policy: {allow_activation: false, allow_deletion: false},
    });
    assert.equal(
      (await f.prepare('campaigns', [update('campaign_id', 'c1', {entity_status: 'ACTIVE'})])).error?.code,
      'POLICY_ACTIVATION_FORBIDDEN',
    );
    assert.equal(
      (await f.prepare('line_items', [remove('line_item_id', 'l1')])).error?.code,
      'POLICY_DELETION_FORBIDDEN',
    );
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('an error or item-error reply is never resubmitted, a short or ignored batch is not verified, and the ledger lists both rows', async () => {
  for (const mode of ['error', 'items', 'short']) {
    const e = setup(mode);
    try {
      const p = ok(
        await e.prepare('line_items', [
          update('line_item_id', 'l1', {name: 'A'}),
          update('line_item_id', 'l2', {name: 'B'}),
        ]),
      );
      assert.equal((await e.execute(p)).success, false, mode);
      assert.equal((await e.execute(p)).success, false, mode);
      assert.equal(e.writes(), 1, mode);
    } finally {
      e.store.close();
    }
  }
  const g = setup('ignore');
  try {
    const p = ok(await g.prepare('campaigns', [update('campaign_id', 'c1', {name: 'Ignored'})]));
    ok(await g.execute(p));
    assert.notEqual(ok(await g.verify(p)).data.status, 'verified');
  } finally {
    g.store.close();
  }
  const h = setup('drift');
  try {
    const p = ok(await h.prepare('campaigns', [pausedCampaign()]));
    ok(await h.execute(p, {spend_change_confirmed: true}));
    assert.notEqual(ok(await h.verify(p)).data.status, 'verified');
  } finally {
    h.store.close();
  }
  for (const [kind, action] of Object.entries(actions)) {
    const row = actionContracts(registry).find(r => r.gateway === gateway && r.action === action);
    assert.equal(row?.status, 'reviewed_write_family', kind);
    assert.equal(row.family, 'x_entity_batches', kind);
  }
});

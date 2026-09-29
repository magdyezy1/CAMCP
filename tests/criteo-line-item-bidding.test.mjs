import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';

/**
 * Keywords and bid multipliers of Criteo auction line items, Retail Media API 2026-07 (pinned OpenAPI document and the
 * 2026.01 "Keywords" and "Bid Multipliers" guides, checked 2026-09-26).
 */
const gateway = 'criteo_native_action',
  prefix = '/2026-07/retail-media',
  registry = new Registry();
const actor = {tenantId: 'criteo-bidding', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const key = (type, phrase) => 'k' + Buffer.from(type + '\n' + phrase.toLowerCase(), 'utf8').toString('hex');
const lists = {
  PositiveExactMatch: 'positiveExact',
  NegativeExactMatch: 'negativeExact',
  NegativeBroadMatch: 'negativeBroad',
};
const pages = [
  'home',
  'search',
  'category',
  'productDetail',
  'merchandising',
  'deals',
  'favorites',
  'searchBar',
  'categoryMenu',
  'checkout',
  'confirmation',
  'aiAssistant',
];
const current = () => ({
  home: 1.9,
  search: 1.1,
  category: 1.5,
  productDetail: 1.6,
  merchandising: 1.7,
  deals: 2,
  favorites: 2.3,
  searchBar: 1,
  categoryMenu: 1.1,
  checkout: 2.5,
  confirmation: 1.3,
  aiAssistant: null,
});
const line = (name, status) => ({
  campaignId: '456',
  targetRetailerId: '55',
  name,
  startDate: '2030-08-01T04:00:00+00:00',
  endDate: null,
  budget: 500,
  monthlyPacing: null,
  dailyPacing: null,
  isAutoDailyPacing: false,
  bidStrategy: 'manual',
  optimizationStrategy: 'conversion',
  targetBid: 0.5,
  maxBid: 3,
  flightSchedule: null,
  keywordStrategy: 'genericAndBranded',
  status,
  budgetSpent: 0,
  budgetRemaining: 500,
  createdAt: '2026-01-01T00:00:00+00:00',
  updatedAt: '2026-01-01T00:00:00+00:00',
});
const entry = (matchType, phrases, bid = null) => ({
  matchType,
  bid,
  ...(matchType === 'PositiveExactMatch' ? {reviewState: 'Approved'} : {}),
  inputKeywords: {positiveExact: [], negativeExact: [], negativeBroad: [], [lists[matchType]]: phrases},
  createdAt: '2026-01-01T00:00:00',
  updatedAt: '2026-01-01T00:00:00',
});
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 71).toString('base64')),
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
  // Criteo indexes keywords by a normalized phrase (opaque to AMCP) and lists the phrases supplied for it.
  const keywords = () => ({
    egg: entry('PositiveExactMatch', ['eggs', 'Egg'], 0.5),
    milk: entry('PositiveExactMatch', ['milk']),
    tomato: entry('NegativeExactMatch', ['tomatoes']),
    fruit: entry('NegativeBroadMatch', ['fruits']),
  });
  const lines = new Map([
    ['789', {attributes: line('Active line', 'active'), keywords: keywords(), multipliers: current()}],
    ['791', {attributes: line('Paused line', 'paused'), keywords: keywords(), multipliers: current()}],
  ]);
  let writes = 0,
    mode = '';
  const calls = [];
  const normalize = phrase => phrase.toLowerCase().replace(/s$/, '');
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
                attributes: {name: 'Account', type: 'demand', currency: 'USD', timeZone: 'America/Chicago'},
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
                  attributes: {
                    name: 'Summer',
                    accountId: '123',
                    type: 'auction',
                    retailerId: null,
                    budget: 5000,
                    status: 'active',
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
                .map(id => ({
                  id,
                  type: 'RetailMediaLineItem',
                  attributes: {
                    campaignId: '456',
                    targetRetailerId: '55',
                    name: lines.get(id).attributes.name,
                    type: 'auction',
                    status: lines.get(id).attributes.status,
                    startDate: '2030-08-01',
                    budget: 500,
                    budgetSpent: 0,
                  },
                })),
            ),
          );
        let m = /^\/2026-07\/retail-media\/auction-line-items\/(\d+)$/.exec(u.pathname);
        if (m)
          return Response.json({
            data: {id: m[1], type: 'SponsoredProductsLineItem', attributes: lines.get(m[1]).attributes},
            errors: [],
            warnings: [],
          });
        m = /^\/2026-07\/retail-media\/line-items\/(\d+)\/keywords$/.exec(u.pathname);
        if (m)
          return Response.json({
            data: {
              id: m[1],
              type: 'RetailMediaKeywordsModel',
              attributes: {keywords: structuredClone(lines.get(m[1]).keywords)},
            },
            errors: [],
            warnings: [],
          });
        m = /^\/2026-07\/retail-media\/line-items\/(\d+)\/bid-multipliers$/.exec(u.pathname);
        if (m)
          return Response.json({
            data: {
              type: 'LineItemBidMultipliersV2',
              attributes: {id: m[1], ...lines.get(m[1]).multipliers, ...(mode === 'extra_page' ? {newPage: 1} : {})},
            },
            warnings: [],
            errors: [],
          });
        throw new Error('Unexpected read ' + u.pathname);
      }
      writes++;
      const body = JSON.parse(String(init.body));
      let m = /^\/2026-07\/retail-media\/line-items\/(\d+)\/keywords\/(add-remove|set-bid)$/.exec(u.pathname);
      if (m) {
        const k = lines.get(m[1]).keywords;
        for (const r of body.data.attributes.keywords) {
          if (mode === 'ignore') continue;
          const holder = type =>
            Object.entries(k).find(
              ([, e]) =>
                (type === undefined || e.matchType === type) &&
                (e.inputKeywords[lists[e.matchType]] ?? []).some(x => x.toLowerCase() === r.phrase.toLowerCase()),
            );
          if (m[2] === 'set-bid') {
            holder('PositiveExactMatch')[1].bid = r.bid;
            continue;
          }
          if (r.isDeleted) {
            const [n, e] = holder(r.matchType);
            e.inputKeywords[lists[e.matchType]] = e.inputKeywords[lists[e.matchType]].filter(
              x => x.toLowerCase() !== r.phrase.toLowerCase(),
            );
            if (!e.inputKeywords[lists[e.matchType]].length) delete k[n];
            continue;
          }
          const n = normalize(r.phrase);
          if (k[n]) k[n].inputKeywords[lists[r.matchType]].push(r.phrase);
          else k[n] = entry(r.matchType, [r.phrase]);
          if (r.matchType === 'PositiveExactMatch') k[n].reviewState = 'InReview';
        }
        return Response.json(
          mode === 'warning'
            ? {warnings: [{code: 'review', detail: 'Keyword needs review'}], errors: []}
            : m[2] === 'add-remove'
              ? {}
              : {errors: [], warnings: []},
        );
      }
      m = /^\/2026-07\/retail-media\/line-items\/(\d+)\/bid-multipliers$/.exec(u.pathname);
      if (m && method === 'PUT') {
        const l = lines.get(m[1]),
          a = body.data.attributes;
        // The PUT replaces every page type; one left out returns to 1.0.
        if (mode !== 'ignore')
          l.multipliers = Object.fromEntries(
            pages.map(p => [p, Object.hasOwn(a, p) ? a[p] : p === 'aiAssistant' ? null : 1]),
          );
        // The guide sample returns the line item ID as a JSON number.
        return new Response(
          '{"data":{"id":' +
            m[1] +
            ',"type":"LineItemBidMultipliersV2","attributes":' +
            JSON.stringify(l.multipliers) +
            '},"warnings":[],"errors":[]}',
          {status: 200, headers: {'content-type': 'application/json'}},
        );
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
  const discover = id =>
    service.call(
      gateway,
      {
        operation: 'criteo_line_item_ops',
        arguments: {
          action: 'GET_LINE_ITEMS_BY_ACCOUNT_ID',
          account_id: '123',
          params: {limitToId: [id], limitToType: 'Auction', pageIndex: 0, pageSize: 2},
        },
      },
      actor,
    );
  const prepare = (operation, action, params, data) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {operation, arguments: {action, account_id: '123', params, payload: {data}}},
      },
      actor,
    );
  const keywordsOf = (lineItem, items) =>
    prepare(
      'criteo_catalog_ops',
      'ADD_REMOVE_KEYWORDS',
      {id: lineItem},
      {type: 'RetailMediaKeywordAddRemove', attributes: {keywords: items}},
    );
  const bids = (lineItem, items) =>
    prepare(
      'criteo_catalog_ops',
      'SET_KEYWORD_BIDS',
      {id: lineItem},
      {type: 'RetailMediaKeywordsSetBid', attributes: {keywords: items}},
    );
  const multipliers = (lineItem, attributes) =>
    prepare(
      'criteo_line_item_ops',
      'UPDATE_BID_MULTIPLIERS_BY_LINE_ITEM_ID',
      {'line-item-id': lineItem},
      {type: 'LineItemBidMultipliersV2', attributes},
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
  return {
    store,
    calls,
    lines,
    discover,
    keywords: keywordsOf,
    bids,
    multipliers,
    execute,
    verify,
    writes: () => writes,
    mode: m => {
      mode = m;
    },
  };
}
const kw = (phrase, matchType, isDeleted = false) => ({phrase, matchType, isDeleted});
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('keywords are added and removed by match type, with confirmation where delivery widens, and verify through normalized keywords', async () => {
  const f = fixture();
  try {
    ok(await f.discover('789'));
    const p = ok(
        await f.keywords('789', [
          kw('Cookies', 'PositiveExactMatch'),
          kw('raspberries', 'NegativeExactMatch'),
          kw('fruits', 'NegativeBroadMatch', true),
        ]),
      ),
      impact = p.data.creative_impact;
    assert.deepEqual(impact.added.PositiveExactMatch, ['Cookies']);
    assert.deepEqual(impact.removed.NegativeBroadMatch, ['fruits']);
    assert.equal(impact.widens_delivery, true);
    assert.equal(impact.keywords_before, 4);
    assert.equal((await f.execute(p)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal(f.writes(), 0);
    ok(await f.execute(p, {spend_change_confirmed: true}));
    assert.equal(f.writes(), 1);
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal((await f.execute(p, {spend_change_confirmed: true})).data.replayed, true);
    assert.equal(f.writes(), 1);
    assert.deepEqual(Object.keys(f.lines.get('789').keywords).sort(), [
      'cookie',
      'egg',
      'milk',
      'raspberrie',
      'tomato',
    ]);
    // Only narrowing: no spending confirmation, and a phrase mentioning a budget is not a budget edit.
    const n = ok(
      await f.keywords('789', [kw('budget tv', 'NegativeBroadMatch'), kw('milk', 'PositiveExactMatch', true)]),
    );
    assert.equal(n.data.creative_impact.widens_delivery, false);
    ok(await f.execute(n));
    assert.equal(ok(await f.verify(n)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});

test('bids apply to positive keywords by any supplied phrase, and bid multipliers are replaced as a whole', async () => {
  const f = fixture();
  try {
    ok(await f.discover('789'));
    const p = ok(
      await f.bids('789', [
        {phrase: 'EGGS', bid: 0.8},
        {phrase: 'milk', bid: 0.6},
      ]),
    );
    assert.deepEqual(p.data.creative_impact.bids, [
      {phrase: 'EGGS', keyword: 'egg', review_state: 'Approved', before: 0.5, after: 0.8},
      {phrase: 'milk', keyword: 'milk', review_state: 'Approved', before: null, after: 0.6},
    ]);
    assert.match(p.data.creative_impact.units, /retailer default currency/);
    assert.equal((await f.execute(p)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    ok(await f.execute(p, {spend_change_confirmed: true}));
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal(f.lines.get('789').keywords.egg.bid, 0.8);
    const back = ok(await f.bids('789', [{phrase: 'egg', bid: null}]));
    ok(await f.execute(back, {spend_change_confirmed: true}));
    assert.equal(ok(await f.verify(back)).data.status, 'verified');
    const m = ok(await f.multipliers('789', {...current(), search: 2, aiAssistant: 1.2}));
    assert.deepEqual(m.data.creative_impact.changed, ['search', 'aiAssistant']);
    assert.equal((await f.execute(m)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    ok(await f.execute(m, {spend_change_confirmed: true}));
    assert.equal(ok(await f.verify(m)).data.status, 'verified');
    assert.equal(f.lines.get('789').multipliers.search, 2);
  } finally {
    f.store.close();
  }
});

test('malformed keyword, bid and bid multiplier requests fail before any request', async () => {
  const many = Array.from({length: 101}, (_, i) => kw('phrase ' + i, 'NegativeBroadMatch'));
  for (const [label, kind, body, code] of [
    ['no keywords', 'keywords', [], 'INVALID_CRITEO_KEYWORDS'],
    ['too many keywords', 'keywords', many, 'INVALID_CRITEO_KEYWORDS'],
    ['missing isDeleted', 'keywords', [{phrase: 'a', matchType: 'NegativeBroadMatch'}], 'INVALID_CRITEO_KEYWORDS'],
    [
      'text isDeleted',
      'keywords',
      [{phrase: 'a', matchType: 'NegativeBroadMatch', isDeleted: 'false'}],
      'INVALID_CRITEO_KEYWORDS',
    ],
    ['unknown match type', 'keywords', [kw('a', 'BroadMatch')], 'INVALID_CRITEO_KEYWORDS'],
    ['long phrase', 'keywords', [kw('x'.repeat(256), 'NegativeBroadMatch')], 'INVALID_CRITEO_KEYWORDS'],
    ['surrounding space', 'keywords', [kw(' a', 'NegativeBroadMatch')], 'INVALID_CRITEO_KEYWORDS'],
    [
      'phrase twice in other case',
      'keywords',
      [kw('Milk', 'NegativeBroadMatch'), kw('milk', 'NegativeExactMatch')],
      'INVALID_CRITEO_KEYWORDS',
    ],
    ['zero bid', 'bids', [{phrase: 'milk', bid: 0}], 'INVALID_CRITEO_KEYWORDS'],
    ['text bid', 'bids', [{phrase: 'milk', bid: '0.5'}], 'INVALID_CRITEO_KEYWORDS'],
    [
      'match type on a bid',
      'bids',
      [{phrase: 'milk', bid: 1, matchType: 'PositiveExactMatch'}],
      'INVALID_CRITEO_KEYWORDS',
    ],
    [
      'missing page type',
      'multipliers',
      (({aiAssistant, ...rest}) => rest)(current()),
      'INVALID_CRITEO_BID_MULTIPLIERS',
    ],
    ['above 6.0', 'multipliers', {...current(), home: 7}, 'INVALID_CRITEO_BID_MULTIPLIERS'],
    ['below 0.5', 'multipliers', {...current(), deals: 0.4}, 'INVALID_CRITEO_BID_MULTIPLIERS'],
    [
      'null for a page other than aiAssistant',
      'multipliers',
      {...current(), home: null},
      'INVALID_CRITEO_BID_MULTIPLIERS',
    ],
    ['unknown page type', 'multipliers', {...current(), banner: 1}, 'INVALID_CRITEO_BID_MULTIPLIERS'],
    ['another line item ID', 'multipliers', {...current(), id: '790'}, 'INVALID_CRITEO_BID_MULTIPLIERS'],
  ]) {
    const f = fixture();
    try {
      const r =
        kind === 'keywords'
          ? await f.keywords('789', body)
          : kind === 'bids'
            ? await f.bids('789', body)
            : await f.multipliers('789', body);
      assert.equal(r.error?.code, code, label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
});

test('the review refuses existing, missing and retyped keywords, bids on negative or shared keywords, unchanged values and unknown page types', async () => {
  const f = fixture();
  try {
    assert.equal((await f.keywords('789', [kw('bread', 'PositiveExactMatch')])).error?.code, 'RESOURCE_SCOPE_REQUIRED');
    assert.equal(f.calls.length, 0);
    ok(await f.discover('789'));
    assert.equal((await f.keywords('789', [kw('MILK', 'PositiveExactMatch')])).error?.code, 'CONFIGURATION_EXISTS');
    const missing = await f.keywords('789', [kw('bread', 'PositiveExactMatch', true)]);
    assert.equal(missing.error?.code, 'STATE_TARGET_MISMATCH');
    assert.deepEqual(missing.error.details.phrases, ['bread']);
    assert.match(
      (await f.keywords('789', [kw('milk', 'NegativeExactMatch')])).error?.message ?? '',
      /another match type/,
    );
    assert.equal((await f.bids('789', [{phrase: 'tomatoes', bid: 1}])).error?.code, 'STATE_TARGET_MISMATCH');
    assert.match(
      (
        await f.bids('789', [
          {phrase: 'eggs', bid: 0.8},
          {phrase: 'egg', bid: 0.9},
        ])
      ).error?.message ?? '',
      /share one bid/,
    );
    assert.match((await f.bids('789', [{phrase: 'eggs', bid: 0.5}])).error?.message ?? '', /already have this bid/);
    assert.match((await f.multipliers('789', current())).error?.message ?? '', /already match/);
    f.mode('extra_page');
    const extra = await f.multipliers('789', {...current(), search: 2});
    assert.equal(extra.error?.code, 'INCOMPLETE_STATE');
    assert.deepEqual(extra.error.details.fields, ['newPage']);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('owner policies: widening keywords count as activation unless the line item is paused; ADD_REMOVE_KEYWORDS is a deletion, bids are neither', async () => {
  const f = fixture();
  try {
    ok(await f.discover('789'));
    ok(await f.discover('791'));
    saveSpendPolicy(f.store, owner, {
      gateway,
      account_id: '123',
      confirmed: true,
      policy: {allow_deletion: true, allow_activation: false},
    });
    assert.equal(
      (await f.keywords('789', [kw('bread', 'PositiveExactMatch')])).error?.code,
      'POLICY_ACTIVATION_FORBIDDEN',
    );
    ok(await f.keywords('791', [kw('bread', 'PositiveExactMatch')]));
    ok(await f.keywords('789', [kw('candy', 'NegativeExactMatch')]));
    ok(await f.bids('789', [{phrase: 'milk', bid: 0.7}]));
    ok(await f.multipliers('789', {...current(), home: 1}));
    saveSpendPolicy(f.store, owner, {
      gateway,
      account_id: '123',
      confirmed: true,
      policy: {allow_deletion: false, allow_activation: true},
    });
    assert.equal(
      (await f.keywords('789', [kw('tomatoes', 'NegativeExactMatch', true)])).error?.code,
      'POLICY_DELETION_FORBIDDEN',
    );
    // The native action can remove keywords, so its name makes every request a deletion, additions included.
    assert.equal(
      (await f.keywords('789', [kw('bread', 'PositiveExactMatch')])).error?.code,
      'POLICY_DELETION_FORBIDDEN',
    );
    ok(await f.bids('789', [{phrase: 'milk', bid: 0.7}]));
    ok(await f.multipliers('789', {...current(), home: 1}));
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('responses with warnings are not resubmitted, a changed keyword list stops execution, and ignored changes are inconclusive', async () => {
  {
    const f = fixture();
    try {
      ok(await f.discover('789'));
      const p = ok(await f.keywords('789', [kw('candy', 'NegativeExactMatch')]));
      f.mode('warning');
      assert.equal((await f.execute(p)).success, false);
      assert.equal((await f.execute(p)).data.replayed, true);
      assert.equal(f.writes(), 1);
      assert.equal((await f.verify(p)).error?.code, 'WRITE_PARTIAL_OR_FAILED');
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    ok(await f.discover('789'));
    const p = ok(await f.bids('789', [{phrase: 'milk', bid: 0.7}]));
    f.lines.get('789').keywords.milk.bid = 0.4;
    assert.equal((await f.execute(p, {spend_change_confirmed: true})).error?.code, 'STATE_CHANGED');
    assert.equal(f.writes(), 0);
    f.mode('ignore');
    const q = ok(await f.bids('789', [{phrase: 'milk', bid: 0.7}]));
    ok(await f.execute(q, {spend_change_confirmed: true}));
    const v = ok(await f.verify(q));
    assert.equal(v.data.status, 'inconclusive');
    assert.deepEqual(v.data.checks[0].changed_fields, ['/keywords/' + key('PositiveExactMatch', 'milk') + '/bid']);
    const r = ok(await f.keywords('789', [kw('candy', 'NegativeExactMatch')]));
    ok(await f.execute(r));
    const w = ok(await f.verify(r));
    assert.equal(w.data.status, 'inconclusive');
    assert.deepEqual(w.data.checks[0].changed_fields, ['/keywords/' + key('NegativeExactMatch', 'candy') + '/present']);
    const m = ok(await f.multipliers('789', {...current(), home: 1}));
    ok(await f.execute(m, {spend_change_confirmed: true}));
    const x = ok(await f.verify(m));
    assert.equal(x.data.status, 'inconclusive');
    assert.deepEqual(x.data.checks[0].changed_fields, ['/multipliers/home']);
  } finally {
    f.store.close();
  }
});

test('the keyword and bid multiplier routes and models match the pinned document', () => {
  const doc = JSON.parse(readFileSync('.mirror/VENDOR/criteo-retail-2026-07.json', 'utf8')).document,
    schemas = doc.components.schemas;
  for (const [path, method] of [
    ['/line-items/{id}/keywords/add-remove', 'post'],
    ['/line-items/{id}/keywords/set-bid', 'post'],
    ['/line-items/{line-item-id}/bid-multipliers', 'put'],
  ])
    assert.deepEqual(doc.paths[prefix + path][method].security, [{oauth: ['RetailMedia_Campaign_Manage']}]);
  assert.deepEqual(Object.keys(schemas.AddRemoveKeywordModel.properties).sort(), ['isDeleted', 'matchType', 'phrase']);
  assert.deepEqual(Object.keys(schemas.SetBidModel.properties).sort(), ['bid', 'phrase']);
  assert.deepEqual(schemas.MatchTypeModel.enum, ['PositiveExactMatch', 'NegativeExactMatch', 'NegativeBroadMatch']);
  assert.deepEqual(Object.keys(schemas.LineItemBidMultipliersV2.properties).sort(), [...pages, 'id'].sort());
  const routes = JSON.parse(readFileSync('generated/vendor-routes.json', 'utf8')).routes.filter(
    r =>
      r.gateway === gateway &&
      ['ADD_REMOVE_KEYWORDS', 'SET_KEYWORD_BIDS', 'UPDATE_BID_MULTIPLIERS_BY_LINE_ITEM_ID'].includes(r.action),
  );
  assert.deepEqual(routes.map(r => [r.operation, r.action, r.method, r.path]).sort(), [
    ['criteo_catalog_ops', 'ADD_REMOVE_KEYWORDS', 'POST', prefix + '/line-items/{id}/keywords/add-remove'],
    ['criteo_catalog_ops', 'SET_KEYWORD_BIDS', 'POST', prefix + '/line-items/{id}/keywords/set-bid'],
    [
      'criteo_line_item_ops',
      'UPDATE_BID_MULTIPLIERS_BY_LINE_ITEM_ID',
      'PUT',
      prefix + '/line-items/{line-item-id}/bid-multipliers',
    ],
  ]);
});

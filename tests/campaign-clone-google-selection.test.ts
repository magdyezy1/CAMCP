import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Store} from '../src/store.js';
import {MirrorError} from '../src/errors.js';
import {composeGoogleBuild} from '../src/google-atomic-builds.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import type {Actor, JsonObject} from '../src/types.js';
import {fingerprint} from '../src/workspace-core.js';
import {assertRefused} from './helpers/assert-refused.js';

/**
 * Cloning part of a Google Search campaign (field fix r25-field-gclone, 2026-11-19; the owner's issue 1 of that day: a
 * clone copied the whole campaign when only some ad groups, or one language, were wanted).
 *
 * The source reads are answered by a fake that evaluates the GAQL the clone sends, as Google does: it filters by the
 * WHERE clause, answers only the fields that were selected, refuses a field the resource does not have, an ORDER BY on a
 * field that cannot be sorted or was not selected, and returns the rows of a query without ORDER BY in an order that
 * changes from one read to the next (GAQL names an order only through ORDER BY, so the fake does not promise one). The
 * field capabilities (selectable, filterable, sortable) are those of Google's v23 field reference on
 * developers.google.com. Nothing here calls a provider.
 */
const google = 'google_ads_native_action',
  actor: Actor = {tenantId: 'clone-google-select', userId: 'operator', role: 'operator'},
  admin: Actor = {...actor, role: 'admin'},
  customer = 'customers/123';
const campaignOf = (id: string) => customer + '/campaigns/' + id,
  groupOf = (id: string) => customer + '/adGroups/' + id;

type Row = Record<string, unknown>;
const adGroup = (campaign: string, id: string, name: string, status = 'ENABLED', cpc?: string): Row => ({
  'campaign.resource_name': campaignOf(campaign),
  'ad_group.id': id,
  'ad_group.resource_name': groupOf(id),
  'ad_group.name': name,
  'ad_group.type': 'SEARCH_STANDARD',
  'ad_group.status': status,
  ...(cpc ? {'ad_group.cpc_bid_micros': cpc} : {}),
});
const keyword = (campaign: string, group: string, id: string, text: string, extra: Row = {}): Row => ({
  'campaign.resource_name': campaignOf(campaign),
  'ad_group.id': group,
  'ad_group_criterion.criterion_id': id,
  'ad_group_criterion.ad_group': groupOf(group),
  'ad_group_criterion.type': 'KEYWORD',
  'ad_group_criterion.status': 'ENABLED',
  'ad_group_criterion.keyword.text': text,
  'ad_group_criterion.keyword.match_type': 'EXACT',
  ...extra,
});
const responsiveAd = (campaign: string, group: string, id: string, label: string): Row => ({
  'campaign.resource_name': campaignOf(campaign),
  'ad_group.id': group,
  'ad_group_ad.ad.id': id,
  'ad_group_ad.ad_group': groupOf(group),
  'ad_group_ad.status': 'ENABLED',
  'ad_group_ad.ad.type': 'RESPONSIVE_SEARCH_AD',
  'ad_group_ad.ad.final_urls': ['https://example.test/' + id],
  'ad_group_ad.ad.responsive_search_ad.headlines': ['one', 'two', 'three'].map(n => ({text: label + ' ' + n})),
  'ad_group_ad.ad.responsive_search_ad.descriptions': ['first', 'second'].map(n => ({text: label + ' ' + n})),
  'ad_group_ad.ad.responsive_search_ad.path1': 'path',
});
const criterion = (campaign: string, id: string, type: string, extra: Row = {}): Row => ({
  'campaign.resource_name': campaignOf(campaign),
  'campaign_criterion.criterion_id': id,
  'campaign_criterion.type': type,
  'campaign_criterion.status': 'ENABLED',
  ...extra,
});

/**
 * The account's rows, in the order they are stored, which is deliberately not the ID order. Campaign 77 is the source:
 * four ad groups (30, 10, 40 and 20), a removed one (50), and targeting of two languages. Campaign 88 has an ad group
 * and a language that must never be reachable through campaign 77. Campaign 66 targets no language. Campaign 55 is too large to
 * copy whole (340 ad groups, each with a keyword and an ad: 1,022 resources, or as many steps), and campaign 57 has 30 ad groups, which
 * a fake that answers one row a page needs 30 pages to read. Campaign 58 has three ad groups whose IDs have one, two and three
 * digits (110, 7 and 12 in the order stored): ID order is the order of the numbers, 7, 12, 110, not of the text, 110, 12, 7.
 */
const manyIds = (first: number, count: number) => Array.from({length: count}, (_, i) => String(first + i));
const rows = (): Record<string, Row[]> => ({
  campaign: [
    {
      'campaign.resource_name': campaignOf('88'),
      'campaign.name': 'Other campaign',
      'campaign.advertising_channel_type': 'SEARCH',
      'campaign.bidding_strategy_type': 'MAXIMIZE_CONVERSIONS',
    },
    {
      'campaign.resource_name': campaignOf('66'),
      'campaign.name': 'No language',
      'campaign.advertising_channel_type': 'SEARCH',
      'campaign.bidding_strategy_type': 'MAXIMIZE_CONVERSIONS',
    },
    ...['55', '57', '58'].map(id => ({
      'campaign.resource_name': campaignOf(id),
      'campaign.name': 'Large ' + id,
      'campaign.advertising_channel_type': 'SEARCH',
      'campaign.bidding_strategy_type': 'MAXIMIZE_CONVERSIONS',
      'campaign_budget.amount_micros': '10000000',
      'campaign_budget.delivery_method': 'STANDARD',
    })),
    {
      'campaign.resource_name': campaignOf('77'),
      'campaign.name': 'Search EN',
      'campaign.advertising_channel_type': 'SEARCH',
      'campaign.bidding_strategy_type': 'MAXIMIZE_CONVERSIONS',
      'campaign.contains_eu_political_advertising': 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
      'campaign.network_settings.target_google_search': true,
      'campaign.network_settings.target_search_network': false,
      'campaign.network_settings.target_content_network': false,
      'campaign.maximize_conversions.target_cpa_micros': '25000000',
      'campaign_budget.amount_micros': '40000000',
      'campaign_budget.delivery_method': 'STANDARD',
    },
  ],
  campaign_criterion: [
    criterion('77', '7000000001', 'KEYWORD', {
      'campaign_criterion.negative': true,
      'campaign_criterion.keyword.text': 'free',
      'campaign_criterion.keyword.match_type': 'PHRASE',
    }),
    criterion('77', '2682', 'LOCATION', {'campaign_criterion.location.geo_target_constant': 'geoTargetConstants/2682'}),
    criterion('77', '9001', 'AD_SCHEDULE'),
    criterion('77', '1019', 'LANGUAGE', {'campaign_criterion.language.language_constant': 'languageConstants/1019'}),
    criterion('77', '1000', 'LANGUAGE', {'campaign_criterion.language.language_constant': 'languageConstants/1000'}),
    criterion('88', '1003', 'LANGUAGE', {'campaign_criterion.language.language_constant': 'languageConstants/1003'}),
  ],
  ad_group: [
    adGroup('77', '30', 'Brand', 'ENABLED', '1500000'),
    adGroup('77', '10', 'Generic', 'PAUSED'),
    adGroup('77', '50', 'Retired', 'REMOVED'),
    adGroup('88', '60', 'Elsewhere'),
    adGroup('77', '40', 'Competitors'),
    adGroup('66', '70', 'Solo'),
    adGroup('77', '20', 'Services'),
    ...manyIds(5000, 340).map(id => adGroup('55', id, 'Group ' + id)),
    ...manyIds(6000, 30).map(id => adGroup('57', id, 'Page ' + id)),
    adGroup('58', '110', 'Hundred ten'),
    adGroup('58', '7', 'Seven'),
    adGroup('58', '12', 'Twelve'),
  ],
  ad_group_criterion: [
    keyword('77', '30', '303', 'acme'),
    keyword('77', '30', '302', 'jobs', {
      'ad_group_criterion.negative': true,
      'ad_group_criterion.keyword.match_type': 'BROAD',
    }),
    keyword('77', '10', '101', 'widgets'),
    keyword('77', '40', '401', 'rival'),
    keyword('88', '60', '601', 'elsewhere'),
    keyword('77', '20', '201', 'repairs'),
    ...manyIds(5000, 340).map(id => keyword('55', id, id + '1', 'term ' + id)),
  ],
  ad_group_ad: [
    responsiveAd('77', '30', '3001', 'Brand'),
    responsiveAd('77', '10', '1001', 'Generic'),
    responsiveAd('77', '10', '1000', 'Generic B'),
    responsiveAd('88', '60', '6001', 'Elsewhere'),
    responsiveAd('77', '20', '2001', 'Services'),
    ...manyIds(5000, 340).map(id => responsiveAd('55', id, id + '2', 'Ad ' + id)),
  ],
});

/**
 * What each resource offers a query: its own fields and its attributed resources' (selectable and filterable), and the
 * fields Google lets a query sort by (Sortable: True in the field reference). Anything else is refused as Google does.
 */
const fields: Record<string, string[]> = {
  campaign: [
    'campaign.resource_name',
    'campaign.name',
    'campaign.advertising_channel_type',
    'campaign.bidding_strategy_type',
    'campaign.contains_eu_political_advertising',
    'campaign.network_settings.target_google_search',
    'campaign.network_settings.target_search_network',
    'campaign.network_settings.target_content_network',
    'campaign.network_settings.target_partner_search_network',
    'campaign.maximize_conversions.target_cpa_micros',
    'campaign.maximize_conversion_value.target_roas',
    'campaign.target_spend.cpc_bid_ceiling_micros',
    'campaign_budget.amount_micros',
    'campaign_budget.delivery_method',
    'campaign_budget.explicitly_shared',
  ],
  campaign_criterion: [
    'campaign.resource_name',
    'campaign_criterion.criterion_id',
    'campaign_criterion.type',
    'campaign_criterion.status',
    'campaign_criterion.negative',
    'campaign_criterion.location.geo_target_constant',
    'campaign_criterion.language.language_constant',
    'campaign_criterion.keyword.text',
    'campaign_criterion.keyword.match_type',
  ],
  ad_group: [
    'campaign.resource_name',
    'ad_group.id',
    'ad_group.resource_name',
    'ad_group.name',
    'ad_group.type',
    'ad_group.status',
    'ad_group.cpc_bid_micros',
  ],
  ad_group_criterion: [
    'campaign.resource_name',
    'ad_group.id',
    'ad_group_criterion.criterion_id',
    'ad_group_criterion.ad_group',
    'ad_group_criterion.type',
    'ad_group_criterion.status',
    'ad_group_criterion.negative',
    'ad_group_criterion.cpc_bid_micros',
    'ad_group_criterion.keyword.text',
    'ad_group_criterion.keyword.match_type',
  ],
  ad_group_ad: [
    'campaign.resource_name',
    'ad_group.id',
    'ad_group_ad.ad.id',
    'ad_group_ad.ad_group',
    'ad_group_ad.status',
    'ad_group_ad.ad.type',
    'ad_group_ad.ad.final_urls',
    'ad_group_ad.ad.responsive_search_ad.headlines',
    'ad_group_ad.ad.responsive_search_ad.descriptions',
    'ad_group_ad.ad.responsive_search_ad.path1',
    'ad_group_ad.ad.responsive_search_ad.path2',
  ],
};
const sortable = new Set([
  'ad_group.id',
  'ad_group_criterion.criterion_id',
  'ad_group_ad.ad.id',
  'campaign_criterion.criterion_id',
  'campaign_criterion.type',
]);
const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
/** A row as Google answers it: only the selected fields that are set, nested by resource, in camelCase. */
function project(row: Row, selected: string[]): JsonObject {
  const out: JsonObject = {};
  for (const field of selected) {
    if (row[field] === undefined) continue;
    const parts = field.split('.').map(camel);
    let at = out;
    for (const part of parts.slice(0, -1)) at = (at[part] ??= {}) as JsonObject;
    at[parts.at(-1)!] = row[field];
  }
  return out;
}
const refusal = (message: string) =>
  Response.json({error: {code: 400, status: 'INVALID_ARGUMENT', message}}, {status: 400});
/** Number-like fields sort as numbers: the ID fields hold int64 as text. */
const sortKey = (row: Row, field: string) =>
  /\.(id|criterion_id)$/.test(field) ? String(row[field] ?? '').padStart(24, '0') : String(row[field] ?? '');

/**
 * pageRows: how many rows of a resource one answer holds, so a longer read is paged by nextPageToken (default: all in one).
 * ignoreIn and ignoreOrderBy: a provider that accepts an IN filter, or an ORDER BY, and does not apply it (the second answers
 * in reverse order), so that what the clone keeps and how it numbers the ad groups can be shown not to rest on the provider
 * doing as asked. endless: the resources whose read a provider never finishes (it always names one more page), so that read
 * cannot fit the pages AMCP reads.
 */
function world(
  options: {pageRows?: Record<string, number>; ignoreIn?: boolean; ignoreOrderBy?: boolean; endless?: string[]} = {},
) {
  const store = new Store(':memory:', Buffer.alloc(32, 47).toString('base64'));
  store.putConnection(
    admin,
    {
      id: 'g',
      tenantId: actor.tenantId,
      gateway: google,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const tables = rows(),
    queries: string[] = [],
    notReads: string[] = [],
    reads = new Map<string, number>();
  function answer(query: string, body: JsonObject): Response {
    const parsed = /^SELECT (.+?) FROM ([a-z_]+)(?: WHERE (.+?))?(?: ORDER BY (.+?))?$/.exec(query);
    if (!parsed) return refusal('The fake does not read this query: ' + query);
    const [, list, table = '', where = '', orderBy = ''] = parsed,
      selected = list!.split(', '),
      offered = fields[table],
      stored = tables[table];
    if (!offered || !stored) return refusal('Unknown resource ' + table);
    const unknown = selected.find(f => !offered.includes(f));
    if (unknown) return refusal('Unrecognized field in the query: ' + unknown);
    const filters: ((row: Row) => boolean)[] = [];
    for (const condition of where ? where.split(' AND ') : []) {
      const equal = /^([a-z_.]+) (=|!=) '([^']*)'$/.exec(condition),
        listed = /^([a-z_.]+) IN \(([0-9, ]+)\)$/.exec(condition);
      if (equal && offered.includes(equal[1]!))
        filters.push(row => (row[equal[1]!] === equal[3]) === (equal[2] === '='));
      else if (listed && offered.includes(listed[1]!)) {
        const wanted = listed[2]!.split(',').map(v => v.trim());
        filters.push(row => options.ignoreIn === true || wanted.includes(String(row[listed[1]!])));
      } else return refusal('The fake does not evaluate, or the resource does not offer: ' + condition);
    }
    const order = orderBy ? orderBy.split(', ') : [];
    for (const field of order)
      if (!sortable.has(field) || !selected.includes(field))
        return refusal('A field of the ORDER BY clause is not sortable or not selected: ' + field);
    let found = stored.filter(row => filters.every(f => f(row)));
    if (order.length && options.ignoreOrderBy === true) found = found.reverse();
    else if (order.length)
      found = found.sort((a, b) => {
        for (const field of order) {
          const x = sortKey(a, field),
            y = sortKey(b, field);
          if (x !== y) return x < y ? -1 : 1;
        }
        return 0;
      });
    else {
      // A query without ORDER BY names no order, so none is kept: every second read of a resource comes back reversed.
      const n = (reads.get(table) ?? 0) + 1;
      reads.set(table, n);
      if (n % 2 === 0) found = found.reverse();
    }
    if (options.endless?.includes(table)) {
      // The page token changes, so the aggregator's loop check does not stop it: only the page limit does.
      const from = Number(body.pageToken ?? body.page_token ?? 0);
      return Response.json({results: found.map(row => project(row, selected)), nextPageToken: String(from + 1)});
    }
    const size = options.pageRows?.[table];
    if (size) {
      const from = Number(body.pageToken ?? body.page_token ?? 0);
      return Response.json({
        results: found.slice(from, from + size).map(row => project(row, selected)),
        ...(from + size < found.length ? {nextPageToken: String(from + size)} : {}),
      });
    }
    return Response.json({results: found.map(row => project(row, selected))});
  }
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith('googleAds:search')) {
          const body = JSON.parse(String(init?.body ?? '{}'));
          queries.push(String(body.query));
          return answer(String(body.query), body);
        }
        notReads.push(path);
        return Response.json({error: {code: 500, message: 'Synthetic'}}, {status: 500});
      },
      undefined,
      undefined,
      undefined,
      10000,
    ),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const call = (input: JsonObject) =>
    service.call(
      'amcp_campaign',
      {
        action: 'clone',
        gateway: google,
        account_id: '123',
        source: {campaign_id: '77'},
        name: 'Search EN copy',
        ...input,
      },
      actor,
    ) as Promise<JsonObject>;
  const plan = async (id: string): Promise<JsonObject> =>
    ((await service.call('amcp_campaign', {action: 'get', id, detail: 'full'}, actor)) as JsonObject).data;
  const plans = () => store.documents(actor.tenantId, 'campaign_run').length;
  return {store, service, queries, notReads, call, plan, plans};
}
/** The names of the ad groups a stored non-atomic plan creates, by step. */
const groupNames = (plan: JsonObject): Record<string, string> =>
  Object.fromEntries(
    (plan.steps as JsonObject[])
      .filter(s => /^adgroup_\d+$/.test(s.id))
      .map(s => [s.id, s.arguments.payload.operations[0].create.name]),
  );
/** The creates of one step of a stored plan. */
const creates = (plan: JsonObject, id: string): JsonObject[] =>
  (plan.steps as JsonObject[]).find(s => s.id === id)!.arguments.payload.operations.map((o: JsonObject) => o.create);
/** The keyword texts the steps of a stored non-atomic plan create. */
const keywordTexts = (plan: JsonObject): string[] =>
  (plan.steps as JsonObject[])
    .filter(s => /^adgroup_\d+_keywords$/.test(s.id))
    .flatMap(s => s.arguments.payload.operations.map((o: JsonObject) => o.create.keyword.text as string))
    .sort();
const idList = (query: string): string[] | undefined =>
  /ad_group\.id IN \(([0-9, ]+)\)/
    .exec(query)?.[1]
    ?.split(',')
    .map(v => v.trim())
    .sort();

test('source.ad_group_ids copies only the ad groups named: every ad group, keyword and ad read carries ad_group.id IN', async () => {
  const w = world();
  try {
    // A string and a number are both numeric IDs.
    const r = await w.call({atomic: false, source: {campaign_id: '77', ad_group_ids: ['30', 20]}});
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 800));
    const plan = await w.plan(r.data.id);
    assert.deepEqual(Object.values(groupNames(plan)).sort(), ['Brand', 'Services'], 'only the two ad groups named');
    assert.deepEqual(keywordTexts(plan), ['acme', 'jobs', 'repairs'], 'and only their keywords');
    assert.deepEqual(r.data.clone.source, {campaign_id: '77', ad_groups: 2, keywords: 3, ads: 2});
    const read = (from: string) => w.queries.filter(q => q.includes(' FROM ' + from + ' WHERE'));
    for (const from of ['ad_group', 'ad_group_criterion', 'ad_group_ad']) {
      assert.equal(read(from).length, 1, from);
      assert.deepEqual(idList(read(from)[0]!), ['20', '30'], from + ' is filtered by the IDs named');
    }
    for (const from of ['campaign', 'campaign_criterion'])
      assert.ok(!/ad_group\.id/.test(read(from)[0]!), from + ' is not an ad group read');
    // The campaign filter is kept: an ad group is the source campaign's, not any ad group of the account.
    assert.ok(
      w.queries.every(q => q.includes("campaign.resource_name = 'customers/123/campaigns/77'")),
      w.queries.join('\n'),
    );
    assert.deepEqual(w.notReads, [], 'nothing but reads reached the provider');
  } finally {
    w.store.close();
  }
});

test('an ad group ID that is not a non-removed ad group of the source campaign is refused, naming it, with no plan saved', async () => {
  const w = world();
  try {
    const cases: [string, (string | number)[], string[]][] = [
      ['an ID no ad group has', ['30', '999'], ['999']],
      ['a removed ad group of the campaign', ['50'], ['50']],
      ['an ad group of another campaign of the account', ['60', 10], ['60']],
      ['several, only the missing ones named', ['40', '70', '60', '999'], ['70', '60', '999']],
    ];
    for (const [label, ids, missing] of cases) {
      const r = await w.call({source: {campaign_id: '77', ad_group_ids: ids}});
      assertRefused(r, 'CLONE_SOURCE_NOT_FOUND');
      assert.equal(r.error.details.field, 'source.ad_group_ids', label);
      assert.deepEqual(r.error.details.missing, missing, label);
    }
    assert.equal(w.plans(), 0, 'no plan was saved');
    assert.deepEqual(w.notReads, []);
    // The same call with a campaign that does not exist is still refused by the campaign's own check.
    assertRefused(await w.call({source: {campaign_id: '999', ad_group_ids: ['30']}}), 'CLONE_SOURCE_NOT_FOUND');
    assert.equal(w.plans(), 0);
  } finally {
    w.store.close();
  }
});

test('source.ad_group_ids that is not 1 to 1,000 numeric IDs is refused before anything is read', async () => {
  const w = world();
  try {
    const bad: unknown[] = [
      [],
      'abc',
      '30',
      {id: 30},
      ['abc'],
      ['30', '-5'],
      [0],
      ['030'],
      ['9223372036854775808'],
      [null],
      [['30']],
      // Text that BigInt or a parser might read as 30, or that would end an IN list and begin a condition (the lead's review,
      // 2026-11-20, S3-1): the end of the rule is what keeps all of it out of the query.
      ['30 '],
      [' 30'],
      ['30\n'],
      ["30' OR '1'='1"],
      ['30) OR (1=1'],
      ['30,20'],
      ['٣٠'],
      ['３０'],
      ['0x1e'],
      ['3e1'],
      ['+30'],
      ['customers/123/adGroups/30'],
      Array.from({length: 1001}, (_, i) => String(i + 1)),
    ];
    for (const ids of bad) {
      const r = await w.call({source: {campaign_id: '77', ad_group_ids: ids}});
      assertRefused(r, 'INVALID_ARGUMENT', {writes: w.notReads.length});
      assert.equal(r.error.details.field, 'source.ad_group_ids', JSON.stringify(ids).slice(0, 80));
    }
    // A number that is not a safe integer is refused by the input guard that every *_ids argument passes first.
    assertRefused(await w.call({source: {campaign_id: '77', ad_group_ids: [1.5]}}), [
      'INVALID_ARGUMENT',
      'UNSAFE_NUMERIC_ID',
    ]);
    assert.deepEqual(w.queries, [], 'a bad list is refused before any read');
    assert.equal(w.plans(), 0);
    // 1,000 IDs are accepted (none of them is an ad group, so the clone is refused by the read, not by the list).
    const most = await w.call({
      source: {campaign_id: '77', ad_group_ids: Array.from({length: 1000}, (_, i) => i + 1000)},
    });
    assertRefused(most, 'CLONE_SOURCE_NOT_FOUND');
    // The refusal names the first 100 of them and counts them all, so its answer stays small.
    assert.deepEqual(
      most.error.details.missing,
      Array.from({length: 100}, (_, i) => String(i + 1000)),
    );
    assert.equal(most.error.details.missing_count, 1000);
  } finally {
    w.store.close();
  }
});

test('without source.ad_group_ids the clone copies every ad group that is not removed, as before', async () => {
  const w = world();
  try {
    for (const source of [{campaign_id: '77'}, {campaign_id: '77', ad_group_ids: null}, {campaign_id: 77}]) {
      const r = await w.call({atomic: false, source});
      assert.equal(r.success, true, JSON.stringify(r).slice(0, 800));
      assert.deepEqual(Object.values(groupNames(await w.plan(r.data.id))).sort(), [
        'Brand',
        'Competitors',
        'Generic',
        'Services',
      ]);
      assert.deepEqual(r.data.clone.source, {
        campaign_id: String(source.campaign_id),
        ad_groups: 4,
        keywords: 5,
        ads: 4,
      });
    }
    assert.ok(
      w.queries.every(q => !/ad_group\.id IN/.test(q)),
      'no ad group filter was sent',
    );
  } finally {
    w.store.close();
  }
});

/** The targeting step of a stored plan, as the languages (sorted), locations and negative keywords it creates. */
const targeting = (plan: JsonObject) => {
  const ops = creates(plan, 'targeting');
  return {
    languages: ops
      .filter(o => o.language)
      .map(o => o.language.language_constant as string)
      .sort(),
    locations: ops.filter(o => o.location).map(o => o.location.geo_target_constant as string),
    negatives: ops.filter(o => o.keyword).map(o => [o.keyword.text, o.keyword.match_type, o.negative]),
    count: ops.length,
  };
};

test('source.languages copies only the language criteria named; locations and negative keywords are copied as before', async () => {
  const w = world();
  try {
    const whole = await w.call({atomic: false});
    assert.equal(whole.success, true, JSON.stringify(whole).slice(0, 800));
    assert.deepEqual(targeting(await w.plan(whole.data.id)), {
      languages: ['languageConstants/1000', 'languageConstants/1019'],
      locations: ['geoTargetConstants/2682'],
      negatives: [['free', 'PHRASE', true]],
      count: 4,
    });
    for (const [chosen, copied] of [
      [['languageConstants/1019'], ['languageConstants/1019']],
      [['languageConstants/1000'], ['languageConstants/1000']],
      [
        ['languageConstants/1019', 'languageConstants/1000'],
        ['languageConstants/1000', 'languageConstants/1019'],
      ],
    ] as const) {
      const r = await w.call({atomic: false, source: {campaign_id: '77', languages: chosen}});
      assert.equal(r.success, true, JSON.stringify(r).slice(0, 800));
      const made = targeting(await w.plan(r.data.id));
      assert.deepEqual(made.languages, copied, 'only the languages named');
      assert.deepEqual(made.locations, ['geoTargetConstants/2682'], 'the location is kept');
      assert.deepEqual(made.negatives, [['free', 'PHRASE', true]], 'the negative keyword is kept');
      assert.equal(made.count, copied.length + 2);
      // The criteria AMCP does not copy are still reported as not copied; choosing languages leaves them as they were.
      assert.deepEqual(r.data.clone.not_copied, [{fields: ['AD_SCHEDULE criteria'], steps: ['targeting']}]);
      // Choosing languages does not touch the ad groups.
      assert.deepEqual(r.data.clone.source, {campaign_id: '77', ad_groups: 4, keywords: 5, ads: 4});
    }
    // Both selections together: two of the ad groups, and one of the languages.
    const both = await w.call({
      atomic: false,
      source: {campaign_id: '77', ad_group_ids: [30, '10'], languages: ['languageConstants/1019']},
    });
    assert.equal(both.success, true, JSON.stringify(both).slice(0, 800));
    const plan = await w.plan(both.data.id);
    assert.deepEqual(Object.values(groupNames(plan)).sort(), ['Brand', 'Generic']);
    assert.deepEqual(targeting(plan).languages, ['languageConstants/1019']);
    assert.deepEqual(w.notReads, [], 'nothing but reads reached the provider');
  } finally {
    w.store.close();
  }
});

test('a language the source campaign does not target is refused, naming it and what it targets, with no plan saved', async () => {
  const w = world();
  try {
    const cases: [string, string, string[], string[]][] = [
      ['a language only another campaign targets', '77', ['languageConstants/1003'], ['languageConstants/1003']],
      ['one of two', '77', ['languageConstants/1019', 'languageConstants/1004'], ['languageConstants/1004']],
      ['a campaign that targets no language', '66', ['languageConstants/1000'], ['languageConstants/1000']],
    ];
    for (const [label, campaign, languages, missing] of cases) {
      const r = await w.call({source: {campaign_id: campaign, languages}});
      assertRefused(r, 'CLONE_SOURCE_NOT_FOUND');
      assert.equal(r.error.details.field, 'source.languages', label);
      assert.deepEqual(r.error.details.missing, missing, label);
      assert.deepEqual(
        [...r.error.details.targeted].sort(),
        campaign === '77' ? ['languageConstants/1000', 'languageConstants/1019'] : [],
        label,
      );
    }
    assert.equal(w.plans(), 0, 'no plan was saved');
    assert.deepEqual(w.notReads, []);
  } finally {
    w.store.close();
  }
});

test('source.languages that is not 1 to 100 language constants is refused before anything is read', async () => {
  const w = world();
  try {
    const bad: unknown[] = [
      [],
      'languageConstants/1000',
      {language: 'languageConstants/1000'},
      ['1000'],
      [1000],
      ['languageConstants/'],
      ['languageConstants/abc'],
      ['languageConstants/0'],
      ['languageConstants/01000'],
      ['languageconstants/1000'],
      ['languageConstants/1000/x'],
      ['customers/123/languageConstants/1000'],
      [null],
      Array.from({length: 101}, (_, i) => 'languageConstants/' + (i + 1)),
    ];
    for (const languages of bad) {
      const r = await w.call({source: {campaign_id: '77', languages}});
      assertRefused(r, 'INVALID_ARGUMENT', {writes: w.notReads.length});
      assert.equal(r.error.details.field, 'source.languages', JSON.stringify(languages).slice(0, 80));
    }
    assert.deepEqual(w.queries, [], 'a bad list is refused before any read');
    assert.equal(w.plans(), 0);
    // 100 are accepted by the list (none is targeted, so the read refuses them), and null means no selection.
    assertRefused(
      await w.call({
        source: {campaign_id: '77', languages: Array.from({length: 100}, (_, i) => 'languageConstants/' + (i + 2000))},
      }),
      'CLONE_SOURCE_NOT_FOUND',
    );
    const unchanged = await w.call({atomic: false, source: {campaign_id: '77', languages: null}});
    assert.equal(unchanged.success, true, JSON.stringify(unchanged).slice(0, 800));
    assert.equal(targeting(await w.plan(unchanged.data.id)).languages.length, 2);
  } finally {
    w.store.close();
  }
});

/** What a stored non-atomic plan creates, in step order, in the words of the clone's source: the shape a caller indexes into. */
const shape = (plan: JsonObject) => {
  const ids = (plan.steps as JsonObject[]).map(s => s.id as string);
  const each = (pattern: RegExp, read: (c: JsonObject) => string) =>
    Object.fromEntries(ids.filter(id => pattern.test(id)).map(id => [id, creates(plan, id).map(read)]));
  return {
    groups: groupNames(plan),
    keywords: each(/_keywords$/, c => c.keyword.text),
    ads: each(/_ads$/, c => c.ad.responsive_search_ad.headlines[0].text),
    targeting: creates(plan, 'targeting').map(c =>
      c.language
        ? 'language ' + c.language.language_constant
        : c.location
          ? 'location ' + c.location.geo_target_constant
          : 'negative keyword ' + c.keyword.text,
    ),
  };
};
/** Ascending IDs, written out in full: the ad groups 10, 20, 30, 40; keyword 302 before 303; ad 1000 before 1001. */
const inIdOrder = {
  groups: {adgroup_1: 'Generic', adgroup_2: 'Services', adgroup_3: 'Brand', adgroup_4: 'Competitors'},
  keywords: {
    adgroup_1_keywords: ['widgets'],
    adgroup_2_keywords: ['repairs'],
    adgroup_3_keywords: ['jobs', 'acme'],
    adgroup_4_keywords: ['rival'],
  },
  ads: {adgroup_1_ads: ['Generic B one', 'Generic one'], adgroup_2_ads: ['Services one'], adgroup_3_ads: ['Brand one']},
  targeting: [
    'language languageConstants/1000',
    'language languageConstants/1019',
    'location geoTargetConstants/2682',
    'negative keyword free',
  ],
};

test('the ad groups, criteria, keywords and ads are copied in ID order whatever order the provider answers in', async () => {
  const w = world();
  try {
    // A read without ORDER BY names no order: the fake answers the second read of each resource reversed.
    for (const round of [1, 2, 3]) {
      const r = await w.call({atomic: false});
      assert.equal(r.success, true, JSON.stringify(r).slice(0, 800));
      assert.deepEqual(shape(await w.plan(r.data.id)), inIdOrder, 'clone ' + round);
    }
    // With a selection, the ad groups named are still taken in ID order, however the caller lists them.
    for (const ids of [
      [40, 20],
      ['20', '40'],
      [20, 40],
    ]) {
      const r = await w.call({atomic: false, source: {campaign_id: '77', ad_group_ids: ids}});
      assert.equal(r.success, true, JSON.stringify(r).slice(0, 800));
      const made = shape(await w.plan(r.data.id));
      assert.deepEqual(made.groups, {adgroup_1: 'Services', adgroup_2: 'Competitors'}, JSON.stringify(ids));
      assert.deepEqual(made.keywords, {adgroup_1_keywords: ['repairs'], adgroup_2_keywords: ['rival']});
    }
  } finally {
    w.store.close();
  }
});

// Round 3 (the lead's review, 2026-11-20, S3-2): each read is ordered by a field of its own resource. Google documents an attributed
// resource's fields (ad_group.id from ad_group_criterion) for SELECT and WHERE, not for ORDER BY; the clone needs only the order within an ad
// group, which a criterion ID and an ad ID fix (each is unique within its ad group), so it does not depend on the undocumented form.
test('every source read asks the provider for an order by a field of its own resource: ad groups, criteria, keywords and ads each by their own ID', async () => {
  const w = world();
  try {
    const r = await w.call({atomic: false});
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 800));
    const read = (from: string) => w.queries.find(q => q.includes(' FROM ' + from + ' WHERE'))!;
    assert.match(read('ad_group'), / ORDER BY ad_group\.id$/);
    assert.match(read('campaign_criterion'), / ORDER BY campaign_criterion\.criterion_id(,|$)/);
    assert.match(read('campaign_criterion'), / ORDER BY campaign_criterion\.criterion_id, campaign_criterion\.type$/);
    assert.match(read('ad_group_criterion'), / ORDER BY ad_group_criterion\.criterion_id$/);
    assert.match(read('ad_group_ad'), / ORDER BY ad_group_ad\.ad\.id$/);
    // The attributed ad_group.id stays selected, for the IN filter, and is not sorted by.
    for (const from of ['ad_group_criterion', 'ad_group_ad']) {
      assert.match(read(from), /^SELECT ad_group\.id, /, from);
      assert.ok(!/ ORDER BY .*\bad_group\.id\b/.test(read(from)), from + ' is not sorted by an attributed field');
    }
    assert.ok(!/ ORDER BY /.test(read('campaign')), 'the campaign read is of one row');
  } finally {
    w.store.close();
  }
});

test('a positional changes.drop and changes.set mean the same thing on every read: adgroup_1 and operation 0 are the lowest IDs', async () => {
  const w = world();
  try {
    for (const round of [1, 2, 3]) {
      const r = await w.call({
        atomic: false,
        changes: {
          drop: ['adgroup_1'],
          set: [
            {
              step_id: 'targeting',
              path: '/payload/operations/0/create/language/language_constant',
              value: 'languageConstants/1003',
            },
          ],
        },
      });
      assert.equal(r.success, true, 'clone ' + round + ': ' + JSON.stringify(r).slice(0, 800));
      assert.deepEqual(r.data.clone.dropped, ['adgroup_1', 'adgroup_1_keywords', 'adgroup_1_ads']);
      assert.deepEqual(r.data.clone.set, [
        {step_id: 'targeting', path: '/payload/operations/0/create/language/language_constant'},
      ]);
      const plan = await w.plan(r.data.id);
      // adgroup_1 was the lowest ID, the ad group Generic (10); operation 0 of the targeting is the lowest criterion, the
      // language 1000, which the change turned into 1003.
      assert.deepEqual(Object.values(groupNames(plan)), ['Services', 'Brand', 'Competitors']);
      assert.deepEqual(targeting(plan).languages, ['languageConstants/1003', 'languageConstants/1019']);
    }
  } finally {
    w.store.close();
  }
});

const adGroupMap = [
  {step_id: 'adgroup_1', source_ad_group_id: '10', name: 'Generic'},
  {step_id: 'adgroup_2', source_ad_group_id: '20', name: 'Services'},
  {step_id: 'adgroup_3', source_ad_group_id: '30', name: 'Brand'},
  {step_id: 'adgroup_4', source_ad_group_id: '40', name: 'Competitors'},
];

test('the response maps each ad group step to its source ad group, so a caller sees which step is which', async () => {
  const w = world();
  try {
    // The default clone is one all-or-nothing build; its response lists the steps it was composed of.
    const atomic = await w.call({});
    assert.equal(atomic.success, true, JSON.stringify(atomic).slice(0, 800));
    assert.deepEqual(atomic.data.clone.ad_groups, adGroupMap);
    for (const {step_id} of adGroupMap) assert.ok(atomic.data.clone.steps.includes(step_id), step_id);
    // The map is what the steps create: step by step, each step makes the ad group the map names.
    const stepwise = await w.call({atomic: false});
    assert.equal(stepwise.success, true, JSON.stringify(stepwise).slice(0, 800));
    assert.deepEqual(stepwise.data.clone.ad_groups, adGroupMap);
    const names = groupNames(await w.plan(stepwise.data.id));
    for (const {step_id, name} of stepwise.data.clone.ad_groups) assert.equal(names[step_id], name, step_id);
    // The stored plan holds it, so a later full read still says which step is which.
    assert.deepEqual((await w.plan(stepwise.data.id)).clone.ad_groups, adGroupMap);
  } finally {
    w.store.close();
  }
});

test('with source.ad_group_ids the map lists the ad groups chosen, numbered in ID order', async () => {
  const w = world();
  try {
    for (const ids of [
      [40, 20],
      ['20', '40'],
    ]) {
      const r = await w.call({source: {campaign_id: '77', ad_group_ids: ids}});
      assert.equal(r.success, true, JSON.stringify(r).slice(0, 800));
      assert.deepEqual(r.data.clone.ad_groups, [
        {step_id: 'adgroup_1', source_ad_group_id: '20', name: 'Services'},
        {step_id: 'adgroup_2', source_ad_group_id: '40', name: 'Competitors'},
      ]);
    }
  } finally {
    w.store.close();
  }
});

test('an ad group a changes.drop leaves out stays in the map, marked dropped, so the drop can be checked against the group', async () => {
  const w = world();
  try {
    const r = await w.call({atomic: false, changes: {drop: ['adgroup_2']}});
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 800));
    assert.deepEqual(r.data.clone.dropped, ['adgroup_2', 'adgroup_2_keywords', 'adgroup_2_ads']);
    assert.deepEqual(
      r.data.clone.ad_groups,
      adGroupMap.map(g => (g.step_id === 'adgroup_2' ? {...g, dropped: true} : g)),
    );
    assert.deepEqual(Object.values(groupNames(await w.plan(r.data.id))), ['Generic', 'Brand', 'Competitors']);
  } finally {
    w.store.close();
  }
});

// A keyed retry of an earlier clone returns the stored plan, map included, without reading the source again (CMP-02 b).
test('a keyed Google clone is returned again with its map and without a read; the key with another selection conflicts', async () => {
  const w = world();
  try {
    const key = {idempotency_key: 'clone-selection-0001'},
      chosen = {campaign_id: '77', ad_group_ids: [30, 20], languages: ['languageConstants/1019']};
    const first = await w.call({...key, source: chosen});
    assert.equal(first.success, true, JSON.stringify(first).slice(0, 800));
    const reads = w.queries.length;
    const again = await w.call({...key, source: chosen});
    assert.equal(again.success, true, JSON.stringify(again).slice(0, 800));
    assert.equal(again.data.id, first.data.id);
    assert.deepEqual(again.data.clone, first.data.clone);
    assert.deepEqual(again.data.clone.ad_groups, [
      {step_id: 'adgroup_1', source_ad_group_id: '20', name: 'Services'},
      {step_id: 'adgroup_2', source_ad_group_id: '30', name: 'Brand'},
    ]);
    assert.equal(w.queries.length, reads, 'a replay reads nothing');
    // The key names the request, selection included: another selection is another request.
    for (const source of [
      {campaign_id: '77', ad_group_ids: [30]},
      {campaign_id: '77', ad_group_ids: [30, 20]},
      {campaign_id: '77', ad_group_ids: [30, 20], languages: ['languageConstants/1000']},
      {campaign_id: '77'},
    ])
      assertRefused(await w.call({...key, source}), 'IDEMPOTENCY_CONFLICT');
    assert.equal(w.queries.length, reads, 'a conflicting key is refused before any read');
    assert.equal(w.plans(), 1);
  } finally {
    w.store.close();
  }
});

test('the help of clone says what source takes: which platform, what each key copies, what is refused, and how steps are numbered', async () => {
  const w = world();
  try {
    const help = (await w.service.call('amcp_campaign', {action: 'help', topic: 'clone'}, actor)) as JsonObject;
    assert.equal(help.success, true, JSON.stringify(help).slice(0, 400));
    const note: string = help.data.arguments.source.description;
    assert.match(
      note,
      /^clone: \{campaign_id\} of the campaign to copy, in the account_id named\./,
      'the old sentence stays',
    );
    assert.match(note, /Google Search only/);
    assert.match(note, /ad_group_ids \(1–1,000 numeric ad group IDs\) copies only those ad groups/);
    assert.match(note, /languages \(1–100 language constants such as languageConstants\/1000.*\) only those languages/);
    assert.match(note, /locations and negative keywords are copied as before/);
    assert.match(note, /CLONE_SOURCE_NOT_FOUND \(details\.missing\)/);
    assert.match(note, /other platforms refuse both keys with CLONE_UNSUPPORTED/);
    assert.match(note, /numbered in ID order \(adgroup_1 is the lowest ID\)/);
    assert.match(note, /clone\.ad_groups/);
    assert.match(
      note,
      /Any other key of source is ignored; for Google Search it is named in meta\.argument_warnings\.$/,
    );
    // The listed tool is not told: the argument's note is the contract's, and tools/list carries none (the golden pins it).
    assert.equal(
      help.data.arguments.changes.description.startsWith('clone: {set:'),
      true,
      'the neighbouring notes are untouched',
    );
  } finally {
    w.store.close();
  }
});

test('with source.ad_group_ids and source.languages the all-or-nothing build holds only those, and every reference resolves', async () => {
  const w = world();
  try {
    const r = await w.call({
      source: {campaign_id: '77', ad_group_ids: [30, 20], languages: ['languageConstants/1019']},
    });
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 800));
    assert.deepEqual(
      r.data.steps.map((s: JsonObject) => s.id),
      ['build'],
    );
    assert.equal(r.data.clone.all_or_nothing, true);
    assert.deepEqual(r.data.clone.steps, [
      'budget',
      'campaign',
      'targeting',
      'adgroup_1',
      'adgroup_1_keywords',
      'adgroup_1_ads',
      'adgroup_2',
      'adgroup_2_keywords',
      'adgroup_2_ads',
    ]);
    const ops = (await w.plan(r.data.id)).steps[0].arguments.payload.mutate_operations as JsonObject[];
    const of = (kind: string) => ops.filter(o => o[kind]).map(o => o[kind].create);
    assert.deepEqual(
      of('ad_group_operation').map(c => c.name),
      ['Services', 'Brand'],
    );
    assert.deepEqual(
      of('ad_group_criterion_operation').map(c => c.keyword.text),
      ['repairs', 'jobs', 'acme'],
    );
    assert.equal(of('ad_group_ad_operation').length, 2);
    // One language, the location and the negative keyword.
    assert.equal(of('campaign_criterion_operation').length, 3);
    assert.deepEqual(
      of('campaign_criterion_operation')
        .filter(c => c.language)
        .map(c => c.language.language_constant),
      ['languageConstants/1019'],
    );
    assert.ok(!JSON.stringify(ops).includes('$ref'), 'every reference became a temporary resource name');
    assert.deepEqual(w.notReads, []);
  } finally {
    w.store.close();
  }
});

test('step IDs are numbered among the ad groups chosen, so a changes.drop names one of them', async () => {
  const w = world();
  try {
    const source = {campaign_id: '77', ad_group_ids: [30, 20]};
    // Two ad groups are chosen, so adgroup_3 is not a step of this clone, and a drop that names it is refused.
    const refused = await w.call({atomic: false, source, changes: {drop: ['adgroup_3']}});
    assertRefused(refused, 'INVALID_ARGUMENT');
    assert.equal(refused.error.details.field, 'changes.drop');
    assert.ok(refused.error.details.allowed.includes('adgroup_2'));
    assert.ok(!refused.error.details.allowed.includes('adgroup_3'));
    assert.equal(w.plans(), 0, 'the refused clone saved nothing');
    // adgroup_2 is the higher of the two IDs, Brand (30): dropping it leaves Services (20).
    const dropped = await w.call({atomic: false, source, changes: {drop: ['adgroup_2']}});
    assert.equal(dropped.success, true, JSON.stringify(dropped).slice(0, 800));
    assert.deepEqual(Object.values(groupNames(await w.plan(dropped.data.id))), ['Services']);
    assert.deepEqual(dropped.data.clone.dropped, ['adgroup_2', 'adgroup_2_keywords', 'adgroup_2_ads']);
  } finally {
    w.store.close();
  }
});

// Round 2 (the lead, 2026-11-20): a key of a Google clone's source that the clone does not read is most likely a typo of a selection
// key (ad_group_id for ad_group_ids), and ignoring it copies the whole campaign without a word. It is reported, not refused.
test('an unknown key of a Google clone’s source draws one meta.argument_warnings entry per key, naming the keys the clone reads and no value, and nothing is refused', async () => {
  const w = world();
  try {
    const typo = await w.call({atomic: false, source: {campaign_id: '77', ad_group_id: 'private-value-30'}});
    // Not refused: an old call keeps working, and the key is ignored as before (every ad group is copied).
    assert.equal(typo.success, true, JSON.stringify(typo).slice(0, 800));
    assert.equal(Object.keys(groupNames(await w.plan(typo.data.id))).length, 4);
    assert.ok(Array.isArray(typo.meta.argument_warnings), 'the unknown key is reported');
    const [warning, ...more] = typo.meta.argument_warnings;
    assert.deepEqual(more, [], 'one warning for the one key');
    assert.equal(warning.code, 'ARGUMENT_NOT_USED_BY_ACTION');
    assert.equal(warning.field, 'source.ad_group_id');
    assert.deepEqual(warning.accepted, ['campaign_id', 'ad_group_ids', 'languages']);
    assert.match(warning.message, /^source\.ad_group_id is not a key this clone reads, so it is ignored\./);
    assert.match(warning.message, /source takes campaign_id, ad_group_ids, languages\.$/);
    assert.deepEqual(warning.help_call, {tool: 'amcp_campaign', arguments: {action: 'help', topic: 'clone'}});
    assert.ok(!JSON.stringify(typo.meta).includes('private-value-30'), 'no value is echoed');

    // One warning per key, in the order the keys were sent; a null value does not make a key known.
    const two = await w.call({
      source: {campaign_id: '77', note: null, languages: ['languageConstants/1019'], extra: 1},
    });
    assert.equal(two.success, true, JSON.stringify(two).slice(0, 800));
    assert.deepEqual(
      two.meta.argument_warnings.map((x: JsonObject) => x.field),
      ['source.note', 'source.extra'],
    );

    // A clean source draws none: the campaign alone, a valid selection, and a null selection.
    for (const source of [
      {campaign_id: '77'},
      {campaign_id: 77},
      {campaign_id: '77', ad_group_ids: [30, '20'], languages: ['languageConstants/1019']},
      {campaign_id: '77', ad_group_ids: null, languages: null},
    ]) {
      const clean = await w.call({source});
      assert.equal(clean.success, true, JSON.stringify(clean).slice(0, 800));
      assert.equal(clean.meta.argument_warnings, undefined, JSON.stringify(source));
    }

    // A key that is not a plain name is not repeated (it is source.<a key>: see the test of round 3 below), and at most 20 keys are named.
    const odd = await w.call({
      source: {
        campaign_id: '77',
        'two words; and more': 1,
        ['k'.repeat(100)]: 1,
        ...Object.fromEntries(Array.from({length: 25}, (_, i) => ['extra' + i, i])),
      },
    });
    assert.equal(odd.success, true, JSON.stringify(odd).slice(0, 800));
    assert.equal(odd.meta.argument_warnings.length, 20);
    assert.deepEqual(
      odd.meta.argument_warnings.slice(0, 3).map((x: JsonObject) => x.field),
      ['source.<a key>', 'source.<a key>', 'source.extra0'],
    );

    // A refused call keeps the warning: the typo is most useful to see exactly when the call failed.
    const refused = await w.call({source: {campaign_id: '77', ad_group_id: '30', ad_group_ids: ['999']}});
    assertRefused(refused, 'CLONE_SOURCE_NOT_FOUND');
    assert.deepEqual(
      refused.meta.argument_warnings.map((x: JsonObject) => x.field),
      ['source.ad_group_id'],
    );
    assert.equal(w.plans(), 7, 'only the seven clones that were not refused were saved');
    assert.deepEqual(w.notReads, []);
  } finally {
    w.store.close();
  }
});

// Round 3 (the lead's review, 2026-11-20, S4-2): the warning repeats the caller's key, which is text the caller chose, and a key can be
// a token. The codebase already masks a long hex run in an identifier it repeats; the key is named only when it is a plain name.
test('an unknown key is named in a warning only when it is a plain name with no run of 32 hex digits; any other key is source.<a key>', async () => {
  const w = world();
  try {
    const hex = '0123456789abcdef'.repeat(2) + '01234567'; // 40 hex digits, synthetic
    const named = ['ad_group_id', 'adGroupIds', 'A1_b2', 'k'.repeat(64), 'n_' + 'ab'.repeat(15) + 'a'];
    const hidden = [
      hex, // a token, which starts with a digit
      't' + hex, // a token that starts with a letter
      'T' + hex.toUpperCase(), // and in capitals
      'x' + 'a'.repeat(32), // the shortest run of hex digits that is hidden: 32
      'k'.repeat(65), // one character too long
      '1abc',
      '_abc',
      'two words; and more',
      'a-b',
      'a.b',
      'ключ',
      '',
    ];
    // (The last of the names holds a run of 31 hex digits, one short of the run that is hidden.)
    for (const key of [...named, ...hidden]) {
      // A call refused after the warning is made (the ad group is not there) saves no plan; the warning is kept.
      const r = await w.call({source: {campaign_id: '77', ad_group_ids: ['999'], [key]: 'private-value'}});
      assertRefused(r, 'CLONE_SOURCE_NOT_FOUND');
      const shown = named.includes(key) ? key : '<a key>';
      assert.deepEqual(
        r.meta.argument_warnings.map((x: JsonObject) => x.field),
        ['source.' + shown],
        JSON.stringify(key),
      );
      assert.ok(
        r.meta.argument_warnings[0].message.startsWith(
          'source.' + shown + ' is not a key this clone reads, so it is ignored.',
        ),
        JSON.stringify(key),
      );
      assert.deepEqual(r.meta.argument_warnings[0].accepted, ['campaign_id', 'ad_group_ids', 'languages']);
      const text = JSON.stringify(r.meta);
      assert.ok(!text.includes('private-value'), 'no value is echoed');
      if (!named.includes(key) && key.length > 5)
        assert.ok(!text.includes(key), 'a key that is not a plain name is not repeated');
    }
    assert.equal(w.plans(), 0);
  } finally {
    w.store.close();
  }
});

// Round 2 (the lead, 2026-11-20): where a Google copy is too large, the answer names source.ad_group_ids too, since choosing the ad groups
// is now the way to a smaller copy, and the shared remedy of every CLONE_ refusal says so for Google Search.
test('a Google clone too large for one plan or one build is advised source.ad_group_ids beside changes.drop, and the advice works', async () => {
  const w = world();
  try {
    // Step by step: 1,022 steps, where a plan holds 50.
    const steps = await w.call({atomic: false, source: {campaign_id: '55'}});
    assertRefused(steps, 'CLONE_SOURCE_TOO_LARGE');
    assert.equal(steps.error.details.field, 'changes.drop');
    assert.equal(
      steps.error.message,
      'The clone has 1022 steps; a plan holds at most 50. Leave some out with changes.drop, or copy only some ad groups with source.ad_group_ids.',
    );
    // One build: 1,022 resources, where a build holds 1,000.
    const build = await w.call({source: {campaign_id: '55'}});
    assertRefused(build, 'CLONE_SOURCE_TOO_LARGE');
    assert.equal(
      build.error.message,
      'The copy has 1022 resources; one build creates at most 1,000. Leave some out with changes.drop, copy only some ad groups with source.ad_group_ids, or clone with atomic: false.',
    );
    assert.equal(w.plans(), 0, 'nothing was saved');
    // The advice works: 100 of the ad groups are one build of 302 resources, and 10 of them one plan of 32 steps.
    const ids = manyIds(5000, 100);
    const build100 = await w.call({source: {campaign_id: '55', ad_group_ids: ids}});
    assert.equal(build100.success, true, JSON.stringify(build100).slice(0, 800));
    assert.equal(build100.data.clone.source.ad_groups, 100);
    const plan10 = await w.call({atomic: false, source: {campaign_id: '55', ad_group_ids: ids.slice(0, 10)}});
    assert.equal(plan10.success, true, JSON.stringify(plan10).slice(0, 800));
    assert.equal(plan10.data.steps.length, 32);
  } finally {
    w.store.close();
  }
});

test('a Google source that does not fit the pages AMCP reads is advised source.ad_group_ids, and a choice of ad groups fits', async () => {
  const w = world({pageRows: {ad_group: 1}});
  try {
    const r = await w.call({source: {campaign_id: '57'}});
    assertRefused(r, 'CLONE_SOURCE_TOO_LARGE');
    assert.equal(
      r.error.message,
      'The source did not fit in the pages AMCP reads; clone a smaller campaign, or copy only some ad groups with source.ad_group_ids.',
    );
    assert.equal(r.error.details.field, 'source.ad_group_ids');
    assert.equal(w.plans(), 0);
    const chosen = await w.call({source: {campaign_id: '57', ad_group_ids: [6000, 6001, 6002]}});
    assert.equal(chosen.success, true, JSON.stringify(chosen).slice(0, 800));
    assert.deepEqual(
      chosen.data.clone.ad_groups.map((g: JsonObject) => g.source_ad_group_id),
      ['6000', '6001', '6002'],
    );
  } finally {
    w.store.close();
  }
});

// Round 3 (the lead's review, 2026-11-20, S4-3): choosing ad groups makes the ad group, keyword and ad reads smaller. It does not make
// the campaign read or the campaign criteria read (targeting and campaign negatives) smaller, so those are not advised it.
test('a source read that does not fit the pages is advised source.ad_group_ids only when the choice of ad groups would shrink that read', async () => {
  const shared = 'The source did not fit in the pages AMCP reads; clone a smaller campaign.',
    advised =
      'The source did not fit in the pages AMCP reads; clone a smaller campaign, or copy only some ad groups with source.ad_group_ids.';
  for (const [table, shrinks] of [
    ['campaign', false],
    ['campaign_criterion', false],
    ['ad_group', true],
    ['ad_group_criterion', true],
    ['ad_group_ad', true],
  ] as const) {
    const w = world({endless: [table]});
    try {
      const r = await w.call({source: {campaign_id: '77'}});
      assertRefused(r, 'CLONE_SOURCE_TOO_LARGE');
      assert.equal(r.error.message, shrinks ? advised : shared, table);
      assert.equal(r.error.details?.field, shrinks ? 'source.ad_group_ids' : undefined, table);
      assert.equal(w.plans(), 0, table);
    } finally {
      w.store.close();
    }
  }
});

test('the remedy of a CLONE_ refusal names source.ad_group_ids and source.languages for Google Search, and keeps the rest', async () => {
  const w = world();
  try {
    for (const r of [
      await w.call({source: {campaign_id: '77', ad_group_ids: ['999']}}),
      await w.call({source: {campaign_id: '999'}}),
    ]) {
      assertRefused(r, 'CLONE_SOURCE_NOT_FOUND');
      const action: string = r.error.remedy.action;
      assert.match(
        action,
        /^Nothing was created\. Check the source campaign ID and account; clone a Snapchat, Google Search, TikTok or LinkedIn campaign/,
      );
      assert.match(
        action,
        /or leave steps out with changes\.drop\. For a Google Search campaign, source\.ad_group_ids and source\.languages choose which ad groups and languages to copy\. Other campaigns are built with create and explicit steps\.$/,
      );
      assert.equal(r.next_action ?? r.error.next_action, action);
    }
  } finally {
    w.store.close();
  }
});

// Round 3 (the lead's review, 2026-11-20, S2-1 and S4-7): the identity of a keyed clone names its selection in a normal form.
/**
 * The identity a keyed Google clone had before its selection joined it (src/campaign-runner.ts at e008273d): the source as sent and
 * nothing else of the selection. A run made then ignored ad_group_ids and languages, as production did, so what it stored is a
 * whole-campaign plan under that identity.
 */
const identityBefore = (source: JsonObject) =>
  fingerprint({
    clone: {
      gateway: google,
      connection_id: 'g',
      account_id: '123',
      source,
      changes: null,
      atomic: null,
      name: 'Search EN copy',
      brief: null,
    },
  });
/** Rewrites the identity a stored keyed run carries to the one it had before this release. */
function storedBefore(w: ReturnType<typeof world>, id: string, source: JsonObject) {
  const {id: _id, revision: _revision, ...data} = w.store.document(actor.tenantId, 'campaign_run', id);
  w.store.putDocument(actor.tenantId, 'campaign_run', id, {...data, creation_origin: identityBefore(source)});
}

test('a keyed clone made before the selection joined its identity is not replayed as if it matched: the same key and source conflict, with no read', async () => {
  const w = world();
  try {
    const key = {idempotency_key: 'clone-selection-0002'},
      source = {campaign_id: '77', ad_group_ids: ['30', '20']};
    const first = await w.call({...key, source});
    assert.equal(first.success, true, JSON.stringify(first).slice(0, 800));
    // Production ignored the selection: its run copied every ad group and was keyed by the source as sent.
    storedBefore(w, first.data.id, source);
    const reads = w.queries.length;
    assertRefused(await w.call({...key, source}), 'IDEMPOTENCY_CONFLICT');
    assert.equal(w.queries.length, reads, 'refused before any read');
    assert.equal(w.plans(), 1, 'no second plan, and the old one is not returned');
    assert.deepEqual(w.notReads, []);
  } finally {
    w.store.close();
  }
});

test('a keyed clone without a selection keeps the identity it had before: an old run still replays', async () => {
  const w = world();
  try {
    let n = 0;
    for (const source of [
      {campaign_id: '77'},
      {campaign_id: '77', ad_group_ids: null, languages: null},
      {campaign_id: '77', note: 'kept as before'},
    ]) {
      const key = {idempotency_key: 'clone-selection-plain-' + ++n};
      const first = await w.call({...key, source});
      assert.equal(first.success, true, JSON.stringify(first).slice(0, 800));
      storedBefore(w, first.data.id, source);
      const reads = w.queries.length;
      const again = await w.call({...key, source});
      assert.equal(again.success, true, JSON.stringify(again).slice(0, 800));
      assert.equal(again.data.id, first.data.id);
      assert.equal(w.queries.length, reads, 'a replay reads nothing');
    }
  } finally {
    w.store.close();
  }
});

test('a selection is one request however it is spelled, and the plan names it in its normal form', async () => {
  const w = world();
  try {
    const key = {idempotency_key: 'clone-selection-0004'},
      first = await w.call({
        ...key,
        source: {
          campaign_id: '77',
          ad_group_ids: [30, 20],
          languages: ['languageConstants/1019', 'languageConstants/1000'],
        },
      });
    assert.equal(first.success, true, JSON.stringify(first).slice(0, 800));
    assert.deepEqual(first.data.clone.selection, {
      ad_group_ids: ['20', '30'],
      languages: ['languageConstants/1000', 'languageConstants/1019'],
    });
    assert.deepEqual((await w.plan(first.data.id)).clone.selection, first.data.clone.selection, 'stored with the plan');
    const reads = w.queries.length;
    // The order of the IDs, a number or its text, a repeated ID, the order of the languages and the order of the keys do not matter.
    for (const source of [
      {campaign_id: '77', ad_group_ids: ['20', '30'], languages: ['languageConstants/1000', 'languageConstants/1019']},
      {campaign_id: '77', ad_group_ids: ['30', '20'], languages: ['languageConstants/1019', 'languageConstants/1000']},
      {campaign_id: '77', ad_group_ids: [20, 30, 20], languages: ['languageConstants/1000', 'languageConstants/1019']},
      {languages: ['languageConstants/1000', 'languageConstants/1019'], ad_group_ids: [30, '20'], campaign_id: '77'},
    ]) {
      const again = await w.call({...key, source});
      assert.equal(again.success, true, JSON.stringify(source) + JSON.stringify(again).slice(0, 500));
      assert.equal(again.data.id, first.data.id);
      assert.deepEqual(again.data.clone.selection, first.data.clone.selection);
    }
    assert.equal(w.queries.length, reads, 'every replay reads nothing');
    // Another selection is another request, as before.
    for (const source of [
      {campaign_id: '77', ad_group_ids: [30], languages: ['languageConstants/1000', 'languageConstants/1019']},
      {campaign_id: '77', ad_group_ids: [30, 20, 10], languages: ['languageConstants/1000', 'languageConstants/1019']},
      {campaign_id: '77', ad_group_ids: [30, 20], languages: ['languageConstants/1000']},
      {campaign_id: '77', ad_group_ids: [30, 20]},
      {campaign_id: '77'},
    ])
      assertRefused(await w.call({...key, source}), 'IDEMPOTENCY_CONFLICT');
    assert.equal(w.queries.length, reads, 'and is refused before any read');
    assert.equal(w.plans(), 1);
  } finally {
    w.store.close();
  }
});

// Round 3 (the lead's review, 2026-11-20, S4-1): what is copied, and which ad group is adgroup_1, do not rest on the provider
// applying the IN filter and the ORDER BY it was asked for (the fake accepts both and applies neither).
test('a provider that ignores the IN filter cannot add ad groups, keywords or ads to a selection', async () => {
  const w = world({ignoreIn: true});
  try {
    const r = await w.call({atomic: false, source: {campaign_id: '77', ad_group_ids: [30, 20]}});
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 800));
    assert.ok(
      w.queries.some(q => idList(q)?.join() === '20,30'),
      'the queries still name the IDs; the fake does not apply them',
    );
    const made = shape(await w.plan(r.data.id));
    // Only the two ad groups named, in ID order: the two others the provider sent are dropped, with their keywords and ads.
    assert.deepEqual(made.groups, {adgroup_1: 'Services', adgroup_2: 'Brand'});
    assert.deepEqual(made.keywords, {adgroup_1_keywords: ['repairs'], adgroup_2_keywords: ['jobs', 'acme']});
    assert.deepEqual(made.ads, {adgroup_1_ads: ['Services one'], adgroup_2_ads: ['Brand one']});
    assert.deepEqual(r.data.clone.source, {campaign_id: '77', ad_groups: 2, keywords: 3, ads: 2});
    assert.deepEqual(r.data.clone.ad_groups, [
      {step_id: 'adgroup_1', source_ad_group_id: '20', name: 'Services'},
      {step_id: 'adgroup_2', source_ad_group_id: '30', name: 'Brand'},
    ]);
    // An ID the campaign does not have is still missing, whatever else the provider sent.
    const missing = await w.call({source: {campaign_id: '77', ad_group_ids: ['30', '999']}});
    assertRefused(missing, 'CLONE_SOURCE_NOT_FOUND');
    assert.deepEqual(missing.error.details.missing, ['999']);
  } finally {
    w.store.close();
  }
});

test('a provider that ignores ORDER BY cannot change which ad group is adgroup_1: the ad groups are numbered by ID in memory, as numbers', async () => {
  for (const ignoreOrderBy of [false, true]) {
    const w = world({ignoreOrderBy});
    const label = ignoreOrderBy ? 'a provider that ignores ORDER BY' : 'a provider that applies it';
    try {
      const whole = await w.call({atomic: false});
      assert.equal(whole.success, true, label + ': ' + JSON.stringify(whole).slice(0, 800));
      assert.deepEqual(
        groupNames(await w.plan(whole.data.id)),
        {adgroup_1: 'Generic', adgroup_2: 'Services', adgroup_3: 'Brand', adgroup_4: 'Competitors'},
        label,
      );
      assert.deepEqual(whole.data.clone.ad_groups, adGroupMap, label);
      // With a selection: the ad groups named, lowest ID first, whatever order they were listed or answered in.
      const chosen = await w.call({atomic: false, source: {campaign_id: '77', ad_group_ids: ['40', '10', '30']}});
      assert.equal(chosen.success, true, label + ': ' + JSON.stringify(chosen).slice(0, 800));
      assert.deepEqual(
        groupNames(await w.plan(chosen.data.id)),
        {adgroup_1: 'Generic', adgroup_2: 'Brand', adgroup_3: 'Competitors'},
        label,
      );
      assert.deepEqual(
        chosen.data.clone.ad_groups.map((g: JsonObject) => g.source_ad_group_id),
        ['10', '30', '40'],
        label,
      );
      // IDs of different lengths are ordered as numbers (7, 12, 110), not as text (110, 12, 7).
      const digits = await w.call({atomic: false, source: {campaign_id: '58'}});
      assert.equal(digits.success, true, label + ': ' + JSON.stringify(digits).slice(0, 800));
      assert.deepEqual(
        groupNames(await w.plan(digits.data.id)),
        {adgroup_1: 'Seven', adgroup_2: 'Twelve', adgroup_3: 'Hundred ten'},
        label,
      );
      assert.deepEqual(
        digits.data.clone.ad_groups.map((g: JsonObject) => g.source_ad_group_id),
        ['7', '12', '110'],
        label,
      );
    } finally {
      w.store.close();
    }
  }
});

// Round 3 (the lead's review, 2026-11-20, S4-4): the agent-facing references of the campaign builder say how to copy part of a Google Search
// campaign where they describe a clone, not only how to drop a step by its position.
test('the Skill references name source.ad_group_ids, source.languages and clone.ad_groups where they describe a clone', () => {
  for (const [file, opening] of [
    ['Skills/amcp-campaign-builder/references/google-ads.md', 'To rebuild a Search campaign, `amcp_campaign clone`'],
    ['Skills/amcp-campaign-builder/references/workspace.md', '8. To rebuild an existing campaign, `clone` it'],
  ] as const) {
    const paragraph = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .find(line => line.includes(opening));
    assert.ok(paragraph, file + ' describes a clone');
    for (const word of ['source.ad_group_ids', 'source.languages', 'clone.ad_groups', 'CLONE_SOURCE_NOT_FOUND'])
      assert.ok(paragraph.includes(word), file + ' says ' + word + ' where it describes a clone');
  }
});

// Round 3 (the lead's review, 2026-11-20, S4-9): composeGoogleBuild is the builder of the Google Search recipe as well as of the clone, and
// choosing ad groups with source.ad_group_ids is advice for a clone only. The caller that has such advice passes it in its own words.
test('the build-size refusal names what a caller can do besides dropping steps only when the caller passes it', () => {
  const step = {
    id: 'keywords',
    kind: 'write',
    gateway: google,
    connection_id: 'g',
    account_id: '123',
    arguments: {
      action: 'google_ads_v23_ad_group_criterion_mutate_ad_group_criteria',
      payload: {
        operations: Array.from({length: 1001}, (_, i) => ({create: {keyword: {text: 'k' + i, match_type: 'EXACT'}}})),
      },
    },
    depends_on: [],
  };
  const refused = (...extra: [string?]) => {
    try {
      composeGoogleBuild([structuredClone(step)], '123', ...extra);
    } catch (error) {
      assert.ok(error instanceof MirrorError);
      assert.equal(error.code, 'CLONE_SOURCE_TOO_LARGE');
      assert.deepEqual(error.details, {field: 'changes.drop'});
      return error.message;
    }
    assert.fail('1,001 resources are more than one build creates');
  };
  // The recipe's call passes none: the sentence it always had.
  assert.equal(
    refused(),
    'The copy has 1001 resources; one build creates at most 1,000. Leave some out with changes.drop, or clone with atomic: false.',
  );
  // The clone's adapter passes its own words (googleCloneShrinkAdvice), so the sentence is the one of round 2.
  assert.equal(
    refused('copy only some ad groups with source.ad_group_ids'),
    'The copy has 1001 resources; one build creates at most 1,000. Leave some out with changes.drop, copy only some ad groups with source.ad_group_ids, or clone with atomic: false.',
  );
  // 1,000 resources are one build.
  const exactly = structuredClone(step);
  exactly.arguments.payload.operations.pop();
  assert.equal((composeGoogleBuild([exactly], '123').arguments as JsonObject).payload.mutate_operations.length, 1000);
});

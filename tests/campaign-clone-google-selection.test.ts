import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import type {Actor, JsonObject} from '../src/types.js';
import {assertRefused} from './helpers/assert-refused.js';

/**
 * Cloning part of a Google Search campaign (field fix r25-field-gclone, 2026-11-19; the owner's issue 1 of that day: a
 * clone copied the whole campaign when only some ad groups, or one language, were wanted).
 *
 * The source reads are answered by a fake that evaluates the GAQL the clone sends, as Google does: it filters by the
 * WHERE clause, answers only the fields that were selected, refuses a field the resource does not have, an ORDER BY on a
 * field that cannot be sorted or was not selected, and returns the rows of a query without ORDER BY in an order that
 * changes from one read to the next (Google gives no order to such a query). The field capabilities (selectable,
 * filterable, sortable) are those of Google's v23 field reference on developers.google.com. Nothing here calls a provider.
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
 * and a language that must never be reachable through campaign 77. Campaign 66 targets no language.
 */
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
  ],
  ad_group_ad: [
    responsiveAd('77', '30', '3001', 'Brand'),
    responsiveAd('77', '10', '1001', 'Generic'),
    responsiveAd('88', '60', '6001', 'Elsewhere'),
    responsiveAd('77', '20', '2001', 'Services'),
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

function world() {
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
  function answer(query: string): Response {
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
        filters.push(row => wanted.includes(String(row[listed[1]!])));
      } else return refusal('The fake does not evaluate, or the resource does not offer: ' + condition);
    }
    const order = orderBy ? orderBy.split(', ') : [];
    for (const field of order)
      if (!sortable.has(field) || !selected.includes(field))
        return refusal('A field of the ORDER BY clause is not sortable or not selected: ' + field);
    let found = stored.filter(row => filters.every(f => f(row)));
    if (order.length)
      found = found.sort((a, b) => {
        for (const field of order) {
          const x = sortKey(a, field),
            y = sortKey(b, field);
          if (x !== y) return x < y ? -1 : 1;
        }
        return 0;
      });
    else {
      // Google gives a query without ORDER BY no order: every second read of a resource comes back reversed.
      const n = (reads.get(table) ?? 0) + 1;
      reads.set(table, n);
      if (n % 2 === 0) found = found.reverse();
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
          const query = String(JSON.parse(String(init?.body ?? '{}')).query);
          queries.push(query);
          return answer(query);
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
        ads: 3,
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
      assert.deepEqual(r.data.clone.source, {campaign_id: '77', ad_groups: 4, keywords: 5, ads: 3});
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

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  normalizeReviewState,
  reviewStateHash,
  changedStateFields,
  normalizeSnapshot,
  reviewVolatile,
} from '../dist/src/review-state.js';
import {registeredProviderHooks} from '../dist/src/provider-hooks.js';

/**
 * R2.5 M1 (package r25-m1-hash, plan idea 1, L5-02): the names that change by themselves are one table per provider, in
 * its hooks (`review.volatile`), not one set every provider shares. A name is exact (snake_case; camelCase spells the
 * same) or a prefix ending in `*`. The table only drops, and drops again nothing, so a saved review projects again to
 * what it was. An unknown field stays protected: a table never excuses a name it does not list. Synthetic values only.
 */
const norm = (value, table) => normalizeReviewState(value, table);
const hash = (value, table) => reviewStateHash(value, table);

test('a table names what changes by itself; every other field is hashed', () => {
  assert.notEqual(hash({a: 1, stats: {x: 1}}, []), hash({a: 1}, []));
  assert.equal(hash({a: 1, stats: {x: 1}}, ['stats']), hash({a: 1}, ['stats']));
  assert.deepEqual(norm({a: 1, stats: 2, status: 'PAUSED'}, ['stats']), {a: 1, status: 'PAUSED'});
  // A name the table does not list is configuration, whatever it looks like.
  for (const name of ['deleted', 'status', 'budget', 'auto_bid', 'statistics_enabled', 'my_stats'])
    assert.notEqual(hash({a: 1, [name]: 1}, ['stats']), hash({a: 1}, ['stats']), name);
  // No table at all is no exclusion.
  assert.deepEqual(norm({updated_at: 'x', request_id: 'y'}, []), {request_id: 'y', updated_at: 'x'});
  assert.deepEqual(norm({updated_at: 'x'}, undefined), {updated_at: 'x'});
});

test('camelCase spells a name as snake_case does, at every depth and inside arrays', () => {
  const table = ['updated_time', 'last_modified'];
  assert.deepEqual(norm({updatedTime: 1, changeAuditStamps: {lastModified: {time: 2}, created: 3}}, table), {
    changeAuditStamps: {created: 3},
  });
  assert.deepEqual(norm({rows: [{id: 1, updated_time: 'a', nested: [{last_modified: 'b', k: 1}]}]}, table), {
    rows: [{id: 1, nested: [{k: 1}]}],
  });
});

test('a prefix entry ends in *: it names a family of fields, and nothing else', () => {
  const table = ['review_status*', 'x-nothing'];
  assert.deepEqual(
    norm(
      {review_status: 1, review_status_reason: 2, reviewStatusDetail: 3, preview_status: 4, status: 5, review: 6},
      table,
    ),
    {preview_status: 4, review: 6, status: 5},
  );
});

test('the table is applied once and its result is stable: idempotent and monotone (property)', () => {
  let seed = 20261116;
  const r = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0), seed / 4294967296);
  const names = [
    'stats',
    'updated_at',
    'updatedAt',
    'review_status',
    'reviewStatusNote',
    'id',
    'name',
    'status',
    'budget',
    'deleted',
  ];
  const tables = [[], ['stats'], ['updated_at', 'review_status*'], ['stats', 'updated_at', 'review_status*', 'id']];
  const random = depth => {
    const roll = r();
    if (depth > 3 || roll < 0.3)
      return ['text', 7, true, null, 'https://h.example/p?ticket=1&a=2'][Math.floor(r() * 5)];
    if (roll < 0.55) return Array.from({length: Math.floor(r() * 4)}, () => random(depth + 1));
    return Object.fromEntries(
      Array.from({length: Math.floor(r() * 5)}, () => [names[Math.floor(r() * names.length)], random(depth + 1)]),
    );
  };
  // `out` keeps a subset of the keys of `input`, at every depth, and nothing is added (monotone).
  const reduction = (out, input) =>
    Array.isArray(input)
      ? Array.isArray(out) && out.length === input.length
      : input && typeof input === 'object'
        ? out && typeof out === 'object' && !Array.isArray(out) && Object.keys(out).every(k => Object.hasOwn(input, k))
        : true;
  for (let i = 0; i < 400; i++) {
    const state = random(0),
      table = tables[i % tables.length],
      once = norm(state, table);
    assert.deepEqual(norm(once, table), once, JSON.stringify({state, table}));
    assert.ok(reduction(once, state), JSON.stringify({state, once}));
    assert.equal(hash(once, table), hash(state, table));
  }
});

test('changedStateFields agrees with the hash for the same table', () => {
  const a = {row: {name: 'A', stats: 1, updated_at: 'x'}},
    b = {row: {name: 'B', stats: 2, updated_at: 'y'}};
  assert.deepEqual(changedStateFields(a, b, ['stats', 'updated_at']), ['$["row"]["name"]']);
  assert.deepEqual(changedStateFields(a, b, []), ['$["row"]["name"]', '$["row"]["stats"]', '$["row"]["updated_at"]']);
  assert.deepEqual(changedStateFields(a, {row: {name: 'A', stats: 5, updated_at: 'z'}}, ['stats', 'updated_at']), []);
});

// --- Each provider's table, in its hooks ------------------------------------------------------------------------------

const read = (gateway, path) => ({
  gateway,
  action: 'native',
  method: 'GET',
  path,
  query: {},
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  accountId: '123',
  evidence: 'TEST',
  warnings: [],
});
const tables = Object.fromEntries(registeredProviderHooks.map(h => [h.gateway, h.review?.volatile]));
const sorted = list => [...(list ?? [])].sort();
// A table also declares where its provider signs links (`signed-host:` and `signed-field:` entries); the rest are field names.
const fieldNames = list => (list ?? []).filter(name => !name.startsWith('signed-'));

// What the whole repository shared before this package (src/review-state-core.ts, by key name, every provider, every
// depth): the response metadata and telemetry names a flat resource carries beside its configuration.
const FORMER = [
  'delivery_status',
  'effective_status',
  'secondary_status',
  'updated_at',
  'updated_time',
  'last_modified_time',
  'last_modified_at',
  'last_modified',
  'update_time',
  'modification_time',
  'modify_time',
  'modified_at',
  'modified_time',
  'last_updated_at',
  'last_update_time',
  'request_id',
  'request_time',
  'trace_id',
  'sub_request_status',
  'request_status',
  'stats',
  'statistics',
  'metrics',
  'insights',
  'reporting',
  'pacing_stats',
  'pacing_metrics',
  'total_stats',
  'timeseries_stats',
  'delivery_metrics',
  'delivery_stats',
  'delivery_pacing',
  'spend_to_date',
  'last_synced_at',
  'last_fired_at',
];
// A name a table holds that the former set did not, with the reason it changes by itself (never a configuration field).
const ADDED = {
  // L4-13: X states these per read, and its batch family already left them out (src/x-entity-batches.ts).
  x_ads_native_action: {servable: 'X computes it per read', reasons_not_servable: 'X computes it per read'},
  // L4-26: LinkedIn's derived serving state and its ad review.
  linkedin_native_action: {
    serving_statuses: 'derived serving state of a campaign',
    is_serving: 'derived serving state of a creative',
    serving_hold_reasons: 'why a creative is not serving',
    review: 'the ad review of a creative, which completes by itself',
  },
  // L3-14: Meta's meters, counters and delivery diagnostics.
  meta_native_action: {
    amount_spent: 'meter',
    balance: 'meter',
    spend: 'meter',
    delivery_info: 'delivery diagnostic',
    learning_stage_info: 'delivery diagnostic',
    issues_info: 'delivery diagnostic',
    ad_review_feedback: 'ad review',
    'approximate_count_*': 'audience size, changes as people join',
    product_count: 'catalog size, changes as feeds run',
  },
  // The telemetry half of the regex of src/snapchat-nested-updates.ts: Snapchat's ad review and reach estimate.
  snapchat_native_action: {
    'review_status*': 'ad review',
    'rejection*': 'ad review',
    'approval*': 'ad review',
    targeting_reach_status: 'reach estimate',
    packaging_status: 'a creative’s media packaging completes after upload (src/snapchat-write-impact.ts)',
  },
  // The crawl observations of src/google-search-console-adapter.ts: a sitemap is downloaded and counted by Google.
  google_search_console_native_action: {
    last_downloaded: 'crawl',
    is_pending: 'crawl',
    warnings: 'crawl count',
    errors: 'crawl count',
    contents: 'crawl count',
  },
};

test('each provider with reviewed writes declares a frozen table of names that change by itself', () => {
  for (const gateway of [
    'tiktok_native_action',
    'meta_native_action',
    'snapchat_native_action',
    'x_ads_native_action',
    'linkedin_native_action',
    'dv360_native_action',
    'google_ads_native_action',
    'google_business_native_action',
    'reddit_native_action',
    'microsoft_ads_native_action',
    'apple_ads_native_action',
    'ga4_native_action',
    'gtm_native_action',
    'google_search_console_native_action',
    'criteo_native_action',
  ]) {
    const table = tables[gateway];
    assert.ok(Array.isArray(table) && table.length > 0, gateway + ' declares review.volatile');
    assert.ok(Object.isFrozen(table), gateway + ' frozen');
    assert.equal(new Set(table).size, table.length, gateway + ' lists no name twice');
    // A field name, or a link the provider signs itself: a host (exact, or every host below a domain) or a field.
    for (const name of table)
      assert.match(
        name,
        /^(?:[a-z0-9_]+\*?|signed-host:(?:\*\.)?[a-z0-9][a-z0-9.-]*\.[a-z]+|signed-field:[a-z0-9_]+)$/,
        gateway + ': ' + name,
      );
  }
});

test('no table adds a name the former set did not hold unless it is justified as changing by itself', () => {
  for (const [gateway, table] of Object.entries(tables)) {
    if (!table) continue;
    const added = fieldNames(table).filter(name => !FORMER.includes(name)),
      justified = Object.keys(ADDED[gateway] ?? {});
    assert.deepEqual(sorted(added), sorted(justified), gateway);
  }
});

// The links a provider signs itself, declared in its table (lead review S2-2): the hosts of its own asset, preview and licence
// links, and the fields it fills with a link it generated. A provider that is not listed declares none, so every URL of its
// rows is configuration and stays whole: this package knows of no signed link in any other provider's reviewed state.
const LINKS = {
  tiktok_native_action: {
    hosts: [
      'ads.tiktok.com',
      '*.tiktokcdn.com',
      '*.tiktokcdn-us.com',
      '*.ibyteimg.com',
      '*.byteimg.com',
      '*.tiktokv.com',
    ],
    fields: ['license_url', 'profile_image_url'],
  },
};
test('a provider declares the links it signs itself in its table, and no other provider does', () => {
  for (const [gateway, table] of Object.entries(tables)) {
    const links = (prefix, list) => (list ?? []).filter(e => e.startsWith(prefix)).map(e => e.slice(prefix.length));
    assert.deepEqual(sorted(links('signed-host:', table)), sorted(LINKS[gateway]?.hosts), gateway + ' hosts');
    assert.deepEqual(sorted(links('signed-field:', table)), sorted(LINKS[gateway]?.fields), gateway + ' fields');
  }
});

test('the names of the plan are in the tables of their providers', () => {
  const has = (gateway, ...names) => names.every(n => tables[gateway]?.includes(n));
  // L4-13 and L4-26.
  assert.ok(has('x_ads_native_action', 'servable', 'reasons_not_servable', 'effective_status', 'updated_at'));
  assert.ok(
    has('linkedin_native_action', 'serving_statuses', 'review', 'is_serving', 'serving_hold_reasons', 'last_modified'),
  );
  // L3-14.
  assert.ok(
    has(
      'meta_native_action',
      'amount_spent',
      'balance',
      'spend',
      'insights',
      'delivery_info',
      'learning_stage_info',
      'issues_info',
      'ad_review_feedback',
      'approximate_count_*',
      'product_count',
      'effective_status',
      'updated_time',
    ),
  );
  // What changes by itself in a TikTok row, a DV360 or GA4 resource and Reddit's pixel.
  assert.ok(has('tiktok_native_action', 'secondary_status', 'modify_time', 'request_id'));
  assert.ok(has('dv360_native_action', 'update_time'));
  assert.ok(has('reddit_native_action', 'modified_at', 'last_fired_at'));
});

test('a name that changes by itself in one provider is configuration in another: the tables are not shared', () => {
  // X's `servable` is X's: it is no part of TikTok's, Snapchat's or Google's rows.
  for (const gateway of [
    'tiktok_native_action',
    'snapchat_native_action',
    'google_ads_native_action',
    'microsoft_ads_native_action',
  ])
    assert.equal(tables[gateway]?.includes('servable'), false, gateway);
  assert.equal(hash({id: 1, servable: true}, tables.tiktok_native_action), hash({id: 1, servable: true}, []));
  assert.notEqual(
    hash({id: 1, servable: true}, tables.tiktok_native_action),
    hash({id: 1}, tables.tiktok_native_action),
  );
  assert.equal(hash({id: 1, servable: true}, tables.x_ads_native_action), hash({id: 1}, tables.x_ads_native_action));
  // The container providers keep only the names their rows carry: TikTok's `updated_at` is not telemetry there.
  assert.notEqual(
    hash({id: 1, updated_at: 'a'}, tables.tiktok_native_action),
    hash({id: 1, updated_at: 'b'}, tables.tiktok_native_action),
  );
  assert.equal(
    hash({id: 1, updated_at: 'a'}, tables.x_ads_native_action),
    hash({id: 1, updated_at: 'b'}, tables.x_ads_native_action),
  );
});

test('Snapchat leaves out the fields that are configuration though a PUT does not return them as such', () => {
  // `deleted`, `auto_bid`, `target_bid` and `separated_types` are not telemetry: a change of one between review and
  // execute changes what the write means. They are not in the table (src/snapchat-nested-updates.ts keeps them as the
  // fields a complete PUT need not carry, which is another question).
  for (const name of ['deleted', 'auto_bid', 'target_bid', 'separated_types', 'created_at'])
    assert.equal(tables.snapchat_native_action.includes(name), false, name);
});

test('normalizeSnapshot applies the table of the read’s gateway', () => {
  const snap = (gateway, path, body) => normalizeSnapshot(read(gateway, path), body);
  // Snapchat: a campaign's delivery and review telemetry, and its ad review, are not a change.
  const campaign = (extra = {}) => ({
    request_status: 'SUCCESS',
    campaigns: [{sub_request_status: 'SUCCESS', campaign: {id: '1', status: 'PAUSED', name: 'A', ...extra}}],
  });
  assert.deepEqual(
    snap(
      'snapchat_native_action',
      '/v1/campaigns/1',
      campaign({delivery_status: ['X'], review_status: 'PENDING', review_status_reason: 'r', updated_at: 'now'}),
    ),
    snap('snapchat_native_action', '/v1/campaigns/1', campaign()),
  );
  assert.notDeepEqual(
    snap('snapchat_native_action', '/v1/campaigns/1', campaign({deleted: true})),
    snap('snapchat_native_action', '/v1/campaigns/1', campaign()),
  );
  // X: the data record without its servable state.
  assert.deepEqual(
    snap('x_ads_native_action', '/12/accounts/a/line_items/1', {
      data: {id: '1', servable: false, reasons_not_servable: ['EXPIRED'], entity_status: 'PAUSED'},
    }),
    {data: {entity_status: 'PAUSED', id: '1'}},
  );
  // LinkedIn: serving telemetry and the review of a creative out, its intended status in.
  assert.deepEqual(
    snap('linkedin_native_action', '/rest/adAccounts/1/creatives/2', {
      id: 2,
      intendedStatus: 'PAUSED',
      isServing: false,
      servingHoldReasons: ['CAMPAIGN_NOT_ACTIVE'],
      review: {status: 'PENDING'},
      changeAuditStamps: {lastModified: {time: 5}, created: {time: 1}},
    }),
    {changeAuditStamps: {created: {time: 1}}, id: 2, intendedStatus: 'PAUSED'},
  );
});

// --- The global set and the scattered lists are gone -------------------------------------------------------------------

const source = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');

test('the shared projection holds no list of names, and no module keeps a regex or set of its own', () => {
  // src/review-state-core.ts is provider-neutral and names nothing that changes by itself.
  const core = source('src/review-state-core.ts');
  for (const name of ['delivery_status', 'effective_status', 'secondary_status', 'pacing_stats', 'last_fired_at'])
    assert.equal(core.includes("'" + name + "'"), false, name);
  assert.doesNotMatch(core, /const volatile\b/);
  // X's batch family used its own set of the same kind: it now reads X's table.
  assert.doesNotMatch(source('src/x-entity-batches.ts'), /const volatile = new Set/);
  // Snapchat's nested updates held the telemetry half of their metadata regex: it is Snapchat's table now.
  assert.doesNotMatch(source('src/snapchat-nested-updates.ts'), /review_status\(\?:/);
  // Search Console's sitemap observations are Search Console's table now.
  assert.doesNotMatch(source('src/google-search-console-adapter.ts'), /sitemapProcessing/);
});

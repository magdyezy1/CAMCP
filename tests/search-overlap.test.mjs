// PRV-07 D: organic/paid search overlap. Synthetic Search Console query rows and Google Ads search terms produce a
// deterministic, approximate overlap table; both sources stay inside their selected property and customer.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {normalizeSearchQuery, searchOverlapTable} from '../dist/src/search-overlap.js';

const actor = {tenantId: 'search-overlap', userId: 'reader', role: 'reader'},
  owner = {...actor, userId: 'owner', role: 'admin'},
  site = 'sc-domain:example.com';
const isoDay = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const organic = [
  {keys: ['Running Shoes'], clicks: 40, impressions: 400, ctr: 0.1, position: 2},
  {keys: ['running  shoes '], clicks: 10, impressions: 100, ctr: 0.1, position: 7},
  {keys: ['trail guide'], clicks: 25, impressions: 500, ctr: 0.05, position: 4.5},
  {keys: ['ﬁt socks'], clicks: 1, impressions: 10, ctr: 0.1, position: 12},
];
const term = (text, impressions, clicks, cost, conversions) => ({
  searchTermView: {resourceName: 'customers/123/searchTermViews/1~2~' + encodeURIComponent(text), searchTerm: text},
  metrics: {impressions, clicks, costMicros: cost, conversions},
});
const paid = [
  term('running shoes', '900', '90', '45000000', 3),
  term('RUNNING SHOES', '100', '10', '5000000', 0),
  term('buy trail shoes', '300', '30', '9000000007', 2.5),
  term('fit socks', '50', '5', '0', 0),
];
function fixture(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 73).toString('base64'));
  t.after(() => store.close());
  const connection = (id, gateway, accounts, scopes) =>
    store.putConnection(
      owner,
      {id, tenantId: actor.tenantId, gateway, accounts, enabled: true, label: 'Synthetic ' + id, scopes},
      {accessToken: 'synthetic'},
    );
  connection('g', 'google_ads_native_action', ['123'], ['https://www.googleapis.com/auth/adwords']);
  connection(
    'gsc',
    'google_search_console_native_action',
    [site],
    ['https://www.googleapis.com/auth/webmasters.readonly'],
  );
  connection(
    'gsc-other',
    'google_search_console_native_action',
    ['sc-domain:other.example'],
    ['https://www.googleapis.com/auth/webmasters.readonly'],
  );
  const requests = [];
  let organicRows = organic,
    paidRows = paid;
  const transport = new NativeTransport(
    async (url, init) => {
      const parsed = new URL(String(url)),
        body = JSON.parse(String(init.body));
      requests.push({host: parsed.hostname, path: decodeURIComponent(parsed.pathname), body, method: init.method});
      if (parsed.pathname.endsWith('/searchAnalytics/query')) return Response.json({rows: organicRows});
      if (parsed.pathname === '/v25/customers/123/googleAds:search') return Response.json({results: paidRows});
      throw Error('Unexpected request ' + parsed.pathname);
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    100,
  );
  const service = new MirrorService(new Registry(), store, transport);
  const input = {
    action: 'search_overlap',
    gateway: 'google_ads_native_action',
    account_id: '123',
    connection_id: 'g',
    requirements: {site_url: site, gsc_connection_id: 'gsc', date_from: isoDay(-28), date_to: isoDay(-3)},
  };
  return {
    requests,
    connection,
    setRows: (o, p) => {
      organicRows = o;
      paidRows = p;
    },
    read: (requirements = {}, extra = {}) =>
      service.call(
        'amcp_workspace',
        {...input, ...extra, requirements: {...input.requirements, ...requirements}},
        actor,
      ),
  };
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
};

test('normalization is NFKC, lower case and collapsed whitespace', () => {
  assert.equal(normalizeSearchQuery('  Running  SHOES '), 'running shoes');
  assert.equal(normalizeSearchQuery('ﬁt socks'), 'fit socks');
  assert.equal(normalizeSearchQuery('أحذية  الجري'), 'أحذية الجري');
});

test('synthetic Search Console and Google Ads rows give a deterministic, approximate overlap table', () => {
  const o = organic.map(r => ({query: r.keys[0], clicks: r.clicks, impressions: r.impressions, position: r.position})),
    p = paid.map(r => ({
      search_term: r.searchTermView.searchTerm,
      impressions: r.metrics.impressions,
      clicks: r.metrics.clicks,
      cost_micros: r.metrics.costMicros,
      conversions: r.metrics.conversions,
    })),
    table = searchOverlapTable(o, p);
  // Any input order gives the same table.
  assert.deepEqual(searchOverlapTable([...o].reverse(), [...p].reverse()), table);
  assert.deepEqual(table.summary, {
    queries: 4,
    both: 2,
    paid_only: 1,
    organic_only: 1,
    // Average position exactly 3 with paid spend.
    organic_strong_with_paid_spend: 1,
    paid_only_converting: 1,
  });
  assert.deepEqual(
    table.rows.map(r => [r.normalized_query, r.overlap, r.review_hint]),
    [
      ['running shoes', 'both', 'organic_strong_with_paid_spend'],
      ['fit socks', 'both', null],
      ['buy trail shoes', 'paid_only', 'paid_only_converting'],
      ['trail guide', 'organic_only', null],
    ],
  );
  const shoes = table.rows[0];
  assert.equal(shoes.match, 'approximate_normalized_text');
  // Impression-weighted position over both organic variants: (2*400 + 7*100) / 500.
  assert.deepEqual(shoes.organic, {
    clicks: 50,
    impressions: 500,
    average_position: 3,
    source_variants: ['Running Shoes', 'running  shoes '],
  });
  assert.deepEqual(shoes.paid, {
    impressions: '1000',
    clicks: '100',
    cost_micros: '50000000',
    conversions: 3,
    source_variants: ['RUNNING SHOES', 'running shoes'],
  });
  // Exact int64 cost beyond a double's safe range of cents is kept as a string.
  assert.equal(table.rows[2].paid.cost_micros, '9000000007');
  const strong = searchOverlapTable(
    [{query: 'brand name', clicks: 9, impressions: 90, position: 1.4}],
    [{search_term: 'Brand Name', impressions: '5', clicks: '1', cost_micros: '1200000', conversions: 0}],
  );
  assert.equal(strong.rows[0].review_hint, 'organic_strong_with_paid_spend');
  const capped = searchOverlapTable(o, p, 2);
  assert.equal(capped.rows.length, 2);
  assert.equal(capped.rows_truncated, true);
  assert.equal(capped.summary.queries, 4);
});

test('search overlap reads final Search Console queries and search_term_view for the same closed dates', async t => {
  const f = fixture(t),
    out = ok(await f.read());
  assert.equal(out.record_kind, 'search_overlap');
  assert.equal(out.match, 'approximate_normalized_text');
  assert.equal(out.summary.both, 2);
  assert.equal(out.complete, true);
  assert.equal(f.requests.length, 2);
  const [gsc, ads] = f.requests;
  assert.match(gsc.path, /\/sites\/sc-domain:example\.com\/searchAnalytics\/query$/);
  assert.deepEqual(gsc.body, {
    startDate: isoDay(-28),
    endDate: isoDay(-3),
    dimensions: ['query'],
    type: 'web',
    dataState: 'final',
    rowLimit: 5000,
    startRow: 0,
  });
  assert.equal(ads.path, '/v25/customers/123/googleAds:search');
  assert.match(ads.body.query, /FROM search_term_view WHERE segments\.date BETWEEN '[0-9-]+' AND '[0-9-]+'/);
  assert.equal(out.provider_mutations, 0);
  assert.equal(out.retained_snapshot, false);
  assert.match(out.meaning, /approximate/);
  f.setRows(organic.slice(0, 1), paid.slice(0, 1));
  const top = ok(await f.read({row_limit: 1}));
  assert.equal(top.complete, false);
  assert.equal(top.sources.organic.top_rows_only, true);
});

test('both sources stay in scope: a foreign site, login or customer is refused before any request', async t => {
  const f = fixture(t);
  for (const [requirements, extra] of [
    [{gsc_connection_id: 'gsc-other'}, {}],
    [{site_url: 'sc-domain:other.example'}, {}],
    [{}, {account_id: '456'}],
    [{gsc_connection_id: 'g'}, {}],
  ])
    assert.equal((await f.read(requirements, extra)).success, false, JSON.stringify(requirements));
  for (const requirements of [
    {date_to: isoDay(0)},
    {date_from: isoDay(-120), date_to: isoDay(-3)},
    {site_url: 'https://example.com/path?q=1'},
    {row_limit: 25001},
    {max_rows: 0},
  ]) {
    const r = await f.read(requirements);
    assert.equal(r.success, false);
    assert.equal(r.error.code, 'INVALID_ARGUMENT', JSON.stringify(requirements));
  }
  assert.equal(f.requests.length, 0);
  // Search Console reads take no connection_id, so a second login for the same property cannot be silently used.
  f.connection(
    'gsc-2',
    'google_search_console_native_action',
    [site],
    ['https://www.googleapis.com/auth/webmasters.readonly'],
  );
  const ambiguous = await f.read();
  assert.equal(ambiguous.success, false);
  assert.equal(ambiguous.error.code, 'AMBIGUOUS_CONNECTION');
  assert.equal(f.requests.length, 0);
});

test('a foreign search term or malformed query row refuses the whole overlap', async t => {
  const f = fixture(t);
  f.setRows(organic, [
    {...paid[0], searchTermView: {...paid[0].searchTermView, resourceName: 'customers/456/searchTermViews/1'}},
  ]);
  let r = await f.read();
  assert.equal(r.error.code, 'SEARCH_OVERLAP_INVALID');
  f.setRows([{keys: ['a', 'b'], clicks: 1, impressions: 1, position: 1}], paid);
  r = await f.read();
  assert.equal(r.error.code, 'SEARCH_OVERLAP_INVALID');
});

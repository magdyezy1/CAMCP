// PRV-07 D: organic/paid search overlap. Synthetic Search Console query rows and Google Ads search terms produce a
// deterministic, approximate overlap table; both sources stay inside their selected property and customer. Paid rows
// name their native search_term_view resources (the ids the reviewed exclusion preview takes), and an opt-in
// query × page read lists each query's top landing pages without changing the query totals.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {normalizeSearchQuery, searchConsolePageInProperty, searchOverlapTable} from '../dist/src/search-overlap.js';

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
const pageRows = [
  {keys: ['Running Shoes', 'https://www.example.com/shoes'], clicks: 30, impressions: 300, ctr: 0.1, position: 2},
  {keys: ['running  shoes ', 'https://www.example.com/shoes'], clicks: 5, impressions: 50, ctr: 0.1, position: 4},
  {keys: ['Running Shoes', 'https://example.com/blog/shoes'], clicks: 9, impressions: 90, ctr: 0.1, position: 3},
  {keys: ['Running Shoes', 'https://shop.example.com/a'], clicks: 2, impressions: 40, ctr: 0.05, position: 9},
  {keys: ['Running Shoes', 'https://shop.example.com/b'], clicks: 2, impressions: 60, ctr: 0.03, position: 8},
  {keys: ['trail guide', 'http://example.com/trail'], clicks: 25, impressions: 500, ctr: 0.05, position: 4.5},
];
// The native grain: campaign~ad group~base64url(term), as Google names a search_term_view.
const view = (text, adGroup = 2) =>
  'customers/123/searchTermViews/1~' + adGroup + '~' + Buffer.from(text, 'utf8').toString('base64url');
const term = (text, impressions, clicks, cost, conversions, adGroup) => ({
  searchTermView: {resourceName: view(text, adGroup), searchTerm: text},
  metrics: {impressions, clicks, costMicros: cost, conversions},
});
const paid = [
  term('running shoes', '900', '90', '45000000', 3),
  term('RUNNING SHOES', '100', '10', '5000000', 0, 3),
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
    pages = pageRows,
    paidRows = paid;
  const transport = new NativeTransport(
    async (url, init) => {
      const parsed = new URL(String(url)),
        body = JSON.parse(String(init.body));
      requests.push({host: parsed.hostname, path: decodeURIComponent(parsed.pathname), body, method: init.method});
      if (parsed.pathname.endsWith('/searchAnalytics/query'))
        return Response.json({rows: body.dimensions.includes('page') ? pages : organicRows});
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
    setPages: rows => (pages = rows),
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
  assert.equal(normalizeSearchQuery('  Running  SHOES '), 'running shoes');
  assert.equal(normalizeSearchQuery('ﬁt socks'), 'fit socks');
  assert.equal(normalizeSearchQuery('أحذية  الجري'), 'أحذية الجري');
});

test('a Search Console page belongs to its domain property or URL prefix, never a lookalike host', () => {
  for (const page of ['https://example.com/', 'http://www.example.com/a?b=1', 'https://shop.example.com/x#y'])
    assert.equal(searchConsolePageInProperty('sc-domain:example.com', page), true, page);
  for (const page of [
    'https://example.com.evil.test/',
    'https://notexample.com/',
    'https://user:pass@example.com/',
    'ftp://example.com/',
    'not a url',
    42,
  ])
    assert.equal(searchConsolePageInProperty('sc-domain:example.com', page), false, String(page));
  assert.equal(searchConsolePageInProperty('https://example.com/', 'https://example.com/shoes'), true);
  assert.equal(searchConsolePageInProperty('https://example.com/', 'https://www.example.com/shoes'), false);
  assert.equal(searchConsolePageInProperty('https://example.com/', 'http://example.com/shoes'), false);
});

test('synthetic Search Console and Google Ads rows give a deterministic, approximate overlap table', () => {
  const o = organic.map(r => ({query: r.keys[0], clicks: r.clicks, impressions: r.impressions, position: r.position})),
    p = paid.map(r => ({
      search_term: r.searchTermView.searchTerm,
      impressions: r.metrics.impressions,
      clicks: r.metrics.clicks,
      cost_micros: r.metrics.costMicros,
      conversions: r.metrics.conversions,
      resource_name: r.searchTermView.resourceName,
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
  // Impression-weighted position over both organic variants: (2*400 + 7*100) / 500. No page rows were read.
  assert.deepEqual(shoes.organic, {
    clicks: 50,
    impressions: 500,
    average_position: 3,
    source_variants: ['Running Shoes', 'running  shoes '],
    top_pages: null,
  });
  // Both native search term views, one per ad group, as preview_search_exclusions ids.
  assert.deepEqual(shoes.paid, {
    impressions: '1000',
    clicks: '100',
    cost_micros: '50000000',
    conversions: 3,
    source_variants: ['RUNNING SHOES', 'running shoes'],
    search_term_views: [view('RUNNING SHOES', 3), view('running shoes')].sort(),
    search_term_view_count: 2,
  });
  // Exact int64 cost beyond a double's safe range of cents is kept as a string.
  assert.equal(table.rows[2].paid.cost_micros, '9000000007');
  const strong = searchOverlapTable(
    [{query: 'brand name', clicks: 9, impressions: 90, position: 1.4}],
    [{search_term: 'Brand Name', impressions: '5', clicks: '1', cost_micros: '1200000', conversions: 0}],
  );
  assert.equal(strong.rows[0].review_hint, 'organic_strong_with_paid_spend');
  assert.deepEqual(strong.rows[0].paid.search_term_views, []);
  const capped = searchOverlapTable(o, p, 2);
  assert.equal(capped.rows.length, 2);
  assert.equal(capped.rows_truncated, true);
  assert.equal(capped.summary.queries, 4);
});

test('every input order gives the same table, even where order-dependent float sums would round apart', () => {
  // (3.55·1 + 5.26·2 + 9.38·3) / 6 = 7.035. Summed in input order, the weighted position rounded to 7.03 for some
  // orders and 7.04 for others; the table now sums in one canonical order.
  const rows = [
      {query: 'Trail Shoes', clicks: 1, impressions: 1, position: 3.55},
      {query: 'trail shoes ', clicks: 2, impressions: 2, position: 5.26},
      {query: 'TRAIL SHOES', clicks: 3, impressions: 3, position: 9.38},
    ],
    orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ].map(order => order.map(i => rows[i])),
    tables = orders.map(order =>
      searchOverlapTable(
        order,
        [],
        200,
        order.map(r => ({...r, page: 'https://example.com/trail'})),
      ),
    );
  for (const table of tables) assert.deepEqual(table, tables[0]);
  const trail = tables[0].rows[0].organic;
  assert.equal(trail.average_position, trail.top_pages[0].average_position);
});

test('page rows rank at most three landing pages per query, deterministically, without changing query totals', () => {
  const o = organic.map(r => ({query: r.keys[0], clicks: r.clicks, impressions: r.impressions, position: r.position})),
    pages = pageRows.map(r => ({
      query: r.keys[0],
      page: r.keys[1],
      clicks: r.clicks,
      impressions: r.impressions,
      position: r.position,
    })),
    table = searchOverlapTable(o, [], 200, pages);
  assert.deepEqual(searchOverlapTable([...o].reverse(), [], 200, [...pages].reverse()), table);
  const shoes = table.rows.find(r => r.normalized_query === 'running shoes');
  // Totals stay the query table's; the two variants on /shoes add up within the page.
  assert.equal(shoes.organic.clicks, 50);
  assert.deepEqual(shoes.organic.top_pages, [
    {page: 'https://www.example.com/shoes', clicks: 35, impressions: 350, average_position: 2.29},
    {page: 'https://example.com/blog/shoes', clicks: 9, impressions: 90, average_position: 3},
    // Equal clicks: more impressions first.
    {page: 'https://shop.example.com/b', clicks: 2, impressions: 60, average_position: 8},
  ]);
  assert.deepEqual(table.rows.find(r => r.normalized_query === 'fit socks').organic.top_pages, []);
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
  assert.match(ads.body.query, /^SELECT search_term_view\.resource_name, search_term_view\.search_term, /);
  assert.match(ads.body.query, /FROM search_term_view WHERE segments\.date BETWEEN '[0-9-]+' AND '[0-9-]+'/);
  assert.equal(out.provider_mutations, 0);
  assert.equal(out.retained_snapshot, false);
  assert.match(out.meaning, /approximate/);
  assert.equal(out.sources.organic_pages, null);
  assert.equal(out.rows[0].organic.top_pages, null);
  assert.deepEqual(out.rows[0].paid.search_term_views, [view('RUNNING SHOES', 3), view('running shoes')].sort());
  assert.match(out.next_steps[0], /capture_preset google_search_terms.*search_term_views as ids/);
  // Final Search Console data trails by days: a window ending three days ago is flagged, four days ago is not.
  assert.equal(out.sources.organic.recent_days_may_be_missing, true);
  assert.equal(ok(await f.read({date_to: isoDay(-4)})).sources.organic.recent_days_may_be_missing, false);
  f.setRows(organic.slice(0, 1), paid.slice(0, 1));
  const top = ok(await f.read({row_limit: 1}));
  assert.equal(top.complete, false);
  assert.equal(top.sources.organic.top_rows_only, true);
});

test('include_pages adds one query × page read inside the property and lists top landing pages', async t => {
  const f = fixture(t),
    out = ok(await f.read({include_pages: true}));
  assert.equal(f.requests.length, 3);
  const [queries, pages, ads] = f.requests;
  assert.deepEqual(queries.body.dimensions, ['query']);
  assert.deepEqual(pages.body, {...queries.body, dimensions: ['query', 'page']});
  assert.equal(ads.path, '/v25/customers/123/googleAds:search');
  assert.equal(out.scope.include_pages, true);
  assert.deepEqual(out.sources.organic_pages, {
    provider: 'search_console',
    dimensions: ['query', 'page'],
    aggregation: 'by_page',
    rows: pageRows.length,
    top_rows_only: false,
    pages_per_query: 3,
  });
  assert.equal(out.source_references.length, 3);
  const shoes = out.rows.find(r => r.normalized_query === 'running shoes');
  assert.equal(shoes.organic.top_pages[0].page, 'https://www.example.com/shoes');
  assert.equal(shoes.organic.top_pages.length, 3);
  // A page of another site refuses the whole overlap.
  f.setPages([
    ...pageRows,
    {keys: ['trail guide', 'https://other.example/trail'], clicks: 1, impressions: 1, position: 1},
  ]);
  const foreign = await f.read({include_pages: true});
  assert.equal(foreign.success, false);
  assert.equal(foreign.error.code, 'SEARCH_OVERLAP_INVALID');
  // A page row must carry exactly the query and the page.
  f.setPages([{keys: ['trail guide'], clicks: 1, impressions: 1, position: 1}]);
  assert.equal((await f.read({include_pages: true})).error.code, 'SEARCH_OVERLAP_INVALID');
  const malformed = await f.read({include_pages: 'yes'});
  assert.equal(malformed.error.code, 'INVALID_ARGUMENT');
  assert.equal(f.requests.length, 3 + 4);
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

test('a foreign, unnamed, malformed or repeated search term view or malformed query row refuses the whole overlap', async t => {
  const f = fixture(t);
  const withView = resourceName => ({...paid[0], searchTermView: {...paid[0].searchTermView, resourceName}});
  for (const rows of [
    [withView('customers/456/searchTermViews/1~2~' + Buffer.from('running shoes').toString('base64url'))],
    // The resource name is what the reviewed exclusion path takes as an id, so a row without one is refused.
    [withView(undefined)],
    [withView('customers/123/searchTermViews/1')],
    [withView('customers/123/searchTermViews/1~2~running%20shoes')],
    [paid[0], paid[0]],
  ]) {
    f.setRows(organic, rows);
    const r = await f.read();
    assert.equal(r.error.code, 'SEARCH_OVERLAP_INVALID', JSON.stringify(rows));
  }
  f.setRows([{keys: ['a', 'b'], clicks: 1, impressions: 1, position: 1}], paid);
  const r = await f.read();
  assert.equal(r.error.code, 'SEARCH_OVERLAP_INVALID');
});

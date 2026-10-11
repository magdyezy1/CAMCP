// QA-02 contract-faithful fakes (tests/helpers/contract-fakes.mjs) for the four adapters the review named: Google
// search metrics, TikTok list endpoints, Microsoft GetAdsByIds/AddAds and Meta Insights. Each fake checks what the
// pinned vendor contract (or, where it under-declares, the vendor documentation) says, not what AMCP happens to send:
//   - Google: every googleAds:search request matches its pinned Discovery method, and the fake's rows match the pinned
//     response schema, with metrics.conversions as the doubles Google declares (before RPT-01 these failed the source);
//   - TikTok and Meta: cursor, has_more, page_info and paging.next pages are served only to a request that continues
//     from the page before (before PRV-03 a TikTok cursor list stopped after its first page and reported complete);
//   - Microsoft: GetAdsByIds and AddAds bodies match the pinned WSDL model and the fields Microsoft Learn marks
//     required (before PRV-03 the verification read omitted AdTypes and every ad write stayed "verifying").
import test from 'node:test';
import assert from 'node:assert/strict';
import {paginate} from '../dist/src/pagination.js';
import {compileMicrosoft, getByIdsPayload, microsoftSnapshots} from '../dist/src/microsoft-native.js';
import {overviewGranularityFixture, granularSource, granularConfig} from './fixtures/overview-granularity-data.mjs';
import {googleEvidenceRow, googleEvidenceResponse} from './fixtures/google-evidence-data.mjs';
import {
  discoveryRequestIssues,
  discoveryResponseIssues,
  documentedRequired,
  pageShapes,
  pagedFake,
  pinnedRequestIssues,
  providerDoubles,
} from './helpers/contract-fakes.mjs';

const sumNine = values => {
  const scaled = values.reduce((n, v) => n + BigInt(v.nine.replace('.', '')), 0n),
    whole = scaled / 1000000000n,
    fraction = (scaled % 1000000000n).toString().padStart(9, '0').replace(/0+$/, '');
  return fraction ? whole + '.' + fraction : String(whole);
};
async function run(f, config) {
  const queued = await f.overview.handle({action: 'run', config, confirmed: true}, f.actor);
  assert.equal(await f.worker.once(), true);
  return f.overview.handle({action: 'get', id: queued.id}, f.actor);
}

test('the Google fake answers only requests its pinned Discovery method accepts, and refuses others', () => {
  const url = 'https://googleads.googleapis.com/v25/customers/123/googleAds:search';
  assert.deepEqual(
    discoveryRequestIssues('google-ads-v25', {method: 'POST', url, body: {query: 'SELECT campaign.id FROM campaign'}}),
    [],
  );
  const issues = (method, target, body) =>
    discoveryRequestIssues('google-ads-v25', {method, url: target, body}).map(i => i.field + ' ' + i.reason);
  assert.match(issues('POST', url, {query: 'x', pageSize: 'ten'}).join(), /pageSize/);
  assert.match(issues('POST', url, {query: 'x', unknownField: 1}).join(), /unknownField/);
  assert.match(issues('POST', url + '?debug=1', {query: 'x'}).join(), /\?debug Query parameter absent/);
  assert.match(issues('GET', url, undefined).join(), /No pinned google-ads-v25 method/);
  assert.match(issues('POST', url, undefined).join(), /takes a request body/);
  // The response schema declares metrics.conversions a double: every generated double is a valid answer, a string
  // in its place is not.
  const row = {...googleEvidenceRow('ad_group_ad'), segments: {date: '2026-09-01'}};
  for (const {value} of providerDoubles)
    assert.deepEqual(
      discoveryResponseIssues(
        'google-ads-v25',
        {method: 'POST', url},
        googleEvidenceResponse({query: 'SELECT x FROM ad_group_ad'}, [
          {...row, metrics: {...row.metrics, conversions: value}},
        ]),
      ),
      [],
      String(value),
    );
});

test('Google search metrics: provider doubles reach the report at nine places half to even, through a spec-checked fake', async () => {
  for (let k = 0; k + 1 < providerDoubles.length; k++) {
    const f = overviewGranularityFixture(),
      pair = [providerDoubles[k], providerDoubles[k + 1]];
    try {
      f.mutate((rows, platform) =>
        platform === 'google'
          ? rows.map((row, i) => ({...row, metrics: {...row.metrics, conversions: pair[i % 2].value}}))
          : rows,
      );
      const report = await run(f, granularConfig(granularSource('google', 'ad')));
      assert.equal(report.state, 'complete', String(pair[0].value) + ' ' + JSON.stringify(report.sources));
      assert.equal(report.rows[0].native.exact_totals.conversions, sumNine(pair), String(pair[0].value));
      const rounded = pair.filter(v => v.rounded).length;
      assert.deepEqual(
        report.sources[0].quality.metric_rounding?.conversions?.rows_rounded,
        rounded || undefined,
        'rounding recorded only when a value was rounded',
      );
      const searches = f.requests.filter(r => r.url.hostname === 'googleads.googleapis.com');
      assert.ok(searches.length >= 2);
      for (const r of searches)
        assert.deepEqual(
          discoveryRequestIssues('google-ads-v25', {method: r.method, url: r.url, body: r.body}),
          [],
          r.url.pathname,
        );
    } finally {
      f.close();
    }
  }
});

const tiktokList = {
  gateway: 'tiktok_native_action',
  action: 'tiktok_identity_video_get',
  method: 'GET',
  path: '/v1.3/identity/video/get/',
  query: {advertiser_id: '7000000000000000001', identity_type: 'TT_USER', identity_id: 'synthetic'},
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  accountId: '7000000000000000001',
  evidence: 'TEST',
  warnings: [],
};
const metaInsights = {
  ...tiktokList,
  gateway: 'meta_native_action',
  action: 'meta_insights',
  path: '/v26.0/act_100/insights',
  query: {level: 'ad', fields: 'spend,actions', time_range: '{"since":"2026-09-01","until":"2026-09-02"}'},
  accountId: '100',
};
const rowsOf = (value, out = []) => {
  if (Array.isArray(value)) value.forEach(v => rowsOf(v, out));
  else if (value && typeof value === 'object') {
    if (typeof value.rid === 'string') out.push(value.rid);
    else Object.values(value).forEach(v => rowsOf(v, out));
  }
  return out;
};

test('pagination sweep: TikTok cursor, has_more and page_info and Meta paging.next lists are read to their last page', async () => {
  let cases = 0;
  for (const [shape, plan] of [
    ['tiktok_cursor', tiktokList],
    ['tiktok_string', tiktokList],
    ['tiktok_page', {...tiktokList, path: '/v1.3/adgroup/get/', action: 'tiktok_adgroup_get'}],
    ['meta', metaInsights],
  ])
    for (let n = 0; n <= 7; n++)
      for (const size of [1, 2, 3]) {
        cases++;
        const rows = Array.from({length: n}, (_, i) => ({rid: 'r' + i})),
          pages = pageShapes(rows, size, shape),
          fake = pagedFake(pages);
        const label = shape + ' rows=' + n + ' size=' + size;
        // A TikTok request always names its advertiser (API for Business v1.3, every advertiser-scoped GET).
        const response = await paginate(
          plan,
          async request => {
            if (plan.gateway === 'tiktok_native_action')
              assert.equal(request.query.advertiser_id, plan.accountId, label + ': advertiser_id');
            return fake.answer(request.query);
          },
          25,
        );
        assert.equal(fake.served, pages.length, label + ': every page requested');
        assert.equal(response.pages, pages.length, label);
        assert.equal(response.truncated, false, label);
        assert.deepEqual(
          rowsOf(response.data),
          rows.map(r => r.rid),
          label + ': every row once, in order',
        );
      }
  assert.equal(cases, 96);
});

test('a TikTok has_more page without a usable cursor is refused, never read as the last page', async () => {
  for (const cursor of [undefined, '', null, -1, 1.5]) {
    const fake = pagedFake([
      {answer: {code: 0, message: 'OK', data: {list: [{rid: 'a'}], cursor, has_more: true}}, continuation: undefined},
    ]);
    await assert.rejects(
      () => paginate(tiktokList, async r => fake.answer(r.query), 25),
      {code: 'UNKNOWN_PAGINATION'},
      String(cursor),
    );
  }
});

test('Microsoft GetAdsByIds and AddAds bodies satisfy the pinned WSDL model and the fields Microsoft documents as required', () => {
  const read = compileMicrosoft({
    action: 'GetAdsByIds',
    account_id: '1234',
    payload: getByIdsPayload('Ads', '2001', ['3001']),
  });
  assert.deepEqual(pinnedRequestIssues(read), []);
  assert.deepEqual(read.body.AdTypes, ['ResponsiveSearch']);
  // The fake refuses what the documentation requires and the WSDL leaves optional, and a field the model lacks.
  const without = {...read, body: {...read.body}};
  delete without.body.AdTypes;
  assert.deepEqual(
    pinnedRequestIssues(without).map(i => i.field),
    ['/AdTypes'],
  );
  assert.deepEqual(
    pinnedRequestIssues({...read, body: {...read.body, AdType: 'ResponsiveSearch'}}).map(i => i.field),
    ['/AdType'],
  );
  assert.deepEqual(Object.keys(documentedRequired.microsoft_ads_native_action).sort(), [
    'AddAds',
    'GetAdsByAdGroupId',
    'GetAdsByIds',
    'UpdateAds',
  ]);
  const add = compileMicrosoft({
    action: 'AddAds',
    account_id: '1234',
    payload: {
      AdGroupId: '2001',
      Ads: [
        {
          Type: 'ResponsiveSearch',
          FinalUrls: ['https://example.com/'],
          Headlines: [1, 2, 3].map(i => ({Asset: {Type: 'TextAsset', Text: 'Headline ' + i}})),
          Descriptions: [1, 2].map(i => ({Asset: {Type: 'TextAsset', Text: 'Description number ' + i}})),
        },
      ],
    },
  });
  assert.deepEqual(pinnedRequestIssues(add), []);
});

test('every Microsoft ad review snapshot and verification read is a request the spec-checked fake answers', () => {
  const update = compileMicrosoft({
    action: 'UpdateAds',
    account_id: '1234',
    payload: {
      AdGroupId: '2001',
      Ads: [{Id: '3001', Type: 'ResponsiveSearch', FinalUrls: ['https://example.com/new']}],
    },
  });
  update.scopeContext = {...update.scopeContext, campaignId: '1001'};
  const reads = microsoftSnapshots(update);
  assert.ok(reads.some(r => r.action === 'GetAdsByIds'));
  for (const r of reads) if (r.action !== 'GetAccount') assert.deepEqual(pinnedRequestIssues(r), [], r.action);
});

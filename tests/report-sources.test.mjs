import test from 'node:test';
import assert from 'node:assert/strict';
import {reportSource, reportSourceList} from '../dist/src/report-sources.js';
import {reportPlatforms} from '../dist/src/report-metrics.js';
import {
  missingNativeMetrics,
  nativeDailyPlatforms,
  nativeMetricExamples,
  normalizeNativeRow,
  reportRange,
} from '../dist/src/report-native.js';
import {reportRange as periodRange} from '../dist/src/report-periods.js';
import {nativeDetailPlatforms} from '../dist/src/overview-native-detail.js';
import {sourceRequestModel} from '../dist/src/report-request-estimate.js';
import {fixedReportTimezones, sourceReportTimezone} from '../dist/src/report-windows.js';
import {redditReportWarning, savedRedditReportProblems} from '../dist/src/reddit-report-rules.js';

// ARC-04 stage F: one report source per reporting platform; src/report-native.ts normalizes through them.

test('every reporting platform has exactly one report source, in the platforms order', () => {
  assert.deepEqual(
    reportSourceList.map(s => s.platform),
    Object.keys(reportPlatforms),
  );
  for (const source of reportSourceList) {
    assert.equal(reportSource(source.platform), source);
    assert.equal(typeof source.normalize, 'function', source.platform);
    assert.deepEqual(nativeMetricExamples[source.platform], [...source.nativeMetricExamples], source.platform);
  }
  assert.deepEqual(Object.keys(nativeMetricExamples), Object.keys(reportPlatforms));
  // Only Google Ads and TikTok (metrics) and Snapchat (stats) nest requested native metrics in a container.
  assert.deepEqual(
    reportSourceList.filter(s => s.nativeMetricContainer).map(s => [s.platform, s.nativeMetricContainer]),
    [
      ['google', 'metrics'],
      ['tiktok', 'metrics'],
      ['snapchat', 'stats'],
    ],
  );
});

// ARC-04 stage F: NativeCampaignReports.collectSource and the request estimate named these platforms in lists; the
// sources declare them now, and these are the lists they replaced, unchanged.
test('the collector and the request estimate read their platform facts from the report sources, unchanged', () => {
  const declaring = fact => reportSourceList.filter(s => s[fact] !== undefined).map(s => [s.platform, s[fact]]);
  assert.deepEqual(declaring('accountLookup'), [
    ['apple', false],
    ['ga4', false],
    ['gsc', false],
  ]);
  assert.deepEqual(declaring('nativeDetail'), [
    ['microsoft', true],
    ['apple', true],
    ['reddit', true],
  ]);
  assert.deepEqual(
    reportSourceList
      .filter(s => s.nativeDetail)
      .map(s => s.platform)
      .sort(),
    [...nativeDetailPlatforms].sort(),
  );
  assert.deepEqual(declaring('nativeMetricCheck'), [
    ['x', false],
    ['apple', false],
  ]);
  assert.deepEqual(declaring('nullNativeMetrics'), [['ga4', true]]);
  assert.deepEqual(declaring('versionHeader'), [['linkedin', 'LinkedIn-Version']]);
  // RPT-02 report day boundaries: the fixed zones of src/report-windows.ts, in its order, and the zone reads it named.
  assert.deepEqual(declaring('fixedTimezone'), [
    ['linkedin', 'UTC'],
    ['apple', 'UTC'],
    ['reddit', 'UTC'],
    ['gsc', 'America/Los_Angeles'],
  ]);
  assert.deepEqual(
    {...fixedReportTimezones},
    {linkedin: 'UTC', apple: 'UTC', reddit: 'UTC', gsc: 'America/Los_Angeles'},
  );
  assert.deepEqual(Object.keys(fixedReportTimezones), ['linkedin', 'apple', 'reddit', 'gsc']);
  // PRV-04: only Reddit's saved queries meet a provider rule change, read through its report source.
  assert.deepEqual(
    reportSourceList.filter(s => s.savedQueryRules).map(s => s.platform),
    ['reddit'],
  );
  assert.equal(reportSource('reddit').savedQueryRules.problems, savedRedditReportProblems);
  assert.deepEqual(
    reportSource('reddit').savedQueryRules.warning('q1', ['AUDIENCE_WITH_LOCATION_OR_PLACEMENT'], ['s1']),
    redditReportWarning('q1', ['AUDIENCE_WITH_LOCATION_OR_PLACEMENT'], ['s1']),
  );
  assert.deepEqual(
    reportSourceList.filter(s => s.timezoneRead).map(s => [s.platform, Object.keys(s.timezoneRead).sort()]),
    [
      ['microsoft', ['zone']],
      ['ga4', ['plan', 'zone']],
    ],
  );
  assert.deepEqual(nativeDailyPlatforms, ['google', 'meta']);
  for (const source of reportSourceList) assert.equal(typeof source.collect, 'function', source.platform);
  // The request model the bootstrap publishes, as the estimate's table and lookup list had it.
  const requests = {google: 1, meta: 1, tiktok: 3, snapchat: 2, linkedin: 1, x: 2, microsoft: 2, apple: 2, reddit: 2};
  Object.assign(requests, {ga4: 3, gsc: 1});
  for (const [platform, minimum] of Object.entries(requests)) {
    const lookups = ['ga4', 'gsc', 'apple'].includes(platform) ? 0 : 1;
    assert.deepEqual(
      sourceRequestModel(platform),
      {
        account_lookups: lookups,
        account_verification_after_periods: lookups,
        minimum_requests_per_period: minimum,
        native_daily_segmentation: ['google', 'meta'].includes(platform),
      },
      platform,
    );
  }
  for (const platform of ['unknown', 'constructor', '__proto__'])
    assert.deepEqual(sourceRequestModel(platform), {
      account_lookups: 1,
      account_verification_after_periods: 1,
      minimum_requests_per_period: 1,
      native_daily_segmentation: false,
    });
});

// RPT-02 rolling windows in the account zone read one time zone before collection. The suite exercised only Meta's
// account read; GA4's property read, Microsoft's report zone and the fixed zones are held here (ARC-04 stage F moved
// them into the report sources).
test('a source report time zone: GA4 reads its property, Microsoft maps its account zone, fixed zones read nothing', async () => {
  const read = async (platform, data) => {
    const calls = [],
      service = {
        store: {
          resolveConnection: (_actor, gateway, account, connection) => calls.push([gateway, account, connection]),
        },
        runPlan: async (plan, options) => calls.push({plan, options}) && {success: true, data},
      };
    return {zone: await sourceReportTimezone(service, {platform, account_id: '123', connection_id: 'c1'}, {}), calls};
  };
  const ga4 = await read('ga4', {timeZone: 'Asia/Riyadh'});
  assert.equal(ga4.zone, 'Asia/Riyadh');
  assert.deepEqual(ga4.calls[0], ['ga4_native_action', '123', 'c1']);
  assert.deepEqual(ga4.calls[1], {
    plan: {
      gateway: 'ga4_native_action',
      accountId: '123',
      action: 'AMCP_CAMPAIGN_REPORT',
      method: 'GET',
      path: '/v1beta/properties/123',
      query: {},
      origin: 'https://analyticsadmin.googleapis.com',
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      evidence: 'Reporting time zone for a rolling window, bounded property scope',
      warnings: [],
    },
    options: {connection_id: 'c1', aggregate_pages: false, max_pages: 25},
  });
  const microsoft = await read('microsoft', {Account: {TimeZone: 'PacificTimeUSCanadaTijuana'}});
  assert.equal(microsoft.zone, 'America/Los_Angeles');
  assert.equal(microsoft.calls[1].plan.action, 'GetAccount');
  assert.equal((await read('meta', {timezone_name: 'America/New_York'})).zone, 'America/New_York');
  for (const [platform, zone] of Object.entries({
    linkedin: 'UTC',
    apple: 'UTC',
    reddit: 'UTC',
    gsc: 'America/Los_Angeles',
  }))
    assert.deepEqual(await read(platform, {}), {zone, calls: []}, platform);
  // An unknown zone name is no zone.
  assert.equal((await read('ga4', {timeZone: 'Not/AZone'})).zone, null);
});

test('requested native metrics are checked against returned rows except where a source declares its own shapes', () => {
  const rows = [{metrics: {native_any_clicks: 1}, native: {}}];
  for (const platform of ['x', 'apple']) assert.deepEqual(missingNativeMetrics(platform, ['VIDEO'], rows), []);
  for (const platform of ['google', 'meta', 'tiktok', 'snapchat', 'linkedin', 'microsoft', 'reddit', 'ga4', 'gsc'])
    assert.deepEqual(missingNativeMetrics(platform, ['video_views'], rows), ['video_views'], platform);
  // GA4 keeps an access-restricted (null) metric as a null native metric; other sources drop a null.
  const ga4 = normalizeNativeRow('ga4', {campaign_id: '1', campaign_name: 'one', sessions: '4', purchaseRevenue: null});
  assert.equal(ga4.metrics.native_ga4_purchaseRevenue, null);
  assert.equal(ga4.metrics.native_ga4_sessions, 4);
  const reddit = normalizeNativeRow('reddit', {campaign_id: '1', SPEND: '1000000', VIDEO_STARTED: null});
  assert.equal(Object.hasOwn(reddit.metrics, 'native_reddit_VIDEO_STARTED'), false);
});

test('a platform without a report source is refused for its missing identifier, never read from an inherited name', () => {
  for (const platform of ['unknown', 'constructor', 'toString', '__proto__', 'hasOwnProperty'])
    assert.throws(
      () => normalizeNativeRow(platform, {id: '1', campaign_id: '1', campaign: {id: '1'}}),
      e => e.code === 'REPORT_ID_MISSING',
      platform,
    );
  assert.equal(reportSource('constructor'), undefined);
});

test('the report date range moved to report-periods.ts and keeps its rule and refusal', () => {
  assert.equal(reportRange, periodRange, 'one function, two import paths');
  assert.deepEqual(reportRange({since: '2026-01-01', until: '2026-12-31'}), {since: '2026-01-01', until: '2026-12-31'});
  for (const range of [
    {since: '2026-01-02', until: '2026-01-01'},
    {since: '2025-01-01', until: '2026-01-02'},
    {since: '2026-02-30', until: '2026-03-01'},
    {since: '2026-1-01', until: '2026-01-02'},
    undefined,
  ])
    assert.throws(
      () => reportRange(range),
      e =>
        e.code === 'INVALID_REPORT_SOURCE' && e.message === 'Choose a valid inclusive date range of at most 366 days.',
      JSON.stringify(range),
    );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {isProviderModule, providerRegistries, runtimeGraph} from '../tools/architecture-map.mjs';
import {providerById} from '../dist/src/provider-adapters.js';
import * as sheets from '../dist/src/google-sheets.js';
import * as table from '../dist/src/report-table.js';
import {reportPlatforms} from '../dist/src/report-metrics.js';

/**
 * ARC-01 (reporting): the shared reporting modules name no provider gateway and import no provider module except
 * through a provider registry. Each entry is what the module still holds; a concern that moves provider facts into the
 * providers' modules lowers it here, and nothing may raise it (tools/architecture-map.mjs ratchets the totals).
 */
const remaining = {
  'src/decision-reporting.ts': {literals: 7, imports: 10},
  'src/overview-parents.ts': {literals: 0, imports: 2},
  'src/overview-levels.ts': {literals: 0, imports: 1},
  'src/reporting-overview.ts': {literals: 0, imports: 1},
};
const gatewayLiteral = /['"]([a-z0-9]+(?:_[a-z0-9]+)*)_native_action['"]/g;
const reportingModule = id =>
  /^src\/(?:report-[\w-]+|[\w-]*reporting(?:-[\w-]+)?|overview-[\w-]+|decision-[\w-]+)\.ts$/.test(id) ||
  id === 'server/report-download-routes.ts';

test('the shared reporting modules hold no more provider gateways or provider imports than recorded', () => {
  const graph = runtimeGraph(process.cwd()),
    measured = {};
  for (const id of [...graph.keys()].filter(id => reportingModule(id) && !isProviderModule(id)).sort()) {
    const literals = [...fs.readFileSync(id, 'utf8').matchAll(gatewayLiteral)].filter(m => m[1] !== 'amcp').length,
      imports = [...graph.get(id)].filter(to => isProviderModule(to) && !providerRegistries.includes(to)).length;
    if (literals || imports) measured[id] = {literals, imports};
  }
  assert.deepEqual(measured, remaining);
});

test('each reporting platform reports through its provider adapter gateway, as the platform table named it', () => {
  assert.deepEqual(Object.keys(reportPlatforms), [
    'google',
    'meta',
    'tiktok',
    'snapchat',
    'linkedin',
    'x',
    'microsoft',
    'apple',
    'reddit',
    'ga4',
    'gsc',
  ]);
  assert.deepEqual(
    {...reportPlatforms},
    {
      google: {name: 'Google Ads', gateway: 'google_ads_native_action', kind: 'paid'},
      meta: {name: 'Meta', gateway: 'meta_native_action', kind: 'paid'},
      tiktok: {name: 'TikTok', gateway: 'tiktok_native_action', kind: 'paid'},
      snapchat: {name: 'Snapchat', gateway: 'snapchat_native_action', kind: 'paid'},
      linkedin: {name: 'LinkedIn', gateway: 'linkedin_native_action', kind: 'paid'},
      x: {name: 'X Ads', gateway: 'x_ads_native_action', kind: 'paid'},
      microsoft: {name: 'Microsoft Ads', gateway: 'microsoft_ads_native_action', kind: 'paid'},
      apple: {name: 'Apple Ads', gateway: 'apple_ads_native_action', kind: 'paid'},
      reddit: {name: 'Reddit Ads', gateway: 'reddit_native_action', kind: 'paid'},
      ga4: {name: 'Google Analytics 4', gateway: 'ga4_native_action', kind: 'measurement'},
      gsc: {name: 'Search Console', gateway: 'google_search_console_native_action', kind: 'organic'},
    },
  );
  for (const [id, platform] of Object.entries(reportPlatforms))
    assert.equal(platform.gateway, providerById(id).gateway);
});

test('the report sources reach no guided collector, so the guided reporting modules may consult their registry', () => {
  // ARC-04 stage F: the native detail collectors build on the leaf src/overview-levels.ts, not on the guided
  // collector (src/overview-granularity.ts imports DecisionReporting), so no report source reaches decision reporting.
  const graph = runtimeGraph(process.cwd()),
    reached = new Set(),
    queue = ['src/report-sources.ts'];
  while (queue.length)
    for (const next of graph.get(queue.shift()) ?? []) if (!reached.has(next)) reached.add(next) && queue.push(next);
  for (const id of [
    'src/overview-granularity.ts',
    'src/decision-reporting.ts',
    'src/report-presets.ts',
    'src/report-allocation.ts',
    'src/report-breakdowns.ts',
    'src/reporting-overview.ts',
  ])
    assert.equal(reached.has(id), false, id);
  assert.equal(graph.get('src/overview-native-detail.ts').has('src/overview-granularity.ts'), false);
});

test('the levels and detailed rows moved to a leaf keep their overview-granularity import path', async () => {
  const granularity = await import('../dist/src/overview-granularity.js'),
    levels = await import('../dist/src/overview-levels.js');
  for (const name of [
    'campaignAttributionProfile',
    'detailContractVersion',
    'detailedOverviewRows',
    'overviewEntityLevels',
    'overviewSourceLevel',
  ])
    assert.equal(granularity[name], levels[name], name);
});

test('the guided breakdown dimensions are the report sources’ own, as the table in report-breakdowns.ts named them', async () => {
  // ARC-04 stage F: Google's and Meta's native dimensions and Meta's packs left src/report-breakdowns.ts for their
  // guided reporting (src/google-guided-reports.ts, src/meta-guided-reports.ts); the shared module names no gateway.
  const breakdowns = await import('../dist/src/report-breakdowns.js'),
    meta = await import('../dist/src/meta-guided-reports.js'),
    google = await import('../dist/src/google-reporting.js');
  assert.deepEqual(breakdowns.breakdownDimensionKeys, [
    'native_ad_network',
    'native_age',
    'native_gender',
    'native_country',
    'native_publisher_platform',
    'native_platform_position',
  ]);
  assert.deepEqual(
    Object.fromEntries(Object.entries(breakdowns.breakdownDimensions).map(([key, d]) => [key, d.gateway])),
    {
      native_ad_network: 'google_ads_native_action',
      native_age: 'meta_native_action',
      native_gender: 'meta_native_action',
      native_country: 'meta_native_action',
      native_publisher_platform: 'meta_native_action',
      native_platform_position: 'meta_native_action',
    },
  );
  // The documented values each dimension accepted, and some it refused.
  const accepts = {
    native_ad_network: [
      ['SEARCH', 'MAPS', 'UNKNOWN'],
      ['search', 'SEARCH_TERM', 1, null],
    ],
    native_age: [
      ['13-17', '65+', 'Unknown'],
      ['unknown', '18-25', 18],
    ],
    native_gender: [
      ['female', 'male', 'unknown'],
      ['Unknown', 'other'],
    ],
    native_country: [
      ['SA', 'US', 'unknown', 'Unknown'],
      ['sa', 'USA', ''],
    ],
    native_publisher_platform: [
      ['facebook', 'threads', 'unknown'],
      ['Facebook', 'whatsapp'],
    ],
    native_platform_position: [
      ['feed', 'instagram_reels', 'a'],
      ['Feed', '1feed', '', 'x'.repeat(81)],
    ],
  };
  for (const [key, [good, wrong]] of Object.entries(accepts)) {
    for (const value of good) assert.equal(breakdowns.breakdownDimensions[key].valid(value), true, key + ' ' + value);
    for (const value of wrong) assert.equal(breakdowns.breakdownDimensions[key].valid(value), false, key + ' ' + value);
  }
  // The moved names keep their report-breakdowns import paths: one value, two import paths.
  for (const name of [
    'metaAgeBuckets',
    'metaGenders',
    'metaPublisherPlatforms',
    'metaBreakdownPresets',
    'metaBreakdownKey',
  ])
    assert.equal(breakdowns[name], meta[name], name);
  assert.equal(breakdowns.googleReportAdNetworks, google.googleReportAdNetworks);
  const graph = runtimeGraph(process.cwd());
  assert.equal(graph.get('src/google-reporting.ts').has('src/report-breakdowns.ts'), false);
});

test('the guided capture presets are the report sources’ own, listed as the preset table listed them', async () => {
  // ARC-04 stage F: each platform's presets, their native requests and its evidence row checks left
  // src/report-presets.ts for its guided reporting (src/<platform>-guided-reports.ts). The fixture is the table
  // report-presets.ts held before (capture_presets returns it): the same presets, fields and order.
  const {reportPresets} = await import('../dist/src/report-presets.js'),
    {guidedReportSources} = await import('../dist/src/report-sources.js'),
    expected = JSON.parse(fs.readFileSync('tests/fixtures/guided-report-presets.json', 'utf8'));
  assert.equal(JSON.stringify(reportPresets), JSON.stringify(expected));
  assert.deepEqual(
    guidedReportSources.map(source => source.platform),
    ['google', 'snapchat', 'tiktok', 'linkedin', 'meta'],
  );
  for (const source of guidedReportSources)
    for (const preset of source.guided.presets) {
      // A platform's presets report through its gateway and are named under its prefix, so a capture finds them.
      assert.equal(preset.gateway, reportPlatforms[source.platform].gateway, preset.id);
      assert.ok(preset.id.startsWith(source.guided.presetPrefix), preset.id);
      assert.ok(typeof source.guided.presetRequest === 'function', preset.id);
    }
  // Only LinkedIn and Meta check their evidence rows; only Snapchat takes a parent campaign filter.
  assert.deepEqual(
    guidedReportSources.filter(source => source.guided.validateRows).map(source => source.platform),
    ['linkedin', 'meta'],
  );
  assert.deepEqual(
    guidedReportSources.filter(source => source.guided.campaignFilter).map(source => source.platform),
    ['snapchat'],
  );
  assert.deepEqual(
    reportPresets.filter(p => guidedReportSources[1].guided.campaignFilter(p)).map(p => p.id),
    ['snapchat_adsquad', 'snapchat_adsquad_leads', 'snapchat_ad_leads'],
  );
});

test('the allocation models are the guided platforms’ own, under the gateways report-allocation named', async () => {
  // DEC-01 (ARC-04 stage F): which guided evidence an allocation models, its source checks and its entity IDs left
  // src/report-allocation.ts for the platforms' guided reporting.
  const {guidedReportSources} = await import('../dist/src/report-sources.js'),
    models = guidedReportSources.filter(source => source.guided.allocation);
  assert.deepEqual(
    Object.fromEntries(
      models.map(source => [source.guided.allocation.preset, reportPlatforms[source.platform].gateway]),
    ),
    {
      google_campaign: 'google_ads_native_action',
      snapchat_adsquad: 'snapchat_native_action',
      linkedin_campaign: 'linkedin_native_action',
      meta_campaign: 'meta_native_action',
    },
  );
  assert.deepEqual(
    models.filter(source => source.guided.allocation.evidence).map(source => source.platform),
    ['snapchat', 'linkedin'],
  );
  // The entity IDs each accepted: numeric campaign IDs, Snapchat ad squad UUIDs, LinkedIn campaign URNs.
  const entity = Object.fromEntries(models.map(source => [source.platform, source.guided.allocation.entity]));
  for (const platform of ['google', 'meta']) {
    assert.equal(entity[platform]('1234567890'), true);
    for (const id of ['', '12a', 'urn:li:sponsoredCampaign:1', 1, '1'.repeat(41)])
      assert.equal(entity[platform](id), false, platform + ' ' + id);
  }
  assert.equal(entity.snapchat('11111111-1111-4111-8111-111111111111'), true);
  assert.equal(entity.snapchat('1234567890'), false);
  assert.equal(entity.linkedin('urn:li:sponsoredCampaign:123'), true);
  for (const id of ['urn:li:sponsoredCampaign:0123', 'urn:li:sponsoredCreative:1', '123'])
    assert.equal(entity.linkedin(id), false, id);
  const graph = runtimeGraph(process.cwd());
  assert.equal(graph.get('src/report-allocation.ts').has('src/snapchat-evidence.ts'), false);
});

test('the report table is shared: the Sheets client re-exports it, and its exporters import no Sheets module', () => {
  for (const name of ['assertReportExportable', 'exportCsv', 'recommendationBasis', 'reportTable'])
    assert.equal(sheets[name], table[name], name + ': one function, two import paths');
  const graph = runtimeGraph(process.cwd());
  for (const id of ['src/report-artifacts.ts', 'src/report-file-delivery.ts', 'server/report-download-routes.ts'])
    assert.equal(graph.get(id).has('src/google-sheets.ts'), false, id);
  // A Sheets destination's connection is resolved under the Sheets provider adapter's gateway.
  assert.equal(providerById('sheets').gateway, sheets.sheetsGateway);
});

test('the workbook resource selectors are their providers’ own, accepting and refusing what the shared table did', async () => {
  // ARC-01 (reporting): which account a saved native query's resource selector names left
  // src/report-resource-scope.ts and src/report-runs.ts for the providers' reportScope hooks (src/<provider>-adapter.ts).
  // Each case is what the shared table answered: the account, or the REPORT_SCOPE_UNAVAILABLE refusal (null).
  const scope = await import('../dist/src/report-resource-scope.js'),
    {registeredProviderHooks} = await import('../dist/src/provider-hooks.js');
  assert.deepEqual(
    registeredProviderHooks.filter(hooks => hooks.reportScope).map(hooks => hooks.gateway),
    [
      'google_business_native_action',
      'reddit_native_action',
      'ga4_native_action',
      'gtm_native_action',
      'google_search_console_native_action',
    ],
  );
  const refused = (f, label) => assert.throws(f, e => e.code === 'REPORT_SCOPE_UNAVAILABLE' && e.status === 403, label);
  const cases = {
    ga4_native_action: [
      ['property', '100', '100'],
      ['property', 'properties/100', '100'],
      ['property', 'properties/abc', null],
      ['resource', 'properties/100/reportTasks/opaque-task_7', '100'],
      ['resource', 'properties/100', '100'],
      ['resource', 'properties/100/../200', null],
      ['resource', 'properties/100/a%2Fb', null],
      ['account', '100', null],
      ['site', '100', null],
    ],
    google_search_console_native_action: [
      ['site', 'sc-domain:example.com', 'sc-domain:example.com'],
      ['site', 'https://example.com/', 'https://example.com/'],
      ['site', 'https://user:secret@example.com/', null],
      ['site', 'https://' + 'a'.repeat(200) + '.com/', null],
      ['site', 'example.com', null],
      ['account', 'sc-domain:example.com', null],
    ],
    reddit_native_action: [
      ['account', 't2_ab-C9', 't2_ab-C9'],
      ['account', 'a.b', null],
      ['resource', 'abc', null],
    ],
    gtm_native_action: [
      ['account', '123', '123'],
      ['account', 'accounts/123', '123'],
      ['account', 'locations/9', null],
      ['resource', 'accounts/123/containers/4', '123'],
      ['resource', 'accounts/123/../9', null],
      ['resource', 'locations/9/media/x', null],
      ['location', '9', null],
    ],
    google_business_native_action: [
      ['account', 'locations/9', 'locations/9'],
      ['account', 'accounts/12', '12'],
      ['account', '12', '12'],
      ['location', '9', 'locations/9'],
      ['location', 'locations/9', 'locations/9'],
      ['location', 'accounts/9', null],
      ['resource', 'locations/9/media/x', 'locations/9'],
      ['resource', 'accounts/12/locations/9', '12'],
      ['resource', 'accounts/12/./x', null],
      ['resource', 'other/12', null],
    ],
    meta_native_action: [['account', '123', null]],
  };
  for (const [gateway, rows] of Object.entries(cases))
    for (const [kind, value, account] of rows) {
      const label = gateway + ' ' + kind + ' ' + value;
      if (account === null) refused(() => scope.reportingResourceAccount(gateway, {kind, value}), label);
      else assert.equal(scope.reportingResourceAccount(gateway, {kind, value}), account, label);
    }
  // The shared bounds come first, whatever the provider: a non-text, empty, long or spaced value is refused.
  for (const value of [undefined, 1, '', 'a'.repeat(513), 'accounts/1 2', 'accounts\\1'])
    refused(() => scope.reportingResourceAccount('gtm_native_action', {kind: 'account', value}), String(value));
  // Business Profile's location selectors check the consistency of the account parent beside them.
  const business = (rows, existing = []) =>
    scope.reportingResourceAccounts('google_business_native_action', rows, existing);
  assert.deepEqual(business([{kind: 'location', value: '9'}]), ['locations/9']);
  assert.deepEqual(
    business([
      {kind: 'location', value: '9'},
      {kind: 'account', value: '12'},
    ]),
    ['12'],
  );
  assert.deepEqual(business([{kind: 'location', value: '9'}], ['12']), []);
  assert.deepEqual(
    business([
      {kind: 'location', value: '9'},
      {kind: 'resource', value: 'locations/9/media/x'},
    ]),
    ['locations/9'],
  );
  refused(
    () =>
      business([
        {kind: 'location', value: '9'},
        {kind: 'resource', value: 'locations/8/media/x'},
      ]),
    '8',
  );
  refused(() => business([{kind: 'location', value: '9'}], ['locations/8']), 'existing');
  assert.deepEqual(
    scope.reportingResourceAccounts(
      'ga4_native_action',
      [
        {kind: 'property', value: '1'},
        {kind: 'property', value: '2'},
      ],
      [],
    ),
    ['1', '2'],
  );
  // A run's anchors in resource form: GA4's properties/, Tag Manager's and Business Profile's accounts/.
  assert.deepEqual(
    [
      ['ga4_native_action', 'properties/1'],
      ['ga4_native_action', 'accounts/1'],
      ['gtm_native_action', 'accounts/1'],
      ['google_business_native_action', 'accounts/1'],
      ['google_business_native_action', 'locations/1'],
      ['reddit_native_action', 'accounts/1'],
      ['meta_native_action', 'properties/1'],
    ].map(([gateway, anchor]) => scope.reportingAnchorKind(gateway, anchor) ?? null),
    ['property', null, 'account', 'account', null, null, null],
  );
});

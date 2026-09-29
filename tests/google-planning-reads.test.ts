import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import type {Actor, JsonObject} from '../src/types.js';

// Keyword Planner, Audience Insights, Reach Planner, benchmarks and brand, creator and theme suggestions: planning reads
// the owner uses for keyword research without the Google Ads interface. Each request is shaped from the pinned v25
// contract; each must reach Google once, at its documented path, on a read-only deployment and for a reader.
const registry = new Registry(),
  reader: Actor = {tenantId: 'planning', userId: 'reader', role: 'reader'},
  account = '1234567890',
  geo = 'geoTargetConstants/2840',
  lang = 'languageConstants/1000',
  group = 'Planning',
  audience = {countryLocations: [{geoTargetConstant: geo}]};
const requests: Record<string, [path: string, payload: JsonObject]> = {
  keyword_plan_idea_generate_keyword_ideas: [
    ':generateKeywordIdeas',
    {
      language: lang,
      geoTargetConstants: [geo],
      keywordPlanNetwork: 'GOOGLE_SEARCH',
      keywordSeed: {keywords: ['shoes']},
    },
  ],
  keyword_plan_idea_generate_keyword_historical_metrics: [
    ':generateKeywordHistoricalMetrics',
    {keywords: ['shoes'], language: lang, geoTargetConstants: [geo], keywordPlanNetwork: 'GOOGLE_SEARCH'},
  ],
  keyword_plan_idea_generate_ad_group_themes: [
    ':generateAdGroupThemes',
    {keywords: ['shoes'], adGroups: ['customers/' + account + '/adGroups/111']},
  ],
  keyword_plan_idea_generate_keyword_forecast_metrics: [
    ':generateKeywordForecastMetrics',
    {
      campaign: {
        biddingStrategy: {manualCpcBiddingStrategy: {maxCpcBidMicros: '1000000'}},
        adGroups: [{keywords: [{text: 'shoes', matchType: 'BROAD'}]}],
        languageConstants: [lang],
        geoTargetConstants: [geo],
      },
      forecastPeriod: {startDate: '2026-10-01', endDate: '2026-10-31'},
    },
  ],
  audience_insights_list_audience_insights_attributes: [
    ':searchAudienceInsightsAttributes',
    {dimensions: ['AFFINITY_USER_INTEREST'], queryText: 'running', customerInsightsGroup: group},
  ],
  audience_insights_list_insights_eligible_dates: ['/audienceInsights:listInsightsEligibleDates', {}],
  audience_insights_generate_insights_finder_report: [
    ':generateInsightsFinderReport',
    {baselineAudience: audience, specificAudience: audience, customerInsightsGroup: group},
  ],
  audience_insights_generate_audience_composition_insights: [
    ':generateAudienceCompositionInsights',
    {audience, dimensions: ['AFFINITY_USER_INTEREST'], customerInsightsGroup: group},
  ],
  audience_insights_generate_audience_definition: [
    ':generateAudienceDefinition',
    {
      audienceDescription: {
        audienceDescription: 'people who run marathons',
        countryLocations: [{geoTargetConstant: geo}],
      },
      customerInsightsGroup: group,
    },
  ],
  audience_insights_generate_audience_overlap_insights: [
    ':generateAudienceOverlapInsights',
    {
      countryLocation: {geoTargetConstant: geo},
      primaryAttribute: {location: {geoTargetConstant: geo}},
      dimensions: ['AFFINITY_USER_INTEREST'],
      customerInsightsGroup: group,
    },
  ],
  audience_insights_generate_suggested_targeting_insights: [
    ':generateSuggestedTargetingInsights',
    {audienceDefinition: {audience}, customerInsightsGroup: group},
  ],
  audience_insights_generate_targeting_suggestion_metrics: [
    ':generateTargetingSuggestionMetrics',
    {audiences: [audience], customerInsightsGroup: group},
  ],
  keyword_theme_constant_suggest_keyword_theme_constants: [
    '/keywordThemeConstants:suggest',
    {queryText: 'shoes', countryCode: 'US', languageCode: 'en'},
  ],
  smart_campaign_suggest_suggest_keyword_themes: [
    ':suggestKeywordThemes',
    {suggestionInfo: {finalUrl: 'https://example.com', languageCode: 'en'}},
  ],
  reach_plan_generate_reach_forecast: [
    ':generateReachForecast',
    {
      campaignDuration: {durationInDays: 30},
      plannedProducts: [{plannableProductCode: 'TRUEVIEW_IN_STREAM', budgetMicros: '1000000000'}],
      targeting: {plannableLocationIds: ['2840']},
    },
  ],
  reach_plan_list_plannable_products: [':listPlannableProducts', {plannableLocationId: '2840'}],
  reach_plan_list_plannable_locations: [':listPlannableLocations', {}],
  reach_plan_list_plannable_user_interests: [':listPlannableUserInterests', {}],
  reach_plan_list_plannable_user_lists: [':listPlannableUserLists', {}],
  reach_plan_generate_conversion_rates: [':generateConversionRates', {}],
  brand_suggestion_suggest_brands: [':suggestBrands', {brandPrefix: 'run'}],
  benchmarks_list_benchmarks_sources: [':listBenchmarksSources', {benchmarksSources: ['INDUSTRY_VERTICAL']}],
  benchmarks_list_benchmarks_locations: [':listBenchmarksLocations', {}],
  benchmarks_list_benchmarks_products: [':listBenchmarksProducts', {}],
  benchmarks_list_benchmarks_available_dates: [':listBenchmarksAvailableDates', {}],
  benchmarks_generate_benchmarks_metrics: [
    ':generateBenchmarksMetrics',
    {
      benchmarksSource: {industryVerticalId: '10001'},
      productFilter: {productList: {productCodes: ['SEARCH']}},
      location: {geoTargetConstant: geo},
    },
  ],
  content_creator_insights_generate_creator_insights: [
    ':generateCreatorInsights',
    {customerInsightsGroup: group, countryLocations: [{geoTargetConstant: geo}]},
  ],
  content_creator_insights_generate_trending_insights: [
    ':generateTrendingInsights',
    {customerInsightsGroup: group, countryLocation: {geoTargetConstant: geo}},
  ],
};
/** Where a request lands: under the customer, or outside any customer for the documented global reads. */
const landing = (path: string) =>
  path.startsWith(':') && !/^:(list(?:Plannable|Benchmarks)\w+|generateConversionRates)$/.test(path)
    ? '/v25/customers/' + account + path
    : '/v25' + path;
const snake = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(snake)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v).map(([k, x]) => [k.replace(/[A-Z]/g, c => '_' + c.toLowerCase()), snake(x)]),
        )
      : v;
function setup() {
  const store = new Store(':memory:', Buffer.alloc(32, 91).toString('base64'));
  store.putConnection(
    {...reader, role: 'admin'},
    {
      id: 'aaaaaaaa-9191-4191-8191-919191919191',
      tenantId: reader.tenantId,
      gateway: 'google_ads_native_action',
      accounts: [account],
      writeAccounts: [],
      enabled: true,
      label: 'Planning',
      scopes: ['https://www.googleapis.com/auth/adwords'],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const sent: {method: string; path: string; body: JsonObject}[] = [];
  const transport = new NativeTransport((async (url, init) => {
    sent.push({
      method: init!.method!,
      path: new URL(String(url)).pathname,
      body: JSON.parse(String(init!.body ?? '{}')),
    });
    return Response.json({results: [{planned: true}]});
  }) as typeof fetch);
  // Writes are off: planning reads never need them.
  return {
    store,
    sent,
    service: new MirrorService(registry, store, transport, undefined, {
      allowWrites: false,
      requireBeforeState: true,
      maxBudgetChange: 0,
    }),
  };
}

test('every Google planning and insights read reaches its documented path once, for a reader, with writes off', async () => {
  const x = setup();
  try {
    const failed: string[] = [];
    for (const [short, [path, payload]] of Object.entries(requests)) {
      x.sent.length = 0;
      const r = await x.service.call(
        'google_ads_native_action',
        {action: 'google_ads_v23_' + short, account_id: account, payload},
        reader,
      );
      if (!r.success) failed.push(short + ': ' + r.error.code + ' ' + r.error.message);
      else {
        assert.deepEqual(
          x.sent.map(s => s.method + ' ' + s.path),
          ['POST ' + landing(path)],
          short,
        );
        assert.deepEqual(x.sent[0]!.body, payload, short);
      }
    }
    assert.deepEqual(failed, []);
  } finally {
    x.store.close();
  }
});

test('the 17 legacy planning names reach the same documented paths', async () => {
  const legacy: Record<string, string> = {
    GENERATE_KEYWORD_IDEAS: 'keyword_plan_idea_generate_keyword_ideas',
    GENERATE_KEYWORD_HISTORICAL_METRICS: 'keyword_plan_idea_generate_keyword_historical_metrics',
    GENERATE_KEYWORD_FORECAST_METRICS: 'keyword_plan_idea_generate_keyword_forecast_metrics',
    GENERATE_AD_GROUP_THEMES: 'keyword_plan_idea_generate_ad_group_themes',
    GENERATE_REACH_FORECAST: 'reach_plan_generate_reach_forecast',
    LIST_PLANNABLE_LOCATIONS: 'reach_plan_list_plannable_locations',
    LIST_PLANNABLE_PRODUCTS: 'reach_plan_list_plannable_products',
    LIST_PLANNABLE_USER_INTERESTS: 'reach_plan_list_plannable_user_interests',
    LIST_PLANNABLE_USER_LISTS: 'reach_plan_list_plannable_user_lists',
    SUGGEST_BRANDS: 'brand_suggestion_suggest_brands',
    LIST_BENCHMARKS_SOURCES: 'benchmarks_list_benchmarks_sources',
    LIST_BENCHMARKS_LOCATIONS: 'benchmarks_list_benchmarks_locations',
    LIST_BENCHMARKS_PRODUCTS: 'benchmarks_list_benchmarks_products',
    LIST_BENCHMARKS_AVAILABLE_DATES: 'benchmarks_list_benchmarks_available_dates',
    GENERATE_BENCHMARKS_METRICS: 'benchmarks_generate_benchmarks_metrics',
    GENERATE_CREATOR_INSIGHTS: 'content_creator_insights_generate_creator_insights',
    GENERATE_TRENDING_INSIGHTS: 'content_creator_insights_generate_trending_insights',
  };
  assert.equal(Object.keys(legacy).length, 17);
  const x = setup();
  try {
    const failed: string[] = [];
    for (const [name, short] of Object.entries(legacy)) {
      const [path, payload] = requests[short]!;
      x.sent.length = 0;
      // The legacy surface takes the protobuf field names.
      const r = await x.service.call(
        'google_ads_native_action',
        {action: name, account_id: account, params: snake(payload)},
        reader,
      );
      if (!r.success) failed.push(name + ': ' + r.error.code + ' ' + r.error.message);
      else
        assert.deepEqual(
          x.sent.map(s => s.method + ' ' + s.path),
          ['POST ' + landing(path)],
          name,
        );
    }
    assert.deepEqual(failed, []);
  } finally {
    x.store.close();
  }
});

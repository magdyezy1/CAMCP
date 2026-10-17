// Captures normalizeNativeRow outputs of the current build for synthetic rows of every report platform: the golden rows of
// tests/report-source-golden.test.mjs (ARC-04 stage F). Regenerate them only for an intended normalization change, and
// say so in the commit:  npm run build && node tools/report-source-golden.mjs . tests/fixtures/report-source-golden.json
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const [repo, out] = process.argv.slice(2);
const {normalizeNativeRow, missingNativeMetrics} = await import(
  pathToFileURL(path.join(repo, 'dist/src/report-native.js')).href
);
const cases = [
  // Google Ads: full row with a native extra metric and a daily segment; no metrics; null metrics; numeric id.
  [
    'google',
    {
      campaign: {id: '1', name: 'Google campaign', status: 'ENABLED'},
      customer: {currencyCode: 'USD'},
      metrics: {
        costMicros: '1500000',
        impressions: '10',
        clicks: '2',
        conversions: 1.5,
        conversionsValue: '20.5',
        videoViews: '3',
        engagements: '4',
        allConversions: '2.5',
        allConversionsValue: 7,
      },
      segments: {date: '2026-10-01'},
    },
  ],
  ['google', {campaign: {id: 2}}],
  ['google', {campaign: {id: '3', name: 'No metrics'}, metrics: null, customer: null}],
  ['google', {campaign: {id: '4', name: 'Strings'}, metrics: {costMicros: 'abc', impressions: '1e3', clicks: -2}}],
  // Meta: delivered with actions; delivered and omitted actions; not delivered; non-array actions; unknown objective.
  [
    'meta',
    {
      campaign_id: '1',
      campaign_name: 'Leads',
      objective: 'OUTCOME_LEADS',
      account_id: '100',
      date_start: '2026-10-01',
      date_stop: '2026-10-01',
      spend: '12.34',
      impressions: '100',
      clicks: '5',
      reach: '80',
      frequency: '1.25',
      actions: [
        {action_type: 'lead', value: '3'},
        {action_type: 'video_view', value: '7'},
        {action_type: 'post_engagement', value: '11'},
      ],
      action_values: [{action_type: 'purchase', value: '9.5'}],
      cost_per_action_type: [{action_type: 'lead', value: '4.11'}],
    },
  ],
  ['meta', {campaign_id: '2', campaign_name: 'Sales', objective: 'OUTCOME_SALES', impressions: '50', spend: '1'}],
  ['meta', {campaign_id: '3', objective: 'OUTCOME_APP_PROMOTION', impressions: '0'}],
  ['meta', {campaign_id: '4', objective: 'OUTCOME_LEADS', impressions: '9', actions: 'not-an-array'}],
  [
    'meta',
    {
      campaign_id: '5',
      objective: 'SOMETHING_NEW',
      impressions: '9',
      actions: [
        {action_type: 'omni_purchase', value: '2'},
        {action_type: 'app_install', value: '1'},
      ],
    },
  ],
  [
    'meta',
    {
      campaign_id: '6',
      objective: 'OUTCOME_SALES',
      impressions: '9',
      actions: [{action_type: 'offsite_conversion.fb_pixel_purchase', value: '2'}],
      action_values: [],
    },
  ],
  // TikTok: one optimization event; mixed events; none.
  [
    'tiktok',
    {
      dimensions: {campaign_id: '1'},
      metrics: {
        campaign_name: 'TikTok',
        spend: '1.5',
        impressions: '10',
        clicks: '1',
        conversion: '2',
        reach: '8',
        frequency: '1.2',
        video_play_actions: '5',
        video_views_p100: '1',
        total_purchase: '1',
        total_purchase_value: '9.99',
        likes: '3',
      },
      objective_type: 'CONVERSIONS',
      optimization_events: ['ON_WEB_ORDER'],
    },
  ],
  ['tiktok', {dimensions: {campaign_id: '2'}, metrics: {campaign_name: 'Mixed'}, optimization_events: ['A', 'B']}],
  ['tiktok', {dimensions: {campaign_id: '3'}}],
  // Snapchat: the objective chooses the conversions.
  [
    'snapchat',
    {
      id: 's1',
      name: 'Leads',
      objective: 'LEAD_GENERATION',
      stats: {
        spend: 2000000,
        impressions: 10,
        swipes: 2,
        conversion_purchases: 1,
        conversion_purchases_value: 5000000,
        conversion_sign_ups: 3,
        total_installs: 4,
        video_views: 5,
        view_completion: 6,
      },
    },
  ],
  ['snapchat', {id: 's2', name: 'Installs', objective: 'APP_INSTALLS', stats: {total_installs: 7}}],
  ['snapchat', {id: 's3', name: 'Sales', objective: 'WEB_CONVERSION', stats: {conversion_purchases: 2}}],
  ['snapchat', {id: 's4', objective: 'AWARENESS'}],
  // LinkedIn.
  [
    'linkedin',
    {
      pivotValues: ['urn:li:sponsoredCampaign:123'],
      name: 'LinkedIn',
      objectiveType: 'LEAD_GENERATION',
      costInLocalCurrency: '10.5',
      impressions: 100,
      clicks: 2,
      externalWebsiteConversions: 1,
      conversionValueInLocalCurrency: '3',
      oneClickLeads: 2,
      videoViews: 1,
      videoCompletions: 0,
      likes: 4,
    },
  ],
  ['linkedin', {pivotValues: ['urn:li:sponsoredCampaign:124']}],
  // X: metrics come prepared.
  [
    'x',
    {id: 'x1', name: 'X campaign', objective: 'WEBSITE_CLICKS', metrics: {spend: 1.2, impressions: 3, engagements: 1}},
  ],
  ['x', {id: 'x2'}],
  // Microsoft Advertising.
  [
    'microsoft',
    {
      CampaignId: '5',
      CampaignName: 'Microsoft',
      CurrencyCode: 'USD',
      Spend: '1.23',
      Impressions: '10',
      Clicks: '1',
      Conversions: '0.5',
      Revenue: '2',
      AllConversions: '1',
    },
  ],
  ['microsoft', {CampaignId: 6}],
  // Apple Ads.
  [
    'apple',
    {
      metadata: {id: 7, name: 'Apple'},
      totalMetrics: {
        localSpend: {amount: '1.5', currency: 'USD'},
        impressions: 10,
        taps: 2,
        totalInstalls: 3,
        newDownloads: 1,
      },
    },
  ],
  ['apple', {metadata: {id: 8}, totalMetrics: {}}],
  ['apple', {metadata: {id: 9}}],
  // Reddit: upper- and lower-case fields.
  [
    'reddit',
    {
      campaign_id: 'r1',
      campaign_name: 'Reddit',
      objective: 'CONVERSIONS',
      SPEND: 2000000,
      IMPRESSIONS: 10,
      CLICKS: 1,
      CONVERSION_PURCHASE_TOTAL_ITEMS: 1,
      CONVERSION_PURCHASE_TOTAL_VALUE: 1999,
      VIDEO_STARTED: 4,
    },
  ],
  [
    'reddit',
    {
      CAMPAIGN_ID: 'r2',
      spend: 1000000,
      impressions: 5,
      clicks: 1,
      conversion_purchase_total_items: 2,
      conversion_purchase_total_value: 250,
    },
  ],
  // GA4: a null native metric is kept.
  [
    'ga4',
    {
      campaign_id: 'g1',
      campaign_name: 'GA4',
      sessions: '10',
      totalUsers: '7',
      keyEvents: '2',
      totalRevenue: '9.5',
      ecommercePurchases: '1',
      engagementRate: null,
      bounceRate: '0.4',
    },
  ],
  ['ga4', {campaign_id: '(not set)'}],
  // Search Console.
  ['gsc', {keys: ['https://example.com/'], clicks: 3, impressions: 30, position: 4.5, ctr: 0.1}],
  ['gsc', {clicks: 1}],
  // Refusals: no identifier, an unsafe numeric identifier, an unknown platform.
  ['google', {campaign: {}}],
  ['google', {campaign: {id: 9007199254740993}}],
  ['meta', {campaign_name: 'No id'}],
  ['linkedin', {pivotValues: []}],
  ['other', {id: '1'}],
];
const records = cases.map(([platform, raw]) => {
  try {
    return {platform, raw, output: normalizeNativeRow(platform, structuredClone(raw))};
  } catch (error) {
    return {platform, raw, error: {code: error.code, message: error.message, status: error.status}};
  }
});
// missingNativeMetrics over the normalized rows, per platform with requested extras.
const requested = {
  google: ['metrics.all_conversions', 'metrics.interactions'],
  meta: ['cost_per_action_type', 'inline_link_clicks'],
  tiktok: ['likes', 'shares'],
  snapchat: ['video_views', 'total_installs', 'swipe_ups'],
  linkedin: ['likes', 'shares'],
  microsoft: ['AllConversions', 'Assists'],
  apple: ['newDownloads'],
  reddit: ['VIDEO_STARTED', 'VIDEO_VIEWABLE_IMPRESSIONS'],
  ga4: ['bounceRate', 'eventCount'],
  gsc: ['ctr'],
  x: ['VIDEO'],
};
const missing = Object.fromEntries(
  Object.entries(requested).map(([platform, names]) => [
    platform,
    missingNativeMetrics(
      platform,
      names,
      records.filter(r => r.platform === platform && r.output).map(r => r.output),
    ),
  ]),
);
fs.writeFileSync(out, JSON.stringify({schema_version: 1, records, missing}, null, 2) + '\n');
console.log(JSON.stringify({records: records.length, errors: records.filter(r => r.error).length}));

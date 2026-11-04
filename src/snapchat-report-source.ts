import {objectiveGroup} from './report-metrics.js';
import {overviewCapabilities, invalidReportSource, nextDay, reportList, type ReportSource} from './report-source.js';
import {snapchatDetailParents} from './snapchat-detail-parents.js';
import {snapchatGuidedReporting} from './snapchat-guided-reports.js';
import type {JsonObject} from './types.js';
import {zonedMidnight} from './workflows.js';
import {mappedReportResult, type ReportResultRules} from './report-results.js';

/** Native optimization goals, not broad campaign objectives. Unpinned/app-source-specific goals stay unknown. */
export const snapchatResultRules: ReportResultRules = {
  selectors: [
    {
      field: 'goal',
      required: true,
      values: Object.fromEntries(
        [
          ['IMPRESSIONS', 'impressions', 'Impressions'],
          ['SWIPES', 'swipes', 'Swipes'],
          ['APP_INSTALLS', 'total_installs', 'Installs'],
          ['VIDEO_VIEWS', 'video_views', 'Video views'],
          ['VIDEO_VIEWS_15_SEC', 'video_views_15s', '15-second video views'],
          ['STORY_OPENS', 'story_opens', 'Story opens'],
          ['LANDING_PAGE_VIEW', 'landing_page_views', 'Landing page views'],
          ['LEAD_FORM_SUBMISSIONS', 'native_leads', 'Lead form submissions'],
          ['PIXEL_PAGE_VIEW', 'conversion_page_views', 'Pixel page views'],
          ['PIXEL_ADD_TO_CART', 'conversion_add_cart', 'Pixel adds to cart'],
          ['PIXEL_PURCHASE', 'conversion_purchases', 'Pixel purchases'],
          ['PIXEL_SIGNUP', 'conversion_sign_ups', 'Pixel sign-ups'],
        ].map(([goal, metric, label]) => [
          goal!,
          {
            id: 'snapchat:' + goal,
            metric: metric!,
            label: label!,
            native_metric: 'stats.' + metric,
            aggregation: 'sum' as const,
            unit: 'number' as const,
            ...(goal === 'IMPRESSIONS' ? {cost_multiplier: 1000 as const} : {}),
          },
        ]),
      ),
    },
  ],
};

/** Snapchat campaign stats rows (micros); conversions follow the campaign objective. */
export const snapchatReportSource: ReportSource = {
  platform: 'snapchat',
  requiresCompleteWindowDeclaration: true,
  overview: overviewCapabilities(
    [
      {id: 'campaign', label: 'Campaign', native_type: 'campaign'},
      {id: 'adset', label: 'Ad squad', native_type: 'adsquad', preset: 'snapchat_adsquad'},
      {id: 'ad', label: 'Ad', native_type: 'ad', preset: 'snapchat_ad'},
    ],
    {swipe_up_attribution_window: '28_DAY', view_attribution_window: '1_DAY'},
    [],
    options => {
      if (
        !['1_DAY', '7_DAY', '28_DAY'].includes(options.swipe_up_attribution_window) ||
        !['none', '1_HOUR', '3_HOUR', '6_HOUR', '1_DAY', '7_DAY'].includes(options.view_attribution_window) ||
        (options.view_attribution_window === '7_DAY' && options.swipe_up_attribution_window === '1_DAY')
      )
        invalidReportSource(
          'Choose supported Snapchat swipe and view windows. Seven-day view requires at least seven-day swipe.',
        );
    },
    {
      campaign_options: ['swipe_up_attribution_window', 'view_attribution_window'],
      detail_options: ['complete_window', 'swipe_up_attribution_window', 'view_attribution_window'],
      requires_complete: true,
    },
  ),
  resultRules: snapchatResultRules,
  readResult(raw, context) {
    return mappedReportResult(snapchatResultRules, {goal: context.goal ?? raw.optimization_goal}, raw, {
      spend: raw.stats?.spend,
      spend_divisor: 1e6,
    });
  },
  objectives: {
    name: 'Snapchat',
    values: {
      BRAND_AWARENESS: 'awareness',
      ENGAGEMENT: 'engagement',
      PROMOTE_STORIES: 'engagement',
      PROMOTE_PLACES: 'engagement',
      VIDEO_VIEW: 'video_views',
      LEAD_GENERATION: 'leads',
      WEB_CONVERSION: 'sales',
      CATALOG_SALES: 'sales',
      APP_CONVERSION: 'sales',
      APP_INSTALL: 'app_installs',
      AWARENESS_AND_ENGAGEMENT: 'awareness',
      TRAFFIC: 'traffic',
      LEADS: 'leads',
      SALES: 'sales',
      APP_PROMOTION: 'app_installs',
    },
    missingReason: 'Snapchat returned no objective for this campaign.',
  },
  nativeMetricExamples: [
    'video_views',
    'view_completion',
    'conversion_purchases',
    'conversion_purchases_value',
    'conversion_sign_ups',
    'total_installs',
  ],
  nativeMetricContainer: 'stats',
  // The stats and the campaign inventory.
  minimumRequestsPerPeriod: 2,
  guided: snapchatGuidedReporting,
  /**
   * One account stats read by campaign over the account-local period, with the default windows or a campaign-level
   * attribution profile (RPT-04), then the account's campaigns for names and objectives.
   */
  async collect(c) {
    if (!c.timezone) invalidReportSource('Snapchat account timezone is required.');
    // RPT-04: an optional campaign-level attribution profile uses the detailed preset's windows and conversion time.
    const profile = c.attributionProfile(),
      swipe = profile?.swipe_up_attribution_window ?? '28_DAY',
      view = profile?.view_attribution_window ?? '1_DAY';
    const start = new Date(zonedMidnight(c.range.since, c.timezone!, true)).toISOString(),
      end = new Date(zonedMidnight(nextDay(c.range.until), c.timezone!, true)).toISOString();
    const d = await c.run(
      c.plan('/v1/adaccounts/' + c.account + '/stats', {
        granularity: 'TOTAL',
        breakdown: 'campaign',
        start_time: start,
        end_time: end,
        fields: [
          ...new Set([
            'spend',
            'impressions',
            'swipes',
            'conversion_purchases',
            'conversion_purchases_value',
            'conversion_sign_ups',
            'total_installs',
            'video_views',
            'view_completion',
            ...c.extra,
          ]),
        ].join(','),
        swipe_up_attribution_window: swipe,
        view_attribution_window: view,
        ...(profile ? {action_report_time: 'conversion', conversion_source_types: 'total'} : {}),
        omit_empty: false,
      }),
    );
    c.raw = reportList(d.total_stats ?? []).flatMap(r => reportList(r.total_stat?.breakdown_stats?.campaign ?? []));
    const campaigns = reportList(
      (await c.run(c.plan('/v1/adaccounts/' + c.account + '/campaigns'))).campaigns ?? [],
    ).map(r => r.campaign);
    c.raw = c.raw.map(r => ({
      ...r,
      name: campaigns.find(campaign => campaign.id === r.id)?.name,
      objective:
        campaigns.find(campaign => campaign.id === r.id)?.objective_v2_properties?.objective_v2_type ??
        campaigns.find(campaign => campaign.id === r.id)?.objective,
    }));
    c.attribution = profile
      ? 'Snapchat ' + swipe + ' swipe / ' + view + ' view; conversion time; total sources'
      : '28-day swipe / 1-day view';
    c.resultDefinition = 'Objective-specific purchases, sign-ups or installs when explicitly requested';
  },
  normalize(raw, {value}) {
    const objective = raw.objective,
      m = raw.stats ?? {};
    const metrics: JsonObject = {
      spend: value(m.spend, 1e6),
      impressions: value(m.impressions),
      clicks: value(m.swipes),
      purchases: value(m.conversion_purchases),
      conversion_value: value(m.conversion_purchases_value, 1e6),
      leads: value(m.conversion_sign_ups),
      installs: value(m.total_installs),
      video_views: value(m.video_views),
      video_completions: value(m.view_completion),
    };
    metrics.conversions =
      objectiveGroup(objective) === 'app_installs'
        ? metrics.installs
        : objectiveGroup(objective) === 'leads'
          ? metrics.leads
          : objectiveGroup(objective) === 'sales'
            ? metrics.purchases
            : null;
    return {id: raw.id, name: raw.name, objective, metrics};
  },
  // Wave 4c round 6 (w4c-arc6-reporting): the native parents of its detailed ad rows (RPT-07).
  detailParents: snapchatDetailParents,
};

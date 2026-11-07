import {metaWindowsOrdered} from './meta-attribution-windows.js';
import {metaGuidedReporting} from './meta-guided-reports.js';
import {metaCampaignRows} from './meta-report.js';
import {metaPrefix} from './meta-version.js';
import {byObjectiveGroup, metricNumber} from './report-metrics.js';
import {overviewCapabilities, invalidReportSource, type ReportSource} from './report-source.js';
import type {JsonObject} from './types.js';
import {
  metaMappedDefinition,
  metaRequestedWindows,
  metaResult,
  metaResultDefinition,
  metaResultRules,
  metaWindowCount,
} from './meta-report-results.js';
import {metaWindowsValid, metaWindowsMessage} from './meta-attribution-windows.js';
import {reportStatus} from './report-status.js';
import {metaReportMetadata} from './meta-report-metadata.js';
import {overviewEntityLevels} from './overview-levels.js';
import {providerById} from './provider-adapters.js';

const metaWindows = providerById('meta')!.reportWindows!;

/** Meta campaign insights rows: actions and action_values arrays; conversions follow the campaign objective. */
export const metaReportSource: ReportSource = {
  platform: 'meta',
  readStatus(raw, {metadata = raw.entity_metadata}) {
    return reportStatus(
      metadata?.configured_status ?? metadata?.status,
      {ACTIVE: 'active', PAUSED: 'paused', ARCHIVED: 'archived', DELETED: 'archived'},
      metadata?.effective_status,
    );
  },
  detailParents: metaReportMetadata,
  overview: overviewCapabilities(
    overviewEntityLevels.meta!,
    {attribution_windows: ['7d_click', '1d_view']},
    ['result_action_type'],
    (options, context) => {
      const configured = options.attribution_windows === null && context?.levels.every(level => level === 'campaign');
      if (!configured && !metaWindowsValid(options.attribution_windows)) invalidReportSource(metaWindowsMessage);
      if (
        options.result_action_type !== undefined &&
        (typeof options.result_action_type !== 'string' || !/^[a-z][a-z0-9_.]{0,159}$/.test(options.result_action_type))
      )
        invalidReportSource('Choose one exact Meta result action.');
    },
    {
      campaign_options: ['attribution_windows'],
      detail_options: ['complete_window', 'result_action_type', 'attribution_windows'],
      requires_action: true,
      provider_configured_options: ['attribution_windows'],
    },
    // What the editor offers: Meta's windows in the order AMCP sends them, one click window at most (F-L5-15).
    {
      attribution_windows: {
        label: 'Click attribution window',
        values: metaWindows.windows,
        exclusive: metaWindows.clickWindows,
        notes: {'1d_ev': 'engaged view'},
      },
    },
  ),
  resultRules: metaResultRules,
  readResult: metaResult,
  objectives: {
    name: 'Meta',
    values: {
      OUTCOME_AWARENESS: 'awareness',
      OUTCOME_TRAFFIC: 'traffic',
      OUTCOME_ENGAGEMENT: 'engagement',
      OUTCOME_LEADS: 'leads',
      OUTCOME_SALES: 'sales',
      OUTCOME_APP_PROMOTION: 'app_installs',
    },
    missingReason: 'Meta returned no objective for this campaign.',
  },
  nativeMetricExamples: [
    'inline_link_clicks',
    'outbound_clicks',
    'unique_clicks',
    'video_play_actions',
    'video_p25_watched_actions',
    'video_p50_watched_actions',
    'video_p75_watched_actions',
    'video_p100_watched_actions',
    'cost_per_action_type',
  ],
  minimumRequestsPerPeriod: 1,
  requestsPerPeriod: (level, contract) => (contract === 'overview-config-v4' ? (level === 'campaign' ? 2 : 4) : 1),
  // RPT-03: one request with time_increment=1; a row that names its last day must end on the day it starts.
  daily: {
    day: native => native?.date_start,
    endsOn: (native, day) => native?.date_stop === undefined || native.date_stop === day,
  },
  guided: metaGuidedReporting,
  /**
   * One campaign Insights read over the period, under the ad sets' unified attribution setting or, with a
   * campaign-level attribution profile (RPT-04), the detailed preset's explicit windows at impression time.
   */
  async collect(c) {
    // RPT-04: an optional campaign-level attribution profile uses the detailed preset's explicit windows.
    const profile = c.attributionProfile(),
      windows = profile ? metaWindowsOrdered(profile.attribution_windows) : undefined;
    c.raw = metaCampaignRows(
      await c.run(
        c.plan(metaPrefix + 'act_' + c.account + '/insights', {
          level: 'campaign',
          time_range: {since: c.range.since, until: c.range.until},
          fields: [
            ...new Set([
              'account_id',
              'account_name',
              'date_start',
              'date_stop',
              'campaign_id',
              'campaign_name',
              'objective',
              'spend',
              'impressions',
              'clicks',
              'reach',
              'frequency',
              'actions',
              'action_values',
              ...(c.source.reporting_contract === 'overview-config-v4'
                ? ['optimization_goal', 'results', 'cost_per_result', 'result_rate', 'inline_link_clicks']
                : []),
              ...c.extra,
            ]),
          ].join(','),
          limit: 500,
          ...(windows
            ? {
                action_report_time: 'impression',
                action_attribution_windows: windows,
                use_account_attribution_setting: false,
                use_unified_attribution_setting: false,
              }
            : {use_unified_attribution_setting: true}),
          ...(c.segment === 'daily' ? {time_increment: 1} : {}),
        }),
      ),
      c.account,
      c.range,
    );
    c.attribution = windows
      ? 'Meta ' + windows.join(' + ') + '; impression time'
      : 'ad set unified attribution setting';
    // A v4 source says what is true of its rows (Meta’s own results, the mapped table or both); v3 says what it always did.
    c.resultDefinition =
      c.source.reporting_contract === 'overview-config-v4'
        ? metaResultDefinition(c.raw, c.source.report_options)
        : metaMappedDefinition;
  },
  /**
   * A v4 report asked Meta for explicit attribution windows: an action’s `value` is then the ad set’s own setting, and the
   * count of each requested window is under the key named for it (F-LEAD-02). A v3 report, and a v4 report under the ad
   * set’s own setting, read `value`.
   */
  actionCount(entry, field, {options, request}) {
    const windows = metaRequestedWindows(options ?? {attribution_windows: request?.query?.action_attribution_windows});
    return windows !== undefined && (field === 'actions' || field === 'action_values')
      ? metaWindowCount(entry, windows, 'native_metric')
      : entry.value;
  },
  normalize(raw, {value, field: n, omitted, options}) {
    const objective = raw.objective,
      windows = metaRequestedWindows(options);
    // RPT-04 (owner policy P6): Meta omits zero-valued action entries. A delivered row (impressions above 0) from a
    // complete page counts an absent requested action as 0 and names it in `omitted_as_zero`; a row without delivery
    // keeps it unknown. Under explicit windows an action with a count in none of them is that case too.
    const delivered = (metricNumber(raw.impressions) ?? 0) > 0;
    const action = (metric: string, keys: string[], field = 'actions') => {
      const a = raw[field];
      if (Array.isArray(a))
        for (const key of keys) {
          const found = a.find((v: JsonObject) => v?.action_type === key);
          if (found) {
            if (windows === undefined) return value(found.value);
            const counted = metaWindowCount(found, windows, 'native_metric');
            if (counted !== undefined) return value(counted);
            break;
          }
        }
      if (delivered && (a === undefined || Array.isArray(a))) {
        omitted.add(metric);
        return 0;
      }
      return null;
    };
    const leads = action('leads', ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead']),
      purchases = action('purchases', ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase']),
      installs = action('installs', ['mobile_app_install', 'app_install']),
      result = byObjectiveGroup<[number | string | null, string] | undefined>(
        objective,
        {leads: [leads, 'leads'], app_installs: [installs, 'installs'], sales: [purchases, 'purchases']},
        undefined,
      );
    if (result && omitted.has(result[1])) omitted.add('conversions');
    return {
      id: raw.campaign_id,
      name: raw.campaign_name,
      objective,
      metrics: {
        spend: n('spend'),
        impressions: n('impressions'),
        clicks: n('clicks'),
        reach: n('reach'),
        frequency: n('frequency'),
        leads,
        purchases,
        installs,
        conversions: result ? result[0] : null,
        conversion_value: action(
          'conversion_value',
          ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase'],
          'action_values',
        ),
        video_views: action('video_views', ['video_view']),
        engagements: action('engagements', ['post_engagement']),
      },
    };
  },
};

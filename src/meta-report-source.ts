import {metaWindowsOrdered} from './meta-attribution-windows.js';
import {metaGuidedReporting} from './meta-guided-reports.js';
import {metaCampaignRows} from './meta-report.js';
import {metaPrefix} from './meta-version.js';
import {metricNumber, objectiveGroup} from './report-metrics.js';
import type {ReportSource} from './report-source.js';
import type {JsonObject} from './types.js';

/** Meta campaign insights rows: actions and action_values arrays; conversions follow the campaign objective. */
export const metaReportSource: ReportSource = {
  platform: 'meta',
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
    c.resultDefinition = 'Objective-mapped lead, purchase or app-install action; aliases are not summed';
  },
  normalize(raw, {value, field: n, omitted}) {
    const objective = raw.objective;
    // RPT-04 (owner policy P6): Meta omits zero-valued action entries. A delivered row (impressions above 0) from a
    // complete page counts an absent requested action as 0 and names it in `omitted_as_zero`; a row without delivery
    // keeps it unknown.
    const delivered = (metricNumber(raw.impressions) ?? 0) > 0;
    const action = (metric: string, keys: string[], field = 'actions') => {
      const a = raw[field];
      if (Array.isArray(a))
        for (const key of keys) {
          const found = a.find((v: JsonObject) => v?.action_type === key);
          if (found) return value(found.value);
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
      result: [number | null, string] | undefined =
        objectiveGroup(objective) === 'leads'
          ? [leads, 'leads']
          : objectiveGroup(objective) === 'app_installs'
            ? [installs, 'installs']
            : objectiveGroup(objective) === 'sales'
              ? [purchases, 'purchases']
              : undefined;
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

import {objectiveGroup} from './report-metrics.js';
import {invalidReportSource, nextDay, reportList, type ReportSource} from './report-source.js';
import type {JsonObject} from './types.js';
import {zonedMidnight} from './workflows.js';

/** Snapchat campaign stats rows (micros); conversions follow the campaign objective. */
export const snapchatReportSource: ReportSource = {
  platform: 'snapchat',
  nativeMetricExamples: [
    'video_views',
    'view_completion',
    'conversion_purchases',
    'conversion_purchases_value',
    'conversion_sign_ups',
    'total_installs',
  ],
  nativeMetricContainer: 'stats',
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
      objective: campaigns.find(campaign => campaign.id === r.id)?.objective,
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
};

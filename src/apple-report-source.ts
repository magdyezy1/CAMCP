import {MirrorError} from './errors.js';
import {mappedReportResult} from './report-results.js';
import {overviewEntityLevels} from './overview-levels.js';
import {overviewCapabilities} from './report-source.js';
import {optionalReadRefused, reportList, type ReportSource} from './report-source.js';
import type {JsonObject} from './types.js';
import {reportStatus, currentStatusUnavailableWarning} from './report-status.js';
import {appleCampaignMetadata} from './apple-report-metadata.js';
import {appleOrigin} from './apple-report-pages.js';
import {appleDetailRequests, collectAppleDetail} from './apple-report-detail.js';

/** Apple Ads reports days in UTC. */
const reportZone = 'UTC';

/** Apple Ads v1 campaign report rows: totalMetrics with local spend; conversions are installs. */
export const appleReportSource: ReportSource = {
  platform: 'apple',
  readStatus(raw, {metadata = raw.entity_metadata}) {
    return reportStatus(
      metadata?.status,
      {ENABLED: 'active', PAUSED: 'paused'},
      metadata?.displayStatus ?? metadata?.systemStatus,
      metadata?.deleted === true || metadata?.displayStatus === 'DELETED',
    );
  },
  overview: overviewCapabilities(overviewEntityLevels.apple!),
  resultRules: {
    selectors: [],
    default: {
      id: 'apple:total_installs',
      metric: 'installs',
      label: 'Installs',
      native_metric: 'totalMetrics.totalInstalls',
      aggregation: 'sum',
      unit: 'number',
    },
  },
  readResult(raw) {
    return mappedReportResult(appleReportSource.resultRules!, {}, raw, {spend: raw.totalMetrics?.localSpend?.amount});
  },
  objectives: {
    name: 'Apple Ads',
    values: {},
    missingReason: 'Apple Ads has no campaign objective field.',
    mapped: () => ({group: 'app_installs', reason: 'Apple Ads campaigns promote apps.'}),
  },
  nativeMetricExamples: [],
  // The collection reads the ad account itself (its currency; Apple reports in UTC).
  accountLookup: false,
  // RPT-07: its own reports collect the ad group and ad levels.
  nativeDetail: true,
  // Apple report rows nest their metrics in their own shape, so requested metrics are not checked against them.
  nativeMetricCheck: false,
  // The account and the report.
  minimumRequestsPerPeriod: 2,
  // The ad group and ad levels read each campaign with activity (or of the scope) as a report of its own, so without a
  // scope one campaign is assumed and requestsLowerBound says the figure is a lower bound.
  requestsPerPeriod: (level, contract, context) =>
    contract === 'overview-config-v4'
      ? level === 'campaign'
        ? 3
        : appleDetailRequests(level, context?.source.campaign_ids?.length ?? 0)
      : level === 'campaign'
        ? 2
        : 1,
  requestsLowerBound: (level, contract, context) =>
    contract === 'overview-config-v4' && level !== 'campaign' && !context?.source.campaign_ids?.length,
  fixedTimezone: reportZone,
  /**
   * The ad account (its currency; Apple reports in UTC), then one bounded campaign report page, or for the RPT-07 ad
   * group and ad levels the campaigns' own reports, each to its last page, and the account's own records for exact parents.
   */
  async collect(c) {
    const m = await c.run({...c.plan('/v1/ad-accounts/' + c.account), origin: appleOrigin}, false);
    c.metadata = m.result ?? m;
    c.currency = c.metadata.currency ?? null;
    c.timezone = reportZone;
    if (c.detail) {
      await collectAppleDetail(c);
    } else {
      const d = await c.run({
        ...c.plan(
          '/v1/reports/apps/campaigns/query',
          {},
          {
            timeRange: {start: c.range.since, end: c.range.until, timeZone: 'UTC'},
            pagination: {offset: 0, pageSize: 100},
            options: {},
          },
          appleOrigin,
        ),
        action: 'apple_ads_v1_reports_apps_campaigns',
      });
      c.raw = reportList(d.result?.rows ?? d.result ?? []);
      if (c.source.reporting_contract === 'overview-config-v4') {
        let metadata: Record<string, JsonObject> = {};
        try {
          metadata = await appleCampaignMetadata(c);
        } catch (error) {
          if (!optionalReadRefused(error)) throw error;
          c.warnings.push(currentStatusUnavailableWarning);
        }
        c.raw = c.raw.map(row => ({...row, entity_metadata: metadata[String(row.metadata?.id)]}));
      }
      c.resultDefinition = 'Apple total attributed installs (tap + view); totalMetrics';
      if (c.extra.length)
        c.warnings.push(
          'Apple report returns native metric columns; arbitrary field selection is not supported by this endpoint.',
        );
    }
  },
  normalize(raw, {value}) {
    const m = raw.totalMetrics;
    if (!m || typeof m !== 'object' || Array.isArray(m))
      throw new MirrorError('REPORT_SHAPE_CHANGED', 'Apple v1 report row is missing totalMetrics.', {}, 502);
    return {
      id: raw.metadata?.id,
      name: raw.metadata?.name,
      currency: m.localSpend?.currency,
      metrics: {
        spend: value(m.localSpend?.amount),
        impressions: value(m.impressions),
        clicks: value(m.taps),
        installs: value(m.totalInstalls),
        conversions: value(m.totalInstalls),
      },
    };
  },
};

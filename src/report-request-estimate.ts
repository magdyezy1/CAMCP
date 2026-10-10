import {MirrorError} from './errors.js';
import {nativeDailySegmentation} from './report-native.js';
import {reportPeriods} from './report-periods.js';
import {reportContractVersion} from './report-quality.js';
import {reportCollectionLimits} from './report-collection-budget.js';
import {overviewSourceLevel} from './overview-granularity.js';
import {fixedReportTimezones} from './report-windows.js';
import type {JsonObject} from './types.js';

/**
 * RPT-03: the fewest provider requests a source can need, before any egress. Pages beyond the first, retries, polls
 * and X analytics (planned from active entities at run time) are excluded, so the estimate is a lower bound: a
 * configuration refused here cannot fit the whole-job collection budget.
 */
const dataRequestsPerPeriod: Readonly<Record<string, number>> = Object.freeze({
  google: 1,
  meta: 1,
  tiktok: 2, // report and campaign inventory
  snapchat: 2, // stats and campaign inventory
  linkedin: 1,
  x: 2, // campaign inventory and active entities
  microsoft: 2, // submit and first poll
  apple: 2, // account and report
  reddit: 2, // report and campaign inventory
  ga4: 3, // property, metric report and name report
  gsc: 1,
});
const accountLookup = (platform: string) => !['ga4', 'gsc', 'apple'].includes(platform);
/** Snapshots created under the current source contract collect natively segmented days (RPT-03). */
export const nativeDailyCollection = (config: JsonObject, source: JsonObject) =>
  config.source_contract_version === reportContractVersion && nativeDailySegmentation(source);
/** The per-platform request model published by bootstrap. */
export const sourceRequestModel = (platform: string) => ({
  account_lookups: accountLookup(platform) ? 1 : 0,
  account_verification_after_periods: accountLookup(platform) ? 1 : 0,
  minimum_requests_per_period: dataRequestsPerPeriod[platform] ?? 1,
  native_daily_segmentation: nativeDailySegmentation({platform}),
});
export function estimateCollectionRequests(config: JsonObject, limit = reportCollectionLimits.requests) {
  const grain = config.grain ?? 'total',
    count = reportPeriods(config.date_range, grain).length,
    sources = (config.sources ?? []).map((source: JsonObject) => {
      const daily = grain === 'daily' && nativeDailyCollection(config, source),
        detailed = overviewSourceLevel(source).id !== 'campaign',
        periods = daily ? 1 : count,
        lookups = accountLookup(source.platform) ? 1 + (grain === 'total' ? 0 : 1) : 0,
        window = config.date_range_rule?.source_timezone === 'account' && !fixedReportTimezones[source.platform] ? 1 : 0;
      return {
        platform: source.platform,
        account_id: source.account_id,
        periods: count,
        collection: daily ? 'native_daily' : 'per_period',
        requests: lookups + window + periods * (detailed ? 1 : (dataRequestsPerPeriod[source.platform] ?? 1)),
      };
    });
  return {
    basis: 'minimum',
    estimated_requests: sources.reduce((n: number, s: JsonObject) => n + s.requests, 0),
    limit,
    sources,
  };
}
/** Refuses a snapshot whose minimum request count already exceeds the whole-job budget, before any provider read. */
export function assertCollectionEstimate(config: JsonObject) {
  const estimate = estimateCollectionRequests(config);
  if (estimate.estimated_requests > estimate.limit)
    throw new MirrorError(
      'REPORT_COLLECTION_LIMIT',
      'This report needs at least ' +
        estimate.estimated_requests +
        ' provider requests, more than the ' +
        estimate.limit +
        ' one snapshot may use. Use fewer accounts, a shorter window or a coarser grouping. Nothing was sent.',
      {dimension: 'requests', estimate},
      422,
    );
  return estimate;
}

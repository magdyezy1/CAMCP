import {MirrorError} from './errors.js';
import {nativeDailySegmentation} from './report-native.js';
import {reportPeriods} from './report-periods.js';
import {reportContractVersion} from './report-quality.js';
import {reportCollectionLimits} from './report-collection-budget.js';
import {overviewSourceLevel} from './overview-granularity.js';
import {fixedReportTimezones} from './report-windows.js';
import {reportSource} from './report-sources.js';
import type {JsonObject} from './types.js';

/**
 * RPT-03: the fewest provider requests a source can need, before any egress, from its report source
 * (src/report-sources.ts, ARC-04 stage F). Pages beyond the first, retries, polls and X analytics (planned from active
 * entities at run time) are excluded, so the estimate is a lower bound: a configuration refused here cannot fit the
 * whole-job collection budget.
 */
const dataRequestsPerPeriod = (platform: string) => reportSource(platform)?.minimumRequestsPerPeriod ?? 1;
/** Whether the source reads its account before collection (and verifies it after a multi-period collection). */
const accountLookup = (platform: string) => reportSource(platform)?.accountLookup !== false;
/** Snapshots created under the current source contract collect natively segmented days (RPT-03). */
export const nativeDailyCollection = (config: JsonObject, source: JsonObject) =>
  config.source_contract_version === reportContractVersion && nativeDailySegmentation(source);
/** The per-platform request model published by bootstrap. */
export const sourceRequestModel = (platform: string) => ({
  account_lookups: accountLookup(platform) ? 1 : 0,
  account_verification_after_periods: accountLookup(platform) ? 1 : 0,
  minimum_requests_per_period: dataRequestsPerPeriod(platform),
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
        window =
          config.date_range_rule?.source_timezone === 'account' && !fixedReportTimezones[source.platform] ? 1 : 0;
      return {
        platform: source.platform,
        account_id: source.account_id,
        periods: count,
        collection: daily ? 'native_daily' : 'per_period',
        requests: lookups + window + periods * (detailed ? 1 : dataRequestsPerPeriod(source.platform)),
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
      'This report needs more provider requests than one snapshot may use. Use fewer accounts, a shorter window or a coarser grouping. Nothing was sent.',
      {dimension: 'requests', estimate},
      422,
    );
  return estimate;
}

import {MirrorError} from './errors.js';
import {nativeDailySegmentation} from './report-native.js';
import {reportPeriods} from './report-periods.js';
import {reportContractVersion} from './report-quality.js';
import {reportCollectionLimits} from './report-collection-budget.js';
import {overviewSourceLevel} from './overview-granularity.js';
import {fixedReportTimezones} from './report-windows.js';
import {reportSource} from './report-sources.js';
import type {JsonObject} from './types.js';
import {expandOverviewV4Sources, overviewConfigV4} from './overview-v4.js';
import type {ReportSource} from './report-source.js';

/**
 * RPT-03: the fewest provider requests a source can need, before any egress, from its report source
 * (src/report-sources.ts, ARC-04 stage F). Pages beyond the first, retries, polls and X analytics (planned from active
 * entities at run time) are excluded, so the estimate is a lower bound: a configuration refused here cannot fit the
 * whole-job collection budget. V4 instead includes first-page metadata for nonempty results; its disclosed baseline
 * can be conservative when no entities are returned or another level has already cached their metadata.
 */
const dataRequestsPerPeriod = (
  platform: string,
  level = 'campaign',
  contract?: string,
  context?: Parameters<NonNullable<ReportSource['requestsPerPeriod']>>[2],
) => {
  const source = reportSource(platform);
  return (
    source?.requestsPerPeriod?.(level, contract, context) ??
    (level === 'campaign' ? (source?.minimumRequestsPerPeriod ?? 1) : 1)
  );
};
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
  const seenAccounts = new Set<string>();
  const grain = config.grain ?? 'total',
    windows = reportPeriods(config.date_range, grain),
    count = windows.length,
    sources = expandOverviewV4Sources({...config, sources: config.sources ?? []}).map((source: JsonObject) => {
      const daily = grain === 'daily' && nativeDailyCollection(config, source),
        level = overviewSourceLevel(source).id,
        periods = daily ? 1 : count,
        lookupKey = source.source_ref === undefined ? null : String(source.source_ref),
        firstLookup = lookupKey === null || !seenAccounts.has(lookupKey),
        lookups = accountLookup(source.platform) ? (firstLookup ? 1 : 0) + (grain === 'total' ? 0 : 1) : 0,
        window =
          config.date_range_rule?.source_timezone === 'account' && !fixedReportTimezones[source.platform] ? 1 : 0;
      if (lookupKey !== null) seenAccounts.add(lookupKey);
      const context = {source, range: daily ? config.date_range : windows[0]!};
      return {
        platform: source.platform,
        account_id: source.account_id,
        ...(source.source_ref !== undefined ? {source_ref: source.source_ref, level} : {}),
        ...(source.scope_supporting ? {purpose: 'scope_rollup', visible: false} : {}),
        // The size of what the level reads is unknown until it is read (an account's campaigns, unscoped): a lower bound.
        ...(reportSource(source.platform)?.requestsLowerBound?.(level, source.reporting_contract, context)
          ? {lower_bound: true}
          : {}),
        periods: count,
        collection: daily ? 'native_daily' : 'per_period',
        requests:
          lookups +
          window +
          // What a source sends once per job (LinkedIn's conversion rules) is paid by its first level; the others share it.
          (firstLookup ? (reportSource(source.platform)?.requestsPerSource?.(source.reporting_contract) ?? 0) : 0) +
          periods *
            dataRequestsPerPeriod(source.platform, level, source.reporting_contract, {
              source,
              range: daily ? config.date_range : windows[0]!,
            }),
      };
    });
  return {
    basis: config.contract_version === overviewConfigV4 ? 'conservative_first_page' : 'minimum',
    estimated_requests: sources.reduce((n: number, s: JsonObject) => n + s.requests, 0),
    limit,
    sources,
  };
}
/** Refuses a snapshot whose disclosed request estimate exceeds the whole-job budget, before any provider read. */
export function assertCollectionEstimate(config: JsonObject) {
  const estimate = estimateCollectionRequests(config);
  if (estimate.estimated_requests > estimate.limit) {
    if (config.contract_version === overviewConfigV4)
      throw new MirrorError(
        'REPORT_COLLECTION_LIMIT',
        'The first-page request estimate exceeds this report’s collection limit. Use fewer accounts, a shorter window or a coarser grouping. Nothing was sent.',
        {dimension: 'requests', estimate},
        422,
      );
    throw new MirrorError(
      'REPORT_COLLECTION_LIMIT',
      'This report needs more provider requests than one snapshot may use. Use fewer accounts, a shorter window or a coarser grouping. Nothing was sent.',
      {dimension: 'requests', estimate},
      422,
    );
  }
  return estimate;
}

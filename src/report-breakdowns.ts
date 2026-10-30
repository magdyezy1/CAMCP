import type {JsonObject} from './types.js';
import {reportPlatforms} from './report-metrics.js';
import {undocumentedBreakdownValue} from './report-source.js';
import {reportSourceList} from './report-sources.js';

/**
 * RPT-07 P1 dimension packs: guided evidence by a native dimension that campaign rows cannot answer.
 *  - Google: Performance Max search terms (campaign_search_term_view) and campaign × ad network (segments.ad_network_type).
 *  - Meta: campaign × age × gender, campaign × country, and campaign × publisher platform × placement Insights breakdowns.
 * Every dimension value stays the literal native value (never translated, renamed or merged). A bucket the provider did
 * not return stays unknown: it is never filled with zero, and breakdown totals are not claimed to equal campaign totals
 * (privacy thresholds and unknown buckets). Reach and frequency stay per row; they are never added across buckets.
 *
 * Each platform's dimensions and their native values are its guided reporting's (ARC-04 stage F: the report sources,
 * src/google-guided-reports.ts and src/meta-guided-reports.ts); this module names no platform.
 */

// The native value lists and Meta's packs keep these import paths, through the report source registry.
export {
  googleReportAdNetworks,
  metaAgeBuckets,
  metaGenders,
  metaPublisherPlatforms,
  metaBreakdownPresets,
  metaBreakdownKey,
} from './report-sources.js';

/**
 * The mapped native dimension keys, their gateway and the native values each accepts: the dimensions the report
 * sources' guided reporting declares, in registry order, under the gateway of the source's platform.
 */
export const breakdownDimensions: Record<string, {gateway: string; valid: (v: unknown) => boolean}> =
  Object.fromEntries(
    reportSourceList.flatMap(source =>
      Object.entries(source.guided?.dimensions ?? {}).map(([key, valid]) => [
        key,
        {gateway: reportPlatforms[source.platform]!.gateway, valid},
      ]),
    ),
  );
export const breakdownDimensionKeys = Object.keys(breakdownDimensions);

/** A mapped dimension value, refused unless it is a documented native value of the capture's gateway. */
export function breakdownValue(key: string, gateway: unknown, value: unknown): string {
  const dimension = breakdownDimensions[key];
  if (!dimension || gateway !== dimension.gateway || !dimension.valid(value)) undocumentedBreakdownValue(key);
  return String(value);
}

/** What a breakdown capture retains about its dimensions (on the saved evidence and in capture_presets). */
export function breakdownDescriptor(dimensions: string[], rows: JsonObject[]) {
  return {
    dimensions,
    observed_values: Object.fromEntries(
      dimensions.map(key => [
        key,
        [...new Set(rows.map(row => row[key]).filter((v): v is string => typeof v === 'string'))].sort(),
      ]),
    ),
    absent_buckets: 'unknown',
    reconciles_with_parent_totals: false,
    meaning:
      'Rows are native dimension buckets with literal provider values. A bucket the provider did not return is unknown, never zero. Bucket totals can differ from campaign totals (privacy thresholds, unknown buckets); reach and frequency are per bucket and never added together.',
  };
}

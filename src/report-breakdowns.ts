import {bad} from './workspace-core.js';
import type {JsonObject} from './types.js';

/**
 * RPT-07 P1 dimension packs: guided evidence by a native dimension that campaign rows cannot answer.
 *  - Google: Performance Max search terms (campaign_search_term_view) and campaign × ad network (segments.ad_network_type).
 *  - Meta: campaign × age × gender, campaign × country, and campaign × publisher platform × placement Insights breakdowns.
 * Every dimension value stays the literal native value (never translated, renamed or merged). A bucket the provider did
 * not return stays unknown: it is never filled with zero, and breakdown totals are not claimed to equal campaign totals
 * (privacy thresholds and unknown buckets). Reach and frequency stay per row; they are never added across buckets.
 */

/** Native v25 AdNetworkType values (pinned discovery .mirror/VENDOR/google-ads-v25.json). */
export const googleReportAdNetworks = Object.freeze([
  'UNSPECIFIED',
  'UNKNOWN',
  'SEARCH',
  'SEARCH_PARTNERS',
  'CONTENT',
  'MIXED',
  'YOUTUBE',
  'GOOGLE_TV',
  'GOOGLE_OWNED_CHANNELS',
  'GMAIL',
  'DISCOVER',
  'MAPS',
]);
/** Meta Insights `age` buckets and `gender` values. */
export const metaAgeBuckets = Object.freeze(['13-17', '18-24', '25-34', '35-44', '45-54', '55-64', '65+', 'Unknown']);
export const metaGenders = Object.freeze(['female', 'male', 'unknown']);
/** Meta Insights `publisher_platform` values. Placements (`platform_position`) change often; their shape is checked. */
export const metaPublisherPlatforms = Object.freeze([
  'facebook',
  'instagram',
  'audience_network',
  'messenger',
  'threads',
  'unknown',
]);
const metaPosition = (v: unknown) => typeof v === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(v);
/** ISO 3166-1 alpha-2 country codes, or Meta's literal unknown bucket. */
const metaCountry = (v: unknown) => typeof v === 'string' && /^(?:[A-Z]{2}|unknown|Unknown)$/.test(v);

/** The mapped native dimension keys, their gateway and the native values each accepts. */
export const breakdownDimensions: Record<string, {gateway: string; valid: (v: unknown) => boolean}> = {
  native_ad_network: {
    gateway: 'google_ads_native_action',
    valid: v => typeof v === 'string' && googleReportAdNetworks.includes(v),
  },
  native_age: {gateway: 'meta_native_action', valid: v => typeof v === 'string' && metaAgeBuckets.includes(v)},
  native_gender: {gateway: 'meta_native_action', valid: v => typeof v === 'string' && metaGenders.includes(v)},
  native_country: {gateway: 'meta_native_action', valid: metaCountry},
  native_publisher_platform: {
    gateway: 'meta_native_action',
    valid: v => typeof v === 'string' && metaPublisherPlatforms.includes(v),
  },
  native_platform_position: {gateway: 'meta_native_action', valid: metaPosition},
};
export const breakdownDimensionKeys = Object.keys(breakdownDimensions);

/** A mapped dimension value, refused unless it is a documented native value of the capture's gateway. */
export function breakdownValue(key: string, gateway: unknown, value: unknown): string {
  const dimension = breakdownDimensions[key];
  if (!dimension || gateway !== dimension.gateway || !dimension.valid(value))
    bad('The provider returned a breakdown value this report type does not document.', 'REPORT_SHAPE_CHANGED', {
      dimension: key,
    });
  return String(value);
}

/** The Meta breakdown packs: Insights `breakdowns` and the row field each mapped dimension reads. */
export const metaBreakdownPresets: Record<string, {breakdowns: string[]; dimensions: Record<string, string>}> = {
  meta_campaign_age_gender: {breakdowns: ['age', 'gender'], dimensions: {native_age: 'age', native_gender: 'gender'}},
  meta_campaign_country: {breakdowns: ['country'], dimensions: {native_country: 'country'}},
  meta_campaign_placement: {
    breakdowns: ['publisher_platform', 'platform_position'],
    dimensions: {native_publisher_platform: 'publisher_platform', native_platform_position: 'platform_position'},
  },
};
/** Meta Insights breakdown fields AMCP never requests here; a row naming one is a different report. */
const otherMetaBreakdowns = [
  'age',
  'gender',
  'country',
  'region',
  'dma',
  'publisher_platform',
  'platform_position',
  'impression_device',
  'device_platform',
];
/**
 * The breakdown values of one Meta row (validated, in dimension order) for its grain key. A row must carry every
 * requested breakdown with a documented value and no other breakdown field.
 */
export function metaBreakdownKey(preset: string, row: JsonObject): string[] {
  const pack = metaBreakdownPresets[preset];
  if (!pack) return [];
  const requested = Object.values(pack.dimensions);
  if (otherMetaBreakdowns.some(field => !requested.includes(field) && row[field] !== undefined))
    bad('Meta returned a breakdown that was not requested.', 'REPORT_SHAPE_CHANGED');
  return Object.entries(pack.dimensions).map(([key, field]) => breakdownValue(key, 'meta_native_action', row[field]));
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

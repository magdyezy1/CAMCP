import {bad} from './workspace-core.js';
import {undocumentedBreakdownValue, type GuidedReporting} from './report-source.js';
import type {JsonObject} from './types.js';

/**
 * Meta's guided reporting (ARC-04 stage F): what the shared guided modules (src/report-breakdowns.ts and the modules
 * above it) ask Meta instead of naming it. Meta's report source declares it.
 *
 * RPT-07 P1 dimension packs: campaign × age × gender, campaign × country, and campaign × publisher platform × placement
 * Insights breakdowns. Every dimension value stays the literal native value (never translated, renamed or merged).
 */

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

/** The mapped native dimension keys of Meta's packs and the native values each accepts. */
const dimensions: Record<string, (v: unknown) => boolean> = {
  native_age: v => typeof v === 'string' && metaAgeBuckets.includes(v),
  native_gender: v => typeof v === 'string' && metaGenders.includes(v),
  native_country: metaCountry,
  native_publisher_platform: v => typeof v === 'string' && metaPublisherPlatforms.includes(v),
  native_platform_position: metaPosition,
};

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
  return Object.entries(pack.dimensions).map(([key, field]) => {
    const value = row[field];
    if (!dimensions[key]!(value)) undocumentedBreakdownValue(key);
    return String(value);
  });
}

export const metaGuidedReporting: GuidedReporting = {dimensions};

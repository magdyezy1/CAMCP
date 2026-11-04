import {MirrorError} from './errors.js';
import {parseProviderDecimal} from './provider-decimal.js';
import {objectiveFallbackGroups} from './report-objectives.js';
import type {JsonObject} from './types.js';

export const overviewConfigV4 = 'overview-config-v4';
export const overviewDetailV4 = 'overview-detail-v4';
export interface OverviewV4Capabilities {
  levels: readonly {id: string; label: string; native_type: string; preset?: string}[];
  /** The provider source owns these facts; this module only validates/applies the supplied declaration. */
  defaults: Readonly<JsonObject>;
  option_names: readonly string[];
  validateOptions?(options: JsonObject): void;
}
function invalid(message: string, code = 'INVALID_REPORT_SOURCE'): never {
  throw new MirrorError(code, message);
}
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const ids = (value: unknown): string[] => {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 500 ||
    value.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(id))
  )
    invalid('Use at most 500 exact native IDs for each report scope.');
  return [...new Set(value as string[])];
};
/** No provider switches or invented defaults. Connection/account authorization remains at the caller's boundary. */
export function normalizeOverviewV4Source(input: JsonObject, capabilities: OverviewV4Capabilities): JsonObject {
  const source = structuredClone(input),
    levels = source.levels ?? [source.level ?? 'campaign'];
  if (
    !Array.isArray(levels) ||
    !levels.length ||
    levels.length > capabilities.levels.length ||
    new Set(levels).size !== levels.length ||
    levels.some(level => !capabilities.levels.some(item => item.id === level)) ||
    (source.levels !== undefined && source.level !== undefined && source.level !== levels[0])
  )
    invalid(
      'Choose supported report levels once each; the legacy level must match the first level.',
      'INVALID_REPORT_LEVEL',
    );
  if (source.report_options !== undefined && !object(source.report_options)) invalid('Use supported report options.');
  const provided = source.report_options ?? {};
  if (Object.keys(provided).some(key => !capabilities.option_names.includes(key)))
    invalid('Use supported report options.');
  const options = {...structuredClone(capabilities.defaults), ...provided};
  if (
    options.complete_window !== null &&
    options.complete_window !== undefined &&
    typeof options.complete_window !== 'boolean'
  )
    invalid('Declare the reporting window complete, incomplete, or leave it undeclared.');
  if (
    options.attribution !== undefined &&
    (typeof options.attribution !== 'string' ||
      !options.attribution.trim() ||
      options.attribution.length > 200 ||
      /[\x00-\x1f\x7f]/.test(options.attribution))
  )
    invalid('Declare the detailed report attribution or use unknown.');
  capabilities.validateOptions?.(options);
  const statuses = source.statuses ?? ['all'];
  if (
    !Array.isArray(statuses) ||
    !statuses.length ||
    new Set(statuses).size !== statuses.length ||
    statuses.some(status => !['active', 'paused', 'archived', 'all'].includes(status)) ||
    (statuses.includes('all') && statuses.length !== 1)
  )
    invalid('Choose active, paused, archived, or all report statuses.');
  if (source.delivered_only !== undefined && typeof source.delivered_only !== 'boolean')
    invalid('Use true or false for delivered_only.');
  const legacyObjective = source.objective;
  delete source.objective;
  if (source.objective_fallback === undefined && objectiveFallbackGroups.includes(legacyObjective))
    source.objective_fallback = legacyObjective;
  return {
    ...source,
    levels: [...levels],
    level: levels[0],
    report_options: options,
    campaign_ids: ids(source.campaign_ids),
    adset_ids: ids(source.adset_ids),
    ad_ids: ids(source.ad_ids),
    statuses: [...statuses],
    delivered_only: source.delivered_only ?? true,
    reporting_contract: overviewConfigV4,
    ...(legacyObjective !== undefined ? {objective_migrated_from_v3: true} : {}),
  };
}

/** One configured account; each requested level gets its own deterministic checkpoint and row budget key. */
export function expandOverviewV4Sources(config: JsonObject): JsonObject[] {
  if (config.contract_version !== overviewConfigV4) return config.sources;
  return config.sources.flatMap((source: JsonObject, index: number) =>
    source.levels.map((level: string) => ({...source, level, source_ref: index})),
  );
}

/** Unknown delivery/status cannot satisfy a positive filter. The caller discloses excluded unknowns in scope quality. */
export function overviewV4Scope(source: JsonObject, rows: JsonObject[]) {
  let excluded = 0,
    unknown = 0;
  const selected = rows.filter(row => {
    const parents = row.parent_ids ?? {},
      level = row.entity_level ?? source.level ?? 'campaign',
      own = row.entity_id ?? row.campaign_id,
      values = {
        campaign_ids: level === 'campaign' ? own : (parents.campaign_id ?? row.campaign_id),
        adset_ids: level === 'adset' ? own : parents.adset_id,
        ad_ids: level === 'ad' ? own : undefined,
      };
    for (const [field, value] of Object.entries(values))
      if (source[field]?.length && !source[field].includes(value)) {
        excluded++;
        if (value === undefined || value === null) unknown++;
        return false;
      }
    if (!source.statuses.includes('all') && !source.statuses.includes(row.status)) {
      excluded++;
      if (row.status == null || row.status === 'unknown') unknown++;
      return false;
    }
    if (source.delivered_only) {
      const metrics = row.native?.exact_totals ?? row.metrics ?? {},
        delivery = ['spend', 'impressions', 'clicks'].map(key => metrics[key]);
      const known = delivery.filter(value => value !== undefined && value !== null);
      if (!known.some(value => parseProviderDecimal(value, {field: 'delivery'}).scaled > 0n)) {
        excluded++;
        if (!known.length) unknown++;
        return false;
      }
    }
    return true;
  });
  return {
    rows: selected,
    scope: {
      returned_rows: rows.length,
      retained_rows: selected.length,
      excluded_rows: excluded,
      excluded_unknown_rows: unknown,
      filtering: 'after_collection',
    },
  };
}

const scale = 1000000000n;
const additiveMetrics = new Set([
  'spend',
  'impressions',
  'clicks',
  'conversions',
  'conversion_value',
  'leads',
  'purchases',
  'installs',
  'video_views',
  'video_completions',
  'engagements',
]);
function decimalText(value: bigint): string {
  const sign = value < 0n ? '-' : '',
    magnitude = value < 0n ? -value : value,
    fraction = (magnitude % scale).toString().padStart(9, '0').replace(/0+$/, '');
  return sign + (magnitude / scale).toString() + (fraction ? '.' + fraction : '');
}
/** Known values add exactly; null/absent values have coverage rather than suppressing every known row. */
export function overviewV4Sum(rows: JsonObject[], metric: string) {
  if (!additiveMetrics.has(metric)) invalid('This report metric is not declared additive.', 'INVALID_METRICS');
  let known = 0,
    rounded = 0,
    total = 0n;
  for (const row of rows) {
    const value = (row.native?.exact_totals ?? row.metrics ?? {})[metric];
    if (value === null || value === undefined) continue;
    const parsed = parseProviderDecimal(value, {field: metric});
    total += parsed.scaled;
    known++;
    if (parsed.rounded) rounded++;
  }
  return {value: known ? decimalText(total) : null, coverage: {known, total: rows.length}, rounded_values: rounded};
}
/** Ratios share a population: never divide a numerator's known total by a different denominator's population. */
export function overviewV4Ratio(rows: JsonObject[], numerator: string, denominator: string, multiplier = 1) {
  let pairs = 0,
    top = 0n,
    bottom = 0n;
  if (![1, 100, 1000].includes(multiplier)) invalid('Use a supported report ratio unit.');
  for (const row of rows) {
    const metrics = row.native?.exact_totals ?? row.metrics ?? {},
      a = metrics[numerator],
      b = metrics[denominator];
    if (a === null || a === undefined || b === null || b === undefined) continue;
    top += parseProviderDecimal(a, {field: numerator}).scaled;
    bottom += parseProviderDecimal(b, {field: denominator}).scaled;
    pairs++;
  }
  if (!pairs || bottom === 0n) return {value: null, coverage: {known_pairs: pairs, total: rows.length}, rounded: false};
  const dividend = top * BigInt(multiplier) * scale,
    quotient = dividend / bottom,
    remainder = dividend % bottom,
    up = remainder * 2n > bottom || (remainder * 2n === bottom && quotient % 2n === 1n);
  return {
    value: decimalText(quotient + (up ? 1n : 0n)),
    coverage: {known_pairs: pairs, total: rows.length},
    rounded: remainder !== 0n,
  };
}

/** Projection changes only v4 snapshots. Retained legacy snapshots keep their recorded representation. */
export function projectOverviewV4Rows(snapshot: JsonObject, rows: JsonObject[], include: JsonObject = {}) {
  if (snapshot.config?.contract_version !== overviewConfigV4) return rows;
  return rows.map(row => {
    const {native, lineage, objective_source, objective_group, objective_reason, ...visible} = row;
    return {
      ...visible,
      level: row.entity_level ?? 'campaign',
      objective: {
        native: row.objective === 'unknown' ? null : row.objective,
        group: objective_group,
        source: objective_source,
        reason: objective_reason ?? null,
      },
      parents: {
        ...(row.parent_ids?.campaign_id
          ? {campaign: {id: row.parent_ids.campaign_id, name: row.parent_ids.campaign_name ?? null}}
          : {}),
        ...(row.parent_ids?.adset_id
          ? {adset: {id: row.parent_ids.adset_id, name: row.parent_ids.adset_name ?? null}}
          : {}),
      },
      ...(include.native === true ? {native} : {}),
      ...(include.lineage === true ? {lineage: snapshot.sources?.[row.source_ref]?.lineage ?? lineage ?? []} : {}),
    };
  });
}

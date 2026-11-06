import {MirrorError} from './errors.js';
import {parseProviderDecimal, providerDecimalText} from './provider-decimal.js';
import {objectiveFallbackGroups} from './report-objectives.js';
import type {JsonObject} from './types.js';
import {reportLevelReconciliation} from './report-level-reconciliation.js';

export const overviewConfigV4 = 'overview-config-v4';
export const overviewDetailV4 = 'overview-detail-v4';
export const overviewV4ScopeContract = 'selected-descendants-v1';
export interface OverviewV4Capabilities {
  levels: readonly {id: string; label: string; native_type: string; preset?: string}[];
  /** The provider source owns these facts; this module only validates/applies the supplied declaration. */
  defaults: Readonly<JsonObject>;
  option_names: readonly string[];
  /** A positive observation of any of these source-owned metrics proves delivery or measurement activity. */
  delivery_metrics: readonly string[];
  supported_statuses: readonly string[];
  status_basis: 'current_configuration' | 'provider_report_status' | 'not_applicable';
  /** A provider-owned URN prefix when reports and parent metadata spell the same native identity differently. */
  scope_id_prefixes?: Readonly<Record<string, string>>;
  scope_id_pattern?: string;
  /** Old scalar parent filters become the same native ID scope used by the current editor. */
  scope_aliases?: Readonly<Record<string, 'campaign_ids' | 'adset_ids' | 'ad_ids'>>;
  validateOptions?(options: JsonObject, context: {levels: readonly string[]}): void;
  legacy?: {
    campaign_options?: readonly string[];
    detail_options?: readonly string[];
    requires_action?: true;
    requires_complete?: true;
    /** Null retains a legacy campaign's provider-configured profile, including its original report-time mode. */
    provider_configured_options?: readonly string[];
    parent_required_levels?: readonly string[];
  };
}

/** Current readers use the sidecar; an older binary continues to read the original config field. */
export const overviewDefinitionConfig = (record: JsonObject): JsonObject => record.config_v4 ?? record.config;
/** Do not expose both definition forms to clients or let an old renderer accidentally edit the wrong one. */
export function publicOverviewDefinition(record: JsonObject): JsonObject {
  const {config_v4, ...visible} = record;
  return config_v4 ? {...visible, config: config_v4} : visible;
}
/**
 * Keep account authorization identical in both forms, and keep the v3 form one Work-here (the build a rollback
 * returns to, D21) accepts. What v3 can say it keeps: one level, no status filter, the platform's scalar parent filter,
 * and `delivered_only` is not part of it (Work-here shows rows without activity too, so its totals are the same; the
 * flag stays in the v4 form). What v3 cannot express (several levels, ID scopes beyond the parent filter, a status
 * filter, a declared-incomplete campaign window, an undeclared or unusable detail window) receives an unsupported
 * level: an old binary lists the definition but refuses it before provider egress, and a schedule of it pauses.
 * Existing v3 definitions are never rewritten by this helper or by a run.
 */
export function overviewDefinitionForms(
  config: JsonObject,
  capabilitiesFor: (platform: string) => OverviewV4Capabilities,
): JsonObject {
  if (config.contract_version !== overviewConfigV4) return {config, config_v4: undefined};
  const current = structuredClone(config),
    legacy: JsonObject = {...current};
  delete legacy.contract_version;
  const legacySource = (source: JsonObject, defaults = false) => {
    const {
        levels,
        reporting_contract,
        source_ref,
        campaign_ids,
        adset_ids,
        ad_ids,
        statuses,
        delivered_only,
        delivery_metrics,
        status_basis,
        objective_migrated_from_v3,
        ...old
      } = source,
      capabilities = capabilitiesFor(source.platform),
      rules = capabilities.legacy ?? {},
      level = levels[0],
      options = source.report_options,
      optionNames =
        level === 'campaign'
          ? (rules.campaign_options ?? [])
          : (rules.detail_options ?? ['complete_window', 'attribution']),
      scopes: Record<string, string[]> = {
        campaign_ids: campaign_ids ?? [],
        adset_ids: adset_ids ?? [],
        ad_ids: ad_ids ?? [],
      },
      parentRequired = rules.parent_required_levels?.includes(level) === true;
    // A platform's declared scalar alias (scope_aliases) is the v3 spelling of a one-entry ID scope, at the levels whose
    // v3 form has a parent filter. Normalization moved the scalar into the scope; the old form gets it back.
    if (parentRequired)
      for (const [alias, field] of Object.entries(capabilities.scope_aliases ?? {}))
        if (scopes[field]?.length === 1) {
          old[alias] = scopes[field]![0];
          scopes[field] = [];
        }
    const parentRestored = Object.keys(capabilities.scope_aliases ?? {}).some(alias => old[alias] !== undefined),
      unavailable =
        levels.length !== 1 ||
        Object.values(scopes).some(ids => ids.length) ||
        !statuses.includes('all') ||
        // Template defaults carry no account, so no parent either (Work-here checks the parent of a report only).
        (parentRequired && !defaults && !parentRestored) ||
        (level === 'campaign' && options.complete_window === false) ||
        (level !== 'campaign' &&
          (typeof options.complete_window !== 'boolean' ||
            (rules.requires_complete && options.complete_window !== true) ||
            (rules.requires_action && !options.result_action_type) ||
            // Work-here takes the preset metrics of a detail level only.
            source.native_metrics?.length));
    old.level = unavailable ? 'v4_required' : level;
    if (source.objective_fallback !== undefined) old.objective = source.objective_fallback;
    const selected = Object.fromEntries(
      optionNames
        .filter(
          key =>
            options[key] !== undefined &&
            !(level === 'campaign' && options[key] === null && rules.provider_configured_options?.includes(key)),
        )
        .map(key => [key, options[key]]),
    );
    if (Object.keys(selected).length) old.report_options = selected;
    else delete old.report_options;
    return old;
  };
  legacy.sources = current.sources.map((source: JsonObject) => legacySource(source));
  if (current.source_defaults)
    legacy.source_defaults = Object.fromEntries(
      Object.entries(current.source_defaults).map(([platform, value]) => {
        // Work-here accepts only objective, native_metrics, level and report_options in a default: the objective
        // fallback is already there as `objective`, and per-campaign overrides stay in the v4 form.
        const {
          platform: _platform,
          objective_fallback: _fallback,
          objective_overrides: _overrides,
          ...defaults
        } = legacySource({platform, ...(value as JsonObject)}, true);
        return [platform, defaults];
      }),
    );
  return {config: legacy, config_v4: current};
}
/**
 * Pure read-old conversion. The caller validates the result and keeps the original stored config as rollback.
 * Total: a library edit hands it a client's body before any validation, so a body that is not a definition is refused
 * here with the codes Work-here's validation gave (INVALID_REPORT, REPORT_SOURCES_REQUIRED, INVALID_REPORT_SOURCE)
 * instead of crashing the request.
 */
export function upgradeOverviewV3Config(
  config: JsonObject,
  capabilitiesFor: (platform: string) => OverviewV4Capabilities | undefined,
): JsonObject {
  if (!object(config)) invalid('Name this report (1–100 characters).', 'INVALID_REPORT');
  if (config.sources !== undefined && !Array.isArray(config.sources))
    invalid('Choose between 1 and 30 platform accounts.', 'REPORT_SOURCES_REQUIRED');
  if (config.sources?.some((value: unknown) => !object(value)))
    invalid('Choose a platform, connection and account.', 'INVALID_REPORT_SOURCE');
  if (config.source_defaults != null && !object(config.source_defaults))
    invalid('Template defaults must name supported reporting platforms.', 'INVALID_REPORT_SOURCE');
  if (Object.values(config.source_defaults ?? {}).some(value => !object(value)))
    invalid(
      'Use objective and native metric names for template defaults, without account identities.',
      'INVALID_REPORT_SOURCE',
    );
  const upgraded = structuredClone(config);
  if (upgraded.contract_version === overviewConfigV4) return upgraded;
  if (
    (Array.isArray(upgraded.sources) && upgraded.sources.some((value: JsonObject) => value?.levels !== undefined)) ||
    Object.values(upgraded.source_defaults ?? {}).some((value: any) => value?.levels !== undefined)
  )
    return {...upgraded, contract_version: overviewConfigV4};
  const source = (original: JsonObject, platform: string, defaults = false): JsonObject => {
    const capabilities = capabilitiesFor(platform);
    if (!capabilities) invalid('Choose a platform, connection and account.');
    const level = original.level ?? 'campaign',
      options = {...original.report_options};
    if (level === 'campaign' && original.report_options === undefined)
      for (const key of capabilities!.legacy?.provider_configured_options ?? []) options[key] = null;
    return {
      ...original,
      levels: [level],
      statuses: ['all'],
      delivered_only: false,
      ...(!defaults ? {campaign_ids: [], adset_ids: [], ad_ids: []} : {}),
      report_options: options,
    };
  };
  upgraded.sources = (upgraded.sources ?? []).map((value: JsonObject) => source(value, value.platform));
  upgraded.source_defaults = Object.fromEntries(
    Object.entries(upgraded.source_defaults ?? {}).map(([platform, value]) => [
      platform,
      source(value as JsonObject, platform, true),
    ]),
  );
  upgraded.contract_version = overviewConfigV4;
  return upgraded;
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
  for (const [alias, field] of Object.entries(capabilities.scope_aliases ?? {})) {
    if (source[alias] === undefined) continue;
    const previous = source[field];
    if (previous !== undefined && (!Array.isArray(previous) || (previous.length && !previous.includes(source[alias]))))
      invalid('The parent campaign filter conflicts with the selected campaign IDs.');
    source[field] = [source[alias]];
    delete source[alias];
  }
  delete source.scope_supporting;
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
  capabilities.validateOptions?.(options, {levels: overviewV4CollectionLevels({...source, levels})});
  const statuses = source.statuses ?? ['all'];
  if (
    !Array.isArray(statuses) ||
    !statuses.length ||
    new Set(statuses).size !== statuses.length ||
    statuses.some(status => !['active', 'paused', 'archived', 'all'].includes(status)) ||
    (statuses.includes('all') && statuses.length !== 1)
  )
    invalid('Choose active, paused, archived, or all report statuses.');
  if (statuses.some(status => !capabilities.supported_statuses.includes(status)))
    invalid('Choose statuses supported by this report source.');
  if (source.delivered_only !== undefined && typeof source.delivered_only !== 'boolean')
    invalid('Use true or false for delivered_only.');
  const legacyObjective = source.objective;
  delete source.objective;
  if (legacyObjective !== undefined) delete source.objective_migrated_from_v3;
  if (source.objective_fallback === undefined && objectiveFallbackGroups.includes(legacyObjective))
    source.objective_fallback = legacyObjective;
  const campaignIds = ids(source.campaign_ids),
    adsetIds = ids(source.adset_ids),
    adIds = ids(source.ad_ids);
  if (
    (adIds.length && !capabilities.levels.some(level => level.id === 'ad')) ||
    (adsetIds.length && !capabilities.levels.some(level => level.id === 'adset')) ||
    [
      [campaignIds, 'campaign'],
      [adsetIds, 'adset'],
      [adIds, 'ad'],
    ].some(([values, level]) =>
      (values as string[]).some(id => overviewV4ScopeIdentity(capabilities, level as string, id) === undefined),
    )
  )
    invalid('Choose ID scopes supported by this report source.');
  return {
    ...source,
    levels: [...levels],
    level: levels[0],
    report_options: options,
    campaign_ids: campaignIds,
    adset_ids: adsetIds,
    ad_ids: adIds,
    statuses: [...statuses],
    delivered_only: source.delivered_only ?? true,
    delivery_metrics: [...capabilities.delivery_metrics],
    status_basis: capabilities.status_basis,
    reporting_contract: overviewConfigV4,
    ...(objectiveFallbackGroups.includes(legacyObjective) ? {objective_migrated_from_v3: true} : {}),
  };
}

const scopeLevelOrder = ['campaign', 'adset', 'ad'];
export function overviewV4MeasurementLevel(source: JsonObject): 'ad' | 'adset' | undefined {
  if (source.ad_ids?.length) return 'ad';
  if (source.adset_ids?.length) return 'adset';
  return undefined;
}
/** A parent-only request still measures the selected descendants; supporting rows are disclosed separately. */
export function overviewV4CollectionLevels(source: JsonObject): string[] {
  const levels: string[] = [...source.levels],
    measurement = overviewV4MeasurementLevel(source);
  if (
    measurement &&
    levels.some(level => scopeLevelOrder.indexOf(level) < scopeLevelOrder.indexOf(measurement)) &&
    !levels.includes(measurement)
  )
    levels.push(measurement);
  return levels;
}
export function overviewV4ScopeIdentity(
  capabilities: OverviewV4Capabilities | undefined,
  level: string,
  value: unknown,
): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  if (capabilities?.scope_id_pattern && !new RegExp(capabilities.scope_id_pattern).test(value)) return undefined;
  const prefix = capabilities?.scope_id_prefixes?.[level],
    id = prefix && value.startsWith(prefix) ? value.slice(prefix.length) : value;
  return id || undefined;
}

/** One configured account; requested and supporting levels each get a deterministic checkpoint and row budget key. */
export function expandOverviewV4Sources(config: JsonObject, rollups = true): JsonObject[] {
  if (config.contract_version !== overviewConfigV4) return config.sources;
  return config.sources.flatMap((source: JsonObject, index: number) => {
    const {scope_supporting: _untrusted, ...owned} = source;
    return (rollups ? overviewV4CollectionLevels(source) : source.levels).map((level: string) => ({
      ...owned,
      level,
      source_ref: index,
      ...(!source.levels.includes(level) ? {scope_supporting: true} : {}),
    }));
  });
}

/** Observe activity before retained metric rounding. Any positive field proves it; missing no-positive fields do not. */
export function overviewV4Activity(metrics: JsonObject, fields: readonly string[]): boolean | null {
  const values = fields.map(key => metrics[key]),
    known = values.filter(value => value !== undefined && value !== null);
  if (known.some(value => providerDecimalText(value, {field: 'delivery'}) !== '0')) return true;
  return known.length === values.length ? false : null;
}

/** Unknown delivery/status cannot satisfy a positive filter. The caller discloses excluded unknowns in scope quality. */
export function overviewV4Scope(source: JsonObject, rows: JsonObject[], capabilities?: OverviewV4Capabilities) {
  const deliveryMetrics = capabilities?.delivery_metrics ?? source.delivery_metrics,
    statusBasis = capabilities?.status_basis ?? source.status_basis;
  if (!Array.isArray(deliveryMetrics) || !deliveryMetrics.length) invalid('Use supported report options.');
  let excluded = 0,
    unknown = 0,
    statusExcluded = 0;
  const selected = rows.filter(row => {
    const parents = row.parent_ids ?? {},
      level = row.entity_level ?? source.level ?? 'campaign',
      own = row.entity_id ?? row.campaign_id,
      values = {
        campaign_ids: level === 'campaign' ? own : (parents.campaign_id ?? row.campaign_id),
        adset_ids: level === 'adset' ? own : parents.adset_id,
        ad_ids: level === 'ad' ? own : undefined,
      };
    for (const [field, value] of Object.entries(values)) {
      const scopeLevel = {campaign_ids: 'campaign', adset_ids: 'adset', ad_ids: 'ad'}[field]!,
        identity = overviewV4ScopeIdentity(capabilities, scopeLevel, value);
      if (
        source[field]?.length &&
        (identity === undefined ||
          !source[field].some((id: string) => overviewV4ScopeIdentity(capabilities, scopeLevel, id) === identity))
      ) {
        excluded++;
        if (identity === undefined) unknown++;
        return false;
      }
    }
    if (!source.statuses.includes('all') && !source.statuses.includes(row.status)) {
      excluded++;
      statusExcluded++;
      if (!['active', 'paused', 'archived'].includes(row.status)) unknown++;
      return false;
    }
    if (source.delivered_only) {
      const exact = row.native?.exact_totals ?? {},
        activity = Object.hasOwn(row.native ?? {}, 'delivery_activity')
          ? row.native.delivery_activity
          : overviewV4Activity(
              Object.fromEntries(
                deliveryMetrics.map((key: string) => [
                  key,
                  Object.hasOwn(exact, key) ? exact[key] : row.metrics?.[key],
                ]),
              ),
              deliveryMetrics,
            );
      if (activity !== true) {
        excluded++;
        if (activity !== false) unknown++;
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
      excluded_status_rows: statusExcluded,
      filtering: 'after_collection',
      status_basis: statusBasis,
      ...(source.delivery_metrics === undefined ? {delivery_metrics: deliveryMetrics} : {}),
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
  const references = (snapshot.sources ?? []).map(
    (source: JsonObject) =>
      new Map<string, number>(
        (source.result_definitions ?? []).map((definition: JsonObject, index: number) => [
          JSON.stringify(definition),
          index,
        ]),
      ),
  );
  const resultContext = (context: JsonObject | undefined, sourceRef: number): JsonObject | undefined => {
    if (!context) return undefined;
    return {
      result_ref: context.definition ? references[sourceRef]?.get(JSON.stringify(context.definition)) : undefined,
      source: context.source,
      cost_source: context.cost_source,
      ...(context.unavailable_reason ? {unavailable_reason: context.unavailable_reason} : {}),
      ...(context.coverage && context.coverage.known < context.coverage.total ? {coverage: context.coverage} : {}),
      ...(context.cost_coverage && context.cost_coverage.known_pairs < context.cost_coverage.total
        ? {cost_coverage: context.cost_coverage}
        : {}),
      ...(Object.keys(context.rounding ?? {}).length ? {rounding: context.rounding} : {}),
    };
  };
  return rows.map(row => {
    const {native, lineage, objective_source, objective_group, objective_reason, ...visible} = row;
    const fields = snapshot.config.metrics
        ? [
            ...new Set<string>([
              ...snapshot.config.metrics,
              ...(snapshot.config.custom_metrics ?? []).map((metric: JsonObject) => metric.id),
            ]),
          ]
        : Object.keys(row.metrics ?? {}),
      partial = Object.fromEntries(
        Object.entries(row.metrics_coverage ?? {}).filter(
          ([name, value]: [string, any]) =>
            fields.includes(name) && (value.known ?? value.known_pairs ?? value.known_rows) < value.total,
        ),
      ),
      recommendation =
        row.recommendation &&
        Object.fromEntries(Object.entries(row.recommendation).filter(([key]) => key !== 'evidence'));
    return {
      ...(include.native === true
        ? visible
        : {
            row_key: row.row_key,
            source_ref: row.source_ref,
            entity_id: row.entity_id ?? row.campaign_id,
            entity_name: row.entity_name ?? row.campaign_name,
            native_entity_type: row.native_entity_type,
            ...(row.status !== undefined ? {status: row.status} : {}),
            ...(row.aggregation ? {aggregation: row.aggregation} : {}),
            currency: row.currency,
            date_from: row.date_from,
            date_to: row.date_to,
            complete: row.complete,
            result: row.result,
            result_context: resultContext(row.result_context, row.source_ref),
            ...(row.result_groups?.length > 1
              ? {
                  result_groups: row.result_groups.map((group: JsonObject) => ({
                    ...resultContext(group, row.source_ref),
                    result: group.result,
                    coverage: group.coverage,
                    cost_coverage: group.cost_coverage,
                  })),
                }
              : {}),
            metrics: Object.fromEntries(fields.map(key => [key, row.metrics?.[key] ?? null])),
            ...(Object.keys(partial).length ? {metrics_coverage: partial} : {}),
            ...(row.omitted_as_zero?.length ? {omitted_as_zero: row.omitted_as_zero} : {}),
            ...(row.quality?.metric_calculation_rounding
              ? {quality: {metric_calculation_rounding: row.quality.metric_calculation_rounding}}
              : {}),
            recommendation,
          }),
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
    };
  });
}

/** Account sources own lineage once; level/period evidence retains its context without copied lineage arrays. */
export function overviewV4Sources(results: JsonObject[], rows: JsonObject[], configured: JsonObject[]) {
  const withoutLineage = (value: any): any =>
    Array.isArray(value)
      ? value.map(withoutLineage)
      : object(value)
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([key]) => key !== 'lineage')
              .map(([key, child]) => [key, withoutLineage(child)]),
          )
        : value;
  return configured.map((source, sourceRef) => {
    const packets = results.filter(result => result.source.source_ref === sourceRef),
      requested = packets.filter(packet => !packet.source.scope_supporting),
      supporting = packets.filter(packet => packet.source.scope_supporting),
      rollups = requested.some(packet => packet.scope?.rollup),
      lineage = new Map<string, JsonObject>();
    for (const packet of packets) {
      for (const entry of [
        ...(packet.lineage ?? []),
        ...(packet.periods ?? []).flatMap((period: JsonObject) => period.lineage ?? []),
      ])
        lineage.set(JSON.stringify(entry), entry);
    }
    const {rows: ignoredRows, source: ignoredSource, metadata, ...first} = packets[0] ?? {};
    const definitions = new Map<string, JsonObject>();
    for (const row of rows.filter(row => row.source_ref === sourceRef))
      for (const context of [row.result_context, ...(row.result_groups ?? [])])
        if (context?.definition) definitions.set(JSON.stringify(context.definition), context.definition);
    return {
      ...withoutLineage(first),
      source,
      source_ref: sourceRef,
      complete: requested.length === source.levels.length && packets.every(packet => packet.complete),
      collection_complete:
        requested.length === source.levels.length &&
        packets.every(packet => packet.collection_complete !== false && !packet.error),
      lineage: [...lineage.values()],
      result_definitions: [...definitions.values()],
      projection: {
        quality: 'source_level_period',
        metric_coverage: 'partial_rows_only',
        advice_evidence: 'include_native',
      },
      row_count: requested.reduce((sum, packet) => sum + (packet.scope?.returned_rows ?? packet.rows.length), 0),
      scoped_row_count: requested.reduce((sum, packet) => sum + packet.rows.length, 0),
      ...(rollups
        ? {
            scope_input_row_count: requested.reduce(
              (sum, packet) => sum + (packet.scope?.input_rows ?? packet.scope?.returned_rows ?? packet.rows.length),
              0,
            ),
            derived_row_count: requested.reduce((sum, packet) => sum + (packet.scope?.rollup?.derived_rows ?? 0), 0),
            collection_row_count: packets.reduce(
              (sum, packet) => sum + (packet.scope?.returned_rows ?? packet.rows.length),
              0,
            ),
          }
        : {}),
      ...(supporting.length ? {supporting_levels: supporting.map(packet => packet.source.level)} : {}),
      visible_row_count: rows.filter(row => row.source_ref === sourceRef).length,
      warnings: [...new Set(packets.flatMap(packet => packet.warnings ?? []))],
      cross_level: reportLevelReconciliation(
        rows.filter(row => row.source_ref === sourceRef),
        packets,
        source.levels,
      ),
      level_results: packets.map(({rows: packetRows, source: packetSource, metadata: packetMetadata, ...data}) => ({
        ...withoutLineage(data),
        level: packetSource.level,
        ...(packetSource.scope_supporting ? {purpose: 'scope_rollup', visible: false} : {}),
        row_count: data.scope?.returned_rows ?? packetRows.length,
        scoped_row_count: packetRows.length,
      })),
    };
  });
}

export function projectOverviewV4Sources(snapshot: JsonObject, include: JsonObject = {}) {
  if (snapshot.config?.contract_version !== overviewConfigV4) return snapshot.sources;
  const project = (value: any): any =>
    Array.isArray(value)
      ? value.map(project)
      : object(value)
        ? Object.fromEntries(
            Object.entries(value)
              .filter(
                ([key]) =>
                  (key !== 'lineage' || include.lineage === true) &&
                  (!['native', 'native_account_evidence'].includes(key) || include.native === true),
              )
              .map(([key, child]) => [key, project(child)]),
          )
        : value;
  return project(snapshot.sources);
}

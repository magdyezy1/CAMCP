import {MirrorError} from './errors.js';
import {sha256, stable} from './security.js';
import {providerDecimalText} from './provider-decimal.js';
import {objectiveFallbackGroups} from './report-objectives.js';
import type {JsonObject} from './types.js';
import {levelFailure, reportLevelReconciliation} from './report-level-reconciliation.js';
import {coverageCounts} from './report-math-v4.js';
import {reportCoverageNotes} from './report-coverage-notes.js';
import {chartsWithChange} from './report-chart-change.js';
import type {ChartSpec} from './report-chart-spec.js';

export const overviewConfigV4 = 'overview-config-v4';
export const overviewDetailV4 = 'overview-detail-v4';
export const overviewV4ScopeContract = 'selected-descendants-v1';
/**
 * The values an option may take when the platform fixes them (attribution windows): what the editor offers, taken from
 * the platform's declaration and sent in the bootstrap, so no page keeps a list of its own (F-L5-15). `values` is every
 * choice in the platform's own order. A selection option (`exclusive` given) takes any of the values, but at most one of
 * the `exclusive` ones; otherwise the option takes exactly one value. `label` names the control (its exclusive group's,
 * for a selection) and `notes` glosses a value.
 */
export interface OverviewV4OptionChoice {
  readonly label: string;
  readonly values: readonly string[];
  readonly exclusive?: readonly string[];
  readonly notes?: Readonly<Record<string, string>>;
}
export interface OverviewV4Capabilities {
  levels: readonly {id: string; label: string; native_type: string; preset?: string}[];
  /** The provider source owns these facts; this module only validates/applies the supplied declaration. */
  defaults: Readonly<JsonObject>;
  option_names: readonly string[];
  /** The fixed choices of the options that have them, by option name; none for a platform without any. */
  option_choices?: Readonly<Record<string, OverviewV4OptionChoice>>;
  /** A positive observation of any of these source-owned metrics proves delivery or measurement activity. */
  delivery_metrics: readonly string[];
  supported_statuses: readonly string[];
  status_basis: 'current_configuration' | 'provider_report_status' | 'not_applicable';
  /** A provider-owned URN prefix when reports and parent metadata spell the same native identity differently. */
  scope_id_prefixes?: Readonly<Record<string, string>>;
  scope_id_pattern?: string;
  /**
   * The ID a scope selects a row by, when the provider names the row by something other than the ID a person copies from
   * its console (Google names an ad by its resource name). Absent or undefined: the row's own entity_id is the scope ID.
   */
  scopeEntityId?(row: JsonObject, level: string): string | undefined;
  /** Old scalar parent filters become the same native ID scope used by the current editor. */
  scope_aliases?: Readonly<Record<string, 'campaign_ids' | 'adset_ids' | 'ad_ids'>>;
  validateOptions?(options: JsonObject, context: {levels: readonly string[]}): void;
  legacy?: {
    /** The levels the build before V2 can collect for this platform; absent means all of the platform's levels. */
    levels?: readonly string[];
    campaign_options?: readonly string[];
    detail_options?: readonly string[];
    requires_action?: true;
    requires_complete?: true;
    /** Null retains a legacy campaign's provider-configured profile, including its original report-time mode. */
    provider_configured_options?: readonly string[];
    parent_required_levels?: readonly string[];
  };
}

/**
 * A stored definition holds its v3 form (`config`, what the build before V2 reads and edits) and, beside it, the v4
 * form (`config_v4`) it was made from. A build that does not know the sidecar edits `config` and leaves it behind, so
 * the sidecar names the `config` it was made from: this fingerprint (F-L6-05).
 */
export const overviewSidecarBasis = (config: JsonObject): string => sha256(stable(config));
/** The fields that write a definition's sidecar: the v4 form and the fingerprint of the v3 form it belongs to. */
export const overviewSidecar = (record: JsonObject, config: JsonObject): JsonObject => ({
  config_v4: config,
  config_v4_basis: overviewSidecarBasis(record.config),
});
/** Whether the sidecar still belongs to `config`. An absent or older one does not: `config` is then the newer edit. */
export const overviewSidecarCurrent = (record: JsonObject): boolean =>
  record.config_v4 !== undefined && record.config_v4_basis === overviewSidecarBasis(record.config);
/**
 * The one reader of a stored definition. Listing, editing, previewing, running, the bootstrap payload and the workspace
 * search all read this form, so they cannot disagree about which accounts a report names (F-L6-05).
 */
export const overviewDefinitionConfig = (record: JsonObject): JsonObject =>
  overviewSidecarCurrent(record) ? record.config_v4 : record.config;
/** Shown with a definition whose v3 form was edited by a build that does not know the sidecar. */
export const overviewStaleSidecarWarning = {
  code: 'DEFINITION_CHANGED_ELSEWHERE',
  message:
    'This report was edited on an earlier version of AMCP after it was last saved here. The edited version is used. Settings that only this version supports are no longer part of it; set them again if you need them.',
} as const;
/**
 * Whether the build a rollback returns to (Work-here) can run this stored definition: none of its sources or template
 * defaults carries the unsupported level that overviewDefinitionForms gives what the earlier form cannot express.
 * Such a report refuses to run there and its schedule pauses; everything else keeps running (F-L10-11).
 */
export const overviewRollbackSafe = (record: JsonObject): boolean =>
  ![...(record.config?.sources ?? []), ...Object.values(record.config?.source_defaults ?? {})].some(
    (source: any) => source?.level === 'v4_required',
  );
/** Do not expose both definition forms to clients or let an old renderer accidentally edit the wrong one. */
export function publicOverviewDefinition(record: JsonObject): JsonObject {
  const {config_v4, config_v4_basis, ...visible} = record,
    rollback_safe = overviewRollbackSafe(record);
  if (config_v4 === undefined) return {...visible, rollback_safe};
  const current = overviewSidecarCurrent(record);
  return {
    ...visible,
    config: overviewDefinitionConfig(record),
    rollback_safe,
    ...(current ? {} : {warnings: [overviewStaleSidecarWarning]}),
  };
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
  if (config.contract_version !== overviewConfigV4) return {config, config_v4: undefined, config_v4_basis: undefined};
  const current = structuredClone(config),
    legacy: JsonObject = {...current};
  delete legacy.contract_version;
  // Which charts a report leaves out (V2-EXP-01) is a setting of this form only; the build before V2 does not read it.
  delete legacy.charts;
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
        // A level that exists only in this build (the platform declares the ones the earlier build has).
        (rules.levels !== undefined && !rules.levels.includes(level)) ||
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
  return {config: legacy, config_v4: current, config_v4_basis: overviewSidecarBasis(legacy)};
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
/** The most native IDs one scope list of a source holds. The generated tool schema and the bootstrap read it from here. */
export const overviewV4ScopeIdLimit = 500;
const ids = (value: unknown): string[] => {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > overviewV4ScopeIdLimit ||
    value.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(id))
  )
    invalid('Use at most 500 exact native IDs for each report scope.');
  return [...new Set(value as string[])];
};
/**
 * What a v4 source gets for the fields it leaves out, the same for every platform (the options a platform defaults are its
 * own, `defaults`). Normalization applies it and the bootstrap states it, so a client is never told one thing and given
 * another.
 */
export const overviewV4SourceDefaults = Object.freeze({
  levels: Object.freeze(['campaign']),
  statuses: Object.freeze(['all']),
  delivered_only: true,
});
/** The statuses a source may filter by; a platform's `supported_statuses` is a subset (the measurement sources have `all`). */
export const overviewV4Statuses: readonly string[] = Object.freeze(['active', 'paused', 'archived', 'all']);
/** The levels where an option a provider configures may be left unset: the provider's own profile exists for campaigns. */
export const overviewV4ProviderConfiguredLevels: readonly string[] = Object.freeze(['campaign']);
/**
 * The rules of one platform's report sources as bootstrap states them (platforms[].reporting_v4), one block per platform
 * and per level: the levels, each with the list its native IDs go in; what a source that leaves them out gets; the
 * options, their defaults and fixed choices; the statuses; and where an option the provider configures may stay unset.
 * Every value is the table's, or the constant the validation applies, so none is a second copy.
 */
export function overviewV4Rules(capabilities: OverviewV4Capabilities | undefined): JsonObject {
  if (!capabilities)
    return {
      levels: [],
      defaults: {},
      option_names: [],
      option_choices: {},
      provider_configured_options: [],
      delivery_metrics: [],
      supported_statuses: ['all'],
      status_basis: 'not_applicable',
    };
  const providerConfigured = capabilities.legacy?.provider_configured_options ?? [];
  return {
    levels: capabilities.levels.map(level => ({
      ...level,
      scope_field: scopeLists.find(([, scopeLevel]) => scopeLevel === level.id)?.[0],
      ...(capabilities.scope_id_prefixes?.[level.id]
        ? {scope_id_prefix: capabilities.scope_id_prefixes[level.id]}
        : {}),
    })),
    defaults: capabilities.defaults,
    source_defaults: overviewV4SourceDefaults,
    option_names: capabilities.option_names,
    // The fixed choices of the options that have them (attribution windows), so the editor keeps no list (F-L5-15).
    option_choices: capabilities.option_choices ?? {},
    provider_configured_options: providerConfigured,
    ...(providerConfigured.length ? {provider_configured_levels: overviewV4ProviderConfiguredLevels} : {}),
    ...(capabilities.scope_aliases ? {scope_aliases: capabilities.scope_aliases} : {}),
    ...(capabilities.scope_id_pattern ? {scope_id_pattern: capabilities.scope_id_pattern} : {}),
    delivery_metrics: capabilities.delivery_metrics,
    supported_statuses: capabilities.supported_statuses,
    status_basis: capabilities.status_basis,
  };
}
/** No provider switches or invented defaults. Connection/account authorization remains at the caller's boundary. */
export function normalizeOverviewV4Source(input: JsonObject, capabilities: OverviewV4Capabilities): JsonObject {
  const source = structuredClone(input),
    levels = source.levels ?? [source.level ?? overviewV4SourceDefaults.levels[0]];
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
  // A detail level takes the preset's metrics. Native metrics named beside it would be added to the provider's request and
  // reach no row, so v4 refuses them as v3 does (overviewSourceLevel), before any request is sent.
  if (levels.some(level => level !== 'campaign') && source.native_metrics?.length)
    invalid(
      'Detailed reporting uses the preset metrics. Clear additional native metrics before selecting this level.',
      'INVALID_NATIVE_METRICS',
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
  const statuses = source.statuses ?? overviewV4SourceDefaults.statuses;
  if (
    !Array.isArray(statuses) ||
    !statuses.length ||
    new Set(statuses).size !== statuses.length ||
    statuses.some(status => !overviewV4Statuses.includes(status)) ||
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
    delivered_only: source.delivered_only ?? overviewV4SourceDefaults.delivered_only,
    delivery_metrics: [...capabilities.delivery_metrics],
    status_basis: capabilities.status_basis,
    reporting_contract: overviewConfigV4,
    ...(objectiveFallbackGroups.includes(legacyObjective) ? {objective_migrated_from_v3: true} : {}),
  };
}

const scopeLevelOrder = ['campaign', 'adset', 'ad'];
/** The ID lists a scope selects by, each with the level whose entities its IDs name. */
const scopeLists = [
  ['campaign_ids', 'campaign'],
  ['adset_ids', 'adset'],
  ['ad_ids', 'ad'],
] as const;
/** The same table for the generated tool schema and the bootstrap: the list field of each level's native IDs. */
export const overviewV4ScopeFields: readonly (readonly [field: string, level: string])[] = scopeLists;
/** The warning a source carries when selected IDs matched no row the provider returned (F-L5-27). */
export const unmatchedIdsWarning = (count: number) =>
  count + ' selected ID' + (count === 1 ? '' : 's') + ' matched no returned row.';
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
/** A platform's ID pattern is compiled once; a report at the row limit asks it for every row. */
const scopePatterns = new Map<string, RegExp>();
const scopePattern = (source: string) => {
  let pattern = scopePatterns.get(source);
  if (!pattern) scopePatterns.set(source, (pattern = new RegExp(source)));
  return pattern;
};
export function overviewV4ScopeIdentity(
  capabilities: OverviewV4Capabilities | undefined,
  level: string,
  value: unknown,
): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  if (capabilities?.scope_id_pattern && !scopePattern(capabilities.scope_id_pattern).test(value)) return undefined;
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
  // The identities of each list of selected IDs, once, so a row is matched by a lookup and not by comparing it with every
  // selected ID (F-L5-28).
  const wanted = new Map<string, Set<string | undefined>>();
  for (const [field, scopeLevel] of scopeLists)
    if (source[field]?.length)
      wanted.set(
        field,
        new Set(source[field].map((id: string) => overviewV4ScopeIdentity(capabilities, scopeLevel, id))),
      );
  // The selected IDs some returned row carries, whatever else excludes that row afterwards.
  const matched: Record<string, Set<string>> = {campaign_ids: new Set(), adset_ids: new Set(), ad_ids: new Set()};
  const selected = rows.filter(row => {
    const parents = row.parent_ids ?? {},
      level = row.entity_level ?? source.level ?? 'campaign',
      own = capabilities?.scopeEntityId?.(row, level) ?? row.entity_id ?? row.campaign_id,
      values = {
        campaign_ids: level === 'campaign' ? own : (parents.campaign_id ?? row.campaign_id),
        adset_ids: level === 'adset' ? own : parents.adset_id,
        ad_ids: level === 'ad' ? own : undefined,
      };
    let refusal: 'unknown' | 'other' | undefined;
    for (const [field, scopeLevel] of scopeLists) {
      if (!source[field]?.length) continue;
      const identity = overviewV4ScopeIdentity(capabilities, scopeLevel, values[field]);
      if (identity !== undefined && wanted.get(field)!.has(identity)) matched[field]!.add(identity);
      else refusal ??= identity === undefined ? 'unknown' : 'other';
    }
    if (refusal) {
      excluded++;
      if (refusal === 'unknown') unknown++;
      return false;
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
  // A selected ID that no returned row of this level carries is named, so a mistyped or stale ID cannot narrow a total
  // unnoticed. Only the lists this level can answer are checked: an ad ID is matched by ad rows alone (F-L5-27).
  const unmatched: Record<string, string[]> = {},
    rank = scopeLevelOrder.indexOf(source.level ?? 'campaign');
  for (const [field, scopeLevel] of scopeLists) {
    if (!source[field]?.length || scopeLevelOrder.indexOf(scopeLevel) > rank) continue;
    const missing = source[field].filter((id: string) => {
      const identity = overviewV4ScopeIdentity(capabilities, scopeLevel, id);
      return identity === undefined || !matched[field]!.has(identity);
    });
    if (missing.length) unmatched[field] = missing;
  }
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
      ...(Object.keys(unmatched).length ? {unmatched_ids: unmatched} : {}),
      ...(source.delivery_metrics === undefined ? {delivery_metrics: deliveryMetrics} : {}),
    },
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
    const {
      native,
      lineage,
      objective_source,
      objective_group,
      objective_reason,
      objective_reason_code,
      objective_reason_values,
      ...visible
    } = row;
    const fields = snapshot.config.metrics
        ? [
            ...new Set<string>([
              ...snapshot.config.metrics,
              ...(snapshot.config.custom_metrics ?? []).map((metric: JsonObject) => metric.id),
            ]),
          ]
        : Object.keys(row.metrics ?? {}),
      partial = Object.fromEntries(
        Object.entries(row.metrics_coverage ?? {}).filter(([name, value]: [string, any]) => {
          const {known, total} = coverageCounts(value);
          return fields.includes(name) && (value.unavailable_reason !== undefined || known < total);
        }),
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
            ...(row.other_results?.length ? {other_results: row.other_results} : {}),
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
        // The stable code of the reason (and the platform and objective it names), for the page to word; a snapshot recorded
        // before the code has the sentence alone.
        ...(objective_reason_code ? {reason_code: objective_reason_code} : {}),
        ...(objective_reason_values ? {reason_values: objective_reason_values} : {}),
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

/**
 * What a source states about its account and its collection. It is taken from the first level that collected, never
 * from the first level: a failed level has none of it, and the facts of an account are the same for every level. The
 * fields are named, so a field added to a packet is not promoted to the source by accident (F-L5-10). Whatever varies
 * by level is derived from the levels below, or stays in `level_results`.
 */
const sourceFacts = [
  'account_name',
  'currency',
  'timezone',
  'source_kind',
  'date_range',
  'captured_at',
  'attribution',
  'result_definition',
  'contract_version',
  'detail_contract',
  'query_fingerprint',
  'quality',
  'scope',
  'periods',
  'collection_mode',
  'open_window',
  'scope_limitations',
  'window_resolution',
  'native_account_evidence',
  'source_hash',
  'metric_mapping',
  'report_time_zone',
  'native_population',
  'no_activity_count',
] as const;

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
    const collected = packets.find(packet => !packet.error),
      facts = Object.fromEntries(
        sourceFacts.flatMap(key => (collected?.[key] === undefined ? [] : [[key, withoutLineage(collected[key])]])),
      ),
      // A source is failed when every level it was asked for failed, and partial when only some did: those levels are
      // named, and the source carries no error of its own, so the page does not call a source failed that has rows.
      failedLevels = requested.flatMap(packet => {
        const error = levelFailure(packet, packets);
        return error ? [{level: packet.source.level, error}] : [];
      }),
      periodErrors = packets.flatMap(packet =>
        (packet.period_errors ?? []).map((entry: JsonObject) => ({
          ...withoutLineage(entry),
          level: packet.source.level,
        })),
      );
    // A selected ID is unmatched when no level able to answer for it found a row carrying it (F-L5-27).
    const unmatched = Object.fromEntries(
        scopeLists.flatMap(([field, scopeLevel]) => {
          const ids: string[] = source[field] ?? [],
            answering = packets.filter(
              packet =>
                !packet.error && scopeLevelOrder.indexOf(packet.source.level) >= scopeLevelOrder.indexOf(scopeLevel),
            ),
            missing = answering.length
              ? ids.filter(id => answering.every(packet => packet.scope?.unmatched_ids?.[field]?.includes(id)))
              : [];
          return missing.length ? [[field, missing]] : [];
        }),
      ),
      unmatchedCount = Object.values(unmatched).reduce((n, ids) => n + ids.length, 0);
    const definitions = new Map<string, JsonObject>();
    for (const row of rows.filter(row => row.source_ref === sourceRef))
      for (const context of [row.result_context, ...(row.result_groups ?? [])])
        if (context?.definition) definitions.set(JSON.stringify(context.definition), context.definition);
    return {
      ...facts,
      ...(packets.some(packet => packet.period_errors) ? {period_errors: periodErrors} : {}),
      ...(packets.some(packet => packet.collection_limit !== undefined)
        ? {collection_limit: packets.some(packet => packet.collection_limit)}
        : {}),
      ...(failedLevels.length ? {failed_levels: failedLevels} : {}),
      ...(unmatchedCount ? {unmatched_ids: unmatched} : {}),
      ...(failedLevels.length && failedLevels.length === requested.length ? {error: failedLevels[0]!.error} : {}),
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
      warnings: [
        ...new Set(packets.flatMap(packet => packet.warnings ?? [])),
        ...(unmatchedCount ? [unmatchedIdsWarning(unmatchedCount)] : []),
      ],
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

/**
 * The charts of a v4 snapshot as `get` returns them (V2-EXP-01): the ones stored with it, with the change of the key figures
 * read from the linked baseline when there is one that can be compared. A snapshot recorded before charts, or one that is
 * not v4, has none and gets none.
 */
export function projectOverviewV4Charts(snapshot: JsonObject, baseline?: JsonObject): JsonObject {
  if (snapshot.config?.contract_version !== overviewConfigV4 || !Array.isArray(snapshot.charts)) return {};
  return {charts: chartsWithChange(snapshot.charts as ChartSpec[], snapshot, baseline)};
}

/**
 * The summaries of a v4 snapshot as `get` returns them: each says which of its metrics were calculated from fewer units
 * than it has (`coverage_notes`, from the one computation every surface renders, F-L5-01). An empty list means every
 * figure is complete. It is derived on every read from the stored coverage, so a snapshot stored before the notes existed
 * gets them too, and nothing stored changes. Other snapshots keep the representation they were recorded in.
 */
export function projectOverviewV4Summaries(snapshot: JsonObject): JsonObject {
  if (snapshot.config?.contract_version !== overviewConfigV4) return {};
  const fields = snapshot.config.metrics
      ? [
          ...new Set<string>([
            ...snapshot.config.metrics,
            ...(snapshot.config.custom_metrics ?? []).map((metric: JsonObject) => metric.id),
          ]),
        ]
      : undefined,
    withNotes = (summaries: JsonObject[]) =>
      summaries.map(summary => ({...summary, coverage_notes: reportCoverageNotes(summary, fields)}));
  return {
    ...(Array.isArray(snapshot.summary) ? {summary: withNotes(snapshot.summary)} : {}),
    ...(Array.isArray(snapshot.window_summary) ? {window_summary: withNotes(snapshot.window_summary)} : {}),
  };
}

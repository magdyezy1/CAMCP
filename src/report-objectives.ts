import {objectiveGroup, objectiveGroups} from './report-metrics.js';
import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';

export type ObjectiveSource =
  'user_override' | 'provider' | 'provider_mapped' | 'provider_inferred' | 'user_fallback' | 'unknown';

/** Provider facts are declared on report sources; the shared resolver knows no provider request or field. */
export interface ObjectiveTable {
  readonly name: string;
  readonly values: Readonly<Record<string, string | null>>;
  /** A native objective may need a row-specific explanation, such as the objectives of a mixed group. */
  reason?(native: string, inputs: JsonObject): string | null;
  mapped?(inputs: JsonObject): {group: string; reason: string | null} | undefined;
  readonly missingReason: string;
}
export interface ResolvedObjective {
  native: string | null;
  group: string;
  source: ObjectiveSource;
  reason: string | null;
}
export const objectiveFallbackGroups: readonly string[] = Object.freeze(
  objectiveGroups.filter(group => group !== 'unknown'),
);
/** A group row may be mixed; a definition can never choose, filter or target it. */
export const mixedObjectiveGroup = 'mixed';
/**
 * Why a campaign's objective was not read: the platform refused the optional read, or the report has more entities than
 * AMCP reads campaign details for. A row read without an objective is not unread: the platform answered with none.
 */
export type ObjectiveUnread = 'refused' | 'limited';
/** The reason without a fallback, and with the user's fallback covering the unread value. */
const unreadReasons: Readonly<Record<ObjectiveUnread, readonly [string, string]>> = Object.freeze({
  refused: [
    'AMCP could not read this campaign’s objective because the platform refused the read; choose one in the report.',
    'AMCP could not read this campaign’s objective because the platform refused the read, so your fallback is used.',
  ],
  limited: [
    'AMCP could not read this campaign’s objective because this report has more entities than AMCP reads campaign details for; choose one in the report.',
    'AMCP could not read this campaign’s objective because this report has more entities than AMCP reads campaign details for, so your fallback is used.',
  ],
});

export function resolveObjective(input: {
  platform: string;
  table: ObjectiveTable | undefined;
  native?: unknown;
  campaignId?: string;
  mappedInputs?: JsonObject;
  overrides?: Record<string, string>;
  legacy?: string;
  fallback?: string;
  /** Set by the collector that could not read the campaign's objective, so a missing value is not blamed on the platform. */
  unread?: ObjectiveUnread;
}): ResolvedObjective {
  const native =
    typeof input.native === 'string' && input.native.trim() && input.native !== 'unknown' ? input.native : null;
  const resolved = (group: string, source: ObjectiveSource, reason: string | null): ResolvedObjective => ({
    native,
    group,
    source,
    reason,
  });
  const choice = (value: unknown): value is string =>
    typeof value === 'string' && objectiveFallbackGroups.includes(value);
  const campaignId = input.campaignId ? objectiveCampaignId(input.campaignId) : undefined;
  if (campaignId && input.overrides && Object.hasOwn(input.overrides, campaignId)) {
    const group = input.overrides[campaignId];
    if (choice(group)) return resolved(group, 'user_override', 'Chosen for this campaign in the report.');
  }
  if (choice(input.legacy))
    return resolved(input.legacy, 'user_override', 'Chosen for every campaign of this source in the saved report.');
  const table = input.table;
  const nativeGroup =
    table && native !== null && Object.hasOwn(table.values, native) ? table.values[native] : undefined;
  if (nativeGroup === mixedObjectiveGroup || choice(nativeGroup))
    return resolved(nativeGroup, 'provider', table?.reason?.(native!, input.mappedInputs ?? {}) ?? null);
  if (table && native && nativeGroup === undefined) {
    const inferred = objectiveGroup(native);
    if (choice(inferred))
      return resolved(
        inferred,
        'provider_inferred',
        'Inferred from the platform’s value {native}.'.replace('{native}', () => native),
      );
  }
  const mapped = table?.mapped?.(input.mappedInputs ?? {});
  if (mapped && choice(mapped.group)) return resolved(mapped.group, 'provider_mapped', mapped.reason);
  const unread =
    native === null && input.unread && Object.hasOwn(unreadReasons, input.unread) ? input.unread : undefined;
  if (choice(input.fallback))
    return resolved(input.fallback, 'user_fallback', unread ? unreadReasons[unread][1] : null);
  let reason = table?.missingReason ?? 'This source has no campaign objective.';
  if (table && native)
    reason = (
      nativeGroup === null
        ? '{platform}’s {native} has no matching AMCP objective; choose one in the report.'
        : '{platform} returned the objective {native}, which AMCP does not group yet; choose one in the report.'
    )
      .replace('{platform}', () => table.name)
      .replace('{native}', () => native);
  else if (unread) reason = unreadReasons[unread][0];
  return resolved('unknown', 'unknown', reason);
}

/** Compare override keys without rewriting the native campaign identity stored on a report row. */
export const objectiveCampaignId = (id: string): string =>
  id.replace(/^urn:li:sponsoredCampaign(?:Group)?:([0-9]+)$/, '$1');

/** Validate and canonicalize only the new definition fields; a saved legacy choice remains untouched. */
export function validateObjectiveFields(source: JsonObject): void {
  if (source.objective_fallback !== undefined && !objectiveFallbackGroups.includes(source.objective_fallback))
    throw new MirrorError(
      'INVALID_REPORT',
      'Choose an objective fallback from awareness, traffic, engagement, video_views, leads, sales, app_installs.',
    );
  if (source.objective_overrides === undefined) return;
  const overrides = source.objective_overrides;
  if (
    !overrides ||
    typeof overrides !== 'object' ||
    Array.isArray(overrides) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(overrides)) ||
    Object.keys(overrides).length > 500 ||
    Object.entries(overrides).some(
      ([id, group]) =>
        !/^[A-Za-z0-9_.:-]{1,200}$/.test(id) || typeof group !== 'string' || !objectiveFallbackGroups.includes(group),
    )
  )
    throw new MirrorError(
      'INVALID_REPORT',
      'Use up to 500 campaign objective overrides with valid campaign IDs and objectives: awareness, traffic, engagement, video_views, leads, sales, app_installs.',
    );
  const canonical = new Map<string, string>();
  for (const [id, value] of Object.entries(overrides) as [string, string][]) {
    const key = objectiveCampaignId(id);
    if (canonical.has(key) && canonical.get(key) !== value)
      throw new MirrorError('INVALID_REPORT', 'Objective overrides for the same campaign must agree.');
    canonical.set(key, value);
  }
  source.objective_overrides = Object.fromEntries(canonical);
}

/** Native rows count as a match even when an objective display filter later hides them. */
export function unusedObjectiveOverrides(source: JsonObject, rows: JsonObject[]): string | undefined {
  const present = new Set(
    rows.filter(row => typeof row.campaign_id === 'string').map(row => objectiveCampaignId(row.campaign_id)),
  );
  const ids = Object.keys(source.objective_overrides ?? {}).filter(id => !present.has(id));
  if (!ids.length) return;
  return (
    'Objective overrides matched no campaign in this snapshot: ' +
    ids.slice(0, 10).join(', ') +
    (ids.length > 10 ? ' and ' + (ids.length - 10) + ' more.' : '.')
  );
}

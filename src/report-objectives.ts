import {objectiveGroup, objectiveGroups} from './report-metrics.js';
import type {JsonObject} from './types.js';

export type ObjectiveSource =
  'user_override' | 'provider' | 'provider_mapped' | 'provider_inferred' | 'user_fallback' | 'unknown';

/** Provider facts are declared on report sources; the shared resolver knows no provider request or field. */
export interface ObjectiveTable {
  readonly name: string;
  readonly values: Readonly<Record<string, string | null>>;
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

export function resolveObjective(input: {
  platform: string;
  table: ObjectiveTable | undefined;
  native?: unknown;
  campaignId?: string;
  mappedInputs?: JsonObject;
  overrides?: Record<string, string>;
  legacy?: string;
  fallback?: string;
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
  if (input.campaignId && input.overrides && Object.hasOwn(input.overrides, input.campaignId)) {
    const group = input.overrides[input.campaignId];
    if (choice(group)) return resolved(group, 'user_override', 'Chosen for this campaign in the report.');
  }
  if (choice(input.legacy))
    return resolved(input.legacy, 'user_override', 'Chosen for every campaign of this source in the saved report.');
  const table = input.table;
  const nativeGroup =
    table && native !== null && Object.hasOwn(table.values, native) ? table.values[native] : undefined;
  if (choice(nativeGroup)) return resolved(nativeGroup, 'provider', null);
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
  if (choice(input.fallback)) return resolved(input.fallback, 'user_fallback', null);
  let reason = table?.missingReason ?? 'This source has no campaign objective.';
  if (table && native)
    reason = (
      nativeGroup === null
        ? '{platform}’s {native} has no matching AMCP objective; choose one in the report.'
        : '{platform} returned the objective {native}, which AMCP does not group yet; choose one in the report.'
    )
      .replace('{platform}', () => table.name)
      .replace('{native}', () => native);
  return resolved('unknown', 'unknown', reason);
}

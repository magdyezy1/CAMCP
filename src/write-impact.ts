import type {CompiledRequest, JsonObject} from './types.js';
import {familyOf} from './reviewed-families.js';
// A provider's impact (ARC-01 phase B, wave 4c): its adapter's `writes.impact` (Snapchat's creative edits and segment
// replacements, Meta's creative choices), asked after a family's own where this stage named the provider.
import {providerHooks} from './provider-hooks.js';

/** What a reviewed write changes beyond its target: a family's impact first, then its provider's; undefined for none. */
export function writeImpact(
  plan: CompiledRequest,
  state: unknown[],
  override: boolean,
  connectionId: string,
): JsonObject | undefined {
  const family = familyOf(plan),
    familyImpact = family?.impact?.(plan, state, {creativeEditConfirmed: override, connectionId});
  if (familyImpact) return familyImpact;
  return providerHooks(plan.gateway)?.writes?.impact?.(plan, state);
}

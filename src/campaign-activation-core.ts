import type {Actor, JsonObject} from './types.js';
import {bad} from './workspace-core.js';

/**
 * What every provider's launch activation shares (CMP-03; ARC-01 phase B, wave 4c: each provider's activation steps
 * and read-only gates left src/campaign-activation.ts for its own module and are its adapter's `campaign.activation`):
 * the verified results of a completed plan, the checks of a native ID read from them, and a failed gate's shape.
 */
export type Results = ReadonlyMap<string, JsonObject>;
export const numeric = /^[1-9][0-9]{0,31}$/,
  uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function unavailable(what: string): never {
  return bad(
    'The completed plan holds no verified ' +
      what +
      ', so AMCP cannot name what to activate. Activate it in the provider, or check the plan’s read-back.',
    'ACTIVATION_UNAVAILABLE',
    {missing: what},
  );
}
/** One value of a verified step's result, checked against the shape of a native ID. */
export function verified(
  results: Results,
  step: string,
  read: (result: JsonObject) => unknown,
  shape: RegExp,
  what: string,
) {
  const result = results.get(step),
    value = result ? read(result) : undefined;
  if ((typeof value !== 'string' && typeof value !== 'number') || !shape.test(String(value))) unavailable(what);
  return String(value);
}
/** A failed gate: the preflight check that blocks the activation plan, with what the provider showed. */
export const blocked = (step: string, gate: string, message: string, observed: JsonObject = {}) => ({
  step,
  status: 'blocked',
  gate,
  error: {code: 'ACTIVATION_GATE_BLOCKED', message, details: {gate, ...observed}},
});
/** Reads the current Google conversion configuration (google-goal-inspection.ts), as recipe_eligibility does. */
export type ConversionGoalInspector = (actor: Actor, scope: JsonObject, current: () => void) => Promise<JsonObject>;

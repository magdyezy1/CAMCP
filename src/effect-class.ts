import type {CompiledRequest} from './types.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {familyOf} from './reviewed-families.js';
import {applyExecutionRisk} from './execution-risk.js';
import {writeEffects} from './write-effects.js';
import {spendConfirmationError} from './preflight.js';
import {microsoftGateway} from './microsoft-native.js';

/**
 * One effect taxonomy for every request AMCP sends (RPT-06, shared with WRT-06). A request has exactly one class, the
 * first that applies in this order:
 *
 * - `read`: independently read-only (execution-risk.ts); changes nothing at the provider.
 * - `provider_validation`: the provider checks a mutation without applying it (provider-validation.ts, WRT-06). It is
 *   the class of the validation call, never of a compiled plan.
 * - `provider_job`: creates a provider-side processing object (a report, export or change-log job) and uses provider
 *   quota, but changes no serving configuration or spend.
 * - `destructive`: deletes or removes something (allow_deletion, the destructive_confirmed tier).
 * - `publish`: makes a change live for everyone at once (a Tag Manager publish, a submitted sitemap).
 * - `spend_affecting`: needs spend_change_confirmed (preflight.ts): budgets, bids, delivery and activation.
 * - `config_write`: every other reviewed write.
 */
export const effectClasses = [
  'read',
  'provider_validation',
  'provider_job',
  'config_write',
  'spend_affecting',
  'publish',
  'destructive',
] as const;
export type EffectClass = (typeof effectClasses)[number];
/**
 * What a reviewed family declares (ReviewedFamily.effect): `provider_job` for a report or export job family, or
 * `reviewed_write` (the default) for a family whose requests are classified per request among the write classes.
 */
export const familyEffects = ['provider_job', 'reviewed_write'] as const;
export type FamilyEffect = (typeof familyEffects)[number];
/** The effect a family declares for one of its requests; a family that declares none writes. */
export function familyEffect(family: ReviewedFamily | undefined, plan: CompiledRequest): FamilyEffect {
  const effect = family?.effect;
  return (typeof effect === 'function' ? effect(plan) : effect) ?? 'reviewed_write';
}
/** Microsoft's report submission: the reporting pipeline's provider job, compiled as a read (src/microsoft-native.ts). */
export function microsoftReportSubmit(plan: CompiledRequest): boolean {
  return plan.gateway === microsoftGateway && plan.action === 'SubmitGenerateReport' && plan.method === 'POST';
}
/** A reviewed family's provider job: the requests the owner's provider-job switch may admit (RPT-06). */
export function reviewedProviderJob(plan: CompiledRequest): boolean {
  const family = familyOf(plan);
  return !!family && familyEffect(family, plan) === 'provider_job';
}
/** Every provider job: a reviewed family's job, or Microsoft's report submission. */
export function providerJob(plan: CompiledRequest): boolean {
  return microsoftReportSubmit(plan) || reviewedProviderJob(plan);
}
/** The effect class of a compiled request; `before`, the reviewed state, refines deletion and publishing. */
export function effectClass(plan: CompiledRequest, before?: unknown[]): EffectClass {
  if (providerJob(plan)) return 'provider_job';
  const risk = applyExecutionRisk(plan, before);
  if (risk.readOnly) return 'read';
  if (risk.destructive) return 'destructive';
  if (writeEffects(risk, before)?.publishes_live) return 'publish';
  if (spendConfirmationError(risk)) return 'spend_affecting';
  return 'config_write';
}

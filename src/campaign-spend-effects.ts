import type {Registry} from './catalog.js';
import type {Compiler} from './compiler.js';
import type {DelegatedNativeCompiler} from './delegated-native.js';
import {applyExecutionRisk} from './execution-risk.js';
import {spendConfirmationError} from './preflight.js';
import {providerHooks} from './provider-hooks.js';
import {familyOf} from './reviewed-families.js';
import {standInArguments} from './plan-reference-standins.js';
import {normalizeAccount} from './scope.js';
import type {CallOptions, JsonObject} from './types.js';
import {assertWriteShape} from './write-shape.js';

/**
 * Which write steps of a plan need spend_change_confirmed, decided locally (R2.5 r25-field-plan, the owner's Google issue 2, fix (a)).
 *
 * A plan approval used to offer spend_change_confirmed only for a step that names a money field, while every review asks for it by a
 * structural rule (src/preflight.ts `spendConfirmationError`: any active status, any positive criterion, any atomic build, any spend-named
 * key). The two rules disagreed, so a plan that switches things on without naming a budget was approved without the flag and `run` then
 * stopped at each step. The approval now asks the rule the reviews ask.
 *
 * Each write step is compiled as `amcp_write inspect` compiles it (the catalog's own validation, the compiler, the request's execution risk,
 * the write shape and the family's availability): locally, with no request and no credentials, and with no review saved. A reference to
 * a predecessor's result that is not known yet takes the well-formed stand-in the plan's preflight gives it (src/plan-reference-standins.ts,
 * the one function both ask, through the provider's own `reference` hook), so a step that names a result still compiles. The answer is the rule the review
 * applies at execute: the request needs spend_change_confirmed unless it is read-only.
 *
 * It fails closed: a step that cannot be compiled counts as spending, so nothing is shown as safe because it could not be checked. Every
 * write step is compiled, settled or not, and always with stand-ins, never with results: the answer is then a function of the plan alone, so
 * the approval summary, which binds it, does not change while the plan runs (a re-approval of the same summary_hash stays valid).
 */
export interface SpendEffectService {
  readonly registry: Registry;
  readonly compiler: Compiler;
  readonly delegatedCompiler: DelegatedNativeCompiler;
  readonly options: CallOptions;
}

/**
 * A step's arguments with each `$ref` replaced by the stand-in of the result it names, the one the preflight gives it (src/plan-reference-standins.ts:
 * one function for both, so that the approval's spend effects and the preflight judge the same request; the provider's hook decides its shape and
 * varies only the number). The preflight refuses a reference to a step that is not a declared predecessor before the plan is approved; here it
 * only means the step cannot be compiled, which counts as spending.
 */
function standIns(service: SpendEffectService, steps: readonly JsonObject[], step: JsonObject): any {
  return standInArguments({
    step,
    steps,
    reference: providerHooks(step.gateway)?.campaign?.preflight?.reference,
    compile: (target: string, args: JsonObject) => service.compiler.compile(target, args, service.options),
  }).arguments;
}

/** Whether one write step's review will ask execute for spend_change_confirmed; true when that cannot be decided. */
function spends(service: SpendEffectService, steps: readonly JsonObject[], step: JsonObject): boolean {
  try {
    const gateway = String(step.gateway),
      delegated = service.registry.tools.get(gateway)?.mode === 'delegated',
      args = standIns(service, steps, step);
    // The account goes where the step's tool takes it, as the plan puts it there before a step is prepared.
    if (service.registry.acceptsArgument(gateway, 'account_id', delegated ? args.operation : undefined)) {
      const account = normalizeAccount(gateway, step.account_id);
      if (delegated) args.arguments = {...args.arguments, account_id: account};
      else args.account_id = account;
    }
    service.registry.validate(gateway, args, service.options);
    const plan = applyExecutionRisk(
      delegated
        ? service.delegatedCompiler.compile(gateway, args)
        : service.compiler.compile(gateway, args, service.options),
    );
    // The checks `amcp_write inspect` makes of a request before it says it can be reviewed.
    assertWriteShape(plan);
    familyOf(plan)?.available?.(plan);
    return !plan.readOnly && spendConfirmationError(plan) !== undefined;
  } catch {
    return true;
  }
}

/**
 * The spend effect of every write step of a plan, by step ID: true when its review will ask execute for spend_change_confirmed. A media
 * step is no write and is not named. Nothing is sent, read or saved.
 */
export function stepSpendEffects(service: SpendEffectService, steps: readonly JsonObject[]): Map<string, boolean> {
  const effects = new Map<string, boolean>();
  for (const step of steps) if (step.kind === 'write') effects.set(step.id, spends(service, steps, step));
  return effects;
}

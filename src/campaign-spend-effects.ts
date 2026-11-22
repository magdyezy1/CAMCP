import type {Registry} from './catalog.js';
import type {Compiler} from './compiler.js';
import type {DelegatedNativeCompiler} from './delegated-native.js';
import {applyExecutionRisk} from './execution-risk.js';
import {spendConfirmationError} from './preflight.js';
import {providerHooks} from './provider-hooks.js';
import {familyOf, reviewedFamilies} from './reviewed-families.js';
import {standInArguments} from './plan-reference-standins.js';
import {normalizeAccount} from './scope.js';
import type {CallOptions, CompiledRequest, JsonObject} from './types.js';
import {assertWriteShape} from './write-shape.js';
import type {StepEffectFacts} from './plan-approval.js';
import {obj} from './workspace-core.js';
import {writeEffects} from './write-effects.js';

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

/** The request a write step compiles to, as `amcp_write inspect` compiles it; it throws when the step cannot be compiled. */
function compiledStep(service: SpendEffectService, steps: readonly JsonObject[], step: JsonObject): CompiledRequest {
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
  return applyExecutionRisk(
    delegated
      ? service.delegatedCompiler.compile(gateway, args)
      : service.compiler.compile(gateway, args, service.options),
  );
}

/**
 * What one write step's review will say of it, from one local compile (r25-approval-effects, the lead's review S2-1): whether it will ask execute
 * for spend_change_confirmed, and whether it deletes or ends something, by the review's own `writeEffects` over the same compiled request
 * (a status value its provider documents as a deletion, a `remove` operation, a DELETE method or a family's own hook, so no platform is
 * missed because of how it spells deleting). Where the step cannot be compiled nothing is known: it counts as spending and as possibly
 * destructive (`checked: false`), never as safe.
 */
function judged(service: SpendEffectService, steps: readonly JsonObject[], step: JsonObject): StepEffectFacts {
  try {
    const plan = compiledStep(service, steps, step);
    // The checks `amcp_write inspect` makes of a request before it says it can be reviewed.
    assertWriteShape(plan);
    familyOf(plan)?.available?.(plan);
    const effects = plan.readOnly ? undefined : writeEffects(plan);
    return {
      spend: !plan.readOnly && spendConfirmationError(plan) !== undefined,
      destructive: effects?.destructive === true,
      irreversible: effects?.irreversible === true,
      checked: true,
    };
  } catch {
    return {spend: true, destructive: true, irreversible: true, checked: false};
  }
}
/** Whether a value names one of `names` as a key, at any depth. */
const namesKey = (value: unknown, names: ReadonlySet<string>): boolean =>
  Array.isArray(value)
    ? value.some(v => namesKey(v, names))
    : obj(value) && Object.entries(value).some(([k, v]) => names.has(k) || namesKey(v, names));

/**
 * The steps of a plan (or of a saved template) that apply a secret-like value, such as a creator's authorization code, by step ID
 * (r25-m4b-smartpush, the lead's review S1-2, probe P8). A plan is stored as it is written and its steps never send the value that an
 * execute takes again (src/secret-fields.ts), so such a step could only store the value and never run: it is refused (`noSecretSteps`,
 * src/workspace-core.ts). A step is one when its action's family declares `secretFields`, decided by compiling the step locally as above,
 * or, where the step cannot be compiled, when its arguments name a field some family holds by its digest, at any depth: the value could be
 * stored all the same. `only` limits the answer to the steps it names (an amendment judges the step it amends). Nothing is sent or saved.
 */
export function stepsWithSecretFields(
  service: SpendEffectService,
  steps: readonly JsonObject[],
  only?: ReadonlySet<string>,
): string[] {
  const names = new Set(reviewedFamilies().flatMap(family => family.secretFields?.fields ?? []));
  const holds = (step: JsonObject): boolean => {
    if (namesKey(step.arguments, names)) return true;
    if (step.kind !== 'write') return false;
    try {
      return familyOf(compiledStep(service, steps, step))?.secretFields !== undefined;
    } catch {
      return false;
    }
  };
  return steps.filter(step => (!only || only.has(String(step.id))) && holds(step)).map(step => String(step.id));
}

/**
 * The effects of every write step of a plan, by step ID: what its review will ask (spend_change_confirmed) and whether it deletes, from one
 * compile of the step (`judged`). A media step is no write and is not named. Nothing is sent, read or saved.
 */
export function stepEffects(service: SpendEffectService, steps: readonly JsonObject[]): Map<string, StepEffectFacts> {
  const effects = new Map<string, StepEffectFacts>();
  for (const step of steps) if (step.kind === 'write') effects.set(step.id, judged(service, steps, step));
  return effects;
}

/** The spend effect of every write step of a plan, by step ID: true when its review will ask execute for spend_change_confirmed. */
export function stepSpendEffects(service: SpendEffectService, steps: readonly JsonObject[]): Map<string, boolean> {
  return new Map([...stepEffects(service, steps)].map(([id, facts]) => [id, facts.spend]));
}

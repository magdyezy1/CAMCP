import {MirrorError} from './errors.js';
import type {ReviewedFamily} from './reviewed-family.js';
import type {JsonObject} from './types.js';

/**
 * The reviewed-family kit (ARC-04 stage C): what family modules each declared for themselves. A leaf that imports no
 * lifecycle module, so a family module may use it without joining the registry's import cycle.
 *
 * `fail` is the refusal helper family modules had copied byte for byte, and the factories below build the variants that
 * modules had written with their own codes and statuses. tools/check-locales.mjs owns the reason of every call to `fail`
 * and to a refusal a factory built, as it owned each local helper's, so the Arabic coverage of those reasons is checked
 * as before. docs/ADDING-A-REVIEWED-FAMILY.md, "The family kit".
 */

/** Refuses with a family's code and reason; `status` is 400 unless the refusal says otherwise (502 for a failed read). */
export function fail(code: string, message: string, details: JsonObject = {}, status = 400): never {
  throw new MirrorError(code, message, details, status);
}

/** A family's refusal that names its reason first. */
export type ReasonFirstRefusal = (message: string, code?: string) => never;
/** A family's refusal that flags an unverified state; `code` and `details` are for a refusal with another code. */
export type StateFlaggedRefusal = (message: string, unverified?: boolean, code?: string, details?: JsonObject) => never;
/** A family's refusal with one code. */
export type OneCodeRefusal = (message: string, details?: JsonObject) => never;
/** `fail` with a module's own default status. */
export type StatusRefusal = (code: string, message: string, details?: JsonObject, status?: number) => never;

const statusOf = (statuses: Readonly<Record<string, number>>, code: string, otherwise: number) =>
  Object.hasOwn(statuses, code) ? (statuses[code] as number) : otherwise;

/**
 * The refusals of a family that names its reason first: `refuse(message, code = input)` throws the family's input code
 * unless the call names another, with the status `statuses` gives that code, and `otherwise` (400) for any other code.
 * Bind it once at the top of the module: `const fail = familyErrors('INVALID_X', {X_STATE_UNVERIFIED: 502});`.
 */
export function familyErrors(
  input: string,
  statuses: Readonly<Record<string, number>> = {},
  otherwise = 400,
): ReasonFirstRefusal {
  return (message, code = input) => fail(code, message, {}, statusOf(statuses, code, otherwise));
}

/**
 * The refusals of a family that flags an unverified state: `refuse(message, unverified = false)` throws the family's
 * state code with 502 when the flag is set (a read could not confirm the state) and its input code with 400 otherwise.
 * A call may name another code and details; the status still follows the flag.
 */
export function familyStateErrors(input: string, state: string): StateFlaggedRefusal {
  return (message, unverified = false, code = unverified ? state : input, details = {}) =>
    fail(code, message, details, unverified ? 502 : 400);
}

/** The refusal of a family with one code: `refuse(message, details = {})` throws it with `status` (400 by default). */
export function familyCodeError(code: string, status = 400): OneCodeRefusal {
  return (message, details = {}) => fail(code, message, details, status);
}

/** `fail` with another default status, for a module whose refusals are conflicts (409) or denials (403). */
export function failWithStatus(status: number): StatusRefusal {
  return (code, message, details = {}, override = status) => fail(code, message, details, override);
}

/** The hooks of a family, by the stage that calls them (src/reviewed-family.ts documents each hook). */
export type FamilyCore = Pick<
  ReviewedFamily,
  | 'name'
  | 'files'
  | 'kind'
  | 'effect'
  | 'available'
  | 'actor'
  | 'credentials'
  | 'assert'
  | 'scope'
  | 'authorize'
  | 'observe'
>;
export type FamilyStateHooks = Pick<
  ReviewedFamily,
  | 'snapshots'
  | 'state'
  | 'isRead'
  | 'reader'
  | 'validateState'
  | 'snapshotState'
  | 'snapshotValue'
  | 'followUps'
  | 'prerequisites'
  | 'stateChecks'
  | 'impact'
  | 'stateAsRead'
  | 'ownsConcurrency'
  | 'creativeEditConfirmation'
  | 'warnings'
>;
export type FamilyPolicyHooks = Pick<
  ReviewedFamily,
  | 'spendConfirmation'
  | 'exemptFromSpendTextMatch'
  | 'activates'
  | 'exemptFromActivationScan'
  | 'destructive'
  | 'publishes'
  | 'policyAmounts'
  | 'requiresSpendPolicy'
  | 'personalData'
  | 'administratorRequired'
>;
export type FamilyDeliveryHooks = Pick<
  ReviewedFamily,
  | 'outcome'
  | 'receipt'
  | 'beforeSubmit'
  | 'admit'
  | 'safeOutcome'
  | 'retain'
  | 'deliver'
  | 'safeError'
  | 'rejectionIsNonApplied'
  | 'created'
>;
export type FamilyVerificationHooks = Pick<
  ReviewedFamily,
  | 'verification'
  | 'verify'
  | 'bindVerificationRead'
  | 'readCheck'
  | 'observed'
  | 'afterReadBack'
  | 'pendingOnRetryableError'
  | 'retryReadAfterMs'
  | 'verifyEveryTime'
  | 'verificationCacheVersion'
  | 'verifiedResources'
>;
type GroupedHook =
  | keyof FamilyCore
  | keyof FamilyStateHooks
  | keyof FamilyPolicyHooks
  | keyof FamilyDeliveryHooks
  | keyof FamilyVerificationHooks;
/** Fails to compile while a ReviewedFamily hook belongs to no group above: add a new hook to the group of its stage. */
export const everyFamilyHookHasAStage: [Exclude<keyof ReviewedFamily, GroupedHook>] extends [never] ? true : never =
  true;

/**
 * Checks a family declaration where it is made, so a malformed one fails when its module loads (which
 * tests/import-order.test.mjs exercises for every module) rather than at its first request: a ledger family name, its
 * implementation module and tests, a membership hook, and a function or a value for every hook. Returns the
 * declaration itself, unchanged.
 */
export function defineFamily<F extends ReviewedFamily>(family: F): F {
  const malformed = (what: string): never => {
    throw new MirrorError(
      'REVIEWED_FAMILY_INVALID',
      'A reviewed family declaration is malformed: ' + what + '.',
      {family: typeof family?.name === 'string' ? family.name : null},
      500,
    );
  };
  if (typeof family?.name !== 'string' || !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(family.name))
    malformed('its name is not a ledger family name');
  const [implementation, tests] = family.files ?? [];
  // The ledger lists a family implemented across modules as 'src/a.ts / src/b.ts'.
  if (
    typeof implementation !== 'string' ||
    implementation.split(' / ').some(module => !/^src\/[a-z0-9-]+\.ts$/.test(module))
  )
    malformed('its implementation is not a src module');
  if (
    !Array.isArray(tests) ||
    !tests.length ||
    tests.some(test => typeof test !== 'string' || !/^tests\/[a-z0-9./-]+\.test\.(?:ts|mjs)$/.test(test))
  )
    malformed('it names no test file');
  if (typeof family.kind !== 'function') malformed('it has no kind hook');
  return family;
}

import {MirrorError} from './errors.js';
import type {ReviewedFamily} from './reviewed-family.js';
import type {JsonObject} from './types.js';

/**
 * The reviewed-family kit (ARC-04 stage C): what family modules each declared for themselves. A leaf that imports no
 * lifecycle module, so a family module may use it without joining the registry's import cycle.
 *
 * `fail` is the refusal helper family modules had copied byte for byte. tools/check-locales.mjs owns the reason of every
 * call to it as it owned each local copy's, so the Arabic coverage of those reasons is checked as before.
 * docs/ADDING-A-REVIEWED-FAMILY.md, "The family kit".
 */

/** Refuses with a family's code and reason; `status` is 400 unless the refusal says otherwise (502 for a failed read). */
export function fail(code: string, message: string, details: JsonObject = {}, status = 400): never {
  throw new MirrorError(code, message, details, status);
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

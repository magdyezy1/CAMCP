import {MirrorError} from './errors.js';
import type {ReviewedFamily} from './reviewed-family.js';
import type {CompiledRequest, JsonObject} from './types.js';

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

/** The fields only a write request carries, which a family's state read clears. */
export type WriteOnlyField = 'responseControls' | 'specialTransport';
const writeOnlyFields: readonly WriteOnlyField[] = Object.freeze(['responseControls', 'specialTransport']);

/** What a family's state read asks the provider (`readOf`); everything else is its write request's. */
export interface FamilyRead<R extends CompiledRequest = CompiledRequest> {
  /** The read's action: a marker the family's `isRead` recognizes, or the native read it performs. */
  readonly action: string;
  readonly path: string;
  readonly query: JsonObject;
  /** `GET`, unless the read is a search that posts `body` (a Google Ads `googleAds:search`, a Criteo search). */
  readonly method?: string;
  readonly body?: unknown;
  /** `{}`, unless the provider needs request headers on a read too (LinkedIn's version headers). */
  readonly headers?: Record<string, string>;
  /**
   * Fields the read sets before its own, in this order: a binding it replaces (`accountId`, `origin`), what it never
   * carries (`personalData`), or a family's state fields that its builder had set first.
   */
  readonly before?: Partial<R>;
  /**
   * Fields the read sets after its own and before the write-only fields it clears, in this order: a family's state
   * fields that its builder reset ahead of those (google_configuration's feed searches).
   */
  readonly after?: Partial<R>;
  /**
   * The write-only fields the read clears, in this order: both by default. A family whose reads always kept one of
   * them names only the other (most Google Ads searches keep the special transport), or none.
   */
  readonly clears?: readonly WriteOnlyField[];
}

/**
 * A family's state read of its write request `p` (the review's `readsFor`), as family modules had each built it: `p`,
 * then `read.before`, the read's action, method, path, query, body and headers, read-only, not destructive, no
 * confirmation, `read.after`, the write-only fields it clears (`read.clears`), then `fields` in the order the family
 * set them (its state fields reset, a query encoding). For every compiled request (all of its required fields present)
 * a family's builder and its `readOf` call give the same keys, values and key order (tests/family-reads.test.mjs). A
 * family keeps its own `read` wrapper, so its call sites do not change: `return readOf<Read>(p, {action:
 * 'AMCP_X_READ', method: 'POST', path, query: {}, body: {query}, clears: ['responseControls']}, {xState: undefined});`.
 */
export function readOf<R extends CompiledRequest = CompiledRequest>(
  p: CompiledRequest,
  read: FamilyRead<R>,
  fields: Partial<R> = {},
): R {
  const out: CompiledRequest = {
    ...p,
    ...read.before,
    action: read.action,
    method: read.method ?? 'GET',
    path: read.path,
    query: read.query,
    body: read.body,
    headers: read.headers ?? {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    ...read.after,
  };
  for (const field of read.clears ?? writeOnlyFields) out[field] = undefined;
  return {...out, ...fields} as R;
}

/**
 * The state read most families build (`readOf` with its defaults): a GET of `path` with `query` that clears both
 * write-only fields, then `fields`. `return stateReadOf<Read>(p, 'AMCP_X_MEDIA_READ', '/12/accounts/' + account(p) +
 * path, query, {xMediaState: undefined});`.
 */
export function stateReadOf<R extends CompiledRequest = CompiledRequest>(
  p: CompiledRequest,
  action: string,
  path: string,
  query: JsonObject,
  fields: Partial<R> = {},
): R {
  return readOf<R>(p, {action, path, query}, fields);
}

/**
 * The hooks of a family, by the stage that calls them (src/reviewed-family.ts documents each hook): its core (who it is,
 * what it owns, who may use it), the review's state reads and checks, the owner's policies, the submission and its
 * outcome, and the read-back. Each hook belongs to one stage (tests/family-kit.test.mjs). A list at run time too, so
 * defineFamily refuses a member of no stage that the type check of an object literal never sees, one a spread brings.
 */
export const familyStages = Object.freeze({
  core: Object.freeze([
    'name',
    'files',
    'kind',
    'effect',
    'available',
    'actor',
    'credentials',
    'assert',
    'scope',
    'authorize',
    'observe',
  ] as const),
  state: Object.freeze([
    'snapshots',
    'state',
    'isRead',
    'reader',
    'validateState',
    'snapshotState',
    'snapshotValue',
    'followUps',
    'prerequisites',
    'stateChecks',
    'impact',
    'stateAsRead',
    'ownsConcurrency',
    'creativeEditConfirmation',
    'warnings',
  ] as const),
  policy: Object.freeze([
    'spendConfirmation',
    'exemptFromSpendTextMatch',
    'activates',
    'exemptFromActivationScan',
    'destructive',
    'publishes',
    'operation',
    'policyAmounts',
    'requiresSpendPolicy',
    'personalData',
    'administratorRequired',
  ] as const),
  delivery: Object.freeze([
    'outcome',
    'receipt',
    'beforeSubmit',
    'admit',
    'safeOutcome',
    'retain',
    'deliver',
    'safeError',
    'rejectionIsNonApplied',
    'created',
  ] as const),
  verification: Object.freeze([
    'verification',
    'verify',
    'bindVerificationRead',
    'readCheck',
    'observed',
    'afterReadBack',
    'pendingOnRetryableError',
    'retryReadAfterMs',
    'verifyEveryTime',
    'verificationCacheVersion',
    'verifiedResources',
  ] as const),
}) satisfies Readonly<Record<string, readonly (keyof ReviewedFamily)[]>>;
type FamilyStage = keyof typeof familyStages;
type StageHook<S extends FamilyStage> = (typeof familyStages)[S][number];
/** The hooks of each stage, typed as ReviewedFamily declares them. */
export type FamilyCore = Pick<ReviewedFamily, StageHook<'core'>>;
export type FamilyStateHooks = Pick<ReviewedFamily, StageHook<'state'>>;
export type FamilyPolicyHooks = Pick<ReviewedFamily, StageHook<'policy'>>;
export type FamilyDeliveryHooks = Pick<ReviewedFamily, StageHook<'delivery'>>;
export type FamilyVerificationHooks = Pick<ReviewedFamily, StageHook<'verification'>>;
/** Fails to compile while a ReviewedFamily hook belongs to no stage above: add a new hook to the list of its stage. */
export const everyFamilyHookHasAStage: [Exclude<keyof ReviewedFamily, StageHook<FamilyStage>>] extends [never]
  ? true
  : never = true;
/**
 * A family's declaration, by stage: its core, and the hooks of each stage it takes part in. Typed by the stages, so a
 * declaration that names a member of no stage (a misspelt hook, which no stage would ever call) fails to compile.
 */
export type FamilyDeclaration = FamilyCore &
  FamilyStateHooks &
  FamilyPolicyHooks &
  FamilyDeliveryHooks &
  FamilyVerificationHooks;
const stagedHooks: ReadonlySet<string> = new Set(Object.values(familyStages).flat());

/**
 * Checks a family declaration where it is made, so a malformed one fails when its module loads (which
 * tests/import-order.test.mjs exercises for every module) rather than at its first request: a ledger family name, its
 * implementation module and tests, a membership hook, and no member outside the stages (`familyStages`; its type,
 * `FamilyDeclaration`, checks that before the build too). Returns the declaration itself, unchanged. Every registered
 * family is declared through it (tests/family-kit.test.mjs).
 */
export function defineFamily(family: FamilyDeclaration): ReviewedFamily {
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
  // A member no stage calls would be ignored at run time, so a misspelt hook would silently not apply.
  for (const member of Object.keys(family))
    if (!stagedHooks.has(member)) malformed('its member ' + member + ' is no hook of any stage');
  return family;
}

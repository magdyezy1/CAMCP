import type {Actor, CompiledRequest, Connection, Credentials, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {Store} from './store.js';
import type {PersonalDataSpec} from './personal-data.js';

/** Performs one read. A family reader handles the reads it marked and passes every other read to the next reader. */
export type Reader = (read: CompiledRequest) => Promise<TransportResult>;

/**
 * Builds a read of `path` the way the lifecycle builds its own: for the plan's account and connection, read-only, with
 * only the headers the provider needs.
 */
export type ReadBuilder = (path: string, query?: JsonObject, body?: JsonObject, method?: string) => CompiledRequest;

/** Runs the gateway's own checks of a state read; `identity`, when given, replaces its check of the read's target. */
export type GatewayStateChecks = (identity?: (read: CompiledRequest, result: TransportResult) => void) => void;

/** What the review knows besides the plan and its state. */
export interface ImpactContext {
  /** The caller confirmed an edit that changes every ad using a shared creative. */
  creativeEditConfirmed: boolean;
  /** The connection the review belongs to. */
  connectionId: string;
}

/**
 * A login binding for a guarded reader: the value the credentials reduce to must stay the one the first read saw.
 * `sameLogin` reduces them to their login stamp (src/connection-authority.ts); TikTok report tasks bind the exact
 * access token instead (TIKTOK_REPORT_TOKEN_CHANGED), a documented exception.
 */
export interface LoginBinding {
  value(credentials: Credentials): string | undefined;
  changed(): never;
}

/** The review's readers, for a family that reads the whole state it depends on itself (`state`). */
export interface StateReaders {
  /**
   * A reader that checks each read like every state read (read-only, the review's connection and grants, the scope
   * guard) and refuses one that is not independently read-only with `unsafe`. `bound` is the binding's first value.
   */
  guarded(unsafe: string, binding?: LoginBinding): {read: Reader; bound: () => string};
  /**
   * A binding that refuses with CONNECTION_AUTHORITY_CHANGED and `message` once the selected login is replaced. It
   * follows the login revision (CON-01), so AMCP's own token refresh does not count as a change.
   */
  sameLogin(message: string): LoginBinding;
}

/** What execute gives a family around the submission of its request. */
export interface Submission {
  store: Store;
  tenantId: string;
  reviewId: string;
  connection: Connection;
  auth: Credentials;
  /** The state read again at execute, unchanged since prepare. */
  state: unknown[];
  submittedAt: number;
}

/** Options of a verification reader: an extra actor check, a connection check, a login binding and a response step. */
export interface VerificationReadOptions {
  actor?(): void;
  check?(connection: Connection): void;
  binding?: LoginBinding;
  after?(
    read: CompiledRequest,
    connection: Connection,
    response: TransportResult,
    auth: Credentials,
  ): TransportResult | void;
}

/** What verification gives a family that verifies its writes itself (`verify`). */
export interface Verification {
  /** The stored execution outcome. */
  result: JsonObject;
  /** The state kept at prepare. */
  state: unknown[];
  reviewId: string;
  connection: Connection;
  store: Store;
  actor: Actor;
  /** A reader that checks each read like every verification read, and refuses one that is not read-only with `unsafe`. */
  guarded(unsafe: string, options?: VerificationReadOptions): Reader;
  sameLogin(message: string): LoginBinding;
  /** The review's connection, resolved again for the actor. */
  current(): Connection;
}

/** The result of a family's own verification. */
export interface Verified {
  status: string;
  checks: JsonObject[];
  resources?: JsonObject[];
}

/** A read the verifier performs after execution, and the fields it expects to find. */
export interface VerificationRead {
  read: CompiledRequest;
  expected: JsonObject;
  id: string;
  /** Fields the provider echoed differently from what was sent, keyed by field. */
  acknowledged?: Record<string, {sent: unknown; echoed: unknown}>;
  /** Fields no read can observe. */
  unobservable?: string[];
}

/** Owner-policy amounts of a request, when a family computes them itself (spend-policy.ts). */
export interface PolicyAmounts {
  creating?: boolean;
  /** `lifetime` marks a lifetime or total amount (owner decision D7): capped by max_total_budget_native when set. */
  amounts: {path: string; key: string; amount: number; decimal?: string; lifetime?: boolean}[];
  old?: {path: string; key: string; amount: number; decimal?: string}[];
  /**
   * Fields of the request that carry money the policy cannot measure: a cleared cap (`cleared`) or a field with no
   * native unit mapping (`unmapped`). Each becomes one POLICY_AMOUNT_UNSUPPORTED finding beside the checks of
   * `amounts`, never instead of them (WRT-01 stage A).
   */
  unsupported?: {field: string; reason: 'cleared' | 'unmapped'}[];
}

/**
 * One reviewed write family: everything the review lifecycle needs from it, declared next to its implementation and
 * listed in src/reviewed-families.ts. docs/ADDING-A-REVIEWED-FAMILY.md explains each stage.
 *
 * `kind` decides membership. At prepare the lifecycle calls `assert`, `scope(write=true)`, `authorize` (through
 * ScopeGuard, also for every read), `snapshots`, whose reads `reader` performs, `validateState` checks and
 * `snapshotState` keeps, then `prerequisites` and `impact`. At execute it repeats the reads, applies
 * `spendConfirmation`, the owner policy (`activates`, `destructive`, `policyAmounts`) and `outcome`. Verification
 * calls `scope(write=false)`, `verification`, `observed` and `verifiedResources`.
 *
 * Every hook except `name`, `files` and `kind` is optional. `kind`, `isRead`, `authorize` and `reader` see every
 * request and must answer false for, or pass on, requests that are not this family's; every other hook receives only
 * this family's plans and reads.
 */
export interface ReviewedFamily {
  /** Ledger family name, e.g. `google_business_lodging`. */
  readonly name: string;
  /** Implementation and tests recorded for the family in the action ledger. */
  readonly files: readonly [implementation: string, tests: readonly string[]];
  /** Truthy when this family owns the compiled mutation. Must be false for every other family's requests. */
  kind(plan: CompiledRequest): unknown;
  /** Refuses a request the provider no longer accepts (a withdrawn feature), at inspect, prepare and execute. */
  available?(plan: CompiledRequest): void;
  /**
   * Refuses an actor the family's writes need more authority from (an administrator); runs first at prepare and
   * execute (`verifying` false) and before the scope check at verification.
   */
  actor?(plan: CompiledRequest, actor: Actor, verifying: boolean): void;
  /** Refuses a request whose connection's credentials changed from those stored, at every attempt to send it. */
  credentials?(stored: Credentials, current: Credentials): void;
  /**
   * Validates the request before any network call; throws the family's refusal. `gateway` runs the gateway's generic
   * write checks (query parameters, method tunnelling, paused creation, native operation structure); a family that
   * relies on them calls it, before or after its own checks.
   */
  assert?(plan: CompiledRequest, gateway: () => void): void;
  /** Checks the connection's OAuth scopes: for writing at prepare and execute (`write` true), for reading at verification. */
  scope?(connection: Connection, write?: boolean, plan?: CompiledRequest): void;
  /** True when this family authorizes the request (its mutation or one of its reads); false to leave it to others. */
  authorize?(plan: CompiledRequest, connection: Connection, account: string, store: Store): boolean;
  /** Records what a native read of the account shows this family's later writes may rely on (listed resources it owns). */
  observe?(read: CompiledRequest, connection: Connection, account: string, data: unknown, store: Store): void;
  /** Reads taken at prepare and repeated at execute; `stateRead` builds a state read of the plan's account. */
  snapshots?(plan: CompiledRequest, stateRead: ReadBuilder): CompiledRequest[];
  /** Reads the whole state the write depends on through `readers`, instead of the reads of `snapshots`. */
  state?(plan: CompiledRequest, readers: StateReaders): Promise<unknown[]>;
  /** True for the reads this family marked in `snapshots` or `verification`. */
  isRead?(read: CompiledRequest): boolean;
  /** Performs and projects this family's marked reads; passes every other read to `next`. */
  reader?(read: CompiledRequest, next: Reader): Promise<TransportResult>;
  /** Refuses a marked read whose result is incomplete or names another target; `gateway` runs the gateway's checks. */
  validateState?(read: CompiledRequest, result: TransportResult, gateway: GatewayStateChecks): void;
  /**
   * The state kept from a marked read, before normalization; without it, the reader's projection is kept as is.
   * `gateway` returns the state the gateway keeps from the read.
   */
  snapshotState?(read: CompiledRequest, data: JsonObject, gateway: () => unknown): unknown;
  /** The state kept from one of the plan's own snapshot reads, or undefined to keep the read's normalized state. */
  snapshotValue?(plan: CompiledRequest, read: CompiledRequest, data: JsonObject): unknown;
  /** More reads the review makes once a read names what the write also depends on. */
  followUps?(plan: CompiledRequest, read: CompiledRequest, data: unknown): CompiledRequest[];
  /** Refuses a request the read state does not allow. `state` holds the normalized snapshots of `reads` in order. */
  prerequisites?(plan: CompiledRequest, state: unknown[], reads: CompiledRequest[]): void;
  /** Refuses on the whole reviewed state: at prepare (`preparing`), and at execute once the state is unchanged. */
  stateChecks?(plan: CompiledRequest, state: unknown[], preparing: boolean): void;
  /** The impact summary prepare returns for review; without one (undefined), the gateway's summary applies. */
  impact?(plan: CompiledRequest, state: unknown[], review: ImpactContext): JsonObject | undefined;
  /** True when the provider response confirms every mutation of the request. */
  outcome?(plan: CompiledRequest, result: TransportResult, before: unknown[]): boolean;
  /** Fields added to the execution outcome, such as the provider's own receipt of the change. */
  receipt?(plan: CompiledRequest, result: TransportResult): JsonObject;
  /** Refuses the submission when the login changed after the state was read (`state` read again at execute). */
  beforeSubmit?(plan: CompiledRequest, state: unknown[], auth: Credentials): void;
  /** Claims what the submission uses up (a provider quota), in the transaction that claims the review. */
  admit?(plan: CompiledRequest, submission: Submission): void;
  /** The execution outcome as it may be returned and stored, without provider data the family must not disclose. */
  safeOutcome?(outcome: JsonObject, plan: CompiledRequest, result: TransportResult): JsonObject;
  /** Keeps what the provider's response gives the family (a job receipt, a created resource), with the outcome. */
  retain?(plan: CompiledRequest, response: TransportResult, result: JsonObject, submission: Submission): void;
  /** The outcome as the caller receives it, with what the family retained (a preview's receipt). */
  deliver?(
    plan: CompiledRequest,
    outcome: JsonObject,
    review: {store: Store; tenantId: string; reviewId: string},
  ): JsonObject;
  /** The error execute reports, without provider data the family must not disclose. */
  safeError?(error: unknown): unknown;
  /**
   * True when the provider's definitive refusal (an HTTP 4xx with a parsed error body, never a timeout, rate limit,
   * 5xx or lost response) proves nothing of the request was applied (CMP-04). The claim then becomes `rejected`: its key
   * is never sent again, its spend reservation is released (owner decision D12), and a plan step may be amended and
   * reviewed under a new key. Declare it only with a primary-document or authorized live proof; without it the outcome
   * stays uncertain.
   */
  rejectionIsNonApplied?(plan: CompiledRequest, status: number, body: JsonObject): boolean;
  /**
   * Reads that show the result after execution; `before` holds the snapshots taken at execute, and `verificationRead`
   * builds a read of the plan's account.
   */
  verification?(
    plan: CompiledRequest,
    result: JsonObject,
    before: unknown[],
    verificationRead: ReadBuilder,
  ): VerificationRead[];
  /**
   * Verifies the write with the family's own reads instead of `verification`'s read-back; undefined leaves the plan to
   * the read-back.
   */
  verify?(plan: CompiledRequest, verification: Verification): Promise<Verified> | undefined;
  /** Binds one of the plan's verification reads to its review (reads the provider authorizes by the review). */
  bindVerificationRead?(plan: CompiledRequest, read: CompiledRequest, reviewId: string): void;
  /** Checks the connection before and after each verification read. */
  readCheck?(connection: Connection): void;
  /** Projects a marked verification read to the shape of its `expected`; `gateway` returns the gateway's projection. */
  observed?(read: CompiledRequest, data: JsonObject, gateway: () => JsonObject): JsonObject;
  /** Records what one read-back shows (a created resource the account may read later), once it is compared. */
  afterReadBack?(
    plan: CompiledRequest,
    check: {id: string; expected: JsonObject; actual: unknown; consistent: boolean},
    verification: {store: Store; result: JsonObject; current(): Connection},
  ): void;
  /** True when a retryable provider error leaves the verification pending rather than unverified. */
  pendingOnRetryableError?(plan: CompiledRequest): boolean;
  /** How long a caller should wait before verifying again, when the provider finishes slowly. */
  readonly retryReadAfterMs?: number;
  /** True when a recent verified result is never reused: each verification reads again. */
  readonly verifyEveryTime?: boolean;
  /** A changed projection must retire older verified caches without discarding accepted mutation receipts. */
  readonly verificationCacheVersion?: string;
  /** True when the family's writes need an administrator (shown by inspect). */
  readonly administratorRequired?: boolean;
  /** True when the request may carry creative_edit_confirmed (an edit that changes every ad using a creative). */
  creativeEditConfirmation?(plan: CompiledRequest): boolean;
  /** True when the family manages the provider's concurrency token itself (GTM's fingerprint is not taken). */
  readonly ownsConcurrency?: boolean;
  /** True when the state kept at prepare is the family's own projection, compared at execute as kept. */
  readonly stateAsRead?: boolean;
  /** Resources the provider's response shows this write created in the account; they become readable for the account. */
  created?(plan: CompiledRequest, response: JsonObject): string[];
  /** IDs of resources a consistent verification read proves this write created; they become readable for the account. */
  verifiedResources?(plan: CompiledRequest, actual: JsonObject): string[];
  /** When `needed`, execution requires spend_change_confirmed=true and refuses with `message` without it. */
  readonly spendConfirmation?: {
    needed(plan: CompiledRequest): boolean;
    readonly message: string | ((plan: CompiledRequest) => string);
  };
  /**
   * True when preflight.ts must not apply its budget/bid/spend text match to this family, because the family decides
   * its spending effect itself (`spendConfirmation`) or has none.
   */
  readonly exemptFromSpendTextMatch?: boolean | ((plan: CompiledRequest) => boolean);
  /** True when the request activates or widens delivery, which an owner policy with allow_activation=false forbids. */
  activates?(plan: CompiledRequest, before: unknown): boolean;
  /**
   * True when the generic scan of the gateway's status field must not decide activation, because `activates` decides it
   * or the field means something else for this family (a definition's availability, not delivery).
   */
  readonly exemptFromActivationScan?: boolean | ((plan: CompiledRequest) => boolean);
  /**
   * True when the request deletes or removes something, which an owner policy with allow_deletion=false forbids.
   * `before`, the reviewed state, is given at prepare and execute, for a deletion that depends on what is already
   * there (a feed whose deletion rule is on); without it the hook answers from the plan alone.
   */
  destructive?(plan: CompiledRequest, before?: unknown): boolean;
  /**
   * True when executing the request makes a change live for everyone at once (a published version, a submitted
   * sitemap, a public link), which the review discloses (write-effects.ts); undefined leaves it to the route rules.
   */
  publishes?(plan: CompiledRequest): boolean;
  /** Warnings shown with the request at review. */
  warnings?(plan: CompiledRequest): string[];
  /** Owner-policy amounts, when the generic budget scan cannot find them. */
  policyAmounts?(plan: CompiledRequest, before: unknown, policy: JsonObject): PolicyAmounts | undefined;
  /** True when the family refuses an account no spending policy protects (the owner's condition for the request). */
  readonly requiresSpendPolicy?: boolean | ((plan: CompiledRequest) => boolean);
  /**
   * Set when the family sends data about people (src/personal-data.ts): the review hashes them in memory and keeps
   * only counts and a digest; execution takes them again and builds the body with `body`.
   */
  readonly personalData?: PersonalDataSpec;
}

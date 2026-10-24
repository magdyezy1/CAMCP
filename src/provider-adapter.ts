/**
 * The gateway-level provider contract (ARC-01). The reviewed-family registry made each write family declare what the
 * review lifecycle needs from it; this contract does the same one level up, for a provider's gateway. A provider
 * supplies facts about itself, and the lifecycle, ScopeGuard and NativeTransport keep control: account binding, the
 * origin allowlist, single send, retries and the spend, confirmation and idempotency rules never move into an adapter.
 *
 * Concerns move into adapters one at a time (ARC-01 phase B), each with a call-replay proof that the provider requests
 * and authorization decisions are unchanged (tools/call-replay.mjs; docs/review/ARCHITECTURE.md, "Provider adapters").
 * Every adapter carries its lifecycle status and its facts (the account model, body deletions), which any module may
 * read; behaviour that needs a provider's own modules (read classification, paging, the account read, the wire
 * profile, its part of ScopeGuard, its write-shape and state checks, the review's projections of its reads) is its
 * hooks, declared in src/<provider>-adapter.ts and registered in src/provider-hooks.ts.
 */
import type {CompiledRequest, Connection, Credentials, JsonObject} from './types.js';
import type {ProviderErrorClass, ProviderErrorContext, ProviderErrorInput} from './provider-error-taxonomy.js';
import type {Store} from './store.js';
import type {Registry} from './catalog.js';
import type {TransportResult} from './transport.js';
import type {VerificationRead} from './reviewed-family.js';

/** `active` providers are offered; a `parked` one is offered only where AMCP_PROVIDERS names it. */
export type ProviderStatus = 'active' | 'parked';

/**
 * Why a provider is parked: `owner_parked`, the owner stopped its work (Criteo, WooCommerce: PRK-01, PRK-02);
 * `unimplemented`, the gateway has no onboarding or implementation modules beyond request routing (Amazon Ads:
 * CON-06 option b).
 */
export type ParkedReason = 'owner_parked' | 'unimplemented';

export interface ProviderParking {
  readonly reason: ParkedReason;
  /** Where the decision is recorded (docs/DECISIONS.md). */
  readonly decision: string;
}

/**
 * What a bound resource is (CON-05). Report destinations and media sources (Sheets, Drive) are not advertising
 * accounts: list_accounts leaves them out unless they are asked for, and no account read is suggested for them.
 */
export type AccountKind =
  'ad_account' | 'analytics_property' | 'tag_account' | 'search_property' | 'business_profile' | 'destination';

/**
 * The provider's account model (ARC-01 phase B, its first concern). It only says where a request names an account:
 * ScopeGuard (src/scope.ts) walks every request and compares each place named here with the bound account before any
 * authorizer runs, and refuses a mismatch with ACCOUNT_SCOPE_MISMATCH. The facts cannot change after load.
 */
export interface AccountModel {
  /**
   * The account ID in the form AMCP binds and compares (`src/account-id.ts`): Meta drops `act_`, Google Ads drops
   * dashes. Without one, an ID is kept as given.
   */
  normalize?(id: string): string;
  /**
   * Request fields that name the account, at any depth of the query and the body: their value, each item of an array
   * and of a JSON array text must be the bound account.
   */
  readonly fields?: ReadonlySet<string>;
  /**
   * Account references inside any string of the request, path included (Google's `customers/<id>`, LinkedIn's sponsored
   * account URNs): a global pattern whose first group is an account ID. It is frozen, so its `lastIndex` is read-only:
   * use it only through `String.prototype.matchAll`, which clones the pattern (as ScopeGuard does), or copy it with
   * `new RegExp(pattern)`. Its own `test` and `exec`, and `match`, `replace` or `search` with it, throw a TypeError.
   */
  readonly references?: RegExp;
  /** JSON Patch operations of a PATCH name account fields in their path (Snapchat): such an operation must set the bound account. */
  readonly patchFields?: true;
  /** The account a decoded request path names, as its first group: a path that names the bound account is in scope. */
  readonly path?: RegExp;
  /** What a bound resource is; an advertising account when absent. */
  readonly kind?: AccountKind;
}

/**
 * Deletions a provider takes as a body value on a route that is not a DELETE (WRT-02): src/execution-risk.ts treats a
 * write that carries one as destructive, so the owner's deletion switch holds it.
 */
export interface BodyDeletions {
  /** Each snake_case field and the values that delete or remove what the request names. */
  readonly fields: Readonly<Record<string, readonly string[]>>;
  /** Where the values come from. */
  readonly source: string;
  /** A `remove` operation by resource name with this prefix deletes (Google Ads `{remove: 'customers/…'}`). */
  readonly removePrefix?: string;
  /** A :mutate POST whose operations carry a string `remove` deletes (Google Ads RPC removals). */
  readonly mutateRemovals?: true;
}

/**
 * A provider's generic entity writes (ARC-01 phase B: they were branches of src/reviewed-routes.ts): the creations,
 * edits and deletions of its campaigns, ad groups, ads and creatives that no registered family claims, which the
 * gateway's generic reads, checks and projections serve. reviewedWriteFamily keeps the read-only and special-transport
 * exclusions and the registered families first, and asks the adapter only whether a write is one of these.
 */
export interface EntityWrites {
  /** The ledger name of their reviewed route (`google_entities`). */
  readonly family: string;
  /** Whether a write is one of them, from its method, path and action alone; it never refuses. */
  claims(plan: CompiledRequest): boolean;
}

/**
 * How the one-line review summary names what a provider's write does (WRT-05 stage E; ARC-01 phase B: a branch of
 * src/review-summary.ts): its operation, the kind of entity and how many, read from the request alone. A provider
 * without it is summarized from the request's path, method and action.
 */
export interface ReviewOperations {
  summarize(plan: CompiledRequest): {operation: string; entity: string; count: number};
}

/**
 * A provider's read classification (ARC-01 phase B): its documented exceptions to the generic read rules of
 * src/execution-risk.ts, which keeps every rule and decides. A request classified as a read still passes ScopeGuard and
 * every review rule.
 */
export interface ReadClassification {
  /** A route the catalog marks as a write that is a reviewed read (planning, estimate and preview POSTs). */
  plannedRead?(plan: CompiledRequest): boolean;
  /** Decides alone, in place of the generic rules: the provider's contracts declare their reads (Microsoft). */
  readOnly?(plan: CompiledRequest): boolean;
  /**
   * The path the generic rules read when the provider's paths hold identifiers that look like words (Search Console's
   * site URLs); undefined to read the decoded path.
   */
  classifiedPath?(plan: CompiledRequest): string | undefined;
  /** A documented GET read whose path holds a word the generic rules refuse (src/provider-read-contracts.ts). */
  qualifiedRead?(plan: CompiledRequest): boolean;
  /** Another documented route whose path words are not edits (TikTok's ad previews). */
  wordExempt?(plan: CompiledRequest): boolean;
  /** A query or body key, in lower case, that makes the request carry other requests (Meta's Graph batch). */
  batch?(key: string): boolean;
  /** Whether a POST is a read, by its decoded path: the provider's documented query, report and planning RPCs. */
  postRead?(plan: CompiledRequest, pathname: string): boolean;
}

/**
 * How a provider's requests and tool arguments name paging (ARC-01 phase B facts; src/pagination.ts reads them).
 */
export interface PagingFacts {
  /** The parameter a generic next-page token takes in this provider's requests (Google Ads `page_token`); `pageToken` otherwise. */
  readonly tokenParameter?: string;
  /** The tool argument that carries a native request's body (GA4 `request`); `payload` or `body` otherwise. */
  readonly bodyArgument?: string;
}

/** A collection a provider reports whole (TikTok integrated reports): its pages are one verified result. */
export interface WholeCollection {
  /** Whether a request reads such a collection. */
  claims(plan: CompiledRequest): boolean;
  /** Starts one collection at its first page (refused otherwise) and returns the check every page read must pass. */
  start(plan: CompiledRequest): (request: CompiledRequest, response: unknown) => void;
  /** The number of pages a page of the collection reports. */
  pages(data: unknown): number;
  /** What a continuation that reads the whole collection again does, for its caller. */
  readonly meaning: string;
}

/**
 * How a provider's collections page (ARC-01 phase B): src/pagination.ts keeps the loop, the merge, the page and size
 * limits, the loop and shape checks and the continuation call, and asks the provider only for its next page.
 */
export interface Paging {
  /**
   * The request of the page after `response`: `next`, a copy of the request, with the provider's cursor set, or null
   * after the last page; undefined leaves the response to the generic page tokens. A cursor that would change the
   * request's scope or filters is refused (UNSAFE_PAGINATION_LINK), and a page that advertises more without a usable
   * cursor too (UNKNOWN_PAGINATION).
   */
  nextPage?(plan: CompiledRequest, response: unknown, next: CompiledRequest): CompiledRequest | null | undefined;
  readonly whole?: WholeCollection;
}

/**
 * A provider's exact account read (ARC-01 phase B): readiness, plan preflight and reports read one account through it
 * (src/account-metadata.ts `accountPlan`, src/workspace.ts `readinessPlan`) and find the account in its response. The
 * shared stages keep what every account read is (AMCP_READINESS, read-only, never confirmed), ScopeGuard's
 * authorization of it and every check of its result.
 */
export interface AccountRead {
  /**
   * The provider's route on `read`, the shared read of account `id` (its path, query, body and headers set and `read`
   * returned), or the provider's own compiled read of it (Microsoft's GetAccount). Absent: the provider has no exact
   * account read (READINESS_CONTRACT_UNAVAILABLE).
   */
  plan?(read: CompiledRequest, id: string): CompiledRequest;
  /**
   * The readiness read of a resource `plan` does not read (CON-03): a GA4 property, a Tag Manager account, a Search
   * Console site, an Apple Ads ad account, a Business Profile location or account. `read` builds the shared read of a
   * path on an origin; undefined when `id` names no resource the provider reads (readiness refuses it). Declared with
   * `names`.
   */
  readiness?(id: string, read: (path: string, origin: string) => CompiledRequest): CompiledRequest | undefined;
  /** Whether the response of a `readiness` read names exactly the selected resource `id`. */
  names?(id: string, data: JsonObject): boolean;
  /** The account inside an account read's response (Snapchat: adaccounts[0].adaccount); its `data`, or itself, when absent. */
  account?(data: JsonObject): unknown;
}

/** What a wire profile sets its provider's headers from: the request, its URL, the connection and its credentials. */
export interface WireHeaders {
  readonly plan: CompiledRequest;
  readonly url: URL;
  readonly connection: Connection;
  readonly credentials: Credentials;
  /** The headers that will be sent: the profile sets its own. */
  readonly headers: Record<string, string>;
}

/**
 * A provider's documented error shapes (PRV-01): src/provider-error-taxonomy.ts keeps the generic shapes and the
 * classification of every refusal they do not name.
 */
export interface ErrorEnvelope {
  /** The provider's own request reference, before the generic headers (LinkedIn's x-li-uuid and x-li-request-id). */
  requestId?(header: (name: string) => string | undefined): string | undefined;
  /** The request reference in a body when no header names one (Meta's error.fbtrace_id). */
  bodyRequestId?(body: unknown): string | undefined;
  /** The provider's own code, from its documented error shape, in place of the generic shapes. */
  code?(body: unknown): string | number | undefined;
  /** A refusal its documented tables classify (Meta's codes, Google Ads' quota errors...); undefined for the generic. */
  classify?(input: ProviderErrorInput, context: ProviderErrorContext): ProviderErrorClass | undefined;
}

/**
 * A provider's wire profile (ARC-01 phase B): how its requests are shaped on the wire and how its responses say they
 * failed. NativeTransport (src/transport.ts) keeps the origin allowlist, the single send, the attempts and retries,
 * the deadlines, rate limits, cooldowns and circuits, the size limits and every refusal; a profile only answers the
 * transport's questions about its provider's requests, at the points where the transport named the provider before.
 */
export interface WireProfile {
  /** Checks a request before its pinned wire contract (Google Ads' Discovery request validation); refuses or returns. */
  validate?(plan: CompiledRequest): void;
  /** Checks a request after its wire contract (Google's generation drafts, DV360's targeting search). */
  validateRoute?(plan: CompiledRequest): void;
  /** The path sent (TikTok's /open_api prefix). */
  path?(path: string): string;
  /** The query string, in place of the generic encoding (LinkedIn's Rest.li 2.0 encoding). */
  search?(query: JsonObject): string;
  /** Sets a header the connection supplies before anything else (Reddit's User-Agent), or refuses. */
  connectionHeaders?(headers: Record<string, string>, connection: Connection): void;
  /** Whether a multipart/related upload is one of the provider's contracts (DV360's asset uploads). */
  relatedUpload?(plan: CompiledRequest): boolean;
  /** Whether a field-only multipart form is one of the provider's contracts (Snapchat's chunked upload). */
  fieldUpload?(plan: CompiledRequest): boolean;
  /** Whether a body is sent form-encoded (Meta; X outside batches and its JSON-body routes). */
  formBody?(plan: CompiledRequest): boolean;
  /** The JSON a body is sent as (Google Ads: its ProtoJSON names, and the Data Manager login account). */
  json?(plan: CompiledRequest, url: URL, connection: Connection, credentials: Credentials): unknown;
  /** The content type of a JSON body that is not application/json (Snapchat's JSON Patch). */
  jsonType?(plan: CompiledRequest): string | undefined;
  /** The header that carries the access token in place of a bearer Authorization (TikTok's Access-Token). */
  readonly tokenHeader?: string;
  /**
   * Sets the provider's own authentication and scope headers (Google Ads' login customer, Microsoft's developer token
   * and customer, Amazon's client and scope, Apple's context), or refuses.
   */
  headers?(context: WireHeaders): void;
  /** The Authorization that replaces the bearer token (X's OAuth 1.0a signature). */
  authorization?(plan: CompiledRequest, url: URL, credentials: Credentials, form?: URLSearchParams): string;
  /** The key of the provider's own user rate limit (X: per access token, origin and endpoint); its account limits are keyed under it. */
  userRateKey?(tenantKey: string, url: URL, credentials: Credentials): string;
  /** Whether a throttled response names its account (X's account reset header), whose cooldown is then the account's. */
  accountThrottle?(response: Response): boolean;
  /** The wait until the throttle reset a 429 reports in the provider's own headers (X). */
  resetWait?(response: Response, now: number): number | undefined;
  /** A read the provider is sent once (Google's generation drafts, Microsoft's report submission). */
  singleAttempt?(plan: CompiledRequest): boolean;
  /** A bounded report read whose bytes are checked whole and whose numbers keep their source text (Adjust). */
  boundedReport?(plan: CompiledRequest, url: URL): boolean;
  /** The monotonic deadline of one of the provider's bounded reads, from the plan field that read carries. */
  deadline?(plan: CompiledRequest, url: URL): number | undefined;
  /**
   * A write documented to answer without a body (Search Console site and sitemap edits, Tag Manager deletes, LinkedIn
   * creations named by x-restli-id and its finalized uploads and tracking parameters, Google's resumable upload session).
   */
  emptyWrite?(plan: CompiledRequest, response: Response): boolean;
  /** A CSV download (TikTok's report task download). */
  csv?(plan: CompiledRequest): boolean;
  /** Report output whose bytes are checked whole (Criteo). */
  reportOutput?(plan: CompiledRequest): boolean;
  /** A read whose 64-bit IDs are kept as their source text (LinkedIn's lead forms). */
  int64?(plan: CompiledRequest): boolean;
  /** Report data whose fractional numbers keep their source text when AMCP_REPORT_LOSSLESS_NUMBERS is on (RPT-01). */
  reportData?(plan: CompiledRequest): boolean;
  /** The provider's own request reference beside its request ID (LinkedIn's x-li-fabric). */
  fabric?(response: Response): string | undefined;
  /** What a version refusal names besides its layer (the LinkedIn version sent and the reviewed default, PRV-02). */
  versionSent?(headers: Record<string, string>): JsonObject;
  /** The login a refused request was sent under (Google Ads' login customer). */
  sentLogin?(headers: Record<string, string>): JsonObject;
  /** An unsuccessful result inside a 2xx response (TikTok's non-zero code, X's errors list). */
  failedResult?(data: JsonObject): boolean;
  /** Checks a successful response, or refuses it (Google's generation drafts, DV360's targeting search). */
  checkResult?(plan: CompiledRequest, data: unknown): void;
  /** Response headers kept beside the generic request IDs (LinkedIn's request references). */
  readonly referenceHeaders?: readonly string[];
  /** Upload session headers kept last (Google's resumable upload URL and chunk granularity). */
  sessionHeaders?(plan: CompiledRequest): readonly string[];
  readonly errors?: ErrorEnvelope;
}

/**
 * One of a provider's read authorizers (ARC-01 phase B). ScopeGuard (src/scope.ts) consults the authorizers of a
 * request's provider only after it has compared every account the request names with the bound one. An authorizer
 * claims the requests it decides, and no two claim one request: ScopeGuard refuses a request two claim with
 * READ_AUTHORIZER_CONFLICT before anything is sent, like two reviewed families claiming one write, and
 * tests/provider-read-authorizers.test.mjs holds the claims disjoint over every catalogued route.
 */
export interface ReadAuthorizer {
  /** The authorizer's name in a conflict refusal. */
  readonly name: string;
  /** Where ScopeGuard consults it: before the reviewed families' own authorizers, or after them (as the chain did). */
  readonly stage: 'before_families' | 'after_families';
  /** Whether this authorizer decides `plan`, from the request alone; it never refuses. */
  claims(plan: CompiledRequest): boolean;
  /** True when the claimed request is in scope; false to leave it to ScopeGuard's later checks; or a refusal. */
  authorize(plan: CompiledRequest, connection: Connection, account: string, store: Store): boolean;
}

/** What ScopeGuard gives a provider's resource scope: the decoded path, its account comparison, the store, the catalog. */
export interface ScopeContext {
  readonly decoded: string;
  /** Refuses with ACCOUNT_SCOPE_MISMATCH unless every value is the bound account. */
  compare(value: unknown, field: string): void;
  /** ScopeGuard's ACCOUNT_SCOPE_MISMATCH refusal, naming `field`. */
  mismatch(field: string): never;
  readonly store: Store;
  readonly registry: Registry;
}

/** A ready-to-send read, as ScopeGuard's ownership_reads offer it. */
export type ScopeCall = {tool: string; arguments: JsonObject};
/** Builds a call of the provider's gateway tool for the account and connection a refusal names. */
export type ScopeCallBuilder = (action: string, extra?: JsonObject) => ScopeCall;

/**
 * A provider's part of ScopeGuard (ARC-01 phase B). ScopeGuard keeps the offering gate, the account binding, the walk
 * that compares every account a request names, the order of every stage, the resource bindings and the final refusal;
 * a provider supplies what only it can say, at the stage where ScopeGuard named the provider before.
 */
export interface ScopeHooks {
  /** A public read that needs no account binding (Meta's Ad Library): ScopeGuard returns its public scope first. */
  publicRead?(plan: CompiledRequest): boolean;
  /** The provider's scope checks before any authorizer (Google's generation scope, Meta's label scope); refusals. */
  assert?(plan: CompiledRequest, connection: Connection): void;
  readonly authorizers?: readonly ReadAuthorizer[];
  /**
   * After the account path: whether the request is in the bound account's scope by the provider's own rules (a
   * Search Console site, a Business Profile account or location, a LinkedIn account filter, TikTok's advertiser
   * parameters, Microsoft's contracts, a mandatory account header, ownership from an account-scoped list); false to
   * leave it to the resource bindings; or a refusal.
   */
  resource?(plan: CompiledRequest, connection: Connection, account: string, context: ScopeContext): boolean;
  /**
   * The account collection reads whose results establish ownership of the resource a refused request names;
   * `call` builds one of the provider's own tool calls for the account and connection.
   */
  ownershipReads?(
    path: string,
    account: string,
    connectionId: string,
    template: string | undefined,
    call: ScopeCallBuilder,
  ): ScopeCall[];
  /** Learns resource ownership from a successful account-scoped read, which ScopeGuard.observe has authorized. */
  observe?(plan: CompiledRequest, connection: Connection, account: string, data: unknown, store: Store): void;
  /** Learns ownership of what a verified, successful creation made; never from caller-supplied data. */
  observeCreated?(plan: CompiledRequest, connection: Connection, account: string, data: JsonObject, store: Store): void;
}

/** Refuses a new serving entity whose `key` is not one of `values`: the write-shape stage's paused-creation rule. */
export type ExpectState = (record: JsonObject, key: string, values: string[]) => void;

/**
 * A provider's checks in the write-shape stage (src/write-shape.ts assertGatewayShape), which keeps the generic ones
 * (query parameters, method tunnelling, side-effecting GETs) and asks the provider before them, after the query
 * parameters and after the method checks.
 */
export interface WriteShapeChecks {
  /** Checks before the generic ones (Snapchat's creative paths, Meta's creative, budget schedule and inline creative). */
  before?(plan: CompiledRequest, body: JsonObject): void;
  /** The one concurrency query parameter a reviewed write may carry (DV360's updateMask, Tag Manager's fingerprint). */
  readonly queryParameter?: string;
  /** Checks after the query parameters (LinkedIn's PARTIAL_UPDATE patches). */
  afterQuery?(plan: CompiledRequest, body: JsonObject): void;
  /** Paused creation and the native record structure, after the method checks; `expect` is the paused-creation rule. */
  after?(plan: CompiledRequest, body: JsonObject, expect: ExpectState): void;
}

/** What a provider's exact-target check of a state read is given: the bound account and the shared ID comparison. */
export interface StateTarget {
  readonly id: string;
  /** Refuses with STATE_TARGET_MISMATCH unless `actual` holds exactly the `expected` IDs, in any order. */
  sameIds(actual: unknown[], expected: unknown[]): void;
  /** The ID the read's path ends with (its last segment, decoded, without act_ or a URN's prefix). */
  target(): string;
}

/**
 * A provider's checks in the state stage (src/write-state.ts validateGatewayState), which keeps the success check,
 * the pagination checks and the order, and asks the provider where it named the provider.
 */
export interface StateChecks {
  /** The provider's own response contract, first; it replaces the generic success check (Microsoft's contracts). */
  contract?(read: CompiledRequest, result: TransportResult): void;
  /** True when a documented result ends the checks (a measurement resource's 404, Tag Manager's status read). */
  settled?(read: CompiledRequest, result: TransportResult): boolean;
  /**
   * The result the success check reads: documented values set aside that are not failures (Search Console's sitemap
   * error counts, Google's omitted empty results, a failed GA4 job's message); `result` itself otherwise. May refuse.
   */
  envelope?(read: CompiledRequest, result: TransportResult, data: JsonObject): TransportResult;
  /** A read complete by its own contract, without the pagination checks (TikTok's published Instant Forms). */
  complete?(read: CompiledRequest, data: JsonObject): boolean;
  /** The provider checks its reads' targets whatever identity a family supplies (Microsoft, the measurement providers). */
  readonly ownTarget?: true;
  /** The exact-target check of a read no family checks: it returns, or refuses. */
  target?(read: CompiledRequest, result: TransportResult, data: JsonObject, context: StateTarget): void;
}

/**
 * A provider's gateway checks (ARC-01 phase B): its parts of the write-shape and state stages. The stages keep every
 * generic rule, the order and every refusal they name; Reddit's write contract and state check stay in them (their
 * module reads pages through src/pagination.ts, which consults these hooks, so Reddit's adapter cannot import it).
 */
export interface GatewayChecks {
  /** The provider's request contracts, first (Google's Discovery schema, Meta's campaign and v26 rules). */
  request?(plan: CompiledRequest): void;
  /** A write contract that decides alone, instead of the families and routes (Microsoft's contracts). */
  contract?(plan: CompiledRequest): void;
  /** The provider's generic write contract before the reviewed routes (the measurement providers' resource writes). */
  routeWrite?(plan: CompiledRequest): void;
  readonly shape?: WriteShapeChecks;
  readonly state?: StateChecks;
}

/** A verification read a provider builds: the family contract's, and how the stage compares two of its fields. */
export interface ProviderVerificationRead extends VerificationRead {
  /** Sent fields the read may omit: when it does, they are compared with the write response instead. */
  readOptional?: string[];
  /** What the read shows beyond the expected fields, reported in the check and never compared. */
  observe?: (actual: unknown) => JsonObject | undefined;
}

/**
 * A provider's parts of the review's projections (ARC-01 phase B): the state a review keeps of a read no family
 * projects (src/review-state.ts), and the reads that show a write no family verifies took effect, with what each
 * shows of its resource (src/verification-reads.ts). The stages keep the families first, the normalization, the empty
 * verification of a DELETE and every comparison; a provider without a projection keeps a read whole.
 */
export interface ReviewProjections {
  /** The state a review keeps of a read, before normalization: its configuration, not its envelope; `data` by default. */
  snapshot?(read: CompiledRequest, data: JsonObject): unknown;
  /** The write's headers a verification read keeps (LinkedIn's versioning headers); none by default. */
  verificationHeaders?(plan: CompiledRequest): Record<string, string>;
  /**
   * The reads that show a write took effect, none by default. `read` builds one the way the stage builds every
   * verification read; `snapshots` returns a request's state reads (src/write-snapshots.ts), passed in so that no
   * adapter imports a lifecycle module.
   */
  verification?(
    plan: CompiledRequest,
    result: JsonObject,
    read: (path: string, query?: JsonObject) => CompiledRequest,
    snapshots: (plan: CompiledRequest) => CompiledRequest[],
  ): ProviderVerificationRead[];
  /** What a verification read shows of its resource: the provider's record, unwrapped; `data` by default. */
  observed?(read: CompiledRequest, data: JsonObject): JsonObject;
  /** The verification cache version that retires older proofs of a write (Google's value-bidding campaigns). */
  verificationVersion?(plan: CompiledRequest): string | undefined;
}

/** The preconditions of a plain documented GET read: read-only, no body, no special transport. */
export const plainGetRead = (p: CompiledRequest) =>
  p.readOnly && p.method === 'GET' && !p.specialTransport && p.body === undefined;

/**
 * A provider's hooks (ARC-01 phase B): the parts of its adapter that call its own modules, declared in
 * src/<provider>-adapter.ts and registered in src/provider-hooks.ts. The facts any module may read are the
 * ProviderAdapter of the leaf registry; a hook only supplies a provider fact to the shared stage that asks for it.
 */
export interface ProviderHooks {
  /** The gateway of the provider adapter these hooks belong to. */
  readonly gateway: string;
  readonly reads?: ReadClassification;
  readonly paging?: Paging;
  readonly accountRead?: AccountRead;
  readonly wire?: WireProfile;
  readonly scope?: ScopeHooks;
  readonly checks?: GatewayChecks;
  readonly review?: ReviewProjections;
}

export interface ProviderAdapter {
  /** The provider's ID, as AMCP_PROVIDERS and the provider contracts name it (`criteo`, `google_business`). */
  readonly id: string;
  /** The gateway tool that carries the provider's native requests. */
  readonly gateway: string;
  readonly status: ProviderStatus;
  /** Set exactly when `status` is `parked`. */
  readonly parked?: ProviderParking;
  /**
   * Prefixes of the provider's reviewed family names (`criteo_`). A family belongs to the adapter with the longest
   * matching prefix, so `google_business_lodging` is Business Profile's and `google_targeting` Google Ads'.
   */
  readonly familyPrefixes: readonly string[];
  readonly account?: AccountModel;
  readonly deletions?: BodyDeletions;
  /** Its generic entity writes, the reviewed route src/reviewed-routes.ts gives a write no registered family claims. */
  readonly entityWrites?: EntityWrites;
  /** How the review summary names its writes' operations (Google Ads' :mutate operations), src/review-summary.ts. */
  readonly reviewOperations?: ReviewOperations;
  readonly paging?: PagingFacts;
  /** Its writes take execution_options, whose validate-only values a reviewed write refuses (Meta, WRT-06). */
  readonly executionOptions?: true;
  /** Its OAuth grant (CON-02, CON-03), which src/provider-grants.ts lists and reads. */
  readonly grant?: ProviderGrantFacts;
}

/** A requirement on recorded scopes: any one of `any` is recorded, and every scope of `all` is. */
export interface ScopeRequirement {
  any?: readonly string[];
  all?: readonly string[];
}
/**
 * A provider's OAuth grant: what AMCP requests, what read and reviewed-write enforcement requires, where the granted
 * permissions come from, and whether readiness has an exact account read. `null` means the provider has no OAuth scope
 * that distinguishes the capability (TikTok, X, Criteo): AMCP cannot know it from a grant.
 */
export interface ProviderGrantFacts {
  /** The website platform that authorizes this gateway, when it has one. */
  platform?: string;
  /** Requested for every authorization (the platform's default scopes). */
  requestedRead: readonly string[];
  /** Added when the deployment allows reviewed writes. */
  requestedWrite: readonly string[];
  read: ScopeRequirement | null;
  write: ScopeRequirement | null;
  /**
   * Where the granted permissions are learned: echoed by the token response, read from a permissions endpoint (Meta
   * `/me/permissions`), only the requested access type (X), or not available at all.
   */
  grantSource: 'token_response' | 'permissions_endpoint' | 'requested_access_type' | 'none';
  /** Whether readiness has one exact, scoped account read for this gateway (src/account-metadata.ts accountPlan). */
  accountReadContract: boolean;
}

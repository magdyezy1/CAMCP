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
import type {
  Action,
  Catalog,
  CompiledRequest,
  Connection,
  Credentials,
  DeclaredOperation,
  JsonObject,
  ToolDefinition,
} from './types.js';
import type {MirrorError} from './errors.js';
import type {ProviderErrorClass, ProviderErrorContext, ProviderErrorInput} from './provider-error-taxonomy.js';
import type {ProviderErrorCandidate, ProviderErrorToken} from './provider-error-core.js';
import type {Store} from './store.js';
import type {Registry} from './catalog.js';
import type {TransportResult} from './transport.js';
import type {VerificationRead} from './reviewed-family.js';
import type {ReviewVolatile} from './review-state-core.js';
import type {UsageProfile} from './provider-usage.js';
// Writes and campaigns (wave 4c): what the review gives a provider's own state read.
import type {Actor} from './types.js';
import type {NativeTransport} from './transport.js';
import type {CredentialProvider} from './auth.js';
import type {VendorRoute} from './delegated-native.js';
// Writes and campaigns (wave 4c): the native calls a campaign clone reads its source through, and the service a plan's
// preflight reads through.
import type {ToolCall} from './workspace-core.js';
import type {MirrorService} from './service.js';
// Wave 4c round 6 (w4c-arc6-tables): the shared tables' row types.
import type {Alternative} from './unavailable-operations.js';
import type {Resolved} from './wire-contracts.js';

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
  /**
   * The connection field that keeps how each selected account is reached, as its login's discovery found it:
   * Microsoft's parent customer of each account (`accountCustomers`), Google Ads' manager route (`accountLoginCustomers`).
   * The website's asset selection and sync replace it from the discovered accounts with the provider's login steps
   * (`routes`, src/provider-login.ts), and the store keeps manager routes only on a login whose provider keeps them.
   */
  readonly routes?: 'accountCustomers' | 'accountLoginCustomers';
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
 * A creation field whose value names a budget but moves no money (ARC-01 phase B: a branch of src/spend-effects.ts):
 * the spending field-name match reads a POST to `path` whose body carries exactly `value` in `field` at its top level
 * without that field. Any other value, another method or path, or the field anywhere else still names a budget.
 */
export interface SpendNeutralCreation {
  /** The creation's path; never global or sticky, so it keeps no position between requests. */
  readonly path: RegExp;
  readonly field: string;
  readonly value: unknown;
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
  /**
   * The rows of closed-set tokens its documented error shape holds (G9, src/provider-error-core.ts): each error's code and
   * enum, the index of the failing operation and the field path (Google Ads' GoogleAdsFailure, Meta's blame fields, TikTok's
   * code). Only what the shape says structurally, never text; the transport checks every token against its pattern again
   * and drops what fails, so a hook cannot put free text into a message.
   */
  tokens?(body: unknown): readonly ProviderErrorCandidate[];
  /**
   * Whether the code and enum of a token row may be quoted in a message (the review's S2-1). A pattern closes a token's
   * alphabet, not its meaning, so a provider whose codes are words of its own choosing (Google Ads' error families and
   * enums) vouches for them against a schema AMCP vendors: the words stay in `details.provider_errors` whatever this says,
   * and a message quotes them only when it says true. A provider whose codes are numbers needs none: a number is quoted.
   */
  quotable?(row: ProviderErrorToken): boolean;
  /**
   * The provider's own first sentence for the refusal (Google Ads' first error message, Meta's user message, TikTok's
   * message): third-party text, which `details.provider_message` keeps cleaned, clipped and marked untrusted, and no
   * message ever carries.
   */
  text?(body: unknown): unknown;
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
  /**
   * How the provider reports its rate limit usage (the rate governor, R2.5 M2, MT3; src/provider-usage.ts): Meta reads its three
   * usage headers on every response, Google declares that its APIs send none. A provider that declares neither is shown as
   * unknown until a header it can read is seen.
   */
  readonly usage?: UsageProfile;
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
  /**
   * Wave 4c (transport and catalog): the resource a RESOURCE_SCOPE_REQUIRED refusal's path names whose ownership
   * observation, once lapsed, MirrorService may renew from the account's own list (Snapchat's scoped entities, F-70);
   * undefined for any other path.
   */
  lapsedResource?(path: string): string | undefined;
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
 * generic rule, the order and every refusal they name. A provider module these checks import must not read pages
 * through src/pagination.ts, which consults these hooks (an import cycle): Reddit's family pages with its own leaf,
 * src/reddit-paging.ts, which its adapter's paging hook is too.
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
  /**
   * What this provider's answers carry that changes by itself (R2.5 M1, plan idea 1, L5-02): response metadata, delivery
   * and review telemetry, meters and last-modified times, as field names (`review_status*` names a family). A review
   * hashes the rest, so a field not listed is protected. Only names that no user edit changes: never a configuration
   * field. The table replaces the one set every provider shared; src/review-state-core.ts applies it, idempotently and
   * without adding anything, to every state this provider's reviews keep, hash and compare. It also declares where the
   * provider itself signs links, which it signs anew at every read: `signed-host:<host>` (`*.` for the hosts below a domain)
   * for its own asset, preview and licence hosts, and `signed-field:<name>` for a field it fills with a link it generated
   * (lead review S2-2). A link there loses its signing and expiry parameters; a URL anywhere else (a landing page, a tracking
   * URL) is the advertiser's, and a provider with no such entry keeps every URL whole.
   */
  readonly volatile?: ReviewVolatile;
  /**
   * What a review keeps of the read of an ACCOUNT (R2.5 M1, plan idea 1: `readRole(read) === 'account'`, the account a write
   * creates something in): its identity (who it is, its status, its currency and time zone), as the provider gave it, and
   * nothing that changes without an edit. Applied by the state stage to every read of this provider that carries a role,
   * before any family's own projection; undefined for a read it keeps no record for. A `parent` read is not the account's:
   * it is kept whole, as a target is (the budget, bid, flight and targeting of a parent decide what the child spends by), so
   * a provider answers `undefined` for it. Idempotent and monotone (it only drops), so a saved review's state is projected
   * again at execute.
   */
  identity?(read: CompiledRequest, data: JsonObject): unknown;
  /**
   * The write's headers its verification reads keep (LinkedIn's versioning headers); none by default. Its state reads
   * keep the same (src/write-snapshots.ts stateRead, wave 4c).
   */
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
  /**
   * The read of account `id` that the state of an amcp_media upload is kept from, where the provider asks only for the
   * fields its `snapshot` keeps (TikTok's advertiser info, T1): `read` is the upload's shared account read, returned with
   * its path and query set. Absent: the upload reads the account as it always did.
   */
  accountState?(read: CompiledRequest, id: string): CompiledRequest;
}

/**
 * How a saved native report query of the provider names its exact account (ARC-01, reporting): the resource
 * selectors a workbook query's arguments carry (projected by src/workbook-repository.ts) and the account anchors it
 * writes in resource form. src/report-resource-scope.ts and src/report-runs.ts keep the selector bounds, the order of
 * the checks and their one refusal (REPORT_SCOPE_UNAVAILABLE); a provider only says which account a selector names.
 */
export interface ReportResourceScope {
  /**
   * The exact account a selector of `kind` names by `value` (a bounded text the shared checks passed), never a child
   * resource; undefined when it names none (refused).
   */
  account(kind: unknown, value: string): string | undefined;
  /**
   * The selector kind of an account anchor written in resource form (GA4's `properties/...` is a property selector,
   * Tag Manager's and Business Profile's `accounts/...` an account selector); undefined for a plain account ID.
   */
  anchorKind?(anchor: string): string | undefined;
  /**
   * The accounts of several selectors when some only check another's consistency (Business Profile's location
   * selectors); undefined to refuse. `account` is the shared check of one selector.
   */
  accounts?(rows: JsonObject[], existing: unknown[], account: (row: JsonObject) => string): string[] | undefined;
  /**
   * Wave 4c round 6 (w4c-arc6-reporting): where a saved query's arguments carry the selectors `account` reads, as
   * data: src/workbook-repository.ts writes the SQL that projects them (ARC-02's store layer).
   */
  readonly selectors?: ReportSelectors;
}

// Wave 4c round 6 (w4c-arc6-reporting): the resource selectors of a saved native report query, which the store layer
// projects in SQLite (src/workbook-repository.ts). Each value is a plain name the projection quotes as a SQL string.

/** One group of selector fields in a saved query's bounded native arguments. */
export interface ReportSelectorGroup {
  /** The argument objects whose own fields are selectors, as SQLite JSON paths (`$` the arguments themselves). */
  readonly paths?: readonly string[];
  /** Instead, one argument object whose fields at any depth are selectors (GA4's report request). */
  readonly within?: string;
  /** The selector fields' native parameter keys (lower case without separators: native_parameter_key). */
  readonly keys: readonly string[];
  /** Only a resource name selects: a text value with a slash (a value of another type still projects, as invalid). */
  readonly resourceNames?: boolean;
}

/** A provider's selector fields, the selector kind each projects as, and the body that invalidates them. */
export interface ReportSelectors {
  /**
   * Where the provider's branch comes among the providers' branches of the projection, first at 1. SQLite takes the
   * one branch of the query's gateway in any order; the order keeps the stored projection's SQL text.
   */
  readonly order: number;
  readonly groups: readonly ReportSelectorGroup[];
  /** The selector kind of a field by its key; a field not named here is of kind `otherwise`. */
  readonly kinds?: Readonly<Record<string, string>>;
  readonly otherwise: string;
  /** The argument that is the native request body: present and not an object, it makes the selectors invalid. */
  readonly body?: string;
}

/**
 * Wave 4c round 6 (w4c-arc6-reporting): the attribution windows a provider's reports take as an explicit selection
 * (Meta's, RPT-07), with which src/overview-levels.ts and the provider's reporting check a source's attribution profile.
 */
export interface ReportAttributionWindows {
  /** Every window, in the canonical order AMCP sends and labels a selection in. */
  readonly windows: readonly string[];
  /** The click windows, of which one selection names at most one. */
  readonly clickWindows: readonly string[];
  /** The refusal's reason for a selection the windows do not support. */
  readonly message: string;
  /** Whether `windows` is one supported explicit selection. */
  readonly valid: (windows: unknown) => windows is string[];
}

// ARC-01 phase B, wave 4c (transport and catalog): the provider's parts of the catalog compiler. The shared module
// keeps every rule and the order of every step; a hook answers only where it named the provider before.

/** A request the catalog lists without a route, adapted to the routed request it stands for (CompileHooks.legacy). */
export interface AdaptedRequest {
  /** The input of the routed action, compiled in its place. */
  readonly input: JsonObject;
  /** The action name the compiled request keeps. */
  readonly legacyAction: string;
  readonly evidence: string;
  readonly warnings: readonly string[];
  /** A default page size the adaptation applied (Google Ads' GAQL LIMIT of a list alias asked without one). */
  readonly defaultLimit?: number;
}

/** What a provider's request rules may set on a request the compiler is building (CompileHooks.request). */
export interface CompileDraft {
  readonly gateway: string;
  /** The catalog action the request is compiled from, and its route template. */
  readonly action: Action;
  readonly route: string;
  method: string;
  readonly query: JsonObject;
  body: unknown;
  readonly headers: Record<string, string>;
  readOnly: boolean;
  readonly accountId: string | undefined;
}

/** How a provider's catalog-required request fields are checked (CompileHooks.required). */
export interface RequiredFields {
  /** Checked in every call mode, not only under the catalogPreflight flag (Google Ads). */
  readonly always?: true;
  /** A route whose required fields its own plan step checks per variant instead (TikTok's preview types). */
  unchecked?(route: string): boolean;
  /** The value of a required field under its other name (Google Ads' camelCase names). */
  alias?(values: JsonObject, key: string): unknown;
  /** A required field another step supplies after review (Google Ads' Drive-imported upload content). */
  supplied?(key: string, route: string, values: JsonObject): boolean;
  /** The refusal of a missing required field (Google Ads names the version change of its action). */
  missing?(action: Action, key: string): MirrorError;
}

/**
 * A provider's part of the catalog compiler (src/compiler.ts Compiler.compile), which keeps the input guards, the
 * catalog lookup, the alias, account, body, path, query and method rules and the order of every step.
 */
export interface CompileHooks {
  /** The provider compiles its requests from its own contracts (Microsoft Advertising): the compiler returns this. */
  own?(input: JsonObject): CompiledRequest;
  /** An action the catalog lists without a route, as the routed request it stands for (Google Ads' legacy actions). */
  legacy?(registry: Registry, input: JsonObject): AdaptedRequest | undefined;
  /** The catalog action of a request that names a resource and an RPC instead of an action (DV360). */
  resourceAction?(registry: Registry, input: JsonObject): Action | undefined;
  /** Its `fields` lists are one comma-separated value (Meta's Graph API): joined when compared and when sent. */
  readonly joinedFields?: true;
  /** Request values the account sets besides its aliases (Google Ads' customer_id, Meta's act_ path ID). */
  accountValues?(values: JsonObject, accountId: string, route: string): void;
  readonly required?: RequiredFields;
  /** Its parameters are sent in the query whatever the method (LinkedIn's Rest.li, DV360). */
  readonly queryParameters?: true;
  /**
   * Its request rules once the query and body are formed (TikTok's advertiser and lead region, Google Ads' body
   * mapping, LinkedIn's version, Rest.li method and method override): it may set the draft's method, body, headers,
   * query and readOnly, and returns the plan fields that ride beside the request (TikTok's comment scope).
   */
  request?(draft: CompileDraft, input: JsonObject, registry: Registry): Partial<CompiledRequest> | undefined;
  /** The query parameter that makes a request carry other requests, never a read (Meta's Graph batch). */
  readonly batchParameter?: string;
  /** Its plan steps before the request controls of its gateway's report job (src/report-jobs.ts). */
  beforeJob?(plan: CompiledRequest): CompiledRequest;
  /** Its plan steps after them. */
  afterJob?(plan: CompiledRequest): CompiledRequest;
}

// ARC-01 phase B, wave 4c (transport and catalog): the provider's parts of the catalog registry.

/**
 * A captured catalog read at the newer provider version AMCP sends (CatalogHooks.version, src/catalog-versions.ts): the
 * version, a catalog action, a captured LIST_ACTIONS page or DESCRIBE_ACTION response, and the tool definition when its
 * text names a version.
 */
export interface CatalogVersion {
  readonly version: string;
  action(action: Action): Action;
  capture(data: JsonObject): JsonObject;
  tool?(tool: ToolDefinition): ToolDefinition;
}

/** Actions a provider documents beyond the captured catalog (CatalogHooks.supplemental). */
export interface SupplementalActions {
  readonly actions: readonly Action[];
  /** What the registry must hold for them to be registered: the provider's captured catalog, or its tool. */
  readonly requires: 'catalog' | 'tool';
}

/**
 * A provider's part of the catalog registry (src/catalog.ts Registry), which keeps how tools, schemas, catalogs and
 * routes are built and in what order, validation, lookups, listings and help; a hook answers only where the registry
 * named the provider before.
 */
export interface CatalogHooks {
  /**
   * AMCP's additions to captured tool definitions, by tool name: its own gateway's (X's report jobs, Reddit's,
   * DV360's, Business Profile's and Adjust's extensions) or an AMCP tool's (Meta's post workflow in
   * amcp_native_action). No two providers extend one tool (a load-time check).
   */
  readonly tools?: Readonly<Record<string, (tool: ToolDefinition) => ToolDefinition>>;
  /** Its captured catalog's actions as AMCP reads them (Meta's documented overrides), before any version move. */
  action?(action: Action): Action;
  /**
   * Its captured catalog moved to the newer version AMCP sends (Google Ads', Meta's, LinkedIn's), which
   * src/catalog-versions.ts lists for the registry, introspection and the capture verification.
   */
  readonly version?: CatalogVersion;
  /** Its documented actions beyond the captured catalog (Meta's rule updates, Google's Data Manager, Apple's v1). */
  readonly supplemental?: SupplementalActions;
  /**
   * The spellings of an action's name beyond the generic ones (T7, src/action-aliases.ts: the name without the provider
   * prefix, and for a read the name without or with the other of `_get` and `_list`): Google Ads' names keep the
   * recorded version, so its version-neutral and current-version spellings are its own. A spelling that is an exact
   * name, that two actions claim, or that reads and leads to a write is dropped, as the generic ones are.
   */
  aliases?(action: Action): readonly string[];
  /**
   * Its tool and catalog are AMCP's own rather than captured (Microsoft Advertising), registered when the registry
   * holds AMCP's tools; the catalog's actions are its routes.
   */
  own?(): {readonly tool: ToolDefinition; readonly catalog: Catalog};
  /** Checks amcp_tool_help's arguments for its gateway, in place of the help tool's schema (Microsoft), or refuses. */
  helpArguments?(input: JsonObject): void;
  /**
   * Its help, in place of the captured help (Microsoft's contracts, Apple's v1 actions); undefined leaves the request to
   * the registry's own help. `schema` is the tool's input schema as the call's options list it.
   */
  help?(input: JsonObject, tool: ToolDefinition, schema: () => JsonObject): JsonObject | undefined;
}

// ARC-01 phase B, wave 4c (transport and catalog): the provider's parts of the delegated compiler.

/** The account a delegated request names, as the generic scope rule found it (DelegatedScope.refine). */
export interface DelegatedAccount {
  /** The account argument, under its name or one of its aliases. */
  readonly account: unknown;
  /** Its ID (an `accounts/<id>` name's last segment). */
  readonly id: string | undefined;
  /** The account the path names, matched by the provider's account path. */
  readonly match: RegExpMatchArray | null;
}

/** What the delegated compiler gives a provider's scope rule: the request and the compiler's own resource helpers. */
export interface DelegatedScopeContext {
  readonly route: VendorRoute;
  readonly args: JsonObject;
  readonly path: string;
  readonly body: JsonObject;
  /** The request's query, which a scope rule may complete (Business Profile's location filter). */
  readonly query: JsonObject;
  /** The ID a value names: itself, or the ID of a `<resource>/<id>` name; refuses another shape. */
  resourceId(value: unknown, resource: string): string | undefined;
  /** Whether two values name the same resource. */
  sameResource(left: unknown, right: unknown, resource: string): boolean;
  /** The one value the bags give a parameter under its names; conflicting aliases are refused. */
  singleValue(key: string, bags: JsonObject[], extra?: string[]): unknown;
}

/**
 * A provider's scope rule for its delegated requests, at the step where the delegated compiler named the provider:
 * in place of the generic account rule, its account names, or after it.
 */
export interface DelegatedScope {
  /** The scope in place of the account rule (GA4's property, Search Console's site). */
  own?(context: DelegatedScopeContext): string | undefined;
  /** Its account argument's other names and the path that names its account (Reddit's ad_account_id, /ad_accounts/). */
  readonly account?: {readonly aliases: readonly string[]; readonly path: RegExp};
  /** Its scope from the account the request names (Business Profile's locations), in place of the account's own. */
  refine?(context: DelegatedScopeContext, account: DelegatedAccount): string | undefined;
}

/**
 * A provider's part of the delegated compiler (src/delegated-native.ts DelegatedNativeCompiler), which keeps the route
 * lookup, the version, path, query and body rules, the vendor schema checks and the order of every step.
 */
export interface DelegatedHooks {
  /** Its routes in the vendor snapshot are compiled by its own entry point, never delegated (Google Ads). */
  readonly direct?: true;
  /** Routes it adds to the snapshot's, when the snapshot holds the schema components they use (Reddit's). */
  readonly routes?: {readonly components: string; list(): readonly VendorRoute[]};
  /** Other names its tool's arguments may give a native parameter (Reddit's), none otherwise. */
  aliases?(parameter: string): readonly string[] | undefined;
  /** The argument that carries its request body (GA4's `request`), `payload` otherwise. */
  readonly bodyArgument?: string;
  /** On a route without a body, its body carries query values and is not refused (GA4's report requests). */
  readonly queryBody?: true;
  /** Body fields its arguments may give at the top level, for an action (Search Console's URL inspection). */
  bodyFields?(action: string): readonly string[] | undefined;
  /** What the refusal of a missing path parameter suggests (GA4's resource names). */
  readonly missingPathStep?: string;
  /**
   * A query parameter its documentation requires although the snapshot does not mark it (Business Profile's readMask
   * of its location and lodging reads): the check of a value given for it, which refuses an unusable one.
   */
  requiredQuery?(operation: string, action: string, key: string): ((value: unknown) => void) | undefined;
  /** Its unexploded array parameters are sent comma-separated (Reddit). */
  readonly joinedArrays?: true;
  /**
   * Its request bodies are checked against their pinned schema (Reddit's; Criteo's documented ones): the compiler
   * refuses an invalid body with INVALID_VENDOR_BODY, `refusal` its sentence naming the provider's schema, and `report`
   * checks a valid report body further (Reddit's insights).
   */
  readonly bodySchema?: {
    applies(route: VendorRoute): boolean;
    readonly refusal: string;
    report?(action: string, body: JsonObject): void;
  };
  readonly scope?: DelegatedScope;
}

// ARC-01 phase B, wave 4c (transport and catalog): the provider's parts of the action contract ledger.

/** The fields of an action contract row a provider's rule sets (src/action-contracts.ts ActionContract). */
export interface ContractRow {
  readonly status?: 'adapter_requires_input' | 'local_workflow' | 'media_workflow';
  readonly implementation: string;
  readonly reason: string;
  readonly source?: string;
  readonly tests: readonly string[];
}

/** What a native read of a provider's own adds to its row: its module, its test and its sentence. */
export interface ContractNote {
  /** Appended to the row's implementation, after ' / '. */
  readonly implementation: string;
  /** Appended to the row's tests; with `once`, the tests are then a set (as the row kept them). */
  readonly test: string;
  readonly once?: true;
  /** Appended to the row's reason, after a space. */
  readonly reason: string;
}

/** A provider's catalogued actions that name no route (Google Ads' legacy actions), for one ledger. */
export interface ContractLegacy {
  /** The route such an action stands for, and the source its row cites. */
  route(action: Action, route: Action, source: string): {readonly route: Action; readonly source: string};
  /** Whether an explicit adapter runs it, its route depending on the request: its row is then `row`. */
  adapted(action: Action): boolean;
  readonly row: ContractRow;
}

/**
 * A provider's part of the action contract ledger (src/action-contracts.ts), which keeps how every captured, supplemental
 * and delegated action is classified, in what order, and every shared row; a hook answers only where the ledger named
 * the provider before. The localization inventory reads the reasons of a declaration of this type
 * (tools/check-locales.mjs), as it read them in the ledger.
 */
export interface ContractHooks {
  /** What its own native reads add to their rows (DV360's targeting search, X's audience estimate and report status). */
  readNotes?(plan: CompiledRequest): readonly ContractNote[];
  /** The row reason of a raw step of a workflow amcp_media performs itself (Snapchat's chunked upload ADD, FINALIZE). */
  mediaStep?(plan: CompiledRequest): string | undefined;
  /** Its catalogued actions without a route (Google Ads' legacy actions), for one ledger of the registry. */
  legacy?(registry: Registry): ContractLegacy;
}

// ARC-01 phase B, wave 4c (transport and catalog): the provider's parts of the token renewal.

/** The refresh-token request as the renewal formed it, which a provider's rule completes (RefreshHooks.request). */
export interface RefreshRequest {
  /** The form body: grant_type, refresh_token, client_id and client_secret. */
  readonly body: URLSearchParams;
  readonly headers: Record<string, string>;
}

/**
 * A provider's part of the token renewal (src/auth.ts CredentialProvider), which keeps the expiry window, the single
 * renewal per connection and its store lock, the refresh gate, the app-change refusal, the refresh-token grant and its
 * endpoint, the single attempt, the response checks, the health records and the order of every step; a hook answers
 * only where the renewal named the provider before.
 */
export interface RefreshHooks {
  /**
   * The provider renews its access token itself instead of with a refresh-token grant (Apple's client credentials), so
   * the renewal asks its login for no app secret; the outcome is recorded as any other renewal's.
   */
  own?(credentials: Credentials, fetcher: typeof fetch): Promise<Credentials>;
  /** The secret its login holds of its own OAuth app (X's consumer secret); the client secret otherwise. */
  appSecret?(credentials: Credentials): unknown;
  /**
   * Its parts of the refresh-token request once the body is formed (Microsoft's scope, Snapchat's registered callback,
   * Reddit's User-Agent and Basic authentication); it refuses a request it cannot send.
   */
  request?(request: RefreshRequest, credentials: Credentials, connection: Connection): void;
}

/** The preconditions of a plain documented GET read: read-only, no body, no special transport. */
export const plainGetRead = (p: CompiledRequest) =>
  p.readOnly && p.method === 'GET' && !p.specialTransport && p.body === undefined;

/** A documented preview placement whose URL and expiry can be returned without provider markup. */
export interface AdPreviewLink {
  placement: string;
  device: string | null;
  url: string;
  expires_at: string;
}

/**
 * One ad amcp_ad_previews considers (a creative, for Snapchat and LinkedIn), in AMCP's terms: what a platform's list
 * or lookup says of it, once the platform's own module has validated the record and mapped its status.
 */
export interface AdPreviewRow {
  /** The ID a preview is read for. */
  id: string;
  name: string | null;
  /** `active`, `paused` or `archived`; absent when the platform's status is none of them. */
  status?: string;
  campaign?: string;
  adset?: string;
  /** The ad behind a creative that several ads share (Snapchat); it keeps those ads' rows apart. */
  key?: string;
  /** The platform's own record, when its fields are the preview (Reddit). */
  native?: JsonObject;
  /**
   * What the platform's entry says of this row whether its preview was read or refused (X: the Tweet and the promoted Tweets that
   * share it). The tool puts them in the entry before the preview's own fields, or before the diagnostic of a refused read, so
   * an entry whose preview could not be read still says which ad it is. A platform that names none gets the entry it always got.
   */
  fields?: JsonObject;
}

/** One native page of a list: its rows, the token of the next page, and whether more follow. */
export interface AdPreviewPage {
  rows: AdPreviewRow[];
  after: string | null;
  more: boolean;
  /** A platform that pages by number carries no token (TikTok): another page does not need one. */
  byNumber?: true;
}

/**
 * What the shared preview tool (src/ad-previews.ts) hands a platform's selection: the checked request, and the stages
 * the tool keeps for every platform: the login check around each native read, the status and parent filters, and the
 * signed, bounded scan of a platform's list pages.
 */
export interface AdPreviewRequest {
  readonly account: string;
  /** The ads or creatives the caller named, as the platform's `normalize` wrote them. */
  readonly wanted?: readonly string[];
  readonly statuses: readonly string[];
  readonly campaigns: readonly string[];
  readonly adsets: readonly string[];
  readonly limit: number;
  /** The placement or format the caller chose, for a platform that offers them (`formats`). */
  readonly format?: string;
  /** The arguments every native read names: the account, and the selected login. */
  readonly base: {readonly account_id: string; readonly connection_id?: string};
  /** One native read through the platform's own gateway, bracketed by the login checks; the answer is its data. */
  read(args: JsonObject): Promise<any>;
  /** Whether a row passes the status and parent filters; a named row ignores the status. */
  matches(row: AdPreviewRow, named?: boolean): boolean;
  /**
   * The next `limit` matching rows of the platform's list, scanning at most `maxScans` native pages under one signed
   * cursor, with the paging fields the answer carries (`next_cursor`, `has_more`).
   */
  pageSelection(
    fetchPage: (after: string | null, page: number) => Promise<AdPreviewPage>,
    maxScans?: number,
  ): Promise<{chosen: AdPreviewRow[]; paging: JsonObject}>;
  /** The `not_found` fields of the named IDs a platform did not list. */
  notListed(missing: readonly string[]): JsonObject;
  /**
   * Whether the gateway has observed the account to own a resource (`creatives/<id>`), from one of its own list reads of
   * the account in the last five minutes: the observation a read of that resource needs before it is sent.
   */
  observed(resource: string): boolean;
}

/** The ads a platform's selection chose, how each one's preview is read, and the rest of the answer. */
export interface AdPreviewSelection {
  /** The ads whose previews are read, in order. */
  readonly rows: AdPreviewRow[];
  /** One row's preview fields; a refusal it throws becomes that row's own diagnostic. */
  preview(row: AdPreviewRow): Promise<JsonObject>;
  /** The answer's other fields: paging, the IDs not found, the order read, what a bounded scan did not establish. */
  readonly extra: JsonObject;
}

/** What a platform without a readable preview is told of the request (`AdPreviewHooks.explain`). */
export interface AdPreviewRoute {
  readonly account: string;
  /** The connection the caller named, if any. */
  readonly connection?: string;
  readonly wanted?: readonly string[];
}

/** A platform's part of amcp_ad_previews (src/ad-previews.ts): its selection of ads and how it reads their previews. */
export interface AdPreviewHooks {
  /** The `platform` value of the tool that names it. */
  readonly platform: string;
  /** The hosts its preview links may be on; a link elsewhere in a response (an ad's own copy, say) is not one. */
  readonly linkHosts?: RegExp;
  /** The placements it previews (`ad_format`); the first is the default. */
  readonly formats?: readonly string[];
  /** Named ads and parent filters it writes in another form (LinkedIn's URNs); it refuses one it cannot read. */
  normalize?(kind: 'ad' | 'campaign' | 'adset', values: string[]): string[];
  /** Reads its ads and their previews; absent for a platform whose previews AMCP cannot read. */
  select?(request: AdPreviewRequest): Promise<AdPreviewSelection>;
  /** For a platform without a readable preview: the answer's fields (its explanation, or the write that creates one). */
  explain?(route: AdPreviewRoute): JsonObject;
  /**
   * For a platform whose links do not all open for anyone who has them: which of its links opens without its sign-in and
   * which may not. The help of amcp_ad_previews lists it (src/ad-previews.ts), since the tool description cannot say it.
   */
  readonly linkAccess?: string;
}

/**
 * A provider's hooks (ARC-01 phase B): the parts of its adapter that call its own modules, declared in
 * src/<provider>-adapter.ts and registered in src/provider-hooks.ts. The facts any module may read are the
 * ProviderAdapter of the leaf registry; a hook only supplies a provider fact to the shared stage that asks for it.
 */
export interface ProviderHooks {
  /** The gateway of the provider adapter these hooks belong to. */
  readonly gateway: string;
  // Wave 4c (transport and catalog).
  readonly compile?: CompileHooks;
  readonly catalog?: CatalogHooks;
  readonly delegated?: DelegatedHooks;
  readonly contracts?: ContractHooks;
  readonly refresh?: RefreshHooks;
  readonly reads?: ReadClassification;
  readonly paging?: Paging;
  readonly accountRead?: AccountRead;
  readonly wire?: WireProfile;
  readonly scope?: ScopeHooks;
  readonly checks?: GatewayChecks;
  readonly review?: ReviewProjections;
  /** Workbook reporting (ARC-01, reporting): the account a saved native report query's selectors name. */
  readonly reportScope?: ReportResourceScope;
  /** Its guided campaign recipes (wave 4c, writes and campaigns). */
  readonly campaign?: CampaignHooks;
  /** Its parts of the reviewed write lifecycle (wave 4c, writes and campaigns). */
  readonly writes?: WriteReviewHooks;
  // Wave 4c round 6 (w4c-arc6-versions).
  /** Its API version as AMCP sends it, from its version module (src/<provider>-version.ts). */
  readonly versions?: ProviderVersions;
  /** What tools/list and amcp_tool_help say of its gateway beyond the captured text (src/tool-notes.ts). */
  readonly notes?: ToolNotes;
  /** Its part of LIST_ACTIONS and DESCRIBE_ACTION (src/introspection.ts). */
  readonly listing?: CatalogListing;
  /** Its provider jobs no reviewed family declares (src/effect-class.ts). */
  readonly jobs?: ProviderJobHooks;
  /** A setting the owner keeps for it per workspace, which owner operations list and save (src/owner-operations.ts). */
  readonly ownerSetting?: OwnerSetting;
  /** Its legacy action alias names, which the owner's alias usage baseline counts (src/legacy-alias-usage.ts). */
  legacyAliases?(): readonly string[];
  // Wave 4c round 6 (w4c-arc6-tables): its rows of the shared tables, which each shared module lists in the order
  // src/provider-hooks.ts declares for it.
  /** The captured operations it lists but AMCP cannot run (src/unavailable-operations.ts), after its connection's. */
  readonly unavailable?: Readonly<Record<string, UnavailableOperationFacts>>;
  /** Its connection operation, whose OAuth steps run on the website (src/connection-diagnostics.ts). */
  readonly connection?: ConnectionOperation;
  /** Its discovery-only programs (src/discovery-programs.ts), in their listed order. */
  readonly programs?: readonly DiscoveryProgramFacts[];
  /** Its top-level parameters (src/parameters.ts): account aliases, platform controls and its own parameter rules. */
  readonly parameters?: ParameterFacts;
  /**
   * Its provider job families and what each guarantees (src/provider-jobs.ts providerJobContracts); `jobs`, above, is
   * its provider jobs that no reviewed family declares.
   */
  readonly jobFamilies?: readonly ProviderJobFacts[];
  /** Its own validation of a mutation, which applies nothing (src/provider-validation.ts, WRT-06). */
  readonly validation?: ProviderValidation;
  /** The pinned contract its requests are checked against before they are sent (src/wire-contracts.ts, PRV-05). */
  readonly wireContract?: WireContractFacts;
  // Wave 4c round 6 (w4c-arc6-workspace).
  /** Its parts of AMCP's generic workflows of amcp_native_action (src/workflows.ts). */
  readonly genericWorkflows?: GenericWorkflowHooks;
  /** Its steps of AMCP's reviewed media upload (src/media-upload.ts). */
  readonly media?: MediaUploadHooks;
  /** Its part of amcp_ad_previews: its ads, their previews, the links it accepts and its explanation (src/ad-previews.ts). */
  readonly previews?: AdPreviewHooks;
  /** Exact read-scoped URL fields whose signatures are capabilities; credentials are still scrubbed. */
  readonly signedLinkFields?: (plan: CompiledRequest) => readonly string[];
  // Wave 4c round 6 (w4c-arc6-catalog).
  /**
   * Its catalog destination's projection of supplied products into its native reviewed steps, or of the rows its
   * comparison reads (COM-03), which src/catalog-ingestion.ts dispatches to by gateway: it refuses in its own order.
   */
  readonly catalogProjection?: (input: JsonObject) => JsonObject;
  /**
   * The native usage the creative library offers for one of its library assets of this provider, from the asset's
   * retained metadata (src/creative-library.ts), or undefined for none.
   */
  readonly mediaUsage?: (asset: JsonObject) => MediaUsage | undefined;
  /**
   * Its conditional programs (CON-04) with their checks' steps, which src/conditional-programs.ts lists and checks;
   * `programs`, above, is its discovery-only programs, which AMCP lists but never checks.
   */
  readonly conditionalPrograms?: readonly ProviderConditionalProgram[];
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
  /**
   * Each of its writes needs spend_change_confirmed=true once no structural or family rule has decided its spending
   * (Reddit: its writes change targeting, serving and shared lists), src/preflight.ts spendConfirmationError.
   */
  readonly everyWriteConfirmsSpend?: true;
  /** A creation field that names a budget but moves no money (Meta's unshared ad set budgets), src/spend-effects.ts. */
  readonly spendNeutralCreation?: SpendNeutralCreation;
  /**
   * A creation that cannot start spend (TikTok's creates, Q14, owner 2026-11-15; Google's campaign creates, owner 2026-11-19),
   * src/spend-effects.ts: everything it creates is pinned paused, or active only under a parent the review reads as paused,
   * so no budget, bid or status field of it names a spend and the field-name match skips it. It reads the plan alone, never a
   * state; Google's children under a parent the review reads PAUSED are the state-aware `writes.pausedChildCreation`. The
   * owner's caps, allow_activation, the flag on every ENABLE of an existing object and the paused-parent check are other
   * rules and still apply.
   */
  readonly pausedCreation?: (plan: CompiledRequest) => boolean;
  readonly paging?: PagingFacts;
  /** Its writes take execution_options, whose validate-only values a reviewed write refuses (Meta, WRT-06). */
  readonly executionOptions?: true;
  /** Its OAuth grant (CON-02, CON-03), which src/provider-grants.ts lists and reads. */
  readonly grant?: ProviderGrantFacts;
  /** The deployment's OAuth app of its logins (SEC-07 S2), which src/app-credentials.ts reads. */
  readonly app?: ProviderApp;
  /** How AMCP renews its logins without the user (CON-02), which src/connection-health.ts reads. */
  readonly renewal?: ProviderRenewal;
  /** Its captured schema lacks LIST_ACTIONS, but AMCP lists its actions from its catalog (DV360, MCP-05; wave 4c). */
  readonly listsActions?: true;
  /** Wave 4c round 6 (w4c-arc6-tables): its withdrawn methods and unsupported aliases (src/retired-provider-actions.ts). */
  readonly retired?: RetiredActions;
  // Wave 4c round 6 (w4c-arc6-workspace).
  /** The child create of a POST that a paused parent covers (Snapchat, Meta, TikTok), src/paused-parents.ts. */
  readonly pausedParents?: (plan: CompiledRequest) => PausedParentLevel | undefined;
  /**
   * Its budget, bid and spend-cap amounts are the account currency times a per-currency offset that only its pinned
   * currency capture gives (Meta's minor units, WRT-07 Stage C), src/budget-units.ts.
   */
  readonly currencyOffsetBudgets?: true;
  // Wave 4c round 6 (w4c-arc6-catalog).
  /** Its catalog destination (COM-03), which src/catalog-destinations.ts lists in catalogDestinationOrder's order. */
  readonly catalogDestination?: CatalogDestinationFacts;
  /** Wave 4c round 6 (w4c-arc6-reporting): the explicit attribution windows its reports take (Meta, RPT-07). */
  readonly reportWindows?: ReportAttributionWindows;
}

/**
 * How AMCP renews a provider's logins without the user (CON-02): at the provider's token endpoint with the login's
 * refresh token, or with the client's own credentials (Apple). A provider without one (Meta, TikTok, X) needs the user's
 * consent again; src/connection-health.ts and the token refresh (src/auth.ts) read it.
 */
export type ProviderRenewal = {readonly tokenEndpoint: string} | {readonly clientCredentials: true};

/**
 * The deployment's OAuth app of a provider's logins (SEC-07 S2): where the environment names its client, and which login
 * fields the deployment's secrets fill when a login of that client is used (src/app-credentials.ts). The website
 * platform that authorizes the provider's logins takes the same stem (server/platform-oauth.ts `env`).
 */
export interface ProviderApp {
  /** AMCP_<stem>_CLIENT_ID and AMCP_<stem>_CLIENT_SECRET name the client. */
  readonly stem: string;
  /** The login field the client secret fills; clientSecret when absent (X's OAuth 1.0a consumer secret). */
  readonly secretField?: 'consumerSecret';
  /** The login field that names the client a login was authorized with, before its clientId (X's consumer key). */
  readonly clientField?: 'consumerKey';
  /**
   * The deployment's further secrets of these logins, by login field and the environment variable that holds it, in this
   * order (Microsoft's developer token; Apple's team, key and private key).
   */
  readonly settings?: Readonly<
    Partial<Record<'developerToken' | 'appleTeamId' | 'appleKeyId' | 'applePrivateKey', string>>
  >;
  /** Login fields never sealed into a login of the deployment's own client (Google Ads' developer token, no longer sent). */
  readonly unsealed?: readonly 'developerToken'[];
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

// ---- Writes and campaigns (ARC-01 phase B and ARC-04, wave 4c) ----

/**
 * A guided campaign recipe a provider offers (ARC-04: campaignRecipe became a table of per-recipe builders). The recipe
 * catalog (src/campaign-recipes.ts) lists the definitions in its provider order and keeps the checks every brief passes
 * before a builder runs: the recipe exists, the brief is an object with every required input, and it names the plan,
 * the account, the login and an ISO currency.
 */
export interface CampaignRecipe {
  readonly definition: RecipeDefinition;
  /** The campaign plan of a brief that passed the catalog's checks; refuses an input the recipe cannot use. */
  build(brief: JsonObject): JsonObject;
  /** What recipe_context says of the recipe beyond its definition (src/recipe-context.ts, wave 4c). */
  readonly context?: RecipeContextFacts;
}
/**
 * A recipe's part of its recipe_context (src/recipe-context.ts recipeContext, which keeps the accounts, defaults,
 * playbook, Pages, Drive logins and the shared prerequisites, in their order).
 */
export interface RecipeContextFacts {
  /** What the recipe leaves unverified or does not change; none by default. */
  readonly limitations?: readonly string[];
  /** The recipe's own prerequisite, after the account grant and currency; its Page, media or search inputs by default. */
  readonly prerequisite?: string;
  /** The provider facts the context adds, read when it is asked (Microsoft's location lookup availability). */
  extra?(): JsonObject;
}
/** A recipe's catalog entry: id, name, platform, required inputs and their alternatives, optional inputs, description. */
export type RecipeDefinition = JsonObject & {
  id: string;
  name: string;
  platform: string;
  required: string[];
  description: string;
};
/** A provider's campaign hooks (ARC-01 phase B, wave 4c). */
export interface CampaignHooks {
  /** Its guided recipes, in the order the recipe catalog lists them. */
  readonly recipes?: readonly CampaignRecipe[];
  /** Its campaign clone (src/campaign-clone.ts, which keeps the checks every clone passes and the spec's changes). */
  readonly clone?: CampaignClone;
  /** Its guided activation of a completed recipe plan (src/campaign-activation.ts, src/campaign-runner.ts). */
  readonly activation?: CampaignActivation;
  /** Its part of a campaign plan's preflight (src/campaign-preflight.ts). */
  readonly preflight?: CampaignPreflight;
  /**
   * Whether a write step the provider refused outright after submission provably created nothing, so that the step may
   * be amended and reviewed under a new key (src/campaign-runner.ts, after the step's own failed-write checks: Google's
   * googleAds:mutate builds without partial failure, refused with a definitive 4xx; the owner's decision 5,
   * 2026-09-29). A provider without one stops the plan.
   */
  refusedBuild?(step: JsonObject): boolean;
  /** The recipe lookups the provider answers, by lookup_kind (src/campaign-runner.ts recipe_lookup). */
  readonly lookups?: Readonly<Record<string, RecipeLookup>>;
  /**
   * The evidence a dependency its recipes declare has in their eligibility (src/recipe-eligibility.ts, after the
   * account currency): the status, evidence and meaning a ready dependency shows, from the assets the read-only
   * preflight checked or the compiled brief; undefined leaves it unknown.
   */
  dependencyEvidence?(id: string, context: DependencyEvidenceContext): JsonObject | undefined;
  /** The plan binding the provider's previews make (Tag Manager's consent preview, X's selected catalog removal). */
  readonly planBinding?: CampaignPlanBinding;
}
/**
 * A campaign plan binding (src/campaign-runner.ts, which keeps where each is made and checked, in its order): the
 * binding a creation input makes is saved on the plan under its key, and each step's review and execution check it.
 */
export interface CampaignPlanBinding {
  /** The plan field it is saved under (`gtm_consent`, `catalog_removal`). */
  readonly key: string;
  /** The binding a plan's creation input and steps make, or undefined without one; refuses a changed preview. */
  create(store: Store, actor: Actor, input: JsonObject, steps: JsonObject[]): JsonObject | undefined;
  /** Before a step's review and its execution, reading through the native calls (Tag Manager's tag); refuses. */
  check?(store: Store, call: ToolCall, actor: Actor, run: JsonObject, step: JsonObject): Promise<void>;
  /** What a step's review and execution expect (X's selected product), or undefined; refuses a changed target. */
  expectation?(run: JsonObject, step: JsonObject): unknown;
  /** Runs a step's review or execution under its expectation. */
  under?<T>(expectation: unknown, run: () => Promise<T>): Promise<T>;
  /** The refusal of a step whose expected evidence changed since the draft. */
  changed?(): never;
}
/** What a recipe's eligibility gives its provider's dependency evidence (src/recipe-eligibility.ts). */
export interface DependencyEvidenceContext {
  /** The assets the read-only preflight's checks name. */
  readonly assets: JsonObject[];
  /** The plan's gateway, login and account. */
  readonly scope: JsonObject;
  /** The brief's resolved inputs. */
  readonly business: JsonObject;
  /** The compiled recipe and its steps. */
  readonly recipe: JsonObject;
  readonly steps: JsonObject[];
}
/**
 * A recipe lookup (recipe_lookup). The runner keeps its order of checks: a lookup the service answers from the
 * provider's own source comes first, then the query's form (2 to 60 letters) and the refusal of an unknown kind, then a
 * lookup searched by that query.
 */
export interface RecipeLookup {
  /**
   * A lookup searched by its query through the ordinary account-scoped native calls (Google's country and language
   * constants); it refuses what the provider's response cannot answer.
   */
  search?(context: RecipeLookupContext): Promise<JsonObject>;
  /**
   * A lookup the service answers from the provider's own source (Microsoft's geographical locations file, CMP-03): the
   * refusal while the service has none.
   */
  unavailable?(): MirrorError;
}
/** What a searched recipe lookup reads with: the runner's store, its native calls, the caller and the checked query. */
export interface RecipeLookupContext {
  readonly store: Store;
  readonly call: ToolCall;
  readonly actor: Actor;
  readonly input: JsonObject;
  readonly query: string;
}
/** What a step's preflight gives its provider (src/campaign-preflight.ts campaignPreflight). */
export interface CampaignPreflightContext {
  readonly service: MirrorService;
  readonly actor: Actor;
  /** The step's login and its normalized account. */
  readonly connectionId: string;
  readonly account: string;
  /** What the provider keeps for one preflight of one plan (Snapchat's pixel lists), by its own keys. */
  readonly cache: Map<string, unknown>;
  /** The review's state check of a read (src/write-state.ts), passed in so that no adapter imports it. */
  validateState(read: CompiledRequest, result: TransportResult): void;
}
/**
 * A provider's part of a campaign plan's preflight. The preflight keeps every check a step passes and their order
 * (the account grant and read, the currency, media preparation, the declared predecessors, the catalog's argument
 * validation, the compiled request's execution risk, write shape and state reads, the 25-record parts); the provider
 * answers where it named the provider.
 */
export interface CampaignPreflight {
  /**
   * The placeholder a declared predecessor's `$ref` takes while the step's contract is checked (Google's resource
   * name of the predecessor's compiled mutation, X's media key and card URI, Snapchat's symbolic ID); undefined for
   * the generic `1`. Refuses a reference it cannot place.
   */
  reference?(context: {
    readonly path: string;
    readonly ref: string;
    readonly parent: JsonObject | undefined;
    /** The preflight's compiler, passed in so that no adapter imports it. */
    compile(gateway: string, args: JsonObject): CompiledRequest;
  }): string | undefined;
  /**
   * The compiled step's own contract checks after its state reads are planned (Meta's creative contract, Snapchat's
   * ad squad pixels); what it can only check at the step's review is a deferral of those fields. Refuses.
   */
  contract?(
    plan: CompiledRequest,
    context: CampaignPreflightContext,
  ): Promise<{fields: string[]; reason: string} | undefined>;
  /**
   * The step's existing dependencies, read live before any predecessor is created (Meta's Page and media, Snapchat's
   * creatives and lead forms, TikTok's launch packs, LinkedIn's lead form), given the paths that depend on
   * predecessors and the prerequisites the step declares. Refuses.
   */
  prerequisites?(
    plan: CompiledRequest,
    context: CampaignPreflightContext,
    deferredPaths: string[],
    declared: string[],
  ): Promise<JsonObject[]>;
}
/** A plan step of an activation, as src/campaign-activation.ts builds it for the plan's gateway, account and login. */
export type ActivationStep = (id: string, description: string, args: JsonObject, depends_on?: string[]) => JsonObject;
/** What an activation plan's read-only gates read with (src/campaign-activation.ts activationGates). */
export interface ActivationGateContext {
  /** The ordinary account-scoped native calls. */
  readonly call: ToolCall;
  readonly actor: Actor;
  /** The plan's activation record: its platform and what the provider's `record` kept for the gates. */
  readonly activation: JsonObject;
  /** The activation plan's steps. */
  readonly steps: JsonObject[];
  /** The account and login of its first step. */
  readonly scope: JsonObject;
  /** Re-checks the actor between reads, as recipe_eligibility does. */
  readonly current: () => void;
  /** Reads the current Google conversion configuration, as recipe_eligibility does (the runner's inspector). */
  readonly inspectConversionGoals?: (actor: Actor, scope: JsonObject, current: () => void) => Promise<JsonObject>;
}
/**
 * A provider's guided activation (CMP-03): a recipe creates its campaign paused, and activation is a separate, linked
 * plan whose steps come from the resources the completed plan verified, in the order that keeps delivery off until
 * the last switch. src/campaign-activation.ts keeps the platforms offered, the step builder and the refusal of a plan
 * without one; src/campaign-runner.ts keeps the activation record and the gates' place in its preflight.
 */
export interface CampaignActivation {
  /** The activation steps from the plan's verified results (step id -> result), made with `step`; refuses a gap. */
  steps(results: ReadonlyMap<string, JsonObject>, scope: JsonObject, step: ActivationStep): JsonObject[];
  /**
   * What the activation record keeps for the gates beyond the plan, platform and recipe (the ad, pixel, lead form or
   * conversion goals the gates read), from the plan, its verified results and its recipe's declared objects.
   */
  record?(run: JsonObject, results: ReadonlyMap<string, JsonObject>, declared: string[]): JsonObject;
  /** The read-only gates, run as one set at the activation plan's preflight; their checks, passed or blocked. */
  gates?(context: ActivationGateContext): Promise<JsonObject[]>;
}
/** What a provider's clone reads and builds (src/campaign-clone.ts clonePlan, after its source and name checks). */
export interface CampaignClone {
  /**
   * The steps of a plan that recreates the source campaign under the new name, read through `call` (the ordinary
   * account-scoped native reads), with the fields it did not copy and what the source holds; refuses a source it
   * cannot clone.
   */
  build(call: ToolCall, actor: Actor, input: JsonObject): Promise<ClonedCampaign>;
  /**
   * The one all-or-nothing build a clone becomes unless the caller asks for step-by-step (`atomic: false`), which
   * also lifts the 50-step plan limit (Google's atomic build, src/campaign-runner.ts); without it a clone is steps.
   */
  allOrNothing?(steps: JsonObject[], accountId: unknown): JsonObject;
}
/** A clone's plan steps, the source fields not copied (by step), and what the source holds. */
export interface ClonedCampaign {
  steps: JsonObject[];
  notCopied: JsonObject[];
  source: JsonObject;
}

/** A state read of a path of the write's account, built as the review builds every state read (src/write-snapshots.ts). */
export type StateReadBuilder = (
  path: string,
  query?: JsonObject,
  body?: JsonObject,
  method?: string,
) => CompiledRequest;
/** A mutation's response and request as the outcome stage reads them (src/write-outcome.ts confirmedMutationResult). */
export interface MutationResponse {
  /** The response data, an object or empty. */
  readonly data: JsonObject;
  /** The request body, an object or empty. */
  readonly body: JsonObject;
  /** The request path's segments, and its last one. */
  readonly segments: string[];
  readonly last: string;
  /** A non-empty string or a safe integer: a native ID. */
  hasId(value: unknown): boolean;
}
/** What the review gives a provider that reads part of a write's state itself: the review's services and access check. */
export interface ReviewStateContext {
  readonly store: Store;
  readonly transport: NativeTransport;
  readonly credentials: CredentialProvider;
  readonly actor: Actor;
  /** The review's access check (actor, deployment, grants, the write's scope), run again; it returns the connection. */
  readonly access: () => Connection;
}
/** What the review gives a provider whose write changes other accounts while it reads state (Apple's shared budget). */
export interface SharedAccountContext {
  /** Binds another account to the review's connection with its write grant, or refuses. */
  bind(account: string): void;
  /** The review's reads, in order; the provider may append reads. */
  readonly reads: CompiledRequest[];
}
/**
 * A provider's parts of the reviewed write lifecycle (ARC-01 phase B, wave 4c: src/write-review.ts named the provider
 * at each). The review keeps the actor, deployment, role and account-grant checks, ScopeGuard, the family hooks, every
 * read's authority checks, the state hash, the spending policy, the approvals, the claim and the single send, in their
 * order; a provider answers only where the review asked about it, for its own writes (and reads, where so marked).
 */
export interface WriteReviewHooks {
  // The review's access check (WriteReviewService.access), in its order.
  /** The other accounts the write changes (Apple's shared budget): each is bound to the connection with its grant. */
  sharedAccounts?(plan: CompiledRequest): string[];
  /** The connection's write scopes, before the family's scope check (Reddit's adsread and adsedit); refuses. */
  writeScopes?(connection: Connection): void;
  /** The connection's write grant, after the family's scope check (Microsoft's msads.manage); refuses. */
  writeGrant?(connection: Connection): void;
  /** The write permission the provider requires, after ScopeGuard (Search Console, GA4, Apple, Tag Manager); refuses. */
  writePermission?(plan: CompiledRequest, connection: Connection): void;
  // The review's state reads (src/write-snapshots.ts snapshotPlans), after a family's own, in its order.
  /**
   * The state reads of a write no family plans, built with `read` (X's targeting criteria, Google Ads' mutations,
   * TikTok's campaign writes, Meta's account-edge creations and node edits, Snapchat's updates and patches); undefined
   * leaves the write to the review's generic reads. Refuses a write whose state it cannot read.
   */
  snapshots?(plan: CompiledRequest, read: StateReadBuilder): CompiledRequest[] | undefined;
  /** Where a path names the write's account (Snapchat's, X's, LinkedIn's, DV360's): a create on it reads the account. */
  readonly accountPath?: RegExp;
  /**
   * The reads of a create by the account its path names (undefined outside one), before the review's generic account
   * read (Snapchat's: a create outside an account, an account create's dependencies); undefined for the generic.
   */
  accountSnapshots?(
    plan: CompiledRequest,
    read: StateReadBuilder,
    account: string | undefined,
  ): CompiledRequest[] | undefined;
  // The review's state (WriteReviewService.state), in its order.
  /** A write whose state is its first read and what the provider reads itself (a Meta creative's identity). */
  readonly ownState?: {
    claims(plan: CompiledRequest): boolean;
    state(plan: CompiledRequest, context: ReviewStateContext): Promise<unknown>;
  };
  /** After each read of this provider's: ScopeGuard learns ownership from it (Snapchat). */
  readonly observeState?: true;
  /** After each read: the reads it shows the write depends on, before the paused parent's (Snapchat's lead forms). */
  dependentReads?(plan: CompiledRequest, read: CompiledRequest, data: unknown): CompiledRequest[];
  /** After each read of this provider's, after the paused parent's: the rest of its pages (TikTok's Instant Forms). */
  morePages?(read: CompiledRequest, data: unknown): CompiledRequest[];
  /** After each read: the accounts of a shared budget it shows, bound and read too (Apple). */
  sharedState?(plan: CompiledRequest, read: CompiledRequest, data: unknown, context: SharedAccountContext): void;
  /** After every read and the family's prerequisites, before the paused-parent check: the provider's (refuses). */
  prerequisites?(plan: CompiledRequest, values: unknown[], reads: CompiledRequest[]): void;
  /** After the paused-parent check (Meta's ad set audience choice, X's paused line item); refuses. */
  parentChecks?(plan: CompiledRequest, values: unknown[]): void;
  // The review's spending acknowledgement (src/preflight.ts spendConfirmationError), after its structural checks.
  /**
   * Whether a write creates only children that the review's state reads as under a PAUSED parent, so that nothing it creates can serve and
   * it needs no spend_change_confirmed (Google Ads, the owner's decision of 2026-11-19, R2.5 field fix r25-field-pausedspend: Q14's principle
   * for TikTok's creates and Q26's for X's promotions under a paused parent). Asked only when the review's state is given: at prepare, and
   * at execute with the state the review froze and, once the state check has passed, the one it read again. With no state (inspect, the
   * effect class of a bare plan, a plan's local compile) it is not asked, and the write asks as it always did. It only ever removes the
   * acknowledgement of a create the state shows cannot serve, never adds one, and answers false for anything it cannot read.
   */
  pausedChildCreation?(plan: CompiledRequest, state: readonly unknown[]): boolean;
  // The review's disclosures (src/write-effects.ts, src/write-impact.ts), after a family's own.
  /** Whether a write makes a change live for everyone once executed (Tag Manager, Search Console, Business Profile). */
  publishesLive?(plan: CompiledRequest): boolean;
  /** How many records a write lists where one request writes several (Snapchat's record lists); undefined for one. */
  recordCount?(body: JsonObject, kind: string): number | undefined;
  /**
   * What a write does, for the one-line summary the person approving it reads (src/review-summary.ts, R2.5 S2-2): a create,
   * an update or a delete, with how many entities it writes and what one is called where the path does not say. It answers
   * from how the provider builds its URLs (Graph's edges and nodes, Rest.li's collections and entities, a custom method
   * after a colon, a POST that always creates), for the writes its review accepts (a registered family's or its own entity
   * writes) and after the family's own `operation`; a write it cannot read, undefined, is left to the summary's path rules.
   */
  operation?(plan: CompiledRequest): DeclaredOperation | undefined;
  /** A write the provider documents as a deletion on a route that is not one (TikTok's status update to DELETE). */
  deletes?(plan: CompiledRequest): boolean;
  /**
   * What a write changes beyond its target (Snapchat's creative edits and segment replacements, Meta's creative
   * choices), or undefined; refuses a replacement that would reset what it omits.
   */
  impact?(plan: CompiledRequest, state: unknown[]): JsonObject | undefined;
  // A long request's parts under one approval (src/write-groups.ts splittableBatch).
  /**
   * The record list a request's payload is split along into parts of 25 under one approval (Google Ads' operations,
   * unless temporary resource IDs link them; Snapchat's one record list); undefined when it is not one AMCP splits.
   */
  batch?(payload: JsonObject): {key: string; items: unknown[]} | undefined;
  // The outcome of the one mutation (src/write-outcome.ts writeOutcome), after a family's own.
  /**
   * Whether a top-level response field that names errors holds none under the provider's contract (Microsoft's
   * batch PartialErrors and NestedPartialErrors whose slots are all null, aligned with the request's items).
   */
  emptyErrors?(key: string, value: unknown): boolean;
  /**
   * Whether the response confirms every mutation under the provider's response contract (Meta, Google Ads, TikTok,
   * Snapchat, LinkedIn, X, DV360), given the response and request as the stage reads them; a write of a provider
   * without one is never confirmed.
   */
  confirms?(plan: CompiledRequest, result: TransportResult, response: MutationResponse): boolean;
  /** What an outcome shows of the response data and its failures (Tag Manager's safe configuration). */
  outcomeData?(value: unknown): unknown;
  // The review's preparation and execution (prepareReview, submit).
  /**
   * The body of a create with a deduplication key of the provider's own set, frozen into the request as its review is prepared:
   * covered by the review's fingerprint and sent exactly at execute. A new object, never the caller's payload; undefined where the
   * route takes no key or the caller supplied one. **No provider declares it** (R2.5 M2, the lead's review S1-1). The first version
   * of TikTok's derived a key from each review, and TikTok's create pages say that a different `request_id` is how a second object
   * of the same name is created, and that a key de-duplicates only within 10 seconds, which a review sent once never uses: a key
   * that is new for every review switches off the provider's own same-name refusal across reviews. The seam stays for a decision
   * after the live check LV-10, which should derive any key from the identity of the object (advertiser, route, name, parent) and
   * never from the review, so that every review of one object sends one key; until then a declaration fails
   * tests/tiktok-request-id.test.mjs and the exact hook lists of tests/provider-review-hooks.test.mjs.
   */
  dedupeBody?(plan: CompiledRequest, reviewId: string): JsonObject | undefined;
  /** The request as a review shows and returns it (Business Profile's place-action links made safe); itself without. */
  shownRequest?(plan: CompiledRequest): unknown;
  /** The concurrency token a route takes from the state, unless its family owns it (Tag Manager's fingerprint). */
  concurrency?(plan: CompiledRequest, state: unknown[], routes: readonly VendorRoute[]): void;
  /** The provider's resources the state names, each owned by the account (Snapchat's creative references); refuses. */
  ownedReferences?(plan: CompiledRequest, state: unknown[], owns: (resource: string) => boolean): void;
  /**
   * The ads a creative edit changes (Snapchat), read through the review's guarded reader with reads `stateRead` builds
   * (src/write-snapshots.ts, passed in so that no adapter imports a lifecycle module); a provider failure of the read
   * leaves them unknown, an authority failure refuses.
   */
  affectedAds?(
    plan: CompiledRequest,
    creativeIds: unknown[],
    read: (request: CompiledRequest) => Promise<TransportResult>,
    stateRead: (plan: CompiledRequest, path: string, query?: JsonObject) => CompiledRequest,
  ): Promise<JsonObject>;
  // The rejected outcome of a refusal after dispatch (src/write-rejection.ts nonAppliedRejection), after a family's own.
  /**
   * Whether a definitive refusal (its HTTP status and the provider's error body) of a dispatched write provably applied
   * nothing under the provider's contract (Google Ads' per-service and googleAds:mutate requests without partial
   * failure or validate-only); without one, the refusal stays uncertain.
   */
  rejectionIsNonApplied?(plan: CompiledRequest, status: number, body: JsonObject): boolean;
  // The verification of a completed write (src/write-verification.ts WriteVerifier.verify), after the review's.
  /**
   * The phase a consistent verification read shows of what the write started (GA4's provider jobs: a report task or
   * audience export still running is pending, a failed one failed); verified without one.
   */
  verificationPhase?(read: CompiledRequest, state: JsonObject): 'verified' | 'pending' | 'failed';
  // The read-only reconciliation of an uncertain write (src/write-reconciliation.ts WriteReconciler).
  /**
   * The lookup that finds what a create made (Google Ads' named campaigns, budgets, ad groups and asset groups by their
   * frozen names; Meta's campaign, ad set and ad creates by name and creation time; TikTok's campaign, ad group and ad by
   * name, parent and creation window), its reads built with `read` as the review builds every state read; undefined for a
   * write it cannot look up. `context` is what the review froze (its state) and when the write was claimed.
   */
  createdLookup?(
    plan: CompiledRequest,
    read: StateReadBuilder,
    context?: CreatedLookupContext,
  ): CreatedLookup | undefined;
  /**
   * The receipt the provider would have returned for an update or removal whose targets the request names (Google
   * Ads' operations' resource names, a Meta node edit's ID), so the verification reads name what to read and expect;
   * undefined for a create and for a request that names none.
   */
  namedTargets?(plan: CompiledRequest): JsonObject | undefined;
  // The owner's spending policy (src/spend-policy.ts), which keeps every rule, its order and its refusals (wave 4c).
  /** The refusal of a cap stated in currency that the provider's own unit cannot convert (Meta's currency offsets). */
  currencyCapRefusal?(field: string, nativeField: string, currency: string | null | undefined): MirrorError;
  /**
   * The owner policy's activation and deletion switches applied to the access a write grants or removes (Business
   * Profile's administrators, Google Ads' users), before a family's policy requirement; refuses.
   */
  accessPolicy?(plan: CompiledRequest, state: unknown, policy: JsonObject): void;
  /** The field a route spells activation with where it is not the provider's declared one (LinkedIn's creatives). */
  activationRule?(plan: CompiledRequest): {field: string; active: string[]} | undefined;
  /** The reviewed state whose amounts are the write's current ones (Apple's shared budget: its value alone). */
  policyState?(plan: CompiledRequest, state: unknown): unknown;
  /**
   * Money fields the provider's pinned contract classifies (Google Ads' Discovery document): bids, which join the bid
   * cap, and money that is neither a bid nor a measured budget, unsupported under a numeric policy.
   */
  moneyFields?(): {bid: string[]; unsupported: string[]};
}
/** What a review froze that a lookup may compare against: the state it kept at prepare, and when the write was claimed. */
export interface CreatedLookupContext {
  /** The review's state, the normalized snapshots of its reads in order (what existed under the parent at prepare). */
  state: unknown[];
  /** When the write was claimed (ms): a created resource carries a creation time after it. */
  claimedAt: number;
  /** What the review saw of the lookup's objects before the write (`CreatedLookup.existing`), where its provider freezes it. */
  existing?: {ids: string[]; whole: boolean};
}
/** What a provider's lookup of a create returns: the created resources it found, in the order of the request's records. */
export interface CreatedLookup {
  reads: CompiledRequest[];
  /**
   * The reads that follow the responses so far, where a list is longer than its page (R2.5 M2: Meta's lists): the next page
   * of each list whose last answer names one, and none once every list is whole. Asked after each batch of reads, for at most
   * ten batches (src/write-reconciliation.ts); `match` then gets every response in the order they were read.
   */
  more?(responses: TransportResult[]): CompiledRequest[];
  /**
   * What this create looks for, one key per record (R2.5 M2, lead re-review N2): the kind of object, the parent it is created under
   * and its name as this lookup compares names (`lookupKey` in src/created-agreement.ts). Two creates whose keys meet could not be told
   * apart by their lookups, so an unresolved one holds the other back (src/write-duplicates.ts) even when their requests differ in a
   * field the provider does not echo. Undefined where the lookup compares by shape or by deterministic names.
   */
  keys?: string[];
  /**
   * What the lookup's reads see before the write (R2.5 M2, lead re-review N3), read at prepare and frozen with the review: the IDs of the
   * objects it would count as this write's, and whether the answer was whole. A provider whose objects carry no creation time and refuses a
   * duplicate name (Google Ads) implements it, because an older object of the name is then exactly why such a create fails; `match` leaves
   * those objects out, and shows every match as a doubt where the list was not whole. Undefined where the provider dates its objects.
   */
  existing?(responses: TransportResult[]): {ids: string[]; whole: boolean};
  /**
   * Matches the responses of `reads` to the request's records; `complete` when the lookup saw everything it asked.
   * `found` are the resources of the frozen name and parent that the lookup can show were created by this write, each
   * with the `index` of its record. `undated` (R2.5 M2) are resources of that name and parent that it cannot tell from
   * older ones (no creation time, or one it cannot read against the window): they are never counted as created and never
   * as proof of absence, so the answer stays indeterminate with their IDs shown.
   */
  match(
    responses: TransportResult[],
    submittedAt: number,
    /**
     * When the responses were read (default now). A provider that cannot date an object (Meta's product sets and feeds, which
     * carry no creation time) counts a new one of the name as this write's only while that is within the window after the claim
     * (R2.5 M2, lead review S3-2); a later one is a doubt (`undated`).
     */
    checkedAt?: number,
  ): {found: JsonObject[]; expected: number; complete: boolean; undated?: JsonObject[]};
  /** The receipt a provider would have returned for these resources (what a plan's later steps reference). */
  receipt(found: JsonObject[]): JsonObject;
}

// Wave 4c round 6 (w4c-arc6-versions): a provider's API version, tool notes, catalog listing, provider jobs outside
// the reviewed families, owner setting and legacy alias names, which shared modules ask its hooks for instead of
// importing its modules (ARC-01).

/** A version AMCP reviewed, with the first month or day it is no longer sent (LinkedIn's version table). */
export interface ReviewedVersion {
  readonly version: string;
  readonly sunset: string;
  readonly basis: 'official' | 'policy';
  /** The day the provider's changes were read for what AMCP sends and reads. */
  readonly reviewed: string;
}

/**
 * A provider's API version as AMCP sends it (ProviderHooks.versions). Each answer is its version module's own value
 * or function (src/<provider>-version.ts), which keeps every rule: the environment it reads and when, the reviewed
 * versions and the refusals.
 */
export interface ProviderVersions {
  /** The version a listing, description or contract names; it never throws (LinkedIn: the reviewed default then). */
  current(): string;
  /** A request path at the version sent: path('/customers/') for Google Ads, path('/') for Meta's prefix. */
  path?(rest: string): string;
  /** The request header that carries the version (LinkedIn-Version): a contract names the version a plan sent there. */
  readonly header?: string;
  /**
   * The version a request sends: an explicit one (a call's api_version), else the configured one, else the default;
   * an unreviewed or sunset version is refused.
   */
  request?(explicit?: unknown, now?: number): string;
  /** A stored request's version (a saved report's or source's) as AMCP sends it now. */
  stored?(stored: unknown, now?: number): string;
  /** The versions AMCP reviewed, each with its sunset. */
  readonly reviewed?: readonly ReviewedVersion[];
  /** Every version its configuration may name (AMCP_META_API_VERSION), each one the sunset registry must record. */
  readonly configurable?: readonly string[];
  /** The owner-operations view of its version configuration: the version sent, the override and the alarm. */
  status?(now?: number, configured?: string): JsonObject;
  /** The warning its deployment configuration earns (a Google developer token AMCP no longer sends), or undefined. */
  warning?(env?: NodeJS.ProcessEnv): string | undefined;
  /** The URL of one of its guides at the version sent. */
  docs?(page: string): string;
}

/**
 * What tools/list and amcp_tool_help say of a provider's gateway beyond its captured text (MCP-10), which
 * src/tool-notes.ts composes, in its order and with AMCP's own sentences.
 */
export interface ToolNotes {
  /**
   * AMCP's description where the captured one names a tool, provider, version or behaviour AMCP does not have, or a
   * function correcting named sentences of a long captured one and keeping the rest.
   */
  readonly description?: string | ((captured: string) => string);
  /** The description ends with AMCP's routing sentence: which AMCP tools launch, change, upload and report. */
  readonly routing?: true;
  /** The description ends by saying the provider is connected on the AMCP website. */
  readonly connectedOnWebsite?: true;
  /** What tools/list shows of a gateway whose whole description is long; amcp_tool_help {gateway} has the rest. */
  readonly summary?: string;
  /** Its catalog holds no action AMCP can run, so it has no AMCP note (tests hold this equal to the contracts ledger). */
  readonly withoutExecutableActions?: true;
  /** An operation-mode gateway whose catalog has write actions: its note says a write is previewed or refused. */
  readonly delegatedWrites?: true;
  /** The note's last sentence: the version AMCP sends where the captured action names another. */
  readonly version?: string;
}

/** A provider's part of LIST_ACTIONS and DESCRIBE_ACTION; src/introspection.ts keeps the filters, bounds and envelope. */
export interface CatalogListing {
  /** DESCRIBE_ACTION's answer for an action the provider describes itself (Meta's ad label read), or undefined. */
  describe?(action: Action): JsonObject | undefined;
  /** LIST_ACTIONS' page size when neither the call nor the schema names one (50 without). */
  readonly defaultLimit?: number;
  /**
   * Its native listing pages by `cursor` and answers {actions, total, returned, next_cursor} unless the catalog
   * envelope is on (Snapchat).
   */
  readonly cursorPages?: true;
  /** What its listing adds about its whole catalog (Google Ads' RPC and legacy action counts). */
  totals?(actions: readonly Action[]): JsonObject;
}

/** A provider's jobs that no reviewed family declares (the effect taxonomy, src/effect-class.ts). */
export interface ProviderJobHooks {
  /** A request compiled as a read that submits a provider job (Microsoft's report submission). */
  submission?(plan: CompiledRequest): boolean;
}

/**
 * A setting the owner keeps for a provider per workspace (GA4's realtime test properties, MSR-04): owner health lists
 * it under `field`, in the place src/owner-operations.ts gives it, and the owner operation `action` saves one.
 */
export interface OwnerSetting {
  readonly field: string;
  readonly action: string;
  list(store: Store, tenant: string): JsonObject[];
  /** Saves one with its checks and audit record; the owner operation's answer. */
  save(store: Store, actor: Actor, input: JsonObject): JsonObject;
}

// Wave 4c round 6 (w4c-arc6-tables): the provider rows of the shared tables (ProviderHooks, above). A row is frozen
// where its provider declares it; the shared module that lists it copies it into the plain table it exports.

/** A captured operation AMCP lists but cannot run, as its provider declares it (src/unavailable-operations.ts). */
export interface UnavailableOperationFacts {
  /** The operation's actions that cannot run; absent when none of them can. */
  readonly actions?: readonly string[];
  readonly reason: string;
  readonly alternatives: readonly Alternative[];
}
/** A connection operation (Analytics, Search Console, Business Profile): its OAuth steps run on the website. */
export interface ConnectionOperation {
  readonly operation: string;
  /** The provider's name in the refusal of those steps (src/unavailable-operations.ts). */
  readonly provider: string;
  /** Its retired Q&A operation, whose status the diagnostics answer locally (Business Profile). */
  readonly qanda?: string;
}
/** A discovery-only program as its provider declares it; src/discovery-programs.ts adds what every entry says. */
export interface DiscoveryProgramFacts {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly prerequisites: readonly {readonly id: string; readonly text: string}[];
  readonly program: {readonly access: string; readonly reference: string; readonly checked_on: string};
  readonly unlocks: readonly string[];
  readonly withheld_actions: readonly string[];
  /** Why the withheld actions wait on the program (the refusal of each of them, src/withheld-writes.ts). */
  readonly withheld_reason?: string;
  readonly personal_data?: string;
}
/**
 * A provider's top-level parameters (src/parameters.ts). The shared checks keep every rule and their order; these name
 * what differs by provider. A `fields` list sent as one value is CompileHooks.joinedFields.
 */
export interface ParameterFacts {
  /** Its account scope aliases, in the order the compiler reads them. */
  readonly accountAliases?: readonly string[];
  /** Its platform routing controls: top-level parameters its compiler routes, or refuses explicitly. */
  readonly platformControls?: readonly string[];
  /** Why a captured action refuses a platform control it does not route, after "is not routed by this action." */
  readonly controlRefusal?: string;
  /** Its direct compiler accepts a JSON-encoded native body (src/parameters.ts encodedBodyGateways). */
  readonly encodedBody?: true;
  /** Every action takes the native `fields` parameter (Meta's Graph API). */
  readonly everyActionFields?: true;
  /** Its actions whose path matches take a native `limit` (Snapchat's stats and reports). */
  readonly nativeLimit?: RegExp;
  /**
   * A parameter that takes one value only, refused otherwise (LinkedIn's JSON body format). The provider constructs the
   * refusal, so its reason stays a literal the localization inventory owns (tools/check-locales.mjs).
   */
  readonly onlyValue?: {readonly parameter: string; readonly value: string; refusal(parameter: string): MirrorError};
  /** Parameters dropped while another is true (X's offset and limit of a report download). */
  readonly droppedWhile?: {readonly parameter: string; readonly dropped: readonly string[]};
}
/** A provider job family and what it guarantees (src/provider-jobs.ts providerJobContracts). */
export interface ProviderJobFacts {
  readonly family: string;
  readonly kind: 'report' | 'export' | 'change_log';
  readonly admission: string;
  readonly lost_response: string;
  readonly retrieval: string;
  /** The reporting pipeline's jobs (Microsoft's): no reviewed family creates them, so no report-job grant applies. */
  readonly pipeline?: true;
}
/**
 * A provider's validation of a mutation (src/provider-validation.ts, WRT-06): the request that has the provider check it
 * without applying it, and what the provider's refusal says. The shared module keeps who may send it, the audit, the
 * classification of the reply and every refusal of its own.
 */
export interface ProviderValidation {
  /**
   * Set when a prepare of this provider's writes validates by default, in a deployment whose policy turns that on
   * (`ExecutionPolicy.providerCheckByDefault`, R2.5 M3, L2-12; the call's `provider_check: false` opts out). Google Ads
   * declares it; Meta, whose validation counts against its rate limits, stays opt-in.
   */
  readonly byDefault?: true;
  /** The validation request of `plan`, or undefined when its route has no qualified validation path. */
  request(plan: CompiledRequest): CompiledRequest | undefined;
  /** The request fields a refusal names, in its order: `error` is the reply's error, or the reply, of any type. */
  fieldPaths(error: JsonObject): string[];
  /** A reply under 300 that still refuses the request (Meta's `success: false`). */
  unsuccessful?(data: JsonObject): boolean;
  /** Its refusal of a request before it is checked (Meta's caller-set execution_options), or undefined. */
  refusal?(plan: CompiledRequest): MirrorError | undefined;
}
/**
 * A provider's withdrawn methods and unsupported aliases (src/retired-provider-actions.ts), which AMCP refuses and never
 * executes, whatever a historical catalog or Discovery mapping says. A withdrawn method's refusal says why, what to use
 * instead and when the withdrawal was checked: its row's own words, or else the provider's below (checked at load).
 */
export interface RetiredActions {
  readonly actions?: readonly RetiredActionFacts[];
  readonly aliases?: readonly UnsupportedAliasFacts[];
  readonly checked?: string;
  readonly reason?: string;
  readonly replacement?: string;
}
/** A withdrawn method, matched by its method and path. */
export interface RetiredActionFacts {
  readonly action: string;
  readonly method: string;
  /** Never global or sticky, so it keeps no position between requests. */
  readonly path: RegExp;
  readonly source: string;
  /** When the provider's documentation recorded the withdrawal. */
  readonly updated: string;
  readonly checked?: string;
  readonly reason?: string;
  readonly replacement?: string;
}
/** A legacy action name that matches no operation of the provider's current version; the alias is matched, not its route. */
export interface UnsupportedAliasFacts {
  readonly action: string;
  readonly version: string;
  readonly source: string;
  readonly checked_at: string;
  readonly reason: string;
  readonly replacement: string;
}
/**
 * The pinned vendor contract a provider's requests are checked against (src/wire-contracts.ts, PRV-05): exactly one of
 * these kinds, checked at load. The wire contracts keep the modes, the seals, the checks and every refusal.
 */
export interface WireContractFacts {
  /** Its routes' request schemas in generated/vendor-routes.json, resolved in their pinned Discovery documents. */
  readonly routes?: {readonly label: string};
  /**
   * The pinned Discovery document whose one method with the request's verb and path is its contract; a path under
   * `uploads` is a multipart upload with its own contract (src/transport.ts) and is not checked.
   */
  readonly discovery?: {readonly document: string; readonly label: string; readonly uploads: string};
  /** Its own contract model, which resolves a request's contract (Microsoft's WSDL types). */
  model?(plan: CompiledRequest): Resolved | undefined;
  /** Its Data Manager routes (Google Ads): their origin, the pinned document and its method of each action. */
  readonly dataManager?: {
    readonly origin: string;
    readonly document: string;
    readonly label: string;
    readonly methods: Readonly<Record<string, string>>;
  };
}

// ---- Wave 4c round 6 (w4c-arc6-workspace) ----

/** A provider's parts of AMCP's generic workflows of amcp_native_action (src/workflows.ts). */
export interface GenericWorkflowHooks {
  /** The time a stats read's range takes for an instant in milliseconds (X: whole UTC hours); refuses any other. */
  statsTime(ms: number): string;
}

/**
 * A child create a paused parent covers (the owner's decision of 2026-09-29, src/paused-parents.ts): what the refusal
 * calls the child and its parent, the status field with its serving and paused values, the statuses the create
 * carries, the parent's record in the review's state, and for an ad the campaign above its parent.
 */
export interface PausedParentLevel {
  /** What the refusal calls the child and its parent. */
  child: string;
  parent: string;
  /** The status field, its serving value, and the parents' paused value. */
  field: string;
  active: string;
  paused: string;
  statuses: (body: JsonObject) => unknown[];
  /** The parent's record in the review's state, or in the parent read's own result. */
  parentRow: (body: JsonObject, states: unknown[]) => JsonObject | undefined;
  /** For an ad: the campaign above its parent, the read that returns it, and its record in the state. */
  campaign?: {
    id: (parent: JsonObject) => unknown;
    read: (parentRead: CompiledRequest, id: string) => CompiledRequest;
    row: (states: unknown[], id: unknown) => JsonObject | undefined;
  };
}

/** What a resumable media transfer is bound to: the reviewed account, connection, owner and file. */
export interface MediaTransferBinding {
  account_id: string;
  connection_id: string;
  owner_urn?: string;
  sha256: string;
  size: number;
}

/**
 * A provider's steps of AMCP's reviewed media upload (src/media-upload.ts: LinkedIn's), which the upload calls where it
 * named the provider's modules; it keeps every other step, check and refusal of its own.
 */
export interface MediaUploadHooks {
  /** Refuses an organization owner that is not bound to the selected account and connection. */
  assertOrganization(connection: Connection, account: string, owner: string): void;
  /** The encrypted receipt of a new resumable video transfer, derived on the server, never taken from MCP arguments. */
  transfer(
    binding: MediaTransferBinding,
    auth: Credentials,
    scopes: string[],
    id: string,
    value: JsonObject,
    instructions: JsonObject[],
  ): JsonObject;
  /** Why a recorded transfer cannot resume safely, or undefined when it can. */
  resumeReason(
    binding: MediaTransferBinding,
    session: JsonObject | undefined,
    auth?: Credentials,
    scopes?: string[],
  ): string | undefined;
  /** Refuses a recorded transfer that cannot resume safely (RECOVERY_NOT_SAFE). */
  assertResume(
    binding: MediaTransferBinding,
    session: JsonObject | undefined,
    auth?: Credentials,
    scopes?: string[],
  ): void;
  /** Refuses the provider's record of a retained upload that is not this one, still waiting for its parts. */
  assertWaiting(binding: MediaTransferBinding, session: JsonObject, response: unknown): void;
  /** Whether an uploaded part's receipt is a well-formed part identifier. */
  partId(value: unknown): value is string;
}

// Wave 4c round 6 (w4c-arc6-catalog): the catalog destinations (COM-03) the providers fill.
/**
 * A provider's catalog destination (COM-03), a fact of its adapter that src/catalog-destinations.ts lists: what a
 * supplied product source may carry, its item identity and how product changes reach the destination.
 */
export interface CatalogDestinationFacts {
  /** Source columns a product may carry; required first. Unknown columns are refused. */
  readonly sourceFields: {required: readonly string[]; optional: readonly string[]};
  /** The destination's native catalog ID. */
  readonly catalogId: RegExp;
  /**
   * Item identity: the source's retailer_id names a product, and `native` is the destination's own key of that product
   * in a comparison item's product_id (Meta's product ID, X's product key, Snapchat's product ID, which is the
   * retailer_id itself).
   */
  readonly identity: {source: 'retailer_id'; native: 'product_id' | 'product_key' | 'retailer_id'; pattern: RegExp};
  /**
   * How product changes reach the destination: one reviewed native step per product, each with its own receipt and
   * read-back (`reviewed_steps`), or only through the destination's own product feeds (`feed_only`: a comparison names
   * what to fix in the feed and no draft is saved).
   */
  readonly writes: 'reviewed_steps' | 'feed_only';
  /** How an existing retailer ID is treated: Meta asks for an explicit choice, X always updates matching IDs. */
  readonly upsert: 'explicit_choice' | 'required' | 'none';
  /**
   * Explicit removal intent the destination supports: a non-destructive retirement of supplied products through the
   * reviewed update (`retire`), also an explicit deletion of selected individual products by native key
   * (`retire_and_selected_deletion`), or nothing (`none`). Absence from a source never selects anything.
   */
  readonly removal: 'retire' | 'retire_and_selected_deletion' | 'none';
  /**
   * What a populated attribute the source does not send means for the comparison (P9's first question): `review` puts
   * an otherwise matching product in the review set as `unknown` (owner decision P9 of 2026-10-11, which names Meta),
   * and `note` names it in `unsent_fields` without changing the state (COM-01's reading, kept for X, whose native
   * review warns of such values, and for feed-only Snapchat). Either way `unsent_fields` names the attributes
   * (docs/DECISIONS.md).
   */
  readonly destinationOnlyValues: 'review' | 'note';
  /**
   * The destination whose comparison answers a gateway that is no catalog destination, which keeps the refusal it had
   * before the destination contract (Meta's). Exactly one destination is the fallback.
   */
  readonly fallback?: true;
  /** The retailer ID one of its reviewed product steps writes, read from the step's payload (src/catalog-retirement.ts). */
  stepRetailerId?(payload: JsonObject | undefined): unknown;
}
/** The native usage a library asset offers (ProviderHooks.mediaUsage), which its asset view states. */
export interface MediaUsage {
  /** Whether the provider's reader can read the asset's current native usage. */
  readonly supported: boolean;
  /** The usage kind of that reader (src/provider-workflows.ts assetUsageReader). */
  readonly kind: string;
  /** The native views it reads, when it names them. */
  readonly views?: readonly string[];
}
/**
 * A conditional program (CON-04): the one exact read that qualifies a provider's private product or access, with its
 * prerequisites, refusals and setup, as capabilities lists it. A type rather than an interface, so it is a JsonObject.
 */
export type ConditionalProgram = {
  id: string;
  kind: string;
  mode: string;
  name: string;
  gateway: string;
  objective: string;
  description: string;
  effects: string;
  effect_details: string;
  required_inputs: string[];
  prerequisite_ids: string[];
  actions: string[];
  recorded_scopes: string[];
  program: {access: string; reference: string; checked_on: string; limitations: string};
  /** The provider's documented refusal codes, each naming the prerequisite it reports. */
  documented_refusals?: Record<string, {prerequisite_id: string; owner_action: string; resolution: string}>;
  undocumented_refusal: {kind: string; text: string};
  account_setup: {text: string; prerequisites: {id: string; text: string}[]};
  next_call: JsonObject;
  website_path: string;
  source: string;
};
/** A conditional program's provider steps, which its check (src/conditional-programs.ts) takes in its own order. */
export interface ConditionalProgramSteps {
  /** The JSON Schema of its requirements, the ad account fixed when given; without one it takes no requirements. */
  readonly template?: (account?: string) => JsonObject;
  /** What a local inspection's next call adds for the live read. */
  readonly liveArguments?: () => JsonObject;
  /** The live read's native call from its requirements, which it refuses in its own order. */
  readonly request: (program: ConditionalProgram, requirements: JsonObject, account: string) => JsonObject;
  /** The evidence a live read keeps of the native data, refusing what it cannot retain; `rows` counts what it keeps. */
  readonly evidence: (
    program: ConditionalProgram,
    data: JsonObject,
    requirements: JsonObject,
    account: string,
    rows: (kind: string, count: number) => void,
  ) => JsonObject;
}
/** A provider's conditional program with its check's steps (ProviderHooks.conditionalPrograms). */
export interface ProviderConditionalProgram {
  readonly program: ConditionalProgram;
  readonly steps: ConditionalProgramSteps;
}

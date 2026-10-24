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
// Writes and campaigns (wave 4c): what the review gives a provider's own state read.
import type {Actor} from './types.js';
import type {NativeTransport} from './transport.js';
import type {CredentialProvider} from './auth.js';
import type {VendorRoute} from './delegated-native.js';
// Writes and campaigns (wave 4c): the native calls a campaign clone reads its source through, and the service a plan's
// preflight reads through.
import type {ToolCall} from './workspace-core.js';
import type {MirrorService} from './service.js';

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
  /** Its guided campaign recipes (wave 4c, writes and campaigns). */
  readonly campaign?: CampaignHooks;
  /** Its parts of the reviewed write lifecycle (wave 4c, writes and campaigns). */
  readonly writes?: WriteReviewHooks;
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
  // The review's disclosures (src/write-effects.ts, src/write-impact.ts), after a family's own.
  /** Whether a write makes a change live for everyone once executed (Tag Manager, Search Console, Business Profile). */
  publishesLive?(plan: CompiledRequest): boolean;
  /** How many records a write lists where one request writes several (Snapchat's record lists); undefined for one. */
  recordCount?(body: JsonObject, kind: string): number | undefined;
  /** A write the provider documents as a deletion on a route that is not one (TikTok's status update to DELETE). */
  deletes?(plan: CompiledRequest): boolean;
  /**
   * What a write changes beyond its target (Snapchat's creative edits and segment replacements, Meta's creative
   * choices), or undefined; refuses a replacement that would reset what it omits.
   */
  impact?(plan: CompiledRequest, state: unknown[]): JsonObject | undefined;
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
}

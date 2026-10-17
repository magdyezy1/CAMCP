/**
 * The gateway-level provider contract (ARC-01). The reviewed-family registry made each write family declare what the
 * review lifecycle needs from it; this contract does the same one level up, for a provider's gateway. A provider
 * supplies facts about itself, and the lifecycle, ScopeGuard and NativeTransport keep control: account binding, the
 * origin allowlist, single send, retries and the spend, confirmation and idempotency rules never move into an adapter.
 *
 * Concerns move into adapters one at a time (ARC-01 phase B), each with a call-replay proof that the provider requests
 * and authorization decisions are unchanged (tools/call-replay.mjs; docs/review/ARCHITECTURE.md, "Provider adapters").
 * Every adapter carries its lifecycle status and its facts (the account model, body deletions), which any module may
 * read; behaviour that needs a provider's own modules (read classification, paging, the account read) is its hooks,
 * declared in src/<provider>-adapter.ts and registered in src/provider-hooks.ts.
 */
import type {CompiledRequest, Connection, JsonObject} from './types.js';

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
   * account URNs): a global pattern whose first group is an account ID.
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
  /**
   * Authorizes a qualified read for the bound account: true when it is in scope, false to leave it to ScopeGuard's
   * other checks, or a refusal.
   */
  authorizeQualifiedRead?(plan: CompiledRequest, connection: Connection, account: string): boolean;
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
}

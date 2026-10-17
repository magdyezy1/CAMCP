/**
 * The gateway-level provider contract (ARC-01). The reviewed-family registry made each write family declare what the
 * review lifecycle needs from it; this contract does the same one level up, for a provider's gateway. A provider
 * supplies facts about itself, and the lifecycle, ScopeGuard and NativeTransport keep control: account binding, the
 * origin allowlist, single send, retries and the spend, confirmation and idempotency rules never move into an adapter.
 *
 * Concerns move into adapters one at a time (ARC-01 phase B), each with a call-replay proof that the provider requests
 * and authorization decisions are unchanged (tools/call-replay.mjs; docs/review/ARCHITECTURE.md, "Provider adapters").
 * Every adapter carries its lifecycle status and its facts (the account model, body deletions), which any module may
 * read; behaviour that needs a provider's own modules (read classification so far) is its hooks, declared in
 * src/<provider>-adapter.ts and registered in src/provider-hooks.ts.
 */
import type {CompiledRequest, Connection} from './types.js';

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
 * A provider's hooks (ARC-01 phase B): the parts of its adapter that call its own modules, declared in
 * src/<provider>-adapter.ts and registered in src/provider-hooks.ts. The facts any module may read are the
 * ProviderAdapter of the leaf registry; a hook only supplies a provider fact to the shared stage that asks for it.
 */
export interface ProviderHooks {
  /** The gateway of the provider adapter these hooks belong to. */
  readonly gateway: string;
  readonly reads?: ReadClassification;
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
}

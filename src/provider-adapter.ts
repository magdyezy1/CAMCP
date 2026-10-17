/**
 * The gateway-level provider contract (ARC-01). The reviewed-family registry made each write family declare what the
 * review lifecycle needs from it; this contract does the same one level up, for a provider's gateway. A provider
 * supplies facts about itself, and the lifecycle, ScopeGuard and NativeTransport keep control: account binding, the
 * origin allowlist, single send, retries and the spend, confirmation and idempotency rules never move into an adapter.
 *
 * Concerns move into adapters one at a time (ARC-01 phase B), each with a call-replay proof that the provider requests
 * and authorization decisions are unchanged (tools/call-replay.mjs; docs/review/ARCHITECTURE.md, "Provider adapters").
 * Every adapter carries its lifecycle status and its account model: the account ID form, where a request names the
 * account, and what a bound resource is.
 */

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
}

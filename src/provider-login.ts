/**
 * A provider's website login steps (ARC-01 phase B, the server discovery and OAuth configurations): the third part of
 * a provider's adapter, beside its facts (the leaf registry, src/provider-adapters.ts) and its hooks
 * (src/provider-hooks.ts, contract src/provider-adapter.ts). They are split by import layer again: only the website's
 * server consults them, so they live in src/<provider>-login.ts, registered in src/provider-logins.ts, which the
 * reviewed-write path never loads (the hooks are on that path, and the guidance coverage of
 * tools/guidance-coverage.ts holds its refusals).
 */
import type {CompiledRequest, Connection, Credentials, JsonObject} from './types.js';
import type {NativeTransport, TransportResult} from './transport.js';

/**
 * A provider's steps of the website's logins: its OAuth flow (server/platform-oauth.ts), the reads that list what a
 * login reaches (server/asset-discovery.ts) and the reads of a renewal that verifies a login's selected accounts
 * before it replaces the login (server/google-reauthorization.ts).
 */
export interface ProviderLogin {
  /** The gateway of the provider adapter these steps belong to. */
  readonly gateway: string;
  readonly oauth?: OAuthSteps;
  readonly discovery?: AssetDiscoveryHooks;
  readonly renewal?: RenewalSteps;
}

// The website's OAuth flows: PlatformOAuth (server/platform-oauth.ts) keeps the configuration check, the state, the
// PKCE verifier and challenge, the requested scopes and what the state records, the shared parameters of an
// authorization request, the client-change refusal, the code and the token request's form, every send (redirect:
// 'error' and a 15-second timeout), the bounded read of each response, every check of the tokens, the lifetimes, the
// credentials it saves and the recorded grant. A provider supplies its endpoints and the steps only it takes (X's OAuth
// 1.0a, TikTok's app ID and auth code, Meta's GET exchange and long-lived token, Reddit's Basic authentication and
// User-Agent, Microsoft's scope and developer token, Apple's client credentials, Google's offline access).

/** A provider request of the OAuth stage: the stage adds `redirect: 'error'` and its timeout, and sends it once. */
export interface OAuthRequestInit {
  method: string;
  headers?: Record<string, string>;
  body?: URLSearchParams | string;
}

/** What the OAuth stage gives a provider's step: the deployment's settings, the configured client and the stage's I/O. */
export interface OAuthContext {
  readonly env: NodeJS.ProcessEnv;
  readonly clientId?: string;
  readonly clientSecret?: string;
  /** The website's callback for this platform. */
  readonly redirectUri: string;
  /** Whether this deployment allows reviewed writes (X asks for write access only then). */
  readonly allowWrites: boolean;
  /** Sends one request through the stage's fetcher, with `redirect: 'error'` and the stage's timeout. */
  send(url: URL, init: OAuthRequestInit): Promise<Response>;
  /** The stage's bounded read of a provider's answer: OAUTH_EXCHANGE_FAILED, OAUTH_RESPONSE_INVALID. */
  readResponse(response: Response, format?: 'json' | 'form'): Promise<JsonObject>;
}

/** An authorization a provider starts its own way (X's request token): what the state keeps, and the URL's parameters. */
export interface OAuthBegun {
  readonly data: JsonObject;
  readonly parameters: Readonly<Record<string, string>>;
}

/** What the stage's code exchange returns (PlatformOAuth.exchange). */
export interface OAuthExchange {
  credentials: Credentials;
  label: string;
  scopes: string[];
  providerId?: string;
  /** The provider's display name for the user (Google, X), when it states one without another request (CON-05). */
  displayName?: string;
  loginExpiresAt?: number;
  grants?: JsonObject;
}

/** The token request of an authorization code: by default a POST of the stage's form to the token endpoint. */
export interface OAuthTokenRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: URLSearchParams | string;
}

/** A provider's OAuth flow: its endpoints, its facts about the shared steps, and the steps only it takes. */
export interface OAuthSteps {
  /** The authorization endpoint ('' for a provider without a browser authorization: Apple's client credentials). */
  readonly authorize: string;
  /** The token endpoint. */
  readonly token: string;
  /** Whether the provider's own server key stands in for a client secret (Apple's signed client assertion). */
  serviceKey?(env: NodeJS.ProcessEnv): boolean;
  /** A deployment setting without which the platform is not configured (Microsoft's developer token). */
  readonly requiredSetting?: string;
  /** The requested scopes are the provider's own: AMCP_<PLATFORM>_SCOPES does not replace them (Apple). */
  readonly fixedScopes?: true;
  /**
   * Connects with the server's own credentials, in place of a browser authorization (Apple's client credentials):
   * `configured` is the stage's configuration check, `scopes` the platform's, `fetcher` the stage's own (the
   * provider's token call keeps its own redirect and timeout rules).
   */
  connect?(
    context: OAuthContext & {
      readonly configured: boolean;
      readonly scopes: readonly string[];
      readonly fetcher: typeof fetch;
    },
  ): Promise<{credentials: Credentials; label: string; scopes: string[]}>;
  /**
   * Starts the authorization the provider's own way, in place of the authorization-code request (X's OAuth 1.0a
   * request token); `state` is the stage's.
   */
  begin?(context: OAuthContext & {readonly state: string}): Promise<OAuthBegun>;
  /** The state also keeps the OAuth client of a first authorization, which a later renewal compares (Google Ads). */
  readonly bindsClient?: true;
  /** The authorization parameter that names the client: `client_id` unless the provider names another (TikTok). */
  readonly clientParameter?: string;
  /** The parameter that carries the callback: `redirect_uri` unless the provider's setting chooses (TikTok); refuses. */
  redirectParameter?(env: NodeJS.ProcessEnv): string;
  /** The authorization request carries no `response_type=code` (TikTok). */
  readonly noResponseType?: true;
  /** What joins the requested scopes: a space unless the provider uses another (Meta's comma). */
  readonly scopeSeparator?: string;
  /**
   * The provider's parameters after PKCE (Google's offline access and consent prompt, Reddit's permanent duration,
   * Meta's re-request and login configuration); `reauthorization` when a saved login is renewed.
   */
  authorizeParameters?(parameters: URLSearchParams, context: {reauthorization: boolean; env: NodeJS.ProcessEnv}): void;
  /**
   * Completes the authorization the provider's own way, in place of the code exchange (X's OAuth 1.0a access token),
   * after the stage's checks of the callback; `label` names the login (CON-05).
   */
  complete?(
    context: OAuthContext & {
      readonly stored: JsonObject;
      readonly query: Readonly<Record<string, string>>;
      assertActive(): void;
      label(name?: string): string;
    },
  ): Promise<OAuthExchange>;
  /** The callback parameter that carries the authorization code: `code` unless the provider names another (TikTok). */
  readonly codeParameter?: string;
  /**
   * The token request of the code, from the stage's: its form (the client, grant type, code, callback and PKCE
   * verifier, in that order), POSTed to the token endpoint (Microsoft's scope, Reddit's Basic authentication and
   * User-Agent, Meta's GET, TikTok's JSON).
   */
  tokenRequest?(request: OAuthTokenRequest, context: OAuthContext & {readonly code: string}): OAuthTokenRequest;
  /** The token response's own result, or a refusal (TikTok's code and data). */
  tokenResult?(result: JsonObject): JsonObject;
  /** A second exchange of the token the code gave (Meta's long-lived token), or the result unchanged. */
  extend?(result: JsonObject, context: OAuthContext & {assertActive(): void}): Promise<JsonObject>;
  /** Refuses tokens the provider must renew but did not make renewable (Reddit), after the stage's token checks. */
  checkTokens?(result: JsonObject, expires: number | undefined): void;
  /** The provider's part of the saved credentials (Google Ads' and Microsoft's developer tokens), or a refusal. */
  credentials?(credentials: Credentials, context: {env: NodeJS.ProcessEnv; expires: number | undefined}): void;
  /**
   * What a login of this provider keeps on its connection besides the stage's fields (Reddit's User-Agent, which its
   * renewals send), or a refusal; never the connection's identity, accounts or grants.
   */
  connectionFields?(env: NodeJS.ProcessEnv): Pick<Connection, 'userAgent'>;
}

// The website's asset discovery: server/asset-discovery.ts keeps the platform and kind checks, the login checks around
// every request, the page and asset rules and each kind's failure group; a provider supplies the reads that list its
// assets (`discovery`).

/** One asset a login's discovery found: what the website lists and a login may select. */
export interface WorkspaceAsset {
  id: string;
  kind: string;
  name: string;
  parentId?: string;
  /** Google: the client's depth beneath the login's root manager (1 = direct client); parentId is its direct manager. */
  level?: number;
  currency?: string;
  timezone?: string;
  status?: string;
  loginCustomerId?: string;
  readVerified?: boolean;
  manager?: boolean;
  hidden?: boolean;
  testAccount?: boolean;
  /** LinkedIn: the member's role on the account (adAccountUsers) and when discovery observed it (PRV-02). */
  linkedinRole?: string;
  linkedinRoleObservedAt?: number;
  /** GA4 data streams: the native stream type and web measurement ID (MSR-03). */
  streamType?: string;
  measurementId?: string;
  /** Tag Manager containers: the public ID and the Google tag IDs that refer to the container (MSR-03). */
  publicId?: string;
  tagIds?: string[];
  source: 'vendor' | 'configured_binding';
}
/** The assets of one kind: complete, or with the error and diagnostics of what could not be read. */
export interface AssetGroup {
  checkedAt?: number;
  kind: string;
  assets: WorkspaceAsset[];
  complete: boolean;
  error?: string;
  diagnostics?: JsonObject[];
  /** Google: false when some sub-manager could not be read, so its clients show the root as their manager. */
  hierarchyComplete?: boolean;
}

/** What discovery learns of the login besides its assets: the user's name and ID, and the permissions it was granted. */
export interface DiscoveryFindings {
  label?: string;
  identity?: string;
  grants?: JsonObject;
}

/** One listing a discovery step reads to its end: a path, a new query (paging writes its cursor into it), its rows. */
export interface DiscoveryListing {
  path: string;
  query: JsonObject;
  extract(data: JsonObject): unknown[];
}

/**
 * The accounts beneath each parent a login reaches (Reddit's businesses, DV360's partners), which the stage walks with
 * its own rules: at most 100 parents, each named once by a valid ID, at most 10,000 accounts, each inside the parent
 * that listed it; a parent whose accounts cannot be read is a diagnostic of the group, and the others' accounts stay.
 */
export interface DiscoveryParents {
  parents(): DiscoveryListing;
  /** A parent row's ID, as text, which `parentPattern` must match. */
  parentId(parent: JsonObject): string;
  readonly parentPattern: RegExp;
  accounts(parent: string): DiscoveryListing;
  /** An account row's own ID, which must be a string matching `accountPattern`. */
  accountId(row: JsonObject): unknown;
  /** The parent an account row names, if it names one. */
  accountParent(row: JsonObject): unknown;
  readonly accountPattern: RegExp;
  /** The fields of an account row its asset shows. */
  fields(row: JsonObject): {name: unknown; currency: unknown; timezone: unknown; status: unknown};
  /** What a complete listing leaves out (Reddit's shared-in accounts): the diagnostics a complete group carries. */
  coverage?(): JsonObject[];
}

/**
 * What the discovery stage (server/asset-discovery.ts) gives a provider's step. Every request goes through `request`,
 * which runs `check` (the connection, its scopes and its login are unchanged) before and after each attempt.
 */
export interface DiscoveryContext {
  readonly connection: Connection;
  readonly credentials: Credentials;
  /** What the step learns of the login; the stage returns it with the groups. */
  readonly found: DiscoveryFindings;
  /** The stage's transport, for a step that reads with other credentials (Google Ads' login customers). */
  readonly transport: NativeTransport;
  check(): void;
  /** A read-only discovery request of a path (AMCP_ASSET_DISCOVERY). */
  plan(path: string, query?: JsonObject, method?: string, body?: unknown): CompiledRequest;
  request(plan: CompiledRequest): Promise<TransportResult>;
  /** The data of one request. */
  read(plan: CompiledRequest): Promise<unknown>;
  /** A listing read to its end with the stage's page rules, on the gateway's origin unless one is given. */
  pages(
    path: string,
    query: JsonObject,
    extract: (data: JsonObject) => unknown[],
    origin?: string,
  ): Promise<JsonObject[]>;
  /** A provider row as an asset: its ID (without act_ for ad accounts), name, currency, time zone and status. */
  asset(row: JsonObject, kind: string, parentId?: string): WorkspaceAsset;
  /** The group of a kind that could not be read: its diagnostic and message. */
  failure(kind: string, error: unknown): AssetGroup;
  /** The stage's walk of the accounts beneath each parent: the group it decided, or the assets of a complete one. */
  parents(kind: string, parents: DiscoveryParents): Promise<WorkspaceAsset[] | AssetGroup>;
}

/** A provider's asset discovery: the reads that list its assets, and its paging and header facts. */
export interface AssetDiscoveryHooks {
  /**
   * Discovers one selected kind: its assets, which the stage keeps one per kind and ID in a complete group, or a group
   * the step decided (Google Ads' hierarchy, the parent walk). A refusal is that kind's failure group.
   */
  kind?(kind: string, context: DiscoveryContext): Promise<WorkspaceAsset[] | AssetGroup>;
  /** Discovers every selected kind in one bounded pass (Business Profile), in place of `kind`. */
  all?(selected: readonly string[], context: DiscoveryContext): Promise<AssetGroup[]>;
  /** The headers every discovery request carries (LinkedIn's version headers). */
  headers?(): Record<string, string>;
  /** Checks a next-page link the stage accepted, before its cursor is read (Reddit: only the cursor may change). */
  nextLink?(next: URL, original: URL, cursor: string): void;
  /** The offset of the next page of a listing that pages by start and count (LinkedIn), or undefined at its end. */
  nextStart?(data: JsonObject, rows: readonly unknown[]): number | undefined;
}

// The renewal of a saved login that verifies every account it selected before a fresh authorization replaces its
// credentials (server/google-reauthorization.ts, Google Ads): the stage keeps the administrator, revision, scope,
// offline-access and identity checks, the login check before and after every read, the refusals, the refresh lock and
// the saved connection; a provider supplies the reads.

/** A provider's renewal reads: what a fresh authorization reaches, and the read that verifies one selected account. */
export interface RenewalSteps {
  /**
   * The accounts a fresh authorization reaches, the reads of its asset discovery (Google Ads: every account beneath
   * each directly accessible root, with its manager route), sent through the stage's transport with `check` before
   * and after each request.
   */
  accounts(
    transport: NativeTransport,
    connection: Connection,
    credentials: Credentials,
    check: () => void,
  ): Promise<AssetGroup>;
  /** The read of one selected account the listing did not verify; the stage sends it through its recorded route. */
  selectedAccountRead(gateway: string, account: string): CompiledRequest;
}

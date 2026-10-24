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

/** A provider's steps of the website's logins: the reads that list what a login reaches (server/asset-discovery.ts). */
export interface ProviderLogin {
  /** The gateway of the provider adapter these steps belong to. */
  readonly gateway: string;
  readonly discovery?: AssetDiscoveryHooks;
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

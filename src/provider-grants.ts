import type {Connection, JsonObject} from './types.js';

/**
 * One registry of provider OAuth grants (CON-02, CON-03): what AMCP requests, what read and reviewed-write enforcement
 * requires, where the granted permissions come from, and whether readiness has an exact account read. The OAuth
 * configuration (server/platform-oauth.ts), measurement write enforcement, the Google Ads and Snapchat scope checks,
 * readiness and capability eligibility read these values instead of keeping their own copies. Recorded scopes are a
 * local prerequisite only; the provider's own permission check at execution remains the authority.
 *
 * A requirement is satisfied when any one of `any` is recorded and every scope of `all` is recorded. `null` means the
 * provider has no OAuth scope that distinguishes the capability (TikTok, X, Criteo): AMCP cannot know it from a grant,
 * and readiness reports it as unknown rather than passed.
 */
export interface ScopeRequirement {
  any?: readonly string[];
  all?: readonly string[];
}
export interface ProviderGrant {
  gateway: string;
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
  /** Whether readiness has one exact, scoped account read for this gateway (src/workspace.ts accountPlan). */
  accountReadContract: boolean;
}

const google = (s: string) => 'https://www.googleapis.com/auth/' + s;
export const gtmWriteScopes = [
  'tagmanager.edit.containers',
  'tagmanager.delete.containers',
  'tagmanager.edit.containerversions',
  'tagmanager.publish',
].map(google);
export const googleAdsScope = google('adwords');
export const dv360Scope = google('display-video');
export const businessScope = google('business.manage');
export const snapchatScope = 'snapchat-marketing-api';
export const microsoftManageScope = 'https://ads.microsoft.com/msads.manage';
export const analyticsScopes = [google('analytics.readonly'), google('analytics')];
export const searchConsoleWriteScope = google('webmasters');
export const appleScope = 'searchadsorg';

export const providerGrants: readonly ProviderGrant[] = [
  {
    gateway: 'meta_native_action',
    platform: 'meta',
    requestedRead: ['ads_read', 'pages_show_list', 'pages_read_engagement', 'business_management'],
    requestedWrite: ['ads_management'],
    read: {any: ['ads_read', 'ads_management']},
    write: {all: ['ads_management']},
    grantSource: 'permissions_endpoint',
    accountReadContract: true,
  },
  {
    gateway: 'google_ads_native_action',
    platform: 'google',
    requestedRead: [googleAdsScope, 'openid', 'profile'],
    // Customer Match and offline conversions through Google's Data Manager API (owner decision of 2026-09-30).
    requestedWrite: [google('datamanager')],
    read: {all: [googleAdsScope]},
    write: {all: [googleAdsScope]},
    grantSource: 'token_response',
    accountReadContract: true,
  },
  {
    gateway: 'linkedin_native_action',
    platform: 'linkedin',
    requestedRead: ['r_ads', 'r_ads_reporting'],
    requestedWrite: ['rw_ads'],
    read: {any: ['r_ads', 'rw_ads']},
    write: {all: ['rw_ads']},
    grantSource: 'token_response',
    accountReadContract: true,
  },
  {
    gateway: 'reddit_native_action',
    platform: 'reddit',
    // adsedit is requested only when the deployment allows reviewed writes (owner decision D19, item 5).
    requestedRead: ['adsread'],
    requestedWrite: ['adsedit'],
    read: {all: ['adsread']},
    write: {all: ['adsread', 'adsedit']},
    grantSource: 'token_response',
    accountReadContract: true,
  },
  {
    gateway: 'microsoft_ads_native_action',
    platform: 'microsoft',
    requestedRead: [microsoftManageScope, 'offline_access'],
    requestedWrite: [],
    // Microsoft uses one API scope for reads and writes; AMCP roles and account grants separate them.
    read: {any: [microsoftManageScope, 'msads.manage']},
    write: {any: [microsoftManageScope, 'msads.manage']},
    grantSource: 'token_response',
    accountReadContract: true,
  },
  {
    gateway: 'snapchat_native_action',
    platform: 'snapchat',
    requestedRead: [snapchatScope],
    requestedWrite: [],
    read: {all: [snapchatScope]},
    write: {all: [snapchatScope]},
    grantSource: 'token_response',
    accountReadContract: true,
  },
  {
    gateway: 'tiktok_native_action',
    platform: 'tiktok',
    requestedRead: [],
    requestedWrite: [],
    // TikTok permissions are set on the developer app, not per authorization; a returned scope list is recorded
    // verbatim, but no documented mapping turns it into an AMCP requirement.
    read: null,
    write: null,
    grantSource: 'token_response',
    accountReadContract: true,
  },
  {
    gateway: 'x_ads_native_action',
    platform: 'x',
    requestedRead: [],
    requestedWrite: [],
    // OAuth 1.0a has no scopes; only the requested access type (read or write) is known.
    read: null,
    write: null,
    grantSource: 'requested_access_type',
    accountReadContract: true,
  },
  {
    gateway: 'dv360_native_action',
    platform: 'dv360',
    requestedRead: [dv360Scope],
    requestedWrite: [],
    read: {all: [dv360Scope]},
    write: {all: [dv360Scope]},
    grantSource: 'token_response',
    accountReadContract: true,
  },
  {
    gateway: 'ga4_native_action',
    platform: 'ga4',
    requestedRead: [google('analytics.readonly')],
    requestedWrite: [],
    read: {any: analyticsScopes},
    // src/measurement-writes.ts accepts either recorded Analytics scope for its reviewed property writes.
    write: {any: analyticsScopes},
    grantSource: 'token_response',
    accountReadContract: true,
  },
  {
    gateway: 'gtm_native_action',
    platform: 'gtm',
    requestedRead: [google('tagmanager.readonly')],
    requestedWrite: gtmWriteScopes,
    read: {any: [google('tagmanager.readonly'), ...gtmWriteScopes]},
    // Each Tag Manager action needs its own scope (src/measurement-writes.ts); any one of them enables some writes.
    write: {any: gtmWriteScopes},
    grantSource: 'token_response',
    accountReadContract: true,
  },
  {
    gateway: 'google_search_console_native_action',
    platform: 'gsc',
    requestedRead: [google('webmasters.readonly')],
    requestedWrite: [searchConsoleWriteScope],
    read: {any: [google('webmasters.readonly'), searchConsoleWriteScope]},
    write: {all: [searchConsoleWriteScope]},
    grantSource: 'token_response',
    accountReadContract: true,
  },
  {
    gateway: 'apple_ads_native_action',
    platform: 'apple',
    requestedRead: [appleScope],
    requestedWrite: [],
    read: {all: [appleScope]},
    write: {all: [appleScope]},
    grantSource: 'token_response',
    accountReadContract: true,
  },
  {
    gateway: 'google_business_native_action',
    platform: 'google_business',
    requestedRead: [businessScope],
    requestedWrite: [],
    read: {all: [businessScope]},
    write: {all: [businessScope]},
    grantSource: 'token_response',
    // One exact read of the selected location or business account (src/workspace.ts readinessPlan, CON-06).
    accountReadContract: true,
  },
  {
    gateway: 'criteo_native_action',
    requestedRead: [],
    requestedWrite: [],
    read: null,
    write: null,
    grantSource: 'none',
    accountReadContract: false,
  },
  {
    gateway: 'google_sheets_native_action',
    platform: 'sheets',
    requestedRead: [google('drive.file'), google('spreadsheets')],
    requestedWrite: [],
    read: {any: [google('drive.file'), google('spreadsheets')]},
    write: null,
    grantSource: 'token_response',
    // Sheets and Drive are report destinations and media sources, not advertising accounts.
    accountReadContract: false,
  },
  {
    gateway: 'google_drive_native_action',
    platform: 'drive',
    requestedRead: [google('drive.readonly')],
    requestedWrite: [],
    read: {all: [google('drive.readonly')]},
    write: null,
    grantSource: 'token_response',
    accountReadContract: false,
  },
];

export function providerGrant(gateway: string): ProviderGrant | undefined {
  return providerGrants.find(g => g.gateway === gateway);
}

/** The scopes AMCP asks a platform for: its read scopes, plus its write scopes when reviewed writes are allowed. */
export function requestedScopes(gateway: string, allowWrites: boolean): string[] {
  const g = providerGrant(gateway);
  return g ? [...g.requestedRead, ...(allowWrites ? g.requestedWrite : [])] : [];
}

/** Every scope a requirement names, for display: all of `all`, then the alternatives of `any`. */
export function requirementScopes(requirement: ScopeRequirement | null | undefined): string[] {
  return requirement ? [...(requirement.all ?? []), ...(requirement.any ?? [])] : [];
}

/** The scopes a requirement still misses on these recorded scopes; [] when satisfied. */
export function missingScopes(requirement: ScopeRequirement, scopes: readonly string[]): string[] {
  const all = (requirement.all ?? []).filter(s => !scopes.includes(s));
  const any = requirement.any?.length && !requirement.any.some(s => scopes.includes(s)) ? [requirement.any[0]!] : [];
  return [...all, ...any];
}

/**
 * Whether the recorded scopes still allow reviewed writes: true or false when the provider has a write scope, and
 * undefined when no scope decides it (TikTok, X), so the caller keeps its other controls.
 */
export function recordedWriteGrant(connection: Pick<Connection, 'gateway' | 'scopes'>): boolean | undefined {
  const requirement = providerGrant(connection.gateway)?.write;
  return requirement ? missingScopes(requirement, connection.scopes).length === 0 : undefined;
}

/**
 * The recorded grant facts Connections may show: the source, whether the grant is known, permission names, the access
 * type AMCP requested (X) and when it was checked. Never a token or provider text.
 */
export function publicGrants(grants: unknown): JsonObject | null {
  if (!grants || typeof grants !== 'object' || Array.isArray(grants)) return null;
  const g = grants as Record<string, unknown>,
    names = (key: string) =>
      Array.isArray(g[key])
        ? {[key]: (g[key] as unknown[]).filter(s => typeof s === 'string' && /^[a-z_]{1,64}$/.test(s)).slice(0, 100)}
        : {};
  return {
    source: typeof g.source === 'string' ? g.source : 'unknown',
    known: g.known === true,
    ...names('granted'),
    ...names('declined'),
    ...names('expired'),
    ...(g.requested_access_type === 'read' || g.requested_access_type === 'write'
      ? {requested_access_type: g.requested_access_type}
      : {}),
    checked_at: Number.isSafeInteger(g.checked_at) ? g.checked_at : null,
  };
}

/**
 * The permissions a provider confirmed it granted (Meta `/me/permissions`, recorded as website_connection.grants), as
 * sorted recorded scopes; undefined while the grant is not known.
 */
export function grantedScopes(grants: unknown): string[] | undefined {
  const g = grants && typeof grants === 'object' && !Array.isArray(grants) ? (grants as Record<string, unknown>) : {};
  return g.known === true && Array.isArray(g.granted) && g.granted.every(s => typeof s === 'string')
    ? [...(g.granted as string[])].sort()
    : undefined;
}

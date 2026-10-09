import type {Connection} from './types.js';

/**
 * One registry of provider OAuth grants (CON-02, CON-03): what AMCP requests, what read and reviewed-write enforcement
 * requires, and where the granted permissions come from. Enforcement modules, the OAuth configuration, readiness and
 * capability eligibility read these values instead of keeping their own copies. Recorded scopes are a local
 * prerequisite only; the provider's own permission check at execution remains the authority.
 *
 * A requirement is satisfied when any one of `any` is recorded and every scope of `all` is recorded. `null` means the
 * provider has no OAuth scope that distinguishes the capability (TikTok, X): AMCP cannot know it from a grant, and
 * readiness reports it as unknown rather than passed.
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
export const microsoftManageScope = 'https://ads.microsoft.com/msads.manage';

export const providerGrants: readonly ProviderGrant[] = [
  {
    gateway: 'meta_native_action',
    platform: 'meta',
    requestedRead: ['ads_read', 'pages_show_list', 'pages_read_engagement', 'business_management'],
    requestedWrite: ['ads_management'],
    read: {any: ['ads_read', 'ads_management']},
    write: {all: ['ads_management']},
    grantSource: 'permissions_endpoint',
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
  },
  {
    gateway: 'linkedin_native_action',
    platform: 'linkedin',
    requestedRead: ['r_ads', 'r_ads_reporting'],
    requestedWrite: ['rw_ads'],
    read: {any: ['r_ads', 'rw_ads']},
    write: {all: ['rw_ads']},
    grantSource: 'token_response',
  },
  {
    gateway: 'reddit_native_action',
    platform: 'reddit',
    requestedRead: ['adsread', 'adsedit'],
    requestedWrite: [],
    read: {all: ['adsread']},
    write: {all: ['adsread', 'adsedit']},
    grantSource: 'token_response',
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
  },
  {
    gateway: 'snapchat_native_action',
    platform: 'snapchat',
    requestedRead: ['snapchat-marketing-api'],
    requestedWrite: [],
    read: {all: ['snapchat-marketing-api']},
    write: {all: ['snapchat-marketing-api']},
    grantSource: 'token_response',
  },
  {
    gateway: 'tiktok_native_action',
    platform: 'tiktok',
    requestedRead: [],
    requestedWrite: [],
    // TikTok permissions are set on the developer app, not per authorization; a returned scope list is recorded.
    read: null,
    write: null,
    grantSource: 'token_response',
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
  },
  {
    gateway: 'dv360_native_action',
    platform: 'dv360',
    requestedRead: [dv360Scope],
    requestedWrite: [],
    read: {all: [dv360Scope]},
    write: {all: [dv360Scope]},
    grantSource: 'token_response',
  },
  {
    gateway: 'ga4_native_action',
    platform: 'ga4',
    requestedRead: [google('analytics.readonly')],
    requestedWrite: [],
    read: {any: [google('analytics.readonly'), google('analytics')]},
    write: {any: [google('analytics.readonly'), google('analytics')]},
    grantSource: 'token_response',
  },
  {
    gateway: 'gtm_native_action',
    platform: 'gtm',
    requestedRead: [google('tagmanager.readonly')],
    requestedWrite: gtmWriteScopes,
    read: {any: [google('tagmanager.readonly'), ...gtmWriteScopes]},
    write: {any: gtmWriteScopes},
    grantSource: 'token_response',
  },
  {
    gateway: 'google_search_console_native_action',
    platform: 'gsc',
    requestedRead: [google('webmasters.readonly')],
    requestedWrite: [google('webmasters')],
    read: {any: [google('webmasters.readonly'), google('webmasters')]},
    write: {all: [google('webmasters')]},
    grantSource: 'token_response',
  },
  {
    gateway: 'apple_ads_native_action',
    platform: 'apple',
    requestedRead: ['searchadsorg'],
    requestedWrite: [],
    read: {all: ['searchadsorg']},
    write: {all: ['searchadsorg']},
    grantSource: 'token_response',
  },
  {
    gateway: 'google_business_native_action',
    requestedRead: [businessScope],
    requestedWrite: [],
    read: {all: [businessScope]},
    write: {all: [businessScope]},
    grantSource: 'token_response',
  },
  {
    gateway: 'google_sheets_native_action',
    platform: 'sheets',
    requestedRead: [google('drive.file'), google('spreadsheets')],
    requestedWrite: [],
    read: {any: [google('drive.file'), google('spreadsheets')]},
    write: null,
    grantSource: 'token_response',
  },
  {
    gateway: 'google_drive_native_action',
    platform: 'drive',
    requestedRead: [google('drive.readonly')],
    requestedWrite: [],
    read: {all: [google('drive.readonly')]},
    write: null,
    grantSource: 'token_response',
  },
];

export function providerGrant(gateway: string): ProviderGrant | undefined {
  return providerGrants.find(g => g.gateway === gateway);
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

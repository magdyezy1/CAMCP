import type {Store} from './store.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import {sha256, stable} from './security.js';
import {bad} from './workspace-core.js';
import {normalizeAccount} from './account-id.js';
import {linkedinVersion} from './linkedin-version.js';
import {microsoftGateway, compileMicrosoft} from './microsoft-native.js';
import {googleAdsCustomers} from './google-version.js';
import {metaPrefix} from './meta-version.js';

/**
 * What a live account read said about an account: its name, currency, timezone and organization (Snapchat S8).
 * list_accounts showed the connection's label as the account name and null currency and timezone for every platform,
 * although a live check had read them. Nothing here is invented: an account never read live has no record, and
 * list_accounts then says how to read it.
 */
export const accountMetadataStaleMs = 7 * 86400000;
const key = (connectionId: string, accountId: string) => sha256(stable([connectionId, accountId]));
export function rememberAccountMetadata(
  store: Store,
  tenantId: string,
  connectionId: string,
  accountId: string,
  metadata: {name: unknown; currency: unknown; timezone: unknown; organization_id?: unknown},
) {
  const text = (v: unknown) => (typeof v === 'string' && v.length <= 300 ? v : null);
  store.putDocument(tenantId, 'account_metadata', key(connectionId, accountId), {
    connection_id: connectionId,
    account_id: accountId,
    name: text(metadata.name),
    currency: text(metadata.currency),
    timezone: text(metadata.timezone),
    organization_id: text(metadata.organization_id),
    source: 'live_account_read',
    checked_at: Date.now(),
  });
}
export function recallAccountMetadata(
  store: Store,
  tenantId: string,
  connectionId: string,
  accountId: string,
): JsonObject | undefined {
  return store.repo('account_metadata', tenantId).payload(key(connectionId, accountId));
}
/** The account's own name in a native account read, however the provider nests it. */
export function accountName(metadata: JsonObject): unknown {
  return metadata.name ?? metadata.descriptiveName ?? metadata.Name ?? metadata.advertiser_name ?? metadata.displayName;
}

/**
 * What a selected resource is (CON-05). Report destinations and media sources (Sheets, Drive) are not advertising
 * accounts: list_accounts leaves them out unless they are asked for, and no account read is suggested for them.
 */
export type AccountKind =
  'ad_account' | 'analytics_property' | 'tag_account' | 'search_property' | 'business_profile' | 'destination';
const kinds: Record<string, AccountKind> = {
  ga4_native_action: 'analytics_property',
  gtm_native_action: 'tag_account',
  google_search_console_native_action: 'search_property',
  google_business_native_action: 'business_profile',
  google_sheets_native_action: 'destination',
  google_drive_native_action: 'destination',
};
export const accountKind = (gateway: string): AccountKind => kinds[gateway] ?? 'ad_account';

export interface ResolvedAccountMetadata {
  kind: AccountKind;
  name: string | null;
  currency: string | null;
  timezone: string | null;
  organization_id: string | null;
  /** Where the values came from: an exact live account read, the login's cached discovery listing, or nothing. */
  source: 'live_account_read' | 'cached_discovery' | null;
  /** When that source observed them (epoch milliseconds), or null. */
  checked_at: number | null;
  /** Set when the live read had no name and the name came from the cached discovery listing. */
  name_source?: 'cached_discovery';
  stale?: true;
}

const text = (v: unknown) => (typeof v === 'string' && v.trim() && v.length <= 300 ? v : null);
const normalized = normalizeAccount;

/** The account as the login's last discovery listed it, with when that listing was read. */
function discovered(store: Store, tenantId: string, c: Connection, accountId: string) {
  const assets = store.repo('website_assets', tenantId).payload(c.id);
  if (!assets) return undefined;
  const wanted = normalized(c.gateway, accountId);
  for (const group of Array.isArray(assets.groups) ? (assets.groups as JsonObject[]) : [])
    for (const asset of Array.isArray(group.assets) ? (group.assets as JsonObject[]) : [])
      if (asset?.source === 'vendor' && normalized(c.gateway, String(asset.id)) === wanted)
        return {
          // A listing that only knew the ID names nothing.
          name: text(asset.name) && asset.name !== asset.id ? (asset.name as string) : null,
          currency: text(asset.currency),
          timezone: text(asset.timezone),
          checked_at: Number.isSafeInteger(group.checkedAt)
            ? (group.checkedAt as number)
            : Number.isSafeInteger(assets.lastSync)
              ? (assets.lastSync as number)
              : null,
        };
  return undefined;
}

/**
 * One account-metadata resolver (CON-05) for list_accounts, recipe context and capabilities, so the same binding
 * shows the same name and source everywhere: the last live account read, then the login's cached discovery listing,
 * then nothing. Values are never invented and the connection's label is never used as an account name.
 */
export function resolveAccountMetadata(
  store: Store,
  tenantId: string,
  c: Connection,
  accountId: string,
): ResolvedAccountMetadata {
  const kind = accountKind(c.gateway),
    live = recallAccountMetadata(store, tenantId, c.id, accountId),
    listed = discovered(store, tenantId, c, accountId);
  if (live) {
    const name = text(live.name) ?? listed?.name ?? null;
    return {
      kind,
      name,
      currency: text(live.currency),
      timezone: text(live.timezone),
      organization_id: text(live.organization_id),
      source: 'live_account_read',
      checked_at: Number.isSafeInteger(live.checked_at) ? live.checked_at : null,
      ...(!text(live.name) && name ? {name_source: 'cached_discovery' as const} : {}),
      ...(Number.isSafeInteger(live.checked_at) && Date.now() - live.checked_at > accountMetadataStaleMs
        ? {stale: true as const}
        : {}),
    };
  }
  if (listed && (listed.name || listed.currency || listed.timezone))
    return {
      kind,
      name: listed.name,
      currency: listed.currency,
      timezone: listed.timezone,
      organization_id: null,
      source: 'cached_discovery',
      checked_at: listed.checked_at,
    };
  return {
    kind,
    name: null,
    currency: null,
    timezone: null,
    organization_id: null,
    source: null,
    checked_at: null,
  };
}

/** The shared `metadata` projection of a resolved account: its source and time, or null when nothing is known. */
export function accountMetadataView(m: ResolvedAccountMetadata): JsonObject | null {
  if (!m.source) return null;
  return {
    source: m.source,
    checked_at: m.checked_at === null ? null : new Date(m.checked_at).toISOString(),
    ...(m.organization_id ? {organization_id: m.organization_id} : {}),
    ...(m.name_source ? {name_source: m.name_source} : {}),
    ...(m.stale ? {stale: true} : {}),
  };
}

/**
 * The exact account read of each advertising provider (ARC-04 stage B: moved from src/workspace.ts, which re-exports it,
 * so reporting reads accounts without importing the workspace tool). Readiness, plan preflight and reports use it.
 */
export const accountPlan = (gateway: string, id: string): CompiledRequest => {
  const p: CompiledRequest = {
    gateway,
    accountId: id,
    action: 'AMCP_READINESS',
    method: 'GET',
    path: '',
    query: {},
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    evidence: 'AMCP exact account readiness read',
    warnings: [],
  };
  switch (gateway) {
    case 'meta_native_action':
      p.path = metaPrefix + 'act_' + id;
      p.query = {fields: 'id,name,account_status,currency,timezone_name'};
      break;
    case 'snapchat_native_action':
      p.path = '/v1/adaccounts/' + id;
      break;
    case 'tiktok_native_action':
      p.path = '/v1.3/advertiser/info/';
      p.query = {advertiser_ids: [id]};
      break;
    case 'google_ads_native_action':
      p.method = 'POST';
      p.path = googleAdsCustomers + id + '/googleAds:search';
      p.body = {query: 'SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 1'};
      break;
    case 'linkedin_native_action':
      p.path = '/rest/adAccounts/' + id;
      p.headers = {'LinkedIn-Version': linkedinVersion(), 'X-Restli-Protocol-Version': '2.0.0'};
      break;
    case 'x_ads_native_action':
      p.path = '/12/accounts/' + id;
      break;
    case 'dv360_native_action':
      p.path = '/v4/advertisers/' + id;
      break;
    case 'reddit_native_action':
      p.path = '/api/v3/ad_accounts/' + id;
      break;
    case microsoftGateway:
      return compileMicrosoft({action: 'GetAccount', account_id: id});
    default:
      bad('This provider uses resource-specific readiness checks.', 'READINESS_CONTRACT_UNAVAILABLE');
  }
  return p;
};
/** Native account reads nest the account differently per provider (Snapchat: adaccounts[0].adaccount).
 * Readiness checks, plan preflight and reports share this reader so a currency is never lost to nesting. */
export function accountMetadata(gateway: string, data: unknown): JsonObject {
  const d = (data && typeof data === 'object' ? data : {}) as JsonObject;
  // A Business Profile location is named by its title and an account by accountName; `name` is the resource name.
  if (gateway === 'google_business_native_action') {
    const title = d.title ?? d.accountName;
    return typeof title === 'string' ? {name: title} : {};
  }
  const m =
    gateway === 'google_ads_native_action'
      ? d.results?.[0]?.customer
      : gateway === 'meta_native_action'
        ? d
        : gateway === 'tiktok_native_action'
          ? d.data?.list?.[0]
          : gateway === 'snapchat_native_action'
            ? d.adaccounts?.[0]?.adaccount
            : gateway === microsoftGateway
              ? d.Account
              : gateway === 'apple_ads_native_action'
                ? (d.result ?? d.data ?? d)
                : (d.data ?? d);
  return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
}
export const accountCurrency = (gateway: string, data: unknown): string | null => {
  const m = accountMetadata(gateway, data);
  return m.currency ?? m.currencyCode ?? m.CurrencyCode ?? null;
};
export const accountTimezone = (gateway: string, data: unknown): string | null => {
  const m = accountMetadata(gateway, data);
  return m.timezone_name ?? m.timezone ?? m.timeZone ?? m.TimeZone ?? null;
};

import type {Store} from './store.js';
import type {Actor, CompiledRequest, Connection, JsonObject} from './types.js';
import {sha256, stable} from './security.js';
import {bad} from './workspace-core.js';
import {normalizeAccount} from './account-id.js';
import type {AccountKind} from './provider-adapter.js';
import {providerOf} from './provider-adapters.js';
import {providerHooks} from './provider-hooks.js';

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
 * What a selected resource is (CON-05), from its provider's account model (src/provider-adapters.ts, ARC-01 phase B).
 * Report destinations and media sources (Sheets, Drive) are not advertising accounts: list_accounts leaves them out
 * unless they are asked for, and no account read is suggested for them.
 */
export type {AccountKind} from './provider-adapter.js';
export const accountKind = (gateway: string): AccountKind => providerOf(gateway)?.account?.kind ?? 'ad_account';

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

/**
 * What an account's last live read (or its login's discovery) stored of its name and currency, for the summary of a write to it (R2.5
 * r25-approval-fields, B6: a Google budget read "in account currency" for an account AMCP knew to be in USD). Nothing is read from a provider: an
 * account never read, or one this actor cannot reach, has nothing here.
 */
export function storedAccountOf(
  store: Store,
  actor: Actor,
  gateway: string,
  accountId: unknown,
  connectionId?: string,
): {name?: string; currency?: string} {
  try {
    if (accountId === undefined || accountId === null) return {};
    const c = store.resolveConnection(actor, gateway, String(accountId), connectionId),
      m = resolveAccountMetadata(store, actor.tenantId, c, normalized(gateway, accountId));
    return {...(m.name ? {name: m.name} : {}), ...(m.currency ? {currency: m.currency} : {})};
  } catch {
    return {};
  }
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
 * so reporting reads accounts without importing the workspace tool). Readiness, plan preflight and reports use it. What
 * every account read is stays here; its route is the provider adapter's account read (ARC-01 phase B,
 * src/<provider>-adapter.ts).
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
  const route = providerHooks(gateway)?.accountRead?.plan;
  if (!route) bad('This provider uses resource-specific readiness checks.', 'READINESS_CONTRACT_UNAVAILABLE');
  return route(p, id);
};
/** Native account reads nest the account differently per provider (Snapchat: adaccounts[0].adaccount): the provider
 * adapter finds it, and an account read of a provider that does not is its `data`, or itself.
 * Readiness checks, plan preflight and reports share this reader so a currency is never lost to nesting. */
export function accountMetadata(gateway: string, data: unknown): JsonObject {
  const d = (data && typeof data === 'object' ? data : {}) as JsonObject,
    account = providerHooks(gateway)?.accountRead?.account;
  const m = account ? account(d) : (d.data ?? d);
  return m && typeof m === 'object' && !Array.isArray(m) ? (m as JsonObject) : {};
}
export const accountCurrency = (gateway: string, data: unknown): string | null => {
  const m = accountMetadata(gateway, data);
  return m.currency ?? m.currencyCode ?? m.CurrencyCode ?? null;
};
export const accountTimezone = (gateway: string, data: unknown): string | null => {
  const m = accountMetadata(gateway, data);
  return m.timezone_name ?? m.timezone ?? m.timeZone ?? m.TimeZone ?? null;
};

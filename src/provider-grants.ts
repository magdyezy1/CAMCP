import type {Connection, JsonObject} from './types.js';
import type {ProviderGrantFacts, ScopeRequirement} from './provider-adapter.js';
import {grantOrder, providerById} from './provider-adapters.js';

/**
 * One registry of provider OAuth grants (CON-02, CON-03): what AMCP requests, what read and reviewed-write enforcement
 * requires, where the granted permissions come from, and whether readiness has an exact account read. The OAuth
 * configuration (server/platform-oauth.ts), measurement write enforcement, the Google Ads and Snapchat scope checks,
 * readiness and capability eligibility read these values instead of keeping their own copies. Recorded scopes are a
 * local prerequisite only; the provider's own permission check at execution remains the authority.
 *
 * Each grant is a fact of its provider's adapter (ARC-01 phase B: `grant` in src/provider-adapters.ts, which also holds
 * the scope names it uses); this module lists them in the registry's grant order and keeps the functions that read them.
 *
 * A requirement is satisfied when any one of `any` is recorded and every scope of `all` is recorded. `null` means the
 * provider has no OAuth scope that distinguishes the capability (TikTok, X, Criteo): AMCP cannot know it from a grant,
 * and readiness reports it as unknown rather than passed.
 */
export type {ScopeRequirement};
export interface ProviderGrant extends ProviderGrantFacts {
  gateway: string;
}

// The scope names the provider modules and readiness check, importable from here as before.
export {
  gtmWriteScopes,
  googleAdsScope,
  dv360Scope,
  businessScope,
  snapchatScope,
  microsoftManageScope,
  analyticsScopes,
  searchConsoleWriteScope,
  appleScope,
} from './provider-adapters.js';

/** Every provider grant, in the registry's grant order: the gateway, then its adapter's grant facts. */
export const providerGrants: readonly ProviderGrant[] = grantOrder.map(id => {
  const adapter = providerById(id)!;
  return {gateway: adapter.gateway, ...adapter.grant!};
});

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

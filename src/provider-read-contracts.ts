import type {CompiledRequest, Connection} from './types.js';
import {providerHooks} from './provider-hooks.js';

/**
 * Exact documented GET reads whose resource names contain mutation-like words (Meta's account value rule sets, TikTok's
 * catalog and authorization status reads, LinkedIn's share-authorization check). Each provider declares its own in its
 * adapter's read classification (ARC-01 phase B, src/<provider>-adapter.ts); this only establishes HTTP semantics,
 * and credentials and object scope are separate.
 */
export function qualifiedProviderRead(p: CompiledRequest): boolean {
  if (!p.readOnly || p.method !== 'GET' || p.specialTransport || p.body !== undefined) return false;
  return providerHooks(p.gateway)?.reads?.qualifiedRead?.(p) === true;
}
/**
 * Authorizes a qualified read for the bound account through its provider's adapter: true when it is in scope, false
 * when ScopeGuard's other checks decide (a Meta value rule set read is bound by its fixed act_ path), or a refusal.
 */
export function authorizeQualifiedProviderRead(p: CompiledRequest, c: Connection, account: string): boolean {
  if (!qualifiedProviderRead(p)) return false;
  return providerHooks(p.gateway)?.reads?.authorizeQualifiedRead?.(p, c, account) === true;
}

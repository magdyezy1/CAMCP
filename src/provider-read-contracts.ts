import type {CompiledRequest} from './types.js';
import {plainGetRead} from './provider-adapter.js';
import {providerHooks} from './provider-hooks.js';

/**
 * Exact documented GET reads whose resource names contain mutation-like words (Meta's account value rule sets, TikTok's
 * catalog and authorization status reads, LinkedIn's share-authorization check). Each provider declares its own in its
 * adapter's read classification (ARC-01 phase B, src/<provider>-adapter.ts); this only establishes HTTP semantics,
 * and credentials and object scope are separate: the TikTok and LinkedIn reads are authorized by their read
 * authorizers (ScopeGuard), a Meta value rule set read by its fixed act_ path.
 */
export function qualifiedProviderRead(p: CompiledRequest): boolean {
  if (!plainGetRead(p)) return false;
  return providerHooks(p.gateway)?.reads?.qualifiedRead?.(p) === true;
}

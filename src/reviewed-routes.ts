import type {CompiledRequest} from './types.js';
import {familyOf} from './reviewed-families.js';
import {providerOf} from './provider-adapters.js';

/** Route membership only. This never substitutes for assertWriteShape, scope,
 * prerequisites, spend policies, frozen review, provider receipts or read-back.
 * Both execution and the complete action ledger use this same declaration. */
export function reviewedWriteFamily(p: CompiledRequest): string | undefined {
  if (p.readOnly || p.specialTransport) return;
  // Every reviewed family is registered (reviewed-families.ts) except the generic entity writes of each platform, which
  // its provider adapter declares (entityWrites, src/provider-adapters.ts).
  const family = familyOf(p);
  if (family) return family.name;
  const entities = providerOf(p.gateway)?.entityWrites;
  return entities?.claims(p) ? entities.family : undefined;
}

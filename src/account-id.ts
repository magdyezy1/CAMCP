import {providerOf} from './provider-adapters.js';

/**
 * A provider account ID in the form AMCP binds and compares (ARC-04 stage B, ARC-01's account concern): each provider
 * adapter declares its own form (Meta without its `act_` prefix, Google Ads without dashes); every other provider's ID
 * is kept as given. A leaf over the leaf adapter registry, so family and provider modules normalize an account without
 * importing src/scope.ts, which imports the family registry; src/scope.ts re-exports it.
 */
export function normalizeAccount(gateway: string, id: unknown): string {
  const value = String(id);
  return providerOf(gateway)?.account?.normalize(value) ?? value;
}

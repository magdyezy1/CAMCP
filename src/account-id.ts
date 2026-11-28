import {providerOf} from './provider-adapters.js';
import type {JsonObject} from './types.js';

/**
 * A provider account ID in the form AMCP binds and compares (ARC-04 stage B, ARC-01's account concern): each provider
 * adapter declares its own form (Meta without its `act_` prefix, Google Ads without dashes); every other provider's ID
 * is kept as given. A leaf over the leaf adapter registry, so family and provider modules normalize an account without
 * importing src/scope.ts, which imports the family registry; src/scope.ts re-exports it.
 */
export function normalizeAccount(gateway: string, id: unknown): string {
  const value = String(id);
  return providerOf(gateway)?.account?.normalize?.(value) ?? value;
}
/**
 * The read that lists the accounts the caller's connections grant to one provider (amcp_platform_workspace list_accounts: AMCP's own
 * records within the caller's client access set, no provider request). The call a refusal names when it cannot tell which account is
 * meant, whether the request named none or the provider's own list of accounts is not something AMCP sends (r25-fr-meta-reads A6).
 * The filter is the provider's own ID, which list_accounts takes for every provider (r25-field2-access, B5).
 */
export function accountListCall(gateway: string): JsonObject {
  const platform = providerOf(gateway)?.id;
  return {
    tool: 'amcp_platform_workspace',
    arguments: {operation: 'list_accounts', arguments: platform ? {platform} : {}},
  };
}
/**
 * Whether a native request's own account field names the call's account (R25 M0, owner 2026-11-15, error 11 of the live
 * checks): the string the provider documents, or the number whose decimal digits are that string, which an agent writes
 * when it types an ID as JSON. Both are compared in the form the provider binds (`normalizeAccount`). A number counts
 * only as a safe integer: a larger one has already lost digits and names no ID. Anything else (a boolean, an object, a
 * list, a fraction, another string) is another account. A provider that compiles its own requests (Microsoft's
 * `compile.own`, which the shared alias check in src/compiler.ts never sees) asks this instead of comparing with `!==`.
 */
export function sameNativeAccount(gateway: string, field: unknown, accountId: string): boolean {
  const text =
    typeof field === 'string'
      ? field
      : typeof field === 'number' && Number.isSafeInteger(field)
        ? String(field)
        : undefined;
  return text !== undefined && normalizeAccount(gateway, text) === normalizeAccount(gateway, accountId);
}
/**
 * The details of the refusal of a request that names an advertiser or account that is not the call's (R25 M0, review S3-2): with
 * `account_conflict`, errorRemedy (src/errors.ts) says the request is at fault and no grant is involved. A request that names
 * none is not in conflict, so its refusal keeps the details it had and its remedy never says to leave out what AMCP does not fill.
 */
export function accountConflict(named: unknown): JsonObject {
  return named === undefined || named === null || named === '' ? {} : {account_conflict: true};
}

import {MirrorError} from './errors.js';
import {providerById, providerOf, retiredActionProviders} from './provider-adapters.js';
import type {CompiledRequest} from './types.js';

/** Official withdrawal overrides a historical catalog or Discovery mapping.
 * Keep these entries discoverable; never turn them into executable contracts. Each provider declares its rows
 * (`retired`, ARC-01 wave 4c round 6: src/provider-adapters.ts); they are listed in the order that registry declares,
 * each a plain row that names its provider's gateway first, as this table always held them. */
export const retiredProviderActions: {
  gateway: string;
  action: string;
  method: string;
  path: RegExp;
  source: string;
  updated: string;
  reason?: string;
  replacement?: string;
  checked?: string;
}[] = retiredActionProviders.flatMap(({gateway, retired}) =>
  (retired!.actions ?? []).map(row => ({gateway, ...structuredClone(row)})),
);
/** The catalog actions whose Google Ads method v25 removed; tools/fetch-vendor-specs.mjs keeps the same list. */
const googleAds = providerById('google')!.gateway;
export const retiredGoogleAdsActions = retiredProviderActions.filter(r => r.gateway === googleAds).map(r => r.action);
export const retiredProviderAction = (p: CompiledRequest) =>
  retiredProviderActions.find(r => r.gateway === p.gateway && r.method === p.method && r.path.test(p.path));
/** Legacy names that do not correspond to an operation of the current provider version: captured aliases that never
 * did, and aliases whose operation a newer version removed. Match the alias, not its shared route. */
export const unsupportedProviderAliases: {
  gateway: string;
  action: string;
  version: string;
  source: string;
  checked_at: string;
  reason: string;
  replacement: string;
}[] = retiredActionProviders.flatMap(({gateway, retired}) =>
  (retired!.aliases ?? []).map(row => ({gateway, ...structuredClone(row)})),
);
export const unsupportedProviderAlias = (gateway: string, action: string) =>
  unsupportedProviderAliases.find(r => r.gateway === gateway && r.action === action);
export function assertProviderAliasAvailable(gateway: string, action: string): void {
  const unavailable = unsupportedProviderAlias(gateway, action);
  if (unavailable) throw new MirrorError('PROVIDER_ACTION_UNSUPPORTED', unavailable.reason, unavailable);
}
export function assertProviderActionAvailable(p: CompiledRequest): void {
  assertProviderAliasAvailable(p.gateway, p.action);
  const retired = retiredProviderAction(p);
  if (retired) {
    // What its provider says where the row says nothing (src/provider-adapters.ts checks at load that one of them does).
    const own = providerOf(retired.gateway)!.retired!;
    throw new MirrorError('PROVIDER_ACTION_UNSUPPORTED', (retired.reason ?? own.reason)!, {
      action: retired.action,
      source: retired.source,
      documentation_updated: retired.updated,
      checked_at: retired.checked ?? own.checked,
      replacement: retired.replacement ?? own.replacement,
    });
  }
}

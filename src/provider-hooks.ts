import type {ProviderHooks} from './provider-adapter.js';
import {providerOf} from './provider-adapters.js';
import {googleAdsHooks} from './google-ads-adapter.js';
import {googleBusinessHooks} from './google-business-adapter.js';
import {metaHooks} from './meta-adapter.js';
import {tiktokHooks} from './tiktok-adapter.js';
import {snapchatHooks} from './snapchat-adapter.js';
import {linkedinHooks} from './linkedin-adapter.js';
import {xHooks} from './x-adapter.js';
import {microsoftHooks} from './microsoft-adapter.js';
import {appleHooks} from './apple-adapter.js';
import {redditHooks} from './reddit-adapter.js';
import {dv360Hooks} from './dv360-adapter.js';
import {ga4Hooks} from './ga4-adapter.js';
import {gtmHooks} from './gtm-adapter.js';
import {searchConsoleHooks} from './google-search-console-adapter.js';
import {criteoHooks} from './criteo-adapter.js';
import {adjustHooks} from './adjust-adapter.js';
import {amazonHooks} from './amazon-adapter.js';

/**
 * The provider hooks registry (ARC-01 phase B): each provider's behaviour that needs its own modules, from its adapter
 * module (src/<provider>-adapter.ts), by gateway. The leaf registry (src/provider-adapters.ts) holds the facts any
 * module may read; these hooks call provider modules, so the shared modules above them consult this registry instead
 * of importing those modules, and no provider module imports it (that would be an import cycle; the architecture
 * ratchet, tools/architecture-map.mjs, counts this registry with the providers). A hook only supplies a provider fact
 * to the shared stage that asks for it: the stage keeps every rule and decides.
 */
export const registeredProviderHooks: readonly ProviderHooks[] = Object.freeze([
  googleAdsHooks,
  googleBusinessHooks,
  metaHooks,
  tiktokHooks,
  snapchatHooks,
  linkedinHooks,
  xHooks,
  microsoftHooks,
  appleHooks,
  redditHooks,
  dv360Hooks,
  ga4Hooks,
  gtmHooks,
  searchConsoleHooks,
  criteoHooks,
  adjustHooks,
  amazonHooks,
]);

const byGateway = new Map<string, ProviderHooks>(),
  authorizerNames = new Set<string>();
for (const hooks of registeredProviderHooks) {
  // A load-time check, like a family declaration's: hooks belong to exactly one provider adapter.
  if (!providerOf(hooks.gateway)) throw new Error('Provider hooks name no provider adapter: ' + hooks.gateway + '.');
  if (byGateway.has(hooks.gateway)) throw new Error('Two provider hooks name ' + hooks.gateway + '.');
  // A readiness read of a provider's own is accepted only when its response names exactly the selected resource.
  if (!hooks.accountRead?.readiness !== !hooks.accountRead?.names)
    throw new Error('Provider hooks of ' + hooks.gateway + ' declare a readiness read without its identity check.');
  // Read authorizers are named once, frozen, and consulted at one of ScopeGuard's two stages.
  for (const authorizer of hooks.scope?.authorizers ?? [])
    if (
      !Object.isFrozen(authorizer) ||
      !['before_families', 'after_families'].includes(authorizer.stage) ||
      authorizerNames.has(authorizer.name)
    )
      throw new Error(
        'Read authorizer ' + authorizer.name + ' of ' + hooks.gateway + ' is not one frozen, staged name.',
      );
    else authorizerNames.add(authorizer.name);
  byGateway.set(hooks.gateway, hooks);
}

/** The hooks of a gateway's provider, or undefined for AMCP's own tools, unknown names and providers without hooks. */
export function providerHooks(gateway: unknown): ProviderHooks | undefined {
  return typeof gateway === 'string' ? byGateway.get(gateway) : undefined;
}

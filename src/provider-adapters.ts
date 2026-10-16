import type {ParkedReason, ProviderAdapter, ProviderParking, ProviderStatus} from './provider-adapter.js';

/**
 * The provider adapter registry (ARC-01): one adapter per provider gateway, each with its lifecycle status. This module
 * is a leaf: it imports no provider module and no lifecycle module, so any module may consult it without joining an
 * import cycle (tools/architecture-map.mjs).
 *
 * A parked provider is not offered unless the deployment's AMCP_PROVIDERS (a comma- or space-separated list of
 * provider IDs) names it: it is not listed in tools/list, contracts, capabilities or the website, any tool call that
 * names its gateway is refused with GATEWAY_NOT_OFFERED before its arguments are read, and ScopeGuard refuses every
 * request to it before credentials are fetched. Its code keeps compiling and its tests keep running with the provider
 * named in AMCP_PROVIDERS. AMCP_PROVIDERS is read at each check, so a process sees one value from its environment.
 */
function adapter(
  id: string,
  gateway: string,
  options: {families?: readonly string[]; parked?: ProviderParking} = {},
): ProviderAdapter {
  const status: ProviderStatus = options.parked ? 'parked' : 'active';
  return Object.freeze({
    id,
    gateway,
    status,
    ...(options.parked ? {parked: Object.freeze({...options.parked})} : {}),
    familyPrefixes: Object.freeze([...(options.families ?? [id + '_'])]),
  });
}

export const providerAdapters: readonly ProviderAdapter[] = Object.freeze([
  adapter('google', 'google_ads_native_action'),
  adapter('google_business', 'google_business_native_action'),
  adapter('meta', 'meta_native_action'),
  adapter('tiktok', 'tiktok_native_action'),
  adapter('snapchat', 'snapchat_native_action'),
  adapter('linkedin', 'linkedin_native_action'),
  adapter('x', 'x_ads_native_action'),
  adapter('microsoft', 'microsoft_ads_native_action'),
  adapter('apple', 'apple_ads_native_action'),
  adapter('reddit', 'reddit_native_action'),
  adapter('dv360', 'dv360_native_action'),
  adapter('ga4', 'ga4_native_action'),
  adapter('gtm', 'gtm_native_action'),
  adapter('gsc', 'google_search_console_native_action', {families: ['search_console_']}),
  adapter('adjust', 'adjust_native_action'),
  adapter('drive', 'google_drive_native_action'),
  adapter('sheets', 'google_sheets_native_action'),
  adapter('criteo', 'criteo_native_action'),
  adapter('woocommerce', 'commerce_native_action'),
  adapter('amazon', 'amazon_native_action', {
    parked: {reason: 'unimplemented', decision: 'CON-06 option (b), docs/DECISIONS.md'},
  }),
]);

const byGateway = new Map(providerAdapters.map(a => [a.gateway, a]));
const byId = new Map(providerAdapters.map(a => [a.id, a]));

/** The adapter of a gateway tool name, or undefined for AMCP's own tools and unknown names. */
export function providerOf(gateway: unknown): ProviderAdapter | undefined {
  return typeof gateway === 'string' ? byGateway.get(gateway) : undefined;
}

export function providerById(id: string): ProviderAdapter | undefined {
  return byId.get(id);
}

/** The provider IDs AMCP_PROVIDERS names. */
export function namedProviders(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return new Set((env.AMCP_PROVIDERS ?? '').split(/[\s,]+/).filter(Boolean));
}

/** Names in AMCP_PROVIDERS that are no provider ID (a misspelt one offers nothing); startup reports them. */
export function unknownProviderIds(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...namedProviders(env)].filter(id => !byId.has(id)).sort();
}

/** True unless the gateway belongs to a parked provider that AMCP_PROVIDERS does not name. */
export function providerOffered(provider: ProviderAdapter | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return !provider || provider.status === 'active' || namedProviders(env).has(provider.id);
}

/** The adapter whose family prefix is the longest prefix of a reviewed family's name. */
export function familyProvider(family: string): ProviderAdapter | undefined {
  let found: ProviderAdapter | undefined,
    length = 0;
  for (const provider of providerAdapters)
    for (const prefix of provider.familyPrefixes)
      if (family.startsWith(prefix) && prefix.length > length) [found, length] = [provider, prefix.length];
  return found;
}

/** Whether a reviewed family's provider is offered: a parked provider's families are not registered for offering. */
export function familyOffered(family: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return providerOffered(familyProvider(family), env);
}

/** The IDs of parked providers, offered or not (tools/provider-lifecycle.ts does not watch their pages). */
export function parkedProviderIds(): ReadonlySet<string> {
  return new Set(providerAdapters.filter(a => a.status === 'parked').map(a => a.id));
}

export interface ProviderLifecycleEntry {
  provider: string;
  gateway: string;
  status: ProviderStatus;
  reason?: ParkedReason;
  offered: boolean;
}

/** Every provider's lifecycle status and whether this deployment offers it. */
export function providerLifecycle(env: NodeJS.ProcessEnv = process.env): ProviderLifecycleEntry[] {
  return providerAdapters.map(a => ({
    provider: a.id,
    gateway: a.gateway,
    status: a.status,
    ...(a.parked ? {reason: a.parked.reason} : {}),
    offered: providerOffered(a, env),
  }));
}

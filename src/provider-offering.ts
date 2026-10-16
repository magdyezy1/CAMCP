import {MirrorError} from './errors.js';
import {providerOf, providerOffered} from './provider-adapters.js';

/**
 * Whether this deployment offers a provider gateway, from its lifecycle status in the provider adapter registry
 * (ARC-01, src/provider-adapters.ts). Amazon Ads is parked as unimplemented (CON-06, owner decision: option b): it has
 * no website login, profile discovery or implementation modules beyond request routing, so it is not listed in
 * tools/list or on website pages, and a call is refused before anything is read. AMCP_PROVIDERS, a comma-separated
 * list of provider IDs, offers a parked provider again (for an operator-provisioned connection).
 */
export function gatewayOffered(gateway: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return providerOffered(providerOf(gateway), env);
}

/** Refuses a gateway this deployment does not offer, naming its provider and why it is parked. */
export function assertGatewayOffered(gateway: unknown, env: NodeJS.ProcessEnv = process.env): void {
  const provider = providerOf(gateway);
  if (!provider?.parked || providerOffered(provider, env)) return;
  const details = {gateway: provider.gateway, provider: provider.id, status: 'parked', reason: provider.parked.reason};
  if (provider.parked.reason === 'owner_parked')
    throw new MirrorError(
      'GATEWAY_NOT_OFFERED',
      'This deployment does not offer this provider: its work is parked. Nothing was sent.',
      details,
      404,
    );
  throw new MirrorError(
    'GATEWAY_NOT_OFFERED',
    'This deployment does not offer this provider: it has no website connection or account discovery yet. Nothing was sent.',
    details,
    404,
  );
}

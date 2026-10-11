import {MirrorError} from './errors.js';

/**
 * Providers this deployment does not offer (CON-06, owner decision: Amazon Ads option b). Amazon Ads has no website
 * login, profile discovery or implementation modules beyond request routing, so its gateway is out of scope until that
 * onboarding exists: it is not listed in tools/list or on website pages, and a call is refused before anything is read.
 * AMCP_PROVIDERS, a comma-separated list of provider IDs, offers one again (for an operator-provisioned connection).
 * This is the standalone variant of ARC-01's provider lifecycle status, which keeps the same switch.
 */
const notOffered: Readonly<Record<string, string>> = {amazon_native_action: 'amazon'};

export function gatewayOffered(gateway: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  const provider = typeof gateway === 'string' && Object.hasOwn(notOffered, gateway) ? notOffered[gateway] : undefined;
  return !provider || (env.AMCP_PROVIDERS ?? '').split(/[\s,]+/).includes(provider);
}

export function assertGatewayOffered(gateway: unknown, env: NodeJS.ProcessEnv = process.env): void {
  if (!gatewayOffered(gateway, env))
    throw new MirrorError(
      'GATEWAY_NOT_OFFERED',
      'This deployment does not offer this provider: it has no website connection or account discovery yet. Nothing was sent.',
      {gateway: String(gateway)},
      404,
    );
}

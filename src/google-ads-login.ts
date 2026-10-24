import type {DiscoveryContext, ProviderLogin} from './provider-login.js';
import {googleAccountDiscovery} from './google-account-discovery.js';

/**
 * Google Ads' website login steps (ARC-01 phase B; registered in src/provider-logins.ts). Discovery: every account
 * beneath each directly accessible root, each with its manager route (src/google-account-discovery.ts), read through
 * the stage's transport with the stage's login check.
 */
export const googleAdsLogin: ProviderLogin = Object.freeze({
  gateway: 'google_ads_native_action',
  discovery: Object.freeze({
    kind: (_kind: string, c: DiscoveryContext) =>
      googleAccountDiscovery(c.transport, c.connection, c.credentials, c.check),
  }),
});

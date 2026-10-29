import type {DiscoveryContext, ProviderLogin, WorkspaceAsset} from './provider-login.js';
import type {Credentials} from './types.js';
import {googleAccountDiscovery, googleSelectedAccountRead} from './google-account-discovery.js';
import {googleOAuth} from './google-oauth.js';

/**
 * Google Ads' website login steps (ARC-01 phase B; registered in src/provider-logins.ts). OAuth: Google's steps
 * (src/google-oauth.ts); a first authorization's state also binds the OAuth client, which a renewal compares, and the
 * login keeps the deployment's developer token. Discovery: every account beneath each directly accessible root, each
 * with its manager route (src/google-account-discovery.ts), read through the stage's transport with the stage's login
 * check. Renewal (server/google-reauthorization.ts): the same hierarchy, then the read of each selected account the
 * hierarchy did not verify.
 */
export const googleAdsLogin: ProviderLogin = Object.freeze({
  gateway: 'google_ads_native_action',
  oauth: Object.freeze({
    ...googleOAuth,
    bindsClient: true,
    // A website login reaches each account through the manager route its discovery recorded (accountLoginCustomers);
    // the deployment-wide AMCP_GOOGLE_LOGIN_CUSTOMER_ID is no longer copied into every user's login (CON-05).
    credentials(credentials: Credentials, {env}: {env: NodeJS.ProcessEnv}) {
      credentials.developerToken = env.AMCP_GOOGLE_DEVELOPER_TOKEN;
    },
  } as const),
  discovery: Object.freeze({
    kind: (_kind: string, c: DiscoveryContext) =>
      googleAccountDiscovery(c.transport, c.connection, c.credentials, c.check),
  }),
  renewal: Object.freeze({accounts: googleAccountDiscovery, selectedAccountRead: googleSelectedAccountRead}),
  // The manager route of each selected account its hierarchy recorded (accountLoginCustomers); an account its
  // discovery reached without one keeps none.
  routes: (assets: readonly WorkspaceAsset[], accounts: readonly string[]) =>
    Object.fromEntries(
      assets.filter(a => accounts.includes(a.id) && a.loginCustomerId).map(a => [a.id, a.loginCustomerId!]),
    ),
});

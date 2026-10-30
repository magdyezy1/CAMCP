import type {DiscoveryContext, OAuthContext, ProviderLogin, WorkspaceAsset} from './provider-login.js';
import type {Credentials} from './types.js';
import {MirrorError} from './errors.js';
import {requestAppleAccessToken} from './apple-auth.js';

/**
 * Apple Ads' website login steps (ARC-01 phase B; registered in src/provider-logins.ts). OAuth: a server-owned API
 * connection with the client credentials grant, in place of a browser authorization: the deployment's signing key
 * stands in for a client secret, and its scope is Apple's own. Discovery: the ad accounts the API user's ACLs name,
 * each with its roles and organization.
 */
async function appleDiscovery(kind: string, c: DiscoveryContext): Promise<WorkspaceAsset[]> {
  const rows = await c.pages('/v1/acls', {}, d => d.result?.acls, 'https://api.ads.apple.com');
  return rows.map(row => {
    const account = row.adAccount,
      id = account?.id;
    if (
      (typeof id !== 'string' && typeof id !== 'number') ||
      !/^\d+$/.test(String(id)) ||
      !Array.isArray(row.roles) ||
      row.roles.some((role: unknown) => typeof role !== 'string')
    )
      throw new MirrorError('ASSET_ID_INVALID', 'Apple Ads returned an invalid ad-account ACL.', {}, 502);
    return c.asset(
      {id, name: account.name, status: row.roles.join(', ')},
      kind,
      account.orgId === undefined ? undefined : String(account.orgId),
    );
  });
}

/** The server-side connection: Apple's access token for the deployment's client, signed with its key. */
async function appleConnect(
  c: OAuthContext & {readonly configured: boolean; readonly scopes: readonly string[]; readonly fetcher: typeof fetch},
): Promise<{credentials: Credentials; label: string; scopes: string[]}> {
  if (!c.configured)
    throw new MirrorError(
      'PROVIDER_SETUP_REQUIRED',
      'Configure Apple Ads API credentials in Railway before connecting.',
      {},
      409,
    );
  const credentials = await requestAppleAccessToken(
    {
      clientId: c.clientId,
      clientSecret: c.clientSecret,
      appleTeamId: c.env.AMCP_APPLE_TEAM_ID,
      appleKeyId: c.env.AMCP_APPLE_KEY_ID,
      applePrivateKey: c.env.AMCP_APPLE_PRIVATE_KEY,
    },
    c.fetcher,
  );
  return {credentials, label: 'Apple Ads API login', scopes: [...c.scopes]};
}

export const appleLogin: ProviderLogin = Object.freeze({
  gateway: 'apple_ads_native_action',
  oauth: Object.freeze({
    authorize: '',
    token: 'https://appleid.apple.com/auth/oauth2/token',
    serviceKey: (env: NodeJS.ProcessEnv) =>
      !!(env.AMCP_APPLE_TEAM_ID && env.AMCP_APPLE_KEY_ID && env.AMCP_APPLE_PRIVATE_KEY),
    fixedScopes: true,
    connect: appleConnect,
  } as const),
  discovery: Object.freeze({kind: appleDiscovery}),
});

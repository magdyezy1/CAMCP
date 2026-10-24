import type {DiscoveryContext, ProviderLogin, WorkspaceAsset} from './provider-login.js';
import {MirrorError} from './errors.js';

/**
 * Apple Ads' website login steps (ARC-01 phase B; registered in src/provider-logins.ts). Discovery: the ad accounts
 * the API user's ACLs name, each with its roles and organization.
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

export const appleLogin: ProviderLogin = Object.freeze({
  gateway: 'apple_ads_native_action',
  discovery: Object.freeze({kind: appleDiscovery}),
});

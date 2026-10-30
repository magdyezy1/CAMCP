import type {AssetGroup, DiscoveryContext, ProviderLogin, WorkspaceAsset} from './provider-login.js';
import {MirrorError} from './errors.js';
import {collectBusinessAssets, type BusinessAsset} from './google-business-assets.js';
import {googleOAuth} from './google-oauth.js';

/**
 * Business Profile's website login steps (ARC-01 phase B; registered in src/provider-logins.ts). Discovery (CON-06):
 * one bounded pass lists the business accounts and, unless only accounts are asked for, their locations, with the
 * collector the MCP sync_assets workflow uses. Neither listing grants access. It authorizes with Google's OAuth steps
 * (src/google-oauth.ts), with the shared Google client once the owner declares the project's API approval
 * (src/app-credentials.ts).
 */
async function businessDiscovery(selected: readonly string[], c: DiscoveryContext): Promise<AssetGroup[]> {
  const groups: AssetGroup[] = [],
    includeLocations = selected.includes('locations');
  try {
    const found = await collectBusinessAssets(c.read, {
        includeLocations,
        maxAccounts: 100,
        maxLocationsPerAccount: 500,
        deadline: performance.now() + 60000,
      }),
      asset = (a: BusinessAsset): WorkspaceAsset => ({
        id: a.id,
        kind: a.kind,
        name: a.name,
        ...(a.parentIds?.length ? {parentId: a.parentIds[0]} : {}),
        ...(a.role ? {status: a.role} : {}),
        source: 'vendor',
      });
    groups.push({kind: 'business_accounts', assets: found.accounts.map(asset), complete: true});
    if (includeLocations) groups.push({kind: 'locations', assets: found.locations.map(asset), complete: true});
  } catch (e) {
    for (const kind of includeLocations ? ['business_accounts', 'locations'] : ['business_accounts']) {
      const group = c.failure(kind, e);
      // Google's own text names a quota; the owner needs to know the project is not approved (CON-06).
      if (e instanceof MirrorError && e.code === 'BUSINESS_PROFILE_API_NOT_APPROVED')
        group.error =
          'Google has not approved this AMCP project for the Business Profile APIs yet (a quota of 0 requests per minute). The AMCP owner must request access; reconnecting will not help.';
      groups.push(group);
    }
  }
  return groups;
}

export const googleBusinessLogin: ProviderLogin = Object.freeze({
  gateway: 'google_business_native_action',
  oauth: googleOAuth,
  discovery: Object.freeze({all: businessDiscovery}),
});

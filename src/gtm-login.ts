import type {DiscoveryContext, ProviderLogin, WorkspaceAsset} from './provider-login.js';
import {MirrorError} from './errors.js';
import {googleOAuth} from './google-oauth.js';

/**
 * Google Tag Manager's website login steps (ARC-01 phase B; registered in src/provider-logins.ts). Discovery: the
 * login's Tag Manager accounts, and the containers of the selected accounts with their public and Google tag IDs. It
 * authorizes with Google's OAuth steps (src/google-oauth.ts), by default with the shared Google client.
 */
async function gtmDiscovery(kind: string, c: DiscoveryContext): Promise<WorkspaceAsset[]> {
  if (kind === 'tag_accounts') {
    const rows = await c.pages('/tagmanager/v2/accounts', {includeGoogleTags: true}, d => d.account ?? []);
    return rows.map(row => {
      if (typeof row.accountId !== 'string' || !/^\d+$/.test(row.accountId))
        throw new MirrorError('ASSET_ID_INVALID', 'Tag Manager returned an invalid account identifier.', {}, 502);
      return c.asset({id: row.accountId, name: row.name}, kind);
    });
  }
  const assets: WorkspaceAsset[] = [];
  if (!c.connection.accounts.length)
    throw new MirrorError(
      'SELECT_ACCOUNT_FIRST',
      'Select Tag Manager accounts before syncing their containers.',
      {},
      409,
    );
  for (const id of c.connection.accounts) {
    if (!/^\d+$/.test(id))
      throw new MirrorError('ASSET_ID_INVALID', 'Tag Manager account identifiers must be numeric.', {}, 400);
    const rows = await c.pages('/tagmanager/v2/accounts/' + id + '/containers', {}, d => d.container ?? []);
    for (const row of rows) {
      if (row.accountId !== id || typeof row.containerId !== 'string' || !/^\d+$/.test(row.containerId))
        throw new MirrorError(
          'ASSET_ID_INVALID',
          'Tag Manager returned a container outside the selected account.',
          {},
          502,
        );
      // MSR-03: the container's public ID and the Google tag IDs that refer to it, when well formed.
      const tagIds = Array.isArray(row.tagIds)
        ? [...new Set(row.tagIds)]
            .filter((v): v is string => typeof v === 'string' && /^[A-Z]{1,4}-[A-Z0-9-]{3,40}$/.test(v))
            .slice(0, 100)
        : [];
      assets.push({
        ...c.asset({id: 'accounts/' + id + '/containers/' + row.containerId, name: row.name ?? row.publicId}, kind, id),
        ...(typeof row.publicId === 'string' && /^[A-Z]{1,4}-[A-Z0-9-]{3,40}$/.test(row.publicId)
          ? {publicId: row.publicId}
          : {}),
        ...(tagIds.length ? {tagIds} : {}),
      });
    }
  }
  return assets;
}

export const gtmLogin: ProviderLogin = Object.freeze({
  gateway: 'gtm_native_action',
  oauth: googleOAuth,
  discovery: Object.freeze({kind: gtmDiscovery}),
});

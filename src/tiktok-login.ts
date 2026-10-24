import type {DiscoveryContext, ProviderLogin, WorkspaceAsset} from './provider-login.js';
import type {JsonObject} from './types.js';
import {MirrorError} from './errors.js';

/**
 * TikTok's website login steps (ARC-01 phase B; registered in src/provider-logins.ts). Discovery: the advertisers the
 * authorization reaches (a read with the app's credentials), and the pixels or identities of the selected advertisers,
 * which must fit one page.
 */
async function tiktokDiscovery(kind: string, c: DiscoveryContext): Promise<WorkspaceAsset[]> {
  if (kind === 'ad_accounts') {
    if (!c.credentials.clientId || !c.credentials.clientSecret)
      throw new MirrorError(
        'PROVIDER_SETUP_REQUIRED',
        'TikTok account discovery requires its app credentials.',
        {},
        409,
      );
    const result = await c.request(
        c.plan('/v1.3/oauth2/advertiser/get/', {app_id: c.credentials.clientId, secret: c.credentials.clientSecret}),
      ),
      rows = (result.data as JsonObject).data?.list;
    if (!Array.isArray(rows))
      throw new MirrorError('ASSET_RESPONSE_INVALID', 'TikTok did not return an advertiser list.', {}, 502);
    return rows.map((r: JsonObject) => c.asset(r, kind));
  }
  const assets: WorkspaceAsset[] = [];
  if (!c.connection.accounts.length)
    throw new MirrorError('SELECT_ACCOUNT_FIRST', 'Select an advertiser before syncing its assets.', {}, 409);
  for (const id of c.connection.accounts) {
    const result = await c.request(
        c.plan(kind === 'pixels' ? '/v1.3/pixel/list/' : '/v1.3/identity/get/', {
          advertiser_id: id,
          page: 1,
          page_size: 100,
        }),
      ),
      data = (result.data as JsonObject).data,
      rows = data?.pixels ?? data?.identity_list ?? data?.list;
    if (!Array.isArray(rows))
      throw new MirrorError('ASSET_RESPONSE_INVALID', 'TikTok did not return the requested assets.', {}, 502);
    if (data.page_info?.total_page > 1)
      throw new MirrorError('ASSET_SYNC_LIMIT', 'This TikTok asset list requires further pagination.', {}, 409);
    assets.push(
      ...rows.map((r: JsonObject) =>
        c.asset(
          {...r, id: r.pixel_id ?? r.identity_id ?? r.id, name: r.pixel_name ?? r.display_name ?? r.name},
          kind,
          id,
        ),
      ),
    );
  }
  return assets;
}

export const tiktokLogin: ProviderLogin = Object.freeze({
  gateway: 'tiktok_native_action',
  discovery: Object.freeze({kind: tiktokDiscovery}),
});

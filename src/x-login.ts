import type {DiscoveryContext, ProviderLogin, WorkspaceAsset} from './provider-login.js';
import {MirrorError} from './errors.js';

/**
 * X Ads' website login steps (ARC-01 phase B; registered in src/provider-logins.ts). Discovery: the login's ad
 * accounts, and the promotable users, website tags or app lists of the selected accounts.
 */
async function xDiscovery(kind: string, c: DiscoveryContext): Promise<WorkspaceAsset[]> {
  if (kind === 'ad_accounts')
    return (await c.pages('/12/accounts', {count: 200}, d => d.data)).map(r => c.asset(r, kind));
  const assets: WorkspaceAsset[] = [];
  if (!c.connection.accounts.length)
    throw new MirrorError('SELECT_ACCOUNT_FIRST', 'Select an ad account before syncing its assets.', {}, 409);
  const edge = kind === 'profiles' ? 'promotable_users' : kind === 'pixels' ? 'website_tags' : 'app_lists';
  for (const id of c.connection.accounts) {
    const rows = await c.pages('/12/accounts/' + encodeURIComponent(id) + '/' + edge, {count: 200}, d => d.data);
    assets.push(...rows.map(r => c.asset({...r, id: r.id ?? r.user_id, name: r.name ?? r.screen_name}, kind, id)));
  }
  return assets;
}

export const xLogin: ProviderLogin = Object.freeze({
  gateway: 'x_ads_native_action',
  discovery: Object.freeze({kind: xDiscovery}),
});

import type {DiscoveryContext, ProviderLogin, WorkspaceAsset} from './provider-login.js';
import {MirrorError} from './errors.js';
import {collectMeasurementAssets} from './google-measurement-assets.js';
import {googleOAuth} from './google-oauth.js';

/**
 * Search Console's website login steps (ARC-01 phase B; registered in src/provider-logins.ts). Discovery: the login's
 * verified sites, with the collector the MCP sync_assets workflow uses, and the sitemaps of the selected sites. It
 * authorizes with Google's OAuth steps (src/google-oauth.ts), by default with the shared Google client.
 */

/** A selected site as Search Console names it: a domain property (sc-domain:) or a URL prefix without credentials. */
function validSearchConsoleSite(value: string): boolean {
  if (value.startsWith('sc-domain:')) {
    const domain = value.slice(10);
    return domain.length > 0 && domain.length <= 253 && /^[a-z0-9.-]+$/i.test(domain) && !domain.includes('..');
  }
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}
async function searchConsoleDiscovery(kind: string, c: DiscoveryContext): Promise<WorkspaceAsset[]> {
  if (kind === 'sites')
    return (await collectMeasurementAssets(c.connection.gateway, c.read, {deadline: performance.now() + 60000})).assets;
  const assets: WorkspaceAsset[] = [];
  if (!c.connection.accounts.length)
    throw new MirrorError(
      'SELECT_ACCOUNT_FIRST',
      'Select Search Console sites before syncing their sitemaps.',
      {},
      409,
    );
  for (const id of c.connection.accounts) {
    if (!validSearchConsoleSite(id))
      throw new MirrorError('ASSET_ID_INVALID', 'Search Console site identifier is invalid.', {}, 400);
    const rows = await c.pages(
      '/webmasters/v3/sites/' + encodeURIComponent(id) + '/sitemaps',
      {},
      d => d.sitemap ?? [],
      'https://www.googleapis.com',
    );
    for (const row of rows) {
      if (typeof row.path !== 'string' || !/^https?:\/\//.test(row.path))
        throw new MirrorError('ASSET_ID_INVALID', 'Search Console returned an invalid sitemap path.', {}, 502);
      assets.push(c.asset({id: row.path, name: row.path}, kind, id));
    }
  }
  return assets;
}

export const searchConsoleLogin: ProviderLogin = Object.freeze({
  gateway: 'google_search_console_native_action',
  oauth: googleOAuth,
  discovery: Object.freeze({kind: searchConsoleDiscovery}),
});

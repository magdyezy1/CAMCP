import type {DiscoveryContext, ProviderLogin, WorkspaceAsset} from './provider-login.js';
import type {JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {metaPrefix} from './meta-version.js';
import {metaPermissionGrants} from './meta-auth-diagnostic.js';

/**
 * Meta's website login steps (ARC-01 phase B; registered in src/provider-logins.ts). Discovery: the login's ad
 * accounts, with the user's name and ID and what Meta granted; its Pages and their Instagram accounts; and, for the
 * selected ad accounts, each account edge's pixels, catalogs, apps or custom conversions.
 */
async function metaDiscovery(kind: string, c: DiscoveryContext): Promise<WorkspaceAsset[]> {
  let assets: WorkspaceAsset[] = [];
  if (kind === 'ad_accounts') {
    assets = (
      await c.pages(
        metaPrefix + 'me/adaccounts',
        {fields: 'id,account_id,name,account_status,currency,timezone_name', limit: 100},
        d => d.data,
      )
    ).map(r => c.asset(r, kind));
    try {
      const identity = await c.request(c.plan(metaPrefix + 'me', {fields: 'id,name'}));
      if (typeof (identity.data as JsonObject).name === 'string') c.found.label = (identity.data as JsonObject).name;
      const id = (identity.data as JsonObject).id;
      if (typeof id === 'string' && /^[0-9]{1,32}$/.test(id)) c.found.identity = id;
    } catch {
      /* Account discovery remains valid when identity profile access is unavailable. */
    }
    // What Meta actually granted (CON-03): one read per connect, sync or renewal of the ad accounts. A failed or
    // unreadable answer records "unknown", never the requested permissions, and does not fail discovery.
    try {
      const permissions = await c.request(c.plan(metaPrefix + 'me/permissions', {limit: 100}));
      c.found.grants = metaPermissionGrants(permissions.data);
    } catch (e) {
      if (
        e instanceof MirrorError &&
        ['CONNECTION_CHANGED', 'CONNECTION_AUTHORITY_CHANGED', 'CONNECTION_NOT_FOUND', 'SIGN_IN_REQUIRED'].includes(
          e.code,
        )
      )
        throw e;
      c.found.grants = {
        source: 'permissions_endpoint',
        known: false,
        reason: e instanceof MirrorError ? e.code : 'PROVIDER_READ_FAILED',
        checked_at: Date.now(),
      };
    }
  } else if (kind === 'pages' || kind === 'instagram') {
    const rows = await c.pages(
      metaPrefix + 'me/accounts',
      {fields: 'id,name,instagram_business_account{id,username}', limit: 100},
      d => d.data,
    );
    assets =
      kind === 'pages'
        ? rows.map(r => c.asset(r, kind))
        : rows
            .filter(r => r.instagram_business_account)
            .map(r => c.asset(r.instagram_business_account, kind, String(r.id)));
  } else {
    if (!c.connection.accounts.length)
      throw new MirrorError('SELECT_ACCOUNT_FIRST', 'Select an ad account before syncing its assets.', {}, 409);
    const edge = {
      pixels: 'adspixels',
      catalogs: 'product_catalogs',
      mobile_apps: 'advertisable_applications',
      custom_conversions: 'customconversions',
    }[kind];
    for (const id of c.connection.accounts) {
      const rows = await c.pages(
        metaPrefix + 'act_' + encodeURIComponent(id) + '/' + edge,
        {fields: 'id,name', limit: 100},
        d => d.data,
      );
      assets.push(...rows.map(r => c.asset(r, kind, id)));
    }
  }
  return assets;
}

export const metaLogin: ProviderLogin = Object.freeze({
  gateway: 'meta_native_action',
  discovery: Object.freeze({kind: metaDiscovery}),
});

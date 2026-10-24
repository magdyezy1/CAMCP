import type {
  DiscoveryContext,
  OAuthContext,
  OAuthTokenRequest,
  ProviderLogin,
  WorkspaceAsset,
} from './provider-login.js';
import type {JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {metaDialogUrl, metaGraphUrl, metaPrefix} from './meta-version.js';
import {metaPermissionGrants} from './meta-auth-diagnostic.js';

/**
 * Meta's website login steps (ARC-01 phase B; registered in src/provider-logins.ts). OAuth: the versioned login dialog
 * and Graph token endpoint; its scopes are joined with commas, a renewal asks again for declined permissions and an
 * owner-set login configuration replaces the default response type; the code is exchanged with a GET, and the
 * short-lived token for a long-lived one unless AMCP_META_LONG_LIVED_TOKEN is false. Discovery: the login's ad
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

const metaToken = metaGraphUrl('oauth/access_token');
/** The long-lived token for the short-lived one the code gave; Meta's own lifetime is trusted, never an invented one. */
async function metaLongLived(result: JsonObject, c: OAuthContext & {assertActive(): void}): Promise<JsonObject> {
  if (c.env.AMCP_META_LONG_LIVED_TOKEN === 'false') return result;
  if (typeof result.access_token !== 'string' || !result.access_token)
    throw new MirrorError('OAUTH_RESPONSE_INVALID', 'Meta did not return a usable short-lived token.', {}, 502);
  const exchangeUrl = new URL(metaToken);
  exchangeUrl.search = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: c.clientId!,
    client_secret: c.clientSecret!,
    fb_exchange_token: result.access_token,
  }).toString();
  const extended = await c.readResponse(await c.send(exchangeUrl, {method: 'GET'}));
  c.assertActive();
  // Trust only the provider's actual lifetime; never invent a 60-day expiration.
  if (
    typeof extended.access_token !== 'string' ||
    !extended.access_token ||
    !Number.isFinite(Number(extended.expires_in)) ||
    Number(extended.expires_in) <= 0
  )
    throw new MirrorError(
      'OAUTH_RESPONSE_INVALID',
      'Meta did not return a valid long-lived token and lifetime.',
      {},
      502,
    );
  return {...result, ...extended};
}

export const metaLogin: ProviderLogin = Object.freeze({
  gateway: 'meta_native_action',
  oauth: Object.freeze({
    authorize: metaDialogUrl,
    token: metaToken,
    scopeSeparator: ',',
    authorizeParameters(
      parameters: URLSearchParams,
      {reauthorization, env}: {reauthorization: boolean; env: NodeJS.ProcessEnv},
    ) {
      // Meta asks again for permissions the user declined earlier only when the dialog is told to.
      if (reauthorization) parameters.set('auth_type', 'rerequest');
      if (env.AMCP_META_CONFIG_ID) {
        parameters.set('config_id', env.AMCP_META_CONFIG_ID);
        parameters.set('override_default_response_type', 'true');
      }
    },
    // The code is exchanged with a GET whose query is the form, without its grant type.
    tokenRequest(request: OAuthTokenRequest) {
      const form = request.body as URLSearchParams;
      form.delete('grant_type');
      request.url.search = form.toString();
      return {...request, method: 'GET', body: undefined};
    },
    extend: metaLongLived,
  }),
  discovery: Object.freeze({kind: metaDiscovery}),
});

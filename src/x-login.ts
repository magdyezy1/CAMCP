import type {DiscoveryContext, OAuthContext, OAuthExchange, ProviderLogin, WorkspaceAsset} from './provider-login.js';
import type {JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {signOAuth1} from './oauth1-authorization.js';

/**
 * X Ads' website login steps (ARC-01 phase B; registered in src/provider-logins.ts). OAuth: X authorizes with OAuth
 * 1.0a, in place of an authorization code: a request token for the access type the deployment allows, whose callback
 * carries the stage's state, and its access token for the returned verifier. Discovery: the login's ad accounts, and
 * the promotable users, website tags or app lists of the selected accounts.
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

const xAccessToken = 'https://api.x.com/oauth/access_token';
/** The temporary credential, for the access type the deployment allows, whose callback carries the stage's state. */
async function xRequestToken(c: OAuthContext & {readonly state: string}) {
  const requestedAccessType = c.allowWrites ? 'write' : 'read';
  const requestUrl = new URL('https://api.x.com/oauth/request_token');
  requestUrl.searchParams.set('x_auth_access_type', requestedAccessType);
  const callback = c.redirectUri + '?state=' + c.state;
  const auth = signOAuth1('POST', requestUrl, c.clientId!, c.clientSecret!, '', '', {oauth_callback: callback});
  const result = await c.readResponse(
    await c.send(requestUrl, {method: 'POST', headers: {Authorization: auth}}),
    'form',
  );
  if (
    result.oauth_callback_confirmed !== 'true' ||
    typeof result.oauth_token !== 'string' ||
    typeof result.oauth_token_secret !== 'string'
  )
    throw new MirrorError('OAUTH_RESPONSE_INVALID', 'X did not confirm the callback.', {}, 502);
  return {
    data: {requestedAccessType, requestToken: result.oauth_token, requestSecret: result.oauth_token_secret},
    parameters: {oauth_token: result.oauth_token},
  };
}
/** The access token for the verifier X returned with the request token the state keeps. */
async function xExchange(
  c: OAuthContext & {
    readonly stored: JsonObject;
    readonly query: Readonly<Record<string, string>>;
    assertActive(): void;
    label(name?: string): string;
  },
): Promise<OAuthExchange> {
  const {stored, query} = c;
  if (query.oauth_token !== stored.requestToken || !query.oauth_verifier)
    throw new MirrorError('OAUTH_TOKEN_MISMATCH', 'X returned a mismatched authorization token.', {}, 400);
  // X binds access to the original request token. Never replace that token or
  // request a new access type during exchange when deployment settings change.
  const url = new URL(xAccessToken),
    authorization = signOAuth1('POST', url, c.clientId!, c.clientSecret!, stored.requestToken, stored.requestSecret, {
      oauth_verifier: query.oauth_verifier,
    });
  const result = await c.readResponse(
    await c.send(url, {method: 'POST', headers: {Authorization: authorization}}),
    'form',
  );
  c.assertActive();
  if (typeof result.oauth_token !== 'string' || typeof result.oauth_token_secret !== 'string')
    throw new MirrorError('OAUTH_RESPONSE_INVALID', 'X did not return usable user credentials.', {}, 502);
  const screenName =
    typeof result.screen_name === 'string' && /^[A-Za-z0-9_]{1,50}$/.test(result.screen_name)
      ? '@' + result.screen_name
      : undefined;
  return {
    credentials: {
      consumerKey: c.clientId,
      consumerSecret: c.clientSecret,
      accessToken: result.oauth_token,
      tokenSecret: result.oauth_token_secret,
    },
    label: c.label(screenName),
    scopes: [],
    providerId: typeof result.user_id === 'string' && /^[0-9]{1,32}$/.test(result.user_id) ? result.user_id : undefined,
    ...(screenName ? {displayName: screenName} : {}),
    // OAuth 1.0a states no granted access level; AMCP records the access type it asked for (CON-03).
    grants: {
      source: 'requested_access_type',
      known: false,
      requested_access_type: stored.requestedAccessType === 'write' ? 'write' : 'read',
      checked_at: Date.now(),
    },
  };
}

export const xLogin: ProviderLogin = Object.freeze({
  gateway: 'x_ads_native_action',
  oauth: Object.freeze({
    authorize: 'https://api.x.com/oauth/authorize',
    token: xAccessToken,
    begin: xRequestToken,
    complete: xExchange,
  }),
  discovery: Object.freeze({kind: xDiscovery}),
});

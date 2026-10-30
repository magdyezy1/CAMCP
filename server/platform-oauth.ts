import {effectiveProviderContract} from '../src/provider-contracts.js';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {MirrorError} from '../src/errors.js';
import type {Connection, Credentials, JsonObject} from '../src/types.js';
import {WebStore, type WebSession} from './web-store.js';
import {optionalLifetimeEnd} from '../src/oauth-token-response.js';
import {providerGrant, requestedScopes} from '../src/provider-grants.js';
import {providerById} from '../src/provider-adapters.js';
import {appClient, businessProfileApproved} from '../src/app-credentials.js';
import {providerLogin} from '../src/provider-logins.js';
import type {
  OAuthContext,
  OAuthExchange,
  OAuthRequestInit,
  OAuthSteps,
  OAuthTokenRequest,
} from '../src/provider-login.js';

/** A website platform's gateway is its provider adapter's (src/provider-adapters.ts): the platform ID is the adapter's. */
const gatewayOf = (id: string) => providerById(id)!.gateway;
/**
 * A website platform's OAuth app stem (AMCP_<stem>_CLIENT_ID and _CLIENT_SECRET) is its provider adapter's (`app`, SEC-07
 * S2), the one a saved login's use-time secrets resolve (src/app-credentials.ts).
 */
const appStemOf = (id: string) => providerById(id)!.app!.stem;
/** A platform's default (read) scopes come from the one grant registry (src/provider-grants.ts, CON-03). */
const requested = (id: string) => requestedScopes(gatewayOf(id), false);
/**
 * A website platform's OAuth flow steps are its provider's website login steps (src/<provider>-login.ts, registered
 * in src/provider-logins.ts; ARC-01 phase B): its endpoints and the steps only it takes. PlatformOAuth keeps the flow.
 */
const oauthOf = (id: string): OAuthSteps => providerLogin(gatewayOf(id))!.oauth!;
const stepsOf = (p: PlatformDefinition): OAuthSteps => providerLogin(p.gateway)!.oauth!;

export interface PlatformDefinition {
  id: string;
  name: string;
  kind: string;
  description: string;
  logo: string;
  gateway: string;
  env: string;
  authorize: string;
  token: string;
  scopes: string[];
  pkce?: boolean;
  assetKinds: string[];
  selectionKind?: string;
  /** Kinds a login may select besides selectionKind (Drive: folders, whose media files it grants). */
  alsoSelectable?: string[];
  authType?: 'client_credentials';
  reviewedWrites?: boolean;
}
export const platforms: PlatformDefinition[] = [
  {
    id: 'sheets',
    name: 'Google Sheets',
    kind: 'Reporting destination',
    description: 'Export campaign reports to a spreadsheet and keep scheduled reports up to date.',
    logo: '▦',
    gateway: gatewayOf('sheets'),
    env: appStemOf('sheets'),
    authorize: oauthOf('sheets').authorize,
    token: oauthOf('sheets').token,
    scopes: requested('sheets'),
    pkce: true,
    assetKinds: ['spreadsheets'],
    selectionKind: 'spreadsheets',
    reviewedWrites: false,
  },
  {
    id: 'drive',
    name: 'Google Drive',
    kind: 'Private media source',
    description: 'Select private media files, or folders of them, for server-side imports and previews.',
    logo: '△',
    gateway: gatewayOf('drive'),
    env: appStemOf('drive'),
    authorize: oauthOf('drive').authorize,
    token: oauthOf('drive').token,
    scopes: requested('drive'),
    pkce: true,
    assetKinds: ['files', 'folders'],
    selectionKind: 'files',
    alsoSelectable: ['folders'],
    reviewedWrites: false,
  },
  {
    id: 'microsoft',
    name: 'Microsoft Advertising',
    kind: 'Bing & Microsoft Ads',
    description: 'Connect Microsoft advertising accounts, search campaigns and reports.',
    logo: 'M',
    gateway: gatewayOf('microsoft'),
    env: appStemOf('microsoft'),
    authorize: oauthOf('microsoft').authorize,
    token: oauthOf('microsoft').token,
    scopes: requested('microsoft'),
    pkce: true,
    assetKinds: ['ad_accounts'],
    reviewedWrites: true,
  },
  {
    id: 'google',
    name: 'Google Ads',
    kind: 'Search & display',
    description: 'Connect your Google advertising accounts.',
    logo: 'G',
    gateway: gatewayOf('google'),
    env: appStemOf('google'),
    authorize: oauthOf('google').authorize,
    token: oauthOf('google').token,
    scopes: requested('google'),
    pkce: true,
    assetKinds: ['ad_accounts'],
  },
  {
    id: 'meta',
    name: 'Meta',
    kind: 'Facebook & Instagram',
    description: 'Bring your ad accounts, pages and Instagram together.',
    logo: '∞',
    gateway: gatewayOf('meta'),
    env: appStemOf('meta'),
    authorize: oauthOf('meta').authorize,
    token: oauthOf('meta').token,
    scopes: requested('meta'),
    assetKinds: ['ad_accounts', 'pages', 'instagram', 'catalogs', 'pixels', 'mobile_apps', 'custom_conversions'],
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    kind: 'TikTok for Business',
    description: 'Connect advertisers and discover your business assets.',
    logo: '♪',
    gateway: gatewayOf('tiktok'),
    env: appStemOf('tiktok'),
    authorize: oauthOf('tiktok').authorize,
    token: oauthOf('tiktok').token,
    scopes: [],
    assetKinds: ['ad_accounts', 'pixels', 'identities'],
  },
  {
    id: 'snapchat',
    name: 'Snapchat',
    kind: 'Snap Ads',
    description: 'Connect organizations, ad accounts and tracking assets.',
    logo: 'S',
    gateway: gatewayOf('snapchat'),
    env: appStemOf('snapchat'),
    authorize: oauthOf('snapchat').authorize,
    token: oauthOf('snapchat').token,
    scopes: requested('snapchat'),
    assetKinds: ['ad_accounts', 'profiles', 'pixels', 'mobile_apps', 'catalogs'],
  },
  {
    id: 'linkedin',
    name: 'LinkedIn',
    kind: 'LinkedIn Marketing',
    description: 'Connect your professional advertising accounts.',
    logo: 'in',
    gateway: gatewayOf('linkedin'),
    env: appStemOf('linkedin'),
    authorize: oauthOf('linkedin').authorize,
    token: oauthOf('linkedin').token,
    scopes: requested('linkedin'),
    assetKinds: ['ad_accounts'],
  },
  {
    id: 'x',
    name: 'X (Twitter)',
    kind: 'X Ads',
    description: 'Connect ad accounts, promoted profiles and tracking tags.',
    logo: '𝕏',
    gateway: gatewayOf('x'),
    env: appStemOf('x'),
    authorize: oauthOf('x').authorize,
    token: oauthOf('x').token,
    scopes: [],
    assetKinds: ['ad_accounts', 'profiles', 'pixels', 'mobile_apps'],
  },
  {
    id: 'ga4',
    name: 'Google Analytics 4',
    kind: 'Analytics & measurement',
    description: 'Connect GA4 properties, reports and data streams.',
    logo: 'A',
    gateway: gatewayOf('ga4'),
    env: appStemOf('ga4'),
    authorize: oauthOf('ga4').authorize,
    token: oauthOf('ga4').token,
    scopes: requested('ga4'),
    pkce: true,
    assetKinds: ['properties', 'data_streams'],
    selectionKind: 'properties',
    reviewedWrites: true,
  },
  {
    id: 'gtm',
    name: 'Google Tag Manager',
    kind: 'Google tag & containers',
    description: 'Connect Tag Manager accounts and Google tag containers.',
    logo: '◇',
    gateway: gatewayOf('gtm'),
    env: appStemOf('gtm'),
    authorize: oauthOf('gtm').authorize,
    token: oauthOf('gtm').token,
    scopes: requested('gtm'),
    pkce: true,
    assetKinds: ['tag_accounts', 'containers'],
    selectionKind: 'tag_accounts',
    reviewedWrites: true,
  },
  {
    id: 'gsc',
    name: 'Google Search Console',
    kind: 'Organic search',
    description: 'Connect verified sites, search performance and sitemaps.',
    logo: '⌕',
    gateway: gatewayOf('gsc'),
    env: appStemOf('gsc'),
    authorize: oauthOf('gsc').authorize,
    token: oauthOf('gsc').token,
    scopes: requested('gsc'),
    pkce: true,
    assetKinds: ['sites', 'sitemaps'],
    selectionKind: 'sites',
    reviewedWrites: true,
  },
  {
    id: 'apple',
    name: 'Apple Ads',
    kind: 'App Store advertising',
    description: 'Connect Apple Ads accounts using your API credentials.',
    logo: '●',
    gateway: gatewayOf('apple'),
    env: appStemOf('apple'),
    authorize: oauthOf('apple').authorize,
    token: oauthOf('apple').token,
    scopes: requested('apple'),
    assetKinds: ['ad_accounts'],
    authType: 'client_credentials',
    reviewedWrites: true,
  },
  // Display & Video 360 reuses the shared Google OAuth client, like the other Google surfaces.
  {
    id: 'dv360',
    name: 'Display & Video 360',
    kind: 'Programmatic display & video',
    description: 'Connect DV360 advertisers, insertion orders and line items.',
    logo: '▶',
    gateway: gatewayOf('dv360'),
    env: appStemOf('dv360'),
    authorize: oauthOf('dv360').authorize,
    token: oauthOf('dv360').token,
    scopes: requested('dv360'),
    pkce: true,
    assetKinds: ['advertisers'],
    selectionKind: 'advertisers',
    reviewedWrites: true,
  },
  // Business Profile (CON-06) reuses the shared Google OAuth client like the other Google surfaces, but Google approves
  // each Cloud project for the Business Profile APIs separately: it stays "setup required" until the owner declares
  // that approval (AMCP_GBP_API_APPROVED=true) or sets its own client. Locations are the primary selection; business
  // accounts can be selected for account-level reviewed changes (notifications, access).
  {
    id: 'google_business',
    name: 'Google Business Profile',
    kind: 'Local business listings',
    description: 'Connect Business Profile accounts and locations: hours, contact details, links and attributes.',
    logo: '⌂',
    gateway: gatewayOf('google_business'),
    env: appStemOf('google_business'),
    authorize: oauthOf('google_business').authorize,
    token: oauthOf('google_business').token,
    scopes: requested('google_business'),
    pkce: true,
    assetKinds: ['locations', 'business_accounts'],
    selectionKind: 'locations',
    alsoSelectable: ['business_accounts'],
    reviewedWrites: true,
  },
  // Reddit exchanges and refreshes with HTTP Basic authentication and requires a descriptive
  // User-Agent on every token call; both are its OAuth steps (src/reddit-login.ts) and src/auth.ts's.
  {
    id: 'reddit',
    name: 'Reddit',
    kind: 'Reddit Ads',
    description: 'Connect Reddit ad accounts, campaigns and saved audiences.',
    logo: 'r',
    gateway: gatewayOf('reddit'),
    env: appStemOf('reddit'),
    authorize: oauthOf('reddit').authorize,
    token: oauthOf('reddit').token,
    scopes: requested('reddit'),
    assetKinds: ['ad_accounts'],
    reviewedWrites: true,
  },
];
// Whether Business Profile may use the shared Google client (CON-06); src/app-credentials.ts owns the rule, so the
// connect flow and a saved login's use-time secrets resolve the same client.
export {businessProfileApproved};
export function platform(id: string) {
  const p = platforms.find(p => p.id === id);
  if (!p) throw new MirrorError('PLATFORM_NOT_FOUND', 'Unknown advertising platform.', {}, 404);
  return p;
}
export function selectionKind(gateway: string) {
  return platforms.find(p => p.gateway === gateway)?.selectionKind ?? 'ad_accounts';
}
/** Every kind a login of this gateway may select: its primary kind first. */
export function selectableKinds(gateway: string) {
  return [selectionKind(gateway), ...(platforms.find(p => p.gateway === gateway)?.alsoSelectable ?? [])];
}
// The OAuth 1.0a signature of X's authorization calls moved to a leaf with X's steps (ARC-01 phase B); its public
// import path stays.
export {signOAuth1} from '../src/oauth1-authorization.js';
/** A display name the provider stated, bounded and without control characters, or undefined. */
export function providerDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.replace(/\s+/g, ' ').trim();
  return name && name.length <= 80 && !/[\u0000-\u001f\u007f]/.test(name) ? name : undefined;
}
/** A login's default name (CON-05): "<Platform> · <name>" when the provider stated the user, else "<Platform> login". */
export function loginLabel(p: Pick<PlatformDefinition, 'name'>, name?: string): string {
  const shown = providerDisplayName(name);
  return shown ? p.name + ' · ' + shown : p.name + ' login';
}
/**
 * The Google user an ID token names (CON-05): its subject and display name. The token came straight from Google's token
 * endpoint over TLS in this exchange, so its issuer and audience are checked and its signature need not be (OpenID
 * Connect Core 3.1.3.7). Anything unexpected yields no identity; it never fails the connection.
 */
export function googleIdentity(
  token: unknown,
  clientId: string | undefined,
): {subject: string; name?: string} | undefined {
  if (typeof token !== 'string' || token.length > 16384 || !clientId) return undefined;
  try {
    const part = token.split('.')[1];
    if (!part) return undefined;
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as JsonObject;
    if (
      !['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) ||
      (Array.isArray(claims.aud) ? !claims.aud.includes(clientId) : claims.aud !== clientId) ||
      typeof claims.sub !== 'string' ||
      !/^[0-9A-Za-z_-]{1,255}$/.test(claims.sub) ||
      (claims.exp !== undefined && (!Number.isFinite(claims.exp) || claims.exp * 1000 < Date.now() - 300000))
    )
      return undefined;
    const name = providerDisplayName(claims.name);
    return {subject: claims.sub, ...(name ? {name} : {})};
  } catch {
    return undefined;
  }
}
export class PlatformOAuth {
  constructor(
    readonly web: WebStore,
    private env: NodeJS.ProcessEnv = process.env,
    private fetcher: typeof fetch = fetch,
    readonly allowWrites = false,
  ) {}
  /**
   * Reddit's User-Agent for this deployment (AMCP_REDDIT_USER_AGENT; its OAuth steps, src/reddit-login.ts, check it),
   * as a Reddit login keeps it on its connection (`connectionFields`).
   */
  redditUserAgent() {
    return String(this.connectionFields(platform('reddit')).userAgent);
  }
  /** Fields a new login of the platform keeps on its connection (Reddit's User-Agent), or the provider's refusal. */
  connectionFields(p: PlatformDefinition): Pick<Connection, 'userAgent'> {
    return stepsOf(p).connectionFields?.(this.env) ?? {};
  }
  config(p: PlatformDefinition) {
    // The same lookup resolves a saved login's app secrets at use time (src/app-credentials.ts, SEC-07 S2). Business
    // Profile shares the Google client only once the owner declares the project's API approval (CON-06).
    const {clientId, clientSecret} = appClient(p.env, this.env);
    // Read scopes, plus each platform's write scopes when reviewed writes are allowed (src/provider-grants.ts). Reddit's
    // adsedit is requested only then (owner decision D19).
    const defaults = requestedScopes(p.gateway, this.allowWrites);
    const steps = stepsOf(p);
    return {
      clientId,
      clientSecret,
      // The provider's own server key may stand in for the client secret (Apple's), and the provider may need a
      // deployment setting besides its client (Microsoft's developer token).
      configured: !!(
        clientId &&
        (clientSecret || steps.serviceKey?.(this.env)) &&
        (!steps.requiredSetting || this.env[steps.requiredSetting])
      ),
      redirectUri: this.web.origin + '/api/auth/' + p.id + '/callback',
      scopes: steps.fixedScopes
        ? p.scopes
        : (this.env['AMCP_' + p.env + '_SCOPES']?.split(/[ ,]+/).filter(Boolean) ?? defaults),
    };
  }
  /** What a provider's OAuth step is given (src/provider-login.ts): the settings, the client and the stage's I/O. */
  private context(c: {clientId?: string; clientSecret?: string; redirectUri: string}): OAuthContext {
    return {
      env: this.env,
      clientId: c.clientId,
      clientSecret: c.clientSecret,
      redirectUri: c.redirectUri,
      allowWrites: this.allowWrites,
      send: (url, init) => this.send(url, init),
      readResponse: (response, format) => this.readResponse(response, format),
    };
  }
  /** Every provider request of a flow is sent once: it never follows a redirect, and it gives up after 15 seconds. */
  private send(url: URL, init: OAuthRequestInit): Promise<Response> {
    return this.fetcher(url, {...init, redirect: 'error', signal: AbortSignal.timeout(15000)});
  }
  publicConfig() {
    return platforms.map(p => {
      const c = this.config(p);
      return {
        ...p,
        contract: effectiveProviderContract(p.id),
        selectionKind: p.selectionKind ?? 'ad_accounts',
        selectableKinds: [p.selectionKind ?? 'ad_accounts', ...(p.alsoSelectable ?? [])],
        authorize: undefined,
        token: undefined,
        configured: c.configured,
        // Whether one exact live account read can check a selected account (Save and check access, CON-05).
        accountRead: providerGrant(p.gateway)?.accountReadContract === true,
        callback: p.authType ? null : c.redirectUri,
        scopes: c.scopes,
      };
    });
  }
  /** A server-owned API connection, for a provider whose OAuth steps connect with the server's credentials (Apple). */
  async connectService(id: string): Promise<{credentials: Credentials; label: string; scopes: string[]}> {
    const p = platform(id),
      c = this.config(p),
      connect = stepsOf(p).connect;
    if (!connect) throw new MirrorError('OAUTH_FLOW_REQUIRED', 'Use browser authorization for this platform.');
    return connect({...this.context(c), configured: c.configured, scopes: p.scopes, fetcher: this.fetcher});
  }
  async readResponse(response: Response, format: 'json' | 'form' = 'json'): Promise<JsonObject> {
    const reader = response.body?.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 1024 * 1024) {
            await reader.cancel();
            throw new MirrorError('OAUTH_RESPONSE_INVALID', 'The provider response was too large.', {}, 502);
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
    if (!response.ok)
      throw new MirrorError(
        'OAUTH_EXCHANGE_FAILED',
        'The provider rejected authorization. Check app credentials and callback settings, then reconnect.',
        {http_status: response.status},
        502,
      );
    try {
      const text = Buffer.concat(chunks).toString('utf8'),
        data = format === 'form' ? Object.fromEntries(new URLSearchParams(text)) : JSON.parse(text);
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.error) throw Error();
      return data;
    } catch {
      throw new MirrorError(
        'OAUTH_RESPONSE_INVALID',
        'The provider returned an invalid authorization response.',
        {},
        502,
      );
    }
  }
  async start(
    session: WebSession,
    id: string,
    reauthorization?: {connectionId: string; revision: string | null},
  ): Promise<{url: string; attemptId: string}> {
    const p = platform(id),
      c = this.config(p),
      steps = stepsOf(p);
    if (!c.configured)
      throw new MirrorError(
        'PROVIDER_SETUP_REQUIRED',
        'Add the ' + p.name + ' app credentials in Railway before connecting.',
        {callback: c.redirectUri},
        409,
      );
    if (p.authType)
      throw new MirrorError(
        'SERVICE_CONNECTION_REQUIRED',
        'This platform uses server-side API credentials, without a browser OAuth callback.',
      );
    const state = randomBytes(32).toString('base64url'),
      attemptId = randomUUID(),
      verifier = randomBytes(48).toString('base64url');
    // Every browser-OAuth platform can renew a saved login in place (CON-02). The state binds the connection, the
    // revision it started from and the platform, and a renewal also refuses a mid-flow OAuth client change.
    let data: JsonObject = {
        attemptId,
        redirectUri: c.redirectUri,
        verifier,
        requestedScopes: [...c.scopes],
        requestedWriteAccess: this.allowWrites && p.reviewedWrites !== false,
        ...(reauthorization ? {reauthorization: {...reauthorization, platform: id}} : {}),
        // Google Ads binds its client on a first authorization too: its renewal compares it.
        ...(steps.bindsClient || reauthorization ? {oauthClientId: c.clientId} : {}),
      },
      url = new URL(p.authorize);
    if (steps.begin) {
      // A provider that authorizes its own way (X's OAuth 1.0a request token): what the state keeps, and the URL's.
      const begun = await steps.begin({...this.context(c), state});
      data = {...data, ...begun.data};
      for (const [name, value] of Object.entries(begun.parameters)) url.searchParams.set(name, value);
    } else this.authorizationRequest(url, p, c, steps, state, verifier, !!reauthorization);
    this.web.beginOAuth(session, id, data, state);
    this.web.store.putDocument(session.actor.tenantId, 'oauth_progress', attemptId, {
      platform: id,
      state: 'authorization',
      createdAt: Date.now(),
      authorization: false,
      exchange: false,
      sync: false,
    });
    return {url: url.href, attemptId};
  }
  /**
   * The authorization-code request's parameters, in this order: the client, the callback, the state, the response
   * type, the scopes, the PKCE challenge, then the provider's own (its OAuth steps name what differs).
   */
  private authorizationRequest(
    url: URL,
    p: PlatformDefinition,
    c: {clientId?: string; redirectUri: string; scopes: string[]},
    steps: OAuthSteps,
    state: string,
    verifier: string,
    reauthorization: boolean,
  ) {
    const redirectParameter = steps.redirectParameter?.(this.env) ?? 'redirect_uri';
    url.searchParams.set(steps.clientParameter ?? 'client_id', c.clientId!);
    url.searchParams.set(redirectParameter, c.redirectUri);
    url.searchParams.set('state', state);
    if (!steps.noResponseType) url.searchParams.set('response_type', 'code');
    if (c.scopes.length) url.searchParams.set('scope', c.scopes.join(steps.scopeSeparator ?? ' '));
    if (p.pkce) {
      url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
      url.searchParams.set('code_challenge_method', 'S256');
    }
    steps.authorizeParameters?.(url.searchParams, {reauthorization, env: this.env});
  }
  async exchange(
    id: string,
    stored: JsonObject,
    query: Record<string, string>,
    assertActive: () => void = () => {},
  ): Promise<OAuthExchange> {
    assertActive();
    const p = platform(id),
      c = this.config(p),
      steps = stepsOf(p);
    if (!c.configured)
      throw new MirrorError('PROVIDER_SETUP_REQUIRED', 'Provider credentials are unavailable.', {}, 503);
    if (p.authType)
      throw new MirrorError('SERVICE_CONNECTION_REQUIRED', 'Apple Ads does not use an authorization-code callback.');
    if (query.error || query.denied)
      throw new MirrorError(
        'OAUTH_CANCELLED',
        'Authorization was cancelled. Your existing connections were not changed.',
        {},
        400,
      );
    if (stored.oauthClientId && stored.oauthClientId !== c.clientId)
      throw new MirrorError(
        'OAUTH_CLIENT_CHANGED',
        'The configured OAuth client changed during authorization. Start again from Connections.',
        {},
        409,
      );
    const context = this.context(c);
    // A provider that authorizes its own way completes its own way (X's OAuth 1.0a access token).
    if (steps.complete)
      return steps.complete({...context, stored, query, assertActive, label: name => loginLabel(p, name)});
    const code = query[steps.codeParameter ?? 'code'];
    if (!code || code.length > 8192)
      throw new MirrorError('OAUTH_CODE_REQUIRED', 'The provider did not return an authorization code.', {}, 400);
    const body = new URLSearchParams({
      client_id: c.clientId!,
      client_secret: c.clientSecret!,
      grant_type: 'authorization_code',
      code,
      redirect_uri: stored.redirectUri,
    });
    if (p.pkce) body.set('code_verifier', stored.verifier);
    // The provider's token request, from this form POSTed to its token endpoint: Microsoft's scope, Reddit's Basic
    // authentication and User-Agent, Meta's GET, TikTok's JSON.
    const form: OAuthTokenRequest = {url: new URL(p.token), method: 'POST', headers: {}, body},
      request = steps.tokenRequest?.(form, {...context, code}) ?? form;
    let result = await this.readResponse(
      await this.send(request.url, {method: request.method, body: request.body, headers: request.headers}),
    );
    assertActive();
    // The provider's own result (TikTok's data, once its code says it succeeded), and a second exchange of its token
    // (Meta's long-lived one).
    if (steps.tokenResult) result = steps.tokenResult(result);
    if (steps.extend) result = await steps.extend(result, {...context, assertActive});
    if (
      typeof result.access_token !== 'string' ||
      !result.access_token ||
      (result.refresh_token !== undefined && typeof result.refresh_token !== 'string')
    )
      throw new MirrorError('OAUTH_RESPONSE_INVALID', 'The provider did not return a usable access token.', {}, 502);
    const expires = result.expires_in === undefined ? undefined : Number(result.expires_in);
    if (expires !== undefined && (!Number.isFinite(expires) || expires <= 0))
      throw new MirrorError('OAUTH_RESPONSE_INVALID', 'The provider returned an invalid token lifetime.', {}, 502);
    // A provider whose logins must be renewable refuses tokens that are not (Reddit).
    steps.checkTokens?.(result, expires);
    const credentials: Credentials = {
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      clientId: c.clientId,
      clientSecret: c.clientSecret,
      redirectUri: stored.redirectUri,
      ...(expires ? {expiresAt: Date.now() + expires * 1000} : {}),
    };
    // The provider's part of the login (Google Ads' and Microsoft's developer tokens), or its refusal.
    steps.credentials?.(credentials, {env: this.env, expires});
    // Bind fallback scope metadata to the authorization that produced this code.
    // An in-flight or legacy read authorization must never inherit a later write configuration.
    const requestedScopes =
      Array.isArray(stored.requestedScopes) &&
      stored.requestedScopes.every((scope: unknown) => typeof scope === 'string')
        ? stored.requestedScopes
        : [...p.scopes];
    // LinkedIn states how long its refresh token (the login) lasts; it is recorded for credential health (CON-02).
    const loginExpiresAt = optionalLifetimeEnd(result.refresh_token_expires_in);
    // Google Ads already asks for openid and profile: its ID token names the Google user, without another request or
    // scope (CON-05). Other platforms learn the user from discovery (Meta, Microsoft) or the exchange (X).
    const identity = googleIdentity(result.id_token, c.clientId);
    return {
      credentials,
      label: loginLabel(p, identity?.name),
      ...(identity ? {providerId: identity.subject, ...(identity.name ? {displayName: identity.name} : {})} : {}),
      // Token responses that echo granted scopes are recorded exactly: a string (Google, Microsoft, LinkedIn, Snapchat,
      // Reddit) or TikTok's list, kept verbatim (CON-03). Others fall back to what this authorization requested.
      scopes:
        typeof result.scope === 'string'
          ? result.scope.split(/[ ,]+/).filter(Boolean)
          : Array.isArray(result.scope) &&
              result.scope.length &&
              result.scope.length <= 200 &&
              result.scope.every(
                (s: unknown) =>
                  (typeof s === 'string' && s.length > 0 && s.length <= 200) ||
                  (typeof s === 'number' && Number.isSafeInteger(s)),
              )
            ? result.scope.map(String)
            : requestedScopes,
      ...(loginExpiresAt ? {loginExpiresAt} : {}),
    };
  }
}

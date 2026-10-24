import type {
  DiscoveryContext,
  DiscoveryParents,
  OAuthContext,
  OAuthTokenRequest,
  ProviderLogin,
} from './provider-login.js';
import type {JsonObject} from './types.js';
import {MirrorError} from './errors.js';

/**
 * Reddit's website login steps (ARC-01 phase B; registered in src/provider-logins.ts). OAuth: a permanent authorization,
 * whose code is exchanged with HTTP Basic authentication and a descriptive User-Agent, which the login keeps on its
 * connection (src/auth.ts renews it with both); a login that is not renewable is refused. Discovery: the ad accounts of
 * each business the login reaches, whose next links may change only their cursor. Reddit's list-by-business
 * intentionally omits ad accounts shared into a business, which a complete listing says.
 */
const redditParents: DiscoveryParents = Object.freeze({
  parents: () => ({path: '/api/v3/me/businesses', query: {}, extract: (d: JsonObject) => d.data}),
  parentId: (parent: JsonObject) => String(parent.id ?? ''),
  parentPattern: /^[A-Za-z0-9_-]{1,100}$/,
  accounts: (id: string) => ({
    path: '/api/v3/businesses/' + id + '/ad_accounts',
    query: {},
    extract: (d: JsonObject) => d.data,
  }),
  accountId: (row: JsonObject) => row.id,
  accountParent: (row: JsonObject) => row.business_id,
  accountPattern: /^a2_[A-Za-z0-9]+$/,
  fields: (row: JsonObject) => ({name: row.name, currency: row.currency, timezone: row.timezone, status: row.status}),
  coverage: () => [
    {
      code: 'DISCOVERY_COVERAGE',
      message:
        'Owned business ad accounts discovered. Reddit does not return shared-in accounts from this endpoint. Provider visibility does not establish write permission.',
    },
  ],
});
/** A next link may change only its cursor: no filter changes and no repeated parameters. */
function redditNextLink(next: URL, original: URL, cursorKey: string) {
  for (const [k, v] of next.searchParams) {
    if (next.searchParams.getAll(k).length !== 1 || (k !== cursorKey && original.searchParams.get(k) !== v))
      throw new MirrorError(
        'UNSAFE_PAGINATION',
        'Reddit pagination changed filters or supplied duplicate parameters.',
        {},
        502,
      );
  }
}

/**
 * Reddit requires a unique, descriptive User-Agent on every token call and throttles or rejects generic ones. Operators
 * can set their own; the default identifies AMCP and is sanitised because the value becomes a request header.
 */
export function redditUserAgent(env: NodeJS.ProcessEnv): string {
  const configured = env.AMCP_REDDIT_USER_AGENT;
  const value = configured && configured.trim() ? configured.trim() : 'AMCP/0.1.0 (advertising campaign management)';
  if (/[\r\n]/.test(value))
    throw new MirrorError('USER_AGENT_REQUIRED', 'AMCP_REDDIT_USER_AGENT must not contain line breaks.');
  return value;
}

export const redditLogin: ProviderLogin = Object.freeze({
  gateway: 'reddit_native_action',
  oauth: Object.freeze({
    authorize: 'https://www.reddit.com/api/v1/authorize',
    token: 'https://www.reddit.com/api/v1/access_token',
    authorizeParameters(parameters: URLSearchParams) {
      parameters.set('duration', 'permanent');
    },
    // Reddit authenticates the token call with HTTP Basic and rejects requests without a descriptive User-Agent. The
    // same two rules apply on refresh (src/auth.ts), so the User-Agent is stored on the connection rather than
    // recomputed there.
    tokenRequest(request: OAuthTokenRequest, c: OAuthContext) {
      const headers = {
        Authorization: 'Basic ' + Buffer.from(c.clientId + ':' + c.clientSecret).toString('base64'),
        'User-Agent': redditUserAgent(c.env),
      };
      const form = request.body as URLSearchParams;
      form.delete('client_id');
      form.delete('client_secret');
      return {...request, headers};
    },
    checkTokens(result: JsonObject, expires: number | undefined) {
      if (!result.refresh_token || !expires)
        throw new MirrorError(
          'OFFLINE_ACCESS_REQUIRED',
          'Reddit did not grant renewable access. Start a new permanent authorization before saving this connection.',
          {},
          502,
        );
    },
    connectionFields: (env: NodeJS.ProcessEnv) => ({userAgent: redditUserAgent(env)}),
  }),
  discovery: Object.freeze({
    kind: (kind: string, c: DiscoveryContext) => c.parents(kind, redditParents),
    nextLink: redditNextLink,
  }),
});

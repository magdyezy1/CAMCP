import {createHmac, randomBytes} from 'node:crypto';

/**
 * The OAuth 1.0a HMAC-SHA1 Authorization header of the website's authorization flow (RFC 5849 section 3.4): the
 * request-token and access-token calls, signed with the consumer, the temporary token once there is one, and the call's
 * own oauth_ parameters (its callback or verifier). X's login steps (src/x-login.ts) sign with it; it moved here from
 * server/platform-oauth.ts (ARC-01 phase B), which re-exports it. A leaf: src/oauth1.ts signs the API requests a login
 * then makes.
 */
const pct = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
export function signOAuth1(
  method: string,
  url: URL,
  consumerKey: string,
  consumerSecret: string,
  token = '',
  tokenSecret = '',
  extra: Record<string, string> = {},
  nonce = randomBytes(20).toString('hex'),
  timestamp = String(Math.floor(Date.now() / 1000)),
): string {
  const params: Record<string, string> = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_version: '1.0',
    ...(token ? {oauth_token: token} : {}),
    ...extra,
  };
  const sorted = [...url.searchParams.entries(), ...Object.entries(params)]
    .map(([k, v]) => [pct(k), pct(v)] as [string, string])
    .sort(([a, b], [c, d]) => (a < c ? -1 : a > c ? 1 : b < d ? -1 : b > d ? 1 : 0))
    .map(([k, v]) => k + '=' + v)
    .join('&');
  const base = method.toUpperCase() + '&' + pct(url.origin + url.pathname) + '&' + pct(sorted),
    signature = createHmac('sha1', pct(consumerSecret) + '&' + pct(tokenSecret))
      .update(base)
      .digest('base64');
  return (
    'OAuth ' +
    Object.entries({...params, oauth_signature: signature})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => pct(k) + '="' + pct(v) + '"')
      .join(', ')
  );
}

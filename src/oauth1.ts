import {createHmac, randomUUID} from 'node:crypto';
import {MirrorError} from './errors.js';
import type {Credentials} from './types.js';

/**
 * The OAuth 1.0a HMAC-SHA1 Authorization header of a request (RFC 5849), which X Ads requests carry. A leaf below
 * src/transport.ts, which re-exports it, and X's wire profile (src/x-adapter.ts), which signs with it.
 */
const pct = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
export function oauth1(
  method: string,
  url: URL,
  credentials: Credentials,
  bodyParams?: URLSearchParams,
  nonce: string = randomUUID(),
  timestamp: string = Math.floor(Date.now() / 1000).toString(),
): string {
  if (!credentials.consumerKey || !credentials.consumerSecret || !credentials.accessToken || !credentials.tokenSecret)
    throw new MirrorError('OAUTH1_CREDENTIALS_REQUIRED', 'X Ads requires consumer and user OAuth 1.0a credentials.');
  const oauth: Record<string, string> = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_token: credentials.accessToken,
    oauth_nonce: nonce,
    oauth_timestamp: timestamp,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_version: '1.0',
  };
  const entries = [...url.searchParams.entries(), ...(bodyParams?.entries() ?? []), ...Object.entries(oauth)]
    .map(([k, v]) => [pct(k), pct(v)] as [string, string])
    .sort(([a, b], [c, d]) => (a < c ? -1 : a > c ? 1 : b < d ? -1 : b > d ? 1 : 0));
  const params = entries.map(([k, v]) => k + '=' + v).join('&');
  const baseUrl = url.origin + url.pathname;
  const signature = createHmac('sha1', pct(credentials.consumerSecret) + '&' + pct(credentials.tokenSecret))
    .update(method.toUpperCase() + '&' + pct(baseUrl) + '&' + pct(params))
    .digest('base64');
  return (
    'OAuth ' +
    Object.entries({...oauth, oauth_signature: signature})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => pct(k) + '="' + pct(v) + '"')
      .join(', ')
  );
}

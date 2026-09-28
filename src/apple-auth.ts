import {createPrivateKey, sign} from 'node:crypto';
import {MirrorError} from './errors.js';
import type {Credentials} from './types.js';
import {readOAuthTokenBody, usableBearerToken, tokenExpiresAt} from './oauth-token-response.js';

/** Apple Ads client credentials use ES256, not Sign in with Apple's browser flow. */
export function appleClientSecret(c: Credentials, now = Math.floor(Date.now() / 1000)): string {
  if (!c.applePrivateKey) {
    if (c.clientSecret) return c.clientSecret;
    throw new MirrorError(
      'REAUTHORIZATION_REQUIRED',
      'Configure an Apple Ads signing key or current client secret.',
      {},
      401,
    );
  }
  if (!c.clientId || !c.appleTeamId || !c.appleKeyId)
    throw new MirrorError(
      'REAUTHORIZATION_REQUIRED',
      'Apple Ads signing requires the client ID, team ID and key ID.',
      {},
      401,
    );
  try {
    const key = createPrivateKey(c.applePrivateKey.replaceAll('\\n', '\n'));
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw Error();
    const header = Buffer.from(JSON.stringify({alg: 'ES256', kid: c.appleKeyId})).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: c.appleTeamId,
        sub: c.clientId,
        aud: 'https://appleid.apple.com',
        iat: now - 30,
        exp: now + 300,
      }),
    ).toString('base64url');
    const input = header + '.' + payload,
      signature = sign('sha256', Buffer.from(input), {key, dsaEncoding: 'ieee-p1363'}).toString('base64url');
    return input + '.' + signature;
  } catch {
    throw new MirrorError('APPLE_SIGNING_KEY_INVALID', 'Apple Ads requires a valid P-256 PEM private key.', {}, 400);
  }
}
export async function requestAppleAccessToken(c: Credentials, fetcher: typeof fetch = fetch): Promise<Credentials> {
  if (!c.clientId) throw new MirrorError('REAUTHORIZATION_REQUIRED', 'Configure the Apple Ads client ID.', {}, 401);
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: c.clientId,
    client_secret: appleClientSecret(c),
    scope: 'searchadsorg',
  });
  let response: Response;
  try {
    response = await fetcher('https://appleid.apple.com/auth/oauth2/token', {
      method: 'POST',
      body,
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new MirrorError('TOKEN_REFRESH_FAILED', 'Apple Ads authentication could not be reached.', {}, 503, true);
  }
  const data = await readOAuthTokenBody(response);
  if (
    !response.ok ||
    data.error !== undefined ||
    !usableBearerToken(data.access_token) ||
    (data.token_type !== undefined &&
      (typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer'))
  )
    throw new MirrorError(
      'TOKEN_REFRESH_FAILED',
      'Apple Ads rejected the API credentials. Verify the uploaded public key and API role.',
      {http_status: response.status},
      401,
    );
  return {...c, accessToken: data.access_token, expiresAt: tokenExpiresAt(data.expires_in)};
}

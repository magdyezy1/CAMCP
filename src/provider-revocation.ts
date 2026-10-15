import {randomUUID} from 'node:crypto';
import {MirrorError} from './errors.js';
import {credentialsLogin} from './connection-authority.js';
import {disconnectLocalConnection} from './connection-disconnect.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';

/**
 * Provider-side revocation on disconnect (CON-05 sub-item 10, owner decision D19 (4)): an administrator who disconnects
 * a login may also ask the provider to revoke AMCP's token, as a separate, explicitly confirmed choice.
 *
 * It is off unless the deployment owner sets AMCP_PROVIDER_REVOCATION=on, because of an open question (Q25): Google
 * revokes the grant of one OAuth client for one Google account as a whole. Every AMCP Google login (Google Ads, GA4,
 * Tag Manager, Search Console, Display & Video 360, Business Profile, Sheets and Drive) uses the deployment's one
 * Google client unless its surface names its own (src/app-credentials.ts), so revoking one login's token may end the
 * same person's other AMCP Google logins too, in any workspace of the deployment. The owner tests that with disposable
 * logins before turning it on.
 *
 * It is wired for Google only (its documented revocation endpoint, https://oauth2.googleapis.com/revoke, RFC 7009).
 * Other providers' logins disconnect locally only, and their access is revoked in the provider's own settings; a
 * provider is added only after its own shared-app effect is checked the way Q25 checks Google's. Test accounts never
 * revoke (the shared reviewer password lets any evaluator disconnect any reviewer login, and AMCP cannot tell who
 * connected it), like every capability the test-account allow-list in server/website.ts does not name. A token never
 * appears in a URL, a result, an error or the audit trail.
 */
export const providerRevocationEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  env.AMCP_PROVIDER_REVOCATION === 'on';

interface RevocationTarget {
  provider: string;
  endpoint: string;
  /** The provider revokes the grant of the whole OAuth client for that person, not one token (Q25). */
  shared_client: boolean;
}
const google: RevocationTarget = {
  provider: 'google',
  endpoint: 'https://oauth2.googleapis.com/revoke',
  shared_client: true,
};
const targets: Record<string, RevocationTarget> = Object.fromEntries(
  [
    'google_ads_native_action',
    'ga4_native_action',
    'gtm_native_action',
    'google_search_console_native_action',
    'dv360_native_action',
    'google_business_native_action',
    'google_sheets_native_action',
    'google_drive_native_action',
  ].map(gateway => [gateway, google]),
);
export const revocationTarget = (gateway: string): RevocationTarget | undefined => targets[gateway];

/** Whether the website offers "Also revoke at the provider" for a platform's logins to this actor, and why not. */
export function providerRevocationOffer(
  gateway: string,
  env: NodeJS.ProcessEnv = process.env,
  actor?: Pick<Actor, 'testAccount'>,
) {
  const target = revocationTarget(gateway),
    reason = !target
      ? 'provider_not_supported'
      : !providerRevocationEnabled(env)
        ? 'deployment_off'
        : actor?.testAccount
          ? 'test_account'
          : null;
  return {
    available: reason === null,
    reason,
    provider: target?.provider ?? null,
    shared_client: target?.shared_client ?? false,
  };
}

export type RevocationOutcome = 'revoked' | 'token_already_invalid' | 'refused' | 'unknown';
/** At most `limit` bytes of a provider answer; the rest is never read. */
async function boundedText(response: Response, limit = 4096): Promise<string> {
  const reader = response.body?.getReader(),
    chunks: Uint8Array[] = [];
  if (!reader) return '';
  let size = 0,
    done = false;
  try {
    while (size < limit) {
      const part = await reader.read();
      if (part.done) {
        done = true;
        break;
      }
      chunks.push(part.value);
      size += part.value.length;
    }
    if (!done) await reader.cancel();
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).subarray(0, limit).toString('utf8');
}
/**
 * Sends one revocation request with the token in the form body. 200 is revoked; Google's 400 invalid_token means the
 * token no longer worked (access through it had already ended). Any other answer is refused, and a network failure or
 * timeout is unknown: the request may have been applied.
 */
export async function revokeProviderToken(
  target: RevocationTarget,
  token: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = 10000,
): Promise<{outcome: RevocationOutcome; status: number | null}> {
  let response: Response;
  try {
    response = await fetcher(target.endpoint, {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({token}).toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return {outcome: 'unknown', status: null};
  }
  let error: unknown;
  try {
    const text = await boundedText(response);
    error = response.status === 400 ? JSON.parse(text)?.error : undefined;
  } catch {
    error = undefined;
  }
  if (response.status === 200) return {outcome: 'revoked', status: 200};
  if (response.status === 400 && error === 'invalid_token') return {outcome: 'token_already_invalid', status: 400};
  return {outcome: 'refused', status: response.status};
}

/**
 * The explicitly confirmed "disconnect and revoke at the provider". The token is read and the request audited before
 * it is sent; the local disconnect follows only when the provider confirmed the token no longer works. A refused or
 * unknown revocation keeps the login, so the administrator can try again or disconnect it without revocation. A token
 * goes only to the endpoint of the provider its stored login belongs to, and the disconnect is fenced on the login
 * revision it was read from: a login reauthorized meanwhile holds a token that was not sent, so it stays.
 */
export async function disconnectWithProviderRevocation(
  store: Store,
  actor: Actor,
  gateway: string,
  id: string,
  options: {fetcher?: typeof fetch; env?: NodeJS.ProcessEnv; recheck?: () => void; timeoutMs?: number} = {},
): Promise<JsonObject> {
  store.assertActorActive(actor);
  if (actor.role !== 'admin')
    throw new MirrorError('FORBIDDEN', 'Only a workspace administrator can disconnect a platform identity.', {}, 403);
  const target = revocationTarget(gateway);
  if (!target)
    throw new MirrorError(
      'PROVIDER_REVOCATION_UNAVAILABLE',
      'AMCP cannot revoke this login at the provider. Disconnect it here, then remove AMCP in the provider’s own settings.',
      {gateway},
      409,
    );
  if (!providerRevocationEnabled(options.env))
    throw new MirrorError(
      'PROVIDER_REVOCATION_DISABLED',
      'Provider revocation on disconnect is off in this deployment. Disconnect the login here, or ask the owner to turn it on after testing it with disposable logins.',
      {setting: 'AMCP_PROVIDER_REVOCATION'},
      409,
    );
  if (actor.testAccount)
    throw new MirrorError(
      'TEST_ACCOUNT_SCOPE',
      'A test account cannot revoke logins at the provider. Disconnect this login here, then remove AMCP in the provider’s own settings.',
      {},
      403,
    );
  const credentials = store.credentials(actor.tenantId, id),
    login = credentialsLogin(credentials),
    token = credentials.refreshToken ?? credentials.accessToken;
  // The stored login names its gateway, read with the token: a token never goes to another provider's endpoint.
  if (!login || login.gateway !== gateway)
    throw new MirrorError('CONNECTION_NOT_FOUND', 'No matching connection exists in this workspace.', {}, 404);
  if (!token)
    throw new MirrorError(
      'PROVIDER_REVOCATION_UNAVAILABLE',
      'This login holds no token to revoke. Disconnect it here, then remove AMCP in the provider’s own settings.',
      {gateway},
      409,
    );
  store.appendAudit(actor.tenantId, randomUUID(), {
    event: 'provider_revocation_requested',
    connection_id: id,
    gateway,
    provider: target.provider,
    actor: actor.userId,
    token_kind: credentials.refreshToken ? 'refresh' : 'access',
    login_revision: login.revision,
  });
  const result = await revokeProviderToken(target, token, options.fetcher, options.timeoutMs);
  store.appendAudit(actor.tenantId, randomUUID(), {
    event: 'provider_revocation_result',
    connection_id: id,
    gateway,
    provider: target.provider,
    outcome: result.outcome,
    status: result.status,
  });
  options.recheck?.();
  const revocation = {provider: target.provider, shared_client: target.shared_client, ...result};
  if (result.outcome === 'refused' || result.outcome === 'unknown')
    throw new MirrorError(
      'PROVIDER_REVOCATION_FAILED',
      'The provider did not confirm the revocation, so AMCP kept this login. Try again, or disconnect it without provider revocation and remove AMCP in the provider’s own settings.',
      {provider_revocation: revocation},
      502,
    );
  const receipt = disconnectLocalConnection(store, actor, gateway, id, 'website', {
    result: revocation,
    revision: login.revision,
    login: login.login,
  });
  // Disconnected by another request meanwhile: its receipt is returned, with the answer to this revocation.
  return receipt.replayed ? {...receipt, provider_revocation: revocation} : receipt;
}

import {Store} from './store.js';
import type {Connection, Credentials, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {scopeKey} from './security.js';
import {providerHooks} from './provider-hooks.js';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {inheritLogin} from './connection-authority.js';
import {appClientChanged} from './app-credentials.js';
import {
  readOAuthTokenBody,
  usableBearerToken,
  usableRefreshToken,
  tokenExpiresAt,
  optionalLifetimeEnd,
} from './oauth-token-response.js';
import {refreshEndpoints, refreshGate, recordRefreshFailed, recordRefreshSucceeded} from './connection-health.js';
/** OAuth 2.0 grant errors that mean the login itself was rejected (RFC 6749 §5.2, RFC 6750 §3.1), and AMCP's own
 * `client_changed`: the login's OAuth app is no longer the deployment's and its secret is gone (SEC-07 S2). */
const grantRejections = ['invalid_grant', 'invalid_token', 'client_changed'];
const failureCode = (value: unknown) =>
  typeof value === 'string' && /^[a-z_]{1,64}$/.test(value) ? value : 'token_refresh_rejected';
export class CredentialProvider {
  private refreshes = new Map<string, Promise<Credentials>>();
  constructor(
    private store: Store,
    private fetcher: typeof fetch = fetch,
  ) {}
  async get(connection: Connection): Promise<Credentials> {
    const c = this.store.connectionCredentials(connection);
    if (!c.expiresAt || c.expiresAt > Date.now() + 120000) return c;
    const key = scopeKey(connection.tenantId, connection.id);
    const current = this.refreshes.get(key);
    if (current) return current;
    const work = this.lockedRefresh(connection);
    this.refreshes.set(key, work);
    try {
      return await work;
    } finally {
      this.refreshes.delete(key);
    }
  }
  private async lockedRefresh(connection: Connection): Promise<Credentials> {
    const key = 'refresh:' + scopeKey(connection.tenantId, connection.id),
      owner = randomUUID();
    for (let attempt = 0; attempt < 80; attempt++) {
      if (this.store.acquireLock(key, owner, 45000)) {
        try {
          const latest = this.store.connectionCredentials(connection);
          if (!latest.expiresAt || latest.expiresAt > Date.now() + 120000) return latest;
          // A login the provider rejected fails fast here, without a token request (CON-02).
          const gate = refreshGate(this.store, connection);
          if (gate.wait !== undefined) {
            if (latest.expiresAt > Date.now()) return latest;
            throw new MirrorError(
              'TOKEN_REFRESH_FAILED',
              'Token renewal failed recently and is paused briefly; the provider was not contacted. Retry shortly.',
              {connection_id: connection.id, retry_after_ms: gate.wait},
              503,
              true,
            );
          }
          return await this.refresh(connection, latest);
        } finally {
          this.store.releaseLock(key, owner);
        }
      }
      await delay(250);
    }
    throw new MirrorError(
      'REFRESH_IN_PROGRESS',
      'Another worker is refreshing this connection. Retry shortly.',
      {connection_id: connection.id, retry_after_ms: 5000},
      503,
      true,
    );
  }
  /** Record the outcome of a token request against the login it renewed (src/connection-health.ts). */
  private failed(
    connection: Connection,
    renewed: Credentials,
    e: unknown,
    status: number | null,
    rejected?: unknown,
  ): never {
    recordRefreshFailed(this.store, connection, renewed, {
      code:
        rejected === undefined ? (e instanceof MirrorError ? e.code : 'TOKEN_REFRESH_FAILED') : failureCode(rejected),
      http_status: status,
      grantRejected: typeof rejected === 'string' && grantRejections.includes(rejected),
    });
    throw e;
  }
  private async refresh(connection: Connection, c: Credentials): Promise<Credentials> {
    // The provider's part of the renewal (ARC-01 phase B, src/<provider>-adapter.ts): its own token request (Apple),
    // the app secret its login holds (X) and its parts of the refresh-token request (Microsoft, Snapchat, Reddit).
    // Everything else here, and the order, is this renewal's.
    const hooks = providerHooks(connection.gateway)?.refresh;
    // The deployment's OAuth app for this platform is not the one this login was authorized with (SEC-07 S2): the
    // login renews with the copy of its own app's secret it still holds, and its health says the client changed.
    const clientChanged = appClientChanged(connection.gateway, c, this.store.appEnvironment);
    if (clientChanged && !hooks?.own && !(hooks?.appSecret ? hooks.appSecret(c) : c.clientSecret))
      return this.failed(
        connection,
        c,
        new MirrorError(
          'REAUTHORIZATION_REQUIRED',
          'This login was authorized with an earlier OAuth app of this deployment, whose secret AMCP no longer holds. Reauthorize it from Connections; the provider was not contacted.',
          {connection_id: connection.id, reason: 'client_changed'},
          401,
        ),
        null,
        'client_changed',
      );
    if (hooks?.own) {
      let token: Credentials;
      try {
        token = await hooks.own(c, this.fetcher);
      } catch (e) {
        return this.failed(
          connection,
          c,
          e,
          e instanceof MirrorError && typeof e.details.status === 'number' ? e.details.status : null,
        );
      }
      const next = inheritLogin(token, c);
      this.store.completeCredentialRefresh(connection, c, next);
      recordRefreshSucceeded(this.store, connection, next, undefined, clientChanged);
      return next;
    }
    const endpoint = refreshEndpoints[connection.gateway];
    if (!endpoint || !c.refreshToken || !c.clientId || !c.clientSecret)
      throw new MirrorError(
        'REAUTHORIZATION_REQUIRED',
        'Credentials expired and this connection needs reauthorization.',
        {connection_id: connection.id},
        401,
      );
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: c.refreshToken,
      client_id: c.clientId,
      client_secret: c.clientSecret,
    });
    const headers: Record<string, string> = {};
    // The provider's parts of the request: Microsoft's scope, Snapchat's registered callback, Reddit's User-Agent and
    // Basic authentication; each refuses a request it cannot send.
    hooks?.request?.({body, headers}, c, connection);
    let response: Response;
    try {
      response = await this.fetcher(endpoint, {
        method: 'POST',
        body,
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      return this.failed(
        connection,
        c,
        new MirrorError(
          'TOKEN_REFRESH_FAILED',
          'Token refresh failed; platform requests were not attempted.',
          {connection_id: connection.id},
          503,
          true,
        ),
        null,
      );
    }
    let data: JsonObject;
    try {
      data = await readOAuthTokenBody(response);
    } catch (e) {
      return this.failed(connection, c, e, response.status);
    }
    if (
      !response.ok ||
      data.error !== undefined ||
      !usableBearerToken(data.access_token) ||
      (data.token_type !== undefined &&
        (typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer'))
    ) {
      this.store.appendAudit(connection.tenantId, 'auth/' + connection.id, {
        event: 'token_refresh_failed',
        connection_id: connection.id,
        status: response.status,
      });
      return this.failed(
        connection,
        c,
        new MirrorError(
          'TOKEN_REFRESH_FAILED',
          'Token refresh was rejected. Reauthorize the connection.',
          {connection_id: connection.id, status: response.status},
          401,
        ),
        response.status,
        data.error ?? 'token_refresh_rejected',
      );
    }
    let next: Credentials, loginExpiresAt: number | undefined;
    try {
      if (data.refresh_token !== undefined && !usableRefreshToken(data.refresh_token))
        throw new MirrorError('TOKEN_REFRESH_FAILED', 'Token service returned invalid refresh metadata.', {}, 502);
      // Preserve the existing one-hour default for providers that omit expires_in.
      // A refresh renews the same login: the result keeps its login revision (CON-01).
      next = inheritLogin(
        {
          ...c,
          accessToken: data.access_token,
          refreshToken: data.refresh_token ?? c.refreshToken,
          expiresAt: tokenExpiresAt(data.expires_in, 3600),
        },
        c,
      );
      // LinkedIn states how long its refresh token (the login) lasts; other providers do not.
      loginExpiresAt = optionalLifetimeEnd(data.refresh_token_expires_in);
    } catch (e) {
      return this.failed(connection, c, e, response.status);
    }
    this.store.completeCredentialRefresh(connection, c, next);
    recordRefreshSucceeded(this.store, connection, next, loginExpiresAt, clientChanged);
    return next;
  }
}

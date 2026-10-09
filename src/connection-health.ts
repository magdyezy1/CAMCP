import {MirrorError} from './errors.js';
import {credentialsLogin, loginRevision} from './connection-authority.js';
import type {Store} from './store.js';
import type {Connection, Credentials, JsonObject} from './types.js';

/**
 * Persisted credential health (CON-02). AMCP records what its own token refreshes observed, bound to the login
 * revision it observed them on, so Connections and MCP status can say whether a login renews automatically, when it
 * expires, and whether the provider rejected it, without contacting the provider.
 *
 * - A documented grant rejection from the token endpoint (`invalid_grant`, `invalid_token`) marks the login
 *   `reauthorization_required`. Later refreshes then fail fast with REAUTHORIZATION_REQUIRED and no provider request
 *   until the login is reauthorized (a new login revision) or an administrator chooses Retry.
 * - Any other refresh failure (network, 5xx, an undocumented 4xx) is `refresh_failed` with a bounded back-off.
 * - Records of an older login revision are ignored, so a reauthorization or re-provisioning starts clean.
 */
export const connectionHealthKind = 'connection_health';
/** A login that cannot renew itself is "expiring" this long before its expiry. */
export const loginExpiryWarningMs = 7 * 86400000;
const backoffMs = (failures: number) => Math.min(15 * 60000, 30000 * 2 ** Math.max(0, failures - 1));

export type CredentialHealthState =
  | 'healthy'
  | 'expiring'
  | 'refresh_failed'
  | 'reauthorization_required'
  | 'client_changed';

/** Token endpoints that renew a login in place; Meta, TikTok and X logins cannot be renewed without consent. */
export const refreshEndpoints: Record<string, string> = {
  google_sheets_native_action: 'https://oauth2.googleapis.com/token',
  google_drive_native_action: 'https://oauth2.googleapis.com/token',
  google_ads_native_action: 'https://oauth2.googleapis.com/token',
  dv360_native_action: 'https://oauth2.googleapis.com/token',
  ga4_native_action: 'https://oauth2.googleapis.com/token',
  gtm_native_action: 'https://oauth2.googleapis.com/token',
  google_business_native_action: 'https://oauth2.googleapis.com/token',
  google_search_console_native_action: 'https://oauth2.googleapis.com/token',
  snapchat_native_action: 'https://accounts.snapchat.com/login/oauth2/access_token',
  linkedin_native_action: 'https://www.linkedin.com/oauth/v2/accessToken',
  amazon_native_action: 'https://api.amazon.com/auth/o2/token',
  microsoft_ads_native_action: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  reddit_native_action: 'https://www.reddit.com/api/v1/access_token',
};

/** Whether AMCP can renew these credentials without the user (refresh token, or Apple client credentials). */
export function renewsAutomatically(gateway: string, c: Credentials): boolean {
  if (gateway === 'apple_ads_native_action') return !!c.clientId;
  return !!refreshEndpoints[gateway] && !!c.refreshToken && !!c.clientId && !!c.clientSecret;
}

interface StoredHealth extends JsonObject {
  connection_id: string;
  login_revision: number;
  login_id: string | null;
  state: 'healthy' | 'refresh_failed' | 'reauthorization_required';
}

const sameLogin = (record: JsonObject | undefined, c: Connection) =>
  !!record &&
  record.connection_id === c.id &&
  record.login_revision === loginRevision(c) &&
  (record.login_id ?? null) === (c.loginId ?? null);

/** The stored health of the connection's current login, or undefined when none was observed for it. */
export function storedHealth(store: Store, c: Connection): StoredHealth | undefined {
  try {
    const record = store.document(c.tenantId, connectionHealthKind, c.id);
    return sameLogin(record, c) ? (record as StoredHealth) : undefined;
  } catch (e) {
    if (e instanceof MirrorError && e.code === 'NOT_FOUND') return undefined;
    throw e;
  }
}

const currentConnection = (store: Store, connection: Connection) => {
  const current = store.listConnections(connection.tenantId).find(c => c.id === connection.id);
  return current && current.gateway === connection.gateway ? current : undefined;
};
/**
 * Write a record for the login stored now. When the credentials that were renewed are known, the record is written
 * only if they still belong to the stored login: an outcome observed on a replaced or removed login is dropped.
 */
function write(
  store: Store,
  connection: Connection,
  update: (previous: StoredHealth | undefined) => JsonObject,
  renewed?: Credentials,
) {
  store.transaction(() => {
    const current = currentConnection(store, connection),
      login = renewed && credentialsLogin(renewed);
    if (!current) return;
    if (login && (login.revision !== loginRevision(current) || login.login !== (current.loginId ?? null))) return;
    const previous = storedHealth(store, current);
    store.putDocument(current.tenantId, connectionHealthKind, current.id, {
      ...update(previous),
      connection_id: current.id,
      login_revision: loginRevision(current),
      login_id: current.loginId ?? null,
      updated_at: Date.now(),
    });
  });
}

/** A new authorization or reauthorization: the login is healthy, with its provider-stated lifetimes. */
export function recordAuthorized(
  store: Store,
  connection: Connection,
  credentials: Credentials,
  loginExpiresAt?: number | null,
): void {
  write(store, connection, () => ({
    state: 'healthy',
    renews_automatically: renewsAutomatically(connection.gateway, credentials),
    access_expires_at: credentials.expiresAt ?? null,
    login_expires_at: loginExpiresAt ?? null,
    last_refresh_at: null,
    last_failure: null,
    consecutive_failures: 0,
    next_retry_at: null,
  }));
}


/** A refresh renewed the login: healthy again, with the new access lifetime. */
export function recordRefreshSucceeded(
  store: Store,
  connection: Connection,
  next: Credentials,
  loginExpiresAt?: number,
): void {
  write(
    store,
    connection,
    previous => ({
      state: 'healthy',
      renews_automatically: renewsAutomatically(connection.gateway, next),
      access_expires_at: next.expiresAt ?? null,
      login_expires_at: loginExpiresAt ?? previous?.login_expires_at ?? null,
      last_refresh_at: Date.now(),
      last_failure: null,
      consecutive_failures: 0,
      next_retry_at: null,
    }),
    next,
  );
}

/** `grantRejected` only for the documented OAuth grant errors; anything else backs off and retries later. */
export function recordRefreshFailed(
  store: Store,
  connection: Connection,
  renewed: Credentials,
  failure: {code: string; http_status: number | null; grantRejected: boolean},
): void {
  write(
    store,
    connection,
    previous => {
      const failures = (Number(previous?.consecutive_failures) || 0) + 1,
        at = Date.now();
      return {
        state: failure.grantRejected ? 'reauthorization_required' : 'refresh_failed',
        renews_automatically: previous?.renews_automatically ?? true,
        access_expires_at: previous?.access_expires_at ?? null,
        login_expires_at: previous?.login_expires_at ?? null,
        last_refresh_at: previous?.last_refresh_at ?? null,
        last_failure: {code: failure.code, http_status: failure.http_status, at},
        consecutive_failures: failures,
        next_retry_at: failure.grantRejected ? null : at + backoffMs(failures),
      };
    },
    renewed,
  );
}

/** An administrator's explicit Retry: the next refresh may contact the provider again. */
export function clearRefreshFailure(store: Store, connection: Connection): boolean {
  const current = currentConnection(store, connection),
    record = current && storedHealth(store, current);
  if (!current || !record || record.state === 'healthy') return false;
  write(store, current, previous => ({
    ...previous,
    state: 'healthy',
    next_retry_at: null,
    consecutive_failures: 0,
    retry_requested_at: Date.now(),
  }));
  return true;
}

/**
 * Called before a refresh is attempted. Throws without any provider request while the provider's rejection stands,
 * and during a back-off returns `wait` so a still-valid token can be used instead.
 */
export function refreshGate(store: Store, connection: Connection): {wait?: number} {
  const current = currentConnection(store, connection),
    record = current && storedHealth(store, current);
  if (record?.state === 'reauthorization_required')
    throw new MirrorError(
      'REAUTHORIZATION_REQUIRED',
      'The provider rejected this login when AMCP last renewed it. Reauthorize it from Connections; no provider request was sent.',
      {connection_id: connection.id, since: record.last_failure?.at ?? null},
      401,
    );
  if (record?.state === 'refresh_failed' && Number(record.next_retry_at) > Date.now())
    return {wait: Number(record.next_retry_at) - Date.now()};
  return {};
}

export interface CredentialHealthView extends JsonObject {
  state: CredentialHealthState;
  renews_automatically: boolean;
  access_expires_at: number | null;
  login_expires_at: number | null;
  last_refresh_at: number | null;
  last_failure: {code: string; http_status: number | null; at: number} | null;
  next_retry_at: number | null;
  source: 'recorded' | 'credentials';
}

const derive = (
  recorded: string | undefined,
  login: number | null,
  now: number,
  clientChanged = false,
): CredentialHealthState => {
  if (recorded === 'reauthorization_required' || recorded === 'refresh_failed') return recorded;
  if (login !== null && login <= now) return 'reauthorization_required';
  if (clientChanged) return 'client_changed';
  if (login !== null && login - now <= loginExpiryWarningMs) return 'expiring';
  return 'healthy';
};

/**
 * What AMCP recorded about this login, without opening its credentials or contacting the provider (MCP connection
 * status). A login AMCP has not yet authorized or renewed since health was recorded reads `not_recorded`.
 */
export function recordedCredentialHealth(store: Store, connection: Connection, now = Date.now()): JsonObject {
  const record = storedHealth(store, connection);
  if (!record)
    return {
      state: 'not_recorded',
      source: 'none',
      meaning:
        'AMCP has not authorized or renewed this login since credential health was recorded. A provider rejection appears here after the next renewal attempt.',
    };
  const login = (record.login_expires_at as number | null | undefined) ?? null;
  return {
    state: derive(record.state, login, now),
    renews_automatically: record.renews_automatically === true,
    access_expires_at: record.access_expires_at ?? null,
    login_expires_at: login,
    last_refresh_at: record.last_refresh_at ?? null,
    last_failure: record.last_failure ?? null,
    next_retry_at: record.next_retry_at ?? null,
    source: 'recorded',
  };
}

/**
 * Metadata only, never tokens, and no provider request. `clientChanged` is supplied by the website, which knows the
 * configured OAuth client. A login that cannot renew itself and is past its expiry needs reauthorization even when no
 * refresh was attempted.
 */
export function credentialHealth(
  store: Store,
  connection: Connection,
  credentials: Credentials,
  options: {clientChanged?: boolean; now?: number} = {},
): CredentialHealthView {
  const now = options.now ?? Date.now(),
    record = storedHealth(store, connection),
    renews = renewsAutomatically(connection.gateway, credentials),
    access = credentials.expiresAt ?? null,
    login = (record?.login_expires_at as number | null | undefined) ?? (renews ? null : access);
  return {
    state: derive(record?.state, login, now, options.clientChanged),
    renews_automatically: renews,
    access_expires_at: access,
    login_expires_at: login,
    last_refresh_at: (record?.last_refresh_at as number | null | undefined) ?? null,
    last_failure: (record?.last_failure as CredentialHealthView['last_failure'] | undefined) ?? null,
    next_retry_at: (record?.next_retry_at as number | null | undefined) ?? null,
    source: record ? 'recorded' : 'credentials',
  };
}

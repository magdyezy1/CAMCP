import {sha256, stable} from './security.js';
import type {Connection, Credentials} from './types.js';
import type {Store} from './store.js';

/**
 * Which login a request is bound to (CON-01).
 *
 * A login is identified by the connection's login revision (and the random login id assigned when its row was
 * created). The store bumps the revision whenever credentials are written by anything other than AMCP's own token
 * refresh: a new authorization, a reauthorization, an administrator re-provisioning or a direct credential
 * replacement. `Store.completeCredentialRefresh` keeps it, so a routine refresh is never reported as a login change.
 * Fences that also compare scopes or accounts keep doing so; the revision replaces only the volatile token bytes.
 *
 * A real change refuses with CONNECTION_AUTHORITY_CHANGED (the login was replaced or lost permissions); the code
 * REAUTHORIZATION_REQUIRED stays for credentials that no longer work.
 *
 * `AMCP_AUTHORITY_FENCE=fingerprint` restores the previous credential-byte comparison as a short-lived rollback.
 */
export function authorityFence(): 'revision' | 'fingerprint' {
  return process.env.AMCP_AUTHORITY_FENCE === 'fingerprint' ? 'fingerprint' : 'revision';
}

/** The stored login revision; rows written before revisions existed read as revision 0. */
export function loginRevision(connection: Pick<Connection, 'loginRevision'> | undefined): number {
  const r = connection?.loginRevision;
  return typeof r === 'number' && Number.isSafeInteger(r) && r >= 0 ? r : 0;
}

/** A connection record without the store-assigned login fields, for comparing it with what a caller provisioned. */
export function provisionedRecord(connection: Connection): Connection {
  const {loginRevision: _revision, loginId: _id, ...rest} = connection;
  return rest;
}

export interface LoginRef {
  tenant: string;
  connection: string;
  gateway: string;
  revision: number;
  /** The random id of the stored row's first login; null on rows created before login ids existed. */
  login: string | null;
}
/** The login each decrypted credentials object was read from. Never serialized and never part of the secret. */
const provenance = new WeakMap<Credentials, LoginRef>();

/** Store-internal: record which login revision freshly decrypted credentials belong to. */
export function recordLogin<T extends Credentials>(credentials: T, ref: LoginRef): T {
  if (credentials && typeof credentials === 'object') provenance.set(credentials, {...ref});
  return credentials;
}

/** A refreshed copy belongs to the same login as the credentials it was refreshed from. */
export function inheritLogin<T extends Credentials>(next: T, from: Credentials): T {
  const ref = provenance.get(from);
  if (ref && next && typeof next === 'object') provenance.set(next, ref);
  return next;
}

/** The login these credentials were read under, when the store recorded it. */
export function credentialsLogin(credentials: Credentials): Readonly<LoginRef> | undefined {
  return provenance.get(credentials);
}

const revisionStamp = (ref: LoginRef, credentials: Credentials) =>
  'login:' + sha256(stable({...ref, client: credentials.clientId ?? credentials.consumerKey ?? null}));

/**
 * A comparable value naming the login these credentials belong to. Token refresh keeps it; a replaced login, a
 * re-pointed gateway or a different OAuth client changes it. Credentials whose origin is unknown (or the rollback
 * fence) fall back to their exact bytes, which can only refuse more, never accept a different login.
 */
export function loginStamp(credentials: Credentials): string {
  const ref = provenance.get(credentials);
  return ref && authorityFence() === 'revision'
    ? revisionStamp(ref, credentials)
    : 'credentials:' + sha256(stable(credentials));
}

/** The stamp of the login the store holds for this connection now. Throws when it was removed or re-pointed. */
export function storedLogin(store: Store, connection: Connection): string {
  return loginStamp(store.connectionCredentials(connection));
}

/**
 * Whether credentials in hand still belong to the login stored now. Identical credentials always do; otherwise both
 * must carry the same recorded login revision (a refresh of the same login).
 */
export function sameLogin(held: Credentials, stored: Credentials): boolean {
  if (stable(held) === stable(stored)) return true;
  const a = provenance.get(held),
    b = provenance.get(stored);
  return !!a && !!b && authorityFence() === 'revision' && revisionStamp(a, held) === revisionStamp(b, stored);
}

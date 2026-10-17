import type {Store} from '../src/store.js';
import type {JsonObject} from '../src/types.js';

/**
 * Website sessions, sign-in identities and account lookups of server/social-signin.ts and server/account-routes.ts in
 * the store layer (ARC-02), moved here verbatim. Sessions are keyed by the hash of their cookie value; no statement
 * reads a password, a secret or a token.
 */
// Sessions.
/** A live session's actor (JSON text), or undefined. */
export function liveSessionActor(store: Store, hash: string, now = Date.now()): JsonObject | undefined {
  return store.sql().prepare('SELECT actor FROM amcp_web_sessions WHERE hash=? AND expires_at>?').get(hash, now) as
    JsonObject | undefined;
}
/** A live session's actor (JSON text) and expiry, or undefined. */
export function liveSession(store: Store, hash: string, now = Date.now()): JsonObject | undefined {
  return store
    .sql()
    .prepare('SELECT actor,expires_at FROM amcp_web_sessions WHERE hash=? AND expires_at>?')
    .get(hash, now) as JsonObject | undefined;
}
/** Whether a session is live. */
export function sessionLive(store: Store, hash: string, now = Date.now()): boolean {
  return !!store.sql().prepare('SELECT hash FROM amcp_web_sessions WHERE hash=? AND expires_at>?').get(hash, now);
}
/** Renews a session's recent-proof time (a step-up), keeping its expiry. */
export function markSessionReauthenticated(store: Store, hash: string, at: number) {
  store.sql().prepare("UPDATE amcp_web_sessions SET actor=json_set(actor,'$.reauthAt',?) WHERE hash=?").run(at, hash);
}
/** Ends a session. */
export function deleteSession(store: Store, hash: string) {
  store.sql().prepare('DELETE FROM amcp_web_sessions WHERE hash=?').run(hash);
}
/** Ends the provider authorizations a session had in progress. */
export function deleteSessionAuthorizations(store: Store, hash: string) {
  store.sql().prepare('DELETE FROM amcp_oauth_states WHERE session_hash=?').run(hash);
}
/** A person's live sessions in one workspace (hash, actor JSON text, expiry). */
export function personSessions(store: Store, userId: string, tenant: string, now = Date.now()): JsonObject[] {
  return store
    .sql()
    .prepare(
      "SELECT hash,actor,expires_at FROM amcp_web_sessions WHERE json_extract(actor,'$.userId')=? AND json_extract(actor,'$.tenantId')=? AND expires_at>?",
    )
    .all(userId, tenant, now) as JsonObject[];
}

// Sign-in identities.
/** Whether a person has a sign-in identity of this provider. */
export function hasIdentity(store: Store, userId: string, provider: string): boolean {
  return !!store.sql().prepare('SELECT 1 FROM amcp_identities WHERE user_id=? AND provider=?').get(userId, provider);
}
/** The person a provider identity is linked to (user_id), or undefined. */
export function identityOwner(store: Store, provider: string, subject: string): JsonObject | undefined {
  return store
    .sql()
    .prepare('SELECT user_id FROM amcp_identities WHERE provider=? AND subject=?')
    .get(provider, subject) as JsonObject | undefined;
}
/** A person's identity subject at a provider, or undefined. */
export function personIdentity(store: Store, userId: string, provider: string): JsonObject | undefined {
  return store
    .sql()
    .prepare('SELECT subject FROM amcp_identities WHERE user_id=? AND provider=?')
    .get(userId, provider) as JsonObject | undefined;
}
/** Links a provider identity to a person. */
export function addIdentity(store: Store, provider: string, subject: string, userId: string, at: number) {
  store.sql().prepare('INSERT INTO amcp_identities VALUES(?,?,?,?)').run(provider, subject, userId, at);
}

// Accounts.
/** The account that holds an e-mail address (its id), or undefined. */
export function accountWithEmail(store: Store, email: string): JsonObject | undefined {
  return store.sql().prepare('SELECT id FROM amcp_users WHERE email=?').get(email) as JsonObject | undefined;
}
/** An enabled account's id and version (for its known-device cookie), or undefined. */
export function enabledAccountVersion(store: Store, userId: string): JsonObject | undefined {
  return store.sql().prepare('SELECT id,version FROM amcp_users WHERE id=? AND disabled=0').get(userId) as
    JsonObject | undefined;
}
/** A workspace's queued e-mails counted by state, with each state's next attempt (Account → e-mail delivery). */
export function emailDeliveryStates(store: Store, tenant: string): JsonObject[] {
  return store
    .sql()
    .prepare(
      'SELECT state,count(*) AS count,min(available_at) AS nextAttempt FROM amcp_email_outbox WHERE tenant_id=? GROUP BY state',
    )
    .all(tenant) as JsonObject[];
}

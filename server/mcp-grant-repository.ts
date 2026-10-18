import type {Store} from '../src/store.js';
import type {JsonObject} from '../src/types.js';

/**
 * The AI-client authorization statements of server/mcp-grants.ts and server/mcp-oauth.ts in the store layer (ARC-02),
 * moved here verbatim. Grants (consent requests, codes, access and refresh grants) are keyed by the hash of their token;
 * no statement reads or stores token material.
 */
/** The unused grants a caller's condition on the unaliased amcp_mcp_grants table selects. */
export function liveGrants(store: Store, where: string, params: unknown[]): JsonObject[] {
  return store
    .sql()
    .prepare('SELECT hash,kind,client_id,tenant_id,data FROM amcp_mcp_grants WHERE used=0 AND (' + where + ')')
    .all(...(params as never[])) as JsonObject[];
}
/** Marks one grant used, with why and when it ended. */
export function endGrant(store: Store, hash: string, reason: string, at: number) {
  store
    .sql()
    .prepare("UPDATE amcp_mcp_grants SET used=1,data=json_set(data,'$.ended_reason',?,'$.ended_at',?) WHERE hash=?")
    .run(reason, at, hash);
}
/** Revokes one API key of a workspace by its hash: an ended access grant's, or a revoked connector token's. */
export function revokeGrantKey(store: Store, tenant: string, hash: string) {
  store.sql().prepare('UPDATE api_keys SET revoked=1 WHERE tenant_id=? AND hash=?').run(tenant, hash);
}
/** The reason recorded on the newest ended grant of a token family, or undefined. */
export function familyEndRow(store: Store, tenant: string, family: string): {reason?: string} | undefined {
  return store
    .sql()
    .prepare(
      "SELECT json_extract(data,'$.ended_reason') AS reason FROM amcp_mcp_grants WHERE tenant_id=? AND kind IN ('access','refresh') AND json_extract(data,'$.family')=? AND json_extract(data,'$.ended_reason') IS NOT NULL ORDER BY json_extract(data,'$.ended_at') DESC LIMIT 1",
    )
    .get(tenant, family) as {reason?: string} | undefined;
}
/** The condition (workspace, family) that selects a token family's access and refresh grants, for endMcpGrants. */
export const familyGrants = "tenant_id=? AND kind IN ('access','refresh') AND json_extract(data,'$.family')=?";
/**
 * The condition that selects a client's grants in a workspace (client, workspace), for endMcpGrants: every person's
 * (`owner` undefined), those approved from the administrator sign-in (null), or one person's (a user id, a third value).
 */
export function clientGrants(owner: string | null | undefined): string {
  return (
    'client_id=? AND tenant_id=?' +
    (owner === undefined
      ? ''
      : owner === null
        ? " AND json_extract(data,'$.ownerUserId') IS NULL"
        : " AND json_extract(data,'$.ownerUserId')=?")
  );
}

// The authorization server (server/mcp-oauth.ts).
/** Stores a grant: its token's hash, kind, client, workspace, data and expiry; it starts unused. */
export function insertGrant(
  store: Store,
  hash: string,
  kind: string,
  client: string,
  tenant: string,
  data: string,
  expiresAt: number,
) {
  store
    .sql()
    .prepare('INSERT INTO amcp_mcp_grants VALUES(?,?,?,?,?,?,0)')
    .run(hash, kind, client, tenant, data, expiresAt);
}
/** A grant by its token's hash and kind (every column, data as JSON text), or undefined. */
export function grantByHash(store: Store, hash: string, kind: string): JsonObject | undefined {
  return store.sql().prepare('SELECT * FROM amcp_mcp_grants WHERE hash=? AND kind=?').get(hash, kind) as
    JsonObject | undefined;
}
/** Deletes the consent requests and codes that expired before `now`. */
export function deleteExpiredAuthorizations(store: Store, now: number) {
  store.sql().prepare("DELETE FROM amcp_mcp_grants WHERE kind IN ('request','code') AND expires_at<?").run(now);
}
/** Marks a grant used. */
export function markGrantUsed(store: Store, hash: string) {
  store.sql().prepare('UPDATE amcp_mcp_grants SET used=1 WHERE hash=?').run(hash);
}
/** Marks a code used and replaces its data (JSON text: the token family it issued). */
export function useGrantWith(store: Store, hash: string, data: string) {
  store.sql().prepare('UPDATE amcp_mcp_grants SET used=1,data=? WHERE hash=?').run(data, hash);
}
/**
 * Removes expired access grants with their keys and key owners, and expired refresh grants already rotated away. Each
 * client keeps its newest refresh grant, so a registration still in use is never orphaned for the unused-client
 * cleanup.
 */
export function pruneGrants(store: Store, now: number) {
  const db = store.sql(),
    expired = "SELECT hash FROM amcp_mcp_grants WHERE kind='access' AND expires_at<?";
  db.prepare('DELETE FROM credential_owners WHERE hash IN (' + expired + ')').run(now);
  db.prepare('DELETE FROM api_keys WHERE hash IN (' + expired + ')').run(now);
  db.prepare("DELETE FROM amcp_mcp_grants WHERE kind='access' AND expires_at<?").run(now);
  db.prepare(
    "DELETE FROM amcp_mcp_grants WHERE kind='refresh' AND used=1 AND expires_at<? AND EXISTS(SELECT 1 FROM amcp_mcp_grants o WHERE o.client_id=amcp_mcp_grants.client_id AND o.kind='refresh' AND o.expires_at>amcp_mcp_grants.expires_at)",
  ).run(now);
}
/** Marks a refresh grant rotated at `at`, naming the hash of the refresh grant that replaced it. */
export function markRotated(store: Store, hash: string, at: number, successor: string) {
  store
    .sql()
    .prepare("UPDATE amcp_mcp_grants SET used=1,data=json_set(data,'$.rotated_at',?,'$.successor',?) WHERE hash=?")
    .run(at, successor, hash);
}
/** A refresh grant of this client and workspace by its hash (hash, data, used, expiry), or undefined. */
export function refreshGrant(store: Store, hash: string, client: string, tenant: string): JsonObject | undefined {
  return store
    .sql()
    .prepare(
      "SELECT hash,data,used,expires_at FROM amcp_mcp_grants WHERE hash=? AND kind='refresh' AND client_id=? AND tenant_id=?",
    )
    .get(hash, client, tenant) as JsonObject | undefined;
}
/** The unused access grants of a workspace issued together with the refresh grant `pair` (their hashes). */
export function pairedAccessGrants(store: Store, tenant: string, pair: string): JsonObject[] {
  return store
    .sql()
    .prepare(
      "SELECT hash FROM amcp_mcp_grants WHERE tenant_id=? AND kind='access' AND used=0 AND json_extract(data,'$.pair')=?",
    )
    .all(tenant, pair) as JsonObject[];
}
/** Supersedes an access grant at `at` and revokes its key. */
export function supersedeAccessGrant(store: Store, tenant: string, hash: string, at: number) {
  const db = store.sql();
  db.prepare("UPDATE amcp_mcp_grants SET used=1,data=json_set(data,'$.superseded_at',?) WHERE hash=?").run(at, hash);
  db.prepare('UPDATE api_keys SET revoked=1 WHERE tenant_id=? AND hash=?').run(tenant, hash);
}
/** Names the refresh grant (by hash) that now replaces this one. */
export function setSuccessor(store: Store, hash: string, successor: string) {
  store
    .sql()
    .prepare("UPDATE amcp_mcp_grants SET data=json_set(data,'$.successor',?) WHERE hash=?")
    .run(successor, hash);
}
/** An access grant by its hash (client, workspace, data, expiry, used), or undefined. */
export function accessGrant(store: Store, hash: string): JsonObject | undefined {
  return store
    .sql()
    .prepare("SELECT client_id,tenant_id,data,expires_at,used FROM amcp_mcp_grants WHERE hash=? AND kind='access'")
    .get(hash) as JsonObject | undefined;
}
/** A grant of any kind issued to this client, by its hash (data and workspace), or undefined. */
export function clientGrant(store: Store, hash: string, client: string): {data: string; tenant_id: string} | undefined {
  return store
    .sql()
    .prepare('SELECT data,tenant_id FROM amcp_mcp_grants WHERE hash=? AND client_id=?')
    .get(hash, client) as {data: string; tenant_id: string} | undefined;
}
/** A grant of this kind issued to this client, by its hash (workspace and data), or undefined. */
export function clientGrantOfKind(
  store: Store,
  hash: string,
  kind: string,
  client: string,
): {tenant_id: string; data: string} | undefined {
  return store
    .sql()
    .prepare('SELECT tenant_id,data FROM amcp_mcp_grants WHERE hash=? AND kind=? AND client_id=?')
    .get(hash, kind, client) as {tenant_id: string; data: string} | undefined;
}
/** Reads account names by id: one prepared statement for a list of the people who approved connections. */
export function accountNames(store: Store): (id: string) => {name?: string} | undefined {
  const byId = store.sql().prepare('SELECT name FROM amcp_users WHERE id=?');
  return id => byId.get(id) as {name?: string} | undefined;
}
/** A workspace's unused, unexpired refresh grants with their client's registration (client, expiry, data). */
export function liveRefreshGrants(store: Store, tenant: string, now: number): JsonObject[] {
  return store
    .sql()
    .prepare(
      "SELECT g.client_id,g.expires_at,g.data AS grant_data,c.data FROM amcp_mcp_grants g LEFT JOIN amcp_mcp_clients c ON c.id=g.client_id WHERE g.tenant_id=? AND g.kind='refresh' AND g.used=0 AND g.expires_at>?",
    )
    .all(tenant, now) as JsonObject[];
}
/**
 * A workspace's connections that ended after `since`, newest first, one per client and approving person, leaving out
 * those the same person authorized again (a live refresh grant at `now`): at most 20.
 */
export function endedRefreshGrants(store: Store, tenant: string, since: number, now: number): JsonObject[] {
  return store
    .sql()
    .prepare(
      "SELECT g.client_id,json_extract(g.data,'$.ownerUserId') AS owner,max(json_extract(g.data,'$.ended_at')) AS ended_at,json_extract(g.data,'$.ended_reason') AS reason,json_extract(g.data,'$.clientName') AS grant_name,c.data FROM amcp_mcp_grants g LEFT JOIN amcp_mcp_clients c ON c.id=g.client_id WHERE g.tenant_id=? AND g.kind='refresh' AND json_extract(g.data,'$.ended_at')>? AND NOT EXISTS(SELECT 1 FROM amcp_mcp_grants l WHERE l.tenant_id=g.tenant_id AND l.client_id=g.client_id AND json_extract(l.data,'$.ownerUserId') IS json_extract(g.data,'$.ownerUserId') AND l.kind='refresh' AND l.used=0 AND l.expires_at>?) GROUP BY g.client_id,json_extract(g.data,'$.ownerUserId') ORDER BY ended_at DESC LIMIT 20",
    )
    .all(tenant, since, now) as JsonObject[];
}

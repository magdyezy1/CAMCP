import type {Store} from './store.js';
export {tableExists} from './owner-health-repository.js';

/**
 * The registered AI-client (MCP OAuth) statements of src/mcp-clients.ts in the store layer (ARC-02), moved here
 * verbatim. Registrations and their grants are deployment wide (dynamic client registration is anonymous), so these
 * statements are not bound to a workspace; an MCP-only store has neither table, which the caller checks first.
 */
/** Registrations issued at or after `issuedSince` (seconds): how many, and the oldest issue time (seconds). */
export function registrationsSince(store: Store, issuedSince: number): {n: number; oldest: number | null} {
  return store
    .sql()
    .prepare(
      "SELECT count(*) AS n,min(json_extract(data,'$.client_id_issued_at')) AS oldest FROM amcp_mcp_clients WHERE json_extract(data,'$.client_id_issued_at')>=?",
    )
    .get(issuedSince) as {n: number; oldest: number | null};
}
/**
 * Registered clients issued before `issuedBefore` (seconds) with no grant that is unused and unexpired at `now`, and
 * whose newest grant expired before `graceCutoff` (or which never had one).
 */
export function idleRegisteredClients(store: Store, issuedBefore: number, now: number, graceCutoff: number): string[] {
  return (
    store
      .sql()
      .prepare(
        `SELECT c.id FROM amcp_mcp_clients c
         WHERE json_extract(c.data,'$.client_id_issued_at')<?
           AND NOT EXISTS(SELECT 1 FROM amcp_mcp_grants g WHERE g.client_id=c.id AND g.used=0 AND g.expires_at>?)
           AND coalesce((SELECT max(g.expires_at) FROM amcp_mcp_grants g WHERE g.client_id=c.id),0)<?`,
      )
      .all(issuedBefore, now, graceCutoff) as {id: string}[]
  ).map(r => r.id);
}
/**
 * Clients that hold grant rows without a registration row (a client identified by its metadata document URL, or an
 * orphan), with no grant unused and unexpired at `now` and none expiring at or after `graceCutoff`.
 */
export function idleUnregisteredClients(store: Store, now: number, graceCutoff: number): string[] {
  return (
    store
      .sql()
      .prepare(
        `SELECT client_id AS id FROM amcp_mcp_grants WHERE client_id NOT IN (SELECT id FROM amcp_mcp_clients)
           GROUP BY client_id HAVING sum(used=0 AND expires_at>?)=0 AND max(expires_at)<?`,
      )
      .all(now, graceCutoff) as {id: string}[]
  ).map(r => r.id);
}
/** Deletes a client's grant rows, with the owners and keys of its access grants that expired by `now`. */
export function deleteClientGrants(store: Store, clientId: string, now: number) {
  const db = store.sql(),
    keys = "SELECT hash FROM amcp_mcp_grants WHERE client_id=? AND kind='access'";
  db.prepare(
    'DELETE FROM credential_owners WHERE hash IN (' +
      keys +
      ') AND hash IN (SELECT hash FROM api_keys WHERE expires_at<=?)',
  ).run(clientId, now);
  db.prepare('DELETE FROM api_keys WHERE hash IN (' + keys + ') AND expires_at<=?').run(clientId, now);
  db.prepare('DELETE FROM amcp_mcp_grants WHERE client_id=?').run(clientId);
}
/** Deletes a client's registration row. */
export function deleteRegisteredClient(store: Store, id: string) {
  store.sql().prepare('DELETE FROM amcp_mcp_clients WHERE id=?').run(id);
}
/** How many clients are registered. */
export function registeredClientCount(store: Store): number {
  return (store.sql().prepare('SELECT count(*) AS n FROM amcp_mcp_clients').get() as {n: number}).n;
}
/** A registered client's stored metadata (JSON text, its secret sealed), or undefined (server/mcp-oauth.ts). */
export function registeredClient(store: Store, id: string): {data: string} | undefined {
  return store.sql().prepare('SELECT data FROM amcp_mcp_clients WHERE id=?').get(id) as {data: string} | undefined;
}
/** Registers a client with its metadata (JSON text, its secret already sealed). */
export function insertRegisteredClient(store: Store, id: string, data: string) {
  store.sql().prepare('INSERT INTO amcp_mcp_clients VALUES(?,?)').run(id, data);
}

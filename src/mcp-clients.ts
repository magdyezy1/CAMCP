import type {Store} from './store.js';

/**
 * Registered MCP OAuth clients (dynamic client registration). Registration is anonymous and the table is deployment
 * wide, so it is capped; a client is released once nothing it was issued can be used any more (MCP-03, review
 * 2026-10-08). Before this rule, any grant row at all kept a client, and token pruning keeps each client's newest
 * refresh row for good, so the cap filled permanently.
 */
export const mcpClientLimit = 1000;
/** How long after its newest grant expired a client stays registered, so a client that comes back soon finds it. */
export const mcpClientReleaseGraceMs = 7 * 86400000;
/** A registration that was never used for this long is released, as before. */
export const mcpClientUnusedMs = 86400000;

const tableExists = (store: Store, name: string) =>
  !!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

/**
 * The registered clients the next registration releases: issued more than a day ago, with no live grant (no access,
 * refresh, code or consent request that is unused and unexpired), and whose newest grant expired more than the grace
 * period ago (or which never had one).
 */
export function releasableMcpClients(store: Store, now = Date.now()): string[] {
  if (!tableExists(store, 'amcp_mcp_clients') || !tableExists(store, 'amcp_mcp_grants')) return [];
  return (
    store.db
      .prepare(
        `SELECT c.id FROM amcp_mcp_clients c
         WHERE json_extract(c.data,'$.client_id_issued_at')<?
           AND NOT EXISTS(SELECT 1 FROM amcp_mcp_grants g WHERE g.client_id=c.id AND g.used=0 AND g.expires_at>?)
           AND coalesce((SELECT max(g.expires_at) FROM amcp_mcp_grants g WHERE g.client_id=c.id),0)<?`,
      )
      .all(Math.floor((now - mcpClientUnusedMs) / 1000), now, now - mcpClientReleaseGraceMs) as {id: string}[]
  ).map(r => r.id);
}

/**
 * Releases the clients releasableMcpClients names, with their grant rows and the expired keys of their access grants,
 * in one transaction. Grant rows of a client without a registration row (a client identified by its metadata
 * document URL, or an orphan) are removed under the same rule. Returns how many registrations were released.
 */
export function releaseStaleMcpClients(store: Store, now = Date.now()): number {
  if (!tableExists(store, 'amcp_mcp_clients') || !tableExists(store, 'amcp_mcp_grants')) return 0;
  return store.transaction(() => {
    const db = store.db,
      ids = releasableMcpClients(store, now);
    const unregistered = (
      db
        .prepare(
          `SELECT client_id AS id FROM amcp_mcp_grants WHERE client_id NOT IN (SELECT id FROM amcp_mcp_clients)
           GROUP BY client_id HAVING sum(used=0 AND expires_at>?)=0 AND max(expires_at)<?`,
        )
        .all(now, now - mcpClientReleaseGraceMs) as {id: string}[]
    ).map(r => r.id);
    for (const id of [...ids, ...unregistered]) {
      const keys = "SELECT hash FROM amcp_mcp_grants WHERE client_id=? AND kind='access'";
      db.prepare(
        'DELETE FROM credential_owners WHERE hash IN (' +
          keys +
          ') AND hash IN (SELECT hash FROM api_keys WHERE expires_at<=?)',
      ).run(id, now);
      db.prepare('DELETE FROM api_keys WHERE hash IN (' + keys + ') AND expires_at<=?').run(id, now);
      db.prepare('DELETE FROM amcp_mcp_grants WHERE client_id=?').run(id);
    }
    for (const id of ids) db.prepare('DELETE FROM amcp_mcp_clients WHERE id=?').run(id);
    return ids.length;
  });
}

/** The registered-client count and its headroom under the cap, for the owner's health view. */
export function mcpClientCapacity(store: Store, now = Date.now()) {
  if (!tableExists(store, 'amcp_mcp_clients'))
    return {registered: 0, limit: mcpClientLimit, headroom: mcpClientLimit, releasable_on_next_registration: 0};
  const registered = (store.db.prepare('SELECT count(*) AS n FROM amcp_mcp_clients').get() as {n: number}).n,
    releasable = releasableMcpClients(store, now).length;
  return {
    registered,
    limit: mcpClientLimit,
    headroom: Math.max(0, mcpClientLimit - registered),
    releasable_on_next_registration: releasable,
  };
}

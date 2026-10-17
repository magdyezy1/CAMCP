import type {Store} from './store.js';

/**
 * The statements of a local disconnect (src/connection-disconnect.ts) on the `connections` and `resource_ownership`
 * tables, in the store layer (ARC-02), moved here verbatim. The documents a login takes with it are declared with
 * `connection` in src/document-kinds.ts and deleted through their repositories.
 */
/** Every login of a workspace: its id and stored record (JSON text). */
export function connectionRows(store: Store, tenant: string): {id: string; data: string}[] {
  return store.sql().prepare('SELECT id,data FROM connections WHERE tenant_id=?').all(tenant) as {
    id: string;
    data: string;
  }[];
}
/** The platforms (gateways) of a workspace's saved logins, sorted. */
export function connectionGateways(store: Store, tenant: string): {gateway: unknown}[] {
  return store
    .sql()
    .prepare("SELECT DISTINCT json_extract(data,'$.gateway') AS gateway FROM connections WHERE tenant_id=? ORDER BY 1")
    .all(tenant) as {gateway: unknown}[];
}
/** How many active memberships a person has in workspaces other than `tenant`. */
export function otherActiveMemberships(store: Store, userId: string, tenant: string): number {
  return Number(
    (
      store
        .sql()
        .prepare('SELECT count(*) AS n FROM workspace_memberships WHERE user_id=? AND tenant_id<>? AND active=1')
        .get(userId, tenant) as {n: number}
    ).n,
  );
}
/** A login's stored record (its JSON text) in a workspace, or undefined. */
export function connectionRow(store: Store, tenant: string, id: string): {data: string} | undefined {
  return store.sql().prepare('SELECT data FROM connections WHERE tenant_id=? AND id=?').get(tenant, id) as
    {data: string} | undefined;
}
/** Deletes the resource bindings recorded through a login; how many. */
export function deleteResourceBindings(store: Store, tenant: string, connectionId: string): number {
  return Number(
    store
      .sql()
      .prepare('DELETE FROM resource_ownership WHERE tenant_id=? AND connection_id=?')
      .run(tenant, connectionId).changes,
  );
}
/** Deletes a login's stored record, with its encrypted credentials. */
export function deleteConnectionRow(store: Store, tenant: string, id: string) {
  store.sql().prepare('DELETE FROM connections WHERE tenant_id=? AND id=?').run(tenant, id);
}

import type {Store} from '../src/store.js';
import type {Connection, JsonObject} from '../src/types.js';

/**
 * The website's statements on AMCP's tables, in the store layer (ARC-02, tools/check-storage-boundary.mjs). They moved
 * here verbatim from createWebsite (ARC-04 stage D): a login's label and default flag, a login's asset selection, and
 * how much access a client access set limits. Revoking a connector token reuses revokeGrantKey
 * (server/mcp-grant-repository.ts), the same statement.
 */
/** Only the label changes: the stored login revision and grants stay as they are now (CON-01). */
export function writeConnectionLabel(store: Store, tenant: string, id: string, label: string) {
  return store
    .sql()
    .prepare("UPDATE connections SET data=json_set(data,'$.label',?) WHERE tenant_id=? AND id=?")
    .run(label, tenant, id);
}
/** A login's selected assets (website_assets), replaced whole; the document's revision advances. */
export function saveWebsiteAssets(store: Store, tenant: string, id: string, assets: JsonObject) {
  store
    .sql()
    .prepare(
      'INSERT INTO documents(tenant_id,kind,id,data) VALUES(?,?,?,?) ON CONFLICT(tenant_id,kind,id) DO UPDATE SET data=excluded.data,revision=documents.revision+1',
    )
    .run(tenant, 'website_assets', id, JSON.stringify(assets));
}
/** One login of a platform with its default flag set or cleared; nothing else of it changes. */
export function writeDefaultFlag(store: Store, tenant: string, connection: Connection, isDefault: boolean) {
  store
    .sql()
    .prepare('UPDATE connections SET data=? WHERE tenant_id=? AND id=?')
    .run(JSON.stringify({...connection, isDefault}), tenant, connection.id);
}
/**
 * How much access client access sets limit (SEC-08): a reader of one set's live, unexpired credentials and its active
 * members, with both statements prepared once for a listing.
 */
export function accessSetUse(store: Store) {
  const db = store.sql(),
    tokens = db.prepare(
      'SELECT count(*) AS n FROM api_keys WHERE tenant_id=? AND access_set_id=? AND revoked=0 AND (expires_at IS NULL OR expires_at>?)',
    ),
    members = db.prepare(
      "SELECT count(*) AS n FROM documents d JOIN workspace_memberships m ON m.tenant_id=d.tenant_id AND m.user_id=d.id AND m.active=1 WHERE d.tenant_id=? AND d.kind='member_access_set' AND json_extract(d.data,'$.access_set_id')=?",
    );
  return (tenant: string, id: string, now: number) => ({
    credentials: (tokens.get(tenant, id, now) as JsonObject).n,
    members: (members.get(tenant, id) as JsonObject).n,
  });
}

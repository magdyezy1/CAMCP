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
// Memberships granted by AMCP_ADMIN_EMAIL (r25-admin-email, server/admin-email.ts): the statements of the grant and of
// its end, in the store layer. A grant is a `member_grant` document in the deployment workspace (the document id is the
// person's user id, the member_access_set precedent): its `granted_by` names the variable and its `granted_from` holds the
// role the person had before it. The memberships table itself is untouched: code and tests insert into it by position.
/** The document kind that records a grant (declared in src/document-kinds.ts). */
export const memberGrantKind = 'member_grant';
/** An account's row, or undefined. */
export function accountRow(store: Store, id: unknown): JsonObject | undefined {
  return store
    .sql()
    .prepare('SELECT * FROM amcp_users WHERE id=?')
    .get(id as string) as JsonObject | undefined;
}
/** Approves an account that is pending; whether it was. */
export function approvePending(store: Store, id: unknown): boolean {
  return (
    store
      .sql()
      .prepare('UPDATE amcp_users SET approved=1 WHERE id=? AND approved=0')
      .run(id as string).changes > 0
  );
}
/** A person's membership of a workspace, active or not, or undefined. */
export function membershipRow(store: Store, tenant: string, userId: unknown): JsonObject | undefined {
  return store
    .sql()
    .prepare('SELECT role,active FROM workspace_memberships WHERE tenant_id=? AND user_id=?')
    .get(tenant, userId as string) as JsonObject | undefined;
}
/** A new active membership made by a grant. */
export function insertGrantedMembership(store: Store, tenant: string, userId: unknown, role: string) {
  store
    .sql()
    .prepare('INSERT INTO workspace_memberships(tenant_id,user_id,role,active,created_at) VALUES(?,?,?,1,?)')
    .run(tenant, userId as string, role, Date.now());
}
/** An existing membership (active or not) made `role` and active by a grant. */
export function raiseMembership(store: Store, tenant: string, userId: unknown, role: string) {
  store
    .sql()
    .prepare('UPDATE workspace_memberships SET role=?,active=1 WHERE tenant_id=? AND user_id=?')
    .run(role, tenant, userId as string);
}
/** Records a grant: who made the role, and the role held before it (absent: none). */
export function recordGrant(store: Store, tenant: string, userId: string, by: string, from: string | null) {
  store.putDocument(tenant, memberGrantKind, userId, {granted_by: by, ...(from ? {granted_from: from} : {})});
}
/** A person's grant record in a workspace, or undefined. */
export function grantRecord(store: Store, tenant: string, userId: string): JsonObject | undefined {
  return store.repo(memberGrantKind, tenant).payload(userId) as JsonObject | undefined;
}
/** Drops a grant record and leaves the membership as it is. */
export function clearGrantRecord(store: Store, tenant: string, userId: string) {
  store.deleteDocument(tenant, memberGrantKind, userId);
}
/** The grants a variable made, in every workspace, each with its membership (role, active) and its account's address, disabled and test flags; optionally one person's. */
export function grantedMemberships(store: Store, by: string, userId?: string): JsonObject[] {
  return store
    .sql()
    .prepare(
      "SELECT d.tenant_id,d.id AS user_id,m.role,m.active,u.email,u.disabled,u.test_account FROM documents d LEFT JOIN workspace_memberships m ON m.tenant_id=d.tenant_id AND m.user_id=d.id LEFT JOIN amcp_users u ON u.id=d.id WHERE d.kind='member_grant' AND json_extract(d.data,'$.granted_by')=?" +
        (userId === undefined ? '' : ' AND d.id=?'),
    )
    .all(...(userId === undefined ? [by] : [by, userId])) as JsonObject[];
}
/** Puts a membership back to `role`. */
export function restoreMembership(store: Store, tenant: string, userId: string, role: string) {
  store
    .sql()
    .prepare('UPDATE workspace_memberships SET role=? WHERE tenant_id=? AND user_id=?')
    .run(role, tenant, userId);
}
/** Ends a granted membership: inactive, with the least role. */
export function endGrantedMembership(store: Store, tenant: string, userId: string) {
  store
    .sql()
    .prepare("UPDATE workspace_memberships SET active=0,role='viewer' WHERE tenant_id=? AND user_id=?")
    .run(tenant, userId);
}
/** A person's website sessions and connector keys in one workspace stop (their AI-client grants end separately). */
export function endPersonSessionsAndKeys(store: Store, tenant: string, userId: string) {
  const db = store.sql();
  db.prepare(
    "DELETE FROM amcp_web_sessions WHERE json_extract(actor,'$.userId')=? AND json_extract(actor,'$.tenantId')=?",
  ).run(userId, tenant);
  db.prepare(
    'UPDATE api_keys SET revoked=1 WHERE tenant_id=? AND hash IN (SELECT hash FROM credential_owners WHERE user_id=?)',
  ).run(tenant, userId);
}
/**
 * The address of the earliest owner of a workspace: an owner a person or the owner chose before one a variable granted,
 * then by membership, account and id, so the answer never depends on row order. Absent when no owner has an address.
 */
export function earliestOwnerEmail(store: Store, tenant: string): string | undefined {
  const row = store
    .sql()
    .prepare(
      "SELECT u.email AS email FROM amcp_users u JOIN workspace_memberships m ON m.user_id=u.id WHERE m.tenant_id=? AND m.role='owner' AND m.active=1 AND u.disabled=0 AND u.email IS NOT NULL ORDER BY EXISTS (SELECT 1 FROM documents g WHERE g.tenant_id=m.tenant_id AND g.kind='member_grant' AND g.id=m.user_id),m.created_at,u.created_at,u.id LIMIT 1",
    )
    .get(tenant) as JsonObject | undefined;
  return typeof row?.email === 'string' ? row.email : undefined;
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

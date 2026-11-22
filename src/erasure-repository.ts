import type {Store} from './store.js';
import type {JsonObject} from './types.js';
import {deleteRowsOneByOne} from './media-storage.js';
import {personDocumentsCondition} from './document-kinds.js';
import {sha256} from './security.js';
import {tableExists} from './owner-health-repository.js';
export {tableExists};

/**
 * The statements of account erasure and account retention (SEC-07 S4, owner decision P3; src/account-erasure.ts) in
 * the store layer (ARC-02), moved here verbatim. An erasure deletes, in order, the rows `erasureSteps` lists: the
 * workspace's own rows, the person's rows in other workspaces (the document kinds src/document-kinds.ts declares with
 * a `person`), their keys and grants, and the account.
 */
export interface ErasureStep {
  table: string;
  where: string;
  params: (string | number)[];
  /** Media chunks go one row per statement, outside the transaction, so the log stays small (OPS-01). */
  oneByOne?: boolean;
}
/**
 * Every row of an erasure, in deletion order (the workspace's own rows, then keys and grants, then the account). The
 * keys are listed first: the workspace's keys, the person's keys in other workspaces and their AI-client access.
 * Without an account (a workspace named by a receipt alone) there is no person: every step keeps only its workspace
 * clause, and a step that only follows the person matches nothing (`0`). Before, the person's clauses were bound to an
 * empty id and deleted any row of any workspace whose person field was the empty string.
 */
export function erasureSteps(store: Store, user: JsonObject | undefined, tenant: string): ErasureStep[] {
  const id = String(user?.id ?? ''),
    known = id !== '',
    emailHash = typeof user?.email === 'string' ? sha256(user.email.toLowerCase()) : '',
    // The person's documents in other workspaces, from the kinds that declare a person (src/document-kinds.ts, ARC-02):
    // monitor subscriptions and notices, invitations and the client access set of a membership.
    person = personDocumentsCondition(id, emailHash),
    grants = tableExists(store, 'amcp_mcp_grants'),
    keys = JSON.stringify(
      (
        store
          .sql()
          .prepare(
            'SELECT hash FROM api_keys WHERE tenant_id=?' +
              (known ? ' OR hash IN (SELECT hash FROM credential_owners WHERE user_id=?)' : '') +
              (known && grants
                ? " OR hash IN (SELECT hash FROM amcp_mcp_grants WHERE kind='access' AND json_extract(data,'$.ownerUserId')=?)"
                : ''),
          )
          .all(tenant, ...(known ? [id] : []), ...(known && grants ? [id] : [])) as {hash: string}[]
      ).map(row => row.hash),
    ),
    // A step that only follows the person.
    personOnly = (where: string): Pick<ErasureStep, 'where' | 'params'> =>
      known ? {where, params: [id]} : {where: '0', params: []};
  return [
    {table: 'media_chunks', where: 'tenant_id=?', params: [tenant], oneByOne: true},
    {table: 'retained_media_chunks', where: 'tenant_id=?', params: [tenant], oneByOne: true},
    {table: 'media_staging', where: 'tenant_id=?', params: [tenant]},
    {table: 'retained_media', where: 'tenant_id=?', params: [tenant]},
    {table: 'media_admissions', where: 'tenant_id=?', params: [tenant]},
    // Without an account (a workspace named by a receipt alone) there is no person to follow into other workspaces.
    person.where
      ? {table: 'documents', where: 'tenant_id=? OR ' + person.where, params: [tenant, ...person.params]}
      : {table: 'documents', where: 'tenant_id=?', params: [tenant]},
    {table: 'jobs', where: 'tenant_id=?', params: [tenant]},
    {table: 'idempotency', where: 'tenant_id=?', params: [tenant]},
    {table: 'resource_ownership', where: 'tenant_id=?', params: [tenant]},
    {table: 'connections', where: 'tenant_id=?', params: [tenant]},
    {table: 'api_keys', where: 'hash IN (SELECT value FROM json_each(?))', params: [keys]},
    known
      ? {table: 'credential_owners', where: 'user_id=? OR hash IN (SELECT value FROM json_each(?))', params: [id, keys]}
      : {table: 'credential_owners', where: 'hash IN (SELECT value FROM json_each(?))', params: [keys]},
    known
      ? {table: 'amcp_mcp_grants', where: "tenant_id=? OR json_extract(data,'$.ownerUserId')=?", params: [tenant, id]}
      : {table: 'amcp_mcp_grants', where: 'tenant_id=?', params: [tenant]},
    known
      ? {table: 'workspace_memberships', where: 'tenant_id=? OR user_id=?', params: [tenant, id]}
      : {table: 'workspace_memberships', where: 'tenant_id=?', params: [tenant]},
    {
      table: 'amcp_oauth_states',
      where:
        'session_hash IN (SELECT hash FROM amcp_web_sessions WHERE ' +
        (known ? "json_extract(actor,'$.userId')=? OR " : '') +
        "json_extract(actor,'$.tenantId')=?)",
      params: known ? [id, tenant] : [tenant],
    },
    {
      table: 'amcp_web_sessions',
      where: (known ? "json_extract(actor,'$.userId')=? OR " : '') + "json_extract(actor,'$.tenantId')=?",
      params: known ? [id, tenant] : [tenant],
    },
    {table: 'amcp_mfa', ...personOnly('user_id=?')},
    {table: 'amcp_identities', ...personOnly('user_id=?')},
    {table: 'amcp_email_outbox', where: 'tenant_id=?', params: [tenant]},
    {table: 'amcp_users', ...personOnly('id=?')},
  ];
}
/** How many rows an erasure step would delete. */
export function stepRowCount(store: Store, step: ErasureStep): number {
  return Number(
    (
      store
        .sql()
        .prepare('SELECT count(*) AS n FROM ' + step.table + ' WHERE ' + step.where)
        .get(...step.params) as JsonObject
    ).n,
  );
}
/** Deletes an erasure step's rows in one statement. */
export function deleteStepRows(store: Store, step: ErasureStep) {
  store
    .sql()
    .prepare('DELETE FROM ' + step.table + ' WHERE ' + step.where)
    .run(...step.params);
}
/** Deletes an erasure step's rows one per statement (media chunks), outside any transaction. */
export function deleteStepRowsOneByOne(store: Store, step: ErasureStep) {
  deleteRowsOneByOne(
    store.sql(),
    step.table,
    'SELECT rowid AS r FROM ' + step.table + ' WHERE ' + step.where + ' LIMIT 1',
    ...step.params.map(String),
  );
}

// Accounts and workspaces.
/** The account with this id, or undefined. */
export function accountById(store: Store, id: string): JsonObject | undefined {
  return store.sql().prepare('SELECT * FROM amcp_users WHERE id=?').get(id) as JsonObject | undefined;
}
/** The account with this e-mail address (already trimmed and lower-cased; compared without case), or undefined. */
export function accountByEmail(store: Store, email: string): JsonObject | undefined {
  return store.sql().prepare('SELECT * FROM amcp_users WHERE email=? COLLATE NOCASE').get(email) as
    JsonObject | undefined;
}
/** Whether an account with this id exists. */
export const accountExists = (store: Store, id: string) =>
  !!store.sql().prepare('SELECT 1 FROM amcp_users WHERE id=?').get(id);
/** Whether a workspace with this id exists. */
export const workspaceExists = (store: Store, tenant: string) =>
  !!store.sql().prepare('SELECT 1 FROM tenants WHERE id=?').get(tenant);
/** Deletes a workspace's row (its records go first, through the erasure steps). */
export function deleteWorkspace(store: Store, tenant: string) {
  store.sql().prepare('DELETE FROM tenants WHERE id=?').run(tenant);
}
/** How many audit records a workspace has (an erasure tombstones them). */
export const auditRecordCount = (store: Store, tenant: string) =>
  Number((store.sql().prepare('SELECT count(*) AS n FROM audit WHERE tenant_id=?').get(tenant) as JsonObject).n);
/** How many active members other than this person use the workspace. */
export const otherActiveMembers = (store: Store, tenant: string, userId: string) =>
  Number(
    (
      store
        .sql()
        .prepare('SELECT count(*) AS n FROM workspace_memberships WHERE tenant_id=? AND active=1 AND user_id<>?')
        .get(tenant, userId) as JsonObject
    ).n,
  );
/** Whether a job of the workspace is running under a live lease at `now`. */
export const leasedJobRunning = (store: Store, tenant: string, now: number) =>
  !!store
    .sql()
    .prepare("SELECT 1 FROM jobs WHERE tenant_id=? AND state='running' AND lease_until>? LIMIT 1")
    .get(tenant, now);
/** Whether a reviewed write of the workspace was claimed after `since` and is still pending. */
export const pendingClaimSince = (store: Store, tenant: string, since: number) =>
  !!store
    .sql()
    .prepare("SELECT 1 FROM idempotency WHERE tenant_id=? AND state='pending' AND created_at>? LIMIT 1")
    .get(tenant, since);

// Sealed rows that only their content ties to a person.
/** Queued e-mails with a sealed payload in workspaces other than `tenant` (id and sealed payload). */
export function sealedMailOutside(store: Store, tenant: string): JsonObject[] {
  return store
    .sql()
    .prepare("SELECT id,secret FROM amcp_email_outbox WHERE secret<>'' AND tenant_id<>?")
    .all(tenant) as JsonObject[];
}
/** Every emailed link (hash and sealed content). */
export function emailedLinks(store: Store): JsonObject[] {
  return store.sql().prepare('SELECT hash,secret FROM amcp_account_challenges').all() as JsonObject[];
}
/** Deletes one queued e-mail. */
export function deleteQueuedMail(store: Store, id: string) {
  store.sql().prepare('DELETE FROM amcp_email_outbox WHERE id=?').run(id);
}
/** Deletes one emailed link. */
export function deleteEmailedLink(store: Store, hash: string) {
  store.sql().prepare('DELETE FROM amcp_account_challenges WHERE hash=?').run(hash);
}

/**
 * Whether a person is an owner of the deployment's workspace: the AMCP owner, or a second owner AMCP_ADMIN_EMAIL granted
 * (r25-admin-email). Erasure refuses an owner whichever workspace is the person's own, and the retention sweep never
 * selects one: the deployment keeps both of its owners.
 */
export function isDeploymentOwner(store: Store, deploymentTenant: string, userId: unknown): boolean {
  return (
    typeof userId === 'string' &&
    !!store
      .sql()
      .prepare("SELECT 1 FROM workspace_memberships WHERE tenant_id=? AND user_id=? AND role='owner' AND active=1")
      .get(deploymentTenant, userId)
  );
}
/** The user IDs of the deployment workspace's active owners. */
export function deploymentOwnerIds(store: Store, deploymentTenant: string): Set<string> {
  return new Set(
    (
      store
        .sql()
        .prepare("SELECT user_id FROM workspace_memberships WHERE tenant_id=? AND role='owner' AND active=1")
        .all(deploymentTenant) as {user_id: string}[]
    ).map(row => row.user_id),
  );
}

// Account retention (owner decision P3).
/** Whether another active member uses the account's own workspace: an erasure of it is refused (eraseAccount). */
const sharedWorkspace =
  'EXISTS (SELECT 1 FROM workspace_memberships s WHERE s.tenant_id=u.tenant_id AND s.active=1 AND s.user_id<>u.id)';
/** An owner of the deployment's workspace (the parameter): never due for erasure, however its access stands. */
const deploymentOwnerAccount =
  "EXISTS (SELECT 1 FROM workspace_memberships o WHERE o.user_id=u.id AND o.tenant_id=? AND o.role='owner' AND o.active=1)";
/** The accounts past each retention period, oldest first; `shared` selects those whose workspace others use. */
export function accountsPastRetention(
  store: Store,
  deploymentTenant: string,
  retention: {pendingMs: number | null; revokedMs: number | null},
  now: number,
  shared: boolean,
  limit: number,
) {
  const workspace = (shared ? '' : 'NOT ') + sharedWorkspace;
  const select = (sql: string, ...params: (string | number)[]) =>
    (
      store
        .sql()
        .prepare(sql + ' ORDER BY u.created_at LIMIT ' + limit)
        .all(...params) as {id: string}[]
    ).map(r => r.id);
  return {
    pending:
      retention.pendingMs === null
        ? []
        : select(
            'SELECT u.id FROM amcp_users u WHERE u.approved=0 AND u.disabled=0 AND u.created_at<? AND u.tenant_id<>? AND NOT EXISTS (SELECT 1 FROM workspace_memberships m WHERE m.user_id=u.id AND m.tenant_id<>u.tenant_id) AND NOT ' +
              deploymentOwnerAccount +
              ' AND ' +
              workspace,
            now - retention.pendingMs,
            deploymentTenant,
            deploymentTenant,
          ),
    revoked:
      retention.revokedMs === null
        ? []
        : // Each account's latest revocation is read in one grouped pass over the deployment's audit, not once per
          // disabled account (the owner's access page runs this on every render; wave 3a review).
          select(
            "WITH revoked AS (SELECT json_extract(a.event,'$.user_id') AS uid,max(a.created_at) AS at FROM audit a WHERE a.tenant_id=? AND json_valid(a.event) AND json_extract(a.event,'$.event')='account_access_revoked' GROUP BY 1) SELECT u.id FROM amcp_users u LEFT JOIN revoked r ON r.uid=u.id WHERE u.disabled=1 AND u.tenant_id<>? AND coalesce(r.at,u.created_at)<? AND NOT " +
              deploymentOwnerAccount +
              ' AND ' +
              workspace,
            deploymentTenant,
            deploymentTenant,
            now - retention.revokedMs,
            deploymentTenant,
          ),
  };
}

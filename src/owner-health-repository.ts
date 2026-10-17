import type {Store} from './store.js';
import type {JsonObject} from './types.js';
import {migrationLedgerSummary} from './schema-migrations.js';
import {providerQuotaHealth, type QuotaPolicy} from './provider-quota.js';

/**
 * The statements of the owner's health view (src/owner-operations.ts) in the store layer (ARC-02), moved here
 * verbatim. src/owner-operations.ts is on the reviewed-write path, so this module imports types only.
 */
/** Live keys of a workspace that the service, not a person, owns (SEC-06): label, role, expiry and owner only. */
export function serviceKeyRows(store: Store, tenant: string, now = Date.now()): JsonObject[] {
  return store
    .sql()
    .prepare(
      "SELECT a.user_id AS label,a.role,a.expires_at,coalesce(o.user_id,'service:legacy') AS owner FROM api_keys a LEFT JOIN credential_owners o ON o.hash=a.hash WHERE a.tenant_id=? AND a.revoked=0 AND (a.expires_at IS NULL OR a.expires_at>?) AND (o.user_id LIKE 'service:%' OR (o.hash IS NULL AND a.user_id NOT LIKE 'connector/%' AND a.user_id NOT LIKE 'oauth/%')) ORDER BY a.expires_at LIMIT 100",
    )
    .all(tenant, now) as JsonObject[];
}
/** Whether the database has a table of this name (the website's tables are absent from an MCP-only store). */
export function tableExists(store: Store, name: string): boolean {
  return !!store.sql().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
/** A workspace's queued e-mails counted by state, with each state's next attempt. */
export function emailQueue(store: Store, tenant: string): JsonObject[] {
  return store
    .sql()
    .prepare(
      'SELECT state,count(*) AS count,min(available_at) AS next_attempt FROM amcp_email_outbox WHERE tenant_id=? GROUP BY state',
    )
    .all(tenant) as JsonObject[];
}
/** A numeric SQLite setting or counter (`PRAGMA name`), NaN when it has none. */
export function pragmaValue(store: Store, name: string): number {
  if (!/^[a-z_]+$/.test(name)) throw new Error('Invalid pragma ' + JSON.stringify(name) + '.');
  const row = store
    .sql()
    .prepare('PRAGMA ' + name)
    .get() as JsonObject | undefined;
  return Number(row ? Object.values(row)[0] : NaN);
}
/** A trivial read, for the health check: throws when the database cannot answer. */
export function probeRead(store: Store) {
  store.sql().prepare('SELECT 1').get();
}
/** The database file's path, or null for an in-memory database. */
export const databaseFile = (store: Store): string | null => store.sql().location();
/** The SQLite library version. */
export const sqliteVersion = (store: Store) =>
  String((store.sql().prepare('SELECT sqlite_version() AS v').get() as JsonObject).v);
/** The stored schema version (throws when the table is unreadable). */
export const storedSchemaVersion = (store: Store) =>
  Number((store.sql().prepare('SELECT version FROM schema_version').get() as JsonObject).version);
// Operations health (src/operations-health.ts): aggregate diagnostics only.
/** A workspace's newest job errors; the jobs_tenant_updated index serves it in order without a sort (OPS-08). */
export const recentJobErrorsSQL =
  "SELECT id,kind,json_extract(error,'$.code') AS code,updated_at FROM jobs WHERE tenant_id=? AND error IS NOT NULL ORDER BY updated_at DESC LIMIT 30";
export const recentJobErrors = (store: Store, tenant: string) =>
  store.sql().prepare(recentJobErrorsSQL).all(tenant) as JsonObject[];
/** A workspace's queued and running jobs by kind and state, with the oldest due time of each. */
export function jobQueueAges(store: Store, tenant: string): JsonObject[] {
  return store
    .sql()
    .prepare(
      "SELECT kind,state,count(*) AS count,min(available_at) AS due FROM jobs WHERE tenant_id=? AND state IN ('queued','running') GROUP BY kind,state",
    )
    .all(tenant) as JsonObject[];
}
/** A workspace's live media admissions: how many, and the bytes they reserve. */
export function mediaReservations(store: Store, tenant: string, now: number): JsonObject {
  return store
    .sql()
    .prepare(
      "SELECT count(*) AS active_operations,coalesce(sum(bytes),0) AS reserved_bytes FROM media_admissions WHERE tenant_id=? AND expires_at>? AND id NOT LIKE 'wait:%'",
    )
    .get(tenant, now) as JsonObject;
}
/** The deployment's live media admissions (the shared budget, MED-02): how many, and the bytes they reserve. */
export function deploymentMediaReservations(store: Store, now: number): JsonObject {
  return store
    .sql()
    .prepare(
      "SELECT count(*) AS deployment_operations,coalesce(sum(bytes),0) AS deployment_reserved_bytes FROM media_admissions WHERE expires_at>? AND id NOT LIKE 'wait:%'",
    )
    .get(now) as JsonObject;
}
/** A workspace's staged media reviews and the next staging expiry. */
export function stagedMedia(store: Store, tenant: string): JsonObject {
  return store
    .sql()
    .prepare('SELECT count(*) AS staged_reviews,min(expires_at) AS next_expiry FROM media_staging WHERE tenant_id=?')
    .get(tenant) as JsonObject;
}
/** The provider request quota health of a workspace (OPS-08), read from the store's issuer usage. */
export const providerQuota = (store: Store, tenant: string, policy: QuotaPolicy, now: number) =>
  providerQuotaHealth(store.sql(), tenant, policy, now);
/** The schema ledger's entry count and newest step (OPS-08), never SQL. */
export const schemaLedgerSummary = (store: Store) => migrationLedgerSummary(store.sql());
/** The database's size: its page count times its page size. */
export function databaseBytes(store: Store): number {
  return (
    Number((store.sql().prepare('PRAGMA page_count').get() as JsonObject).page_count) *
    Number((store.sql().prepare('PRAGMA page_size').get() as JsonObject).page_size)
  );
}

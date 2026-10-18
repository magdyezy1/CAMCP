import {backup, type DatabaseSync} from 'node:sqlite';
import type {Store} from './store.js';
import type {JsonObject} from './types.js';
import {backupExcludedCondition} from './document-kinds.js';
import {JOURNAL_SIZE_LIMIT_BYTES, deleteRowsOneByOne} from './media-storage.js';
import {activeScheduleSQL, scheduleKinds} from './schedule-repository.js';
import {tableExists} from './owner-health-repository.js';
export {databaseBytes, databaseFile} from './owner-health-repository.js';

/**
 * The statements of encrypted backups, restores and restore drills (OPS-04, SEC-07 S1), in the store layer (ARC-02),
 * moved here verbatim from src/backup.ts. The snapshot strip and the copy checks edit or read only a disposable copy;
 * the running database and provider assets are untouched.
 */
/**
 * Copies the running database into `file` with the largest positive signed 32-bit page batch Node accepts.
 * A copy fitting that batch finishes in one read snapshot, so another connection's writes cannot restart it.
 * SQLite's negative all-pages sentinel is not a supported Node rate. `progress` runs between unfinished steps.
 */
export function snapshotDatabase(store: Store, file: string, progress: () => void) {
  return backup(store.sql(), file, {rate: 0x7fffffff, progress});
}
/** What an encrypted backup leaves out (OPS-04). Only the disposable snapshot is edited. */
export function stripBackupSnapshot(snapshot: DatabaseSync) {
  // Chunks go one row per statement, so the strip's log stays about one chunk rather than every file (OPS-01).
  snapshot.exec('PRAGMA secure_delete=ON; PRAGMA journal_size_limit=' + JOURNAL_SIZE_LIMIT_BYTES + ';');
  deleteRowsOneByOne(snapshot, 'media_chunks', 'SELECT rowid AS r FROM media_chunks LIMIT 1');
  deleteRowsOneByOne(
    snapshot,
    'retained_media_chunks',
    "SELECT c.rowid AS r FROM retained_media_chunks c WHERE EXISTS(SELECT 1 FROM documents d WHERE d.kind='retained_media_source' AND d.tenant_id=c.tenant_id AND d.id=c.id AND json_extract(d.data,'$.origin')='upload') LIMIT 1",
  );
  // The documents left out are the kinds src/document-kinds.ts declares with `backup` (ARC-02).
  snapshot.exec(`DELETE FROM media_staging;
        DELETE FROM media_admissions;
        DELETE FROM retained_media WHERE EXISTS(SELECT 1 FROM documents d WHERE d.kind='retained_media_source' AND d.tenant_id=retained_media.tenant_id AND d.id=retained_media.id AND json_extract(d.data,'$.origin')='upload');
        DELETE FROM documents WHERE ${backupExcludedCondition()};
        VACUUM;`);
}

// A copy being checked: a SQLite file opened read-only, never the running database.
/** The rows of SQLite's integrity check of a copy (a single `ok` row when it is sound). */
export const integrityCheck = (copy: DatabaseSync) => copy.prepare('PRAGMA integrity_check').all() as JsonObject[];
/** How many foreign-key violations SQLite finds in a copy. */
export const foreignKeyViolations = (copy: DatabaseSync) => copy.prepare('PRAGMA foreign_key_check').all().length;
/** The names of a copy's tables. */
export const tableNames = (copy: DatabaseSync) =>
  (copy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name: string}[]).map(t => t.name);
/** What a restore drill records about the restored copy: counts only. */
export function drillCounts(copy: DatabaseSync): JsonObject {
  const count = (sql: string) => Number((copy.prepare(sql).get() as {n: number}).n);
  return {
    workspaces: count('SELECT count(*) AS n FROM tenants'),
    connections: count('SELECT count(*) AS n FROM connections'),
    documents: count('SELECT count(*) AS n FROM documents'),
    audit_events: count('SELECT count(*) AS n FROM audit'),
    queued_jobs: count("SELECT count(*) AS n FROM jobs WHERE state='queued'"),
    running_jobs: count("SELECT count(*) AS n FROM jobs WHERE state='running'"),
    uncertain_writes: count("SELECT count(*) AS n FROM idempotency WHERE state='uncertain'"),
  };
}
/** The newest audit event or job update a copy holds (its recovery point); 0 when it holds neither. */
export function newestActivityAt(copy: DatabaseSync): number {
  // Multi-argument max() is NULL when any argument is; an empty table counts as no activity.
  return Number(
    (
      copy
        .prepare(
          'SELECT max(coalesce((SELECT max(created_at) FROM audit),0),coalesce((SELECT max(updated_at) FROM jobs),0)) AS at',
        )
        .get() as {at: number}
    ).at,
  );
}

/** Moves the write-ahead log into the database file and truncates it, so a copy is one self-contained file. */
export function truncateWal(store: Store) {
  store.sql().exec('PRAGMA wal_checkpoint(TRUNCATE)');
}
/**
 * The access a restored copy brings back, ended (SEC-07 S1): every website session, provider authorization in progress
 * and emailed link, every unrevoked API key, every unused AI-client grant (with the reason server/mcp-grants.ts records),
 * every queued e-mail payload and every active report schedule. Returns how many of each; `workspaces_paused` starts at
 * 0 for the caller's write pauses.
 */
export function endRestoredAccess(store: Store, now: number): JsonObject {
  const has = (table: string) => tableExists(store, table),
    run = (sql: string, ...values: (string | number)[]) =>
      Number(
        store
          .sql()
          .prepare(sql)
          .run(...values).changes,
      );
  return {
    sessions_ended: has('amcp_web_sessions') ? run('DELETE FROM amcp_web_sessions') : 0,
    authorizations_in_progress_ended: has('amcp_oauth_states') ? run('DELETE FROM amcp_oauth_states') : 0,
    emailed_links_ended: has('amcp_account_challenges') ? run('DELETE FROM amcp_account_challenges') : 0,
    keys_revoked: run('UPDATE api_keys SET revoked=1 WHERE revoked=0'),
    // The reason is the one server/mcp-grants.ts records, so the AI client is told why its access ended.
    ai_client_grants_ended: has('amcp_mcp_grants')
      ? run(
          "UPDATE amcp_mcp_grants SET used=1,data=json_set(data,'$.ended_reason','restore_quarantine','$.ended_at',?) WHERE used=0",
          now,
        )
      : 0,
    queued_emails_cleared: has('amcp_email_outbox')
      ? run(
          "UPDATE amcp_email_outbox SET secret='',lease_token=NULL,state=CASE WHEN state IN ('queued','sending','failed') THEN 'expired' ELSE state END WHERE secret<>''",
        )
      : 0,
    schedules_paused: run(
      "UPDATE documents SET data=json_set(data,'$.is_active',json('false'),'$.pause_reason','restore_quarantine','$.updated_at',?),revision=revision+1 WHERE kind IN (" +
        scheduleKinds.map(k => "'" + k + "'").join(',') +
        ') AND ' +
        activeScheduleSQL,
      now,
    ),
    workspaces_paused: 0,
  };
}
/**
 * Whether a restored workspace already holds a document of this kind and id (the owner's write pause). The tenants
 * of a restored copy may predate the registry's reserved partition ids, so this reads the row itself.
 */
export function restoredDocumentExists(store: Store, tenant: string, kind: string, id: string): boolean {
  return !!store.sql().prepare('SELECT 1 FROM documents WHERE tenant_id=? AND kind=? AND id=?').get(tenant, kind, id);
}

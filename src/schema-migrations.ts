import type {DatabaseSync} from 'node:sqlite';
import {MirrorError} from './errors.js';
import {readBuildRecord} from './release-status.js';

/**
 * Schema evolution (OPS-08). `schema_version` is the physical version this release writes; `READER_VERSION` is the
 * newest version it can read. Each release also records `min_reader_version` in `schema_meta`: the oldest reader that
 * may still open the database. An additive (expand) change keeps it, so a rolled-back image still starts; a
 * contracting change raises it, so an older image refuses with SCHEMA_TOO_NEW instead of misreading the data.
 *
 * Every step is idempotent and runs inside the serialized bootstrap transaction on every start; the ledger
 * (`schema_migrations`) records when each step first ran and under which release. A database created before the
 * ledger records today's steps as its baseline at its first start under this release. Recovery steps for a refusal
 * are in docs/OPERATIONS.md, "Schema migrations and rollback".
 */
export const SCHEMA_VERSION = 2;
export const READER_VERSION = 2;
/** What this release declares as the oldest reader of a database it wrote: only additive changes since version 2. */
export const MIN_READER_VERSION = 2;
export const SCHEMA_RECOVERY_DOC = 'docs/OPERATIONS.md#schema-migrations-and-rollback';
export const ledgerSQL = `CREATE TABLE IF NOT EXISTS schema_migrations(id TEXT PRIMARY KEY,applied_at INTEGER NOT NULL,release TEXT);
  CREATE TABLE IF NOT EXISTS schema_meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL);`;
export type MigrationStep = {id: string; run: (db: DatabaseSync) => void};
export type SchemaCompatibility = 'current' | 'upgrade' | 'newer_compatible' | 'too_new' | 'invalid';
export type SchemaState = {version: number | null; min_reader_version: number | null};

const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;
/** How this release may treat a database at `version` that declares `minReader` (absent: the version itself). */
export function schemaCompatibility(version: unknown, minReader: unknown = null): SchemaCompatibility {
  if (!positive(version)) return 'invalid';
  if (version === 1) return 'upgrade';
  if (version === SCHEMA_VERSION) return 'current';
  if (version < SCHEMA_VERSION) return 'invalid';
  const reader = minReader === null || minReader === undefined ? version : minReader;
  if (!positive(reader) || reader > version) return 'invalid';
  return reader <= READER_VERSION ? 'newer_compatible' : 'too_new';
}
const tableExists = (db: DatabaseSync, name: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
/** The stored schema version (null unless exactly one row) and declared minimum reader (null when not recorded). */
export function readSchemaState(db: DatabaseSync): SchemaState {
  const rows = tableExists(db, 'schema_version')
    ? (db.prepare('SELECT version FROM schema_version').all() as {version: unknown}[])
    : [];
  const version = rows.length === 1 && positive(rows[0]!.version) ? rows[0]!.version : null;
  let minReader: number | null = null;
  if (tableExists(db, 'schema_meta')) {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key='min_reader_version'").get() as
      {value: unknown} | undefined;
    minReader = row && positive(row.value) ? row.value : null;
  }
  return {version, min_reader_version: minReader};
}
/** The refusal for a database this release must not open; its details name the versions and the recovery guide. */
export function schemaTooNew(state: SchemaState): MirrorError {
  return new MirrorError(
    'SCHEMA_TOO_NEW',
    'This database was written by a newer AMCP release that older releases cannot read. Deploy that release (or a newer one) again, or restore a backup made by this release; see ' +
      SCHEMA_RECOVERY_DOC +
      '.',
    {
      database_version: state.version,
      min_reader_version: state.min_reader_version ?? state.version,
      reader_version: READER_VERSION,
      recovery: SCHEMA_RECOVERY_DOC,
    },
    500,
  );
}
let release: string | null | undefined;
/** The release label stored with ledger rows: the build's source revision, else its package digest prefix. */
export function migrationRelease(): string | null {
  if (release !== undefined) return release;
  const record = readBuildRecord(process.cwd());
  release = record?.source_revision
    ? 'rev:' + record.source_revision.slice(0, 12)
    : record?.sha256
      ? 'pkg:' + record.sha256.slice(0, 16)
      : null;
  return release;
}
/** Runs every step (each idempotent) and records the ones the ledger has not seen; returns their IDs. */
export function applyMigrationSteps(db: DatabaseSync, steps: readonly MigrationStep[], now = Date.now()): string[] {
  const applied: string[] = [],
    insert = db.prepare('INSERT OR IGNORE INTO schema_migrations(id,applied_at,release) VALUES(?,?,?)');
  for (const step of steps) {
    step.run(db);
    if (insert.run(step.id, now, migrationRelease()).changes === 1) applied.push(step.id);
  }
  return applied;
}
/** Records the minimum reader for a database this release created or upgraded; a newer release's value is kept. */
export function recordMinimumReader(db: DatabaseSync) {
  db.prepare("INSERT OR IGNORE INTO schema_meta(key,value) VALUES('min_reader_version',?)").run(MIN_READER_VERSION);
}
/** Owner-health summary of the ledger: counts and the newest step, never SQL. */
export function migrationLedgerSummary(db: DatabaseSync) {
  if (!tableExists(db, 'schema_migrations')) return {entries: 0, latest: null};
  const count = (db.prepare('SELECT count(*) AS n FROM schema_migrations').get() as {n: number}).n,
    latest = db
      .prepare('SELECT id,applied_at,release FROM schema_migrations ORDER BY applied_at DESC,id DESC LIMIT 1')
      .get() as {id: string; applied_at: number; release: string | null} | undefined;
  return {
    entries: count,
    latest: latest ? {id: latest.id, applied_at: latest.applied_at, release: latest.release} : null,
  };
}

import type {MediaSink} from './media-buffer.js';
import {operationRecovery, type OperationPhase} from './operation-journal.js';
import {createHash} from 'node:crypto';
import {MAX_MEDIA_BYTES} from './drive-media.js';
import {retainedMediaStats} from './retained-media.js';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {MirrorError} from './errors.js';
import {SecretBox, sha256, stable, redact, scopeKey, sealedBytesOverhead} from './security.js';
import type {Actor, Connection, Credentials, JsonObject} from './types.js';
import {recordServiceTiming, type ServiceTimingCategory} from './service-timings.js';
import {nativeParameterKey} from './parameter-key.js';
import {scheduleGlobalIndexSQL, scheduleIndexSQL} from './schedule-repository.js';
import {reportPartsCleanupSQL} from './report-repository.js';
import {WEBSITE_UPLOAD_TTL_MS, WEBSITE_UPLOAD_IDLE_MS, MEDIA_CLEANUP_INTERVAL_MS} from './media-retention.js';
import {recordSqliteFailure, sqliteDiagnostic} from './sqlite-diagnostics.js';
import {
  QUOTA_RETAINED_DAYS,
  issuerKey,
  quotaDay,
  quotaExhausted,
  quotaPolicyFromEnv,
  quotaRefusal,
  type IssuerDay,
  type IssuerPermit,
  type QuotaPolicy,
} from './provider-quota.js';
import {
  READER_VERSION,
  applyMigrationSteps,
  ledgerSQL,
  readSchemaState,
  recordMinimumReader,
  schemaCompatibility,
  schemaTooNew,
  type SchemaCompatibility,
  type SchemaState,
} from './schema-migrations.js';
import {
  CRASH_EXPIRY_LIMIT,
  JOB_SHUTDOWN_MESSAGE,
  LEASE_CRASH_QUARANTINE_MESSAGE,
  LEASE_EXPIRED_MESSAGE,
  LEASE_EXPIRY_LIMIT_MESSAGE,
  leaseExpiryDelay,
  leaseExpiryLimit,
  WORKER_BOOT_ALIVE_MS,
  WORKER_BOOT_ID,
} from './job-leases.js';
import type {StorageVolume} from './storage-health.js';
import {loginRevision, recordLogin} from './connection-authority.js';
import {
  accessSetKind,
  accountScopeRestricted,
  isNarrowedConnection,
  memberAccessSetId,
  narrowConnections,
  setBindings,
  type AccessBinding,
} from './access-sets.js';
import {storableCredentials, withAppSecrets} from './app-credentials.js';
import {DocumentRepository} from './document-repository.js';
import {mcpRateLimitsSQL} from './mcp-rate-limit-repository.js';
import {
  isServicePartition,
  maintenanceSweeps,
  servicePartitions,
  type ServiceDocumentKind,
  type TenantDocumentKind,
} from './document-kinds.js';
import {
  JOURNAL_SIZE_LIMIT_BYTES,
  MEDIA_CHUNK_BYTES,
  deleteRowsOneByOne,
  mediaChunkFormat,
  storageAdmissionRequirement,
  storageSpace,
  type StatfsResult,
} from './media-storage.js';
export const MEDIA_LEASE_MS = 45000;
/** Where service limits, heartbeats and dispatch cursors are stored (src/document-kinds.ts, `scope: 'service'`). */
const serviceLimits = servicePartitions.limits;
/** The documents the maintenance timer deletes: the kinds whose retention the registry gives it (ARC-02). */
const recordSweeps = maintenanceSweeps();
/** credential_owners.user_id of a key the service owns (Store.createServiceKey, SEC-06), e.g. `service:cli`. */
export const serviceOwnerPrefix = 'service:';
/** One member's unfinished website uploads per workspace: at most this many files and two media limits of bytes. */
const MEMBER_UNFINISHED_UPLOADS = 10,
  MEMBER_UNFINISHED_BYTES = 2 * MAX_MEDIA_BYTES;
/**
 * A cached fitted output (MED-03 C): `fit-` + the exact source id it was derived from + a 16-hex key of its limits and
 * encoder, so every copy derived from one source can be found and removed with it. It is staged like a source.
 */
export const FIT_CACHE_ID = /^fit-(?:src|lib)-[0-9a-f-]{36}-[0-9a-f]{16}$/;
/** Staging rows that count against the original-file quota: uploads/imports and the fitted copies cached from them. */
const SOURCE_ROWS = "(id LIKE 'src-%' OR id LIKE 'fit-%')";
/** English source text of the retryable refusal when admitting media would leave too little free space (OPS-01). */
export const STORAGE_LOW_MESSAGE =
  'AMCP storage is nearly full, so this file was not accepted. Try again later, or ask the deployment administrator to add capacity.';
// Chunks whose manifest is gone are unreadable; they are erased one row per statement (OPS-01).
const orphanStagedChunk =
    'SELECT c.rowid AS r FROM media_chunks c WHERE NOT EXISTS(SELECT 1 FROM media_staging s WHERE s.tenant_id=c.tenant_id AND s.id=c.id) LIMIT 1',
  orphanRetainedChunk =
    'SELECT c.rowid AS r FROM retained_media_chunks c WHERE NOT EXISTS(SELECT 1 FROM retained_media m WHERE m.tenant_id=c.tenant_id AND m.id=c.id) LIMIT 1';
const stagedChunkScopes = (tenant: string, id: string, index: number) =>
  [scopeKey(tenant, 'media-chunk', id, String(index)), scopeKey(tenant, 'media-chunk-v2', id, String(index))] as const;
const busyPause = new Int32Array(new SharedArrayBuffer(4));
/**
 * Audit records are append-only, except that an erasure (SEC-07 S4, src/account-erasure.ts) may replace a record's
 * payload by its tombstone and clear its request id; its workspace, time, previous hash and hash never change, so the
 * chain stays linked. verifyAudit accepts a tombstone only when a later `account_erased` record names exactly the
 * records its erasure tombstoned.
 */
const auditUpdateTrigger = `CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit WHEN NOT (NEW.seq=OLD.seq AND NEW.tenant_id=OLD.tenant_id AND NEW.previous_hash=OLD.previous_hash AND NEW.hash=OLD.hash AND NEW.created_at=OLD.created_at AND NEW.request_id='' AND json_valid(NEW.event) AND json_extract(NEW.event,'$.amcp_audit_tombstone')=1 AND json_type(NEW.event,'$.erasure')='text') BEGIN SELECT RAISE(ABORT,'audit is append only'); END;`;
/** The payload an erased audit record keeps: the id of the erasure, nothing of the original. */
export const auditTombstone = (erasure: string) => stable({amcp_audit_tombstone: 1, erasure});
/** The erasure a tombstoned audit record belongs to, or undefined for any other record. */
function tombstoneErasure(row: JsonObject): string | undefined {
  if (row.request_id !== '' || typeof row.event !== 'string' || !row.event.startsWith('{"amcp_audit_tombstone":1,'))
    return;
  try {
    const value = JSON.parse(row.event);
    return Object.keys(value).length === 2 &&
      typeof value.erasure === 'string' &&
      row.event === auditTombstone(value.erasure)
      ? value.erasure
      : undefined;
  } catch {
    return;
  }
}
/**
 * The record to store: the store's login revision and login id, never a caller's (revision 0 is left implicit, as on
 * older rows, which also have no login id).
 */
function withLogin(connection: Connection, revision: number, loginId: string | undefined): Connection {
  const {loginRevision: _revision, loginId: _id, ...rest} = connection;
  return {...rest, ...(revision ? {loginRevision: revision} : {}), ...(loginId ? {loginId} : {})};
}
export type StoreBootstrap = {
  schema_version: number | null;
  min_reader_version: number | null;
  reader_version: number;
  compatibility: SchemaCompatibility;
  migration_ms: number;
  migrations_applied: string[];
};
export class Store {
  readonly db: DatabaseSync;
  private box?: SecretBox;
  private actorChecks = new WeakMap<Actor, () => void>();
  private authenticatedActors = new WeakMap<Actor, string>();
  private transactionDepth = 0;
  private timingFailures = 0;
  private transientCleanupTimer?: NodeJS.Timeout;
  private transientCleanupAt = 0;
  private transientCleanupError?: string;
  private chunkSweepPending = false;
  private checkpointPending = false;
  private beginBusyRetries = 0;
  private recordsCleanupAt = 0;
  /** Set by the production start-up guard (OPS-03): whether the database is on a verified persistent volume. */
  volume?: StorageVolume;
  /**
   * What this start's schema bootstrap found and did (OPS-08): versions, how it treated the database, how long the
   * serialized bootstrap took and which ledger steps it recorded for the first time. The website store adds its own.
   */
  bootstrap!: StoreBootstrap;
  /** Reads free space of the database's file system; tests inject synthetic results. */
  statfs: (directory: string) => StatfsResult = fs.statfsSync;
  /**
   * How long a transaction keeps retrying `BEGIN IMMEDIATE` after SQLITE_BUSY, in total, including SQLite's own busy
   * wait. Nothing has run when BEGIN fails, so the retry is safe for every kind of work. The retry blocks the event loop
   * of the one HTTP process (Atomics.wait), so the total stays at the five-second busy_timeout that bounded a single
   * BEGIN before: contention is retried within that budget instead of stalling sign-in, MCP and /healthz for longer.
   */
  beginBusyDeadlineMs = 5000;
  /** BEGIN IMMEDIATE attempts this process retried after SQLITE_BUSY (metadata only). */
  get transactionBusyRetries() {
    return this.beginBusyRetries;
  }
  get mediaCleanupHealth() {
    return {
      lifetime_minutes: 30,
      idle_release_minutes: WEBSITE_UPLOAD_IDLE_MS / 60000,
      cleanup_interval_ms: MEDIA_CLEANUP_INTERVAL_MS,
      last_success_at: this.transientCleanupAt,
      ...(this.transientCleanupError ? {error_code: this.transientCleanupError} : {}),
    };
  }
  private mediaCounts = new Map<string, Map<string, number>>();
  /**
   * Counts one workspace's media refusals, releases and measured transfers in this process since it started (MED-01,
   * MED-02), for the owner's operations health; no member, file or URL detail. The unauthenticated probe never shows
   * them.
   */
  noteMedia(tenant: string, event: string, n = 1) {
    const counts = this.mediaCounts.get(tenant) ?? new Map<string, number>();
    counts.set(event, Math.min(Number.MAX_SAFE_INTEGER, (counts.get(event) ?? 0) + n));
    this.mediaCounts.set(tenant, counts);
  }
  mediaCounters(tenant: string): Record<string, number> {
    return Object.fromEntries(this.mediaCounts.get(tenant) ?? []);
  }
  get serviceTimingFailures() {
    return this.timingFailures;
  }
  serviceTiming(tenant: string, category: ServiceTimingCategory, elapsedMs: number, success: boolean) {
    recordServiceTiming(this, tenant, category, elapsedMs, success);
  }
  noteServiceTimingFailure() {
    this.timingFailures = Math.min(Number.MAX_SAFE_INTEGER, this.timingFailures + 1);
  }
  /** `previousMasterKeys` (MIRROR_MASTER_KEY_PREVIOUS) still open values sealed before a key rotation (SEC-07 S3). */
  constructor(filename: string, masterKey?: string, previousMasterKeys: readonly string[] = []) {
    if (masterKey) this.box = new SecretBox(masterKey, previousMasterKeys);
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), {recursive: true});
    this.db = new DatabaseSync(filename);
    try {
      this.db.function('native_parameter_key', {deterministic: true}, nativeParameterKey);
      this.db.exec('PRAGMA busy_timeout=5000;');
      // SQLite may skip its busy handler when concurrent journal-mode changes would
      // deadlock. Retry only this idempotent bootstrap step, before any application work.
      const journalDeadline = Date.now() + 5000,
        pause = new Int32Array(new SharedArrayBuffer(4));
      for (;;) {
        try {
          this.db.exec('PRAGMA journal_mode=WAL;');
          break;
        } catch (e) {
          const code = (e as {errcode?: number}).errcode;
          if (code === undefined || ![5, 6].includes(code & 255) || Date.now() >= journalDeadline) throw e;
          Atomics.wait(pause, 0, 0, Math.min(25, journalDeadline - Date.now()));
        }
      }
      // secure_delete stays ON (owner decision D24); bounded statements and the log size limit keep its writes small.
      this.db.exec(
        'PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA journal_size_limit=' + JOURNAL_SIZE_LIMIT_BYTES + ';',
      );
      // Serialize bootstrap and migration together so two starting processes cannot
      // both observe an old schema and attempt the same ALTER TABLE. Every step is idempotent and recorded in the
      // schema_migrations ledger; a database newer than this release can read is refused (OPS-08).
      const bootstrapStarted = performance.now();
      let schema: SchemaState = {version: null, min_reader_version: null},
        compatibility: SchemaCompatibility = 'invalid',
        applied: string[] = [];
      this.transaction(() => {
        this.db.exec(`
   CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL); INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_version);
   CREATE TABLE IF NOT EXISTS tenants(id TEXT PRIMARY KEY,name TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS workspace_memberships(tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','admin','operator','viewer')),active INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,PRIMARY KEY(tenant_id,user_id));
   CREATE TABLE IF NOT EXISTS credential_owners(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS service_locks(key TEXT PRIMARY KEY,owner TEXT NOT NULL,expires_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS provider_cooldowns(key TEXT PRIMARY KEY,until_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS api_keys(hash TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(id),user_id TEXT NOT NULL,role TEXT NOT NULL,expires_at INTEGER,revoked INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS connections(id TEXT NOT NULL,tenant_id TEXT NOT NULL REFERENCES tenants(id),data TEXT NOT NULL,secret TEXT NOT NULL,PRIMARY KEY(tenant_id,id));
   CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id TEXT NOT NULL,request_id TEXT NOT NULL,event TEXT NOT NULL,previous_hash TEXT NOT NULL,hash TEXT NOT NULL,created_at INTEGER NOT NULL);
   ${auditUpdateTrigger}
   CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'audit is append only'); END;
   CREATE TABLE IF NOT EXISTS idempotency(tenant_id TEXT NOT NULL,key TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,result TEXT,created_at INTEGER NOT NULL,PRIMARY KEY(tenant_id,key));
   CREATE TABLE IF NOT EXISTS documents(tenant_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(tenant_id,kind,id));
   CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,kind TEXT NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL,result TEXT,error TEXT,attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL,lease_until INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(state,available_at);
   CREATE INDEX IF NOT EXISTS audit_tenant ON audit(tenant_id,seq);
   CREATE TABLE IF NOT EXISTS resource_ownership(tenant_id TEXT NOT NULL,connection_id TEXT NOT NULL,account_id TEXT NOT NULL,resource TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(tenant_id,connection_id,account_id,resource));
   CREATE TABLE IF NOT EXISTS media_admissions(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,bytes INTEGER NOT NULL,expires_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS media_chunks(tenant_id TEXT NOT NULL,id TEXT NOT NULL,chunk_index INTEGER NOT NULL,secret TEXT NOT NULL,PRIMARY KEY(tenant_id,id,chunk_index));
   CREATE TABLE IF NOT EXISTS media_staging(tenant_id TEXT NOT NULL,id TEXT NOT NULL,secret TEXT,expires_at INTEGER NOT NULL,PRIMARY KEY(tenant_id,id));
   CREATE TABLE IF NOT EXISTS retained_media(tenant_id TEXT NOT NULL,id TEXT NOT NULL,secret TEXT NOT NULL,size_bytes INTEGER NOT NULL,PRIMARY KEY(tenant_id,id));
   CREATE TABLE IF NOT EXISTS retained_media_chunks(tenant_id TEXT NOT NULL,id TEXT NOT NULL,chunk_index INTEGER NOT NULL,secret TEXT NOT NULL,PRIMARY KEY(tenant_id,id,chunk_index));
  `);
        this.db.exec(ledgerSQL);
        schema = readSchemaState(this.db);
        compatibility = schemaCompatibility(schema.version, schema.min_reader_version);
        if (compatibility === 'too_new') throw schemaTooNew(schema);
        if (compatibility === 'invalid')
          throw new MirrorError('SCHEMA_VERSION_MISMATCH', 'Database migration required.', {}, 500);
        if (compatibility === 'upgrade')
          this.db.exec('ALTER TABLE jobs ADD COLUMN lease_token TEXT; UPDATE schema_version SET version=2;');
        // A newer, still readable database keeps the minimum reader its own release declared.
        if (compatibility !== 'newer_compatible') recordMinimumReader(this.db);
        applied = applyMigrationSteps(this.db, [
          // Both ran above: the core tables, and the version 1 -> 2 upgrade (jobs.lease_token).
          {id: 'store-0001-core-tables', run: () => {}},
          {id: 'store-0002-jobs-lease-token', run: () => {}},
          // Additive schema-2 index: workbook authorization repeatedly looks up exact query membership.
          // Tenant and association are indexed together; current actor/account checks still run for every result.
          {
            id: 'store-0003-reporting-query-workbook-index',
            run: db =>
              db.exec(`CREATE INDEX IF NOT EXISTS reporting_query_workbook
          ON documents(tenant_id,json_extract(data,'$.workbook_binding_id'),id)
          WHERE kind='reporting_query'`),
          },
          // Additive schema-2 indexes: inactive/future schedules need not be decoded every worker pass.
          {id: 'store-0004-schedule-due-indexes', run: db => db.exec(scheduleIndexSQL)},
          // The independent expiry timer visits media kinds without scanning report, audit or schedule documents.
          {
            id: 'store-0005-media-documents-index',
            run: db =>
              db.exec(`CREATE INDEX IF NOT EXISTS media_documents_by_kind ON documents(kind)
          WHERE kind IN ('media_source','retained_media_source','media_review','media_variant','upload_session','preview_receipt')`),
          },
          // Additive schema-2 job columns (OPS-07): the process boot that holds a lease, and how many leases expired.
          {
            id: 'store-0006-job-lease-columns',
            run: db => {
              for (const [column, definition] of [
                ['lease_boot', 'TEXT'],
                ['lease_expiries', 'INTEGER NOT NULL DEFAULT 0'],
                ['crash_expiries', 'INTEGER NOT NULL DEFAULT 0'],
              ] as const)
                if (!db.prepare("SELECT 1 FROM pragma_table_info('jobs') WHERE name=?").get(column))
                  db.exec('ALTER TABLE jobs ADD COLUMN ' + column + ' ' + definition);
            },
          },
          // Additive schema-2 table: one row the health check rewrites with a committed write (OPS-02).
          {
            id: 'store-0007-health-probe',
            run: db =>
              db.exec(
                'CREATE TABLE IF NOT EXISTS health_probe(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,payload BLOB NOT NULL)',
              ),
          },
          // Additive schema-2 column: the encrypted declared size (and member) of an unfinished website upload, so it
          // reserves what it declared instead of the whole media limit. Absent or unreadable, the full limit applies.
          {
            id: 'store-0008-media-staging-reservation',
            run: db => {
              if (!db.prepare("SELECT 1 FROM pragma_table_info('media_staging') WHERE name='reservation'").get())
                db.exec('ALTER TABLE media_staging ADD COLUMN reservation TEXT');
            },
          },
          // Additive schema-2 column: when a workspace refused media admission for bytes started waiting (MED-02).
          {
            id: 'store-0009-media-admissions-waiting-since',
            run: db => {
              if (!db.prepare("SELECT 1 FROM pragma_table_info('media_admissions') WHERE name='waiting_since'").get())
                db.exec('ALTER TABLE media_admissions ADD COLUMN waiting_since INTEGER');
            },
          },
          // Additive schema-2 index (OPS-08): owner health's recent job errors read one workspace's newest jobs in
          // order instead of scanning and sorting every job.
          {
            id: 'store-0010-jobs-tenant-updated-index',
            run: db => db.exec('CREATE INDEX IF NOT EXISTS jobs_tenant_updated ON jobs(tenant_id,updated_at)'),
          },
          // Additive schema-2 indexes (OPS-08 sweep): one query names the workspaces with a due schedule instead of
          // one query per workspace on every worker cycle.
          {id: 'store-0011-schedule-global-due-indexes', run: db => db.exec(scheduleGlobalIndexSQL)},
          // Additive schema-2 table (OPS-08): daily provider request counts per hashed issuer and workspace.
          {
            id: 'store-0012-provider-issuer-usage',
            run: db =>
              db.exec(
                'CREATE TABLE IF NOT EXISTS provider_issuer_usage(issuer TEXT NOT NULL,day TEXT NOT NULL,tenant_id TEXT NOT NULL,gateway TEXT NOT NULL,requests INTEGER NOT NULL DEFAULT 0,reserved_requests INTEGER NOT NULL DEFAULT 0,operations INTEGER NOT NULL DEFAULT 0,rate_limits INTEGER NOT NULL DEFAULT 0,refused INTEGER NOT NULL DEFAULT 0,would_refuse INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(issuer,day,tenant_id,gateway))',
              ),
          },
          // Additive schema-2 trigger (OPS-08): a report's split budget and checkpoint documents go with the report.
          {id: 'store-0013-report-parts-cleanup', run: db => db.exec(reportPartsCleanupSQL)},
          // Additive schema-2 change (SEC-07 S4): the audit's update trigger also admits an erasure's tombstone. A
          // database created before keeps the stricter trigger until this replaces it.
          {
            id: 'store-0014-audit-tombstone-trigger',
            run: db => {
              const trigger = db
                .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='audit_no_update'")
                .get() as {sql?: string} | undefined;
              if (!String(trigger?.sql).includes('amcp_audit_tombstone'))
                db.exec('DROP TRIGGER IF EXISTS audit_no_update; ' + auditUpdateTrigger);
            },
          },
          // An additive schema-2 column (SEC-08): the client access set a key is limited to. Absent (the default for
          // every existing row) means the whole workspace, as before. A member's set is a member_access_set document.
          {
            id: 'store-0015-api-key-access-set',
            run: db => {
              if (!db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name=?').get('api_keys', 'access_set_id'))
                db.exec('ALTER TABLE api_keys ADD COLUMN access_set_id TEXT');
            },
          },
          // An additive schema-2 table (ARC-02: one ordered migration list): the /mcp request buckets (SEC-02), which
          // the limiter created on its first admitted request, outside the ledger. An older release creates the same
          // table that way, so a rollback starts unchanged.
          {id: 'store-0016-mcp-rate-limits', run: db => db.exec(mcpRateLimitsSQL)},
        ]);
        schema = readSchemaState(this.db);
      });
      this.bootstrap = {
        schema_version: schema.version,
        min_reader_version: schema.min_reader_version,
        reader_version: READER_VERSION,
        compatibility,
        migration_ms: Math.round((performance.now() - bootstrapStarted) * 1000) / 1000,
        migrations_applied: applied,
      };
      this.cleanupTransient();
      this.transientCleanupTimer = setInterval(() => {
        try {
          this.cleanupMediaTransient();
        } catch (error) {
          recordSqliteFailure(error, 'maintenance');
          this.transientCleanupError =
            error instanceof MirrorError
              ? error.code
              : typeof (error as {code?: unknown})?.code === 'string'
                ? (error as {code: string}).code
                : 'MEDIA_CLEANUP_FAILED';
        }
        // Record expiry used to run from the anonymous health probe; it runs here at most once a minute (OPS-02).
        if (Date.now() - this.recordsCleanupAt >= 60000)
          try {
            this.cleanupExpiredRecords();
          } catch (error) {
            recordSqliteFailure(error, 'maintenance');
          }
        try {
          this.checkpointAfterDeletes();
        } catch (error) {
          // A busy or failed checkpoint is harmless; the next tick retries it.
          recordSqliteFailure(error, 'maintenance');
        }
      }, MEDIA_CLEANUP_INTERVAL_MS);
      this.transientCleanupTimer.unref();
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  close() {
    clearInterval(this.transientCleanupTimer);
    this.db.close();
  }
  /** Store-internal: the keyring, for re-sealing every value under the current key (`admin rekey`, src/rekey.ts). */
  get keyring(): SecretBox | undefined {
    return this.box;
  }
  /** Encrypted read continuations are bound to the current tenant, actor and
   * exact workflow selection. They require no database rows and survive workers
   * and restarts sharing the master key; they never authorize a provider write. */
  sealReadCursor(actor: Actor, binding: string, value: JsonObject): string {
    this.assertActorActive(actor);
    if (!this.box)
      throw new MirrorError('ENCRYPTION_REQUIRED', 'Read continuations require the configured encryption key.');
    const issued = Date.now(),
      data = {version: 1, issued, expires: issued + 900000, value};
    if (Buffer.byteLength(JSON.stringify(data)) > 16384)
      throw new MirrorError('INVALID_READ_CURSOR', 'The read continuation exceeds its size limit.');
    return 'v1.' + this.box.seal(data, scopeKey(actor.tenantId, actor.userId, 'read-cursor', binding));
  }
  openReadCursor(actor: Actor, binding: string, token: string): JsonObject {
    this.assertActorActive(actor);
    try {
      if (!this.box || typeof token !== 'string' || token.length > 32768 || !token.startsWith('v1.')) throw Error();
      const encoded = token.slice(3).split('.');
      if (
        encoded.length !== 3 ||
        encoded.some(s => !s || Buffer.from(s, 'base64').toString('base64') !== s) ||
        Buffer.from(encoded[0]!, 'base64').length !== 12 ||
        Buffer.from(encoded[1]!, 'base64').length !== 16
      )
        throw Error();
      const data = this.box.open<JsonObject>(
          token.slice(3),
          scopeKey(actor.tenantId, actor.userId, 'read-cursor', binding),
        ),
        now = Date.now();
      if (
        data.version !== 1 ||
        !Number.isSafeInteger(data.issued) ||
        data.expires !== data.issued + 900000 ||
        now < data.issued ||
        now >= data.expires ||
        !data.value ||
        typeof data.value !== 'object' ||
        Array.isArray(data.value)
      )
        throw Error();
      return data.value;
    } catch {
      throw new MirrorError(
        'INVALID_READ_CURSOR',
        'The read continuation expired or does not match this actor, connection and request. Restart from the first page.',
      );
    }
  }
  saveUploadSession(tenant: string, id: string, value: JsonObject, expiresAt: number) {
    if (!this.box) throw new MirrorError('ENCRYPTION_REQUIRED', 'Upload sessions require encryption.');
    this.putDocument(tenant, 'upload_session', id, {
      secret: this.box.seal(value, scopeKey(tenant, 'upload-session', id)),
      expires_at: expiresAt,
    });
  }
  // Native preview URLs are shareable capabilities. Keep them out of ordinary
  // receipts/audit, and recover them only after the reviewed-write access check.
  savePreviewReceipt(tenant: string, id: string, value: JsonObject) {
    if (!this.box) throw new MirrorError('ENCRYPTION_REQUIRED', 'Preview recovery requires encryption.');
    this.putDocument(tenant, 'preview_receipt', id, {
      secret: this.box.seal(value, scopeKey(tenant, 'preview-receipt', id)),
      expires_at: Date.now() + 86400000,
    });
  }
  previewReceipt(tenant: string, id: string): JsonObject | undefined {
    const row = this.db
      .prepare("SELECT data FROM documents WHERE tenant_id=? AND kind='preview_receipt' AND id=?")
      .get(tenant, id) as JsonObject | undefined;
    if (!row) return;
    const data = JSON.parse(row.data);
    if (data.expires_at <= Date.now() || !this.box) return;
    return this.box.open<JsonObject>(data.secret, scopeKey(tenant, 'preview-receipt', id));
  }
  uploadSession(tenant: string, id: string): JsonObject | undefined {
    const row = this.db
      .prepare("SELECT data FROM documents WHERE tenant_id=? AND kind='upload_session' AND id=?")
      .get(tenant, id) as JsonObject | undefined;
    if (!row) return;
    const data = JSON.parse(row.data);
    if (data.expires_at <= Date.now()) return;
    return this.box!.open<JsonObject>(data.secret, scopeKey(tenant, 'upload-session', id));
  }
  saveXReportResult(tenant: string, id: string, value: JsonObject, expires: number) {
    if (!this.box) throw new MirrorError('ENCRYPTION_REQUIRED', 'Report result storage requires encryption.');
    this.putDocument(tenant, 'x_report_result', id, {
      secret: this.box.seal(value, scopeKey(tenant, 'x-report-result', id)),
      expires_at: expires,
    });
  }
  xReportResult(tenant: string, id: string): JsonObject | undefined {
    const row = this.db
      .prepare("SELECT data FROM documents WHERE tenant_id=? AND kind='x_report_result' AND id=?")
      .get(tenant, id) as JsonObject | undefined;
    if (!row) return;
    const data = JSON.parse(row.data);
    if (data.expires_at <= Date.now() || !this.box) return;
    return this.box.open<JsonObject>(data.secret, scopeKey(tenant, 'x-report-result', id));
  }
  /**
   * The shared media budget (MED-02): one worst-case operation's bytes by default (AMCP_MEDIA_MEMORY_MB raises it), at
   * most AMCP_MEDIA_OPERATIONS operations at once (default 8) and AMCP_MEDIA_TENANT_OPERATIONS of them per workspace
   * (default 4, half). An operation reserves AMCP_MEDIA_MEMORY_FACTOR (default 6) copies of its file, at least
   * AMCP_MEDIA_MIN_RESERVATION_MB (default 64); a file of unknown size (a download not finished) the worst case.
   */
  get mediaAdmissionLimits() {
    const setting = (name: string, fallback: number, min: number, max: number) => {
      const value = Number(process.env[name] ?? fallback);
      return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
    };
    const factor = setting('AMCP_MEDIA_MEMORY_FACTOR', 6, 2, 12),
      worst = factor * MAX_MEDIA_BYTES,
      operations = setting('AMCP_MEDIA_OPERATIONS', 8, 1, 64);
    return {
      factor,
      worst_case_bytes: worst,
      minimum_bytes: Math.min(worst, setting('AMCP_MEDIA_MIN_RESERVATION_MB', 64, 8, 6144) * 1048576),
      limit_bytes: setting('AMCP_MEDIA_MEMORY_MB', worst / 1048576, worst / 1048576, 8192) * 1048576,
      operations,
      tenant_operations: Math.min(operations, setting('AMCP_MEDIA_TENANT_OPERATIONS', 4, 1, 64)),
    };
  }
  /**
   * Admits one media operation of a file of `size` bytes, when known, into the shared budget (see
   * mediaAdmissionLimits). A workspace refused for bytes is remembered for 20 seconds as waiting: operations of other
   * workspaces that started waiting later, or not at all, must then leave its bytes free, so a large operation is not
   * starved by a stream of small ones.
   */
  mediaAdmission(tenant: string, size?: number) {
    const id = randomUUID(),
      now = Date.now(),
      limits = this.mediaAdmissionLimits,
      known = typeof size === 'number' && Number.isSafeInteger(size) && size > 0 && size <= MAX_MEDIA_BYTES,
      bytes = known
        ? Math.min(limits.worst_case_bytes, Math.max(limits.minimum_bytes, limits.factor * size))
        : limits.worst_case_bytes,
      limit = limits.limit_bytes,
      wait = 'wait:' + tenant;
    let refusal: MirrorError | undefined;
    this.transaction(() => {
      this.db.prepare('DELETE FROM media_admissions WHERE expires_at<=?').run(now);
      const used = this.db
          .prepare(
            "SELECT coalesce(sum(bytes),0) AS n,count(*) AS operations,coalesce(sum(tenant_id=?),0) AS mine FROM media_admissions WHERE id NOT LIKE 'wait:%'",
          )
          .get(tenant) as {n: number; operations: number; mine: number},
        waiting = this.db.prepare('SELECT bytes,waiting_since FROM media_admissions WHERE id=?').get(wait) as
          {bytes: number; waiting_since: number} | undefined,
        ahead = Number(
          (
            this.db
              .prepare(
                "SELECT coalesce(sum(bytes),0) AS n FROM media_admissions WHERE id LIKE 'wait:%' AND tenant_id<>? AND waiting_since<?",
              )
              .get(tenant, waiting?.waiting_since ?? Number.MAX_SAFE_INTEGER) as {n: number}
          ).n,
        ),
        forBytes = used.n + bytes + ahead > limit;
      if (forBytes || used.operations >= limits.operations || used.mine >= limits.tenant_operations) {
        if (forBytes)
          this.db
            .prepare(
              'INSERT INTO media_admissions(id,tenant_id,bytes,expires_at,waiting_since) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET bytes=max(bytes,excluded.bytes),expires_at=excluded.expires_at',
            )
            .run(wait, tenant, bytes, now + 20000, now);
        refusal = new MirrorError(
          'MEDIA_MEMORY_BUSY',
          'Another media operation is using the shared byte budget. Wait for it to finish, then inspect recovery for any submitted review before retrying.',
          {
            retry_after_ms: 5000,
            // What is full: the shared bytes, the deployment's operation slots, or this workspace's share of them.
            reason: forBytes ? 'bytes' : used.mine >= limits.tenant_operations ? 'workspace_share' : 'operation_slots',
            reserved_bytes: used.n,
            limit_bytes: limit,
            requested_bytes: bytes,
            operations: used.operations,
            workspace_operations: used.mine,
          },
          429,
          true,
        );
        return;
      }
      if (waiting && bytes >= waiting.bytes) this.db.prepare('DELETE FROM media_admissions WHERE id=?').run(wait);
      this.db
        .prepare('INSERT INTO media_admissions(id,tenant_id,bytes,expires_at) VALUES(?,?,?,?)')
        .run(id, tenant, bytes, now + MEDIA_LEASE_MS);
    });
    if (refusal) {
      this.noteMedia(tenant, 'memory_busy_refusals');
      throw refusal;
    }
    return {
      id,
      bytes,
      limit,
      check: () => {
        const now = Date.now(),
          r = this.db
            .prepare('UPDATE media_admissions SET expires_at=? WHERE id=? AND expires_at>?')
            .run(now + MEDIA_LEASE_MS, id, now);
        if (!r.changes)
          throw new MirrorError(
            'MEDIA_ADMISSION_LOST',
            'This media operation lost its byte reservation. Inspect any submitted upload before further action.',
          );
      },
      release: () => {
        this.db.prepare('DELETE FROM media_admissions WHERE id=?').run(id);
      },
    };
  }
  mediaSink(tenant: string, id: string, check: () => void): MediaSink {
    if (!this.box) throw new MirrorError('ENCRYPTION_REQUIRED', 'Encrypted staging is required.');
    let pending = Buffer.alloc(4 * 1024 * 1024),
      filled = 0,
      index = 0,
      size = 0;
    const hash = createHash('sha256');
    const flush = () => {
      if (!filled) return;
      check();
      this.transaction(() => {
        if (
          !this.db
            .prepare('SELECT id FROM media_staging WHERE tenant_id=? AND id=? AND expires_at>?')
            .get(tenant, id, Date.now())
        )
          throw new MirrorError('REVIEW_EXPIRED', 'Media staging expired or was cancelled.');
        this.db
          .prepare('INSERT INTO media_chunks VALUES(?,?,?,?)')
          .run(tenant, id, index, this.sealStagedChunk(tenant, id, index, pending.subarray(0, filled)));
      });
      index++;
      filled = 0;
    };
    return {
      write: part => {
        check();
        size += part.length;
        if (size > MAX_MEDIA_BYTES) throw new MirrorError('MEDIA_TOO_LARGE', 'Media exceeds its reservation.');
        hash.update(part);
        for (let offset = 0; offset < part.length;) {
          const take = Math.min(pending.length - filled, part.length - offset);
          pending.set(part.subarray(offset, offset + take), filled);
          filled += take;
          offset += take;
          if (filled === pending.length) flush();
        }
      },
      finish: () => {
        flush();
        check();
        this.db
          .prepare('UPDATE media_staging SET secret=? WHERE tenant_id=? AND id=?')
          .run(
            this.box!.seal({chunks: index, size, sha256: hash.digest('hex')}, scopeKey(tenant, 'media', id)),
            tenant,
            id,
          );
        pending = Buffer.alloc(0);
        return this.stagedMedia(tenant, id);
      },
    };
  }
  journal(tenant: string, id: string, phase: OperationPhase, details: JsonObject = {}) {
    this.transaction(() => {
      const prior = this.db
          .prepare("SELECT data FROM documents WHERE tenant_id=? AND kind='operation_journal' AND id=?")
          .get(tenant, id) as JsonObject | undefined,
        old = prior ? JSON.parse(prior.data) : {sequence: 0, events: []};
      // Only explicit diagnostic fields; no URLs, credentials, request bodies or actor bindings.
      const safe = Object.fromEntries(
          [
            'media_id',
            'bytes_confirmed',
            'total_bytes',
            'upload_session_created',
            'code',
            'step_id',
            'report_id',
            'rows',
            'transfer_ms',
            'http_status',
          ]
            .filter(k => details[k] !== undefined)
            .map(k => [k, details[k]]),
        ),
        event = {sequence: old.sequence + 1, phase, at: Date.now(), ...safe};
      this.putDocument(tenant, 'operation_journal', id, {
        version: 1,
        sequence: event.sequence,
        phase,
        updated_at: event.at,
        events: [...old.events, event].slice(-100),
        ...operationRecovery(phase),
      });
    });
  }
  providerMetric(
    tenant: string,
    gateway: string,
    metric:
      | 'requests'
      | 'errors'
      | 'rate_limits'
      | 'latency_ms'
      | 'wire_contract_violations'
      | 'wire_contract_read_violations'
      | 'wire_contract_check_failures',
    value = 1,
  ) {
    this.transaction(() => {
      const r = this.db
          .prepare("SELECT data FROM documents WHERE tenant_id=? AND kind='provider_metrics' AND id=?")
          .get(tenant, gateway) as JsonObject | undefined,
        data = r ? JSON.parse(r.data) : {};
      this.putDocument(tenant, 'provider_metrics', gateway, {
        ...data,
        [metric]: (data[metric] ?? 0) + value,
        at: Date.now(),
      });
    });
  }
  operationJournal(tenant: string, id: string) {
    try {
      return this.document(tenant, 'operation_journal', id);
    } catch (e) {
      if (!(e instanceof MirrorError && e.code === 'NOT_FOUND')) throw e;
      return {version: 1, phase: 'unknown', events: [], ...operationRecovery('unknown')};
    }
  }
  private cleanupMediaTransient(now = Date.now()) {
    let released: {tenant_id: string; n: number}[] = [];
    this.transaction(() => {
      // Upgrade older reviews that kept a source reference but did not copy its absolute upload deadline.
      this.db
        .prepare(
          `UPDATE media_staging SET expires_at=min(expires_at,coalesce((
        SELECT json_extract(s.data,'$.created_at')+? FROM documents d JOIN documents s
        ON s.tenant_id=d.tenant_id AND s.id=CASE WHEN d.kind='media_review' THEN json_extract(d.data,'$.plan.origin.source_id') ELSE json_extract(d.data,'$.origin.source_id') END
        AND s.kind IN ('media_source','retained_media_source') AND json_extract(s.data,'$.origin')='upload'
        WHERE d.tenant_id=media_staging.tenant_id AND d.id=media_staging.id AND d.kind IN ('media_review','media_variant')
      ),expires_at)) WHERE id NOT LIKE 'src-%'`,
        )
        .run(WEBSITE_UPLOAD_TTL_MS);
      // Historical retained website originals obey the same deadline. Provider media and metadata receipts are separate.
      // Keep the partial-index predicate explicit: SQLite does not infer a single kind from its IN condition.
      const expiredUploads = `SELECT tenant_id,id FROM documents
        WHERE kind IN ('media_source','retained_media_source','media_review','media_variant','upload_session','preview_receipt')
        AND kind='retained_media_source' AND json_extract(data,'$.origin')='upload'
        AND coalesce(json_extract(data,'$.created_at'),0)<=?`;
      // The manifest goes first, inside this transaction; its chunks are then erased one row per statement.
      if (
        this.db
          .prepare(`DELETE FROM retained_media WHERE (tenant_id,id) IN (${expiredUploads})`)
          .run(now - WEBSITE_UPLOAD_TTL_MS).changes
      )
        this.chunkSweepPending = true;
      this.db
        .prepare(`DELETE FROM documents WHERE kind='retained_media_source' AND (tenant_id,id) IN (${expiredUploads})`)
        .run(now - WEBSITE_UPLOAD_TTL_MS);
      // Cap older source records/staging too; a previous deployment or edited expiry cannot extend a website upload.
      this.db
        .prepare(
          "UPDATE media_staging SET expires_at=min(expires_at,coalesce((SELECT json_extract(d.data,'$.created_at')+? FROM documents d WHERE d.tenant_id=media_staging.tenant_id AND d.id=media_staging.id AND d.kind='media_source' AND json_extract(d.data,'$.origin')='upload'),expires_at)) WHERE id LIKE 'src-%'",
        )
        .run(WEBSITE_UPLOAD_TTL_MS);
      this.db
        .prepare(
          `UPDATE media_staging SET expires_at=min(expires_at,coalesce((
        SELECT CASE WHEN d.kind='media_review' THEN json_extract(d.data,'$.plan.upload_expires_at') ELSE json_extract(d.data,'$.upload_expires_at') END
        FROM documents d WHERE d.tenant_id=media_staging.tenant_id AND d.id=media_staging.id AND d.kind IN ('media_review','media_variant')
      ),expires_at)) WHERE id NOT LIKE 'src-%'`,
        )
        .run();
      this.db
        .prepare(
          `UPDATE documents SET data=json_set(data,'$.expires_at',min(json_extract(data,'$.expires_at'),
        (SELECT m.expires_at FROM media_staging m WHERE m.tenant_id=documents.tenant_id AND m.id=documents.id)))
        WHERE kind IN ('media_review','media_variant','upload_session') AND EXISTS(
          SELECT 1 FROM media_staging m WHERE m.tenant_id=documents.tenant_id AND m.id=documents.id AND m.expires_at<json_extract(documents.data,'$.expires_at'))`,
        )
        .run();
      // A cached fitted copy never outlives the original it was derived from (MED-03 C): its staging, or the retained
      // copy, must still exist.
      if (
        this.db
          .prepare(
            `DELETE FROM media_staging WHERE id LIKE 'fit-%' AND NOT EXISTS(
          SELECT 1 FROM media_staging s WHERE s.tenant_id=media_staging.tenant_id AND s.id=substr(media_staging.id,5,40) AND s.expires_at>?)
          AND NOT EXISTS(SELECT 1 FROM retained_media r WHERE r.tenant_id=media_staging.tenant_id AND r.id=substr(media_staging.id,5,40))`,
          )
          .run(now).changes
      )
        this.chunkSweepPending = true;
      this.cleanupStagedMedia(now);
      // An unfinished upload whose staging was released (idle, removed or expired) leaves no receiving record behind.
      const unfinished = `FROM documents WHERE kind IN ('media_source','retained_media_source','media_review','media_variant','upload_session','preview_receipt')
        AND kind='media_source' AND json_extract(data,'$.state')='receiving' AND NOT EXISTS(
          SELECT 1 FROM media_staging m WHERE m.tenant_id=documents.tenant_id AND m.id=documents.id)`;
      released = this.db.prepare(`SELECT tenant_id,count(*) AS n ${unfinished} GROUP BY tenant_id`).all() as {
        tenant_id: string;
        n: number;
      }[];
      if (released.length) this.db.prepare(`DELETE ${unfinished}`).run();
      this.db.prepare('DELETE FROM media_admissions WHERE expires_at<=?').run(now);
      this.db
        .prepare(
          "DELETE FROM documents WHERE kind IN ('media_source','retained_media_source','media_review','media_variant','upload_session','preview_receipt') AND ((kind IN ('upload_session','preview_receipt','media_source','media_variant') AND json_extract(data,'$.expires_at')<=?) OR (kind='media_source' AND json_extract(data,'$.origin')='upload' AND coalesce(json_extract(data,'$.created_at'),0)<=?) OR (kind='media_variant' AND json_extract(data,'$.upload_expires_at')<=?))",
        )
        .run(now, now - WEBSITE_UPLOAD_TTL_MS, now);
    });
    for (const r of released) this.noteMedia(r.tenant_id, 'unfinished_uploads_released', Number(r.n));
    // Erase the chunks of every removed manifest now; a failure leaves them unreadable and is retried next tick.
    this.sweepMediaChunks();
    this.transientCleanupAt = now;
    this.transientCleanupError = undefined;
  }

  cleanupTransient() {
    const now = Date.now();
    this.cleanupMediaTransient(now);
    this.cleanupExpiredRecords(now);
  }
  /**
   * Expired report runs and results, provider cooldowns and day-old service heartbeats, budgets and quotas: the
   * document kinds are those src/document-kinds.ts gives this timer (`maintenanceSweeps`).
   */
  private cleanupExpiredRecords(now = Date.now()) {
    this.transaction(() => {
      for (const sweep of recordSweeps) this.db.prepare(sweep.sql).run(sweep.cutoff(now));
      this.db.prepare('DELETE FROM provider_cooldowns WHERE until_at<=?').run(now);
      // Issuer quota counters keep the current day and the seven before it (OPS-08 baseline).
      this.db
        .prepare('DELETE FROM provider_issuer_usage WHERE day<?')
        .run(quotaDay(now - (QUOTA_RETAINED_DAYS - 1) * 86400000));
    });
    this.recordsCleanupAt = now;
  }
  /**
   * One small committed write for the health check (OPS-02): a new probe row large enough to need a fresh page,
   * replacing the previous one. 'busy' is contention (degraded), 'full' is exhausted storage, 'failed' anything else.
   */
  probeWrite(now = Date.now()): 'ok' | 'busy' | 'full' | 'failed' {
    if (this.transactionDepth > 0) return 'busy';
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const id = this.db
          .prepare('INSERT INTO health_probe(at,payload) VALUES(?,zeroblob(4096))')
          .run(now).lastInsertRowid;
        this.db.prepare('DELETE FROM health_probe WHERE id<?').run(id);
        this.db.exec('COMMIT');
      } catch (e) {
        if (this.db.isTransaction) this.db.exec('ROLLBACK');
        throw e;
      }
      return 'ok';
    } catch (e) {
      const database = recordSqliteFailure(e, 'health');
      return database?.primary_code === 13
        ? 'full'
        : database?.primary_code === 5 || database?.primary_code === 6
          ? 'busy'
          : 'failed';
    }
  }

  /**
   * At a claim, a review's frozen copy is kept for its transfer window (MED-01 Stage D), so a qualified resume can
   * continue after the five-minute confirmation window. The caller caps `until` at a website upload's absolute deadline;
   * the cleanup timer caps it again. Uploaded originals (`src-…`) never use this.
   */
  holdStagedTransfer(tenant: string, id: string, until: number) {
    if (!Number.isSafeInteger(until) || until <= Date.now() || id.startsWith('src-'))
      throw new MirrorError('REVIEW_EXPIRED', 'The media staging expired or was removed.');
    const result = this.db
      .prepare(
        "UPDATE media_staging SET expires_at=max(expires_at,?) WHERE tenant_id=? AND id=? AND id NOT LIKE 'src-%' AND expires_at>?",
      )
      .run(until, tenant, id, Date.now());
    if (result.changes !== 1) throw new MirrorError('REVIEW_EXPIRED', 'The media staging expired or was removed.');
  }
  /** Derived upload copies may shorten a staging lifetime, never extend it. */
  capStagedMediaExpiry(tenant: string, id: string, expiresAt: number) {
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())
      throw new MirrorError('REVIEW_EXPIRED', 'The original website upload expired. Upload the file again.');
    const result = this.db
      .prepare('UPDATE media_staging SET expires_at=min(expires_at,?) WHERE tenant_id=? AND id=? AND expires_at>?')
      .run(expiresAt, tenant, id, Date.now());
    if (result.changes !== 1) throw new MirrorError('REVIEW_EXPIRED', 'The media staging expired or was removed.');
  }

  /**
   * Removes expired staging manifests, which makes their chunks unreadable at once and frees their quota. The chunks are
   * erased after the enclosing transaction, one row per statement, so secure deletion of a large file never needs a
   * write-ahead log the size of the file (OPS-01).
   */
  private cleanupStagedMedia(now = Date.now()) {
    if (this.db.prepare('DELETE FROM media_staging WHERE expires_at<=?').run(now).changes)
      this.chunkSweepPending = true;
  }
  /**
   * Erases encrypted chunks whose manifest is gone (removed, expired or left by an interrupted staging), one row per
   * statement. Inside a transaction it only marks the sweep, which then runs after the outermost commit. Returns the
   * number of chunks erased.
   */
  sweepMediaChunks(): number {
    if (this.transactionDepth > 0 || this.db.isTransaction) {
      this.chunkSweepPending = true;
      return 0;
    }
    this.chunkSweepPending = false;
    let removed = 0;
    try {
      removed += deleteRowsOneByOne(this.db, 'media_chunks', orphanStagedChunk);
      removed += deleteRowsOneByOne(this.db, 'retained_media_chunks', orphanRetainedChunk);
    } catch (e) {
      this.chunkSweepPending = true;
      throw e;
    } finally {
      if (removed) this.checkpointPending = true;
    }
    return removed;
  }
  /** Asks the next maintenance pass to truncate the write-ahead log, as after an account erasure (SEC-07). */
  scheduleCheckpoint() {
    this.checkpointPending = true;
  }
  /**
   * After large deletions, truncates the write-ahead log when no job holds a lease. It never waits: a busy result is
   * harmless and the next maintenance tick tries again (OPS-01).
   */
  checkpointAfterDeletes(now = Date.now()): boolean {
    if (!this.checkpointPending || this.transactionDepth > 0 || this.db.isTransaction) return false;
    if (this.db.prepare("SELECT 1 FROM jobs WHERE state='running' AND lease_until>? LIMIT 1").get(now)) return false;
    const timeout = Number((this.db.prepare('PRAGMA busy_timeout').get() as {timeout: number}).timeout);
    this.db.exec('PRAGMA busy_timeout=0');
    try {
      const result = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as {busy?: number} | undefined;
      if (result?.busy !== 0) return false;
      this.checkpointPending = false;
      return true;
    } finally {
      this.db.exec('PRAGMA busy_timeout=' + (Number.isSafeInteger(timeout) && timeout >= 0 ? timeout : 5000));
    }
  }
  /** Free and total bytes of the file system holding the database, or undefined in memory or when unreadable. */
  storageSpace() {
    const file = this.db.location();
    return storageSpace(file ? path.dirname(file) : undefined, this.statfs);
  }
  /**
   * Refuses, retryably, to admit `rawBytes` of new media when free space would fall below twice its stored size plus
   * the configured floor (OPS-01). Unknown free space never refuses; health reports it instead.
   */
  assertStorageCapacity(rawBytes: number) {
    const space = this.storageSpace();
    if (!space || space.free_bytes >= storageAdmissionRequirement(rawBytes, space.total_bytes)) return;
    throw new MirrorError('STORAGE_LOW', STORAGE_LOW_MESSAGE, {retry_after_ms: 60000}, 503, true);
  }
  /** Seals one chunk of a staged file: a raw BLOB (format v2) unless AMCP_MEDIA_CHUNK_FORMAT=v1 keeps base64 JSON. */
  private sealStagedChunk(tenant: string, id: string, index: number, bytes: Buffer): string | Buffer {
    const [v1, v2] = stagedChunkScopes(tenant, id, index);
    return this.sealChunk(v1, v2, bytes);
  }
  private openStagedChunk(tenant: string, id: string, index: number, sealed: unknown): Buffer {
    const [v1, v2] = stagedChunkScopes(tenant, id, index);
    return this.openChunk(v1, v2, sealed, 'MEDIA_STAGING_INVALID');
  }
  /** Seals one chunk of media for a document-scoped purpose, in the current chunk format (see `sealStagedChunk`). */
  sealMediaChunk(tenant: string, purpose: string, id: string, bytes: Buffer): string | Buffer {
    return this.sealChunk(
      scopeKey(tenant, 'sealed-value', purpose, id),
      scopeKey(tenant, 'sealed-bytes', purpose, id),
      bytes,
    );
  }
  /** Opens a chunk sealed by `sealMediaChunk` in either format; an oversized chunk is refused with `invalidCode`. */
  openMediaChunk(tenant: string, purpose: string, id: string, sealed: unknown, invalidCode: string): Buffer {
    return this.openChunk(
      scopeKey(tenant, 'sealed-value', purpose, id),
      scopeKey(tenant, 'sealed-bytes', purpose, id),
      sealed,
      invalidCode,
    );
  }
  private sealChunk(v1Scope: string, v2Scope: string, bytes: Buffer): string | Buffer {
    if (!this.box) throw new MirrorError('ENCRYPTION_REQUIRED', 'Encrypted staging is required.');
    return mediaChunkFormat() === 'v1'
      ? this.box.seal({bytes: bytes.toString('base64')}, v1Scope)
      : this.box.sealBytes(bytes, v2Scope);
  }
  /** SQLite returns a v2 chunk as bytes and a v1 chunk as text; both stay readable. */
  private openChunk(v1Scope: string, v2Scope: string, sealed: unknown, invalidCode: string): Buffer {
    if (!this.box) throw new MirrorError('ENCRYPTION_REQUIRED', 'Encrypted staging is required.');
    const oversized = () => new MirrorError(invalidCode, 'An encrypted media chunk exceeds its byte ceiling.');
    if (sealed instanceof Uint8Array) {
      if (sealed.length > MEDIA_CHUNK_BYTES + sealedBytesOverhead) throw oversized();
      return this.box.openBytes(sealed, v2Scope);
    }
    if (typeof sealed !== 'string') throw new MirrorError(invalidCode, 'An encrypted media chunk has no known format.');
    const encoded = this.box.open<{bytes?: unknown}>(sealed, v1Scope).bytes;
    if (typeof encoded !== 'string')
      throw new MirrorError(invalidCode, 'An encrypted media chunk has no known format.');
    if (encoded.length > Math.ceil(MEDIA_CHUNK_BYTES / 3) * 4) throw oversized();
    return Buffer.from(encoded, 'base64');
  }
  /**
   * Original-file counts include staged sources, the fitted copies cached from them (MED-03 C) and retained copies;
   * review/variant staging is independent.
   */
  private stagedCount(sources: boolean, tenant?: string) {
    const kind = sources ? SOURCE_ROWS : 'NOT ' + SOURCE_ROWS,
      row = (
        tenant === undefined
          ? this.db.prepare('SELECT count(*) AS n FROM media_staging WHERE ' + kind).get()
          : this.db.prepare('SELECT count(*) AS n FROM media_staging WHERE tenant_id=? AND ' + kind).get(tenant)
      ) as {n: number};
    return row.n + (sources ? retainedMediaStats(this, tenant).count : 0);
  }
  reserveMedia(tenant: string, id: string, expiresAt: number) {
    if (!this.box) throw new MirrorError('ENCRYPTION_REQUIRED', 'Media staging requires the configured master key.');
    if (id.startsWith('src-')) throw new MirrorError('MEDIA_STAGING_INVALID', 'Invalid media staging id.');
    this.transaction(() => {
      this.cleanupStagedMedia();
      // Uploaded sources have their own quota (reserveMediaSource), so waiting uploads never take a review's place.
      if (this.stagedCount(false, tenant) >= 2 || this.stagedCount(false) >= 8)
        throw new MirrorError(
          'MEDIA_STAGING_FULL',
          'Finish or cancel existing media reviews, or wait five minutes for them to expire.',
          {},
          429,
        );
      this.db
        .prepare('INSERT INTO media_staging(tenant_id,id,secret,expires_at) VALUES(?,?,NULL,?)')
        .run(tenant, id, expiresAt);
    });
  }
  /** The sealed declared size and member of an unfinished website upload; undefined when absent or unreadable. */
  private reservation(tenant: string, id: string, sealed: string | null): {bytes: number; member: string} | undefined {
    if (!sealed || !this.box) return;
    try {
      const r = this.box.open<{bytes?: unknown; member?: unknown}>(sealed, scopeKey(tenant, 'media-reservation', id));
      if (
        Number.isSafeInteger(r.bytes) &&
        (r.bytes as number) >= 1 &&
        (r.bytes as number) <= MAX_MEDIA_BYTES &&
        typeof r.member === 'string' &&
        r.member
      )
        return {bytes: r.bytes as number, member: r.member};
    } catch {
      /* Fails closed: an unreadable reservation counts at the whole media limit. */
    }
  }
  /**
   * Bytes held by uploaded files: a finished one counts its size; one still arriving its sealed declared size (the
   * website enforces it exactly); a download of unknown size, or a reservation that cannot be read, the whole limit.
   */
  private stagedSourceBytes(tenant?: string) {
    const rows = (
      tenant === undefined
        ? this.db.prepare('SELECT tenant_id, id, secret, reservation FROM media_staging WHERE ' + SOURCE_ROWS).all()
        : this.db
            .prepare(
              'SELECT tenant_id, id, secret, reservation FROM media_staging WHERE tenant_id=? AND ' + SOURCE_ROWS,
            )
            .all(tenant)
    ) as {tenant_id: string; id: string; secret: string | null; reservation: string | null}[];
    let bytes = 0;
    for (const r of rows) {
      const size = r.secret
        ? Number(this.box!.open<{size?: unknown}>(r.secret, scopeKey(r.tenant_id, 'media', r.id)).size)
        : r.id.startsWith('fit-')
          ? Number(this.fitCacheMetadata(r.tenant_id, r.id, r.reservation)?.size ?? NaN)
          : (this.reservation(r.tenant_id, r.id, r.reservation)?.bytes ?? NaN);
      bytes += Number.isSafeInteger(size) && size >= 0 && size <= MAX_MEDIA_BYTES ? size : MAX_MEDIA_BYTES;
    }
    return bytes + retainedMediaStats(this, tenant).bytes;
  }
  /** One member's unfinished website uploads in a workspace: how many, and the bytes they declared. */
  private unfinishedUploads(tenant: string, member: string) {
    let count = 0,
      bytes = 0;
    for (const r of this.db
      .prepare(
        "SELECT id, reservation FROM media_staging WHERE tenant_id=? AND id LIKE 'src-%' AND secret IS NULL AND reservation IS NOT NULL",
      )
      .all(tenant) as {id: string; reservation: string}[]) {
      const declared = this.reservation(tenant, r.id, r.reservation);
      // An unreadable reservation cannot be attributed; it already counts at the whole limit for the workspace.
      if (declared?.member !== member) continue;
      count++;
      bytes += declared.bytes;
    }
    return {count, bytes};
  }
  /** A selected durable copy shares the existing original-file count and byte ceilings with uploads. */
  assertRetainedMediaCapacity(tenant: string, size: number) {
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_MEDIA_BYTES)
      throw new MirrorError('MEDIA_LIBRARY_INVALID', 'Invalid retained-original size.');
    this.assertStorageCapacity(size);
    this.cleanupStagedMedia();
    const full = () =>
      this.stagedCount(true, tenant) >= 25 ||
      this.stagedSourceBytes(tenant) + size > 4 * MAX_MEDIA_BYTES ||
      this.stagedCount(true) >= 50 ||
      this.stagedSourceBytes() + size > 8 * MAX_MEDIA_BYTES;
    // Cached fitted copies can always be computed again: they give way before an original is refused (MED-03 C).
    if (full() && (!this.evictFitCache(tenant) || full()) && (!this.evictFitCache() || full()))
      throw new MirrorError(
        'MEDIA_STAGING_FULL',
        'Waiting uploads and retained originals fill the shared file storage. Remove selected files or wait for temporary uploads to expire. Retained copies require owner confirmation to remove.',
        {},
        429,
        true,
      );
  }
  /**
   * Reserves encrypted staging for a file uploaded to AMCP or imported from a link or Drive (media-sources.ts), apart
   * from the reviews and variants each workspace may stage. Each workspace holds at most four, and AMCP at most eight,
   * times the media limit in bytes; and at most 25 and 50 files. A website upload declares its exact size (`declared`,
   * sealed with the row) and reserves that size; a link or Drive download, whose size is not known yet, reserves the
   * whole limit until it is finished. One member's unfinished website uploads hold at most two limits' worth of bytes
   * and ten files, so abandoned uploads of one member cannot fill a workspace for everyone.
   * The volume must also keep room for the reserved bytes, or it refuses with STORAGE_LOW (OPS-01).
   */
  reserveMediaSource(tenant: string, id: string, expiresAt: number, declared?: {bytes: number; member: string}) {
    if (!this.box) throw new MirrorError('ENCRYPTION_REQUIRED', 'Media staging requires the configured master key.');
    if (!/^src-[0-9a-f-]{36}$/.test(id)) throw new MirrorError('MEDIA_STAGING_INVALID', 'Invalid media source id.');
    if (
      declared &&
      (!Number.isSafeInteger(declared.bytes) ||
        declared.bytes < 1 ||
        declared.bytes > MAX_MEDIA_BYTES ||
        typeof declared.member !== 'string' ||
        !declared.member)
    )
      throw new MirrorError('MEDIA_STAGING_INVALID', 'Invalid media source reservation.');
    const reserved = declared?.bytes ?? MAX_MEDIA_BYTES;
    this.assertStorageCapacity(reserved);
    this.transaction(() => {
      this.cleanupStagedMedia();
      let refusal: MirrorError | undefined;
      // Cached fitted copies can always be computed again: they give way before an upload is refused (MED-03 C).
      const workspaceFull = () =>
          this.stagedCount(true, tenant) >= 25 || this.stagedSourceBytes(tenant) + reserved > 4 * MAX_MEDIA_BYTES,
        deploymentFull = () =>
          this.stagedCount(true) >= 50 || this.stagedSourceBytes() + reserved > 8 * MAX_MEDIA_BYTES;
      if (workspaceFull()) this.evictFitCache(tenant);
      if (!workspaceFull() && deploymentFull()) this.evictFitCache();
      if (workspaceFull())
        refusal = new MirrorError(
          'MEDIA_STAGING_FULL',
          'Waiting uploads and retained originals fill this workspace storage (25 files, or four at the media limit). Discard unfinished uploads or remove files on the Media library page, or wait for temporary uploads to expire; retained copies require owner confirmation.',
          {retry_after_ms: 60000},
          429,
          true,
        );
      else if (declared) {
        const mine = this.unfinishedUploads(tenant, declared.member);
        if (mine.count >= MEMBER_UNFINISHED_UPLOADS || mine.bytes + reserved > MEMBER_UNFINISHED_BYTES)
          refusal = new MirrorError(
            'MEDIA_STAGING_FULL',
            'Your unfinished uploads fill your share of this workspace storage. Resume or discard them on the Media library page; an upload that receives nothing for a while is released automatically.',
            {retry_after_ms: 60000, member_share: true},
            429,
            true,
          );
      }
      if (!refusal && deploymentFull())
        refusal = new MirrorError(
          'MEDIA_STAGING_FULL',
          'AMCP is holding as many uploaded files as it keeps at once. Try again in a few minutes.',
          {retry_after_ms: 60000},
          429,
          true,
        );
      if (refusal) {
        this.noteMedia(tenant, 'staging_full_refusals');
        throw refusal;
      }
      this.db
        .prepare('INSERT INTO media_staging(tenant_id,id,secret,expires_at,reservation) VALUES(?,?,NULL,?,?)')
        .run(
          tenant,
          id,
          expiresAt,
          declared ? this.box!.seal(declared, scopeKey(tenant, 'media-reservation', id)) : null,
        );
    });
  }
  /**
   * Keeps an unfinished or just-completed source's staging until `until`: the caller passes the idle release or the
   * absolute website deadline, never later (media-retention.ts). Refuses a row that already expired or was removed.
   */
  holdStagedSource(tenant: string, id: string, until: number) {
    const now = Date.now();
    if (!Number.isSafeInteger(until) || until <= now)
      throw new MirrorError('REVIEW_EXPIRED', 'The upload expired or was removed. Upload the file again.');
    const result = this.db
      .prepare("UPDATE media_staging SET expires_at=? WHERE tenant_id=? AND id=? AND id LIKE 'src-%' AND expires_at>?")
      .run(until, tenant, id, now);
    if (result.changes !== 1)
      throw new MirrorError('REVIEW_EXPIRED', 'The upload expired or was removed. Upload the file again.');
  }
  /** The sealed description of a cached fitted copy (MED-03 C); undefined when absent or unreadable. */
  private fitCacheMetadata(tenant: string, id: string, sealed: string | null): JsonObject | undefined {
    if (!sealed || !this.box) return;
    try {
      const m = this.box.open<JsonObject>(sealed, scopeKey(tenant, 'media-fit-cache', id));
      return Number.isSafeInteger(m.size) && m.size >= 1 && m.size <= MAX_MEDIA_BYTES ? m : undefined;
    } catch {
      return undefined;
    }
  }
  /**
   * Stages a fitted copy of an original for the reviews that follow its plan (MED-03 C). `id` names the original it
   * was derived from; it lapses at `expiresAt` (the caller passes the original's deadline, never later) and counts
   * against the original-file quota, which it never exceeds: a full quota refuses it (MEDIA_STAGING_FULL), and an
   * upload that needs the room later evicts it. Replaces an earlier copy under the same id.
   */
  stageFitCache(tenant: string, id: string, expiresAt: number, metadata: JsonObject, bytes: Buffer) {
    if (!this.box) throw new MirrorError('ENCRYPTION_REQUIRED', 'Media staging requires the configured master key.');
    if (
      !FIT_CACHE_ID.test(id) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= Date.now() ||
      !bytes.length ||
      bytes.length > MAX_MEDIA_BYTES
    )
      throw new MirrorError('MEDIA_STAGING_INVALID', 'Invalid fitted media copy.');
    this.assertStorageCapacity(bytes.length);
    this.transaction(() => {
      this.cleanupStagedMedia();
      this.db.prepare('DELETE FROM media_staging WHERE tenant_id=? AND id=?').run(tenant, id);
      if (
        this.stagedCount(true, tenant) >= 25 ||
        this.stagedSourceBytes(tenant) + bytes.length > 4 * MAX_MEDIA_BYTES ||
        this.stagedCount(true) >= 50 ||
        this.stagedSourceBytes() + bytes.length > 8 * MAX_MEDIA_BYTES
      )
        throw new MirrorError(
          'MEDIA_STAGING_FULL',
          'The workspace file storage has no room for a fitted copy.',
          {},
          429,
        );
      this.db
        .prepare('INSERT INTO media_staging(tenant_id,id,secret,expires_at,reservation) VALUES(?,?,NULL,?,?)')
        .run(
          tenant,
          id,
          expiresAt,
          this.box!.seal({...metadata, size: bytes.length}, scopeKey(tenant, 'media-fit-cache', id)),
        );
    });
    try {
      this.stageMedia(tenant, id, bytes);
    } catch (e) {
      this.removeStagedMedia(tenant, id);
      throw e;
    }
  }
  /** A cached fitted copy that is staged completely and has not expired: its sealed description and expiry. */
  fitCache(tenant: string, id: string): {metadata: JsonObject; expires_at: number} | undefined {
    if (!FIT_CACHE_ID.test(id)) return;
    const row = this.db
      .prepare('SELECT secret,reservation,expires_at FROM media_staging WHERE tenant_id=? AND id=? AND expires_at>?')
      .get(tenant, id, Date.now()) as
      {secret: string | null; reservation: string | null; expires_at: number} | undefined;
    if (!row?.secret || !this.box) return;
    const metadata = this.fitCacheMetadata(tenant, id, row.reservation),
      manifest = this.box.open<{size?: unknown; sha256?: unknown}>(row.secret, scopeKey(tenant, 'media', id));
    if (!metadata || manifest.size !== metadata.size || manifest.sha256 !== metadata.sha256) return;
    return {metadata, expires_at: row.expires_at};
  }
  /** Removes every fitted copy cached from the original `sourceId` (removed or discarded); returns how many. */
  removeFitCache(tenant: string, sourceId: string): number {
    if (!/^(?:src|lib)-[0-9a-f-]{36}$/.test(sourceId)) return 0;
    return this.transaction(() => {
      const n = Number(
        this.db
          .prepare('DELETE FROM media_staging WHERE tenant_id=? AND id LIKE ?')
          .run(tenant, 'fit-' + sourceId + '-%').changes,
      );
      if (n) this.chunkSweepPending = true;
      return n;
    });
  }
  /** Drops the cached fitted copies of one workspace, or of all, so an original can be admitted; returns how many. */
  private evictFitCache(tenant?: string): number {
    const n = Number(
      (tenant === undefined
        ? this.db.prepare("DELETE FROM media_staging WHERE id LIKE 'fit-%'").run()
        : this.db.prepare("DELETE FROM media_staging WHERE tenant_id=? AND id LIKE 'fit-%'").run(tenant)
      ).changes,
    );
    if (n) this.chunkSweepPending = true;
    return n;
  }
  /** Whether a source's staging still exists, and when it ends; for an unfinished upload, its idle release. */
  stagedSourceExpiry(tenant: string, id: string): number | undefined {
    const row = this.db
      .prepare('SELECT expires_at FROM media_staging WHERE tenant_id=? AND id=? AND expires_at>?')
      .get(tenant, id, Date.now()) as {expires_at: number} | undefined;
    return row?.expires_at;
  }
  /** The part indexes received so far for an unfinished upload, without decrypting them; and whether all are sealed. */
  receivedMediaChunks(tenant: string, id: string): {parts: number[]; sealed: boolean} {
    const row = this.db
      .prepare('SELECT secret FROM media_staging WHERE tenant_id=? AND id=? AND expires_at>?')
      .get(tenant, id, Date.now()) as {secret: string | null} | undefined;
    if (!row) throw new MirrorError('REVIEW_EXPIRED', 'The upload expired or was removed. Upload the file again.');
    return {
      parts: (
        this.db
          .prepare('SELECT chunk_index FROM media_chunks WHERE tenant_id=? AND id=? ORDER BY chunk_index')
          .all(tenant, id) as {chunk_index: number}[]
      ).map(r => r.chunk_index),
      sealed: !!row.secret,
    };
  }
  private receivingSource(tenant: string, id: string) {
    const row = this.db
      .prepare('SELECT secret FROM media_staging WHERE tenant_id=? AND id=? AND expires_at>?')
      .get(tenant, id, Date.now()) as {secret: string | null} | undefined;
    if (!row) throw new MirrorError('REVIEW_EXPIRED', 'The upload expired or was removed. Upload the file again.');
    if (row.secret) throw new MirrorError('MEDIA_UPLOAD_COMPLETE', 'This upload is already complete.', {}, 409);
  }
  /**
   * Stores chunk `index` of a file that is still being received, encrypted like every staged chunk. A chunk sent again
   * replaces itself, so a client may retry one. `chunkBytes` is the upload's chunk size: no chunk is longer, and no
   * chunk starts past the media limit, so one upload never holds more than the limit plus one chunk.
   */
  putMediaChunk(tenant: string, id: string, index: number, bytes: Buffer, chunkBytes: number, holdUntil?: number) {
    if (!this.box) throw new MirrorError('ENCRYPTION_REQUIRED', 'Encrypted staging is required.');
    if (
      !Number.isSafeInteger(chunkBytes) ||
      chunkBytes < 1 ||
      chunkBytes > 4 * 1024 * 1024 ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index * chunkBytes >= MAX_MEDIA_BYTES ||
      !bytes.length ||
      bytes.length > chunkBytes ||
      (holdUntil !== undefined && !Number.isSafeInteger(holdUntil))
    )
      throw new MirrorError('MEDIA_STAGING_INVALID', 'Invalid media chunk.');
    this.transaction(() => {
      this.receivingSource(tenant, id);
      this.db
        .prepare('INSERT OR REPLACE INTO media_chunks VALUES(?,?,?,?)')
        .run(tenant, id, index, this.sealStagedChunk(tenant, id, index, bytes));
      // A part is activity: the idle release moves on, to a time the caller caps at the absolute upload deadline.
      if (holdUntil !== undefined && holdUntil > Date.now())
        this.db
          .prepare('UPDATE media_staging SET expires_at=? WHERE tenant_id=? AND id=? AND expires_at>?')
          .run(holdUntil, tenant, id, Date.now());
    });
  }
  /**
   * Completes a file received in chunks: chunks 0 to `chunks - 1` must all be present, each exactly `chunkBytes` long
   * except the last, adding up to `size`. Writes the manifest `stagedMedia` reads and returns the file's SHA-256.
   * Completion is idempotent: when an interrupted completion already wrote the manifest (no part can be added after
   * it), the same chunks are checked against it and its SHA-256 is returned again.
   */
  finalizeMediaChunks(tenant: string, id: string, expected: {chunks: number; size: number; chunkBytes: number}) {
    if (!this.box) throw new MirrorError('ENCRYPTION_REQUIRED', 'Encrypted staging is required.');
    const {chunks, size, chunkBytes} = expected;
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_MEDIA_BYTES)
      throw new MirrorError('MEDIA_STAGING_INVALID', 'Invalid media size.');
    return this.transaction(() => {
      const staged = this.db
        .prepare('SELECT secret FROM media_staging WHERE tenant_id=? AND id=? AND expires_at>?')
        .get(tenant, id, Date.now()) as {secret: string | null} | undefined;
      if (!staged) throw new MirrorError('REVIEW_EXPIRED', 'The upload expired or was removed. Upload the file again.');
      const hash = createHash('sha256');
      let index = 0,
        total = 0;
      for (const c of this.db
        .prepare('SELECT chunk_index,secret FROM media_chunks WHERE tenant_id=? AND id=? ORDER BY chunk_index')
        .iterate(tenant, id) as Iterable<JsonObject>) {
        if (c.chunk_index !== index)
          throw new MirrorError('MEDIA_UPLOAD_INCOMPLETE', 'Part ' + (index + 1) + ' of the upload is missing.', {
            missing_chunk: index,
          });
        const part = this.openStagedChunk(tenant, id, index, c.secret);
        if (index < chunks - 1 && part.length !== chunkBytes)
          throw new MirrorError('MEDIA_UPLOAD_INCOMPLETE', 'Part ' + (index + 1) + ' of the upload is incomplete.', {
            incomplete_chunk: index,
          });
        hash.update(part);
        total += part.length;
        index++;
      }
      if (index !== chunks || total !== size)
        throw new MirrorError('MEDIA_UPLOAD_INCOMPLETE', 'The upload has not received every part yet.', {
          received_chunks: index,
          expected_chunks: chunks,
          received_bytes: total,
          expected_bytes: size,
        });
      const digest = hash.digest('hex');
      if (staged.secret) {
        const manifest = this.box!.open<{chunks?: unknown; size?: unknown; sha256?: unknown}>(
          staged.secret,
          scopeKey(tenant, 'media', id),
        );
        if (manifest.chunks !== chunks || manifest.size !== size || manifest.sha256 !== digest)
          throw new MirrorError('MEDIA_STAGING_INVALID', 'Encrypted media chunks do not match their manifest.');
        return digest;
      }
      this.db
        .prepare('UPDATE media_staging SET secret=? WHERE tenant_id=? AND id=?')
        .run(this.box!.seal({chunks, size, sha256: digest}, scopeKey(tenant, 'media', id)), tenant, id);
      return digest;
    });
  }
  /** One decrypted chunk of a completed staged file, so a large file can be copied without holding it whole. */
  stagedMediaChunk(tenant: string, id: string, index: number): Buffer {
    this.stagedMediaManifest(tenant, id);
    const row = this.db
      .prepare('SELECT secret FROM media_chunks WHERE tenant_id=? AND id=? AND chunk_index=?')
      .get(tenant, id, index) as {secret: string | Uint8Array} | undefined;
    if (!row) throw new MirrorError('MEDIA_STAGING_INVALID', 'Encrypted media chunks are incomplete.');
    return this.openStagedChunk(tenant, id, index, row.secret);
  }
  /** The manifest of a completed staged file: its chunk count, size and SHA-256. */
  stagedMediaManifest(tenant: string, id: string): {chunks: number; size: number; sha256: string; bytes?: string} {
    const row = this.db
      .prepare('SELECT secret FROM media_staging WHERE tenant_id=? AND id=? AND expires_at>?')
      .get(tenant, id, Date.now()) as {secret: string | null} | undefined;
    if (!this.box || !row?.secret) throw new MirrorError('REVIEW_EXPIRED', 'The staged media expired or was removed.');
    return this.box.open(row.secret, scopeKey(tenant, 'media', id));
  }
  /**
   * Stages a whole file in bounded steps (OPS-01): any earlier manifest is withdrawn first, each 4 MiB chunk is written
   * in its own transaction, and the manifest is written last, so an interrupted staging is never readable as complete
   * and expiry erases what it left. Refuses with STORAGE_LOW before writing when the volume lacks room.
   */
  stageMedia(tenant: string, id: string, bytes: Buffer) {
    if (!this.box || bytes.length > MAX_MEDIA_BYTES)
      throw new MirrorError('MEDIA_STAGING_INVALID', 'Media exceeds the configured encrypted staging limit.');
    const live = () => {
      if (
        !this.db
          .prepare('SELECT expires_at FROM media_staging WHERE tenant_id=? AND id=? AND expires_at>?')
          .get(tenant, id, Date.now())
      )
        throw new MirrorError('REVIEW_EXPIRED', 'Media preparation expired.');
    };
    live();
    this.assertStorageCapacity(bytes.length);
    this.transaction(() => {
      live();
      this.db.prepare('UPDATE media_staging SET secret=NULL WHERE tenant_id=? AND id=?').run(tenant, id);
    });
    deleteRowsOneByOne(
      this.db,
      'media_chunks',
      'SELECT rowid AS r FROM media_chunks WHERE tenant_id=? AND id=? LIMIT 1',
      tenant,
      id,
    );
    let chunks = 0;
    for (let offset = 0; offset < bytes.length; offset += MEDIA_CHUNK_BYTES) {
      const index = chunks++,
        secret = this.sealStagedChunk(tenant, id, index, bytes.subarray(offset, offset + MEDIA_CHUNK_BYTES));
      this.transaction(() => {
        live();
        this.db.prepare('INSERT INTO media_chunks VALUES(?,?,?,?)').run(tenant, id, index, secret);
      });
    }
    this.transaction(() => {
      live();
      this.db
        .prepare('UPDATE media_staging SET secret=? WHERE tenant_id=? AND id=?')
        .run(
          this.box!.seal({chunks, size: bytes.length, sha256: sha256(bytes)}, scopeKey(tenant, 'media', id)),
          tenant,
          id,
        );
    });
  }
  stagedMedia(tenant: string, id: string): Buffer {
    const manifest = this.stagedMediaManifest(tenant, id);
    if (manifest.bytes) return Buffer.from(manifest.bytes, 'base64');
    if (!Number.isSafeInteger(manifest.size) || manifest.size < 0 || manifest.size > MAX_MEDIA_BYTES)
      throw new MirrorError('MEDIA_STAGING_INVALID', 'Invalid staged size.');
    const bytes = Buffer.alloc(manifest.size);
    let offset = 0,
      index = 0;
    for (const c of this.db
      .prepare('SELECT chunk_index,secret FROM media_chunks WHERE tenant_id=? AND id=? ORDER BY chunk_index')
      .iterate(tenant, id) as Iterable<JsonObject>) {
      if (c.chunk_index !== index)
        throw new MirrorError('MEDIA_STAGING_INVALID', 'Encrypted media chunk order is invalid.');
      const part = this.openStagedChunk(tenant, id, index++, c.secret);
      if (offset + part.length > bytes.length)
        throw new MirrorError('MEDIA_STAGING_INVALID', 'Encrypted chunks exceed the manifest.');
      part.copy(bytes, offset);
      offset += part.length;
    }
    if (index !== manifest.chunks || offset !== bytes.length)
      throw new MirrorError('MEDIA_STAGING_INVALID', 'Encrypted media chunks are incomplete.');
    if (bytes.length !== manifest.size || sha256(bytes) !== manifest.sha256)
      throw new MirrorError('MEDIA_STAGING_INVALID', 'Staged media integrity check failed.');
    return bytes;
  }
  /** Removes the manifest first, which makes the file unreadable at once, then erases its chunks one row at a time. */
  removeStagedMedia(tenant: string, id: string) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM media_staging WHERE tenant_id=? AND id=?').run(tenant, id);
      this.chunkSweepPending = true;
    });
  }
  transaction<T>(fn: () => T): T {
    if (fn.constructor.name === 'AsyncFunction')
      throw new MirrorError('ASYNC_TRANSACTION_UNSUPPORTED', 'SQLite transactions require synchronous callbacks.');
    const depth = this.transactionDepth,
      name = 'amcp_sp_' + depth;
    if (depth === 0) this.beginImmediate();
    else this.db.exec('SAVEPOINT ' + name);
    this.transactionDepth++;
    let result: T;
    try {
      result = fn();
      if (result && typeof (result as {then?: unknown}).then === 'function')
        throw new MirrorError('ASYNC_TRANSACTION_UNSUPPORTED', 'SQLite transactions require synchronous callbacks.');
      this.db.exec(depth === 0 ? 'COMMIT' : 'RELEASE SAVEPOINT ' + name);
    } catch (e) {
      // ROLLBACK TO preserves the savepoint; release it after undoing the inner work.
      if (this.db.isTransaction)
        this.db.exec(depth === 0 ? 'ROLLBACK' : 'ROLLBACK TO SAVEPOINT ' + name + '; RELEASE SAVEPOINT ' + name);
      throw e;
    } finally {
      this.transactionDepth = depth;
    }
    if (depth === 0 && this.chunkSweepPending)
      try {
        this.sweepMediaChunks();
      } catch {
        // The committed work stands; the chunks stay unreadable and the maintenance timer erases them.
      }
    return result;
  }
  /**
   * Starts the outermost transaction. SQLite already waits up to busy_timeout, but under sustained contention from
   * other processes a waiting writer can still see SQLITE_BUSY. Nothing has run when BEGIN fails, so retrying only the
   * BEGIN is safe for every kind of work; the retries stop at `beginBusyDeadlineMs` in total, with jittered pauses so
   * contending processes stop polling in step.
   */
  private beginImmediate() {
    const deadline = Date.now() + this.beginBusyDeadlineMs;
    let configured: number | undefined;
    try {
      for (;;) {
        try {
          this.db.exec('BEGIN IMMEDIATE');
          return;
        } catch (e) {
          if (sqliteDiagnostic(e)?.primary_code !== 5 || this.db.isTransaction || Date.now() >= deadline) throw e;
          this.beginBusyRetries = Math.min(Number.MAX_SAFE_INTEGER, this.beginBusyRetries + 1);
          configured ??= Number((this.db.prepare('PRAGMA busy_timeout').get() as {timeout: number}).timeout);
          Atomics.wait(busyPause, 0, 0, Math.max(1, Math.min(deadline - Date.now(), 10 + Math.random() * 40)));
          // Keep the total wait within the deadline: the next BEGIN may wait at most the time that remains.
          this.db.exec('PRAGMA busy_timeout=' + Math.max(1, Math.min(configured, deadline - Date.now())));
        }
      }
    } finally {
      if (configured !== undefined) this.db.exec('PRAGMA busy_timeout=' + configured);
    }
  }
  ensureTenant(id: string, name = id) {
    if (!id) throw new MirrorError('INVALID_TENANT', 'Tenant ID is required.');
    // Service documents live under reserved ids (ARC-02); a workspace of that id would read them as its own. A coded
    // refusal, since an id can come from an operator (tools/admin.ts) or a request rather than from the code.
    if (isServicePartition(id))
      throw new MirrorError(
        'INVALID_TENANT',
        'This workspace ID is reserved for AMCP service records. Choose another workspace ID.',
        {tenant_id: id},
      );
    this.db.prepare('INSERT INTO tenants(id,name) VALUES(?,?) ON CONFLICT(id) DO NOTHING').run(id, name);
  }
  createKey(actor: Actor, ttlMs: number = 86400000 * 30): string {
    // A key limited to a client access set keeps it for life (SEC-08); an administrator key is never limited.
    if (actor.accessSetId !== undefined && actor.role === 'admin')
      throw new MirrorError('INVALID_ROLE', 'A client access set limits reader or operator access only.');
    this.assertActorActive(actor);
    this.ensureTenant(actor.tenantId);
    const token = 'whm_' + randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
    this.transaction(() => {
      this.db
        .prepare('INSERT INTO api_keys(hash,tenant_id,user_id,role,expires_at,access_set_id) VALUES(?,?,?,?,?,?)')
        .run(sha256(token), actor.tenantId, actor.userId, actor.role, Date.now() + ttlMs, actor.accessSetId ?? null);
      if (actor.ownerUserId)
        this.db.prepare('INSERT INTO credential_owners VALUES(?,?)').run(sha256(token), actor.ownerUserId);
    });
    return token;
  }
  /**
   * A key created on the server (`admin create-key`, SEC-06): owned by the service, not by a person, so a member's
   * password, email or two-step change never revokes it. It needs server shell access to create, and owner health
   * lists the active ones. It acts exactly as before: no person account is checked for it.
   */
  createServiceKey(actor: Actor, ttlMs: number = 86400000 * 30, service = 'cli'): string {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(service)) throw new MirrorError('INVALID_ARGUMENT', 'Name a valid service.');
    const {ownerUserId: _owner, ...unowned} = actor;
    return this.transaction(() => {
      const token = this.createKey(unowned, ttlMs);
      this.db.prepare('INSERT INTO credential_owners VALUES(?,?)').run(sha256(token), serviceOwnerPrefix + service);
      return token;
    });
  }
  authenticate(token: string): Actor {
    const row = this.db
      .prepare('SELECT * FROM api_keys WHERE hash=? AND revoked=0 AND (expires_at IS NULL OR expires_at>?)')
      .get(sha256(token), Date.now()) as JsonObject | undefined;
    if (!row) throw new MirrorError('UNAUTHORIZED', 'A valid, unexpired API key is required.', {}, 401);
    const owner = this.db.prepare('SELECT user_id FROM credential_owners WHERE hash=?').get(sha256(token)) as
      JsonObject | undefined;
    // A service-owned key (createServiceKey) belongs to no person account.
    const person = owner && !String(owner.user_id).startsWith(serviceOwnerPrefix) ? owner.user_id : undefined;
    const actor: Actor = {
      tenantId: row.tenant_id,
      userId: row.user_id,
      role: row.role,
      ...(person ? {ownerUserId: person} : {}),
      ...(typeof row.access_set_id === 'string' ? {accessSetId: row.access_set_id} : {}),
    };
    this.authenticatedActors.set(actor, sha256(token));
    this.assertActorActive(actor);
    return actor;
  }
  /** A stable identity of the credential an actor authenticated with, derived from its hash; undefined for local actors. */
  sessionIdentity(actor: Actor): string | undefined {
    const hash = this.authenticatedActors.get(actor);
    return hash ? sha256('session:' + hash) : undefined;
  }
  /** HTTP actors retain a process-local credential identity without exposing the token or hash. */
  bindActorCheck(actor: Actor, check: () => void) {
    const previous = this.actorChecks.get(actor);
    this.actorChecks.set(
      actor,
      previous
        ? () => {
            previous();
            check();
          }
        : check,
    );
  }
  assertActorActive(actor: Actor): void {
    this.actorChecks.get(actor)?.();
    // A client access set limits reader and operator access only (SEC-08); an administrator is never limited by one.
    if (actor.accessSetId !== undefined && actor.role === 'admin')
      throw new MirrorError('MEMBERSHIP_REVOKED', 'Workspace access changed. Sign in again.', {}, 403);
    if (
      actor.userId === 'workspace-admin' &&
      this.db
        .prepare("SELECT 1 FROM documents WHERE tenant_id=? AND kind='account_settings' AND id='owner_migration'")
        .get(actor.tenantId)
    )
      throw new MirrorError(
        'OWNER_LOGIN_REQUIRED',
        'The administrator workspace was migrated. Sign in with the owner account and explicitly resume pending work.',
        {},
        401,
      );
    if (actor.ownerUserId) {
      const hasUsers = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='amcp_users'").get();
      const user = hasUsers
        ? (this.db.prepare('SELECT version,approved,disabled FROM amcp_users WHERE id=?').get(actor.ownerUserId) as
            JsonObject | undefined)
        : undefined;
      if (
        !user ||
        !user.approved ||
        user.disabled ||
        (actor.accountVersion !== undefined && user.version !== actor.accountVersion)
      )
        throw new MirrorError(
          'ACCOUNT_ACCESS_REVOKED',
          'Account access or security changed. Sign in again and explicitly resume this job or schedule.',
          {},
          401,
        );
    }
    if (actor.ownerUserId) {
      const membership = this.db
        .prepare('SELECT role FROM workspace_memberships WHERE tenant_id=? AND user_id=? AND active=1')
        .get(actor.tenantId, actor.ownerUserId) as JsonObject | undefined;
      const memberSet = membership ? memberAccessSetId(this, actor.tenantId, actor.ownerUserId) : undefined;
      const rank: Record<string, number> = {viewer: 0, reader: 0, operator: 1, admin: 2, owner: 2};
      // A member limited to a client access set (SEC-08) acts only within that set: a token or AI client the person
      // authorized before the limit, or for another set, stops at once instead of keeping wider access.
      if (
        !membership ||
        rank[membership.role]! < rank[actor.role]! ||
        (memberSet !== undefined && memberSet !== actor.accessSetId)
      )
        throw new MirrorError(
          'MEMBERSHIP_REVOKED',
          'Workspace access was removed or reduced. Sign in or authorize the connector again.',
          {},
          403,
        );
    }
    const hash = this.authenticatedActors.get(actor);
    if (!hash) return; // Trusted local/stdio actors have no bearer credential.
    const row = this.db
      .prepare(
        'SELECT tenant_id,user_id,role,access_set_id FROM api_keys WHERE hash=? AND revoked=0 AND (expires_at IS NULL OR expires_at>?)',
      )
      .get(hash, Date.now()) as JsonObject | undefined;
    if (
      !row ||
      row.tenant_id !== actor.tenantId ||
      row.user_id !== actor.userId ||
      row.role !== actor.role ||
      (row.access_set_id ?? undefined) !== actor.accessSetId
    )
      throw new MirrorError(
        'UNAUTHORIZED',
        'Connector access expired, changed or was revoked during this request.',
        {},
        401,
      );
  }
  revokeKey(token: string) {
    this.db.prepare('UPDATE api_keys SET revoked=1 WHERE hash=?').run(sha256(token));
  }
  bindJobActor(actor: Actor, id: string): string {
    this.assertActorActive(actor);
    if (!this.box) throw new MirrorError('ENCRYPTION_REQUIRED', 'Background verification requires encryption.');
    const bound = {...actor};
    if (bound.ownerUserId && bound.accountVersion === undefined)
      bound.accountVersion = Number(
        (this.db.prepare('SELECT version FROM amcp_users WHERE id=?').get(bound.ownerUserId) as JsonObject).version,
      );
    return this.box.seal(
      {version: 1, actor: bound, credential_hash: this.authenticatedActors.get(actor) ?? null},
      scopeKey(actor.tenantId, 'job-actor', id),
    );
  }
  acquireLock(key: string, owner: string, ttl = 45000): boolean {
    return this.transaction(() => {
      const now = Date.now();
      this.db.prepare('DELETE FROM service_locks WHERE key=? AND expires_at<=?').run(key, now);
      return (
        this.db
          .prepare('INSERT OR IGNORE INTO service_locks(key,owner,expires_at) VALUES(?,?,?)')
          .run(key, owner, now + ttl).changes === 1
      );
    });
  }
  releaseLock(key: string, owner: string) {
    this.db.prepare('DELETE FROM service_locks WHERE key=? AND owner=?').run(key, owner);
  }
  /** Every key or none, in one transaction, so two holders of overlapping key sets can never deadlock (WRT-04). */
  acquireLocks(keys: string[], owner: string, ttl: number): boolean {
    if (!keys.length) return true;
    return this.transaction(() => {
      const now = Date.now();
      for (const key of keys) this.db.prepare('DELETE FROM service_locks WHERE key=? AND expires_at<=?').run(key, now);
      if (keys.some(key => this.db.prepare('SELECT 1 FROM service_locks WHERE key=?').get(key))) return false;
      for (const key of keys)
        this.db.prepare('INSERT INTO service_locks(key,owner,expires_at) VALUES(?,?,?)').run(key, owner, now + ttl);
      return true;
    });
  }
  /** Extends every lock this owner still holds; false when another holder took one after it lapsed. */
  renewLocks(keys: string[], owner: string, ttl: number): boolean {
    if (!keys.length) return true;
    return this.transaction(() => {
      const until = Date.now() + ttl;
      return keys.every(
        key =>
          this.db.prepare('UPDATE service_locks SET expires_at=? WHERE key=? AND owner=?').run(until, key, owner)
            .changes === 1,
      );
    });
  }
  releaseLocks(keys: string[], owner: string) {
    if (!keys.length) return;
    this.transaction(() => {
      for (const key of keys) this.releaseLock(key, owner);
    });
  }
  renewLock(key: string, owner: string, ttl: number) {
    const now = Date.now();
    return (
      this.db
        .prepare('UPDATE service_locks SET expires_at=? WHERE key=? AND owner=? AND expires_at>?')
        .run(now + ttl, key, owner, now).changes === 1
    );
  }
  /** Issuer quota profiles and mode (OPS-08); read from the environment on first use, replaceable in tests. */
  quotaPolicy?: QuotaPolicy;
  // Shared across processes, so this bucket must use wall-clock time; never let a backward
  // clock correction subtract tokens. Refill pauses until the clock catches up, which is the safe direction.
  // The default budget is 30 burst and one token per 200 ms; a caller may size a smaller shared budget.
  // With an issuer (OPS-08), the workspace bucket and the issuer's daily counters are consumed in one transaction:
  // an enforced issuer refusal sends nothing and consumes neither.
  providerPermit(
    key: string,
    budget: {burst: number; refillMs: number} = {burst: 30, refillMs: 200},
    issuer?: IssuerPermit,
  ) {
    try {
      return this.providerPermitOnce(key, budget, issuer);
    } catch (e) {
      // A refusal is still counted for owner health, outside the rolled-back permit (best effort, never masking it).
      if (issuer && e instanceof MirrorError && e.code === 'PROVIDER_QUOTA_SHARE_EXHAUSTED')
        try {
          this.issuerCounter(issuer, 'refused');
        } catch {}
      throw e;
    }
  }
  private issuerCounter(
    issuer: Pick<IssuerPermit, 'issuer' | 'tenant' | 'gateway'>,
    column: 'refused' | 'rate_limits',
  ) {
    this.db
      .prepare(
        `INSERT INTO provider_issuer_usage(issuer,day,tenant_id,gateway,${column}) VALUES(?,?,?,?,1) ON CONFLICT(issuer,day,tenant_id,gateway) DO UPDATE SET ${column}=${column}+1`,
      )
      .run(issuer.issuer, quotaDay(), issuer.tenant, issuer.gateway);
  }
  /** One provider 429 against an issuer's daily counters (OPS-08). */
  providerIssuerRateLimit(issuer: Pick<IssuerPermit, 'issuer' | 'tenant' | 'gateway'>) {
    this.issuerCounter(issuer, 'rate_limits');
  }
  private issuerToday(issuer: string, day: string, tenant?: string): IssuerDay {
    return this.db
      .prepare(
        'SELECT coalesce(sum(requests),0) AS requests,coalesce(sum(reserved_requests),0) AS reserved_requests,coalesce(sum(operations),0) AS operations FROM provider_issuer_usage WHERE issuer=? AND day=?' +
          (tenant === undefined ? '' : ' AND tenant_id=?'),
      )
      .get(...(tenant === undefined ? [issuer, day] : [issuer, day, tenant])) as IssuerDay;
  }
  /**
   * Whether standard work for this connection would be refused right now by an enforced issuer profile (OPS-08): the
   * refusal scope, or null. Read-only and counts nothing; a report run asks before it starts, so a spent shared quota
   * defers the whole run instead of stopping it at its first request. Observe mode, no profile, a removed connection
   * or credentials that name no app give null, leaving every decision to the permit itself.
   */
  issuerAdmission(tenantId: string, connectionId: string, now = Date.now()) {
    const policy = (this.quotaPolicy ??= quotaPolicyFromEnv(process.env));
    if (policy.mode !== 'enforce') return null;
    const row = this.db
      .prepare('SELECT data FROM connections WHERE tenant_id=? AND id=?')
      .get(tenantId, connectionId) as {data: string} | undefined;
    const gateway = row ? (JSON.parse(row.data) as Connection).gateway : undefined,
      profile = gateway ? policy.profiles[gateway] : undefined;
    if (!gateway || !profile) return null;
    let issuer: string | null;
    try {
      issuer = issuerKey(gateway, this.credentials(tenantId, connectionId));
    } catch {
      return null;
    }
    if (!issuer) return null;
    const day = quotaDay(now);
    return quotaRefusal(
      profile,
      {purpose: 'standard'},
      this.issuerToday(issuer, day),
      this.issuerToday(issuer, day, tenantId),
    );
  }
  private providerPermitOnce(key: string, budget: {burst: number; refillMs: number}, issuer?: IssuerPermit) {
    return this.transaction(() => {
      const now = Date.now(),
        cooldown = this.db.prepare('SELECT until_at FROM provider_cooldowns WHERE key=?').get(key) as
          JsonObject | undefined;
      if (cooldown?.until_at > now)
        throw new MirrorError(
          'PLATFORM_RATE_LIMIT',
          'The shared provider cooldown is active.',
          {retry_after_ms: cooldown!.until_at - now},
          429,
          true,
        );
      const record = this.db
          .prepare(`SELECT data FROM documents WHERE tenant_id='${serviceLimits}' AND kind='provider_budget' AND id=?`)
          .get(sha256(key)) as JsonObject | undefined,
        old = record ? JSON.parse(record.data) : {tokens: budget.burst, at: now},
        tokens = Math.min(budget.burst, old.tokens + Math.max(0, now - old.at) / budget.refillMs);
      if (tokens < 1)
        throw new MirrorError(
          'TENANT_RATE_LIMIT',
          'The shared platform request budget is exhausted.',
          {retry_after_ms: Math.ceil((1 - tokens) * budget.refillMs)},
          429,
          true,
        );
      if (issuer) {
        const policy = (this.quotaPolicy ??= quotaPolicyFromEnv(process.env)),
          profile = policy.profiles[issuer.gateway],
          day = quotaDay(now),
          refusal = profile
            ? quotaRefusal(
                profile,
                issuer,
                this.issuerToday(issuer.issuer, day),
                this.issuerToday(issuer.issuer, day, issuer.tenant),
              )
            : null;
        if (refusal && policy.mode === 'enforce') throw quotaExhausted(refusal, now);
        this.db
          .prepare(
            'INSERT INTO provider_issuer_usage(issuer,day,tenant_id,gateway,requests,reserved_requests,operations,would_refuse) VALUES(?,?,?,?,1,?,?,?) ON CONFLICT(issuer,day,tenant_id,gateway) DO UPDATE SET requests=requests+1,reserved_requests=reserved_requests+excluded.reserved_requests,operations=operations+excluded.operations,would_refuse=would_refuse+excluded.would_refuse',
          )
          .run(
            issuer.issuer,
            day,
            issuer.tenant,
            issuer.gateway,
            issuer.purpose === 'reserved' ? 1 : 0,
            Math.max(1, Math.floor(issuer.operations)),
            refusal ? 1 : 0,
          );
      }
      this.putDocument(serviceLimits, 'provider_budget', sha256(key), {
        tokens: tokens - 1,
        at: Math.max(now, old.at),
      });
    });
  }
  assertProviderCooldown(key: string) {
    const row = this.db.prepare('SELECT until_at FROM provider_cooldowns WHERE key=?').get(key) as
      JsonObject | undefined;
    if (row && row.until_at > Date.now())
      throw new MirrorError(
        'PLATFORM_RATE_LIMIT',
        'The shared provider cooldown is active.',
        {retry_after_ms: row.until_at - Date.now()},
        429,
        true,
      );
  }
  providerCooldown(key: string, milliseconds: number) {
    const until = Date.now() + Math.max(1000, Math.min(86400000, milliseconds));
    this.db
      .prepare(
        'INSERT INTO provider_cooldowns VALUES(?,?) ON CONFLICT(key) DO UPDATE SET until_at=max(until_at,excluded.until_at)',
      )
      .run(key, until);
  }
  retryJob(id: string, leaseToken: string, error: unknown, delayMs: number) {
    const now = Date.now(),
      r = this.db
        .prepare(
          "UPDATE jobs SET state='queued',error=?,available_at=?,lease_until=NULL,lease_token=NULL,updated_at=? WHERE id=? AND state='running' AND lease_token=? AND lease_until>?",
        )
        .run(
          JSON.stringify(redact(error)),
          now + (Number.isFinite(delayMs) ? Math.max(1000, Math.min(86400000, delayMs)) : 30000),
          now,
          id,
          leaseToken,
          now,
        );
    if (!r.changes) throw new MirrorError('STALE_JOB_LEASE', 'This worker no longer owns the job lease.', {}, 409);
  }
  restoreJobActor(tenant: string, id: string, binding: string): Actor {
    if (typeof binding !== 'string' || !binding)
      throw new MirrorError(
        'JOB_REAUTHORIZATION_REQUIRED',
        'This job has no verified creator. An authorized member must explicitly resume it.',
        {},
        403,
      );
    if (!this.box) throw new MirrorError('ENCRYPTION_REQUIRED', 'Background verification requires encryption.');
    const value = this.box.open<{version?: number; actor: Actor; credential_hash: string | null}>(
        binding,
        scopeKey(tenant, 'job-actor', id),
      ),
      actor = value.actor;
    if (value.version !== undefined && value.version !== 1)
      throw new MirrorError(
        'JOB_REAUTHORIZATION_REQUIRED',
        'This job authority version is unsupported. Explicitly resume it with the current application.',
        {},
        403,
      );
    if (actor.tenantId !== tenant) throw new MirrorError('FORBIDDEN', 'Invalid job tenant.');
    if (value.credential_hash) this.authenticatedActors.set(actor, value.credential_hash);
    this.assertActorActive(actor);
    return actor;
  }
  /**
   * Provision a login: a new connection, a reauthorization or an administrator re-provisioning. The store assigns the
   * login revision (CON-01): a new row starts at 0 with a fresh login id, and replacing an existing row's credentials
   * or gateway bumps it, so in-flight requests bound to the previous login refuse. Writing back the stored credentials
   * keeps the revision; metadata-only changes use `updateConnection`, which never touches the credentials.
   */
  putConnection(actor: Actor, connection: Connection, credentials: Credentials): void {
    this.assertConnectionShape(actor, connection);
    this.transaction(() => {
      this.ensureTenant(actor.tenantId);
      const row = this.db
          .prepare('SELECT data, secret FROM connections WHERE tenant_id=? AND id=?')
          .get(connection.tenantId, connection.id) as {data: string; secret: string} | undefined,
        previous = row ? (JSON.parse(row.data) as Connection) : undefined,
        revision = !previous
          ? 0
          : loginRevision(previous) +
            (previous.gateway === connection.gateway && this.storedSecretEquals(row!, connection, credentials) ? 0 : 1),
        stored = withLogin(connection, revision, previous ? previous.loginId : randomUUID()),
        secret =
          'v2:' +
          this.box!.seal(this.storable(connection.gateway, credentials), scopeKey(connection.tenantId, connection.id));
      this.db
        .prepare(
          'INSERT INTO connections(id,tenant_id,data,secret) VALUES(?,?,?,?) ON CONFLICT(tenant_id,id) DO UPDATE SET data=excluded.data,secret=excluded.secret',
        )
        .run(connection.id, connection.tenantId, JSON.stringify(stored), secret);
      this.db
        .prepare('DELETE FROM resource_ownership WHERE tenant_id=? AND connection_id=?')
        .run(connection.tenantId, connection.id);
      this.invalidateReadiness(connection.tenantId, connection.id);
    });
  }
  /**
   * Change a connection's metadata (selection, write grants, label, default) without touching its credentials or
   * login revision, so a concurrent token refresh is neither overwritten nor reported as a login change.
   */
  updateConnection(actor: Actor, connection: Connection): void {
    this.assertConnectionShape(actor, connection);
    this.transaction(() => {
      const row = this.db
        .prepare('SELECT data FROM connections WHERE tenant_id=? AND id=?')
        .get(connection.tenantId, connection.id) as {data: string} | undefined;
      if (!row) throw new MirrorError('CONNECTION_REQUIRED', 'Connection was removed.', {}, 403);
      const previous = JSON.parse(row.data) as Connection;
      if (previous.gateway !== connection.gateway)
        throw new MirrorError(
          'CONNECTION_CHANGED',
          'The selected connection changed. Resolve the current login before retrying.',
          {connection_id: connection.id},
          409,
        );
      const stored = withLogin(connection, loginRevision(previous), previous.loginId);
      this.db
        .prepare('UPDATE connections SET data=? WHERE tenant_id=? AND id=?')
        .run(JSON.stringify(stored), connection.tenantId, connection.id);
      this.db
        .prepare('DELETE FROM resource_ownership WHERE tenant_id=? AND connection_id=?')
        .run(connection.tenantId, connection.id);
      this.invalidateReadiness(connection.tenantId, connection.id);
    });
  }
  /** Whether a row already holds exactly these credentials; an unreadable secret counts as different. The deployment's
   * app secrets are not part of a login (SEC-07 S2), so a copy held or left out never makes two logins differ. */
  private storedSecretEquals(row: {secret: string}, connection: Connection, credentials: Credentials) {
    try {
      const current = row.secret.startsWith('v2:')
        ? this.box!.open<Credentials>(row.secret.slice(3), scopeKey(connection.tenantId, connection.id))
        : this.box!.open<Credentials>(row.secret, connection.tenantId + '/' + connection.id);
      return (
        stable(this.storable(connection.gateway, current)) === stable(this.storable(connection.gateway, credentials))
      );
    } catch {
      return false;
    }
  }
  /**
   * The deployment environment app secrets are read from when a login is used (SEC-07 S2): the HTTP server and the
   * worker set it. Unset (tests, tools), a login is used and stored exactly as given.
   */
  appEnvironment?: NodeJS.ProcessEnv;
  /** What is sealed for a login: without copies of the app secrets the deployment supplies (src/app-credentials.ts). */
  private storable(gateway: string, credentials: Credentials): Credentials {
    return storableCredentials(gateway, credentials, this.appEnvironment);
  }
  private assertConnectionShape(actor: Actor, connection: Connection) {
    if (actor.role !== 'admin' || actor.tenantId !== connection.tenantId)
      throw new MirrorError('FORBIDDEN', 'Only a tenant administrator can provision a connection.', {}, 403);
    // A login as a client access set shows it (SEC-08) holds only that set's accounts: storing it would remove every
    // other account and grant from the login. Read the login with listConnections before changing it.
    if (isNarrowedConnection(connection))
      throw new MirrorError(
        'CONNECTION_CHANGED',
        'This connection was read through a client access set and cannot be saved from that view. Reload it as a workspace administrator.',
        {connection_id: connection.id},
        409,
      );
    if (!this.box)
      throw new MirrorError('ENCRYPTION_REQUIRED', 'Configure MIRROR_MASTER_KEY before storing credentials.', {}, 503);
    if (
      (connection.enabled && !connection.accounts.length) ||
      connection.accounts.some(x => typeof x !== 'string' || !x)
    )
      throw new MirrorError(
        'INVALID_ACCOUNT_BINDING',
        'Enabled connections require explicit nonempty account bindings.',
      );
    if (
      connection.writeAccounts !== undefined &&
      (!Array.isArray(connection.writeAccounts) ||
        connection.writeAccounts.some(id => typeof id !== 'string' || !connection.accounts.includes(id)))
    )
      throw new MirrorError('INVALID_WRITE_BINDING', 'Write grants must be a subset of the connection account grants.');
    if (
      connection.accountCustomers !== undefined &&
      (typeof connection.accountCustomers !== 'object' ||
        Array.isArray(connection.accountCustomers) ||
        Object.entries(connection.accountCustomers).some(
          ([id, v]) => !connection.accounts.includes(id) || typeof v !== 'string' || !/^[1-9][0-9]*$/.test(v),
        ))
    )
      throw new MirrorError(
        'INVALID_ACCOUNT_BINDING',
        'Microsoft parent customers must map selected accounts to decimal identifiers.',
      );
    if (
      connection.accountLoginCustomers !== undefined &&
      (!connection.accountLoginCustomers ||
        connection.gateway !== 'google_ads_native_action' ||
        typeof connection.accountLoginCustomers !== 'object' ||
        Array.isArray(connection.accountLoginCustomers) ||
        Object.entries(connection.accountLoginCustomers).some(
          ([id, v]) => !connection.accounts.includes(id) || typeof v !== 'string' || !/^\d+$/.test(v),
        ))
    )
      throw new MirrorError(
        'INVALID_ACCOUNT_BINDING',
        'Google login customers must map selected accounts to decimal identifiers.',
      );
    for (const binding of connection.resourceBindings ?? [])
      if (
        !connection.accounts.includes(binding.accountId) ||
        !/^\/[a-zA-Z0-9]/.test(binding.pathPrefix) ||
        binding.pathPrefix.endsWith('/') ||
        /[?%#\\]|\/\.\.?($|\/)/.test(binding.pathPrefix)
      )
        throw new MirrorError(
          'INVALID_RESOURCE_BINDING',
          'Resource bindings require an exact safe path prefix and a configured account.',
        );
  }
  /** Every login of a workspace. For what a person or credential may reach, use connectionsFor(actor). */
  listConnections(tenantId: string): Connection[] {
    return (this.db.prepare('SELECT data FROM connections WHERE tenant_id=?').all(tenantId) as {data: string}[]).map(
      x => JSON.parse(x.data),
    );
  }
  /**
   * The logins this actor may reach (SEC-08): the whole workspace, or for an actor limited to a client access set, each
   * bound login narrowed to its bound accounts (src/access-sets.ts). Every listing and resolution of accounts for an
   * actor goes through here, so a set is enforced in one place. A removed set reaches nothing.
   */
  connectionsFor(actor: Actor): Connection[] {
    return this.connectionsWithin(actor.tenantId, actor.accessSetId);
  }
  /**
   * The logins of a workspace as a client access set narrows them, or every login without one. A login read through a
   * set remembers it (narrowedAccessSetId), so a refusal about that login lists only the same set's logins.
   */
  connectionsWithin(tenantId: string, accessSetId?: string): Connection[] {
    const all = this.listConnections(tenantId);
    if (accessSetId === undefined) return all;
    return narrowConnections(all, this.accessSetBindings(tenantId, accessSetId), accessSetId);
  }
  /** The bindings of a client access set; none when the set was removed. */
  private accessSetBindings(tenantId: string, accessSetId: string): AccessBinding[] {
    const row = this.db
      .prepare('SELECT data FROM documents WHERE tenant_id=? AND kind=? AND id=?')
      .get(tenantId, accessSetKind, accessSetId) as {data: string} | undefined;
    return row ? setBindings(JSON.parse(row.data)) : [];
  }
  /** Decrypt a login. The result remembers its login revision (read atomically with it) for authority fences. */
  credentials(tenantId: string, id: string): Credentials {
    const row = this.db.prepare('SELECT data, secret FROM connections WHERE tenant_id=? AND id=?').get(tenantId, id) as
      {data: string; secret: string} | undefined;
    if (!row || !this.box)
      throw new MirrorError('CONNECTION_REQUIRED', 'Connection credentials are unavailable for this tenant.', {}, 403);
    const data = JSON.parse(row.data) as Connection,
      login = {
        tenant: tenantId,
        connection: id,
        gateway: data.gateway,
        revision: loginRevision(data),
        login: data.loginId ?? null,
      };
    // A login is used with the deployment's current app secrets of its own client (SEC-07 S2).
    if (row.secret.startsWith('v2:'))
      return recordLogin(
        withAppSecrets(
          data.gateway,
          this.box.open<Credentials>(row.secret.slice(3), scopeKey(tenantId, id)),
          this.appEnvironment,
        ),
        login,
      );
    // Legacy delimiter encoding is migratable only when both components lack that delimiter.
    if (tenantId.includes('/') || id.includes('/'))
      throw new MirrorError(
        'REAUTHORIZATION_REQUIRED',
        'Re-provision this legacy connection to establish an unambiguous encryption scope.',
        {},
        401,
      );
    const value = this.box.open<Credentials>(row.secret, tenantId + '/' + id);
    this.sealCredentials(tenantId, id, value, 'reseal');
    return recordLogin(withAppSecrets(data.gateway, value, this.appEnvironment), login);
  }
  /**
   * Replace a connection's credentials directly. Different credentials are a different login (CON-01): the login
   * revision is bumped so in-flight requests bound to the previous login refuse. Only AMCP's own token refresh
   * (`completeCredentialRefresh`) keeps the revision.
   */
  replaceCredentials(tenantId: string, id: string, value: Credentials) {
    this.sealCredentials(tenantId, id, value, 'replace');
  }
  /**
   * Every credential write after provisioning. `refresh` and `reseal` keep the login revision (the same login with a
   * renewed token, or the same bytes re-encrypted); `replace` bumps it unless the bytes are unchanged. A refresh keeps
   * readiness evidence, which is bound to the login rather than its token.
   */
  private sealCredentials(tenantId: string, id: string, value: Credentials, mode: 'refresh' | 'reseal' | 'replace') {
    if (!this.box) throw new MirrorError('ENCRYPTION_REQUIRED', 'Credential encryption unavailable.');
    this.transaction(() => {
      const row = this.db
        .prepare('SELECT data, secret FROM connections WHERE tenant_id=? AND id=?')
        .get(tenantId, id) as {data: string; secret: string} | undefined;
      if (!row) throw new MirrorError('CONNECTION_REQUIRED', 'Connection was removed.');
      const data = JSON.parse(row.data) as Connection,
        bump = mode === 'replace' && !this.storedSecretEquals(row, data, value);
      this.db
        .prepare('UPDATE connections SET secret=?, data=? WHERE tenant_id=? AND id=?')
        .run(
          'v2:' + this.box!.seal(this.storable(data.gateway, value), scopeKey(tenantId, id)),
          JSON.stringify(bump ? withLogin(data, loginRevision(data) + 1, data.loginId) : data),
          tenantId,
          id,
        );
      if (mode !== 'refresh') this.invalidateReadiness(tenantId, id);
      if (bump)
        this.db.prepare('DELETE FROM resource_ownership WHERE tenant_id=? AND connection_id=?').run(tenantId, id);
    });
  }
  private invalidateReadiness(tenantId: string, connectionId: string) {
    this.db
      .prepare(
        "DELETE FROM documents WHERE tenant_id=? AND kind='readiness' AND json_extract(data,'$.connection_id')=?",
      )
      .run(tenantId, connectionId);
  }
  /** Read the current login without sending another gateway's credentials to a stale caller. */
  connectionCredentials(connection: Connection): Credentials {
    return this.transaction(() => {
      const row = this.db
        .prepare('SELECT data FROM connections WHERE tenant_id=? AND id=?')
        .get(connection.tenantId, connection.id) as {data: string} | undefined;
      if (!row) throw new MirrorError('CONNECTION_REQUIRED', 'Connection was removed.', {}, 403);
      if (JSON.parse(row.data).gateway !== connection.gateway)
        throw new MirrorError(
          'CONNECTION_CHANGED',
          'The selected connection changed. Resolve the current login before retrying.',
          {connection_id: connection.id},
          409,
        );
      return this.credentials(connection.tenantId, connection.id);
    });
  }
  /**
   * Fence a refresh by the login actually used, not randomized encryption or mutable account grants. The refreshed
   * credentials keep the login revision (CON-01), so requests bound to this login continue.
   */
  completeCredentialRefresh(connection: Connection, previous: Credentials, next: Credentials): void {
    this.transaction(() => {
      const current = this.connectionCredentials(connection);
      if (stable(current) !== stable(previous))
        throw new MirrorError(
          'CONNECTION_CHANGED',
          'The selected login changed while refreshing. Its newer credentials were preserved.',
          {connection_id: connection.id},
          409,
        );
      this.sealCredentials(connection.tenantId, connection.id, next, 'refresh');
    });
  }
  rememberResource(connection: Connection, accountId: string, resource: string, ttlMs = 300000) {
    this.db
      .prepare(
        'INSERT INTO resource_ownership VALUES(?,?,?,?,?) ON CONFLICT(tenant_id,connection_id,account_id,resource) DO UPDATE SET expires_at=excluded.expires_at',
      )
      .run(connection.tenantId, connection.id, accountId, resource, Date.now() + Math.min(ttlMs, 300000));
  }
  /** True when this connection observed the resource in the account's list and that observation has since expired;
   * false when it never did, or when re-provisioning cleared its observations. */
  ownershipLapsed(connection: Connection, accountId: string, resource: string): boolean {
    return !!this.db
      .prepare(
        'SELECT 1 FROM resource_ownership WHERE tenant_id=? AND connection_id=? AND account_id=? AND resource=? AND expires_at<=?',
      )
      .get(connection.tenantId, connection.id, accountId, resource, Date.now());
  }
  ownsResource(connection: Connection, accountId: string, resource: string): boolean {
    return !!this.db
      .prepare(
        'SELECT 1 FROM resource_ownership WHERE tenant_id=? AND connection_id=? AND account_id=? AND resource=? AND expires_at>?',
      )
      .get(connection.tenantId, connection.id, accountId, resource, Date.now());
  }
  resolveConnection(actor: Actor, gateway: string, accountId?: string, connectionId?: string): Connection {
    this.assertActorActive(actor);
    const normalize = (id: string) =>
      gateway === 'google_ads_native_action'
        ? id.replaceAll('-', '')
        : gateway === 'meta_native_action'
          ? id.replace(/^act_/, '')
          : id;
    const available = this.connectionsFor(actor).filter(
      c =>
        c.enabled &&
        c.gateway === gateway &&
        (!connectionId || c.id === connectionId) &&
        (!accountId || c.accounts.some(a => normalize(a) === normalize(accountId))),
    );
    // Outside a client access set, whether the account exists in the workspace stays unsaid (SEC-08).
    if (!available.length && actor.accessSetId !== undefined)
      throw accountScopeRestricted(actor.accessSetId, {gateway, account_id: accountId ?? null});
    if (!available.length)
      throw new MirrorError(
        'CONNECTION_REQUIRED',
        'No authorized connection is configured for this gateway/account.',
        {gateway, account_id: accountId ?? null},
        403,
      );
    if (available.length !== 1) {
      const defaults = available.filter(c => c.isDefault === true);
      if (!connectionId && defaults.length === 1) return defaults[0]!;
      // The connections to choose from, and the read that lists them with their accounts (MCP-09). Labels are written
      // by workspace members, so the error marks them untrusted (errorResult).
      const platform = /^(meta|tiktok|snapchat|reddit|linkedin|dv360|criteo|google_ads|x_ads)_native_action$/
        .exec(gateway)?.[1]
        ?.replace(/^google_ads$/, 'google')
        .replace(/^x_ads$/, 'x');
      // Each candidate also says whether it selects the account and may change it (CON-05), so a caller can choose
      // without another read. A login whose default flag is set but which is disabled is never a candidate.
      const writes = (c: Connection) =>
        accountId
          ? (c.writeAccounts ?? []).some(a => normalize(a) === normalize(accountId))
          : (c.writeAccounts ?? []).length > 0;
      throw new MirrorError('AMBIGUOUS_CONNECTION', 'Specify a connection_id to select one connection.', {
        gateway,
        account_id: accountId ?? null,
        candidates: available.slice(0, 20).map(c => ({
          connection_id: c.id,
          label: c.label,
          is_default: c.isDefault === true,
          account_selected: accountId ? true : c.accounts.length > 0,
          write_enabled: writes(c),
        })),
        ...(available.length > 20 ? {candidates_truncated: true} : {}),
        next_call: {
          tool: 'amcp_platform_workspace',
          arguments: {operation: 'list_accounts', arguments: platform ? {platform} : {}},
        },
      });
    }
    return available[0]!;
  }
  appendAudit(tenantId: string, requestId: string, event: unknown) {
    const payload = stable(redact(event));
    this.transaction(() => {
      const prev = this.db.prepare('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1').get() as
        {hash: string} | undefined;
      const previous = prev?.hash ?? 'GENESIS';
      const at = Date.now();
      const hash = sha256(stable({tenantId, requestId, payload, previous, at}));
      this.db
        .prepare('INSERT INTO audit(tenant_id,request_id,event,previous_hash,hash,created_at) VALUES(?,?,?,?,?,?)')
        .run(tenantId, requestId, payload, previous, hash, at);
    });
  }
  audit(tenantId: string, limit = 100, after = 0) {
    return this.db
      .prepare('SELECT * FROM audit WHERE tenant_id=? AND seq>? ORDER BY seq LIMIT ?')
      .all(tenantId, after, Math.min(1000, Math.max(1, limit)));
  }
  // The activity feed needs the latest rows; forward audit cursors retain their existing ordering.
  recentAudit(tenantId: string, limit = 100) {
    return this.db
      .prepare('SELECT * FROM audit WHERE tenant_id=? ORDER BY seq DESC LIMIT ?')
      .all(tenantId, Math.min(1000, Math.max(1, limit)));
  }
  /**
   * Checks the one hash chain across all workspaces. A record an erasure tombstoned (SEC-07 S4) keeps its link: its
   * previous hash must be the record before it, and its own hash links the next. Its payload is no longer verifiable,
   * so every tombstone must be accounted for by a later, verified `account_erased` record of its erasure that names
   * how many records it tombstoned and the digest of their sequence numbers and hashes.
   */
  verifyAudit() {
    let previous = 'GENESIS';
    const erased = new Map<string, string[]>();
    for (const row of this.db.prepare('SELECT * FROM audit ORDER BY seq').iterate() as Iterable<JsonObject>) {
      const erasure = tombstoneErasure(row);
      if (erasure !== undefined) {
        if (row.previous_hash !== previous || typeof row.hash !== 'string') return false;
        const records = erased.get(erasure) ?? [];
        records.push(row.seq + ':' + row.hash);
        erased.set(erasure, records);
        previous = row.hash;
        continue;
      }
      const hash = sha256(
        stable({tenantId: row.tenant_id, requestId: row.request_id, payload: row.event, previous, at: row.created_at}),
      );
      if (row.previous_hash !== previous || row.hash !== hash) return false;
      if (String(row.event).includes('"account_erased"')) {
        let receipt: JsonObject = {};
        try {
          receipt = JSON.parse(row.event);
        } catch {
          /* Not a receipt. */
        }
        if (receipt?.event === 'account_erased' && typeof receipt.erasure === 'string') {
          const records = erased.get(receipt.erasure) ?? [];
          if (records.length !== receipt.tombstoned_rows || sha256(records.join('\n')) !== receipt.tombstone_digest)
            return false;
          erased.delete(receipt.erasure);
        }
      }
      previous = hash;
    }
    return erased.size === 0;
  }
  /**
   * Replaces the payload of every audit record of one workspace by the tombstone of `erasure` (SEC-07 S4). Returns
   * what the erasure's `account_erased` record must state for verifyAudit: the count and the digest of the records.
   * Call it inside the transaction that appends that record.
   */
  tombstoneAudit(tenant: string, erasure: string): {tombstoned_rows: number; tombstone_digest: string} {
    return this.transaction(() => {
      const tombstone = auditTombstone(erasure),
        rows = (
          this.db
            .prepare('SELECT seq,request_id,event,hash FROM audit WHERE tenant_id=? ORDER BY seq')
            .all(tenant) as JsonObject[]
        ).filter(row => tombstoneErasure(row) === undefined),
        update = this.db.prepare("UPDATE audit SET event=?,request_id='' WHERE seq=?");
      for (const row of rows) update.run(tombstone, row.seq);
      return {
        tombstoned_rows: rows.length,
        tombstone_digest: sha256(rows.map(row => row.seq + ':' + row.hash).join('\n')),
      };
    });
  }
  claim(tenantId: string, key: string, fingerprint: string): {fresh: boolean; result?: unknown} {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM idempotency WHERE tenant_id=? AND key=?').get(tenantId, key) as
        JsonObject | undefined;
      if (row) {
        if (row.fingerprint !== fingerprint)
          throw new MirrorError('IDEMPOTENCY_CONFLICT', 'The same key was used for a different request.', {}, 409);
        if (row.state === 'complete') return {fresh: false, result: JSON.parse(row.result)};
        // A rejected key (CMP-04) applied nothing and is never sent again: the request is corrected under a new review.
        if (row.state === 'rejected')
          throw new MirrorError(
            'WRITE_REJECTED',
            'The provider refused this request without applying it, so this key is never sent again. Correct the request and prepare a new review.',
            {submission: 'rejected', key_retired: true},
            409,
          );
        throw new MirrorError(
          'WRITE_OUTCOME_UNCERTAIN',
          'This key is pending or has an uncertain outcome. Read back the platform state before resolving it.',
          {},
          409,
        );
      }
      this.db
        .prepare("INSERT INTO idempotency(tenant_id,key,fingerprint,state,created_at) VALUES(?,?,?,'pending',?)")
        .run(tenantId, key, fingerprint, Date.now());
      this.journal(tenantId, key, 'claimed');
      return {fresh: true};
    });
  }
  complete(tenantId: string, key: string, result: unknown, details: JsonObject = {}) {
    this.transaction(() => {
      this.db
        .prepare("UPDATE idempotency SET state='complete',result=? WHERE tenant_id=? AND key=?")
        .run(JSON.stringify(redact(result)), tenantId, key);
      this.journal(tenantId, key, 'responded', details);
    });
  }
  uncertain(tenantId: string, key: string) {
    this.transaction(() => {
      this.db.prepare("UPDATE idempotency SET state='uncertain' WHERE tenant_id=? AND key=?").run(tenantId, key);
      this.journal(tenantId, key, 'uncertain');
    });
  }
  /**
   * A refusal raised before any provider request (WRT-04, owner decision D12): one transaction removes this pending
   * claim and the daily spend reservations its review took (an Apple shared budget reserves `<key>:<account>` per
   * account), journals not_sent and audits write_not_sent. Only a pending claim with this fingerprint is released; a
   * completed or uncertain one is never reset. Returns whether the claim was released.
   */
  release(tenantId: string, key: string, fingerprint: string, audit: JsonObject = {}): boolean {
    return this.transaction(() => {
      const released =
        this.db
          .prepare("DELETE FROM idempotency WHERE tenant_id=? AND key=? AND state='pending' AND fingerprint=?")
          .run(tenantId, key, fingerprint).changes === 1;
      if (!released) return false;
      this.db
        .prepare("DELETE FROM documents WHERE tenant_id=? AND kind='spend_reservation' AND (id=? OR substr(id,1,?)=?)")
        .run(tenantId, key, key.length + 1, key + ':');
      this.journal(tenantId, key, 'not_sent', typeof audit.code === 'string' ? {code: audit.code} : {});
      this.appendAudit(tenantId, key, {...audit, event: 'write_not_sent'});
      return true;
    });
  }
  /**
   * A definitive provider refusal that a family proves applied nothing (CMP-04): one transaction marks this pending claim
   * rejected (its key is kept and never reused), releases the daily spend reservations its review took (owner decision
   * D12: released only for families with a declared non-applied proof), journals rejected and audits write_rejected.
   * Only a pending claim with this fingerprint changes. Returns whether it did.
   */
  rejected(tenantId: string, key: string, fingerprint: string, audit: JsonObject = {}): boolean {
    return this.transaction(() => {
      const marked =
        this.db
          .prepare(
            "UPDATE idempotency SET state='rejected' WHERE tenant_id=? AND key=? AND state='pending' AND fingerprint=?",
          )
          .run(tenantId, key, fingerprint).changes === 1;
      if (!marked) return false;
      this.db
        .prepare("DELETE FROM documents WHERE tenant_id=? AND kind='spend_reservation' AND (id=? OR substr(id,1,?)=?)")
        .run(tenantId, key, key.length + 1, key + ':');
      this.journal(
        tenantId,
        key,
        'rejected',
        typeof audit.http_status === 'number' ? {http_status: audit.http_status} : {},
      );
      this.appendAudit(tenantId, key, {...audit, event: 'write_rejected'});
      return true;
    });
  }
  putDocument(tenantId: string, kind: string, id: string, data: unknown, expectedRevision?: number) {
    return this.transaction(() => {
      const old = this.db
        .prepare('SELECT revision FROM documents WHERE tenant_id=? AND kind=? AND id=?')
        .get(tenantId, kind, id) as {revision: number} | undefined;
      // An expected revision of 0 means the document must not exist yet.
      if (expectedRevision !== undefined && (old?.revision ?? 0) !== expectedRevision)
        throw new MirrorError('REVISION_CONFLICT', 'The document changed since it was read.', {}, 409);
      const revision = (old?.revision ?? 0) + 1;
      this.db
        .prepare(
          'INSERT INTO documents(tenant_id,kind,id,data,revision) VALUES(?,?,?,?,?) ON CONFLICT(tenant_id,kind,id) DO UPDATE SET data=excluded.data,revision=excluded.revision',
        )
        .run(tenantId, kind, id, JSON.stringify(data), revision);
      return {id, revision};
    });
  }
  deleteDocument(tenantId: string, kind: string, id: string) {
    this.db.prepare('DELETE FROM documents WHERE tenant_id=? AND kind=? AND id=?').run(tenantId, kind, id);
  }
  /**
   * The documents of one workspace kind in one workspace (ARC-02): every statement is bound to the workspace and the
   * kind (src/document-kinds.ts), so a read, change or deletion through it cannot reach another workspace.
   */
  repo<K extends TenantDocumentKind>(kind: K, tenant: string): DocumentRepository<K> {
    return new DocumentRepository(this, kind, {tenant});
  }
  /** The documents of one service kind (limits, heartbeats, cursors, the volume marker), in its reserved partition. */
  serviceRepo<K extends ServiceDocumentKind>(kind: K): DocumentRepository<K> {
    return new DocumentRepository(this, kind, {service: true});
  }
  /**
   * The database handle, for the store layer only: this module, src/schema-migrations.ts, src/document-kinds.ts, the
   * repositories (src/document-repository.ts, src/*-repository.ts) and server/web-store.ts. Every other module's use of
   * it (or of `db`) is counted by tools/check-storage-boundary.mjs, and the count may only fall.
   */
  sql(): DatabaseSync {
    return this.db;
  }
  /** Seals a value for a document field that only this tenant, purpose and id can open again. */
  sealValue(tenant: string, purpose: string, id: string, value: JsonObject): string {
    if (!this.box)
      throw new MirrorError('ENCRYPTION_REQUIRED', 'Encrypted storage requires the configured master key.');
    return this.box.seal(value, scopeKey(tenant, 'sealed-value', purpose, id));
  }
  openValue<T = JsonObject>(tenant: string, purpose: string, id: string, sealed: string): T {
    if (!this.box)
      throw new MirrorError('ENCRYPTION_REQUIRED', 'Encrypted storage requires the configured master key.');
    return this.box.open<T>(sealed, scopeKey(tenant, 'sealed-value', purpose, id));
  }
  document(tenantId: string, kind: string, id: string): JsonObject {
    const row = this.db
      .prepare('SELECT data,revision FROM documents WHERE tenant_id=? AND kind=? AND id=?')
      .get(tenantId, kind, id) as {data: string; revision: number} | undefined;
    if (!row) throw new MirrorError('NOT_FOUND', 'Document not found in this tenant.', {}, 404);
    return {...JSON.parse(row.data), id, revision: row.revision};
  }
  documents(tenantId: string, kind: string): JsonObject[] {
    return (
      this.db
        .prepare('SELECT id,data,revision FROM documents WHERE tenant_id=? AND kind=? ORDER BY id')
        .all(tenantId, kind) as JsonObject[]
    ).map(r => ({...JSON.parse(r.data), id: r.id, revision: r.revision}));
  }
  enqueue(tenantId: string, kind: string, input: unknown, availableAt = Date.now()): string {
    const id = randomUUID(),
      at = Date.now();
    this.db
      .prepare(
        "INSERT INTO jobs(id,tenant_id,kind,input,state,available_at,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?,?)",
      )
      .run(id, tenantId, kind, JSON.stringify(input), availableAt, at, at);
    return id;
  }
  enqueueReport(actor: Actor, input: JsonObject, availableAt = Date.now()): string {
    return this.transaction(() => {
      this.assertActorActive(actor);
      const id = this.enqueue(actor.tenantId, 'report', input, availableAt);
      this.db
        .prepare('UPDATE jobs SET input=? WHERE id=?')
        .run(JSON.stringify({...input, authority: {version: 1, binding: this.bindJobActor(actor, 'job:' + id)}}), id);
      return id;
    });
  }
  resumeReport(actor: Actor, id: string): void {
    this.transaction(() => {
      this.assertActorActive(actor);
      if (actor.role === 'reader')
        throw new MirrorError('FORBIDDEN', 'An operator must resume report authority.', {}, 403);
      const job = this.job(actor.tenantId, id);
      if (job.kind !== 'report')
        throw new MirrorError('INVALID_REPORT_RUN', 'Only reporting runs can use this recovery flow.');
      if (['running', 'complete'].includes(job.state)) return;
      if (!['queued', 'failed', 'cancelled'].includes(job.state))
        throw new MirrorError('INVALID_JOB_STATE', 'This report cannot be resumed.', {}, 409);
      this.db
        .prepare(
          "UPDATE jobs SET state='queued',input=?,error=NULL,attempts=0,lease_expiries=0,crash_expiries=0,available_at=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE tenant_id=? AND id=?",
        )
        .run(
          JSON.stringify({...job.input, authority: {version: 1, binding: this.bindJobActor(actor, 'job:' + id)}}),
          Date.now(),
          Date.now(),
          actor.tenantId,
          id,
        );
      this.appendAudit(actor.tenantId, id, {event: 'report_authority_resumed', actor: actor.userId});
    });
  }
  activateJob(tenantId: string, id: string) {
    const result = this.db
      .prepare("UPDATE jobs SET available_at=?,updated_at=? WHERE tenant_id=? AND id=? AND state='queued'")
      .run(Date.now(), Date.now(), tenantId, id);
    if (!result.changes) {
      const job = this.job(tenantId, id);
      if (!['running', 'complete'].includes(job.state))
        throw new MirrorError('INVALID_JOB_STATE', 'Only a queued run can be executed.', {}, 409);
    }
  }
  listTenants(): string[] {
    return (this.db.prepare('SELECT id FROM tenants ORDER BY id').all() as {id: string}[]).map(r => r.id);
  }
  enqueueSchedule(
    tenantId: string,
    scheduleId: string,
    revision: number,
    nextRunAt: number,
    following: JsonObject = {},
  ): string | undefined {
    return this.transaction(() => {
      const schedule = this.document(tenantId, 'reporting_schedule', scheduleId),
        now = Date.now();
      if (schedule.revision !== revision || !schedule.is_active || schedule.next_run_at > now) return;
      const query = this.document(tenantId, 'reporting_query', schedule.schedule_config.query_id),
        {id, revision: oldRevision, ...data} = schedule;
      const actor = this.restoreJobActor(tenantId, 'reporting-schedule:' + scheduleId, schedule.actor_binding);
      const job = this.enqueueReport(actor, {
        query_id: query.id,
        query_revision: query.revision,
        query_name: query.name,
        query_config: query.query_config,
        schedule_id: scheduleId,
      });
      this.db.prepare('UPDATE documents SET data=?,revision=revision+1 WHERE tenant_id=? AND kind=? AND id=?').run(
        JSON.stringify({
          ...data,
          ...following,
          last_occurrence_at: schedule.next_run_at,
          next_run_at: nextRunAt,
          last_run_id: job,
          last_run_at: new Date(now).toISOString(),
        }),
        tenantId,
        'reporting_schedule',
        scheduleId,
      );
      return job;
    });
  }
  leaseJob(leaseMs = 60000): JsonObject | undefined {
    return this.transaction(() => {
      if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 3600000)
        throw new MirrorError('INVALID_LEASE', 'Lease duration must be between 1 ms and 1 hour.');
      const now = Date.now();
      this.expireLeases(now);
      const row = this.db
        .prepare(
          `SELECT * FROM jobs WHERE state='queued' AND available_at<=? ORDER BY coalesce((SELECT json_extract(data,'$.ordinal') FROM documents WHERE tenant_id='${serviceLimits}' AND kind='tenant_dispatch' AND id=jobs.tenant_id),0),available_at,created_at LIMIT 1`,
        )
        .get(now) as JsonObject | undefined;
      if (!row) return;
      const cursor = this.db
          .prepare(
            `SELECT data FROM documents WHERE tenant_id='${serviceLimits}' AND kind='queue_cursor' AND id='dispatch'`,
          )
          .get() as JsonObject | undefined,
        ordinal = (cursor ? JSON.parse(cursor.data).ordinal : 0) + 1;
      this.putDocument(serviceLimits, 'queue_cursor', 'dispatch', {ordinal});
      this.putDocument(serviceLimits, 'tenant_dispatch', row.tenant_id, {ordinal, at: now});
      const token = randomUUID();
      this.db
        .prepare(
          "UPDATE jobs SET state='running',attempts=attempts+1,lease_until=?,lease_token=?,lease_boot=?,updated_at=? WHERE id=?",
        )
        .run(now + leaseMs, token, WORKER_BOOT_ID, now, row.id);
      return {
        ...row,
        input: JSON.parse(row.input),
        attempts: row.attempts + 1,
        lease_token: token,
        lease_until: now + leaseMs,
      };
    });
  }
  /**
   * Returns expired leases to the queue within the leasing transaction (OPS-07). Each expiry is counted and audited
   * (`job_lease_expired`); the first is available at once (a dead worker), later ones back off up to five minutes. A
   * job fails with LEASE_EXPIRY_LIMIT at its kind's expiry limit, or once two leases taken by another process boot
   * expired while that boot had stopped heartbeating (the job may be crashing its worker). A lease of another boot that
   * still heartbeats is a slow job in a live process, never a crash. Explicit resume resets the counters.
   */
  private expireLeases(now: number) {
    const expired = this.db
      .prepare(
        "SELECT id,tenant_id,kind,attempts,lease_boot,lease_expiries,crash_expiries FROM jobs WHERE state='running' AND lease_until<=? LIMIT 100",
      )
      .all(now) as JsonObject[];
    const bootAlive = this.db.prepare(
      `SELECT 1 FROM documents WHERE tenant_id='${serviceLimits}' AND kind='worker_heartbeat' AND json_valid(data) AND json_extract(data,'$.boot')=? AND json_extract(data,'$.at')>=? LIMIT 1`,
    );
    for (const job of expired) {
      const expiries = Number(job.lease_expiries) + 1,
        crashAttributed =
          typeof job.lease_boot === 'string' &&
          job.lease_boot !== WORKER_BOOT_ID &&
          !bootAlive.get(job.lease_boot, now - WORKER_BOOT_ALIVE_MS),
        crashes = Number(job.crash_expiries) + (crashAttributed ? 1 : 0),
        limit = leaseExpiryLimit(String(job.kind)),
        quarantined = crashes >= CRASH_EXPIRY_LIMIT,
        terminal = quarantined || expiries >= limit,
        delay = leaseExpiryDelay(expiries),
        details = {lease_expiries: expiries, crash_expiries: crashes, crash_attributed: crashAttributed, limit},
        error = terminal
          ? {
              code: 'LEASE_EXPIRY_LIMIT',
              message: quarantined ? LEASE_CRASH_QUARANTINE_MESSAGE : LEASE_EXPIRY_LIMIT_MESSAGE,
              details: {...details, reason: quarantined ? 'crash_quarantine' : 'expiry_limit'},
            }
          : {code: 'LEASE_EXPIRED', message: LEASE_EXPIRED_MESSAGE, details: {...details, retry_after_ms: delay}};
      this.db
        .prepare(
          'UPDATE jobs SET state=?,error=?,available_at=?,lease_until=NULL,lease_token=NULL,lease_boot=NULL,lease_expiries=?,crash_expiries=?,updated_at=? WHERE id=? AND state=? AND lease_until<=?',
        )
        .run(
          terminal ? 'failed' : 'queued',
          JSON.stringify(error),
          now + delay,
          expiries,
          crashes,
          now,
          String(job.id),
          'running',
          now,
        );
      this.appendAudit(String(job.tenant_id), String(job.id), {
        event: 'job_lease_expired',
        kind: job.kind,
        attempts: job.attempts,
        ...details,
        outcome: terminal ? 'failed' : 'requeued',
        ...(terminal ? {code: error.code} : {}),
      });
    }
  }
  /**
   * Returns a job to the queue at shutdown without counting its attempt (OPS-07): only while this worker still holds
   * the lease, and only for kinds the caller knows are safe to interrupt. `onRelease` runs in the same transaction.
   */
  releaseJob(id: string, leaseToken: string, onRelease?: () => void, delayMs = 1000): boolean {
    return this.transaction(() => {
      const now = Date.now(),
        r = this.db
          .prepare(
            "UPDATE jobs SET state='queued',error=?,available_at=?,attempts=max(0,attempts-1),lease_until=NULL,lease_token=NULL,lease_boot=NULL,updated_at=? WHERE id=? AND state='running' AND lease_token=? AND lease_until>?",
          )
          .run(
            JSON.stringify({code: 'SHUTDOWN', message: JOB_SHUTDOWN_MESSAGE}),
            now + delayMs,
            now,
            id,
            leaseToken,
            now,
          );
      if (!r.changes) return false;
      onRelease?.();
      return true;
    });
  }
  finishJob(id: string, leaseToken: string, result: unknown) {
    const now = Date.now();
    const r = this.db
      .prepare(
        "UPDATE jobs SET state='complete',result=?,lease_until=NULL,lease_token=NULL,updated_at=? WHERE id=? AND state='running' AND lease_token=? AND lease_until>?",
      )
      .run(JSON.stringify(redact(result)), now, id, leaseToken, now);
    if (!r.changes) throw new MirrorError('STALE_JOB_LEASE', 'This worker no longer owns the job lease.', {}, 409);
  }
  failJob(id: string, leaseToken: string, error: unknown) {
    const now = Date.now();
    const r = this.db
      .prepare(
        "UPDATE jobs SET state='failed',error=?,lease_until=NULL,lease_token=NULL,updated_at=? WHERE id=? AND state='running' AND lease_token=? AND lease_until>?",
      )
      .run(JSON.stringify(redact(error)), now, id, leaseToken, now);
    if (!r.changes) throw new MirrorError('STALE_JOB_LEASE', 'This worker no longer owns the job lease.', {}, 409);
  }
  renewJob(id: string, leaseToken: string, leaseMs = 60000) {
    if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 3600000)
      throw new MirrorError('INVALID_LEASE', 'Invalid lease duration.');
    const now = Date.now();
    const r = this.db
      .prepare(
        "UPDATE jobs SET lease_until=?,updated_at=? WHERE id=? AND state='running' AND lease_token=? AND lease_until>?",
      )
      .run(now + leaseMs, now, id, leaseToken, now);
    if (!r.changes) throw new MirrorError('STALE_JOB_LEASE', 'This worker no longer owns the job lease.', {}, 409);
  }
  job(tenantId: string, id: string): JsonObject {
    const row = this.db.prepare('SELECT * FROM jobs WHERE tenant_id=? AND id=?').get(tenantId, id) as
      JsonObject | undefined;
    if (!row) throw new MirrorError('NOT_FOUND', 'Job not found in this tenant.', {}, 404);
    const {lease_token, lease_boot, lease_expiries, crash_expiries, ...publicRow} = row,
      {authority, ...input} = JSON.parse(row.input);
    return {
      ...publicRow,
      input,
      result: row.result ? JSON.parse(row.result) : null,
      error: row.error ? JSON.parse(row.error) : null,
    };
  }
  /**
   * A job as this actor may read it by ID (SEC-08): any job of the workspace, or under a client access set only a job
   * started under that same set, as its sealed authority records; any other is not found, like one that does not exist.
   */
  jobFor(actor: Actor, id: string): JsonObject {
    this.assertActorActive(actor);
    const job = this.job(actor.tenantId, id);
    if (actor.accessSetId !== undefined && this.jobAccessSet(actor.tenantId, id) !== actor.accessSetId)
      throw new MirrorError('NOT_FOUND', 'Job not found in this tenant.', {}, 404);
    return job;
  }
  /**
   * The client access set a job's creator was limited to, from the sealed authority: the job's own, or for a job that
   * runs or delivers a report snapshot, the snapshot's. Undefined when there is none or it cannot be read (fail closed).
   */
  private jobAccessSet(tenantId: string, id: string): string | undefined {
    const row = this.db.prepare('SELECT input FROM jobs WHERE tenant_id=? AND id=?').get(tenantId, id) as
      {input: string} | undefined;
    const input = row ? (JSON.parse(row.input) as JsonObject) : undefined;
    let binding: unknown = input?.authority?.binding,
      scope = 'job:' + id;
    if (typeof binding !== 'string' && typeof input?.report_id === 'string') {
      const report = this.db
        .prepare(
          "SELECT json_extract(data,'$.actor_binding') AS binding FROM documents WHERE tenant_id=? AND kind=? AND id=?",
        )
        .get(tenantId, 'overview_report', input.report_id) as {binding?: unknown} | undefined;
      binding = report?.binding;
      scope = input.report_id;
    }
    if (typeof binding !== 'string' || !this.box) return undefined;
    try {
      return this.box.open<{actor: Actor}>(binding, scopeKey(tenantId, 'job-actor', scope)).actor.accessSetId;
    } catch {
      return undefined;
    }
  }
}

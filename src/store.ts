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
import {SecretBox, sha256, stable, redact, scopeKey} from './security.js';
import type {Actor, Connection, Credentials, JsonObject} from './types.js';
import {recordServiceTiming, type ServiceTimingCategory} from './service-timings.js';
import {nativeParameterKey} from './parameter-key.js';
import {scheduleIndexSQL} from './scheduled-work.js';
import {WEBSITE_UPLOAD_TTL_MS, MEDIA_CLEANUP_INTERVAL_MS} from './media-retention.js';
import {loginRevision, recordLogin} from './connection-authority.js';
export const MEDIA_LEASE_MS = 45000;
/**
 * The record to store: the store's login revision and login id, never a caller's (revision 0 is left implicit, as on
 * older rows, which also have no login id).
 */
function withLogin(connection: Connection, revision: number, loginId: string | undefined): Connection {
  const {loginRevision: _revision, loginId: _id, ...rest} = connection;
  return {...rest, ...(revision ? {loginRevision: revision} : {}), ...(loginId ? {loginId} : {})};
}
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
  get mediaCleanupHealth() {
    return {
      lifetime_minutes: 30,
      cleanup_interval_ms: MEDIA_CLEANUP_INTERVAL_MS,
      last_success_at: this.transientCleanupAt,
      ...(this.transientCleanupError ? {error_code: this.transientCleanupError} : {}),
    };
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
  constructor(filename: string, masterKey?: string) {
    if (masterKey) this.box = new SecretBox(masterKey);
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
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;');
      // Serialize bootstrap and migration together so two starting processes cannot
      // both observe an old schema and attempt the same ALTER TABLE.
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
   CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'audit is append only'); END;
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
        const version = this.db.prepare('SELECT version FROM schema_version').get() as {version: number};
        if (version.version === 1)
          this.db.exec('ALTER TABLE jobs ADD COLUMN lease_token TEXT; UPDATE schema_version SET version=2;');
        else if (version.version !== 2)
          throw new MirrorError('SCHEMA_VERSION_MISMATCH', 'Database migration required.', {}, 500);
        // Additive schema-2 index: workbook authorization repeatedly looks up exact query membership.
        // Tenant and association are indexed together; current actor/account checks still run for every result.
        this.db.exec(`CREATE INDEX IF NOT EXISTS reporting_query_workbook
          ON documents(tenant_id,json_extract(data,'$.workbook_binding_id'),id)
          WHERE kind='reporting_query'`);
        // Additive schema-2 indexes: inactive/future schedules need not be decoded every worker pass.
        this.db.exec(scheduleIndexSQL);
        // The independent expiry timer visits media kinds without scanning report, audit or schedule documents.
        this.db.exec(`CREATE INDEX IF NOT EXISTS media_documents_by_kind ON documents(kind)
          WHERE kind IN ('media_source','retained_media_source','media_review','media_variant','upload_session','preview_receipt')`);
      });
      this.cleanupTransient();
      this.transientCleanupTimer = setInterval(() => {
        try {
          this.cleanupMediaTransient();
        } catch (error) {
          this.transientCleanupError =
            error instanceof MirrorError
              ? error.code
              : typeof (error as {code?: unknown})?.code === 'string'
                ? (error as {code: string}).code
                : 'MEDIA_CLEANUP_FAILED';
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
  mediaAdmission(tenant: string) {
    const id = randomUUID(),
      bytes = 6 * MAX_MEDIA_BYTES,
      now = Date.now();
    // One maximum-sized operation by default, shared by all workers. Covers upload/base64/FFmpeg copies.
    const raw = Number(process.env.AMCP_MEDIA_MEMORY_MB ?? bytes / 1048576),
      limit = Number.isSafeInteger(raw) && raw >= bytes / 1048576 && raw <= 8192 ? raw * 1048576 : bytes;
    this.transaction(() => {
      this.db.prepare('DELETE FROM media_admissions WHERE expires_at<=?').run(now);
      const used = this.db.prepare('SELECT coalesce(sum(bytes),0) AS n FROM media_admissions').get() as JsonObject;
      if (used.n + bytes > limit)
        throw new MirrorError(
          'MEDIA_MEMORY_BUSY',
          'Another media operation is using the shared byte budget. Wait for it to finish, then inspect recovery for any submitted review before retrying.',
          {retry_after_ms: 5000, reserved_bytes: used.n, limit_bytes: limit},
          429,
          true,
        );
      this.db.prepare('INSERT INTO media_admissions VALUES(?,?,?,?)').run(id, tenant, bytes, now + MEDIA_LEASE_MS);
    });
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
          .run(
            tenant,
            id,
            index,
            this.box!.seal(
              {bytes: pending.subarray(0, filled).toString('base64')},
              scopeKey(tenant, 'media-chunk', id, String(index)),
            ),
          );
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
    metric: 'requests' | 'errors' | 'rate_limits' | 'latency_ms',
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
      this.db
        .prepare(`DELETE FROM retained_media_chunks WHERE (tenant_id,id) IN (${expiredUploads})`)
        .run(now - WEBSITE_UPLOAD_TTL_MS);
      this.db
        .prepare(`DELETE FROM retained_media WHERE (tenant_id,id) IN (${expiredUploads})`)
        .run(now - WEBSITE_UPLOAD_TTL_MS);
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
      this.cleanupStagedMedia(now);
      this.db.prepare('DELETE FROM media_admissions WHERE expires_at<=?').run(now);
      this.db
        .prepare(
          "DELETE FROM documents WHERE kind IN ('media_source','retained_media_source','media_review','media_variant','upload_session','preview_receipt') AND ((kind IN ('upload_session','preview_receipt','media_source','media_variant') AND json_extract(data,'$.expires_at')<=?) OR (kind='media_source' AND json_extract(data,'$.origin')='upload' AND coalesce(json_extract(data,'$.created_at'),0)<=?) OR (kind='media_variant' AND json_extract(data,'$.upload_expires_at')<=?))",
        )
        .run(now, now - WEBSITE_UPLOAD_TTL_MS, now);
    });
    this.transientCleanupAt = now;
    this.transientCleanupError = undefined;
  }

  cleanupTransient() {
    const now = Date.now();
    this.transaction(() => {
      this.cleanupMediaTransient(now);
      this.db
        .prepare(
          "DELETE FROM documents WHERE kind IN ('tiktok_report_run','x_report_run','x_report_result') AND json_extract(data,'$.expires_at')<=?",
        )
        .run(now);
      this.db.prepare('DELETE FROM provider_cooldowns WHERE until_at<=?').run(now);
      this.db
        .prepare(
          "DELETE FROM documents WHERE tenant_id='__service_limits__' AND kind IN ('provider_budget','worker_heartbeat','tiktok_report_quota') AND coalesce(json_extract(data,'$.at'),0)<?",
        )
        .run(now - 86400000);
    });
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

  private cleanupStagedMedia(now = Date.now()) {
    this.db
      .prepare(
        'DELETE FROM media_chunks WHERE EXISTS(SELECT 1 FROM media_staging s WHERE s.tenant_id=media_chunks.tenant_id AND s.id=media_chunks.id AND s.expires_at<=?)',
      )
      .run(now);
    this.db.prepare('DELETE FROM media_staging WHERE expires_at<=?').run(now);
  }
  /** Original-file counts include staged sources and retained copies; review/variant staging is independent. */
  private stagedCount(sources: boolean, tenant?: string) {
    const kind = sources ? "id LIKE 'src-%'" : "id NOT LIKE 'src-%'",
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
      this.db.prepare('INSERT INTO media_staging VALUES(?,?,NULL,?)').run(tenant, id, expiresAt);
    });
  }
  /**
   * Bytes held by uploaded files: a finished one counts its size, one still arriving (or downloading) the whole media
   * limit, since its size is not final.
   */
  private stagedSourceBytes(tenant?: string) {
    const rows = (
      tenant === undefined
        ? this.db.prepare("SELECT tenant_id, id, secret FROM media_staging WHERE id LIKE 'src-%'").all()
        : this.db
            .prepare("SELECT tenant_id, id, secret FROM media_staging WHERE tenant_id=? AND id LIKE 'src-%'")
            .all(tenant)
    ) as {tenant_id: string; id: string; secret: string | null}[];
    let bytes = 0;
    for (const r of rows) {
      const size = r.secret
        ? Number(this.box!.open<{size?: unknown}>(r.secret, scopeKey(r.tenant_id, 'media', r.id)).size)
        : NaN;
      bytes += Number.isSafeInteger(size) && size >= 0 && size <= MAX_MEDIA_BYTES ? size : MAX_MEDIA_BYTES;
    }
    return bytes + retainedMediaStats(this, tenant).bytes;
  }
  /** A selected durable copy shares the existing original-file count and byte ceilings with uploads. */
  assertRetainedMediaCapacity(tenant: string, size: number) {
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_MEDIA_BYTES)
      throw new MirrorError('MEDIA_LIBRARY_INVALID', 'Invalid retained-original size.');
    this.cleanupStagedMedia();
    if (
      this.stagedCount(true, tenant) >= 25 ||
      this.stagedSourceBytes(tenant) + size > 4 * MAX_MEDIA_BYTES ||
      this.stagedCount(true) >= 50 ||
      this.stagedSourceBytes() + size > 8 * MAX_MEDIA_BYTES
    )
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
   * times the media limit in bytes, counting the new file at the limit until it is finished; and at most 25 and 50
   * files. Four full-sized files still fill a workspace, and many small ones fit in the same space.
   */
  reserveMediaSource(tenant: string, id: string, expiresAt: number) {
    if (!this.box) throw new MirrorError('ENCRYPTION_REQUIRED', 'Media staging requires the configured master key.');
    if (!/^src-[0-9a-f-]{36}$/.test(id)) throw new MirrorError('MEDIA_STAGING_INVALID', 'Invalid media source id.');
    this.transaction(() => {
      this.cleanupStagedMedia();
      if (
        this.stagedCount(true, tenant) >= 25 ||
        this.stagedSourceBytes(tenant) + MAX_MEDIA_BYTES > 4 * MAX_MEDIA_BYTES
      )
        throw new MirrorError(
          'MEDIA_STAGING_FULL',
          'Waiting uploads and retained originals fill this workspace storage (25 files, or four at the media limit). Remove selected files or wait for temporary uploads to expire; retained copies require owner confirmation.',
          {retry_after_ms: 60000},
          429,
          true,
        );
      if (this.stagedCount(true) >= 50 || this.stagedSourceBytes() + MAX_MEDIA_BYTES > 8 * MAX_MEDIA_BYTES)
        throw new MirrorError(
          'MEDIA_STAGING_FULL',
          'AMCP is holding as many uploaded files as it keeps at once. Try again in a few minutes.',
          {retry_after_ms: 60000},
          429,
          true,
        );
      this.db.prepare('INSERT INTO media_staging VALUES(?,?,NULL,?)').run(tenant, id, expiresAt);
    });
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
  putMediaChunk(tenant: string, id: string, index: number, bytes: Buffer, chunkBytes: number) {
    if (!this.box) throw new MirrorError('ENCRYPTION_REQUIRED', 'Encrypted staging is required.');
    if (
      !Number.isSafeInteger(chunkBytes) ||
      chunkBytes < 1 ||
      chunkBytes > 4 * 1024 * 1024 ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index * chunkBytes >= MAX_MEDIA_BYTES ||
      !bytes.length ||
      bytes.length > chunkBytes
    )
      throw new MirrorError('MEDIA_STAGING_INVALID', 'Invalid media chunk.');
    this.transaction(() => {
      this.receivingSource(tenant, id);
      this.db
        .prepare('INSERT OR REPLACE INTO media_chunks VALUES(?,?,?,?)')
        .run(
          tenant,
          id,
          index,
          this.box!.seal({bytes: bytes.toString('base64')}, scopeKey(tenant, 'media-chunk', id, String(index))),
        );
    });
  }
  /**
   * Completes a file received in chunks: chunks 0 to `chunks - 1` must all be present, each exactly `chunkBytes` long
   * except the last, adding up to `size`. Writes the manifest `stagedMedia` reads and returns the file's SHA-256.
   */
  finalizeMediaChunks(tenant: string, id: string, expected: {chunks: number; size: number; chunkBytes: number}) {
    if (!this.box) throw new MirrorError('ENCRYPTION_REQUIRED', 'Encrypted staging is required.');
    const {chunks, size, chunkBytes} = expected;
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_MEDIA_BYTES)
      throw new MirrorError('MEDIA_STAGING_INVALID', 'Invalid media size.');
    return this.transaction(() => {
      this.receivingSource(tenant, id);
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
        const part = Buffer.from(
          this.box!.open<{bytes: string}>(c.secret, scopeKey(tenant, 'media-chunk', id, String(index))).bytes,
          'base64',
        );
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
      .get(tenant, id, index) as {secret: string} | undefined;
    if (!row) throw new MirrorError('MEDIA_STAGING_INVALID', 'Encrypted media chunks are incomplete.');
    return Buffer.from(
      this.box!.open<{bytes: string}>(row.secret, scopeKey(tenant, 'media-chunk', id, String(index))).bytes,
      'base64',
    );
  }
  /** The manifest of a completed staged file: its chunk count, size and SHA-256. */
  stagedMediaManifest(tenant: string, id: string): {chunks: number; size: number; sha256: string; bytes?: string} {
    const row = this.db
      .prepare('SELECT secret FROM media_staging WHERE tenant_id=? AND id=? AND expires_at>?')
      .get(tenant, id, Date.now()) as {secret: string | null} | undefined;
    if (!this.box || !row?.secret) throw new MirrorError('REVIEW_EXPIRED', 'The staged media expired or was removed.');
    return this.box.open(row.secret, scopeKey(tenant, 'media', id));
  }
  stageMedia(tenant: string, id: string, bytes: Buffer) {
    if (!this.box || bytes.length > MAX_MEDIA_BYTES)
      throw new MirrorError('MEDIA_STAGING_INVALID', 'Media exceeds the configured encrypted staging limit.');
    this.transaction(() => {
      const row = this.db
        .prepare('SELECT expires_at FROM media_staging WHERE tenant_id=? AND id=? AND expires_at>?')
        .get(tenant, id, Date.now());
      if (!row) throw new MirrorError('REVIEW_EXPIRED', 'Media preparation expired.');
      this.db.prepare('DELETE FROM media_chunks WHERE tenant_id=? AND id=?').run(tenant, id);
      const size = 4 * 1024 * 1024;
      let chunks = 0;
      for (let offset = 0; offset < bytes.length; offset += size) {
        const secret = this.box!.seal(
          {bytes: bytes.subarray(offset, offset + size).toString('base64')},
          scopeKey(tenant, 'media-chunk', id, String(chunks)),
        );
        this.db.prepare('INSERT INTO media_chunks VALUES(?,?,?,?)').run(tenant, id, chunks++, secret);
      }
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
      const part = Buffer.from(
        this.box!.open<{bytes: string}>(c.secret, scopeKey(tenant, 'media-chunk', id, String(index++))).bytes,
        'base64',
      );
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
  removeStagedMedia(tenant: string, id: string) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM media_chunks WHERE tenant_id=? AND id=?').run(tenant, id);
      this.db.prepare('DELETE FROM media_staging WHERE tenant_id=? AND id=?').run(tenant, id);
    });
  }
  transaction<T>(fn: () => T): T {
    if (fn.constructor.name === 'AsyncFunction')
      throw new MirrorError('ASYNC_TRANSACTION_UNSUPPORTED', 'SQLite transactions require synchronous callbacks.');
    const depth = this.transactionDepth,
      name = 'amcp_sp_' + depth;
    this.db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : 'SAVEPOINT ' + name);
    this.transactionDepth++;
    try {
      const result = fn();
      if (result && typeof (result as {then?: unknown}).then === 'function')
        throw new MirrorError('ASYNC_TRANSACTION_UNSUPPORTED', 'SQLite transactions require synchronous callbacks.');
      this.db.exec(depth === 0 ? 'COMMIT' : 'RELEASE SAVEPOINT ' + name);
      return result;
    } catch (e) {
      // ROLLBACK TO preserves the savepoint; release it after undoing the inner work.
      if (this.db.isTransaction)
        this.db.exec(depth === 0 ? 'ROLLBACK' : 'ROLLBACK TO SAVEPOINT ' + name + '; RELEASE SAVEPOINT ' + name);
      throw e;
    } finally {
      this.transactionDepth = depth;
    }
  }
  ensureTenant(id: string, name = id) {
    if (!id) throw new MirrorError('INVALID_TENANT', 'Tenant ID is required.');
    this.db.prepare('INSERT INTO tenants(id,name) VALUES(?,?) ON CONFLICT(id) DO NOTHING').run(id, name);
  }
  createKey(actor: Actor, ttlMs: number = 86400000 * 30): string {
    this.assertActorActive(actor);
    this.ensureTenant(actor.tenantId);
    const token = 'whm_' + randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
    this.transaction(() => {
      this.db
        .prepare('INSERT INTO api_keys(hash,tenant_id,user_id,role,expires_at) VALUES(?,?,?,?,?)')
        .run(sha256(token), actor.tenantId, actor.userId, actor.role, Date.now() + ttlMs);
      if (actor.ownerUserId)
        this.db.prepare('INSERT INTO credential_owners VALUES(?,?)').run(sha256(token), actor.ownerUserId);
    });
    return token;
  }
  authenticate(token: string): Actor {
    const row = this.db
      .prepare('SELECT * FROM api_keys WHERE hash=? AND revoked=0 AND (expires_at IS NULL OR expires_at>?)')
      .get(sha256(token), Date.now()) as JsonObject | undefined;
    if (!row) throw new MirrorError('UNAUTHORIZED', 'A valid, unexpired API key is required.', {}, 401);
    const owner = this.db.prepare('SELECT user_id FROM credential_owners WHERE hash=?').get(sha256(token)) as
      JsonObject | undefined;
    const actor: Actor = {
      tenantId: row.tenant_id,
      userId: row.user_id,
      role: row.role,
      ...(owner ? {ownerUserId: owner.user_id} : {}),
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
      const rank: Record<string, number> = {viewer: 0, reader: 0, operator: 1, admin: 2, owner: 2};
      if (!membership || rank[membership.role]! < rank[actor.role]!)
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
        'SELECT tenant_id,user_id,role FROM api_keys WHERE hash=? AND revoked=0 AND (expires_at IS NULL OR expires_at>?)',
      )
      .get(hash, Date.now()) as JsonObject | undefined;
    if (!row || row.tenant_id !== actor.tenantId || row.user_id !== actor.userId || row.role !== actor.role)
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
  renewLock(key: string, owner: string, ttl: number) {
    const now = Date.now();
    return (
      this.db
        .prepare('UPDATE service_locks SET expires_at=? WHERE key=? AND owner=? AND expires_at>?')
        .run(now + ttl, key, owner, now).changes === 1
    );
  }
  // Shared across processes, so this bucket must use wall-clock time; never let a backward
  // clock correction subtract tokens. Refill pauses until the clock catches up, which is the safe direction.
  providerPermit(key: string) {
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
          .prepare(
            "SELECT data FROM documents WHERE tenant_id='__service_limits__' AND kind='provider_budget' AND id=?",
          )
          .get(sha256(key)) as JsonObject | undefined,
        old = record ? JSON.parse(record.data) : {tokens: 30, at: now},
        tokens = Math.min(30, old.tokens + Math.max(0, now - old.at) / 200);
      if (tokens < 1)
        throw new MirrorError(
          'TENANT_RATE_LIMIT',
          'The shared platform request budget is exhausted.',
          {retry_after_ms: Math.ceil((1 - tokens) * 200)},
          429,
          true,
        );
      this.putDocument('__service_limits__', 'provider_budget', sha256(key), {
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
        secret = 'v2:' + this.box!.seal(credentials, scopeKey(connection.tenantId, connection.id));
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
  /** Whether a row already holds exactly these credentials; an unreadable secret counts as different. */
  private storedSecretEquals(row: {secret: string}, connection: Connection, credentials: Credentials) {
    try {
      const current = row.secret.startsWith('v2:')
        ? this.box!.open<Credentials>(row.secret.slice(3), scopeKey(connection.tenantId, connection.id))
        : this.box!.open<Credentials>(row.secret, connection.tenantId + '/' + connection.id);
      return stable(current) === stable(credentials);
    } catch {
      return false;
    }
  }
  private assertConnectionShape(actor: Actor, connection: Connection) {
    if (actor.role !== 'admin' || actor.tenantId !== connection.tenantId)
      throw new MirrorError('FORBIDDEN', 'Only a tenant administrator can provision a connection.', {}, 403);
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
  listConnections(tenantId: string): Connection[] {
    return (this.db.prepare('SELECT data FROM connections WHERE tenant_id=?').all(tenantId) as {data: string}[]).map(
      x => JSON.parse(x.data),
    );
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
    if (row.secret.startsWith('v2:'))
      return recordLogin(this.box.open<Credentials>(row.secret.slice(3), scopeKey(tenantId, id)), login);
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
    return recordLogin(value, login);
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
          'v2:' + this.box!.seal(value, scopeKey(tenantId, id)),
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
    const available = this.listConnections(actor.tenantId).filter(
      c =>
        c.enabled &&
        c.gateway === gateway &&
        (!connectionId || c.id === connectionId) &&
        (!accountId || c.accounts.some(a => normalize(a) === normalize(accountId))),
    );
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
      throw new MirrorError('AMBIGUOUS_CONNECTION', 'Specify a connection_id to select one connection.');
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
  verifyAudit() {
    let previous = 'GENESIS';
    for (const row of this.db.prepare('SELECT * FROM audit ORDER BY seq').iterate() as Iterable<JsonObject>) {
      const hash = sha256(
        stable({tenantId: row.tenant_id, requestId: row.request_id, payload: row.event, previous, at: row.created_at}),
      );
      if (row.previous_hash !== previous || row.hash !== hash) return false;
      previous = hash;
    }
    return true;
  }
  claim(tenantId: string, key: string, fingerprint: string): {fresh: boolean; result?: unknown} {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM idempotency WHERE tenant_id=? AND key=?').get(tenantId, key) as
        JsonObject | undefined;
      if (row) {
        if (row.fingerprint !== fingerprint)
          throw new MirrorError('IDEMPOTENCY_CONFLICT', 'The same key was used for a different request.', {}, 409);
        if (row.state === 'complete') return {fresh: false, result: JSON.parse(row.result)};
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
  complete(tenantId: string, key: string, result: unknown) {
    this.transaction(() => {
      this.db
        .prepare("UPDATE idempotency SET state='complete',result=? WHERE tenant_id=? AND key=?")
        .run(JSON.stringify(redact(result)), tenantId, key);
      this.journal(tenantId, key, 'responded');
    });
  }
  uncertain(tenantId: string, key: string) {
    this.transaction(() => {
      this.db.prepare("UPDATE idempotency SET state='uncertain' WHERE tenant_id=? AND key=?").run(tenantId, key);
      this.journal(tenantId, key, 'uncertain');
    });
  }
  putDocument(tenantId: string, kind: string, id: string, data: unknown, expectedRevision?: number) {
    return this.transaction(() => {
      const old = this.db
        .prepare('SELECT revision FROM documents WHERE tenant_id=? AND kind=? AND id=?')
        .get(tenantId, kind, id) as {revision: number} | undefined;
      if (expectedRevision !== undefined && old?.revision !== expectedRevision)
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
          "UPDATE jobs SET state='queued',input=?,error=NULL,available_at=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE tenant_id=? AND id=?",
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
  enqueueSchedule(tenantId: string, scheduleId: string, revision: number, nextRunAt: number): string | undefined {
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
      this.db
        .prepare('UPDATE documents SET data=?,revision=revision+1 WHERE tenant_id=? AND kind=? AND id=?')
        .run(
          JSON.stringify({...data, next_run_at: nextRunAt, last_run_id: job, last_run_at: new Date(now).toISOString()}),
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
      this.db
        .prepare(
          "UPDATE jobs SET state='queued',lease_until=NULL,lease_token=NULL WHERE state='running' AND lease_until<=?",
        )
        .run(now);
      const row = this.db
        .prepare(
          "SELECT * FROM jobs WHERE state='queued' AND available_at<=? ORDER BY coalesce((SELECT json_extract(data,'$.ordinal') FROM documents WHERE tenant_id='__service_limits__' AND kind='tenant_dispatch' AND id=jobs.tenant_id),0),available_at,created_at LIMIT 1",
        )
        .get(now) as JsonObject | undefined;
      if (!row) return;
      const cursor = this.db
          .prepare(
            "SELECT data FROM documents WHERE tenant_id='__service_limits__' AND kind='queue_cursor' AND id='dispatch'",
          )
          .get() as JsonObject | undefined,
        ordinal = (cursor ? JSON.parse(cursor.data).ordinal : 0) + 1;
      this.putDocument('__service_limits__', 'queue_cursor', 'dispatch', {ordinal});
      this.putDocument('__service_limits__', 'tenant_dispatch', row.tenant_id, {ordinal, at: now});
      const token = randomUUID();
      this.db
        .prepare(
          "UPDATE jobs SET state='running',attempts=attempts+1,lease_until=?,lease_token=?,updated_at=? WHERE id=?",
        )
        .run(now + leaseMs, token, now, row.id);
      return {
        ...row,
        input: JSON.parse(row.input),
        attempts: row.attempts + 1,
        lease_token: token,
        lease_until: now + leaseMs,
      };
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
    const {lease_token, ...publicRow} = row,
      {authority, ...input} = JSON.parse(row.input);
    return {
      ...publicRow,
      input,
      result: row.result ? JSON.parse(row.result) : null,
      error: row.error ? JSON.parse(row.error) : null,
    };
  }
}

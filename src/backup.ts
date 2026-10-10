import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {backup, DatabaseSync} from 'node:sqlite';
import {createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID} from 'node:crypto';
import {Store} from './store.js';
import {setTimeout as delay} from 'node:timers/promises';
import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';
import {JOURNAL_SIZE_LIMIT_BYTES, deleteRowsOneByOne} from './media-storage.js';

const magic = Buffer.from('AMCP-BACKUP-1\n');
function backupKey(key: string | undefined) {
  const bytes = Buffer.from(key ?? '', 'base64');
  if (bytes.length !== 32)
    throw new MirrorError(
      'ENCRYPTION_REQUIRED',
      'Set the 32-byte MIRROR_MASTER_KEY before creating, verifying or restoring backups.',
    );
  return bytes;
}
/**
 * Options of createEncryptedBackup (OPS-04). `tmpdir` overrides AMCP_BACKUP_TMPDIR (default os.tmpdir()), the parent of
 * the private staging directory. `production` defaults to NODE_ENV=production, where a destination on the same volume
 * as the database is refused unless `allowSameVolume` is set. `skipSpaceCheck` is the documented override of the
 * free-space preflight. `freeBytes` and `device` replace statfs and stat (test seams).
 */
export interface BackupOptions {
  tmpdir?: string;
  production?: boolean;
  allowSameVolume?: boolean;
  skipSpaceCheck?: boolean;
  freeBytes?: (directory: string) => number;
  device?: (file: string) => number | bigint;
}
const freeBytesOf = (directory: string) => {
  const s = fs.statfsSync(directory);
  return Number(s.bavail) * Number(s.bsize);
};
const deviceOf = (file: string) => fs.statSync(file).dev;
/** The staging parent: an existing directory named by the option, AMCP_BACKUP_TMPDIR or the OS temporary directory. */
function stagingParent(option?: string): string {
  const parent = path.resolve(option ?? (process.env.AMCP_BACKUP_TMPDIR || os.tmpdir()));
  try {
    if (fs.statSync(parent).isDirectory()) return fs.realpathSync(parent);
  } catch {
    /* refused below */
  }
  throw new MirrorError(
    'BACKUP_TMPDIR_UNAVAILABLE',
    'The backup staging directory (AMCP_BACKUP_TMPDIR, or the system temporary directory) must be an existing private directory.',
  );
}
const mib = (bytes: number) => (bytes / 1048576).toFixed(1) + ' MiB';
function temporary(parent = os.tmpdir()) {
  const root = path.resolve(parent),
    dir = fs.mkdtempSync(path.join(root, 'amcp-backup-'));
  return {
    file: path.join(dir, 'snapshot.sqlite'),
    async clean(primaryErrorCode?: string) {
      const target = path.resolve(dir);
      for (let attempt = 0; ; attempt++) {
        try {
          if (
            path.dirname(target) !== root ||
            !path.basename(target).startsWith('amcp-backup-') ||
            fs.lstatSync(target).isSymbolicLink()
          )
            throw new MirrorError('BACKUP_CLEANUP_FAILED', 'Refusing to clean an unexpected backup staging directory.');
          await fs.promises.rm(target, {recursive: true, force: true});
          return;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') return;
          // Let pending handle releases run; synchronous retries can keep the event loop blocked.
          if (['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES'].includes(code ?? '') && attempt < 5) {
            await delay(50 * (attempt + 1));
            continue;
          }
          throw new MirrorError(
            'BACKUP_CLEANUP_FAILED',
            'Backup staging could not be removed. Keep the staging directory private and remove it after resolving the filesystem restriction. Inspect whether the operation completed before retrying a restore.',
            {
              cleanup_required: true,
              staging_directory: target,
              primary_error_code: primaryErrorCode ?? null,
              operation_completed: primaryErrorCode === undefined,
              cleanup_error_code: code ?? 'UNKNOWN',
            },
            500,
          );
        }
      }
    },
  };
}
async function hashFile(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function writeAll(fd: number, bytes: Buffer) {
  let at = 0;
  while (at < bytes.length) {
    const n = fs.writeSync(fd, bytes, at, bytes.length - at);
    if (n <= 0) throw new MirrorError('BACKUP_IO_FAILED', 'The snapshot could not be written completely.');
    at += n;
  }
}
function inspectSqlite(file: string) {
  const db = new DatabaseSync(file, {readOnly: true});
  try {
    const result = db.prepare('PRAGMA integrity_check').all() as JsonObject[];
    if (
      result.length !== 1 ||
      result[0]!.integrity_check !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').all().length
    )
      throw new MirrorError(
        'BACKUP_INTEGRITY_FAILED',
        'The restored SQLite copy failed its integrity or foreign-key check.',
      );
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name: string}[]).map(t => t.name),
    );
    if (
      ['schema_version', 'tenants', 'connections', 'audit', 'idempotency', 'documents', 'jobs'].some(
        t => !tables.has(t),
      )
    )
      throw new MirrorError('BACKUP_SCHEMA_INVALID', 'The authenticated file does not contain an AMCP database.');
    const versions = db.prepare('SELECT version FROM schema_version').all() as {version: number}[];
    if (versions.length !== 1 || ![1, 2].includes(versions[0]!.version))
      throw new MirrorError('SCHEMA_VERSION_MISMATCH', 'The backup schema is not supported by this AMCP release.');
    return versions[0]!.version;
  } catch (e) {
    if (e instanceof MirrorError) throw e;
    throw new MirrorError(
      'BACKUP_INTEGRITY_FAILED',
      'The authenticated snapshot is not a readable, intact SQLite database.',
    );
  } finally {
    db.close();
  }
}

/** Verify a disposable restored copy; never restore over the running database. */
async function withVerifiedBackup<T>(
  file: string,
  key: string | undefined,
  parent: string | undefined,
  consume: (snapshot: string, receipt: JsonObject) => Promise<T>,
): Promise<T> {
  const restoreStarted = performance.now(),
    secret = backupKey(key),
    header = Buffer.alloc(magic.length + 12),
    tag = Buffer.alloc(16),
    fd = fs.openSync(file, 'r');
  let temp: ReturnType<typeof temporary> | undefined, output: number | undefined, failure: MirrorError | undefined;
  try {
    const stat = fs.fstatSync(fd),
      size = stat.size;
    if (!stat.isFile() || size <= header.length + 16 || !Number.isSafeInteger(size))
      throw new MirrorError('BACKUP_INVALID', 'The encrypted backup is not a complete regular file.');
    if (
      fs.readSync(fd, header, 0, header.length, 0) !== header.length ||
      fs.readSync(fd, tag, 0, 16, size - 16) !== 16 ||
      !header.subarray(0, magic.length).equals(magic)
    )
      throw new MirrorError('BACKUP_INVALID', 'This is not a complete AMCP encrypted backup.');
    temp = temporary(parent);
    const hash = createHash('sha256').update(header);
    const decrypt = createDecipheriv('aes-256-gcm', secret, header.subarray(magic.length));
    decrypt.setAAD(magic);
    decrypt.setAuthTag(tag);
    output = fs.openSync(temp.file, 'wx', 0o600);
    // Pin one descriptor and hash the bytes actually authenticated, not a later
    // pathname lookup that could refer to a replaced backup.
    for await (const chunk of fs.createReadStream(file, {fd, autoClose: false, start: header.length, end: size - 17})) {
      hash.update(chunk);
      writeAll(output, decrypt.update(chunk));
    }
    writeAll(output, decrypt.final());
    hash.update(tag);
    fs.fsyncSync(output);
    fs.closeSync(output);
    output = undefined;
    const sourceSchema = inspectSqlite(temp.file),
      restored = new Store(temp.file, key);
    try {
      if (!restored.verifyAudit()) throw new MirrorError('BACKUP_AUDIT_FAILED', 'The restored audit chain is invalid.');
      for (const tenant of restored.listTenants())
        for (const connection of restored.listConnections(tenant)) restored.credentials(tenant, connection.id);
      restored.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      restored.close();
    }
    const schema = inspectSqlite(temp.file),
      receipt = {
        status: 'verified',
        restore_duration_ms: Math.ceil(performance.now() - restoreStarted),
        restore_scope: 'Disposable local copy; production RPO/RTO and remote-write reconciliation are not established.',
        verified_at: Date.now(),
        encrypted_bytes: size,
        sha256: hash.digest('hex'),
        source_schema_version: sourceSchema,
        schema_version: schema,
        message:
          'Disposable restoration passed SQLite integrity, audit-chain and connection decryption checks. Store a copy off-host and keep its master key separately.',
      };
    return await consume(temp.file, receipt);
  } catch (e) {
    failure =
      e instanceof MirrorError
        ? e
        : new MirrorError(
            'BACKUP_DECRYPT_FAILED',
            'Backup authentication or restoration failed. Check the matching master key and file.',
          );
    throw failure;
  } finally {
    if (output !== undefined) fs.closeSync(output);
    fs.closeSync(fd);
    await temp?.clean(failure?.code);
  }
}

/** Verify on a disposable copy staged under `tmpdir` (default AMCP_BACKUP_TMPDIR, else the OS temporary directory). */
export async function verifyEncryptedBackup(file: string, key: string | undefined, tmpdir?: string) {
  return withVerifiedBackup(file, key, stagingParent(tmpdir), async (_snapshot, receipt) => receipt);
}

/** Publish only an authenticated, verified snapshot to a previously absent path.
 * The application configuration and running database are never opened or changed. */
export async function restoreEncryptedBackup(file: string, destination: string, key: string | undefined) {
  if (typeof destination !== 'string' || !destination.trim() || destination === ':memory:')
    throw new MirrorError('BACKUP_PATH_REQUIRED', 'Choose a new SQLite file in an existing private directory.');
  let target: string;
  try {
    target = path.join(fs.realpathSync(path.dirname(path.resolve(destination))), path.basename(destination));
  } catch {
    throw new MirrorError(
      'BACKUP_PATH_REQUIRED',
      'The restore destination needs an existing accessible parent directory.',
    );
  }
  const absent = () => {
    for (const name of [target, target + '-wal', target + '-shm', target + '-journal'])
      try {
        fs.lstatSync(name);
        throw new MirrorError(
          'BACKUP_DESTINATION_EXISTS',
          'The restore destination or a SQLite sidecar already exists. Nothing was overwritten.',
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
  };
  absent();
  return withVerifiedBackup(file, key, path.dirname(target), async (snapshot, receipt) => {
    const snapshotHash = await hashFile(snapshot),
      fd = fs.openSync(snapshot, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // Same-filesystem hard-link publication is atomic and refuses existing files,
    // directories and dangling symlinks, including a competing restore's result.
    absent();
    try {
      fs.linkSync(snapshot, target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST')
        throw new MirrorError(
          'BACKUP_DESTINATION_EXISTS',
          'The restore destination appeared during verification. Nothing was overwritten.',
        );
      throw new MirrorError(
        'BACKUP_RESTORE_FAILED',
        'The destination filesystem could not atomically publish the restored file. Use a local filesystem supporting hard links; no copy-overwrite fallback was attempted.',
      );
    }
    let directorySynced = false;
    if (process.platform !== 'win32') {
      let dir: number | undefined;
      try {
        dir = fs.openSync(path.dirname(target), 'r');
        fs.fsyncSync(dir);
        directorySynced = true;
      } catch {
        /* Some filesystems do not expose directory fsync; report that limit. */
      } finally {
        if (dir !== undefined) fs.closeSync(dir);
      }
    }
    return {
      ...receipt,
      status: 'restored',
      destination: target,
      snapshot_sha256: snapshotHash,
      durability: {file_synced: true, directory_synced: directorySynced},
      requires_reconciliation: true,
      application_started: false,
      restore_scope:
        'A verified offline SQLite copy only. Current configuration and the running database were not opened. Jobs, schedules, provider writes, grants and sessions newer than this backup must be reconciled before activation.',
      message:
        'Keep the restored database private and offline. Stop all original writers before any deliberate switch; use the same master key and review post-backup changes before starting workers or enabling writes.',
    };
  });
}

/**
 * Refuses a backup that cannot complete or would not protect the data (OPS-04): a destination on the database's own
 * volume in production, and too little free space. The estimate is three database sizes (page_count x page_size) in
 * the staging directory (the snapshot, VACUUM's working copy and WAL, then the verification copy) and one in the
 * destination for the encrypted archive; when both share a device, three in total, since those phases do not overlap.
 */
function backupPreflight(store: Store, parent: string, destinationDir: string, options: BackupOptions) {
  const device = options.device ?? deviceOf,
    database = store.db.location(),
    sameVolume = database ? device(database) === device(destinationDir) : null,
    production = options.production ?? process.env.NODE_ENV === 'production';
  if (sameVolume && production && !options.allowSameVolume)
    throw new MirrorError(
      'BACKUP_SAME_VOLUME',
      'The backup destination is on the same volume as MIRROR_DB, so losing the volume would lose both. Write it outside the volume (for example under /tmp), copy it off-host and delete the local copy, or pass --allow-same-volume deliberately.',
      {destination_same_volume: true},
    );
  const pragma = (name: string) => Number((store.db.prepare('PRAGMA ' + name).get() as JsonObject)[name]),
    databaseBytes = pragma('page_count') * pragma('page_size'),
    stagingDevice = device(parent),
    shared = stagingDevice === device(destinationDir),
    requirements = shared
      ? [{directory: parent, role: 'staging and destination', bytes: 3 * databaseBytes}]
      : [
          {directory: parent, role: 'staging', bytes: 3 * databaseBytes},
          {directory: destinationDir, role: 'destination', bytes: databaseBytes},
        ];
  if (!options.skipSpaceCheck)
    for (const need of requirements) {
      const available = (options.freeBytes ?? freeBytesOf)(need.directory);
      if (available < need.bytes)
        throw new MirrorError(
          'BACKUP_SPACE_INSUFFICIENT',
          'The backup needs about ' +
            mib(need.bytes) +
            ' free in its ' +
            need.role +
            ' directory, but ' +
            mib(available) +
            ' is available. Free space, set AMCP_BACKUP_TMPDIR to a larger private directory, or pass --skip-space-check if the estimate (three database sizes for staging, one for the archive) is too high.',
          {role: need.role, required_bytes: need.bytes, available_bytes: available, database_bytes: databaseBytes},
        );
    }
  return {databaseBytes, sameVolume};
}

export async function createEncryptedBackup(
  store: Store,
  file: string,
  key: string | undefined,
  options: BackupOptions = {},
) {
  const started = performance.now(),
    secret = backupKey(key),
    parent = stagingParent(options.tmpdir);
  let destinationDir: string;
  try {
    destinationDir = fs.realpathSync(path.dirname(path.resolve(file)));
  } catch {
    throw new MirrorError(
      'BACKUP_PATH_REQUIRED',
      'The backup destination needs an existing accessible parent directory.',
    );
  }
  const preflight = backupPreflight(store, parent, destinationDir, options),
    temp = temporary(parent);
  let output: number | undefined,
    created = false,
    failureCode: string | undefined,
    steps = 1;
  try {
    // One step from one read snapshot (rate -1 copies every page at once). The default 100 pages per step restarts
    // whenever another connection writes between steps, so a busy site could keep a backup from ever finishing.
    await backup(store.db, temp.file, {rate: -1, progress: () => void steps++});
    // A backup must not turn a 30-minute website upload into a permanent copy.
    // Only the disposable snapshot is edited; the running database and provider assets are untouched.
    const snapshot = new DatabaseSync(temp.file);
    try {
      // Chunks go one row per statement, so the strip's log stays about one chunk rather than every file (OPS-01).
      snapshot.exec('PRAGMA secure_delete=ON; PRAGMA journal_size_limit=' + JOURNAL_SIZE_LIMIT_BYTES + ';');
      deleteRowsOneByOne(snapshot, 'media_chunks', 'SELECT rowid AS r FROM media_chunks LIMIT 1');
      deleteRowsOneByOne(
        snapshot,
        'retained_media_chunks',
        "SELECT c.rowid AS r FROM retained_media_chunks c WHERE EXISTS(SELECT 1 FROM documents d WHERE d.kind='retained_media_source' AND d.tenant_id=c.tenant_id AND d.id=c.id AND json_extract(d.data,'$.origin')='upload') LIMIT 1",
      );
      snapshot.exec(`DELETE FROM media_staging;
        DELETE FROM media_admissions;
        DELETE FROM retained_media WHERE EXISTS(SELECT 1 FROM documents d WHERE d.kind='retained_media_source' AND d.tenant_id=retained_media.tenant_id AND d.id=retained_media.id AND json_extract(d.data,'$.origin')='upload');
        DELETE FROM documents WHERE kind IN ('media_source','media_variant','upload_session') OR (kind='retained_media_source' AND json_extract(data,'$.origin')='upload');
        VACUUM;`);
    } finally {
      snapshot.close();
    }
    output = fs.openSync(file, 'wx', 0o600);
    created = true;
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', secret, nonce);
    cipher.setAAD(magic);
    writeAll(output, Buffer.concat([magic, nonce]));
    for await (const chunk of fs.createReadStream(temp.file)) writeAll(output, cipher.update(chunk));
    writeAll(output, cipher.final());
    writeAll(output, cipher.getAuthTag());
    fs.fsyncSync(output);
    fs.closeSync(output);
    output = undefined;
    const snapshotBytes = fs.statSync(temp.file).size,
      receipt: JsonObject = {
        ...(await verifyEncryptedBackup(file, key, parent)),
        created_at: new Date().toISOString(),
        duration_ms: Math.ceil(performance.now() - started),
        database_bytes: preflight.databaseBytes,
        snapshot_bytes: snapshotBytes,
        backup_steps: steps,
        destination_same_volume: preflight.sameVolume,
        space_check: options.skipSpaceCheck ? 'skipped' : 'passed',
      },
      id = randomUUID();
    for (const tenant of store.listTenants()) store.putDocument(tenant, 'backup_receipt', id, receipt);
    return receipt;
  } catch (e) {
    failureCode = e instanceof MirrorError ? e.code : 'BACKUP_IO_FAILED';
    if (output !== undefined) {
      fs.closeSync(output);
      output = undefined;
    }
    if (created && fs.existsSync(file)) fs.unlinkSync(file);
    throw e;
  } finally {
    await temp.clean(failureCode);
  }
}

// Owner health reads the newest receipt from its own module, so that the reviewed-write path (owner health's module
// holds the write pause) never loads the backup and restore code.
export {lastBackupReceipt} from './backup-receipt.js';

/**
 * A rehearsed restore (OPS-04): restores an encrypted backup to a new file exactly as backup-restore does, then reads
 * the restored copy (read-only) for what an owner needs to decide on a switch: the recovery time measured end to end,
 * the recovery point (the newest audit event or job update the copy holds) and what must be reconciled. It never opens
 * the configured database, starts workers or contacts a provider. The record holds counts only, never secrets.
 */
export async function restoreDrill(file: string, destination: string, key: string | undefined) {
  const started = performance.now(),
    drilledAt = Date.now();
  const restored: JsonObject = await restoreEncryptedBackup(file, destination, key),
    recoveryTime = Math.ceil(performance.now() - started);
  const db = new DatabaseSync(String(restored.destination), {readOnly: true});
  let counts: JsonObject, newest: number | null;
  try {
    const count = (sql: string) => Number((db.prepare(sql).get() as {n: number}).n);
    counts = {
      workspaces: count('SELECT count(*) AS n FROM tenants'),
      connections: count('SELECT count(*) AS n FROM connections'),
      documents: count('SELECT count(*) AS n FROM documents'),
      audit_events: count('SELECT count(*) AS n FROM audit'),
      queued_jobs: count("SELECT count(*) AS n FROM jobs WHERE state='queued'"),
      running_jobs: count("SELECT count(*) AS n FROM jobs WHERE state='running'"),
      uncertain_writes: count("SELECT count(*) AS n FROM idempotency WHERE state='uncertain'"),
    };
    // Multi-argument max() is NULL when any argument is; an empty table counts as no activity.
    const latest = Number(
      (
        db
          .prepare(
            'SELECT max(coalesce((SELECT max(created_at) FROM audit),0),coalesce((SELECT max(updated_at) FROM jobs),0)) AS at',
          )
          .get() as {at: number}
      ).at,
    );
    newest = Number.isFinite(latest) && latest > 0 ? latest : null;
  } finally {
    db.close();
  }
  return {
    record_kind: 'amcp_restore_drill',
    schema_version: 1,
    drilled_at: new Date(drilledAt).toISOString(),
    backup_sha256: restored.sha256,
    restored_sha256: restored.snapshot_sha256,
    destination: restored.destination,
    recovery_time_ms: recoveryTime,
    verification_ms: restored.restore_duration_ms,
    recovery_point: {
      newest_recorded_activity_at: newest === null ? null : new Date(newest).toISOString(),
      age_ms: newest === null ? null : Math.max(0, drilledAt - newest),
      basis:
        'The newest audit event or job update in the restored copy. Changes after it are not in the backup and must be reconciled.',
    },
    counts,
    requires_reconciliation: true,
    application_started: false,
    scope:
      'A local drill of an AMCP encrypted backup. It measures restore and verification on this host only; a Railway volume restore is timed separately by the owner (docs/OPERATIONS.md, "Restore drill").',
    next_steps: [
      'Keep the restored copy private and offline; start it only with MIRROR_ALLOW_WRITES=false and AMCP_RUN_WORKER=false.',
      'Reconcile queued and running jobs, uncertain writes and provider changes made after the recovery point before enabling writes or workers.',
      'Delete the restored copy and any scratch service after the drill.',
    ],
  };
}

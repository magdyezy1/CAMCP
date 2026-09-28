import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {backup, DatabaseSync} from 'node:sqlite';
import {createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID} from 'node:crypto';
import {Store} from './store.js';
import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';

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
function temporary(parent = os.tmpdir()) {
  const root = path.resolve(parent),
    dir = fs.mkdtempSync(path.join(root, 'amcp-backup-'));
  return {
    file: path.join(dir, 'snapshot.sqlite'),
    clean() {
      const target = path.resolve(dir);
      if (
        path.dirname(target) !== root ||
        !path.basename(target).startsWith('amcp-backup-') ||
        fs.lstatSync(target).isSymbolicLink()
      )
        throw new MirrorError('BACKUP_CLEANUP_FAILED', 'Refusing to clean an unexpected backup staging directory.');
      fs.rmSync(target, {recursive: true, force: true, maxRetries: 5, retryDelay: 50});
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
  let temp: ReturnType<typeof temporary> | undefined, output: number | undefined;
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
    if (e instanceof MirrorError) throw e;
    throw new MirrorError(
      'BACKUP_DECRYPT_FAILED',
      'Backup authentication or restoration failed. Check the matching master key and file.',
    );
  } finally {
    if (output !== undefined) fs.closeSync(output);
    fs.closeSync(fd);
    temp?.clean();
  }
}

export async function verifyEncryptedBackup(file: string, key: string | undefined) {
  return withVerifiedBackup(file, key, undefined, async (_snapshot, receipt) => receipt);
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

export async function createEncryptedBackup(store: Store, file: string, key: string | undefined) {
  const secret = backupKey(key),
    temp = temporary();
  let output: number | undefined,
    created = false;
  try {
    await backup(store.db, temp.file);
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
    const receipt = await verifyEncryptedBackup(file, key),
      id = randomUUID();
    for (const tenant of store.listTenants()) store.putDocument(tenant, 'backup_receipt', id, receipt);
    return receipt;
  } catch (e) {
    if (output !== undefined) {
      fs.closeSync(output);
      output = undefined;
    }
    if (created && fs.existsSync(file)) fs.unlinkSync(file);
    throw e;
  } finally {
    temp.clean();
  }
}

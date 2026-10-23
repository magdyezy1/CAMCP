import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createCipheriv, createHash, randomBytes} from 'node:crypto';
import {DatabaseSync, backup} from 'node:sqlite';
import * as backups from '../dist/src/backup.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {Registry} from '../dist/src/catalog.js';
import {removeTestDirectory} from '../dist/tests/temp.js';
import {runAdmin} from '../dist/tests/admin-cli.js';

const key = Buffer.alloc(32, 67).toString('base64'),
  actor = {tenantId: 'backup', userId: 'operator', role: 'admin'};
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-backup-recovery-')),
    source = path.join(dir, 'source.amcp'),
    store = new Store(':memory:', key);
  store.ensureTenant(actor.tenantId);
  store.putConnection(
    actor,
    {
      id: 'selected',
      tenantId: actor.tenantId,
      gateway: 'x_ads_native_action',
      accounts: ['abc'],
      scopes: [],
      enabled: true,
      label: 'Synthetic',
    },
    {accessToken: 'synthetic-private-token'},
  );
  store.putDocument(actor.tenantId, 'fixture', 'original', {value: 'committed-source'});
  store.appendAudit(actor.tenantId, 'fixture', {event: 'synthetic_checkpoint'});
  await backups.createEncryptedBackup(store, source, key);
  return {
    dir,
    source,
    store,
    target: path.join(dir, 'restored.sqlite'),
    close() {
      store.close();
      removeTestDirectory(dir, 'amcp-backup-recovery-');
    },
  };
}
test('Backup verification CLI never opens or creates MIRROR_DB', async () => {
  const f = await fixture();
  try {
    const unrelated = path.join(f.dir, 'must-not-exist.sqlite'),
      run = runAdmin(['backup-verify', f.source], {
        encoding: 'utf8',
        env: {...process.env, MIRROR_DB: unrelated, MIRROR_MASTER_KEY: key},
        timeout: 15000,
      });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).status, 'verified');
    assert.equal(fs.existsSync(unrelated), false, 'A verification-only command created the configured database');
  } finally {
    f.close();
  }
});
test('Encrypted backup restores a verified new SQLite file without changing the source', async () => {
  const f = await fixture();
  try {
    assert.equal(typeof backups.restoreEncryptedBackup, 'function');
    const before = fs.readFileSync(f.source),
      receipt = await backups.restoreEncryptedBackup(f.source, f.target, key);
    assert.equal(receipt.status, 'restored');
    assert.equal(receipt.destination, path.resolve(f.target));
    assert.equal(receipt.requires_reconciliation, true);
    assert.deepEqual(fs.readFileSync(f.source), before);
    const restored = new Store(f.target, key);
    try {
      assert.equal(restored.verifyAudit(), true);
      assert.equal(restored.credentials(actor.tenantId, 'selected').accessToken, 'synthetic-private-token');
      assert.equal(restored.document(actor.tenantId, 'fixture', 'original').value, 'committed-source');
    } finally {
      restored.close();
    }
    assert.equal(f.store.document(actor.tenantId, 'fixture', 'original').value, 'committed-source');
    assert.equal(JSON.stringify(receipt).includes('synthetic-private-token'), false);
  } finally {
    f.close();
  }
});
test('Backup restore CLI remains offline even with a corrupt configured database', async () => {
  const f = await fixture();
  try {
    const unrelated = path.join(f.dir, 'corrupt-current.sqlite'),
      sentinel = Buffer.from('This file must not be opened as SQLite.');
    fs.writeFileSync(unrelated, sentinel);
    const run = runAdmin(['backup-restore', f.source, f.target], {
      encoding: 'utf8',
      env: {...process.env, MIRROR_DB: unrelated, MIRROR_MASTER_KEY: key},
      timeout: 15000,
    });
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.status, 'restored');
    assert.equal(receipt.requires_reconciliation, true);
    assert.equal(receipt.application_started, false);
    assert.deepEqual(fs.readFileSync(unrelated), sentinel);
    assert.equal(fs.existsSync(unrelated + '-wal'), false);
    assert.equal(receipt.sha256, createHash('sha256').update(fs.readFileSync(f.source)).digest('hex'));
    assert.equal(receipt.snapshot_sha256, createHash('sha256').update(fs.readFileSync(f.target)).digest('hex'));
    assert.equal(receipt.durability.file_synced, true);
    assert.equal(
      fs.readdirSync(f.dir).some(x => x.startsWith('amcp-backup-')),
      false,
    );
  } finally {
    f.close();
  }
});
test('Backup restore refuses existing files, directories, hard links, sources and orphaned SQLite sidecars', async () => {
  for (const mode of ['file', 'directory', 'hardlink', 'source', 'wal', 'shm', 'journal']) {
    const f = await fixture();
    try {
      const sentinel = Buffer.from('existing contents'),
        target = mode === 'source' ? f.source : f.target;
      let preserved = target;
      if (mode === 'directory') fs.mkdirSync(target);
      else if (mode === 'hardlink') fs.linkSync(f.source, target);
      else if (mode === 'file') fs.writeFileSync(target, sentinel);
      else if (mode !== 'source') {
        preserved = target + '-' + mode;
        fs.writeFileSync(preserved, sentinel);
      }
      const before = mode === 'directory' ? undefined : fs.readFileSync(preserved);
      await assert.rejects(() => backups.restoreEncryptedBackup(f.source, target, key), {
        code: 'BACKUP_DESTINATION_EXISTS',
      });
      if (before) assert.deepEqual(fs.readFileSync(preserved), before);
      assert.equal(
        fs.readdirSync(f.dir).some(x => x.startsWith('amcp-backup-')),
        false,
      );
    } finally {
      f.close();
    }
  }
});
test('Concurrent backup restores publish exactly one verified file and never replace the winner', async () => {
  const f = await fixture();
  try {
    const results = await Promise.allSettled([
      backups.restoreEncryptedBackup(f.source, f.target, key),
      backups.restoreEncryptedBackup(f.source, f.target, key),
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const rejected = results.find(r => r.status === 'rejected');
    assert.equal(rejected.reason.code, 'BACKUP_DESTINATION_EXISTS');
    const good = results.find(r => r.status === 'fulfilled').value;
    assert.equal(createHash('sha256').update(fs.readFileSync(f.target)).digest('hex'), good.snapshot_sha256);
    assert.equal(
      fs.readdirSync(f.dir).some(x => x.startsWith('amcp-backup-')),
      false,
    );
  } finally {
    f.close();
  }
});
test('Backup publication refuses a late competing file and unsupported hard links without partial output', async t => {
  for (const mode of ['race', 'unsupported']) {
    const f = await fixture(),
      original = fs.linkSync;
    try {
      t.mock.method(fs, 'linkSync', (source, target) => {
        if (mode === 'race') {
          fs.writeFileSync(target, 'competing writer');
          return original(source, target);
        }
        const error = new Error('Synthetic unsupported links');
        error.code = 'ENOTSUP';
        throw error;
      });
      await assert.rejects(() => backups.restoreEncryptedBackup(f.source, f.target, key), {
        code: mode === 'race' ? 'BACKUP_DESTINATION_EXISTS' : 'BACKUP_RESTORE_FAILED',
      });
      if (mode === 'race') assert.equal(fs.readFileSync(f.target, 'utf8'), 'competing writer');
      else assert.equal(fs.existsSync(f.target), false);
      assert.equal(
        fs.readdirSync(f.dir).some(x => x.startsWith('amcp-backup-')),
        false,
      );
    } finally {
      t.mock.restoreAll();
      f.close();
    }
  }
});
test('Wrong keys and truncated/tampered encrypted backups never publish plaintext and clean staging', async () => {
  for (const mode of ['key', 'magic', 'header', 'tag', 'ciphertext', 'truncated']) {
    const f = await fixture();
    try {
      const bytes = fs.readFileSync(f.source);
      if (mode === 'magic') bytes[0] ^= 1;
      if (mode === 'header') bytes[18] ^= 1;
      if (mode === 'tag') bytes[bytes.length - 1] ^= 1;
      if (mode === 'ciphertext') bytes[100] ^= 1;
      if (mode !== 'key') fs.writeFileSync(f.source, mode === 'truncated' ? bytes.subarray(0, 20) : bytes);
      await assert.rejects(() =>
        backups.restoreEncryptedBackup(
          f.source,
          f.target,
          mode === 'key' ? Buffer.alloc(32, 68).toString('base64') : key,
        ),
      );
      assert.equal(fs.existsSync(f.target), false);
      assert.equal(
        fs.readdirSync(f.dir).some(x => x.startsWith('amcp-backup-')),
        false,
      );
      assert.equal(f.store.verifyAudit(), true);
    } finally {
      f.close();
    }
  }
});
function encrypted(file, bytes) {
  const magic = Buffer.from('AMCP-BACKUP-1\n'),
    nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), nonce);
  cipher.setAAD(magic);
  fs.writeFileSync(file, Buffer.concat([magic, nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]));
}
test('Backup staging cleanup yields between bounded transient Windows failures and removes the verified copy', async t => {
  const f = await fixture(),
    remove = fs.promises.rm.bind(fs.promises);
  let attempts = 0,
    yielded = false;
  const busy = () => Object.assign(Error('synthetic staging lock'), {code: 'EPERM'});
  try {
    t.mock.method(fs, 'rmSync', () => {
      throw busy();
    });
    t.mock.method(fs.promises, 'rm', async (target, options) => {
      assert.equal(path.dirname(path.resolve(target)), path.resolve(f.dir));
      assert.match(path.basename(target), /^amcp-backup-/);
      if (++attempts === 1) {
        setImmediate(() => {
          yielded = true;
        });
        throw busy();
      }
      assert.equal(yielded, true);
      return remove(target, options);
    });
    const result = await backups.restoreEncryptedBackup(f.source, f.target, key);
    assert.equal(result.status, 'restored');
    assert.equal(attempts, 2);
    assert.equal(
      fs.readdirSync(f.dir).some(name => name.startsWith('amcp-backup-')),
      false,
    );
    const restored = new DatabaseSync(f.target, {readOnly: true});
    try {
      assert.equal(restored.isOpen, true);
    } finally {
      restored.close();
    }
  } finally {
    t.mock.restoreAll();
    f.close();
  }
});

test('Permanent backup cleanup failure is explicit, bounded and preserves the primary verification failure code', async t => {
  const f = await fixture();
  let attempts = 0;
  try {
    const bytes = fs.readFileSync(f.source);
    bytes[bytes.length - 1] ^= 1;
    fs.writeFileSync(f.source, bytes);
    const busy = () => Object.assign(Error('PRIVATE system lock'), {code: 'EPERM'});
    t.mock.method(fs, 'rmSync', () => {
      throw busy();
    });
    t.mock.method(fs.promises, 'rm', async () => {
      attempts++;
      throw busy();
    });
    await assert.rejects(backups.restoreEncryptedBackup(f.source, f.target, key), error => {
      assert.equal(error.code, 'BACKUP_CLEANUP_FAILED');
      assert.equal(error.details.primary_error_code, 'BACKUP_DECRYPT_FAILED');
      assert.equal(error.details.cleanup_required, true);
      assert.equal(error.details.operation_completed, false);
      assert.equal(path.dirname(error.details.staging_directory), path.resolve(f.dir));
      assert.doesNotMatch(error.message, /PRIVATE/);
      return true;
    });
    assert.equal(attempts, 6);
    assert.equal(fs.existsSync(f.target), false);
  } finally {
    t.mock.restoreAll();
    f.close();
  }
});

test('A published restore remains visible when later cleanup fails and the diagnostic prevents blind retry', async t => {
  const f = await fixture();
  try {
    t.mock.method(fs.promises, 'rm', async () => {
      throw Object.assign(Error('synthetic lock'), {code: 'EBUSY'});
    });
    await assert.rejects(backups.restoreEncryptedBackup(f.source, f.target, key), error => {
      assert.equal(error.code, 'BACKUP_CLEANUP_FAILED');
      assert.equal(error.details.operation_completed, true);
      assert.equal(error.details.primary_error_code, null);
      return true;
    });
    assert.equal(fs.existsSync(f.target), true);
    const restored = new Store(f.target, key);
    try {
      assert.equal(restored.verifyAudit(), true);
    } finally {
      restored.close();
    }
  } finally {
    t.mock.restoreAll();
    f.close();
  }
});

test('Authenticated non-AMCP, corrupted SQLite, future schema and broken audit backups fail verification', async () => {
  for (const mode of ['empty_schema', 'not_sqlite', 'future', 'audit']) {
    const f = await fixture();
    try {
      const plain = path.join(f.dir, 'synthetic.sqlite');
      if (mode === 'not_sqlite') fs.writeFileSync(plain, 'not a SQLite file');
      else {
        if (mode !== 'empty_schema') await backup(f.store.db, plain);
        const db = new DatabaseSync(plain);
        try {
          if (mode === 'empty_schema') db.exec('CREATE TABLE unrelated(value TEXT)');
          if (mode === 'future') db.exec('UPDATE schema_version SET version=999');
          if (mode === 'audit') db.exec("DROP TRIGGER audit_no_update; UPDATE audit SET event='{}'");
        } finally {
          db.close();
        }
      }
      encrypted(f.source, fs.readFileSync(plain));
      await assert.rejects(() => backups.restoreEncryptedBackup(f.source, f.target, key), {
        code: {
          empty_schema: 'BACKUP_SCHEMA_INVALID',
          not_sqlite: 'BACKUP_INTEGRITY_FAILED',
          future: 'SCHEMA_VERSION_MISMATCH',
          audit: 'BACKUP_AUDIT_FAILED',
        }[mode],
      });
      assert.equal(fs.existsSync(f.target), false);
      assert.equal(
        fs.readdirSync(f.dir).some(x => x.startsWith('amcp-backup-')),
        false,
      );
    } finally {
      f.close();
    }
  }
});
test('Backup source replacement cannot change the authenticated bytes or their receipt hash', async t => {
  const f = await fixture(),
    original = fs.createReadStream;
  try {
    const before = fs.readFileSync(f.source),
      expectedHash = createHash('sha256').update(before).digest('hex'),
      other = path.join(f.dir, 'newer.amcp');
    f.store.putDocument(actor.tenantId, 'fixture', 'original', {value: 'newer-copy'});
    await backups.createEncryptedBackup(f.store, other, key);
    let swapped = false;
    t.mock.method(fs, 'createReadStream', (file, options) => {
      if (!swapped && file === f.source && options?.fd !== undefined) {
        swapped = true;
        fs.renameSync(f.source, path.join(f.dir, 'held-original.amcp'));
        fs.copyFileSync(other, f.source);
      }
      return original(file, options);
    });
    const out = await backups.restoreEncryptedBackup(f.source, f.target, key);
    assert.equal(swapped, true);
    assert.equal(out.sha256, expectedHash);
    assert.notEqual(out.sha256, createHash('sha256').update(fs.readFileSync(f.source)).digest('hex'));
    const restored = new Store(f.target, key);
    try {
      assert.equal(restored.document(actor.tenantId, 'fixture', 'original').value, 'committed-source');
    } finally {
      restored.close();
    }
  } finally {
    t.mock.restoreAll();
    f.close();
  }
});
test('Backup encryption and restoration handle short filesystem writes without truncating data', async t => {
  const f = await fixture(),
    original = fs.writeSync;
  let shortWrites = 0;
  try {
    t.mock.method(fs, 'writeSync', (fd, buffer, offset, length) => {
      const bounded = Math.min(length, 4096);
      if (bounded < length) shortWrites++;
      return original(fd, buffer, offset, bounded);
    });
    const archive = path.join(f.dir, 'short-writes.amcp');
    await backups.createEncryptedBackup(f.store, archive, key);
    const out = await backups.restoreEncryptedBackup(archive, f.target, key);
    assert.equal(out.status, 'restored');
    assert.ok(shortWrites > 0);
    const db = new Store(f.target, key);
    try {
      assert.equal(db.verifyAudit(), true);
      assert.equal(db.document(actor.tenantId, 'fixture', 'original').value, 'committed-source');
    } finally {
      db.close();
    }
  } finally {
    t.mock.restoreAll();
    f.close();
  }
});
test('Invalid recovery CLI arguments never create or inspect a configured database', async () => {
  const f = await fixture();
  try {
    const unrelated = path.join(f.dir, 'must-not-exist.sqlite');
    for (const args of [
      ['backup-verify'],
      ['backup-verify', f.source, 'extra'],
      ['backup-restore', f.source],
      ['backup-restore', f.source, f.target, 'extra'],
    ]) {
      const run = runAdmin(args, {
        encoding: 'utf8',
        env: {...process.env, MIRROR_DB: unrelated, MIRROR_MASTER_KEY: key},
        timeout: 15000,
      });
      assert.equal(run.status, 1);
      assert.match(run.stderr, /BACKUP_PATH_REQUIRED/);
      assert.equal(fs.existsSync(unrelated), false);
      assert.equal(fs.existsSync(f.target), false);
    }
  } finally {
    f.close();
  }
});
test('Restoration preserves unresolved jobs and idempotency history without starting or completing them', async () => {
  const f = await fixture();
  try {
    f.store.claim(actor.tenantId, 'uncertain-write', 'frozen');
    f.store.uncertain(actor.tenantId, 'uncertain-write');
    const job = f.store.enqueue(actor.tenantId, 'media_upload', {review_id: 'synthetic-review'});
    f.store.putDocument(actor.tenantId, 'report_delivery_schedule', 'synthetic-schedule', {
      enabled: true,
      spreadsheet_id: 'synthetic',
    });
    const archive = path.join(f.dir, 'pending.amcp');
    await backups.createEncryptedBackup(f.store, archive, key);
    const receipt = await backups.restoreEncryptedBackup(archive, f.target, key);
    assert.equal(receipt.application_started, false);
    assert.equal(receipt.requires_reconciliation, true);
    const restored = new Store(f.target, key);
    try {
      assert.equal(restored.job(actor.tenantId, job).state, 'queued');
      assert.equal(
        restored.db.prepare('SELECT state FROM idempotency WHERE key=?').get('uncertain-write').state,
        'uncertain',
      );
      assert.equal(restored.document(actor.tenantId, 'report_delivery_schedule', 'synthetic-schedule').enabled, true);
      assert.equal(restored.verifyAudit(), true);
    } finally {
      restored.close();
    }
  } finally {
    f.close();
  }
});
test('Restore refuses a snapshot with connection secrets encrypted under a different master key', async () => {
  const f = await fixture();
  try {
    const plain = path.join(f.dir, 'mixed.sqlite');
    await backup(f.store.db, plain);
    const db = new DatabaseSync(plain);
    try {
      db.prepare('UPDATE connections SET secret=?').run('not-a-valid-ciphertext');
    } finally {
      db.close();
    }
    encrypted(f.source, fs.readFileSync(plain));
    await assert.rejects(() => backups.restoreEncryptedBackup(f.source, f.target, key));
    assert.equal(fs.existsSync(f.target), false);
    assert.equal(
      fs.readdirSync(f.dir).some(x => x.startsWith('amcp-backup-')),
      false,
    );
  } finally {
    f.close();
  }
});
test('A process interruption before atomic publication leaves no destination or changed source', async () => {
  const f = await fixture();
  try {
    const hook = path.join(f.dir, 'interrupt.mjs');
    fs.writeFileSync(hook, "import fs from 'node:fs'; fs.linkSync=()=>process.exit(73);\n");
    const before = fs.readFileSync(f.source),
      unrelated = path.join(f.dir, 'must-not-exist.sqlite'),
      run = runAdmin(
        ['backup-restore', f.source, f.target],
        {env: {...process.env, MIRROR_DB: unrelated, MIRROR_MASTER_KEY: key}, timeout: 15000},
        ['--import', pathToFileURL(hook).href],
      );
    assert.equal(run.status, 73, run.stderr);
    assert.equal(fs.existsSync(f.target), false);
    assert.equal(fs.existsSync(unrelated), false);
    assert.deepEqual(fs.readFileSync(f.source), before);
    const staged = fs.readdirSync(f.dir).filter(n => n.startsWith('amcp-backup-'));
    assert.equal(staged.length, 1);
    const stat = fs.statSync(path.join(f.dir, staged[0], 'snapshot.sqlite'));
    if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600);
    assert.equal((await backups.verifyEncryptedBackup(f.source, key)).status, 'verified');
  } finally {
    f.close();
  }
});

// OPS-04: an online backup copied 100 pages per step and restarted whenever another connection wrote between steps, so
// a busy site could keep a backup from ever completing. The copy is now one step from one read snapshot.
const writerScript = `
const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
db.exec('PRAGMA busy_timeout=10000');
const insert = db.prepare("INSERT INTO documents(tenant_id,kind,id,data,revision) VALUES('backup','writer_probe',?,'{}',1)");
let n = 0;
const timer = setInterval(() => { insert.run(String(++n)); process.stdout.write(n + '\\n'); }, 100);
process.stdin.on('data', () => { clearInterval(timer); db.close(); process.exit(0); });
`;
function fileStore(prefix = 'amcp-backup-writer-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
    database = path.join(dir, 'live.sqlite'),
    store = new Store(database, key);
  store.ensureTenant(actor.tenantId);
  store.putConnection(
    actor,
    {
      id: 'selected',
      tenantId: actor.tenantId,
      gateway: 'x_ads_native_action',
      accounts: ['abc'],
      scopes: [],
      enabled: true,
      label: 'Synthetic',
    },
    {accessToken: 'synthetic-private-token'},
  );
  store.appendAudit(actor.tenantId, 'fixture', {event: 'synthetic_checkpoint'});
  return {
    dir,
    database,
    store,
    close() {
      store.close();
      removeTestDirectory(dir, prefix);
    },
  };
}
test('a backup completes in one step while another process writes ten times per second', async () => {
  const f = fileStore();
  let writer;
  try {
    // About 16 MiB of committed rows, so the old 100-page steps would need over 40 uninterrupted steps.
    const insert = f.store.db.prepare('INSERT INTO documents(tenant_id,kind,id,data,revision) VALUES(?,?,?,?,1)');
    f.store.db.exec('BEGIN');
    for (let i = 0; i < 2000; i++)
      insert.run(actor.tenantId, 'bulk', String(i), JSON.stringify({pad: 'x'.repeat(8000)}));
    f.store.db.exec('COMMIT');
    writer = spawn(process.execPath, ['-e', writerScript, f.database], {stdio: ['pipe', 'pipe', 'inherit']});
    let writes = 0;
    writer.stdout.on('data', chunk => {
      writes = Math.max(writes, ...String(chunk).trim().split('\n').map(Number));
    });
    while (writes < 3) await new Promise(resolve => setTimeout(resolve, 50));
    const before = writes,
      archive = path.join(f.dir, 'busy.amcp'),
      started = Date.now(),
      receipt = await backups.createEncryptedBackup(f.store, archive, key, {tmpdir: f.dir});
    assert.equal(receipt.status, 'verified');
    assert.equal(receipt.backup_steps, 1);
    assert.ok(Date.now() - started < 60000);
    assert.ok(receipt.duration_ms > 0 && receipt.database_bytes >= 15 * 1048576 && receipt.snapshot_bytes > 0);
    assert.match(receipt.created_at, /^\d{4}-\d{2}-\d{2}T/);
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.ok(writes > before, 'the writer kept writing during the backup');
    const restored = await backups.restoreEncryptedBackup(archive, path.join(f.dir, 'restored.sqlite'), key);
    assert.equal(restored.status, 'restored');
  } finally {
    if (writer && writer.exitCode === null) {
      const exited = new Promise(resolve => writer.once('exit', resolve));
      writer.stdin.write('stop\n');
      await exited;
    }
    f.close();
  }
});
test('the space preflight refuses before writing anything, names the directory, and can be overridden', async () => {
  const f = fileStore('amcp-backup-space-');
  try {
    const archive = path.join(f.dir, 'space.amcp'),
      staging = () => fs.readdirSync(f.dir).filter(n => n.startsWith('amcp-backup-'));
    await assert.rejects(
      backups.createEncryptedBackup(f.store, archive, key, {tmpdir: f.dir, freeBytes: () => 4096}),
      error => {
        assert.equal(error.code, 'BACKUP_SPACE_INSUFFICIENT');
        assert.equal(error.details.role, 'staging and destination');
        assert.equal(error.details.required_bytes, 3 * error.details.database_bytes);
        assert.equal(error.details.available_bytes, 4096);
        return true;
      },
    );
    assert.equal(fs.existsSync(archive), false);
    assert.deepEqual(staging(), []);
    // Staging and destination on different devices are checked separately: three sizes and one size.
    const elsewhere = path.join(f.dir, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const device = file => (path.resolve(file).startsWith(path.resolve(elsewhere)) ? 2 : 1);
    await assert.rejects(
      backups.createEncryptedBackup(f.store, path.join(elsewhere, 'split.amcp'), key, {
        tmpdir: f.dir,
        device,
        freeBytes: dir => (path.resolve(dir).startsWith(path.resolve(elsewhere)) ? 1024 : Number.MAX_SAFE_INTEGER),
      }),
      error => error.code === 'BACKUP_SPACE_INSUFFICIENT' && error.details.role === 'destination',
    );
    const skipped = await backups.createEncryptedBackup(f.store, archive, key, {
      tmpdir: f.dir,
      freeBytes: () => 4096,
      skipSpaceCheck: true,
    });
    assert.equal(skipped.space_check, 'skipped');
    assert.deepEqual(staging(), []);
    await assert.rejects(
      backups.createEncryptedBackup(f.store, path.join(f.dir, 'x.amcp'), key, {tmpdir: path.join(f.dir, 'missing')}),
      {code: 'BACKUP_TMPDIR_UNAVAILABLE'},
    );
  } finally {
    f.close();
  }
});
test('in production a backup on the database volume is refused unless allowed, by the library and the CLI', async () => {
  const f = fileStore('amcp-backup-volume-');
  try {
    const archive = path.join(f.dir, 'same.amcp');
    await assert.rejects(backups.createEncryptedBackup(f.store, archive, key, {tmpdir: f.dir, production: true}), {
      code: 'BACKUP_SAME_VOLUME',
    });
    assert.equal(fs.existsSync(archive), false);
    const allowed = await backups.createEncryptedBackup(f.store, archive, key, {
      tmpdir: f.dir,
      production: true,
      allowSameVolume: true,
    });
    assert.equal(allowed.destination_same_volume, true);
    const offVolume = await backups.createEncryptedBackup(f.store, path.join(f.dir, 'other.amcp'), key, {
      tmpdir: f.dir,
      production: true,
      device: file => (path.resolve(file) === path.resolve(f.database) ? 7 : 8),
    });
    assert.equal(offVolume.destination_same_volume, false);
    // Outside production the same-volume copy is allowed and reported.
    const local = await backups.createEncryptedBackup(f.store, path.join(f.dir, 'local.amcp'), key, {tmpdir: f.dir});
    assert.equal(local.destination_same_volume, true);
    const env = {
      ...process.env,
      MIRROR_DB: f.database,
      MIRROR_MASTER_KEY: key,
      NODE_ENV: 'production',
      AMCP_BACKUP_TMPDIR: f.dir,
    };
    // runAdmin passes --allow-root, so the volume policy is exercised even when the Docker build runs the CLI as root.
    const refused = runAdmin(['backup', path.join(f.dir, 'cli.amcp')], {
      encoding: 'utf8',
      env,
      timeout: 30000,
    });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /BACKUP_SAME_VOLUME/);
    assert.equal(fs.existsSync(path.join(f.dir, 'cli.amcp')), false);
    const forced = runAdmin(['backup', path.join(f.dir, 'cli.amcp'), '--allow-same-volume'], {
      encoding: 'utf8',
      env,
      timeout: 30000,
    });
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(JSON.parse(forced.stdout).destination_same_volume, true);
  } finally {
    f.close();
  }
});
test('owner health shows the newest backup receipt by time with its age, not the last by random ID', async () => {
  const store = new Store(':memory:', key),
    service = new MirrorService(new Registry(), store),
    owner = {tenantId: 'backup-health', userId: 'owner', role: 'admin'};
  try {
    store.ensureTenant(owner.tenantId);
    const now = Date.now();
    store.putDocument(owner.tenantId, 'backup_receipt', 'ffffffff-0000-4000-8000-000000000000', {
      status: 'verified',
      verified_at: now - 30 * 86400000,
    });
    store.putDocument(owner.tenantId, 'backup_receipt', '00000000-0000-4000-8000-000000000000', {
      status: 'verified',
      verified_at: now - 2 * 3600000,
    });
    const health = await service.call('amcp_workspace', {action: 'health'}, owner);
    assert.equal(health.success, true, JSON.stringify(health));
    assert.equal(health.data.backup.verified_at, now - 2 * 3600000);
    assert.ok(health.data.backup.age_hours >= 2 && health.data.backup.age_hours < 2.5);
    assert.equal(backups.lastBackupReceipt(store, 'no-backups'), undefined);
  } finally {
    store.close();
  }
});
test('a restore drill records recovery time, recovery point and what to reconcile without secrets or MIRROR_DB', async () => {
  const f = await fixture();
  try {
    f.store.enqueue(actor.tenantId, 'media_upload', {review_id: 'synthetic-review'});
    const archive = path.join(f.dir, 'drill.amcp');
    await backups.createEncryptedBackup(f.store, archive, key);
    const drill = await backups.restoreDrill(archive, f.target, key);
    assert.equal(drill.record_kind, 'amcp_restore_drill');
    assert.ok(Number.isInteger(drill.recovery_time_ms) && drill.recovery_time_ms >= drill.verification_ms);
    assert.equal(drill.backup_sha256, createHash('sha256').update(fs.readFileSync(archive)).digest('hex'));
    assert.equal(drill.restored_sha256, createHash('sha256').update(fs.readFileSync(f.target)).digest('hex'));
    assert.match(drill.recovery_point.newest_recorded_activity_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(drill.recovery_point.age_ms >= 0);
    assert.deepEqual(
      [drill.counts.workspaces, drill.counts.connections, drill.counts.queued_jobs, drill.counts.audit_events > 0],
      [1, 1, 1, true],
    );
    assert.equal(drill.requires_reconciliation, true);
    assert.equal(drill.application_started, false);
    assert.equal(JSON.stringify(drill).includes('synthetic-private-token'), false);
    // The CLI keeps the record in a new private file and never opens MIRROR_DB.
    const unrelated = path.join(f.dir, 'must-not-exist.sqlite'),
      record = path.join(f.dir, 'drill-record.json'),
      env = {...process.env, MIRROR_DB: unrelated, MIRROR_MASTER_KEY: key},
      run = runAdmin(['backup-drill', archive, path.join(f.dir, 'drill-2.sqlite'), '--record', record], {
        encoding: 'utf8',
        env,
        timeout: 30000,
      });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(fs.readFileSync(record, 'utf8')).record_kind, 'amcp_restore_drill');
    assert.equal(fs.existsSync(unrelated), false);
    const again = runAdmin(['backup-drill', archive, path.join(f.dir, 'drill-3.sqlite'), '--record', record], {
      encoding: 'utf8',
      env,
      timeout: 30000,
    });
    assert.equal(again.status, 1);
    assert.match(again.stderr, /BACKUP_PATH_REQUIRED/);
    assert.equal(fs.existsSync(path.join(f.dir, 'drill-3.sqlite')), false);
  } finally {
    f.close();
  }
});

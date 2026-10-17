// OPS-08 schema ledger and rollback discipline: fresh, version 1, pre-ledger version 2 and future databases; the
// SCHEMA_TOO_NEW refusal and its structured start-up line; two concurrent starts on a legacy amcp_users; backups of a
// newer but still readable schema. Synthetic temporary databases only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {Store} from '../dist/src/store.js';
import {WebStore} from '../dist/server/web-store.js';
import {createRuntime} from '../dist/server/runtime.js';
import {loadConfig} from '../dist/server/config.js';
import {createEncryptedBackup, verifyEncryptedBackup} from '../dist/src/backup.js';
import {READER_VERSION, schemaCompatibility, SCHEMA_RECOVERY_DOC} from '../dist/src/schema-migrations.js';
import {runtimeDiagnostics} from '../dist/src/storage-health.js';
import {removeTestDirectory} from '../dist/tests/temp.js';

const key = Buffer.alloc(32, 77).toString('base64'),
  prefix = 'amcp-schema-ledger-',
  storeSteps = [
    'store-0001-core-tables',
    'store-0002-jobs-lease-token',
    'store-0003-reporting-query-workbook-index',
    'store-0004-schedule-due-indexes',
    'store-0005-media-documents-index',
    'store-0006-job-lease-columns',
    'store-0007-health-probe',
    'store-0008-media-staging-reservation',
    'store-0009-media-admissions-waiting-since',
    'store-0010-jobs-tenant-updated-index',
    'store-0011-schedule-global-due-indexes',
    'store-0012-provider-issuer-usage',
    'store-0013-report-parts-cleanup',
    'store-0014-audit-tombstone-trigger',
    'store-0015-api-key-access-set',
    'store-0016-mcp-rate-limits',
  ],
  webSteps = ['web-0001-tables', 'web-0002-amcp-users-approval-columns'];
function temporary() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {directory, file: path.join(directory, 'mirror.sqlite'), remove: () => removeTestDirectory(directory, prefix)};
}
const raw = (file, sql) => {
  const db = new DatabaseSync(file);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
};
const read = (file, sql) => {
  const db = new DatabaseSync(file, {readOnly: true});
  try {
    return db
      .prepare(sql)
      .all()
      .map(row => ({...row}));
  } finally {
    db.close();
  }
};
const ledger = file => read(file, 'SELECT id FROM schema_migrations ORDER BY id').map(r => r.id);
const columns = (file, table) => read(file, `SELECT name FROM pragma_table_info('${table}')`).map(r => r.name);

test('compatibility: version 1 upgrades, 2 is current, a newer version opens only when its minimum reader allows', () => {
  assert.equal(READER_VERSION, 2);
  assert.equal(schemaCompatibility(1), 'upgrade');
  assert.equal(schemaCompatibility(2, 2), 'current');
  assert.equal(schemaCompatibility(3), 'too_new', 'no declared minimum reader means the version itself');
  assert.equal(schemaCompatibility(3, 2), 'newer_compatible');
  assert.equal(schemaCompatibility(3, 3), 'too_new');
  for (const invalid of [0, -1, 1.5, null, '2', undefined]) assert.equal(schemaCompatibility(invalid), 'invalid');
  assert.equal(schemaCompatibility(4, 5), 'invalid', 'a minimum reader above the version is corrupt');
});

test('a fresh database records every step once with migration_ms; a restart applies nothing new', () => {
  const t = temporary();
  try {
    let store = new Store(t.file, key);
    assert.equal(store.bootstrap.schema_version, 2);
    assert.equal(store.bootstrap.min_reader_version, 2);
    assert.equal(store.bootstrap.reader_version, 2);
    assert.deepEqual(store.bootstrap.migrations_applied, storeSteps);
    assert.ok(Number.isFinite(store.bootstrap.migration_ms) && store.bootstrap.migration_ms >= 0);
    new WebStore(store, {origin: 'http://localhost:4317', tenantId: 'local'});
    assert.deepEqual(store.bootstrap.migrations_applied, [...storeSteps, ...webSteps]);
    const runtime = runtimeDiagnostics(store).schema_ledger;
    assert.equal(runtime.entries, storeSteps.length + webSteps.length);
    assert.equal(runtime.reader_version, 2);
    assert.deepEqual(runtime.applied_at_start, [...storeSteps, ...webSteps]);
    store.close();
    store = new Store(t.file, key);
    assert.equal(store.bootstrap.compatibility, 'current');
    assert.deepEqual(store.bootstrap.migrations_applied, []);
    new WebStore(store, {origin: 'http://localhost:4317', tenantId: 'local'});
    assert.deepEqual(store.bootstrap.migrations_applied, []);
    store.close();
    assert.deepEqual(ledger(t.file), [...storeSteps, ...webSteps].sort());
    assert.deepEqual(read(t.file, 'SELECT key,value FROM schema_meta ORDER BY key'), [
      {key: 'min_reader_for_version', value: 2},
      {key: 'min_reader_version', value: 2},
    ]);
  } finally {
    t.remove();
  }
});

test('a version 1 database is upgraded and a pre-ledger version 2 database records its baseline', () => {
  for (const legacy of [1, 2]) {
    const t = temporary();
    try {
      new Store(t.file, key).close();
      // The shape an older release left: no ledger, no minimum reader, and for version 1 no jobs.lease_token.
      raw(t.file, 'DROP TABLE schema_migrations; DROP TABLE schema_meta;');
      if (legacy === 1) raw(t.file, 'ALTER TABLE jobs DROP COLUMN lease_token; UPDATE schema_version SET version=1;');
      const store = new Store(t.file, key);
      assert.equal(store.bootstrap.compatibility, legacy === 1 ? 'upgrade' : 'current');
      assert.equal(store.bootstrap.schema_version, 2);
      assert.deepEqual(store.bootstrap.migrations_applied, storeSteps, 'the baseline is recorded at the first start');
      store.close();
      assert.ok(columns(t.file, 'jobs').includes('lease_token'));
      assert.deepEqual(read(t.file, 'SELECT version FROM schema_version'), [{version: 2}]);
    } finally {
      t.remove();
    }
  }
});

test('a database newer than this release refuses with SCHEMA_TOO_NEW, changes nothing and closes; a declared older reader opens', () => {
  const t = temporary();
  try {
    new Store(t.file, key).close();
    raw(
      t.file,
      "UPDATE schema_version SET version=3; DELETE FROM schema_meta; DROP TABLE health_probe; DELETE FROM schema_migrations WHERE id='store-0007-health-probe';",
    );
    assert.throws(
      () => new Store(t.file, key),
      error =>
        error.code === 'SCHEMA_TOO_NEW' &&
        error.details.database_version === 3 &&
        error.details.min_reader_version === 3 &&
        error.details.reader_version === 2 &&
        error.details.recovery === SCHEMA_RECOVERY_DOC &&
        error.message.includes(SCHEMA_RECOVERY_DOC),
    );
    // The refusal rolled back the bootstrap: no table recreated, no ledger row written.
    assert.equal(read(t.file, "SELECT 1 FROM sqlite_master WHERE name='health_probe'").length, 0);
    assert.equal(ledger(t.file).includes('store-0007-health-probe'), false);
    assert.deepEqual(read(t.file, 'SELECT version FROM schema_version'), [{version: 3}]);
    // A declaration made for an older version does not cover the newer one (the version was bumped without one).
    raw(t.file, "INSERT INTO schema_meta VALUES('min_reader_version',2),('min_reader_for_version',2)");
    assert.throws(() => new Store(t.file, key), {code: 'SCHEMA_TOO_NEW'});
    // A newer release that declares this release still able to read its version (an additive change) opens.
    raw(t.file, "UPDATE schema_meta SET value=3 WHERE key='min_reader_for_version'");
    const store = new Store(t.file, key);
    assert.equal(store.bootstrap.compatibility, 'newer_compatible');
    assert.equal(store.bootstrap.schema_version, 3, 'never downgraded');
    assert.equal(store.bootstrap.min_reader_version, 2, "the newer release's declaration is kept");
    store.close();
    raw(t.file, 'UPDATE schema_version SET version=0');
    assert.throws(() => new Store(t.file, key), {code: 'SCHEMA_VERSION_MISMATCH'});
  } finally {
    t.remove();
  }
});

test('start-up on a too-new database logs one startup_failed line with the stage, code and recovery, and no path', () => {
  const t = temporary();
  try {
    new Store(t.file, key).close();
    raw(t.file, 'UPDATE schema_version SET version=3; DELETE FROM schema_meta;');
    const logs = [];
    assert.throws(
      () => createRuntime(loadConfig({MIRROR_DB: t.file, MIRROR_MASTER_KEY: key}, 'stdio'), {log: e => logs.push(e)}),
      {code: 'SCHEMA_TOO_NEW'},
    );
    const failed = logs.filter(l => l.event === 'startup_failed');
    assert.equal(failed.length, 1);
    assert.deepEqual(
      {...failed[0]},
      {
        level: 'error',
        event: 'startup_failed',
        stage: 'store_open',
        code: 'SCHEMA_TOO_NEW',
        details: {database_version: 3, min_reader_version: 3, reader_version: 2, recovery: SCHEMA_RECOVERY_DOC},
      },
    );
    assert.doesNotMatch(JSON.stringify(logs), new RegExp(path.basename(t.directory)));
    // A start that succeeds writes no startup_failed line and reports its bootstrap.
    raw(t.file, 'UPDATE schema_version SET version=2');
    logs.length = 0;
    const runtime = createRuntime(loadConfig({MIRROR_DB: t.file, MIRROR_MASTER_KEY: key}, 'stdio'), {
      log: e => logs.push(e),
    });
    assert.equal(
      logs.some(l => l.event === 'startup_failed'),
      false,
    );
    assert.equal(runtime.store.bootstrap.compatibility, 'current');
    runtime.store.close();
  } finally {
    t.remove();
  }
});

test('an invalid issuer quota setting stops start-up with a startup_failed line naming the quota stage (regression: it named provider_versions)', () => {
  const t = temporary(),
    before = process.env.AMCP_PROVIDER_QUOTA_MODE;
  process.env.AMCP_PROVIDER_QUOTA_MODE = 'on';
  try {
    const logs = [];
    assert.throws(
      () => createRuntime(loadConfig({MIRROR_DB: t.file, MIRROR_MASTER_KEY: key}, 'stdio'), {log: e => logs.push(e)}),
      /AMCP_PROVIDER_QUOTA_MODE/,
    );
    const failed = logs.filter(l => l.event === 'startup_failed');
    assert.deepEqual(
      failed.map(l => [l.stage, l.code]),
      [['quota_policy', 'STARTUP_FAILED']],
    );
    assert.equal(fs.existsSync(t.file), false, 'stopped before the database opened');
  } finally {
    if (before === undefined) delete process.env.AMCP_PROVIDER_QUOTA_MODE;
    else process.env.AMCP_PROVIDER_QUOTA_MODE = before;
    t.remove();
  }
});

test('two concurrent starts on a legacy amcp_users both succeed and add each column once', async () => {
  const t = temporary();
  try {
    const store = new Store(t.file, key);
    new WebStore(store, {origin: 'http://localhost:4317', tenantId: 'local'});
    store.db.exec(
      "ALTER TABLE amcp_users DROP COLUMN approved; ALTER TABLE amcp_users DROP COLUMN test_account; DELETE FROM schema_migrations WHERE id LIKE 'web-%';",
    );
    store.close();
    assert.equal(columns(t.file, 'amcp_users').includes('approved'), false);
    const storeModule = new URL('../dist/src/store.js', import.meta.url).href,
      webModule = new URL('../dist/server/web-store.js', import.meta.url).href,
      at = Date.now() + 750;
    const script = `const {Store}=await import(${JSON.stringify(storeModule)});const {WebStore}=await import(${JSON.stringify(webModule)});
while(Date.now()<${at});
const s=new Store(${JSON.stringify(t.file)},${JSON.stringify(key)});new WebStore(s,{origin:'http://localhost:4317',tenantId:'local'});
process.stdout.write(JSON.stringify(s.bootstrap.migrations_applied));s.close();`;
    const run = () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', b => (stdout += b));
      child.stderr.on('data', b => (stderr += b));
      return once(child, 'close').then(([code]) => ({code, stdout, stderr}));
    };
    const results = await Promise.all([run(), run()]);
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    const applied = results.map(r => JSON.parse(r.stdout));
    // Exactly one of the two recorded the column step; the other found it done inside its own transaction.
    assert.deepEqual(applied.flat().sort(), webSteps.slice().sort());
    for (const column of ['approved', 'test_account'])
      assert.ok(columns(t.file, 'amcp_users').includes(column), column);
    assert.equal(ledger(t.file).filter(id => id.startsWith('web-')).length, 2);
  } finally {
    t.remove();
  }
});

test('backups of a newer database this release may read verify; the receipt names the source schema', async () => {
  const t = temporary();
  try {
    new Store(t.file, key).close();
    raw(
      t.file,
      "UPDATE schema_version SET version=3; UPDATE schema_meta SET value=3 WHERE key='min_reader_for_version';",
    );
    const store = new Store(t.file, key),
      archive = path.join(t.directory, 'compatible.amcp');
    try {
      await createEncryptedBackup(store, archive, key, {skipSpaceCheck: true});
    } finally {
      store.close();
    }
    const receipt = await verifyEncryptedBackup(archive, key, t.directory);
    assert.equal(receipt.status, 'verified');
    assert.equal(receipt.source_schema_version, 3);
    assert.equal(receipt.schema_version, 3);
  } finally {
    t.remove();
  }
});

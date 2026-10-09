// OPS-02: health that sees committed writes and storage, SQLite-aware MCP envelopes, owner storage diagnostics and
// the F-118 redaction merge. Synthetic local fixtures only; no provider request is allowed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';
import {removeTestDirectory} from '../dist/tests/temp.js';
import {scrubPeople} from '../dist/src/personal-data.js';
import {
  clearSqliteFailures,
  recentSqliteFailures,
  recordSqliteFailure,
  DATABASE_BUSY_MESSAGE,
  STORAGE_FULL_MESSAGE,
} from '../dist/src/sqlite-diagnostics.js';

const key = Buffer.alloc(32, 97).toString('base64'),
  owner = {tenantId: 'storage-health-fixture', userId: 'owner', role: 'admin'};
function fixture(filename = ':memory:') {
  const store = new Store(filename, key),
    logs = [];
  let requests = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      requests++;
      throw Error('No provider request is allowed');
    }),
  );
  store.ensureTenant(owner.tenantId);
  return {store, service, logs, requests: () => requests};
}
async function serve(f, options = {}) {
  const listener = await listenForFetch(createHttpApp(f.service, f.store, {log: e => f.logs.push(e), ...options})),
    base = 'http://127.0.0.1:' + listener.address().port;
  return {base, close: () => new Promise(done => listener.close(done))};
}
function tempDatabase(prefix = 'amcp-health-storage-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {file: path.join(directory, 'fixture.sqlite'), remove: () => removeTestDirectory(directory, prefix)};
}
// A genuine SQLITE_FULL: the database may not grow, and the trigger needs a new megabyte for each guarded insert.
function pinFull(store, guarded) {
  store.db.exec('CREATE TABLE IF NOT EXISTS synthetic_storage_pressure(value BLOB)');
  for (const [name, table, when] of guarded)
    store.db.exec(
      `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} ${when ? 'WHEN ' + when : ''} BEGIN INSERT INTO synthetic_storage_pressure VALUES(zeroblob(1048576)); END`,
    );
  store.db.exec('PRAGMA max_page_count=' + store.db.prepare('PRAGMA page_count').get().page_count);
}
const checkStates = new Set(['ok', 'failed', 'busy', 'full', 'low', 'not_persistent', 'unknown', 'stale']);
function assertAnonymous(body, privateText = []) {
  assert.deepEqual(Object.keys(body).sort(), ['checked_at', 'checks', 'media_retention', 'status', 'version']);
  assert.deepEqual(Object.keys(body.checks).sort(), ['database', 'database_write', 'mcp', 'media_retention', 'storage']);
  for (const value of Object.values(body.checks)) assert.ok(checkStates.has(value), value);
  const text = JSON.stringify(body);
  for (const marker of privateText) assert.equal(text.includes(marker), false, 'no private text ' + marker);
  assert.doesNotMatch(text, /free_bytes|total_bytes|wal_|freelist|\\\\|\/tmp\//i);
}

test('healthz commits a write: pinned storage returns 503 database_write full without a cleanup scan or paths', async () => {
  const db = tempDatabase(),
    f = fixture(db.file),
    s = await serve(f);
  try {
    let cleanups = 0;
    const cleanup = f.store.cleanupTransient.bind(f.store);
    f.store.cleanupTransient = () => {
      cleanups++;
      return cleanup();
    };
    const healthy = await (await fetch(s.base + '/healthz')).json();
    assert.equal(healthy.checks.database_write, 'ok');
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM health_probe').get().n, 1, 'one probe row at rest');
    // Pin the database at its current pages with nothing free: the next probe needs a new page.
    f.store.db.exec('VACUUM');
    pinFull(f.store, []);
    await new Promise(done => setTimeout(done, 10));
    const app = await serve(f);
    try {
      const response = await fetch(app.base + '/healthz'),
        body = await response.json();
      assert.equal(response.status, 503);
      assert.equal(body.status, 'unavailable');
      assert.equal(body.checks.database, 'ok', 'reads still work');
      assert.equal(body.checks.database_write, 'full');
      assert.equal(body.checks.storage, 'full');
      assertAnonymous(body, [db.file, path.dirname(db.file)]);
    } finally {
      await app.close();
    }
    assert.equal(cleanups, 0, 'the anonymous probe never runs the cleanup scan');
    assert.ok(recentSqliteFailures().some(r => r.surface === 'health' && r.name === 'SQLITE_FULL'));
  } finally {
    await s.close();
    f.store.close();
    db.remove();
  }
});

test('healthz: busy writes, low, ephemeral or unknown production storage and stalled expiry degrade without 503', async () => {
  const db = tempDatabase(),
    f = fixture(db.file);
  const check = async (options = {}) => {
    const s = await serve(f, options);
    try {
      const response = await fetch(s.base + '/healthz');
      return {status: response.status, body: await response.json()};
    } finally {
      await s.close();
    }
  };
  try {
    // Another connection holds the write lock: contention is degraded, never unavailable.
    const other = new DatabaseSync(db.file);
    f.store.db.exec('PRAGMA busy_timeout=20');
    f.store.beginBusyDeadlineMs = 50;
    other.exec('BEGIN IMMEDIATE');
    try {
      const busy = await check();
      assert.equal(busy.status, 200);
      assert.equal(busy.body.status, 'degraded');
      assert.equal(busy.body.checks.database_write, 'busy');
    } finally {
      other.exec('ROLLBACK');
      other.close();
      f.store.db.exec('PRAGMA busy_timeout=5000');
      f.store.beginBusyDeadlineMs = 10000;
    }
    assert.equal((await check()).body.status, 'up');
    // Free space below the media admission floor is low; under one MiB the volume is full.
    f.store.statfs = () => ({bavail: 100 * 1024 * 1024, bsize: 1, blocks: 1024 * 1024 * 1024});
    const low = await check();
    assert.equal(low.status, 200);
    assert.deepEqual([low.body.status, low.body.checks.storage], ['degraded', 'low']);
    assertAnonymous(low.body, [String(100 * 1024 * 1024)]);
    f.store.statfs = () => ({bavail: 1000, bsize: 1, blocks: 1024 * 1024 * 1024});
    const full = await check();
    assert.equal(full.status, 503);
    assert.equal(full.body.checks.storage, 'full');
    // Unreadable free space is unknown: degraded in production only.
    f.store.statfs = () => {
      throw Object.assign(Error('statfs unsupported'), {code: 'ENOSYS'});
    };
    assert.deepEqual([(await check()).body.status, (await check({production: true})).body.status], ['up', 'degraded']);
    f.store.statfs = fs.statfsSync;
    f.store.volume = {persistent: false, mount: null, reason: 'override'};
    const ephemeral = await check();
    assert.deepEqual([ephemeral.status, ephemeral.body.checks.storage], [200, 'not_persistent']);
    assert.equal(ephemeral.body.status, 'degraded');
    delete f.store.volume;
    // The cleanup timer stopped succeeding more than four intervals ago.
    const real = Object.getOwnPropertyDescriptor(Store.prototype, 'mediaCleanupHealth').get;
    Object.defineProperty(f.store, 'mediaCleanupHealth', {
      configurable: true,
      get() {
        return {...real.call(this), last_success_at: Date.now() - 61000, error_code: 'ERR_SQLITE_ERROR'};
      },
    });
    const stale = await check();
    assert.deepEqual([stale.status, stale.body.status, stale.body.checks.media_retention], [200, 'degraded', 'stale']);
    Object.defineProperty(f.store, 'mediaCleanupHealth', {
      configurable: true,
      get() {
        return {...real.call(this), last_success_at: Date.now() - 59000};
      },
    });
    assert.equal((await check()).body.checks.media_retention, 'ok');
    assert.equal(f.requests(), 0);
  } finally {
    f.store.close();
    db.remove();
  }
});

test('MCP under full storage returns the AMCP STORAGE_FULL envelope with a request ID even when the audit fails', async () => {
  // Regression: a real SQLITE_FULL became INTERNAL_ERROR, and with the audit table full the call rejected as JSON-RPC
  // -32603 "database or disk is full" with no request ID, no STORAGE_FULL code and no log line.
  const f = fixture(),
    token = f.store.createKey(owner),
    s = await serve(f),
    client = new Client({name: 'storage-full-fixture', version: '1'});
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(s.base + '/mcp'), {
        requestInit: {headers: {Authorization: 'Bearer ' + token}},
      }),
    );
    pinFull(f.store, [
      ['synthetic_pause_pressure', 'documents', "NEW.kind='write_pause'"],
      ['synthetic_audit_pressure', 'audit', ''],
    ]);
    const audits = f.store.db.prepare('SELECT count(*) AS n FROM audit').get().n;
    const result = await client.callTool({
        name: 'amcp_workspace',
        arguments: {action: 'pause_writes', reason: 'synthetic storage drill', confirmed: true},
      }),
      text = result.content.find(item => item.type === 'text').text,
      envelope = JSON.parse(text);
    assert.equal(result.isError, true);
    assert.equal(envelope.success, false);
    assert.equal(envelope.error.code, 'STORAGE_FULL');
    assert.equal(envelope.error.message, STORAGE_FULL_MESSAGE);
    assert.equal(envelope.error.retryable, false);
    assert.equal(envelope.error.remedy.owner, 'deployment_operator');
    assert.match(envelope.meta.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(envelope.meta.audit_recorded, false);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM audit').get().n, audits, 'no audit row was promised');
    assert.doesNotMatch(text, /disk is full|database or disk|zeroblob|synthetic_storage|-32603/);
    const lines = f.logs.filter(entry => entry.event === 'mcp_tool_failed');
    assert.equal(lines.length, 1);
    assert.deepEqual(
      {...lines[0], at: undefined},
      {
        level: 'error',
        event: 'mcp_tool_failed',
        requestId: envelope.meta.requestId,
        tool_category: 'workspace',
        code: 'STORAGE_FULL',
        status: 503,
        audit_recorded: false,
        at: undefined,
        database: {result_code: 13, primary_code: 13, name: 'SQLITE_FULL'},
      },
    );
    assert.doesNotMatch(JSON.stringify(lines), /message|synthetic storage drill|pause_writes|owner|disk is full/);
    assert.equal(f.requests(), 0);
  } finally {
    await client.close();
    await s.close();
    f.store.close();
  }
});

test('SQLite contention becomes DATABASE_BUSY, never retryable as a write; other internal errors stay INTERNAL_ERROR', async () => {
  const db = tempDatabase(),
    f = fixture(db.file);
  try {
    f.service.onToolFailure = entry => f.logs.push(entry);
    const other = new DatabaseSync(db.file);
    f.store.db.exec('PRAGMA busy_timeout=20');
    f.store.beginBusyDeadlineMs = 50;
    other.exec('BEGIN IMMEDIATE');
    let busy;
    try {
      busy = await f.service.call(
        'amcp_workspace',
        {action: 'pause_writes', reason: 'synthetic contention drill', confirmed: true},
        owner,
      );
    } finally {
      other.exec('ROLLBACK');
      other.close();
    }
    assert.equal(busy.error.code, 'DATABASE_BUSY');
    assert.equal(busy.error.message, DATABASE_BUSY_MESSAGE);
    assert.equal(busy.error.retryable, false);
    assert.equal(busy.error.details.read_retry_safe, true);
    assert.equal(busy.error.remedy.mutation_retry_safe, false);
    assert.equal(busy.meta.audit_recorded, false, 'the audit append was blocked too');
    assert.equal(f.logs.at(-1).database.name, 'SQLITE_BUSY');
    assert.equal(f.store.documents(owner.tenantId, 'write_pause').length, 0);
    // A non-SQLite failure is still INTERNAL_ERROR; when its audit append fails, the envelope says so.
    f.store.db.exec('PRAGMA busy_timeout=5000');
    const read = f.store.listConnections.bind(f.store);
    f.store.listConnections = () => {
      throw Error('private failure text');
    };
    const internal = await f.service.call('amcp_workspace', {action: 'health'}, owner);
    assert.equal(internal.error.code, 'INTERNAL_ERROR');
    assert.equal(internal.meta.audit_recorded, undefined, 'the audit append succeeded');
    assert.equal(f.logs.at(-1).code, 'INTERNAL_ERROR');
    assert.equal(f.logs.at(-1).audit_recorded, true);
    const append = f.store.appendAudit.bind(f.store);
    f.store.appendAudit = () => {
      throw Error('private audit failure');
    };
    const unaudited = await f.service.call('amcp_workspace', {action: 'health'}, owner);
    assert.equal(unaudited.error.code, 'INTERNAL_ERROR');
    assert.equal(
      unaudited.error.message,
      'The request failed and its audit record could not be written. Report this request ID to the deployment operator.',
    );
    assert.equal(unaudited.error.next_action, 'Report this request ID to the deployment operator.');
    assert.equal(unaudited.meta.audit_recorded, false);
    assert.doesNotMatch(JSON.stringify([internal, unaudited, f.logs]), /private (failure|audit)/);
    f.store.appendAudit = append;
    f.store.listConnections = read;
    // Ordinary refusals are not operator events.
    const before = f.logs.length;
    assert.equal((await f.service.call('amcp_workspace', {action: 'unsupported'}, owner)).success, false);
    assert.equal(f.logs.length, before);
  } finally {
    f.store.close();
    db.remove();
  }
});

test('owner health and the support bundle show storage, release, runtime and recent SQLite failures', async () => {
  clearSqliteFailures();
  const db = tempDatabase(),
    f = fixture(db.file);
  try {
    recordSqliteFailure(Object.assign(new Error('private text'), {code: 'ERR_SQLITE_ERROR', errcode: 13}), 'worker');
    const health = await f.service.call('amcp_workspace', {action: 'health'}, owner);
    assert.equal(health.success, true, JSON.stringify(health));
    const storage = health.data.storage;
    for (const field of [
      'db_dir_free_bytes',
      'db_dir_total_bytes',
      'db_bytes',
      'wal_bytes',
      'freelist_bytes',
      'page_size',
      'admission_floor_bytes',
      'database_bytes',
    ])
      assert.ok(Number.isSafeInteger(storage[field]) && storage[field] >= 0, field);
    assert.ok(['ok', 'low'].includes(storage.state));
    assert.equal(storage.mount, null);
    assert.equal(storage.media_retention.state, 'ok');
    const runtime = health.data.operations.runtime;
    assert.equal(runtime.node, process.version);
    assert.match(runtime.sqlite, /^3\.\d+\.\d+$/);
    assert.equal(runtime.schema_version, 2);
    assert.ok(Number.isSafeInteger(runtime.uptime_seconds));
    assert.ok(runtime.release.sha256 || runtime.release.status === 'unavailable');
    assert.equal(typeof runtime.ffmpeg, 'string');
    assert.deepEqual(
      runtime.sqlite_failures.map(({name, result_code, surface, count}) => ({name, result_code, surface, count})),
      [{name: 'SQLITE_FULL', result_code: 13, surface: 'worker', count: 1}],
    );
    assert.doesNotMatch(JSON.stringify(health), /private text|fixture\.sqlite/);
    const bundle = await f.service.call('amcp_workspace', {action: 'support_bundle'}, owner);
    assert.equal(bundle.success, true, JSON.stringify(bundle));
    assert.equal(bundle.data.storage.page_size, storage.page_size);
    assert.equal(bundle.data.runtime.schema_version, 2);
    const reader = await f.service.call('amcp_workspace', {action: 'health'}, {...owner, role: 'reader'});
    assert.equal(reader.success, false, 'storage figures stay owner-only');
    assert.equal(f.requests(), 0);
  } finally {
    f.store.close();
    db.remove();
  }
});

test('the SQLite failure ring keeps 20 kinds with counts and no messages', () => {
  clearSqliteFailures();
  const failure = code => Object.assign(new Error('private ' + code), {code: 'ERR_SQLITE_ERROR', errcode: code});
  for (let code = 1; code <= 25; code++) recordSqliteFailure(failure(code), 'maintenance', 1000 + code);
  recordSqliteFailure(failure(25), 'maintenance', 2000);
  assert.equal(recordSqliteFailure(new Error('not sqlite'), 'mcp'), undefined);
  const rows = recentSqliteFailures();
  assert.equal(rows.length, 20);
  assert.deepEqual(rows[0], {
    name: 'SQLITE_RANGE',
    result_code: 25,
    surface: 'maintenance',
    first_at: 1025,
    at: 2000,
    count: 2,
  });
  assert.equal(
    rows.some(r => r.result_code === 1),
    false,
    'oldest kinds are evicted',
  );
  assert.doesNotMatch(JSON.stringify(rows), /private/);
  clearSqliteFailures();
});

test('F-118: colliding redacted keys keep their totals and no identifier survives', () => {
  // Regression: {hashA:3, hashB:5, email:2} (total 10) became {'[personal data]': 2}.
  const hashA = 'a'.repeat(64),
    hashB = 'b'.repeat(64);
  const out = scrubPeople({[hashA]: 3, [hashB]: 5, 'person@example.com': 2});
  assert.deepEqual(out, {'[personal data]': 10, redacted_key_count: 3});
  const text = JSON.stringify(
    scrubPeople({
      rows: [{[hashA]: ['x@example.com'], [hashB]: [hashA]}],
      [hashA]: 'kept',
      [hashB]: {nested: 1},
      plain: 4,
    }),
  );
  assert.doesNotMatch(text, /aaaa|bbbb|example\.com/);
  assert.deepEqual(JSON.parse(text), {
    rows: [{'[personal data]': ['[personal data]', '[personal data]'], redacted_key_count: 2}],
    '[personal data]': {merged_values: 2},
    plain: 4,
    redacted_key_count: 2,
  });
  // Keys stay data: a reply key named __proto__ never becomes the object's prototype.
  const hostile = scrubPeople(JSON.parse('{"__proto__":{"polluted":true},"ok":1}'));
  assert.equal(Object.getPrototypeOf(hostile), Object.prototype);
  assert.equal(hostile.polluted, undefined);
  assert.deepEqual(Object.keys(hostile), ['__proto__', 'ok']);
  assert.deepEqual(scrubPeople({a: 1, b: [2]}), {a: 1, b: [2]}, 'unredacted objects are unchanged');
});

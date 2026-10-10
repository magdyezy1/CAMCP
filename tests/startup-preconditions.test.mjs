// OPS-03: one validated configuration, the production persistent-volume guard, the volume marker, the entrypoint's
// ownership repair and the admin-as-root refusal. Synthetic environments, injected stat results and owned temporary
// directories only; nothing reads a real deployment, database or provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {loadConfig, adminRootRefusal} from '../dist/server/config.js';
import {
  verifyDataVolume,
  checkVolumeMarker,
  stampVolumeMarker,
  StorageNotPersistentError,
  VOLUME_MARKER_FILE,
} from '../dist/server/volume.js';
import {createRuntime} from '../dist/server/runtime.js';
import {Store} from '../dist/src/store.js';
import {storageDetails} from '../dist/src/storage-health.js';
import {removeTestDirectory} from '../dist/tests/temp.js';

const key = Buffer.alloc(32, 51).toString('base64'),
  prefix = 'amcp-startup-preconditions-';
const temporary = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {directory, remove: () => removeTestDirectory(directory, prefix)};
};
const production = {
  NODE_ENV: 'production',
  MIRROR_MASTER_KEY: key,
  AMCP_ADMIN_PASSWORD: 'Synthetic preconditions only',
};
// Devices by path prefix: the mount is device 2, everything else (the root file system) device 1.
const devices =
  (mount, overrides = {}) =>
  file => {
    for (const [prefixPath, dev] of Object.entries(overrides)) if (file.startsWith(prefixPath)) return {dev};
    if (file === mount || file.startsWith(mount + path.sep)) return {dev: 2};
    return {dev: 1};
  };

test('origin derivation is identical in every entry point (regression: the worker had its own default)', () => {
  for (const env of [
    {},
    {PORT: '8080'},
    {MIRROR_PORT: '4999'},
    {RAILWAY_PUBLIC_DOMAIN: 'synthetic.up.railway.app'},
    {MIRROR_PUBLIC_ORIGIN: 'https://mirror.example.test', RAILWAY_PUBLIC_DOMAIN: 'synthetic.up.railway.app'},
    {AMCP_PUBLIC_ORIGIN: 'https://amcp.example.test', MIRROR_PUBLIC_ORIGIN: 'https://mirror.example.test'},
    {AMCP_PUBLIC_ORIGIN: '', PORT: '8080'},
  ]) {
    const [http, worker, stdio] = ['http', 'worker', 'stdio'].map(entry => loadConfig(env, entry));
    assert.equal(worker.origin, http.origin, JSON.stringify(env));
    assert.equal(stdio.origin, http.origin, JSON.stringify(env));
    assert.equal(worker.publicOrigin, http.publicOrigin);
  }
  assert.equal(loadConfig({PORT: '8080'}, 'worker').origin, 'http://127.0.0.1:8080');
  assert.equal(loadConfig({RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app'}, 'worker').origin, 'https://x.up.railway.app');
  assert.equal(loadConfig({AMCP_PUBLIC_ORIGIN: ''}, 'http').publicOrigin, undefined, 'an empty origin is unset');
  const config = loadConfig({AMCP_TRUSTED_PROXY_CIDRS: '10.0.0.1/32, 10.0.0.2/32'}, 'http');
  assert.ok(Object.isFrozen(config));
  assert.deepEqual(config.trustedProxyCidrs, ['10.0.0.1/32', '10.0.0.2/32']);
  assert.equal(config.databasePath, '.runtime/mirror.sqlite');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(loadConfig({PORT: '8080'}, 'http').host, '0.0.0.0');
});

test('production preconditions: HTTP needs the key and an administrator password, the worker needs the key', () => {
  assert.throws(() => loadConfig({NODE_ENV: 'production'}, 'http'), /MIRROR_MASTER_KEY and an AMCP administrator/);
  assert.throws(() => loadConfig({NODE_ENV: 'production', MIRROR_MASTER_KEY: key}, 'http'), /administrator password/);
  assert.equal(
    loadConfig({NODE_ENV: 'production', MIRROR_MASTER_KEY: key, AMCP_ADMIN_PASSWORD_HASH: 'scrypt-v3$x'}, 'http')
      .production,
    true,
  );
  // Regression: the standalone worker started in production without a key and failed sealed work at run time.
  assert.throws(() => loadConfig({NODE_ENV: 'production'}, 'worker'), /production worker requires MIRROR_MASTER_KEY/);
  assert.throws(() => loadConfig({NODE_ENV: 'production', MIRROR_MASTER_KEY: ''}, 'worker'), /MIRROR_MASTER_KEY/);
  assert.equal(loadConfig({NODE_ENV: 'production', MIRROR_MASTER_KEY: key}, 'worker').masterKey, key);
  assert.equal(loadConfig({}, 'worker').masterKey, undefined, 'outside production the key stays optional');
  assert.throws(
    () => loadConfig({MIRROR_ALLOW_WRITES: 'perhaps'}, 'stdio'),
    /MIRROR_ALLOW_WRITES must be true or false/,
  );
  assert.throws(() => loadConfig({MIRROR_ALLOW_WRITES: 'true'}, 'stdio'), /encrypted persistent connection/);
  assert.throws(() => loadConfig({MIRROR_PORT: '70000'}, 'http'), /Invalid MIRROR_PORT/);
  assert.throws(() => loadConfig({MIRROR_PORT: 'x'}, 'worker'), /Invalid MIRROR_PORT/);
  // Optional settings never stop a start on their own.
  const lenient = loadConfig(
    {AMCP_DATA_MOUNT: 'relative/data', AMCP_ALLOW_EPHEMERAL_DB: 'yes', AMCP_SHUTDOWN_GRACE_MS: '5'},
    'http',
  );
  assert.deepEqual(lenient.dataMounts, []);
  assert.equal(lenient.allowEphemeralDb, false);
  assert.equal(lenient.shutdownGraceMs, 25000, 'a bad grace period keeps the default (OPS-07)');
  assert.equal(lenient.problems.length, 3);
  assert.equal(loadConfig({AMCP_SHUTDOWN_GRACE_MS: '30000'}, 'worker').shutdownGraceMs, 30000);
  assert.equal(loadConfig({}, 'http').shutdownGraceMs, 25000);
});

test('the volume guard refuses, allows and overrides from injected environment and stat results', () => {
  const mount = path.resolve(os.tmpdir(), 'amcp-synthetic-volume'),
    database = path.join(mount, 'mirror.sqlite');
  const guard = (env, stat = devices(mount)) => {
    const logs = [];
    try {
      return {
        volume: verifyDataVolume(
          loadConfig({...production, MIRROR_DB: database, ...env}, 'http'),
          e => logs.push(e),
          stat,
        ),
        logs,
      };
    } catch (error) {
      return {error, logs};
    }
  };
  // Outside production nothing is checked.
  assert.equal(
    verifyDataVolume(
      loadConfig({MIRROR_DB: database}, 'http'),
      () => assert.fail('no log'),
      () => assert.fail('no stat'),
    ),
    undefined,
  );
  const verified = guard({RAILWAY_VOLUME_MOUNT_PATH: mount});
  assert.deepEqual(verified.volume, {persistent: true, mount, reason: 'verified'});
  assert.deepEqual(
    verified.logs.map(l => [l.level, l.event, l.mount]),
    [['info', 'storage_verified', mount]],
  );
  assert.equal(
    guard({AMCP_DATA_MOUNT: mount}).volume.persistent,
    true,
    'AMCP_DATA_MOUNT covers a missing Railway variable',
  );
  for (const [env, reason, stat] of [
    [{}, 'no_mount'],
    [{RAILWAY_VOLUME_MOUNT_PATH: path.resolve(os.tmpdir(), 'amcp-other-volume')}, 'outside_mount'],
    [{AMCP_DATA_MOUNT: mount}, 'same_device', () => ({dev: 1})],
    [
      {AMCP_DATA_MOUNT: mount},
      'mount_missing',
      () => {
        throw Object.assign(Error('missing'), {code: 'ENOENT'});
      },
    ],
    // A link or nested mount below the mount point leads the database to the root device.
    [{AMCP_DATA_MOUNT: mount}, 'outside_mount', devices(mount, {[database]: 1})],
    [{AMCP_DATA_MOUNT: mount, MIRROR_DB: ':memory:'}, 'in_memory'],
  ]) {
    const refused = guard(env, stat);
    assert.ok(refused.error instanceof StorageNotPersistentError, reason);
    assert.equal(refused.error.reason, reason);
    assert.equal(refused.logs.length, 1);
    assert.equal(refused.logs[0].event, 'storage_not_persistent');
    assert.equal(refused.logs[0].level, 'error');
    assert.equal(refused.logs[0].reason, reason);
    assert.match(refused.logs[0].remedy, /AMCP_ALLOW_EPHEMERAL_DB=true/);
  }
  const override = guard({AMCP_ALLOW_EPHEMERAL_DB: 'true'});
  assert.deepEqual(override.volume, {persistent: false, mount: null, reason: 'override'});
  assert.deepEqual(
    override.logs.map(l => [l.level, l.event, l.reason, l.override]),
    [['warn', 'storage_not_persistent', 'no_mount', true]],
  );
});

test('production without a verified volume refuses before the database file is created', () => {
  const t = temporary();
  try {
    const database = path.join(t.directory, 'data', 'mirror.sqlite'),
      logs = [];
    assert.throws(
      () => createRuntime(loadConfig({...production, MIRROR_DB: database}, 'stdio'), {log: e => logs.push(e)}),
      StorageNotPersistentError,
    );
    assert.equal(fs.existsSync(path.dirname(database)), false, 'no fresh database on container storage');
    assert.equal(logs.at(-1).event, 'storage_not_persistent');
  } finally {
    t.remove();
  }
});

test('the volume marker is stamped, verified, reported as changed after a replacement and deliberately re-stamped', () => {
  const t = temporary();
  try {
    const database = path.join(t.directory, 'mirror.sqlite'),
      config = loadConfig({...production, MIRROR_DB: database, AMCP_DATA_MOUNT: t.directory}, 'stdio'),
      stat = devices(path.resolve(t.directory));
    const start = () => {
      const logs = [],
        runtime = createRuntime(config, {log: e => logs.push(e), stat});
      return {runtime, logs, events: logs.map(l => l.event)};
    };
    let run = start();
    assert.deepEqual(run.events, ['storage_verified', 'storage_volume_stamped']);
    assert.equal(run.runtime.store.volume.marker, 'stamped');
    const marker = fs.readFileSync(path.join(t.directory, VOLUME_MARKER_FILE), 'utf8').trim();
    assert.match(marker, /^[0-9a-f-]{36}$/);
    assert.deepEqual(storageDetails(run.runtime.store).mount, {
      persistent: true,
      mount: path.resolve(t.directory),
      reason: 'verified',
      marker: 'stamped',
    });
    run.runtime.store.close();
    run = start();
    assert.deepEqual(run.events, ['storage_verified']);
    assert.equal(run.runtime.store.volume.marker, 'verified');
    run.runtime.store.close();
    // The database stays, the volume's marker is gone: as after restoring this database onto a new volume.
    fs.rmSync(path.join(t.directory, VOLUME_MARKER_FILE));
    run = start();
    assert.deepEqual(run.events, ['storage_verified', 'storage_volume_changed']);
    assert.equal(run.logs[1].level, 'warn');
    assert.deepEqual([run.logs[1].marker_file, run.logs[1].marker_database], ['absent', 'present']);
    assert.equal(run.runtime.store.volume.marker, 'changed');
    assert.equal(storageDetails(run.runtime.store).mount.marker, 'changed', 'owner health shows the mismatch');
    assert.equal(fs.existsSync(path.join(t.directory, VOLUME_MARKER_FILE)), false, 'never silently re-stamped');
    stampVolumeMarker(run.runtime.store, t.directory);
    run.runtime.store.close();
    run = start();
    assert.equal(run.runtime.store.volume.marker, 'verified');
    assert.deepEqual(
      fs.readdirSync(t.directory).filter(f => f.endsWith('.tmp')),
      [],
      'no temporary marker remains',
    );
    run.runtime.store.close();
    // A different database under the same marker file (for example an older file copied in place) is a change too.
    const other = new Store(path.join(t.directory, 'other.sqlite'), key);
    try {
      const logs = [];
      assert.equal(
        checkVolumeMarker(other, t.directory, e => logs.push(e)),
        'changed',
      );
      assert.deepEqual([logs[0].marker_file, logs[0].marker_database], ['present', 'absent']);
    } finally {
      other.close();
    }
  } finally {
    t.remove();
  }
});

async function runEntry(file, env, args = []) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/server/' + file, import.meta.url)), ...args], {
    windowsHide: true,
    env: {
      SystemRoot: process.env.SystemRoot,
      PATH: process.env.PATH,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', b => (stdout += b));
  child.stderr.on('data', b => (stderr += b));
  const timer = setTimeout(() => child.kill(), 15000);
  const [code] = await once(child, 'close');
  clearTimeout(timer);
  return {code, stdout, stderr};
}

test(
  'the actual standalone worker refuses to start in production without the key, before opening the database',
  {timeout: 20000},
  async () => {
    const t = temporary();
    try {
      const database = path.join(t.directory, 'worker.sqlite');
      const result = await runEntry(
        'worker.js',
        {NODE_ENV: 'production', MIRROR_DB: database, AMCP_ALLOW_EPHEMERAL_DB: 'true'},
        ['--once'],
      );
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /The production worker requires MIRROR_MASTER_KEY/);
      assert.equal(fs.existsSync(database), false);
    } finally {
      t.remove();
    }
  },
);

test(
  'the actual HTTP server refuses production without a verified volume and logs storage_not_persistent',
  {timeout: 20000},
  async () => {
    const t = temporary();
    try {
      const database = path.join(t.directory, 'data', 'mirror.sqlite');
      const result = await runEntry('http.js', {
        ...production,
        MIRROR_DB: database,
        PORT: '1',
        AMCP_RUN_WORKER: 'false',
        AMCP_PUBLIC_ORIGIN: 'https://startup.example.test',
      });
      assert.notEqual(result.code, 0);
      const line = result.stderr.split(/\r?\n/).find(s => s.includes('"event":"storage_not_persistent"'));
      assert.ok(line, result.stderr);
      assert.deepEqual([JSON.parse(line).level, JSON.parse(line).reason], ['error', 'no_mount']);
      assert.doesNotMatch(result.stdout, /http_listening/);
      assert.doesNotMatch(result.stdout + result.stderr, /Synthetic preconditions only/);
      assert.equal(fs.existsSync(path.dirname(database)), false);
    } finally {
      t.remove();
    }
  },
);

test('admin commands are refused as root in production unless --allow-root is given', () => {
  assert.match(adminRootRefusal({production: true, uid: 0, allowRoot: false}), /gosu node npm run admin/);
  assert.equal(adminRootRefusal({production: true, uid: 0, allowRoot: true}), undefined);
  assert.equal(adminRootRefusal({production: false, uid: 0, allowRoot: false}), undefined);
  assert.equal(adminRootRefusal({production: true, uid: 1000, allowRoot: false}), undefined);
  assert.equal(adminRootRefusal({production: true, uid: undefined, allowRoot: false}), undefined, 'Windows has no uid');
});

const sh = spawnSync('sh', ['-c', 'exit 0']).status === 0;
test(
  'the entrypoint repairs ownership of the known database files only, as root, then drops privileges',
  {skip: !sh && 'needs a POSIX sh'},
  () => {
    const t = temporary();
    try {
      const bin = path.join(t.directory, 'bin'),
        data = path.join(t.directory, 'data').replaceAll('\\', '/'),
        calls = path.join(t.directory, 'calls.log').replaceAll('\\', '/');
      fs.mkdirSync(bin);
      fs.mkdirSync(data);
      // Shims record what the entrypoint would do as root; nothing changes real ownership.
      for (const [name, body] of [
        ['id', 'echo 0'],
        ['chown', 'echo "chown $*" >> "' + calls + '"'],
        ['mkdir', 'echo "mkdir $*" >> "' + calls + '"'],
        ['gosu', 'echo "gosu $*" >> "' + calls + '"'],
      ])
        fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n' + body + '\n', {mode: 0o755});
      const database = data + '/mirror.sqlite';
      fs.writeFileSync(database, '');
      fs.writeFileSync(database + '-wal', '');
      fs.writeFileSync(data + '/' + VOLUME_MARKER_FILE, 'x\n');
      fs.writeFileSync(data + '/unrelated.sqlite', '');
      let linked = false;
      try {
        fs.symlinkSync(data + '/unrelated.sqlite', database + '-shm');
        linked = fs.lstatSync(database + '-shm').isSymbolicLink();
      } catch {}
      const result = spawnSync('sh', ['deploy/entrypoint.sh', 'node', 'dist/server/http.js'], {
        encoding: 'utf8',
        env: {...process.env, PATH: bin.replaceAll('\\', '/') + path.delimiter + process.env.PATH, MIRROR_DB: database},
      });
      assert.equal(result.status, 0, result.stderr);
      const log = fs.readFileSync(calls, 'utf8').trim().split('\n');
      assert.deepEqual(log, [
        'mkdir -p /data',
        'chown node:node /data',
        'chown node:node ' + database,
        'chown node:node ' + database + '-wal',
        'chown node:node ' + data + '/' + VOLUME_MARKER_FILE,
        'gosu node node dist/server/http.js',
      ]);
      assert.equal(
        log.some(l => l.includes('unrelated')),
        false,
        'no other file and no recursive change',
      );
      if (linked)
        assert.equal(
          log.some(l => l.endsWith('-shm')),
          false,
          'a symbolic link is never followed',
        );
    } finally {
      t.remove();
    }
  },
);

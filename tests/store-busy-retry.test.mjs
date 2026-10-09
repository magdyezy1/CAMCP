// Contended SQLite transactions on an owned temporary database; no provider, account or credential operation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {Store} from '../dist/src/store.js';
import {removeTestDirectory} from '../dist/tests/temp.js';

const key = Buffer.alloc(32, 95).toString('base64');
// Another connection takes the write lock, reports it, holds it for `holdMs`, then commits.
const holder = `
const {parentPort, workerData} = require('node:worker_threads');
const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync(workerData.file);
db.exec('BEGIN IMMEDIATE');
db.prepare("INSERT INTO documents(tenant_id,kind,id,data) VALUES('busy','fixture','holder','{}')").run();
parentPort.postMessage('locked');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.holdMs);
db.exec('COMMIT');
db.close();
parentPort.postMessage('released');
`;
async function contended(holdMs, run) {
  const prefix = 'amcp-busy-retry-',
    directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
    file = path.join(directory, 'fixture.sqlite'),
    store = new Store(file, key);
  const worker = new Worker(holder, {eval: true, workerData: {file, holdMs}}),
    exited = new Promise(resolve => worker.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.on('message', m => m === 'locked' && resolve());
    });
    // SQLite's own wait gives up quickly here, as it can under sustained multi-process contention.
    store.db.exec('PRAGMA busy_timeout=20');
    return run(store);
  } finally {
    await exited;
    store.close();
    removeTestDirectory(directory, prefix);
  }
}

test('a transaction retries BEGIN IMMEDIATE while another process briefly holds the write lock', async () => {
  // Regression: 'three actual processes update the same bounded timing record' once failed with
  // "database is locked" from BEGIN IMMEDIATE when SQLite's busy wait expired under load.
  await contended(400, store => {
    const before = store.transactionBusyRetries,
      started = performance.now();
    const id = store.transaction(() => store.putDocument('busy', 'fixture', 'waiter', {ok: true}).id);
    assert.equal(id, 'waiter');
    assert.ok(performance.now() - started >= 300, 'it waited for the holder');
    assert.ok(store.transactionBusyRetries > before);
    assert.equal(store.db.prepare('PRAGMA busy_timeout').get().timeout, 20, 'the configured wait is restored');
    assert.equal(store.document('busy', 'fixture', 'holder').id, 'holder');
    assert.equal(store.db.isTransaction, false);
  });
});

test('BEGIN retries stop at their deadline with the original SQLITE_BUSY and no open transaction', async () => {
  await contended(1500, store => {
    store.beginBusyDeadlineMs = 200;
    const started = performance.now();
    assert.throws(
      () => store.putDocument('busy', 'fixture', 'waiter', {ok: true}),
      e => e.code === 'ERR_SQLITE_ERROR' && (e.errcode & 255) === 5,
    );
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 150 && elapsed < 1200, String(elapsed));
    assert.equal(store.db.isTransaction, false);
    assert.equal(store.db.prepare('PRAGMA busy_timeout').get().timeout, 20);
  });
});

test('errors other than SQLITE_BUSY are never retried', () => {
  const store = new Store(':memory:', key);
  try {
    let calls = 0;
    const exec = store.db.exec.bind(store.db);
    store.db.exec = sql => {
      if (sql === 'BEGIN IMMEDIATE' && ++calls === 1)
        throw Object.assign(new Error('synthetic full'), {code: 'ERR_SQLITE_ERROR', errcode: 13});
      return exec(sql);
    };
    assert.throws(() => store.transaction(() => 1), {errcode: 13});
    assert.equal(calls, 1);
    assert.equal(
      store.transaction(() => 2),
      2,
    );
    assert.equal(store.transactionBusyRetries, 0);
  } finally {
    store.close();
  }
});

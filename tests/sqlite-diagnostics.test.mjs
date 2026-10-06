import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {sqliteDiagnostic} from '../dist/src/sqlite-diagnostics.js';
import {runWorkerLoop} from '../dist/src/worker-loop.js';
test('real SQLite query errors retain only numeric and predefined diagnostic fields', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    let original;
    try {
      db.prepare('SELECT * FROM private_native_argument_missing_table');
    } catch (e) {
      original = e;
    }
    assert.ok(original);
    assert.deepEqual(sqliteDiagnostic(original), {result_code: 1, primary_code: 1, name: 'SQLITE_ERROR'});
    const failures = [];
    await assert.rejects(
      runWorkerLoop({
        schedule: () => {},
        deliverEmails: async () => {},
        work: async () => {
          throw original;
        },
        shouldStop: () => false,
        onceOnly: true,
        onFailure: f => failures.push(f),
      }),
      e => e === original,
    );
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, 'ERR_SQLITE_ERROR');
    assert.deepEqual(failures[0].database, {result_code: 1, primary_code: 1, name: 'SQLITE_ERROR'});
    assert.doesNotMatch(JSON.stringify(failures), /private_native_argument|message|query|stack|errstr/);
  } finally {
    db.close();
  }
});
test('real SQLite capacity errors are distinct from extended contention and arbitrary exceptions', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA page_size=512;PRAGMA max_page_count=2;CREATE TABLE pressure(value BLOB)');
    let full;
    try {
      db.prepare('INSERT INTO pressure VALUES(?)').run(Buffer.alloc(65536));
    } catch (e) {
      full = e;
    }
    assert.deepEqual(sqliteDiagnostic(full), {result_code: 13, primary_code: 13, name: 'SQLITE_FULL'});
    assert.deepEqual(
      sqliteDiagnostic(Object.assign(Error('PRIVATE'), {code: 'ERR_SQLITE_ERROR', errcode: 517, errstr: 'PRIVATE'})),
      {result_code: 517, primary_code: 5, name: 'SQLITE_BUSY'},
    );
    for (const e of [
      null,
      {},
      {code: 'ERR_SQLITE_ERROR', errcode: 13},
      Error('database or disk is full'),
      ...['13', NaN, Infinity, -1, 0, 256, 13.5, 0x80000000].map(errcode =>
        Object.assign(Error('PRIVATE'), {code: 'ERR_SQLITE_ERROR', errcode}),
      ),
      Object.assign(Error('PRIVATE'), {code: 'OTHER_ERROR', errcode: 13}),
    ])
      assert.equal(sqliteDiagnostic(e), undefined);
  } finally {
    db.close();
  }
});

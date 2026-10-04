import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../dist/src/store.js';
import {dueSchedules, dueScheduleSQL, failSchedule} from '../dist/src/scheduled-work.js';
import {createEncryptedBackup, restoreEncryptedBackup} from '../dist/src/backup.js';
import {removeTestDirectory} from '../dist/tests/temp.js';

const key = Buffer.alloc(32, 84).toString('base64'),
  kinds = ['reporting_schedule', 'overview_schedule'];
function memory() {
  const store = new Store(':memory:', key);
  store.ensureTenant('a');
  store.ensureTenant('b');
  return store;
}
const error = {code: 'JOB_REAUTHORIZATION_REQUIRED', message: 'Original job cannot continue'};

test('indexed selection preserves complete original projections, ordering, kind and tenant', () => {
  const store = memory(),
    at = 1791000000000;
  try {
    store.transaction(() => {
      for (const tenant of ['a', 'b'])
        for (const kind of kinds)
          for (let i = 0; i < 220; i++)
            store.putDocument(tenant, kind, 'id-' + String(i).padStart(3, '0'), {
              name: 'Original ' + tenant,
              is_active: true,
              next_run_at: at - 1,
              config: {
                native_id: String(9007199254740993n + BigInt(i)),
                decimal: '123456789.000001',
                marker: tenant + '/' + kind,
              },
            });
      store.putDocument('a', 'unrelated', 'id-000', {is_active: true, next_run_at: 0});
    });
    for (const tenant of ['a', 'b'])
      for (const kind of kinds) {
        const original = store.documents(tenant, kind).filter(s => s.is_active && s.next_run_at <= at);
        assert.equal(original.length, 220);
        assert.deepEqual(dueSchedules(store, tenant, kind, at), original);
        const plan = store.db
          .prepare('EXPLAIN QUERY PLAN ' + dueScheduleSQL[kind])
          .all(tenant, at)
          .map(r => r.detail)
          .join('\n');
        assert.match(plan, new RegExp('USING INDEX ' + kind + '_due'));
      }
    assert.deepEqual(dueSchedules(store, 'foreign', kinds[0], at), []);
  } finally {
    store.close();
  }
});

test('coarse date prefilter retains original JSON truthiness and legacy numeric coercion', () => {
  const store = memory(),
    at = 2000;
  try {
    const active = [true, false, 1, 0, -1, '0', 'false', '', null, [], {}, undefined];
    const dates = [
      0,
      1999,
      2000,
      2001,
      '1999',
      '2001',
      '0x10',
      '1e3',
      '2001abc',
      'invalid',
      null,
      [],
      [1000],
      {},
      true,
      false,
      undefined,
      '\u00a01000\u00a0',
    ];
    let i = 0;
    for (const enabled of active)
      for (const next of dates)
        store.putDocument('a', kinds[0], String(i++).padStart(3, '0'), {is_active: enabled, next_run_at: next});
    assert.deepEqual(
      dueSchedules(store, 'a', kinds[0], at),
      store.documents('a', kinds[0]).filter(s => s.is_active && s.next_run_at <= at),
    );
  } finally {
    store.close();
  }
});

test('active, future, paused and edited deadlines enter or leave the index without changing revisions', () => {
  const store = memory(),
    at = 2000;
  try {
    store.putDocument('a', kinds[0], 'current', {is_active: true, next_run_at: at + 1});
    assert.equal(dueSchedules(store, 'a', kinds[0], at).length, 0);
    assert.equal(dueSchedules(store, 'a', kinds[0], at + 1).length, 1);
    let row = store.document('a', kinds[0], 'current');
    store.putDocument('a', kinds[0], row.id, {...row, is_active: false}, row.revision);
    assert.equal(dueSchedules(store, 'a', kinds[0], at + 1).length, 0);
    row = store.document('a', kinds[0], 'current');
    store.putDocument('a', kinds[0], row.id, {...row, is_active: true}, row.revision);
    assert.equal(dueSchedules(store, 'a', kinds[0], at + 1)[0].revision, 3);
    assert.equal(store.document('a', kinds[0], row.id).revision, 3);
  } finally {
    store.close();
  }
});

test('failure pauses the exact current revision and preserves native configuration and original error', () => {
  const store = memory();
  try {
    for (const kind of kinds) {
      store.putDocument('a', kind, 'current', {
        is_active: true,
        next_run_at: 0,
        name: 'Original',
        config: {native_id: '9007199254740993', budget: '10.000001'},
      });
      const original = store.document('a', kind, 'current');
      assert.equal(failSchedule(store, 'a', kind, original, error), true);
      assert.deepEqual(store.document('a', kind, 'current'), {...original, revision: 2, is_active: false, error});
      assert.equal(failSchedule(store, 'a', kind, original, error), false);
    }
  } finally {
    store.close();
  }
});

test('failure cannot overwrite a newer revision, another tenant or a deleted schedule', () => {
  const store = memory();
  try {
    for (const kind of kinds) {
      store.putDocument('a', kind, 'current', {is_active: true, next_run_at: 0});
      store.putDocument('b', kind, 'current', {is_active: true, next_run_at: 0, name: 'Foreign'});
      const old = store.document('a', kind, 'current');
      store.putDocument('a', kind, 'current', {...old, name: 'New choice'}, old.revision);
      const newer = store.document('a', kind, 'current'),
        foreign = store.document('b', kind, 'current');
      assert.equal(failSchedule(store, 'a', kind, old, error), false);
      assert.deepEqual(store.document('a', kind, 'current'), newer);
      assert.deepEqual(store.document('b', kind, 'current'), foreign);
      store.deleteDocument('a', kind, 'current');
      assert.equal(failSchedule(store, 'a', kind, newer, error), false);
      assert.throws(
        () => store.document('a', kind, 'current'),
        e => e.code === 'NOT_FOUND',
      );
    }
  } finally {
    store.close();
  }
});

test('failure rollback preserves the original when its database write fails', () => {
  const store = memory();
  try {
    store.putDocument('a', kinds[0], 'current', {is_active: true, next_run_at: 0});
    const before = store.document('a', kinds[0], 'current');
    const put = store.putDocument;
    store.putDocument = () => {
      throw Error('Synthetic storage failure');
    };
    assert.throws(() => failSchedule(store, 'a', kinds[0], before, error), /Synthetic storage failure/);
    store.putDocument = put;
    assert.deepEqual(store.document('a', kinds[0], 'current'), before);
    store.putDocument('a', kinds[0], 'after', {is_active: false});
    assert.equal(store.document('a', kinds[0], 'after').revision, 1);
  } finally {
    store.close();
  }
});

test('old schema-1 bootstrap and repeated schema-2 opens add indexes without altering schedule bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-scheduled-work-')),
    file = path.join(dir, 'old.sqlite');
  let store;
  const raw = JSON.stringify({
    name: 'Original',
    is_active: true,
    next_run_at: 0,
    native_id: '9007199254740993',
    budget: '12.000001',
  });
  try {
    const old = new DatabaseSync(file);
    old.exec(
      'CREATE TABLE schema_version(version INTEGER NOT NULL);INSERT INTO schema_version VALUES(1);CREATE TABLE documents(tenant_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(tenant_id,kind,id))',
    );
    old.prepare('INSERT INTO documents VALUES(?,?,?,?,?)').run('a', kinds[0], 'current', raw, 9);
    old.close();
    for (let i = 0; i < 2; i++) {
      store = new Store(file, key);
      assert.equal(store.db.prepare('SELECT version FROM schema_version').get().version, 2);
      assert.equal(
        store.db
          .prepare('SELECT data FROM documents WHERE tenant_id=? AND kind=? AND id=?')
          .get('a', kinds[0], 'current').data,
        raw,
      );
      assert.equal(dueSchedules(store, 'a', kinds[0], 2000)[0].revision, 9);
      for (const kind of kinds)
        assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(kind + '_due'));
      store.close();
      store = undefined;
    }
  } finally {
    store?.close();
    removeTestDirectory(dir, 'amcp-scheduled-work-');
  }
});

test('encrypted backup restore retains new indexes and exactly the original due projections', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-scheduled-work-')),
    store = memory();
  let restored;
  try {
    store.putDocument('a', kinds[1], 'original', {is_active: true, next_run_at: 0, native_id: '9007199254740993'});
    const before = dueSchedules(store, 'a', kinds[1], 2000),
      backup = path.join(dir, 'source.amcp'),
      target = path.join(dir, 'restored.sqlite');
    await createEncryptedBackup(store, backup, key);
    await restoreEncryptedBackup(backup, target, key);
    restored = new Store(target, key);
    assert.deepEqual(dueSchedules(restored, 'a', kinds[1], 2000), before);
    for (const kind of kinds)
      assert.ok(restored.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(kind + '_due'));
  } finally {
    restored?.close();
    store.close();
    removeTestDirectory(dir, 'amcp-scheduled-work-');
  }
});

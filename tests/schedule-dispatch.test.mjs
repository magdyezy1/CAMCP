import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../dist/src/store.js';
import {ReportWorker} from '../dist/src/worker.js';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {MirrorService} from '../dist/src/service.js';
import {Registry} from '../dist/src/catalog.js';
import {NativeTransport} from '../dist/src/transport.js';
import {removeTestDirectory} from '../dist/tests/temp.js';

const key = Buffer.alloc(32, 81).toString('base64');
function fixture(kind) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-schedule-dispatch-'));
  const file = path.join(dir, 'fixture.sqlite'),
    store = new Store(file, key),
    editor = new Store(file, key);
  for (const t of ['a', 'b']) {
    store.ensureTenant(t);
    store.putDocument(t, 'reporting_query', 'query', {
      name: 'Synthetic',
      query_config: {platform: 'meta', account_id: '100'},
    });
    store.putDocument(t, kind, 'schedule', {
      name: 'Original ' + t,
      is_active: true,
      next_run_at: Date.now() - 1000,
      timezone: 'UTC',
      schedule_kind: 'daily',
      schedule_config: {hour: 9, minute: 0, query_id: 'query'},
      config: {sources: []},
      actor_binding: null,
    });
  }
  let calls = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      calls++;
      throw Error('No network permitted');
    }),
  );
  return {
    store,
    editor,
    service,
    get calls() {
      return calls;
    },
    close() {
      editor.close();
      store.close();
      removeTestDirectory(dir, 'amcp-schedule-dispatch-');
    },
  };
}
function concurrentEditAfterFailedTransaction(f, kind) {
  const transaction = f.store.transaction.bind(f.store);
  let armed = true,
    edited;
  f.store.transaction = fn => {
    try {
      return transaction(fn);
    } catch (e) {
      if (armed && e.code === 'JOB_REAUTHORIZATION_REQUIRED') {
        armed = false;
        const old = f.editor.document('a', kind, 'schedule');
        f.editor.putDocument(
          'a',
          kind,
          'schedule',
          {...old, name: 'New operator choice', next_run_at: Date.now() + 86400000, error: null},
          old.revision,
        );
        edited = f.editor.document('a', kind, 'schedule');
      }
      throw e;
    }
  };
  return () => edited;
}

test('report scheduler failure preserves a newer edit and continues another tenant', () => {
  const f = fixture('reporting_schedule');
  try {
    const edited = concurrentEditAfterFailedTransaction(f, 'reporting_schedule');
    const worker = new ReportWorker(f.store, async () => {
      throw Error('No execution permitted');
    });
    assert.doesNotThrow(() => worker.tickSchedules());
    assert.ok(edited());
    assert.deepEqual(f.store.document('a', 'reporting_schedule', 'schedule'), edited());
    assert.equal(f.store.document('b', 'reporting_schedule', 'schedule').is_active, false);
    assert.equal(f.calls, 0);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM jobs').get().n, 0);
  } finally {
    f.close();
  }
});

test('overview scheduler failure preserves a newer edit without resurrecting old settings', () => {
  const f = fixture('overview_schedule');
  try {
    const edited = concurrentEditAfterFailedTransaction(f, 'overview_schedule');
    new ReportingOverview(f.service).tick();
    assert.ok(edited());
    assert.deepEqual(f.store.document('a', 'overview_schedule', 'schedule'), edited());
    assert.equal(f.store.document('b', 'overview_schedule', 'schedule').is_active, false);
    assert.equal(f.calls, 0);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM jobs').get().n, 0);
  } finally {
    f.close();
  }
});

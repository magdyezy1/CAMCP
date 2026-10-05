import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../dist/src/store.js';
import {ReportWorker} from '../dist/src/worker.js';
import {operationsHealth} from '../dist/src/operations-health.js';
import {removeTestDirectory} from '../dist/tests/temp.js';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-heartbeat-'));
  const database = path.join(directory, 'fixture.sqlite');
  const store = new Store(database),
    blocker = new Store(database);
  store.db.exec('PRAGMA busy_timeout=1;');
  return {
    store,
    blocker,
    close() {
      if (blocker.db.isTransaction) blocker.db.exec('ROLLBACK');
      blocker.close();
      store.close();
      removeTestDirectory(directory, 'amcp-heartbeat-');
    },
  };
}
const isBusy = error => error.code === 'ERR_SQLITE_ERROR' && (error.errcode & 255) === 5;
function blockHealth(f) {
  const original = f.store.putDocument.bind(f.store);
  f.store.putDocument = (tenant, kind, ...args) => {
    if (tenant !== '__service_limits__' || kind !== 'worker_heartbeat') return original(tenant, kind, ...args);
    f.blocker.db.exec('BEGIN IMMEDIATE');
    try {
      return original(tenant, kind, ...args);
    } finally {
      f.blocker.db.exec('ROLLBACK');
    }
  };
  return () => {
    f.store.putDocument = original;
  };
}
function intervalFixture() {
  const original = globalThis.setInterval,
    clear = globalThis.clearInterval;
  let callback,
    cleared = false;
  const timer = {unref() {}};
  globalThis.setInterval = (fn, ms) => {
    assert.equal(ms, 15000);
    callback = fn;
    return timer;
  };
  globalThis.clearInterval = value => {
    assert.equal(value, timer);
    cleared = true;
  };
  return {
    tick() {
      assert.ok(callback);
      callback();
    },
    get cleared() {
      return cleared;
    },
    close() {
      globalThis.setInterval = original;
      globalThis.clearInterval = clear;
    },
  };
}

test('a real blocked health update leaves observations unreported and critical writes refused, then recovers', () => {
  const f = fixture();
  try {
    const worker = new ReportWorker(f.store, async () => ({}));
    f.blocker.db.exec('BEGIN IMMEDIATE');
    assert.equal(worker.heartbeat(), false);
    assert.equal(f.store.db.isTransaction, false);
    assert.equal(operationsHealth(f.store, 'tenant').worker.status, 'not_observed');
    assert.throws(() => f.store.putDocument('tenant', 'critical', 'result', {}), isBusy);
    f.blocker.db.exec('ROLLBACK');
    assert.equal(worker.heartbeat(), true);
    const observation = operationsHealth(f.store, 'tenant').worker;
    assert.equal(observation.status, 'active');
    assert.equal(observation.observations.length, 1);
    assert.equal(observation.observations[0].state, 'idle');
  } finally {
    f.close();
  }
});

test('blocked initial, working and final health observations cannot discard an actual completed job or re-execute it', async () => {
  const f = fixture();
  try {
    const id = f.store.enqueue('tenant', 'synthetic', {});
    let executions = 0;
    const worker = new ReportWorker(
      f.store,
      async () => ({}),
      async () => {
        executions++;
        return {value: 'retained-result'};
      },
    );
    const restore = blockHealth(f);
    assert.equal(await worker.once(), true);
    assert.equal(executions, 1);
    const job = f.store.job('tenant', id);
    assert.equal(job.state, 'complete');
    assert.deepEqual(job.result, {value: 'retained-result'});
    assert.equal(job.attempts, 1);
    assert.equal(await worker.once(), false);
    assert.equal(executions, 1);
    assert.equal(operationsHealth(f.store, 'tenant').worker.status, 'not_observed');
    restore();
    assert.equal(worker.heartbeat(), true);
    assert.equal(operationsHealth(f.store, 'tenant').worker.status, 'active');
  } finally {
    f.close();
  }
});

test('a real busy heartbeat still renews the original lease independently before completing once', async () => {
  const f = fixture(),
    interval = intervalFixture();
  try {
    const id = f.store.enqueue('tenant', 'synthetic', {});
    let renewals = 0;
    const renew = f.store.renewJob.bind(f.store);
    f.store.renewJob = (...args) => {
      renewals++;
      return renew(...args);
    };
    blockHealth(f);
    const worker = new ReportWorker(
      f.store,
      async () => ({}),
      async () => {
        interval.tick();
        return {renewed: true};
      },
    );
    assert.equal(await worker.once(), true);
    assert.equal(renewals, 1);
    assert.equal(f.store.job('tenant', id).state, 'complete');
    assert.deepEqual(f.store.job('tenant', id).result, {renewed: true});
    assert.equal(f.store.job('tenant', id).attempts, 1);
    assert.equal(interval.cleared, true);
  } finally {
    interval.close();
    f.close();
  }
});

test('non-busy health errors propagate and a busy critical lease renewal still withholds completion', async () => {
  const f = fixture(),
    interval = intervalFixture();
  try {
    const worker = new ReportWorker(
      f.store,
      async () => ({}),
      async () => {
        interval.tick();
        return {must_not_complete: true};
      },
    );
    const put = f.store.putDocument.bind(f.store);
    for (const error of [
      Object.assign(Error('IO failure'), {code: 'ERR_SQLITE_ERROR', errcode: 10}),
      Object.assign(Error('local lock'), {code: 'ERR_SQLITE_ERROR', errcode: 6}),
      Error('unexpected'),
    ]) {
      f.store.putDocument = () => {
        throw error;
      };
      assert.throws(
        () => worker.heartbeat(),
        actual => actual === error,
      );
    }
    f.store.putDocument = put;
    const id = f.store.enqueue('tenant', 'synthetic', {});
    const renew = f.store.renewJob.bind(f.store);
    f.store.renewJob = (...args) => {
      f.blocker.db.exec('BEGIN IMMEDIATE');
      try {
        return renew(...args);
      } finally {
        f.blocker.db.exec('ROLLBACK');
      }
    };
    assert.equal(await worker.once(), true);
    assert.equal(f.store.job('tenant', id).state, 'running');
    assert.equal(f.store.job('tenant', id).result, null);
    assert.equal(interval.cleared, true);
  } finally {
    interval.close();
    f.close();
  }
});

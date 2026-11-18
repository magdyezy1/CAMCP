import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Store} from '../dist/src/store.js';
import {runWorkerBenchmark} from '../tools/benchmark-workers.mjs';
import {removeTestDirectory} from '../dist/tests/temp.js';

const script = fileURLToPath(new URL('./fixtures/queue-worker.mjs', import.meta.url)),
  key = Buffer.alloc(32, 83).toString('base64');
test('four actual worker processes qualify leases, fair equal backlogs, schedule de-duplication and original authority', async () => {
  const result = await runWorkerBenchmark(4, {
    tenants: 4,
    jobsPerTenant: 8,
    delayMs: 1,
    revokedPerTenant: 1,
    schedulesPerTenant: 2,
  });
  assert.equal(result.unique_dispatches, 44);
  assert.equal(result.completed, 40);
  assert.equal(result.revoked_refused, 4);
  assert.equal(result.duplicate_dispatches, 0);
  assert.equal(result.cross_tenant_results, 0);
  assert.equal(result.equal_backlog_round_robin, true);
  assert.equal(result.schedule_duplicate_enqueues, 0);
  assert.equal(result.original_authority_revocation_verified, true);
  assert.equal(result.audit_chain_verified, true);
  assert.equal(result.provider_requests, 0);
  assert.equal(result.advertising_writes, 0);
  assert.ok(result.claim_p95_ms >= result.claim_p50_ms);
});

test('benchmark refuses unbounded worker, tenant, job, delay and schedule counts before creating a database', async () => {
  for (const [workers, options] of [
    [0, {}],
    [7, {}],
    [1, {tenants: 0}],
    [1, {tenants: 13}],
    [1, {jobsPerTenant: 101}],
    [1, {delayMs: 31}],
    [1, {revokedPerTenant: 6}],
    [1, {schedulesPerTenant: 6}],
  ])
    await assert.rejects(runWorkerBenchmark(workers, options), /Invalid bounded/);
});

async function heldWorker(change) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-worker-benchmark-')),
    file = path.join(dir, 'fixture.sqlite'),
    store = new Store(file, key);
  let child;
  try {
    store.db.exec(
      'CREATE TABLE benchmark_dispatch(ordinal INTEGER PRIMARY KEY,job_id TEXT UNIQUE NOT NULL,tenant_id TEXT NOT NULL,worker INTEGER NOT NULL)',
    );
    const token = store.createKey({tenantId: 'held', userId: 'operator', role: 'admin'}),
      actor = store.authenticate(token);
    const id = store.enqueueReport(actor, {
      query_config: {
        platform: 'meta',
        account_id: '100',
        synthetic_tenant: 'held',
        synthetic_sequence: 1,
        synthetic_native_id: '9007199254740993',
        synthetic_barrier: true,
      },
    });
    child = fork(script, [file, '0', '0', 'once'], {windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
    let diagnostics = '',
      held = false,
      summary;
    child.stderr.on('data', chunk => {
      diagnostics = (diagnostics + chunk).slice(-8192);
    });
    const done = new Promise((resolve, reject) => {
      child.on('message', message => {
        if (message.state === 'ready') child.send('start');
        if (message.state === 'held') {
          held = true;
          try {
            change(store, id, token);
            child.send('release');
          } catch (e) {
            reject(e);
            child.kill();
          }
        }
        if (message.state === 'done') summary = message;
      });
      child.on('error', reject);
      child.on('exit', code =>
        code === 0 && summary ? resolve(summary) : reject(Error(diagnostics || 'No worker summary')),
      );
    });
    let timer;
    try {
      await Promise.race([
        done,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('Authority barrier timed out')), 15000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    assert.equal(held, true);
    assert.equal(summary.executed.length, 0);
    return change.verify(store, id);
  } finally {
    if (child?.exitCode === null && child.signalCode === null)
      await new Promise(resolve => {
        child.once('exit', resolve);
        child.kill();
      });
    store.close();
    removeTestDirectory(dir, 'amcp-worker-benchmark-');
  }
}

test('actual worker withholds a pending result after another connection revokes the original creator', async () => {
  const change = (store, id, token) => store.revokeKey(token);
  change.verify = (store, id) => {
    const row = store.job('held', id);
    assert.equal(row.state, 'failed');
    assert.equal(row.result, null);
    assert.equal(row.error.code, 'UNAUTHORIZED');
    assert.equal(row.attempts, 1);
    assert.equal(store.verifyAudit(), true);
  };
  await heldWorker(change);
});

test('expired actual worker cannot complete the next lease generation or overwrite its eventual result', async () => {
  let originalToken;
  const change = (store, id) => {
    originalToken = store.db.prepare('SELECT lease_token FROM jobs WHERE id=?').get(id).lease_token;
    // The expiry is a minute in the past, not a millisecond: the worker is another process, whose Date.now() can read a few milliseconds
    // behind this one's (on Windows, up to a timer tick), and a lease that expired 1 ms ago here could still look live there, so the
    // worker would execute the job this test expects it to withhold (R2.5 M3 round 2, the lead's review, answer 6). A lease is 60 s long.
    store.db.prepare('UPDATE jobs SET lease_until=? WHERE id=?').run(Date.now() - 60000, id);
  };
  change.verify = (store, id) => {
    assert.equal(store.job('held', id).result, null);
    const recovered = store.leaseJob(60000);
    assert.equal(recovered.id, id);
    assert.equal(recovered.attempts, 2);
    assert.notEqual(recovered.lease_token, originalToken);
    assert.throws(
      () => store.finishJob(id, originalToken, {wrong: true}),
      e => e.code === 'STALE_JOB_LEASE',
    );
    assert.throws(
      () => store.renewJob(id, originalToken),
      e => e.code === 'STALE_JOB_LEASE',
    );
    assert.throws(
      () => store.failJob(id, originalToken, {wrong: true}),
      e => e.code === 'STALE_JOB_LEASE',
    );
    store.finishJob(id, recovered.lease_token, {native_id: '9007199254740993'});
    assert.deepEqual(store.job('held', id).result, {native_id: '9007199254740993'});
    assert.equal(store.verifyAudit(), true);
  };
  await heldWorker(change);
});

test('synthetic child refuses a database outside the owned benchmark directory before opening or creating it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-worker-refusal-')),
    file = path.join(dir, 'fixture.sqlite');
  let child;
  try {
    child = fork(script, [file, '0', '0'], {windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
    let diagnostics = '';
    child.stderr.on('data', chunk => {
      diagnostics += chunk;
    });
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', resolve);
    });
    assert.notEqual(code, 0);
    assert.match(diagnostics, /owned synthetic temporary database/);
    assert.equal(fs.existsSync(file), false);
  } finally {
    if (child?.exitCode === null && child.signalCode === null)
      await new Promise(resolve => {
        child.once('exit', resolve);
        child.kill();
      });
    removeTestDirectory(dir, 'amcp-worker-refusal-');
  }
});

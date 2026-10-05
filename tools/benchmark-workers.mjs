import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {Store} from '../dist/src/store.js';
import {removeTestDirectory} from '../dist/tests/temp.js';

/** Bounded synthetic workloads only. Never accepts a database path or loads deployed configuration. */
export async function runWorkerBenchmark(
  workers,
  {tenants = 6, jobsPerTenant = 20, delayMs = 5, revokedPerTenant = 2, schedulesPerTenant = 2} = {},
) {
  for (const [value, min, max] of [
    [workers, 1, 6],
    [tenants, 1, 12],
    [jobsPerTenant, 1, 100],
    [delayMs, 0, 30],
    [revokedPerTenant, 0, 5],
    [schedulesPerTenant, 0, 5],
  ])
    if (!Number.isInteger(value) || value < min || value > max) throw Error('Invalid bounded synthetic workload');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-worker-benchmark-')),
    database = path.join(directory, 'fixture.sqlite');
  const key = Buffer.alloc(32, 83).toString('base64'),
    children = [],
    jobs = [],
    tokens = [],
    schedules = [];
  let store;
  try {
    store = new Store(database, key);
    store.db.exec(
      'CREATE TABLE benchmark_dispatch(ordinal INTEGER PRIMARY KEY,job_id TEXT UNIQUE NOT NULL,tenant_id TEXT NOT NULL,worker INTEGER NOT NULL)',
    );
    for (let t = 0; t < tenants; t++) {
      const tenant = 'worker-' + String(t).padStart(2, '0'),
        local = {tenantId: tenant, userId: 'synthetic-operator', role: 'admin'};
      const token = store.createKey(local),
        actor = store.authenticate(token);
      tokens.push(token);
      const config = i => ({
        platform: 'meta',
        account_id: '100',
        synthetic_tenant: tenant,
        synthetic_sequence: i,
        synthetic_native_id: String(9007199254740993n + BigInt(t * 1000 + i)),
      });
      for (let i = 0; i < jobsPerTenant; i++)
        jobs.push({id: store.enqueueReport(actor, {query_config: config(i)}), tenant, sequence: i});
      for (let i = 0; i < revokedPerTenant; i++) {
        const revoked = store.createKey({...local, userId: 'synthetic-revoked-' + i}),
          bound = store.authenticate(revoked);
        jobs.push({id: store.enqueueReport(bound, {query_config: config(jobsPerTenant + i)}), tenant, revoked: true});
        store.revokeKey(revoked);
      }
      for (let i = 0; i < schedulesPerTenant; i++) {
        const id = 'schedule-' + i,
          sequence = jobsPerTenant + revokedPerTenant + i;
        store.putDocument(tenant, 'reporting_query', id, {name: 'Synthetic', query_config: config(sequence)});
        store.putDocument(tenant, 'reporting_schedule', id, {
          name: 'Synthetic',
          is_active: true,
          next_run_at: Date.now() - 1000,
          timezone: 'UTC',
          schedule_kind: 'daily',
          schedule_config: {hour: 0, minute: 0, query_id: id},
          actor_binding: store.bindJobActor(actor, 'reporting-schedule:' + id),
        });
        schedules.push({id, tenant, sequence});
      }
    }
    store.close();
    store = undefined;
    const script = fileURLToPath(new URL('../tests/fixtures/queue-worker.mjs', import.meta.url)),
      ready = [],
      done = [];
    const started = performance.now();
    for (let i = 0; i < workers; i++) {
      const child = fork(script, [database, String(i), String(delayMs)], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      children.push(child);
      let diagnostics = '',
        summary;
      child.stderr.on('data', chunk => {
        diagnostics = (diagnostics + chunk).slice(-8192);
      });
      ready.push(
        new Promise((resolve, reject) => {
          child.on('message', message => {
            if (message.state === 'ready') resolve();
          });
          child.on('error', reject);
          child.on('exit', code => {
            if (code !== 0) reject(Error('Synthetic worker startup failed: ' + diagnostics));
          });
        }),
      );
      done.push(
        new Promise((resolve, reject) => {
          child.on('message', message => {
            if (message.state === 'done') summary = message;
          });
          child.on('error', reject);
          child.on('exit', code =>
            code === 0 && summary ? resolve(summary) : reject(Error('Synthetic worker failed: ' + diagnostics)),
          );
        }),
      );
    }
    // Attach rejection handlers while waiting at the start barrier; never leave rejected child promises unhandled.
    const completion = Promise.all(done);
    completion.catch(() => {});
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Synthetic worker deadline exceeded')), 90000);
    });
    let metrics;
    try {
      await Promise.race([Promise.all(ready), timeout]);
      for (const child of children) child.send('start');
      metrics = await Promise.race([completion, timeout]);
    } finally {
      clearTimeout(timer);
    }
    const elapsed = performance.now() - started;
    store = new Store(database, key);
    const dispatch = store.db
      .prepare('SELECT ordinal,job_id,tenant_id,worker FROM benchmark_dispatch ORDER BY ordinal')
      .all();
    const expected = tenants * (jobsPerTenant + revokedPerTenant + schedulesPerTenant);
    if (dispatch.length !== expected || new Set(dispatch.map(r => r.job_id)).size !== expected)
      throw Error('Duplicate or missing job dispatch');
    for (let i = 0; i < dispatch.length; i += tenants)
      if (new Set(dispatch.slice(i, i + tenants).map(r => r.tenant_id)).size !== tenants)
        throw Error('Equal eligible tenant backlogs did not receive round-robin dispatch');
    const records = store.db
      .prepare('SELECT id,tenant_id,input,state,result,error,attempts FROM jobs ORDER BY id')
      .all();
    if (records.length !== expected) throw Error('Schedule was enqueued more than once');
    const completed = records.filter(r => r.state === 'complete'),
      refused = records.filter(r => r.state === 'failed');
    if (
      completed.length !== tenants * (jobsPerTenant + schedulesPerTenant) ||
      refused.length !== tenants * revokedPerTenant
    )
      throw Error(
        'Unexpected worker outcome counts: ' +
          JSON.stringify({
            expected_completed: tenants * (jobsPerTenant + schedulesPerTenant),
            expected_refused: tenants * revokedPerTenant,
            completed: completed.length,
            refused: refused.length,
            other_states: records.length - completed.length - refused.length,
            failure_codes: refused.reduce((counts, row) => {
              const code = JSON.parse(row.error).code,
                safe = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'UNKNOWN';
              counts[safe] = (counts[safe] ?? 0) + 1;
              return counts;
            }, {}),
          }),
      );
    for (const row of completed) {
      const result = JSON.parse(row.result),
        config = JSON.parse(row.input).query_config;
      if (
        result.tenant_id !== row.tenant_id ||
        result.native_id !== config.synthetic_native_id ||
        result.sequence !== config.synthetic_sequence ||
        row.attempts !== 1
      )
        throw Error('Result crossed tenant, exact ID or job generation');
    }
    for (const row of refused)
      if (JSON.parse(row.error).code !== 'UNAUTHORIZED' || row.result !== null || row.attempts !== 1)
        throw Error('Revoked original authority did not withhold the result');
    for (const schedule of schedules) {
      const current = store.document(schedule.tenant, 'reporting_schedule', schedule.id);
      if (current.revision !== 2 || current.next_run_at <= Date.now() || !current.last_run_id)
        throw Error('Schedule revision or next window is incorrect');
    }
    for (const token of tokens) store.revokeKey(token);
    let reauthorized = false;
    for (const row of completed)
      try {
        store.restoreJobActor(row.tenant_id, 'job:' + row.id, JSON.parse(row.input).authority.binding);
        reauthorized = true;
      } catch (e) {
        if (e.code !== 'UNAUTHORIZED') throw e;
      }
    if (reauthorized) throw Error('Revoked original job authority remained usable');
    if (!store.verifyAudit()) throw Error('Audit hash chain failed under contention');
    const claims = metrics.flatMap(m => m.claims_ms).sort((a, b) => a - b),
      executed = metrics.flatMap(m => m.executed);
    if (executed.length !== completed.length) throw Error('Executed callback count differs from completed results');
    return {
      synthetic: true,
      workers,
      workload: {
        tenants,
        jobs_per_tenant: jobsPerTenant,
        revoked_per_tenant: revokedPerTenant,
        schedules_per_tenant: schedulesPerTenant,
        synthetic_callback_delay_ms: delayMs,
      },
      elapsed_ms: elapsed,
      completed: completed.length,
      revoked_refused: refused.length,
      unique_dispatches: dispatch.length,
      duplicate_dispatches: 0,
      schedule_duplicate_enqueues: 0,
      cross_tenant_results: 0,
      equal_backlog_round_robin: true,
      original_authority_revocation_verified: true,
      audit_chain_verified: true,
      claim_p50_ms: claims[Math.floor(claims.length / 2)],
      claim_p95_ms: claims[Math.ceil(claims.length * 0.95) - 1],
      max_sampled_worker_rss_bytes: Math.max(...metrics.map(m => m.sampled_rss_bytes)),
      worker_job_counts: metrics.map(m => ({index: m.index, executed: m.executed.length})),
      environment: {
        node: process.version,
        platform: process.platform,
        sqlite: store.db.prepare('SELECT sqlite_version() v').get().v,
      },
      provider_requests: 0,
      advertising_writes: 0,
    };
  } finally {
    await Promise.all(
      children.map(child =>
        child.exitCode === null && child.signalCode === null
          ? new Promise(resolve => {
              child.once('exit', resolve);
              child.kill();
            })
          : Promise.resolve(),
      ),
    );
    store?.close();
    removeTestDirectory(directory, 'amcp-worker-benchmark-');
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw Error('Run this benchmark without arguments');
  const cohorts = [];
  for (const count of [1, 4]) cohorts.push(await runWorkerBenchmark(count));
  console.log(
    JSON.stringify(
      {
        benchmark: 'worker-queue-contention',
        created_at: new Date().toISOString(),
        synthetic: true,
        cohorts,
        qualification:
          'Local child processes on one owned temporary WAL database. Actual ReportWorker scheduling/leases with instrumented nested transactions and synthetic 5 ms callbacks. No live native reads/writes, real tenants, production queue or deployed-capacity claim. Worker counts are observations, not a deployment recommendation.',
      },
      null,
      2,
    ),
  );
}

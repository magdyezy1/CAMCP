// OPS-07: lease-expiry cap and backoff, per-stage isolation and backoff, the storage pause, bounded failure logs and
// graceful drain. Synthetic jobs on owned temporary or in-memory databases; no provider request is allowed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {ReportWorker} from '../dist/src/worker.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {ReportCollectionBudget} from '../dist/src/report-collection-budget.js';
import {operationsHealth} from '../dist/src/operations-health.js';
import {runWorkerLoop, stageFailureLog, workerStageHealth, STAGE_BACKOFF_AFTER_MS} from '../dist/src/worker-loop.js';
import {LEASE_EXPIRY_LIMIT, WORKER_BOOT_ID, leaseExpiryDelay} from '../dist/src/job-leases.js';
import {gracefulShutdown} from '../dist/server/shutdown.js';

const key = Buffer.alloc(32, 73).toString('base64'),
  tenant = 'resilience-fixture';
const store = () => new Store(':memory:', key);
const expire = (s, id, boot) =>
  s.db
    .prepare('UPDATE jobs SET lease_until=?' + (boot ? ',lease_boot=?' : '') + ' WHERE id=?')
    .run(...[Date.now() - 1, ...(boot ? [boot] : []), id]);
const row = (s, id) => s.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
const audits = (s, event) =>
  s.db
    .prepare('SELECT event FROM audit WHERE tenant_id=? ORDER BY seq')
    .all(tenant)
    .map(r => JSON.parse(r.event))
    .filter(e => e.event === event);
function deferred() {
  let resolve;
  const promise = new Promise(done => (resolve = done));
  return {promise, resolve};
}

test('repeatedly expiring leases back off and end in failed LEASE_EXPIRY_LIMIT (regression: requeued forever)', () => {
  // The old requeue re-dispatched 25 consecutive expired leases with attempts 25, error null and available_at unchanged.
  const s = store();
  try {
    const id = s.enqueue(tenant, 'report_file_export', {}),
      gaps = [];
    let leased = s.leaseJob(60000);
    for (let expiry = 1; expiry <= LEASE_EXPIRY_LIMIT; expiry++) {
      assert.equal(leased?.id, id, 'lease before expiry ' + expiry);
      assert.equal(row(s, id).lease_boot, WORKER_BOOT_ID, 'each lease records this process boot');
      expire(s, id);
      // Leasing processes the expiry; only the first one (a dead worker's job) is available again at once.
      const next = s.leaseJob(60000),
        after = row(s, id),
        error = JSON.parse(after.error);
      gaps.push(after.available_at - after.updated_at);
      assert.equal(after.lease_expiries, expiry);
      if (expiry < LEASE_EXPIRY_LIMIT) {
        assert.equal(error.code, 'LEASE_EXPIRED');
        assert.equal(error.details.lease_expiries, expiry);
        if (expiry === 1) assert.equal(next?.id, id);
        else {
          assert.equal(next, undefined, 'backing off');
          // Simulate the backoff elapsing.
          s.db.prepare('UPDATE jobs SET available_at=0 WHERE id=?').run(id);
          leased = s.leaseJob(60000);
        }
        if (expiry === 1) leased = next;
      } else {
        assert.equal(after.state, 'failed');
        assert.equal(error.code, 'LEASE_EXPIRY_LIMIT');
        assert.equal(error.details.reason, 'expiry_limit');
      }
    }
    assert.deepEqual(gaps.slice(0, -1), [0, 5000, 10000, 20000], 'available_at grows');
    assert.deepEqual([1, 2, 3, 4, 5, 8, 12].map(leaseExpiryDelay), [0, 5000, 10000, 20000, 40000, 300000, 300000]);
    assert.equal(s.leaseJob(60000), undefined, 'a failed job is never leased again');
    assert.equal(row(s, id).attempts, LEASE_EXPIRY_LIMIT);
    const audited = audits(s, 'job_lease_expired');
    assert.equal(audited.length, LEASE_EXPIRY_LIMIT, 'every expiry is audited in its leasing transaction');
    assert.deepEqual(
      audited.map(a => a.outcome),
      ['requeued', 'requeued', 'requeued', 'requeued', 'failed'],
    );
    assert.equal(s.verifyAudit(), true);
    // The public job view keeps its shape; the counters stay internal and the error explains them.
    assert.equal('lease_expiries' in s.job(tenant, id), false);
    assert.equal('lease_boot' in s.job(tenant, id), false);
  } finally {
    s.close();
  }
});

test('a job that survives a lease expiry and then completes carries no error (F-L5-33)', () => {
  const s = store();
  try {
    const id = s.enqueue(tenant, 'report_file_export', {});
    s.leaseJob(60000);
    expire(s, id);
    // The first expiry of a dead worker's job is available again at once.
    const resumed = s.leaseJob(60000);
    assert.equal(resumed.id, id);
    assert.equal(JSON.parse(row(s, id).error).code, 'LEASE_EXPIRED', 'while it runs, the last expiry is on record');
    s.finishJob(id, resumed.lease_token, {rows: 1});
    const done = s.job(tenant, id);
    assert.deepEqual([done.state, done.attempts, done.error], ['complete', 2, null]);
    assert.deepEqual(done.result, {rows: 1});
    // A job that fails keeps its error, and one that finished without ever expiring has none.
    const failing = s.enqueue(tenant, 'report_file_export', {}),
      leased = s.leaseJob(60000);
    assert.equal(leased.id, failing);
    s.failJob(failing, leased.lease_token, {code: 'SYNTHETIC', message: 'fails'});
    assert.equal(s.job(tenant, failing).error.code, 'SYNTHETIC');
  } finally {
    s.close();
  }
});

test('two expiries of leases taken by an earlier process boot quarantine the job; resume resets every counter', () => {
  const s = store(),
    actor = {tenantId: tenant, userId: 'synthetic-operator', role: 'admin'};
  try {
    s.ensureTenant(tenant);
    const id = s.enqueueReport(actor, {query_config: {}});
    s.leaseJob(60000);
    expire(s, id, 'previous-boot');
    const first = s.leaseJob(60000);
    assert.equal(first.id, id, 'one crash-attributed expiry is recovered at once');
    let error = JSON.parse(row(s, id).error);
    assert.deepEqual(
      [error.code, error.details.crash_attributed, error.details.crash_expiries],
      ['LEASE_EXPIRED', true, 1],
    );
    expire(s, id, 'another-previous-boot');
    assert.equal(s.leaseJob(60000), undefined);
    const quarantined = row(s, id);
    error = JSON.parse(quarantined.error);
    assert.equal(quarantined.state, 'failed');
    assert.deepEqual(
      [error.code, error.details.reason, quarantined.crash_expiries],
      ['LEASE_EXPIRY_LIMIT', 'crash_quarantine', 2],
    );
    // Explicit resume: queued again with fresh counters.
    s.resumeReport(actor, id);
    const resumed = row(s, id);
    assert.deepEqual(
      [resumed.state, resumed.attempts, resumed.lease_expiries, resumed.crash_expiries, resumed.error],
      ['queued', 0, 0, 0, null],
    );
    assert.equal(s.leaseJob(60000).id, id);
  } finally {
    s.close();
  }
});

test('expiries of leases held by another live worker process are slow jobs, not crashes (regression: two workers)', () => {
  const s = store(),
    actor = {tenantId: tenant, userId: 'synthetic-operator', role: 'admin'};
  // The job is running under a lease of another process boot, and that lease has just expired.
  const runningUnder = (id, boot) =>
    s.db
      .prepare(
        "UPDATE jobs SET state='running',lease_until=?,lease_boot=?,lease_token='other',available_at=0 WHERE id=?",
      )
      .run(Date.now() - 1, boot, id);
  const heartbeat = at =>
    s.putDocument('__service_limits__', 'worker_heartbeat', 'other-process', {
      at,
      state: 'working',
      boot: 'other-boot',
    });
  try {
    s.ensureTenant(tenant);
    const id = s.enqueueReport(actor, {query_config: {}});
    // A second worker process on the same database heartbeats with its own boot ID while its job runs long.
    heartbeat(Date.now());
    for (const expiry of [1, 2]) {
      runningUnder(id, 'other-boot');
      s.leaseJob(60000);
      const job = row(s, id),
        error = JSON.parse(job.error);
      assert.deepEqual(
        [error.code, error.details.lease_expiries, error.details.crash_attributed, job.crash_expiries],
        ['LEASE_EXPIRED', expiry, false, 0],
        'expiry ' + expiry + ' of a live boot is never crash-attributed',
      );
      assert.notEqual(job.state, 'failed', 'live-boot expiries do not quarantine the job');
    }
    // Once that boot stops heartbeating (older than 90 s), its expired leases are crash-attributed again.
    heartbeat(Date.now() - 91000);
    runningUnder(id, 'other-boot');
    s.leaseJob(60000);
    const job = row(s, id);
    assert.deepEqual([JSON.parse(job.error).details.crash_attributed, job.crash_expiries], [true, 1]);
  } finally {
    s.close();
  }
});

test('a failing schedule stage backs off after ten seconds while the job stage keeps running', async () => {
  let clock = 1_000_000,
    jobs = 0,
    scheduleCalls = 0,
    stopping = false,
    healthWhileBackingOff;
  const failures = [],
    scheduleAt = [],
    jobAt = [],
    pauses = [];
  await runWorkerLoop({
    now: () => clock,
    random: () => 1,
    schedule: () => {
      scheduleCalls++;
      scheduleAt.push(clock);
      throw Object.assign(Error('synthetic schedule failure'), {code: 'SYNTHETIC_SCHEDULE'});
    },
    deliverEmails: async () => {},
    work: async () => {
      jobs++;
      jobAt.push(clock);
      const health = workerStageHealth(clock);
      if (health.stages.schedule.state === 'backing_off') healthWhileBackingOff ??= health;
      return false;
    },
    shouldStop: () => stopping,
    onFailure: failure => failures.push(failure),
    pause: async ms => {
      pauses.push(ms);
      clock += ms;
      if (clock - 1_000_000 >= 300000) stopping = true;
    },
  });
  // Ten one-second retries, then 2 s, 4 s, ... capped at 60 s (jitter at its upper bound here).
  const gaps = scheduleAt.slice(1).map((at, i) => at - scheduleAt[i]);
  assert.deepEqual(gaps.slice(0, 10), Array(10).fill(1000));
  assert.deepEqual(gaps.slice(10, 17), [2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  assert.ok(gaps.every(gap => gap <= 60000));
  assert.ok(jobs > 200, 'the job stage runs in every cycle the schedule stage is backing off: ' + jobs);
  // Stage isolation: the job stage also runs in the very cycle the schedule stage fails, before any backoff starts
  // (regression: a failure skipped the rest of its cycle, so jobs waited out the first ten seconds of a failing stage).
  for (const at of scheduleAt) assert.ok(jobAt.includes(at), 'the job stage ran in the failed cycle at ' + at);
  assert.equal(failures.length, scheduleCalls);
  assert.ok(
    pauses.every(ms => ms === 1000),
    'cycles keep the one-second pace',
  );
  assert.equal(healthWhileBackingOff.stages.schedule.state, 'backing_off');
  assert.equal(healthWhileBackingOff.stages.schedule.last_code, 'SYNTHETIC_SCHEDULE');
  assert.equal(healthWhileBackingOff.stages.job.state, 'ok');
  assert.ok(STAGE_BACKOFF_AFTER_MS === 10000);
});

test('jitter only shortens a stage backoff, and a success resets it', async () => {
  let clock = 0,
    stopping = false,
    calls = 0;
  const at = [];
  await runWorkerLoop({
    now: () => clock,
    random: () => 0,
    schedule: () => {
      calls++;
      at.push(clock);
      if (calls === 14) return; // recovers
      if (calls > 15) stopping = true;
      throw Object.assign(Error('x'), {code: 'SYNTHETIC'});
    },
    deliverEmails: async () => {},
    work: async () => false,
    shouldStop: () => stopping,
    onFailure: () => {},
    pause: async ms => {
      clock += ms;
    },
  });
  const gaps = at.slice(1).map((t, i) => t - at[i]);
  // 75% of 2 s, 4 s and 8 s, observed at the one-second cycle (1.5 s waits for the next whole cycle).
  assert.deepEqual(gaps.slice(10, 13), [2000, 3000, 6000]);
  assert.deepEqual(gaps.slice(13), [1000, 1000], 'after a success the next failure retries on the next cycle');
});

test('SQLite full pauses every stage and probes storage every 30 seconds until a write succeeds', async () => {
  let clock = 0,
    stopping = false,
    probes = 0;
  const events = [],
    calls = [],
    probeAt = [];
  const full = Object.assign(Error('database or disk is full'), {code: 'ERR_SQLITE_ERROR', errcode: 13});
  let failed = false,
    pausedHealth;
  await runWorkerLoop({
    now: () => clock,
    schedule: () => calls.push('schedule'),
    deliverEmails: async () => calls.push('email_delivery'),
    work: async () => {
      calls.push('job');
      if (!failed) {
        failed = true;
        throw full;
      }
      stopping = true;
      return true;
    },
    shouldStop: () => stopping,
    onFailure: () => {},
    onEvent: event => events.push(event),
    storageProbe: () => {
      probes++;
      probeAt.push(clock);
      pausedHealth ??= workerStageHealth(clock);
      return probes === 3;
    },
    pause: async ms => {
      clock += ms;
    },
  });
  assert.deepEqual(probeAt, [30000, 60000, 90000]);
  assert.deepEqual(calls, ['schedule', 'email_delivery', 'job', 'schedule', 'email_delivery', 'job'], 'no stage ran');
  assert.deepEqual(
    events.map(e => [e.level, e.event, e.database?.name]),
    [
      ['warn', 'worker_storage_paused', 'SQLITE_FULL'],
      ['info', 'worker_storage_resumed', undefined],
    ],
  );
  assert.equal(pausedHealth.storage_paused, true);
  assert.equal(pausedHealth.stages.schedule.state, 'paused');
});

test('a persistent stage failure writes its first line, then at most one summary per stage per minute', () => {
  let clock = 0;
  const lines = [],
    log = stageFailureLog(
      line => lines.push(line),
      () => clock,
    );
  for (let i = 1; i <= 300; i++) {
    log({event: 'worker_stage_failed', stage: 'schedule', code: 'SQLITE', consecutive_failures: i, at: 'x'});
    if (i % 2) log({event: 'worker_stage_failed', stage: 'job', code: 'JOB', consecutive_failures: i, at: 'x'});
    clock += 1000;
  }
  const schedule = lines.filter(l => l.stage === 'schedule'),
    job = lines.filter(l => l.stage === 'job');
  assert.equal(schedule.length, 5, 'one first line and one summary per minute over five minutes');
  assert.equal(schedule[0].event, 'worker_stage_failed');
  assert.ok(schedule.slice(1).every(l => l.event === 'worker_stage_failures' && l.count === 60));
  assert.ok(job.length <= 5);
  assert.ok(lines.every(l => l.level === 'error'));
});

function auxiliaryFixture(kind) {
  const s = store(),
    entered = deferred(),
    release = deferred();
  let checkLease;
  const worker = new ReportWorker(
    s,
    async () => {
      throw Error('Unexpected report executor');
    },
    async (_tenant, _kind, input) => {
      checkLease = () => {
        const current = s.db.prepare('SELECT state,lease_token FROM jobs WHERE id=?').get(input.__job_id);
        if (current.state !== 'running' || current.lease_token !== input.__lease_token)
          throw Object.assign(Error('stale'), {code: 'STALE_JOB_LEASE'});
      };
      entered.resolve();
      await release.promise;
      checkLease();
      return {synthetic: true};
    },
  );
  const id = s.enqueue(tenant, kind, {});
  return {s, worker, id, entered, release};
}

test('stopping during a read-only job returns it to the queue at once with unchanged attempts', async () => {
  const f = auxiliaryFixture('report_file_export');
  try {
    const running = f.worker.once();
    await f.entered.promise;
    assert.equal(row(f.s, f.id).attempts, 1);
    const started = Date.now(),
      drained = f.worker.drain();
    assert.deepEqual(drained, {released: ['report_file_export'], settling: []});
    const queued = row(f.s, f.id);
    assert.equal(queued.state, 'queued');
    assert.equal(queued.attempts, 0, 'the interrupted attempt is not counted');
    assert.equal(JSON.parse(queued.error).code, 'SHUTDOWN');
    assert.ok(queued.available_at - started <= 1100, 'available again within about a second');
    assert.equal(queued.lease_token, null);
    f.release.resolve();
    assert.equal(await running, true);
    assert.equal(row(f.s, f.id).state, 'queued', 'the interrupted execution cannot complete or fail it');
    assert.equal(audits(f.s, 'report_failed').length + audits(f.s, 'report_lease_lost').length, 0);
    assert.equal(await f.worker.once(), false, 'a draining worker takes no new lease');
  } finally {
    f.s.close();
  }
});

test('a job that may be mid-mutation is never interrupted by a stop: it settles and completes', async () => {
  const f = auxiliaryFixture('sheets_export');
  try {
    const running = f.worker.once();
    await f.entered.promise;
    assert.deepEqual(f.worker.drain(), {released: [], settling: ['sheets_export']});
    assert.equal(row(f.s, f.id).state, 'running', 'the lease stays with the running write');
    f.release.resolve();
    await running;
    const done = row(f.s, f.id);
    assert.equal(done.state, 'complete');
    assert.deepEqual(JSON.parse(done.result), {synthetic: true});
  } finally {
    f.s.close();
  }
});

test('a report released at shutdown is not charged for the downtime that follows', () => {
  const s = store();
  try {
    s.ensureTenant(tenant);
    const service = new MirrorService(
        new Registry(),
        s,
        new NativeTransport(async () => {
          throw Error('No provider request is allowed');
        }),
      ),
      overview = new ReportingOverview(service),
      now = Date.now(),
      definition = 'synthetic-definition';
    s.putDocument(tenant, 'overview_report', 'r1', {
      state: 'running',
      collection_budget: {
        version: 1,
        definition,
        requests: 3,
        rows: 0,
        bytes: 0,
        elapsed_ms: 1000,
        row_counts: {},
        active_since: now - 4000,
      },
    });
    overview.releaseJob(tenant, 'report_overview', {report_id: 'r1'});
    const budget = s.document(tenant, 'overview_report', 'r1').collection_budget;
    assert.equal(budget.active_since, null);
    assert.ok(budget.elapsed_ms >= 5000 && budget.elapsed_ms < 5500, String(budget.elapsed_ms));
    // An hour of downtime later, the resumed budget starts from the saved elapsed time.
    let saved;
    new ReportCollectionBudget(
      budget,
      definition,
      state => (saved = state),
      undefined,
      () => 0,
      () => now + 3600000,
    );
    assert.ok(saved.elapsed_ms < 5500, 'no downtime charge: ' + saved.elapsed_ms);
    // Other kinds and missing reports are left alone.
    overview.releaseJob(tenant, 'sheets_export', {report_id: 'r1'});
    overview.releaseJob(tenant, 'report_overview', {report_id: 'missing'});
  } finally {
    s.close();
  }
});

test('graceful shutdown exits 0 within a second after releasing, waits for settling work, and stops at its deadline', async () => {
  const run = async (drained, workerDone, graceMs = 5000) => {
    const logs = [];
    let exited,
      closed = 0;
    const started = Date.now();
    const finished = new Promise(resolve => {
      gracefulShutdown({
        graceMs,
        log: entry => logs.push(entry),
        drain: () => drained,
        workerDone,
        close: () => closed++,
        exit: code => {
          exited = code;
          resolve();
        },
      });
    });
    await finished;
    return {exited, closed, logs, elapsed: Date.now() - started, events: logs.map(l => l.event)};
  };
  const never = new Promise(() => {});
  const released = await run({released: ['report_overview'], settling: []}, never);
  assert.equal(released.exited, 0);
  assert.ok(released.elapsed < 1800, String(released.elapsed));
  assert.deepEqual(released.events, ['shutdown_started', 'jobs_released', 'shutdown_completed']);
  assert.equal(released.closed, 1);
  const settle = deferred();
  setTimeout(() => settle.resolve(), 300);
  const settled = await run({released: [], settling: ['media_upload']}, settle.promise);
  assert.equal(settled.exited, 0);
  assert.ok(settled.elapsed >= 250);
  const stuck = await run({released: [], settling: ['media_upload']}, never, 200);
  assert.equal(stuck.exited, 1);
  assert.deepEqual(stuck.events, ['shutdown_started', 'jobs_released', 'shutdown_deadline']);
  assert.equal(stuck.closed, 0);
});

test('owner health shows this process worker stages', async () => {
  const s = store();
  try {
    let stopping = false;
    await runWorkerLoop({
      schedule: () => {
        throw Object.assign(Error('x'), {code: 'SYNTHETIC_OWNER_HEALTH'});
      },
      deliverEmails: async () => {},
      work: async () => false,
      shouldStop: () => stopping,
      onFailure: () => {},
      pause: async () => {
        stopping = true;
      },
    });
    const stages = operationsHealth(s, tenant).worker.stages;
    assert.equal(stages.storage_paused, false);
    assert.deepEqual(Object.keys(stages.stages), ['schedule', 'email_delivery', 'job']);
    assert.equal(stages.stages.schedule.consecutive_failures, 1);
    assert.equal(stages.stages.schedule.last_code, 'SYNTHETIC_OWNER_HEALTH');
  } finally {
    s.close();
  }
});

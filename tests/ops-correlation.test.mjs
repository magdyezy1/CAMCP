// OPS-08 correlation and runtime identity: the ingress request ID header and its log lines, job start/finish lines,
// event-loop delay and worker stage durations in owner health and the support bundle, and the recent-errors index.
// Synthetic local fixtures only; no provider request is allowed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {MirrorError} from '../dist/src/errors.js';
import {ReportWorker} from '../dist/src/worker.js';
import {runWorkerLoop} from '../dist/src/worker-loop.js';
import {operationsHealth, recentJobErrorsSQL} from '../dist/src/operations-health.js';
import {currentRequestId, runWithRequestId, REQUEST_ID_HEADER} from '../dist/src/request-context.js';
import {
  eventLoopDelay,
  EVENT_LOOP_WINDOW_MS,
  startEventLoopMonitor,
  stopEventLoopMonitor,
} from '../dist/src/runtime-metrics.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {logRuntimeStart, startFfmpegVersionProbe} from '../dist/src/storage-health.js';
import {listenForFetch} from '../dist/tests/http-listener.js';

const key = Buffer.alloc(32, 99).toString('base64'),
  owner = {tenantId: 'ops-correlation', userId: 'owner', role: 'admin'},
  uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function fixture() {
  const store = new Store(':memory:', key),
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
async function serve(f) {
  const listener = await listenForFetch(createHttpApp(f.service, f.store, {log: e => f.logs.push(e)})),
    base = 'http://127.0.0.1:' + listener.address().port;
  return {base, close: () => new Promise(done => listener.close(done))};
}

test('every response carries a server-generated X-AMCP-Request-Id that its refusal log names; a client value is never echoed', async () => {
  const f = fixture(),
    s = await serve(f);
  try {
    const health = await fetch(s.base + '/healthz');
    const first = health.headers.get(REQUEST_ID_HEADER);
    assert.match(first, uuid);
    const refused = await fetch(s.base + '/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [REQUEST_ID_HEADER]: 'PRIVATE-CLIENT-ID',
        'X-Request-ID': 'PRIVATE',
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
    assert.equal(refused.status, 401);
    const second = refused.headers.get(REQUEST_ID_HEADER);
    assert.match(second, uuid);
    assert.notEqual(second, first, 'one ID per request');
    const line = f.logs.find(entry => entry.event === 'mcp_refused');
    assert.equal(line.request_id, second, 'the refusal line names the header the client received');
    assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE/);
    assert.equal(f.requests(), 0);
  } finally {
    await s.close();
    f.store.close();
  }
});

test('a tool failure inside an HTTP request names its ingress ID beside the audit request ID; none is invented outside', async () => {
  const f = fixture();
  try {
    f.service.onToolFailure = entry => f.logs.push(entry);
    f.store.assertActorActive = () => {
      throw new Error('synthetic private failure text');
    };
    const outside = await f.service.call('amcp_tool_help', {}, owner);
    // The synthetic crash is the case under test: it is reported as INTERNAL_ERROR, never as its private text.
    assert.equal(outside.success, false);
    assert.equal(outside.error.code, 'INTERNAL_ERROR');
    assert.equal(currentRequestId(), undefined);
    const ingress = '00000000-0000-4000-8000-000000000001';
    const inside = await runWithRequestId(ingress, () => f.service.call('amcp_tool_help', {}, owner));
    assert.equal(inside.success, false);
    assert.equal(inside.error.code, 'INTERNAL_ERROR');
    const lines = f.logs.filter(entry => entry.event === 'mcp_tool_failed');
    assert.equal(lines.length, 2);
    assert.equal(Object.hasOwn(lines[0], 'http_request_id'), false);
    assert.equal(lines[1].http_request_id, ingress);
    assert.equal(lines[1].requestId, inside.meta.requestId, 'the audit request ID stays the envelope request ID');
    assert.notEqual(lines[1].requestId, ingress);
    assert.doesNotMatch(JSON.stringify(f.logs), /synthetic private failure text/);
    assert.throws(() => runWithRequestId('client-chosen', () => {}), /Invalid ingress request ID/);
  } finally {
    f.store.close();
  }
});

test('job_started and job_finished lines carry only ID, kind, attempt, duration, outcome and code', async () => {
  const store = new Store(':memory:', key),
    events = [];
  try {
    store.ensureTenant(owner.tenantId);
    const worker = new ReportWorker(
      store,
      async () => ({}),
      async (_tenant, kind) => {
        if (kind === 'synthetic_fail')
          throw new MirrorError('SYNTHETIC_FAILURE', 'secret failure message', {secret: 'PRIVATE-DETAIL'});
        if (kind === 'report_overview')
          throw new MirrorError('PLATFORM_RATE_LIMIT', 'secret retry message', {retry_after_ms: 1000}, 429, true);
        return {secret: 'PRIVATE-RESULT'};
      },
    );
    worker.onJobEvent = entry => events.push(entry);
    const ok = store.enqueue(owner.tenantId, 'synthetic_ok', {secret: 'PRIVATE-INPUT'}, 1),
      failed = store.enqueue(owner.tenantId, 'synthetic_fail', {secret: 'PRIVATE-INPUT'}, 2),
      retried = store.enqueue(owner.tenantId, 'report_overview', {report_id: 'PRIVATE-REPORT'}, 3);
    assert.equal(await worker.once(), true);
    assert.equal(await worker.once(), true);
    assert.equal(await worker.once(), true);
    assert.deepEqual(
      events.map(e => [e.event, e.job_id, e.kind, e.attempt, e.outcome ?? null, e.code ?? null, e.level]),
      [
        ['job_started', ok, 'synthetic_ok', 1, null, null, 'info'],
        ['job_finished', ok, 'synthetic_ok', 1, 'complete', null, 'info'],
        ['job_started', failed, 'synthetic_fail', 1, null, null, 'info'],
        ['job_finished', failed, 'synthetic_fail', 1, 'failed', 'SYNTHETIC_FAILURE', 'error'],
        ['job_started', retried, 'report_overview', 1, null, null, 'info'],
        ['job_finished', retried, 'report_overview', 1, 'retry_scheduled', 'PLATFORM_RATE_LIMIT', 'info'],
      ],
    );
    for (const e of events) {
      assert.deepEqual(
        Object.keys(e).sort(),
        e.event === 'job_started'
          ? ['at', 'attempt', 'event', 'job_id', 'kind', 'level']
          : ['at', 'attempt', 'code', 'duration_ms', 'event', 'job_id', 'kind', 'level', 'outcome'],
      );
      if (e.event === 'job_finished') assert.ok(Number.isSafeInteger(e.duration_ms) && e.duration_ms >= 0);
    }
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE|secret|ops-correlation/);
    // A failing sink never changes a job's outcome.
    worker.onJobEvent = () => {
      throw new Error('sink failed');
    };
    store.enqueue(owner.tenantId, 'synthetic_ok', {}, 4);
    assert.equal(await worker.once(), true);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM jobs WHERE state='complete'").get().n, 2);
  } finally {
    store.close();
  }
});

test('event-loop delay reports per-window percentiles, rotates its window and is absent without a monitor', async () => {
  stopEventLoopMonitor();
  assert.equal(eventLoopDelay(), null, 'no monitor in this process yet');
  const start = Math.floor(Date.now() / EVENT_LOOP_WINDOW_MS) * EVENT_LOOP_WINDOW_MS;
  startEventLoopMonitor(10, start + 1000);
  try {
    // Let the sampler run, block the loop, then let it observe the late timer.
    await new Promise(done => setTimeout(done, 60));
    const until = performance.now() + 120;
    while (performance.now() < until);
    await new Promise(done => setTimeout(done, 60));
    const current = eventLoopDelay(start + 2000);
    assert.equal(current.resolution_ms, 10);
    assert.equal(current.window_ms, EVENT_LOOP_WINDOW_MS);
    assert.ok(current.current.samples > 0);
    assert.ok(current.current.max_ms >= 30, JSON.stringify(current.current));
    assert.ok(current.current.p99_ms >= current.current.p50_ms);
    assert.equal(current.previous, null);
    const next = eventLoopDelay(start + EVENT_LOOP_WINDOW_MS + 5);
    assert.equal(next.previous.from, start);
    assert.ok(next.previous.samples >= current.current.samples);
    assert.ok(next.previous.max_ms >= 30);
    assert.ok(next.current.samples <= 1, 'the new window starts empty');
    // A gap of more than one window shows no stale previous window.
    assert.equal(eventLoopDelay(start + 3 * EVENT_LOOP_WINDOW_MS).previous, null);
  } finally {
    stopEventLoopMonitor();
  }
});

test('owner health and the support bundle carry event-loop delay and per-stage worker durations', async () => {
  const f = fixture();
  startEventLoopMonitor();
  try {
    let clock = 1000;
    await runWorkerLoop({
      schedule: () => {},
      deliverEmails: async () => {},
      work: async () => false,
      shouldStop: () => false,
      onFailure: () => {},
      onceOnly: true,
      now: () => clock++,
    });
    const health = operationsHealth(f.store, owner.tenantId);
    for (const stage of ['schedule', 'email_delivery', 'job']) {
      const duration = health.worker.stages.stages[stage].duration;
      assert.deepEqual(Object.keys(duration), ['runs', 'last_ms', 'max_ms', 'mean_ms']);
      assert.equal(duration.runs, 1, stage);
      assert.ok(duration.last_ms >= 0 && duration.max_ms >= duration.last_ms && duration.mean_ms >= 0, stage);
    }
    const loop = health.runtime.event_loop;
    assert.equal(loop.version, 1);
    assert.deepEqual(Object.keys(loop.current), ['from', 'to', 'samples', 'mean_ms', 'p50_ms', 'p99_ms', 'max_ms']);
    const bundle = await f.service.call('amcp_workspace', {action: 'support_bundle'}, owner);
    assert.equal(bundle.success, true, JSON.stringify(bundle));
    assert.equal(bundle.data.runtime.event_loop.window_ms, EVENT_LOOP_WINDOW_MS);
    assert.equal(bundle.data.worker.stages.stages.job.duration.runs, 1);
    assert.equal(f.requests(), 0);
  } finally {
    stopEventLoopMonitor();
    f.store.close();
  }
});

test('the one start line carries release, Node, SQLite, FFmpeg and bootstrap identity; the probe wait is bounded', async () => {
  // Regression: the listening line once waited for the whole FFmpeg probe (up to five seconds), so a slow probe
  // delayed the line Railway and the start-up tests wait for.
  const store = new Store(':memory:', key),
    lines = [];
  try {
    const started = performance.now();
    await logRuntimeStart(store, {level: 'info', event: 'http_listening', port: 1}, entry => lines.push(entry), 200);
    assert.ok(performance.now() - started < 2000, 'the wait for the probe is bounded');
    assert.equal(lines.length, 1, 'exactly one start line');
    const [line] = lines;
    assert.equal(line.event, 'http_listening');
    assert.equal(line.node, process.version);
    assert.match(line.sqlite, /^\d+\.\d+\.\d+$/);
    assert.equal(typeof line.ffmpeg, 'string');
    assert.equal(line.schema_version, 2);
    // A fresh database is created at version 1 and upgraded inside the same bootstrap transaction.
    assert.equal(line.schema_compatibility, 'upgrade');
    assert.ok(Number.isFinite(line.migration_ms) && line.migration_ms >= 0);
    assert.ok(line.migrations_applied.includes('store-0010-jobs-tenant-updated-index'));
    assert.ok('release' in line);
    await startFfmpegVersionProbe();
    const settled = [];
    await logRuntimeStart(store, {event: 'runtime_started'}, entry => settled.push(entry), 0);
    assert.notEqual(settled[0].ffmpeg, 'checking', 'a settled probe is named in the line');
    assert.doesNotMatch(JSON.stringify(lines), /MIRROR_MASTER_KEY|:memory:|BEGIN|CREATE /);
  } finally {
    store.close();
  }
});

test('the recent job errors query reads the jobs_tenant_updated index in order, without a scan or sort', () => {
  const store = new Store(':memory:', key);
  try {
    store.ensureTenant(owner.tenantId);
    for (let i = 0; i < 200; i++) store.enqueue(i % 2 ? owner.tenantId : 'other', 'synthetic', {}, i);
    store.db.exec('ANALYZE');
    const plan = store.db
      .prepare('EXPLAIN QUERY PLAN ' + recentJobErrorsSQL)
      .all(owner.tenantId)
      .map(row => row.detail)
      .join('\n');
    assert.match(plan, /USING INDEX jobs_tenant_updated \(tenant_id=\?\)/);
    assert.doesNotMatch(plan, /SCAN jobs|TEMP B-TREE/);
  } finally {
    store.close();
  }
});

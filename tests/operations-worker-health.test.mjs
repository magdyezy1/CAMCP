import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {operationsWorkerHealth} from '../dist/src/operations-worker-health.js';
import {operationsHealth} from '../dist/src/operations-health.js';
import {ReportWorker} from '../dist/src/worker.js';

const fixed = Date.UTC(2026, 9, 6, 1),
  create = () => new Store(':memory:', Buffer.alloc(32, 101).toString('base64'));
const heartbeat = (store, id, at, state = 'idle', extra = {}) =>
  store.putDocument('__service_limits__', 'worker_heartbeat', id, {at, state, ...extra});

test('worker liveness reports exact valid ages and boundary states without loading complete documents', () => {
  const store = create();
  try {
    assert.equal(operationsWorkerHealth(store, fixed).status, 'not_observed');
    heartbeat(store, 'boundary', fixed - 90000, 'idle');
    heartbeat(store, 'stale', fixed - 90001, 'working');
    const original = store.documents.bind(store);
    store.documents = (tenant, kind, ...args) => {
      assert.notEqual(kind, 'worker_heartbeat', 'Complete heartbeat documents must stay in SQLite');
      return original(tenant, kind, ...args);
    };
    const out = operationsWorkerHealth(store, fixed);
    assert.equal(out.status, 'active');
    assert.equal(out.total_heartbeat_records, 2);
    assert.equal(out.active_records, 1);
    assert.deepEqual(out.observations, [
      {state: 'idle', age_ms: 90000, stale: false},
      {state: 'working', age_ms: 90001, stale: true},
    ]);
    assert.equal(operationsWorkerHealth(store, fixed + 1).status, 'stale');
    assert.equal(operationsHealth(store, 'synthetic').worker.observed_records, 2);
    assert.doesNotMatch(
      JSON.stringify(out),
      /boundary|"stale"\s*:\s*"|__service_limits__|worker_heartbeat|worker_id|tenant_id/,
    );
  } finally {
    store.close();
  }
});

test('bounded heartbeat projections distinguish malformed, unknown, future, duplicate and oversized observations', () => {
  const store = create();
  try {
    for (const [id, at, state] of [
      ['future', fixed + 1, 'working'],
      ['float', fixed - 0.5, 'idle'],
      ['text', String(fixed), 'idle'],
      ['negative', -1, 'idle'],
      ['unknown', fixed, 'DO-NOT-EXPOSE-STATE'],
      ['object', fixed, {token: 'DO-NOT-EXPOSE-STATE'}],
    ])
      heartbeat(store, id, at, state);
    heartbeat(store, 'oversized', fixed, 'idle', {native_body: 'DO-NOT-EXPOSE-BODY'.repeat(50000)});
    heartbeat(store, 'duplicate', fixed, 'idle');
    store.db
      .prepare(
        "UPDATE documents SET data=? WHERE tenant_id='__service_limits__' AND kind='worker_heartbeat' AND id='duplicate'",
      )
      .run('{"at":' + fixed + ',"state":"idle","state":"working"}');
    heartbeat(store, 'malformed', fixed, 'idle');
    store.db
      .prepare(
        "UPDATE documents SET data=? WHERE tenant_id='__service_limits__' AND kind='worker_heartbeat' AND id='malformed'",
      )
      .run('DO-NOT-EXPOSE-INVALID-JSON');
    const out = operationsWorkerHealth(store, fixed);
    assert.equal(out.status, 'unavailable');
    assert.equal(out.total_heartbeat_records, 9);
    assert.equal(out.unavailable_records, 9);
    assert.deepEqual(out.observations, []);
    assert.equal(out.observed_records, 0);
    assert.equal(out.active_records, 0);
    assert.doesNotMatch(JSON.stringify(out), /DO-NOT-EXPOSE|native_body|"(?:duplicate|future|malformed|token)"\s*:/);
    heartbeat(store, 'valid-old', fixed - 90001, 'idle');
    assert.equal(operationsWorkerHealth(store, fixed).status, 'uncertain');
    heartbeat(store, 'valid-current', fixed, 'working');
    assert.equal(operationsWorkerHealth(store, fixed).status, 'active');
  } finally {
    store.close();
  }
});

test('worker health caps observations while reporting all valid counts and never admits other shared or workspace document kinds', () => {
  const store = create();
  try {
    store.transaction(() => {
      for (let n = 0; n < 1000; n++)
        heartbeat(store, String(n).padStart(4, '0'), fixed - n, n % 2 ? 'idle' : 'working');
      store.putDocument('private-workspace', 'worker_heartbeat', 'DO-NOT-EXPOSE-FOREIGN', {
        at: fixed,
        state: 'working',
      });
      store.putDocument('__service_limits__', 'unselected_private', 'DO-NOT-EXPOSE-OTHER', {
        at: fixed,
        state: 'working',
      });
    });
    const out = operationsWorkerHealth(store, fixed);
    assert.equal(out.status, 'active');
    assert.equal(out.total_heartbeat_records, 1000);
    assert.equal(out.observed_records, 1000);
    assert.equal(out.active_records, 1000);
    assert.equal(out.observations.length, 100);
    assert.equal(out.has_more, true);
    assert.deepEqual(
      out.observations.map(row => row.age_ms),
      Array.from({length: 100}, (_, n) => n),
    );
    assert.ok(Buffer.byteLength(JSON.stringify(out)) < 7000);
    assert.doesNotMatch(JSON.stringify(out), /DO-NOT-EXPOSE|private-workspace|unselected_private/);
    assert.equal(operationsWorkerHealth(store, fixed + 91000).status, 'stale');
  } finally {
    store.close();
  }
});

test('allowed native heartbeat values cannot carry additional body, credential or identifier fields into health', () => {
  const store = create();
  try {
    heartbeat(store, 'PRIVATE-PROCESS-ID', fixed, 'working', {
      tenant_id: 'PRIVATE-TENANT',
      access_token: 'PRIVATE-TOKEN',
      argument: 'PRIVATE-PAYLOAD',
    });
    const out = operationsWorkerHealth(store, fixed);
    assert.deepEqual(out.observations, [{state: 'working', age_ms: 0, stale: false}]);
    assert.doesNotMatch(JSON.stringify(out), /PRIVATE|access_token|tenant_id|argument|PROCESS-ID/);
    for (const now of [NaN, Infinity, -1, 'today', 0.5, Number.MAX_SAFE_INTEGER])
      assert.throws(() => operationsWorkerHealth(store, now), /observation clock/);
  } finally {
    store.close();
  }
});

test('the heartbeat byte boundary is checked before JSON qualification and does not normalize oversized native text', () => {
  const store = create();
  try {
    const insert = store.db.prepare(
        "INSERT INTO documents(tenant_id,kind,id,data,revision) VALUES('__service_limits__','worker_heartbeat',?,?,1)",
      ),
      native = JSON.stringify({at: fixed, state: 'idle', private: 'PRIVATE-SYNTHETIC'});
    for (const bytes of [512, 513]) insert.run(String(bytes), native + ' '.repeat(bytes - Buffer.byteLength(native)));
    const out = operationsWorkerHealth(store, fixed);
    assert.equal(out.observed_records, 1);
    assert.equal(out.unavailable_records, 1);
    assert.equal(out.total_heartbeat_records, 2);
    assert.deepEqual(out.observations, [{state: 'idle', age_ms: 0, stale: false}]);
    assert.doesNotMatch(JSON.stringify(out), /PRIVATE-SYNTHETIC|"private"/);
  } finally {
    store.close();
  }
});

test('an actual worker heartbeat remains visible while owner health and support boundaries withhold shared process details from other roles', async () => {
  const store = create(),
    owner = {tenantId: 'synthetic-health', userId: 'owner', role: 'admin'},
    reader = {...owner, userId: 'reader', role: 'reader'},
    service = new MirrorService(new Registry(), store),
    worker = new ReportWorker(store, async () => ({}));
  try {
    assert.equal(worker.heartbeat('working'), true);
    const health = await service.call('amcp_workspace', {action: 'health'}, owner);
    assert.equal(health.success, true, JSON.stringify(health));
    assert.equal(health.data.operations.worker.status, 'active');
    assert.equal(health.data.operations.worker.observed_records, 1);
    assert.equal((await service.call('amcp_workspace', {action: 'health'}, reader)).error.code, 'OWNER_REQUIRED');
    const support = await service.call('amcp_workspace', {action: 'support_bundle'}, owner);
    assert.equal(support.success, true, JSON.stringify(support));
    assert.equal(support.data.worker.status, 'active');
    assert.doesNotMatch(JSON.stringify(health.data.operations.worker), new RegExp(worker.workerId));
  } finally {
    store.close();
  }
});

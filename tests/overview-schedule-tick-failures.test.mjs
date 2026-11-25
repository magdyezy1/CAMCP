import test from 'node:test';
import assert from 'node:assert/strict';
import {rollbackFixture, rollingWindow} from './helpers/rollback-fixture.mjs';
import {MirrorError} from '../dist/src/errors.js';
import {runWorkerLoop, workerStageHealth} from '../dist/src/worker-loop.js';
import {assertRefused} from './helpers/assert-refused.mjs';

// r25-mf-jobs item 2 and F4: a due schedule whose run could not be queued (100 jobs already waiting, a busy database) was
// turned off for good by its first failure. Only a failure that waiting changes leaves it on now: a retryable refusal and a
// busy, locked or full database. It says so on the schedule (schedule_warning), records the failure once, and the next tick
// tries again. Anything else repeats on every tick and stops the schedule with its error, as it always did. A storage
// failure also fails the worker's schedule stage, so its health never reads "ok" while nothing can be written.
const sqlite = (message, errcode) => Object.assign(new Error(message), {code: 'ERR_SQLITE_ERROR', errcode});
const busy = () => sqlite('database is locked', 5);
const locked = () => sqlite('database table is locked', 6);
const full = () => sqlite('database or disk is full', 13);

async function addSchedule(f, n) {
  const destination = await f.handle({
    action: 'bind_file_destination',
    confirmed: true,
    idempotency_key: 'tick-files-000' + n,
    file_destination: {name: 'Tick files ' + n, formats: ['xlsx']},
  });
  return f.handle({
    action: 'schedule',
    confirmed: true,
    idempotency_key: 'tick-sched-000' + n,
    config: f.body([f.source('meta')], {date_range: rollingWindow}),
    schedule: {schedule_kind: 'daily', timezone: 'UTC', schedule_config: {hour: 8}, destination_id: destination.id},
  });
}
async function fixture(t) {
  const f = rollbackFixture(t, {platforms: ['meta']}),
    created = await addSchedule(f, 1);
  const tenant = f.actor.tenantId,
    schedule = () => f.document('overview_schedule', created.id),
    due = () => {
      const {id: _id, revision: _revision, ...data} = schedule();
      f.store.putDocument(tenant, 'overview_schedule', created.id, {...data, next_run_at: Date.now() - 1000});
      return schedule();
    },
    // The queue holds at most 100 active reporting jobs; these fill it.
    fill = () => {
      for (let i = 0; i < 100; i++) f.store.enqueue(tenant, 'report_overview', {report_id: 'filler-' + i});
    },
    drain = () =>
      f.store.sql().prepare("DELETE FROM jobs WHERE json_extract(input,'$.report_id') LIKE 'filler-%'").run(),
    snapshots = () => f.documents('overview_report').filter(r => r.schedule_id === created.id),
    failures = () =>
      f.store
        .audit(tenant, 1000)
        .filter(row => row.request_id === 'scheduler/' + created.id)
        .map(row => JSON.parse(row.event)),
    failQueue = error => {
      f.overview.queue = () => {
        throw error;
      };
    };
  return {f, created, schedule, due, fill, drain, snapshots, failures, failQueue};
}

test('a full queue does not turn a due schedule off: it stays on with a warning, is recorded once, and runs when the queue has room', async t => {
  const x = await fixture(t),
    before = x.due();
  x.fill();
  x.f.overview.tick();
  const first = x.schedule();
  for (let tick = 0; tick < 2; tick++) x.f.overview.tick();
  const waiting = x.schedule();
  assert.equal(waiting.is_active, true, 'one full queue is not a reason to stop a client’s report');
  assert.equal(waiting.error ?? null, null);
  assert.equal(waiting.next_run_at, before.next_run_at, 'the occurrence is still due');
  assert.equal(waiting.schedule_warning.code, 'REPORT_QUEUE_FULL', 'the schedule says what it waits for');
  assert.equal(typeof waiting.schedule_warning.message, 'string');
  assert.equal(waiting.revision, first.revision, 'the warning is written once, not on every tick');
  assert.deepEqual(x.snapshots(), []);
  assert.deepEqual(
    x.failures().map(e => [e.event, e.error.code, e.will_retry]),
    [['schedule_failed', 'REPORT_QUEUE_FULL', true]],
    'the failure is recorded once, not once per tick',
  );
  x.drain();
  x.f.overview.tick();
  const ran = x.schedule();
  assert.equal(ran.is_active, true);
  assert.equal(x.snapshots().length, 1, 'the next tick queued the run');
  assert.equal(ran.last_report_id, x.snapshots()[0].id);
  assert.ok(ran.next_run_at > Date.now(), 'and moved to the following occurrence');
  assert.equal(ran.error ?? null, null);
  assert.equal(ran.schedule_warning ?? null, null, 'the warning is gone with the run');
});

test('a retryable refusal of another kind leaves the schedule on, with its own code on the warning', async t => {
  const x = await fixture(t);
  x.due();
  x.failQueue(new MirrorError('PLATFORM_RATE_LIMIT', 'Provider cooldown is active.', {}, 429, true));
  x.f.overview.tick();
  assert.equal(x.schedule().is_active, true);
  assert.equal(x.schedule().schedule_warning.code, 'PLATFORM_RATE_LIMIT');
  assert.deepEqual(x.snapshots(), []);
});

for (const [name, make, code] of [
  ['busy', busy, 'DATABASE_BUSY'],
  ['locked', locked, 'DATABASE_BUSY'],
  ['full', full, 'STORAGE_FULL'],
])
  test(`a ${name} database leaves the schedule on and tried again, and fails the worker's schedule stage`, async t => {
    const x = await fixture(t),
      error = make();
    x.due();
    const queue = x.f.overview.queue.bind(x.f.overview);
    x.failQueue(error);
    assert.throws(
      () => x.f.overview.tick(),
      thrown => thrown === error,
      'the stage that ran the tick sees the storage failure',
    );
    assert.equal(x.schedule().is_active, true, 'one busy moment is not a reason to stop a client’s report');
    assert.equal(x.schedule().error ?? null, null);
    assert.equal(x.schedule().schedule_warning.code, code);
    assert.deepEqual(x.snapshots(), []);
    // The loop that runs the stage records the failure: the health of the stage is not "ok" (OPS-07).
    const failures = [];
    let stop = false;
    await runWorkerLoop({
      schedule: () => x.f.overview.tick(),
      deliverEmails: async () => {},
      work: async () => false,
      shouldStop: () => stop,
      onFailure: failure => failures.push(failure),
      pause: async () => {
        stop = true;
      },
      storageProbe: () => false,
    });
    const health = workerStageHealth();
    assert.equal(failures.length, 1);
    assert.equal(failures[0].stage, 'schedule');
    assert.equal(failures[0].database.primary_code, error.errcode);
    assert.notEqual(health.stages.schedule.state, 'ok');
    assert.equal(health.stages.schedule.consecutive_failures, 1);
    assert.equal(health.storage_paused, name === 'full', 'a full disk pauses every stage until a write succeeds');
    x.f.overview.queue = queue;
    x.f.overview.tick();
    assert.equal(x.snapshots().length, 1, 'the next tick runs it');
    assert.equal(x.schedule().is_active, true);
    assert.equal(x.schedule().schedule_warning ?? null, null);
  });

test('a storage failure is thrown after the other due schedules had their turn', async t => {
  const x = await fixture(t),
    second = await addSchedule(x.f, 2),
    tenant = x.f.actor.tenantId,
    ids = [x.created.id, second.id];
  for (const id of ids) {
    const {id: _id, revision: _revision, ...data} = x.f.document('overview_schedule', id);
    x.f.store.putDocument(tenant, 'overview_schedule', id, {...data, next_run_at: Date.now() - 1000});
  }
  const queue = x.f.overview.queue.bind(x.f.overview),
    error = busy();
  let calls = 0;
  x.f.overview.queue = (...args) => {
    if (++calls === 1) throw error;
    return queue(...args);
  };
  assert.throws(
    () => x.f.overview.tick(),
    thrown => thrown === error,
  );
  assert.equal(calls, 2, 'the second schedule was tried after the first met a busy database');
  const reports = x.f.documents('overview_report').filter(r => ids.includes(r.schedule_id));
  assert.equal(reports.length, 1, 'and it ran');
  const states = ids.map(id => x.f.document('overview_schedule', id));
  assert.deepEqual(
    states.map(s => s.is_active),
    [true, true],
  );
  assert.equal(states.filter(s => s.schedule_warning?.code === 'DATABASE_BUSY').length, 1);
});

test('any other error is not one a retry changes: it stops the schedule, with its error, visibly', async t => {
  const x = await fixture(t);
  x.due();
  x.failQueue(new TypeError('synthetic bug'));
  x.f.overview.tick();
  const stopped = x.schedule();
  assert.equal(stopped.is_active, false);
  assert.equal(stopped.error.code, 'SCHEDULE_FAILED');
  assert.equal(typeof stopped.error.message, 'string');
  assert.deepEqual(x.snapshots(), []);
  assert.deepEqual(
    x.failures().map(e => [e.event, e.error.code, e.will_retry]),
    [['schedule_failed', 'SCHEDULE_FAILED', false]],
  );
  // A stopped schedule is not due again until someone resumes it.
  const revision = stopped.revision;
  x.f.overview.tick();
  assert.equal(x.schedule().revision, revision);
});

test('a refusal no retry changes still stops the schedule, with its code, as before', async t => {
  const x = await fixture(t);
  x.due();
  x.f.store.sql().prepare('DELETE FROM connections WHERE id=?').run('login-meta');
  x.f.overview.tick();
  const stopped = x.schedule();
  assert.equal(stopped.is_active, false);
  assert.equal(typeof stopped.error?.code, 'string');
  assert.notEqual(stopped.error.code, 'SCHEDULE_FAILED', 'the refusal names its own code');
  assert.deepEqual(x.snapshots(), []);
  // A stopped schedule is not due again until someone resumes it.
  const revision = x.schedule().revision;
  x.f.overview.tick();
  assert.equal(x.schedule().revision, revision);
  // The same rule for a refusal that did not come from a lost login: a code thrown as not retryable stops it.
  const y = await fixture(t);
  y.due();
  y.failQueue(new MirrorError('REPORT_SOURCES_REQUIRED', 'Synthetic refusal.'));
  y.f.overview.tick();
  assert.equal(y.schedule().is_active, false);
  assert.equal(y.schedule().error.code, 'REPORT_SOURCES_REQUIRED');
});

test('a schedule that a refusal stopped is recorded as stopped', async t => {
  const x = await fixture(t);
  x.due();
  x.f.store.sql().prepare('DELETE FROM connections WHERE id=?').run('login-meta');
  x.f.overview.tick();
  x.f.overview.tick();
  assert.deepEqual(
    x.failures().map(e => [e.event, e.error.code, e.will_retry]),
    [['schedule_failed', x.schedule().error.code, false]],
  );
});

test('a full queue is retryable for a person too: the refusal of a run says so', async t => {
  const x = await fixture(t);
  x.fill();
  const view = await x.f.handle({
    action: 'save',
    confirmed: true,
    config: x.f.body([x.f.source('meta')], {name: 'Queue full', date_range: rollingWindow}),
  });
  await assert.rejects(x.f.handle({action: 'run', id: view.id, confirmed: true}), error => {
    assertRefused(error, 'REPORT_QUEUE_FULL');
    assert.equal(error.retryable, true);
    return true;
  });
  const refused = await x.f.service.call(
    'amcp_reporting_overview',
    {action: 'run', id: view.id, confirmed: true},
    x.f.actor,
  );
  assertRefused(refused, 'REPORT_QUEUE_FULL');
  assert.equal(refused.error.retryable, true);
});

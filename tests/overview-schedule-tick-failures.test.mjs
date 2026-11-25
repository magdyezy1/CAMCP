import test from 'node:test';
import assert from 'node:assert/strict';
import {rollbackFixture, rollingWindow} from './helpers/rollback-fixture.mjs';
import {MirrorError} from '../dist/src/errors.js';
import {assertRefused} from './helpers/assert-refused.mjs';

// r25-mf-jobs item 2: a due schedule whose run could not be queued (100 jobs already waiting, a busy database) was turned
// off for good by its first failure. The rule of the reporting scheduler (src/worker.ts tickSchedules) now holds here too:
// only an error that no retry changes stops a schedule; any other leaves it on, records the failure, and the next tick
// tries again.
async function fixture(t) {
  const f = rollbackFixture(t, {platforms: ['meta']}),
    destination = await f.handle({
      action: 'bind_file_destination',
      confirmed: true,
      idempotency_key: 'tick-files-0001',
      file_destination: {name: 'Tick files', formats: ['xlsx']},
    }),
    created = await f.handle({
      action: 'schedule',
      confirmed: true,
      idempotency_key: 'tick-sched-0001',
      config: f.body([f.source('meta')], {date_range: rollingWindow}),
      schedule: {schedule_kind: 'daily', timezone: 'UTC', schedule_config: {hour: 8}, destination_id: destination.id},
    });
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
        .map(row => JSON.parse(row.event));
  return {f, created, schedule, due, fill, drain, snapshots, failures};
}

test('a full queue does not turn a due schedule off: it stays on, is recorded once, and runs when the queue has room', async t => {
  const x = await fixture(t),
    before = x.due();
  x.fill();
  for (let tick = 0; tick < 3; tick++) x.f.overview.tick();
  const waiting = x.schedule();
  assert.equal(waiting.is_active, true, 'one full queue is not a reason to stop a client’s report');
  assert.equal(waiting.error ?? null, null);
  assert.equal(waiting.next_run_at, before.next_run_at, 'the occurrence is still due');
  assert.equal(waiting.revision, before.revision, 'a failed tick writes nothing to the schedule');
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
});

test('a busy database, or any error that is not a refusal, leaves the schedule on and tried again', async t => {
  const x = await fixture(t);
  x.due();
  const queue = x.f.overview.queue.bind(x.f.overview);
  const busy = Object.assign(new Error('database is locked'), {code: 'ERR_SQLITE_ERROR', errcode: 5});
  for (const error of [busy, new TypeError('synthetic bug')]) {
    x.f.overview.queue = () => {
      throw error;
    };
    x.f.overview.tick();
    assert.equal(x.schedule().is_active, true, error.message);
    assert.equal(x.schedule().error ?? null, null, error.message);
  }
  assert.deepEqual(x.snapshots(), []);
  x.f.overview.queue = queue;
  x.f.overview.tick();
  assert.equal(x.snapshots().length, 1, 'the next tick runs it');
  assert.equal(x.schedule().is_active, true);
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
  y.f.overview.queue = () => {
    throw new MirrorError('REPORT_SOURCES_REQUIRED', 'Synthetic refusal.');
  };
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

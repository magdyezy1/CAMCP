import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rollbackFixture, rollingWindow} from './helpers/rollback-fixture.mjs';

// r25-mf-jobs item 1: pausing, editing or removing a schedule used to load every retained snapshot with all its rows
// (100 snapshots of 500 rows took 580 MB) only to find the few that were still running. These tests count what the
// database hands to the process, so they fail on any read of a snapshot's rows, whatever the code that does it.
const rowsPerSnapshot = 500;

/** The bytes of every row SQLite returns to the process (`all` and `get`) while `watching` is true. */
function readProbe(store) {
  const db = store.sql(),
    prepare = db.prepare.bind(db),
    probe = {watching: false, bytes: 0};
  db.prepare = sql => {
    const statement = prepare(sql);
    return new Proxy(statement, {
      get(target, name) {
        const member = target[name];
        if (typeof member !== 'function') return member;
        return (...args) => {
          const out = member.apply(target, args);
          if (probe.watching && (name === 'all' || name === 'get')) probe.bytes += JSON.stringify(out ?? null).length;
          return out;
        };
      },
    });
  };
  return probe;
}

const snapshotRows = n =>
  Array.from({length: n}, (_, i) => ({
    campaign_id: 'c' + i,
    campaign_name: 'Synthetic campaign number ' + i + ' '.padEnd(200, 'x'),
    metrics: {spend: String(i), impressions: String(i * 10), clicks: String(i)},
    platform: 'meta',
    account_id: '100',
  }));

const bindFiles = (f, key, name) =>
  f.handle({
    action: 'bind_file_destination',
    confirmed: true,
    idempotency_key: key,
    file_destination: {name, formats: ['xlsx']},
  });

async function fixture(t) {
  const f = rollbackFixture(t, {platforms: ['meta']}),
    destination = await bindFiles(f, 'cancel-files-0001', 'Cancel files'),
    second = await bindFiles(f, 'cancel-files-0002', 'Second files'),
    schedule = {schedule_kind: 'daily', timezone: 'UTC', schedule_config: {hour: 8}, destination_id: destination.id},
    config = f.body([f.source('meta')], {date_range: rollingWindow}),
    created = await f.handle({
      action: 'schedule',
      confirmed: true,
      idempotency_key: 'cancel-sched-0001',
      config,
      schedule,
    }),
    other = await f.handle({
      action: 'schedule',
      confirmed: true,
      idempotency_key: 'cancel-sched-0002',
      config: {...config, name: 'Another schedule'},
      schedule: {...schedule, destination_id: second.id},
    });
  const snapshot = (scheduleId, state, rows = []) => {
    const id = randomUUID();
    f.store.putDocument(f.actor.tenantId, 'overview_report', id, {
      config,
      state,
      schedule_id: scheduleId,
      created_at: Date.now(),
      rows,
      sources: [],
      checkpoints: {},
    });
    return id;
  };
  const job = (kind, reportId) => f.store.enqueue(f.actor.tenantId, kind, {report_id: reportId});
  return {f, created, other, snapshot, job};
}

const jobState = (f, id) => f.store.job(f.actor.tenantId, id).state;
const reportState = (f, id) => f.document('overview_report', id).state;

/** 100 finished snapshots of 500 rows (every fifth is another schedule's), and the runs a schedule still has in flight. */
function retained(x) {
  const finished = Array.from({length: 100}, (_, i) =>
    x.snapshot(i % 5 === 0 ? x.other.id : x.created.id, 'complete', snapshotRows(rowsPerSnapshot)),
  );
  const queued = x.snapshot(x.created.id, 'queued'),
    running = x.snapshot(x.created.id, 'running'),
    otherRunning = x.snapshot(x.other.id, 'running');
  const jobs = {
    queued: x.job('report_overview', queued),
    running: x.job('report_overview', running),
    otherRunning: x.job('report_overview', otherRunning),
    // A finished snapshot of the schedule that still has a delivery waiting: it stops with the schedule, as before.
    delivery: x.job('sheets_export', finished[1]),
    otherDelivery: x.job('sheets_export', finished[0]),
  };
  return {finished, queued, running, otherRunning, jobs};
}

const actions = {
  pause_schedule: (x, revision) => ({action: 'pause_schedule', id: x.created.id, expected_revision: revision}),
  remove_schedule: (x, revision) => ({action: 'remove_schedule', id: x.created.id, expected_revision: revision}),
  update_schedule: (x, revision, f) => ({
    action: 'update_schedule',
    id: x.created.id,
    expected_revision: revision,
    config: f.body([f.source('meta')], {name: 'Edited', date_range: rollingWindow}),
    schedule: {
      schedule_kind: 'daily',
      timezone: 'UTC',
      schedule_config: {hour: 9},
      destination_id: f.document('overview_schedule', x.created.id).destination_id,
    },
  }),
};

for (const [name, request] of Object.entries(actions))
  test(name + ' reads no snapshot rows, and still stops only this schedule’s runs', async t => {
    const x = await fixture(t),
      {f} = x,
      kept = retained(x),
      probe = readProbe(f.store);
    probe.watching = true;
    await f.handle({confirmed: true, ...request(x, f.document('overview_schedule', x.created.id).revision, f)});
    probe.watching = false;
    t.diagnostic(name + ' read ' + probe.bytes + ' bytes from the database');
    // The 100 retained snapshots hold about 16 MB of rows; what a schedule change needs from them is their ids and states.
    assert.ok(probe.bytes < 100000, name + ' read ' + probe.bytes + ' bytes from the database');
    // The schedule's runs in flight stop; nothing else changes.
    assert.equal(reportState(f, kept.queued), 'cancelled');
    assert.equal(reportState(f, kept.running), 'cancelled');
    assert.equal(jobState(f, kept.jobs.queued), 'cancelled');
    assert.equal(jobState(f, kept.jobs.running), 'cancelled');
    assert.equal(
      jobState(f, kept.jobs.delivery),
      'cancelled',
      'a delivery of a finished snapshot of this schedule stops too',
    );
    for (const id of kept.finished)
      assert.equal(reportState(f, id), 'complete', 'a finished snapshot is never rewritten');
    assert.equal(reportState(f, kept.otherRunning), 'running', 'another schedule’s run is untouched');
    assert.equal(jobState(f, kept.jobs.otherRunning), 'queued');
    assert.equal(jobState(f, kept.jobs.otherDelivery), 'queued');
  });

test('a snapshot of the schedule that already failed is left as it is, and its waiting job still stops', async t => {
  const x = await fixture(t),
    {f} = x,
    done = x.snapshot(x.created.id, 'failed'),
    job = x.job('report_overview', done);
  await f.handle({
    confirmed: true,
    action: 'pause_schedule',
    id: x.created.id,
    expected_revision: f.document('overview_schedule', x.created.id).revision,
  });
  assert.equal(reportState(f, done), 'failed', 'only a queued or running snapshot becomes cancelled');
  assert.equal(jobState(f, job), 'cancelled', 'its waiting job stops as it always did');
});

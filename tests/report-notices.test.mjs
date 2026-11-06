import test from 'node:test';
import assert from 'node:assert/strict';
import {rollbackFixture, rollingWindow} from './helpers/rollback-fixture.mjs';
import {overviewGranularityFixture, granularConfig, granularSource} from './fixtures/overview-granularity-data.mjs';
import {documentKind, documentProblems} from '../dist/src/document-kinds.js';
import {objectiveMigrationKind, objectiveMigrationNotice} from '../dist/src/report-definition-migration.js';

// D22 and the platform-contract notes: a "numbers changed" note reaches the client once, on the first report that is
// actually delivered to them, and shows in History on the snapshots that carried it. One durable record per saved
// report holds which notes it owes and which were delivered (F-L6-03, F-L6-04, F-L6-07, F-L2-06, F-L2-13).
const OBJ = objectiveMigrationNotice.id,
  LI = 'linkedin_levels_v2';
const row = {
  campaign_id: '1',
  campaign_name: 'C1',
  objective: 'OUTCOME_TRAFFIC',
  metrics: {spend: 10, impressions: 100, clicks: 2},
};
const has = (report, id) => (report?.notices ?? []).some(notice => notice.id === id);
const tenant = f => f.actor.tenantId;

/** A stored v3 report with a daily schedule that delivers to a retained-file tab, as Work-here wrote them. */
async function scheduled(t, {platform = 'meta', objective = 'leads', ran = true, extra = {}} = {}) {
  const f = rollbackFixture(t, {platforms: [platform], rows: {[platform]: [row]}}),
    destination = await f.handle({
      action: 'bind_file_destination',
      confirmed: true,
      idempotency_key: 'notice-files-0001',
      file_destination: {name: 'Notice files', formats: ['xlsx']},
    }),
    config = f.body([f.source(platform, objective ? {objective} : {})], {
      version: 3,
      date_range: rollingWindow,
      ...extra,
    });
  f.store.putDocument(tenant(f), 'overview_view', 'v1', {
    config,
    schedule_id: 's1',
    destination_id: destination.id,
    created_at: 1,
  });
  f.store.putDocument(tenant(f), 'overview_schedule', 's1', {
    config,
    view_id: 'v1',
    is_active: true,
    definition_version: 1,
    schedule_kind: 'daily',
    schedule_config: {hour: 3},
    timezone: 'UTC',
    destination_id: destination.id,
    next_run_at: Date.now() - 1000,
    actor_binding: f.store.bindJobActor(f.actor, 's1'),
    created_at: 1,
    ...(ran ? {last_occurrence_at: 1} : {}),
  });
  return {f, destination, config};
}
/** The schedule falls due again (and is switched back on if a blocking failure paused it). */
function due(f) {
  const {id, revision, ...schedule} = f.document('overview_schedule', 's1');
  f.store.putDocument(
    tenant(f),
    'overview_schedule',
    's1',
    {...schedule, next_run_at: Date.now() - 1000, is_active: true, error: null},
    revision,
  );
}
const snapshots = f => f.documents('overview_report').sort((a, b) => a.created_at - b.created_at);
const delivered = f => new Set(f.documents('report_file').map(file => file.report_id));
const record = (f, key = 'view:v1') => f.document(objectiveMigrationKind, key);
/** A saved LinkedIn report that ran before the contract changed: its snapshot carries no contract stamps. */
function linkedinView(t, {history = true} = {}) {
  const f = rollbackFixture(t, {platforms: ['linkedin'], rows: {linkedin: [row]}}),
    config = f.body([f.source('linkedin')], {date_range: rollingWindow});
  f.store.putDocument(tenant(f), 'overview_view', 'lv', {config, created_at: 1});
  if (history)
    f.store.putDocument(tenant(f), 'overview_report', 'old-1', {
      config,
      view_id: 'lv',
      schedule_id: null,
      state: 'complete',
      completed_at: Date.now() - 100000,
      created_at: Date.now() - 100000,
      rows: [],
      sources: [],
    });
  return {f, config};
}
const runView = async (f, id, extra = {}) => f.handle({action: 'run', id, confirmed: true, ...extra});

test('the first delivered report carries the note and spends it; the next has none; History shows it on the first only', async t => {
  const {f} = await scheduled(t);
  f.overview.tick();
  await f.drain();
  const [first] = snapshots(f);
  assert.ok(has(first, OBJ));
  assert.ok(delivered(f).has(first.id), 'the report reached the client');
  due(f);
  f.overview.tick();
  await f.drain();
  const all = snapshots(f);
  assert.equal(all.length, 2);
  assert.ok(!has(all[1], OBJ), 'the second delivery has no note');
  const history = await f.handle({action: 'list'});
  assert.deepEqual(history.reports.map(report => has(report, OBJ)).reverse(), [true, false]);
  assert.equal(record(f).notices[OBJ].spent_report_id, first.id);
  assert.equal(record(f).notices[OBJ].first_report_id, first.id);
});

test('a first delivery that fails does not spend the note: the next delivered report carries it', async t => {
  const {f, destination} = await scheduled(t),
    {id: _id, revision: _revision, ...saved} = f.document('report_file_destination', destination.id);
  f.overview.tick();
  f.store.deleteDocument(tenant(f), 'report_file_destination', destination.id); // the tab is gone before delivery
  await f.drain(3);
  const [first] = snapshots(f);
  assert.ok(has(first, OBJ), 'History shows it on the snapshot that was recorded');
  assert.equal(first.export.state, 'failed');
  assert.equal(delivered(f).size, 0);
  f.store.putDocument(tenant(f), 'report_file_destination', destination.id, saved); // the owner repairs the tab
  due(f);
  f.overview.tick();
  await f.drain();
  const second = snapshots(f).find(report => report.id !== first.id);
  assert.ok(has(second, OBJ), 'the first report that can be delivered carries the note');
  assert.ok(delivered(f).has(second.id));
  due(f);
  f.overview.tick();
  await f.drain();
  assert.ok(!has(snapshots(f).at(-1), OBJ));
  assert.equal(
    record(f).notices[OBJ].spent_report_id,
    second.id,
    'spent by the first delivery that reached the client',
  );
});

test('a run in the website before the schedule fires carries the note without spending it', async t => {
  const {f} = await scheduled(t),
    manual = await runView(f, 'v1');
  await f.worker.once();
  const manualReport = f.document('overview_report', manual.id);
  assert.ok(has(manualReport, OBJ), 'the analyst sees the note on the manual run');
  f.overview.tick();
  await f.drain();
  const scheduledReport = snapshots(f).find(report => report.schedule_id === 's1');
  assert.ok(has(scheduledReport, OBJ), 'the client’s scheduled delivery carries it too');
  assert.ok(delivered(f).has(scheduledReport.id));
  assert.equal(record(f).notices[OBJ].spent_report_id, scheduledReport.id);
  assert.equal(record(f).notices[OBJ].first_report_id, manual.id, 'History keeps the first snapshot that showed it');
});

test('editing the schedule between recording a snapshot and its delivery keeps the note for the next delivery', async t => {
  const {f, destination} = await scheduled(t);
  f.overview.tick();
  await f.worker.once(); // the collection records the snapshot and queues its delivery job
  const [first] = snapshots(f);
  assert.ok(has(first, OBJ));
  const schedule = f.document('overview_schedule', 's1');
  await f.handle({
    action: 'update_schedule',
    id: 's1',
    expected_revision: schedule.revision,
    expected_view_revision: f.document('overview_view', 'v1').revision,
    schedule: {schedule_kind: 'daily', timezone: 'UTC', schedule_config: {hour: 4}, destination_id: destination.id},
    confirmed: true,
  });
  await f.drain(4);
  assert.equal(delivered(f).size, 0, 'the edit cancelled the pending delivery');
  due(f);
  f.overview.tick();
  await f.drain();
  const second = snapshots(f).find(report => report.id !== first.id);
  assert.ok(has(second, OBJ));
  assert.ok(delivered(f).has(second.id));
  assert.equal(record(f).notices[OBJ].spent_report_id, second.id);
});

test('a partial snapshot under complete-only delivery is skipped and keeps the note for the next complete one', async t => {
  const {f} = await scheduled(t, {extra: {partial_delivery: 'complete_only'}}),
    collect = f.overview.native.collect;
  let partial = true;
  f.overview.native.collect = async (...args) => {
    const result = await collect(...args);
    if (!partial) return result;
    partial = false;
    return {...result, complete: false};
  };
  f.overview.tick();
  await f.drain();
  const [first] = snapshots(f);
  assert.equal(first.state, 'partial');
  assert.equal(first.export.state, 'skipped');
  assert.equal(first.export.reason, 'PARTIAL_DELIVERY_BLOCKED');
  assert.ok(has(first, OBJ), 'History shows the note on the partial snapshot');
  due(f);
  f.overview.tick();
  await f.drain();
  const second = snapshots(f).find(report => report.id !== first.id);
  assert.equal(second.state, 'complete');
  assert.ok(has(second, OBJ));
  assert.ok(delivered(f).has(second.id));
  assert.equal(record(f).notices[OBJ].spent_report_id, second.id);
});

test('two runs queued before either finishes carry a platform-contract note once', async t => {
  const {f} = linkedinView(t),
    a = await runView(f, 'lv'),
    b = await runView(f, 'lv');
  await f.drain(4);
  const reports = [a, b].map(run => f.document('overview_report', run.id));
  assert.deepEqual(
    reports.map(report => report.state),
    ['complete', 'complete'],
  );
  assert.deepEqual(
    reports.map(report => has(report, LI)),
    [true, false],
    'a report with no schedule is the delivery, so the first to finish spends the note',
  );
  assert.equal(f.document(objectiveMigrationKind, 'view:lv').notices[LI].spent_report_id, a.id);
});

test('deleting History neither repeats a delivered note nor loses one that was never delivered', async t => {
  // A delivered note stays spent: the snapshot that carried it is deleted and the next run has none.
  const {f} = linkedinView(t),
    first = await runView(f, 'lv');
  await f.drain(3);
  assert.ok(has(f.document('overview_report', first.id), LI));
  await f.handle({action: 'delete_report', id: first.id, confirmed: true});
  const next = await runView(f, 'lv');
  await f.drain(3);
  assert.ok(!has(f.document('overview_report', next.id), LI), 'deleting History does not re-arm a delivered note');
  // A note a manual run of a scheduled report carried is not delivered, so deleting that snapshot loses nothing.
  const other = await scheduled(t);
  const manual = await runView(other.f, 'v1');
  await other.f.worker.once();
  assert.ok(has(other.f.document('overview_report', manual.id), OBJ));
  await other.f.handle({action: 'delete_report', id: manual.id, confirmed: true});
  other.f.overview.tick();
  await other.f.drain();
  const scheduledReport = snapshots(other.f).find(report => report.schedule_id === 's1');
  assert.ok(has(scheduledReport, OBJ), 'the client still gets the note');
  assert.equal(record(other.f).notices[OBJ].spent_report_id, scheduledReport.id);
});

test('a schedule that has run keeps its platform-contract note when retention purged its previous snapshot', async t => {
  const {f} = await scheduled(t, {platform: 'linkedin', objective: undefined});
  assert.equal(snapshots(f).length, 0, 'no snapshot is retained');
  f.overview.tick();
  await f.drain();
  const [first] = snapshots(f);
  assert.ok(has(first, LI), 'it ran before, under the older contract, so the client is told');
  assert.ok(delivered(f).has(first.id));
});

test('a saved report that has never run is told nothing changed for it, however it was saved', async t => {
  const stamp = await scheduled(t, {platform: 'linkedin', objective: undefined, ran: false});
  stamp.f.overview.tick();
  await stamp.f.drain();
  assert.ok(!has(snapshots(stamp.f)[0], LI), 'a first-ever report has no earlier numbers to differ from');
  assert.equal(snapshots(stamp.f).length, 1);
  const objective = await scheduled(t, {ran: false});
  objective.f.overview.tick();
  await objective.f.drain();
  assert.ok(!has(snapshots(objective.f)[0], OBJ), 'a saved objective that never produced numbers has none to change');
  due(objective.f);
  objective.f.overview.tick();
  await objective.f.drain();
  assert.ok(!snapshots(objective.f).some(report => has(report, OBJ)), 'and it is not told on a later run either');
  assert.deepEqual(record(objective.f).notices, {});
  // The same definition after a retained earlier snapshot is told.
  const ran = linkedinView(t);
  const run = await runView(ran.f, 'lv');
  await ran.f.drain(3);
  assert.ok(has(ran.f.document('overview_report', run.id), LI));
});

test('a comparison baseline neither carries a note nor spends it', async t => {
  const {f} = linkedinView(t),
    pair = await runView(f, 'lv', {compare: 'previous_period'});
  await f.worker.once();
  const baseline = f.document('overview_report', pair.comparison.baseline_id);
  assert.equal(baseline.state, 'complete');
  assert.ok(!has(baseline, LI));
  assert.equal(f.document(objectiveMigrationKind, 'view:lv').notices[LI], undefined, 'it registered nothing');
  await f.worker.once();
  assert.ok(has(f.document('overview_report', pair.id), LI), 'the report the person asked for carries it');
});

test('a saved report deleted while one of its runs is still collecting leaves no notice record behind', async t => {
  const {f} = linkedinView(t),
    run = await runView(f, 'lv');
  assert.ok(f.document(objectiveMigrationKind, 'view:lv'), 'the run made the report’s record when it was queued');
  await f.handle({
    action: 'delete_view',
    id: 'lv',
    expected_revision: f.document('overview_view', 'lv').revision,
    confirmed: true,
  });
  assert.deepEqual(f.documents(objectiveMigrationKind), [], 'deleting the report deleted its record');
  await f.worker.once();
  assert.equal(f.document('overview_report', run.id).state, 'complete', 'the run still finishes');
  assert.deepEqual(
    f.documents(objectiveMigrationKind),
    [],
    'and its recording makes no record that nothing would delete',
  );
});

test('History is read once for each report, never again by a later run', async t => {
  const {f} = linkedinView(t),
    database = f.store.sql(),
    prepare = database.prepare.bind(database);
  let scans = 0;
  database.prepare = sql => {
    if (String(sql).includes('platform_contracts')) scans++;
    return prepare(sql);
  };
  for (let i = 0; i < 6; i++) {
    await runView(f, 'lv');
    await f.worker.once();
  }
  assert.equal(scans, 1, 'six runs of one report read History once');
  const second = f.body([f.source('linkedin')], {date_range: rollingWindow});
  f.store.putDocument(tenant(f), 'overview_view', 'lv2', {config: second, created_at: 1});
  await runView(f, 'lv2');
  await f.worker.once();
  assert.equal(scans, 2, 'another report reads it once');
});

test('the notice record is a document the store contract describes', async t => {
  const {f} = await scheduled(t);
  f.overview.tick();
  await f.drain();
  const kind = documentKind(objectiveMigrationKind);
  assert.equal(kind.fields.notices, 'object');
  assert.equal(kind.fields['contracts?'], 'object');
  assert.deepEqual(documentProblems(objectiveMigrationKind, record(f)), []);
  const stored = record(f);
  assert.equal(typeof stored.registered_at, 'number');
  assert.deepEqual(Object.keys(stored.notices[OBJ]).sort(), ['first_report_id', 'registered_at', 'spent_report_id']);
  assert.equal(
    stored.contracts.overview_config,
    'overview-config-v4',
    'it keeps the contracts the last report ran under',
  );
});

test('a manual export of a snapshot that carries a note spends it when the export is delivered', async t => {
  const {f, destination} = await scheduled(t),
    manual = await runView(f, 'v1');
  await f.worker.once();
  assert.equal(record(f).notices[OBJ].spent_report_id, null);
  await f.handle({action: 'export', report_id: manual.id, destination_id: destination.id, confirmed: true});
  await f.worker.once();
  assert.ok(delivered(f).has(manual.id));
  assert.equal(record(f).notices[OBJ].spent_report_id, manual.id);
});

// ---- Google Sheets: the queued export job, and the inline mode that writes inside the collection job ----
const granularSchedule = async (t, {inline = false} = {}) => {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  const destination = await f.overview.handle(
      {
        action: 'bind_destination',
        connection_id: 'sheets-granular',
        spreadsheet_id: 'syntheticGranularSheet',
        tab_name: 'Notice tab',
        idempotency_key: 'notice-sheet-0001',
        confirmed: true,
      },
      f.actor,
    ),
    config = {
      ...granularConfig(granularSource('meta', 'ad')),
      version: 3,
      date_range: {preset: 'last_complete_days', days: 2, timezone: 'UTC'},
    };
  f.store.putDocument(f.actor.tenantId, 'overview_view', 'v1', {
    config,
    schedule_id: 's1',
    destination_id: destination.id,
    created_at: 1,
  });
  f.store.putDocument(f.actor.tenantId, 'overview_schedule', 's1', {
    config,
    view_id: 'v1',
    is_active: true,
    definition_version: 1,
    schedule_kind: 'daily',
    schedule_config: {hour: 3},
    timezone: 'UTC',
    destination_id: destination.id,
    // The rolling window resolves to the two days the synthetic provider has data for.
    next_run_at: Date.parse('2026-09-03T08:00:00Z'),
    actor_binding: f.store.bindJobActor(f.actor, 's1'),
    created_at: 1,
    last_occurrence_at: 1,
  });
  return {f, destination, inline};
};
for (const inline of [false, true])
  test(
    'a scheduled Google Sheets delivery spends the note when the tab is written' +
      (inline ? ' inside the collection job' : ''),
    async t => {
      const saved = process.env.AMCP_SCHEDULED_SHEETS_DELIVERY;
      if (inline) process.env.AMCP_SCHEDULED_SHEETS_DELIVERY = 'inline';
      t.after(() => {
        if (saved === undefined) delete process.env.AMCP_SCHEDULED_SHEETS_DELIVERY;
        else process.env.AMCP_SCHEDULED_SHEETS_DELIVERY = saved;
      });
      const {f, destination} = await granularSchedule(t);
      f.overview.tick();
      for (let i = 0; i < 6; i++) await f.worker.once();
      const [report] = f.store.documents(f.actor.tenantId, 'overview_report');
      assert.equal(report.state, 'complete', JSON.stringify(report.sources));
      assert.ok(has(report, OBJ));
      const cells = f.tabs.get(destination.sheet_id).values;
      assert.ok(cells.length > 1, 'the tab holds the report');
      assert.equal(
        f.store.document(f.actor.tenantId, objectiveMigrationKind, 'view:v1').notices[OBJ].spent_report_id,
        report.id,
      );
    },
  );

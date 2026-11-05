import test from 'node:test';
import assert from 'node:assert/strict';
import {objectiveReportFixture} from './helpers/objective-report.mjs';
import {
  objectiveMigrationKind,
  objectiveMigrationNotice,
  registerObjectiveMigration,
  linkObjectiveMigration,
} from '../dist/src/report-definition-migration.js';
import {sha256, stable} from '../dist/src/security.js';
import {documentKind} from '../dist/src/document-kinds.js';
import {overviewConfigV4} from '../dist/src/overview-v4.js';

const rolling = {preset: 'last_complete_days', days: 7, timezone: 'UTC'};
const notices = report => (report.notices ?? []).filter(n => n.id === objectiveMigrationNotice.id);
async function legacySchedule(t, {linked = false, active = true, id = 'legacy-standalone'} = {}) {
  const f = objectiveReportFixture(t, {
    rows: [{campaign_id: '1', objective: 'OUTCOME_TRAFFIC', metrics: {spend: 10, impressions: 100, clicks: 2}}],
  });
  const destination = await f.overview.handle(
    {
      action: 'bind_file_destination',
      confirmed: true,
      idempotency_key: 'migration-files',
      file_destination: {name: 'Migration fixture', formats: ['xlsx']},
    },
    f.actor,
  );
  const config = {
    ...f.config,
    version: 3,
    date_range: rolling,
    sources: [{...f.config.sources[0], objective: 'leads'}],
  };
  const settings = {
    schedule_kind: 'daily',
    timezone: 'UTC',
    schedule_config: {hour: 8},
    destination_id: destination.id,
  };
  const viewId = linked ? 'legacy-linked-view' : undefined;
  if (viewId) f.store.putDocument(f.actor.tenantId, 'overview_view', viewId, {config, schedule_id: id, created_at: 1});
  f.store.putDocument(f.actor.tenantId, 'overview_schedule', id, {
    config,
    ...settings,
    ...(viewId ? {view_id: viewId} : {}),
    is_active: active,
    definition_version: 1,
    next_run_at: Date.now() - 1000,
    actor_binding: f.store.bindJobActor(f.actor, id),
    created_at: 1,
  });
  return {
    ...f,
    config,
    settings,
    id,
    viewId,
    schedule: () => f.store.document(f.actor.tenantId, 'overview_schedule', id),
    ledger: key => f.store.document(f.actor.tenantId, objectiveMigrationKind, key),
  };
}

test('updating a standalone legacy schedule without config creates its linked view and preserves rollback data', async t => {
  const f = await legacySchedule(t),
    before = f.schedule();
  const updated = await f.overview.handle(
    {
      action: 'update_schedule',
      id: f.id,
      expected_revision: before.revision,
      schedule: {...f.settings, schedule_config: {hour: 9}},
      confirmed: true,
    },
    f.actor,
  );
  const schedule = f.schedule(),
    view = f.store.document(f.actor.tenantId, 'overview_view', updated.view_id);
  assert.equal(schedule.revision, before.revision + 1);
  assert.equal(schedule.definition_version, 2);
  assert.deepEqual(schedule.config, f.config);
  assert.deepEqual(view.config, f.config);
  assert.equal(schedule.config_v4.contract_version, overviewConfigV4);
  assert.equal(view.config_v4.sources[0].objective_fallback, 'leads');
  assert.equal(f.ledger('view:' + view.id).announced_report_id, null);
  assert.throws(() => f.ledger('schedule:' + f.id), {code: 'NOT_FOUND'});
});

test('linking the same origin keeps an announced schedule claim over a pending view claim', t => {
  const f = objectiveReportFixture(t),
    kind = objectiveMigrationKind;
  f.store.putDocument(f.actor.tenantId, kind, 'schedule:s', {
    origin_fingerprint: 'same-origin',
    registered_at: 1,
    announced_report_id: 'first',
    announced_at: 2,
  });
  f.store.putDocument(f.actor.tenantId, kind, 'view:v', {
    origin_fingerprint: 'same-origin',
    registered_at: 3,
    announced_report_id: null,
  });
  f.store.transaction(() => linkObjectiveMigration(f.store, f.actor.tenantId, 's', 'v'));
  const claim = f.store.document(f.actor.tenantId, kind, 'view:v');
  assert.equal(claim.id, 'view:v');
  assert.equal(claim.revision, 2);
  assert.equal(claim.announced_report_id, 'first');
  assert.equal(claim.announced_at, 2);
  assert.throws(() => f.store.document(f.actor.tenantId, kind, 'schedule:s'), {code: 'NOT_FOUND'});
  f.store.transaction(() => linkObjectiveMigration(f.store, f.actor.tenantId, 's', 'v'));
  assert.deepEqual(f.store.document(f.actor.tenantId, kind, 'view:v'), claim);
});

test('linking a different origin preserves the view claim and never transfers another tenant claim', t => {
  const f = objectiveReportFixture(t),
    kind = objectiveMigrationKind;
  for (const [key, origin, report] of [
    ['schedule:s', 'schedule-origin', 'prior'],
    ['view:v', 'view-origin', null],
  ])
    f.store.putDocument(f.actor.tenantId, kind, key, {origin_fingerprint: origin, announced_report_id: report});
  const view = f.store.document(f.actor.tenantId, kind, 'view:v');
  f.store.putDocument('other-tenant', kind, 'schedule:s', {
    origin_fingerprint: 'schedule-origin',
    announced_report_id: 'other',
  });
  f.store.transaction(() => linkObjectiveMigration(f.store, f.actor.tenantId, 's', 'v'));
  assert.deepEqual(f.store.document(f.actor.tenantId, kind, 'view:v'), view);
  assert.equal(f.store.document('other-tenant', kind, 'schedule:s').announced_report_id, 'other');
});

test('an announced standalone run cannot announce again after an update links it to an already registered same-origin view', async t => {
  const f = await legacySchedule(t);
  f.overview.tick();
  await f.worker.once();
  const first = f.store.document(f.actor.tenantId, 'overview_report', f.schedule().last_report_id);
  assert.equal(first.state, 'complete', JSON.stringify(first.sources));
  assert.equal(notices(first).length, 1);
  const viewId = 'same-origin-view';
  f.store.putDocument(f.actor.tenantId, 'overview_view', viewId, {config: f.config, created_at: 1});
  const view = f.store.document(f.actor.tenantId, 'overview_view', viewId);
  registerObjectiveMigration(f.store, f.actor.tenantId, view, 'overview_view');
  assert.equal(f.ledger('view:' + viewId).announced_report_id, null);
  await f.overview.handle(
    {
      action: 'update_schedule',
      id: f.id,
      view_id: viewId,
      expected_revision: f.schedule().revision,
      expected_view_revision: view.revision,
      schedule: f.settings,
      confirmed: true,
    },
    f.actor,
  );
  assert.equal(f.ledger('view:' + viewId).announced_report_id, first.id);
  // Remove the queued file export; only the next reporting collection is relevant to this assertion.
  f.store.db.prepare("UPDATE jobs SET state='cancelled' WHERE kind='report_file_export' AND state='queued'").run();
  const second = await f.finish(await f.overview.handle({action: 'run', id: viewId, confirmed: true}, f.actor));
  assert.equal(second.state, 'complete');
  assert.deepEqual(notices(second), []);
});

test('resuming legacy linked schedules upgrades both definitions once and preserves their original config', async t => {
  const f = await legacySchedule(t, {linked: true, active: false}),
    before = f.schedule();
  await f.overview.handle(
    {action: 'resume_schedule', id: f.id, expected_revision: before.revision, confirmed: true},
    f.actor,
  );
  const schedule = f.schedule(),
    view = f.store.document(f.actor.tenantId, 'overview_view', f.viewId);
  assert.equal(schedule.is_active, true);
  assert.equal(schedule.revision, before.revision + 1);
  assert.equal(schedule.definition_version, 2);
  assert.equal(schedule.config_v4.contract_version, overviewConfigV4);
  assert.equal(view.config_v4.contract_version, overviewConfigV4);
  assert.deepEqual(schedule.config, f.config);
  assert.deepEqual(view.config, f.config);
  const claim = f.ledger('view:' + f.viewId);
  await f.overview.handle(
    {action: 'pause_schedule', id: f.id, expected_revision: schedule.revision, confirmed: true},
    f.actor,
  );
  await f.overview.handle(
    {action: 'resume_schedule', id: f.id, expected_revision: f.schedule().revision, confirmed: true},
    f.actor,
  );
  assert.deepEqual(f.ledger('view:' + f.viewId), claim);
});

test('failed legacy resume rolls back sidecars and notice registration with the surrounding transaction', async t => {
  const f = await legacySchedule(t, {linked: true, active: false}),
    before = f.schedule(),
    viewBefore = f.store.document(f.actor.tenantId, 'overview_view', f.viewId);
  f.store.deleteDocument(f.actor.tenantId, 'report_file_destination', f.settings.destination_id);
  await assert.rejects(
    f.overview.handle(
      {
        action: 'resume_schedule',
        id: f.id,
        expected_revision: before.revision,
        confirmed: true,
      },
      f.actor,
    ),
    {code: 'NOT_FOUND'},
  );
  assert.deepEqual(f.schedule(), before);
  assert.deepEqual(f.store.document(f.actor.tenantId, 'overview_view', f.viewId), viewBefore);
  assert.equal(f.store.documents(f.actor.tenantId, objectiveMigrationKind).length, 0);
});

test('legacy creation idempotency survives normalized v4 configs but rejects changed schedule settings', async t => {
  const key = 'old-schedule-key',
    id = sha256('schedule:' + key),
    f = await legacySchedule(t, {linked: true, id});
  const old = f.schedule(),
    normalized = f.overview.config(f.config, f.actor, false, true);
  f.store.putDocument(f.actor.tenantId, 'overview_schedule', id, {
    ...old,
    config: normalized,
    fingerprint_version: 2,
    request_fingerprint: sha256(stable({name: normalized.name, config: normalized, ...f.settings, view_id: f.viewId})),
  });
  const before = f.schedule();
  const args = {action: 'schedule', id: f.viewId, idempotency_key: key, schedule: f.settings, confirmed: true};
  const retried = await f.overview.handle(args, f.actor);
  assert.equal(retried.id, id);
  assert.equal(retried.revision, before.revision);
  assert.deepEqual(f.schedule(), before);
  await assert.rejects(f.overview.handle({...args, schedule: {...f.settings, schedule_config: {hour: 9}}}, f.actor), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
});

test('a reader cannot trigger migration writes by running or resuming a saved legacy report', async t => {
  const f = await legacySchedule(t, {linked: true, active: false}),
    before = f.schedule();
  const reader = {...f.actor, role: 'reader'};
  for (const input of [
    {action: 'run', id: f.viewId},
    {action: 'resume_schedule', id: f.id, expected_revision: before.revision},
  ])
    await assert.rejects(f.overview.handle({...input, confirmed: true}, reader), {code: 'FORBIDDEN'});
  assert.deepEqual(f.schedule(), before);
  assert.equal(f.store.document(f.actor.tenantId, 'overview_view', f.viewId).config_v4, undefined);
  assert.equal(f.store.documents(f.actor.tenantId, objectiveMigrationKind).length, 0);
});

test('durable objective migration claims are registered as tenant documents retained with saved definitions', () => {
  const kind = documentKind(objectiveMigrationKind);
  assert.equal(kind.scope, 'tenant');
  assert.equal(kind.owner, 'src/report-definition-migration.ts');
  assert.equal(kind.retention.rule, 'workspace');
});

test('queued manual and scheduled runs share one durable notice claim without changing their collection contracts', async t => {
  const f = await legacySchedule(t, {linked: true});
  const manual = await f.overview.handle({action: 'run', id: f.viewId, confirmed: true}, f.actor);
  f.overview.tick();
  const scheduledId = f.schedule().last_report_id;
  assert.notEqual(manual.id, scheduledId);
  await f.worker.once();
  await f.worker.once();
  const reports = [manual.id, scheduledId].map(id => f.store.document(f.actor.tenantId, 'overview_report', id));
  assert(
    reports.every(r => r.state === 'complete'),
    JSON.stringify(reports.map(r => [r.state, r.sources])),
  );
  assert.equal(reports.flatMap(notices).length, 1);
  assert.equal(f.ledger('view:' + f.viewId).announced_report_id, reports.find(r => notices(r).length).id);
  assert(reports.every(r => r.config.contract_version === overviewConfigV4));
});

test('a previously queued legacy run retains its objective semantics and cannot consume the upgraded run notice', async t => {
  const f = await legacySchedule(t, {linked: true});
  const oldConfig = f.overview.config(f.config, f.actor, false, true);
  const old = f.overview.queue(f.actor, oldConfig, undefined, undefined, Date.now(), f.viewId);
  const modern = await f.overview.handle({action: 'run', id: f.viewId, confirmed: true}, f.actor);
  await f.worker.once();
  await f.worker.once();
  const oldReport = f.store.document(f.actor.tenantId, 'overview_report', old.id),
    newReport = f.store.document(f.actor.tenantId, 'overview_report', modern.id);
  assert.equal(oldReport.state, 'complete');
  assert.equal(oldReport.rows[0].objective_group, 'leads');
  assert.notEqual(oldReport.config.contract_version, overviewConfigV4);
  assert.deepEqual(notices(oldReport), []);
  assert.equal(newReport.rows[0].objective_group, 'traffic');
  assert.equal(notices(newReport).length, 1);
  assert.equal(f.ledger('view:' + f.viewId).announced_report_id, modern.id);
});

test('editing a legacy linked definition keeps its rollback projection and durable claim across subsequent edits', async t => {
  const f = await legacySchedule(t, {linked: true}),
    before = f.store.document(f.actor.tenantId, 'overview_view', f.viewId);
  const config = {...f.config, name: 'Edited saved report'};
  await f.overview.handle(
    {
      action: 'save',
      id: f.viewId,
      expected_revision: before.revision,
      config,
      confirmed: true,
    },
    f.actor,
  );
  const edited = f.store.document(f.actor.tenantId, 'overview_view', f.viewId);
  assert.equal(edited.config.name, config.name);
  assert.equal(edited.config.sources[0].objective, 'leads');
  assert.equal(edited.config.sources[0].level, 'campaign');
  assert.equal(edited.config.sources[0].report_options, undefined);
  assert.equal(edited.config_v4.sources[0].objective_fallback, 'leads');
  assert.equal(f.schedule().config_v4.name, config.name);
  assert.equal(f.schedule().definition_version, 2);
  const report = await f.finish(await f.overview.handle({action: 'run', id: f.viewId, confirmed: true}, f.actor));
  assert.equal(notices(report).length, 1);
  const claim = f.ledger('view:' + f.viewId),
    current = f.store.document(f.actor.tenantId, 'overview_view', f.viewId);
  await f.overview.handle(
    {
      action: 'save',
      id: f.viewId,
      expected_revision: current.revision,
      config: {...current.config_v4, name: 'Edited again'},
      confirmed: true,
    },
    f.actor,
  );
  assert.deepEqual(f.ledger('view:' + f.viewId), claim);
  await assert.rejects(
    f.overview.handle(
      {
        action: 'save',
        id: f.viewId,
        expected_revision: before.revision,
        config,
        confirmed: true,
      },
      f.actor,
    ),
    {code: 'REVISION_CONFLICT'},
  );
});

test('a comparison baseline cannot consume the numbers-changed notice intended for the current delivery', async t => {
  const f = await legacySchedule(t, {linked: true});
  const pair = await f.overview.handle(
    {action: 'run', id: f.viewId, compare: 'previous_period', confirmed: true},
    f.actor,
  );
  await f.worker.once();
  const baseline = f.store.document(f.actor.tenantId, 'overview_report', pair.comparison.baseline_id);
  assert.equal(baseline.state, 'complete');
  assert.deepEqual(notices(baseline), []);
  assert.equal(f.ledger('view:' + f.viewId).announced_report_id, null);
  await f.worker.once();
  const current = f.store.document(f.actor.tenantId, 'overview_report', pair.id);
  assert.equal(current.state, 'complete');
  assert.deepEqual(notices(current), [objectiveMigrationNotice]);
  assert.equal(f.ledger('view:' + f.viewId).announced_report_id, pair.id);
});

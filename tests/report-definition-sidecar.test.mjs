import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRefused} from './helpers/assert-refused.mjs';
import {rollbackFixture, rollingWindow} from './helpers/rollback-fixture.mjs';
import {overviewConfigV4} from '../dist/src/overview-v4.js';
import {saveAccessSet} from '../dist/src/access-sets.js';
import {sha256, stable} from '../dist/src/security.js';
import {workspaceSearch} from '../dist/server/workspace-search.js';

// The stored v4 form (`config_v4`) is a sidecar of the v3 form (`config`): a build that does not know it, which is
// what a rollback runs, edits `config` and leaves the sidecar behind. The sidecar says which `config` it was made from.
const basis = config => sha256(stable(config));
const migrations = f =>
  f.store
    .audit(f.actor.tenantId, 1000)
    .map(row => ({request: row.request_id, ...JSON.parse(row.event)}))
    .filter(event => event.event === 'report_definition_migrated');
const bootstrap = async (f, actor) => f.overview.handle({action: 'bootstrap'}, actor ?? f.actor);

/** A stored v3 report with its schedule, as Work-here wrote them. */
async function legacyScheduled(t, {objective} = {}) {
  const f = rollbackFixture(t, {platforms: ['meta']}),
    destination = await f.handle({
      action: 'bind_file_destination',
      confirmed: true,
      idempotency_key: 'sidecar-files-0001',
      file_destination: {name: 'Sidecar files', formats: ['xlsx']},
    }),
    config = f.body([f.source('meta', objective ? {objective} : {})], {version: 3, date_range: rollingWindow});
  f.store.putDocument(f.actor.tenantId, 'overview_view', 'legacy-view', {
    config,
    schedule_id: 'legacy-schedule',
    destination_id: destination.id,
    created_at: 1,
  });
  f.store.putDocument(f.actor.tenantId, 'overview_schedule', 'legacy-schedule', {
    config,
    view_id: 'legacy-view',
    is_active: true,
    definition_version: 1,
    schedule_kind: 'daily',
    schedule_config: {hour: 8},
    timezone: 'UTC',
    destination_id: destination.id,
    next_run_at: Date.now() - 1000,
    actor_binding: f.store.bindJobActor(f.actor, 'legacy-schedule'),
    created_at: 1,
  });
  return {f, config, destination};
}
/** What Work-here does on an edit: it writes `config` and keeps the fields it does not know. */
function editUnderWorkHere(f, kind, id, change) {
  const {id: _id, revision, ...record} = f.document(kind, id);
  f.store.putDocument(f.actor.tenantId, kind, id, {...record, config: change(record.config)}, revision);
}
const v4Body = (f, name) =>
  f.body([f.source('meta', {levels: ['campaign'], delivered_only: false})], {
    name,
    contract_version: overviewConfigV4,
    date_range: rollingWindow,
  });

// ---- F-L6-05: a stale sidecar must not silently win ----
test('a report edited on Work-here during a rollback keeps that edit after the roll forward, with a warning', async t => {
  const f = rollbackFixture(t, {platforms: ['meta']}),
    saved = await f.handle({action: 'save', config: v4Body(f, 'Original name'), confirmed: true});
  assert.equal(
    f.document('overview_view', saved.id).config_v4_basis,
    basis(f.document('overview_view', saved.id).config),
  );
  editUnderWorkHere(f, 'overview_view', saved.id, config => ({
    ...config,
    name: 'Edited under Work-here',
    metrics: ['spend'],
  }));
  const shown = (await bootstrap(f)).views.find(view => view.id === saved.id);
  assert.equal(shown.config.name, 'Edited under Work-here', 'the newer edit is what the editor opens');
  assert.deepEqual(shown.config.metrics, ['spend']);
  assert.equal(shown.warnings.length, 1);
  assert.equal(shown.warnings[0].code, 'DEFINITION_CHANGED_ELSEWHERE');
  assert.equal(shown.config_v4, undefined);
  // It runs as edited, and the run rebuilds the sidecar from the edit.
  const run = await f.handle({action: 'run', id: saved.id, confirmed: true});
  await f.drain();
  const snapshot = f.document('overview_report', run.id);
  assert.equal(snapshot.config.name, 'Edited under Work-here');
  assert.deepEqual(snapshot.config.metrics, ['spend']);
  const rebuilt = f.document('overview_view', saved.id);
  assert.equal(rebuilt.config_v4.name, 'Edited under Work-here');
  assert.equal(rebuilt.config_v4_basis, basis(rebuilt.config));
  assert.equal((await bootstrap(f)).views.find(view => view.id === saved.id).warnings, undefined);
});

test('a template and a schedule edited on rollback read the same way', async t => {
  const f = rollbackFixture(t, {platforms: ['meta']}),
    destination = await f.handle({
      action: 'bind_file_destination',
      confirmed: true,
      idempotency_key: 'sidecar-files-0002',
      file_destination: {name: 'Sidecar files 2', formats: ['xlsx']},
    }),
    template = await f.handle({action: 'save_template', config: v4Body(f, 'Template v4'), confirmed: true}),
    view = await f.handle({action: 'save', config: v4Body(f, 'Scheduled v4'), confirmed: true}),
    schedule = await f.handle({
      action: 'schedule',
      id: view.id,
      idempotency_key: 'sidecar-sched-0001',
      schedule: {schedule_kind: 'daily', timezone: 'UTC', schedule_config: {hour: 8}, destination_id: destination.id},
      confirmed: true,
    });
  editUnderWorkHere(f, 'overview_template', template.id, config => ({...config, name: 'Template edited'}));
  editUnderWorkHere(f, 'overview_schedule', schedule.id, config => ({...config, name: 'Schedule edited'}));
  const boot = await bootstrap(f);
  assert.equal(boot.templates.find(row => row.id === template.id).config.name, 'Template edited');
  assert.equal(boot.schedules.find(row => row.id === schedule.id).config.name, 'Schedule edited');
  assert.equal(boot.views.find(row => row.id === view.id).config.name, 'Scheduled v4', 'the unedited view is current');
  assert.equal(boot.views.find(row => row.id === view.id).warnings, undefined);
  // Previewing the edited schedule reads the edited form as well.
  const preview = await f.handle({action: 'preview_schedule', id: schedule.id});
  assert.equal(preview.occurrences.length, 3);
});

test('the listing gate, the edit gate, the payload and the workspace search read one form, for a client-limited key', async t => {
  const A = '7100000001',
    B = '7200000002',
    f = rollbackFixture(t, {platforms: []}),
    admin = f.actor;
  f.store.putConnection(
    admin,
    {
      id: 'meta-login',
      tenantId: admin.tenantId,
      gateway: 'meta_native_action',
      accounts: [A, B],
      writeAccounts: [A, B],
      enabled: true,
      label: 'Meta',
      scopes: ['ads_read'],
    },
    {accessToken: 'synthetic'},
  );
  const set = saveAccessSet(f.store, admin, {
      name: 'Client A',
      bindings: [{gateway: 'meta_native_action', connection_id: 'meta-login', account_id: A}],
    }),
    scoped = f.store.authenticate(
      f.store.createKey({
        tenantId: admin.tenantId,
        userId: 'connector/client-a',
        role: 'operator',
        accessSetId: String(set.id),
      }),
    ),
    source = account => ({
      platform: 'meta',
      account_id: account,
      connection_id: 'meta-login',
      levels: ['campaign'],
      delivered_only: false,
    }),
    both = await f.handle({
      action: 'save',
      confirmed: true,
      config: f.body([source(A), source(B)], {
        name: 'Both clients',
        contract_version: overviewConfigV4,
        date_range: rollingWindow,
      }),
    });
  // Work-here edits the report down to client A's account and renames it; the sidecar still names both accounts.
  editUnderWorkHere(f, 'overview_view', both.id, config => ({
    ...config,
    name: 'Renamed on rollback',
    sources: config.sources.filter(entry => entry.account_id === A),
  }));
  const boot = await bootstrap(f, scoped),
    listed = boot.views.find(view => view.id === both.id);
  assert.ok(listed, 'the record is listed to the client key');
  assert.deepEqual(
    listed.config.sources.map(entry => entry.account_id),
    [A],
    'the payload shows the form the gate checked',
  );
  assert.ok(!JSON.stringify(boot).includes(B), 'the other client’s account never reaches this key');
  // The workspace search lists the same report, under the same name.
  const search = await workspaceSearch(f.store, scoped, 'rollback', async () => ({success: true, data: {}}));
  const found = search.results.find(hit => hit.kind === 'report' && hit.id === both.id);
  assert.ok(found, 'search finds the report by its edited name');
  assert.ok(found.label.includes('Renamed on rollback'));
  assert.equal(
    (await workspaceSearch(f.store, scoped, 'Both clients', async () => ({success: true, data: {}}))).results.filter(
      hit => hit.kind === 'report',
    ).length,
    0,
    'the name of the stale form no longer matches',
  );
  // The edit gate and the run use that form too: a key limited to client A may run and edit the A-only report.
  const run = await f.overview.handle({action: 'run', id: both.id, confirmed: true}, scoped);
  assert.equal(run.state, 'queued');
  const current = f.document('overview_view', both.id);
  await f.overview.handle(
    {
      action: 'save',
      id: both.id,
      expected_revision: current.revision,
      config: {
        ...f.body([source(A)], {contract_version: overviewConfigV4, date_range: rollingWindow}),
        name: 'Edited by client A',
      },
      confirmed: true,
    },
    scoped,
  );
  // A report that really names the other account stays out of reach.
  const other = await f.handle({
    action: 'save',
    confirmed: true,
    config: f.body([source(B)], {name: 'Client B only', contract_version: overviewConfigV4, date_range: rollingWindow}),
  });
  await assert.rejects(f.overview.handle({action: 'run', id: other.id, confirmed: true}, scoped), error =>
    assertRefused(error, 'ACCOUNT_SCOPE_RESTRICTED'),
  );
});

// ---- F-L6-09: an automatic write is not a person's edit ----
for (const action of ['a schedule update', 'a save of the report'])
  test('a scheduler tick between loading a report and ' + action + ' causes no revision conflict', async t => {
    const {f, destination} = await legacyScheduled(t, {objective: 'leads'}),
      loaded = (await bootstrap(f)).views.find(view => view.id === 'legacy-view');
    assert.equal(loaded.revision, 1);
    // Its first post-deploy occurrence fires: the scheduler upgrades the schedule and its linked view.
    f.overview.tick();
    const view = f.document('overview_view', 'legacy-view');
    assert.equal(view.config_v4.contract_version, overviewConfigV4, 'the view was upgraded');
    assert.equal(view.revision, loaded.revision, 'by a write that is not a person’s edit');
    // The person acts from the report as they loaded it. (The occurrence itself advances the schedule’s revision, as in
    // Work-here, so a schedule update names the schedule revision it reads now and the view revision it loaded.)
    if (action === 'a schedule update')
      await f.handle({
        action: 'update_schedule',
        id: 'legacy-schedule',
        expected_revision: f.document('overview_schedule', 'legacy-schedule').revision,
        expected_view_revision: loaded.revision,
        schedule: {schedule_kind: 'daily', timezone: 'UTC', schedule_config: {hour: 9}, destination_id: destination.id},
        confirmed: true,
      });
    else
      await f.handle({
        action: 'save',
        id: 'legacy-view',
        expected_revision: loaded.revision,
        config: {...loaded.config, name: 'Edited after the tick'},
        confirmed: true,
      });
    const after = f.document('overview_view', 'legacy-view');
    assert.equal(after.revision, loaded.revision + 1, 'the person’s write is the one that advances it');
    if (action === 'a save of the report') assert.equal(after.config_v4.name, 'Edited after the tick');
  });

test('running a stored report by id leaves its revision where the editor read it', async t => {
  const {f} = await legacyScheduled(t),
    before = f.document('overview_view', 'legacy-view'),
    queued = await f.handle({action: 'run', id: 'legacy-view', confirmed: true}),
    after = f.document('overview_view', 'legacy-view');
  assert.equal(after.config_v4.contract_version, overviewConfigV4);
  assert.equal(after.revision, before.revision);
  assert.equal(queued.view_revision, before.revision, 'a run still reports the revision to edit from');
  assert.equal(after.config_v4_basis, basis(after.config));
  assert.deepEqual(after.config, before.config, 'the v3 form is untouched');
});

test('every write path that builds a sidecar records the form it was built from', async t => {
  const {f, destination} = await legacyScheduled(t);
  // Resume writes the schedule's sidecar and the view's.
  f.store.putDocument(f.actor.tenantId, 'overview_schedule', 'legacy-schedule', {
    ...(({id, revision, ...rest}) => rest)(f.document('overview_schedule', 'legacy-schedule')),
    is_active: false,
  });
  await f.handle({
    action: 'resume_schedule',
    id: 'legacy-schedule',
    expected_revision: f.document('overview_schedule', 'legacy-schedule').revision,
    confirmed: true,
  });
  for (const [kind, id] of [
    ['overview_schedule', 'legacy-schedule'],
    ['overview_view', 'legacy-view'],
  ]) {
    const record = f.document(kind, id);
    assert.equal(record.config_v4.contract_version, overviewConfigV4, kind);
    assert.equal(record.config_v4_basis, basis(record.config), kind + ' (resume)');
  }
  // The tick writes the schedule's sidecar with its occurrence.
  const other = await legacyScheduled(t);
  other.f.overview.tick();
  const ticked = other.f.document('overview_schedule', 'legacy-schedule');
  assert.equal(ticked.config_v4_basis, basis(ticked.config), 'tick');
  // A schedule created from a stored report keeps the report’s v3 form and writes the sidecar beside it.
  const third = await legacyScheduled(t);
  const unscheduled = third.f.document('overview_view', 'legacy-view');
  third.f.store.putDocument(third.f.actor.tenantId, 'overview_view', 'plain-view', {
    config: unscheduled.config,
    created_at: 1,
  });
  const created = await third.f.handle({
    action: 'schedule',
    id: 'plain-view',
    idempotency_key: 'sidecar-sched-0002',
    schedule: {
      schedule_kind: 'daily',
      timezone: 'UTC',
      schedule_config: {hour: 7},
      destination_id: (
        await third.f.handle({
          action: 'bind_file_destination',
          confirmed: true,
          idempotency_key: 'sidecar-files-0003',
          file_destination: {name: 'Sidecar files 3', formats: ['xlsx']},
        })
      ).id,
    },
    confirmed: true,
  });
  for (const [kind, id] of [
    ['overview_schedule', created.id],
    ['overview_view', 'plain-view'],
  ]) {
    const record = third.f.document(kind, id);
    assert.equal(record.config_v4_basis, basis(record.config), kind + ' (schedule)');
  }
  assert.ok(destination);
});

// ---- F-L9-02: a state change through a new path is journalled like the existing ones ----
test('each migrated stored definition is journalled once, whichever path migrates it, and an upgraded one never again', async t => {
  // Run by id: the view.
  const run = await legacyScheduled(t);
  await run.f.handle({action: 'run', id: 'legacy-view', confirmed: true});
  assert.deepEqual(
    migrations(run.f).map(event => [event.request, event.id]),
    [['report-library/legacy-view', 'legacy-view']],
  );
  await run.f.handle({action: 'run', id: 'legacy-view', confirmed: true});
  assert.equal(migrations(run.f).length, 1, 'a second run migrates nothing and journals nothing');
  // The scheduler: the schedule and its linked view, once each.
  const tick = await legacyScheduled(t);
  tick.f.overview.tick();
  assert.deepEqual(
    migrations(tick.f)
      .map(event => event.id)
      .sort(),
    ['legacy-schedule', 'legacy-view'],
  );
  const record = tick.f.document('overview_schedule', 'legacy-schedule');
  tick.f.store.putDocument(
    tick.f.actor.tenantId,
    'overview_schedule',
    'legacy-schedule',
    {...(({id, revision, ...rest}) => rest)(record), next_run_at: Date.now() - 1000},
    record.revision,
  );
  tick.f.overview.tick();
  assert.equal(migrations(tick.f).length, 2, 'the next occurrence journals nothing');
  // Resume: a paused schedule and its view.
  const resume = await legacyScheduled(t);
  const paused = resume.f.document('overview_schedule', 'legacy-schedule');
  resume.f.store.putDocument(
    resume.f.actor.tenantId,
    'overview_schedule',
    'legacy-schedule',
    {...(({id, revision, ...rest}) => rest)(paused), is_active: false},
    paused.revision,
  );
  await resume.f.handle({
    action: 'resume_schedule',
    id: 'legacy-schedule',
    expected_revision: resume.f.document('overview_schedule', 'legacy-schedule').revision,
    confirmed: true,
  });
  assert.deepEqual(
    migrations(resume.f)
      .map(event => event.id)
      .sort(),
    ['legacy-schedule', 'legacy-view'],
  );
  assert.ok(migrations(resume.f).every(event => event.actor === 'owner'));
});

test('a definition born in v4, or already upgraded, is never journalled as migrated', async t => {
  const f = rollbackFixture(t, {platforms: ['meta']}),
    saved = await f.handle({action: 'save', config: v4Body(f, 'Born in v4'), confirmed: true});
  await f.handle({action: 'run', id: saved.id, confirmed: true});
  assert.deepEqual(migrations(f), []);
});

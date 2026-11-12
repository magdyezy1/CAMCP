import test from 'node:test';
import assert from 'node:assert/strict';
import {rollbackFixture, rollingWindow} from './helpers/rollback-fixture.mjs';
import {overviewConfigV4} from '../dist/src/overview-v4.js';
import {saveAccessSet} from '../dist/src/access-sets.js';

/**
 * DR2-04 (differential review, wave 5 round 2): the audit rows of saved-definition and schedule changes name the client
 * access set the actor works under, as the rows of every other tool do (SEC-08, `accessSetAudit`). The report library's
 * row is the main record of such a change (the composite tool writes none of its own on success), so without the set a
 * change by a client-limited key could not be tied to its client scope.
 */
const A = '7100000001';

/** An administrator, one Meta login holding account A, a client access set bound to A, and a key limited to that set. */
function fixture(t) {
  const f = rollbackFixture(t, {platforms: []}),
    admin = f.actor;
  f.store.putConnection(
    admin,
    {
      id: 'meta-login',
      tenantId: admin.tenantId,
      gateway: 'meta_native_action',
      accounts: [A],
      writeAccounts: [A],
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
    );
  const source = {
    platform: 'meta',
    account_id: A,
    connection_id: 'meta-login',
    levels: ['campaign'],
    delivered_only: false,
  };
  const bind = name =>
    f.handle({
      action: 'bind_file_destination',
      confirmed: true,
      idempotency_key: name.toLowerCase().replace(/\W+/g, '-') + '-0001',
      file_destination: {name, formats: ['xlsx']},
    });
  return {f, set: String(set.id), scoped, source, bind};
}
/** What the library wrote: its rows are the ones whose request is `report-library/<id>`. */
const libraryRows = f =>
  f.store
    .audit(f.actor.tenantId, 1000)
    .filter(row => row.request_id.startsWith('report-library/'))
    .map(row => ({request: row.request_id, ...JSON.parse(row.event)}));

/** Saves, edits and deletes a report and a template, and creates, pauses, resumes, edits and deletes a schedule. */
async function changeReports(f, actor, source, destination, label) {
  const config = name =>
      f.body([source], {
        name: label + ' ' + name,
        contract_version: overviewConfigV4,
        date_range: rollingWindow,
      }),
    call = input => f.overview.handle({confirmed: true, ...input}, actor),
    schedule = {
      schedule_kind: 'daily',
      timezone: 'UTC',
      schedule_config: {hour: 8},
      destination_id: destination.id,
    };
  const saved = await call({action: 'save', config: config('report')});
  await call({
    action: 'save',
    id: saved.id,
    expected_revision: f.document('overview_view', saved.id).revision,
    config: config('report, edited'),
  });
  const template = await call({action: 'save_template', config: config('template')});
  const scheduled = await call({
    action: 'schedule',
    idempotency_key: label.toLowerCase().replace(/\W+/g, '-') + '-schedule-0001',
    config: config('schedule'),
    schedule,
  });
  const revision = () => f.document('overview_schedule', scheduled.id).revision;
  await call({action: 'pause_schedule', id: scheduled.id, expected_revision: revision()});
  await call({action: 'resume_schedule', id: scheduled.id, expected_revision: revision()});
  await call({
    action: 'update_schedule',
    id: scheduled.id,
    expected_revision: revision(),
    config: config('schedule, edited'),
    schedule,
  });
  // `delete_schedule` is the legacy pause; the schedule is deleted by `remove_schedule`.
  await call({action: 'remove_schedule', id: scheduled.id, expected_revision: revision()});
  // A snapshot of the saved report (queued; no provider is read) and its deletion.
  const snapshot = await call({action: 'run', id: saved.id});
  await call({action: 'delete_report', id: snapshot.id});
  await call({
    action: 'delete_view',
    id: saved.id,
    expected_revision: f.document('overview_view', saved.id).revision,
  });
  await call({
    action: 'delete_template',
    id: template.id,
    expected_revision: f.document('overview_template', template.id).revision,
  });
  return {saved, template, scheduled, snapshot};
}
const events = [
  'report_definition_saved',
  'report_definition_saved',
  'report_template_saved',
  'report_schedule_created',
  'report_schedule_paused',
  'report_schedule_resumed',
  'report_schedule_updated',
  'report_schedule_deleted',
  'overview_report_deleted',
  'overview_view_deleted',
  'overview_template_deleted',
];

test('a client-limited key saves, edits and deletes a report and works a schedule: every audit row names its set', async t => {
  const {f, set, scoped, source, bind} = fixture(t),
    destination = await bind('Client A files');
  const {saved, template, scheduled, snapshot} = await changeReports(f, scoped, source, destination, 'Client A');
  const rows = libraryRows(f);
  assert.deepEqual(
    rows.map(row => row.event),
    events,
  );
  assert.deepEqual(
    rows.map(row => row.id),
    [
      saved.id,
      saved.id,
      template.id,
      scheduled.id,
      scheduled.id,
      scheduled.id,
      scheduled.id,
      scheduled.id,
      snapshot.id,
      saved.id,
      template.id,
    ],
  );
  for (const row of rows) {
    assert.equal(row.actor, 'connector/client-a', row.event);
    assert.equal(row.access_set_id, set, row.event + ' does not name the client access set');
  }
});

test('the rows of a full-access key carry no access set, as before', async t => {
  const {f, source, bind} = fixture(t),
    destination = await bind('Whole workspace files');
  await changeReports(f, f.actor, source, destination, 'Workspace');
  const rows = libraryRows(f);
  assert.deepEqual(
    rows.map(row => row.event),
    events,
  );
  for (const row of rows) {
    assert.equal(row.actor, 'owner', row.event);
    assert.equal(Object.hasOwn(row, 'access_set_id'), false, row.event + ' names a set for a full-access key');
  }
});

test('the migration of a stored definition under a client-limited key names the set, and under a full-access key does not', async t => {
  const {f, set, scoped, source, bind} = fixture(t);
  // A schedule and its report as Work-here stored them: the v3 form, no v4 sidecar, paused.
  async function stored(id, destination) {
    const config = f.body([{platform: 'meta', account_id: A, connection_id: 'meta-login'}], {
      version: 3,
      date_range: rollingWindow,
    });
    f.store.putDocument(f.actor.tenantId, 'overview_view', id + '-view', {
      config,
      schedule_id: id,
      destination_id: destination.id,
      created_at: 1,
    });
    f.store.putDocument(f.actor.tenantId, 'overview_schedule', id, {
      config,
      view_id: id + '-view',
      is_active: false,
      definition_version: 1,
      schedule_kind: 'daily',
      schedule_config: {hour: 8},
      timezone: 'UTC',
      destination_id: destination.id,
      next_run_at: Date.now() + 86400000,
      actor_binding: f.store.bindJobActor(f.actor, id),
      created_at: 1,
    });
  }
  for (const [id, actor, name] of [
    ['legacy-limited', scoped, 'Legacy client files'],
    ['legacy-full', f.actor, 'Legacy workspace files'],
  ]) {
    await stored(id, await bind(name));
    const before = libraryRows(f).length;
    await f.overview.handle(
      {
        action: 'resume_schedule',
        id,
        expected_revision: f.document('overview_schedule', id).revision,
        confirmed: true,
      },
      actor,
    );
    const rows = libraryRows(f).slice(before);
    assert.deepEqual(
      rows.map(row => row.event),
      ['report_definition_migrated', 'report_definition_migrated', 'report_schedule_resumed'],
      id,
    );
    for (const row of rows)
      if (actor === scoped) assert.equal(row.access_set_id, set, id + ' ' + row.event);
      else assert.equal(Object.hasOwn(row, 'access_set_id'), false, id + ' ' + row.event);
  }
});

// EXP-04 D phase 2 (review 2026-10-08, owner policy P6): workbook schedules carried a spreadsheet ID but only ever
// produced local runs, beside a second schedule system (Overview) that delivers to Google Sheets. A workbook schedule
// now moves into Reporting overview explicitly and reversibly: a dry run converts its campaign query and clock and
// saves nothing, the confirmed move creates one Overview report and schedule on a report tab that bind_destination
// verified for the workbook's own spreadsheet and pauses the local schedule in the same transaction, and undo restores
// it. The saved query and its revision never change. All provider and Sheets responses are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ReportingService} from '../dist/src/reporting.js';
import {workbookSchedule, saveWorkbookSchedule} from '../dist/src/workbook-schedules.js';
import {overviewConfigFromWorkbook} from '../dist/src/workbook-migration.js';
import {destinationOwners} from '../dist/src/reporting-overview.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {overviewGranularityFixture, granularSource} from './fixtures/overview-granularity-data.mjs';

const google = granularSource('google');
const campaignQuery = {
  platform: 'google',
  account_id: '123',
  connection_id: google.connection_id,
  date_range: {preset: 'last_complete_days', days: 7, timezone: 'Asia/Riyadh'},
  granularity: 'day',
  metrics: ['clicks', 'impressions'],
};

async function fixture({query = campaignQuery, active = true} = {}) {
  const f = overviewGranularityFixture(),
    {store, actor, overview} = f,
    tenant = actor.tenantId;
  store.putDocument(tenant, 'workbook', 'wb', {
    spreadsheet_id: 'syntheticGranularSheet',
    spreadsheet_name: 'Client workbook',
    created_by: actor.userId,
  });
  store.putDocument(tenant, 'reporting_query', 'q', {
    name: 'Weekly Google',
    workbook_binding_id: 'wb',
    query_config: query,
  });
  const reporting = new ReportingService(store),
    schedule = reporting.handle(
      'create_reporting_schedule',
      {
        workbook_binding_id: 'wb',
        name: 'Weekly Google workbook',
        timezone: 'Asia/Riyadh',
        schedule_kind: 'weekly',
        schedule_config: {query_id: 'q', weekday: 1, hour: 8, minute: 30},
        is_active: active,
        dry_run: false,
      },
      actor,
    );
  // bind_destination's authenticated read of the spreadsheet (synthetic Sheets) is the verification the move relies on.
  const destination = await overview.handle(
    {
      action: 'bind_destination',
      connection_id: 'sheets-granular',
      spreadsheet_id: 'syntheticGranularSheet',
      tab_name: 'Weekly Google',
      idempotency_key: 'workbook-move-tab-1',
      confirmed: true,
    },
    actor,
  );
  const call = (args, who = actor) => overview.handle(args, who);
  const documents = () =>
    store.db
      .prepare('SELECT kind,id,revision,data FROM documents WHERE tenant_id=? ORDER BY kind,id')
      .all(tenant)
      .map(row => ({...row}));
  return {...f, tenant, scheduleId: schedule.id, destination, call, documents};
}

test('the dry run converts the campaign query and clock, lists the workbook tabs and saves nothing', async () => {
  const f = await fixture();
  try {
    const before = f.documents(),
      requests = f.requests.length;
    const listed = await f.call({action: 'preview_workbook_move', id: f.scheduleId});
    assert.equal(listed.migratable, false);
    assert.deepEqual(
      listed.blockers.map(b => b.code),
      ['destination_required'],
    );
    assert.deepEqual(listed.destinations, [
      {id: f.destination.id, name: f.destination.name, tab_name: f.destination.tab_name, in_use: false},
    ]);
    assert.equal(listed.move_version, null);
    const preview = await f.call({action: 'preview_workbook_move', id: f.scheduleId, destination_id: f.destination.id});
    assert.equal(preview.migratable, true, JSON.stringify(preview.blockers));
    assert.equal(preview.query_revision, 1);
    assert.equal(preview.spreadsheet_id, 'syntheticGranularSheet');
    assert.deepEqual(preview.overview_report.sources, [
      {
        platform: 'google',
        account_id: '123',
        connection_id: google.connection_id,
        native_metrics: ['clicks', 'impressions'],
      },
    ]);
    // compileReport's default daily rows become daily grouping; the rolling window is kept as saved.
    assert.equal(preview.overview_report.grain, 'daily');
    assert.deepEqual(preview.overview_report.date_range, campaignQuery.date_range);
    assert.equal(preview.overview_report.name, 'Weekly Google workbook');
    assert.deepEqual(preview.overview_schedule, {
      schedule_kind: 'weekly',
      schedule_config: {minute: 30, hour: 8, weekday: 1},
      timezone: 'Asia/Riyadh',
      active: true,
    });
    assert.match(preview.move_version, /^[0-9a-f]{64}$/);
    // Preserves query revisions and schedules: the dry run wrote nothing and sent nothing.
    assert.deepEqual(f.documents(), before);
    assert.equal(f.requests.length, requests);
  } finally {
    f.close();
  }
});

test('the move creates one Overview report and schedule on the verified tab and pauses the local schedule', async () => {
  const f = await fixture();
  try {
    const local = workbookSchedule(f.store, f.actor, f.scheduleId),
      preview = await f.call({action: 'preview_workbook_move', id: f.scheduleId, destination_id: f.destination.id}),
      requests = f.requests.length;
    const moved = await f.call({
      action: 'move_workbook_schedule',
      id: f.scheduleId,
      destination_id: f.destination.id,
      move_version: preview.move_version,
      confirmed: true,
    });
    assert.equal(f.requests.length, requests, 'the move itself makes no network request');
    assert.equal(moved.active, false);
    assert.equal(moved.overview_migration.state, 'migrated');
    assert.equal(moved.query_revision, 1);
    const schedule = f.store.document(f.tenant, 'overview_schedule', moved.overview_migration.overview_schedule_id),
      view = f.store.document(f.tenant, 'overview_view', moved.overview_migration.overview_view_id);
    assert.equal(schedule.is_active, true);
    assert.equal(schedule.destination_id, f.destination.id);
    assert.equal(schedule.schedule_kind, 'weekly');
    assert.equal(schedule.timezone, 'Asia/Riyadh');
    assert.deepEqual(schedule.schedule_config, {minute: 30, hour: 8, weekday: 1});
    // The same clock: the Overview schedule's next delivery is the local schedule's next occurrence.
    assert.equal(schedule.next_run_at, local.occurrences[0]);
    assert.deepEqual(view.config.sources, preview.overview_report.sources);
    assert.equal(view.schedule_id, schedule.id);
    // The tab now belongs to the moved schedule (EXP-03 ownership applies unchanged).
    assert.deepEqual(
      destinationOwners(f.store, f.tenant, f.destination.id).map(o => o.schedule_id),
      [schedule.id],
    );
    const raw = f.store.document(f.tenant, 'reporting_schedule', f.scheduleId);
    assert.equal(raw.is_active, false);
    assert.equal(raw.pause_reason, 'migrated_to_overview');
    assert.equal(f.store.document(f.tenant, 'reporting_query', 'q').revision, 1, 'the saved query is unchanged');
    const audit = f.store.db
      .prepare("SELECT event FROM audit WHERE tenant_id=? AND event LIKE '%workbook_schedule_migrated%'")
      .all(f.tenant);
    assert.equal(audit.length, 1);
    // The local schedule cannot run beside the Overview one, and cannot move twice.
    assert.throws(
      () =>
        saveWorkbookSchedule(f.store, f.actor, {
          id: f.scheduleId,
          schedule_version: workbookSchedule(f.store, f.actor, f.scheduleId).schedule_version,
          confirmed: true,
          active: true,
          schedule: {
            name: 'Weekly Google workbook',
            timezone: 'Asia/Riyadh',
            schedule_kind: 'weekly',
            weekday: 1,
            hour: 8,
            minute: 30,
          },
        }),
      e => assertRefused(e, 'WORKBOOK_SCHEDULE_MIGRATED', {status: 409}),
    );
    const again = await f.call({action: 'preview_workbook_move', id: f.scheduleId, destination_id: f.destination.id});
    assert.deepEqual(
      again.blockers.map(b => b.code),
      ['already_migrated', 'destination_in_use'],
    );
    await assert.rejects(
      f.call({
        action: 'move_workbook_schedule',
        id: f.scheduleId,
        destination_id: f.destination.id,
        move_version: preview.move_version,
        confirmed: true,
      }),
      e => assertRefused(e, 'WORKBOOK_MIGRATION_UNSUPPORTED', {status: 409}),
    );
  } finally {
    f.close();
  }
});

test('undo pauses the Overview schedule and restores the local one; a query edited meanwhile stays paused', async () => {
  const f = await fixture();
  try {
    const move = async () => {
      const preview = await f.call({
        action: 'preview_workbook_move',
        id: f.scheduleId,
        destination_id: f.destination.id,
      });
      return f.call({
        action: 'move_workbook_schedule',
        id: f.scheduleId,
        destination_id: f.destination.id,
        move_version: preview.move_version,
        confirmed: true,
      });
    };
    const first = await move(),
      undone = await f.call({action: 'undo_workbook_move', id: f.scheduleId, confirmed: true});
    assert.equal(undone.active, true);
    assert.equal(undone.restored_active, true);
    assert.equal(undone.overview_migration.state, 'reverted');
    assert.ok(undone.next_run_at > Date.now());
    const paused = f.store.document(f.tenant, 'overview_schedule', first.overview_migration.overview_schedule_id);
    assert.equal(paused.is_active, false, 'the Overview schedule is paused; its report and snapshots stay');
    await assert.rejects(f.call({action: 'undo_workbook_move', id: f.scheduleId, confirmed: true}), e =>
      assertRefused(e, 'WORKBOOK_MIGRATION_NOT_FOUND', {status: 409}),
    );
    // Moving again is a new, explicit move with its own Overview schedule.
    const second = await move();
    assert.notEqual(second.overview_migration.overview_schedule_id, first.overview_migration.overview_schedule_id);
    // A query definition edited while moved keeps the local schedule paused for separate review on undo.
    const query = f.store.document(f.tenant, 'reporting_query', 'q');
    const {id, revision, ...data} = query;
    f.store.putDocument(f.tenant, 'reporting_query', 'q', {...data, name: 'Weekly Google (edited)'}, revision);
    const kept = await f.call({action: 'undo_workbook_move', id: f.scheduleId, confirmed: true});
    assert.equal(kept.active, false);
    assert.equal(kept.restored_active, false);
    assert.equal(kept.query_changed, true);
    assert.equal(
      f.store.document(f.tenant, 'reporting_schedule', f.scheduleId).pause_reason,
      'query_definition_changed',
    );
  } finally {
    f.close();
  }
});

test('a paused local schedule moves as a paused Overview schedule and undo keeps it paused', async () => {
  const f = await fixture({active: false});
  try {
    const preview = await f.call({action: 'preview_workbook_move', id: f.scheduleId, destination_id: f.destination.id}),
      moved = await f.call({
        action: 'move_workbook_schedule',
        id: f.scheduleId,
        destination_id: f.destination.id,
        move_version: preview.move_version,
        confirmed: true,
      });
    assert.equal(
      f.store.document(f.tenant, 'overview_schedule', moved.overview_migration.overview_schedule_id).is_active,
      false,
    );
    const undone = await f.call({action: 'undo_workbook_move', id: f.scheduleId, confirmed: true});
    assert.equal(undone.active, false);
  } finally {
    f.close();
  }
});

test('queries without an exact Overview equivalent are refused with reasons, and the move stays unsent', async () => {
  for (const [query, codes] of [
    [
      {gateway: 'google_ads_native_action', arguments: {account_id: '123'}, connection_id: google.connection_id},
      ['native_request'],
    ],
    [{...campaignQuery, date_range: {since: '2026-09-01', until: '2026-09-07'}}, ['fixed_dates']],
    [{...campaignQuery, level: 'adset'}, ['entity_level']],
    [{...campaignQuery, granularity: 'hour'}, ['granularity']],
    [{...campaignQuery, campaign_ids: ['1']}, ['unsupported_fields']],
    [{...campaignQuery, metrics: ['clicks; DROP']}, ['metrics']],
  ]) {
    const f = await fixture({query});
    try {
      const preview = await f.call({
        action: 'preview_workbook_move',
        id: f.scheduleId,
        destination_id: f.destination.id,
      });
      assert.equal(preview.migratable, false);
      assert.deepEqual(
        preview.blockers.map(b => b.code),
        codes,
      );
      assert.ok(preview.blockers.every(b => typeof b.message === 'string' && b.message.length > 20));
      await assert.rejects(
        f.call({
          action: 'move_workbook_schedule',
          id: f.scheduleId,
          destination_id: f.destination.id,
          move_version: 'unused',
          confirmed: true,
        }),
        e => assertRefused(e, 'WORKBOOK_MIGRATION_UNSUPPORTED', {status: 409}),
      );
      assert.equal(f.store.documents(f.tenant, 'overview_schedule').length, 0);
      assert.equal(f.store.document(f.tenant, 'reporting_schedule', f.scheduleId).is_active, true);
    } finally {
      f.close();
    }
  }
});

test('the move refuses another spreadsheet, a changed schedule, readers and unconfirmed requests', async () => {
  const f = await fixture();
  try {
    // A report tab the same Sheets login may use, but in another spreadsheet than the workbook's.
    const sheets = f.store.listConnections(f.tenant).find(c => c.id === 'sheets-granular');
    f.store.putConnection(
      f.actor,
      {...sheets, accounts: [...sheets.accounts, 'otherSpreadsheet']},
      {accessToken: 'synthetic'},
    );
    f.store.putDocument(f.tenant, 'sheets_destination', 'other-sheet', {
      connection_id: 'sheets-granular',
      spreadsheet_id: 'otherSpreadsheet',
      name: 'Other',
      tab_name: 'Other tab',
    });
    await assert.rejects(
      f.call({action: 'preview_workbook_move', id: f.scheduleId, destination_id: 'other-sheet'}),
      e => assertRefused(e, 'WORKBOOK_DESTINATION_MISMATCH'),
    );
    const preview = await f.call({action: 'preview_workbook_move', id: f.scheduleId, destination_id: f.destination.id}),
      args = {
        action: 'move_workbook_schedule',
        id: f.scheduleId,
        destination_id: f.destination.id,
        move_version: preview.move_version,
        confirmed: true,
      };
    await assert.rejects(f.call({...args, confirmed: undefined}), e => assertRefused(e, 'CONFIRMATION_REQUIRED'));
    await assert.rejects(f.call(args, {...f.actor, role: 'reader'}), e => assertRefused(e, 'FORBIDDEN', {status: 403}));
    // The clock changed after the preview: the reviewed move no longer matches.
    const current = workbookSchedule(f.store, f.actor, f.scheduleId);
    saveWorkbookSchedule(f.store, f.actor, {
      id: f.scheduleId,
      schedule_version: current.schedule_version,
      confirmed: true,
      active: true,
      schedule: {
        name: 'Weekly Google workbook',
        timezone: 'Asia/Riyadh',
        schedule_kind: 'weekly',
        weekday: 2,
        hour: 8,
        minute: 30,
      },
    });
    await assert.rejects(f.call(args), e => assertRefused(e, 'STALE_WORKBOOK_MIGRATION', {status: 409}));
    assert.equal(f.store.documents(f.tenant, 'overview_schedule').length, 0);
    await assert.rejects(f.call({action: 'undo_workbook_move', id: f.scheduleId, confirmed: true}), e =>
      assertRefused(e, 'WORKBOOK_MIGRATION_NOT_FOUND', {status: 409}),
    );
  } finally {
    f.close();
  }
});

test('grouping maps compileReport granularity exactly; other settings are named, never dropped', () => {
  const scope = {account_id: '123', connection_id: 'c'},
    grain = granularity =>
      overviewConfigFromWorkbook({query_config: {...campaignQuery, granularity}}, 'Name', scope).config?.grain;
  assert.equal(grain(undefined), 'daily');
  assert.equal(grain('day'), 'daily');
  assert.equal(grain('month'), 'monthly');
  assert.equal(grain('all'), 'total');
  assert.equal(grain('week'), undefined);
  const {blockers} = overviewConfigFromWorkbook(
    {query_config: {...campaignQuery, breakdowns: ['age'], include_creatives: true}},
    'Name',
    scope,
  );
  assert.deepEqual(blockers, [
    {
      code: 'unsupported_fields',
      message: 'Reporting overview has no equivalent for these query settings.',
      fields: ['breakdowns', 'include_creatives'],
    },
  ]);
  const unnamed = overviewConfigFromWorkbook(
    {query_config: {...campaignQuery, metrics: undefined}},
    'x'.repeat(120),
    scope,
  );
  assert.equal(unnamed.config.name.length, 100);
  assert.equal(unnamed.config.sources[0].native_metrics, undefined);
});

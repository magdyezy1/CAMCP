import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {ReportingService} from '../dist/src/reporting.js';
import {ReportWorker} from '../dist/src/worker.js';
import {assertRefused} from './helpers/assert-refused.mjs';

function fixture() {
  const actor = {tenantId: 'schedule-operations', userId: 'operator', role: 'operator'};
  const store = new Store(':memory:', Buffer.alloc(32, 84).toString('base64'));
  const connection = {
    id: 'meta',
    tenantId: actor.tenantId,
    gateway: 'meta_native_action',
    accounts: ['100'],
    enabled: true,
    label: 'Synthetic',
    scopes: [],
  };
  store.putConnection({...actor, role: 'admin'}, connection, {accessToken: 'synthetic'});
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      throw Error('Unexpected network');
    }),
  );
  const config = {
    platform: 'meta',
    account_id: '100',
    connection_id: 'meta',
    date_range: {preset: 'last_complete_days', days: 7},
    timezone: 'UTC',
    private: 'CANARY',
  };
  store.putDocument(actor.tenantId, 'workbook', 'workbook', {spreadsheet_id: 'CANARY'});
  store.putDocument(actor.tenantId, 'reporting_query', 'query', {
    name: 'Weekly sales',
    workbook_binding_id: 'workbook',
    query_config: config,
  });
  const reporting = new ReportingService(store);
  const saved = reporting.handle(
    'create_reporting_schedule',
    {
      workbook_binding_id: 'workbook',
      name: 'Weekly workbook',
      timezone: 'UTC',
      schedule_kind: 'weekly',
      schedule_config: {query_id: 'query', weekday: 1, hour: 9, minute: 0},
      dry_run: false,
    },
    actor,
  );
  const id = saved.id;
  const call = (args, who = actor) => service.call('amcp_workspace', args, who);
  return {actor, store, connection, config, id, call};
}

test('workbook schedules appear in Operations with scoped metadata and three future clock occurrences', async () => {
  const f = fixture();
  try {
    f.store.document = f.store.documents = () => {
      throw Error('Full documents must not be loaded for metadata');
    };
    const feed = await f.call({action: 'operations', kind: 'workbook_schedule', limit: 1});
    assert.equal(feed.success, true, JSON.stringify(feed));
    // The feed's kinds grew with standalone reviewed writes (WRT-08); this test is about workbook schedules.
    assert.ok(feed.data.coverage.includes('workbook_schedule'));
    assert.equal(feed.data.operations[0].id, f.id);
    assert.equal(feed.data.operations[0].state, 'active');
    const row = feed.data.operations[0],
      detail = await f.call(row.next_call.arguments);
    assert.equal(detail.success, true, JSON.stringify(detail));
    assert.equal(detail.data.record_kind, 'workbook_schedule');
    assert.equal(detail.data.query_revision, 1);
    assert.equal(detail.data.occurrences.length, 3);
    assert.ok(detail.data.occurrences.every((at, i, a) => at > Date.now() && (!i || at > a[i - 1])));
    assert.equal(detail.data.destination, 'local');
    assert.doesNotMatch(JSON.stringify(detail), /CANARY|actor_binding|query_config|"authority"/);
    assert.equal(row.website_path, '/operations?workbook_schedule_id=' + f.id);
  } finally {
    f.store.close();
  }
});

test('editing a schedule binds its current query revision and changes only future occurrences', async () => {
  const f = fixture();
  try {
    let detail = (await f.call({action: 'report_schedule', id: f.id})).data;
    assert.ok(detail?.schedule_version);
    const args = {
      action: 'save_report_schedule',
      id: f.id,
      schedule_version: detail.schedule_version,
      confirmed: true,
      active: false,
      schedule: {
        name: 'Monthly sales',
        timezone: 'Africa/Cairo',
        schedule_kind: 'monthly',
        day: 31,
        hour: 9,
        minute: 15,
      },
    };
    const query = f.store.document(f.actor.tenantId, 'reporting_query', 'query');
    f.store.putDocument(
      f.actor.tenantId,
      'reporting_query',
      'query',
      {...query, query_config: {...f.config, date_range: {since: '2026-09-01', until: '2026-09-07'}}},
      query.revision,
    );
    assert.equal((await f.call(args)).error.code, 'STALE_REPORT_SCHEDULE');
    detail = (await f.call({action: 'report_schedule', id: f.id})).data;
    const preview = await f.call({
      ...args,
      action: 'preview_report_schedule',
      confirmed: undefined,
      schedule_version: detail.schedule_version,
    });
    assert.equal(preview.success, true, JSON.stringify(preview));
    assert.equal(preview.data.occurrences.length, 3);
    assert.ok(preview.data.changes.some(c => c.field === 'schedule_kind' && c.to === 'monthly'));
    assert.equal(preview.data.active, false);
    assert.equal(f.store.document(f.actor.tenantId, 'reporting_schedule', f.id).revision, 1);
    const saved = await f.call({...args, schedule_version: detail.schedule_version});
    assert.equal(saved.success, true, JSON.stringify(saved));
    assert.equal(saved.data.state, 'paused');
    assert.equal(saved.data.query_revision, 2);
    assert.equal(saved.data.schedule_kind, 'monthly');
    assert.equal(saved.data.schedule.day, 31);
    assert.ok(saved.data.occurrences.every(at => new Date(at).getUTCHours() === 6 || new Date(at).getUTCHours() === 7));
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM jobs').get().n, 0);
    assert.equal(f.store.document(f.actor.tenantId, 'reporting_schedule', f.id).schedule_config.query_id, 'query');
    assert.equal(
      (await f.call({...args, schedule_version: detail.schedule_version})).error.code,
      'STALE_REPORT_SCHEDULE',
    );
  } finally {
    f.store.close();
  }
});

test('schedule mutations require confirmation, an operator, valid calendar fields and current account grants', async () => {
  const f = fixture();
  try {
    const detail = (await f.call({action: 'report_schedule', id: f.id})).data;
    assert.ok(detail?.schedule_version);
    const args = {
      action: 'save_report_schedule',
      id: f.id,
      schedule_version: detail.schedule_version,
      confirmed: true,
      active: true,
      schedule: {name: 'Daily sales', timezone: 'UTC', schedule_kind: 'daily', hour: 9, minute: 0},
    };
    for (const invalid of [
      {confirmed: false},
      {active: 'true'},
      {schedule: {...args.schedule, timezone: ''}},
      {schedule: {...args.schedule, timezone: 'not-a-zone'}},
      {schedule: {...args.schedule, hour: 24}},
      {schedule: {...args.schedule, minute: 0.5}},
      {schedule: {...args.schedule, schedule_kind: 'weekly', weekday: 7}},
      {schedule: {...args.schedule, query_id: 'other'}},
    ])
      assertRefused(await f.call({...args, ...invalid}), [
        'CONFIRMATION_REQUIRED',
        'INVALID_SCHEDULE',
        'INVALID_TIMEZONE',
        'INVALID_ARGUMENT',
      ]);
    assertRefused(await f.call(args, {...f.actor, role: 'reader'}), 'FORBIDDEN');
    assertRefused(await f.call({action: 'report_schedule', id: f.id}, {...f.actor, tenantId: 'other'}), 'NOT_FOUND');
    assert.equal(f.store.document(f.actor.tenantId, 'reporting_schedule', f.id).revision, 1);
    f.store.putConnection({...f.actor, role: 'admin'}, {...f.connection, enabled: false}, {accessToken: 'synthetic'});
    assertRefused(await f.call(args), 'CONNECTION_REQUIRED');
    assert.deepEqual((await f.call({action: 'operations', kind: 'workbook_schedule'})).data.operations, []);
  } finally {
    f.store.close();
  }
});

test('pausing preserves queued work, resuming binds a new creator and a changed query revokes schedule visibility', async () => {
  const f = fixture();
  try {
    const doc = f.store.document(f.actor.tenantId, 'reporting_schedule', f.id);
    f.store.putDocument(
      f.actor.tenantId,
      'reporting_schedule',
      f.id,
      {...doc, next_run_at: Date.now() - 1000},
      doc.revision,
    );
    const worker = new ReportWorker(f.store, async () => ({rows: []}));
    worker.tickSchedules();
    let detail = (await f.call({action: 'report_schedule', id: f.id})).data;
    assert.ok(detail?.last_run?.id);
    assert.ok(detail.updated_at >= Date.now() - 5000);
    const run = detail.last_run.id;
    const args = {
      action: 'save_report_schedule',
      id: f.id,
      confirmed: true,
      schedule: {name: 'Weekly workbook', timezone: 'UTC', schedule_kind: 'weekly', weekday: 1, hour: 9, minute: 0},
    };
    const paused = await f.call({...args, active: false, schedule_version: detail.schedule_version});
    assert.equal(paused.success, true, JSON.stringify(paused));
    assert.equal(f.store.job(f.actor.tenantId, run).state, 'queued');
    const key = f.store.createKey({...f.actor, userId: 'new-operator'}),
      actor = f.store.authenticate(key);
    const resumed = await f.call({...args, active: true, schedule_version: paused.data.schedule_version}, actor);
    assert.equal(resumed.success, true, JSON.stringify(resumed));
    const current = f.store.document(f.actor.tenantId, 'reporting_schedule', f.id);
    assert.equal(
      f.store.restoreJobActor(f.actor.tenantId, 'reporting-schedule:' + f.id, current.actor_binding).userId,
      'new-operator',
    );
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM jobs').get().n, 1);
    f.store.putDocument(f.actor.tenantId, 'reporting_query', 'query', {
      name: 'CANARY',
      query_config: {...f.config, account_id: '200'},
    });
    assertRefused(await f.call({action: 'report_schedule', id: f.id}), 'CONNECTION_REQUIRED');
    assert.deepEqual((await f.call({action: 'operations', kind: 'workbook_schedule'})).data.operations, []);
  } finally {
    f.store.close();
  }
});

test('current schedule access does not expose a last run from a formerly granted account', async () => {
  const f = fixture();
  try {
    const at = Date.now(),
      run = f.store.enqueueReport(f.actor, {query_config: f.config});
    const doc = f.store.document(f.actor.tenantId, 'reporting_schedule', f.id);
    f.store.putDocument(f.actor.tenantId, 'reporting_schedule', f.id, {
      ...doc,
      updated_at: new Date(at - 3600000).toISOString(),
      last_run_at: new Date(at).toISOString(),
      last_run_id: run,
    });
    f.store.putDocument(f.actor.tenantId, 'reporting_query', 'query', {query_config: {...f.config, account_id: '200'}});
    f.store.putConnection(
      {...f.actor, role: 'admin'},
      {...f.connection, accounts: ['200']},
      {accessToken: 'synthetic'},
    );
    const detail = await f.call({action: 'report_schedule', id: f.id});
    assert.equal(detail.success, true, JSON.stringify(detail));
    assert.equal(detail.data.last_run, null);
    assert.equal(detail.data.updated_at, at);
    const feed = await f.call({action: 'operations', kind: 'workbook_schedule'});
    assert.equal(feed.data.operations[0].updated_at, at);
    assert.doesNotMatch(JSON.stringify(detail), new RegExp(run));
  } finally {
    f.store.close();
  }
});

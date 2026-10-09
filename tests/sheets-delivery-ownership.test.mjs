// EXP-03: truthful, owned and decoupled Google Sheets deliveries. Synthetic Google fake and a counting provider
// transport only (no network); jobs run through the real ReportWorker so job states are the ones operators see.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {sheetsGateway} from '../dist/src/google-sheets.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {ReportingOverview, jobRetryAvailable} from '../dist/src/reporting-overview.js';
import {ReportWorker} from '../dist/src/worker.js';
import {operationsPage} from '../dist/src/operations-feed.js';
import {sha256} from '../dist/src/security.js';
import {recordScheduleDelivery} from '../dist/src/scheduled-work.js';
import {readFileSync} from 'node:fs';
import {Script, createContext} from 'node:vm';

/** One owned tab (sheetId 7); every batch is all-or-nothing and the tab remembers which report it holds. */
function fakeGoogle() {
  const tab = {markers: [{metadataKey: 'amcp_destination', metadataValue: 'dest', metadataId: 1}], report: null};
  const plan = [],
    log = {reads: 0, writes: 0, provider: 0};
  let nextId = 10;
  const apply = body => {
    for (const r of body.requests) {
      if (r.createDeveloperMetadata)
        tab.markers.push({...r.createDeveloperMetadata.developerMetadata, metadataId: nextId++});
      if (r.updateDeveloperMetadata) {
        const m = tab.markers.find(
          m => m.metadataId === r.updateDeveloperMetadata.dataFilters[0].developerMetadataLookup.metadataId,
        );
        m.metadataValue = r.updateDeveloperMetadata.developerMetadata.metadataValue;
      }
      if (r.deleteDeveloperMetadata) {
        const key = r.deleteDeveloperMetadata.dataFilter.developerMetadataLookup.metadataKey;
        tab.markers = tab.markers.filter(m => m.metadataKey !== key);
      }
      if (r.updateCells) {
        const header = r.updateCells.rows[0].values.map(v => v.userEnteredValue.stringValue);
        tab.report = r.updateCells.rows[1].values[header.indexOf('Report ID')].userEnteredValue.stringValue;
      }
    }
  };
  const fetcher = async (url, init = {}) => {
    if (new URL(String(url)).hostname !== 'sheets.googleapis.com') {
      log.provider++;
      return new Response('synthetic provider refusal', {status: 500});
    }
    if (init.method === 'POST') {
      log.writes++;
      const body = JSON.parse(init.body),
        mode = plan.shift() ?? 'ok';
      if (mode === '403') return Response.json({error: {code: 403, status: 'PERMISSION_DENIED'}}, {status: 403});
      if (mode === '503') return Response.json({error: {code: 503, status: 'UNAVAILABLE'}}, {status: 503});
      apply(body);
      return Response.json({spreadsheetId: 'sheet123', replies: body.requests.map(() => ({}))});
    }
    log.reads++;
    return Response.json({
      sheets: [
        {
          properties: {sheetId: 7, gridProperties: {rowCount: 100, columnCount: 40}},
          developerMetadata: tab.markers.map(m => ({...m})),
        },
      ],
    });
  };
  return {tab, plan, log, fetcher};
}

function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 63).toString('base64')),
    actor = {tenantId: 't', userId: 'u', role: 'admin'},
    google = fakeGoogle();
  store.putConnection(
    actor,
    {
      id: 'sheets',
      tenantId: 't',
      gateway: sheetsGateway,
      enabled: true,
      accounts: ['sheet123'],
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      label: 'Synthetic',
    },
    {accessToken: 'synthetic'},
  );
  store.putConnection(
    actor,
    {
      id: 'meta',
      tenantId: 't',
      gateway: 'meta_native_action',
      enabled: true,
      accounts: ['123', '456'],
      scopes: ['ads_read'],
      label: 'Synthetic Meta',
    },
    {accessToken: 'synthetic-source'},
  );
  store.putDocument('t', 'sheets_destination', 'dest', {
    connection_id: 'sheets',
    spreadsheet_id: 'sheet123',
    sheet_id: 7,
    tab_name: 'Client A report',
    name: 'Client sheet',
  });
  const service = new MirrorService(new Registry(), store, new NativeTransport(google.fetcher, async () => {})),
    overview = new ReportingOverview(service, google.fetcher),
    worker = new ReportWorker(
      store,
      async () => ({}),
      (t, k, i) => overview.work(t, k, i),
    );
  const sources = account => [{platform: 'meta', account_id: account, connection_id: 'meta'}];
  const report = (id, captured_at, extra = {}) => {
    const account = extra.account ?? '123',
      {account: _, ...fields} = extra;
    const r = {
      state: 'complete',
      captured_at,
      created_at: captured_at,
      completed_at: captured_at + 5,
      config: {
        name: 'Synthetic ' + account,
        client_name: account === '123' ? 'Client A' : 'Client B',
        metrics: ['spend'],
        custom_metrics: [],
        partial_delivery: 'allow_marked',
        sources: sources(account),
      },
      sources: [],
      actor_binding: store.bindJobActor(actor, id),
      rows: [
        {
          platform: 'meta',
          account_id: account,
          campaign_id: '9',
          campaign_name: 'Synthetic',
          currency: 'USD',
          timezone: 'UTC',
          date_from: '2026-09-01',
          date_to: '2026-09-02',
          metrics: {spend: captured_at},
          recommendation: {decision: 'observe', reason: 'Synthetic'},
          complete: true,
          captured_at,
        },
      ],
      ...fields,
    };
    // Each snapshot has its finished collection job, as a collected report does.
    r.job_id = store.enqueue('t', 'report_overview', {report_id: id});
    store.db.prepare("UPDATE jobs SET state='complete' WHERE id=?").run(r.job_id);
    store.putDocument('t', 'overview_report', id, r);
    return store.document('t', 'overview_report', id);
  };
  const schedule = (id = 'sA', extra = {}) => {
    store.putDocument('t', 'overview_schedule', id, {
      is_active: true,
      destination_id: 'dest',
      view_id: 'v' + id,
      definition_version: 1,
      timezone: 'UTC',
      schedule_kind: 'daily',
      schedule_config: {hour: 8},
      next_run_at: Date.now() + 86400000,
      config: {name: 'Client A weekly', client_name: 'Client A', sources: sources('123')},
      ...extra,
    });
    return store.document('t', 'overview_schedule', id);
  };
  const call = input => overview.handle({confirmed: true, ...input}, actor);
  const jobs = kind => store.db.prepare('SELECT id,state,error FROM jobs WHERE kind=? ORDER BY created_at').all(kind);
  const scheduleState = () =>
    operationsPage(store, actor, {kind: 'schedule'}, true).operations.find(o => o.id === 'sA')?.state;
  const now = () => store.db.prepare('UPDATE jobs SET available_at=0').run();
  // Re-enters a snapshot's collection job (a retry or a lost lease) without the website retry action.
  const requeue = id => {
    const job = store.document('t', 'overview_report', id).job_id;
    store.db.prepare("UPDATE jobs SET state='queued',available_at=0 WHERE id=?").run(job);
    return job;
  };
  return {store, actor, google, overview, worker, report, schedule, call, jobs, scheduleState, now, requeue};
}

test('EXP-03 A: an older snapshot exported over a newer one is reported Superseded, not Complete', async () => {
  const f = fixture();
  try {
    f.report('rB', 200);
    f.report('rA', 100);
    await f.call({action: 'export', report_id: 'rB', destination_id: 'dest'});
    await f.worker.once();
    assert.equal(f.google.tab.report, 'rB');
    const older = await f.call({action: 'export', report_id: 'rA', destination_id: 'dest'});
    await f.worker.once();
    assert.equal(f.google.log.writes, 1, 'nothing was written for the older snapshot');
    const status = await f.call({action: 'export_status', id: older.id});
    // `state` keeps the job state for existing MCP clients; `outcome` tells what happened at the destination.
    assert.equal(status.state, 'complete');
    assert.equal(status.outcome, 'superseded');
    assert.equal(status.url, undefined);
    assert.equal(status.newer_report_id, 'rB');
    assert.equal(status.newer_captured_at, 200);
    const history = (await f.call({action: 'get', id: 'rA'})).exports;
    assert.deepEqual(
      history.map(e => [e.state, e.outcome, e.url ?? null]),
      [['complete', 'superseded', null]],
    );
    // The bootstrap names the capture time of the snapshot the tab holds, for the dialog warning.
    const destination = (await f.call({action: 'bootstrap'})).destinations.find(d => d.id === 'dest');
    assert.equal(destination.last_captured_at, 200);
    assert.equal(destination.last_report_id, 'rB');
    // Operations does not count a superseded export as active work.
    const exported = operationsPage(f.store, f.actor, {kind: 'export'}, true).operations.find(o => o.id === older.id);
    assert.deepEqual([exported.state, exported.category], ['superseded', 'complete']);
  } finally {
    f.store.close();
  }
});

test('EXP-03 B: a manual export cannot replace another report’s scheduled tab; the owner’s own snapshot can', async () => {
  const f = fixture();
  try {
    f.schedule();
    f.report('rB', 300, {account: '456'});
    await assert.rejects(
      () => f.call({action: 'export', report_id: 'rB', destination_id: 'dest'}),
      e =>
        e.code === 'DESTINATION_OWNED_BY_OTHER_REPORT' &&
        e.status === 409 &&
        e.details.owner_name === 'Client A weekly' &&
        e.details.owner_client_name === 'Client A',
    );
    assert.equal(f.jobs('sheets_export').length, 0, 'no job was created');
    assert.deepEqual([f.google.log.reads, f.google.log.writes], [0, 0]);
    // The owner's ad-hoc snapshot (same accounts, no schedule) may use the tab.
    f.report('rA', 200);
    await f.call({action: 'export', report_id: 'rA', destination_id: 'dest'});
    await f.worker.once();
    assert.equal(f.google.tab.report, 'rA');
    const owners = (await f.call({action: 'bootstrap'})).destinations.find(d => d.id === 'dest').owners;
    assert.deepEqual(
      owners.map(o => [o.kind, o.schedule_id, o.view_id, o.name, o.client_name, o.accounts]),
      [['schedule', 'sA', 'vsA', 'Client A weekly', 'Client A', ['meta:123']]],
    );
    // A paused schedule leaves its saved report as the owner.
    f.store.putDocument('t', 'overview_schedule', 'sA', {
      ...f.store.document('t', 'overview_schedule', 'sA'),
      is_active: false,
    });
    f.store.putDocument('t', 'overview_view', 'vsA', {
      config: {name: 'Client A weekly', sources: [{platform: 'meta', account_id: '123', connection_id: 'meta'}]},
      destination_id: 'dest',
      schedule_id: 'sA',
    });
    await assert.rejects(() => f.call({action: 'export', report_id: 'rB', destination_id: 'dest'}), {
      code: 'DESTINATION_OWNED_BY_OTHER_REPORT',
    });
    // A tab claimed after an export was queued is protected when the job runs.
    f.store.db.prepare("DELETE FROM documents WHERE kind IN ('overview_view','overview_schedule')").run();
    const queued = await f.call({action: 'export', report_id: 'rB', destination_id: 'dest'});
    f.schedule();
    await f.worker.once();
    const job = f.store.job('t', queued.job_id);
    assert.equal(job.state, 'failed');
    assert.equal(job.error.code, 'DESTINATION_OWNED_BY_OTHER_REPORT');
    assert.equal(jobRetryAvailable(job), false);
    assert.equal(f.google.tab.report, 'rA', 'the owned tab is unchanged');
    assert.equal(f.google.log.writes, 1);
  } finally {
    f.store.close();
  }
});

test('EXP-03 B: the ownership rollback switch restores unrestricted manual exports', async () => {
  const f = fixture();
  process.env.AMCP_SHEETS_DESTINATION_OWNERSHIP = 'off';
  try {
    f.schedule();
    f.report('rB', 300, {account: '456'});
    const queued = await f.call({action: 'export', report_id: 'rB', destination_id: 'dest'});
    assert.equal(queued.state, 'queued');
    assert.deepEqual((await f.call({action: 'bootstrap'})).destinations[0].owners, []);
  } finally {
    delete process.env.AMCP_SHEETS_DESTINATION_OWNERSHIP;
    f.store.close();
  }
});

test('EXP-03 C: complete-only is enforced before any job and scheduled partial runs are skipped, not failed', async () => {
  const f = fixture();
  try {
    f.report('rP', 100, {state: 'partial'});
    f.store.putDocument('t', 'overview_report', 'rP', {
      ...f.store.document('t', 'overview_report', 'rP'),
      config: {...f.store.document('t', 'overview_report', 'rP').config, partial_delivery: 'complete_only'},
    });
    await assert.rejects(
      () => f.call({action: 'export', report_id: 'rP', destination_id: 'dest'}),
      e => e.code === 'PARTIAL_DELIVERY_BLOCKED' && e.status === 409,
    );
    assert.equal(f.jobs('sheets_export').length, 0);
    // A scheduled partial run records a skipped delivery and its collection job completes.
    const s = f.schedule();
    f.report('rS', 200, {
      state: 'partial',
      schedule_id: 'sA',
      schedule_version: s.definition_version,
      destination_id: 'dest',
    });
    f.store.putDocument('t', 'overview_report', 'rS', {
      ...f.store.document('t', 'overview_report', 'rS'),
      config: {...f.store.document('t', 'overview_report', 'rS').config, partial_delivery: 'complete_only'},
    });
    const job = f.requeue('rS');
    await f.worker.once();
    assert.equal(f.store.job('t', job).state, 'complete');
    const r = f.store.document('t', 'overview_report', 'rS');
    assert.deepEqual([r.export.state, r.export.reason], ['skipped', 'PARTIAL_DELIVERY_BLOCKED']);
    assert.equal(f.jobs('sheets_export').length, 0);
    assert.equal(f.store.document('t', 'overview_schedule', 'sA').last_delivery.state, 'skipped');
    assert.equal(f.google.log.provider, 0);
    // A deterministic failure offers no Retry and the server refuses one; a permission failure can be retried.
    const blocked = f.store.enqueue('t', 'sheets_export', {report_id: 'rP', export_id: 'x'});
    f.store.db
      .prepare("UPDATE jobs SET state='failed',error=? WHERE id=?")
      .run(JSON.stringify({code: 'PARTIAL_DELIVERY_BLOCKED', message: 'Synthetic.'}), blocked);
    assert.equal(jobRetryAvailable(f.store.job('t', blocked)), false);
    await assert.rejects(() => f.call({action: 'retry', id: blocked}), {code: 'JOB_NOT_RETRYABLE'});
    assert.equal(jobRetryAvailable({state: 'failed', error: {code: 'SHEETS_PERMISSION_DENIED'}}), true);
    assert.equal(jobRetryAvailable({state: 'cancelled'}), true);
  } finally {
    f.store.close();
  }
});

test('EXP-03 D/E: a delivery failure leaves the snapshot complete, its retry never recollects or re-stamps it', async () => {
  const f = fixture();
  try {
    const s = f.schedule();
    const before = f.report('rS', 100, {
      schedule_id: 'sA',
      schedule_version: s.definition_version,
      destination_id: 'dest',
    });
    // A legacy run whose inline Sheets write failed the whole collection job.
    const job = f.store.document('t', 'overview_report', 'rS').job_id;
    f.store.db
      .prepare("UPDATE jobs SET state='failed',error=? WHERE id=?")
      .run(JSON.stringify({code: 'SHEETS_PERMISSION_DENIED', message: 'Synthetic legacy failure.'}), job);
    const view = await f.call({action: 'get', id: 'rS'});
    assert.equal(view.job.retry_available, true);
    await f.call({action: 'retry', id: job});
    assert.equal(
      f.store.document('t', 'overview_report', 'rS').state,
      'complete',
      'a finished snapshot stays finished',
    );
    await f.worker.once();
    let r = f.store.document('t', 'overview_report', 'rS');
    assert.equal(f.store.job('t', job).state, 'complete');
    assert.equal(f.google.log.provider, 0, 'the retry re-requested no provider source');
    assert.equal(r.completed_at, before.completed_at);
    assert.equal(sha256(JSON.stringify(r.rows)), sha256(JSON.stringify(before.rows)));
    assert.equal(r.export.state, 'queued');
    const exportId = r.export.id;
    assert.equal(f.store.document('t', 'overview_export', exportId).origin, 'schedule');
    // The delivery is its own job: a 403 fails the export, not the snapshot, and the schedule needs attention.
    f.google.plan.push('403');
    await f.worker.once();
    r = f.store.document('t', 'overview_report', 'rS');
    assert.equal(r.state, 'complete');
    assert.equal(r.completed_at, before.completed_at);
    let status = await f.call({action: 'export_status', id: exportId});
    assert.deepEqual([status.state, status.outcome, status.retry_available], ['failed', 'failed', true]);
    let schedule = f.store.document('t', 'overview_schedule', 'sA');
    assert.deepEqual(
      [schedule.is_active, schedule.last_delivery.state, schedule.last_delivery.error_code],
      [true, 'failed', 'SHEETS_PERMISSION_DENIED'],
    );
    assert.equal(schedule.consecutive_delivery_failures, 1);
    assert.equal(f.scheduleState(), 'attention');
    // Retry delivers the same snapshot; the schedule is healthy again and the snapshot was never re-stamped.
    await f.call({action: 'retry', id: status.job.id});
    await f.worker.once();
    status = await f.call({action: 'export_status', id: exportId});
    assert.deepEqual([status.state, status.outcome], ['complete', 'complete']);
    assert.equal(f.google.tab.report, 'rS');
    schedule = f.store.document('t', 'overview_schedule', 'sA');
    assert.deepEqual([schedule.last_delivery.state, schedule.consecutive_delivery_failures], ['complete', 0]);
    assert.equal(f.scheduleState(), 'active');
    assert.equal(f.store.document('t', 'overview_report', 'rS').completed_at, before.completed_at);
  } finally {
    f.store.close();
  }
});

test('EXP-03 E: a Sheets 5xx marks the schedule for attention and success clears it', async () => {
  const f = fixture();
  try {
    const s = f.schedule();
    f.report('rS', 100, {schedule_id: 'sA', schedule_version: s.definition_version, destination_id: 'dest'});
    f.requeue('rS');
    await f.worker.once();
    f.google.plan.push('503');
    await f.worker.once();
    const delivery = f.store.document('t', 'overview_schedule', 'sA');
    assert.equal(delivery.last_delivery.state, 'retrying');
    assert.equal(delivery.consecutive_delivery_failures, 0, 'a retryable failure is not a blocking failure');
    assert.equal(f.scheduleState(), 'attention');
    f.now();
    await f.worker.once();
    assert.equal(f.store.document('t', 'overview_schedule', 'sA').last_delivery.state, 'complete');
    assert.equal(f.scheduleState(), 'active');
  } finally {
    f.store.close();
  }
});

test('EXP-03 E: N consecutive blocking delivery failures pause only the revision that produced them', async () => {
  const f = fixture();
  process.env.AMCP_SCHEDULE_DELIVERY_PAUSE_AFTER = '2';
  try {
    const s = f.schedule();
    const deliver = async (id, captured, version = s.definition_version) => {
      f.report(id, captured, {schedule_id: 'sA', schedule_version: version, destination_id: 'dest'});
      f.requeue(id);
      await f.worker.once();
      f.google.plan.push('403');
      await f.worker.once();
    };
    await deliver('r1', 100);
    assert.equal(f.store.document('t', 'overview_schedule', 'sA').is_active, true);
    // An older revision's failure never changes (or pauses) the current schedule revision.
    const current = f.store.document('t', 'overview_schedule', 'sA');
    f.store.putDocument('t', 'overview_schedule', 'sA', {...current, definition_version: 2});
    for (let i = 0; i < 3; i++)
      assert.equal(
        recordScheduleDelivery(
          f.store,
          't',
          {id: 'rOld', schedule_id: 'sA', schedule_version: 1, captured_at: 150},
          {state: 'failed', blocking: true, error_code: 'SHEETS_PERMISSION_DENIED'},
        ),
        false,
      );
    // An earlier occurrence's outcome never replaces a later one's.
    assert.equal(
      recordScheduleDelivery(
        f.store,
        't',
        {id: 'rEarly', schedule_id: 'sA', schedule_version: 2, captured_at: 50},
        {state: 'complete'},
      ),
      false,
    );
    let schedule = f.store.document('t', 'overview_schedule', 'sA');
    assert.deepEqual([schedule.is_active, schedule.consecutive_delivery_failures], [true, 1]);
    assert.equal(schedule.last_delivery.report_id, 'r1');
    await deliver('r2', 200, 2);
    schedule = f.store.document('t', 'overview_schedule', 'sA');
    assert.equal(schedule.is_active, false);
    assert.equal(schedule.consecutive_delivery_failures, 2);
    assert.deepEqual(
      [schedule.error.code, schedule.error.reason, schedule.error.delivery_error_code],
      ['SCHEDULE_DELIVERY_FAILED', 'delivery', 'SHEETS_PERMISSION_DENIED'],
    );
    assert.equal(f.scheduleState(), 'failed');
  } finally {
    delete process.env.AMCP_SCHEDULE_DELIVERY_PAUSE_AFTER;
    f.store.close();
  }
});

test('EXP-03 D: the inline rollback switch writes scheduled Sheets inside the collection job again', async () => {
  const f = fixture();
  process.env.AMCP_SCHEDULED_SHEETS_DELIVERY = 'inline';
  try {
    const s = f.schedule();
    f.report('rS', 100, {schedule_id: 'sA', schedule_version: s.definition_version, destination_id: 'dest'});
    f.requeue('rS');
    await f.worker.once();
    const r = f.store.document('t', 'overview_report', 'rS');
    assert.equal(r.export.state, 'complete');
    assert.equal(f.google.tab.report, 'rS');
    assert.equal(f.jobs('sheets_export').length, 0);
    assert.equal(f.store.document('t', 'overview_schedule', 'sA').last_delivery.state, 'complete');
  } finally {
    delete process.env.AMCP_SCHEDULED_SHEETS_DELIVERY;
    f.store.close();
  }
});

test('EXP-03 website: Superseded history, Retry only for retryable failures, locked tabs and delivery health (EN/AR)', () => {
  const esc = v =>
    String(v ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  const context = createContext({
    esc,
    Intl,
    URLSearchParams,
    date: v => 'at-' + v,
    session: {workspaceRole: 'operator'},
    document: {querySelector: () => null, addEventListener() {}},
    location: {pathname: '/'},
  });
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  new Script(readFileSync('web/reporting-overview.js', 'utf8')).runInContext(context);
  new Script(readFileSync('web/report-delivery.js', 'utf8')).runInContext(context);
  new Script('overviewState.destinationId = ""').runInContext(context);
  const run = (code, values) => new Script(code).runInContext(Object.assign(context, values));
  const history = exports => run('renderExportHistory(r)', {r: {exports}});
  let html = history([
    {id: 'e1', job_id: 'j1', state: 'complete', outcome: 'superseded', newer_captured_at: 200, retry_available: false},
  ]);
  assert.match(html, /<strong>Superseded<\/strong>/);
  assert.match(html, /Not written — this tab already holds a newer snapshot \(captured at-200\)/);
  assert.doesNotMatch(html, /Open sheet|data-export-retry/);
  html = history([{id: 'e2', job_id: 'j2', state: 'failed', error: {message: 'Blocked'}, retry_available: false}]);
  assert.doesNotMatch(html, /data-export-retry/);
  html = history([{id: 'e3', job_id: 'j3', state: 'failed', error: {message: 'Denied'}, retry_available: true}]);
  assert.match(html, /data-export-retry="j3"/);
  // Grouped destinations: a tab owned by another client's report is listed, named and locked.
  const destinations = [
    {id: 'own', name: 'Sheet', tab_name: 'Client A', owners: [{schedule_id: 's1', accounts: ['meta:123']}]},
    {id: 'free', name: 'Sheet', tab_name: 'Spare', owners: []},
    {
      id: 'other',
      name: 'Sheet',
      tab_name: 'Client B',
      owners: [{schedule_id: 's2', name: 'Client B weekly', client_name: 'Client B', accounts: ['meta:456']}],
    },
  ];
  const snapshot = {config: {sources: [{platform: 'meta', account_id: 'act_123'}]}, schedule_id: null};
  const options = run('reportDestinationOptions(d, s).html', {d: destinations, s: snapshot});
  const [mine, locked] = options.split('<optgroup').slice(1);
  assert.match(mine, /Tabs for this report/);
  assert.match(mine, /value="own"/);
  assert.match(mine, /value="free"/);
  assert.match(locked, /Other reports’ tabs \(locked\)/);
  assert.match(locked, /<option value="other"[^>]*disabled[^>]*>.*Client: Client B · Report: Client B weekly/);
  // The owning schedule's own snapshot may use its tab even after its accounts changed.
  assert.doesNotMatch(
    run('reportDestinationOptions(d, s).html', {d: destinations, s: {...snapshot, schedule_id: 's2'}}),
    /disabled/,
  );
  // Without a snapshot (schedule setup) every destination is a plain choice.
  assert.doesNotMatch(run('reportDestinationOptions(d, null).html', {d: destinations}), /optgroup|disabled/);
  const health = s => run('scheduleDeliveryHealth(s, false)', {s});
  html = health({
    consecutive_delivery_failures: 2,
    last_delivery: {
      state: 'failed',
      at: 5,
      error_code: 'SHEETS_PERMISSION_DENIED',
      job_id: 'j9',
      retry_available: true,
    },
  });
  assert.match(html, /Last delivery: Failed · at-5 · SHEETS_PERMISSION_DENIED · 2 failed in a row/);
  assert.match(html, /data-schedule-delivery-retry="j9"/);
  assert.doesNotMatch(health({last_delivery: {state: 'complete', at: 5}}), /data-schedule-delivery-retry/);
  // The same surfaces in Arabic.
  const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
  run('uiMessages = new Map(Object.entries(catalog))', {catalog});
  html = history([{id: 'e1', job_id: 'j1', state: 'complete', outcome: 'superseded', newer_captured_at: 200}]);
  assert.ok(html.includes(esc(catalog['Superseded'])));
  assert.ok(
    html.includes(
      esc(
        catalog['Not written — this tab already holds a newer snapshot (captured {date}).'].replace('{date}', 'at-200'),
      ),
    ),
  );
  const arabicOptions = run('reportDestinationOptions(d, s).html', {d: destinations, s: snapshot});
  for (const message of ['Tabs for this report', 'Other reports’ tabs (locked)'])
    assert.ok(arabicOptions.includes(esc(catalog[message])), message);
  assert.ok(
    health({last_delivery: {state: 'failed', at: 5, job_id: 'j9', retry_available: true}}).includes(
      esc(catalog['Retry delivery']),
    ),
  );
});

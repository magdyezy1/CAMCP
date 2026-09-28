import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {ReportingOverview} from '../src/reporting-overview.js';
import {nextSchedule, resolveReportConfig} from '../src/reporting.js';
import {ReportWorker} from '../src/worker.js';
import {sheetsGateway} from '../src/google-sheets.js';
import type {Actor, JsonObject} from '../src/types.js';
import {sha256} from '../src/security.js';

const actor: Actor = {tenantId: 'report-library', userId: 'owner', role: 'admin'};
const base = {
  name: 'Client A weekly',
  client_name: 'Client A',
  sources: [{platform: 'meta', connection_id: 'meta', account_id: '100'}],
  date_range: {preset: 'last_complete_days', days: 7, timezone: 'UTC'},
  metrics: ['spend', 'clicks', 'cpc'],
  custom_metrics: [],
  targets: {},
  objectives: [],
};
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 64).toString('base64'));
  store.putConnection(
    actor,
    {
      id: 'meta',
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['100', '200'],
      enabled: true,
      label: 'Fixture Meta',
      scopes: ['ads_read'],
    },
    {accessToken: 'synthetic'},
  );
  store.putConnection(
    actor,
    {
      id: 'sheets',
      tenantId: actor.tenantId,
      gateway: sheetsGateway,
      accounts: ['sheetA', 'sheetB'],
      enabled: true,
      label: 'Fixture Sheets',
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    },
    {accessToken: 'synthetic'},
  );
  for (const id of ['A', 'B'])
    store.putDocument(actor.tenantId, 'sheets_destination', 'dest' + id, {
      spreadsheet_id: 'sheet' + id,
      connection_id: 'sheets',
      tab_name: id,
    });
  const service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(async () => {
        throw Error('Unexpected live request');
      }),
    ),
    overview = new ReportingOverview(service),
    worker = new ReportWorker(
      store,
      async () => ({}),
      (t, k, i) => overview.work(t, k, i),
    );
  return {
    store,
    overview,
    worker,
    call: (input: JsonObject, a = actor) => overview.handle({confirmed: true, ...input}, a),
  };
}

test('editing an existing client report retains its identity and rejects lost updates', async () => {
  const f = fixture();
  try {
    const saved = await f.call({action: 'save', config: base});
    assert.equal(saved.config.client_name, 'Client A');
    const edited = await f.call({
      action: 'save',
      id: saved.id,
      expected_revision: saved.revision,
      config: {...base, name: 'Client A monthly'},
    });
    assert.equal(edited.id, saved.id);
    assert.equal(f.store.documents(actor.tenantId, 'overview_view').length, 1);
    await assert.rejects(
      () => f.call({action: 'save', id: saved.id, expected_revision: saved.revision, config: base}),
      {code: 'REVISION_CONFLICT'},
    );
  } finally {
    f.store.close();
  }
});

test('reusable templates carry metrics and calendar choices without client accounts or spreadsheet destinations', async () => {
  const f = fixture();
  try {
    const template = await f.call({action: 'save_template', config: base});
    assert.equal(template.config.sources.length, 0);
    assert.equal(template.config.client_name, '');
    assert.equal(template.destination_id, undefined);
    const bootstrap = await f.call({action: 'bootstrap'});
    assert.equal(bootstrap.templates.length, 1);
    await assert.rejects(() => f.call({action: 'save_template', config: base}, {...actor, role: 'reader'}), {
      code: 'FORBIDDEN',
    });
  } finally {
    f.store.close();
  }
});

test('monthly schedules clamp month-end days and rolling calendar months handle leap years', () => {
  assert.equal(
    nextSchedule(
      {schedule_kind: 'monthly', timezone: 'UTC', schedule_config: {day: 31, hour: 8}},
      Date.parse('2024-02-01T00:00:00Z'),
    ),
    Date.parse('2024-02-29T08:00:00Z'),
  );
  assert.deepEqual(
    resolveReportConfig(
      {date_range: {preset: 'last_complete_month', timezone: 'America/New_York'}},
      Date.parse('2024-03-01T06:00:00Z'),
    ).date_range,
    {since: '2024-02-01', until: '2024-02-29'},
  );
});

test('saved report deletion removes its future schedule without touching another client', async () => {
  const f = fixture();
  try {
    const a = await f.call({
        action: 'schedule',
        config: base,
        schedule: {schedule_kind: 'daily', timezone: 'UTC', destination_id: 'destA'},
      }),
      b = await f.call({
        action: 'save',
        config: {...base, name: 'Client B', sources: [{platform: 'meta', connection_id: 'meta', account_id: '200'}]},
      });
    const view = f.store.document(actor.tenantId, 'overview_view', a.view_id);
    await f.call({action: 'delete_view', id: view.id, expected_revision: view.revision});
    assert.throws(() => f.store.document(actor.tenantId, 'overview_view', view.id), {code: 'NOT_FOUND'});
    assert.throws(() => f.store.document(actor.tenantId, 'overview_schedule', a.id), {code: 'NOT_FOUND'});
    assert.equal(f.store.document(actor.tenantId, 'overview_view', b.id).config.name, 'Client B');
  } finally {
    f.store.close();
  }
});

test('templates retain unbound native defaults, support revisioned edit/delete, and never copy account targets', async () => {
  const f = fixture();
  try {
    const config = {
      ...base,
      sources: [{...base.sources[0], objective: 'traffic', native_metrics: ['outbound_clicks']}],
      targets: {
        'meta:100:123': {kpi: 'cpc', target: 2, currency: 'USD'},
        traffic: {kpi: 'cpc', target: 3, currency: 'USD'},
      },
    };
    const t = await f.call({action: 'save_template', config, destination_id: 'destA'});
    assert.deepEqual(t.config.source_defaults, {meta: {objective: 'traffic', native_metrics: ['outbound_clicks']}});
    assert.equal(t.config.targets['meta:100:123'], undefined);
    assert.equal(t.config.targets.traffic.target, 3);
    assert.equal(t.schedule_id, undefined);
    const changed = await f.call({
      action: 'save_template',
      id: t.id,
      expected_revision: t.revision,
      config: {...t.config, name: 'Reusable traffic'},
    });
    await assert.rejects(() => f.call({action: 'delete_template', id: t.id, expected_revision: t.revision}), {
      code: 'REVISION_CONFLICT',
    });
    await f.call({action: 'delete_template', id: t.id, expected_revision: changed.revision});
    assert.equal(f.store.documents(actor.tenantId, 'overview_template').length, 0);
    await assert.rejects(
      () => f.call({action: 'save_template', config: {...base, source_defaults: {meta: {account_id: '100'}}}}),
      {code: 'INVALID_REPORT_SOURCE'},
    );
  } finally {
    f.store.close();
  }
});

test('editing a report and its schedule preserves identity, cancels old pending runs and protects another destination', async () => {
  const f = fixture();
  try {
    const a = await f.call({action: 'save', config: base}),
      b = await f.call({
        action: 'schedule',
        config: {
          ...base,
          name: 'Client B',
          client_name: 'Client B',
          sources: [{platform: 'meta', connection_id: 'meta', account_id: '200'}],
        },
        schedule: {schedule_kind: 'weekly', schedule_config: {weekday: 1}, timezone: 'UTC', destination_id: 'destB'},
      });
    const schedule = await f.call({
      action: 'schedule',
      view_id: a.id,
      expected_revision: a.revision,
      schedule: {schedule_kind: 'daily', timezone: 'UTC', destination_id: 'destA'},
    });
    let view = f.store.document(actor.tenantId, 'overview_view', a.id),
      s = f.store.document(actor.tenantId, 'overview_schedule', schedule.id);
    const run = f.overview.queue(actor, s.config, s.destination_id, s.id);
    await assert.rejects(
      () => f.call({action: 'save', id: a.id, expected_revision: view.revision, config: base, destination_id: 'destB'}),
      {code: 'DESTINATION_IN_USE'},
    );
    assert.equal(f.store.job(actor.tenantId, run.job_id).state, 'queued');
    const edited = await f.call({
      action: 'save',
      id: a.id,
      expected_revision: view.revision,
      config: {
        ...base,
        name: 'A monthly',
        grain: 'daily',
        date_range: {preset: 'last_complete_month', timezone: 'Asia/Riyadh'},
      },
    });
    assert.equal(edited.id, a.id);
    assert.equal(edited.schedule_id, s.id);
    assert.equal(f.store.job(actor.tenantId, run.job_id).state, 'cancelled');
    s = f.store.document(actor.tenantId, 'overview_schedule', s.id);
    assert.equal(s.config.grain, 'daily');
    assert.equal(s.config.name, 'A monthly');
    assert.equal(f.store.document(actor.tenantId, 'overview_schedule', b.id).config.name, 'Client B');
    await assert.rejects(
      () =>
        f.call({
          action: 'update_schedule',
          id: s.id,
          expected_revision: s.revision,
          expected_view_revision: view.revision,
          config: base,
          schedule: {schedule_kind: 'monthly', schedule_config: {day: 31}, timezone: 'UTC', destination_id: 'destA'},
        }),
      {code: 'REVISION_CONFLICT'},
    );
    const updated = await f.call({
      action: 'update_schedule',
      id: s.id,
      expected_revision: s.revision,
      expected_view_revision: edited.revision,
      config: edited.config,
      schedule: {schedule_kind: 'monthly', schedule_config: {day: 31}, timezone: 'UTC', destination_id: 'destA'},
    });
    assert.equal(updated.id, s.id);
    assert.equal(updated.view_id, a.id);
    assert.equal(f.store.documents(actor.tenantId, 'overview_view').length, 2);
    assert.equal(f.store.documents(actor.tenantId, 'overview_schedule').length, 2);
  } finally {
    f.store.close();
  }
});

test('schedule deletion is distinct from legacy pause, and retries cannot recreate a deleted schedule', async () => {
  const f = fixture();
  try {
    const input = {
        action: 'schedule',
        idempotency_key: 'stable-key-12345',
        config: base,
        schedule: {schedule_kind: 'daily', timezone: 'UTC', destination_id: 'destA'},
      },
      s = await f.call(input);
    assert.equal((await f.call(input)).id, s.id);
    await f.call({action: 'delete_schedule', id: s.id});
    assert.equal(f.store.document(actor.tenantId, 'overview_schedule', s.id).is_active, false);
    await f.call({action: 'resume_schedule', id: s.id});
    let current = f.store.document(actor.tenantId, 'overview_schedule', s.id);
    assert.equal(current.is_active, true);
    await assert.rejects(() => f.call({action: 'remove_schedule', id: s.id, expected_revision: s.revision}), {
      code: 'REVISION_CONFLICT',
    });
    await f.call({action: 'remove_schedule', id: s.id, expected_revision: current.revision});
    assert.equal(f.store.document(actor.tenantId, 'overview_view', s.view_id).schedule_id, undefined);
    await assert.rejects(() => f.call(input), {code: 'SCHEDULE_DELETED'});
  } finally {
    f.store.close();
  }
});

test('pre-upgrade schedule keys retain exact retry compatibility with default total grouping', async () => {
  const f = fixture();
  try {
    const input = {
        action: 'schedule',
        idempotency_key: 'legacy-key-12345',
        config: {...base, client_name: ''},
        schedule: {schedule_kind: 'daily', schedule_config: {hour: 8}, timezone: 'UTC', destination_id: 'destA'},
      },
      normalized = f.overview.config(input.config, actor),
      {client_name, grain, source_defaults, ...config} = normalized;
    const id = sha256('schedule:' + input.idempotency_key),
      settings = {name: config.name, config, ...input.schedule},
      fingerprint = sha256(JSON.stringify(settings));
    f.store.putDocument(actor.tenantId, 'overview_schedule', id, {
      ...settings,
      request_fingerprint: fingerprint,
      is_active: true,
      view_id: id,
      next_run_at: Date.now() + 10000,
    });
    f.store.putDocument(actor.tenantId, 'overview_view', id, {config, destination_id: 'destA', schedule_id: id});
    assert.equal((await f.call(input)).id, id);
    await assert.rejects(() => f.call({...input, config: {...input.config, grain: 'daily'}}), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
  } finally {
    f.store.close();
  }
});

test('deleting a definition while a worker is collecting revokes its lease and prevents old delivery', async () => {
  const f = fixture();
  let release!: () => void, started!: () => void;
  const arrived = new Promise<void>(r => (started = r)),
    gate = new Promise<void>(r => (release = r));
  try {
    let deliveries = 0;
    f.overview.native.collect = async () => {
      started();
      await gate;
      return {rows: [], complete: true};
    };
    f.overview.sheets.write = async () => {
      deliveries++;
      return {state: 'complete', rows: 0, url: 'https://docs.google.com/fixture'};
    };
    const s = await f.call({
        action: 'schedule',
        config: base,
        schedule: {schedule_kind: 'daily', timezone: 'UTC', destination_id: 'destA'},
      }),
      schedule = f.store.document(actor.tenantId, 'overview_schedule', s.id),
      run = f.overview.queue(actor, schedule.config, schedule.destination_id, schedule.id),
      work = f.worker.once();
    await arrived;
    const view = f.store.document(actor.tenantId, 'overview_view', s.view_id);
    await f.call({action: 'delete_view', id: view.id, expected_revision: view.revision});
    release();
    await work;
    assert.equal(f.store.job(actor.tenantId, run.job_id).state, 'cancelled');
    assert.equal(f.store.document(actor.tenantId, 'overview_report', run.id).state, 'cancelled');
    assert.equal(deliveries, 0);
  } finally {
    release?.();
    f.store.close();
  }
});

test('snapshot deletion cannot be resurrected by an in-flight worker and is tenant/role scoped', async () => {
  const f = fixture();
  let release!: () => void, started!: () => void;
  const arrived = new Promise<void>(r => (started = r)),
    gate = new Promise<void>(r => (release = r));
  try {
    f.overview.native.collect = async () => {
      started();
      await gate;
      return {rows: [], complete: true};
    };
    const run = await f.call({action: 'run', config: base});
    const work = f.worker.once();
    await arrived;
    await assert.rejects(() => f.call({action: 'delete_report', id: run.id}, {...actor, tenantId: 'foreign'}), {
      code: 'NOT_FOUND',
    });
    await assert.rejects(() => f.call({action: 'delete_report', id: run.id}, {...actor, role: 'reader'}), {
      code: 'FORBIDDEN',
    });
    await f.call({action: 'delete_report', id: run.id});
    release();
    await work;
    assert.throws(() => f.store.document(actor.tenantId, 'overview_report', run.id), {code: 'NOT_FOUND'});
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM jobs WHERE id=?').get(run.job_id)!.n, 0);
  } finally {
    release?.();
    f.store.close();
  }
});

test('MCP exposes report-library actions and rejects stale edits through the executable tool schema', async () => {
  const f = fixture();
  try {
    const saved = await f.overview.service.call(
      'amcp_reporting_overview',
      {action: 'save_template', config: base, confirmed: true},
      actor,
    );
    assert.equal(saved.success, true);
    if (!saved.success) return;
    const data = saved.data as JsonObject;
    const invalid = await f.overview.service.call(
      'amcp_reporting_overview',
      {action: 'save_template', id: data.id, expected_revision: 0, config: base, confirmed: true},
      actor,
    );
    assert.equal(invalid.success, false);
    const result = await f.overview.service.call(
      'amcp_reporting_overview',
      {action: 'delete_template', id: data.id, expected_revision: data.revision, confirmed: true},
      actor,
    );
    assert.equal(result.success, true);
    assert.equal(f.store.documents(actor.tenantId, 'overview_template').length, 0);
  } finally {
    f.store.close();
  }
});

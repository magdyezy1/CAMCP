import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {ReportingOverview} from '../src/reporting-overview.js';
import {ReportWorker} from '../src/worker.js';
import {
  metricNumber,
  parseMetricFormula,
  evaluateMetric,
  validateCustomMetrics,
  calculateMetrics,
  campaignRecommendation,
} from '../src/report-metrics.js';
import {normalizeNativeRow, reportRange} from '../src/report-native.js';
import {GoogleSheetsExports, sheetsGateway, exportCsv} from '../src/google-sheets.js';
import type {Actor, Connection, JsonObject} from '../src/types.js';
const actor: Actor = {tenantId: 'report-test', userId: 'owner', role: 'admin'},
  json = (d: unknown, status = 200) =>
    new Response(JSON.stringify(d), {status, headers: {'Content-Type': 'application/json'}}),
  config = {
    name: 'Campaign performance',
    sources: [{platform: 'meta', connection_id: 'meta-connection', account_id: '100', objective: 'sales'}],
    date_range: {since: '2026-08-01', until: '2026-08-07'},
    metrics: ['spend', 'impressions', 'conversions', 'cpa'],
    targets: {sales: {target: 15, currency: 'USD', minimum_results: 10}},
    custom_metrics: [{id: 'profit', label: 'Profit', formula: 'conversion_value - spend', format: 'currency'}],
  };
function setup(fetcher?: typeof fetch) {
  const store = new Store(':memory:', Buffer.alloc(32, 47).toString('base64'));
  store.ensureTenant(actor.tenantId);
  const calls: JsonObject[] = [];
  const c: Connection = {
    id: 'meta-connection',
    tenantId: actor.tenantId,
    gateway: 'meta_native_action',
    accounts: ['100'],
    enabled: true,
    label: 'Meta test',
    scopes: ['ads_read'],
  };
  store.putConnection(actor, c, {accessToken: 'synthetic'});
  const read: typeof fetch =
    fetcher ??
    (async (url, init) => {
      calls.push({url: String(url), init});
      const u = new URL(String(url));
      if (u.hostname === 'googleads.googleapis.com')
        return json(
          {
            error: {
              code: 403,
              status: 'PERMISSION_DENIED',
              message: 'Synthetic account access denial',
              details: [
                {
                  errors: [
                    {
                      errorCode: {authorizationError: 'USER_PERMISSION_DENIED'},
                      message: 'Synthetic account access denial',
                    },
                  ],
                },
              ],
            },
          },
          403,
        );
      if (u.pathname.endsWith('/insights'))
        return json({
          data: [
            {
              campaign_id: '101',
              campaign_name: '=IMPORTDATA("untrusted")',
              objective: 'OUTCOME_SALES',
              spend: '100.50',
              impressions: '10000',
              clicks: '500',
              actions: [
                {action_type: 'purchase', value: '20'},
                {action_type: 'omni_purchase', value: '20'},
              ],
              action_values: [{action_type: 'purchase', value: '500'}],
            },
          ],
        });
      return json({id: 'act_100', currency: 'USD', timezone_name: 'America/New_York'});
    });
  const service = new MirrorService(new Registry(), store, new NativeTransport(read, async () => {})),
    overview = new ReportingOverview(service, read),
    worker = new ReportWorker(
      store,
      async () => ({}),
      (t, k, i) => overview.work(t, k, i),
    );
  return {store, service, overview, worker, calls};
}
test('custom metrics parse arithmetic safely, propagate missing values, reject code, cycles and precision loss', () => {
  assert.equal(evaluateMetric(parseMetricFormula('(spend / clicks) * 100').tree, {spend: 4, clicks: 2}), 200);
  assert.equal(evaluateMetric(parseMetricFormula('spend / clicks').tree, {spend: 5, clicks: 0}), null);
  assert.equal(evaluateMetric(parseMetricFormula('spend - purchases').tree, {spend: 5}), null);
  for (const f of ['process.exit()', 'constructor', 'spend;1', 'spend ** 2', '(spend'])
    assert.throws(() => parseMetricFormula(f));
  assert.throws(
    () =>
      validateCustomMetrics([
        {id: 'a', label: 'A', formula: 'b', format: 'decimal'},
        {id: 'b', label: 'B', formula: 'a', format: 'decimal'},
      ]),
    /cycle/,
  );
  assert.throws(() => metricNumber('9007199254740993'));
  assert.throws(() => reportRange({since: '2026-02-30', until: '2026-03-02'}));
  const custom = validateCustomMetrics([
    {id: 'two', label: 'Two', formula: 'one * 2'},
    {id: 'one', label: 'One', formula: 'spend / clicks'},
  ]);
  assert.equal(calculateMetrics({spend: 10, clicks: 2}, custom).two, 10);
});
test('campaign adapters preserve native units, missing data, conversion aliases and objective semantics', () => {
  const m = normalizeNativeRow('meta', {
    campaign_id: '1',
    objective: 'OUTCOME_SALES',
    actions: [
      {action_type: 'purchase', value: '4'},
      {action_type: 'omni_purchase', value: '4'},
    ],
  });
  assert.equal(m.metrics.conversions, 4);
  assert.equal(m.metrics.spend, null);
  assert.equal(
    normalizeNativeRow('google', {campaign: {id: '1'}, metrics: {costMicros: '12000000'}}).metrics.spend,
    12,
  );
  assert.equal(normalizeNativeRow('snapchat', {id: '1', stats: {spend: '5000000', swipes: '4'}}).metrics.spend, 5);
  assert.equal(
    normalizeNativeRow('reddit', {campaign_id: '1', SPEND: 1e6, CONVERSION_PURCHASE_TOTAL_VALUE: 500}).metrics
      .conversion_value,
    5,
  );
  assert.equal(normalizeNativeRow('ga4', {campaign_id: '1', sessions: '4'}).metrics.spend, undefined);
  assert.equal(
    normalizeNativeRow('microsoft', {CampaignId: '1', CampaignName: 'test', Spend: '12.5'}).metrics.spend,
    12.5,
  );
  assert.equal(
    normalizeNativeRow('apple', {
      metadata: {id: '1'},
      totalMetrics: {localSpend: {amount: '1.2', currency: 'USD'}, taps: 2, totalInstalls: 1},
    }).metrics.conversions,
    1,
  );
});
test('objective recommendations require a target, currency, attribution, sufficient results and complete data', () => {
  const row = {
    campaign_key: 'meta:100:101',
    source_kind: 'paid',
    objective_group: 'sales',
    complete: true,
    currency: 'USD',
    timezone: 'UTC',
    captured_at: Date.now(),
    date_to: '2026-08-01',
    attribution: '7d click',
    result_definition: 'purchase',
    metrics: {spend: 100, conversions: 20, cpa: 5},
  };
  const target = {sales: {target: 10, currency: 'USD'}};
  assert.equal(campaignRecommendation(row, target).decision, 'scale');
  assert.equal(
    campaignRecommendation({...row, metrics: {...row.metrics, cpa: 18}}, target).decision,
    'reconsider_pause',
  );
  assert.equal(campaignRecommendation({...row, complete: false}, target).decision, 'needs_review');
  assert.equal(campaignRecommendation(row, {}).decision, 'needs_target');
  assert.equal(campaignRecommendation({...row, currency: 'EUR'}, target).decision, 'needs_review');
  assert.equal(campaignRecommendation({...row, attribution: 'unknown'}, target).decision, 'needs_review');
  assert.equal(
    campaignRecommendation({...row, metrics: {...row.metrics, conversions: 1}}, target).decision,
    'insufficient_data',
  );
  assert.equal(campaignRecommendation({...row, source_kind: 'organic'}, target).decision, 'observe');
});
test('overview worker captures an account-scoped snapshot, calculates metrics, preserves evidence and rejects revoked access', async () => {
  const f = setup();
  try {
    const run = await f.overview.handle({action: 'run', config, confirmed: true}, actor);
    assert.equal(f.calls.length, 0);
    assert.equal(await f.worker.once(), true);
    const r = await f.overview.handle({action: 'get', id: run.id}, actor);
    assert.equal(r.state, 'complete', JSON.stringify(r.job));
    assert.equal(r.rows[0].metrics.profit, 399.5);
    assert.equal(r.rows[0].metrics.conversions, 20);
    assert.equal(r.rows[0].recommendation.decision, 'scale');
    assert.equal(r.rows[0].native.actions.length, 2);
    assert.ok(f.calls.every(c => c.init.method === 'GET'));
    assert.match(exportCsv(r), /'=IMPORTDATA/);
    f.store.db.prepare('DELETE FROM connections WHERE tenant_id=?').run(actor.tenantId);
    await assert.rejects(() => f.overview.handle({action: 'get', id: run.id}, actor));
  } finally {
    f.store.close();
  }
});
test('multi-platform runs isolate source failures and never present partial account coverage as zero', async () => {
  const f = setup();
  try {
    f.store.putConnection(
      actor,
      {
        id: 'google-connection',
        tenantId: actor.tenantId,
        gateway: 'google_ads_native_action',
        accounts: ['200'],
        enabled: true,
        label: 'Google',
        scopes: [],
      },
      {accessToken: 'synthetic'},
    );
    const run = await f.overview.handle(
      {
        action: 'run',
        config: {
          ...config,
          sources: [...config.sources, {platform: 'google', connection_id: 'google-connection', account_id: '200'}],
        },
        confirmed: true,
      },
      actor,
    );
    await f.worker.once();
    const r = await f.overview.handle({action: 'get', id: run.id}, actor);
    assert.ok(['partial', 'failed'].includes(r.state));
    assert.equal(r.sources.length, 2);
    assert.equal(
      r.sources.find((s: JsonObject) => s.source.platform === 'google').error.provider.code,
      'USER_PERMISSION_DENIED',
    );
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].platform, 'meta');
  } finally {
    f.store.close();
  }
});
test('schedules atomically enqueue one run per occurrence with frozen timezone/date range; report cancellation is durable', async () => {
  const f = setup();
  try {
    f.store.putConnection(
      actor,
      {
        id: 'sheets',
        tenantId: actor.tenantId,
        gateway: sheetsGateway,
        accounts: ['sheet1'],
        enabled: true,
        label: 'Fixture Sheets',
        scopes: ['https://www.googleapis.com/auth/drive.file'],
      },
      {accessToken: 'synthetic'},
    );
    f.store.putDocument(actor.tenantId, 'sheets_destination', 'dest', {
      spreadsheet_id: 'sheet1',
      connection_id: 'sheets',
    });
    const schedule = await f.overview.handle(
      {
        action: 'schedule',
        config: {...config, date_range: {preset: 'last_complete_days', days: 7, timezone: 'Africa/Cairo'}},
        schedule: {
          schedule_kind: 'daily',
          timezone: 'Africa/Cairo',
          schedule_config: {hour: 8},
          destination_id: 'dest',
        },
        confirmed: true,
      },
      actor,
    );
    const s = f.store.document(actor.tenantId, 'overview_schedule', schedule.id),
      at = Date.now() - 60000;
    f.store.putDocument(actor.tenantId, 'overview_schedule', s.id, {...s, next_run_at: at});
    f.overview.tick();
    f.overview.tick();
    const jobs = f.store.db.prepare("SELECT * FROM jobs WHERE kind='report_overview'").all() as JsonObject[];
    assert.equal(jobs.length, 1);
    const r = f.store.document(actor.tenantId, 'overview_report', JSON.parse(jobs[0]!.input).report_id);
    assert.ok(r.config.date_range.since && !r.config.date_range.preset);
    await f.overview.handle({action: 'cancel', id: jobs[0]!.id, confirmed: true}, actor);
    assert.equal(f.store.job(actor.tenantId, jobs[0]!.id).state, 'cancelled');
    assert.equal(await f.worker.once(), false);
    await f.overview.handle({action: 'delete_schedule', id: s.id, confirmed: true}, actor);
    assert.equal(f.store.document(actor.tenantId, 'overview_schedule', s.id).is_active, false);
    const resumed = await f.overview.handle({action: 'resume_schedule', id: s.id, confirmed: true}, actor);
    assert.equal(resumed.is_active, true);
    assert.ok(resumed.next_run_at > Date.now());
    f.store.db.prepare('DELETE FROM connections WHERE id=?').run('sheets');
    await assert.rejects(() => f.overview.handle({action: 'resume_schedule', id: s.id, confirmed: true}, actor));
  } finally {
    f.store.close();
  }
});
test('Sheets export writes typed literal cells in one atomic batch to its own tab; completed replay is local and a new run updates the same tab', async () => {
  const f = setup(),
    requests: JsonObject[] = [];
  try {
    f.store.putConnection(
      actor,
      {
        id: 'sheets',
        tenantId: actor.tenantId,
        gateway: sheetsGateway,
        accounts: ['sheet123'],
        enabled: true,
        label: 'Sheets',
        scopes: ['https://www.googleapis.com/auth/drive.file'],
      },
      {accessToken: 'synthetic'},
    );
    let created = false,
      meta: JsonObject = {sheets: []};
    const sheets = new GoogleSheetsExports(f.store, async (url, init) => {
      requests.push({url: String(url), init});
      if (init?.body) {
        const b = JSON.parse(String(init.body));
        if (!created) {
          const add = b.requests.find((r: JsonObject) => r.addSheet).addSheet.properties,
            mark = b.requests.find((r: JsonObject) => r.createDeveloperMetadata).createDeveloperMetadata
              .developerMetadata;
          meta = {
            sheets: [
              {properties: {...add, gridProperties: {rowCount: 100, columnCount: 30}}, developerMetadata: [mark]},
            ],
          };
          created = true;
        }
        return json({spreadsheetId: 'sheet123', replies: b.requests.map(() => ({}))});
      }
      return json(
        String(url).includes('fields=spreadsheetId')
          ? {spreadsheetId: 'sheet123', properties: {title: 'Campaigns'}}
          : meta,
      );
    });
    const d = await sheets.bind(actor, {connection_id: 'sheets', spreadsheet_id: 'sheet123', confirmed: true});
    const run = await f.overview.handle({action: 'run', config, confirmed: true}, actor);
    await f.worker.once();
    const r = f.store.document(actor.tenantId, 'overview_report', run.id);
    await sheets.write(actor, d.id, r);
    const beforeReplay = requests.length;
    const replay = await sheets.write(actor, d.id, r);
    assert.ok('replayed' in replay && replay.replayed === true);
    assert.equal(requests.length, beforeReplay);
    await sheets.write(actor, d.id, {...r, id: r.id + '-next', captured_at: r.captured_at + 1});
    const writes = requests.filter(r => r.init?.body).map(r => JSON.parse(r.init.body));
    assert.equal(writes.length, 2);
    assert.ok(writes[0].requests.some((r: JsonObject) => r.addSheet));
    assert.ok(!writes[1].requests.some((r: JsonObject) => r.addSheet));
    const update = writes[0].requests.find((r: JsonObject) => r.updateCells).updateCells;
    assert.equal(update.rows[1].values[3].userEnteredValue.stringValue, '=IMPORTDATA("untrusted")');
    assert.equal(update.rows[1].values[9].userEnteredValue.numberValue, 100.5);
    assert.ok(!JSON.stringify(writes).includes('formulaValue'));
    meta.sheets[0].developerMetadata = [];
    await assert.rejects(
      () => sheets.write(actor, d.id, {...r, id: r.id + '-missing-owner', captured_at: r.captured_at + 2}),
      /not marked/,
    );
    await assert.rejects(
      () =>
        sheets.bind({...actor, role: 'reader'}, {connection_id: 'sheets', spreadsheet_id: 'sheet123', confirmed: true}),
      /operator/,
    );
  } finally {
    f.store.close();
  }
});
test('Google Sheets creation does not blindly retry an unknown create, and can reconcile the app-owned file', async () => {
  const f = setup();
  try {
    f.store.putConnection(
      actor,
      {
        id: 'sheets',
        tenantId: actor.tenantId,
        gateway: sheetsGateway,
        accounts: [],
        enabled: false,
        label: 'Sheets',
        scopes: ['https://www.googleapis.com/auth/drive.file'],
      },
      {accessToken: 'synthetic'},
    );
    let posts = 0,
      found = false;
    const sheets = new GoogleSheetsExports(f.store, async (_url, init) => {
      if (init?.method === 'POST') {
        posts++;
        throw Error('lost response');
      }
      return json({
        files: found ? [{id: 'sheet123', name: 'Report', mimeType: 'application/vnd.google-apps.spreadsheet'}] : [],
      });
    });
    const input = {connection_id: 'sheets', name: 'Report', idempotency_key: 'stable-create-key', confirmed: true};
    await assert.rejects(() => sheets.create(actor, input), /did not confirm/);
    await assert.rejects(() => sheets.create(actor, input), /will not create/);
    assert.equal(posts, 1);
    found = true;
    const r = await sheets.create(actor, input);
    assert.equal(r.spreadsheet_id, 'sheet123');
    assert.equal(posts, 1);
    assert.ok(f.store.resolveConnection(actor, sheetsGateway, 'sheet123', 'sheets'));
  } finally {
    f.store.close();
  }
});

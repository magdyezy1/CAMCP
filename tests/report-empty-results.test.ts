import {listenForFetch} from './http-listener.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {ReportingOverview} from '../src/reporting-overview.js';
import {ReportWorker} from '../src/worker.js';
import {GoogleSheetsExports, exportCsv} from '../src/google-sheets.js';
import {metaCampaignRows} from '../src/meta-report.js';
import {createHttpApp} from '../server/http-app.js';
import type {Actor, JsonObject} from '../src/types.js';

const actor: Actor = {tenantId: 'empty-report-test', userId: 'owner', role: 'admin'},
  key = Buffer.alloc(32, 43).toString('base64');
const source = {platform: 'meta', account_id: '100', connection_id: 'meta-connection'};
const range = {since: '2025-01-01', until: '2025-01-31'};
const config = {
  name: 'January campaign performance',
  sources: [source],
  date_range: range,
  metrics: ['spend', 'clicks', 'purchases'],
  custom_metrics: [],
};
const row = (id: string) => ({
  account_id: '100',
  account_name: 'Synthetic account',
  campaign_id: id,
  campaign_name: 'Campaign ' + id,
  objective: 'OUTCOME_SALES',
  date_start: range.since,
  date_stop: range.until,
  spend: '10.25',
  impressions: '100',
  clicks: '5',
  actions: [{action_type: 'purchase', value: '2'}],
});
function fixture(insights: (url: URL) => unknown) {
  const store = new Store(':memory:', key),
    calls: URL[] = [];
  store.putConnection(
    actor,
    {
      id: source.connection_id,
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['100'],
      enabled: true,
      label: 'Synthetic login',
      scopes: ['ads_read'],
    },
    {accessToken: 'synthetic-test-token'},
  );
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (url, init) => {
        assert.equal(init?.method, 'GET');
        const u = new URL(String(url));
        calls.push(u);
        assert.ok(u.pathname === '/v26.0/act_100' || u.pathname === '/v26.0/act_100/insights');
        return Response.json(
          u.pathname.endsWith('/insights')
            ? insights(u)
            : {id: 'act_100', name: 'Synthetic account', currency: 'USD', timezone_name: 'Asia/Dubai'},
        );
      },
      async () => {},
    ),
  );
  const overview = new ReportingOverview(service, async () => {
      throw Error('Unexpected Google Sheets request');
    }),
    worker = new ReportWorker(
      store,
      async () => ({}),
      (t, k, i) => overview.work(t, k, i),
    );
  const run = async (c: JsonObject = config) => {
    const queued = await overview.handle({action: 'run', config: c, confirmed: true}, actor);
    await worker.once();
    return overview.handle({action: 'get', id: queued.id}, actor);
  };
  return {store, service, overview, worker, calls, run};
}

test('AMCP sends January 2025 unchanged, preserves Meta campaign pages and exports every returned row', async () => {
  const f = fixture(u => ({
    data: u.searchParams.has('after') ? [row('102')] : [row('101')],
    ...(!u.searchParams.has('after')
      ? {paging: {next: 'https://graph.facebook.com/ignored-next-url', cursors: {after: 'second-page'}}}
      : {}),
  }));
  try {
    const report = await f.run();
    assert.equal(report.state, 'complete');
    assert.equal(report.row_count, 2);
    assert.equal(report.source_row_count, 2);
    assert.equal(report.filtered_row_count, 0);
    assert.equal(report.sources[0].account_name, 'Synthetic account');
    assert.equal(report.sources[0].visible_row_count, 2);
    assert.equal(report.rows[0].metrics.spend, 10.25);
    assert.equal(f.calls.length, 3);
    for (const u of f.calls.filter(u => u.pathname.endsWith('/insights'))) {
      assert.deepEqual(JSON.parse(u.searchParams.get('time_range')!), range);
      assert.equal(u.searchParams.get('level'), 'campaign');
      assert.equal(u.searchParams.get('use_unified_attribution_setting'), 'true');
      assert.equal(u.searchParams.has('date_preset'), false);
      assert.match(u.searchParams.get('fields')!, /account_id,account_name,date_start,date_stop/);
    }
    const csv = exportCsv(report);
    assert.equal(csv.split('\r\n').length, 3);
    assert.ok(csv.includes('Campaign 101') && csv.includes('Campaign 102'));
    assert.ok(csv.includes('2025-01-01') && csv.includes('2025-01-31'));
    assert.ok(!csv.includes('2026-01'));
  } finally {
    f.store.close();
  }
});

test('a legitimate empty Meta response records no data and blocks manual CSV and Sheets exports before any export job or egress', async () => {
  const f = fixture(() => ({data: []}));
  try {
    const report = await f.run();
    assert.equal(report.state, 'complete');
    assert.equal(report.job.state, 'complete');
    assert.equal(report.empty_reason, 'no_provider_rows');
    assert.equal(report.source_row_count, 0);
    assert.equal(report.filtered_row_count, 0);
    assert.throws(() => exportCsv(report), {code: 'EMPTY_REPORT'});
    await assert.rejects(
      () =>
        f.overview.handle({action: 'export', report_id: report.id, destination_id: 'unused', confirmed: true}, actor),
      {code: 'EMPTY_REPORT'},
    );
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM jobs WHERE kind='sheets_export'").get()!.n, 0);
    let requests = 0;
    const sheets = new GoogleSheetsExports(f.store, async () => {
      requests++;
      throw Error('Unexpected export');
    });
    await assert.rejects(() => sheets.write(actor, 'unused', report), {code: 'EMPTY_REPORT'});
    assert.equal(requests, 0);
  } finally {
    f.store.close();
  }
});

test('an empty scheduled report leaves the existing Google Sheets destination untouched and reports the skipped export', async () => {
  const f = fixture(() => ({data: []}));
  try {
    const destination = {last_report_id: 'previous-report', last_captured_at: 123, sheet_id: 12345};
    f.store.putDocument(actor.tenantId, 'sheets_destination', 'existing', destination);
    f.store.putDocument(actor.tenantId, 'overview_schedule', 'synthetic-schedule', {
      is_active: true,
      definition_version: 1,
    });
    const queued = f.overview.queue(actor, f.overview.config(config, actor), 'existing', 'synthetic-schedule');
    await f.worker.once();
    const report = await f.overview.handle({action: 'get', id: queued.id}, actor);
    assert.equal(report.job.state, 'complete');
    assert.equal(report.export.state, 'skipped');
    assert.equal(report.export.reason, 'EMPTY_REPORT');
    assert.equal(f.store.document(actor.tenantId, 'sheets_destination', 'existing').last_report_id, 'previous-report');
    assert.equal(f.calls.length, 2);
  } finally {
    f.store.close();
  }
});

test('objective filters expose the native row count instead of claiming Meta returned nothing', async () => {
  const f = fixture(() => ({data: [row('101'), row('102')]}));
  try {
    const report = await f.run({...config, objectives: ['traffic']});
    assert.equal(report.row_count, 0);
    assert.equal(report.source_row_count, 2);
    assert.equal(report.filtered_row_count, 2);
    assert.equal(report.empty_reason, 'objective_filter');
    assert.equal(report.sources[0].row_count, 2);
    assert.equal(report.sources[0].visible_row_count, 0);
    assert.throws(() => exportCsv(report), {code: 'EMPTY_REPORT'});
  } finally {
    f.store.close();
  }
});

test('missing Meta collections, wrong accounts and out-of-period rows cannot become successful empty reports', async () => {
  for (const body of [{}, {data: null}, {data: {}}, {data: [null]}]) {
    const f = fixture(() => body);
    try {
      const report = await f.run();
      assert.equal(report.state, 'failed');
      assert.equal(report.sources[0].error.code, 'REPORT_SHAPE_CHANGED');
      assert.throws(() => exportCsv(report), {code: 'REPORT_NOT_READY'});
    } finally {
      f.store.close();
    }
  }
  assert.throws(() => metaCampaignRows({data: [{...row('101'), account_id: '200'}]}, '100', range), {
    code: 'REPORT_ACCOUNT_MISMATCH',
  });
  assert.throws(
    () => metaCampaignRows({data: [{...row('101'), date_start: '2026-01-01', date_stop: '2026-01-31'}]}, '100', range),
    {code: 'REPORT_DATE_MISMATCH'},
  );
  assert.throws(() => metaCampaignRows({data: [{...row('101'), date_stop: '2025-02-30'}]}, '100', range), {
    code: 'REPORT_DATE_MISMATCH',
  });
  assert.equal(metaCampaignRows({data: []}, '100', range).length, 0);
});

test('report account choices use selected account names and keep the login label separate without provider requests', async () => {
  const f = fixture(() => {
    throw Error('No live reads expected');
  });
  try {
    f.store.putDocument(actor.tenantId, 'website_assets', source.connection_id, {
      groups: [
        {
          kind: 'ad_accounts',
          assets: [
            {id: '100', name: 'Selected advertising account'},
            {id: '200', name: 'Not selected'},
          ],
        },
      ],
    });
    const bootstrap = await f.overview.handle({action: 'bootstrap'}, actor),
      accounts = bootstrap.platforms.find((p: JsonObject) => p.id === 'meta').accounts;
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].label, 'Selected advertising account');
    assert.equal(accounts[0].connection_label, 'Synthetic login');
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});

test('the CSV endpoint rejects empty, failed and unfinished reports as JSON without an attachment header', async () => {
  const f = fixture(() => ({data: []})),
    origin = 'https://amcp.shop',
    app = createHttpApp(f.service, f.store, {
      publicOrigin: origin,
      website: {
        origin,
        masterKey: key,
        adminPassword: 'synthetic-test-password',
        tenantId: actor.tenantId,
        authEnv: {},
      },
    }),
    listener = await listenForFetch(app);
  const base = 'http://127.0.0.1:' + (listener.address() as {port: number}).port;
  try {
    const report = await f.run(),
      url = base + '/api/reporting-overview/' + report.id + '.csv';
    assert.equal((await fetch(url)).status, 401);
    const login = await fetch(base + '/api/session', {
      method: 'POST',
      headers: {Origin: origin, 'Content-Type': 'application/json'},
      body: JSON.stringify({password: 'synthetic-test-password'}),
    });
    await login.text();
    const headers = {Cookie: login.headers.get('set-cookie')!.split(';')[0]!};
    for (const state of ['complete', 'failed', 'queued']) {
      const stored = f.store.document(actor.tenantId, 'overview_report', report.id);
      f.store.putDocument(actor.tenantId, 'overview_report', report.id, {...stored, state});
      const r = await fetch(url, {headers});
      assert.equal(r.status, 409);
      assert.match(r.headers.get('content-type')!, /application\/json/);
      assert.equal(r.headers.get('content-disposition'), null);
      assert.equal(
        ((await r.json()) as JsonObject).error.code,
        state === 'complete' ? 'EMPTY_REPORT' : 'REPORT_NOT_READY',
      );
    }
  } finally {
    await new Promise<void>(resolve => {
      listener.close(() => resolve());
      listener.closeAllConnections();
    });
    f.store.close();
  }
});

test('date controls preserve historical years and empty reports render without download actions', async () => {
  const esc = (v: unknown) =>
    String(v ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  const root = {innerHTML: ''},
    report = {
      id: 'empty',
      state: 'complete',
      row_count: 0,
      rows: [],
      sources: [{source, complete: true, row_count: 0}],
      empty_reason: 'no_provider_rows',
      config: {...config, custom_metrics: []},
      job: {state: 'complete'},
      summary: [],
      exports: [],
    };
  const context = createContext({
    document: {querySelector: () => null},
    Intl,
    URLSearchParams,
    esc,
    api: async () => ({success: true, data: report}),
    clearTimeout: () => {},
    pollTimer: undefined,
    location: {pathname: '/reporting-overview'},
    authBind: () => {},
    date: () => '',
    $: (selector: string) => (selector === '#overview-results' ? root : null),
  });
  new Script(readFileSync('web/report-library.js', 'utf8')).runInContext(context);
  new Script(readFileSync('web/report-quality.js', 'utf8')).runInContext(context);
  new Script(readFileSync('web/reporting-overview.js', 'utf8')).runInContext(context);
  assert.deepEqual(JSON.parse(new Script("JSON.stringify(reportMonthRange('2025-01'))").runInContext(context)), range);
  assert.equal(new Script("reportMonthRange('2024-02').until").runInContext(context), '2024-02-29');
  assert.equal(
    new Script("overviewInitialConfig('?since=2025-01-01&until=2025-01-31').date_range.since").runInContext(context),
    '2025-01-01',
  );
  assert.throws(() => new Script("overviewInitialConfig('?since=2025-02-30&until=2025-03-01')").runInContext(context));
  assert.match(
    new Script("reportRangeLabel({since:'2025-01-01',until:'2025-01-31'})").runInContext(context),
    /1 January 2025.*31 January 2025/,
  );
  await new Script(
    "overviewState.bootstrap={platforms:[{id:'meta',name:'Meta'}],metrics:{}};loadOverviewReport('empty')",
  ).runInContext(context);
  assert.match(root.innerHTML, /No data/);
  assert.match(root.innerHTML, /No campaign rows returned/);
  assert.ok(!root.innerHTML.includes('Download CSV'));
  assert.ok(!root.innerHTML.includes('id="report-export"'));
  context.report = {...report, empty_reason: 'objective_filter', source_row_count: 2, filtered_row_count: 2};
  assert.match(new Script('renderReportEmpty(report)').runInContext(context), /2 rows were returned before filtering/);
});

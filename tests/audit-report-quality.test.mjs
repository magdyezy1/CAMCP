import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {ReportWorker} from '../dist/src/worker.js';
import {GoogleSheetsExports, reportTable, exportCsv} from '../dist/src/google-sheets.js';
import {normalizeNativeRow} from '../dist/src/report-native.js';
import {campaignRecommendation} from '../dist/src/report-metrics.js';
import {summarizeGA4Quality, ga4Quality} from '../dist/src/report-quality.js';

const actor = {tenantId: 'quality', userId: 'owner', role: 'admin'},
  key = Buffer.alloc(32, 63).toString('base64');
const config = {
  name: 'Quality regression',
  date_range: {since: '2026-08-01', until: '2026-08-07'},
  sources: [
    {platform: 'apple', connection_id: 'apple-login', account_id: '123'},
    {platform: 'ga4', connection_id: 'ga4-login', account_id: '456'},
    {platform: 'meta', connection_id: 'meta-login', account_id: '789'},
  ],
  metrics: ['spend', 'clicks', 'installs', 'sessions', 'conversion_value'],
  custom_metrics: [{id: 'return_per_session', label: 'Revenue per session', formula: 'conversion_value / sessions'}],
};
function fixture() {
  const store = new Store(':memory:', key),
    batches = [];
  for (const [platform, id] of [
    ['apple', '123'],
    ['ga4', '456'],
    ['meta', '789'],
  ])
    store.putConnection(
      actor,
      {
        id: platform + '-login',
        tenantId: actor.tenantId,
        gateway:
          platform === 'apple'
            ? 'apple_ads_native_action'
            : platform === 'ga4'
              ? 'ga4_native_action'
              : 'meta_native_action',
        accounts: [id],
        enabled: true,
        label: 'Synthetic',
        scopes: [],
      },
      {accessToken: 'synthetic'},
    );
  const fetcher = async (url, init) => {
    const u = new URL(String(url));
    if (u.hostname === 'graph.facebook.com')
      return Response.json({error: {code: 100, message: 'Synthetic source failure'}}, {status: 400});
    if (u.hostname === 'sheets.googleapis.com') {
      if (init?.method === 'POST') {
        const batch = JSON.parse(init.body);
        batches.push(batch);
        return Response.json({spreadsheetId: 'sheet123', replies: batch.requests.map(() => ({}))});
      }
      return Response.json({sheets: []});
    }
    if (u.pathname === '/v1/ad-accounts/123')
      return Response.json({result: {id: '123', name: 'Synthetic Apple', currency: 'USD'}});
    if (u.pathname === '/v1/reports/apps/campaigns/query') {
      assert.equal(JSON.parse(init.body).timeRange.granularity, undefined);
      return Response.json({
        result: {
          rows: [
            {
              metadata: {id: '42', name: 'Apple launch', adAccountId: '123'},
              totalMetrics: {
                localSpend: {amount: '12.50', currency: 'USD'},
                impressions: 100,
                taps: 10,
                totalInstalls: 4,
                tapInstalls: 3,
                viewInstalls: 1,
              },
            },
          ],
        },
        pagination: {totalResults: 1},
      });
    }
    if (u.hostname === 'analyticsadmin.googleapis.com')
      return Response.json({name: 'properties/456', currencyCode: 'USD', timeZone: 'UTC'});
    if (u.pathname === '/v1beta/properties/456:runReport') {
      const body = JSON.parse(init.body),
        names = body.metrics.map(m => m.name);
      return Response.json({
        rows: [
          {
            dimensionValues: body.dimensions.map(d => ({
              value: d.name === 'sessionCampaignId' ? 'linked-ad-id' : 'Tagged or linked campaign',
            })),
            metricValues: names.map(name => ({value: name === 'totalRevenue' ? '0' : '10'})),
          },
        ],
        rowCount: 1,
        metricHeaders: names.map(name => ({name})),
        metadata: {
          samplingMetadatas: [{samplesReadCount: '20000000000000001', samplingSpaceSize: '40000000000000002'}],
          schemaRestrictionResponse: {
            activeMetricRestrictions: [{metricName: 'totalRevenue', restrictedMetricTypes: ['REVENUE_DATA']}],
          },
          currencyCode: 'USD',
          timeZone: 'UTC',
        },
      });
    }
    throw Error('Unexpected request ' + u.pathname);
  };
  const service = new MirrorService(new Registry(), store, new NativeTransport(fetcher, async () => {})),
    overview = new ReportingOverview(service, fetcher),
    worker = new ReportWorker(
      store,
      async () => ({}),
      (t, k, i) => overview.work(t, k, i),
    );
  return {store, overview, worker, fetcher, batches};
}

test('official Apple v1 totals and GA4 quality survive backend, CSV and typed Sheets with failed sources visible', async () => {
  const f = fixture();
  try {
    const run = await f.overview.handle({action: 'run', confirmed: true, config}, actor);
    await f.worker.once();
    const report = await f.overview.handle({action: 'get', id: run.id}, actor);
    assert.equal(report.state, 'partial', JSON.stringify(report));
    assert.equal(report.sources.length, 3);
    const apple = report.rows.find(r => r.platform === 'apple'),
      ga4 = report.rows.find(r => r.platform === 'ga4');
    assert.equal(apple.campaign_id, '42');
    assert.equal(apple.campaign_name, 'Apple launch');
    assert.equal(apple.metrics.spend, 12.5);
    assert.equal(apple.metrics.installs, 4);
    assert.equal(ga4.metrics.sessions, 10);
    assert.equal(ga4.metrics.conversion_value, null);
    assert.equal(ga4.metrics.return_per_session, null);
    assert.equal(ga4.native.totalRevenue, null);
    assert.equal(ga4.metrics.native_ga4_totalRevenue, null);
    assert.ok(report.native_metrics.includes('native_ga4_totalRevenue'));
    assert.equal(ga4.quality.sampled, true);
    assert.equal(ga4.quality.pages[0].samples[0].samples_read_count, '20000000000000001');
    assert.deepEqual(ga4.quality.restricted_metrics, ['totalRevenue']);
    assert.equal(ga4.recommendation.decision, 'observe');
    assert.equal(report.config.formula_version, 'arithmetic-v1');
    assert.match(ga4.query_fingerprint, /^[a-f0-9]{64}$/);
    assert.ok(ga4.lineage.every(l => l.response_fingerprint));
    const table = reportTable(report),
      headers = table[0],
      status = JSON.parse(table[1][headers.indexOf('Source status JSON')]);
    assert.equal(status.selected_sources.find(s => s.platform === 'meta').status, 'failed');
    assert.ok(exportCsv(report).includes('Source status JSON'));
    f.store.putConnection(
      actor,
      {
        id: 'sheets',
        tenantId: actor.tenantId,
        gateway: 'google_sheets_native_action',
        accounts: ['sheet123'],
        enabled: true,
        label: 'Synthetic',
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      },
      {accessToken: 'synthetic'},
    );
    f.store.putDocument(actor.tenantId, 'sheets_destination', 'destination', {
      connection_id: 'sheets',
      spreadsheet_id: 'sheet123',
      sheet_id: 7,
      tab_name: 'Quality',
    });
    await new GoogleSheetsExports(f.store, f.fetcher).write(actor, 'destination', report);
    const cells = f.batches[0].requests
      .find(r => r.updateCells)
      .updateCells.rows.map(r => r.values.map(v => v.userEnteredValue.numberValue ?? v.userEnteredValue.stringValue));
    assert.deepEqual(cells, table, 'CSV and Sheets derive from the same snapshot table, including quality metadata');
    await assert.rejects(
      () =>
        new GoogleSheetsExports(f.store, f.fetcher).write(actor, 'destination', {
          ...report,
          config: {...report.config, partial_delivery: 'complete_only'},
        }),
      e => e.code === 'PARTIAL_DELIVERY_BLOCKED',
    );
    assert.equal(f.batches.length, 1);
  } finally {
    f.store.close();
  }
});
test('GA4 measurement quality handles precision, thresholding and empty reasons without inventing zero', () => {
  const q = summarizeGA4Quality([
    ga4Quality(
      {subjectToThresholding: true, dataLossFromOtherRow: true, emptyReason: 'NO_DATA'},
      ['sessionCampaignId'],
      0,
    ),
  ]);
  assert.equal(q.measurement_complete, false);
  assert.deepEqual(q.empty_reasons, ['NO_DATA']);
  assert.throws(
    () => normalizeNativeRow('apple', {metadata: {campaignId: '1'}, total: {installs: 1}}),
    e => e.code === 'REPORT_SHAPE_CHANGED',
  );
});
test('recommendations expose uncertainty and honor contradictory evidence and business limits', () => {
  const row = {
    campaign_key: 'a',
    source_kind: 'paid',
    complete: true,
    currency: 'USD',
    timezone: 'UTC',
    captured_at: Date.now(),
    objective_group: 'traffic',
    date_to: '2026-08-01',
    metrics: {spend: 50, clicks: 100, cpc: 0.5, roas: 0.1},
  };
  const p = {traffic: {target: 1, currency: 'USD'}};
  assert.equal(campaignRecommendation(row, p).decision, 'scale');
  assert.equal(campaignRecommendation(row, p).confidence, 'moderate');
  for (const context of [
    {tracking_verified: false},
    {recent_change: true},
    {seasonal_event: 'Launch promotion'},
    {secondary_kpi: {kpi: 'roas', target: 2, direction: 'higher'}},
  ])
    assert.equal(campaignRecommendation(row, {traffic: {...p.traffic, context}}).decision, 'needs_review');
  for (const context of [
    {capacity_available: false},
    {budget_available: false},
    {current_daily_budget: 100, maximum_daily_budget: 100},
  ])
    assert.equal(campaignRecommendation(row, {traffic: {...p.traffic, context}}).decision, 'maintain');
  assert.ok(
    campaignRecommendation(row, {
      traffic: {...p.traffic, context: {current_daily_budget: 100, maximum_daily_budget: 103}},
    }).evidence.maximum_budget_change_percent < 3.01,
  );
});

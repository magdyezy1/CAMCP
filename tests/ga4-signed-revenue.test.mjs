import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {ReportWorker} from '../dist/src/worker.js';
import {reportTable, exportCsv} from '../dist/src/google-sheets.js';
import {overviewConfigV4} from '../dist/src/overview-v4.js';
import {MirrorError} from '../dist/src/errors.js';
import {normalizeNativeRowV4} from '../dist/src/report-native.js';
import {parseProviderDecimal, providerDecimalText} from '../dist/src/provider-decimal.js';
import {assertRefused} from './helpers/assert-refused.mjs';

// r25-mf-jobs item 4: GA4 totalRevenue is revenue minus refunds, so a campaign whose refunds exceed its sales reports a
// negative number. The exact reader refused every negative number, and that one refund row failed the whole GA4 source.
// A metric a report source names as a net figure (signedMetrics) takes a minus sign; nothing else does.
const actor = {tenantId: 'ga4-signed-revenue', userId: 'owner', role: 'admin'},
  key = Buffer.alloc(32, 45).toString('base64');
const source = {platform: 'ga4', account_id: '153293282', connection_id: 'ga4-connection', levels: ['campaign']};
const config = {
  contract_version: overviewConfigV4,
  name: 'GA4 revenue',
  sources: [source],
  date_range: {since: '2025-01-01', until: '2025-01-31'},
  metrics: ['sessions', 'conversions', 'conversion_value'],
  custom_metrics: [],
};
const row = (dims, values) => ({
  dimensionValues: dims.map(value => ({value})),
  metricValues: values.map(value => ({value})),
});

/** rows are [campaign id, campaign name, sessions, totalRevenue] the property holds. */
function fixture(t, rows) {
  const store = new Store(':memory:', key);
  t.after(() => store.close());
  store.putConnection(
    actor,
    {
      id: source.connection_id,
      tenantId: actor.tenantId,
      gateway: 'ga4_native_action',
      accounts: [source.account_id],
      enabled: true,
      label: 'Synthetic property',
      scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
    },
    {accessToken: 'synthetic-test-token'},
  );
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (url, init) => {
        const u = new URL(String(url));
        if (!u.pathname.endsWith(':runReport'))
          return Response.json({name: 'properties/' + source.account_id, currencyCode: 'SAR', timeZone: 'Asia/Riyadh'});
        const body = JSON.parse(String(init?.body)),
          names = body.metrics.map(m => m.name),
          withName = body.dimensions.length === 2,
          values = {sessions: 2, totalUsers: 3, keyEvents: 4};
        const out = rows.map(([id, name, sessions, revenue]) =>
          row(
            withName ? [id, name] : [id],
            names.map(n => (n === 'sessions' ? sessions : n === 'totalRevenue' ? revenue : String(values[n] ?? 1))),
          ),
        );
        return Response.json({
          rows: out,
          rowCount: out.length,
          metricHeaders: names.map(name => ({name})),
          dimensionHeaders: body.dimensions.map(d => ({name: d.name})),
        });
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
      (tenant, kind, input) => overview.work(tenant, kind, input),
    );
  return {
    store,
    /** The stored snapshot; `read` is what a client's get returns for it. */
    run: async () => {
      const queued = await overview.handle({action: 'run', config, confirmed: true}, actor);
      await worker.once();
      return Object.assign(store.document(actor.tenantId, 'overview_report', queued.id), {
        read: () => overview.handle({action: 'get', id: queued.id, limit: 100}, actor),
      });
    },
  };
}

test('a GA4 campaign whose refunds exceed its revenue is a negative figure, not a failed source', async t => {
  const f = fixture(t, [
      ['sale', 'Spring sale', '10', '30'],
      ['refunded', 'Refunded orders', '5', '-12.5'],
    ]),
    report = await f.run();
  assert.equal(report.state, 'complete', JSON.stringify(report.error ?? report.sources[0].error));
  const byId = Object.fromEntries(report.rows.map(r => [r.campaign_id, r.metrics]));
  assert.equal(byId.sale.conversion_value, '30');
  assert.equal(byId.refunded.conversion_value, '-12.5', 'the refund row keeps its sign, exactly');
  assert.equal(byId.refunded.native_ga4_totalRevenue, '-12.5');
  assert.equal(byId.refunded.sessions, '5', 'the other metrics of the row are read as before');
  // The whole report carries the figure: the total is the exact sum, and the exports hold the signed cell.
  const total = report.summary.reduce((sum, group) => sum + Number(group.metrics.conversion_value), 0);
  assert.equal(total, 17.5);
  assert.match(exportCsv(report), /-12\.5/);
  assert.match(JSON.stringify(reportTable(report)), /-12\.5/);
  // What a client reads back is the same figure.
  const read = await report.read();
  assert.equal(read.state, 'complete');
  assert.equal(read.rows.find(r => r.entity_id === 'refunded').metrics.conversion_value, '-12.5');
});

test('a refund smaller than the nine-place unit rounds to zero as a positive one does', async t => {
  const f = fixture(t, [['refunded', 'Refunded orders', '5', '-0.0000000005']]),
    report = await f.run();
  assert.equal(report.state, 'complete');
  // Nine places, half to even, as for every provider metric (a rounded value is recorded as such).
  assert.equal(report.rows[0].metrics.conversion_value, '0');
});

// ---- the gate: every other number is read as before ----
const ga4 = {campaign_id: 'c1', campaign_name: 'Campaign', sessions: '10', totalUsers: '8', keyEvents: '2'};
const refused = fn => assert.throws(fn, error => assertRefused(error, 'REPORT_SHAPE_CHANGED'));

test('only a metric the source names as signed takes a minus sign', () => {
  const read = (platform, raw) => normalizeNativeRowV4(platform, raw);
  assert.equal(read('ga4', {...ga4, totalRevenue: '-12.5'}).metrics.conversion_value, '-12.5');
  assert.equal(read('ga4', {...ga4, totalRevenue: -12.5}).metrics.conversion_value, '-12.5');
  assert.equal(read('ga4', {...ga4, totalRevenue: '-0'}).metrics.conversion_value, '0', 'minus zero is zero');
  // The same refund as the number of sessions, users or key events, or as a native metric the source does not name.
  for (const name of ['sessions', 'totalUsers', 'keyEvents'])
    refused(() => read('ga4', {...ga4, totalRevenue: '1', [name]: '-1'}));
  refused(() => read('ga4', {...ga4, totalRevenue: '1', purchaseRevenue: '-1'}));
  // Another provider's value is never signed, whatever its metric is called.
  refused(() => read('meta', {campaign_id: '1', campaign_name: 'c', spend: '-1', impressions: '1', clicks: '1'}));
  // A signed metric keeps every other guard of the reader.
  for (const bad of ['--5', '+5', '5-', '- 5', 'abc', '1,5', '-1e9999', '-5e', '1-'])
    refused(() => read('ga4', {...ga4, totalRevenue: bad}));
  assert.throws(
    () => read('ga4', {...ga4, totalRevenue: -9007199254740993}),
    error => assertRefused(error, 'METRIC_PRECISION_LOSS'),
  );
  assert.throws(
    () => read('ga4', {...ga4, totalRevenue: -Infinity}),
    error => assertRefused(error, 'REPORT_SHAPE_CHANGED'),
  );
});

test('the decimal reader takes a sign only when it is told to, and rounds a negative as it rounds a positive', () => {
  const field = 'totalRevenue';
  assert.equal(parseProviderDecimal('-12.5', {field, signed: true}).scaled, -12500000000n);
  assert.equal(parseProviderDecimal('12.5', {field, signed: true}).scaled, 12500000000n);
  assert.equal(parseProviderDecimal('0.5', {field}).scaled, 500000000n);
  for (const call of [() => parseProviderDecimal('-12.5', {field}), () => providerDecimalText(-1, {field})])
    assert.throws(call, error => error instanceof MirrorError && error.code === 'REPORT_SHAPE_CHANGED');
  // Half to even on the magnitude: -0.0000000015 -> -0.000000002, -0.0000000025 -> -0.000000002, -0.0000000005 -> 0.
  for (const [text, scaled] of [
    ['-0.0000000015', -2n],
    ['-0.0000000025', -2n],
    ['-0.0000000005', 0n],
    ['-0.0000000016', -2n],
  ]) {
    const parsed = parseProviderDecimal(text, {field, signed: true});
    assert.equal(parsed.scaled, scaled, text);
    assert.equal(parsed.rounded, true, text);
    assert.equal(
      parseProviderDecimal(text.slice(1), {field}).scaled,
      scaled === 0n ? 0n : -scaled,
      'symmetric: ' + text,
    );
  }
  assert.equal(providerDecimalText('-1.250', {field, signed: true}), '-1.25');
  assert.equal(providerDecimalText('-0.00', {field, signed: true}), '0');
  assert.equal(providerDecimalText('-1e2', {field, signed: true}), '-100');
  assert.equal(providerDecimalText('-1e-3', {field, signed: true}), '-0.001');
  assert.equal(providerDecimalText('1e-3', {field}), '0.001');
});

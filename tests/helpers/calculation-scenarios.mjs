import {parentPort, workerData} from 'node:worker_threads';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {ReportingOverview} from '../../dist/src/reporting-overview.js';
import {ReportWorker} from '../../dist/src/worker.js';
import {validateCustomMetrics} from '../../dist/src/report-metrics.js';
import {reportMetricsSummaryV4} from '../../dist/src/report-summary.js';
import {recommendationV4} from '../../dist/src/report-advice-v4.js';
import {calculateMetricsV4, withCalculationBudget} from '../../dist/src/report-math-v4.js';

// The custom metric sets of the audit's F-L9-01, run in a worker thread so that a calculation that never ends is
// stopped by the test instead of stopping the run (tests/helpers/bounded-run.mjs).
const {scenario, args} = workerData;

/** m_i = m_{i+1} + ... + m_n + leaf: every metric uses all the later ones, so a walk that does not remember has 2^n paths. */
export const chain = (length, leaf) =>
  Array.from({length}, (_, index) => {
    const i = index + 1,
      dependencies = [];
    for (let j = i + 1; j <= length; j++) dependencies.push('m' + j);
    dependencies.push(leaf);
    return {id: 'm' + i, label: 'M' + i, formula: dependencies.join('+'), format: 'decimal'};
  });
/** Form C of the audit: powers of spend and clicks, then 26 long formulas over them. */
export const wide = () => {
  const custom = [
    {id: 'p1', label: 'p', formula: Array(55).fill('spend').join('*'), format: 'decimal'},
    {id: 'p2', label: 'p', formula: Array(30).fill('p1').join('*'), format: 'decimal'},
    {id: 'p3', label: 'p', formula: Array(55).fill('clicks').join('*'), format: 'decimal'},
    {id: 'p4', label: 'p', formula: Array(18).fill('p3').join('*'), format: 'decimal'},
  ];
  for (let i = 0; i < 26; i++)
    custom.push({id: 'q' + i, label: 'q', formula: '(p2+7)/(p4+9)' + '*1'.repeat(50), format: 'decimal'});
  return custom;
};

/**
 * Form D: every number stays under the size bound (about 3,700 digits), and 26 long formulas multiply the quotient of two
 * unrelated ones by 1 fifty times each. Each multiplication reduces a fraction of two coprime 3,700-digit numbers, about
 * 12 ms, so without a work budget this is half a minute per pass over the row.
 */
export const deep = () => {
  const custom = [
    {id: 'b1', label: 'b', formula: Array(60).fill('clicks').join('*'), format: 'decimal'},
    {id: 'p2', label: 'p', formula: Array(16).fill('b1').join('*'), format: 'decimal'},
    {id: 'b3', label: 'b', formula: Array(40).fill('impressions').join('*'), format: 'decimal'},
    {id: 'p4', label: 'p', formula: Array(15).fill('b3').join('*'), format: 'decimal'},
  ];
  for (let i = 0; i < 26; i++)
    custom.push({id: 'q' + i, label: 'q', formula: '(p2+7)/(p4+9)' + '*1'.repeat(50), format: 'decimal'});
  return custom;
};

const row = {
  platform: 'meta',
  account_id: '1',
  currency: 'USD',
  date_from: '2026-01-01',
  date_to: '2026-01-31',
  attribution: 'x',
  entity_level: 'campaign',
  campaign_key: 'meta:1:1',
  objective_group: 'sales',
  source_kind: 'paid',
  complete: true,
  metrics: {spend: '123.47', impressions: '987653', clicks: '7657', conversions: '32.5', reach: '1000'},
  result: {value: '32.5', cost_per_result: '3.8', label: 'Purchases', definition_id: 'meta:purchases'},
  result_context: {definition: {id: 'meta:purchases', aggregation: 'sum'}, source: 'mapped', cost_source: 'provider'},
  recommendation: {decision: 'hold'},
};

/** A stall gauge: the longest time a 5 ms timer of this thread had to wait. */
function gauge() {
  let last = performance.now(),
    gap = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    gap = Math.max(gap, now - last);
    last = now;
  }, 5);
  return {
    reset() {
      gap = 0;
      last = performance.now();
    },
    stop() {
      clearInterval(timer);
      return gap;
    },
  };
}

async function pipeline({mode, length = 30, rows = 1}) {
  const admin = {tenantId: 't1', userId: 'owner', role: 'admin'},
    operator = {tenantId: 't1', userId: 'op', role: 'operator'},
    custom_metrics =
      mode === 'A' ? chain(length, 'reach') : mode === 'B' ? chain(length, 'clicks') : mode === 'D' ? deep() : wide(),
    targets = mode === 'B' ? {sales: {target: 1, currency: 'USD', kpi: 'm1', direction: 'higher'}} : undefined,
    store = new Store(':memory:', Buffer.alloc(32, 121).toString('base64'));
  store.putConnection(
    admin,
    {
      id: 'login',
      tenantId: 't1',
      gateway: 'meta_native_action',
      accounts: ['100'],
      enabled: true,
      scopes: [],
      label: 'S',
    },
    {accessToken: 'synthetic'},
  );
  const fetcher = async () => {
    throw new Error('Unexpected provider request');
  };
  const overview = new ReportingOverview(
    new MirrorService(new Registry(), store, new NativeTransport(fetcher, async () => {})),
    fetcher,
  );
  const collected = Array.from({length: rows}, (_, i) => ({
    id: String(111 + i),
    campaign_id: String(111 + i),
    campaign_name: 'S' + i,
    entity_name: 'S' + i,
    name: 'S' + i,
    objective: 'OUTCOME_SALES',
    metrics: {spend: '123.47', impressions: '987653', clicks: '7657', conversions: '32.5', reach: '1000'},
    result: {value: '32.5', cost_per_result: '3.8', label: 'Purchases'},
  }));
  overview.native.collect = async (source, dates) => ({
    source,
    rows: collected,
    currency: 'USD',
    timezone: 'UTC',
    complete: true,
    collection_complete: true,
    source_kind: 'paid',
    date_range: dates,
    warnings: [],
    lineage: [],
    captured_at: Date.now(),
    result_definition: 'S',
    attribution: 'S',
  });
  overview.native.verifyAccount = async () => undefined;
  const worker = new ReportWorker(
    store,
    async () => ({}),
    (t, kind, input) => overview.work(t, kind, input),
  );
  const run = await overview.handle(
    {
      action: 'run',
      confirmed: true,
      config: {
        contract_version: 'overview-config-v4',
        name: 'P',
        client_name: 'C',
        sources: [
          {
            platform: 'meta',
            account_id: '100',
            connection_id: 'login',
            levels: ['campaign'],
            delivered_only: false,
            report_options: {attribution_windows: ['7d_click', '1d_view']},
          },
        ],
        date_range: {since: '2026-09-01', until: '2026-09-02'},
        metrics: ['spend', 'clicks', 'reach'],
        custom_metrics,
        ...(targets ? {targets} : {}),
      },
    },
    operator,
  );
  const stall = gauge();
  await new Promise(resolve => setTimeout(resolve, 15));
  stall.reset();
  const started = performance.now();
  await worker.once();
  const workerMs = performance.now() - started;
  await new Promise(resolve => setTimeout(resolve, 15));
  const longest = stall.stop(),
    report = await overview.handle({action: 'get', id: run.id, limit: 500}, operator),
    first = report.rows?.[0];
  store.close();
  return {
    state: report.state,
    row_count: report.rows?.length ?? 0,
    error: report.error ?? report.job?.error ?? null,
    worker_ms: workerMs,
    longest_stall_ms: longest,
    custom: Object.fromEntries(Object.entries(first?.metrics ?? {}).filter(([key]) => /^[mpq]\d+$/.test(key))),
    coverage: Object.fromEntries(
      Object.entries(first?.metrics_coverage ?? {})
        .filter(([key]) => /^[mpqb]\d+$/.test(key))
        .map(([key, value]) => [key, value.unavailable_reason ?? null]),
    ),
    provider: {spend: first?.metrics?.spend ?? null, clicks: first?.metrics?.clicks ?? null},
    recommendation: first?.recommendation?.decision ?? null,
  };
}

async function run() {
  if (scenario === 'summary-chain') {
    const custom = validateCustomMetrics(chain(args.length, args.leaf)),
      started = performance.now(),
      summary = reportMetricsSummaryV4([row, {...row}], custom);
    return {
      ms: performance.now() - started,
      reasons: Object.fromEntries(
        Object.entries(summary.metrics_coverage).map(([key, c]) => [key, c.unavailable_reason ?? null]),
      ),
      values: summary.metrics,
    };
  }
  if (scenario === 'advice-chain') {
    const custom = validateCustomMetrics(chain(args.length, 'clicks')),
      started = performance.now(),
      summary = reportMetricsSummaryV4([row], custom),
      advised = recommendationV4(
        {
          ...row,
          metrics: summary.metrics,
          metrics_coverage: summary.metrics_coverage,
          result_groups: summary.result_groups,
        },
        {sales: {target: 1, currency: 'USD', kpi: 'm1', direction: 'higher'}},
        custom,
      );
    return {ms: performance.now() - started, decision: advised.decision};
  }
  if (scenario === 'pipeline') return pipeline(args);
  if (scenario === 'one-pass-deep') {
    // One pass over one row, with the report budget. The numbers under the size bound are calculated until the work is
    // spent; the long formulas that would take half a minute are ended.
    const custom = validateCustomMetrics(deep()),
      started = performance.now(),
      {metrics, limited} = withCalculationBudget(() => calculateMetricsV4(row.metrics, custom));
    return {
      ms: performance.now() - started,
      digits: Object.fromEntries(['b1', 'p2', 'b3', 'p4'].map(key => [key, String(metrics[key] ?? '').length])),
      limited: Object.fromEntries(Object.entries(limited)),
      q_values: Object.fromEntries(Object.entries(metrics).filter(([key]) => key.startsWith('q'))),
    };
  }
  throw new Error('unknown scenario ' + scenario);
}
parentPort.postMessage(await run());

// DEC-01: recommendation correctness. KPI direction comes from metric metadata, zero spend never scales, accounts in
// another currency get their own target, grouped rows share one whole-window recommendation and frozen
// recommendations expire in exports. Synthetic rows and fake fetchers only; no provider or Google request is made.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {ReportWorker} from '../dist/src/worker.js';
import {GoogleSheetsExports, reportTable, exportCsv} from '../dist/src/google-sheets.js';
import {reportPack} from '../dist/src/report-packs.js';
import {
  campaignRecommendation,
  exportedRecommendation,
  kpiDirection,
  metricDefinitions,
  recommendationValidityMs,
  windowRecommendations,
} from '../dist/src/report-metrics.js';

const hour = 3600000,
  connection = 'meta-login';
const refusal = (code, field) => error => {
  assert.equal(error.code, code, error.message);
  if (field) assert.equal(error.details?.field, field, JSON.stringify(error.details));
  return true;
};
/** A paid traffic row with enough clicks for advice; the KPI value is set directly. */
const trafficRow = (metrics = {}, extra = {}) => ({
  campaign_key: 'meta:100:101',
  source_kind: 'paid',
  objective_group: 'traffic',
  complete: true,
  currency: 'USD',
  timezone: 'UTC',
  captured_at: Date.now(),
  date_from: '2026-08-01',
  date_to: '2026-08-07',
  attribution: '7d click',
  result_definition: 'clicks',
  quality: {version: 1, measurement_complete: null},
  metrics: {spend: 100, impressions: 10000, clicks: 500, conversions: 50, ...metrics},
  ...extra,
});
const salesRow = (metrics = {}, extra = {}) =>
  trafficRow(
    {spend: 100, conversions: 20, cpa: 5, ...metrics},
    {objective_group: 'sales', result_definition: 'purchase', ...extra},
  );

test('every formula KPI derives its direction; higher-is-better KPIs are no longer inverted', () => {
  const higher = ['ctr', 'conversion_rate', 'video_completion_rate', 'roas'],
    lower = ['cpc', 'cpm', 'cpa', 'cpl', 'cpi', 'cpv'];
  assert.deepEqual(
    Object.entries(metricDefinitions)
      .filter(([, d]) => d.formula)
      .map(([id]) => id)
      .sort(),
    [...higher, ...lower].sort(),
    'A new formula KPI needs a declared direction in metricDefinitions',
  );
  for (const kpi of [...higher, ...lower]) {
    const better = higher.includes(kpi) ? 'higher' : 'lower',
      worse = better === 'higher' ? 'lower' : 'higher',
      // Twice as good as the target of 10 in the KPI's own direction, and twice as bad.
      good = better === 'higher' ? 20 : 5,
      bad = better === 'higher' ? 5 : 20,
      policy = direction => ({traffic: {kpi, target: 10, currency: 'USD', ...(direction ? {direction} : {})}}),
      decide = (actual, direction) => campaignRecommendation(trafficRow({[kpi]: actual}), policy(direction)).decision;
    assert.equal(kpiDirection(kpi), better, kpi);
    assert.equal(decide(good), 'scale', kpi + ' without direction, outperforming');
    assert.equal(decide(bad), 'reconsider_pause', kpi + ' without direction, underperforming');
    assert.equal(decide(good, better), 'scale', kpi + ' with its own direction');
    assert.equal(decide(bad, better), 'reconsider_pause', kpi + ' with its own direction');
    // An explicit direction still wins over the default.
    assert.equal(decide(good, worse), 'reconsider_pause', kpi + ' with the opposite direction');
    assert.equal(decide(bad, worse), 'scale', kpi + ' with the opposite direction');
  }
  // The review's synthetic case: before DEC-01 a 5% CTR against a 2% target was told to pause, and 5% against 10%
  // was told to scale.
  const ctr = target => campaignRecommendation(trafficRow({ctr: 5}), {traffic: {kpi: 'ctr', target, currency: 'USD'}});
  assert.equal(ctr(2).decision, 'scale');
  assert.equal(ctr(10).decision, 'reconsider_pause');
  // ROAS and cost KPIs keep their earlier behavior.
  assert.equal(campaignRecommendation(salesRow(), {sales: {target: 10, currency: 'USD'}}).decision, 'scale');
  assert.equal(
    campaignRecommendation(salesRow({roas: 4}), {sales: {kpi: 'roas', target: 2, currency: 'USD'}}).decision,
    'scale',
  );
});

test('a KPI without a derivable direction needs one: refused in new targets, held for review in saved ones', async () => {
  const custom = trafficRow({profit: 50});
  const held = campaignRecommendation(custom, {traffic: {kpi: 'profit', target: 10, currency: 'USD'}});
  assert.equal(held.decision, 'needs_review');
  assert.equal(held.evidence.field, 'direction');
  assert.match(held.reason, /direction/);
  assert.equal(
    campaignRecommendation(custom, {traffic: {kpi: 'profit', target: 10, currency: 'USD', direction: 'higher'}})
      .decision,
    'scale',
  );
  for (const kpi of ['profit', 'conversions', 'spend']) assert.equal(kpiDirection(kpi), null, kpi);

  const f = metaFixture({clicks: '500', spend: '100'});
  try {
    const profit = {id: 'profit', label: 'Profit', formula: 'conversion_value - spend', format: 'currency'},
      config = targets => ({...f.config(), custom_metrics: [profit], targets});
    for (const kpi of ['profit', 'conversions'])
      await assert.rejects(
        () =>
          f.overview.handle(
            {action: 'run', confirmed: true, config: config({traffic: {kpi, target: 5, currency: 'USD'}})},
            f.actor,
          ),
        refusal('INVALID_TARGET', 'targets.traffic.direction'),
        kpi,
      );
    // Formula KPIs derive their direction, and an explicit direction makes a custom KPI valid.
    for (const traffic of [
      {kpi: 'ctr', target: 1, currency: 'USD'},
      {kpi: 'profit', target: 5, currency: 'USD', direction: 'higher'},
    ])
      assert.ok((await f.overview.handle({action: 'save', confirmed: true, config: config({traffic})}, f.actor)).id);
    // A definition saved before this rule still runs; its recommendation names the missing field.
    const saved = await f.overview.handle(
      {action: 'save', confirmed: true, config: config({traffic: {kpi: 'ctr', target: 1, currency: 'USD'}})},
      f.actor,
    );
    const stored = f.store.document(f.actor.tenantId, 'overview_view', saved.id);
    f.store.putDocument(
      f.actor.tenantId,
      'overview_view',
      saved.id,
      {...stored, config: {...stored.config, targets: {traffic: {kpi: 'profit', target: 5, currency: 'USD'}}}},
      stored.revision,
    );
    const report = await f.runSaved(saved.id);
    assert.equal(report.state, 'complete', JSON.stringify(report.sources));
    assert.equal(report.rows[0].recommendation.decision, 'needs_review');
    assert.equal(report.rows[0].recommendation.evidence.field, 'direction');
    // Editing it applies the rule.
    const current = f.store.document(f.actor.tenantId, 'overview_view', saved.id);
    await assert.rejects(
      () =>
        f.overview.handle(
          {action: 'save', confirmed: true, id: saved.id, expected_revision: current.revision, config: current.config},
          f.actor,
        ),
      refusal('INVALID_TARGET', 'targets.traffic.direction'),
    );
  } finally {
    f.close();
  }
});

test('zero spend never recommends scaling, and minimum_spend holds advice below it', async () => {
  // Before DEC-01: spend 0 with 20 conversions made CPA 0, which recommended "scale".
  const zero = campaignRecommendation(salesRow({spend: 0, cpa: 0}), {sales: {target: 10, currency: 'USD'}});
  assert.equal(zero.decision, 'insufficient_data');
  assert.match(zero.reason, /No spend/);
  assert.equal(zero.evidence.spend, 0);
  for (const kpi of Object.keys(metricDefinitions).filter(k => kpiDirection(k)))
    for (const direction of [undefined, 'higher', 'lower'])
      assert.notEqual(
        campaignRecommendation(trafficRow({spend: 0, [kpi]: kpi === 'ctr' ? 50 : 0}), {
          traffic: {kpi, target: 10, currency: 'USD', ...(direction ? {direction} : {})},
        }).decision,
        'scale',
        kpi + ' ' + direction,
      );
  const minimum = spend =>
    campaignRecommendation(salesRow({spend, cpa: spend / 20}), {
      sales: {target: 10, currency: 'USD', minimum_spend: 100},
    });
  assert.equal(minimum(50).decision, 'insufficient_data');
  assert.equal(minimum(50).evidence.minimum_spend, 100);
  assert.equal(minimum(150).decision, 'scale');
  // Unknown spend cannot meet a declared minimum; without one, a non-cost KPI is still judged.
  const unknownSpend = trafficRow({spend: null, ctr: 20});
  assert.equal(
    campaignRecommendation(unknownSpend, {traffic: {kpi: 'ctr', target: 10, currency: 'USD', minimum_spend: 1}})
      .decision,
    'insufficient_data',
  );
  assert.equal(
    campaignRecommendation(unknownSpend, {traffic: {kpi: 'ctr', target: 10, currency: 'USD'}}).decision,
    'scale',
  );

  const f = metaFixture({clicks: '500', spend: '100'});
  try {
    for (const minimum_spend of [-1, '10', Number.POSITIVE_INFINITY])
      await assert.rejects(
        () =>
          f.overview.handle(
            {
              action: 'run',
              confirmed: true,
              config: {...f.config(), targets: {traffic: {target: 1, currency: 'USD', minimum_spend}}},
            },
            f.actor,
          ),
        refusal('INVALID_TARGET', 'targets.traffic.minimum_spend'),
        String(minimum_spend),
      );
  } finally {
    f.close();
  }
});

test('accounts in another currency get their own objective target', async () => {
  const usd = salesRow({cpa: 5}),
    sar = salesRow({cpa: 20}, {campaign_key: 'meta:200:201', currency: 'SAR'}),
    objective = {sales: {target: 10, currency: 'USD'}},
    both = {...objective, 'sales:SAR': {target: 40, currency: 'SAR'}};
  // Before DEC-01 the website could only set one currency per objective, so the SAR account always needed review.
  assert.equal(campaignRecommendation(sar, objective).decision, 'needs_review');
  const usdAdvice = campaignRecommendation(usd, both),
    sarAdvice = campaignRecommendation(sar, both);
  assert.equal(usdAdvice.decision, 'scale');
  assert.equal(usdAdvice.evidence.target, 10);
  assert.equal(sarAdvice.decision, 'scale');
  assert.equal(sarAdvice.evidence.target, 40);
  assert.equal(sarAdvice.evidence.currency, 'SAR');
  // A campaign target still beats the currency target, which beats the objective target.
  assert.equal(
    campaignRecommendation(sar, {...both, 'meta:200:201': {target: 10, currency: 'SAR'}}).decision,
    'reconsider_pause',
  );

  const f = metaFixture({clicks: '500', spend: '100'});
  try {
    const run = targets =>
      f.overview.handle({action: 'run', confirmed: true, config: {...f.config(), targets}}, f.actor);
    await assert.rejects(
      () => run({'traffic:SAR': {target: 1, currency: 'USD'}}),
      refusal('INVALID_TARGET', 'targets.traffic:SAR'),
    );
    await assert.rejects(() => run({'bogus:SAR': {target: 1, currency: 'SAR'}}), refusal('INVALID_TARGET'));
    const saved = await f.overview.handle(
      {
        action: 'save_template',
        confirmed: true,
        config: {
          ...f.config(),
          targets: {
            traffic: {target: 1, currency: 'USD'},
            'traffic:SAR': {target: 4, currency: 'SAR'},
            'meta:100:101': {target: 2, currency: 'USD'},
          },
        },
      },
      f.actor,
    );
    // Templates are account-free: the currency target stays, the campaign target does not.
    assert.deepEqual(Object.keys(saved.config.targets).sort(), ['traffic', 'traffic:SAR']);
  } finally {
    f.close();
  }
});

test('grouped periods share one recommendation from the entity’s whole-window additive totals', async () => {
  const day = (date, metrics, quality = {version: 1, measurement_complete: null}) =>
    trafficRow(metrics, {date_from: date, date_to: date, quality, grain: 'daily'});
  const days = () =>
      [
        day('2026-08-01', {spend: 10, clicks: 20, impressions: 1000}),
        day('2026-08-02', {spend: 10, clicks: 20, impressions: 1000}),
        day('2026-08-03', {spend: 10, clicks: 20, impressions: 1000}),
      ].map(row => ({...row, metrics: {...row.metrics, cpc: row.metrics.spend / row.metrics.clicks}})),
    policy = {traffic: {target: 1, currency: 'USD'}};
  // Each day alone has 20 of the 30 clicks a traffic recommendation needs.
  for (const row of days()) assert.equal(campaignRecommendation(row, policy).decision, 'insufficient_data');
  const shared = windowRecommendations(
    days().map(row => ({...row, recommendation: campaignRecommendation(row, policy)})),
    policy,
  );
  for (const row of shared) {
    assert.equal(row.recommendation.decision, 'scale');
    assert.equal(row.recommendation.basis, 'entity_window');
    assert.equal(row.recommendation.evidence.results, 60);
    assert.equal(row.recommendation.evidence.periods, 3);
    assert.equal(row.recommendation.evidence.date_from, '2026-08-01');
    assert.equal(row.recommendation.evidence.date_to, '2026-08-03');
    assert.equal(row.recommendation.evidence.actual, 0.5);
  }
  // One open day holds the whole entity; a different entity is unaffected.
  const open = days();
  open[2] = {...open[2], quality: {open_window: true, window_closes_at: '2026-08-04T00:00:00.000Z'}};
  const other = {...day('2026-08-01', {spend: 0, clicks: 40}), campaign_key: 'meta:100:202'};
  const held = windowRecommendations(
    [...open, other].map(row => ({...row, recommendation: campaignRecommendation(row, policy)})),
    policy,
  );
  assert.deepEqual(
    held.slice(0, 3).map(row => row.recommendation.decision),
    ['wait', 'wait', 'wait'],
  );
  assert.equal(held[3].recommendation.basis, undefined, 'A single-period entity keeps its own recommendation');
  assert.equal(held[3].recommendation.decision, 'insufficient_data');

  // End to end: a daily Meta report with 20 clicks a day.
  const f = metaFixture({clicks: '20', spend: '10'});
  try {
    const report = await f.run({...f.config(), grain: 'daily', date_range: {since: '2026-09-01', until: '2026-09-03'}});
    assert.equal(report.state, 'complete', JSON.stringify(report.sources));
    assert.equal(report.rows.length, 3);
    for (const row of report.rows) {
      assert.equal(row.recommendation.decision, 'scale', JSON.stringify(row.recommendation));
      assert.equal(row.recommendation.basis, 'entity_window');
    }
    assert.equal(report.summary.filter(s => s.decisions.scale === 1).length, 3);
  } finally {
    f.close();
  }
});

test('frozen recommendations carry as_of and expire in tables, CSV, packs and Sheets after valid_until', async t => {
  const captured = Date.now() - hour,
    advice = campaignRecommendation(salesRow({}, {captured_at: captured}), {sales: {target: 10, currency: 'USD'}});
  assert.equal(advice.as_of, captured);
  assert.equal(advice.valid_until, captured + recommendationValidityMs);
  const row = {captured_at: captured, recommendation: advice};
  assert.deepEqual(exportedRecommendation(row, advice.valid_until), {decision: 'scale', reason: advice.reason});
  const expired = exportedRecommendation(row, advice.valid_until + 1);
  assert.equal(expired.decision, 'expired');
  assert.match(expired.reason, /^Expired — refresh before acting\./);
  assert.match(expired.reason, /original decision: scale/);
  // A snapshot from before valid_until existed expires 48 hours after capture.
  const legacy = {captured_at: captured, recommendation: {decision: 'scale', reason: 'Older snapshot'}};
  assert.equal(exportedRecommendation(legacy, captured + recommendationValidityMs).decision, 'scale');
  assert.equal(exportedRecommendation(legacy, captured + recommendationValidityMs + 1).decision, 'expired');

  const f = metaFixture({clicks: '500', spend: '100'});
  try {
    const report = await f.run(f.config());
    assert.equal(report.state, 'complete', JSON.stringify(report.sources));
    const validUntil = report.rows[0].recommendation.valid_until,
      decision = report.rows[0].recommendation.decision,
      column = (now, name = 'Recommendation') => {
        const table = reportTable(report, now);
        return table[1][table[0].indexOf(name)];
      };
    assert.equal(decision, 'scale');
    assert.equal(report.rows[0].recommendation.as_of, report.rows[0].captured_at);
    assert.equal(column(validUntil), 'scale');
    assert.equal(column(validUntil + 1), 'expired');
    assert.match(column(validUntil + 1, 'Reason'), /refresh before acting/);
    assert.equal(reportPack(report, undefined, validUntil).recommendations_expired, false);
    const pack = reportPack(report, undefined, validUntil + 1);
    assert.equal(pack.recommendations_expired, true);
    assert.equal(pack.recommendations_valid_until, new Date(validUntil).toISOString());
    assert.ok(
      pack.limitations.includes(
        'Recommendations in this snapshot have expired. Refresh the report before acting on them.',
      ),
    );

    // Sheets: deliver before expiry, then replay the same delivery after it. The delivery identity is the snapshot
    // as captured, so the replay is recognized instead of conflicting with its own earlier content.
    const sheets = sheetsFixture(f);
    const first = await sheets.exports.write(f.actor, 'destination', report);
    assert.equal(first.state, 'complete');
    assert.equal(sheets.cell(0, 'Recommendation'), 'scale');
    const real = Date.now.bind(Date),
      shift = validUntil + hour - real();
    t.mock.method(Date, 'now', () => real() + shift);
    assert.match(exportCsv(report), /"expired"/);
    const replay = await sheets.exports.write(f.actor, 'destination', report);
    assert.equal(replay.replayed, true, JSON.stringify(replay));
    assert.equal(sheets.batches.length, 1, 'A replay writes nothing');
    // A new destination written after expiry shows the expired state.
    sheets.destination('later');
    assert.equal((await sheets.exports.write(f.actor, 'later', report)).state, 'complete');
    assert.equal(sheets.cell(1, 'Recommendation'), 'expired');
  } finally {
    f.close();
  }
});

/** A Meta traffic account whose insights return one row per requested period with the given values. */
function metaFixture(values) {
  const actor = {tenantId: 'recommendations', userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 73).toString('base64'));
  store.putConnection(
    actor,
    {
      id: connection,
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['100'],
      enabled: true,
      label: 'Synthetic Meta',
      scopes: ['ads_read'],
    },
    {accessToken: 'synthetic'},
  );
  const fetcher = async (raw, init) => {
    const url = new URL(String(raw));
    assert.equal(init?.method ?? 'GET', 'GET', 'Synthetic Meta refuses mutations');
    if (url.hostname !== 'graph.facebook.com') throw Error('Synthetic fixture refuses egress: ' + url.hostname);
    if (!url.pathname.endsWith('/insights'))
      return Response.json({id: 'act_100', account_id: '100', currency: 'USD', timezone_name: 'UTC'});
    const range = JSON.parse(url.searchParams.get('time_range'));
    return Response.json({
      data: [
        {
          account_id: '100',
          campaign_id: '101',
          campaign_name: 'Synthetic traffic',
          objective: 'OUTCOME_TRAFFIC',
          date_start: range.since,
          date_stop: range.until,
          impressions: '10000',
          ...values,
        },
      ],
    });
  };
  const service = new MirrorService(new Registry(), store, new NativeTransport(fetcher, async () => {})),
    overview = new ReportingOverview(service, async () => {
      throw Error('Unexpected Google Sheets request');
    }),
    worker = new ReportWorker(
      store,
      async () => ({}),
      (tenant, kind, input) => overview.work(tenant, kind, input),
    );
  const config = () => ({
    name: 'Synthetic traffic',
    sources: [{platform: 'meta', connection_id: connection, account_id: '100'}],
    date_range: {since: '2026-09-01', until: '2026-09-07'},
    metrics: ['spend', 'clicks', 'cpc'],
    custom_metrics: [],
    targets: {traffic: {target: 1, currency: 'USD'}},
    objectives: [],
  });
  const finish = async queued => {
    assert.equal(await worker.once(), true);
    return overview.handle({action: 'get', id: queued.id}, actor);
  };
  return {
    actor,
    store,
    overview,
    config,
    run: async c => finish(await overview.handle({action: 'run', config: c, confirmed: true}, actor)),
    runSaved: async id => finish(await overview.handle({action: 'run', id, confirmed: true}, actor)),
    close: () => store.close(),
  };
}
/** A synthetic Google Sheets destination that records each batch update; nothing leaves the process. */
function sheetsFixture(f) {
  const batches = [];
  f.store.putConnection(
    f.actor,
    {
      id: 'sheets',
      tenantId: f.actor.tenantId,
      gateway: 'google_sheets_native_action',
      accounts: ['sheet123'],
      enabled: true,
      label: 'Synthetic Sheets',
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    },
    {accessToken: 'synthetic'},
  );
  const destination = (id, sheet = 7) =>
    f.store.putDocument(f.actor.tenantId, 'sheets_destination', id, {
      connection_id: 'sheets',
      spreadsheet_id: 'sheet123',
      sheet_id: sheet + (id === 'destination' ? 0 : 1),
      tab_name: 'Recommendations ' + id,
    });
  destination('destination');
  const fetcher = async (url, init) => {
    const u = new URL(String(url));
    if (u.hostname !== 'sheets.googleapis.com') throw Error('Synthetic Sheets refuses egress: ' + u.hostname);
    if (init?.method === 'POST') {
      const batch = JSON.parse(init.body);
      batches.push(batch);
      return Response.json({spreadsheetId: 'sheet123', replies: batch.requests.map(() => ({}))});
    }
    return Response.json({sheets: []});
  };
  return {
    batches,
    destination,
    exports: new GoogleSheetsExports(f.store, fetcher),
    cell(batch, header) {
      const rows = batches[batch].requests
        .find(r => r.updateCells)
        .updateCells.rows.map(r => r.values.map(v => v.userEnteredValue.numberValue ?? v.userEnteredValue.stringValue));
      return rows[1][rows[0].indexOf(header)];
    },
  };
}

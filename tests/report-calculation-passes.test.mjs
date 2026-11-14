// NF-1 (post-patch validation of the wave 5 Round 2 fixes, residual of F-L9-01): the report worker shares its thread with
// the website and the MCP endpoint. F-L9-01 made the row loop hand the event loop back every 20 ms, but the passes after it
// (the advice for every row, the grouped advice of every entity, the period summaries and the window summaries) each ran
// as one block, so a report of 25,000 rows with 30 custom metrics stopped the thread for seconds. These tests run the
// worker's calculation (calculateSnapshot) with a timer in the same thread and pin the longest stop, pin that slicing the
// passes changes no figure, and pin the work a summary does for many metrics over the same inputs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateSnapshot} from '../dist/src/report-row-assembly.js';
import {reportMetricsSummaryV4, reportSummary, reportWindowSummary} from '../dist/src/report-summary.js';
import {assignRecommendationsV4} from '../dist/src/report-advice-v4.js';
import {evaluateReportFormulaV4, sumReportValuesV4} from '../dist/src/report-math-v4.js';
import {config, packet, row} from './helpers/report-packets.mjs';

const days = ['2026-09-01', '2026-09-02'];
/** Thirty custom metrics, each a sum of base metrics (accepted: at most 30 metrics, 500 characters, 120 tokens). */
const thirty = Array.from({length: 30}, (_, i) => ({
  id: 'k' + (i + 1),
  label: 'K' + (i + 1),
  formula: 'spend+clicks+impressions+conversions+' + (i + 1),
  format: 'decimal',
}));
/** A figure that varies from row to row, so that no sum is trivial. */
const figures = n => ({
  spend: String(1 + ((n * 37) % 9000)) + '.' + String(n % 100).padStart(2, '0'),
  clicks: String(3 + ((n * 31) % 3000)),
  impressions: String(100 + ((n * 7919) % 90000)),
  conversions: String((n % 40) + 0.5),
});
const purchases = {
  id: 'meta:purchases',
  metric: 'purchases',
  label: 'Purchases',
  native_metric: 'actions.purchase',
  aggregation: 'sum',
  unit: 'number',
};
/**
 * `accounts` source packets of `entities` campaigns over two days, collected the way a daily report is: one row for each
 * entity and day, from a paid source captured now, so that the advice has data to judge. `gaps` leaves some figures out,
 * so that rows differ in which metrics they can give; `mixed` gives alternate campaigns another result definition.
 */
function scenario({accounts, entities, gaps = false, mixed = false, custom = thirty, more = {}}) {
  const results = Array.from({length: accounts}, (_, s) =>
    packet(
      'campaign',
      days.flatMap((day, d) =>
        Array.from({length: entities}, (_, i) => {
          const n = s * 100003 + d * 10007 + i,
            metrics = figures(n);
          if (gaps) {
            if (n % 7 === 0) metrics.clicks = null;
            if (n % 11 === 0) metrics.conversions = null;
            if (n % 13 === 0) metrics.impressions = null;
          }
          const definition = mixed && i % 2 ? purchases : undefined;
          return row('campaign', 'c' + i, metrics, {
            report_period: {since: day, until: day},
            ...(definition ? {definition} : {}),
            result: {
              metric: definition?.metric ?? 'leads',
              label: definition?.label ?? 'Leads',
              value: String(2 + (n % 9)),
              cost_per_result: String(1 + (n % 7)) + '.5',
              definition_id: definition?.id ?? 'meta:leads',
            },
          });
        }),
      ),
      {source: {account_id: String(100 + s), source_ref: s}, source_kind: 'paid', captured_at: Date.now()},
    ),
  );
  return {
    results,
    config: config({
      grain: 'daily',
      date_range: {since: days[0], until: days[1]},
      custom_metrics: custom,
      ...more,
    }),
  };
}
/**
 * A 1 ms timer of this thread: the longest time it had to wait is the longest the thread was unable to run anything. A stop
 * that ends with the work is seen by the timer only afterwards, so `stop` lets the timer run once more before it reads.
 */
function stalls() {
  let last = performance.now(),
    gap = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    gap = Math.max(gap, now - last);
    last = now;
  }, 1);
  return {
    async stop() {
      await new Promise(resolve => setTimeout(resolve, 20));
      clearInterval(timer);
      return gap;
    },
  };
}

// 6,000 rows are a quarter of the 25,000-row ceiling of a job. Before the fix the passes after the row loop held the thread
// for about 1.6 s here, each of the three for longer than the bound (the advice 0.85 s, each summary about 0.4 s), and for
// 12 s at 25,000 rows (measured through the worker). The bound is the row loop's: it hands the loop back every 20 ms.
test('NF-1: the advice, summary and window summary passes after row assembly hand the event loop back', async () => {
  const {results, config: c} = scenario({accounts: 3, entities: 1000}),
    timer = stalls(),
    snapshot = await calculateSnapshot(results, c),
    longest = await timer.stop();
  assert.equal(snapshot.rows.length, 6000);
  assert.equal(snapshot.summary.length, 6, 'a summary for each account and day');
  assert.equal(snapshot.windowSummary.length, 3, 'a window summary for each account');
  assert.equal(typeof snapshot.rows[0].metrics.k30, 'string', 'the custom metrics were calculated');
  assert.ok(longest < 250, 'the event loop was stopped for ' + Math.round(longest) + ' ms');
});

for (const [what, shape] of [
  ['rows with gaps and a target on a custom metric', {gaps: true}],
  ['campaigns of one objective with two result definitions', {mixed: true}],
])
  test(`NF-1: slicing the passes changes no figure: ${what} give the one-block functions’ summaries, window summaries and advice`, async () => {
    const {results, config: c} = scenario({
        accounts: 2,
        entities: 60,
        ...shape,
        more: {targets: {leads: {target: 3, currency: 'USD', kpi: 'k3', direction: 'lower'}}},
      }),
      snapshot = await calculateSnapshot(results, c);
    assert.equal(snapshot.rows.length, 240);
    assert.deepEqual(snapshot.summary, reportSummary(snapshot.rows, snapshot.custom, true));
    assert.deepEqual(snapshot.windowSummary, reportWindowSummary(snapshot.rows, snapshot.custom, true));
    const again = snapshot.rows.map(({recommendation, ...rest}) => structuredClone(rest));
    assignRecommendationsV4(again, c.targets, snapshot.custom, true);
    assert.deepEqual(
      again.map(r => r.recommendation),
      snapshot.rows.map(r => r.recommendation),
    );
    // The comparison is not between empty things. With gaps the grouped advice ran, advice differs from row to row and some
    // metrics are known for fewer rows than others; with two result definitions in one objective the last pass over the
    // rows refused to compare their costs.
    if (shape.gaps) {
      assert.ok(snapshot.rows.some(r => r.recommendation.basis === 'entity_window'));
      assert.ok(new Set(snapshot.rows.map(r => r.recommendation.decision)).size > 1);
      const covered = snapshot.summary[0].metrics_coverage.k1;
      assert.ok(covered.known_rows < covered.total_rows);
    }
    if (shape.mixed) assert.ok(snapshot.rows.every(r => /different result definitions/.test(r.recommendation.reason)));
  });

test('NF-1: a summary sums each metric over the rows that have all of its inputs, as if every metric were summed alone', () => {
  // Three families of custom metrics with different inputs, over rows that each lack some: the rows a metric can use
  // differ from family to family, so a sum shared between metrics must be shared only between the same rows.
  const families = [
      ['a', 'spend+clicks+'],
      ['b', 'spend+conversions+'],
      ['c', 'clicks+impressions+conversions+'],
    ],
    custom = families.flatMap(([id, head]) =>
      [1, 2, 3].map(k => ({id: id + k, label: id + k, formula: head + k, format: 'decimal'})),
    ),
    {results} = scenario({accounts: 1, entities: 90, gaps: true, custom}),
    group = results[0].rows.slice(0, 90).map((r, i) => ({
      ...r,
      platform: 'meta',
      account_id: '100',
      currency: 'USD',
      date_from: days[0],
      date_to: days[0],
      row_key: 'k' + i,
    }));
  const summary = reportMetricsSummaryV4(group, custom);
  for (const metric of custom) {
    const inputs = [...new Set(metric.formula.match(/[a-z]+/g))],
      paired = group.filter(r => inputs.every(name => r.metrics[name] !== null && r.metrics[name] !== undefined)),
      values = Object.fromEntries(
        inputs.map(name => [name, sumReportValuesV4(paired.map(r => r.metrics[name])).value]),
      );
    assert.ok(paired.length > 0 && paired.length < group.length, metric.id + ' uses some rows, not all');
    assert.equal(summary.metrics[metric.id], evaluateReportFormulaV4(metric.formula, values).value, metric.id);
    assert.equal(summary.metrics_coverage[metric.id].known_rows, paired.length, metric.id);
  }
});

test('NF-1: thirty custom metrics over the same four inputs read each row’s inputs a few more times, not thirty times more', () => {
  const cells = (reads, count = 200) =>
      Array.from({length: count}, (_, n) => ({
        platform: 'meta',
        account_id: '100',
        currency: 'USD',
        date_from: days[0],
        date_to: days[0],
        metrics: new Proxy(
          {...figures(n), reach: null, frequency: null},
          {
            get(target, key) {
              if (typeof key === 'string') reads[key] = (reads[key] ?? 0) + 1;
              return target[key];
            },
          },
        ),
      })),
    readsOf = custom => {
      const reads = {};
      reportMetricsSummaryV4(cells(reads), custom);
      return reads;
    },
    alone = readsOf([]),
    withThirty = readsOf(thirty);
  // Before the fix each metric summed each of its inputs again: 90 more reads of every row's input for the thirty.
  for (const input of ['spend', 'clicks', 'impressions', 'conversions'])
    assert.ok(
      (withThirty[input] - alone[input]) / 200 <= 6,
      input + ' was read ' + (withThirty[input] - alone[input]) / 200 + ' more times for each row',
    );
});

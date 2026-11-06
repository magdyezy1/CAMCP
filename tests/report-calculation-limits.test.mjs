import test from 'node:test';
import assert from 'node:assert/strict';
import {runBounded} from './helpers/bounded-run.mjs';
import {calculateMetricsV4, evaluateReportFormulaV4, withCalculationBudget} from '../dist/src/report-math-v4.js';
import {reportMetricsSummaryV4} from '../dist/src/report-summary.js';
import {assembleReportRows, reportCustomMetrics, reportNativeFields} from '../dist/src/report-row-assembly.js';
import {validateCustomMetrics} from '../dist/src/report-metrics.js';
import {config, packet, row} from './helpers/report-packets.mjs';

// F-L9-01: a custom metric set that validation accepts must not stop the worker, and with it the website and the MCP
// endpoint, for every tenant. Each scenario runs in a worker thread that the test terminates if it does not finish, so
// a calculation that never ends fails here instead of stopping the run.
const limit = 20000;

test('a 30-metric chain over a non-additive metric (reach) is calculated in linear time', async () => {
  const result = await runBounded('summary-chain', {length: 30, leaf: 'reach'}, limit);
  assert.equal(result.finished, true, 'the summary of a 30-metric chain did not finish');
  assert.ok(result.ms < 1000, 'summary took ' + result.ms + ' ms');
  assert.ok(
    Object.entries(result.reasons)
      .filter(([key]) => /^m\d+$/.test(key))
      .every(([, reason]) => reason === 'non_additive_inputs'),
    'every metric of the chain says why several rows cannot give it a value',
  );
});

test('a 30-metric chain used as a KPI target is walked once per metric for advice', async () => {
  const result = await runBounded('advice-chain', {length: 30}, limit);
  assert.equal(result.finished, true, 'the advice for a 30-metric chain did not finish');
  assert.ok(result.ms < 1000, 'advice took ' + result.ms + ' ms');
  assert.equal(typeof result.decision, 'string');
});

for (const mode of ['A', 'B']) {
  test(`form ${mode} (a 30-metric chain${mode === 'B' ? ' and a custom KPI target' : ''}) through the real worker leaves the event loop free`, async () => {
    const result = await runBounded('pipeline', {mode, length: 30, rows: 3}, limit);
    assert.equal(result.finished, true, 'the report did not finish');
    assert.equal(result.state, 'complete', JSON.stringify(result.error));
    assert.equal(result.row_count, 3);
    assert.ok(result.longest_stall_ms < 1000, 'the event loop was stopped for ' + result.longest_stall_ms + ' ms');
    assert.ok(result.worker_ms < 5000, 'the job took ' + result.worker_ms + ' ms');
  });
}

test('form C, values near the size bound and long formulas, ends with those metrics unavailable and says why', async () => {
  const result = await runBounded('pipeline', {mode: 'C', rows: 1}, limit);
  assert.equal(result.finished, true, 'the report did not finish');
  assert.equal(result.state, 'complete', JSON.stringify(result.error));
  assert.ok(result.longest_stall_ms < 1000, 'the event loop was stopped for ' + result.longest_stall_ms + ' ms');
  assert.ok(result.worker_ms < 5000, 'the job took ' + result.worker_ms + ' ms');
  // p1 = spend^55 is small enough; p2 = p1^30 is not, and everything that uses it is unavailable with its reason.
  assert.notEqual(result.custom.p1, null);
  assert.equal(result.custom.p2, null);
  assert.equal(result.coverage.p2, 'calculation_limit');
  const dependents = Object.entries(result.custom).filter(([key]) => key.startsWith('q'));
  assert.equal(dependents.length, 26);
  assert.ok(
    dependents.every(([, value]) => value === null),
    'no guess for a metric that depends on a limited one',
  );
  assert.ok(
    Object.entries(result.coverage)
      .filter(([key]) => key.startsWith('q'))
      .every(([, reason]) => reason === 'calculation_limit'),
  );
});

// Form D keeps every number under the size bound (3,700 digits), so only the work budget can end it: each of the 26
// formulas multiplies a quotient of two such numbers fifty times, about 12 ms a step, half a minute for one pass.
test('form D, one pass: numbers under the size bound are calculated until the work is spent, then the formulas end', async () => {
  const result = await runBounded('one-pass-deep', {}, limit);
  assert.equal(result.finished, true, 'the pass did not finish: nothing but the work budget bounds this one');
  assert.ok(result.ms < 3000, 'the pass took ' + result.ms + ' ms');
  assert.ok(result.digits.p2 > 3000 && result.digits.p4 > 3000, 'the powers under the bound are calculated');
  const values = Object.entries(result.q_values);
  assert.equal(values.length, 26);
  assert.ok(
    values.every(([, value]) => value === null),
    'no guess for a formula the budget ended: ' + JSON.stringify(result.q_values),
  );
  assert.ok(
    values.every(([key]) => result.limited[key] === 'calculation_limit'),
    'and each says why: ' + JSON.stringify(result.limited),
  );
});

test('form D through the real worker finishes, and what the work budget ended says calculation_limit', async () => {
  const result = await runBounded('pipeline', {mode: 'D', rows: 1}, limit);
  assert.equal(result.finished, true, 'the report did not finish: nothing but the work budget bounds this one');
  assert.equal(result.state, 'complete', JSON.stringify(result.error));
  assert.ok(result.longest_stall_ms < 1000, 'the event loop was stopped for ' + result.longest_stall_ms + ' ms');
  assert.ok(result.worker_ms < 5000, 'the job took ' + result.worker_ms + ' ms');
  // A report's budget is shared by its passes over a row, so once the first pass has spent it the later passes cannot
  // calculate any large number: the figures the provider reported stay, every large derived one is unavailable.
  assert.deepEqual(result.provider, {spend: '123.47', clicks: '7657'});
  const dependents = Object.entries(result.coverage).filter(([key]) => key.startsWith('q'));
  assert.equal(dependents.length, 26);
  assert.ok(
    dependents.every(([key, reason]) => result.custom[key] === null && reason === 'calculation_limit'),
    'unavailable with the reason, never a guess: ' + JSON.stringify(dependents),
  );
});

const spendAndClicks = {spend: '123.47', impressions: '987653', clicks: '7657', conversions: '32.5', reach: '1000'};
/** base is clicks to the 60th (233 digits); huge is base to the 20th (4,660 digits), past the 4,096-digit bound. */
const power = [
  {id: 'base', label: 'b', formula: Array(60).fill('clicks').join('*'), format: 'decimal'},
  {id: 'huge', label: 'h', formula: Array(20).fill('base').join('*'), format: 'decimal'},
];

test('a metric past the size bound is null with the reason, and the metrics that need nothing large still calculate', () => {
  const custom = validateCustomMetrics([
      ...power,
      {id: 'after', label: 'a', formula: 'huge + 1', format: 'decimal'},
      {id: 'plain', label: 'p', formula: 'spend * 2', format: 'decimal'},
    ]),
    result = calculateMetricsV4(spendAndClicks, custom);
  assert.notEqual(result.metrics.base, null, 'a number of 233 digits is fine');
  assert.equal(result.metrics.huge, null, 'twenty of them is 4,660 digits, past the bound');
  assert.equal(result.limited.huge, 'calculation_limit');
  assert.equal(result.metrics.after, null);
  assert.equal(result.limited.after, 'calculation_limit', 'a metric that uses a limited one carries the reason too');
  assert.equal(result.metrics.plain, '246.94');
  assert.equal(result.limited.plain, undefined);
  assert.equal(result.metrics.ctr, '0.775272287', 'the standard metrics are unaffected');
  // A direct evaluation keeps refusing with the precision code, as before.
  assert.throws(
    () => evaluateReportFormulaV4('a*a*a*a*a', {a: '1e999'}),
    error => error.code === 'METRIC_PRECISION_LOSS',
  );
});

test('a report’s calculation budget ends its large-number work, the same way every time, and meters nothing small', () => {
  const custom = validateCustomMetrics([
    {id: 'power', label: 'p', formula: Array(40).fill('spend').join('*'), format: 'decimal'},
    {id: 'again', label: 'a', formula: 'power / spend', format: 'decimal'},
  ]);
  const calculate = limits => withCalculationBudget(() => calculateMetricsV4(spendAndClicks, custom), limits);
  const generous = calculate({work: 1e9, elapsed_ms: 60000}),
    tight = calculate({work: 50, elapsed_ms: 60000}),
    repeat = calculate({work: 50, elapsed_ms: 60000});
  assert.notEqual(generous.metrics.power, null, 'with room, the metric has its value');
  assert.equal(tight.metrics.power, null, 'with the budget spent, it is unavailable');
  assert.equal(tight.limited.power, 'calculation_limit');
  assert.equal(tight.limited.again, 'calculation_limit');
  assert.deepEqual(repeat, tight, 'the work is counted, not timed: the same input ends at the same place');
  assert.equal(tight.metrics.cpc, generous.metrics.cpc, 'small numbers are not metered');
  assert.equal(tight.metrics.ctr, generous.metrics.ctr);
});

test('a report whose calculation time is spent stops calculating further metrics and says so', () => {
  withCalculationBudget(
    () => {
      const states = Array.from({length: 600}, () => calculateMetricsV4(spendAndClicks, []));
      assert.equal(states[0].metrics.ctr, '0.775272287', 'the first rows are calculated');
      assert.deepEqual(states[0].limited, {});
      const last = states.at(-1);
      assert.equal(last.metrics.ctr, null, 'once the time is gone, so is every derived value');
      assert.equal(last.limited.ctr, 'calculation_limit');
      assert.equal(last.metrics.spend, '123.47', 'the figures the provider reported are untouched');
    },
    {work: 1e12, elapsed_ms: 0},
  );
});

test('a summary says calculation_limit in the coverage of a metric it could not calculate', () => {
  const custom = validateCustomMetrics(power),
    cell = {platform: 'x', account_id: '1', currency: 'USD', date_from: 'a', date_to: 'b', metrics: spendAndClicks},
    summary = reportMetricsSummaryV4([cell, {...cell}], custom);
  assert.equal(summary.metrics.huge, null);
  assert.equal(summary.metrics_coverage.huge.unavailable_reason, 'calculation_limit');
  assert.equal(summary.metrics_coverage.ctr.unavailable_reason, undefined);
});

test('a single row’s metric that needs a non-additive input and reaches a bound says calculation_limit', () => {
  // reach is not additive, so these metrics are the single row's own, and several rows give no value for them.
  const custom = validateCustomMetrics([
      {id: 'rbase', label: 'b', formula: Array(60).fill('reach').join('*'), format: 'decimal'},
      {id: 'rhuge', label: 'h', formula: Array(25).fill('rbase').join('*'), format: 'decimal'},
    ]),
    cell = {platform: 'x', account_id: '1', currency: 'USD', date_from: 'a', date_to: 'b', metrics: spendAndClicks},
    one = reportMetricsSummaryV4([cell], custom),
    two = reportMetricsSummaryV4([cell, {...cell}], custom);
  assert.equal(typeof one.metrics.rbase, 'string', 'a number of 180 digits is fine');
  assert.equal(one.metrics_coverage.rbase.unavailable_reason, undefined);
  assert.equal(one.metrics.rhuge, null, 'twenty-five of them are past the bound');
  assert.equal(one.metrics_coverage.rhuge.unavailable_reason, 'calculation_limit');
  assert.equal(two.metrics_coverage.rhuge.unavailable_reason, 'non_additive_inputs', 'several rows still say so');
});

test('assembling many rows hands the event loop back as it goes', async () => {
  // Ten custom metrics over 3,000 rows is a few hundred milliseconds of synchronous work in one block.
  const custom = Array.from({length: 10}, (_, i) => ({
      id: 'k' + i,
      label: 'K' + i,
      formula: 'spend / clicks * ' + (i + 1) + ' + impressions / (clicks + ' + (i + 1) + ')',
      format: 'decimal',
    })),
    rows = Array.from({length: 3000}, (_, i) =>
      row('campaign', 'c' + i, {spend: String(i + 1), clicks: String(i + 3)}),
    ),
    results = [packet('campaign', rows)],
    c = config({custom_metrics: custom}),
    names = reportCustomMetrics(c, reportNativeFields(results));
  let gap = 0,
    last = performance.now(),
    ticks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    gap = Math.max(gap, now - last);
    last = now;
    ticks++;
  }, 1);
  const started = performance.now();
  const assembled = await assembleReportRows(results, c, names);
  const took = performance.now() - started;
  clearInterval(timer);
  assert.equal(assembled.length, 3000);
  assert.ok(took > 100, 'the scenario must be long enough to need a turn (' + took + ' ms)');
  assert.ok(ticks >= 3, 'the event loop ran ' + ticks + ' times during ' + took + ' ms of assembly');
  assert.ok(gap < 250, 'the longest stop was ' + gap + ' ms');
});

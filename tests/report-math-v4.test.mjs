import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateMetricsV4, evaluateReportFormulaV4} from '../dist/src/report-math-v4.js';
import {reportMetricsSummaryV4} from '../dist/src/report-summary.js';

test('v4 row formulas preserve large native decimal text and round only after the full expression', () => {
  assert.deepEqual(evaluateReportFormulaV4('a / b * 1000', {a: '0.000000003', b: '5'}), {
    value: '0.0000006',
    rounded: false,
  });
  assert.deepEqual(evaluateReportFormulaV4('a / b * b', {a: '1', b: '3'}), {value: '1', rounded: false});
  assert.equal(
    evaluateReportFormulaV4('a + b', {a: '9007199254740993.123456789', b: '0.000000001'}).value,
    '9007199254740993.12345679',
  );
  assert.equal(evaluateReportFormulaV4('a - b', {a: '1', b: '3.000000001'}).value, '-2.000000001');
  assert.equal(evaluateReportFormulaV4('-a / b', {a: '3', b: '2000000000'}).value, '-0.000000002');
  assert.equal(evaluateReportFormulaV4('-a / b', {a: '1', b: '2000000000'}).value, '0');
});
test('v4 formula unknowns and zero divisors stay unknown, with bounded calculations and structured precision refusals', () => {
  assert.equal(evaluateReportFormulaV4('a / b', {a: '1', b: '0'}).value, null);
  assert.equal(evaluateReportFormulaV4('a + b', {a: null, b: '0'}).value, null);
  assert.equal(evaluateReportFormulaV4('a / b', {a: '0', b: '10'}).value, '0');
  assert.throws(
    () => evaluateReportFormulaV4('a + b', {a: 9007199254740992, b: '1'}),
    error => error.code === 'METRIC_PRECISION_LOSS',
  );
  assert.throws(
    () => evaluateReportFormulaV4('a*a*a*a*a', {a: '1e999'}),
    error => error.code === 'METRIC_PRECISION_LOSS',
  );
});
test('standard and ordered custom metric references use retained nine-place results without floating point', () => {
  const result = calculateMetricsV4(
    {
      spend: '9007199254740993',
      conversions: '3',
      impressions: '100',
      clicks: '25',
      conversion_value: '9007199254740994',
    },
    [
      {id: 'profit', formula: 'conversion_value - spend'},
      {id: 'triple_cpa', formula: 'cpa * 3'},
    ],
  );
  assert.equal(result.metrics.cpa, '3002399751580331');
  assert.equal(result.metrics.ctr, '25');
  assert.equal(result.metrics.profit, '1');
  assert.equal(result.metrics.triple_cpa, '9007199254740993');
  assert.equal(result.metrics.cpl, null);
});

// F-L5-20: a metric that depends on another starts from its exact fraction and is rounded once, on output. The cost per
// click of 1/3 is shown as 0.333333333, and three of it is 1, not 0.999999999.
const dependent = [
  {id: 'chain', label: 'c', formula: 'cpc * clicks', format: 'number'},
  {id: 'chain_big', label: 'c2', formula: 'cpc * 3000000000', format: 'number'},
  {id: 'chain2', label: 'c3', formula: 'chain * 2', format: 'number'},
];
test('dependent custom metrics keep exact fractions between them and round once, on output', () => {
  const result = calculateMetricsV4({spend: '1', clicks: '3', impressions: '7'}, dependent);
  assert.equal(result.metrics.cpc, '0.333333333', 'the cost per click is shown rounded');
  assert.equal(result.metrics.chain, '1');
  assert.equal(result.metrics.chain_big, '1000000000');
  assert.equal(result.metrics.chain2, '2');
  assert.deepEqual(
    [result.rounding.cpc, result.rounding.chain, result.rounding.chain_big, result.rounding.chain2],
    [1, undefined, undefined, undefined],
    'only the metric that really is rounded says so',
  );
  assert.deepEqual(result.limited, {});
  // The same chain read in the other order of definition still starts from exact values.
  const reversed = calculateMetricsV4({spend: '1', clicks: '3', impressions: '7'}, [...dependent].reverse());
  assert.equal(reversed.metrics.chain_big, '1000000000');
});

test('a summary of rows chains its dependent metrics exactly as a row does', () => {
  const row = metrics => ({
      platform: 'x',
      account_id: '1',
      currency: 'USD',
      date_from: 'a',
      date_to: 'b',
      metrics,
    }),
    summary = reportMetricsSummaryV4(
      [row({spend: '1', clicks: '3', impressions: '7'}), row({spend: '0', clicks: '0', impressions: '0'})],
      dependent,
    );
  assert.equal(summary.metrics.cpc, '0.333333333');
  assert.equal(summary.metrics.chain, '1');
  assert.equal(summary.metrics.chain_big, '1000000000');
  assert.equal(summary.metrics.chain2, '2');
  const rounded = summary.metric_calculation_rounding.rounded_operations;
  assert.equal(rounded.cpc, 1);
  assert.deepEqual([rounded.chain, rounded.chain_big, rounded.chain2], [undefined, undefined, undefined]);
});

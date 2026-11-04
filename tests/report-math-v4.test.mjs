import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateMetricsV4, evaluateReportFormulaV4} from '../dist/src/report-math-v4.js';

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

import test from 'node:test';
import assert from 'node:assert/strict';
import {reportSummary, reportWindowSummary, reportMetricsSummaryV4} from '../dist/src/report-summary.js';
import {groupReportResults, resolveReportResult} from '../dist/src/report-results.js';
import {recommendationV4, assignRecommendationsV4} from '../dist/src/report-advice-v4.js';
import {calculateMetricsV4, compareReportValuesV4, withCalculationBudget} from '../dist/src/report-math-v4.js';

const definition = {
  id: 'fixture:conversions',
  metric: 'conversions',
  label: 'Results',
  native_metric: 'native_count',
  aggregation: 'sum',
  unit: 'number',
};
const row = (spend, count, extra = {}) => {
  const {result, ...context} = resolveReportResult(definition, {value: count, spend}, 'mapped');
  return {
    platform: 'fixture',
    account_id: '1',
    currency: 'SAR',
    timezone: 'UTC',
    source_kind: 'paid',
    captured_at: Date.now(),
    objective_group: 'sales',
    campaign_id: '1',
    campaign_key: 'fixture:1:1',
    date_from: '2026-09-01',
    date_to: '2026-09-02',
    attribution: 'Synthetic verified window',
    result_definition: 'Results',
    complete: true,
    metrics: {spend, conversions: count, reach: '2000'},
    result,
    result_context: context,
    recommendation: {decision: 'needs_review'},
    ...extra,
  };
};
const sparse = () => [row('10', '5'), row('100', null), row(null, '995'), row('0', '5')];
test('v4 summaries sum known decimal values and price only rows where both inputs are known', () => {
  const summary = reportSummary(sparse(), [], true)[0];
  assert.equal(summary.metrics.spend, '110');
  assert.equal(summary.metrics.conversions, '1005');
  assert.equal(summary.metrics.cpa, '1');
  assert.equal(summary.metrics.primary_result, '1005');
  assert.equal(summary.metrics.cost_per_result, '1');
  assert.equal(summary.metrics.reach, null);
  // F-L5-31: one shape for a sum, a formula and a result, and the basis says the counted units are the report's rows.
  assert.deepEqual(summary.metrics_coverage.spend, {
    known_rows: 3,
    total_rows: 4,
    basis: 'report_rows',
    report_rows: 4,
  });
  assert.deepEqual(summary.metrics_coverage.cpa, {
    known_rows: 2,
    total_rows: 4,
    basis: 'report_rows',
    report_rows: 4,
    known_pairs: 2,
  });
  assert.deepEqual(summary.result_groups[0].coverage, {known: 3, total: 4});
  assert.deepEqual(summary.result_groups[0].cost_coverage, {known_pairs: 2, total: 4});
  assert.deepEqual(summary.metrics_coverage.primary_result, {
    known_rows: 3,
    total_rows: 4,
    basis: 'report_rows',
    report_rows: 4,
  });
  assert.deepEqual(summary.metrics_coverage.cost_per_result, {
    known_rows: 2,
    total_rows: 4,
    known_pairs: 2,
    basis: 'report_rows',
    report_rows: 4,
  });
  assert.equal(summary.result_groups[0].cost_coverage.known_pairs, 2);
  assert.deepEqual(summary.result_groups[0].cost_basis, {spend: '10', result: '10'});
});
test('native daily pair coverage survives one entity total and another round of summary grouping', () => {
  const daily = sparse(),
    groups = groupReportResults(
      daily.map(value => ({
        resolved: {definition, result: value.result, ...value.result_context},
        currency: 'SAR',
        scope: 'one-entity',
        spend: value.metrics.spend,
      })),
    ),
    entity = row('110', '1005', {
      native: {exact_rows: daily.map(value => value.metrics)},
      result: groups[0].result,
      result_context: groups[0],
      result_groups: groups,
    }),
    summary = reportMetricsSummaryV4([entity]);
  assert.equal(summary.metrics.cpa, '1');
  assert.equal(summary.metrics.cost_per_result, '1');
  // One report row built from four native daily cells: the counted units are the provider's own, not the report's.
  assert.deepEqual(summary.metrics_coverage.cpa, {
    known_rows: 2,
    total_rows: 4,
    basis: 'native_measurements',
    report_rows: 1,
    known_pairs: 2,
  });
  assert.deepEqual(summary.metrics_coverage.spend, {
    known_rows: 3,
    total_rows: 4,
    basis: 'native_measurements',
    report_rows: 1,
  });
});
test('v4 summary formulas use one known cohort for their complete dependency graph and never sum reach', () => {
  const rows = sparse();
  rows[0].metrics.conversion_value = '20';
  rows[2].metrics.conversion_value = '995';
  rows[3].metrics.conversion_value = '5';
  const summary = reportSummary(
    rows,
    [
      {id: 'profit', formula: 'conversion_value - spend'},
      {id: 'double_profit', formula: 'profit * 2'},
      {id: 'triple_cpa', formula: 'cpa * 3'},
      {id: 'cost_reach', formula: 'spend / reach'},
    ],
    true,
  )[0];
  assert.equal(summary.metrics.profit, '15');
  assert.equal(summary.metrics.double_profit, '30');
  assert.equal(summary.metrics.triple_cpa, '3');
  assert.equal(summary.metrics.cost_reach, null);
  assert.equal(summary.metrics_coverage.cost_reach.unavailable_reason, 'non_additive_inputs');
});
test('currencies, unlike definitions with identical labels and non-additive result windows stay separate', () => {
  const a = row('10', '5'),
    b = row('10', '30'),
    c = row('10', '5', {currency: 'USD'});
  b.result.definition_id = 'fixture:leads';
  b.result_context.definition = {...definition, id: 'fixture:leads'};
  assert.equal(reportSummary([a, b, c], [], true).length, 3);
  const reach = {
      ...definition,
      id: 'fixture:reach',
      metric: 'reach',
      aggregation: 'non_additive',
      cost_multiplier: 1000,
    },
    periods = ['2026-09-01', '2026-09-02'].map(date => {
      const resolved = resolveReportResult(reach, {value: '2000', spend: '10'}, 'mapped');
      return row('10', null, {date_from: date, date_to: date, result: resolved.result, result_context: resolved});
    }),
    summary = reportWindowSummary(periods, [], true)[0];
  assert.equal(summary.result.value, null);
  assert.equal(summary.result_groups[0].unavailable_reason, 'non_additive');
  assert.deepEqual(
    summary.series.map(point => point.spend),
    ['10', '10'],
  );
});
test('exact advisory thresholds retain native costs, known zero results and conservative precision holds', () => {
  assert.equal(compareReportValuesV4('0.3', '0.1', 3), 0);
  const priced = row('10', '20');
  priced.result.cost_per_result = '0.15';
  priced.result_context.cost_source = 'provider';
  const advice = recommendationV4(priced, {sales: {target: 0.1, currency: 'SAR'}});
  assert.equal(advice.decision, 'reconsider_pause');
  assert.equal(advice.evidence.kpi, 'cost_per_result');
  assert.equal(advice.evidence.actual, 0.15);
  assert.equal(recommendationV4(row('0.3', '0'), {sales: {target: 0.1, currency: 'SAR'}}).decision, 'reconsider_pause');
  assert.equal(recommendationV4(row('0', '30'), {sales: {target: 1, currency: 'SAR'}}).decision, 'insufficient_data');
  assert.equal(
    recommendationV4(row('9007199254740993', '30'), {sales: {target: 1, currency: 'SAR'}}).decision,
    'needs_review',
  );
});
// These replace the tests of overviewV4Sum and overviewV4Ratio (F-L5-28): nothing called those two, and the summary is
// what reports use, so the properties they pinned are pinned on it.
const cell = metrics => ({
  platform: 'fixture',
  account_id: '1',
  currency: 'USD',
  date_from: '2026-09-01',
  date_to: '2026-09-02',
  metrics,
});
test('known additive values keep exact decimal text and coverage, and non-additive metrics are never summed', () => {
  const summary = reportMetricsSummaryV4([
    cell({spend: '9007199254740993.123456789', reach: '10'}),
    cell({spend: null, reach: '20'}),
    cell({reach: '30'}),
    cell({spend: '0.000000001'}),
    cell({spend: '0'}),
  ]);
  assert.equal(summary.metrics.spend, '9007199254740993.12345679', 'beyond 2^53 and exact to the ninth place');
  assert.deepEqual(summary.metrics_coverage.spend, {
    known_rows: 3,
    total_rows: 5,
    basis: 'report_rows',
    report_rows: 5,
  });
  assert.equal(summary.metrics.reach, null);
  assert.equal(summary.metrics.frequency, null);
  const sum = values => reportMetricsSummaryV4(values.map(spend => cell({spend}))).metrics.spend;
  assert.equal(sum(['0.0000000015']), '0.000000002', 'half to even at the ninth place: 1.5 becomes 2');
  assert.equal(sum(['0.0000000025']), '0.000000002', 'and 2.5 stays 2');
  assert.equal(sum(['0.0000000005', '0.0000000010']), '0.000000002', 'the sum is exact before it is rounded');
  assert.equal(sum([null]), null);
  assert.deepEqual(reportMetricsSummaryV4([cell({spend: null})]).metrics_coverage.spend.known_rows, 0);
});
test('ratios divide only the rows that have both parts, round half to even and refuse a zero denominator', () => {
  const ratio = rows => reportMetricsSummaryV4(rows.map(metrics => cell(metrics)));
  const summary = ratio([
    {spend: '10', clicks: '5'},
    {spend: '100', clicks: null},
    {spend: null, clicks: '995'},
    {spend: '0', clicks: '5'},
  ]);
  assert.equal(summary.metrics.cpc, '1', 'only the two rows with both parts: 10 / 10');
  assert.equal(summary.metrics_coverage.cpc.known_pairs, 2);
  assert.equal(summary.metrics_coverage.cpc.total_rows, 4);
  assert.equal(ratio([{spend: '1', clicks: '2000000000'}]).metrics.cpc, '0');
  assert.equal(ratio([{spend: '3', clicks: '2000000000'}]).metrics.cpc, '0.000000002');
  assert.equal(ratio([{spend: '10', impressions: '2000'}]).metrics.cpm, '5', 'a per-thousand ratio');
  assert.equal(ratio([{spend: '10', clicks: '0'}]).metrics.cpc, null, 'a zero denominator has no value');
});
test('advice holds while a metric it needs is calculated from some of its rows only (F-L5-31 shape)', () => {
  const policy = {sales: {target: 0.1, currency: 'SAR'}},
    covered = known_rows =>
      row('10', '20', {metrics_coverage: {spend: {known_rows, total_rows: 2, basis: 'report_rows', report_rows: 2}}});
  const partial = recommendationV4(covered(1), policy);
  assert.equal(partial.decision, 'needs_review');
  assert.match(partial.reason, /report metrics are incomplete/);
  assert.notEqual(recommendationV4(covered(2), policy).decision, 'needs_review', 'a complete metric holds nothing');
  // The cost per result is a ratio: its coverage counts the rows that had both parts.
  const ratio = row('10', '20', {
    metrics_coverage: {
      cost_per_result: {known_rows: 1, total_rows: 2, known_pairs: 1, basis: 'report_rows', report_rows: 2},
    },
  });
  assert.match(recommendationV4(ratio, policy).reason, /report metrics are incomplete/);
});
test('advice holds, and the report does not fail, once the report’s calculation time is spent', () => {
  withCalculationBudget(
    () => {
      // The time check runs every 256 formulas; after it fires no formula is calculated.
      for (let i = 0; i < 300; i++) calculateMetricsV4({spend: '1', clicks: '2'}, []);
      const advice = recommendationV4(row('10', '20'), {sales: {target: 0.1, currency: 'SAR'}});
      assert.equal(advice.decision, 'needs_review');
      assert.match(advice.reason, /exceeds supported numeric precision/);
    },
    {work: 1e12, elapsed_ms: 0},
  );
});
test('unbound objective targets do not recommend against different native result meanings', () => {
  const a = row('10', '30'),
    b = row('10', '30', {campaign_key: 'fixture:1:2'});
  b.result.definition_id = 'fixture:leads';
  b.result_context.definition = {...definition, id: 'fixture:leads'};
  const rows = assignRecommendationsV4([a, b], {sales: {target: 1, currency: 'SAR'}}, [], false);
  assert.equal(
    rows.every(value => value.recommendation.decision === 'needs_review'),
    true,
  );
  assert.match(rows[0].recommendation.reason, /different result definitions/);
});

test('one native non-additive measurement remains usable with coverage, while unknown currency stays unpriced', () => {
  const custom = [{id: 'cost_reach', formula: 'spend / reach'}],
    one = reportMetricsSummaryV4([row('10', '5')], custom);
  assert.equal(one.metrics.cost_reach, '0.005');
  assert.equal(one.metrics_coverage.cost_reach.known_pairs, 1);
  assert.equal(one.metrics_coverage.cost_reach.unavailable_reason, undefined);
  const missing = row('10', '5', {currency: null}),
    unknown = reportMetricsSummaryV4([missing], custom);
  assert.equal(unknown.metrics.cost_reach, null);
  assert.equal(unknown.metrics_coverage.cost_reach.unavailable_reason, 'unknown_currency');
  missing.native = {exact_rows: [{spend: '5'}, {spend: '5'}]};
  assert.equal(reportMetricsSummaryV4([missing]).metrics.spend, null, 'unknown monetary units never acquire a total');
});

test('a retained native result for an unpinned goal cannot authorize a recommendation or invented derived cost', () => {
  const unknown = row('10', '5');
  unknown.result_context.unavailable_reason = 'unsupported_goal';
  unknown.result_context.definition = {...definition, aggregation: 'non_additive'};
  unknown.result.cost_per_result = null;
  assert.equal(recommendationV4(unknown, {sales: {target: 10, currency: 'SAR'}}).decision, 'needs_review');
  const summary = reportMetricsSummaryV4([unknown]);
  assert.equal(summary.result.value, '5');
  assert.equal(summary.result.cost_per_result, null);
  assert.equal(summary.result_groups[0].unavailable_reason, 'unsupported_goal');
});

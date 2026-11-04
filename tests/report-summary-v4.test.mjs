import test from 'node:test';
import assert from 'node:assert/strict';
import {reportSummary, reportWindowSummary, reportMetricsSummaryV4} from '../dist/src/report-summary.js';
import {groupReportResults, resolveReportResult} from '../dist/src/report-results.js';
import {recommendationV4, assignRecommendationsV4} from '../dist/src/report-advice-v4.js';
import {compareReportValuesV4} from '../dist/src/report-math-v4.js';

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
  assert.deepEqual(summary.metrics_coverage.spend, {known: 3, total: 4, basis: 'native_measurements', report_rows: 4});
  assert.equal(summary.metrics_coverage.cpa.known_pairs, 2);
  assert.deepEqual(summary.result_groups[0].coverage, {known: 3, total: 4});
  assert.deepEqual(summary.result_groups[0].cost_coverage, {known_pairs: 2, total: 4});
  assert.equal(summary.metrics_coverage.primary_result.total, 4);
  assert.equal(summary.metrics_coverage.cost_per_result.known_pairs, 2);
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
  assert.equal(summary.metrics_coverage.cpa.total, 4);
  assert.equal(summary.metrics_coverage.cpa.report_rows, 1);
  assert.equal(summary.metrics_coverage.cpa.known_pairs, 2);
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

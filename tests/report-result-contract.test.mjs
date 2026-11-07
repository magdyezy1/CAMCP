import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveReportResult,
  unavailableReportResult,
  groupReportResults,
  selectReportResultDefinition,
} from '../dist/src/report-results.js';
import {reportSource} from '../dist/src/report-sources.js';

const conversions = {
  id: 'fixture:conversion',
  metric: 'conversions',
  label: 'Conversions',
  native_metric: 'native_count',
  aggregation: 'sum',
  unit: 'number',
};
test('provider rules preserve the documented conversion/install and LinkedIn objective pairings', () => {
  for (const [platform, context, field] of [
    ['google', {}, 'metrics.conversions'],
    ['microsoft', {}, 'Conversions'],
    ['apple', {}, 'totalMetrics.totalInstalls'],
    ['linkedin', {objective: 'WEBSITE_VISIT'}, 'landingPageClicks'],
    ['linkedin', {objective: 'ENGAGEMENT'}, 'clicks'],
    ['linkedin', {objective: 'VIDEO_VIEW'}, 'videoViews'],
    ['linkedin', {objective: 'LEAD_GENERATION'}, 'oneClickLeads'],
    ['linkedin', {objective: 'WEBSITE_CONVERSION'}, 'externalWebsiteConversions'],
    ['linkedin', {objective: 'TALENT_LEAD'}, 'talentLeads'],
    ['linkedin', {objective: 'JOB_APPLICANT'}, 'landingPageClicks'],
    ['linkedin', {objective: 'BRAND_AWARENESS'}, 'approximateMemberReach'],
    ['linkedin', {objective: 'WEBSITE_VISIT', format: 'SPONSORED_INMAILS'}, 'sends'],
  ]) {
    const selected = selectReportResultDefinition(reportSource(platform).resultRules, context);
    assert.equal(selected.definition.native_metric, field, platform + JSON.stringify(context));
    assert.equal(selected.unavailable_reason, null);
  }
  const reach = selectReportResultDefinition(reportSource('linkedin').resultRules, {
    objective: 'BRAND_AWARENESS',
  }).definition;
  assert.equal(reach.aggregation, 'non_additive');
  assert.equal(reach.cost_multiplier, 1000);
});
test('required unknown native goals cannot fall through, including inherited properties', () => {
  const rules = {selectors: [{field: 'goal', required: true, values: {KNOWN: conversions}}], default: conversions};
  for (const goal of ['new-provider-goal', 'constructor', '__proto__']) {
    const selected = selectReportResultDefinition(rules, {goal});
    assert.equal(selected.definition, null);
    assert.equal(selected.unavailable_reason, 'unsupported_goal');
  }
  assert.equal(selectReportResultDefinition(rules, {}).unavailable_reason, 'missing_goal');
  assert.equal(selectReportResultDefinition(rules, Object.create({goal: 'KNOWN'})).definition, null);
  assert.equal(selectReportResultDefinition(rules, {goal: 'KNOWN'}).definition.id, conversions.id);
  assert.equal(
    selectReportResultDefinition(reportSource('linkedin').resultRules, {objective: 'FUTURE_OBJECTIVE'}).definition,
    null,
  );
});
const row = (value, spend, overrides = {}) => ({
  resolved: resolveReportResult(conversions, {value, spend}, 'mapped'),
  currency: 'SAR',
  scope: 'closed-window',
  spend,
  ...overrides,
});

test('provider results and costs retain exact decimals and prefer a supplied native cost', () => {
  const result = resolveReportResult(conversions, {value: '9007199254740993', spend: '18014398509481986'}, 'mapped');
  assert.equal(result.result.value, '9007199254740993');
  assert.equal(result.result.cost_per_result, '2');
  assert.equal(result.cost_source, 'derived');
  const native = resolveReportResult(conversions, {value: '5', spend: '10', cost_per_result: '1.875'}, 'provider');
  assert.equal(native.result.cost_per_result, '1.875');
  assert.equal(native.cost_source, 'provider');
  assert.equal(
    groupReportResults([{resolved: native, currency: 'SAR', scope: 'one-entity', spend: '10'}])[0].result
      .cost_per_result,
    '1.875',
  );
});
test('absent, blank and dash results stay unknown; an explicit zero is retained without inventing a cost', () => {
  for (const value of [undefined, null, '', '  ', '-', '--']) {
    const result = resolveReportResult(conversions, {value, spend: '10'}, 'provider');
    assert.equal(result.result.value, null);
    assert.equal(result.result.cost_per_result, null);
    assert.equal(result.unavailable_reason, 'missing_metric');
  }
  const zero = resolveReportResult(conversions, {value: '0', spend: '10'}, 'provider');
  assert.equal(zero.result.value, '0');
  assert.equal(zero.result.cost_per_result, null);
  assert.equal(resolveReportResult(conversions, {value: '5', spend: '0'}, 'mapped').result.cost_per_result, '0');
  assert.equal(unavailableReportResult('unverified_native_shape').result.value, null);
});
test('derived costs use nine-place half-even rounding and declared per-thousand units', () => {
  const even = resolveReportResult(conversions, {value: '2000000000', spend: '1'}, 'mapped'),
    odd = resolveReportResult(conversions, {value: '2000000000', spend: '3'}, 'mapped');
  assert.equal(even.result.cost_per_result, '0');
  assert.equal(odd.result.cost_per_result, '0.000000002');
  assert.equal(even.rounding.cost_per_result, 1);
  const reach = {
    ...conversions,
    id: 'fixture:reach',
    metric: 'reach',
    aggregation: 'non_additive',
    cost_multiplier: 1000,
  };
  assert.equal(resolveReportResult(reach, {value: '4000', spend: '5'}, 'mapped').result.cost_per_result, '1.25');
});
test('bad provider values refuse the shape instead of becoming zero or losing precision', () => {
  for (const value of ['bad', '-1', -1, NaN, Infinity])
    assert.throws(() => resolveReportResult(conversions, {value}, 'provider'), {code: 'REPORT_SHAPE_CHANGED'});
  assert.throws(() => resolveReportResult(conversions, {value: Number.MAX_SAFE_INTEGER + 1}, 'provider'), {
    code: 'METRIC_PRECISION_LOSS',
  });
});
test('result groups split definitions, currencies and scopes and expose known-value and paired-cost coverage', () => {
  const groups = groupReportResults([
    row('5', '10'),
    row(null, '20'),
    row('5', null),
    row('2', '8', {currency: 'USD'}),
    row('3', '9', {scope: 'another-window'}),
    row('4', '4', {
      resolved: resolveReportResult({...conversions, id: 'fixture:another-goal'}, {value: '4', spend: '4'}, 'mapped'),
    }),
  ]);
  assert.equal(groups.length, 4);
  const sar = groups.find(
    group => group.currency === 'SAR' && group.scope === 'closed-window' && group.definition.id === conversions.id,
  );
  assert.equal(sar.result.value, '10');
  assert.deepEqual(sar.coverage, {known: 2, total: 3});
  assert.equal(sar.result.cost_per_result, '2');
  assert.deepEqual(sar.cost_coverage, {known_pairs: 1, total: 3});
  assert.equal(groupReportResults([row(null, '0')])[0].result.value, null);
});
test('a bidding selector is optional: an absent or unlisted strategy falls to the default (package results)', () => {
  const value = {...conversions, id: 'fixture:value', metric: 'conversion_value', unit: 'currency'},
    rules = {selectors: [{field: 'bidding', values: {TARGET_ROAS: value}}], default: conversions};
  assert.equal(selectReportResultDefinition(rules, {bidding: 'TARGET_ROAS'}).definition.id, value.id);
  for (const bidding of [undefined, null, '', 'MANUAL_CPC', 'constructor', '__proto__'])
    assert.equal(selectReportResultDefinition(rules, {bidding}).definition.id, conversions.id, String(bidding));
  assert.equal(selectReportResultDefinition(rules, {}).definition.id, conversions.id);
  // The selector reads only its own field: a goal or an objective of the same name does not select it.
  assert.equal(selectReportResultDefinition(rules, {goal: 'TARGET_ROAS'}).definition.id, conversions.id);
  assert.equal(selectReportResultDefinition(rules, {objective: 'TARGET_ROAS'}).definition.id, conversions.id);
});
test('a result counted in money has a return on spend, never a derived cost per result (package results)', () => {
  const money = {...conversions, id: 'fixture:value', metric: 'conversion_value', unit: 'currency'},
    single = resolveReportResult(money, {value: '50', spend: '10'}, 'mapped');
  assert.equal(single.result.value, '50');
  assert.equal(single.result.cost_per_result, null);
  assert.equal(single.cost_source, 'unknown');
  assert.equal(single.unavailable_reason, null);
  // The same inputs on a count still price it: the rule is the unit's, not the arithmetic's.
  assert.equal(resolveReportResult(conversions, {value: '50', spend: '10'}, 'mapped').result.cost_per_result, '0.2');
  // A cost the provider itself supplies is kept as it is.
  const native = resolveReportResult(money, {value: '50', spend: '10', cost_per_result: '0.2'}, 'provider');
  assert.equal(native.result.cost_per_result, '0.2');
  assert.equal(native.cost_source, 'provider');
  const group = groupReportResults([
    row('50', '10', {resolved: single}),
    row('30', '5', {resolved: resolveReportResult(money, {value: '30', spend: '5'}, 'mapped')}),
  ]);
  assert.equal(group.length, 1);
  assert.equal(group[0].result.value, '80');
  assert.equal(group[0].result.cost_per_result, null);
  assert.equal(group[0].cost_source, 'unknown');
  assert.deepEqual(group[0].coverage, {known: 2, total: 2});
  // Money does not add to a count: a different definition is a different group.
  assert.equal(groupReportResults([row('50', '10', {resolved: single}), row('4', '10')]).length, 2);
});
test('non-additive results and unidentified monetary units cannot silently acquire totals', () => {
  const reach = {
    ...conversions,
    id: 'fixture:reach',
    metric: 'reach',
    aggregation: 'non_additive',
    cost_multiplier: 1000,
  };
  const native = value => row(value, '10', {resolved: resolveReportResult(reach, {value, spend: '10'}, 'mapped')});
  const grouped = groupReportResults([native('1000'), native('2000')])[0];
  assert.equal(grouped.result.value, null);
  assert.equal(grouped.result.cost_per_result, null);
  assert.equal(grouped.unavailable_reason, 'non_additive');
  assert.equal(groupReportResults([native('1000')])[0].result.value, '1000');
  const monetary = {...conversions, id: 'fixture:value', unit: 'currency'};
  const unknown = value =>
    row(value, '10', {currency: null, resolved: resolveReportResult(monetary, {value}, 'mapped')});
  assert.equal(groupReportResults([unknown('2'), unknown('3')])[0].unavailable_reason, 'unknown_currency');
  assert.equal(groupReportResults([row('2', '10', {currency: null})])[0].result.cost_per_result, null);
});

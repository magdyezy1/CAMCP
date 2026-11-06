import test from 'node:test';
import assert from 'node:assert/strict';
import {reportLevelReconciliation} from '../dist/src/report-level-reconciliation.js';

const range = {since: '2026-09-01', until: '2026-09-02'};
const packet = (level, more = {}) => ({source: {level}, date_range: range, collection_complete: true, ...more});
const row = (level, spend, more = {}) => ({
  entity_level: level,
  currency: 'SAR',
  timezone: 'UTC',
  metrics: {spend, impressions: '100', clicks: '10', reach: '999999', primary_result: '200'},
  ...more,
});
const packets = [packet('campaign'), packet('adset'), packet('ad')];
const compare = rows => reportLevelReconciliation(rows, packets, ['campaign', 'adset', 'ad']);

test('cross-level evidence compares exact delivery totals, reports the coverage gap and never adds result meanings or reach', () => {
  const comparisons = compare([row('campaign', '100'), row('adset', '100'), row('ad', '97')]);
  assert.equal(comparisons.length, 6);
  assert.equal(comparisons[0].state, 'agree');
  const gap = comparisons.find(value => value.metric === 'spend' && value.comparison.level === 'ad');
  assert.equal(gap.state, 'gap');
  assert.equal(gap.delta, '-3');
  assert.equal(gap.coverage_percent, '97');
  assert.equal(
    comparisons.some(value => ['reach', 'primary_result'].includes(value.metric)),
    false,
  );
  assert.equal(
    compare([row('campaign', '9007199254740993.123456789'), row('adset', '9007199254740993.123456788')])[0].delta,
    '-0.000000001',
  );
});

test('partial metrics, unknown currencies, missing levels and differing windows cannot claim agreement', () => {
  const rows = [
    row('campaign', '100'),
    row('adset', '100', {metrics_coverage: {spend: {known_rows: 1, total_rows: 2}}}),
  ];
  assert.equal(compare(rows)[0].state, 'partial');
  assert.equal(compare(rows)[3].state, 'unavailable');
  const unknown = compare(rows.map(value => ({...value, currency: null})));
  assert.equal(unknown[0].state, 'unavailable');
  assert.equal(unknown[0].unavailable_reason, 'unknown_currency');
  const incomplete = reportLevelReconciliation(
    rows,
    [packet('campaign'), packet('adset', {collection_complete: false})],
    ['campaign', 'adset'],
  );
  assert.equal(incomplete[0].state, 'partial');
  const wrongWindow = reportLevelReconciliation(
    rows,
    [packet('campaign'), packet('adset', {date_range: {since: '2026-09-02', until: '2026-09-02'}})],
    ['campaign', 'adset'],
  );
  assert.equal(wrongWindow[0].state, 'unavailable');
});

test('cross-level checks split currencies, report zero honestly and are absent for a single requested level', () => {
  const rows = ['SAR', 'USD'].flatMap(currency => [row('campaign', '0', {currency}), row('adset', '0', {currency})]);
  const comparisons = reportLevelReconciliation(rows, packets, ['adset', 'campaign']);
  assert.equal(comparisons.length, 6);
  assert.deepEqual([...new Set(comparisons.map(value => value.currency))], ['SAR', 'USD']);
  assert.equal(comparisons[0].state, 'agree');
  assert.equal(comparisons[0].coverage_percent, null, '0/0 is unknown, never invented as 100 percent');
  assert.deepEqual(reportLevelReconciliation(rows, packets, ['ad']), []);
});

// F-L5-25. A provider rounds every money figure to the currency's minor unit, so two sums of such figures agree when they
// differ by no more than half a minor unit for each figure summed on either side. Counts are not rounded: exact.
const spendOf = (currency, campaign, ads, adMore = {}) =>
  reportLevelReconciliation(
    [row('campaign', campaign, {currency}), ...ads.map(value => row('ad', value, {currency, ...adMore}))],
    [packet('campaign'), packet('ad')],
    ['campaign', 'ad'],
  ).find(value => value.metric === 'spend');

test('provider rounding of money reads as agreement, and the delta stays in the output', () => {
  // The audit's case: a campaign of 10.01 beside three ads of 3.34.
  const rounded = spendOf('USD', '10.01', ['3.34', '3.34', '3.34']);
  assert.equal(rounded.state, 'agree');
  assert.equal(rounded.delta, '0.01', 'nothing is hidden: the difference is still reported');
  assert.equal(rounded.tolerance, '0.02', 'four figures, half a cent each');
  assert.equal(rounded.coverage_percent, '100.0999001');
  // The side totals count their rows with the same names as the summaries do.
  assert.deepEqual(rounded.baseline.coverage, {known_rows: 1, total_rows: 1});
  assert.deepEqual(rounded.comparison.coverage, {known_rows: 3, total_rows: 3});
});

test('the bound is half a minor unit for each figure compared, inclusive, and a difference beyond it is a gap', () => {
  // Two figures (the campaign and one ad): 0.01 is the bound.
  const at = spendOf('USD', '10.00', ['10.01']),
    over = spendOf('USD', '10.00', ['10.02']),
    below = spendOf('USD', '10.01', ['10.00']);
  assert.deepEqual([at.state, at.delta, at.tolerance], ['agree', '0.01', '0.01']);
  assert.deepEqual([over.state, over.delta, over.tolerance], ['gap', '0.02', '0.01']);
  assert.deepEqual([below.state, below.delta], ['agree', '-0.01'], 'a shortfall is judged the same way');
  // Each further figure widens it by half a cent: four figures (a campaign and three ads) allow 0.02, not 0.03.
  assert.equal(spendOf('USD', '10.00', ['3.34', '3.34', '3.34']).state, 'agree');
  assert.equal(spendOf('USD', '10.00', ['3.34', '3.34', '3.35']).state, 'gap');
});

test('the currency’s own exponent decides the unit, and a code without one is read as two decimals', () => {
  assert.equal(spendOf('JPY', '1000', ['1001']).state, 'agree', 'JPY has no minor unit: half a yen a figure');
  assert.equal(spendOf('JPY', '1000', ['1001']).tolerance, '1');
  assert.equal(spendOf('JPY', '1000', ['1002']).state, 'gap');
  assert.equal(spendOf('KWD', '10.000', ['10.001']).state, 'agree', 'KWD has three: half a fils a figure');
  assert.equal(spendOf('KWD', '10.000', ['10.002']).state, 'gap');
  assert.equal(spendOf('XYZ', '10.00', ['10.01']).state, 'agree');
  assert.equal(spendOf('XYZ', '10.00', ['10.02']).state, 'gap');
});

test('counts stay exact: one more impression is a gap, with no tolerance', () => {
  const comparisons = reportLevelReconciliation(
    [row('campaign', '10'), row('ad', '10', {metrics: {spend: '10', impressions: '101', clicks: '10'}})],
    [packet('campaign'), packet('ad')],
    ['campaign', 'ad'],
  );
  const impressions = comparisons.find(value => value.metric === 'impressions'),
    clicks = comparisons.find(value => value.metric === 'clicks');
  assert.deepEqual([impressions.state, impressions.delta, impressions.tolerance], ['gap', '1', '0']);
  assert.deepEqual([clicks.state, clicks.delta, clicks.tolerance], ['agree', '0', '0']);
});

test('a figure that sums several native measurements counts each one, and an unavailable comparison has no tolerance', () => {
  // The ad row is 30 daily figures, each rounded by the provider: 31 figures with the campaign's.
  const daily = {metrics_coverage: {spend: {known_rows: 30, total_rows: 30}}};
  assert.equal(spendOf('USD', '100.00', ['100.15'], daily).state, 'agree', '0.15 is inside 31 half cents (0.155)');
  assert.equal(spendOf('USD', '100.00', ['100.15'], daily).tolerance, '0.155');
  assert.equal(spendOf('USD', '100.00', ['100.16'], daily).state, 'gap');
  const unknown = spendOf(null, '100.00', ['100.00']);
  assert.deepEqual([unknown.state, unknown.tolerance, unknown.delta], ['unavailable', null, null]);
});

test('status-filtered levels cannot present different entity populations as provider collection gaps', () => {
  const comparisons = reportLevelReconciliation(
    [row('campaign', '100'), row('adset', '80')],
    [packet('campaign', {scope: {excluded_status_rows: 0}}), packet('adset', {scope: {excluded_status_rows: 1}})],
    ['campaign', 'adset'],
  );
  assert.ok(comparisons.every(value => value.state === 'unavailable'));
  assert.ok(comparisons.every(value => value.unavailable_reason === 'different_status_populations'));
  assert.ok(comparisons.every(value => value.delta === null && value.coverage_percent === null));
});

test('objective-filtered native groups and children cannot claim equivalent delivery populations', () => {
  const rows = [row('campaign', '100'), row('adset', '80')],
    comparisons = reportLevelReconciliation(
      rows,
      [packet('campaign', {rows: [rows[0]]}), packet('adset', {rows: [rows[1], row('adset', '20')]})],
      ['campaign', 'adset'],
    );
  assert.ok(comparisons.every(value => value.state === 'unavailable'));
  assert.ok(comparisons.every(value => value.unavailable_reason === 'different_objective_populations'));
  assert.ok(comparisons.every(value => value.delta === null));
});

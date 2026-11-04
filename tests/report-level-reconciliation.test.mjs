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
  const rows = [row('campaign', '100'), row('adset', '100', {metrics_coverage: {spend: {known: 1, total: 2}}})];
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

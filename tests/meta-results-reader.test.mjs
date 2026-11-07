// Package meta-results (F-L5-12): a v4 Meta row's result is Meta's own `results` entry for the row's optimization goal.
// The rows are synthetic, in the shape the owner's live read recorded (tests/fixtures/meta-results-samples.json and
// docs/records/META-RESULTS-PIN-2026-11-07.md); every expected value was worked out by hand from the rules of the record,
// never read back from the code. Nothing here reaches a provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {nativeReportResult} from '../dist/src/report-native.js';
import {reportSource} from '../dist/src/report-sources.js';
import {assertRefused} from './helpers/assert-refused.mjs';

const samples = JSON.parse(readFileSync(new URL('./fixtures/meta-results-samples.json', import.meta.url), 'utf8'));
const range = {since: '2026-09-01', until: '2026-09-07'};
/** The v4 boundary: `attribution_windows` null is the ad set's own setting, a list is the explicit windows. */
const read = (row, windows = null, report_options = {}) =>
  nativeReportResult('meta', row, {
    level: 'adset',
    range,
    report_options: {attribution_windows: windows, ...report_options},
  });
const brief = resolved => ({
  value: resolved.result.value,
  cost: resolved.result.cost_per_result,
  id: resolved.result.definition_id,
  source: resolved.source,
  cost_source: resolved.cost_source,
  reason: resolved.unavailable_reason,
  omitted: resolved.provider_omitted,
});
const entry = (indicator, values) => ({indicator, ...(values === undefined ? {} : {values})});
const wire = (value, window = 'default') => ({value, attribution_windows: [window]});
/** A row of a goal the mapped table pins: the mapped answer is 3, so a read that ignores `results` is visibly wrong. */
const linkClicks = more => ({
  optimization_goal: 'LINK_CLICKS',
  inline_link_clicks: '3',
  impressions: '1000',
  spend: '6',
  ...more,
});

for (const sample of samples.samples)
  test('Meta results, recorded form: ' + sample.form, () => {
    const resolved = read(sample.row, sample.request.attribution_windows),
      e = sample.expect;
    assert.deepEqual(brief(resolved), {
      value: e.value,
      cost: e.cost_per_result,
      id: e.definition_id,
      source: e.source,
      cost_source: e.cost_source,
      reason: e.reason,
      omitted: e.provider_omitted,
    });
  });

test('Meta results: every indicator of the declared table gives its id, label, aggregation and cost unit', () => {
  assert.equal(samples.indicators.length, 20);
  const windowLess = new Set(['estimated_ad_recallers', 'profile_visit_view', 'total_profile_visits']);
  for (const item of samples.indicators) {
    const row = {
        impressions: '1000',
        spend: '24',
        results: [entry(item.indicator, [windowLess.has(item.indicator) ? {value: '12'} : wire('12')])],
      },
      resolved = read(row),
      d = resolved.definition;
    assert.equal(d.id, item.id, item.indicator);
    assert.equal(d.label, item.label, item.indicator);
    assert.equal(d.aggregation, item.aggregation, item.indicator);
    assert.equal(d.cost_multiplier, item.cost_multiplier, item.indicator);
    assert.equal(d.unit, 'number', item.indicator);
    assert.ok(d.native_metric.includes(item.indicator), 'the evidence names what was read: ' + d.native_metric);
    assert.equal(resolved.source, 'provider', item.indicator);
    assert.equal(resolved.result.value, '12', item.indicator);
    // 24 spent over 12 results; a result priced per 1,000 (reach) is 24 * 1000 / 12.
    assert.equal(resolved.result.cost_per_result, item.cost_multiplier === 1000 ? '2000' : '2', item.indicator);
    assert.equal(resolved.cost_source, 'derived', item.indicator);
  }
});

test('Meta results: different indicators have different definitions, so they are never added', () => {
  const ids = samples.indicators.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
  // An action Meta adds later, and a metric it adds later, are still read, as results of their own.
  assert.equal(
    read({impressions: '1', results: [entry('actions:onsite_conversion.post_save', [wire('4')])]}).definition.id,
    'meta:action:onsite_conversion.post_save',
  );
  assert.equal(
    read({impressions: '1', results: [entry('thruplay_views', [wire('4')])]}).definition.id,
    'meta:result:thruplay_views',
  );
});

test('Meta results: an indicator is bounded before it enters an id, and one outside the bound is an unverified shape', () => {
  for (const indicator of [
    '',
    ' ',
    'actions:',
    ':x',
    'a b',
    'actions:link click',
    'actions:link_click;drop',
    'x'.repeat(400),
    'actions:' + 'x'.repeat(400),
    'a:b:c',
    '<img src=x>',
    'actions:link_click\n',
    '__proto__',
  ]) {
    const resolved = read(linkClicks({results: [entry(indicator, [wire('8')])]}));
    assert.equal(resolved.unavailable_reason, 'unverified_native_shape', JSON.stringify(indicator));
    assert.equal(resolved.result.value, null, JSON.stringify(indicator));
    assert.equal(resolved.definition, null, JSON.stringify(indicator));
  }
});

test('Meta results: a result_action_type set by the person wins over results (rule 1)', () => {
  const row = {
    optimization_goal: 'OFFSITE_CONVERSIONS',
    impressions: '1000',
    spend: '12',
    results: [entry('actions:link_click', [wire('99')])],
    actions: [{action_type: 'purchase', value: '3'}],
  };
  const resolved = read(row, null, {result_action_type: 'purchase'});
  assert.deepEqual(brief(resolved), {
    value: '3',
    cost: '4',
    id: 'meta:action:purchase',
    source: 'mapped',
    cost_source: 'derived',
    reason: null,
    omitted: undefined,
  });
});

test('Meta results: absent or empty results fall back to the mapped table, labelled mapped (rule 2)', () => {
  for (const results of [undefined, []]) {
    const resolved = read(linkClicks(results === undefined ? {} : {results}));
    assert.equal(resolved.source, 'mapped');
    assert.equal(resolved.result.value, '3');
    assert.equal(resolved.definition.native_metric, 'inline_link_clicks');
    assert.equal(resolved.result.cost_per_result, '2');
    // A goal the table does not pin stays an unsupported goal; it is not blamed on the shape of results.
    assert.equal(
      read({optimization_goal: 'OFFSITE_CONVERSIONS', impressions: '1000', ...(results ? {results} : {})})
        .unavailable_reason,
      'unsupported_goal',
    );
  }
});

const hostile = [
  ['null', null],
  ['a string', 'oops'],
  ['a number', 7],
  ['an object', entry('actions:link_click', [wire('8')])],
  ['a null entry', [null]],
  ['a number entry', [7]],
  ['an array entry', [[entry('actions:link_click', [wire('8')])]]],
  ['an entry without an indicator', [{values: [wire('8')]}]],
  ['an indicator that is not a string', [{indicator: 7, values: [wire('8')]}]],
  ['a second entry', [entry('actions:link_click', [wire('8')]), entry('actions:link_click', [wire('8')])]],
  ['a second entry of another indicator', [entry('actions:link_click', [wire('8')]), entry('reach', [wire('8')])]],
  ['values that are not an array', [entry('actions:link_click', 'x')]],
  ['values that are an object', [entry('actions:link_click', {value: '8'})]],
  ['a value that is not an object', [entry('actions:link_click', ['8'])]],
  ['a null value entry', [entry('actions:link_click', [null])]],
  ['a value entry without value', [entry('actions:link_click', [{attribution_windows: ['default']}])]],
  ['a value that is not a decimal', [entry('actions:link_click', [wire('abc')])]],
  ['a negative value', [entry('actions:link_click', [wire('-1')])]],
  ['an empty value', [entry('actions:link_click', [wire('')])]],
  ['a dash value', [entry('actions:link_click', [wire('-')])]],
  ['a null value', [entry('actions:link_click', [{value: null, attribution_windows: ['default']}])]],
  ['a boolean value', [entry('actions:link_click', [{value: true, attribution_windows: ['default']}])]],
  ['a value with a comma', [entry('actions:link_click', [wire('1,5')])]],
  ['windows that are a string', [entry('actions:link_click', [{value: '8', attribution_windows: 'default'}])]],
  ['an empty window list', [entry('actions:link_click', [{value: '8', attribution_windows: []}])]],
  [
    'an entry naming two windows',
    [entry('actions:link_click', [{value: '8', attribution_windows: ['default', '7d_click']}])],
  ],
  ['a window that is not a string', [entry('actions:link_click', [{value: '8', attribution_windows: [7]}])]],
  ['two default entries', [entry('actions:link_click', [wire('8'), wire('9')])]],
];
test('Meta results: a results shape that is not the one recorded is unknown, never a throw and never a guess (rule 3)', () => {
  for (const [name, results] of hostile) {
    let resolved;
    assert.doesNotThrow(() => (resolved = read(linkClicks({results}))), name);
    assert.deepEqual(
      [
        resolved.unavailable_reason,
        resolved.result.value,
        resolved.result.cost_per_result,
        resolved.source,
        resolved.definition,
      ],
      ['unverified_native_shape', null, null, 'unknown', null],
      name,
    );
  }
  // The same rows under explicit windows, where a repeated requested window is as ambiguous as a repeated default.
  const twice = [entry('actions:link_click', [wire('4', '7d_click'), wire('5', '7d_click')])];
  assert.equal(read(linkClicks({results: twice}), ['7d_click']).unavailable_reason, 'unverified_native_shape');
  for (const [name, results] of hostile)
    assert.doesNotThrow(() => read(linkClicks({results}), ['7d_click', '1d_view']), name);
});

test('Meta results: a malformed cost is ignored, never fatal, and the cost then comes from spend (rule 6)', () => {
  const values = [wire('3')];
  for (const [name, cost] of [
    ['not an array', 'oops'],
    ['an object', entry('actions:link_click', [wire('2')])],
    ['two entries', [entry('actions:link_click', [wire('2')]), entry('actions:link_click', [wire('2')])]],
    ['another indicator', [entry('reach', [wire('2')])]],
    ['not a decimal', [entry('actions:link_click', [wire('abc')])]],
    ['negative', [entry('actions:link_click', [wire('-2')])]],
    ['values not an array', [entry('actions:link_click', 'x')]],
    ['a null entry', [null]],
    ['no entry for the default', [entry('actions:link_click', [wire('2', '7d_click')])]],
    ['indicator only', [entry('actions:link_click')]],
  ]) {
    let resolved;
    assert.doesNotThrow(
      () => (resolved = read(linkClicks({results: [entry('actions:link_click', values)], cost_per_result: cost}))),
      name,
    );
    assert.deepEqual(
      [resolved.result.value, resolved.result.cost_per_result, resolved.cost_source],
      ['3', '2', 'derived'],
      name,
    );
  }
  const given = read(
    linkClicks({
      results: [entry('actions:link_click', values)],
      cost_per_result: [entry('actions:link_click', [wire('1.75')])],
    }),
  );
  assert.deepEqual(
    [given.result.cost_per_result, given.cost_source],
    ['1.75', 'provider'],
    'a good cost is Meta’s own',
  );
});

test('Meta results: counts add exactly, with no float in the sum', () => {
  const resolved = read(
    {
      impressions: '1',
      spend: '9007199254740994',
      results: [
        entry('actions:link_click', [
          wire('9007199254740993', '7d_click'),
          wire('1', '1d_view'),
          wire('9007199254740994'),
        ]),
      ],
    },
    ['7d_click', '1d_view'],
  );
  assert.equal(resolved.result.value, '9007199254740994');
  // The sum equals the default, so the cost would be Meta's; none was sent, and spend over value is exactly 1.
  assert.equal(resolved.result.cost_per_result, '1');
});

test('Meta results: the cost of a sum of windows is Meta’s default cost only when the sum is the default value', () => {
  const costs = [entry('actions:link_click', [wire('9', '7d_click'), wire('8', '1d_view'), wire('7')])],
    windows = ['7d_click', '1d_view'],
    results = total => [entry('actions:link_click', [wire('20', '7d_click'), wire('5', '1d_view'), wire(total)])];
  assert.deepEqual(
    brief(read(linkClicks({spend: '40', results: results('25'), cost_per_result: costs}), windows)).cost,
    '7',
  );
  assert.deepEqual(
    brief(read(linkClicks({spend: '40', results: results('25'), cost_per_result: costs}), windows)).cost_source,
    'provider',
  );
  const other = brief(read(linkClicks({spend: '40', results: results('26'), cost_per_result: costs}), windows));
  assert.deepEqual([other.value, other.cost, other.cost_source], ['25', '1.6', 'derived']);
  // Several windows and no default entry at all: nothing to compare the sum with, so the cost comes from spend.
  const noDefault = [entry('actions:link_click', [wire('20', '7d_click'), wire('5', '1d_view')])];
  const bare = brief(read(linkClicks({spend: '40', results: noDefault, cost_per_result: costs}), windows));
  assert.deepEqual([bare.value, bare.cost, bare.cost_source], ['25', '1.6', 'derived']);
});

test('Meta results: with explicit windows and no requested window in the values, the action entry’s own window keys count (rule 5)', () => {
  const only = [entry('actions:landing_page_view', [wire('90')])],
    row = actions => ({
      optimization_goal: 'LANDING_PAGE_VIEWS',
      impressions: '1000',
      spend: '170',
      results: only,
      actions,
    });
  const keys = {action_type: 'landing_page_view', value: '90', '7d_click': '70', '1d_view': '15'};
  assert.equal(read(row([keys]), ['7d_click', '1d_view']).result.value, '85');
  assert.equal(read(row([keys]), ['7d_click']).result.value, '70', 'a window that was not requested is not added');
  assert.equal(read(row([keys]), ['1d_click']).result.value, '0', 'a requested window with no key counts 0');
  assert.equal(
    read(row([keys]), ['1d_click']).provider_omitted,
    true,
    'and the row delivered, so the zero is one Meta left out',
  );
  assert.equal(
    read({...row([keys]), impressions: '0'}, ['1d_click']).result.value,
    null,
    'a row that did not deliver stays unknown',
  );
  // Without explicit windows the same row is the default value.
  assert.equal(read(row([keys]), null).result.value, '90');
  // No action entry for the indicator: the metric has no window split, so default is the value.
  assert.equal(read(row([{action_type: 'link_click', value: '9', '7d_click': '9'}]), ['7d_click']).result.value, '90');
  assert.equal(read(row(undefined), ['7d_click']).result.value, '90');
  // An actions list that cannot be read cleanly does not fall back to the default setting’s number under a window label.
  for (const actions of ['oops', [null], [keys, keys], [{value: '5'}]])
    assert.equal(
      read(row(actions), ['7d_click']).unavailable_reason,
      'unverified_native_shape',
      JSON.stringify(actions),
    );
});

test('Meta results: several entries and no default under the ad set’s own setting is unknown, one named default is read', () => {
  const several = [entry('actions:link_click', [wire('4', '7d_click'), wire('5', '1d_view')])];
  assert.equal(read(linkClicks({results: several})).unavailable_reason, 'unverified_native_shape');
  const withDefault = [entry('actions:link_click', [wire('4', '7d_click'), wire('5', '1d_view'), wire('9')])];
  assert.equal(read(linkClicks({results: withDefault})).result.value, '9');
  // One entry that names a window other than default, under the ad set’s own setting: neither rule applies.
  assert.equal(
    read(linkClicks({results: [entry('actions:link_click', [wire('4', '7d_click')])]})).unavailable_reason,
    'unverified_native_shape',
  );
  // Explicit windows and no default and no requested window: nothing to read.
  assert.equal(
    read(linkClicks({results: [entry('actions:link_click', [wire('4', '1d_view')])]}), ['7d_click']).unavailable_reason,
    'unverified_native_shape',
  );
});

test('Meta results: the reader is the source’s own, and its pinned fallback table is unchanged', () => {
  const source = reportSource('meta');
  assert.equal(typeof source.readResult, 'function');
  assert.deepEqual(Object.keys(source.resultRules.selectors[0].values).sort(), [
    'APP_INSTALLS',
    'IMPRESSIONS',
    'LEAD_GENERATION',
    'LINK_CLICKS',
    'POST_ENGAGEMENT',
    'REACH',
  ]);
});

test('Meta results: a malformed result_action_type is still refused with its code', () => {
  assert.throws(
    () =>
      read(linkClicks({results: [entry('actions:link_click', [wire('8')])]}), null, {result_action_type: '__proto__'}),
    e => assertRefused(e, 'INVALID_REPORT_SOURCE'),
  );
});

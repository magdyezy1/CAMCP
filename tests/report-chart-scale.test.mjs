// V2-EXP-01: the arithmetic every chart renderer shares. Ticks, labels and shares are exact decimal text computed on the
// server (BigInt, never a binary double), so a label a reader sees is never a floating-point artefact.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assignChartColors,
  chartColorIndex,
  chartMeasureColor,
  compareChartDecimals,
  formatChartNumber,
  formatFixed,
  parseChartDecimal,
  percentText,
  zeroBasedScale,
} from '../dist/src/report-chart-scale.js';

const scale = max => zeroBasedScale(parseChartDecimal(max));
const objectiveGroups = [
  'awareness',
  'traffic',
  'engagement',
  'video_views',
  'leads',
  'sales',
  'app_installs',
  'unknown',
];

test('ticks start at zero and step by 1, 2 or 5 times a power of ten, in exact decimal text', () => {
  // At most four intervals: 9 would need five steps of 2, so the step is 5.
  const cases = [
    ['9', ['0', '5', '10']],
    ['8', ['0', '2', '4', '6', '8']],
    ['10', ['0', '5', '10']],
    ['3', ['0', '1', '2', '3']],
    ['4', ['0', '1', '2', '3', '4']],
    ['87', ['0', '50', '100']],
    ['61', ['0', '20', '40', '60', '80']],
    ['1234.5', ['0', '500', '1000', '1500']],
    ['0.85', ['0', '0.5', '1']],
    ['0.3', ['0', '0.1', '0.2', '0.3']],
    ['0.000000003', ['0', '0.000000001', '0.000000002', '0.000000003']],
    // A step may be a fraction of the finest unit the data was reported in.
    ['0.000000001', ['0', '0.0000000005', '0.000000001']],
    ['12345678901234567890', ['0', '5000000000000000000', '10000000000000000000', '15000000000000000000']],
  ];
  for (const [max, ticks] of cases) {
    const s = scale(max);
    assert.equal(s.min, '0', max);
    assert.deepEqual(s.ticks, ticks, 'ticks for ' + max);
    assert.equal(s.max, ticks.at(-1), 'the scale ends at its last tick for ' + max);
    assert.ok(compareChartDecimals(parseChartDecimal(s.max), parseChartDecimal(max)) >= 0, 'the data fits in ' + max);
  }
});

test('no tick or label is ever written with a float artefact, exponent or trailing zero', () => {
  for (const max of ['0.1', '0.2', '0.7', '1.1', '2.3', '14.9', '99.99', '0.0004', '123456.789', '1', '1000000']) {
    const s = scale(max);
    for (const tick of s.ticks)
      assert.match(tick, /^(0|[1-9][0-9]*(\.[0-9]*[1-9])?|0\.[0-9]*[1-9])$/, tick + ' for ' + max);
    for (const label of s.tick_labels)
      assert.match(label, /^(0|[1-9][0-9]{0,2}(,[0-9]{3})*(\.[0-9]*[1-9])?|0\.[0-9]*[1-9])$/, label + ' for ' + max);
    assert.equal(s.ticks.length, s.tick_labels.length);
    assert.ok(compareChartDecimals(parseChartDecimal(s.max), parseChartDecimal(max)) >= 0, 'the data fits in ' + max);
  }
});

test('a scale has at most four intervals, and its max is the smallest nice value that holds the data', () => {
  for (let n = 1; n <= 400; n++) {
    const s = scale(String(n));
    assert.ok(s.ticks.length - 1 <= 4, n + ' has ' + s.ticks.length + ' ticks');
    assert.ok(Number(s.max) >= n, n + ' fits in ' + s.max);
    // Smallest: one interval fewer would not hold it.
    assert.ok(Number(s.max) - Number(s.ticks[1]) < n, n + ' does not need ' + s.max);
    // Every tick is a whole multiple of the first.
    s.ticks.forEach((tick, index) => assert.equal(Number(tick), index * Number(s.ticks[1])));
  }
});

test('an all-zero data set still has a scale from zero to one', () => {
  const s = scale('0');
  assert.deepEqual(s.ticks, ['0', '1']);
  assert.equal(s.max, '1');
});

test('tick labels group thousands with commas and use Latin digits', () => {
  assert.deepEqual(scale('1234567').tick_labels, ['0', '500,000', '1,000,000', '1,500,000']);
  assert.deepEqual(scale('87').tick_labels, ['0', '50', '100']);
  assert.equal(formatChartNumber('1234567.891'), '1,234,567.891');
  assert.equal(formatChartNumber('-1234.5'), '-1,234.5');
  assert.equal(formatChartNumber('0.50'), '0.5');
  assert.equal(formatChartNumber('0007'), '7');
});

test('a fixed number of places rounds half up on the exact text', () => {
  assert.equal(formatFixed('1234.5', 2), '1,234.50');
  assert.equal(formatFixed('1.005', 2), '1.01');
  assert.equal(formatFixed('0.1', 0), '0');
  assert.equal(formatFixed('0.5', 0), '1');
  assert.equal(formatFixed('999.995', 2), '1,000.00');
  assert.equal(formatFixed('12', 3), '12.000');
  assert.equal(formatFixed('1234.5678', 3), '1,234.568');
});

test('a percentage is an exact decimal quotient, cut like the website cuts it, with more digits where a cut would read 0 or 100', () => {
  const share = (a, b, places = 1) => percentText(parseChartDecimal(a), parseChartDecimal(b), places);
  assert.equal(share('1', '3'), '33.3');
  assert.equal(share('2', '3'), '66.6');
  assert.equal(share('1', '8'), '12.5');
  assert.equal(share('5', '5'), '100');
  assert.equal(share('0', '5'), '0');
  assert.equal(share('5', '0'), null);
  // A share that is not 100 is never shown as 100, and one that is not 0 is never shown as 0.
  assert.equal(share('99999', '100000'), '99.9');
  assert.equal(share('999999', '1000000'), '99.9');
  assert.equal(share('1', '100000'), '0.001');
  assert.equal(share('1', '3', 0), '33');
});

test('only plain decimals parse: no exponent, NaN, signs in the middle or empty text', () => {
  for (const good of ['0', '12', '0.5', '123456789012345678901234567890.123456789', '-3', '007']) {
    assert.ok(parseChartDecimal(good), good);
  }
  for (const bad of [
    '',
    ' ',
    '1e3',
    'NaN',
    'Infinity',
    '1.',
    '.5',
    '1,000',
    '--1',
    '1 2',
    null,
    undefined,
    {},
    [],
    true,
  ]) {
    assert.equal(parseChartDecimal(bad), null, String(bad));
  }
  // A finite number is accepted as its shortest plain text; an exponent form is not.
  assert.equal(parseChartDecimal(12.5)?.units, 125n);
  assert.equal(parseChartDecimal(1e21), null);
  assert.equal(parseChartDecimal(1e-7), null);
  assert.equal(parseChartDecimal('-3')?.units, -3n);
});

test('decimals compare exactly across different numbers of places', () => {
  const c = (a, b) => compareChartDecimals(parseChartDecimal(a), parseChartDecimal(b));
  assert.equal(c('1.50', '1.5'), 0);
  assert.equal(c('0.1', '0.10000000000000001'), -1);
  assert.equal(c('9007199254740993', '9007199254740992'), 1);
  assert.equal(c('-1', '0'), -1);
});

test('a key keeps its colour: the home slot depends on the key and nothing else, and the eight objectives use all three hues', () => {
  const homes = objectiveGroups.map(chartColorIndex);
  for (const home of homes) assert.ok([0, 1, 2].includes(home), String(home));
  assert.equal(new Set(homes).size, 3);
  assert.deepEqual(
    objectiveGroups.map(chartColorIndex),
    homes,
    'the same key gives the same slot every time, in any order',
  );
  assert.equal(chartColorIndex('Spring — حملة'), chartColorIndex('Spring — حملة'));
});

test('two series displayed together never share a colour, whatever the order they arrive in', () => {
  for (let a = 0; a < objectiveGroups.length; a++)
    for (let b = a + 1; b < objectiveGroups.length; b++) {
      const two = assignChartColors([objectiveGroups[a], objectiveGroups[b]]);
      assert.notEqual(two[0], two[1], objectiveGroups[a] + ' ' + objectiveGroups[b]);
      for (let c = b + 1; c < objectiveGroups.length; c++) {
        const keys = [objectiveGroups[a], objectiveGroups[b], objectiveGroups[c]],
          three = assignChartColors(keys);
        assert.equal(new Set(three).size, 3, keys.join(' '));
        assert.deepEqual(assignChartColors([keys[2], keys[0], keys[1]]), [three[2], three[0], three[1]]);
        assert.deepEqual(assignChartColors([keys[1], keys[2], keys[0]]), [three[1], three[2], three[0]]);
      }
    }
  // A series that is alone keeps its home slot.
  for (const key of objectiveGroups) assert.deepEqual(assignChartColors([key]), [chartColorIndex(key)]);
  assert.throws(() => assignChartColors(['a', 'b', 'c', 'd']), /three/);
});

test('a filter that removes a series does not repaint a survivor whose home slot nobody else wants', () => {
  const distinct = [];
  for (const key of objectiveGroups)
    if (!distinct.some(other => chartColorIndex(other) === chartColorIndex(key))) distinct.push(key);
  assert.equal(distinct.length, 3);
  const all = assignChartColors(distinct);
  assert.deepEqual(all, distinct.map(chartColorIndex));
  for (let drop = 0; drop < 3; drop++) {
    const left = distinct.filter((_, index) => index !== drop),
      after = assignChartColors(left);
    left.forEach((key, index) => assert.equal(after[index], all[distinct.indexOf(key)], key + ' keeps its colour'));
  }
});

test('measures have their own fixed colour, so spend is the same hue in every chart', () => {
  assert.equal(chartMeasureColor('spend'), 0);
  assert.equal(chartMeasureColor('primary_result'), 1);
  assert.equal(chartMeasureColor('cost_per_result'), 2);
  assert.equal(chartMeasureColor('some_other_metric'), chartColorIndex('some_other_metric'));
});

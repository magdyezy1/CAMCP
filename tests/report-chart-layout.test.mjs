// V2-EXP-01: the geometry every renderer draws. One layout turns a chart spec into marks with coordinates (bars from the
// baseline, a line over periods, a stack of segments, a grid of key figures); the SVG, the PDF and the page draw that scene,
// so what these tests pin - bars start at zero, nothing leaves the chart, a short period is a hollow mark off the line, the
// layout mirrors in Arabic while time stays left to right - holds for all three.
import test from 'node:test';
import assert from 'node:assert/strict';
import {chartLayout, chartDateLabel, chartTextWidth, fitChartText} from '../dist/src/report-chart-layout.js';
import {reportCharts} from '../dist/src/report-charts.js';
import {chartRow, keyFigures, money, names, parts} from './helpers/chart-rows.mjs';

const charts = (rows, more) => reportCharts(parts(rows, more), {platformNames: names});
const of = (specs, kind) => specs.filter(spec => spec.kind === kind);
const campaigns = spends => spends.map((spend, index) => chartRow('c' + (index + 1), String(spend)));
const layout = (spec, width = 480, language = 'en') =>
  chartLayout(spec, {width, language, t: text => (language === 'ar' ? 'ع:' + text : text)});
const marks = (scene, role) => scene.items.filter(item => item.role === role);
const week = (date, id, spend, more = {}) =>
  chartRow(id, spend, '1', {date_from: date, date_to: date, grain: 'weekly', ...more});
const weekly = rows => charts(rows, {config: {grain: 'weekly'}});
const r2 = value => Math.round(value * 100) / 100;

/** One of each drawn shape, with the awkward text: a name that is too long, an Arabic one and one that is markup. */
const hostile = [
  'A very long campaign name that will not fit on a narrow screen at all',
  'Short',
  'x',
  'مرحبا بالعالم',
  '</svg><script>alert(1)</script>',
];
const barsSpec = () =>
  of(
    charts(
      campaigns([1234567.89, 98765.43, 5000, 12.5, 3]).map((row, index) => ({...row, campaign_name: hostile[index]})),
    ),
    'spend_by_entity',
  )[0];
const costSpec = () =>
  of(
    charts([chartRow('a', '100', '10'), chartRow('b', '100', null)], {
      config: {targets: {leads: {target: 12, currency: 'USD'}}},
    }),
    'cost_vs_target',
  )[0];
const stackSpec = () => {
  const group = (id, objective, spend, platform, account) =>
    chartRow(id, spend, '1', {objective_group: objective, platform, account_id: account});
  return of(
    charts([
      group('s1', 'sales', '100', 'meta', '100'),
      group('l1', 'leads', '60', 'meta', '100'),
      group('t1', 'traffic', '1', 'meta', '100'),
      group('s2', 'sales', '40', 'google', '200'),
      group('l2', 'leads', '20', 'google', '200'),
    ]),
    'spend_by_objective',
  )[0];
};
const eightWeeks = [
  '2026-09-07',
  '2026-09-14',
  '2026-09-21',
  '2026-09-28',
  '2026-10-05',
  '2026-10-12',
  '2026-10-19',
  '2026-10-26',
];
const lineSpec = (dates = eightWeeks) =>
  of(
    weekly(dates.map((date, index) => week(date, 'a', String([10, 80, 40, 25, 60, 5, 90, 33][index % 8])))),
    'trend',
  ).find(item => item.title.text === 'Spend over time');
const tilesSpec = () => keyFigures([money('a', '120'), money('b', '80')], [money('a', '100'), money('b', '50')])[0];

/** The box a mark covers; text by its estimated width, the way the layout itself places it. */
function boundsOf(item) {
  if (item.t === 'rect') return {left: item.x, right: item.x + item.w, top: item.y, bottom: item.y + item.h};
  if (item.t === 'line')
    return {
      left: Math.min(item.x1, item.x2),
      right: Math.max(item.x1, item.x2),
      top: Math.min(item.y1, item.y2),
      bottom: Math.max(item.y1, item.y2),
    };
  if (item.t === 'circle')
    return {left: item.cx - item.r, right: item.cx + item.r, top: item.cy - item.r, bottom: item.cy + item.r};
  if (item.t === 'polyline') {
    const xs = item.points.map(point => point[0]),
      ys = item.points.map(point => point[1]);
    return {left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys)};
  }
  const width = chartTextWidth(item.text, item.size),
    left = item.anchor === 'left' ? item.x : item.anchor === 'right' ? item.x - width : item.x - width / 2;
  return {left, right: left + width, top: item.y - item.size, bottom: item.y + 3};
}

test('text is measured by one function, and a label that is too long is cut with an ellipsis, never clipped', () => {
  assert.equal(chartTextWidth('', 12), 0);
  assert.ok(chartTextWidth('Campaign', 12) > chartTextWidth('Camp', 12));
  assert.equal(chartTextWidth('abc', 24), chartTextWidth('abc', 12) * 2);
  assert.equal(fitChartText('Short', 200, 12), 'Short');
  const long = 'A campaign name that is far longer than the room it has been given on a phone';
  const fitted = fitChartText(long, 120, 12);
  assert.ok(fitted.endsWith('…') && fitted.length < long.length, fitted);
  assert.ok(chartTextWidth(fitted, 12) <= 120);
  assert.equal(fitChartText('x', 3, 12), '…', 'not even one letter fits: only the ellipsis');
});

test('dates read as month and day in English and Arabic, with Latin digits, and with the year when a series spans years', () => {
  assert.equal(chartDateLabel('2026-09-07', 'en', false), 'Sep 7');
  assert.equal(chartDateLabel('2026-09-07', 'en', true), 'Sep 7, 2026');
  assert.equal(chartDateLabel('2026-12-31', 'ar', false), '31 ديسمبر');
  assert.equal(chartDateLabel('2027-01-02', 'ar', true), '2 يناير 2027');
  assert.equal(chartDateLabel('not a date', 'en', false), 'not a date');
  assert.equal(
    chartDateLabel('2026-13-01', 'en', false),
    '2026-13-01',
    'a month that does not exist is left as it came',
  );
});

test('bars start at the baseline and their lengths are the values’ shares of the scale, exactly', () => {
  const [spec] = of(charts(campaigns([100, 50, 25])), 'spend_by_entity'),
    scene = layout(spec, 480),
    bars = marks(scene, 'bar'),
    axis = marks(scene, 'axis')[0];
  assert.equal(bars.length, 3);
  assert.ok(
    bars.every(bar => bar.x === axis.x1),
    'every bar starts at the baseline',
  );
  // The scale holds 100 in 100 (ticks 0 50 100); the widths are in the proportions 1 : 1/2 : 1/4 (to a hundredth of a pixel).
  const [a, b, c] = bars.map(bar => bar.w);
  assert.ok(Math.abs(b - a / 2) <= 0.02 && Math.abs(c - a / 4) <= 0.02, [a, b, c].join(' '));
  assert.ok(
    bars.every(bar => bar.h > 0 && bar.h <= 24),
    'bars are at most 24px thick',
  );
  // Rows run top to bottom in the order of the spec and never overlap.
  const ys = bars.map(bar => bar.y);
  assert.deepEqual(
    [...ys].sort((p, q) => p - q),
    ys,
  );
  assert.ok(ys.every((y, index) => index === 0 || y - ys[index - 1] >= 24));
});

test('a value of zero draws no bar but is still labelled, and an unknown value says there is no data', () => {
  const rows = [chartRow('a', '30'), chartRow('b', '0'), chartRow('c', '10')],
    scene = layout(of(charts(rows), 'spend_by_entity')[0]);
  assert.equal(marks(scene, 'bar').length, 2);
  assert.deepEqual(
    marks(scene, 'value').map(item => item.text),
    ['30.00', '10.00', '0.00'],
  );
  const costScene = layout(costSpec());
  assert.deepEqual(
    marks(costScene, 'nodata').map(item => item.text),
    ['No data'],
  );
  // The target (12) of the campaign that has a cost (10) is marked beyond the end of its bar; the campaign with no cost
  // has no bar for a mark to belong to, and the table has its target.
  const [bar] = marks(costScene, 'bar'),
    targets = marks(costScene, 'target');
  assert.equal(targets.length, 1);
  assert.equal(targets[0].i, 0);
  assert.ok(targets[0].x1 > bar.x + bar.w, 'the target lies beyond a cost that is under it');
  assert.equal(targets[0].x1, targets[0].x2, 'a target is a vertical mark across its bar');
  assert.ok(targets[0].y1 < bar.y && targets[0].y2 > bar.y + bar.h, 'it reaches past the bar on both sides');
});

test('nothing leaves the chart: every mark lies inside the width at every width down to a phone, for every shape and both languages', () => {
  const shapes = {bars: barsSpec(), cost: costSpec(), stack: stackSpec(), line: lineSpec(), tiles: tilesSpec()};
  for (const [name, spec] of Object.entries(shapes))
    for (const language of ['en', 'ar'])
      for (const width of [320, 375, 480, 640, 960]) {
        const scene = layout(spec, width, language);
        assert.equal(scene.width, width);
        assert.ok(scene.items.length > 0, `${name} ${language} ${width}`);
        for (const item of scene.items) {
          const box = boundsOf(item);
          const where = `${name} ${language} ${width} ${item.role} ${JSON.stringify(item).slice(0, 140)}`;
          assert.ok(box.left >= -0.01 && box.right <= width + 0.01, where);
          assert.ok(box.top >= -0.01 && box.bottom <= scene.height + 0.01, where + ' (vertical)');
        }
      }
});

test('a name that does not fit is cut with an ellipsis on a phone and whole where there is room', () => {
  const spec = barsSpec(),
    longest = scene => marks(scene, 'label')[0].text;
  assert.ok(longest(layout(spec, 320)).endsWith('…'));
  assert.equal(longest(layout(spec, 960)), hostile[0]);
  // What the page shows is still the whole name: the cut is the picture's, the spec and the table keep the text.
  assert.equal(spec.x.items[0].label, hostile[0]);
});

test('in Arabic the layout mirrors: bars grow from the right, labels sit at the right edge, and names are translated', () => {
  const spec = of(charts(campaigns([100, 50, 25])), 'spend_by_entity')[0],
    en = layout(spec, 480, 'en'),
    ar = layout(spec, 480, 'ar');
  assert.equal(ar.rtl, true);
  assert.equal(en.rtl, false);
  const enBars = marks(en, 'bar'),
    arBars = marks(ar, 'bar');
  arBars.forEach((bar, index) => {
    assert.equal(bar.w, enBars[index].w, 'the same length');
    assert.equal(r2(bar.x + bar.w), r2(480 - enBars[index].x), 'mirrored about the middle');
    assert.equal(bar.round, 'left', 'the rounded data end is on the left');
    assert.equal(enBars[index].round, 'right');
  });
  const arLabel = marks(ar, 'label')[0],
    enLabel = marks(en, 'label')[0];
  assert.equal(enLabel.anchor, 'left');
  assert.equal(arLabel.anchor, 'right');
  assert.equal(r2(arLabel.x), r2(480 - enLabel.x));
  // A name AMCP wrote is said in Arabic; a name a provider wrote is not touched.
  const other = of(charts(campaigns([100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 5, 4])), 'spend_by_entity')[0];
  assert.ok(marks(layout(other, 480, 'ar'), 'label').some(item => item.text === 'ع:Other'));
  assert.ok(marks(layout(other, 480, 'ar'), 'label').some(item => item.text === 'Campaign c1'));
});

test('text that has Arabic letters in an Arabic report reads right to left; numbers and Latin names keep their own direction', () => {
  const ar = layout(barsSpec(), 480, 'ar'),
    label = text => marks(ar, 'label').find(item => item.text === text);
  assert.equal(label('مرحبا بالعالم').rtl, true);
  assert.equal(label('Short').rtl, false);
  assert.ok(
    marks(ar, 'value').every(item => item.rtl === false),
    'a number is never reordered',
  );
  assert.ok(
    layout(barsSpec(), 480, 'en')
      .items.filter(item => item.t === 'text')
      .every(item => item.rtl === false),
  );
});

test('a line is drawn over its periods left to right in both languages, a short period is a hollow mark off the line, a gap is a gap', () => {
  const weeks = ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'],
    rows = [
      ...weeks.flatMap((date, index) => ['a', 'b'].map(id => week(date, id, index === 1 && id === 'a' ? null : '20'))),
      week('2026-09-14', 'x', '5', {currency: 'EUR'}),
    ];
  const spec = of(weekly(rows), 'trend').find(item => item.context.currency === 'USD'),
    series = spec.series[0];
  assert.deepEqual(series.short.map(Boolean), [false, true, false, false]);
  for (const language of ['en', 'ar']) {
    const scene = layout(spec, 480, language),
      points = marks(scene, 'point'),
      hollow = marks(scene, 'hollow'),
      lines = marks(scene, 'line');
    // Whole periods 1, 3 and 4 are solid; period 2 (one of two campaigns unknown) is hollow; the line joins 3 and 4 only.
    assert.equal(points.length, 3, language);
    assert.equal(hollow.length, 1, language);
    assert.equal(lines.length, 1, language);
    assert.equal(lines[0].points.length, 2);
    const xs = [points[0], hollow[0], points[1], points[2]].map(item => item.cx);
    assert.deepEqual(
      [...xs].sort((p, q) => p - q),
      xs,
      language + ': periods run left to right in both languages',
    );
    assert.ok(hollow[0].cy > points[0].cy, 'the short week sits lower, off the line');
    // Every y is inside the plot: nothing is clipped above or below.
    for (const item of [...points, ...hollow]) assert.ok(item.cy >= 0 && item.cy <= scene.height);
  }
  const en = layout(spec, 480, 'en'),
    ar = layout(spec, 480, 'ar');
  const tick = scene =>
    marks(scene, 'tick')
      .filter(item => /^\d/.test(item.text) && !item.text.includes(' '))
      .map(item => item.x);
  assert.ok(tick(en)[0] < 100, 'English puts the value axis on the left');
  assert.ok(tick(ar)[0] > 380, 'Arabic puts the value axis on the right');
});

test('the date labels of a line never overlap, and the last period is always labelled', () => {
  const spec = lineSpec();
  for (const language of ['en', 'ar'])
    for (const width of [320, 375, 480, 960]) {
      const scene = layout(spec, width, language),
        dates = marks(scene, 'tick').filter(item => item.anchor === 'center');
      assert.ok(dates.length >= 2, `${language} ${width}`);
      const boxes = dates.map(boundsOf);
      for (let index = 1; index < boxes.length; index++)
        assert.ok(
          boxes[index].left - boxes[index - 1].right >= 8,
          `${language} ${width} labels ${index - 1} and ${index} touch`,
        );
      const last = chartDateLabel('2026-10-26', language, false);
      assert.equal(dates.at(-1).text, last, `${language} ${width}: the last period is named`);
      assert.equal(dates[0].text, chartDateLabel('2026-09-07', language, false), 'and so is the first');
    }
  // Dates that span a year carry it.
  const spanning = layout(lineSpec(['2026-12-21', '2026-12-28', '2027-01-04']), 960),
    labels = marks(spanning, 'tick').filter(item => item.anchor === 'center');
  assert.deepEqual(
    labels.map(item => item.text),
    ['Dec 21, 2026', 'Dec 28, 2026', 'Jan 4, 2027'],
  );
});

test('the value axis of a line starts at zero and the highest point never touches the top', () => {
  const rows = ['2026-09-07', '2026-09-14', '2026-09-21'].map((date, index) =>
    week(date, 'a', ['10', '80', '40'][index]),
  );
  const [spec] = weekly(rows).filter(item => item.kind === 'trend' && item.title.text === 'Spend over time'),
    scene = layout(spec, 480),
    ys = marks(scene, 'point').map(item => item.cy),
    baseline = marks(scene, 'axis')[0];
  assert.ok(Math.max(...ys) < baseline.y1, 'the lowest point is above the zero line');
  assert.ok(Math.min(...ys) > 8, 'the highest point leaves room for its label');
  assert.equal(marks(scene, 'tick')[0].text, '0');
});

test('a stack: segments from the baseline in order, a 2px gap between neighbours, a legend for every series, labels only where they fit', () => {
  const spec = stackSpec(),
    scene = layout(spec, 480);
  const segments = marks(scene, 'segment'),
    meta = segments.filter(segment => segment.i === 0);
  assert.equal(meta.length, 3);
  assert.equal(meta[0].x, marks(scene, 'axis')[0].x1, 'the first segment starts at the baseline');
  for (let k = 1; k < meta.length; k++) {
    const gap = r2(meta[k].x - (meta[k - 1].x + meta[k - 1].w));
    assert.equal(gap, 2, 'neighbouring segments are 2px apart');
  }
  assert.equal(marks(scene, 'legend-text').length, 3, 'a legend entry for each series');
  assert.equal(marks(scene, 'legend-swatch').length, 3);
  // The sliver for traffic (1 of 160) has no room for a label; the others do.
  const inside = marks(scene, 'inside');
  assert.ok(inside.some(item => item.s === 0 && item.i === 0));
  assert.ok(!inside.some(item => item.s === 2 && item.i === 0));
  assert.deepEqual(
    marks(scene, 'total').map(item => item.text),
    ['161.00', '60.00'],
  );
  // Only the last segment of a stack has a rounded data end, and a sliver too thin to hold the rounding stays square.
  assert.deepEqual(
    segments.filter(segment => segment.i === 1).map(segment => segment.round),
    [null, 'right'],
  );
  assert.deepEqual(
    meta.map(segment => segment.round),
    [null, null, null],
  );
});

test('a stack in Arabic mirrors about the middle too, and its legend keeps the order of the series', () => {
  const spec = stackSpec(),
    en = layout(spec, 480, 'en'),
    ar = layout(spec, 480, 'ar');
  const enSegments = marks(en, 'segment'),
    arSegments = marks(ar, 'segment');
  arSegments.forEach((segment, index) => {
    assert.equal(r2(segment.x + segment.w), r2(480 - enSegments[index].x));
    assert.equal(segment.s, enSegments[index].s, 'the same series in the same row');
  });
  assert.deepEqual(
    marks(ar, 'legend-text').map(item => item.s),
    marks(en, 'legend-text').map(item => item.s),
  );
});

test('key figures lay out as a grid of tiles: name, value and currency, then the change in words, one height for every tile', () => {
  const plain = keyFigures([money('a', '120'), money('b', '80')])[0],
    moved = tilesSpec();
  // Five tiles on one row from 600px, three across from 420px, two across on a phone.
  const rowsOf = scene => new Set(marks(scene, 'kpi-value').map(item => item.y)).size;
  assert.equal(rowsOf(layout(plain, 960)), 1);
  assert.equal(rowsOf(layout(plain, 480)), 2);
  assert.equal(rowsOf(layout(plain, 320)), 3);
  const scene = layout(moved, 960);
  assert.deepEqual(
    marks(scene, 'kpi-label').map(item => item.text),
    ['Spend', 'Impressions', 'Clicks', 'Results', 'Cost per result'],
  );
  assert.deepEqual(
    marks(scene, 'kpi-value').map(item => item.text),
    moved.series.map(series => series.value_labels[0]),
  );
  assert.ok(
    marks(scene, 'kpi-value').every(item => item.size === 22 && item.bold),
    'the value is the largest text',
  );
  assert.deepEqual(
    marks(scene, 'kpi-unit').map(item => item.text),
    ['USD', 'USD'],
    'only the amounts in money say their currency',
  );
  // The change is in words that the server wrote, under the value, with the sign of the change and nothing coloured.
  assert.deepEqual(
    marks(scene, 'kpi-change').map(item => item.text),
    ['+50.00 (+33.33%)', '+500 (+33.33%)', '0 (0%)'],
  );
  assert.deepEqual(
    marks(scene, 'kpi-caption').map(item => item.text),
    Array(3).fill('Since the previous period'),
  );
  assert.ok(layout(moved, 960).height > layout(plain, 960).height, 'the change takes a line');
  assert.equal(marks(layout(plain, 960), 'kpi-change').length, 0, 'no baseline, no change');
  // An unknown figure is said so, never drawn as zero.
  const unknown = keyFigures([money('a', null)])[0];
  assert.ok(marks(layout(unknown, 960), 'kpi-value').some(item => item.text === 'No data'));
});

test('key figures in Arabic: tiles run from the right, the caption is translated, the numbers keep their direction', () => {
  const spec = tilesSpec(),
    en = layout(spec, 960, 'en'),
    ar = layout(spec, 960, 'ar');
  const enLabels = marks(en, 'kpi-label'),
    arLabels = marks(ar, 'kpi-label');
  arLabels.forEach((item, index) => {
    assert.equal(item.anchor, 'right');
    assert.equal(r2(item.x), r2(960 - enLabels[index].x));
  });
  assert.equal(marks(ar, 'kpi-caption')[0].text, 'ع:Since the previous period');
  assert.ok(marks(ar, 'kpi-change').every(item => item.rtl === false && /^[-+\d]/.test(item.text)));
  assert.ok(marks(ar, 'kpi-value').every(item => item.rtl === false));
});

test('a figure that is too wide for its tile is set smaller, never cut: a number is read whole', () => {
  const huge = keyFigures([money('a', '123456789012.34')])[0],
    value = marks(layout(huge, 320), 'kpi-value')[0];
  assert.equal(value.text, huge.series[0].value_labels[0], 'the whole figure');
  assert.ok(value.size < 22 && value.size >= 12, 'set smaller, not below the 12px a reader can read: ' + value.size);
  assert.ok(marks(layout(huge, 960), 'kpi-value')[0].size > value.size, 'larger where there is more room');
  assert.equal(
    marks(layout(keyFigures([money('a', '1234.56')])[0], 960), 'kpi-value')[0].size,
    22,
    'full size when it fits',
  );
  // Every figure of the tile row fits its cell: the widest estimate never exceeds a cell's width.
  for (const item of marks(layout(huge, 320), 'kpi-value'))
    assert.ok(chartTextWidth(item.text, item.size) <= (320 - 8 - 8) / 2);
});

test('every mark carries the hue it is drawn in, decided once here: a series keeps its hue, Other is neutral, ink follows the fill', () => {
  // Bars: the measure's hue (spend 0), the combined remainder neutral.
  const many = of(charts(campaigns([100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 5, 4])), 'spend_by_entity')[0],
    manyBars = marks(layout(many), 'bar'),
    otherIndex = many.x.items.findIndex(item => item.other);
  assert.ok(otherIndex >= 0);
  manyBars.forEach(bar => assert.equal(bar.color, bar.i === otherIndex ? null : many.series[0].color_index));
  assert.equal(many.series[0].color_index, 0, 'spend is the first hue wherever it is drawn');
  assert.ok(
    marks(layout(costSpec()), 'bar').every(bar => bar.color === 2),
    'cost per result keeps the third hue',
  );
  // A stack: each segment, each legend swatch and the label inside a segment are of their series' hue. Five objectives
  // fold into the three largest and Other.
  const objectives = {sales: '100', leads: '80', traffic: '60', awareness: '20', engagement: '10'},
    stack = of(
      charts(
        Object.entries(objectives).map(([objective, spend]) =>
          chartRow(objective, spend, '1', {objective_group: objective}),
        ),
      ),
      'spend_by_objective',
    )[0],
    scene = layout(stack);
  for (const item of [...marks(scene, 'segment'), ...marks(scene, 'legend-swatch')])
    assert.equal(item.color, stack.series[item.s].color_index, item.role + ' of series ' + item.s);
  for (const item of marks(scene, 'inside')) assert.equal(item.color, stack.series[item.s].color_index);
  assert.ok(
    stack.series.some(series => series.color_index === null),
    'the stack has an Other series',
  );
  assert.ok(marks(scene, 'segment').some(item => item.color === null));
  // A line: the series' hue for the line and every mark on it.
  const line = lineSpec(),
    lineScene = layout(line);
  for (const item of [...marks(lineScene, 'point'), ...marks(lineScene, 'line')])
    assert.equal(item.color, line.series[0].color_index);
});

test('a chart that is not drawn has no layout', () => {
  const [one] = of(charts(campaigns([30])), 'spend_by_entity');
  assert.equal(one.drawn, false);
  assert.equal(chartLayout(one, {width: 480, language: 'en', t: text => text}), null);
});

test('the layout is a pure function: the same spec and width give the same scene, and the spec is not changed', () => {
  const spec = of(charts(campaigns([100, 50, 25])), 'spend_by_entity')[0],
    before = JSON.stringify(spec);
  assert.deepEqual(layout(spec, 480), layout(spec, 480));
  assert.deepEqual(layout(spec, 320), layout(spec, 320));
  assert.notDeepEqual(layout(spec, 320), layout(spec, 480));
  assert.equal(JSON.stringify(spec), before);
});

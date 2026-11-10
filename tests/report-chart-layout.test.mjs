// V2-EXP-01: the geometry every renderer draws. One layout turns a chart spec into marks with coordinates (bars from the
// baseline, a line over periods, a stack of segments, a grid of key figures); the SVG, the PDF and the page draw that scene,
// so what these tests pin - bars start at zero, nothing leaves the chart, a short period is a hollow mark off the line, the
// layout mirrors in Arabic while time stays left to right - holds for all three.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chartDateLabel,
  chartLayout,
  chartTextWidth,
  fitChartText,
  sceneInDrawingOrder,
  wrapChartText,
} from '../dist/src/report-chart-layout.js';
import {chartRow, keyFigures, money} from './helpers/chart-rows.mjs';
import {
  barsSpec,
  bigTilesSpec,
  campaigns,
  charts,
  costSpec,
  foldedBarsSpec,
  foldedStackSpec,
  hostile,
  lineSpec,
  of,
  shortLineSpec,
  stackSpec,
  tilesSpec,
  week,
  weekly,
} from './helpers/chart-specimens.mjs';

const layout = (spec, width = 480, language = 'en') =>
  chartLayout(spec, {width, language, t: text => (language === 'ar' ? 'ع:' + text : text)});
const marks = (scene, role) => scene.items.filter(item => item.role === role);
const r2 = value => Math.round(value * 100) / 100;

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

/** The pairs of text marks whose boxes overlap, each described. A little air is allowed: a box is the text's own extent. */
function textOverlaps(scene) {
  const texts = scene.items.filter(item => item.t === 'text'),
    found = [];
  texts.forEach((a, index) => {
    for (const b of texts.slice(index + 1)) {
      const p = boundsOf(a),
        q = boundsOf(b),
        across = Math.min(p.right, q.right) - Math.max(p.left, q.left),
        down = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
      if (across > 0.5 && down > 1) found.push(`${a.role} "${a.text}" and ${b.role} "${b.text}"`);
    }
  });
  return found;
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

const everyShape = () => ({
  bars: barsSpec(),
  folded: foldedBarsSpec(),
  cost: costSpec(),
  stack: stackSpec(),
  'folded stack': foldedStackSpec(),
  line: lineSpec(),
  'short line': shortLineSpec(),
  tiles: tilesSpec(),
  'big tiles': bigTilesSpec(),
});

test('nothing leaves the chart: every mark lies inside the width at every width down to a phone, for every shape and both languages', () => {
  for (const [name, spec] of Object.entries(everyShape()))
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

test('no text lies over another text, at every width down to a phone, for every shape and both languages', () => {
  for (const [name, spec] of Object.entries(everyShape()))
    for (const language of ['en', 'ar'])
      for (const width of [320, 375, 480, 640, 960])
        assert.deepEqual(textOverlaps(layout(spec, width, language)), [], `${name} ${language} ${width}`);
});

test('the names of bars and stacks start a little clear of the baseline, never touching it, in both languages', () => {
  for (const [name, spec] of Object.entries({bars: barsSpec(), cost: costSpec(), stack: stackSpec()}))
    for (const language of ['en', 'ar'])
      for (const width of [320, 640]) {
        const scene = layout(spec, width, language),
          [axis] = marks(scene, 'axis');
        for (const label of marks(scene, 'label'))
          assert.ok(
            Math.abs(label.x - axis.x1) >= 4,
            `${name} ${language} ${width}: "${label.text}" starts ${Math.abs(label.x - axis.x1)}px from the baseline`,
          );
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
  const other = foldedBarsSpec();
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
  const spec = shortLineSpec(),
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

test('the first and last marks of a line sit inside the plot, clear of the value axis and of the edge, with their rings', () => {
  for (const language of ['en', 'ar'])
    for (const width of [320, 640]) {
      const scene = layout(lineSpec(), width, language),
        [axis] = marks(scene, 'axis'),
        xs = marks(scene, 'point').map(item => item.cx);
      assert.ok(
        Math.min(...xs) - 6 >= axis.x1,
        `${language} ${width}: the first mark and its ring clear the plot's left edge`,
      );
      assert.ok(
        Math.max(...xs) + 6 <= axis.x2,
        `${language} ${width}: the last mark and its ring clear the plot's right edge`,
      );
    }
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

/** Does the segment from p to q pass through the box? Sampled: this tests a drawing, not geometry. */
function crosses(p, q, box) {
  for (let step = 0; step <= 80; step++) {
    const x = p[0] + ((q[0] - p[0]) * step) / 80,
      y = p[1] + ((q[1] - p[1]) * step) / 80;
    if (x > box.left && x < box.right && y > box.top && y < box.bottom) return true;
  }
  return false;
}
test('a direct label on a line never sits on the line: above a peak, below a point the line comes down to, or left out', () => {
  const dates = [
    '2026-09-07',
    '2026-09-14',
    '2026-09-21',
    '2026-09-28',
    '2026-10-05',
    '2026-10-12',
    '2026-10-19',
    '2026-10-26',
  ];
  const shapes = {
    zigzag: [10, 80, 40, 25, 60, 5, 90, 33],
    rising: [10, 20, 30, 40, 50, 60, 70, 100],
    falling: [100, 90, 80, 70, 60, 50, 40, 30],
    flat: [50, 50, 50, 50, 50, 50, 50, 50],
    valley: [60, 40, 20, 5, 20, 40, 60, 80],
  };
  for (const [name, values] of Object.entries(shapes)) {
    const spec = of(weekly(values.map((value, index) => week(dates[index], 'a', String(value)))), 'trend').find(
      item => item.title.text === 'Spend over time',
    );
    for (const language of ['en', 'ar'])
      for (const width of [320, 480, 640, 960]) {
        const scene = layout(spec, width, language),
          segments = marks(scene, 'line').flatMap(line =>
            line.points.slice(1).map((point, k) => [line.points[k], point]),
          ),
          points = marks(scene, 'point'),
          where = `${name} ${language} ${width}`;
        const labels = marks(scene, 'value');
        assert.equal(labels.length, spec.series[0].label_at.length, where + ': every labelled point has its label');
        for (const label of labels) {
          const box = boundsOf(label);
          for (const [p, q] of segments)
            assert.equal(crosses(p, q, box), false, `${where}: "${label.text}" is struck through`);
          // It sits above its point or below it, never on it.
          const point = points.find(item => item.i === label.i);
          assert.ok(
            label.y < point.cy - 6 || label.y - 12 > point.cy + 4,
            `${where}: "${label.text}" overlaps its own point`,
          );
        }
      }
  }
  // The end of a falling line is below its label's point: the label goes under it. The peak's goes above.
  const zigzag = layout(lineSpec(), 640),
    last = marks(zigzag, 'point').at(-1),
    end = marks(zigzag, 'value').find(item => item.i === last.i),
    peak = marks(zigzag, 'point').find(item => item.i === 6),
    top = marks(zigzag, 'value').find(item => item.i === 6);
  assert.ok(end.y > last.cy, 'the line comes down to the last point: its label is under it');
  assert.ok(top.y < peak.cy, 'the highest point has its label above it');
});

test('a value label is never crossed by the target mark of its own bar: it moves beyond the target', () => {
  // Two campaigns at 10 and 8 per result against a target of 10.5: the target mark lies just past the first bar's end,
  // where its label would go, and well past the second's.
  const spec = of(
    charts([chartRow('a', '100', '10'), chartRow('b', '80', '10')], {
      config: {targets: {leads: {target: 10.5, currency: 'USD'}}},
    }),
    'cost_vs_target',
  )[0];
  assert.deepEqual(spec.series[0].targets, ['10.5', '10.5']);
  for (const language of ['en', 'ar'])
    for (const width of [320, 480, 640, 960]) {
      const scene = layout(spec, width, language),
        where = `${language} ${width}`;
      for (const target of marks(scene, 'target')) {
        const label = marks(scene, 'value').find(item => item.i === target.i),
          box = boundsOf(label);
        assert.ok(
          target.x1 < box.left - 1 || target.x1 > box.right + 1,
          `${where}: the target crosses "${label.text}"`,
        );
      }
      // The label stays beside the end of its bar when nothing is in the way, and clear of the target when it is.
      const [near, far] = marks(scene, 'bar'),
        labels = marks(scene, 'value'),
        ahead = (bar, label) => (language === 'ar' ? bar.x - label.x : label.x - (bar.x + bar.w));
      assert.equal(r2(ahead(far, labels[1])), 6, where + ': the second label is right beside its bar');
      assert.ok(ahead(near, labels[0]) > 6, where + ': the first label has been moved past the target');
    }
});

test('a point on the baseline that the line comes down to has no label rather than one struck through by the line', () => {
  const dates = ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'],
    spec = of(weekly([100, 60, 30, 0].map((value, index) => week(dates[index], 'a', String(value)))), 'trend').find(
      item => item.title.text === 'Spend over time',
    );
  assert.deepEqual(spec.series[0].label_at, [0, 3], 'the spec asks for the highest point and the end');
  for (const width of [320, 640]) {
    const scene = layout(spec, width),
      labelled = marks(scene, 'value').map(item => item.i);
    // Above the last point is the line coming down to it, below it is the axis: no room, so no label. The table and
    // the title of the mark still have the value; the highest point keeps its own.
    assert.deepEqual(labelled, [0], 'width ' + width);
  }
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

test('text is broken at its spaces into the lines a box holds, and what cannot fit is cut with an ellipsis on the last line', () => {
  const caption = 'Since the previous period';
  assert.deepEqual(wrapChartText(caption, 400, 12, 2), [caption], 'one line when it fits');
  assert.deepEqual(wrapChartText(caption, 120, 12, 2), ['Since the previous', 'period']);
  assert.deepEqual(wrapChartText('', 120, 12, 2), []);
  assert.deepEqual(wrapChartText('   ', 120, 12, 2), []);
  // More lines than the box has: the last line takes the rest and is cut.
  const long = 'one two three four five six seven eight nine ten eleven twelve';
  const lines = wrapChartText(long, 80, 12, 2);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].endsWith('…'));
  assert.ok(lines.every(line => chartTextWidth(line, 12) <= 80));
  assert.ok(long.startsWith(lines[0]), 'the first line is the start of the text');
  // A single word wider than the box is cut, never allowed to leave it.
  const word = wrapChartText('Supercalifragilisticexpialidocious', 80, 12, 2);
  assert.equal(word.length, 1);
  assert.ok(word[0].endsWith('…') && chartTextWidth(word[0], 12) <= 80);
  // The lines of a wrapped text read back, joined by a space, as the text (when nothing is cut).
  assert.equal(wrapChartText('+123,356.50 (+123,356.5%)', 100, 12, 2).join(' '), '+123,356.50 (+123,356.5%)');
});

test('text is cut and broken by whatever measures it, so the PDF can use the real width of its font', () => {
  const tenEach = text => text.length * 10;
  assert.equal(fitChartText('abcdefghij', 55, 12, tenEach), 'abcd…');
  assert.equal(fitChartText('abc', 55, 12, tenEach), 'abc');
  assert.deepEqual(wrapChartText('ab cd ef', 55, 12, 2, tenEach), ['ab cd', 'ef']);
  assert.deepEqual(wrapChartText('ab cd ef gh ij', 55, 12, 2, tenEach), ['ab cd', 'ef g…']);
});

test('a caption or a change too wide for its tile goes on a second line, whole, and every tile has the height of the tallest', () => {
  const spec = tilesSpec(),
    caption = 'Since the previous period';
  // 5 tiles of 120px at 640px: the caption does not fit one line of a tile there.
  const narrow = layout(spec, 640),
    lines = marks(narrow, 'kpi-caption');
  assert.ok(lines.length > 3, 'more than one caption line in some tile');
  const byTile = [...new Set(lines.map(item => item.s))].map(s => lines.filter(item => item.s === s));
  for (const tile of byTile) {
    assert.equal(tile.map(item => item.text).join(' '), caption, 'the whole caption, in order');
    assert.deepEqual(
      tile.map(item => item.y),
      [...tile.map(item => item.y)].sort((a, b) => a - b),
      'top to bottom',
    );
    assert.ok(tile.every(item => chartTextWidth(item.text, item.size) <= (640 - 8 - 4 * 8) / 5));
  }
  // The wide screen has room for the caption on one line.
  assert.equal(marks(layout(spec, 960), 'kpi-caption').length, 3);
  // A long change: the amount and the percentage, each whole.
  const big = bigTilesSpec(),
    change = marks(layout(big, 320), 'kpi-change').filter(item => item.s === 0);
  assert.equal(change.map(item => item.text).join(' '), '+12,345,578.50 (+12,345,578.5%)');
  assert.ok(change.length > 1, 'it does not fit one line of a phone tile');
  // Every tile has the height of the tallest, so the rows of a grid line up: the value of each row sits at one y.
  const scene = layout(big, 320),
    values = marks(scene, 'kpi-value').map(item => item.y);
  const rows = [...new Set(values)];
  assert.equal(rows.length, Math.ceil(big.series.length / 2), 'one y for each row of two tiles');
  assert.equal(rows[1] - rows[0], rows[2] - rows[1], 'the rows are one height apart');
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
  const many = foldedBarsSpec(),
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
  const stack = foldedStackSpec(),
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

test('marks are drawn in one order by every renderer: grid, axis, fills, the line, targets, points, then text, each layer in scene order', () => {
  const rank = item =>
    item.t === 'line' && item.role === 'grid'
      ? 0
      : item.t === 'line' && item.role === 'axis'
        ? 1
        : item.t === 'rect'
          ? 2
          : item.t === 'polyline'
            ? 3
            : item.t === 'line'
              ? 4
              : item.t === 'circle'
                ? 5
                : 6;
  for (const [name, spec] of Object.entries(everyShape())) {
    const scene = layout(spec, 480),
      ordered = sceneInDrawingOrder(scene);
    assert.equal(ordered.length, scene.items.length, name);
    assert.deepEqual(
      ordered.map(rank),
      [...ordered.map(rank)].sort((a, b) => a - b),
      name + ': layers in order',
    );
    // Nothing is lost or invented, and within a layer the scene's own order is kept.
    for (let layer = 0; layer <= 6; layer++)
      assert.deepEqual(
        ordered.filter(item => rank(item) === layer),
        scene.items.filter(item => rank(item) === layer),
        `${name} layer ${layer}`,
      );
  }
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

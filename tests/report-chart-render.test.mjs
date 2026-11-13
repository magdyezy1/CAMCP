// V2-EXP-01: the SVG back end. chartSvg draws the scene of src/report-chart-layout.ts as a string: well-formed, one escape
// function for every string (a campaign called </svg><script>alert(1)</script> is text, probe 16), only the colours of the
// theme, a title and description that name the chart, a title on every mark, the report's language, and print texture so
// that colour is not the only encoding.
import test from 'node:test';
import assert from 'node:assert/strict';
import {chartLayout} from '../dist/src/report-chart-layout.js';
import {chartSvg} from '../dist/src/report-chart-render.js';
import {
  chartMessageText,
  chartNoteText,
  chartPalette,
  chartSeriesName,
  escapeChartText,
} from '../dist/src/report-chart-theme.js';
import {reportCharts} from '../dist/src/report-charts.js';
import {artifactLocale} from '../dist/src/report-localization.js';
import {chartRow, parts} from './helpers/chart-rows.mjs';
import {
  barsSpec,
  campaigns,
  charts,
  foldedBarsSpec,
  foldedStackSpec,
  lineSpec,
  of,
  shortLineSpec,
  specimens,
  stackSpec,
  tilesSpec,
} from './helpers/chart-specimens.mjs';
import {elementsOf, parseXml, textOf} from './helpers/xml-check.mjs';

const en = artifactLocale({artifact_language: 'en'}),
  ar = artifactLocale({artifact_language: 'ar'});
const render = (spec, theme = 'light', locale = en, more = {}) => chartSvg(spec, {theme, locale, ...more});
const hostileMarkup = '</svg><script>alert(1)</script>';
const marksOf = root => elementsOf(root).filter(element => ['path', 'rect', 'circle'].includes(element.name));
const titlesOf = root =>
  marksOf(root).flatMap(element => element.children.filter(child => child.name === 'title').map(textOf));

test('one function turns text into markup: the five markup characters become entities, what XML cannot carry a space', () => {
  assert.equal(
    escapeChartText(`</svg><script>alert("1")&'x'</script>`),
    '&lt;/svg&gt;&lt;script&gt;alert(&quot;1&quot;)&amp;&#39;x&#39;&lt;/script&gt;',
  );
  assert.equal(escapeChartText('a\u0000b\u000bc￾d'), 'a b c d');
  assert.equal(escapeChartText('lone \ud800 surrogate'), 'lone   surrogate');
  assert.equal(escapeChartText('pair \u{1F600} stays'), 'pair \u{1F600} stays');
  assert.equal(escapeChartText('tab\tnewline\nstay'), 'tab\tnewline\nstay');
  assert.equal(escapeChartText('مرحبا ٣٥'), 'مرحبا ٣٥');
  assert.deepEqual([escapeChartText(null), escapeChartText(undefined), escapeChartText(12.5)], ['', '', '12.5']);
});

test('the well-formedness check used here refuses what it should, so a pass means something', () => {
  for (const bad of [
    '<svg><text>a < b</text></svg>',
    '<svg><text>fish & chips</text></svg>',
    '<svg><g></svg>',
    '<svg a="1" a="2"/>',
    '<svg a=1/>',
    '<svg/><svg/>',
    '<svg><text></svg></text>',
    'text<svg/>',
    '<svg a="<"/>',
  ])
    assert.throws(() => parseXml(bad), bad);
  assert.doesNotThrow(() => parseXml('<svg a="x &amp; y"><title>&lt;b&gt;</title></svg>'));
  assert.equal(textOf(parseXml('<svg><title>&lt;b&gt; &amp; &quot;q&quot;</title></svg>').children[0]), '<b> & "q"');
});

test('a message is said in the language of the artifact: names AMCP wrote are translated, provider data and numbers are not', () => {
  const spec = stackSpec(),
    english = chartMessageText(spec.takeaway, en),
    arabic = chartMessageText(spec.takeaway, ar);
  assert.equal(english, spec.takeaway.text, 'English is the very sentence the spec holds');
  assert.match(arabic, /\p{Script=Arabic}/u);
  // The largest objective is a name AMCP wrote ("Sales"): said in Arabic, and its share and total are as they were.
  assert.ok(spec.takeaway.labels.includes('name'));
  assert.ok(!arabic.includes(spec.takeaway.params.name), 'the objective is translated');
  assert.ok(arabic.includes(spec.takeaway.params.share) && arabic.includes(spec.takeaway.params.total));
  // In Arabic every value is isolated from the sentence around it (first-strong isolate), so a date, a percentage or an
  // amount keeps its own order inside a right-to-left sentence: "2026-10-19" must not be read as "19-10-2026".
  const isolated = value => String.fromCodePoint(0x2068) + value + String.fromCodePoint(0x2069);
  assert.ok(arabic.includes(isolated(spec.takeaway.params.share)));
  assert.ok(arabic.includes(isolated(spec.takeaway.params.total)));
  assert.ok(
    !arabic.includes(isolated(spec.takeaway.params.name)),
    'a name AMCP wrote is a word of the sentence, not data',
  );
  assert.ok(!/\p{Bidi_Control}/u.test(english), 'English has no isolates');
  const peak = chartMessageText(lineSpec().takeaway, ar);
  assert.ok(peak.includes(isolated('2026-10-19')), peak);
  // A campaign's name is a provider's: never translated.
  const bars = foldedBarsSpec();
  assert.ok(chartMessageText(bars.takeaway, ar).includes(bars.takeaway.params.name));
  assert.equal(chartMessageText(bars.takeaway, en), bars.takeaway.text);
  // A title is one of the messages.
  assert.equal(chartMessageText(spec.title, en), 'Spend by objective');
  assert.match(chartMessageText(spec.title, ar), /\p{Script=Arabic}/u);
  assert.equal(chartSeriesName(spec.series[0], en), spec.series[0].name);
  assert.notEqual(chartSeriesName(spec.series[0], ar), spec.series[0].name);
  const entity = {...spec.series[0], name: 'Meta campaign', name_kind: 'entity'};
  assert.equal(chartSeriesName(entity, ar), 'Meta campaign');
});

test('a coverage note is re-worded by the helper that wrote it: the very line in English, Arabic in Arabic', () => {
  const spec = shortLineSpec(),
    coverage = spec.notes.filter(note => note.kind === 'coverage');
  assert.ok(coverage.length > 0, 'the short line has coverage notes');
  for (const note of coverage) {
    assert.equal(chartNoteText(note, en), note.text);
    assert.match(chartNoteText(note, ar), /\p{Script=Arabic}/u);
  }
  const message = spec.notes.find(note => note.kind === 'message');
  assert.equal(chartNoteText(message, en), message.text);
});

test('a chart that is not drawn has no SVG: its notes and its table are what is left', () => {
  const [one] = of(charts(campaigns([30])), 'spend_by_entity');
  assert.equal(one.drawn, false);
  assert.equal(render(one), null);
});

test('every chart is well-formed SVG that names itself, in both themes and both languages', () => {
  for (const [name, spec] of Object.entries(specimens()))
    for (const theme of ['light', 'dark'])
      for (const locale of [en, ar]) {
        const where = `${name} ${theme} ${locale.language}`,
          svg = render(spec, theme, locale),
          root = parseXml(svg);
        assert.equal(root.name, 'svg', where);
        assert.equal(root.attrs.xmlns, 'http://www.w3.org/2000/svg', where);
        assert.equal(root.attrs.role, 'img', where);
        assert.equal(root.attrs.lang, locale.language, where);
        // The positions are physical: a picture embedded in a right-to-left page must not inherit that direction, which
        // would turn every text-anchor around. A text that reads right to left says so itself.
        assert.equal(root.attrs.direction, 'ltr', where);
        assert.match(root.attrs.viewBox, /^0 0 640 \d+(\.\d+)?$/, where);
        assert.equal(root.attrs.width, '640', where);
        const title = root.children.find(child => child.name === 'title'),
          desc = root.children.find(child => child.name === 'desc');
        assert.equal(textOf(title), chartMessageText(spec.title, locale), where);
        const words = [
          spec.takeaway && chartMessageText(spec.takeaway, locale),
          ...spec.notes.map(note => chartNoteText(note, locale)),
        ];
        assert.equal(textOf(desc), words.filter(Boolean).join(' '), where);
        // aria-labelledby names the title and the description.
        assert.deepEqual(root.attrs['aria-labelledby'].split(' '), [title.attrs.id, desc.attrs.id], where);
        assert.doesNotMatch(svg, /NaN|undefined|Infinity/, where);
      }
});

test('the SVG draws every text mark of the layout, escaped, in order, at 12px or more', () => {
  for (const [name, spec] of Object.entries(specimens()))
    for (const locale of [en, ar]) {
      const scene = chartLayout(spec, {width: 640, language: locale.language, t: locale.text}),
        texts = elementsOf(parseXml(render(spec, 'light', locale)), 'text');
      assert.deepEqual(
        texts.map(textOf),
        scene.items.filter(item => item.t === 'text').map(item => item.text),
        `${name} ${locale.language}`,
      );
      for (const text of texts) assert.ok(Number(text.attrs['font-size']) >= 12, `${name}: ${text.attrs['font-size']}`);
    }
});

test('probe 16: a name that is markup is text in the SVG, wherever a name is written', () => {
  const rows = [
    chartRow('c1', '100', '2', {campaign_name: hostileMarkup, platform: 'meta', account_id: '1'}),
    chartRow('c2', '60', '2', {campaign_name: '"><img src=x onerror=alert(1)>', platform: 'google', account_id: '2'}),
    chartRow('c3', '30', '2', {campaign_name: "'; DROP TABLE x; --", platform: 'meta', account_id: '1'}),
  ];
  const specs = reportCharts(parts(rows), {platformNames: {meta: hostileMarkup, google: '<b>Google</b> & Co'}});
  assert.ok(specs.length >= 2, 'a platform chart and a campaign chart');
  for (const spec of specs.filter(item => item.drawn))
    for (const theme of ['light', 'dark'])
      for (const locale of [en, ar]) {
        const svg = render(spec, theme, locale),
          root = parseXml(svg);
        assert.deepEqual(elementsOf(root, 'script'), []);
        assert.deepEqual(elementsOf(root, 'img'), []);
        assert.equal(svg.split('<svg').length - 1, 1, 'one root element');
        assert.doesNotMatch(svg, /<script|<img|<b>/);
        // No element carries an event handler: what looked like one is text.
        assert.deepEqual(
          elementsOf(root).filter(element => Object.keys(element.attrs).some(name => name.startsWith('on'))),
          [],
        );
      }
  const campaignsChart = specs.find(spec => spec.drawn && spec.kind === 'spend_by_entity' && spec.x.items.length === 3);
  assert.ok(campaignsChart, 'a chart of three campaigns');
  const root = parseXml(render(campaignsChart));
  // The name is text: in a label, in the title of its bar, and in the sentence of the description.
  assert.ok(elementsOf(root, 'text').some(text => textOf(text) === hostileMarkup));
  assert.ok(titlesOf(root).some(title => title.startsWith(hostileMarkup + ': ')));
  assert.ok(textOf(root.children.find(child => child.name === 'desc')).includes(hostileMarkup));
  assert.ok(render(campaignsChart).includes('&lt;/svg&gt;&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('a chart draws only the colours of its theme: the surface behind, the hues for data, the inks for text', () => {
  for (const theme of ['light', 'dark']) {
    const colors = chartPalette[theme],
      allowed = new Set([
        colors.surface,
        colors.ink,
        colors.ink2,
        colors.grid,
        colors.axis,
        ...colors.hues,
        colors.other,
        ...colors.on,
        colors.onOther,
      ]);
    for (const [name, spec] of Object.entries(specimens()))
      for (const element of elementsOf(parseXml(render(spec, theme))))
        for (const attribute of ['fill', 'stroke']) {
          const value = element.attrs[attribute];
          if (value === undefined || value === 'none') continue;
          assert.ok(allowed.has(value), `${name} ${theme}: ${attribute}="${value}" on <${element.name}>`);
        }
  }
  // The two themes differ, and the surface is drawn first, as wide and as high as the chart.
  const light = parseXml(render(barsSpec(), 'light')),
    dark = parseXml(render(barsSpec(), 'dark')),
    [background] = elementsOf(light, 'rect');
  assert.equal(background.attrs.fill, chartPalette.light.surface);
  assert.equal(elementsOf(dark, 'rect')[0].attrs.fill, chartPalette.dark.surface);
  assert.equal(background.attrs.width, light.attrs.width);
  assert.equal(background.attrs.height, light.attrs.height);
  assert.notEqual(render(barsSpec(), 'light'), render(barsSpec(), 'dark'));
});

test('spend is the first hue wherever it is drawn, and Other is the neutral', () => {
  for (const theme of ['light', 'dark']) {
    const colors = chartPalette[theme],
      spec = foldedBarsSpec(),
      root = parseXml(render(spec, theme)),
      bars = marksOf(root).filter(element => element.children.some(child => child.name === 'title')),
      fills = Object.fromEntries(
        bars.map(element => [textOf(element.children.find(child => child.name === 'title')), element.attrs.fill]),
      );
    assert.equal(fills['Campaign c1: 100.00'], colors.hues[0], theme);
    assert.equal(fills['Other: 9.00'], colors.other, theme);
    assert.equal(bars.length, spec.x.items.length);
  }
});

test('every mark has a title that says what it is, in the language of the report', () => {
  const bars = foldedBarsSpec(),
    shown = bars.x.items.map(
      (item, index) => `${item.other ? 'Other' : item.label}: ${bars.series[0].value_labels[index]}`,
    );
  assert.deepEqual(titlesOf(parseXml(render(bars))), shown);
  assert.deepEqual(
    titlesOf(parseXml(render(bars, 'light', ar))),
    shown.map(title => title.replace(/^Other/, ar.text('Other'))),
  );
  // A stack: the entry, the series and the value.
  const stack = stackSpec(),
    stacked = titlesOf(parseXml(render(stack)));
  assert.ok(stacked.includes('Meta · Sales: 100.00'), stacked.join(' | '));
  assert.ok(stacked.includes('Meta · Traffic: 1.00'));
  // A line: the exact day and the value, hollow marks too.
  const line = shortLineSpec(),
    days = titlesOf(parseXml(render(line)));
  assert.deepEqual(days, ['2026-09-07: 40.00', '2026-09-14: 20.00', '2026-09-21: 40.00', '2026-09-28: 40.00']);
  // A zero is no bar, so it has no title; the table and the label say it.
  const zero = of(charts([chartRow('a', '30'), chartRow('b', '0'), chartRow('c', '10')]), 'spend_by_entity')[0];
  assert.deepEqual(titlesOf(parseXml(render(zero))), ['Campaign a: 30.00', 'Campaign c: 10.00']);
});

test('a bar is square at the baseline and rounded at its data end, and a sliver is a plain rectangle', () => {
  const root = parseXml(render(barsSpec())),
    byTitle = prefix =>
      marksOf(root).find(element =>
        element.children.some(child => child.name === 'title' && textOf(child).startsWith(prefix)),
      );
  const long = byTitle('A very long campaign name');
  assert.equal(long.name, 'path');
  assert.match(long.attrs.d, /^M[\d.]+,[\d.]+H[\d.]+A4,4 0 0 1 [\d.]+,[\d.]+V[\d.]+A4,4 0 0 1 [\d.]+,[\d.]+H[\d.]+Z$/);
  // The baseline end has no arc: both left corners are the same x.
  const sliver = byTitle('x: ');
  assert.equal(sliver.name, 'rect');
  assert.ok(Number(sliver.attrs.width) <= 2);
  // In Arabic the rounded end is on the left.
  const mirrored = marksOf(parseXml(render(barsSpec(), 'light', ar))).find(
    element => element.name === 'path' && element.children.some(child => textOf(child).startsWith('A very long')),
  );
  assert.match(
    mirrored.attrs.d,
    /^M[\d.]+,[\d.]+H[\d.]+A4,4 0 0 0 [\d.]+,[\d.]+V[\d.]+A4,4 0 0 0 [\d.]+,[\d.]+H[\d.]+Z$/,
  );
});

test('in Arabic a text is anchored by the end its own letters start from, and only Arabic text is set right to left', () => {
  const bars = foldedBarsSpec(),
    english = elementsOf(parseXml(render(bars)), 'text'),
    arabic = elementsOf(parseXml(render(bars, 'light', ar)), 'text'),
    pick = (texts, content) => texts.find(text => textOf(text) === content);
  // English: names are left-anchored from the baseline.
  assert.equal(pick(english, 'Campaign c1').attrs['text-anchor'], 'start');
  assert.equal(pick(english, 'Campaign c1').attrs.direction, undefined);
  // Arabic: the layout mirrors, so a Latin name sits at the right edge and ends there; an Arabic one starts there.
  assert.equal(pick(arabic, 'Campaign c1').attrs['text-anchor'], 'end');
  assert.equal(pick(arabic, 'Campaign c1').attrs.direction, undefined);
  const other = pick(arabic, ar.text('Other'));
  assert.equal(other.attrs['text-anchor'], 'start');
  assert.equal(other.attrs.direction, 'rtl');
  assert.equal(other.attrs['unicode-bidi'], 'embed');
  // A number is never set right to left.
  for (const text of arabic.filter(item => /^[\d.,]+$/.test(textOf(item))))
    assert.equal(text.attrs.direction, undefined);
  // Time still runs left to right: the date labels of a line are centred and the value axis is on the right in Arabic.
  const line = elementsOf(parseXml(render(lineSpec(), 'light', ar)), 'text'),
    zero = line.find(text => textOf(text) === '0');
  assert.equal(zero.attrs['text-anchor'], 'start', 'the value axis is on the right: its labels start at its edge');
  assert.ok(Number(zero.attrs.x) > 320);
});

test('print texture gives every fill but the first hue a pattern, so colour is not the only encoding', () => {
  const spec = foldedStackSpec(),
    colors = chartPalette.light,
    plain = parseXml(render(spec)),
    textured = parseXml(render(spec, 'light', en, {texture: true}));
  assert.deepEqual(elementsOf(plain, 'pattern'), []);
  const patterns = elementsOf(textured, 'pattern');
  assert.equal(patterns.length, 3, 'the second hue, the third hue and Other');
  assert.equal(new Set(patterns.map(pattern => pattern.attrs.id)).size, 3);
  for (const pattern of patterns) assert.equal(pattern.attrs.patternUnits, 'userSpaceOnUse');
  // The marks of each hue refer to their pattern, the first hue stays solid; the legend swatches match their marks.
  const scene = chartLayout(spec, {width: 640, language: 'en', t: text => text}),
    swatches = scene.items.filter(item => item.t === 'rect');
  const fills = marksOf(textured)
    .filter(element => element.name !== 'circle' && element.attrs.width !== '640')
    .map(element => element.attrs.fill);
  const count = pattern => fills.filter(fill => fill === `url(#${pattern.attrs.id})`).length;
  const hueOf = pattern => pattern.children.find(child => child.name === 'rect').attrs.fill;
  for (const [hue, color] of [
    [1, colors.hues[1]],
    [2, colors.hues[2]],
    [null, colors.other],
  ]) {
    const pattern = patterns.find(item => hueOf(item) === color);
    assert.ok(pattern, 'a pattern on the colour ' + color);
    assert.equal(count(pattern), swatches.filter(item => item.color === hue).length, 'marks of hue ' + hue);
  }
  assert.ok(fills.includes(colors.hues[0]), 'the first hue stays solid');
  // A label inside a patterned fill has a halo of the fill's colour, so the stripes do not run through its letters.
  for (const text of elementsOf(textured, 'text').filter(item => item.attrs['paint-order'] === 'stroke'))
    assert.ok(Object.values(colors.hues).includes(text.attrs.stroke) || text.attrs.stroke === colors.other);
  assert.ok(elementsOf(textured, 'text').some(item => item.attrs['paint-order'] === 'stroke'));
  assert.equal(elementsOf(plain, 'text').filter(item => item.attrs['paint-order']).length, 0);
});

test('the width is the width of the chart, within bounds, and the same chart draws the same SVG every time', () => {
  const spec = barsSpec();
  assert.equal(render(spec), render(spec));
  const at = width => parseXml(render(spec, 'light', en, {width})).attrs;
  assert.equal(at(320).width, '320');
  assert.match(at(320).viewBox, /^0 0 320 /);
  assert.equal(at(100).width, '240', 'not narrower than a chart can be read');
  assert.equal(at(5000).width, '1600');
  assert.equal(at(NaN).width, '640');
  assert.equal(at(Infinity).width, '640');
  assert.equal(at(undefined).width, '640');
  // The ids that tie a title to its chart are unique among the charts of one report.
  const rows = [
    chartRow('a', '10', '1'),
    chartRow('b', '20', '1'),
    chartRow('c', '5', '1', {currency: 'EUR'}),
    chartRow('d', '7', '1', {currency: 'EUR'}),
  ];
  const ids = charts(rows)
    .filter(item => item.drawn)
    .flatMap(item =>
      parseXml(render(item))
        .children.filter(child => ['title', 'desc'].includes(child.name))
        .map(child => child.attrs.id),
    );
  assert.ok(ids.length >= 2);
  assert.equal(new Set(ids).size, ids.length);
});

test('key figures are text only: a name, a figure, a currency, and the change in words', () => {
  const root = parseXml(render(tilesSpec(), 'light', en, {width: 960})),
    texts = elementsOf(root, 'text').map(textOf);
  assert.deepEqual(marksOf(root).length, 1, 'only the surface');
  assert.ok(texts.includes('+50.00 (+33.33%)'));
  assert.ok(texts.includes('Since the previous period'));
  const figure = elementsOf(root, 'text').find(text => textOf(text) === tilesSpec().series[0].value_labels[0]);
  assert.equal(figure.attrs['font-weight'], '700');
  assert.equal(figure.attrs.fill, chartPalette.light.ink);
  const arabic = elementsOf(parseXml(render(tilesSpec(), 'light', ar, {width: 960})), 'text').map(textOf);
  assert.ok(arabic.includes(ar.text('Since the previous period')));
  assert.ok(arabic.includes('+50.00 (+33.33%)'), 'numbers and their signs are as they were');
  // Narrower, the words go on a second line: the same words, in the same order.
  const phone = elementsOf(parseXml(render(tilesSpec(), 'light', en, {width: 320})), 'text').map(textOf);
  assert.ok(phone.includes('Since the previous'));
  assert.ok(phone.includes('period'));
});

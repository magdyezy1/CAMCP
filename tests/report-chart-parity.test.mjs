// V2-EXP-01: the page draws a chart with a port of the layout the SVG and the PDF share, so a chart is the same picture on
// the page, in the SVG and on paper. This feeds the server's layout (src/report-chart-layout.ts) and the page's port
// (web/charts.js, run in the page's own context with its real Arabic catalog) the same chart, at every width and in both
// languages, and compares every coordinate, label, colour and anchor; then the words (messages, table cells) the same way.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  chartBarPath,
  chartDateLabel,
  chartLayout,
  chartTextWidth,
  fitChartText,
  wrapChartText,
} from '../dist/src/report-chart-layout.js';
import {chartMessageText, chartTableText} from '../dist/src/report-chart-theme.js';
import {artifactLocale} from '../dist/src/report-localization.js';
import {reportPage} from './helpers/report-page.mjs';
import {bigTilesSpec, specimens} from './helpers/chart-specimens.mjs';

const pages = {},
  charts = fs.readFileSync('web/charts.js', 'utf8');
for (const language of ['en', 'ar']) {
  pages[language] = reportPage(language, {metrics: {}, platforms: []});
  pages[language].run(charts);
}
/** What the page's port makes of an expression, as plain data: the context's own objects have prototypes of their own. */
const page = (language, expression, values = {}) =>
  JSON.parse(JSON.stringify(pages[language].raw(expression, values) ?? null));
const plain = value => JSON.parse(JSON.stringify(value ?? null));
const shapes = {...specimens(), 'big-tiles': bigTilesSpec()};
const widths = [240, 320, 375, 480, 640, 960, 1280];
// The artifact catalogue and the page's catalog say the same thing for every chart message (tests/report-charts-messages).
const locales = {en: artifactLocale({artifact_language: 'en'}), ar: artifactLocale({artifact_language: 'ar'})};
const say = language => locales[language].text;

test('the page lays a chart out as the server does: every mark, coordinate, label, hue and anchor, at every width, in both languages', () => {
  for (const [name, spec] of Object.entries(shapes))
    for (const language of ['en', 'ar'])
      for (const width of widths) {
        const expected = plain(chartLayout(spec, {width, language, t: say(language)}));
        // The page says AMCP's own words through uiText: the page's real Arabic catalog.
        const actual = page(language, 'amcpChartLayout(spec, {width, language, t: uiText})', {spec, width, language});
        assert.deepEqual(actual, expected, `${name} ${language} ${width}`);
      }
});

test('a chart that is not drawn has no layout on the page either', () => {
  const [one] = Object.values(shapes).filter(spec => spec.drawn === false);
  const undrawn = {...shapes.bars, drawn: false};
  assert.equal(one, undefined, 'the specimens are all drawn');
  assert.equal(page('en', 'amcpChartLayout(spec, {width: 480, language: "en", t: uiText})', {spec: undrawn}), null);
});

test('the pieces the layout is made of agree: the width estimate, the ellipsis, the wrap, the dates, a bar outline', () => {
  const samples = [
    '',
    'Campaign',
    'Spend by campaign',
    '1,234,567.89',
    'مرحبا بالعالم',
    '中文活动',
    'Café ñ €',
    '</svg><script>',
  ];
  for (const text of samples)
    for (const size of [12, 22]) {
      assert.equal(page('en', 'amcpChartTextWidth(text, size)', {text, size}), chartTextWidth(text, size), text);
      for (const max of [0, 10, 40, 120])
        assert.equal(
          page('en', 'amcpChartFit(text, max, size)', {text, max, size}),
          fitChartText(text, max, size),
          text,
        );
    }
  for (const text of [
    'Since the previous period',
    '+12,345,578.50 (+12,345,578.5%)',
    'one two three four five six seven',
    '',
  ]) {
    for (const max of [30, 80, 120, 400])
      for (const lines of [1, 2, 3])
        assert.deepEqual(
          page('en', 'amcpChartWrap(text, max, 12, lines)', {text, max, lines}),
          wrapChartText(text, max, 12, lines),
          `${text} ${max} ${lines}`,
        );
  }
  for (const iso of ['2026-09-07', '2026-12-31', '2027-01-02', 'not a date', '2026-13-01'])
    for (const language of ['en', 'ar'])
      for (const withYear of [false, true])
        assert.equal(
          page('en', 'amcpChartDate(iso, language, withYear)', {iso, language, withYear}),
          chartDateLabel(iso, language, withYear),
        );
  for (const round of ['right', 'left'])
    assert.equal(
      page('en', 'amcpChartBarPath(item)', {item: {x: 10.5, y: 22, w: 120.25, h: 14, round}}),
      chartBarPath({t: 'rect', role: 'bar', x: 10.5, y: 22, w: 120.25, h: 14, round, s: 0, color: 0}),
    );
});

test('the page says the messages of a chart as the artifacts do, in both languages: names translated, values isolated in Arabic', () => {
  for (const [name, spec] of Object.entries(shapes))
    for (const language of ['en', 'ar']) {
      for (const message of [spec.title, spec.takeaway].filter(Boolean))
        assert.equal(
          page(language, 'amcpChartMessage(message)', {message}),
          chartMessageText(message, locales[language]),
          `${name} ${language}`,
        );
      for (const note of spec.notes.filter(item => item.kind === 'message'))
        assert.equal(page(language, 'amcpChartNote(note)', {note}), chartMessageText(note, locales[language]));
    }
});

test('the page reads the table of a chart as the PDF lists it: the same headings and cells, in both languages', () => {
  // "Campaign" was translated twice before charts existed, in two words, in the page's catalog and the artifacts' (the one
  // difference tests/report-charts-messages.test.mjs allows): the heading that holds it is compared as the word itself.
  const campaign = {
    page: page('ar', 'uiText("Campaign")'),
    artifact: locales.ar.text('Campaign'),
  };
  const same = (table, word) => ({
    ...table,
    columns: table.columns.map(column => ({...column, label: column.label === word ? 'Campaign' : column.label})),
  });
  for (const [name, spec] of Object.entries(shapes))
    for (const language of ['en', 'ar'])
      assert.deepEqual(
        same(page(language, 'amcpChartTable(spec)', {spec}), campaign.page),
        same(plain(chartTableText(spec, locales[language])), campaign.artifact),
        `${name} ${language}`,
      );
  // Exact decimals: a figure a float would spoil, a minor unit of three digits, none.
  const spec = {
    table: {
      columns: [
        {label: 'Name', label_kind: 'label', type: 'text', cell_kind: 'entity'},
        {label: 'Spend', label_kind: 'label', type: 'currency', currency: 'KWD'},
        {label: 'Spend', label_kind: 'label', type: 'currency', currency: 'JPY'},
        {label: 'Value', label_kind: 'label', type: 'decimal'},
      ],
      rows: [
        ['a', '0.1234', '1234.5', '9007199254740993.000001'],
        ['b', '-12', null, '-0.5'],
      ],
    },
  };
  assert.deepEqual(page('en', 'amcpChartTable(spec)', {spec}).rows, [
    ['a', '0.123', '1,235', '9,007,199,254,740,993.000001'],
    ['b', '-12.000', 'No data', '-0.5'],
  ]);
  assert.deepEqual(
    plain(chartTableText({...shapes.bars, ...spec}, locales.en).rows),
    page('en', 'amcpChartTable(spec)', {spec}).rows,
  );
});

test('the page keeps the key figures table in step with the tiles: the change columns appear with the change', () => {
  const spec = shapes.tiles;
  assert.deepEqual(
    page('en', 'amcpChartTable(spec)', {spec}).columns.map(column => column.label),
    ['Metric', 'Value', 'Currency', 'Previous period', 'Change', 'Change in percent'],
  );
});

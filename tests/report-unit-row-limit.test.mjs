// F-L5-28: the most rows one source unit may hold is one number, reportUnitRowLimit, read by every collector and by
// the detail assembly. A unit at the limit is kept and one row over it is refused, wherever the rows are counted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {reportUnitRowLimit} from '../dist/src/report-collection-budget.js';
import {collectNativeDaily, collectReportPeriods} from '../dist/src/report-periods.js';
import {nativeDetailResult} from '../dist/src/overview-native-detail.js';
import {granularSource} from './fixtures/overview-granularity-data.mjs';

const rows = count => Array.from({length: count}, (_, i) => ({id: String(i)})),
  refused = error => error.code === 'REPORT_ROW_LIMIT' && error.message.includes('10,000 rows'),
  dates = {since: '2026-09-01', until: '2026-09-02'},
  source = {platform: 'fixture', account_id: '1'};

test('the unit row limit is 10,000, and its refusals name that number', () => {
  assert.equal(reportUnitRowLimit, 10000);
});

test('rows collected by period count together: the limit is kept, one row more is refused', async () => {
  const period = count => async range => ({rows: rows(count), complete: true, date_range: range}),
    half = reportUnitRowLimit / 2;
  const kept = await collectReportPeriods(source, dates, 'daily', {}, period(half), () => {});
  assert.equal(kept.rows.length, reportUnitRowLimit);
  await assert.rejects(
    () =>
      collectReportPeriods(
        source,
        dates,
        'daily',
        {},
        async range => ({rows: rows(range.since === dates.since ? half : half + 1), complete: true, date_range: range}),
        () => {},
      ),
    refused,
  );
});

test('rows of a natively day-segmented read count together too', async () => {
  const days = count => async () =>
    ['2026-09-01', '2026-09-02'].map(day => ({
      rows: rows(count),
      complete: true,
      date_range: {since: day, until: day},
    }));
  const half = reportUnitRowLimit / 2;
  const kept = await collectNativeDaily(
    source,
    dates,
    {},
    days(half),
    () => {},
    async () => ({}),
  );
  assert.equal(kept.rows.length, reportUnitRowLimit);
  await assert.rejects(
    () =>
      collectNativeDaily(
        source,
        dates,
        {},
        days(half + 1),
        () => {},
        async () => ({}),
      ),
    refused,
  );
});

test('a detailed source of more than the limit is refused before its rows are assembled', () => {
  const detail = count => ({rows: rows(count), parents: {}}),
    base = {
      lineage: [],
      metadata: {},
      currency: 'USD',
      timezone: 'UTC',
      range: dates,
      providerComplete: true,
      resultDefinition: 'Results',
      warnings: [],
      context: {},
      rounding: {},
    },
    detailed = {...granularSource('linkedin', 'ad'), report_options: {attribution: 'unknown', complete_window: true}};
  assert.throws(() => nativeDetailResult(detailed, detail(reportUnitRowLimit + 1), [], base), refused);
});

test('no module compares a unit’s rows with a literal 10,000: they read the one constant', () => {
  for (const file of ['overview-levels', 'overview-native-detail', 'report-native', 'report-periods']) {
    const text = fs.readFileSync('src/' + file + '.ts', 'utf8');
    assert.match(text, /reportUnitRowLimit/, file);
    assert.doesNotMatch(text, /(?:length|rowCount)[^;\n]{0,40}>\s*10000\b/, file + ' compares with a literal');
    assert.doesNotMatch(text, /\.reduce\([^\n]*\)\s*>\s*10000\b/, file + ' compares a total with a literal');
  }
});

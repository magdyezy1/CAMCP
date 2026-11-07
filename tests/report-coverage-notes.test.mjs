// F-L5-01 (S1): partial totals read as complete on every human surface. A report of 28 campaigns whose cost is null on two
// collects everything it was asked for, so its state is `complete`; its spend is still the sum of 26 rows. The engine says
// so (`metrics_coverage`), and now every surface says it where the number is shown: the card, the CSV, the Excel workbook,
// the PDF and the Sheets tab. The snapshots here are built by the real server path (the queue, the worker, the row
// assembly, the summaries and `get`), and the exports and the page are the real ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {exportCsv, reportTable} from '../dist/src/report-table.js';
import {reportWorkbook, reportPdf} from '../dist/src/report-artifacts.js';
import {reportSource} from '../dist/src/report-sources.js';
import {row} from './helpers/report-packets.mjs';
import {reportEngine} from './helpers/report-engine.mjs';
import {overviewGranularityFixture, granularConfig, granularSource} from './fixtures/overview-granularity-data.mjs';
import {pdfActualText} from './helpers/pdf-actual-text.mjs';
import {pdfPlainText} from './helpers/pdf-plain-text.mjs';
import {reportPage, plainText} from './helpers/report-page.mjs';
import {packFixture} from './fixtures/report-pack-data.mjs';

const summaryCards = html =>
  [...html.matchAll(/<article class="report-summary-card[^"]*">([\s\S]*?)<\/article>/g)].map(card => card[1]);
/** The cells of the CSV text as arrays of strings, each cell unquoted. */
const parse = csv =>
  csv
    .replace(/^﻿/, '')
    .split('\r\n')
    .map(line => (line.match(/"(?:[^"]|"")*"/g) ?? []).map(cell => cell.slice(1, -1).replaceAll('""', '"')));
/** Whatever the PDF says in either script, as one line of text. */
const pdfWords = bytes => (pdfPlainText(bytes).join(' ') + ' ' + pdfActualText(bytes)).replace(/\s+/g, ' ');
const metrics = ['spend', 'clicks', 'cpc'];

// 28 campaigns; the cost of two is null.
const campaigns = Array.from({length: 28}, (_, i) =>
  row('campaign', 'c' + i, {spend: i < 2 ? null : '10.5', clicks: '7'}),
);
/** The report of the 28 campaigns through the real engine, and the server's bootstrap. */
async function shortSpend(t, {levels = ['campaign'], rowsFor = () => campaigns, changes = {}} = {}) {
  const e = reportEngine(t, {rowsFor});
  const done = await e.go(levels, {metrics, ...changes});
  return {e, ...done, bootstrap: await e.overview.handle({action: 'bootstrap'}, e.actor)};
}

test('the engine lists the figures a summary calculated from some of its rows, and nothing for a complete one', async () => {
  const {reportCoverageNotes} = await import('../dist/src/report-coverage-notes.js');
  const rows = {known_rows: 28, total_rows: 28, basis: 'report_rows', report_rows: 28};
  assert.deepEqual(reportCoverageNotes({metrics_coverage: {spend: rows, clicks: rows}}), []);
  assert.deepEqual(reportCoverageNotes({}), []);
  assert.deepEqual(reportCoverageNotes({metrics_coverage: null}), []);
  const summary = {
    metrics_coverage: {
      spend: {...rows, known_rows: 26},
      clicks: rows,
      cpc: {...rows, known_rows: 26, known_pairs: 26},
      impressions: {known_rows: 6, total_rows: 8, basis: 'native_measurements', report_rows: 2},
      conversion_value: {...rows, unavailable_reason: 'unknown_currency'},
      frequency: {...rows, unavailable_reason: 'non_additive_inputs'},
      cpa: {...rows, known_rows: 0, unavailable_reason: 'calculation_limit'},
      primary_result: {...rows, known_rows: 27},
    },
  };
  assert.deepEqual(reportCoverageNotes(summary), [
    {metric: 'spend', known: 26, total: 28, unit: 'rows', reason: 'missing_values'},
    {metric: 'cpc', known: 26, total: 28, unit: 'rows', reason: 'missing_inputs'},
    {metric: 'impressions', known: 6, total: 8, unit: 'measurements', reason: 'missing_values'},
    {metric: 'conversion_value', known: 28, total: 28, unit: 'rows', reason: 'unknown_currency'},
    {metric: 'frequency', known: 28, total: 28, unit: 'rows', reason: 'non_additive_inputs'},
    {metric: 'cpa', known: 0, total: 28, unit: 'rows', reason: 'calculation_limit'},
    {metric: 'primary_result', known: 27, total: 28, unit: 'rows', reason: 'missing_values'},
  ]);
  // The metrics a report shows, in its order; a metric it does not show is not listed.
  assert.deepEqual(
    reportCoverageNotes(summary, ['cpc', 'clicks', 'spend']).map(note => note.metric),
    ['cpc', 'spend'],
  );
});

test('a stored summary is read whichever build wrote it, and an entry whose counts cannot be read says nothing', async () => {
  const {reportCoverageNotes} = await import('../dist/src/report-coverage-notes.js');
  assert.deepEqual(
    reportCoverageNotes({
      metrics_coverage: {
        // Earlier builds: a sum wrote known/total, a ratio known_rows/total, the cost per result known_pairs/total, and
        // every unit was called a native measurement although it counted rows.
        spend: {known: 1, total: 2, basis: 'native_measurements', report_rows: 2},
        cpc: {known_rows: 1, total: 2, basis: 'native_measurements', report_rows: 2, known_pairs: 1},
        cost_per_result: {known_pairs: 1, total: 2, basis: 'native_measurements', report_rows: 2},
        clicks: {note: 'no counts'},
        impressions: 'not an entry',
      },
    }),
    [
      {metric: 'spend', known: 1, total: 2, unit: 'rows', reason: 'missing_values'},
      {metric: 'cpc', known: 1, total: 2, unit: 'rows', reason: 'missing_inputs'},
      {metric: 'cost_per_result', known: 1, total: 2, unit: 'rows', reason: 'missing_inputs'},
    ],
  );
});

test('the words of a note: the counts first in English, after the colon in Arabic, and a reason where nothing is calculated', async () => {
  const {reportCoverageLine, reportCoverageHelp} = await import('../dist/src/report-coverage-notes.js');
  const note = (reason, more = {}) => ({metric: 'spend', known: 26, total: 28, unit: 'rows', reason, ...more});
  assert.equal(reportCoverageLine(note('missing_values'), 'spend'), 'spend: 26 of 28 rows');
  assert.equal(reportCoverageLine(note('missing_values', {known: 0, total: 1}), 'spend'), 'spend: 0 of 1 row');
  assert.equal(
    reportCoverageLine(note('missing_values', {unit: 'measurements', known: 1, total: 2}), 'spend'),
    'spend: 1 of 2 measurements',
  );
  assert.equal(reportCoverageLine(note('missing_inputs'), 'cpc', 'ar'), 'cpc: الصفوف 26 من 28');
  assert.equal(
    reportCoverageLine(note('missing_values', {unit: 'measurements'}), 'spend', 'ar'),
    'spend: القياسات 26 من 28',
  );
  assert.match(reportCoverageLine(note('unknown_currency'), 'spend'), /^spend: not added \(.*currencies/);
  assert.match(reportCoverageLine(note('non_additive_inputs'), 'frequency'), /cannot be calculated from several rows/);
  assert.match(reportCoverageLine(note('calculation_limit'), 'cpa'), /not calculated/);
  for (const reason of ['unknown_currency', 'non_additive_inputs', 'calculation_limit'])
    assert.match(reportCoverageLine(note(reason), 'spend', 'ar'), /[؀-ۿ]/);
  assert.match(reportCoverageHelp(), /never counted as 0/);
  assert.match(reportCoverageHelp('ar'), /ولا تُحتسب صفرًا/);
});

test('a report of 28 campaigns whose cost is null on two is complete, and its spend says 26 of 28 rows', async t => {
  const {report, stored} = await shortSpend(t);
  assert.equal(report.state, 'complete', 'the collection is complete: state stays the collection truth');
  assert.equal(stored.summary[0].complete, true);
  const [summary] = report.summary;
  assert.equal(summary.metrics.spend, '273');
  assert.equal(summary.metrics.cpc, '1.5');
  assert.deepEqual(summary.coverage_notes, [
    {metric: 'spend', known: 26, total: 28, unit: 'rows', reason: 'missing_values'},
    {metric: 'cpc', known: 26, total: 28, unit: 'rows', reason: 'missing_inputs'},
  ]);
  // The stored document is untouched: the notes are derived on every read.
  assert.equal(stored.summary[0].coverage_notes, undefined);
});

test('a v3 report keeps its summaries and its table as recorded', async () => {
  const {projectOverviewV4Summaries} = await import('../dist/src/overview-v4.js'),
    v3 = packFixture();
  assert.notEqual(v3.config.contract_version, 'overview-config-v4');
  assert.deepEqual(projectOverviewV4Summaries(v3), {}, 'get adds nothing to a v3 snapshot');
  assert.equal(reportTable(v3)[0].includes('Coverage'), false);
  assert.equal(reportTable(v3).length, 3, 'a header and its two rows, no note row');
});

test('the CSV names the short totals in rows a spreadsheet reads as notes, and every data row still parses as data', async t => {
  const {stored} = await shortSpend(t),
    [header, ...body] = parse(exportCsv(stored)),
    column = name => header.indexOf(name),
    notes = body.filter(cells => cells[column('Platform')] === 'Coverage note'),
    data = body.filter(cells => cells[column('Platform')] !== 'Coverage note');
  assert.equal(data.length, 28, 'the data rows are the campaigns, and only they');
  assert.equal(notes.length, 2, 'one note for the summary, one saying what "n of m" means');
  assert.match(notes[0][column('Campaign')], /^Meta \| spend: 26 of 28 rows; cpc: 26 of 28 rows$/);
  assert.match(notes[1][column('Campaign')], /never counted as 0/);
  // The report is rectangular and the metric columns hold numbers or nothing, in the data rows and the notes alike.
  for (const cells of body) assert.equal(cells.length, header.length);
  for (const cells of body) for (const name of metrics) assert.match(cells[column(name)], /^(-?\d+(\.\d+)?)?$/);
  assert.deepEqual(
    notes.map(cells => cells[column('spend')] + cells[column('clicks')] + cells[column('cpc')]),
    ['', ''],
  );
  assert.equal(notes[0][column('Account ID')], '100');
  assert.equal(notes[0][column('Currency')], 'USD');
  // Each row says which of its own figures are short; a complete row says nothing.
  const own = data.map(cells => cells[column('Coverage')]);
  assert.equal(own.filter(Boolean).length, 2);
  assert.equal(own[0], 'spend: 0 of 1 row; cpc: 0 of 1 row');
  assert.equal(own[5], '');
  assert.equal(
    data.reduce((sum, cells) => sum + Number(cells[column('spend')] || 0), 0),
    273,
    'summing the column gives the figure the note qualifies',
  );
});

test('a whole level with no cost is stated for that level only', async t => {
  const rowsFor = level =>
      level === 'ad'
        ? ['a1', 'a2', 'a3', 'a4'].map(id => row('ad', id, {spend: null}))
        : [row('campaign', 'c1', {spend: '10'})],
    {report, stored} = await shortSpend(t, {levels: ['campaign', 'ad'], rowsFor});
  assert.equal(report.state, 'complete');
  const [campaign, ad] = report.summary;
  assert.equal(ad.entity_level, 'ad');
  assert.equal(ad.metrics.spend, null);
  assert.deepEqual(campaign.coverage_notes, []);
  assert.deepEqual(ad.coverage_notes, [
    {metric: 'spend', known: 0, total: 4, unit: 'rows', reason: 'missing_values'},
    {metric: 'cpc', known: 0, total: 4, unit: 'rows', reason: 'missing_inputs'},
  ]);
  const [header, ...body] = parse(exportCsv(stored)),
    note = body.find(cells => cells[header.indexOf('Platform')] === 'Coverage note');
  assert.equal(note[header.indexOf('Entity level')], 'ad');
  assert.match(note[header.indexOf('Campaign')], /spend: 0 of 4 rows/);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await reportWorkbook(stored));
  const sheet = book.getWorksheet('Account summaries'),
    head = sheet.getRow(1).values,
    cell = (r, name) => sheet.getRow(r).getCell(head.indexOf(name)).value;
  assert.equal(cell(2, 'Entity level'), 'campaign');
  assert.equal(cell(2, 'Coverage'), null, 'the complete level says nothing');
  assert.equal(cell(3, 'Entity level'), 'ad');
  assert.match(cell(3, 'Coverage'), /spend: 0 of 4 rows/);
});

for (const language of ['en', 'ar']) {
  test(
    language + ': the workbook states the coverage beside the totals, on the report sheet and in the rows',
    async t => {
      const {stored} = await shortSpend(t),
        book = new ExcelJS.Workbook(),
        ar = language === 'ar',
        spend = ar ? 'spend\\)?: الصفوف 26 من 28' : 'spend: 26 of 28 rows';
      await book.xlsx.load(await reportWorkbook(stored, {artifact_language: language}));
      const sheet = book.getWorksheet(ar ? 'ملخصات الحسابات' : 'Account summaries'),
        head = sheet.getRow(1).values,
        coverage = head.indexOf(ar ? 'التغطية' : 'Coverage');
      assert.ok(coverage > 0, 'the summaries have a coverage column');
      assert.match(sheet.getRow(2).getCell(coverage).value, new RegExp(spend));
      assert.match(sheet.getRow(2).getCell(coverage).value, ar ? /cpc\)?: الصفوف 26 من 28/ : /cpc: 26 of 28 rows/);
      // The first sheet is where a reader starts: the coverage is there too, with what it means.
      const first = book.worksheets[0],
        lines = [];
      first.eachRow(r => {
        if (r.getCell(1).value === (ar ? 'التغطية' : 'Coverage')) lines.push(r.getCell(2).value);
      });
      assert.equal(lines.length, 2);
      assert.match(lines[0], new RegExp(spend));
      assert.match(lines[1], ar ? /ولا تُحتسب صفرًا/ : /never counted as 0/);
      // The rows sheet carries a note row after the 28 campaigns.
      const rows = book.getWorksheet(ar ? 'صفوف الحملات' : 'Campaign rows');
      assert.equal(rows.rowCount, 1 + 28 + 2);
      assert.match(rows.getRow(30).getCell(4).value, new RegExp(spend));
      assert.equal(rows.getRow(30).getCell(1).value, ar ? 'ملاحظة التغطية' : 'Coverage note');
      // Numbers stay numbers: the metric cells of a note row are empty, so a column of numbers is still one.
      assert.equal(rows.getRow(30).getCell(10).value, null);
    },
  );

  test(language + ': the PDF states the coverage under the totals it qualifies', async t => {
    const {stored} = await shortSpend(t),
      words = pdfWords(await reportPdf(stored, {artifact_language: language}));
    assert.match(words, language === 'ar' ? /spend\)?: الصفوف 26 من 28/ : /spend: 26 of 28 rows/);
    assert.match(words, language === 'ar' ? /ولا تُحتسب صفرًا/ : /never counted as 0/);
  });

  test(
    language + ': the card says "26 of 28 rows" and that its coverage is limited, though its source is complete',
    async t => {
      const {report, bootstrap} = await shortSpend(t),
        view = reportPage(language, bootstrap),
        card = plainText(summaryCards(view.call('renderReportSummary(report)', {report}))[0]),
        limited = view.text('Limited coverage: these totals may be incomplete.');
      assert.equal(report.sources[0].complete, true, 'nothing the source collected is missing');
      assert.match(card, language === 'ar' ? /الصفوف: 26 من 28/ : /26 of 28 rows/);
      assert.ok(card.includes(limited), card);
      // A complete report has no such line.
      const whole = await shortSpend(t, {
        rowsFor: () => campaigns.map(r => ({...r, metrics: {...r.metrics, spend: '10.5'}})),
      });
      assert.equal(whole.report.summary[0].coverage_notes.length, 0);
      const complete = plainText(
        summaryCards(
          reportPage(language, whole.bootstrap).call('renderReportSummary(report)', {report: whole.report}),
        )[0],
      );
      assert.equal(complete.includes(limited), false);
    },
  );
}

test('the window summary card of a grouped report says it too', async t => {
  const range = {since: '2026-09-07', until: '2026-09-20'},
    {report, bootstrap} = await shortSpend(t, {changes: {grain: 'weekly', date_range: range}});
  assert.ok(report.window_summary.length);
  const [window] = report.window_summary;
  assert.deepEqual(window.coverage_notes[0], {
    metric: 'spend',
    known: 52,
    total: 56,
    unit: 'rows',
    reason: 'missing_values',
  });
  const view = reportPage('en', bootstrap),
    card = plainText(summaryCards(view.call('renderReportWindowSummary(report)', {report}))[0]);
  assert.match(card, /52 of 56 rows/);
  assert.ok(card.includes('Limited coverage: these totals may be incomplete.'), card);
});

test('Sheets receives the note rows and the row coverage, and describes the column in its header note', async t => {
  const f = overviewGranularityFixture(),
    meta = reportSource('meta').overview,
    connection = granularSource('meta', 'campaign');
  t.after(() => f.close());
  f.overview.native.collect = async (source, dates) => ({
    source,
    rows: structuredClone(campaigns),
    currency: 'USD',
    timezone: 'UTC',
    complete: true,
    collection_complete: true,
    source_kind: 'ads',
    date_range: dates,
    warnings: [],
    lineage: [],
    captured_at: Date.now(),
    result_definition: 'Synthetic results',
    attribution: 'Synthetic click window',
    quality: {version: 2, status: 'complete'},
  });
  const queued = await f.overview.handle(
    {
      action: 'run',
      confirmed: true,
      config: {
        ...granularConfig(
          {
            platform: 'meta',
            connection_id: connection.connection_id,
            account_id: connection.account_id,
            levels: ['campaign'],
            statuses: ['all'],
            delivered_only: false,
            report_options: {...meta.defaults, complete_window: true},
          },
          'total',
        ),
        contract_version: 'overview-config-v4',
        metrics,
      },
    },
    f.actor,
  );
  await f.worker.once();
  const destination = await f.overview.handle(
    {
      action: 'bind_destination',
      connection_id: 'sheets-granular',
      spreadsheet_id: 'syntheticGranularSheet',
      tab_name: 'Coverage',
      idempotency_key: 'coverage-sheet',
      confirmed: true,
    },
    f.actor,
  );
  await f.overview.handle(
    {action: 'export', report_id: queued.id, destination_id: destination.id, confirmed: true},
    f.actor,
  );
  assert.equal(await f.worker.once(), true);
  const cells = f.tabs.get(destination.sheet_id).values,
    header = cells[0].map(cell => cell.stringValue),
    at = name => header.indexOf(name),
    notes = cells.filter(line => line[at('Platform')]?.stringValue === 'Coverage note');
  assert.equal(cells.length, 1 + 28 + 2);
  assert.equal(notes.length, 2);
  assert.equal(notes[0][at('Campaign')].stringValue, 'Meta | spend: 26 of 28 rows; cpc: 26 of 28 rows');
  assert.match(notes[1][at('Campaign')].stringValue, /never counted as 0/);
  assert.equal(cells[1][at('Coverage')].stringValue, 'spend: 0 of 1 row; cpc: 0 of 1 row');
  const batch = f.requests.find(r => r.url.hostname === 'sheets.googleapis.com' && r.method === 'POST').body,
    note = batch.requests.find(r => r.repeatCell?.cell?.note && r.repeatCell.range.startColumnIndex === at('Coverage'));
  assert.match(note.repeatCell.cell.note, /calculated from some of their measurements only/);
});

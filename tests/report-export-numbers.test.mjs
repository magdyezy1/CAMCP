// F-L5-07: a v4 report keeps every metric as exact decimal text, and the Excel workbook and the Sheets tab wrote that text,
// so `SUM` in a client's sheet gave 0 and number formats did not apply. At the export boundary a metric cell is now the
// number when the decimal text is exactly that number, and stays text, with a note that says why, when a number would
// lose digits. IDs and names are never numbers, and a report before v4 keeps its cells.
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {reportWorkbook} from '../dist/src/report-artifacts.js';
import {reportSource} from '../dist/src/report-sources.js';
import {row} from './helpers/report-packets.mjs';
import {reportEngine} from './helpers/report-engine.mjs';
import {overviewGranularityFixture, granularConfig, granularSource} from './fixtures/overview-granularity-data.mjs';
import {packFixture} from './fixtures/report-pack-data.mjs';

const huge = '123456789012345678901234567890.123456789';
const rows = () => [
  row('campaign', 'c1', {spend: '10.5', clicks: '7'}),
  row('campaign', 'c2', {spend: '0.100000001', clicks: '3'}),
  row('campaign', 'c3', {spend: huge, clicks: '1'}),
];
const metrics = ['spend', 'clicks', 'cpc'];

test('a decimal becomes a number only when it is exactly that number', async () => {
  const {exactNumber, keptAsText} = await import('../dist/src/export-number.js');
  for (const [text, number] of [
    ['273', 273],
    ['10.5', 10.5],
    ['0.100000001', 0.100000001],
    ['-3', -3],
    ['0', 0],
    ['-0', 0],
    ['0.000000001', 1e-9],
    ['1000000000', 1e9],
    ['0.30000000000000004', 0.30000000000000004],
    ['123456789012345680000', 123456789012345680000],
  ])
    assert.equal(exactNumber(text), number, text);
  assert.ok(Object.is(exactNumber('-0'), 0), 'there is no negative zero in a cell');
  // More digits than a double holds, or digits that a double would change: the text stays.
  for (const text of [
    '9007199254740993',
    huge,
    '1.0000000000000001',
    '0.1000000000000000055511151231257827',
    '99999999999999999999.5',
  ]) {
    assert.equal(exactNumber(text), null, text);
    assert.equal(keptAsText(text), true, text);
  }
  // Not a decimal at all: never a number, and not "kept as text" because of its digits.
  for (const value of ['1e3', 'abc', '', ' 5', '5 ', '0x10', '1,000', null, undefined, 5, true, {}]) {
    assert.equal(exactNumber(value), null, String(value));
    assert.equal(keptAsText(value), false, String(value));
  }
});

test('the workbook of a v4 report holds numbers in its metric cells, so SUM works, and keeps a huge decimal exact', async t => {
  const e = reportEngine(t, {rowsFor: () => rows()}),
    {stored} = await e.go(['campaign'], {metrics}),
    book = new ExcelJS.Workbook();
  assert.equal(stored.state, 'complete');
  await book.xlsx.load(await reportWorkbook(stored));
  const sheet = book.getWorksheet('Campaign rows'),
    header = sheet.getRow(1).values,
    column = name => header.indexOf(name),
    cell = (r, name) => sheet.getRow(r).getCell(column(name));
  // The campaigns' spend: two numbers and the text that no number holds.
  assert.equal(cell(2, 'spend').type, ExcelJS.ValueType.Number);
  assert.equal(cell(2, 'spend').value, 10.5);
  assert.equal(cell(3, 'spend').type, ExcelJS.ValueType.Number);
  assert.equal(cell(3, 'spend').value, 0.100000001);
  assert.equal(cell(4, 'spend').type, ExcelJS.ValueType.String);
  assert.equal(cell(4, 'spend').value, huge, 'every digit survives');
  // The cell values a SUM adds: the numbers add, and the text is left to its note.
  const numbers = [2, 3, 4].map(r => cell(r, 'spend').value).filter(value => typeof value === 'number');
  assert.ok(Math.abs(numbers.reduce((sum, value) => sum + value, 0) - 10.600000001) < 1e-9);
  assert.equal(cell(2, 'cpc').value, 1.5);
  assert.equal(cell(2, 'clicks').value, 7);
  // IDs and names are never numbers, even when they look like one.
  assert.equal(cell(2, 'Account ID').value, '100');
  assert.equal(cell(2, 'Account ID').type, ExcelJS.ValueType.String);
  assert.equal(cell(2, 'Campaign ID').value, 'c1');
  // The account summaries add the same cells; their huge sum is text, the clicks a number.
  const summaries = book.getWorksheet('Account summaries'),
    head = summaries.getRow(1).values,
    total = name => summaries.getRow(2).getCell(head.indexOf(name));
  assert.equal(total('clicks').value, 11);
  assert.equal(total('clicks').type, ExcelJS.ValueType.Number);
  assert.equal(total('spend').type, ExcelJS.ValueType.String);
  assert.equal(total('spend').value, '123456789012345678901234567900.72345679');
  // The report sheet says how many metric values are text, and why.
  const notes = [];
  book.worksheets[0].eachRow(r => {
    if (r.getCell(1).value === 'Precision') notes.push(r.getCell(2).value);
  });
  assert.deepEqual(notes, [
    'Metric values kept as text, because a number holds fewer digits than they have: 4. All other metric values are numbers.',
  ]);
});

test('with no value too long for a number, every metric cell is a number and the workbook has no precision note', async t => {
  const e = reportEngine(t, {
      rowsFor: () =>
        Array.from({length: 28}, (_, i) => row('campaign', 'c' + i, {spend: i < 2 ? null : '10.5', clicks: '7'})),
    }),
    {stored} = await e.go(['campaign'], {metrics}),
    book = new ExcelJS.Workbook();
  await book.xlsx.load(await reportWorkbook(stored));
  const sheet = book.getWorksheet('Campaign rows'),
    spend = sheet.getRow(1).values.indexOf('spend'),
    values = sheet.getColumn(spend).values.slice(2, 30);
  assert.equal(values.filter(value => typeof value === 'number').length, 26, 'a null stays an empty cell');
  assert.equal(
    values.reduce((sum, value) => sum + (typeof value === 'number' ? value : 0), 0),
    273,
    'SUM of the column is the report total',
  );
  const summary = book.getWorksheet('Account summaries');
  assert.equal(summary.getRow(2).getCell(summary.getRow(1).values.indexOf('spend')).value, 273);
  let precision = false;
  book.worksheets[0].eachRow(r => (precision ||= r.getCell(1).value === 'Precision'));
  assert.equal(precision, false);
});

test('the Arabic workbook says it in Arabic, with the counts after the colon', async t => {
  const e = reportEngine(t, {rowsFor: () => rows()}),
    {stored} = await e.go(['campaign'], {metrics}),
    book = new ExcelJS.Workbook();
  await book.xlsx.load(await reportWorkbook(stored, {artifact_language: 'ar'}));
  const notes = [];
  book.worksheets[0].eachRow(r => {
    if (r.getCell(1).value === 'الدقة') notes.push(r.getCell(2).value);
  });
  assert.deepEqual(notes, ['قيم المقاييس المحفوظة نصًّا لأن الرقم لا يتسع لكل أرقامها: 4. وسائر قيم المقاييس أرقام.']);
});

test('a report before v4 keeps the cells it had: a text value stays text', async () => {
  const report = packFixture();
  report.rows[0].metrics.spend = '12.5';
  report.summary[0].metrics.spend = '12.5';
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await reportWorkbook(report));
  assert.equal(book.getWorksheet('Campaign rows').getCell('J2').value, '12.5');
  assert.equal(book.getWorksheet('Campaign rows').getCell('J3').value, 13.5);
  assert.equal(book.getWorksheet('Account summaries').getCell('K2').value, '12.5');
  assert.equal(
    book.worksheets[0].getColumn(1).values.includes('Precision'),
    false,
    'and the report sheet says nothing about precision',
  );
});

test('the Sheets tab holds the same numbers, keeps the huge decimal as text, notes the column, and formats fractions as fractions', async t => {
  const f = overviewGranularityFixture(),
    meta = reportSource('meta').overview,
    connection = granularSource('meta', 'campaign');
  t.after(() => f.close());
  f.overview.native.collect = async (source, dates) => ({
    source,
    rows: [
      row('campaign', 'c1', {spend: '10.5', clicks: '7.5'}),
      row('campaign', 'c2', {spend: '0.100000001', clicks: '3'}),
      row('campaign', 'c3', {spend: huge, clicks: '1'}),
    ],
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
      tab_name: 'Numbers',
      idempotency_key: 'numbers-sheet',
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
    at = name => header.indexOf(name);
  assert.deepEqual(cells[1][at('spend')], {numberValue: 10.5});
  assert.deepEqual(cells[2][at('spend')], {numberValue: 0.100000001});
  assert.deepEqual(cells[3][at('spend')], {stringValue: huge});
  assert.deepEqual(cells[1][at('clicks')], {numberValue: 7.5});
  assert.deepEqual(cells[1][at('cpc')], {numberValue: 1.4});
  // IDs are text, whatever they look like.
  assert.deepEqual(cells[1][at('Account ID')], {stringValue: '100'});
  assert.deepEqual(cells[1][at('Campaign ID')], {stringValue: 'c1'});
  const batch = f.requests.find(r => r.url.hostname === 'sheets.googleapis.com' && r.method === 'POST').body,
    note = name =>
      batch.requests.find(r => r.repeatCell?.cell?.note && r.repeatCell.range.startColumnIndex === at(name))?.repeatCell
        .cell.note,
    format = name =>
      batch.requests.find(
        r => r.repeatCell?.cell?.userEnteredFormat?.numberFormat && r.repeatCell.range.startColumnIndex === at(name),
      )?.repeatCell.cell.userEnteredFormat.numberFormat.pattern;
  assert.match(note('spend'), /Values with more digits than a number holds exactly are kept as text\.$/);
  assert.doesNotMatch(note('clicks'), /kept as text/);
  // A count with a fraction is shown with one: the column's numbers decide, not the text they were written as.
  assert.equal(format('clicks'), '#,##0.00');
});

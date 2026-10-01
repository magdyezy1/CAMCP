import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {reportWorkbook, reportPdf} from '../dist/src/report-artifacts.js';
import {presentationStyle, defaultPresentation} from '../dist/src/report-packs.js';
import {packFixture} from './fixtures/report-pack-data.mjs';
import {inflateSync} from 'node:zlib';
import {reportEvidence} from '../dist/src/report-quality.js';

test('artifact language is explicit and optional; legacy presentation bytes keep their original shape', () => {
  assert.deepEqual(presentationStyle({}), defaultPresentation);
  assert.equal(Object.hasOwn(presentationStyle({}), 'artifact_language'), false);
  assert.equal(presentationStyle({artifact_language: 'ar'}).artifact_language, 'ar');
  assert.equal(presentationStyle({artifact_language: 'en'}).artifact_language, 'en');
  for (const language of ['fr', null, 'ar-SA', {}, true])
    assert.throws(() => presentationStyle({artifact_language: language}));
});

test('Arabic workbook headings and RTL views preserve numeric cells, native text, custom identifiers and exact evidence', async () => {
  const report = packFixture();
  report.config.custom_metrics = [{id: 'client_cost', label: 'Spend', expression: 'spend / clicks'}];
  for (const row of [...report.rows, ...report.summary]) row.metrics.client_cost = 6.25;
  const original = JSON.stringify(report),
    english = new ExcelJS.Workbook(),
    arabic = new ExcelJS.Workbook();
  await english.xlsx.load(await reportWorkbook(report));
  await arabic.xlsx.load(await reportWorkbook(report, {artifact_language: 'ar'}));
  assert.deepEqual(
    arabic.worksheets.map(s => s.name),
    ['التقرير', 'ملخصات الحسابات', 'صفوف الحملات', 'تغطية المصادر', 'الأدلة'],
  );
  assert.equal(arabic.getWorksheet('صفوف الحملات').views[0].rightToLeft, true);
  assert.equal(arabic.getWorksheet('صفوف الحملات').getCell('B1').value, 'معرّف الحساب');
  assert.match(arabic.getWorksheet('ملخصات الحسابات').getCell('K1').value, /الإنفاق/);
  const customColumn = arabic.getWorksheet('ملخصات الحسابات').getRow(1).values.indexOf('client_cost');
  assert.ok(customColumn > 0);
  assert.equal(arabic.getWorksheet('ملخصات الحسابات').getCell(2, customColumn).value, 6.25);
  for (let sheet = 1; sheet < english.worksheets.length; sheet++) {
    const a = arabic.worksheets[sheet],
      b = english.worksheets[sheet];
    for (let row = 2; row <= b.rowCount; row++) assert.deepEqual(a.getRow(row).values, b.getRow(row).values);
  }
  assert.equal(arabic.getWorksheet('صفوف الحملات').getCell('D2').type, ExcelJS.ValueType.String);
  assert.equal(JSON.stringify(report), original);
});

test('Arabic PDF declares its language, embeds original logical text and preserves source evidence', async () => {
  const report = packFixture();
  report.config.name = 'تقرير الأداء - AMCP 2026';
  const bytes = await reportPdf(report, {artifact_language: 'ar'}),
    text = bytes.toString('latin1');
  assert.match(text, /\/Lang \(ar\)/);
  const streams = [...text.matchAll(/<<[^]*?\/Length (\d+)\s*\/Filter \/FlateDecode\s*>>\s*stream\r?\n/g)].map(
    match => {
      const start = match.index + match[0].length;
      return inflateSync(bytes.subarray(start, start + Number(match[1])));
    },
  );
  assert.ok(
    streams.some(s => s.toString('latin1').includes('/ActualText')),
    'Logical text must be retained in marked PDF content.',
  );
  assert.ok(
    streams.some(s => s.toString('utf8') === JSON.stringify(reportEvidence(report), null, 2)),
    'The original source-evidence attachment must remain byte-identical.',
  );
  assert.match(text, /\/FontFile2/);
  assert.doesNotMatch(text, /\/JavaScript|\/OpenAction/);
  assert.ok((text.match(/\/Type \/Page\b/g) ?? []).length <= 4);
});

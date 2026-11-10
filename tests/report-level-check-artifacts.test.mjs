// F-L5-05: `get` returned the cross-level check (sources[].cross_level), and the report page drew it, but the PDF and the
// Excel workbook said nothing of whether the levels of a source agree. They now word the same facts with the same
// sentences, in the report's language, with the percentage cut from the server's decimal and never read as 100 when the
// totals differ. The snapshots are built by the real engine (queue, worker, assembly, reconciliation, get).
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {MirrorError} from '../dist/src/errors.js';
import {reportWorkbook, reportPdf} from '../dist/src/report-artifacts.js';
import {reportSource} from '../dist/src/report-sources.js';
import {row} from './helpers/report-packets.mjs';
import {reportEngine} from './helpers/report-engine.mjs';
import {pdfActualText} from './helpers/pdf-actual-text.mjs';
import {pdfPlainText} from './helpers/pdf-plain-text.mjs';
import {reportPage, plainText} from './helpers/report-page.mjs';

/** Campaign and ad rows: the campaign spends `campaign`, the ad `ad`, and both deliver the same impressions and clicks. */
const levels = (campaign, ad) => level =>
  level === 'ad' ? [row('ad', 'a1', {spend: ad})] : [row('campaign', 'c1', {spend: campaign})];
async function check(t, rowsFor, more = {}) {
  const e = reportEngine(t, {rowsFor, ...more}),
    done = await e.go(['campaign', 'ad'], {metrics: ['spend', 'impressions', 'clicks']});
  return {...done, bootstrap: await e.overview.handle({action: 'bootstrap'}, e.actor)};
}
const lineBreaks = text => String(text).split('\n');
/** The check as the report page prints it. */
const pageLines = (view, report) =>
  [...view.call('renderReportLevelCheck(report)', {report}).matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map(item =>
    plainText(item[1]),
  );
/** The 'Level check' cell of the first source of a workbook, as lines. */
async function workbookLines(stored, language = 'en') {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await reportWorkbook(stored, {artifact_language: language}));
  const sheet = book.getWorksheet(language === 'ar' ? 'تغطية المصادر' : 'Source coverage'),
    column = sheet.getRow(1).values.indexOf(language === 'ar' ? 'مطابقة المستويات' : 'Level check');
  return {column, lines: column > 0 ? lineBreaks(sheet.getRow(2).getCell(column).value) : []};
}

const cases = {
  agree: levels('100.000001', '100.000001'),
  // 97.000001 of 100.000001 is 97.00000003%: a shortfall, and the metrics that still agree keep their line.
  short: levels('100.000001', '97.000001'),
  // 99.7% is cut to 99%, never rounded up to 100.
  nearly: levels('100', '99.7'),
  above: levels('100.000001', '300.000001'),
  // The server rounds this to 100 at nine places although the totals differ: the line says they differ.
  rounds: levels('1000000000000', '999999999999'),
};

test('the workbook words the cross-level check of a source as the report page does', async t => {
  for (const [name, rowsFor] of Object.entries(cases)) {
    const {stored, report, bootstrap} = await check(t, rowsFor),
      view = reportPage('en', bootstrap),
      {lines} = await workbookLines(stored);
    assert.ok(lines.length, name);
    assert.deepEqual(lines, pageLines(view, report), name);
  }
});

test('the lines say what they must: a shortfall by its cut percentage, above 100 as adding up to more, and never 100 for a difference', async t => {
  const said = async name => {
    const {stored} = await check(t, cases[name]);
    return (await workbookLines(stored)).lines;
  };
  assert.deepEqual(await said('agree'), [
    'Levels agree on spend, impressions, and clicks / taps / swipes (Campaign and Ad).',
  ]);
  assert.deepEqual(await said('short'), [
    'Ad rows cover 97% of campaign spend.',
    'Levels agree on impressions and clicks / taps / swipes (Campaign and Ad).',
  ]);
  assert.equal((await said('nearly'))[0], 'Ad rows cover 99% of campaign spend.');
  assert.equal((await said('above'))[0], 'Ad rows add up to 299% of campaign spend.');
  const rounds = await said('rounds');
  assert.equal(rounds[0], 'Ad rows and campaign rows differ on spend.');
  assert.doesNotMatch(rounds.join(' '), /100\s*%/);
});

test('a level that is partial or failed gives its reason in words', async t => {
  // One of the two ads has no cost: the levels cannot be compared in full, and the delivery they share still agrees.
  const partial = await check(t, level =>
      level === 'ad'
        ? [
            row('ad', 'a1', {spend: '0.5', impressions: '50', clicks: '5'}),
            row('ad', 'a2', {spend: null, impressions: '50', clicks: '5'}),
          ]
        : [row('campaign', 'c1', {spend: '1'})],
    ),
    failed = await check(t, levels('10', '10'), {
      fail: source =>
        source.level === 'ad' ? new MirrorError('PLATFORM_ERROR', 'Synthetic refusal', {}, 502, false) : undefined,
    });
  assert.equal(partial.stored.sources[0].cross_level[0].state, 'partial');
  assert.match(
    (await workbookLines(partial.stored)).lines[0],
    /^Spend could not be fully compared between Campaign and Ad rows: some values are unknown, or a level was not fully collected\.$/,
  );
  assert.equal(failed.stored.sources[0].cross_level[0].unavailable_reason, 'level_failed');
  assert.equal(
    (await workbookLines(failed.stored)).lines[0],
    'Spend, Impressions, and Clicks / taps / swipes cannot be compared between Campaign and Ad rows: a level could not be collected.',
  );
  assert.deepEqual(
    (await workbookLines(failed.stored)).lines,
    pageLines(reportPage('en', failed.bootstrap), failed.report),
  );
});

test('the percentage is cut from the decimal text, exactly as the page cuts it', async () => {
  const {levelCheckPercent} = await import('../dist/src/report-level-check.js');
  for (const [value, shown] of [
    ['97', '97%'],
    ['97.00000003', '97%'],
    ['99.999999999', '99%'],
    ['100', '100%'],
    ['100.4', '100.4%'],
    ['100.0000001', '100.0000001%'],
    ['0', '0%'],
    ['0.04', '0.04%'],
    ['299.999997', '299%'],
    ['1500.5', '1,500%'],
  ])
    assert.equal(levelCheckPercent(value), shown, value);
  for (const value of [null, undefined, '', '-5', 'abc', '1e3', '97.5.1'])
    assert.equal(levelCheckPercent(value), null, String(value));
});

test('a source of one level, and a report that is not v4, add no level check', async t => {
  const e = reportEngine(t, {rowsFor: () => [row('campaign', 'c1')]}),
    {stored} = await e.go(['campaign']);
  assert.equal((await workbookLines(stored)).column, -1);
  const {packFixture} = await import('./fixtures/report-pack-data.mjs'),
    book = new ExcelJS.Workbook();
  await book.xlsx.load(await reportWorkbook(packFixture()));
  assert.deepEqual(book.getWorksheet('Source coverage').getRow(1).values.slice(1), [
    'Platform',
    'Account ID',
    'Connection',
    'Status',
    'Rows',
    'Error code',
    'Warning count',
    'Query fingerprint',
  ]);
});

for (const language of ['en', 'ar']) {
  test(language + ': the PDF and the workbook word a shortfall and a rounded gap in the report’s language', async t => {
    const short = await check(t, cases.short),
      rounds = await check(t, cases.rounds),
      ar = language === 'ar',
      words = pdf => (ar ? pdfActualText(pdf) : pdfPlainText(pdf).join(' ')).replace(/\s+/g, ' '),
      said = async snapshot => ({
        workbook: (await workbookLines(snapshot.stored, language)).lines,
        pdf: words(await reportPdf(snapshot.stored, {artifact_language: language})),
        // The PDF without its Charts section (V2-EXP-01). A chart's table may say that a lone campaign is 100% of the
        // spend, which is true and is not the level check's statement; what must never read 100% is a rounded gap.
        withoutCharts: words(await reportPdf({...snapshot.stored, charts: undefined}, {artifact_language: language})),
      }),
      one = await said(short),
      two = await said(rounds);
    const covers = ar
        ? 'تغطي صفوف الإعلان نسبة 97% من الإنفاق (spend) على مستوى الحملة.'
        : 'Ad rows cover 97% of campaign spend.',
      differs = ar
        ? 'تختلف صفوف الإعلان عن صفوف الحملة في الإنفاق (spend).'
        : 'Ad rows and campaign rows differ on spend.';
    assert.equal(one.workbook[0], covers);
    assert.ok(one.pdf.includes(covers), one.pdf);
    assert.equal(two.workbook[0], differs);
    assert.ok(two.pdf.includes(differs), two.pdf);
    assert.ok(two.withoutCharts.includes(differs));
    assert.doesNotMatch(two.workbook.join(' ') + two.withoutCharts, /100\s*%/);
    // The platform's own words for the levels: Meta's ad level is an ad, its campaign a campaign.
    assert.equal(reportSource('meta').overview.levels.find(level => level.id === 'ad').label, 'Ad');
  });
}

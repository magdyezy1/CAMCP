// F-L5-11: a report scoped to selected ads labels its rolled-up rows, but the summary tile and the workbook's account
// summaries showed the same total with no label, so a reader could mistake it for the campaign's own total. A summary now
// carries an aggregation kind (`rolled_up_from_selected`), a rolled-up total never shares a summary with a native one, and
// the label is printed wherever the total is shown: the tile, the Excel summaries, the PDF and the Sheets tab.
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {overviewGranularityFixture, granularConfig, granularSource} from './fixtures/overview-granularity-data.mjs';
import {overviewConfigV4} from '../dist/src/overview-v4.js';
import {reportSummary, reportWindowSummary} from '../dist/src/report-summary.js';
import {reportWorkbook, reportPdf} from '../dist/src/report-artifacts.js';
import {pdfActualText} from './helpers/pdf-actual-text.mjs';
import {pdfPlainText} from './helpers/pdf-plain-text.mjs';
import {reportPage, plainText} from './helpers/report-page.mjs';
import {row} from './helpers/report-packets.mjs';

const selected = '9007199254740993',
  other = '9007199254740994',
  label = 'Rolled up from selected ads',
  arabicLabel = 'مجمّع من الإعلانات المحددة';
const cards = html =>
  [...html.matchAll(/<article class="report-summary-card[^"]*">([\s\S]*?)<\/article>/g)].map(card => card[1]);

/** A Meta report of three levels scoped to one ad: the campaign and ad set are rolled up from it, the ad is native. */
async function scoped(t) {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  f.mutate((rows, platform) =>
    platform === 'meta'
      ? rows.flatMap(r =>
          r.ad_id ? [r, {...r, ad_id: other, spend: '100', impressions: '10000'}] : [{...r, spend: '100.100000001'}],
        )
      : rows,
  );
  const queued = await f.overview.handle(
    {
      action: 'run',
      confirmed: true,
      config: {
        ...granularConfig({
          ...granularSource('meta', 'campaign'),
          levels: ['campaign', 'adset', 'ad'],
          ad_ids: [selected],
        }),
        contract_version: overviewConfigV4,
        date_range: {since: '2026-09-01', until: '2026-09-01'},
        metrics: ['spend', 'impressions', 'clicks', 'cpc'],
      },
    },
    f.actor,
  );
  await f.worker.once();
  return {
    f,
    queued,
    report: await f.overview.handle({action: 'get', id: queued.id, limit: 100}, f.actor),
    stored: f.store.document(f.actor.tenantId, 'overview_report', queued.id),
    bootstrap: await f.overview.handle({action: 'bootstrap'}, f.actor),
  };
}

test('a summary of rolled-up rows says so, and a native total of the same level is a summary of its own', async t => {
  const {report} = await scoped(t);
  assert.equal(report.state, 'complete', JSON.stringify(report.sources));
  assert.deepEqual(
    report.summary.map(s => [s.entity_level, s.aggregation?.kind ?? null, s.metrics.spend]),
    [
      ['campaign', 'rolled_up_from_selected', '0.100000001'],
      ['adset', 'rolled_up_from_selected', '0.100000001'],
      ['ad', null, '0.100000001'],
    ],
  );
  assert.deepEqual(report.summary[0].aggregation, {
    kind: 'rolled_up_from_selected',
    from_level: 'ad',
    scope_field: 'ad_ids',
    label,
  });
  // Rows alone decide it: a rolled-up campaign row and a native one never add up, wherever they come from.
  const rolled = {
      ...row('campaign', 'c1', {spend: '10'}),
      platform: 'meta',
      account_id: '100',
      currency: 'USD',
      recommendation: {decision: 'observe'},
      date_from: '2026-09-01',
      date_to: '2026-09-02',
      entity_level: 'campaign',
      aggregation: {kind: 'rolled_up', from_level: 'ad', scope_field: 'ad_ids', child_rows: 1, label},
    },
    native = {...rolled, aggregation: undefined};
  for (const summarize of [reportSummary, reportWindowSummary]) {
    const groups = summarize([rolled, native, {...rolled, metrics: {...rolled.metrics, spend: '5'}}], [], true);
    assert.equal(groups.length, 2, summarize.name);
    assert.deepEqual(
      groups.map(g => [g.aggregation?.kind ?? null, g.metrics.spend]),
      [
        ['rolled_up_from_selected', '15'],
        [null, '10'],
      ],
    );
  }
});

for (const language of ['en', 'ar']) {
  const text = language === 'ar' ? arabicLabel : label;

  test(
    language + ': the summary tile of a rolled-up total carries the label, and the tile of a native total does not',
    async t => {
      const {report, bootstrap} = await scoped(t),
        view = reportPage(language, bootstrap),
        drawn = cards(view.call('renderReportSummary(report)', {report})).map(plainText);
      assert.equal(drawn.length, 3);
      assert.ok(drawn[0].includes(text), drawn[0]);
      assert.ok(drawn[1].includes(text), drawn[1]);
      assert.equal(drawn[2].includes(text), false, drawn[2]);
    },
  );

  test(
    language + ': the Excel account summaries carry an aggregation column, and the PDF labels each rolled-up total',
    async t => {
      const {stored} = await scoped(t),
        book = new ExcelJS.Workbook();
      await book.xlsx.load(await reportWorkbook(stored, {artifact_language: language}));
      const sheet = book.getWorksheet(language === 'ar' ? 'ملخصات الحسابات' : 'Account summaries'),
        column = sheet.getRow(1).values.indexOf(language === 'ar' ? 'التجميع' : 'Aggregation');
      assert.ok(column > 0, 'the summaries name their aggregation');
      assert.deepEqual(
        [2, 3, 4].map(r => sheet.getRow(r).getCell(column).value),
        [text, text, null],
      );
      const pdf = await reportPdf(stored, {artifact_language: language}),
        words = language === 'ar' ? pdfActualText(pdf) : pdfPlainText(pdf).join(' ');
      // Once at the top for the report, and again under each of the two rolled-up totals.
      assert.equal(words.split(text).length - 1, 3);
    },
  );
}

test('the Sheets tab labels its rolled-up rows and the totals named in its notes', async t => {
  const {f, queued} = await scoped(t),
    destination = await f.overview.handle(
      {
        action: 'bind_destination',
        connection_id: 'sheets-granular',
        spreadsheet_id: 'syntheticGranularSheet',
        tab_name: 'Rolled up',
        idempotency_key: 'rolled-up-sheet',
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
    aggregation = header.indexOf('Aggregation');
  assert.ok(aggregation > 0);
  assert.deepEqual(
    cells.slice(1).map(line => line[aggregation].stringValue),
    [label, label, ''],
  );
});

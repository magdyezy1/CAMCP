import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import ExcelJS from 'exceljs';
import {overviewGranularityFixture, granularSource, granularConfig} from './fixtures/overview-granularity-data.mjs';
import {reportTable, exportCsv} from '../dist/src/report-table.js';
import {reportPack} from '../dist/src/report-packs.js';
import {reportWorkbook} from '../dist/src/report-artifacts.js';

/**
 * F-L5-12 (label only): a Meta result is mapped by AMCP from documented fields (actions, link clicks, impressions, reach),
 * never read from Meta's Results column, whose shape is not pinned. The row says so on the website and in the exports,
 * from what the row's result already carries (`result_context.source` and the definition's native field).
 */
const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
const mappedLimitation =
  'Results shown as mapped are chosen by AMCP from the platform’s reported fields; they are not read from a result column of the platform’s own.';
const mappedHeader = 'Result mapped from';

async function snapshot(t, {v4}) {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  const {objective, level, ...source} = granularSource('meta', 'ad'),
    config = {
      ...granularConfig(source),
      ...(v4
        ? {contract_version: 'overview-config-v4', sources: [{...source, levels: ['ad']}]}
        : {sources: [{...source, level: 'ad'}]}),
    };
  const queued = await f.overview.handle({action: 'run', config, confirmed: true}, f.actor);
  await f.worker.once();
  const stored = f.store.document(f.actor.tenantId, 'overview_report', queued.id);
  assert.equal(stored.state, 'complete', JSON.stringify(stored.sources));
  return {f, stored, requests: f.requests};
}

test('the v4 Meta row carries a mapped result and the request still asks for Meta’s Results column', async t => {
  const {stored, requests} = await snapshot(t, {v4: true}),
    [row] = stored.rows;
  assert.equal(row.result_context.source, 'mapped');
  assert.equal(row.result_context.definition.native_metric, 'actions.purchase');
  assert.equal(row.result.value, '4');
  // Not parsed (the live shape is unpinned), but still requested, so the snapshot records it for the live check.
  const insights = requests.filter(
    item => item.url.hostname === 'graph.facebook.com' && item.url.pathname.endsWith('/insights'),
  );
  assert.ok(insights.length > 0);
  for (const request of insights) assert.ok(request.url.searchParams.get('fields').split(',').includes('results'));
});

test('exports name the native field a mapped result comes from, and v3 snapshots keep their columns', async t => {
  const {stored} = await snapshot(t, {v4: true}),
    table = reportTable(stored),
    column = table[0].indexOf(mappedHeader);
  assert.ok(column > 0, 'the table has the column: ' + table[0].join('|'));
  assert.ok(
    table[0].slice(column + 1).every(name => name === 'Report notices'),
    'a trailing column, so the others keep their places',
  );
  assert.deepEqual(
    table.slice(1).map(cells => cells[column]),
    ['actions.purchase'],
  );
  const lines = exportCsv(stored).split('\r\n');
  // Every CSV field is quoted.
  assert.ok(lines[0].split(',').includes('"' + mappedHeader + '"'));
  assert.ok(lines[1].split(',').includes('"actions.purchase"'));
  // A result the platform itself supplies, or a snapshot with no v4 result, has nothing to say.
  const provider = structuredClone(stored);
  for (const row of provider.rows) row.result_context.source = 'provider';
  assert.equal(reportTable(provider)[0].includes(mappedHeader), false);
  const {stored: legacy} = await snapshot(t, {v4: false});
  assert.equal(reportTable(legacy)[0].includes(mappedHeader), false);
  assert.equal(
    reportPack(legacy).limitations.some(item => item === mappedLimitation),
    false,
  );
});

test('the pack, the workbook and the PDF say mapped results are not the platform’s own result column', async t => {
  const {stored} = await snapshot(t, {v4: true});
  assert.ok(reportPack(stored).limitations.includes(mappedLimitation));
  const english = new ExcelJS.Workbook(),
    arabic = new ExcelJS.Workbook();
  await english.xlsx.load(await reportWorkbook(stored, {artifact_language: 'en'}));
  await arabic.xlsx.load(await reportWorkbook(stored, {artifact_language: 'ar'}));
  const cells = book => book.worksheets.flatMap(sheet => sheet.getSheetValues().flat().filter(Boolean));
  assert.ok(cells(english).includes(mappedLimitation));
  assert.ok(cells(english).includes(mappedHeader));
  const header = cells(arabic).find(value => typeof value === 'string' && /^النتيجة معيّنة من$/.test(value));
  assert.ok(header, 'the Arabic header');
  assert.equal(cells(arabic).includes(mappedLimitation), false);
  assert.ok(cells(arabic).some(value => typeof value === 'string' && /لا تُقرأ من عمود نتائج/.test(value)));
  // The native field is a literal, as IDs and native names always are.
  assert.ok(cells(arabic).includes('actions.purchase'));
});

function page(locale) {
  const context = createContext({
    document: {addEventListener() {}},
    pretty: String,
    date: value => new Date(value).toISOString(),
    esc: value =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    catalog,
  });
  const run = source => new Script(source).runInContext(context);
  for (const file of ['localization', 'report-library', 'report-quality', 'report-workflows', 'reporting-overview'])
    run(readFileSync('web/' + file + '.js', 'utf8'));
  run(`uiLocale='${locale}'; uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  return {context, run};
}
const row = (more = {}) => ({
  campaign_id: '101',
  campaign_name: 'Synthetic campaign',
  platform: 'meta',
  account_id: '100',
  objective_group: 'leads',
  objective_source: 'provider',
  result_definition: 'Leads',
  attribution: 'Meta 7d_click',
  timezone: 'UTC',
  native: {},
  metrics: {},
  recommendation: {decision: 'needs_review', reason: ''},
  ...more,
});
const render = (ui, rows) => {
  ui.context.report = {
    config: {name: 'Synthetic report', grain: 'total', date_range: {since: '2026-09-01', until: '2026-09-02'}},
    rows,
  };
  return String(ui.run('renderReportTable(report,[],{platforms:[{id:"meta",name:"Meta"}],metrics:{}})'));
};

for (const locale of ['en', 'ar'])
  test('the website says a mapped result comes from a field, in ' + locale, () => {
    const ui = page(locale),
      mapped = {
        result_context: {source: 'mapped', definition: {native_metric: 'actions.onsite_conversion.lead_grouped'}},
      },
      markup = render(ui, [row(mapped)]),
      sentence = 'Result mapped by AMCP from {field}, not read from a platform result column.';
    const expected = (locale === 'ar' ? catalog[sentence] : sentence).replace(
      '{field}',
      'actions.onsite_conversion.lead_grouped',
    );
    assert.ok(markup.includes(expected), expected);
    if (locale === 'ar') assert.match(expected, /[؀-ۿ]/u);
    const prefix = (locale === 'ar' ? catalog[sentence] : sentence).split('{field}')[0];
    // Rows whose result the platform supplied, rows with no v4 result, and a missing field say nothing.
    for (const quiet of [
      {result_context: {source: 'provider', definition: {native_metric: 'metrics.result'}}},
      {result_context: {source: 'unknown'}},
      {result_context: {source: 'mapped'}},
      {},
    ])
      assert.equal(render(ui, [row(quiet)]).includes(prefix), false, JSON.stringify(quiet));
    // A native field is text, never markup.
    const hostile = render(ui, [row({result_context: {source: 'mapped', definition: {native_metric: '<img src=x>'}}})]);
    assert.doesNotMatch(hostile, /<img src=x>/);
    assert.match(hostile, /&lt;img src=x&gt;/);
  });

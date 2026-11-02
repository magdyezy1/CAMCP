import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import ExcelJS from 'exceljs';
import {overviewGranularityFixture, granularSource, granularConfig} from './fixtures/overview-granularity-data.mjs';
import {reportEvidence} from '../dist/src/report-quality.js';
import {reportWorkbook} from '../dist/src/report-artifacts.js';
import {artifactLocale} from '../dist/src/report-localization.js';
import {linkedinResults} from '../dist/src/linkedin-report-source.js';

const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
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
async function snapshot(t, level) {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  f.mutate((rows, platform) =>
    platform === 'linkedin' ? rows.map(row => ({...row, oneClickLeads: '3', qualifiedLeads: '2'})) : rows,
  );
  f.parents((platform, url, body) =>
    platform === 'linkedin' && /\/adCampaign(?:Groups|s)$/.test(url.pathname)
      ? {...body, elements: body.elements.map(row => ({...row, objectiveType: 'LEAD_GENERATION'}))}
      : body,
  );
  const {objective, ...source} = granularSource('linkedin', level);
  if (level === 'campaign') delete source.report_options;
  const config = granularConfig(source);
  config.name = 'LinkedIn leads (one-click)';
  const queued = await f.overview.handle({action: 'run', config, confirmed: true}, f.actor);
  await f.worker.once();
  const report = await f.overview.handle({action: 'get', id: queued.id}, f.actor);
  assert.equal(report.state, 'complete', JSON.stringify(report.sources));
  return report;
}
for (const level of ['campaign', 'adset', 'ad'])
  test(level + ' snapshot retains its result definition and the saved native field mapping', async t => {
    const report = await snapshot(t, level),
      row = report.rows[0];
    assert.equal(row.metrics.conversions, 3);
    assert.equal(row.result_definition, 'LinkedIn leads (one-click)');
    assert.equal(row.objective_group, 'leads');
    assert.equal(row.metrics.native_linkedin_oneClickLeads, 3);
    assert.equal(row.metrics.native_linkedin_qualifiedLeads, 2);
    assert.equal(report.summary[0].metrics.cpa, 20.24 / 3);
    assert.equal(report.summary[0].metrics.cpl, 20.24 / 3);
    assert.equal(report.sources[0].metric_mapping.conversions.by_objective.LEAD_GENERATION, '/oneClickLeads');
    assert.equal(reportEvidence(report).metric_sources.linkedin, undefined);
    const ui = page('ar');
    ui.context.report = report;
    const markup = ui.run('renderReportTable(report,[],{platforms:[{id:"linkedin",name:"LinkedIn"}],metrics:{}})');
    assert.ok(markup.includes(catalog['LinkedIn leads (one-click)']));
    assert.doesNotMatch(markup.replace(/<caption>[\s\S]*?<\/caption>/, ''), /LinkedIn leads \(one-click\)/);
    const mapping = ui.run(
      'renderMetricSources(report,["conversions"],{platforms:[],metrics:{conversions:{label:"Conversions"}},metric_sources:{linkedin:{conversions:{from:"old_static_field"}}}})',
    );
    assert.match(mapping, /oneClickLeads/);
    assert.doesNotMatch(mapping, /old_static_field|Native mapping unavailable/);
  });
test('Arabic result labels reach the workbook while saved names and native IDs remain literal', async t => {
  const report = await snapshot(t, 'ad'),
    before = JSON.stringify(report),
    binary = await reportWorkbook(report, {artifact_language: 'ar'});
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(binary);
  let columns = 0;
  for (const sheet of book.worksheets) {
    const header = sheet.getRow(1),
      column = header.values.indexOf('النتيجة الأساسية');
    if (column > 0) {
      columns++;
      assert.equal(sheet.getRow(2).getCell(column).value, catalog['LinkedIn leads (one-click)']);
    }
  }
  assert.equal(columns, 2);
  const values = book.worksheets.flatMap(sheet => sheet.getSheetValues().flat().filter(Boolean));
  assert.ok(values.includes('LinkedIn leads (one-click)'), 'the saved report title stays literal');
  assert.ok(values.includes('urn:li:sponsoredCreative:9007199254740993'), 'the native ID stays exact');
  assert.equal(JSON.stringify(report), before);
  for (const {label} of Object.values(linkedinResults))
    assert.equal(artifactLocale({artifact_language: 'ar'}).result(label), catalog[label]);
  assert.equal(artifactLocale({artifact_language: 'ar'}).result('Spend'), 'Spend');
});
test('the omitted legend and generated unknown objective are localized without assuming delivery', () => {
  for (const locale of ['en', 'ar']) {
    const ui = page(locale);
    const note = ui.run('uiText(reportOmittedNote)');
    assert.doesNotMatch(note, /delivery/);
    if (locale === 'ar') assert.match(note, /[\u0600-\u06ff]/u);
    ui.context.row = {
      objective_source: 'provider',
      results_by_objective: [{objective: 'unknown', result_definition: 'LinkedIn video views', value: null}],
    };
    const result = String(ui.run('reportObjectiveResults(row)'));
    assert.doesNotMatch(result, /: 0|>unknown</);
    assert.ok(result.includes(locale === 'ar' ? catalog.Unknown : 'Unknown'));
    const notice = ui.run('uiSourceWarning("LinkedIn reports reach only for windows of 92 days or less.")');
    if (locale === 'ar') assert.equal(notice, catalog['LinkedIn reports reach only for windows of 92 days or less.']);
  }
});

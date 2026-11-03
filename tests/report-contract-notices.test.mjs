import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {inflateSync} from 'node:zlib';
import ExcelJS from 'exceljs';
import {reportSource} from '../dist/src/report-sources.js';
import {reportPack} from '../dist/src/report-packs.js';
import {reportWorkbook, reportPdf} from '../dist/src/report-artifacts.js';
import {fingerprint} from '../dist/src/report-quality.js';
import {ReportParts} from '../dist/src/report-checkpoints.js';
import {overviewGranularityFixture, granularSource, granularConfig} from './fixtures/overview-granularity-data.mjs';
import {assertNamesNoProvider} from './helpers/shared-module-seams.mjs';

const notices = {
  linkedin: {
    id: 'linkedin_levels_v2',
    message:
      'LinkedIn reports now show campaign groups in the campaign position, LinkedIn campaigns in the ad set position and creatives in the ad position. Earlier snapshots keep the levels they recorded.',
  },
  tiktok: {
    id: 'tiktok_collection_v2',
    message:
      'TikTok reports now include campaigns deleted since the window and check TikTok’s own totals, so past windows can show more spend than before.',
  },
};
function fixture(t, platform = 'linkedin') {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  const source = granularSource(platform, platform === 'tiktok' ? 'ad' : 'campaign');
  if (source.level === 'campaign') delete source.report_options;
  const config = granularConfig(source);
  f.store.putDocument(f.actor.tenantId, 'overview_view', 'synthetic-view', {config});
  return {...f, config};
}
function legacy(
  f,
  {
    view = 'synthetic-view',
    schedule = null,
    state = 'complete',
    contracts,
    id = 'synthetic-old',
    created = Date.now() - 1000,
  } = {},
) {
  f.store.putDocument(f.actor.tenantId, 'overview_report', id, {
    config: f.config,
    view_id: view,
    schedule_id: schedule,
    state,
    completed_at: created,
    created_at: created,
    rows: [],
    sources: [],
    ...(contracts ? {platform_contracts: contracts} : {}),
  });
}
async function runView(f) {
  const queued = await f.overview.handle({action: 'run', id: 'synthetic-view', confirmed: true}, f.actor);
  await f.worker.once();
  const report = f.store.document(f.actor.tenantId, 'overview_report', queued.id);
  assert.equal(report.state, 'complete', JSON.stringify(report.sources));
  return report;
}

test('each source declares its own contract without a provider name in the shared modules', () => {
  assert.equal(reportSource('linkedin').contract.stamp, 'linkedin-levels-v2');
  assert.equal(reportSource('tiktok').contract.stamp, 'tiktok-collection-v2');
  for (const [platform, notice] of Object.entries(notices))
    assert.deepEqual(reportSource(platform).contract.notice, notice);
  for (const file of ['src/reporting-overview.ts', 'src/report-source.ts']) assertNamesNoProvider(file);
});

for (const platform of ['linkedin', 'tiktok'])
  test(platform + ' saved view carries a contract notice once without changing its definition', async t => {
    const f = fixture(t, platform);
    const original = JSON.stringify(f.store.document(f.actor.tenantId, 'overview_view', 'synthetic-view'));
    legacy(f);
    const oldSnapshot = JSON.stringify(f.store.document(f.actor.tenantId, 'overview_report', 'synthetic-old'));
    const first = await runView(f);
    assert.equal(first.platform_contracts[platform], reportSource(platform).contract.stamp);
    assert.deepEqual(first.notices, [notices[platform]]);
    const second = await runView(f);
    assert.deepEqual(second.notices ?? [], []);
    assert.equal(JSON.stringify(f.store.document(f.actor.tenantId, 'overview_view', 'synthetic-view')), original);
    assert.equal(JSON.stringify(f.store.document(f.actor.tenantId, 'overview_report', 'synthetic-old')), oldSnapshot);
  });

test('a view with no previous run and an ad hoc report get no migration notice', async t => {
  const f = fixture(t);
  const first = await runView(f);
  assert.deepEqual(first.notices ?? [], []);
  const queued = await f.overview.handle({action: 'run', config: f.config, confirmed: true}, f.actor);
  assert.deepEqual(f.store.document(f.actor.tenantId, 'overview_report', queued.id).notices ?? [], []);
});

test('notice lookup ignores another definition and unfinished snapshots, beyond the first History page', async t => {
  const f = fixture(t);
  legacy(f);
  const stamp = {linkedin: 'linkedin-levels-v2'};
  for (let i = 0; i < 505; i++)
    legacy(f, {view: 'different-view', contracts: stamp, id: 'other-' + i, created: Date.now() + i});
  legacy(f, {contracts: stamp, state: 'running', id: 'unfinished', created: Date.now() + 1000});
  const queued = await f.overview.handle({action: 'run', id: 'synthetic-view', confirmed: true}, f.actor);
  assert.deepEqual(f.store.document(f.actor.tenantId, 'overview_report', queued.id).notices, [notices.linkedin]);
});

test('a schedule carries the notice into its pack and bilingual workbook/PDF before limitations', async t => {
  const f = fixture(t);
  legacy(f, {view: null, schedule: 'synthetic-schedule'});
  f.store.putDocument(f.actor.tenantId, 'overview_schedule', 'synthetic-schedule', {
    config: f.config,
    definition_version: 1,
    is_active: true,
  });
  const queued = f.overview.queue(f.actor, f.config, undefined, 'synthetic-schedule');
  await f.worker.once();
  const report = f.store.document(f.actor.tenantId, 'overview_report', queued.id);
  assert.equal(
    report.state,
    'complete',
    JSON.stringify({sources: report.sources, error: f.store.job(f.actor.tenantId, queued.job_id).error}),
  );
  assert.deepEqual(reportPack(report).notes, [notices.linkedin.message]);
  const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
  for (const language of ['en', 'ar']) {
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(await reportWorkbook(report, {artifact_language: language}));
    const rows = book.worksheets[0].getSheetValues();
    const note = rows.findIndex(r => r?.[1] === (language === 'ar' ? catalog.Note : 'Note'));
    const limitation = rows.findIndex(r => r?.[1] === (language === 'ar' ? 'قيد' : 'Limitation'));
    assert.ok(note > 0 && note < limitation);
    assert.equal(rows[note][2], language === 'ar' ? catalog[notices.linkedin.message] : notices.linkedin.message);
  }
  const bytes = await reportPdf(report, {artifact_language: 'ar'}),
    raw = bytes.toString('latin1');
  const streams = [...raw.matchAll(/<<[^]*?\/Length (\d+)\s*\/Filter \/FlateDecode\s*>>\s*stream\r?\n/g)].map(m =>
    inflateSync(bytes.subarray(m.index + m[0].length, m.index + m[0].length + Number(m[1]))),
  );
  const actual = streams
    .flatMap(s =>
      [...s.toString('latin1').matchAll(/\/ActualText\s*\(((?:\\[\s\S]|[^\\)])*)\)/g)].map(m => {
        const literal = m[1].replace(
          /\\([\\()nrtbf])/g,
          (_, value) => ({n: '\n', r: '\r', t: '\t', b: '\b', f: '\f'})[value] ?? value,
        );
        const bytes = Buffer.from(literal, 'latin1');
        return bytes[0] === 254 && bytes[1] === 255 ? bytes.subarray(2).swap16().toString('utf16le') : literal;
      }),
    )
    .join(' ')
    .replace(/\s+/gu, ' ');
  assert.ok(actual.includes(catalog.Notes));
  assert.ok(actual.includes(catalog[notices.linkedin.message]));
  assert.ok(actual.indexOf(catalog.Notes) < actual.indexOf('تبقى عملات الحسابات ومناطقها الزمنية'));
});

for (const layout of ['inline', 'split'])
  test(layout + ' stale contract checkpoints refuse before any read and preserve their evidence', async t => {
    const f = fixture(t);
    const queued = await f.overview.handle({action: 'run', config: f.config, confirmed: true}, f.actor);
    const original = f.store.document(f.actor.tenantId, 'overview_report', queued.id);
    const budget = {
      version: 1,
      definition: fingerprint(original.config),
      requests: 2,
      rows: 1,
      bytes: 100,
      elapsed_ms: 100,
      row_counts: {'0': 1},
    };
    const checkpoint = {result: {rows: [{campaign_id: 'synthetic-old-campaign'}], complete: true}};
    const older = {
      ...original,
      platform_contracts: {},
      collection_budget: budget,
      checkpoints: layout === 'inline' ? {'0': checkpoint} : {},
    };
    f.store.putDocument(f.actor.tenantId, 'overview_report', queued.id, older);
    if (layout === 'split') {
      const parts = new ReportParts(f.store, f.actor.tenantId, older);
      parts.saveBudget(budget);
      parts.save('0', checkpoint);
    }
    const before = f.requests.length;
    await assert.rejects(() => f.overview.work(f.actor.tenantId, 'report_overview', {report_id: queued.id}), {
      code: 'REPORT_RESTART_REQUIRED',
    });
    assert.equal(f.requests.length, before);
    const saved = f.store.document(f.actor.tenantId, 'overview_report', queued.id);
    assert.equal(saved.state, 'failed');
    const retained = new ReportParts(f.store, f.actor.tenantId, saved).source('0', saved.checkpoints?.['0']);
    assert.deepEqual(retained, checkpoint);
  });

test('both history displays translate authored notices and escape unknown strings', () => {
  const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
  const esc = value =>
    String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  const context = createContext({
    document: {addEventListener() {}},
    pretty: String,
    esc,
    catalog,
    overviewLabel: c => c.name,
    reportRangeLabel: () => '',
    reportLabel: String,
    date: String,
    reportDisplayState: () => 'complete',
  });
  const run = source => new Script(source).runInContext(context);
  for (const file of ['localization', 'report-library', 'reporting-overview'])
    run(readFileSync('web/' + file + '.js', 'utf8'));
  context.report = {
    id: 'synthetic-history',
    config: {name: 'Synthetic', date_range: {}},
    notices: [notices.linkedin, {id: 'unknown', message: '<native> $&'}],
    exports: [{state: 'complete'}],
  };
  for (const locale of ['en', 'ar']) {
    run(`uiLocale='${locale}';uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
    for (const expression of ['renderOverviewHistory([report],true)', 'renderExportHistory(report)']) {
      const markup = run(expression);
      assert.ok(markup.includes(esc(locale === 'ar' ? catalog[notices.linkedin.message] : notices.linkedin.message)));
      assert.ok(markup.includes('&lt;native&gt; $&'));
      assert.ok(!markup.includes('<native>'));
    }
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {overviewGranularityFixture, granularConfig, granularSource} from './fixtures/overview-granularity-data.mjs';
import {estimateCollectionRequests} from '../dist/src/report-request-estimate.js';
import {overviewConfigV4, overviewV4ScopeContract} from '../dist/src/overview-v4.js';
import {normalizeOverviewV4Source, expandOverviewV4Sources, overviewV4Scope} from '../dist/src/overview-v4.js';
import {reportSource} from '../dist/src/report-sources.js';
import {REPORT_CHECKPOINT_KIND} from '../dist/src/report-checkpoints.js';
import {reportTable, exportCsv} from '../dist/src/report-table.js';
import {reportWorkbook} from '../dist/src/report-artifacts.js';
import ExcelJS from 'exceljs';
import {Script, createContext} from 'node:vm';
import {readFileSync} from 'node:fs';

const selected = '9007199254740993',
  other = '9007199254740994',
  range = {since: '2026-09-01', until: '2026-09-01'};
function fixture(t, levels = ['campaign']) {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  f.mutate((rows, platform) =>
    platform === 'meta'
      ? rows.flatMap(row =>
          row.ad_id
            ? [row, {...row, ad_id: other, spend: '100', impressions: '10000'}]
            : [{...row, spend: '100.100000001'}],
        )
      : rows,
  );
  const config = {
    ...granularConfig({...granularSource('meta', levels[0]), levels, ad_ids: [selected]}),
    contract_version: overviewConfigV4,
    date_range: range,
    metrics: ['spend', 'impressions', 'clicks', 'primary_result', 'cost_per_result', 'reach'],
  };
  return {
    ...f,
    config,
    async queue(changes = {}) {
      return f.overview.handle({action: 'run', confirmed: true, config: {...config, ...changes}}, f.actor);
    },
    async get(id, include = {}) {
      return f.overview.handle({action: 'get', id, include}, f.actor);
    },
  };
}

test('campaign-only scope measures selected ads, returns their exact totals and discloses supporting collection', async t => {
  const f = fixture(t),
    queued = await f.queue();
  await f.worker.once();
  const report = await f.get(queued.id, {native: true});
  assert.equal(report.state, 'complete', JSON.stringify(report.sources));
  assert.equal(report.row_count, 1);
  assert.equal(report.rows[0].metrics.spend, '0.100000001');
  assert.equal(report.rows[0].metrics.reach, null);
  assert.equal(report.rows[0].aggregation.label, 'Rolled up from selected ads');
  assert.equal(report.rows[0].native.scope_rollup.native_parent.spend, '100.100000001');
  assert.equal(report.source_row_count, 1);
  assert.equal(report.derived_row_count, 1);
  assert.equal(report.supporting_row_count, 2);
  assert.deepEqual(report.sources[0].supporting_levels, ['ad']);
  assert.equal(report.sources[0].collection_row_count, 3);
  assert.equal(report.sources[0].level_results.find(level => level.level === 'ad').visible, false);
  assert.equal(report.sources[0].level_results.find(level => level.level === 'ad').purpose, 'scope_rollup');
  assert.ok(report.estimated_requests >= f.requests.length);
  assert.equal(estimateCollectionRequests(report.config).sources.at(-1).purpose, 'scope_rollup');
  const requests = f.requests.length,
    compact = await f.get(queued.id);
  assert.equal(compact.rows[0].aggregation.label, 'Rolled up from selected ads');
  assert.equal(compact.rows[0].native, undefined);
  assert.equal(f.requests.length, requests);
});

test('each requested ancestor rolls up the same selected ads without claiming independent cross-level agreement', async t => {
  const f = fixture(t, ['campaign', 'adset', 'ad']),
    queued = await f.queue();
  await f.worker.once();
  const report = await f.get(queued.id);
  assert.equal(report.state, 'complete', JSON.stringify(report.sources));
  assert.deepEqual(
    report.rows.map(row => [row.level, row.metrics.spend]),
    [
      ['campaign', '0.100000001'],
      ['adset', '0.100000001'],
      ['ad', '0.100000001'],
    ],
  );
  assert.equal(report.source_row_count, 4);
  assert.equal(report.scope_input_row_count, 4);
  assert.equal(report.scoped_row_count, 3);
  assert.equal(report.scope_filtered_row_count, 1);
  assert.equal(report.objective_filtered_row_count, 0);
  assert.equal(report.sources[0].cross_level.length, 6);
  assert.ok(
    report.sources[0].cross_level.every(
      value =>
        value.state === 'unavailable' &&
        value.unavailable_reason === 'derived_parent_population' &&
        value.delta === null,
    ),
  );
});

test('native parents with no performance row can receive a derived row without negative filtering counts', async t => {
  const f = fixture(t);
  f.mutate((rows, platform) => (platform === 'meta' && !rows[0]?.ad_id ? [] : rows));
  const queued = await f.queue();
  await f.worker.once();
  const report = await f.get(queued.id);
  assert.equal(report.state, 'complete', JSON.stringify(report.sources));
  assert.equal(report.row_count, 1);
  assert.equal(report.source_row_count, 0);
  assert.equal(report.scope_input_row_count, 1);
  assert.equal(report.derived_row_count, 1);
  assert.equal(report.scope_filtered_row_count, 0);
  assert.equal(report.filtered_row_count, 0);
  assert.equal(report.rows[0].status, 'unknown');
  assert.equal(report.rows[0].metrics.spend, '0.100000001');
});

test('a legacy queued v4 snapshot keeps its original scoped checkpoint contract', async t => {
  const f = fixture(t),
    queued = await f.queue(),
    stored = f.store.document(f.actor.tenantId, 'overview_report', queued.id);
  assert.equal(stored.scope_contract, overviewV4ScopeContract);
  delete stored.scope_contract;
  f.store.putDocument(f.actor.tenantId, 'overview_report', queued.id, stored);
  await f.worker.once();
  const report = await f.get(queued.id);
  assert.equal(report.state, 'partial');
  assert.equal(report.row_count, 0);
  assert.equal(report.sources[0].scope.excluded_unknown_rows, 1);
  assert.equal(report.sources[0].level_results.length, 1);
  assert.ok(!f.requests.some(request => request.url.searchParams.get('level') === 'ad'));
});

test('a retry retains raw parent metrics and derives them only after the supporting ad collection completes', async t => {
  const f = fixture(t);
  f.hook(url => {
    if (url.pathname.endsWith('/insights') && url.searchParams.get('level') === 'ad')
      return Response.json({error: {message: 'Synthetic temporary failure', code: 2}}, {status: 503});
  });
  const queued = await f.queue();
  await f.worker.once();
  const checkpoint = f.store
    .documents(f.actor.tenantId, REPORT_CHECKPOINT_KIND)
    .find(value => value.id === queued.id + ':0');
  assert.equal(checkpoint.result.rows[0].metrics.spend, '100.100000001');
  assert.equal(checkpoint.result.scope, undefined);
  const parentReads = f.requests.filter(
    request => request.url.pathname.endsWith('/insights') && request.url.searchParams.get('level') === 'campaign',
  ).length;
  f.hook(() => {});
  f.store.db.prepare("UPDATE jobs SET available_at=0 WHERE state='queued'").run();
  await f.worker.once();
  const report = await f.get(queued.id);
  assert.equal(report.state, 'complete', JSON.stringify(report.sources));
  assert.equal(report.rows[0].metrics.spend, '0.100000001');
  assert.equal(
    f.requests.filter(
      request => request.url.pathname.endsWith('/insights') && request.url.searchParams.get('level') === 'campaign',
    ).length,
    parentReads,
  );
});

test('a selected ad without established native parents cannot invent an ancestor total', async t => {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  f.parents((platform, url, body) =>
    platform === 'tiktok' && url.pathname.endsWith('/ad/get/') ? {code: 40001, message: 'No permission'} : body,
  );
  const queued = await f.overview.handle(
    {
      action: 'run',
      confirmed: true,
      config: {
        ...granularConfig({...granularSource('tiktok', 'adset'), levels: ['adset'], ad_ids: [selected]}),
        contract_version: overviewConfigV4,
        date_range: range,
      },
    },
    f.actor,
  );
  await f.worker.once();
  const report = await f.overview.handle({action: 'get', id: queued.id}, f.actor);
  assert.equal(report.state, 'partial', JSON.stringify(report.sources));
  assert.equal(report.row_count, 0);
  assert.equal(report.sources[0].scope.rollup.unassigned_child_rows, 1);
});

test('LinkedIn selected creative IDs and parent URNs retain the provider hierarchy at every requested level', async t => {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  const queued = await f.overview.handle(
    {
      action: 'run',
      confirmed: true,
      config: {
        ...granularConfig({
          ...granularSource('linkedin', 'campaign'),
          levels: ['campaign', 'adset', 'ad'],
          ad_ids: [selected],
          campaign_ids: ['urn:li:sponsoredCampaignGroup:444'],
          adset_ids: ['urn:li:sponsoredCampaign:555'],
        }),
        contract_version: overviewConfigV4,
        date_range: range,
      },
    },
    f.actor,
  );
  await f.worker.once();
  const report = await f.overview.handle({action: 'get', id: queued.id, include: {native: true}}, f.actor);
  assert.equal(report.state, 'complete', JSON.stringify(report.sources));
  assert.deepEqual(
    report.rows.map(row => [row.entity_level, row.entity_id]),
    [
      ['campaign', '444'],
      ['adset', 'urn:li:sponsoredCampaign:555'],
      ['ad', 'urn:li:sponsoredCreative:' + selected],
    ],
  );
  assert.ok(report.rows.every(row => row.metrics.spend === report.rows[2].metrics.spend));
  assert.equal(report.rows[2].parents.campaign.id, '444');
  assert.equal(report.rows[2].parents.adset.id, '555');
});

test('selected middle-level IDs add only their supporting measurement level and retain a child-entity rollup label', async t => {
  const f = fixture(t),
    source = {...f.config.sources[0], ad_ids: [], adset_ids: ['201']},
    queued = await f.queue({sources: [source]});
  await f.worker.once();
  const report = await f.get(queued.id);
  assert.equal(report.state, 'complete', JSON.stringify(report.sources));
  assert.deepEqual(report.sources[0].supporting_levels, ['adset']);
  assert.equal(report.rows[0].aggregation.label, 'Rolled up from selected child entities');
  assert.equal(report.rows[0].metrics.spend, '100.100000001');
  assert.ok(!f.requests.some(request => request.url.searchParams.get('level') === 'ad'));
});

test('new jobs refuse already-filtered retained checkpoints before another provider request', async t => {
  const f = fixture(t),
    queued = await f.queue(),
    original = {
      source: {...f.config.sources[0], level: 'campaign', source_ref: 0},
      rows: [],
      scope: {filtering: 'after_collection', returned_rows: 1},
      complete: false,
    };
  f.store.putDocument(f.actor.tenantId, REPORT_CHECKPOINT_KIND, queued.id + ':0', {
    report_id: queued.id,
    result: original,
  });
  await f.worker.once();
  const report = await f.get(queued.id);
  assert.equal(report.state, 'failed');
  assert.equal(report.error.code, 'REPORT_RESTART_REQUIRED');
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.store.document(f.actor.tenantId, REPORT_CHECKPOINT_KIND, queued.id + ':0').result, original);
});

test('rolled-up rows keep their scope labels in the shared CSV/Sheets table and real English/Arabic Excel cells', async t => {
  const f = fixture(t),
    queued = await f.queue();
  await f.worker.once();
  const report = await f.get(queued.id, {native: true}),
    table = reportTable(report),
    column = table[0].indexOf('Aggregation');
  assert.ok(column >= 0);
  assert.equal(table[1][column], 'Rolled up from selected ads');
  assert.match(exportCsv(report), /Rolled up from selected ads/);
  for (const language of ['en', 'ar']) {
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(await reportWorkbook(report, {artifact_language: language}));
    const sheet = book.getWorksheet(language === 'ar' ? 'صفوف الحملات' : 'Campaign rows'),
      header = sheet.getRow(1).values,
      index = header.indexOf(language === 'ar' ? 'التجميع' : 'Aggregation');
    assert.ok(index > 0);
    assert.equal(
      sheet.getRow(2).getCell(index).value,
      language === 'ar' ? 'مجمّع من الإعلانات المحددة' : 'Rolled up from selected ads',
    );
  }
});

test('web reporting level labels disclose selected-ad aggregation in English and Arabic', () => {
  for (const language of ['en', 'ar']) {
    const context = createContext({document: {addEventListener() {}}});
    new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
    new Script(readFileSync('web/reporting-overview.js', 'utf8')).runInContext(context);
    if (language === 'ar') {
      context.catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
      new Script("uiLocale='ar';uiMessages=new Map(Object.entries(catalog))").runInContext(context);
    }
    const label = new Script(
      "reportLevelLabel({platforms:[{id:'meta',entity_levels:[{id:'campaign',label:'Campaign'}]}]}, {platform:'meta',entity_level:'campaign',aggregation:{kind:'rolled_up',scope_field:'ad_ids'}})",
    ).runInContext(context);
    assert.ok(label.endsWith(language === 'ar' ? 'مجمّع من الإعلانات المحددة' : 'Rolled up from selected ads'));
  }
});

test('unsupported descendant filters and empty provider URNs refuse at the source boundary', () => {
  for (const [platform, changes] of [
    ['ga4', {ad_ids: [selected]}],
    ['gsc', {adset_ids: ['201']}],
    ['x', {ad_ids: ['invalid/native/id']}],
    ['linkedin', {ad_ids: ['urn:li:sponsoredCreative:']}],
  ]) {
    assert.throws(
      () => normalizeOverviewV4Source({platform, levels: ['campaign'], ...changes}, reportSource(platform).overview),
      {code: 'INVALID_REPORT_SOURCE'},
    );
  }
  const x = normalizeOverviewV4Source(
    {platform: 'x', levels: ['campaign'], ad_ids: [selected]},
    reportSource('x').overview,
  );
  assert.deepEqual(x.ad_ids, [selected], 'X promotion IDs now support selected-ad ancestor totals');
  const source = normalizeOverviewV4Source(
      {platform: 'meta', levels: ['campaign'], ad_ids: [selected], scope_supporting: true},
      reportSource('meta').overview,
    ),
    expanded = expandOverviewV4Sources({contract_version: overviewConfigV4, sources: [source]});
  assert.equal(source.scope_supporting, undefined);
  assert.equal(expanded[0].scope_supporting, undefined);
  assert.equal(expanded[1].scope_supporting, true);
});

test('an unknown row identity never matches a malformed stored ID after canonicalization', () => {
  const legacy = {
      platform: 'linkedin',
      level: 'campaign',
      ad_ids: ['urn:li:sponsoredCreative:'],
      statuses: ['all'],
      delivered_only: false,
    },
    selection = overviewV4Scope(
      legacy,
      [{entity_level: 'campaign', campaign_id: '444', metrics: {spend: '99'}}],
      reportSource('linkedin').overview,
    );
  assert.equal(selection.rows.length, 0);
  assert.equal(selection.scope.excluded_unknown_rows, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  upgradeOverviewV3Config,
  normalizeOverviewV4Source,
  overviewDefinitionForms,
  overviewConfigV4,
} from '../dist/src/overview-v4.js';
import {reportSource} from '../dist/src/report-sources.js';
import {overviewGranularityFixture, granularConfig, granularSource} from './fixtures/overview-granularity-data.mjs';
import {savedObjectiveViews} from './fixtures/saved-objective-views.mjs';
import {objectiveReportFixture} from './helpers/objective-report.mjs';
import {objectiveMigrationKind, objectiveMigrationNotice} from '../dist/src/report-definition-migration.js';
import {MirrorError} from '../dist/src/errors.js';
import {reportTable, exportCsv} from '../dist/src/report-table.js';
import {reportWorkbook, reportPdf} from '../dist/src/report-artifacts.js';
import {reportPack} from '../dist/src/report-packs.js';
import {reportEvidence} from '../dist/src/report-quality.js';
import {artifactLocale} from '../dist/src/report-localization.js';
import ExcelJS from 'exceljs';
import {pdfActualText} from './helpers/pdf-actual-text.mjs';

const capabilities = platform => reportSource(platform)?.overview,
  range = {since: '2026-09-01', until: '2026-09-01'};

test('pure stored-definition upgrade preserves the original config, account bindings, declarations and old scope', () => {
  // `config.version` is one stored number that both builds always write as 1 and nothing reads: there are no separate
  // v1, v2 and v3 stored forms (the real discriminators are source_contract_version, contract_version and the sidecar).
  // The loop shows the upgrade is indifferent to the value it carries.
  for (const version of [1, 2, 3]) {
    const original = {
        ...savedObjectiveViews[0].config,
        version,
        custom_metrics: [{id: 'profit', label: 'Profit', formula: 'conversion_value - spend'}],
      },
      before = JSON.stringify(original),
      upgraded = upgradeOverviewV3Config(original, capabilities);
    assert.equal(JSON.stringify(original), before);
    assert.equal(upgraded.contract_version, overviewConfigV4);
    const source = upgraded.sources[0];
    assert.equal(source.account_id, original.sources[0].account_id);
    assert.equal(source.connection_id, original.sources[0].connection_id);
    assert.deepEqual(source.levels, ['campaign']);
    assert.equal(source.delivered_only, false);
    assert.deepEqual(source.statuses, ['all']);
    assert.deepEqual(source.ad_ids, []);
    assert.equal(source.report_options.attribution_windows, null);
    assert.deepEqual(upgraded.custom_metrics, original.custom_metrics);
    const normalized = normalizeOverviewV4Source(source, capabilities('meta'));
    assert.equal(normalized.objective, undefined);
    assert.equal(normalized.objective_fallback, 'leads');
    assert.equal(normalized.objective_migrated_from_v3, true);
    assert.equal(normalized.report_options.complete_window, null);
  }
  const declared = upgradeOverviewV3Config(
    {
      sources: [
        {
          ...granularSource('tiktok', 'ad'),
          report_options: {complete_window: false, attribution: 'explicit old declaration'},
        },
      ],
    },
    capabilities,
  );
  assert.equal(declared.sources[0].report_options.complete_window, false);
  assert.equal(declared.sources[0].report_options.attribution, 'explicit old declaration');
  assert.deepEqual(declared.sources[0].levels, ['ad']);
});

test('a stored unknown objective does not invent a converted choice or a numbers-changed marker', () => {
  const original = savedObjectiveViews[1].config,
    source = normalizeOverviewV4Source(
      upgradeOverviewV3Config(original, capabilities).sources[0],
      capabilities('meta'),
    );
  assert.equal(source.objective_fallback, undefined);
  assert.equal(source.objective_migrated_from_v3, undefined);
  assert.equal(original.sources[0].objective, 'unknown');
});

test('Meta and Snapchat campaign upgrades preserve the actual legacy attribution request and leave declarations unknown', async t => {
  for (const platform of ['meta', 'snapchat']) {
    const f = overviewGranularityFixture();
    t.after(() => f.close());
    const originalSource = {...granularSource(platform, 'campaign'), report_options: undefined},
      original = {...granularConfig(originalSource), date_range: range},
      legacy = await f.overview.native.collect(originalSource, range, f.actor),
      config = f.overview.config(upgradeOverviewV3Config(original, capabilities), f.actor, false, true),
      current = await f.overview.native.collect(config.sources[0], range, f.actor),
      reads = f.requests.filter(request =>
        platform === 'meta' ? request.url.pathname.endsWith('/insights') : request.url.pathname.endsWith('/stats'),
      );
    assert.equal(current.attribution, legacy.attribution, platform);
    assert.equal(config.sources[0].report_options.complete_window, null);
    const keys =
      platform === 'meta'
        ? [
            'action_report_time',
            'action_attribution_windows',
            'use_account_attribution_setting',
            'use_unified_attribution_setting',
          ]
        : ['action_report_time', 'conversion_source_types', 'swipe_up_attribution_window', 'view_attribution_window'];
    for (const key of keys)
      assert.equal(reads[1].url.searchParams.get(key), reads[0].url.searchParams.get(key), platform + ':' + key);
    // A campaign-level source needs no window declaration (F-L6-02): the upgrade invents none, and it changes no
    // completeness either. Declaration rules belong to the detail levels.
    assert.equal(
      current.quality.reporting_window_declared_complete,
      null,
      platform + ': the declaration stays unknown',
    );
    assert.equal(current.complete, legacy.complete, platform + ': completeness is the legacy collection’s');
  }
});

test('provider-configured campaign profiles cannot bypass detailed attribution validation', () => {
  for (const [platform, options] of [
    ['meta', {attribution_windows: null}],
    ['snapchat', {swipe_up_attribution_window: null, view_attribution_window: null}],
    ['snapchat', {swipe_up_attribution_window: null, view_attribution_window: '1_DAY'}],
  ]) {
    assert.throws(
      () =>
        normalizeOverviewV4Source(
          {platform, levels: ['campaign', 'ad'], report_options: options},
          capabilities(platform),
        ),
      {code: 'INVALID_REPORT_SOURCE'},
    );
  }
  for (const platform of ['meta', 'snapchat']) {
    const legacy = upgradeOverviewV3Config({sources: [{platform}]}, capabilities).sources[0];
    assert.throws(() => normalizeOverviewV4Source({...legacy, ad_ids: ['1']}, capabilities(platform)), {
      code: 'INVALID_REPORT_SOURCE',
    });
  }
});

test('provider-configured windows project to omission for a representable legacy campaign', () => {
  for (const platform of ['meta', 'snapchat']) {
    const source = normalizeOverviewV4Source(
        {
          ...upgradeOverviewV3Config({sources: [{platform}]}, capabilities).sources[0],
          report_options: {
            ...upgradeOverviewV3Config({sources: [{platform}]}, capabilities).sources[0].report_options,
            complete_window: true,
          },
        },
        capabilities(platform),
      ),
      rollback = overviewDefinitionForms({contract_version: overviewConfigV4, sources: [source]}, capabilities).config
        .sources[0];
    assert.equal(rollback.level, 'campaign');
    assert.equal(rollback.report_options, undefined);
  }
});

test('an existing v4 config or explicit multi-level input is never collapsed into legacy single-level scope', () => {
  const current = {
      contract_version: overviewConfigV4,
      sources: [
        {platform: 'meta', levels: ['campaign', 'ad'], ad_ids: ['1'], statuses: ['paused'], delivered_only: true},
      ],
    },
    upgraded = upgradeOverviewV3Config(current, capabilities);
  assert.deepEqual(upgraded, current);
  assert.notEqual(upgraded, current);
  const unmarked = {...current};
  delete unmarked.contract_version;
  assert.deepEqual(upgradeOverviewV3Config(unmarked, capabilities), current);
});

const migrationNotices = report => (report.notices ?? []).filter(notice => notice.id === objectiveMigrationNotice.id);
const noticeState = (f, id) =>
  f.store.document(f.actor.tenantId, objectiveMigrationKind, 'view:' + id).notices[objectiveMigrationNotice.id];
/**
 * A report as Work-here stored it, with its objective chosen by hand. By default it has run before: one finished v3
 * snapshot is retained for it. That is what makes the upgrade change its numbers; a report that never ran has no earlier
 * numbers to change and is told nothing (F-L2-13).
 */
function storedView(f, objective = 'leads', id = 'legacy-definition', ran = true) {
  const config = {...f.config, version: 3, sources: [{...f.config.sources[0], objective}]};
  f.store.putDocument(f.actor.tenantId, 'overview_view', id, {config, created_at: 1, updated_at: 2});
  if (ran)
    f.store.putDocument(f.actor.tenantId, 'overview_report', 'ran-before-' + id, {
      config,
      view_id: id,
      schedule_id: null,
      state: 'complete',
      created_at: 10,
      completed_at: 20,
      rows: [],
      sources: [],
    });
  return {id, config};
}
const runStored = async (f, id) => f.finish(await f.overview.handle({action: 'run', id, confirmed: true}, f.actor));

test('running a stored v3 report writes its v4 sidecar, preserves original config/snapshots and registers and spends the notice once', async t => {
  const f = objectiveReportFixture(t, {
      rows: [{campaign_id: '1', objective: 'OUTCOME_TRAFFIC', metrics: {spend: 10, impressions: 100, clicks: 2}}],
    }),
    saved = storedView(f),
    original = JSON.stringify(saved.config),
    old = await f.run({sources: saved.config.sources}),
    oldBytes = JSON.stringify(old),
    current = await runStored(f, saved.id),
    record = f.store.document(f.actor.tenantId, 'overview_view', saved.id);
  assert.equal(current.config.contract_version, overviewConfigV4);
  assert.equal(current.rows[0].objective.group, 'traffic');
  assert.equal(current.rows[0].objective.source, 'provider');
  assert.equal(record.config_v4.sources[0].objective_fallback, 'leads');
  assert.equal(JSON.stringify(record.config), original);
  assert.equal(JSON.stringify(await f.overview.handle({action: 'get', id: old.id}, f.actor)), oldBytes);
  assert.deepEqual(migrationNotices(current), [objectiveMigrationNotice]);
  const second = await runStored(f, saved.id);
  assert.deepEqual(migrationNotices(second), []);
  // The report has no scheduled delivery, so its snapshot is the delivery and spends the note when it is recorded.
  assert.equal(noticeState(f, saved.id).first_report_id, current.id);
  assert.equal(noticeState(f, saved.id).spent_report_id, current.id);
});

test('deleting migration History does not reset its durable notice or change the rollback form', async t => {
  const f = objectiveReportFixture(t, {rows: [{campaign_id: '1', objective: 'OUTCOME_TRAFFIC', metrics: {spend: 10}}]}),
    saved = storedView(f),
    first = await runStored(f, saved.id);
  assert.equal(migrationNotices(first).length, 1);
  await f.overview.handle({action: 'delete_report', id: first.id, confirmed: true}, f.actor);
  const next = await runStored(f, saved.id);
  assert.deepEqual(migrationNotices(next), []);
  assert.deepEqual(f.store.document(f.actor.tenantId, 'overview_view', saved.id).config, saved.config);
  const view = f.store.document(f.actor.tenantId, 'overview_view', saved.id);
  await f.overview.handle(
    {action: 'delete_view', id: saved.id, expected_revision: view.revision, confirmed: true},
    f.actor,
  );
  assert.throws(() => f.store.document(f.actor.tenantId, objectiveMigrationKind, 'view:' + saved.id), {
    code: 'NOT_FOUND',
  });
});

test('an empty capture or retryable failure cannot consume the next numbers-changed notice', async t => {
  const rows = [],
    f = objectiveReportFixture(t, {rows}),
    saved = storedView(f),
    empty = await runStored(f, saved.id);
  assert.equal(empty.rows.length, 0);
  assert.deepEqual(migrationNotices(empty), []);
  assert.equal(noticeState(f, saved.id).first_report_id, null);
  assert.equal(noticeState(f, saved.id).spent_report_id, null);
  const collect = f.overview.native.collect;
  f.overview.native.collect = async () => {
    throw new MirrorError('UPSTREAM_ERROR', 'Synthetic outage', {http_status: 503}, 503, true);
  };
  const queued = await f.overview.handle({action: 'run', id: saved.id, confirmed: true}, f.actor);
  await f.worker.once();
  assert.equal(noticeState(f, saved.id).first_report_id, null);
  assert.equal(noticeState(f, saved.id).spent_report_id, null);
  f.overview.native.collect = collect;
  rows.push({campaign_id: '1', objective: 'OUTCOME_TRAFFIC', metrics: {spend: 10}});
  f.store.db.prepare("UPDATE jobs SET available_at=0 WHERE state='queued'").run();
  const resumed = await f.finish(queued);
  assert.equal(resumed.state, 'complete', JSON.stringify(resumed.sources));
  assert.deepEqual(migrationNotices(resumed), [objectiveMigrationNotice]);
});

test('a default unknown stored objective upgrades without a false numbers-changed notice', async t => {
  const f = objectiveReportFixture(t, {rows: [{campaign_id: '1', objective: 'OUTCOME_TRAFFIC', metrics: {spend: 10}}]}),
    saved = storedView(f, 'unknown'),
    report = await runStored(f, saved.id);
  assert.equal(report.rows[0].objective.group, 'traffic');
  assert.deepEqual(migrationNotices(report), []);
  // The report’s record exists (it holds the contracts it ran under) but owes no objective note.
  assert.deepEqual(f.store.document(f.actor.tenantId, objectiveMigrationKind, 'view:' + saved.id).notices, {});
});

test('a note carried by a snapshot already in History is not imported: only the report’s own record says what was delivered', async t => {
  // The earlier mechanism read History for a note an unpublished build had emitted. History is now read once, for the
  // contracts the report last ran under and whether it ran at all, never for notes (F-L6-04, F-L6-07).
  const f = objectiveReportFixture(t, {rows: [{campaign_id: '1', objective: 'OUTCOME_TRAFFIC', metrics: {spend: 10}}]}),
    saved = storedView(f);
  f.store.putDocument(f.actor.tenantId, 'overview_report', 'prior-v4', {
    view_id: saved.id,
    state: 'complete',
    created_at: 10,
    completed_at: 20,
    rows: [],
    notices: [objectiveMigrationNotice],
  });
  const report = await runStored(f, saved.id);
  assert.deepEqual(migrationNotices(report), [objectiveMigrationNotice]);
  assert.equal(noticeState(f, saved.id).spent_report_id, report.id);
  assert.equal(
    Object.hasOwn(
      f.store.document(f.actor.tenantId, objectiveMigrationKind, 'view:' + saved.id),
      'imported_from_history',
    ),
    false,
  );
});

test('an earlier auxiliary baseline notice does not suppress the next primary report delivery notice', async t => {
  const f = objectiveReportFixture(t, {rows: [{campaign_id: '1', objective: 'OUTCOME_TRAFFIC', metrics: {spend: 10}}]}),
    saved = storedView(f);
  f.store.putDocument(f.actor.tenantId, 'overview_report', 'prior-auxiliary', {
    view_id: saved.id,
    state: 'complete',
    created_at: 10,
    completed_at: 20,
    comparison: {role: 'baseline'},
    rows: [],
    notices: [objectiveMigrationNotice],
  });
  const report = await runStored(f, saved.id);
  assert.deepEqual(migrationNotices(report), [objectiveMigrationNotice]);
});

test('a due stored schedule upgrades with its linked view in one occurrence without a revision conflict', async t => {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  f.mutate((rows, platform) =>
    platform === 'meta' ? rows.map(row => ({...row, objective: 'OUTCOME_TRAFFIC'})) : rows,
  );
  const config = {
      ...granularConfig({...granularSource('meta', 'campaign'), report_options: undefined, objective: 'leads'}),
      date_range: range,
      version: 3,
    },
    original = JSON.stringify(config),
    scheduleId = 'stored-schedule',
    viewId = 'stored-schedule-view';
  f.store.putDocument(f.actor.tenantId, 'overview_view', viewId, {config, schedule_id: scheduleId, created_at: 1});
  f.store.putDocument(f.actor.tenantId, 'overview_schedule', scheduleId, {
    config,
    view_id: viewId,
    is_active: true,
    definition_version: 1,
    schedule_kind: 'daily',
    schedule_config: {hour: 3, minute: 0},
    timezone: 'UTC',
    next_run_at: Date.now() - 1000,
    actor_binding: f.store.bindJobActor(f.actor, scheduleId),
    created_at: 1,
    // It has fired before, so the upgrade changes numbers it already delivered.
    last_occurrence_at: 1,
  });
  const before = f.store.document(f.actor.tenantId, 'overview_schedule', scheduleId);
  f.overview.tick();
  const schedule = f.store.document(f.actor.tenantId, 'overview_schedule', scheduleId),
    view = f.store.document(f.actor.tenantId, 'overview_view', viewId);
  assert.equal(schedule.error, null, JSON.stringify(schedule.error));
  assert.equal(schedule.revision, before.revision + 1);
  assert.equal(schedule.config_v4.contract_version, overviewConfigV4);
  assert.equal(view.config_v4.contract_version, overviewConfigV4);
  assert.equal(JSON.stringify(schedule.config), original);
  assert.equal(JSON.stringify(view.config), original);
  assert.ok(schedule.next_run_at > before.next_run_at);
  assert.equal(f.store.documents(f.actor.tenantId, 'overview_report').length, 1);
  await f.worker.once();
  const report = f.store.document(f.actor.tenantId, 'overview_report', schedule.last_report_id);
  assert.equal(report.state, 'complete', JSON.stringify(report.sources));
  assert.equal(report.rows[0].objective_group, 'traffic');
  assert.deepEqual(migrationNotices(report), [objectiveMigrationNotice]);
  assert.equal(noticeState(f, viewId).first_report_id, report.id);
  assert.equal(noticeState(f, viewId).spent_report_id, report.id, 'it has no delivery destination');
});

test('v4 templates retain account-free level/scope defaults and a safe legacy projection', async t => {
  const f = objectiveReportFixture(t),
    template = await f.overview.handle(
      {
        action: 'save_template',
        confirmed: true,
        config: {
          ...f.config,
          contract_version: overviewConfigV4,
          sources: [
            {
              ...f.config.sources[0],
              levels: ['campaign', 'ad'],
              ad_ids: ['private-account-ad'],
              statuses: ['paused'],
              delivered_only: false,
            },
          ],
        },
      },
      f.actor,
    );
  assert.equal(template.config.contract_version, overviewConfigV4);
  assert.deepEqual(template.config.source_defaults.meta.levels, ['campaign', 'ad']);
  assert.deepEqual(template.config.source_defaults.meta.statuses, ['paused']);
  assert.equal(template.config.source_defaults.meta.delivered_only, false);
  for (const key of ['account_id', 'connection_id', 'ad_ids', 'campaign_ids', 'adset_ids', 'objective_overrides'])
    assert.equal(template.config.source_defaults.meta[key], undefined);
  const stored = f.store.document(f.actor.tenantId, 'overview_template', template.id);
  assert.equal(stored.config.source_defaults.meta.level, 'v4_required');
  assert.equal(stored.config.source_defaults.meta.levels, undefined);
  assert.equal(stored.config.source_defaults.meta.statuses, undefined);
});

test('unversioned v4 template defaults keep explicit levels and scope when an existing template is edited', async t => {
  const f = objectiveReportFixture(t),
    config = {
      ...f.config,
      sources: [],
      source_defaults: {meta: {levels: ['campaign', 'ad'], statuses: ['paused'], delivered_only: true}},
    },
    before = JSON.stringify(config),
    upgraded = upgradeOverviewV3Config(config, capabilities);
  assert.equal(JSON.stringify(config), before);
  assert.deepEqual(upgraded.source_defaults.meta, config.source_defaults.meta);
  f.store.putDocument(f.actor.tenantId, 'overview_template', 'old-template', {
    config: {...f.config, sources: [], source_defaults: {meta: {level: 'campaign'}}},
  });
  const edited = await f.overview.handle(
    {
      action: 'save_template',
      id: 'old-template',
      expected_revision: 1,
      config,
      confirmed: true,
    },
    f.actor,
  );
  assert.deepEqual(edited.config.source_defaults.meta.levels, ['campaign', 'ad']);
  assert.deepEqual(edited.config.source_defaults.meta.statuses, ['paused']);
  assert.equal(edited.config.source_defaults.meta.delivered_only, true);
});

for (const mode of ['alias', 'levels'])
  test('template sources replace stale ' + mode + ' defaults atomically', async t => {
    const f = objectiveReportFixture(t),
      source = {...f.config.sources[0], ...(mode === 'alias' ? {levels: ['campaign', 'ad']} : {level: 'campaign'})},
      previous = mode === 'alias' ? {level: 'ad'} : {levels: ['ad']};
    const template = await f.overview.handle(
      {
        action: 'save_template',
        confirmed: true,
        config: {...f.config, contract_version: overviewConfigV4, source_defaults: {meta: previous}, sources: [source]},
      },
      f.actor,
    );
    assert.deepEqual(template.config.source_defaults.meta.levels, source.levels ?? ['campaign']);
  });

test('the first migration notice reaches History, CSV/Sheets, evidence and real bilingual Excel/PDF artifacts', async t => {
  const f = objectiveReportFixture(t, {
      rows: [{campaign_id: '1', objective: 'OUTCOME_TRAFFIC', metrics: {spend: 10, impressions: 100, clicks: 2}}],
    }),
    saved = storedView(f),
    result = await runStored(f, saved.id),
    report = f.store.document(f.actor.tenantId, 'overview_report', result.id),
    table = reportTable(report),
    column = table[0].indexOf('Report notices'),
    history = await f.overview.handle({action: 'list'}, f.actor);
  assert.deepEqual(migrationNotices(history.reports.find(record => record.id === report.id)), [
    objectiveMigrationNotice,
  ]);
  assert.ok(column >= 0);
  assert.equal(table[1][column], objectiveMigrationNotice.message);
  assert.ok(exportCsv(report).includes(objectiveMigrationNotice.message));
  assert.deepEqual(reportPack(report).notes, [objectiveMigrationNotice.message]);
  assert.deepEqual(reportEvidence(report).notices, [objectiveMigrationNotice]);
  for (const language of ['en', 'ar']) {
    const locale = artifactLocale({artifact_language: language}),
      expected = locale.text(objectiveMigrationNotice.message),
      book = new ExcelJS.Workbook();
    await book.xlsx.load(await reportWorkbook(report, {artifact_language: language}));
    const sheet = book.getWorksheet(locale.text('Campaign rows')),
      noteColumn = sheet.getRow(1).values.indexOf(locale.text('Report notices')),
      summary = book.worksheets[0].getSheetValues();
    assert.ok(noteColumn > 0);
    assert.equal(sheet.getRow(2).getCell(noteColumn).value, expected);
    assert.ok(summary.some(row => row?.[1] === locale.text('Note') && row[2] === expected));
    if (language === 'ar') {
      assert.notEqual(expected, objectiveMigrationNotice.message);
      assert.ok(pdfActualText(await reportPdf(report, {artifact_language: language})).includes(expected));
    } else assert.ok((await reportPdf(report)).subarray(0, 5).equals(Buffer.from('%PDF-')));
  }
  const old = {...report, config: {...report.config, contract_version: undefined}};
  assert.equal(reportTable(old)[0].includes('Report notices'), false);
  assert.equal(reportEvidence(old).notices, undefined);
});

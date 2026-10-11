import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {overviewSourceLevel, detailedOverviewRows} from '../dist/src/overview-granularity.js';
import {reportTable, exportCsv} from '../dist/src/google-sheets.js';
import {reportWorkbook} from '../dist/src/report-artifacts.js';
import {reportSummary} from '../dist/src/report-summary.js';
import {reportEvidence} from '../dist/src/report-quality.js';
import {overviewGranularityFixture, granularSource, granularConfig} from './fixtures/overview-granularity-data.mjs';

async function run(f, config) {
  const queued = await f.overview.handle({action: 'run', config, confirmed: true}, f.actor);
  assert.equal(await f.worker.once(), true);
  return f.overview.handle({action: 'get', id: queued.id}, f.actor);
}
test('every supported native ad and middle-level preset reaches Overview without inventing a LinkedIn ad set', async () => {
  for (const platform of ['meta', 'google', 'tiktok', 'snapchat', 'linkedin'])
    for (const level of platform === 'linkedin' ? ['ad'] : ['adset', 'ad']) {
      const f = overviewGranularityFixture();
      try {
        const report = await run(f, granularConfig(granularSource(platform, level)));
        assert.equal(report.state, 'complete', JSON.stringify(report.sources));
        assert.equal(report.rows.length, 1);
        const row = report.rows[0];
        assert.equal(row.entity_level, level);
        assert.equal(report.summary[0].entity_level, level);
        assert.equal(report.summary[0].entity_count, 1);
        assert.equal(report.summary[0].campaign_count, undefined);
        assert.ok(row.entity_id);
        assert.equal(row.source_kind, 'paid');
        assert.equal(row.native.daily_rows.length, 2);
        assert.ok(row.native.exact_totals.spend);
        assert.equal(row.metrics.reach, null);
        assert.equal(row.metrics.frequency, null);
        assert.equal(row.native.exact_totals.conversions, '4');
        const conversionFields = {
          google: '/metrics/conversions',
          meta: {path: '/actions', action_type: 'purchase'},
          tiktok: '/metrics/conversion',
          snapchat: '/stats/conversion_purchases',
          linkedin: '/externalWebsiteConversions',
        };
        assert.deepEqual(report.sources[0].metric_mapping.conversions, conversionFields[platform]);
        const evidence = reportEvidence(report);
        assert.deepEqual(evidence.sources[0].metric_mapping, report.sources[0].metric_mapping);
        assert.equal(
          evidence.metric_sources[platform],
          undefined,
          'Campaign rules cannot explain a detailed native preset',
        );
        assert.equal(
          f.store.documents('local', 'decision_report').length,
          0,
          'Internal capture never persists an extra report',
        );
        assert.ok(report.collection_budget.requests >= 4);
        if (platform === 'google')
          assert.ok(row.entity_id.includes(level === 'ad' ? '/adGroupAds/' : '9007199254740993'));
        if (platform === 'meta') {
          assert.equal(row.entity_id, level === 'ad' ? '9007199254740993' : '201');
          assert.equal(row.parent_ids.campaign_id, '101');
          assert.equal(row.native.exact_totals.spend, '0.200000002');
        }
        if (platform === 'linkedin') {
          assert.equal(row.timezone, 'UTC');
          assert.equal(row.campaign_id, null);
        }
      } finally {
        f.close();
      }
    }
  assert.throws(() => overviewSourceLevel(granularSource('linkedin', 'adset')), {code: 'REPORT_LEVEL_UNSUPPORTED'});
});

test('summary keeps hierarchy levels separate and preserves the existing campaign-only shape', () => {
  const campaign = {
    platform: 'meta',
    account_id: '100',
    currency: 'USD',
    timezone: 'UTC',
    objective_group: 'sales',
    date_from: '2026-09-01',
    date_to: '2026-09-02',
    result_definition: 'purchase',
    attribution: '7d_click',
    metrics: {spend: 1, clicks: 2},
    complete: true,
    recommendation: {decision: 'maintain'},
  };
  const groups = reportSummary([
    campaign,
    {...campaign, entity_level: 'adset', native_entity_type: 'adset'},
    {...campaign, entity_level: 'ad', native_entity_type: 'ad'},
  ]);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].campaign_count, 1);
  assert.equal(groups[0].entity_level, undefined);
  assert.deepEqual(
    groups.slice(1).map(g => [g.entity_level, g.entity_count, g.metrics.spend]),
    [
      ['adset', 1, 1],
      ['ad', 1, 1],
    ],
  );
});
test('daily native detail retains single-day reach while total detail never sums it; explicit missing results stay unknown', async () => {
  const f = overviewGranularityFixture();
  try {
    const report = await run(f, granularConfig(granularSource('meta'), 'daily'));
    assert.equal(report.state, 'complete', JSON.stringify(report.sources));
    assert.equal(report.rows.length, 2);
    assert.notEqual(report.rows[0].row_key, report.rows[1].row_key);
    assert.ok(
      report.rows.every(
        row => row.metrics.reach === 80 && row.metrics.frequency === 1.25 && row.metrics.conversions === 2,
      ),
    );
    // RPT-04 (owner policy P6): an absent action on a delivered day counts 0 with the qualifier (this test previously
    // expected unknown, the defect RPT-04 fixes); on a day without delivery it stays unknown.
    f.mutate(rows => rows.map((row, index) => (index ? {...row, actions: []} : row)));
    const omitted = await run(f, granularConfig());
    assert.equal(omitted.rows[0].metrics.conversions, 2);
    assert.equal(omitted.rows[0].native.exact_totals.conversions, '2');
    assert.deepEqual(omitted.rows[0].omitted_as_zero, ['conversions']);
    f.mutate(rows => rows.map((row, index) => (index ? {...row, impressions: '0', actions: []} : row)));
    const missing = await run(f, granularConfig());
    assert.equal(missing.rows[0].metrics.conversions, null);
    assert.equal(missing.rows[0].native.exact_totals.conversions, null);
  } finally {
    f.close();
  }
});
test('unsupported, ambiguous, extra-native-metric and unscoped parent requests are refused before egress', async () => {
  const f = overviewGranularityFixture();
  try {
    for (const source of [
      {...granularSource('meta'), level: 'adgroup'},
      {...granularSource('meta'), report_options: {}},
      {...granularSource('meta'), native_metrics: ['clicks']},
      {
        ...granularSource('meta'),
        report_options: {...granularSource('meta').report_options, attribution_windows: ['1d_click', '7d_click']},
      },
      {...granularSource('snapchat', 'adset'), campaign_id: undefined},
      {...granularSource('tiktok'), report_options: {complete_window: false, attribution: 'unknown'}},
    ]) {
      await assert.rejects(
        f.overview.handle({action: 'run', config: granularConfig(source), confirmed: true}, f.actor),
      );
    }
    assert.equal(f.requests.length, 0);
  } finally {
    f.close();
  }
});
test('duplicate dates and changed native parents fail instead of blending entity data', async () => {
  for (const mutate of [
    rows => [...rows, rows[0]],
    rows => rows.map((row, i) => (i ? {...row, adset_id: '202'} : row)),
  ]) {
    const f = overviewGranularityFixture();
    try {
      f.mutate(mutate);
      const report = await run(f, granularConfig());
      assert.equal(report.rows.length, 0);
      assert.equal(report.state, 'failed');
      assert.ok(
        ['REPORT_DUPLICATE_ROWS', 'REPORT_ACCOUNT_MISMATCH'].includes(report.sources[0].error.code),
        JSON.stringify(report.sources),
      );
    } finally {
      f.close();
    }
  }
});
test('account revocation during detailed collection leaves no rows or extra report', async () => {
  const f = overviewGranularityFixture();
  try {
    f.hook(url => {
      if (url.pathname.endsWith('/insights'))
        f.store.putConnection(
          f.actor,
          {...f.store.connection('local', granularSource('meta').connection_id), enabled: false},
          {accessToken: 'synthetic'},
        );
    });
    await run(f, granularConfig()).catch(() => {});
    assert.equal(f.store.documents('local', 'decision_report').length, 0);
    assert.ok(f.store.documents('local', 'overview_report').every(report => !report.rows?.length));
  } finally {
    f.close();
  }
});
test('exact detail validates aligned native rows and refuses unsafe displayed totals', () => {
  const source = granularSource('meta'),
    raw = {campaign_id: '101', adset_id: '201'};
  assert.throws(() => detailedOverviewRows(source, {rows: [{}], native_rows: []}), {code: 'REPORT_SHAPE_CHANGED'});
  assert.throws(() =>
    detailedOverviewRows(source, {
      rows: [{entity_id: '1', spend: '9007199254740993'}],
      native_rows: [raw],
      semantics: {currency: 'USD'},
    }),
  );
});
test('CSV, English/Arabic Excel and real queued Sheets batches preserve exact native IDs and original tabs', async () => {
  const f = overviewGranularityFixture();
  try {
    const report = await run(f, granularConfig()),
      table = reportTable(report),
      headers = table[0],
      adColumn = headers.indexOf('Entity ID');
    assert.equal(table[1][adColumn], '9007199254740993');
    assert.equal(table[1][headers.indexOf('Ad set / ad group ID')], '201');
    assert.match(exportCsv(report), /9007199254740993/);
    assert.match(exportCsv(report), /'=UNTRUSTED AD\(\)/);
    for (const language of ['en', 'ar']) {
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(await reportWorkbook(report, {artifact_language: language}));
      const sheet = book.getWorksheet(language === 'ar' ? 'صفوف الكيانات الإعلانية' : 'Entity rows');
      assert.equal(sheet.getCell(2, adColumn + 1).value, '9007199254740993');
      assert.equal(sheet.getCell(2, headers.indexOf('Entity') + 1).type, ExcelJS.ValueType.String);
      assert.equal(
        sheet.getCell(1, headers.indexOf('spend') + 1).value,
        language === 'ar' ? 'الإنفاق (spend)' : 'spend',
      );
    }
    const destination = await f.overview.handle(
      {
        action: 'bind_destination',
        connection_id: 'sheets-granular',
        spreadsheet_id: 'syntheticGranularSheet',
        tab_name: 'Native detail',
        idempotency_key: 'granular-sheet-v1',
        confirmed: true,
      },
      f.actor,
    );
    const exported = await f.overview.handle(
      {action: 'export', report_id: report.id, destination_id: destination.id, confirmed: true},
      f.actor,
    );
    assert.equal(await f.worker.once(), true);
    const status = await f.overview.handle({action: 'export_status', id: exported.id}, f.actor);
    assert.equal(status.state, 'complete', JSON.stringify(status));
    const cells = f.tabs.get(destination.sheet_id).values;
    assert.deepEqual(cells[1][adColumn], {stringValue: '9007199254740993'});
    assert.deepEqual(cells[1][headers.indexOf('Entity')], {stringValue: '=UNTRUSTED AD()'});
    assert.deepEqual(f.tabs.get(7).values, [['KEEP THIS ORIGINAL']]);
    assert.equal(f.store.documents('local', 'overview_schedule').length, 0);
  } finally {
    f.close();
  }
});

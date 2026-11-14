import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {exportCsv} from '../dist/src/report-table.js';
import {reportPdf, reportWorkbook} from '../dist/src/report-artifacts.js';
import {reportPack} from '../dist/src/report-packs.js';
import {reportEvidence} from '../dist/src/report-quality.js';
import {reportSummary} from '../dist/src/report-summary.js';
import {compareSnapshots} from '../dist/src/report-compare.js';
import {evaluateMonitors, monitorOperation} from '../dist/src/report-monitors.js';
import {DecisionReporting} from '../dist/src/decision-reporting.js';
import {pdfActualText} from './helpers/pdf-actual-text.mjs';
import {pdfPlainText} from './helpers/pdf-plain-text.mjs';
import {linkedinConnection, linkedinPipeline} from './helpers/linkedin-pipeline.mjs';
import {analytics, fixClock, run, stored, accountRulesPair, world} from './helpers/linkedin-windows-world.mjs';
import {linkedinConversionRule} from './fixtures/linkedin-conversion-rules-docs.mjs';

// V2-RPT-04: what reads a source's attribution after the join. Every consumer takes it from the source's period, so the
// pair has to reach all of them, and a total must never add results measured under different windows.
const rule = (id, click, view) => linkedinConversionRule(id, click, view);
const pair = accountRulesPair(30, 7);
const squash = text => text.replace(/\s+/g, '');
const pdfWords = bytes => squash(pdfPlainText(bytes).join(' ') + ' ' + pdfActualText(bytes));

test('every surface that shows a snapshot shows the pair in words: MCP, CSV, workbook, PDF, pack and evidence', async t => {
  const {f, report} = await run(t, 'campaign', {conversions: [rule('501', 30, 7), rule('502', 30, 7)]}),
    snapshot = stored(f, report);
  // The MCP tool answers with the source and the summary the website reads.
  const tool = await f.service.call('amcp_reporting_overview', {action: 'get', id: report.id}, f.actor);
  assert.equal(tool.success, true, JSON.stringify(tool));
  assert.equal(tool.data.sources[0].attribution, pair);
  assert.equal(tool.data.summary[0].attribution, pair);
  assert.ok(tool.data.sources[0].warnings.some(w => /conversion rules/.test(w)));
  // The CSV keeps the pair in the attribution column of every row.
  assert.ok(exportCsv(snapshot).includes(',"' + pair + '",'));
  // The workbook, in its summary sheet and in its rows sheet.
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await reportWorkbook(snapshot));
  for (const name of ['Account summaries', 'Entity rows', 'Campaign rows']) {
    const sheet = workbook.getWorksheet(name);
    if (!sheet) continue;
    const column = sheet.getRow(1).values.indexOf('Attribution');
    assert.ok(column > 0, name + ' has an attribution column');
    assert.equal(sheet.getRow(2).getCell(column).value, pair, name);
  }
  // The PDF prints it with the account summaries.
  assert.ok(pdfWords(await reportPdf(snapshot)).includes(squash(pair)));
  // The pack lists it for the source, and the evidence download has the source whole: the pair, the notes and the join.
  assert.equal(reportPack(snapshot).sources[0].attribution, pair);
  const evidence = reportEvidence(snapshot).sources[0];
  assert.equal(evidence.attribution, pair);
  assert.ok(
    evidence.warnings.some(w =>
      /^LinkedIn attribution windows come from the conversion rules this account owns/.test(w),
    ),
  );
  assert.equal(evidence.level_results[0].conversion_windows.status, 'single_window');
  assert.deepEqual(evidence.level_results[0].conversion_windows.single_window, {
    post_click_days: 30,
    post_view_days: 7,
  });
});

test('a total never adds results measured under different attributions: the pair and unknown summarise apart', async t => {
  const {f, report} = await run(t, 'campaign', {conversions: [rule('501', 30, 7)]}),
    [row] = stored(f, report).rows,
    twin = {...row, row_key: row.row_key + ':twin', attribution: 'unknown'},
    groups = reportSummary([row, twin], [], true);
  assert.deepEqual(groups.map(g => g.attribution).sort(), ['unknown', pair].sort());
  assert.deepEqual(
    groups.map(g => g.metrics.spend),
    ['50', '50'],
    'each summary holds its own row’s spend, not both',
  );
});

test('an Overview group of a joined source is captured as evidence under its attribution, the pair or the mixed words', async t => {
  for (const [rules, attribution] of [
    [[rule('501', 30, 7)], pair],
    [
      [rule('501', 30, 7), rule('502', 7, 1)],
      'LinkedIn conversion rules with mixed windows, no single window: 30d click / 7d view; 7d click / 1d view',
    ],
  ]) {
    const {f, report} = await run(t, 'campaign', {conversions: rules}),
      reporting = new DecisionReporting(f.store, (gateway, args, actor) => f.service.call(gateway, args, actor)),
      groups = await reporting.handle({action: 'overview_sources', id: report.id}, f.actor),
      captured = await reporting.handle(
        {action: 'capture_overview', id: report.id, group_id: groups.groups[0].id},
        f.actor,
      );
    assert.equal(groups.groups[0].semantics.attribution, attribution);
    assert.equal(captured.semantics.attribution, attribution);
    assert.equal(captured.totals.spend, '50');
  }
});

/** A monitor on the context of a summary, as the monitors page builds it from a retained snapshot. */
const saveMonitor = (f, summary, connection, more = {}) =>
  monitorOperation(f.store, f.actor, {
    action: 'save_monitor',
    confirmed: true,
    monitor: {
      name: 'Spend ceiling',
      platform: summary.platform,
      connection_id: connection,
      account_id: summary.account_id,
      currency: summary.currency,
      timezone: summary.timezone,
      result_definition: summary.result_definition,
      attribution: summary.attribution,
      metric: 'spend',
      comparison: 'above',
      threshold: '10',
      max_age_hours: 24,
      ...more,
    },
  });

test('a monitor declared on the pair a v4 snapshot recorded evaluates that snapshot; one declared on unknown no longer matches it', async t => {
  const {f, report} = await run(t, 'campaign', {conversions: [rule('501', 30, 7)]}),
    [summary] = report.summary;
  assert.equal(summary.attribution, pair);
  // An attribution is a retained setting of at most 200 characters; the pair is well within it.
  saveMonitor(f, summary, linkedinConnection);
  assert.equal(evaluateMonitors(f.store, f.actor, report.id).outcomes[0].state, 'open');
  // A rule declared before the join, on the unknown attribution the source then had, finds no summary of its context.
  const f2 = (await run(t, 'campaign', {conversions: [rule('501', 30, 7)]})).f;
  saveMonitor(f2, {...summary, attribution: 'unknown'}, linkedinConnection);
  const [outcome] = evaluateMonitors(
    f2.store,
    f2.actor,
    [...f2.store.documents(f2.actor.tenantId, 'overview_report')][0].id,
  ).outcomes;
  assert.deepEqual([outcome.status, outcome.reason], ['data_unavailable', 'no_matching_summary']);
});

test('a v3 LinkedIn snapshot keeps its attribution, makes no rules read, and its monitor keeps matching it', async t => {
  fixClock(t);
  const f = linkedinPipeline(t, {analytics, ...world(), conversions: [rule('501', 30, 7)]}),
    report = await f.run({sources: [{platform: 'linkedin', account_id: '100', connection_id: 'login'}]});
  assert.equal(report.state, 'complete');
  assert.notEqual(report.config.contract_version, 'overview-config-v4');
  assert.equal(report.sources[0].attribution, 'unknown');
  assert.ok(report.sources[0].warnings.some(w => /not independently verified/.test(w)));
  assert.equal(
    f.requests.some(p => p.path === '/rest/conversions'),
    false,
  );
  assert.equal(report.sources[0].conversion_windows, undefined);
  saveMonitor(f, report.summary[0], 'login');
  assert.equal(evaluateMonitors(f.store, f.actor, report.id).outcomes[0].state, 'open');
});

test('a snapshot is compared with an earlier one only when their windows are the same: a changed rule is a changed attribution', async t => {
  const window = {since: '2026-08-30', until: '2026-08-31'},
    now = async (rules, changes = {}) => {
      const {f, report} = await run(t, 'campaign', {conversions: rules, changes});
      return stored(f, report);
    },
    current = await now([rule('501', 30, 7)]),
    same = await now([rule('501', 30, 7)], {date_range: window}),
    changed = await now([rule('501', 7, 1)], {date_range: window});
  assert.equal(compareSnapshots(current, same).rows.length, 1);
  const refused = compareSnapshots(current, changed);
  assert.equal(refused.rows.length, 0);
  assert.deepEqual(
    refused.incompatible.map(entry => entry.reasons),
    [['attribution']],
  );
});

// V2-MCP-01: the public reporting reference is pinned to the executable contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ExcelJS from 'exceljs';
import {overviewTool} from '../dist/src/reporting-overview.js';
import {detailContractVersion, overviewEntityLevels} from '../dist/src/overview-levels.js';
import {firstPartyContract} from '../dist/src/first-party-contracts.js';
import {coverageReasons, reportCoverageNotes} from '../dist/src/report-coverage-notes.js';
import {objectiveReasonCodes, resolveObjective} from '../dist/src/report-objectives.js';
import {monitorUnavailableReasons} from '../dist/src/report-monitors.js';
import {
  normalizeOverviewV4Source,
  overviewConfigV4,
  projectOverviewV4Summaries,
  upgradeOverviewV3Config,
} from '../dist/src/overview-v4.js';
import {reportRollupLabel} from '../dist/src/report-scope-rollups.js';
import {reportTable} from '../dist/src/report-table.js';
import {reportWorkbook} from '../dist/src/report-artifacts.js';
import {redditResultRules} from '../dist/src/reddit-report-source.js';
import {overviewGranularityFixture, granularConfig, granularSource} from './fixtures/overview-granularity-data.mjs';

const doc = fs.readFileSync('docs/REPORTING-OVERVIEW.md', 'utf8');
function section(name) {
  const start = '<!-- ' + name + ':start -->',
    end = '<!-- ' + name + ':end -->';
  assert.ok(doc.includes(start) && doc.includes(end), 'missing documented section: ' + name);
  return doc.split(start)[1].split(end)[0];
}
const cells = line =>
  line
    .split('|')
    .slice(1, -1)
    .map(cell => cell.trim().replaceAll('`', ''));

test('REPORTING-OVERVIEW.md names every amcp_reporting_overview action', () => {
  const actions = [...section('overview-actions').matchAll(/`([a-z_]+)`/g)].map(match => match[1]);
  assert.equal(new Set(actions).size, actions.length, 'each action is listed once');
  assert.deepEqual(actions.sort(), [...overviewTool.inputSchema.properties.action.enum].sort());
});
test('the declared-incomplete detail contract label equals detailContractVersion', () => {
  const label = /\*\*Declared incomplete\.\*\*[\s\S]*?detail_contract:"(overview-detail-v\d+)"/.exec(doc)?.[1];
  assert.equal(label, detailContractVersion);
  assert.match(doc, /[Oo]lder[^\n]*overview-detail-v2/);
});
test('the level matrix equals overviewEntityLevels in native position order', () => {
  const actual = Object.fromEntries(
    section('overview-levels')
      .split('\n')
      .filter(line => /^\| `/.test(line))
      .map(line => {
        const [platform, ...levels] = cells(line);
        return [platform, levels];
      }),
  );
  assert.deepEqual(
    actual,
    Object.fromEntries(
      Object.entries(overviewEntityLevels).map(([platform, levels]) => [platform, levels.map(level => level.label)]),
    ),
  );
});
test('documented pages use the action schema bounds, and detailed measurement restrictions are explicit', () => {
  const actual = Object.fromEntries(
    section('overview-pages')
      .split('\n')
      .filter(line => /^\| `/.test(line))
      .map(line => {
        const [action, minimum, maximum, fallback] = cells(line);
        return [action, {minimum: Number(minimum), maximum: Number(maximum), default: Number(fallback)}];
      }),
  );
  const expected = Object.fromEntries(
    ['list', 'get', 'compare_candidates', 'compare', 'presentation_profiles'].map(action => {
      const property = firstPartyContract(overviewTool, action).argumentsSchema.properties.limit;
      return [action, {minimum: property.minimum, maximum: property.maximum, default: property.default}];
    }),
  );
  assert.deepEqual(actual, expected);
  for (const text of ['INVALID_NATIVE_METRICS', 'complete_window:true', 'campaign_id', 'Snapchat', 'TikTok'])
    assert.ok(doc.includes(text), text);
  for (const metric of ['spend', 'impressions', 'clicks', 'conversions', 'cpa', 'roas'])
    assert.ok(section('overview-default-metrics').includes('`' + metric + '`'), metric);
});

// F-L5-35: the v4 reference (selection, rolled-up totals, coverage notes, objective codes, monitors, the names in the
// files) lists what the engine writes, so each list is read from the code that writes it.
/** The cells of the rows of a documented table: every line whose first cell is a code-formatted name. */
const tableRows = name =>
  section(name)
    .split('\n')
    .filter(line => /^\| `/.test(line))
    .map(cells);
const flat = text => text.replace(/\s+/g, ' ');
const coverage = {known_rows: 1, total_rows: 2, basis: 'report_rows', report_rows: 2};

test('the documented coverage notes have the fields, units and reasons the engine writes', () => {
  const region = section('overview-coverage-notes'),
    notes = reportCoverageNotes({
      metrics_coverage: {
        spend: coverage,
        cpc: {...coverage, known_pairs: 1},
        impressions: {known_rows: 1, total_rows: 2, basis: 'native_measurements', report_rows: 1},
        conversion_value: {...coverage, known_rows: 2, unavailable_reason: 'unknown_currency'},
        frequency: {...coverage, known_rows: 2, unavailable_reason: 'non_additive_inputs'},
        cpa: {...coverage, known_rows: 0, unavailable_reason: 'calculation_limit'},
      },
    });
  assert.deepEqual(
    tableRows('overview-coverage-notes')
      .map(([reason]) => reason)
      .sort(),
    [...coverageReasons].sort(),
  );
  assert.deepEqual([...new Set(notes.map(note => note.reason))].sort(), [...coverageReasons].sort());
  const fields = /Each note is `\{([a-z_, ]+)\}`/.exec(region)?.[1].split(', ');
  for (const note of notes) assert.deepEqual(Object.keys(note), fields);
  assert.deepEqual([...new Set(notes.map(note => note.unit))].sort(), ['measurements', 'rows']);
  assert.ok(region.includes('`unit` is `rows` or `measurements`'));
  // `get` adds the notes to the summaries of a v4 snapshot, derived from the stored coverage, and to no other snapshot.
  const stored = {
      summary: [{metrics_coverage: {spend: coverage}}],
      window_summary: [{metrics_coverage: {spend: coverage}}],
    },
    read = projectOverviewV4Summaries({config: {contract_version: overviewConfigV4}, ...stored});
  assert.deepEqual(Object.keys(read).sort(), ['summary', 'window_summary']);
  for (const summaries of Object.values(read)) assert.equal(summaries[0].coverage_notes[0].reason, 'missing_values');
  assert.deepEqual(projectOverviewV4Summaries({config: {contract_version: 'overview-config-v3'}, ...stored}), {});
  assert.ok(flat(doc).includes('`get` adds `coverage_notes` to every `summary[]` and `window_summary[]` entry'));
});

test('the documented objective reason codes are the resolver’s, each with the source it gives', () => {
  const table = {
      name: 'Acme',
      values: {BUY: 'sales', MIXED: 'mixed', RETIRED: null},
      reason: native => (native === 'MIXED' ? 'Several objectives.' : null),
      missingReason: 'Acme returned no objective for this campaign.',
    },
    given = {},
    resolve = input => {
      const resolved = resolveObjective({platform: 'acme', table, ...input});
      given[resolved.reason_code] = resolved.source;
    };
  resolve({native: 'BUY', campaignId: '1', overrides: {1: 'leads'}});
  resolve({native: 'BUY', legacy: 'traffic'});
  resolve({native: 'MIXED'});
  resolve({native: null, table: {...table, mapped: () => ({group: 'leads', reason: 'Mapped from the goal.'})}});
  resolve({native: 'LEAD_FORM'});
  resolve({native: null, unread: 'refused', fallback: 'sales'});
  resolve({native: null, unread: 'limited', fallback: 'sales'});
  resolve({native: null, unread: 'refused'});
  resolve({native: null, unread: 'limited'});
  resolve({native: null});
  resolve({native: 'BUY', table: undefined});
  resolve({native: 'RETIRED'});
  resolve({native: 'NEW_THING'});
  assert.deepEqual(Object.keys(given).sort(), [...objectiveReasonCodes].sort(), 'the cases give every code');
  assert.deepEqual(
    Object.fromEntries(tableRows('objective-reason-codes').map(([code, source]) => [code, source])),
    given,
  );
  assert.ok(flat(doc).includes('`{native, group, source, reason, reason_code, reason_values}`'));
});

test('the documented reasons a monitor cannot answer are the ones the evaluation names', () => {
  assert.deepEqual(
    tableRows('overview-monitor-reasons')
      .map(([reason]) => reason)
      .sort(),
    [...monitorUnavailableReasons].sort(),
  );
  for (const text of ['data_unavailable', 'max_age_hours', 'save_monitor'])
    assert.ok(doc.includes('`' + text + '`'), text);
});

test('the documented source fields, their defaults, statuses and ID limit are the v4 contract’s', () => {
  const capabilities = {
      levels: ['campaign', 'adset', 'ad'].map(id => ({id, label: id, native_type: id})),
      defaults: {attribution: 'unknown', complete_window: null},
      option_names: ['attribution', 'complete_window'],
      delivery_metrics: ['spend', 'impressions', 'clicks'],
      supported_statuses: ['active', 'paused', 'archived', 'all'],
      status_basis: 'current_configuration',
    },
    source = {platform: 'fixture', account_id: '1', connection_id: 'login'},
    normalized = normalizeOverviewV4Source(source, capabilities),
    rows = tableRows('overview-source-selection');
  for (const [field, , fallback] of rows)
    for (const name of field.split(', ')) {
      assert.ok(Object.hasOwn(normalized, name), name + ' is a field of a source');
      assert.equal(JSON.stringify(normalized[name]), fallback, name + ' defaults as documented');
    }
  assert.deepEqual(rows.flatMap(([field]) => field.split(', ')).sort(), [
    'ad_ids',
    'adset_ids',
    'campaign_ids',
    'delivered_only',
    'levels',
    'statuses',
  ]);
  const statuses = [
    ...rows.find(([field]) => field === 'statuses')[1].matchAll(/\b(all|active|paused|archived)\b/g),
  ].map(match => match[1]);
  assert.deepEqual(statuses.sort(), ['active', 'all', 'archived', 'paused']);
  for (const status of statuses)
    assert.deepEqual(normalizeOverviewV4Source({...source, statuses: [status]}, capabilities).statuses, [status]);
  for (const refused of [['paused', 'bogus'], ['all', 'active'], []])
    assert.throws(
      () => normalizeOverviewV4Source({...source, statuses: refused}, capabilities),
      e => e.code === 'INVALID_REPORT_SOURCE',
    );
  const limit = Number(/Up to (\d+) exact native IDs each/.exec(rows.at(-1)[1])?.[1]),
    ids = count => Array.from({length: count}, (_, index) => 'c' + index);
  assert.equal(
    normalizeOverviewV4Source({...source, campaign_ids: ids(limit)}, capabilities).campaign_ids.length,
    limit,
  );
  assert.throws(
    () => normalizeOverviewV4Source({...source, campaign_ids: ids(limit + 1)}, capabilities),
    e => e.code === 'INVALID_REPORT_SOURCE',
  );
  // A v3 definition upgraded to v4 keeps the rows without activity it showed.
  const upgraded = upgradeOverviewV3Config(
    {name: 'Earlier report', sources: [{platform: 'fixture', connection_id: 'login', account_id: '1'}]},
    () => capabilities,
  );
  assert.equal(upgraded.sources[0].delivered_only, false);
  assert.ok(doc.includes('A v3 definition upgraded to v4 keeps `delivered_only:false`'));
  // `get` returns the evidence of a snapshot, and its charts (V2-EXP-01), only when asked.
  assert.deepEqual(Object.keys(overviewTool.inputSchema.properties.include.properties), [
    'native',
    'lineage',
    'charts',
  ]);
  assert.ok(doc.includes('`include:{native:true}` and `include:{lineage:true}`'));
  assert.ok(flat(doc).includes('`charts` are returned with `include:{charts:true}` and only then'));
});

test('the rolled-up fields, the labels and the export names the document gives are the real ones', async t => {
  const selected = '9007199254740993',
    other = '9007199254740994',
    f = overviewGranularityFixture();
  t.after(() => f.close());
  // Two ads are selected; one has no cost, and the other a cost with more digits than a number holds.
  f.mutate((rows, platform) =>
    platform === 'meta'
      ? rows.flatMap(r =>
          r.ad_id
            ? [
                {...r, spend: '9007199254740993'},
                {...r, ad_id: other, spend: null},
              ]
            : [{...r, spend: '100.100000001'}],
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
          ad_ids: [selected, other],
        }),
        contract_version: overviewConfigV4,
        date_range: {since: '2026-09-01', until: '2026-09-01'},
        metrics: ['spend', 'impressions', 'clicks', 'cpc'],
      },
    },
    f.actor,
  );
  await f.worker.once();
  const report = await f.overview.handle({action: 'get', id: queued.id, limit: 100}, f.actor),
    stored = f.store.document(f.actor.tenantId, 'overview_report', queued.id);
  assert.equal(report.state, 'complete', JSON.stringify(report.sources));
  // A rolled-up row and a rolled-up summary carry the fields the document lists; a native summary carries none.
  const listed = pattern => {
      const match = pattern.exec(flat(doc));
      assert.ok(match, 'the document lists ' + pattern);
      return ['kind', ...match[1].split(', ')];
    },
    row = report.rows.find(r => r.level === 'campaign'),
    aggregation = level => report.summary.find(s => s.entity_level === level)?.aggregation;
  assert.deepEqual(Object.keys(row.aggregation), listed(/`aggregation:\{kind:"rolled_up", ([a-z_, ]+)\}`/));
  assert.equal(row.aggregation.kind, 'rolled_up');
  assert.deepEqual(
    Object.keys(aggregation('campaign')),
    listed(/`aggregation:\{kind:"rolled_up_from_selected", ([a-z_, ]+)\}`/),
  );
  assert.equal(aggregation('campaign').kind, 'rolled_up_from_selected');
  assert.equal(aggregation('ad'), undefined, 'a summary of native rows has no aggregation');
  for (const scope_field of ['ad_ids', 'adset_ids'])
    assert.ok(
      doc.includes('"' + reportRollupLabel({aggregation: {kind: 'rolled_up', scope_field}}) + '"'),
      scope_field,
    );
  // Every name the document gives to a column, a row or a sheet is in the real files.
  const table = reportTable(stored),
    book = new ExcelJS.Workbook();
  await book.xlsx.load(await reportWorkbook(stored));
  const header = sheet => book.getWorksheet(sheet).getRow(1).values.filter(Boolean),
    reportRows = [];
  book.getWorksheet('Report').eachRow(r => reportRows.push(r.getCell(1).value));
  for (const [name, where] of [
    ['Coverage', table[0]],
    ['Aggregation', table[0]],
    ['Coverage note', table.map(line => line[0])],
    ['Coverage', reportRows],
    ['Precision', reportRows],
    ['Entity level', header('Account summaries')],
    ['Aggregation', header('Account summaries')],
    ['Coverage', header('Account summaries')],
    ['Level check', header('Source coverage')],
  ]) {
    assert.ok(where.includes(name), name + ' is in the file');
    assert.ok(doc.includes('`' + name + '`'), name + ' is in the document');
  }
  for (const sheet of ['Account summaries', 'Source coverage']) assert.ok(doc.includes('**' + sheet + '**'), sheet);
  assert.ok(book.getWorksheet('Report') && doc.includes('`Report` sheet'));
});

test('the words the document quotes from the website, and the Reddit objectives it lists, are the real ones', () => {
  const page = file => fs.readFileSync('web/' + file, 'utf8');
  assert.ok(page('reporting-overview.js').includes('Limited coverage: these totals may be incomplete.'));
  assert.ok(flat(doc).includes('"Limited coverage: these totals may be incomplete."'));
  assert.ok(page('report-source-settings.js').includes('I have checked the reporting window is complete'));
  assert.ok(doc.includes('**I have checked the reporting window is complete**'));
  const values = redditResultRules.selectors[0].values,
    row = doc.split('\n').find(line => line.startsWith('| Reddit Ads'));
  assert.deepEqual(
    Object.keys(values)
      .filter(objective => values[objective])
      .sort(),
    ['CLICKS', 'IMPRESSIONS', 'VIDEO_VIEWABLE_IMPRESSIONS'],
  );
  assert.deepEqual(
    Object.keys(values)
      .filter(objective => !values[objective])
      .sort(),
    ['APP_INSTALLS', 'CATALOG_SALES', 'CONVERSIONS', 'LEAD_GENERATION'],
  );
  assert.match(row, /impressions, clicks and viewable-video objectives report that field as the result/);
  assert.match(row, /conversion, catalogue-sales, lead-generation and app-install objectives claim none \(`unknown`\)/);
});

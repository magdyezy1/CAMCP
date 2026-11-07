// V2-EXP-01: charts are computed when a snapshot finishes, stored with it, and returned by get; a report can switch a chart
// off; a stored definition keeps that setting in its v4 form only; a list never carries them; the change of a key figure
// is read from the linked baseline when the report is read. The report is the real one: definition, queue, worker, row
// assembly, summaries and the get projection, over a fake collector.
import test from 'node:test';
import assert from 'node:assert/strict';
import {row} from './helpers/report-packets.mjs';
import {reportEngine} from './helpers/report-engine.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';
import {reportChartsOrNone} from '../dist/src/report-charts.js';
import {chartKindIds} from '../dist/src/report-chart-spec.js';

const spends = {c1: '20', c2: '10', c3: '5'};
const engine = (t, more = {}) =>
  reportEngine(t, {
    rowsFor: () => Object.entries(spends).map(([id, spend]) => row('campaign', id, {spend, clicks: '3'})),
    ...more,
  });
const kinds = report => (report.charts ?? []).map(spec => spec.kind);
/** The report as get returns it when the charts are asked for (include: {charts: true}). */
const withCharts = (e, id) => e.overview.handle({action: 'get', id, limit: 500, include: {charts: true}}, e.actor);

test('a finished v4 snapshot stores its charts, and get returns them when asked, not otherwise', async t => {
  const e = engine(t),
    {report, stored} = await e.go(['campaign']);
  assert.equal(report.state, 'complete');
  assert.ok(Array.isArray(stored.charts), 'stored with the snapshot');
  assert.deepEqual(kinds(stored), ['kpi', 'spend_by_entity', 'cost_vs_target', 'spend_by_objective', 'top_ads']);
  // A plain get keeps its size (a three-level report stays under a third of the single-level gets it replaces).
  assert.equal(Object.hasOwn(report, 'charts'), false);
  const asked = await withCharts(e, report.id);
  assert.deepEqual(asked.charts, stored.charts, 'get returns what was stored (no baseline, so no change)');
  assert.equal(
    Object.hasOwn(await e.overview.handle({action: 'get', id: report.id, include: {charts: false}}, e.actor), 'charts'),
    false,
  );
  await assert.rejects(e.overview.handle({action: 'get', id: report.id, include: {charts: 'yes'}}, e.actor), error =>
    assertRefused(error, 'INVALID_REPORT'),
  );
  await assert.rejects(e.overview.handle({action: 'get', id: report.id, include: {pie: true}}, e.actor), error =>
    assertRefused(error, 'INVALID_REPORT'),
  );
  const spend = stored.charts.find(spec => spec.kind === 'spend_by_entity');
  assert.equal(spend.drawn, true);
  assert.deepEqual(spend.series[0].values, ['20', '10', '5']);
  assert.equal(spend.context.currency, 'USD');
  // The three charts the report cannot draw say why, in words, and the data a chart needs is still in the report.
  const why = kind => stored.charts.find(spec => spec.kind === kind).notes.map(note => note.text);
  assert.deepEqual(why('cost_vs_target'), [
    'No campaign has a cost per result target, so there is nothing to compare costs with.',
  ]);
  assert.deepEqual(why('spend_by_objective'), ['All spend is on one objective, so there is nothing to compare.']);
  assert.deepEqual(why('top_ads'), ['This report has no ad-level rows.']);
  // The whole snapshot stays small beside its rows.
  assert.ok(JSON.stringify(stored.charts).length < 12000, JSON.stringify(stored.charts).length + ' bytes of charts');
});

test('a report that switches a chart off does not compute it', async t => {
  const {stored} = await engine(t).go(['campaign'], {charts: {disabled: ['kpi', 'top_ads', 'top_ads']}});
  assert.deepEqual(kinds(stored), ['spend_by_entity', 'cost_vs_target', 'spend_by_objective']);
  // The setting is stored the way it was written: normalized, in the frozen definition.
  assert.deepEqual(stored.config.charts, {disabled: ['kpi', 'top_ads']});
});

test('a report from before v4 gets no charts', async t => {
  const e = engine(t, {platform: 'meta'}),
    report = await e.run({});
  assert.notEqual(report.config.contract_version, 'overview-config-v4');
  assert.equal(report.charts, undefined);
  assert.equal(Object.hasOwn(e.stored(report.id), 'charts'), false);
});

test('chart settings are checked: known kinds only, v4 only, and an empty list is no setting', async t => {
  const e = engine(t),
    refuse = (changes, code = 'INVALID_REPORT') =>
      assert.rejects(e.queue(['campaign'], changes), error => assertRefused(error, code));
  await refuse({charts: {disabled: ['pie']}});
  await refuse({charts: {disabled: 'kpi'}});
  await refuse({charts: {disabled: [1]}});
  await refuse({charts: {other: true}});
  await refuse({charts: []});
  await refuse({charts: null});
  // A definition in the form before v4 has no such setting.
  await assert.rejects(
    e.overview.handle({action: 'run', confirmed: true, config: {...e.config, charts: {disabled: ['kpi']}}}, e.actor),
    error => assertRefused(error, 'INVALID_REPORT'),
  );
  // Every kind the editor offers is accepted; an empty list is dropped.
  const queued = await e.queue(['campaign'], {charts: {disabled: [...chartKindIds].reverse()}});
  assert.deepEqual(e.stored(queued.id).config.charts, {disabled: [...chartKindIds].sort()});
  const none = await e.queue(['campaign'], {charts: {disabled: []}});
  assert.equal(Object.hasOwn(e.stored(none.id).config, 'charts'), false);
});

test('a saved report keeps the setting in its v4 form only, so a build before V2 never sees it', async t => {
  const e = engine(t),
    saved = await e.overview.handle(
      {
        action: 'save',
        confirmed: true,
        config: e.definition(['campaign'], {name: 'Charts off', charts: {disabled: ['kpi']}}),
      },
      e.actor,
    );
  const record = e.store.document(e.actor.tenantId, 'overview_view', saved.id);
  assert.deepEqual(record.config_v4.charts, {disabled: ['kpi']});
  assert.equal(Object.hasOwn(record.config, 'charts'), false, 'the form Work-here reads has no chart setting');
  assert.equal(Object.hasOwn(record.config, 'contract_version'), false);
  // A run of the saved report uses the setting.
  const queued = await e.overview.handle({action: 'run', id: saved.id, confirmed: true}, e.actor);
  await e.worker.once();
  assert.deepEqual(kinds(e.stored(queued.id)), ['spend_by_entity', 'cost_vs_target', 'spend_by_objective', 'top_ads']);
});

test('a list of snapshots carries no charts, and get does', async t => {
  const e = engine(t),
    {queued} = await e.go(['campaign']),
    listed = await e.overview.handle({action: 'list'}, e.actor),
    entry = listed.reports.find(item => item.id === queued.id);
  assert.ok(entry, 'listed');
  assert.equal(Object.hasOwn(entry, 'charts'), false);
  assert.ok((await withCharts(e, queued.id)).charts.length);
});

test('a chart that cannot be computed never fails the snapshot: it is simply not there', () => {
  const failures = [];
  assert.equal(
    reportChartsOrNone({config: {contract_version: 'overview-config-v4'}, rows: [null]}, {}, error =>
      failures.push(error),
    ),
    undefined,
  );
  assert.equal(failures.length, 1);
  assert.deepEqual(
    reportChartsOrNone({config: {contract_version: 'overview-config-v4'}, rows: []}, {}, () => assert.fail()),
    undefined,
    'no rows, no charts',
  );
});

test('the change of a key figure is read from the linked baseline when the report is read', async t => {
  const e = engine(t),
    collect = e.overview.native.collect;
  e.overview.native.collect = async (source, dates) => ({
    ...(await collect(source, dates)),
    rows: ['c1', 'c2'].map(id => row('campaign', id, {spend: dates.since === '2026-09-01' ? '10' : '25'})),
  });
  const window = {since: '2026-09-08', until: '2026-09-14'},
    queued = await e.overview.handle(
      {
        action: 'run',
        confirmed: true,
        compare: 'previous_period',
        config: e.definition(['campaign'], {date_range: window}),
      },
      e.actor,
    );
  const baselineId = queued.comparison.baseline_id,
    work = id => e.overview.work(e.actor.tenantId, 'report_overview', {report_id: id});
  // The report finishes first: until its baseline does there is nothing to compare, and the report still reads.
  await work(queued.id);
  const unfinished = await withCharts(e, queued.id),
    tile = report => report.charts.find(spec => spec.kind === 'kpi').series.find(series => series.key === 'spend');
  assert.equal(unfinished.state, 'complete');
  assert.equal(tile(unfinished).values[0], '50');
  assert.equal(tile(unfinished).change, undefined);
  await work(baselineId);
  assert.equal(e.stored(baselineId).state, 'complete');
  const compared = await withCharts(e, queued.id);
  assert.deepEqual(tile(compared).change, {baseline: '20', delta: '30', delta_percent: '150'});
  // It is read, not stored: the stored snapshot has no change, and the baseline's own report has none.
  assert.equal(tile(e.stored(queued.id)).change, undefined);
  assert.equal(tile(await withCharts(e, baselineId)).change, undefined);
});

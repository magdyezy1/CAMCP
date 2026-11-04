import test from 'node:test';
import assert from 'node:assert/strict';
import {objectiveReportFixture} from './helpers/objective-report.mjs';
import {normalizeOverviewV4Source, overviewV4Scope} from '../dist/src/overview-v4.js';
import {reportSource} from '../dist/src/report-sources.js';

const version = 'overview-config-v4';

test('provider-owned delivery metrics retain analytics activity and preserve explicit missing values', async t => {
  for (const scenario of [
    {platform: 'ga4', metrics: {sessions: '4', users: null}, exact: {sessions: '4'}, retained: 1, unknown: 0},
    {platform: 'ga4', metrics: {sessions: null, users: '2'}, exact: {sessions: null}, retained: 1, unknown: 0},
    {platform: 'ga4', metrics: {sessions: '0', users: '0'}, exact: {sessions: null}, retained: 0, unknown: 1},
    {
      platform: 'gsc',
      metrics: {impressions: '0', clicks: '0'},
      exact: {impressions: '0', clicks: '0'},
      retained: 0,
      unknown: 0,
    },
    {
      platform: 'gsc',
      metrics: {impressions: '10', clicks: '0'},
      exact: {impressions: '10', clicks: '0'},
      retained: 1,
      unknown: 0,
    },
  ]) {
    const f = objectiveReportFixture(t, {
        platform: scenario.platform,
        rows: [{campaign_id: 'page', metrics: scenario.metrics, native: {exact_totals: scenario.exact}}],
      }),
      snapshot = await f.run({contract_version: version, metrics: Object.keys(scenario.metrics)});
    assert.equal(snapshot.row_count, scenario.retained, JSON.stringify(scenario));
    assert.equal(snapshot.state, scenario.unknown ? 'partial' : 'complete', JSON.stringify(snapshot.sources));
    assert.equal(snapshot.sources[0].scope.excluded_unknown_rows, scenario.unknown);
  }
  const f = objectiveReportFixture(t),
    bootstrap = await f.overview.handle({action: 'bootstrap'}, f.actor);
  for (const [platform, fields] of Object.entries({
    meta: ['spend', 'impressions', 'clicks'],
    ga4: ['sessions', 'users'],
    gsc: ['impressions', 'clicks'],
  })) {
    const source = normalizeOverviewV4Source(
      {platform, delivery_metrics: ['invented_metric']},
      reportSource(platform).overview,
    );
    assert.deepEqual(source.delivery_metrics, fields, 'client fields cannot redefine observed delivery');
    assert.deepEqual(bootstrap.platforms.find(item => item.id === platform).reporting_v4.delivery_metrics, fields);
    assert.equal(overviewV4Scope(source, [{metrics: {invented_metric: '999'}}]).rows.length, 0);
    if (platform !== 'meta') {
      assert.deepEqual(bootstrap.platforms.find(item => item.id === platform).reporting_v4.supported_statuses, ['all']);
      assert.equal(source.status_basis, 'not_applicable');
      assert.throws(
        () => normalizeOverviewV4Source({platform, statuses: ['active']}, reportSource(platform).overview),
        error => error.code === 'INVALID_REPORT_SOURCE',
      );
    }
  }
});

test('scope and objective filters preserve provider, scoped and visible counts independently', async t => {
  const f = objectiveReportFixture(t, {
      rows: [
        {campaign_id: '1', objective: 'OUTCOME_TRAFFIC', metrics: {spend: '1'}},
        {campaign_id: '2', objective: 'OUTCOME_SALES', metrics: {spend: '2'}},
        {campaign_id: '3', objective: 'OUTCOME_TRAFFIC', metrics: {spend: '3'}},
      ],
    }),
    sources = [{...f.config.sources[0], levels: ['campaign'], campaign_ids: ['1', '2']}],
    snapshot = await f.run({contract_version: version, sources, objectives: ['traffic']});
  assert.equal(snapshot.state, 'complete');
  assert.equal(snapshot.row_count, 1);
  assert.equal(snapshot.source_row_count, 3);
  assert.equal(snapshot.scoped_row_count, 2);
  assert.equal(snapshot.scope_filtered_row_count, 1);
  assert.equal(snapshot.objective_filtered_row_count, 1);
  assert.equal(snapshot.filtered_row_count, 2);
  assert.equal(snapshot.sources[0].row_count, 3);
  assert.equal(snapshot.sources[0].scoped_row_count, 2);
  assert.equal(snapshot.sources[0].visible_row_count, 1);
  assert.equal(snapshot.sources[0].level_results[0].row_count, 3);
  assert.equal(snapshot.sources[0].level_results[0].scoped_row_count, 2);
  assert.equal(snapshot.empty_reason, null);
  const empty = await f.run({contract_version: version, sources, objectives: ['leads']});
  assert.equal(empty.empty_reason, 'objective_filter');
  assert.equal(empty.source_row_count, 3);
  assert.equal(empty.objective_filtered_row_count, 2);
  const scopedOut = await f.run({
    contract_version: version,
    sources: [{...sources[0], campaign_ids: ['999']}],
  });
  assert.equal(scopedOut.state, 'complete');
  assert.equal(scopedOut.row_count, 0);
  assert.equal(scopedOut.empty_reason, 'scope_filter');
  assert.equal(scopedOut.source_row_count, 3);
  assert.equal(scopedOut.scoped_row_count, 0);
  assert.equal(scopedOut.scope_filtered_row_count, 3);
  assert.equal(scopedOut.objective_filtered_row_count, 0);
  const legacy = await f.run({objectives: ['traffic']});
  assert.equal(legacy.source_row_count, 3);
  assert.equal(legacy.filtered_row_count, 1);
  assert.equal(legacy.scoped_row_count, undefined, 'retained v3 counters keep their contract');
});

test('an empty provider response remains distinct from scope-filtered empty reports', async t => {
  const f = objectiveReportFixture(t),
    snapshot = await f.run({contract_version: version});
  assert.equal(snapshot.state, 'complete');
  assert.equal(snapshot.empty_reason, 'no_provider_rows');
  assert.equal(snapshot.source_row_count, 0);
  assert.equal(snapshot.scoped_row_count, 0);
  assert.equal(snapshot.filtered_row_count, 0);
});

test('a previously queued v4 job obtains new activity declarations from the server table', async t => {
  const f = objectiveReportFixture(t, {
      platform: 'ga4',
      rows: [{campaign_id: '1', metrics: {sessions: '4', users: null}}],
    }),
    config = f.overview.config({...f.config, contract_version: version, metrics: ['sessions']}, f.actor);
  delete config.sources[0].delivery_metrics;
  delete config.sources[0].status_basis;
  const snapshot = await f.finish(f.overview.queue(f.actor, config));
  assert.equal(snapshot.state, 'complete', JSON.stringify(snapshot.sources));
  assert.equal(snapshot.rows.length, 1);
  assert.deepEqual(snapshot.sources[0].scope.delivery_metrics, ['sessions', 'users']);
  assert.equal(snapshot.sources[0].scope.status_basis, 'not_applicable');
});

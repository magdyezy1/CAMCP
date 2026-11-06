import test from 'node:test';
import assert from 'node:assert/strict';
import {applyScopedRollups} from '../dist/src/report-scope-rollups.js';
import {resolveReportResult} from '../dist/src/report-results.js';
import {ReportCollectionBudget, reportCollectionLimits} from '../dist/src/report-collection-budget.js';

const capabilities = {
    levels: ['campaign', 'adset', 'ad'].map(id => ({id, native_type: id})),
    delivery_metrics: ['spend', 'impressions', 'clicks'],
    status_basis: 'current_configuration',
  },
  definition = {
    id: 'purchases',
    metric: 'purchases',
    label: 'Purchases',
    native_metric: 'purchases',
    aggregation: 'sum',
    unit: 'number',
  },
  source = {
    platform: 'fixture',
    account_id: '100',
    source_ref: 0,
    levels: ['campaign', 'ad'],
    ad_ids: ['a1', 'a2'],
    adset_ids: [],
    campaign_ids: [],
    statuses: ['all'],
    delivered_only: true,
  };
function child(id, spend, value, more = {}) {
  const resolved = resolveReportResult(definition, {value, spend}, 'provider');
  return {
    entity_id: id,
    entity_level: 'ad',
    campaign_id: 'c1',
    parent_ids: {campaign_id: 'c1', adset_id: 'g1'},
    currency: 'USD',
    status: 'active',
    metrics: {spend, impressions: '100', clicks: '10', reach: '50', frequency: '2', users: '20'},
    result: resolved.result,
    result_context: resolved,
    native: {delivery_activity: true},
    ...more,
  };
}
const packet = (level, rows) => ({
  source: {...source, level},
  date_range: {since: '2026-09-01', until: '2026-09-01'},
  currency: 'USD',
  timezone: 'UTC',
  attribution: 'fixture',
  complete: true,
  collection_complete: true,
  quality: {},
  rows,
});
const parent = () =>
  packet('campaign', [
    {
      entity_id: 'c1',
      entity_level: 'campaign',
      campaign_id: 'c1',
      currency: 'USD',
      status: 'active',
      metrics: {spend: '999'},
    },
  ]);
const apply = (rows, first = parent(), budget) =>
  applyScopedRollups([first, packet('ad', rows)], () => capabilities, budget)[0];

test('selected totals retain exact known coverage and derive costs from matched spend/result populations', () => {
  const report = apply([child('a1', '0.1', '2'), child('a2', null, '3')]),
    row = report.rows[0];
  assert.equal(row.metrics.spend, '0.1');
  assert.equal(row.result.value, '5');
  assert.equal(row.result.cost_per_result, '0.05');
  assert.deepEqual([row.metrics_coverage.spend.known_rows, row.metrics_coverage.spend.total_rows], [1, 2]);
  for (const name of ['reach', 'frequency', 'users']) assert.equal(row.metrics[name], null, name);
  const zero = apply([child('a1', '0', '0')]).rows[0];
  assert.equal(zero.metrics.spend, '0');
  assert.equal(zero.result.value, '0');
  assert.equal(zero.result.cost_per_result, null);
});

test('currency, timezone, attribution and periods never share a derived parent total', () => {
  for (const more of [
    {currency: 'EUR'},
    {period_context: {currency: 'USD', timezone: 'Asia/Riyadh', attribution: 'fixture'}},
    {period_context: {currency: 'USD', timezone: 'UTC', attribution: 'another'}},
    {report_period: {since: '2026-09-02', until: '2026-09-02'}},
  ]) {
    const report = apply([child('a1', '0.1', '2'), child('a2', '1', '3', more)]);
    assert.equal(report.rows.length, 2, JSON.stringify(more));
    assert.deepEqual(
      report.rows.map(row => row.metrics.spend),
      ['0.1', '1'],
    );
  }
  const missingCurrency = {currency: null, period_context: {currency: null, timezone: 'UTC', attribution: 'fixture'}};
  const unknown = apply([child('a1', '0.1', '2', missingCurrency), child('a2', '1', '3', missingCurrency)], {
    ...parent(),
    currency: null,
    rows: [],
  });
  assert.equal(unknown.rows[0].currency, null);
  assert.equal(unknown.rows[0].metrics.spend, null);
  assert.equal(unknown.rows[0].result.cost_per_result, null);
});

test('mixed result definitions stay separate and non-additive primary results cannot be added across selected ads', () => {
  const second = child('a2', '1', '3'),
    different = resolveReportResult(
      {...definition, id: 'leads', metric: 'leads', label: 'Leads'},
      {value: '3', spend: '1'},
      'provider',
    );
  const mixed = apply([child('a1', '0.1', '2'), {...second, result: different.result, result_context: different}])
    .rows[0];
  assert.equal(mixed.result.value, null);
  assert.equal(mixed.result_context.unavailable_reason, 'mixed_goals');
  assert.deepEqual(
    mixed.result_groups.map(group => group.result.value),
    ['2', '3'],
  );
  const reached = resolveReportResult(
    {...definition, id: 'reach', metric: 'reach', aggregation: 'non_additive'},
    {value: '50', spend: '1'},
    'provider',
  );
  const blocked = apply(['a1', 'a2'].map(id => child(id, '1', '50', {result: reached.result, result_context: reached})))
    .rows[0];
  assert.equal(blocked.result.value, null);
  assert.equal(blocked.result_context.unavailable_reason, 'non_additive');
});

test('native parent status applies after deriving selected totals; unknown parents keep positive status scope partial', () => {
  const wanted = {...parent(), source: {...source, level: 'campaign', statuses: ['paused']}};
  const first = child('a1', '1', '1', {status: 'paused'}),
    childPacket = {...packet('ad', [first]), source: {...source, level: 'ad', statuses: ['paused']}};
  let report = applyScopedRollups([wanted, childPacket], () => capabilities)[0];
  assert.equal(report.rows.length, 0);
  assert.equal(report.complete, true);
  assert.equal(report.scope.excluded_status_rows, 1);
  wanted.rows = [];
  report = applyScopedRollups([wanted, childPacket], () => capabilities)[0];
  assert.equal(report.rows.length, 0);
  assert.equal(report.complete, false);
  assert.equal(report.scope.excluded_unknown_rows, 1);
});

// Package engine-core (F-L5-04): a rollup that cannot be derived fails its level as a unit, with the same error as before,
// instead of throwing out of the whole job. The other levels keep their rows.
test('a native middle-level identity cannot belong to two different ancestor campaigns: that level fails, the ads stay', () => {
  const rows = [child('a1', '1', '1'), child('a2', '1', '1', {parent_ids: {campaign_id: 'c2', adset_id: 'g1'}})],
    middle = {...parent(), source: {...source, level: 'adset'}, rows: []},
    [failed, ads] = applyScopedRollups([middle, packet('ad', rows)], () => capabilities);
  assert.equal(failed.error.code, 'REPORT_ACCOUNT_MISMATCH');
  assert.equal(failed.source.level, 'adset');
  assert.deepEqual(failed.rows, []);
  assert.equal(failed.complete, false);
  assert.equal(ads.error, undefined);
  assert.equal(ads.rows.length, 2);
});

test('derivation consumes the existing row and byte budgets before it can return an oversized report', () => {
  for (const dimension of ['rows', 'bytes']) {
    const budget = new ReportCollectionBudget(undefined, 'synthetic', () => {}, {
      ...reportCollectionLimits,
      [dimension]: 0,
    });
    try {
      // Package engine-core (F-L5-04): the ancestor level fails as a unit with the limit error; nothing oversized returns.
      const report = apply([child('a1', '1', '1')], parent(), budget);
      assert.equal(report.error.code, 'REPORT_COLLECTION_LIMIT', dimension);
      assert.match(report.error.message, new RegExp('whole-job ' + dimension + ' limit'));
      assert.deepEqual(report.rows, [], dimension);
      assert.equal(report.complete, false, dimension);
    } finally {
      budget.close();
    }
  }
});

// Package engine-core (F-L5-09): the campaign read and the detail read of one source often declare different attribution
// (the provider's configured one against unknown). The parent row is found by entity and frame without it.
const configured = 'provider configured';
const richParent = (more = {}, packetMore = {}) => {
  const base = parent();
  base.attribution = configured;
  base.rows[0] = {
    ...base.rows[0],
    name: 'Spring sale',
    objective: 'OUTCOME_SALES',
    status: 'active',
    native: {delivery_activity: true, campaign: {advertisingChannelType: 'SHOPPING'}},
    ...more,
  };
  return {...base, ...packetMore};
};

test('a parent read under another attribution still supplies the rolled row’s status, name and objective', () => {
  const report = applyScopedRollups([richParent(), packet('ad', [child('a1', '1', '1')])], () => capabilities)[0],
    row = report.rows[0];
  assert.equal(report.rows.length, 1);
  assert.equal(row.status, 'active');
  assert.equal(row.objective, 'OUTCOME_SALES');
  assert.equal(row.entity_name, 'c1');
  assert.equal(
    row.period_context.attribution,
    'fixture',
    'the total itself keeps the attribution it was measured under',
  );
  assert.equal(
    row.native.scope_rollup.native_parent.campaign.advertisingChannelType,
    'SHOPPING',
    'the parent it was found under is recorded, with its own raw evidence',
  );
});

test('a status filter keeps a rolled row whose parent was read under another attribution', () => {
  const wanted = richParent({}, {source: {...source, level: 'campaign', statuses: ['active']}}),
    childPacket = {...packet('ad', [child('a1', '1', '1')]), source: {...source, level: 'ad', statuses: ['active']}},
    report = applyScopedRollups([wanted, childPacket], () => capabilities)[0];
  assert.equal(report.rows.length, 1, 'the active campaign is kept');
  assert.equal(report.rows[0].status, 'active');
  assert.equal(report.scope.excluded_unknown_rows, 0, 'its status is known');
  assert.equal(report.complete, true);
  // A parent that is paused is still excluded, by the status it really has.
  const paused = richParent({status: 'paused'}, {source: {...source, level: 'campaign', statuses: ['active']}}),
    excluded = applyScopedRollups([paused, childPacket], () => capabilities)[0];
  assert.equal(excluded.rows.length, 0);
  assert.equal(excluded.scope.excluded_status_rows, 1);
  assert.equal(excluded.scope.excluded_unknown_rows, 0);
});

test('a total never mixes attribution: children read under different attribution stay separate rows of one parent', () => {
  const other = child('a2', '1', '1', {period_context: {currency: 'USD', timezone: 'UTC', attribution: 'another'}}),
    report = applyScopedRollups([richParent(), packet('ad', [child('a1', '1', '1'), other])], () => capabilities)[0];
  assert.equal(report.rows.length, 2);
  assert.deepEqual(
    report.rows.map(row => [row.status, row.period_context.attribution]),
    [
      ['active', 'fixture'],
      ['active', 'another'],
    ],
  );
});

test('a requested ancestor never keeps the full parent’s results by objective or its other results', () => {
  const full = {
      results_by_objective: [{objective: 'FULL_PARENT', result_definition: 'Leads', value: 123456}],
      other_results: [{objective: 'OTHER', result_definition: 'Leads', value: 7}],
    },
    report = applyScopedRollups([richParent(full), packet('ad', [child('a1', '1', '1')])], () => capabilities)[0],
    row = report.rows[0];
  assert.equal(row.status, 'active', 'the identity of the parent is kept');
  assert.equal(Object.hasOwn(row, 'results_by_objective'), false);
  assert.equal(Object.hasOwn(row, 'other_results'), false);
  assert.equal(row.metrics.spend, '1', 'the figures are the selected ads’');
});
test('derived values use child measurement context and omissions while retaining parent metadata audit times', () => {
  const ancestor = parent();
  ancestor.captured_at = 1000;
  ancestor.query_fingerprint = 'parent';
  ancestor.rows[0].omitted_as_zero = ['conversions'];
  const children = packet('ad', [child('a1', '1', '2', {omitted_as_zero: ['leads']})]);
  children.captured_at = 2000;
  children.query_fingerprint = 'selected-ads';
  children.quality = {metric_rounding: {spend: {places: 9, rule: 'half_even', rows_rounded: 1}}};
  const derived = applyScopedRollups([ancestor, children], () => capabilities)[0],
    row = derived.rows[0];
  assert.equal(derived.captured_at, 2000);
  assert.equal(row.period_context.query_fingerprint, 'selected-ads');
  assert.deepEqual(row.period_context.quality.metric_rounding, children.quality.metric_rounding);
  assert.equal(row.period_context.quality.scope.returned_rows, 1);
  assert.deepEqual(row.omitted_as_zero, ['leads']);
  assert.equal(row.native.scope_rollup.parent_captured_at, 1000);
  assert.equal(row.native.scope_rollup.child_captured_at, 2000);
  assert.equal(row.period_context.rows, undefined);
});

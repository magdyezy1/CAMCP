import test from 'node:test';
import assert from 'node:assert/strict';
import {reportSummary, reportWindowSummary} from '../dist/src/report-summary.js';
import {tiktokNativeFixture} from './helpers/tiktok-native-fixture.mjs';

// Two TikTok campaigns whose ad groups optimize for four different events (F-L5-02). A campaign whose ad groups
// disagree has no single result; its conversions are the provider's own total for exactly those events, so two such
// campaigns may share a summary only if they mix the same events.
const events = [
  ['COMPLETE_PAYMENT', 'ADD_TO_CART'],
  ['ON_WEB_REGISTER', 'ON_WEB_DETAIL'],
];

test('v4 campaign summaries never add conversions across different TikTok optimization events', async t => {
  const f = tiktokNativeFixture(t, {
    campaigns: 2,
    groupsPerCampaign: 2,
    adsPerGroup: 1,
    eventFor: (campaign, group) => events[campaign][group],
    // The two campaigns spend differently, so a cost per conversion computed across them could not equal either one.
    metricsFor: (units, {level, id}) => ({
      spend: level === 'campaign' ? {101: '10', 102: '30'}[id] : String(units / 8),
      impressions: String(units * 10),
      clicks: String(units * 2),
      conversion: String(units),
      result: String(units),
      cost_per_result: '0.125',
      result_rate: '50',
    }),
  });
  const queued = await f.queue({
    ...f.v4(),
    metrics: ['spend', 'conversions', 'cpa', 'primary_result', 'cost_per_result'],
  });
  await f.worker.once();
  const report = await f.get(queued.id);
  assert.equal(report.state, 'complete', JSON.stringify(report.sources));
  assert.equal(report.rows.filter(row => row.level === 'campaign').length, 2);
  for (const row of report.rows.filter(row => row.level === 'campaign')) {
    assert.equal(row.result.value, null, 'a campaign that mixes events has no single result');
    assert.equal(row.result_context.unavailable_reason, 'mixed_goals');
    assert.equal(row.result_groups.length, 2);
  }

  const campaigns = report.summary.filter(summary => !summary.entity_level || summary.entity_level === 'campaign');
  assert.equal(campaigns.length, 2, 'one summary for each set of mixed events, never one for both');
  assert.equal(
    campaigns.some(summary => summary.metrics.conversions === '8'),
    false,
    'conversions of four different events are never one number',
  );
  const byEvent = Object.fromEntries(
    campaigns.map(summary => [
      summary.result_groups
        .map(group => group.definition.id.replace('tiktok:CONVERT:', ''))
        .sort()
        .join('+'),
      summary,
    ]),
  );
  assert.deepEqual(Object.keys(byEvent).sort(), ['ADD_TO_CART+COMPLETE_PAYMENT', 'ON_WEB_DETAIL+ON_WEB_REGISTER']);
  for (const summary of campaigns) {
    assert.equal(summary.metrics.conversions, '4');
    assert.equal(summary.campaign_count, 1);
    assert.match(summary.result_definition, /mixing optimization events/);
    assert.equal(summary.metrics.primary_result, null);
  }
  // The cost per conversion belongs to one campaign: 10 spent over 4 conversions, 30 over 4. Across both it would be 5.
  assert.equal(byEvent['ADD_TO_CART+COMPLETE_PAYMENT'].metrics.cpa, '2.5');
  assert.equal(byEvent['ON_WEB_DETAIL+ON_WEB_REGISTER'].metrics.cpa, '7.5');
  const named = byEvent['ADD_TO_CART+COMPLETE_PAYMENT'].result_definition;
  assert.match(named, /ADD_TO_CART/);
  assert.match(named, /COMPLETE_PAYMENT/);
  assert.doesNotMatch(named, /ON_WEB/, 'the provider names exactly the events this campaign mixes');

  // Ad groups carry one event each, so each event has its own ad group summary.
  const groups = report.summary.filter(summary => summary.entity_level === 'adset');
  assert.deepEqual(groups.map(summary => summary.result_groups.length).sort(), [1, 1, 1, 1]);
  assert.equal(groups.length, 4);
});

// The same guard on the pure functions, for rows whose provider named no row definition at all: the result groups they
// hold are the only thing that tells two unresolved rows apart.
const unresolved = (id, groupIds, extra = {}) => ({
  platform: 'fixture',
  account_id: '1',
  currency: 'USD',
  timezone: 'UTC',
  objective_group: 'sales',
  campaign_id: id,
  campaign_key: 'fixture:1:' + id,
  date_from: '2026-09-01',
  date_to: '2026-09-02',
  attribution: 'Synthetic verified window',
  result_definition: 'unknown',
  complete: true,
  metrics: {spend: '10', conversions: '4'},
  result: {metric: null, label: null, value: null, cost_per_result: null, definition_id: null},
  result_context: {definition: null, source: 'unknown', cost_source: 'unknown', unavailable_reason: 'mixed_goals'},
  result_groups: groupIds.map(groupId => ({
    definition: {
      id: groupId,
      metric: 'conversions',
      label: 'Results',
      native_metric: 'n',
      aggregation: 'sum',
      unit: 'number',
    },
    result: {metric: 'conversions', label: 'Results', value: '2', cost_per_result: null, definition_id: groupId},
    source: 'mapped',
    cost_source: 'unknown',
    unavailable_reason: null,
    rounding: {},
    coverage: {known: 1, total: 1},
    cost_coverage: {known_pairs: 0, total: 1},
  })),
  recommendation: {decision: 'needs_review'},
  ...extra,
});

test('rows with no resolved result are told apart by the definitions of their result groups, in either order', () => {
  const rows = [unresolved('1', ['a', 'b']), unresolved('2', ['c', 'd']), unresolved('3', ['b', 'a'])];
  const summaries = reportSummary(rows, [], true);
  assert.equal(summaries.length, 2);
  assert.deepEqual(summaries.map(summary => summary.campaign_count).sort(), [1, 2]);
  assert.equal(summaries.find(summary => summary.campaign_count === 2).metrics.conversions, '8');
  const windows = reportWindowSummary(rows, [], true);
  assert.equal(windows.length, 2);
  assert.deepEqual(windows.map(summary => summary.entity_count).sort(), [1, 2]);
});

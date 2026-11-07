import test from 'node:test';
import assert from 'node:assert/strict';
import {runCollectScenario} from './helpers/report-collect-scenarios.mjs';
import {normalizeOverviewV4Source} from '../dist/src/overview-v4.js';
import {reportSource} from '../dist/src/report-sources.js';

/**
 * F-L5-21: Reddit's rule table pins VIDEO_VIEWABLE_IMPRESSIONS as the result of a video views campaign, but the report
 * request never asked for the field, so the pin could not produce a value. The v4 request asks for it; the v3 request is
 * unchanged.
 */
const viewable = 'VIDEO_VIEWABLE_IMPRESSIONS';
const account = 't2_acct';
const base = {platform: 'reddit', account_id: account, connection_id: 'login'};
const legacy = (level, extra = {}) =>
  level === 'campaign'
    ? {...base, ...extra}
    : {...base, level, report_options: {complete_window: true, attribution: 'unknown'}, ...extra};
const v4 = (level, extra = {}) => ({
  ...normalizeOverviewV4Source(
    {
      ...base,
      levels: [level],
      report_options: {complete_window: true, attribution: 'unknown'},
      delivered_only: false,
      ...extra,
    },
    reportSource('reddit').overview,
  ),
  level,
});
// A provider that returns a report column only when the request asked for it, as Reddit does.
const reddit = objective => plan => {
  if (plan.path === '/api/v3/ad_accounts/' + account)
    return {data: {id: account, name: 'Synthetic Reddit', currency: 'USD', time_zone_id: 'UTC'}};
  if (plan.path.endsWith('/reports')) {
    const asked = plan.body.data.fields;
    return {
      data: {
        metrics: [
          {
            campaign_id: '11',
            ad_group_id: '22',
            ad_id: '33',
            spend: 2000000,
            impressions: 1000,
            clicks: 4,
            ...(asked.includes(viewable) ? {[viewable]: 900} : {}),
          },
        ],
      },
    };
  }
  if (plan.path.endsWith('/campaigns')) return {data: [{id: '11', name: 'Campaign 11', objective}]};
  const kind = plan.path.endsWith('/ad_groups') ? 'ad_groups' : 'ads',
    ids = String(plan.query.id).split(',');
  return {
    data: {
      ad_groups: [{id: '22', name: 'Group 22', campaign_id: '11', ad_account_id: account}],
      ads: [{id: '33', name: 'Ad 33', ad_group_id: '22', campaign_id: '11', ad_account_id: account}],
    }[kind].filter(item => ids.includes(item.id)),
  };
};
const run = (name, source, objective = viewable) =>
  runCollectScenario({name, gateway: 'reddit_native_action', account, answer: reddit(objective), source});
const requested = recording =>
  recording.requests.find(item => item.plan.path.endsWith('/reports')).plan.body.data.fields;

test('the v4 request asks for the pinned video result at every level, once, before any extra field', async () => {
  for (const level of ['campaign', 'adset', 'ad']) {
    assert.deepEqual(
      requested(await run('v4 ' + level, v4(level))),
      ['SPEND', 'IMPRESSIONS', 'CLICKS', viewable],
      level,
    );
  }
  // A person who also asks for the field gets it once; other extra fields keep their place after it.
  assert.deepEqual(requested(await run('v4 extra', v4('campaign', {native_metrics: [viewable, 'VIDEO_STARTED']}))), [
    'SPEND',
    'IMPRESSIONS',
    'CLICKS',
    viewable,
    'VIDEO_STARTED',
  ]);
});

test('the v3 request is byte-identical: the pinned video result is not asked for', async () => {
  for (const level of ['campaign', 'adset', 'ad'])
    assert.deepEqual(requested(await run('v3 ' + level, legacy(level))), ['SPEND', 'IMPRESSIONS', 'CLICKS'], level);
  assert.deepEqual(
    requested(await run('v3 extra', legacy('campaign', {native_metrics: ['CONVERSION_PURCHASE_TOTAL_VALUE']}))),
    ['SPEND', 'IMPRESSIONS', 'CLICKS', 'CONVERSION_PURCHASE_TOTAL_VALUE'],
  );
});

test('a Reddit video views campaign reports its viewable video impressions as the result at every v4 level', async () => {
  for (const level of ['campaign', 'adset', 'ad']) {
    const recording = await run('result ' + level, v4(level)),
      [row] = recording.result.rows;
    assert.equal(recording.error, undefined, JSON.stringify(recording.error));
    assert.equal(row.result.value, '900', level);
    assert.equal(row.result.metric, 'video_viewable_impressions');
    assert.equal(row.result.definition_id, 'reddit:viewable_video_impressions');
    // Spend 2 over 900 results: the pinned rule counts one result per viewable impression.
    assert.equal(row.result.cost_per_result, '0.002222222');
    assert.equal(row.result_context.unavailable_reason, null);
  }
  // Another objective is untouched by the extra column: its result is its own pinned field.
  const clicks = await run('clicks', v4('campaign'), 'CLICKS');
  assert.equal(clicks.result.rows[0].result.metric, 'clicks');
  assert.equal(clicks.result.rows[0].result.value, '4');
});

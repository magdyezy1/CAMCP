import test from 'node:test';
import assert from 'node:assert/strict';
import {MirrorError} from '../dist/src/errors.js';
import {xCampaignReport} from '../dist/src/x-campaign-report.js';
import {assertRefused} from './helpers/assert-refused.mjs';

const hour = 3600000,
  start = Date.parse('2026-09-01T00:00:00Z');
const threeWeeks = start + 21 * 24 * hour;
const active = {
  version: 1,
  fingerprint: 'synthetic',
  requests: 1,
  entities: [{entity_id: 'e1', start, end: threeWeeks, placements: ['ALL_ON_TWITTER']}],
};
const hoursOf = query => (Date.parse(query.end_time) - Date.parse(query.start_time)) / hour;
/** X's synchronous answer to one request: an echo of the request and one value per hour for each metric. */
function answer(query, metrics = {impressions: 1, billed_charge_local_micro: 1000000}, omit = []) {
  const n = hoursOf(query);
  return {
    request: {
      params: {
        entity: query.entity,
        entity_ids: query.entity_ids.split(','),
        start_time: query.start_time,
        end_time: query.end_time,
        granularity: 'HOUR',
        metric_groups: query.metric_groups.split(','),
        placement: query.placement,
      },
    },
    time_series_length: n,
    data: query.entity_ids
      .split(',')
      .filter(id => !omit.includes(id))
      .map(id => ({
        id,
        id_data: [
          {
            segment: null,
            metrics: Object.fromEntries(
              Object.entries(metrics).map(([name, value]) => [
                name,
                Array.isArray(value) || (value && typeof value === 'object') ? value : Array(n).fill(value),
              ]),
            ),
          },
        ],
      })),
  };
}
const refusal = (status, code = 'UPSTREAM_ERROR') =>
  new MirrorError(code, 'X refused the request.', {http_status: status, upstream: {errors: [{message: 'no'}]}}, status);
const line = [{id: 'e1', name: 'One'}];
const run = (read, options = {}) =>
  xCampaignReport(line, start, threeWeeks, [], read, {exact: true, entity: 'LINE_ITEM', active, ...options});

for (const entity of ['LINE_ITEM', 'PROMOTED_TWEET'])
  for (const code of ['REPORT_COLLECTION_LIMIT', 'REPORT_BUDGET_INVALID'])
    test('AMCP’s own ' + code + ' ends the ' + entity + ' analytics loop and is not blamed on X', async () => {
      let calls = 0;
      const saved = [];
      await assert.rejects(
        run(
          async query => {
            if (++calls === 3)
              throw new MirrorError(code, 'This snapshot reached its whole-job requests limit.', {}, 422);
            return answer(query);
          },
          {entity, save: value => saved.push(structuredClone(value))},
        ),
        error => assertRefused(error, code),
      );
      assert.equal(calls, 3);
      const last = saved.at(-1);
      assert.equal(last.next, 2, 'the failed step is not recorded as done, so a later run repeats it');
      assert.deepEqual(last.failures, [], 'no X rejection is recorded');
      assert.equal(
        last.warnings.some(warning => warning.startsWith('X rejected')),
        false,
      );
    });

test('AMCP’s own limit also ends the campaign-level analytics loop', async () => {
  await assert.rejects(
    xCampaignReport(line, start, threeWeeks, [], async () => {
      throw new MirrorError('REPORT_COLLECTION_LIMIT', 'This snapshot reached its whole-job requests limit.', {}, 422);
    }),
    error => assertRefused(error, 'REPORT_COLLECTION_LIMIT'),
  );
});

for (const status of [400, 404, 422])
  test(
    'an X rejection (HTTP ' + status + ') of one detail chunk stays partial and keeps the other chunks',
    async () => {
      let calls = 0;
      const saved = [];
      const report = await run(
        async query => {
          if (++calls === 2) throw refusal(status);
          return answer(query);
        },
        {save: value => saved.push(structuredClone(value))},
      );
      assert.equal(report.complete, false);
      assert.equal(report.rows.length, 1);
      assert.equal(report.rows[0].native_metrics.impressions, String(2 * 7 * 24), 'two of the three weeks were read');
      assert.equal(
        report.warnings.filter(warning => warning.startsWith('X rejected ALL_ON_TWITTER / ENGAGEMENT,BILLING')).length,
        1,
      );
      assert.equal(saved.at(-1).failures.length, 1);
      assert.equal(saved.at(-1).next, 3, 'a provider rejection is recorded as an answered chunk');
    },
  );

test('a detail chunk that omits requested IDs stays partial and names the omission', async () => {
  const report = await xCampaignReport(
    [
      {id: 'e1', name: 'One'},
      {id: 'e2', name: 'Two'},
    ],
    start,
    start + 7 * 24 * hour,
    [],
    async query => answer(query, undefined, ['e2']),
    {
      exact: true,
      entity: 'LINE_ITEM',
      active: {
        ...active,
        entities: [
          {entity_id: 'e1', start, end: threeWeeks, placements: ['ALL_ON_TWITTER']},
          {entity_id: 'e2', start, end: threeWeeks, placements: ['ALL_ON_TWITTER']},
        ],
      },
    },
  );
  assert.equal(report.complete, false);
  assert.deepEqual(
    report.rows.map(row => row.id),
    ['e1'],
    'the returned subset is retained and the missing entity is not zero-filled',
  );
  assert.ok(report.warnings.includes('X omitted requested native entity IDs; the returned subset is retained.'));
});

// X documents no ratio among the metrics its analytics returns (rates are derived from counts), but a ratio summed over
// hours is wrong whatever sends it: [0.1, 0, 0.05, 0.05] is 0.05 over those four hours, not 0.2.
const hourly = {
  impressions: [100, 100, 100, 100],
  engagements: [5, 5, 5, 5],
  billed_charge_local_micro: [1000000, 0, 2000000, 0],
  engagement_rate: [0.1, 0, 0.05, 0.05],
  conversion_purchases: {metric: [1, 0, 2, 0], order_quantity: [1, 0, 3, 0]},
};
for (const exact of [true, false])
  test('only additive X metrics are summed over hours (' + (exact ? 'exact' : 'legacy') + ' arithmetic)', async () => {
    const report = await xCampaignReport(line, start, start + 4 * hour, [], async query => answer(query, hourly), {
      ...(exact ? {exact: true} : {}),
      entity: 'LINE_ITEM',
      active,
    });
    const metrics = report.rows[0].native_metrics;
    assert.equal(Number(metrics.impressions), 400);
    assert.equal(Number(metrics.engagements), 20);
    assert.equal(Number(metrics.billed_charge_local_micro), 3000000);
    assert.equal(Number(metrics.conversion_purchases_metric), 3, 'nested conversion counts are additive');
    assert.equal(Number(metrics.conversion_purchases_order_quantity), 4);
    assert.equal(Object.hasOwn(metrics, 'engagement_rate'), false, 'a rate is never summed');
    assert.ok(
      report.warnings.includes(
        'X returned metrics that are not additive counts or amounts, such as rates; they are not summed over hours and are left out.',
      ),
    );
  });

test('the additive allowlist keeps every count and amount in X’s ENGAGEMENT, BILLING and VIDEO groups', async () => {
  const documented = [
    'engagements',
    'impressions',
    'retweets',
    'replies',
    'likes',
    'follows',
    'card_engagements',
    'clicks',
    'app_clicks',
    'url_clicks',
    'qualified_impressions',
    'carousel_swipes',
    'billed_engagements',
    'billed_charge_local_micro',
    'video_total_views',
    'video_views_25',
    'video_views_50',
    'video_views_75',
    'video_views_100',
    'video_cta_clicks',
    'video_content_starts',
    'video_3s100pct_views',
    'video_6s_views',
    'video_15s_views',
  ];
  const report = await xCampaignReport(
    line,
    start,
    start + 2 * hour,
    ['VIDEO'],
    async query => answer(query, Object.fromEntries(documented.map(name => [name, [1, 2]]))),
    {exact: true, entity: 'LINE_ITEM', active},
  );
  for (const name of documented) assert.equal(report.rows[0].native_metrics[name], '3', name);
  assert.equal(
    report.warnings.some(warning => warning.startsWith('X returned metrics that are not additive')),
    false,
  );
});

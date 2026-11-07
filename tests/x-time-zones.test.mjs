import test from 'node:test';
import assert from 'node:assert/strict';
import {overviewGranularityFixture, granularConfig, granularSource} from './fixtures/overview-granularity-data.mjs';

/**
 * F-L5-23 and F-L5-24, through the X collectors (the real queue, worker and collection):
 * - an account whose days start on a half hour is read over whole UTC hours, and each boundary hour belongs to the local
 *   day holding its midpoint (docs/workflows/REPORTS.md), with a warning that names the rule;
 * - a day whose local midnight is skipped by a clock change starts at its first valid instant.
 */
const midpointWarning =
  'X reports whole UTC hours. Boundary hours are assigned by their midpoint so adjacent local periods do not overlap; exact fractional-hour totals are unavailable.';
const hourly = 10; // the fake provider reports 10 impressions in every UTC hour

async function run(t, zone, range, {level = 'campaign', grain = 'total'} = {}) {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  f.hook(url => {
    if (url.hostname !== 'ads-api.x.com') return;
    if (url.pathname === '/12/accounts/100')
      return Response.json({data: {id: '100', name: 'Synthetic X', currency: 'USD', timezone: zone}});
    // X reports activity throughout the window it is asked about.
    if (url.pathname.endsWith('/active_entities'))
      return Response.json({
        data: [
          {
            entity_id: {CAMPAIGN: 'c1', LINE_ITEM: 'l1', PROMOTED_TWEET: 'p1'}[url.searchParams.get('entity')],
            placements: ['ALL_ON_TWITTER'],
            activity_start_time: url.searchParams.get('start_time'),
            activity_end_time: url.searchParams.get('end_time'),
          },
        ],
      });
  });
  const {objective, level: ignored, ...source} = granularSource('x', level),
    config = {
      ...granularConfig(source, grain),
      date_range: range,
      contract_version: 'overview-config-v4',
      sources: [{...source, levels: [level]}],
    };
  const queued = await f.overview.handle({action: 'run', config, confirmed: true}, f.actor);
  await f.worker.once();
  const report = await f.overview.handle({action: 'get', id: queued.id, limit: 500}, f.actor),
    requests = f.requests
      .filter(request => request.url.pathname === '/12/stats/accounts/100')
      .map(request => [request.url.searchParams.get('start_time'), request.url.searchParams.get('end_time')]);
  return {report, requests, impressions: report.rows.map(row => row.metrics.impressions)};
}
const warnings = report => report.sources[0].level_results.flatMap(item => item.warnings ?? []);

for (const level of ['campaign', 'adset'])
  test(
    'an X account on a half-hour zone is read over whole UTC hours at the ' + level + ' level (Asia/Kolkata)',
    async t => {
      const whole = await run(t, 'Asia/Kolkata', {since: '2026-09-01', until: '2026-09-02'}, {level});
      assert.equal(whole.report.state, 'complete', JSON.stringify(whole.report.sources));
      // Local midnight is 18:30 UTC: the request widens to the hours that contain it, never a half-hour timestamp.
      assert.deepEqual(whole.requests, [['2026-08-31T18:00:00Z', '2026-09-02T19:00:00Z']]);
      assert.equal(whole.impressions[0], String(48 * hourly), 'the 48 hours whose midpoints fall inside the two days');
      assert.ok(warnings(whole.report).includes(midpointWarning), 'the source names the midpoint rule');
      // Each boundary hour belongs to exactly one local day: adjacent days add up to the whole window.
      const first = await run(t, 'Asia/Kolkata', {since: '2026-09-01', until: '2026-09-01'}, {level}),
        second = await run(t, 'Asia/Kolkata', {since: '2026-09-02', until: '2026-09-02'}, {level});
      assert.deepEqual(first.requests, [['2026-08-31T18:00:00Z', '2026-09-01T19:00:00Z']]);
      assert.deepEqual(second.requests, [['2026-09-01T18:00:00Z', '2026-09-02T19:00:00Z']]);
      assert.equal(Number(first.impressions[0]) + Number(second.impressions[0]), Number(whole.impressions[0]));
      assert.equal(first.impressions[0], String(24 * hourly));
    },
  );

test('a whole-hour X zone keeps its exact request and says nothing about midpoints (control)', async t => {
  const {report, requests, impressions} = await run(t, 'UTC', {since: '2026-09-01', until: '2026-09-02'});
  assert.equal(report.state, 'complete', JSON.stringify(report.sources));
  assert.deepEqual(requests, [['2026-09-01T00:00:00Z', '2026-09-03T00:00:00Z']]);
  assert.equal(impressions[0], String(48 * hourly));
  assert.equal(warnings(report).includes(midpointWarning), false);
});

// Zones that skip their local midnight on these days: the clocks move from 00:00 to 01:00, so the day is 23 hours long and
// starts at the clock change.
const skipped = [
  ['Africa/Cairo', '2026-04-24', '2026-04-23T22:00:00Z', '2026-04-24T21:00:00Z'],
  ['Asia/Beirut', '2026-03-29', '2026-03-28T22:00:00Z', '2026-03-29T21:00:00Z'],
  ['America/Havana', '2026-03-08', '2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z'],
];
for (const level of ['campaign', 'adset'])
  for (const [zone, day, start, end] of skipped)
    test('X ' + level + ' level: ' + day + ' in ' + zone + ' starts at its first valid instant', async t => {
      const {report, requests, impressions} = await run(t, zone, {since: day, until: day}, {level});
      assert.equal(report.state, 'complete', JSON.stringify(report.sources));
      assert.deepEqual(requests, [[start, end]]);
      assert.equal(impressions[0], String(23 * hourly), 'the day is 23 hours long');
    });

test('a daily X report across a skipped midnight keeps each day whole and adds up to the window (Africa/Cairo)', async t => {
  const daily = await run(t, 'Africa/Cairo', {since: '2026-04-23', until: '2026-04-25'}, {grain: 'daily'}),
    total = await run(t, 'Africa/Cairo', {since: '2026-04-23', until: '2026-04-25'});
  assert.equal(daily.report.state, 'complete', JSON.stringify(daily.report.sources));
  assert.deepEqual(
    daily.report.rows.map(row => [row.date_from, row.metrics.impressions]),
    [
      ['2026-04-23', String(24 * hourly)],
      ['2026-04-24', String(23 * hourly)],
      ['2026-04-25', String(24 * hourly)],
    ],
  );
  assert.equal(total.report.state, 'complete', JSON.stringify(total.report.sources));
  assert.equal(total.impressions[0], String(71 * hourly));
});

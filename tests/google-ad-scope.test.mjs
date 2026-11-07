import test from 'node:test';
import assert from 'node:assert/strict';
import {overviewGranularityFixture, granularConfig, granularSource} from './fixtures/overview-granularity-data.mjs';
import {googleEvidenceRow} from './fixtures/google-evidence-data.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';
import {reportSource} from '../dist/src/report-sources.js';

/**
 * F-L5-08: Google names an ad by its ad_group_ad resource name (customers/<customer>/adGroupAds/<group>~<ad>), but the
 * website asks for the ad's own numeric ID. The scope of a Google ad source is matched by Google's own rule.
 */
const adA = '9007199254740993',
  adB = '9007199254740995',
  adC = '9007199254740997',
  resourceOf = (group, ad) => 'customers/123/adGroupAds/' + group + '~' + ad;
// One campaign (1) with two ad groups: group 2 holds the ads A and B, group 3 holds the ad C. One day.
const day = {[adA]: [1500000, 100, 10], [adB]: [2500000, 50, 5], [adC]: [4000000, 70, 7]};
const total = (...ids) => [0, 1, 2].map(i => ids.reduce((n, id) => n + day[id][i], 0));
const metrics = ([costMicros, impressions, clicks]) => ({
  costMicros: String(costMicros),
  impressions: String(impressions),
  clicks: String(clicks),
  conversions: 1,
  conversionsValue: 1,
});
const figures = ([costMicros, impressions, clicks]) => ({
  spend: String(costMicros / 1e6),
  impressions: String(impressions),
  clicks: String(clicks),
});
const shown = row => ({spend: row.metrics.spend, impressions: row.metrics.impressions, clicks: row.metrics.clicks});
/** The answer of the Google fake for one resource: every entity of the hierarchy, once for each requested day. */
function hierarchy(resource, days) {
  const entities =
    resource === 'campaign'
      ? [{...googleEvidenceRow('campaign', '1'), metrics: metrics(total(adA, adB, adC))}]
      : resource === 'ad_group'
        ? [
            {...googleEvidenceRow('ad_group', '2'), metrics: metrics(total(adA, adB))},
            {...googleEvidenceRow('ad_group', '3'), metrics: metrics(total(adC))},
          ]
        : [
            [adA, '2'],
            [adB, '2'],
            [adC, '3'],
          ].map(([ad, group]) => ({...googleEvidenceRow('ad_group_ad', ad, group), metrics: metrics(day[ad])}));
  return days.flatMap(segments => entities.map(entity => ({...entity, segments})));
}
async function run(t, ad_ids, more = {}) {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  // The fixture asks for the rows of a request after the hook ran, so the hook can tell which resource it reads.
  let resource = '';
  f.hook(() => {
    resource = /FROM (\w+)/.exec(f.requests.at(-1)?.body?.query ?? '')?.[1] ?? resource;
  });
  f.mutate((rows, kind) =>
    kind === 'google' && ['campaign', 'ad_group', 'ad_group_ad'].includes(resource)
      ? hierarchy(
          resource,
          rows.map(row => row.segments),
        )
      : rows,
  );
  const {objective, level, ...source} = granularSource('google', 'ad'),
    config = {
      ...granularConfig(source),
      contract_version: 'overview-config-v4',
      date_range: {since: '2026-09-01', until: '2026-09-01'},
      metrics: ['spend', 'impressions', 'clicks'],
      sources: [{...source, levels: ['campaign', 'adset', 'ad'], ad_ids, ...more}],
    };
  const queued = await f.overview.handle({action: 'run', config, confirmed: true}, f.actor);
  await f.worker.once();
  return f.overview.handle({action: 'get', id: queued.id, limit: 500}, f.actor);
}
const byLevel = (report, level) => report.rows.filter(row => row.level === level);

test('without a scope the same fake returns every ad and the full parents (control for the scoped runs)', async t => {
  const report = await run(t, []);
  assert.equal(report.state, 'complete', JSON.stringify(report.sources));
  assert.deepEqual(
    byLevel(report, 'ad')
      .map(row => row.entity_id)
      .sort(),
    [resourceOf('2', adA), resourceOf('2', adB), resourceOf('3', adC)],
  );
  assert.deepEqual(shown(byLevel(report, 'campaign')[0]), figures(total(adA, adB, adC)));
  assert.deepEqual(
    byLevel(report, 'adset')
      .map(row => [row.entity_id, shown(row)])
      .sort(),
    [
      ['2', figures(total(adA, adB))],
      ['3', figures(total(adC))],
    ],
  );
  assert.ok(byLevel(report, 'ad').every(row => row.aggregation === undefined));
});

test('a Google ad scope takes the numeric ad ID the website asks for and returns that ad with its exact rollups', async t => {
  const report = await run(t, [adA]);
  assert.equal(report.state, 'complete', JSON.stringify(report.sources));
  assert.deepEqual(
    report.rows.map(row => row.level).sort(),
    ['ad', 'adset', 'campaign'],
    'the selected ad and the rows rolled up from it, nothing else',
  );
  const [ad] = byLevel(report, 'ad'),
    expected = figures(total(adA));
  // The row keeps Google's own identity: the resource name.
  assert.equal(ad.entity_id, resourceOf('2', adA));
  // The ad's own figures. Its sibling B in the same ad group and the ad C of the other group are not in them.
  assert.deepEqual(shown(ad), expected);
  for (const level of ['adset', 'campaign']) {
    const [rolled] = byLevel(report, level);
    assert.equal(rolled.aggregation?.kind, 'rolled_up', level);
    assert.equal(rolled.aggregation.from_level, 'ad', level);
    assert.equal(rolled.aggregation.child_rows, 1, level);
    assert.deepEqual(shown(rolled), expected, level + ' carries the selected ad only, never the full parent');
  }
  assert.equal(byLevel(report, 'adset')[0].entity_id, '2');
  assert.equal(byLevel(report, 'campaign')[0].entity_id, '1');
  const scope = report.sources[0].level_results.find(item => item.level === 'ad').scope;
  assert.equal(scope.excluded_rows, 2, 'the other two ads are outside the scope');
});

test('several Google ad IDs select several ads, an ID of no ad selects nothing, and group scopes still work', async t => {
  const both = await run(t, [adA, adC]);
  assert.equal(both.state, 'complete');
  assert.deepEqual(
    byLevel(both, 'ad')
      .map(row => row.entity_id)
      .sort(),
    [resourceOf('2', adA), resourceOf('3', adC)],
  );
  assert.deepEqual(shown(byLevel(both, 'campaign')[0]), figures(total(adA, adC)));
  assert.equal(byLevel(both, 'adset').length, 2);
  const none = await run(t, ['9007199254740999']);
  assert.equal(none.row_count, 0);
  assert.equal(none.empty_reason, 'scope_filter');
  // The ad group scope selects by the number Google rows already carry.
  const group = await run(t, [], {adset_ids: ['3']});
  assert.deepEqual(
    byLevel(group, 'ad').map(row => row.entity_id),
    [resourceOf('3', adC)],
  );
});

test('the scope ID pattern stays strict: a resource name or a group-and-ad pair is still refused', async t => {
  for (const id of ['2~' + adA, resourceOf('2', adA), 'customers/123/ads/' + adA])
    await assert.rejects(run(t, [id]), error => assertRefused(error, 'INVALID_REPORT_SOURCE'), id);
});

test('Google reads the ad ID of a row from its ad_group_ad resource name and from nothing else', () => {
  const read = reportSource('google').overview.scopeEntityId;
  assert.equal(typeof read, 'function');
  assert.equal(read({entity_id: resourceOf('2', adA)}, 'ad'), adA);
  // Only the ad level has a second spelling; a campaign and an ad group are named by their own numbers.
  assert.equal(read({entity_id: '2'}, 'adset'), undefined);
  assert.equal(read({entity_id: '1'}, 'campaign'), undefined);
  assert.equal(read({entity_id: resourceOf('2', adA)}, 'adset'), undefined);
  // A name that is not a Google ad_group_ad resource name is left alone, not guessed at.
  for (const entity_id of [
    adA,
    '2~' + adA,
    'customers/123/ads/' + adA,
    'customers/123/adGroupAds/2~',
    'customers/123/adGroupAds/~' + adA,
    'customers/123/adGroupAds/2~' + adA + '/extra',
    'customers/abc/adGroupAds/2~' + adA,
    undefined,
    null,
    7,
  ])
    assert.equal(read({entity_id}, 'ad'), undefined, String(entity_id));
});

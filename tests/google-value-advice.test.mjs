import test from 'node:test';
import assert from 'node:assert/strict';
import {overviewGranularityFixture, granularConfig, granularSource} from './fixtures/overview-granularity-data.mjs';
import {googleEvidenceCustomer} from './fixtures/google-evidence-data.mjs';

/**
 * F-L5-13, found while testing it: a value-based Google campaign's result is its conversion value, and the advice asks
 * "enough results?" of the result. Counting the value would let one large sale clear a minimum of ten results, so the
 * guard counts the conversions behind a result that is money.
 */
const day = '2026-09-01',
  nextDay = '2026-09-02';
const row = (id, bidding, conversions, value, date = day) => ({
  customer: googleEvidenceCustomer(),
  campaign: {
    id,
    resourceName: 'customers/123/campaigns/' + id,
    name: 'Campaign ' + id,
    status: 'ENABLED',
    advertisingChannelType: bidding === 'MAXIMIZE_CONVERSIONS' ? 'SHOPPING' : 'SEARCH',
    biddingStrategyType: bidding,
  },
  metrics: {costMicros: '10000000', impressions: '1000', clicks: '100', conversions, conversionsValue: value},
  segments: {date},
});
async function advise(t, rows, targets, grain = 'total') {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  let query = '';
  f.hook(() => {
    query = f.requests.at(-1)?.body?.query ?? query;
  });
  f.mutate((answer, kind) => (kind === 'google' && /FROM campaign /.test(query) ? rows : answer));
  const {objective, level, ...source} = granularSource('google', 'ad'),
    queued = await f.overview.handle(
      {
        action: 'run',
        confirmed: true,
        config: {
          ...granularConfig(source, grain),
          contract_version: 'overview-config-v4',
          date_range: {since: day, until: grain === 'total' ? day : nextDay},
          metrics: ['spend', 'conversions', 'conversion_value', 'roas', 'cpa', 'primary_result', 'cost_per_result'],
          targets,
          sources: [{...source, levels: ['campaign']}],
        },
      },
      f.actor,
    );
  await f.worker.once();
  const report = await f.overview.handle({action: 'get', id: queued.id, limit: 500}, f.actor),
    // The default view keeps the decision and drops its evidence; the native view carries the evidence, keyed by row.
    native = await f.overview.handle({action: 'get', id: queued.id, limit: 500, include: {native: true}}, f.actor);
  assert.equal(report.state, 'complete', JSON.stringify(report.sources));
  const evidence = new Map(native.rows.map(item => [item.row_key, item.recommendation?.evidence]));
  return Object.fromEntries(
    report.rows.map(item => [item.entity_id, {...item.recommendation, evidence: evidence.get(item.row_key)}]),
  );
}

test('a ROAS target is not met by one large sale: the sample counts conversions, not money', async t => {
  const advice = await advise(t, [row('11', 'TARGET_ROAS', 1, 50), row('12', 'TARGET_ROAS', 30, 300)], {
    sales: {kpi: 'roas', target: 3, currency: 'USD', direction: 'higher'},
  });
  // ROAS is 5 and 30 against a target of 3, but one conversion is not enough to tell a signal from a small sample.
  assert.equal(advice['11'].decision, 'insufficient_data');
  assert.equal(advice['11'].evidence.results, 1, 'the results are the conversions, not the 50 of value');
  assert.equal(advice['11'].evidence.minimum_results, 10);
  assert.equal(advice['12'].decision, 'scale');
  assert.equal(advice['12'].evidence.results, 30);
});

test('a result that is a count keeps counting itself (control)', async t => {
  const advice = await advise(
    t,
    [row('21', 'MAXIMIZE_CONVERSIONS', 1, 50), row('22', 'MAXIMIZE_CONVERSIONS', 30, 300)],
    {sales: {kpi: 'cpa', target: 5, currency: 'USD', direction: 'lower'}},
  );
  assert.equal(advice['21'].decision, 'insufficient_data');
  assert.equal(advice['21'].evidence.results, 1);
  assert.equal(advice['22'].decision, 'scale');
  assert.equal(advice['22'].evidence.results, 30);
});

test('an explicit result metric in the target still wins over the default', async t => {
  const advice = await advise(t, [row('31', 'TARGET_ROAS', 1, 50)], {
    sales: {kpi: 'roas', target: 3, currency: 'USD', direction: 'higher', result_metric: 'conversion_value'},
  });
  // The person asked for the value to be the sample, so one sale of 50 is five times the minimum.
  assert.equal(advice['31'].decision, 'scale');
  assert.equal(advice['31'].evidence.results, 50);
});

test('a grouped report keeps the same guard over the whole window', async t => {
  // Two days of one sale worth 100 each hold 200 of value but two conversions; two days of six sales hold twelve.
  const advice = await advise(
    t,
    [
      row('41', 'TARGET_ROAS', 1, 100, day),
      row('41', 'TARGET_ROAS', 1, 100, nextDay),
      row('42', 'TARGET_ROAS', 6, 100, day),
      row('42', 'TARGET_ROAS', 6, 100, nextDay),
    ],
    {sales: {kpi: 'roas', target: 3, currency: 'USD', direction: 'higher'}},
    'daily',
  );
  assert.equal(advice['41'].decision, 'insufficient_data');
  assert.equal(advice['41'].evidence.results, 2, 'the window counts its two conversions, not its 200 of value');
  assert.equal(advice['42'].decision, 'scale');
  assert.equal(advice['42'].evidence.results, 12);
});

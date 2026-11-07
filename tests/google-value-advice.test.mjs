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
const row = (id, bidding, conversions, value, date = day, costMicros = '10000000') => ({
  customer: googleEvidenceCustomer(),
  campaign: {
    id,
    resourceName: 'customers/123/campaigns/' + id,
    name: 'Campaign ' + id,
    status: 'ENABLED',
    advertisingChannelType: bidding === 'MAXIMIZE_CONVERSIONS' ? 'SHOPPING' : 'SEARCH',
    biddingStrategyType: bidding,
  },
  metrics: {costMicros, impressions: '1000', clicks: '100', conversions, conversionsValue: value},
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

/**
 * A result counted in money has no cost per result (spend per unit of value is only the inverse of ROAS), so a target
 * that is a cost per result cannot be compared with it. That is not a small sample, so the row must not say "wait for
 * enough results": it says why, and asks for a return target or a review by hand. Nothing else changes.
 */
const costTargetReason =
  'This campaign’s result is a conversion value, so a cost per result target cannot be compared with it. Set a return on ad spend target for it, or review it by hand.';
const costTarget = (extra = {}) => ({
  sales: {kpi: 'cost_per_result', target: 5, currency: 'USD', direction: 'lower', ...extra},
});

test('a cost per result target cannot be compared with a conversion value: the row says so, at any number of results', async t => {
  for (const targets of [
    costTarget(),
    // The KPI of a v4 target defaults to cost per result.
    {sales: {target: 5, currency: 'USD'}},
    // Naming conversions as the sample does not make a cost per result of a conversion value.
    costTarget({result_metric: 'conversions'}),
  ]) {
    const advice = await advise(t, [row('51', 'TARGET_ROAS', 1, 50), row('52', 'TARGET_ROAS', 30, 300)], targets);
    for (const id of ['51', '52']) {
      assert.equal(advice[id].decision, 'needs_review', id + ' ' + JSON.stringify(targets));
      assert.equal(advice[id].reason, costTargetReason, id);
    }
  }
});

test('only that case changes: counts, a return target, a missing target, a wrong currency, no spend and no results answer as before', async t => {
  // A count result has a cost per result: one conversion is a small sample, thirty are far below a target of 5.
  const counts = await advise(
    t,
    [row('61', 'MAXIMIZE_CONVERSIONS', 1, 50), row('62', 'MAXIMIZE_CONVERSIONS', 30, 300)],
    costTarget(),
  );
  assert.equal(counts['61'].decision, 'insufficient_data');
  assert.equal(counts['61'].reason, 'Wait for enough results to distinguish a signal from a small sample.');
  assert.equal(counts['62'].decision, 'scale');
  // A return target is compared with a conversion value as before (the first test of this file).
  const returns = await advise(t, [row('63', 'TARGET_ROAS', 30, 300)], {
    sales: {kpi: 'roas', target: 3, currency: 'USD', direction: 'higher'},
  });
  assert.equal(returns['63'].decision, 'scale');
  // The rules that answer before the sample check still do.
  const none = await advise(t, [row('64', 'TARGET_ROAS', 30, 300)], {});
  assert.equal(none['64'].decision, 'needs_target');
  const currency = await advise(t, [row('65', 'TARGET_ROAS', 30, 300)], costTarget({currency: 'SAR'}));
  assert.equal(currency['65'].decision, 'needs_review');
  assert.equal(currency['65'].reason, 'The target currency must match the campaign account currency.');
  const unspent = await advise(t, [row('66', 'TARGET_ROAS', 30, 300, day, '0')], costTarget());
  assert.equal(unspent['66'].decision, 'insufficient_data');
  assert.match(unspent['66'].reason, /^No spend, or less than the minimum spend/);
  // Spend of 10 is more than three targets of 2 and nothing was reported: the pause rule is about conversions.
  const nothing = await advise(t, [row('67', 'TARGET_ROAS', 0, 0)], costTarget({target: 2}));
  assert.equal(nothing['67'].decision, 'reconsider_pause');
});

test('a grouped report gives the same answer over the whole window', async t => {
  const advice = await advise(
    t,
    [row('81', 'TARGET_ROAS', 1, 100, day), row('81', 'TARGET_ROAS', 1, 100, nextDay)],
    costTarget(),
    'daily',
  );
  assert.equal(advice['81'].decision, 'needs_review');
  assert.equal(advice['81'].reason, costTargetReason);
});

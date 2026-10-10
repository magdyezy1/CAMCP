// RPT-04 item 4 (owner policy P6): Meta omits zero-valued action entries. A delivered row (impressions above 0) from a
// complete page counts an absent requested action as 0 with the `omitted_as_zero` qualifier; a row without delivery
// keeps it unknown. Before RPT-04 one campaign with only clicks blanked the account's conversions, CPA and ROAS.
import test from 'node:test';
import assert from 'node:assert/strict';
import {granularConfig, granularSource, overviewGranularityFixture} from './fixtures/overview-granularity-data.mjs';
import {normalizeNativeRow} from '../dist/src/report-native.js';
import {campaignRecommendation} from '../dist/src/report-metrics.js';
import {reportSummary} from '../dist/src/report-summary.js';

async function run(f, config) {
  const queued = await f.overview.handle({action: 'run', config, confirmed: true}, f.actor);
  assert.equal(await f.worker.once(), true);
  return f.overview.handle({action: 'get', id: queued.id, limit: 100}, f.actor);
}
const campaignSource = () => {
  const {level, report_options, ...source} = granularSource('meta', 'campaign');
  return source;
};
/** Day two drops Meta's action lists; `impressions` decides whether that day had delivery. */
const dropSecondDayActions = impressions => (rows, platform) =>
  platform !== 'meta'
    ? rows
    : rows.map(row => {
        const out = {...row, objective: 'OUTCOME_SALES'};
        if (row.date_start === '2026-09-02') {
          delete out.actions;
          delete out.action_values;
          out.impressions = impressions;
        }
        return out;
      });

test('RPT-04: a delivered Meta campaign day without the purchase action counts 0 conversions with the qualifier', async () => {
  const f = overviewGranularityFixture();
  try {
    f.mutate(dropSecondDayActions('100'));
    const report = await run(f, granularConfig(campaignSource(), 'daily'));
    assert.equal(report.state, 'complete', JSON.stringify(report.sources?.[0]?.error));
    const [first, second] = [...report.rows].sort((a, b) => (a.date_from < b.date_from ? -1 : 1));
    assert.equal(first.metrics.conversions, 2);
    // Actions Meta did not list on a delivered day (leads, installs, ...) count as 0 too, and stay named.
    assert.deepEqual(first.omitted_as_zero, ['engagements', 'installs', 'leads', 'video_views']);
    assert.equal(second.metrics.conversions, 0, 'before RPT-04 this was unknown (null)');
    assert.deepEqual(second.omitted_as_zero, [
      'conversion_value',
      'conversions',
      'engagements',
      'installs',
      'leads',
      'purchases',
      'video_views',
    ]);
    assert.deepEqual(second.quality.omitted_as_zero, second.omitted_as_zero, 'exports carry the qualifier in quality');
    assert.equal(second.metrics.cpa, null, 'no CPA from zero results');
    const summary = report.summary.find(g => g.date_from === '2026-09-02');
    assert.equal(summary.metrics.conversions, 0);
    assert.equal(summary.omitted_as_zero.conversions, 1);
  } finally {
    f.close();
  }
});

test('RPT-04: a Meta day without delivery keeps absent actions unknown', async () => {
  const f = overviewGranularityFixture();
  try {
    f.mutate(dropSecondDayActions('0'));
    const report = await run(f, granularConfig(campaignSource(), 'daily'));
    const second = report.rows.find(r => r.date_from === '2026-09-02');
    assert.equal(second.metrics.conversions, null);
    assert.equal(second.omitted_as_zero, undefined);
    assert.equal(report.summary.find(g => g.date_from === '2026-09-02').omitted_as_zero, undefined);
  } finally {
    f.close();
  }
});

test('RPT-04: detailed Meta totals sum an omitted delivered day as 0 and keep the qualifier on the entity', async () => {
  const f = overviewGranularityFixture();
  try {
    f.mutate(dropSecondDayActions('100'));
    const report = await run(f, granularConfig(granularSource('meta', 'ad')));
    assert.equal(report.rows.length, 1);
    const [row] = report.rows;
    assert.equal(row.metrics.conversions, 2, 'before RPT-04 one omitted day made the entity total unknown');
    assert.equal(row.native.exact_totals.conversions, '2');
    assert.deepEqual(row.omitted_as_zero, ['conversions', 'conversion_value']);
    assert.equal(report.summary[0].omitted_as_zero.conversions, 1);
  } finally {
    f.close();
  }
});

test('RPT-04: summaries total omitted zeros and the zero-result rule names its provider-omitted basis', () => {
  const meta = (actions, impressions = '500') =>
    normalizeNativeRow('meta', {
      campaign_id: actions ? '1' : '2',
      campaign_name: 'C',
      objective: 'OUTCOME_SALES',
      spend: '40',
      impressions,
      clicks: '20',
      ...(actions ? {actions} : {}),
    });
  const withPurchases = meta([{action_type: 'purchase', value: '3'}]),
    onlyClicks = meta([{action_type: 'link_click', value: '20'}]),
    noActions = meta(undefined),
    undelivered = meta(undefined, '0');
  assert.equal(onlyClicks.metrics.conversions, 0);
  assert.equal(noActions.metrics.conversions, 0);
  assert.equal(undelivered.metrics.conversions, null);
  const rows = [withPurchases, onlyClicks].map(r => ({
    ...r,
    platform: 'meta',
    account_id: '100',
    currency: 'USD',
    timezone: 'UTC',
    date_from: '2026-08-01',
    date_to: '2026-08-07',
    attribution: 'ad set unified attribution setting',
    result_definition: 'purchase',
    complete: true,
    recommendation: {decision: 'observe'},
  }));
  const [summary] = reportSummary(rows);
  assert.equal(summary.metrics.conversions, 3, 'before RPT-04 the account total was unknown');
  assert.ok(Math.abs(summary.metrics.cpa - 80 / 3) < 1e-9);
  assert.deepEqual(summary.omitted_as_zero, {
    conversion_value: 2,
    conversions: 1,
    engagements: 2,
    installs: 2,
    leads: 2,
    purchases: 1,
    video_views: 2,
  });
  const advice = campaignRecommendation(
    {
      ...rows[1],
      source_kind: 'paid',
      captured_at: Date.now(),
      quality: {},
      campaign_key: 'meta:100:2',
    },
    {sales: {target: 5, currency: 'USD', minimum_results: 1, conversion_lag_days: 0}},
  );
  assert.equal(advice.decision, 'reconsider_pause');
  assert.equal(advice.evidence.results_basis, 'provider_omitted');
});

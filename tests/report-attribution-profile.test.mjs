// RPT-04 item 7: campaign-level Meta and Snapchat sources accept an optional attribution profile (the same windows their
// detailed presets use), so campaign and detailed rows of one snapshot reconcile under one attribution. Before RPT-04
// campaign level refused report_options and always used the provider default (Meta unified setting, Snapchat 28-day
// swipe / 1-day view) while detailed rows used the user's windows. Without a profile, campaign reporting is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import {granularConfig, granularSource, overviewGranularityFixture} from './fixtures/overview-granularity-data.mjs';
import {overviewSourceLevel} from '../dist/src/overview-granularity.js';

async function run(f, config) {
  const queued = await f.overview.handle({action: 'run', config, confirmed: true}, f.actor);
  assert.equal(await f.worker.once(), true);
  // Total-grain snapshots can need more than one worker pass.
  for (let i = 0; i < 5 && (await f.worker.once()); i++);
  return f.overview.handle({action: 'get', id: queued.id, limit: 100}, f.actor);
}
const metaCampaign = report_options => {
  const {level, report_options: _detail, ...source} = granularSource('meta', 'campaign');
  return {...source, ...(report_options ? {report_options} : {})};
};
const insights = f =>
  f.requests
    .filter(r => r.url.hostname === 'graph.facebook.com' && r.url.pathname.endsWith('/insights'))
    .map(r => r.url.searchParams);

test('RPT-04 item 7: Meta campaign and ad reports with one profile show identical attribution labels', async () => {
  // A snapshot selects each account once, so the campaign and ad levels of one account are two runs of one profile.
  const f = overviewGranularityFixture();
  try {
    const campaignReport = await run(
      f,
      granularConfig(metaCampaign({attribution_windows: ['7d_click', '1d_view']}), 'daily'),
    );
    const adReport = await run(f, granularConfig(granularSource('meta', 'ad')));
    for (const report of [campaignReport, adReport])
      assert.equal(report.state, 'complete', JSON.stringify(report.sources.map(s => s.error)));
    const label = 'Meta 7d_click + 1d_view; impression time';
    assert.equal(campaignReport.sources[0].attribution, label);
    assert.equal(adReport.sources[0].attribution, label);
    assert.deepEqual(
      [...new Set([...campaignReport.rows, ...adReport.rows].map(r => r.attribution))],
      [label],
      'campaign and ad rows share one attribution',
    );
    const campaign = insights(f).find(q => q.get('level') !== 'ad');
    assert.equal(campaign.get('action_attribution_windows'), '["7d_click","1d_view"]');
    assert.equal(campaign.get('action_report_time'), 'impression');
    assert.equal(campaign.get('use_unified_attribution_setting'), 'false');
    assert.equal(campaign.get('use_account_attribution_setting'), 'false');
  } finally {
    f.close();
  }
});

test('RPT-04 item 7: campaign reporting without a profile keeps the provider default attribution', async () => {
  const f = overviewGranularityFixture();
  try {
    const report = await run(f, granularConfig(metaCampaign(), 'daily'));
    assert.equal(report.state, 'complete');
    assert.equal(report.sources[0].attribution, 'ad set unified attribution setting');
    const [query] = insights(f);
    assert.equal(query.get('use_unified_attribution_setting'), 'true');
    assert.equal(query.get('action_attribution_windows'), null);
  } finally {
    f.close();
  }
});

test('RPT-04 item 7: Snapchat campaign rows use the profile windows with the detailed label', async () => {
  const f = overviewGranularityFixture();
  try {
    const {level, report_options, ...source} = granularSource('snapchat', 'campaign');
    const profile = {swipe_up_attribution_window: '7_DAY', view_attribution_window: '1_DAY'};
    const report = await run(f, granularConfig({...source, report_options: profile}));
    assert.equal(report.state, 'complete', JSON.stringify(report.sources[0].error));
    assert.equal(report.sources[0].attribution, 'Snapchat 7_DAY swipe / 1_DAY view; conversion time; total sources');
    const stats = f.requests.find(r => r.url.hostname.endsWith('snapchat.com') && r.url.pathname.endsWith('/stats'));
    assert.equal(stats.url.searchParams.get('swipe_up_attribution_window'), '7_DAY');
    assert.equal(stats.url.searchParams.get('view_attribution_window'), '1_DAY');
    assert.equal(stats.url.searchParams.get('action_report_time'), 'conversion');
  } finally {
    f.close();
  }
});

test('RPT-04 item 7: campaign-level report options stay limited to a valid Meta or Snapchat attribution profile', () => {
  const refused = (source, pattern) =>
    assert.throws(
      () => overviewSourceLevel(source),
      e => e.code === 'INVALID_REPORT_LEVEL' && pattern.test(e.message),
    );
  // Other platforms keep refusing campaign-level report options.
  refused(
    {platform: 'google', level: 'campaign', report_options: {complete_window: true, attribution: 'x'}},
    /require a supported ad or ad set/,
  );
  // Detailed-only settings (result action, window declaration) are not a campaign profile.
  refused(
    {
      platform: 'meta',
      level: 'campaign',
      report_options: {complete_window: true, result_action_type: 'purchase', attribution_windows: ['7d_click']},
    },
    /only an attribution profile/,
  );
  refused({platform: 'meta', report_options: {attribution_windows: ['1d_click', '7d_click']}}, /one click window/);
  refused(
    {platform: 'snapchat', report_options: {swipe_up_attribution_window: '1_DAY', view_attribution_window: '7_DAY'}},
    /Seven-day view/,
  );
  assert.equal(
    overviewSourceLevel({platform: 'meta', report_options: {attribution_windows: ['1d_view']}}).id,
    'campaign',
  );
});

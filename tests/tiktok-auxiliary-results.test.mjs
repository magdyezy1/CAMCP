import test from 'node:test';
import assert from 'node:assert/strict';
import {tiktokThreeLevelFixture, tiktokLevelOf, tiktokBodyCode} from './helpers/tiktok-three-level.mjs';
import {MirrorError} from '../dist/src/errors.js';
import * as results from '../dist/src/tiktok-report-results.js';

/**
 * F-L5-19: a TikTok campaign has no result of its own; its result comes from an auxiliary BASIC report of its ad
 * groups. When that read fails the campaign keeps its spend with an unknown result, and a warning says so.
 */
const warning = results.tiktokResultsUnavailableWarning;
const adGroupReport = url => url.pathname.endsWith('/report/integrated/get/') && tiktokLevelOf(url) === 'adset';
async function run(t, answer) {
  const f = tiktokThreeLevelFixture();
  t.after(() => f.close());
  f.state.hook = url => (answer && adGroupReport(url) ? answer(url) : undefined);
  const queued = await f.queue();
  await f.turn();
  return {f, queued, report: await f.get(queued.id)};
}
const levelOf = (report, level) => report.sources[0].level_results.find(item => item.level === level);
const campaignRow = report => report.rows.find(row => row.level === 'campaign');

test('control: with the ad group report readable the campaign result adds the same-goal ad groups', async t => {
  const {report} = await run(t);
  assert.equal(report.state, 'complete', JSON.stringify(report.sources));
  const row = campaignRow(report);
  assert.equal(row.metrics.spend, '10');
  assert.equal(row.metrics.primary_result, '80');
  assert.equal(row.metrics.cost_per_result, '0.125');
  assert.equal(levelOf(report, 'campaign').warnings.includes(warning), false);
  assert.equal(typeof warning, 'string');
});

for (const [label, code] of [
  ['an unlisted TikTok return code (PLATFORM_ERROR)', 40002],
  ['a role or asset access denial (PROVIDER_ACCESS_DENIED)', 40001],
])
  test('a refused ad group report keeps the campaign row, its spend and a warning: ' + label, async t => {
    const {report} = await run(t, () => tiktokBodyCode(code));
    // The campaign unit succeeded; only its result is unknown.
    const row = campaignRow(report);
    assert.ok(row, 'the campaign row is kept');
    assert.equal(row.metrics.spend, '10');
    assert.equal(row.metrics.impressions, '800');
    assert.equal(row.metrics.clicks, '160');
    assert.equal(row.result.value, null);
    assert.equal(row.result_context.unavailable_reason, 'missing_metric');
    assert.equal(row.metrics.primary_result, null);
    assert.equal(row.metrics.cost_per_result, null);
    const campaign = levelOf(report, 'campaign');
    assert.equal(campaign.error, undefined);
    assert.equal(campaign.row_count, 1);
    assert.deepEqual(
      campaign.warnings.filter(text => text === warning),
      [warning],
      'said once',
    );
    // The ad group level reads the same report for itself, so it fails on its own; the ad level is untouched.
    assert.equal(levelOf(report, 'adset').row_count, 0);
    assert.ok(levelOf(report, 'adset').error);
    assert.equal(levelOf(report, 'ad').row_count, 40);
    assert.equal(report.state, 'partial');
    assert.equal(report.row_count, 41);
  });

test('a retryable failure of the ad group report still retries the job instead of dropping the result', async t => {
  let faults = 0;
  const {f, queued, report} = await run(t, () => {
    // The transport asks three times for one read; all three meet a provider fault, so the failure reaches the job.
    if (faults++ < 3) return tiktokBodyCode(50000, 'Synthetic provider fault');
  });
  assert.equal(faults >= 3, true);
  assert.equal(report.state, 'running', 'the first turn is not a finished report');
  assert.equal(report.rows.length, 0, 'no campaign row was written without its result');
  assert.deepEqual(
    f.jobs().map(job => [job.state, job.attempts]),
    [['queued', 1]],
  );
  await f.turn();
  const retried = await f.get(queued.id);
  assert.equal(retried.state, 'complete', JSON.stringify(retried.sources));
  assert.equal(campaignRow(retried).metrics.primary_result, '80');
  assert.equal(levelOf(retried, 'campaign').warnings.includes(warning), false);
});

test('an expired login is not an unknown result: it still fails the campaign unit', async t => {
  const {report} = await run(t, () => tiktokBodyCode(40101, 'Synthetic expired token'));
  assert.equal(campaignRow(report), undefined);
  assert.equal(levelOf(report, 'campaign').error.code, 'AUTH_EXPIRED');
});

// The same decision at the collector, for every kind of failure it can be handed.
function collection(failure) {
  const calls = [];
  return {
    calls,
    c: {
      account: '500',
      lookup: {},
      currency: 'SAR',
      range: {since: '2026-10-01', until: '2026-10-07'},
      attribution: 'Synthetic window',
      raw: [{dimensions: {campaign_id: '123'}, metrics: {result: '-', spend: '30'}}],
      complete: true,
      collectionComplete: true,
      warnings: [],
      plan: (path, query) => ({path, query}),
      run: async plan => {
        calls.push(plan);
        throw failure;
      },
    },
  };
}
const metadata = {1: {campaign_id: '123', optimization_goal: 'CONVERT', optimization_event: 'COMPLETE_PAYMENT'}};
const failing = (code, {status = 502, retryable = false, details = {}} = {}) =>
  new MirrorError(code, 'Synthetic ' + code, details, status, retryable);

test('only a non-retryable failure of the TikTok read itself leaves the result unknown', async () => {
  for (const failure of [
    failing('PLATFORM_ERROR', {details: {http_status: 200, provider_code: 40002}}),
    failing('PROVIDER_ACCESS_DENIED', {details: {layer: 'role_or_asset_access'}}),
    failing('PROVIDER_REPORT_FAILED'),
    failing('UPSTREAM_ERROR', {status: 400}),
    failing('UPSTREAM_ERROR', {status: 404}),
    failing('INCOMPLETE_REPORT', {status: 400}),
  ]) {
    const {c, calls} = collection(failure);
    await results.collectTikTokCampaignResults(c, metadata);
    assert.equal(calls.length, 1, 'one read, no retry of a failed read');
    assert.deepEqual(c.raw[0].amcp_result_groups, [], failure.code);
    assert.deepEqual(c.warnings, [warning], failure.code);
    assert.equal(c.complete, true, 'the campaign report itself was complete');
    assert.equal(c.collectionComplete, true);
  }
  // A retry, AMCP's own limits and refusals, a changed login, a lost connection and a cancellation all end the unit.
  for (const failure of [
    failing('UPSTREAM_ERROR', {status: 503, retryable: true}),
    failing('PLATFORM_ERROR', {retryable: true}),
    failing('PLATFORM_RATE_LIMIT', {status: 429, retryable: true, details: {layer: 'rate_limit'}}),
    failing('REPORT_COLLECTION_LIMIT', {status: 422}),
    failing('REPORT_COLLECTION_YIELD', {status: 503, retryable: true}),
    failing('REPORT_BUDGET_INVALID', {status: 400}),
    failing('REPORT_SHAPE_CHANGED'),
    failing('AUTH_EXPIRED', {status: 401, details: {layer: 'credential'}}),
    failing('CONNECTION_REQUIRED', {status: 400}),
    failing('CONNECTION_AUTHORITY_CHANGED', {status: 409}),
    failing('FORBIDDEN', {status: 403}),
    failing('MEMBERSHIP_REVOKED', {status: 403}),
    failing('ACCOUNT_ACCESS_REVOKED', {status: 403}),
    failing('JOB_CANCELLED', {status: 409}),
    failing('STALE_JOB_LEASE', {status: 409}),
    new Error('not a MirrorError'),
  ]) {
    const {c} = collection(failure);
    await assert.rejects(
      results.collectTikTokCampaignResults(c, metadata),
      error => error === failure,
      failure.code ?? failure.message,
    );
    assert.deepEqual(c.warnings, [], 'nothing is said for a failure that ends the unit');
    assert.equal(c.raw[0].amcp_result_groups, undefined);
  }
});

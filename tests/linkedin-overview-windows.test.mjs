import test from 'node:test';
import assert from 'node:assert/strict';
import {linkedinConnection, linkedinPipeline} from './helpers/linkedin-pipeline.mjs';
import {linkedinConversionRule} from './fixtures/linkedin-conversion-rules-docs.mjs';

// V2-RPT-04 (plan 4.7): a v4 Overview source of LinkedIn website conversions takes its attribution windows from the
// account's conversion rules. Every case runs the real queue, worker and LinkedIn collector over a synthetic LinkedIn
// that answers from the documented shapes of its reporting, account-structure and conversion-rule references.
const owner = 'urn:li:sponsoredAccount:100',
  groupUrn = 'urn:li:sponsoredCampaignGroup:20',
  campaignUrn = 'urn:li:sponsoredCampaign:30',
  creativeUrn = 'urn:li:sponsoredCreative:40',
  delivered = {impressions: '1000', clicks: '100', costInLocalCurrency: '50', externalWebsiteConversions: '7'},
  source = level => ({
    platform: 'linkedin',
    account_id: '100',
    connection_id: linkedinConnection,
    levels: [level],
    delivered_only: false,
    report_options: {complete_window: true, attribution: 'unknown'},
  }),
  v4 = {contract_version: 'overview-config-v4', metrics: ['spend', 'clicks', 'primary_result', 'cost_per_result']},
  verifiedPair = (click, view) =>
    'LinkedIn conversion rules: ' + click + '-day post-click / ' + view + '-day post-view (verified per rule)',
  unverifiedWarning = /attribution windows are not independently verified/;
const urnOf = {CAMPAIGN_GROUP: groupUrn, CAMPAIGN: campaignUrn, CREATIVE: creativeUrn};
const world = (objectiveType = 'WEBSITE_CONVERSION') => ({
  groups: {20: {id: 20, account: owner, name: 'Group One', status: 'ACTIVE'}},
  campaigns: {
    30: {
      id: 30,
      account: owner,
      campaignGroup: groupUrn,
      name: 'Campaign 30',
      objectiveType,
      status: 'ACTIVE',
      type: 'SPONSORED_UPDATES',
    },
  },
  creatives: {40: {id: creativeUrn, account: owner, campaign: campaignUrn, name: 'Creative 40'}},
});
// The creative level reads only the current and five previous months of the real clock; the report dates are September.
const fixClock = t => {
  t.mock.timers.reset();
  t.mock.timers.enable({apis: ['Date'], now: Date.UTC(2026, 10, 6)});
};
const analytics = pivot => [{pivotValues: [urnOf[pivot]], ...delivered}];
async function run(t, level, {conversions = [], changes = {}, ...options} = {}) {
  fixClock(t);
  const f = linkedinPipeline(t, {analytics, ...world(), conversions, ...options});
  const report = await f.run({...v4, sources: [source(level)], ...changes});
  return {f, report, source: report.sources[0], row: report.rows[0]};
}
// The conversion rules requests, and the snapshot as stored (whose rows keep the attribution `get` leaves to the source).
const rulesRead = f => f.requests.filter(p => p.path === '/rest/conversions');
const stored = (f, report) => f.store.document(f.actor.tenantId, 'overview_report', report.id);

// The campaign and creative positions read their own native rows, so they take the pair as the campaign-group position does,
// in place of the attribution a detailed source otherwise declares in its report options.
for (const level of ['adset', 'ad'])
  test('a v4 ' + level + ' source of website conversions carries the pair, not its declared attribution', async t => {
    const {
      f,
      report,
      source: s,
    } = await run(t, level, {
      conversions: [linkedinConversionRule('501', 7, 1)],
      changes: {
        sources: [{...source(level), report_options: {complete_window: true, attribution: 'declared by the owner'}}],
      },
    });
    assert.equal(report.state, 'complete', JSON.stringify(report.sources.map(x => x.warnings)));
    assert.equal(s.attribution, verifiedPair(7, 1));
    assert.equal(stored(f, report).rows[0].attribution, verifiedPair(7, 1));
    assert.equal(report.summary[0].attribution, verifiedPair(7, 1));
    assert.equal(
      s.warnings.some(w => unverifiedWarning.test(w)),
      false,
      JSON.stringify(s.warnings),
    );
    assert.equal(s.level_results[0].conversion_windows.status, 'verified_per_rule');
    assert.equal(rulesRead(f).length, 1);
  });

test('a v4 campaign-group source of website conversions takes the one window pair its account’s rules share', async t => {
  const {
    f,
    report,
    source: s,
    row,
  } = await run(t, 'campaign', {
    conversions: [linkedinConversionRule('501', 30, 7), linkedinConversionRule('502', 30, 7)],
  });
  assert.equal(report.state, 'complete', JSON.stringify(report.sources.map(x => x.warnings)));
  assert.equal(row.objective.native, 'WEBSITE_CONVERSION');
  // The pair, in words, on the source, the stored row and the summary every consumer reads.
  assert.equal(s.attribution, verifiedPair(30, 7));
  assert.equal(stored(f, report).rows[0].attribution, verifiedPair(30, 7));
  assert.equal(report.summary[0].attribution, verifiedPair(30, 7));
  // The old "not independently verified" line goes; what stays true is said on its own.
  assert.equal(
    s.warnings.some(w => unverifiedWarning.test(w)),
    false,
    JSON.stringify(s.warnings),
  );
  assert.ok(
    s.warnings.includes(
      'LinkedIn attribution windows come from the account’s own conversion rules. AMCP does not read which campaigns a rule counts for, so every rule of the account is used, and rule settings are current, not the settings at delivery time.',
    ),
  );
  assert.ok(
    s.warnings.includes('LinkedIn entity names and objectives are current metadata, not the values at delivery time.'),
  );
  // What was read, how, and after the analytics response: the account, the rules (one page), the account again.
  assert.equal(rulesRead(f).length, 1);
  assert.deepEqual(f.requests.map(p => p.path).slice(-3), [
    '/rest/adAccounts/100',
    '/rest/conversions',
    '/rest/adAccounts/100',
  ]);
  assert.equal(
    f.requests.findIndex(p => p.path === '/rest/conversions') >
      f.requests.findLastIndex(p => p.path === '/rest/adAnalytics'),
    true,
    'the rules are read after the analytics response',
  );
  assert.deepEqual(rulesRead(f)[0].query, {q: 'account', account: owner, start: 0, count: 100});
  const windows = s.level_results[0].conversion_windows;
  assert.deepEqual(
    [windows.status, windows.basis, windows.rule_count, windows.reason],
    ['verified_per_rule', 'account_rules', 2, null],
  );
  assert.deepEqual(windows.single_window, {post_click_days: 30, post_view_days: 7});
  assert.deepEqual(windows.distinct_windows, ['30d click / 7d view']);
  const lineage = (await f.overview.handle({action: 'get', id: report.id, include: {lineage: true}}, f.actor))
    .sources[0].lineage;
  assert.deepEqual(
    lineage.map(l => l.stage).slice(-3),
    ['conversion_rules_account', 'conversion_rules', 'conversion_rules_account_verify'],
    'the rules read is part of the source’s lineage, request by request',
  );
  assert.ok(lineage.slice(-3).every(l => l.method === 'GET' && l.api_version === '202609' && l.query_fingerprint));
});

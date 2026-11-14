import {linkedinConnection, linkedinPipeline} from './linkedin-pipeline.mjs';

// The synthetic LinkedIn account of the Overview attribution-window tests (V2-RPT-04): a campaign group, a campaign and a
// creative, and a v4 report of one of its levels run through the real queue, worker and LinkedIn collector.
export const owner = 'urn:li:sponsoredAccount:100',
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
  /**
   * The attribution the join gives one pair, in the words of the guided preset's join but for what it claims: the source's
   * analytics are not split by conversion, so it names the account's own rules it read, never a verification per rule.
   */
  accountRulesPair = (click, view) =>
    'LinkedIn conversion rules: ' + click + '-day post-click / ' + view + '-day post-view (per account rules)';
/** What a joined source says it read: the rules the account owns, never a rule shared from or owned by another account. */
export const accountRulesNote =
  'LinkedIn attribution windows come from the conversion rules this account owns. AMCP does not read which campaigns a rule counts for, so every owned rule is used. A rule shared from or owned by another account is not read, so a campaign may count a rule whose windows are not shown here. Rule settings are current, not the settings at delivery time.';
export const urnOf = {CAMPAIGN_GROUP: groupUrn, CAMPAIGN: campaignUrn, CREATIVE: creativeUrn};
export const world = (objectiveType = 'WEBSITE_CONVERSION') => ({
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
export const fixClock = t => {
  t.mock.timers.reset();
  t.mock.timers.enable({apis: ['Date'], now: Date.UTC(2026, 10, 6)});
};
export const analytics = pivot => [{pivotValues: [urnOf[pivot]], ...delivered}];
/** One v4 report of `level`, its pipeline, its source and its first row (`options` are the pipeline's). */
export async function run(t, level, {conversions = [], changes = {}, ...options} = {}) {
  fixClock(t);
  const f = linkedinPipeline(t, {analytics, ...world(), conversions, ...options});
  const report = await f.run({...v4, sources: [source(level)], ...changes});
  return {f, report, source: report.sources[0], row: report.rows[0]};
}
// The conversion rules requests, and the snapshot as stored (whose rows keep the attribution `get` leaves to the source).
export const rulesRead = f => f.requests.filter(p => p.path === '/rest/conversions');
export const stored = (f, report) => f.store.document(f.actor.tenantId, 'overview_report', report.id);

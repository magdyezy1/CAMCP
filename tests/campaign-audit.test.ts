import test from 'node:test';
import assert from 'node:assert/strict';
import {auditCampaign, optimizationSuggestions, type CampaignAuditInput} from '../src/campaign-audit.js';
const base = (): CampaignAuditInput => ({
  platform: 'google',
  account_id: '100',
  campaign_id: '200',
  campaign: {
    campaign: {
      id: '200',
      status: 'ENABLED',
      startDate: '20260901',
      endDate: '20260930',
      biddingStrategyType: 'MAXIMIZE_CONVERSIONS',
    },
    campaignBudget: {amountMicros: '10000000'},
    customer: {currencyCode: 'USD'},
  },
  as_of: '2026-09-06',
  report: {
    normalized: true,
    platform: 'google',
    account_id: '100',
    level: 'campaign',
    granularity: 'day',
    date_range: {since: '2026-09-01', until: '2026-09-04'},
    rows: [1, 2, 3, 4].map(day => ({
      platform: 'google',
      account_id: '100',
      entity_id: '200',
      date: `2026-09-0${day}`,
      currency: 'USD',
      impressions: 100,
      clicks: 10,
      spend: 10,
      conversions: 2,
      conversion_value: 40,
      frequency: 2,
    })),
  },
});
test('audit scores only evaluated rules, preserves explicit unknowns and mutates no input', () => {
  const input = base(),
    before = structuredClone(input),
    result = auditCampaign(input);
  assert.deepEqual(input, before);
  assert.equal(result.score, 100);
  assert.equal(result.score_kind, 'evaluated_rule_checks');
  assert.deepEqual(result.coverage, {requested_checks: 3, evaluated_checks: 2, unknown_checks: 1, complete: false});
  assert.equal(result.findings.find(f => f.check === 'targeting')!.status, 'unknown');
  assert.equal(result.observed_metrics.spend, 40);
  assert.match(result.score_method, /not that campaign health is fully verified/);
  assert.equal(result.automated_changes, false);
});
test('frequency thresholds are strict and rows are never averaged into period frequency', () => {
  for (const [frequency, status] of [
    [3.5, 'pass'],
    [3.5001, 'warning'],
    [6, 'warning'],
    [6.01, 'critical'],
  ] as const) {
    const input = base();
    input.checks = ['creative_fatigue'];
    input.report!.rows[0].frequency = frequency;
    const result = auditCampaign(input);
    assert.equal(result.findings[0]!.status, status);
    assert.equal(result.findings[0]!.evidence[0]!.pointer, '/rows/0/frequency');
  }
  const input = base();
  input.checks = ['creative_fatigue'];
  delete input.report!.rows[0].frequency;
  const result = auditCampaign(input);
  assert.equal(result.score, null);
  assert.match(result.unknowns[0]!, /1 of 4/);
});
test('USD daily minimum checks native micros and never compares non-USD or conflicting currencies', () => {
  const input = base();
  input.checks = ['budget'];
  input.campaign.campaignBudget.amountMicros = '4999999';
  assert.equal(auditCampaign(input).findings[0]!.status, 'warning');
  input.campaign.campaignBudget.amountMicros = '5000000';
  assert.equal(auditCampaign(input).findings[0]!.status, 'pass');
  input.campaign.customer.currencyCode = 'SAR';
  input.report!.rows.forEach((row: any) => (row.currency = 'SAR'));
  let result = auditCampaign(input);
  assert.equal(result.score, null);
  assert.equal(result.observed_metrics.currency, 'SAR');
  assert.equal(result.observed_metrics.spend, 40);
  input.report!.rows[0].currency = 'USD';
  result = auditCampaign(input);
  assert.equal(result.observed_metrics.spend, null);
  assert.equal(result.observed_metrics.currency, null);
  assert.match(result.warnings.join(' '), /Conflicting/);
});
test('zero, absent and malformed metrics remain distinct with no NaN or infinity', () => {
  const input = base();
  input.checks = ['budget'];
  input.campaign.campaignBudget.amountMicros = '0';
  input.report!.rows.forEach((row: any) => {
    row.conversions = 0;
    row.clicks = 0;
    row.impressions = 0;
  });
  const result = optimizationSuggestions(input);
  assert.equal(result.audit.findings[0].status, 'warning');
  assert.equal(result.trend.changes.ctr.later, null);
  assert.equal(result.trend.changes.cpa.later, null);
  assert.ok(result.suggestions.some((s: any) => s.id === 'zero_reported_conversions'));
  assert.ok(!JSON.stringify(result).includes('Infinity'));
  input.report!.rows[0].conversions = null;
  assert.equal(auditCampaign(input).observed_metrics.conversions, null);
  assert.ok(!optimizationSuggestions(input).suggestions.some((s: any) => s.id === 'zero_reported_conversions'));
  input.report!.rows[0].clicks = true;
  assert.equal(auditCampaign(input).observed_metrics.clicks, null);
  input.campaign.campaignBudget.amountMicros = 'bad';
  assert.equal(auditCampaign(input).score, null);
});
test('schedule validates actual calendar dates, timestamps and explicit observation date', () => {
  const input = base();
  input.checks = ['schedule'];
  assert.equal(auditCampaign(input).score, 100);
  input.campaign.campaign.endDate = '20260902';
  assert.equal(auditCampaign(input).findings[0]!.status, 'warning');
  input.campaign.campaign.startDate = '20260903';
  assert.equal(auditCampaign(input).findings[0]!.status, 'critical');
  input.campaign.campaign.endDate = '20260230';
  assert.equal(auditCampaign(input).score, null);
  input.campaign = {runSchedule: {start: Date.parse('2026-09-01T00:00:00Z'), end: Date.parse('2026-09-30T00:00:00Z')}};
  assert.equal(auditCampaign(input).score, 100);
  input.campaign = {start_time: '2026-09-01T00:00:00', end_time: '2026-09-30T00:00:00Z'};
  assert.equal(auditCampaign(input).score, null);
  input.as_of = '2026-02-30';
  assert.throws(() => auditCampaign(input), /valid YYYY-MM-DD/);
});
test('audit rejects wrong scope, grain, truncated reports, mismatched dates and duplicate unknown checks', () => {
  for (const change of [
    (i: CampaignAuditInput) => (i.report!.rows[0].entity_id = '300'),
    (i: CampaignAuditInput) => (i.report!.account_id = '999'),
    (i: CampaignAuditInput) => (i.report!.level = 'adset'),
    (i: CampaignAuditInput) => (i.report!.native_meta = {truncated: true}),
    (i: CampaignAuditInput) => (i.report!.rows[0].date = '2026-02-30'),
    (i: CampaignAuditInput) => (i.date_range = {since: '2026-09-01', until: '2026-09-03'}),
  ]) {
    const input = base();
    change(input);
    assert.throws(() => auditCampaign(input));
  }
  const input = base();
  input.checks = ['budget', 'budget'];
  assert.equal(auditCampaign(input).coverage.requested_checks, 1);
  input.checks = ['not_real' as any];
  assert.throws(() => auditCampaign(input), /Unknown/);
});
test('empty reports and absent configuration cannot receive a healthy score', () => {
  const input = base();
  input.campaign = {};
  input.report!.rows = [];
  const result = auditCampaign(input);
  assert.equal(result.score, null);
  assert.equal(result.coverage.evaluated_checks, 0);
  assert.equal(result.observed_metrics.spend, null);
  assert.equal(result.observed_metrics.conversions, null);
  input.checks = [];
  assert.equal(auditCampaign(input).score, null);
});
test('optimization reports supported observations without claiming AI or automatic writes', () => {
  const input = base();
  input.report!.rows[2].spend = 20;
  input.report!.rows[3].spend = 20;
  input.report!.rows[2].conversions = 1;
  input.report!.rows[3].conversions = 1;
  const result = optimizationSuggestions(input);
  assert.equal(result.trend.changes.cpa.earlier, 5);
  assert.equal(result.trend.changes.cpa.later, 20);
  assert.equal(result.trend.changes.cpa.change_pct, 300);
  assert.ok(result.suggestions.some((s: any) => s.id === 'declining_efficiency'));
  assert.equal(result.ai_generated, false);
  assert.equal(result.automated_changes, false);
  assert.equal(result.budget_reallocation.available, false);
  assert.equal(result.method, 'deterministic_evidence_rules');
});
test('daily trends require all explicitly returned days and do not manufacture a zero baseline', () => {
  const input = base();
  input.report!.rows.pop();
  assert.equal(optimizationSuggestions(input).trend.available, false);
  input.report!.rows.push(structuredClone(input.report!.rows[0]));
  assert.equal(optimizationSuggestions(input).trend.available, false);
  const zeros = base();
  zeros.report!.rows[0].conversions = 0;
  zeros.report!.rows[1].conversions = 0;
  const result = optimizationSuggestions(zeros);
  assert.equal(result.trend.changes.conversions_per_day.earlier, 0);
  assert.equal(result.trend.changes.conversions_per_day.change_pct, null);
  assert.equal(result.trend.changes.cpa.earlier, null);
});
test('budget suppression and bid configuration limits remain explicit', () => {
  const input = base();
  input.checks = ['budget', 'bid_strategy'];
  input.campaign.campaignBudget.amountMicros = '1000000';
  const result = optimizationSuggestions(input, {budget_reallocation: false});
  assert.equal(result.budget_reallocation.requested, false);
  assert.ok(!result.suggestions.some((s: any) => s.id === 'budget'));
  assert.equal(result.audit.findings[1].status, 'pass');
  assert.match(result.audit.findings[1].explanation, /configuration presence only/);
  input.campaign.campaign.biddingStrategyType = 'UNSPECIFIED';
  assert.equal(auditCampaign(input).findings[1]!.status, 'warning');
});
test('overlapping reporting grains never double count metrics and invalid rows fail explicitly', () => {
  const input = base();
  input.report!.rows[1].date = input.report!.rows[0].date;
  const result = auditCampaign(input);
  assert.equal(result.observed_metrics.aggregation_safe, false);
  assert.equal(result.observed_metrics.spend, null);
  assert.equal(result.observed_metrics.conversions, null);
  input.report!.rows = [null];
  assert.throws(
    () => auditCampaign(input),
    (error: any) => error.code === 'AUDIT_REPORT_REQUIRED',
  );
  input.report!.rows = [];
  input.campaign.campaign.id = '999';
  assert.throws(
    () => auditCampaign(input),
    (error: any) => error.code === 'AUDIT_CAMPAIGN_SCOPE_MISMATCH',
  );
});
test('derived ratios that exceed finite precision return unknown instead of Infinity', () => {
  const input = base();
  input.report!.rows.forEach((row: any) => (row.conversions = 1e-310));
  const result = optimizationSuggestions(input);
  assert.equal(result.trend.changes.cpa.earlier, null);
  assert.equal(result.trend.changes.cpa.later, null);
});

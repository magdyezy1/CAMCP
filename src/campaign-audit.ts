import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';

export type CampaignAuditCheck = 'budget' | 'targeting' | 'creative_fatigue' | 'schedule' | 'bid_strategy';
export interface CampaignAuditInput {
  platform: string;
  account_id: string;
  campaign_id: string;
  /** One native campaign row, retaining joined customer/campaign-budget data if present. */
  campaign: JsonObject;
  /** Complete, normalized campaign-level report, filtered to this campaign. */
  report?: JsonObject;
  checks?: CampaignAuditCheck[];
  date_range?: {since: string; until: string};
  /** Explicit observation date; no wall clock is consulted by these pure functions. */
  as_of?: string;
}
export interface AuditEvidence {
  source: 'campaign' | 'report';
  pointer: string;
  value: unknown;
}
export interface AuditFinding {
  check: CampaignAuditCheck;
  status: 'pass' | 'warning' | 'critical' | 'unknown';
  title: string;
  explanation: string;
  recommendation: string | null;
  evidence: AuditEvidence[];
  unknowns: string[];
}
export interface CampaignAuditResult {
  platform: string;
  account_id: string;
  campaign_id: string;
  evidence: 'INDEPENDENT_DESIGN';
  date_range: {since: string; until: string} | null;
  as_of: string | null;
  score: number | null;
  score_kind: 'evaluated_rule_checks';
  score_method: string;
  coverage: {requested_checks: number; evaluated_checks: number; unknown_checks: number; complete: boolean};
  findings: AuditFinding[];
  unknowns: string[];
  observed_metrics: JsonObject;
  warnings: string[];
  automated_changes: false;
}
const checks: CampaignAuditCheck[] = ['budget', 'targeting', 'creative_fatigue', 'schedule', 'bid_strategy'];
const defaults: CampaignAuditCheck[] = ['budget', 'targeting', 'creative_fatigue'];
const record = (v: unknown): JsonObject =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {};
const finite = (v: unknown): number | null => {
  if ((typeof v !== 'number' && typeof v !== 'string') || (typeof v === 'string' && !/^\d+(?:\.\d+)?$/.test(v.trim())))
    return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && (!Number.isInteger(n) || Number.isSafeInteger(n)) ? n : null;
};
function divide(n: unknown, d: unknown, multiple = 1): number | null {
  if (typeof n !== 'number' || typeof d !== 'number' || !Number.isFinite(n) || !Number.isFinite(d) || d <= 0)
    return null;
  const value = (n / d) * multiple;
  return Number.isFinite(value) ? value : null;
}
function date(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === value ? value : null;
}
function nativeDate(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8640000000000000)
    return date(new Date(value).toISOString().slice(0, 10));
  if (typeof value === 'string') {
    if (/^\d{8}$/.test(value)) return date(value.slice(0, 4) + '-' + value.slice(4, 6) + '-' + value.slice(6));
    if (date(value)) return value;
    if (
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
      date(value.slice(0, 10)) &&
      Number.isFinite(Date.parse(value))
    )
      return new Date(value).toISOString().slice(0, 10);
  }
  const v = record(value);
  return Number.isInteger(v.year) && Number.isInteger(v.month) && Number.isInteger(v.day)
    ? date(`${v.year}-${String(v.month).padStart(2, '0')}-${String(v.day).padStart(2, '0')}`)
    : null;
}
function at(root: JsonObject, path: string): unknown {
  return path
    .split('/')
    .filter(Boolean)
    .reduce((v: any, k) => v?.[k], root);
}
function pick(
  root: JsonObject,
  paths: string[],
  source: AuditEvidence['source'] = 'campaign',
): AuditEvidence | undefined {
  for (const pointer of paths) {
    const value = at(root, pointer);
    if (value !== undefined && value !== null) return {source, pointer, value};
  }
  return undefined;
}
const evidence = (source: AuditEvidence['source'], pointer: string, value: unknown): AuditEvidence => ({
  source,
  pointer,
  value,
});
function finding(
  check: CampaignAuditCheck,
  status: AuditFinding['status'],
  title: string,
  explanation: string,
  items: AuditEvidence[] = [],
  recommendation: string | null = null,
  unknowns: string[] = [],
): AuditFinding {
  return {check, status, title, explanation, recommendation, evidence: items, unknowns};
}
const identity = (v: unknown) => String(v).split(/[/:]/).at(-1);
function range(input: CampaignAuditInput): {since: string; until: string} | null {
  const r = input.date_range ?? input.report?.date_range;
  if (r === undefined) return null;
  if (
    !r ||
    !date(r.since) ||
    !date(r.until) ||
    r.since > r.until ||
    Date.parse(r.until) - Date.parse(r.since) > 3660 * 86400000
  )
    throw new MirrorError(
      'INVALID_DATE_RANGE',
      'Audit dates must be ordered calendar dates in YYYY-MM-DD format spanning at most ten years.',
    );
  if (
    input.date_range &&
    input.report?.date_range &&
    (input.date_range.since !== input.report.date_range.since ||
      input.date_range.until !== input.report.date_range.until)
  )
    throw new MirrorError('AUDIT_REPORT_RANGE_MISMATCH', 'The audit and report date ranges differ.');
  return {since: r.since, until: r.until};
}
function reportRows(input: CampaignAuditInput, period: {since: string; until: string} | null): JsonObject[] {
  const report = input.report;
  if (report === undefined) return [];
  if (report.normalized !== true || !Array.isArray(report.rows))
    throw new MirrorError(
      'AUDIT_REPORT_REQUIRED',
      'Audit metrics require a normalized report with an explicit rows array.',
    );
  if (report.truncated === true || report.native_meta?.truncated === true)
    throw new MirrorError(
      'INCOMPLETE_AUDIT_REPORT',
      'Complete the report pagination before auditing campaign metrics.',
    );
  if (report.level && report.level !== 'campaign')
    throw new MirrorError(
      'AUDIT_REPORT_GRAIN',
      'Audit requires campaign-level rows, not overlapping child-entity metrics.',
    );
  const platform = (v: unknown) =>
    String(v)
      .toLowerCase()
      .replace(/^google_ads$/, 'google')
      .replace(/^twitter$/, 'x');
  for (const value of [report, ...report.rows]) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new MirrorError('AUDIT_REPORT_REQUIRED', 'Each normalized report row must be an object.');
    if (
      (value.account_id !== undefined && String(value.account_id) !== input.account_id) ||
      (value.platform !== undefined && platform(value.platform) !== platform(input.platform))
    )
      throw new MirrorError(
        'AUDIT_REPORT_SCOPE_MISMATCH',
        'Report platform and account must match the audited campaign.',
      );
  }
  for (const row of report.rows) {
    if (!row || typeof row !== 'object' || !row.entity_id || identity(row.entity_id) !== identity(input.campaign_id))
      throw new MirrorError('AUDIT_REPORT_SCOPE_MISMATCH', 'Each report row must identify the audited campaign.');
    if (
      row.date !== null &&
      row.date !== undefined &&
      (!date(row.date) || (period && (row.date < period.since || row.date > period.until)))
    )
      throw new MirrorError('AUDIT_REPORT_DATE_MISMATCH', 'Report rows contain an invalid or out-of-range date.');
  }
  return report.rows;
}
function currency(
  input: CampaignAuditInput,
  rows: JsonObject[],
): {value: string | null; items: AuditEvidence[]; conflict: boolean} {
  const items: AuditEvidence[] = [];
  const source = pick(input.campaign, [
    '/customer/currencyCode',
    '/customer/currency_code',
    '/currencyCode',
    '/currency_code',
    '/currency',
    '/dailyBudget/currencyCode',
    '/campaign/dailyBudget/currencyCode',
  ]);
  if (source) items.push(source);
  rows.forEach((row, i) => {
    if (row.currency !== null && row.currency !== undefined)
      items.push(evidence('report', `/rows/${i}/currency`, row.currency));
  });
  const values = new Set(
    items.map(item => (typeof item.value === 'string' && /^[A-Z]{3}$/.test(item.value) ? item.value : null)),
  );
  return {
    value: values.size === 1 && !values.has(null) ? [...values][0]! : null,
    items,
    conflict: values.size > 1 || values.has(null),
  };
}
function totals(rows: JsonObject[], curr: string | null): JsonObject {
  const result: JsonObject = {row_count: rows.length, currency: curr};
  for (const key of ['impressions', 'clicks', 'spend', 'conversions', 'conversion_value']) {
    const values = rows.map(row => finite(row[key]));
    const sum = values.length && values.every(v => v !== null) ? values.reduce<number>((n, v) => n + v!, 0) : null;
    result[key] =
      sum !== null &&
      Number.isFinite(sum) &&
      (!Number.isInteger(sum) || Number.isSafeInteger(sum)) &&
      (!['spend', 'conversion_value'].includes(key) || curr !== null)
        ? sum
        : null;
  }
  return result;
}
function aggregationSafe(input: CampaignAuditInput, rows: JsonObject[]): boolean {
  if (rows.length < 2) return true;
  const grain = input.report?.granularity;
  if (!['day', 'month'].includes(grain) || rows.some(row => !date(row.date))) return false;
  return new Set(rows.map(row => (grain === 'month' ? row.date.slice(0, 7) : row.date))).size === rows.length;
}
function budget(input: CampaignAuditInput, rows: JsonObject[]): AuditFinding {
  const money = currency(input, rows),
    item = pick(input.campaign, [
      '/campaignBudget/amountMicros',
      '/campaign_budget/amount_micros',
      '/campaignBudget/amount_micros',
      '/campaign_budget/amountMicros',
      '/daily_budget_amount_local_micro',
      '/campaign/daily_budget_amount_local_micro',
      '/dailyBudget/amount',
      '/campaign/dailyBudget/amount',
      '/daily_budget',
      '/campaign/daily_budget',
    ]);
  if (!item)
    return finding(
      'budget',
      'unknown',
      'Daily budget was not returned',
      'A budget resource reference or lifetime budget is not evidence of a daily spending limit.',
      [],
      'Read the campaign daily budget and its account currency before assessing the USD 5/day rule.',
      ['Daily budget amount unavailable.'],
    );
  let amount = finite(item.value);
  if (amount !== null) {
    if (/micros|_micro$/i.test(item.pointer)) amount /= 1e6;
    else if (['meta', 'snapchat'].includes(input.platform) && /daily_budget$/.test(item.pointer))
      amount /= input.platform === 'meta' ? 100 : 1e6;
  }
  if (amount === null)
    return finding(
      'budget',
      'unknown',
      'Daily budget value is invalid',
      'The returned budget cannot be interpreted as a finite, nonnegative amount.',
      [item],
      'Verify the native budget amount and units.',
      ['Budget amount invalid.'],
    );
  if (money.conflict || money.value !== 'USD')
    return finding(
      'budget',
      'unknown',
      'The USD minimum cannot be evaluated',
      money.conflict
        ? 'Returned currency values conflict or are invalid.'
        : `The captured rule is USD 5/day; ${money.value ?? 'an unknown currency'} cannot be compared without an explicit exchange rate.`,
      [item, ...money.items],
      'Verify the account currency and use an approved currency-specific budget threshold.',
      ['No currency conversion or non-USD benchmark was supplied.'],
    );
  return finding(
    'budget',
    amount < 5 ? 'warning' : 'pass',
    amount < 5 ? 'Daily budget is below USD 5' : 'Daily budget meets the USD 5 minimum',
    `The current daily budget is USD ${amount}. This checks the captured minimum only; it does not establish budget efficiency or historical utilization.`,
    [item, ...money.items],
    amount < 5
      ? 'Review the current budget against the campaign objective and an approved spending plan before changing it.'
      : null,
    ['Historical budget changes and planned utilization were not supplied.'],
  );
}
function fatigue(input: CampaignAuditInput, rows: JsonObject[]): AuditFinding {
  const found: AuditEvidence[] = [];
  let invalid = 0;
  rows.forEach((row, i) => {
    const item = pick(row, [
      '/frequency',
      '/raw/frequency',
      '/raw/metrics/averageImpressionFrequencyPerUser',
      '/raw/metrics/average_impression_frequency_per_user',
    ]);
    if (!item || finite(item.value) === null) {
      invalid++;
      return;
    }
    found.push(evidence('report', `/rows/${i}${item.pointer}`, item.value));
  });
  if (!found.length)
    return finding(
      'creative_fatigue',
      'unknown',
      'Frequency is unavailable',
      'Frequency is not inferred by summing reach or averaging daily ratios.',
      [],
      'Request native campaign frequency for the intended reporting period.',
      ['Native frequency metric unavailable.'],
    );
  const maximum = Math.max(...found.map(item => finite(item.value)!)),
    status = maximum > 6 ? 'critical' : maximum > 3.5 ? 'warning' : invalid ? 'unknown' : 'pass';
  return finding(
    'creative_fatigue',
    status,
    maximum > 3.5
      ? 'Observed frequency exceeds the captured threshold'
      : invalid
        ? 'Frequency coverage is incomplete'
        : 'Observed frequency is within the captured thresholds',
    `Highest returned row frequency: ${maximum}. Frequency > 3.5 is a warning; > 6 is critical. Each row is assessed at its own ${input.report?.granularity ?? 'reported'} grain; row frequencies are never combined into campaign-period frequency.`,
    found,
    maximum > 3.5
      ? 'Inspect creative-level frequency, reach and dated performance before refreshing assets or changing delivery.'
      : invalid
        ? 'Request frequency for the missing rows.'
        : null,
    invalid ? [`${invalid} of ${rows.length} report rows have no valid frequency.`] : [],
  );
}
function schedule(input: CampaignAuditInput): AuditFinding {
  const start = pick(input.campaign, [
    '/campaign/startDate',
    '/campaign/start_date',
    '/startDate',
    '/start_date',
    '/start_time',
    '/runSchedule/start',
    '/campaignFlight/plannedDates/startDate',
  ]);
  const end = pick(input.campaign, [
    '/campaign/endDate',
    '/campaign/end_date',
    '/endDate',
    '/end_date',
    '/end_time',
    '/runSchedule/end',
    '/campaignFlight/plannedDates/endDate',
  ]);
  const items = [start, end].filter((v): v is AuditEvidence => v !== undefined),
    a = start ? nativeDate(start.value) : null,
    b = end ? nativeDate(end.value) : null;
  if ((start && !a) || (end && !b))
    return finding(
      'schedule',
      'unknown',
      'Schedule values are invalid',
      'The source contains an invalid calendar date or an ambiguous timestamp.',
      items,
      'Correct or retrieve the native schedule with an explicit timezone.',
      ['Schedule cannot be evaluated.'],
    );
  if (!a || !b)
    return finding(
      'schedule',
      'unknown',
      'Schedule bounds are incomplete',
      'Missing dates do not prove that the campaign is intentionally scheduled indefinitely.',
      items,
      'Read the campaign flight and confirm any intentionally open-ended schedule.',
      ['Both native schedule bounds were not returned.'],
    );
  if (a > b)
    return finding(
      'schedule',
      'critical',
      'Campaign end precedes its start',
      `The returned flight is ${a} through ${b}.`,
      items,
      'Correct the campaign schedule before enabling delivery.',
    );
  const state = pick(input.campaign, ['/campaign/status', '/status', '/entity_status', '/entityStatus']);
  if (state) items.push(state);
  if (input.as_of && b < input.as_of && ['ACTIVE', 'ENABLED', 'ENTITY_STATUS_ACTIVE'].includes(String(state?.value)))
    return finding(
      'schedule',
      'warning',
      'An active campaign has an elapsed flight',
      `The campaign end date ${b} is before observation date ${input.as_of}; dates alone do not establish that spend continued.`,
      items,
      'Confirm the intended end date and inspect native delivery status.',
    );
  return finding(
    'schedule',
    'pass',
    'Schedule bounds are ordered',
    `The returned flight is ${a} through ${b}. Timestamp comparisons use UTC calendar dates; hour-level account-timezone scheduling is not evaluated.`,
    items,
    null,
    input.as_of ? [] : ['No observation date supplied; current expiry was not evaluated.'],
  );
}
function bids(input: CampaignAuditInput): AuditFinding {
  const item = pick(input.campaign, [
    '/campaign/biddingStrategyType',
    '/campaign/bidding_strategy_type',
    '/biddingStrategyType',
    '/bidding_strategy_type',
    '/bid_strategy',
    '/biddingStrategy',
    '/bidding_strategy',
    '/optimizationGoal',
  ]);
  if (!item || typeof item.value !== 'string')
    return finding(
      'bid_strategy',
      'unknown',
      'Bid strategy was not returned',
      'Campaign and shared bidding strategy configuration is required for this check.',
      item ? [item] : [],
      'Read the native bid strategy and any shared strategy settings.',
      ['Bid strategy unavailable.'],
    );
  const unspecified = /^(?:UNSPECIFIED|UNKNOWN|NONE|)$/i.test(item.value);
  if (unspecified)
    return finding(
      'bid_strategy',
      'warning',
      'Bid strategy is unspecified',
      'The native response has no concrete bidding strategy value.',
      [item],
      'Verify the intended bidding strategy and conversion tracking before delivery.',
    );
  return finding(
    'bid_strategy',
    'pass',
    'A bid strategy is configured',
    `The native strategy is ${item.value}. This evaluates configuration presence only; suitability and bid amounts need explicit targets and comparison data.`,
    [item],
    null,
    ['No performance target or shared-strategy details were supplied.'],
  );
}
/** Deterministic rules implement documented thresholds, not a calibrated platform health model. */
export function auditCampaign(input: CampaignAuditInput): CampaignAuditResult {
  if (
    !input.platform ||
    !input.account_id ||
    !input.campaign_id ||
    !input.campaign ||
    typeof input.campaign !== 'object' ||
    Array.isArray(input.campaign)
  )
    throw new MirrorError(
      'INVALID_AUDIT_INPUT',
      'Provide platform, account, campaign identifier and one native campaign row.',
    );
  const campaignId = pick(input.campaign, ['/campaign/id', '/id', '/campaignId', '/campaign_id']);
  if (campaignId && identity(campaignId.value) !== identity(input.campaign_id))
    throw new MirrorError(
      'AUDIT_CAMPAIGN_SCOPE_MISMATCH',
      'The native campaign identifier differs from the requested campaign.',
    );
  if (input.as_of !== undefined && !date(input.as_of))
    throw new MirrorError('INVALID_DATE_RANGE', 'Audit observation date must be a valid YYYY-MM-DD calendar date.');
  if (
    input.checks !== undefined &&
    (!Array.isArray(input.checks) || input.checks.some(check => !checks.includes(check)))
  )
    throw new MirrorError('INVALID_AUDIT_CHECK', 'Unknown campaign audit check.');
  const requested = [...new Set(input.checks ?? defaults)],
    period = range(input),
    rows = reportRows(input, period),
    money = currency(input, rows);
  const findings = requested.map(check =>
    check === 'budget'
      ? budget(input, rows)
      : check === 'creative_fatigue'
        ? fatigue(input, rows)
        : check === 'schedule'
          ? schedule(input)
          : check === 'bid_strategy'
            ? bids(input)
            : finding(
                'targeting',
                'unknown',
                'Targeting quality needs additional evidence',
                'Current targeting settings alone cannot establish audience quality, valid reach, exclusions, or historical relevance.',
                [],
                'Read native targeting criteria, exclusions, audience estimates and objective-aligned performance before recommending changes.',
                ['Targeting reach and an explicit quality criterion were not supplied.'],
              ),
  );
  const evaluated = findings.filter(f => f.status !== 'unknown'),
    unknowns = findings.flatMap(f => f.unknowns),
    canAggregate = aggregationSafe(input, rows),
    metrics = {
      ...totals(canAggregate ? rows : [], money.value),
      row_count: rows.length,
      aggregation_safe: canAggregate,
    };
  return {
    platform: input.platform,
    account_id: input.account_id,
    campaign_id: input.campaign_id,
    evidence: 'INDEPENDENT_DESIGN',
    date_range: period,
    as_of: input.as_of ?? null,
    score: evaluated.length
      ? Math.round(
          evaluated.reduce((n, f) => n + (f.status === 'pass' ? 100 : f.status === 'warning' ? 50 : 0), 0) /
            evaluated.length,
        )
      : null,
    score_kind: 'evaluated_rule_checks',
    score_method:
      'Equal-weight mean: pass 100, warning 50, critical 0; unknown checks excluded. A score of 100 means only that the evaluated rules passed, not that campaign health is fully verified.',
    coverage: {
      requested_checks: requested.length,
      evaluated_checks: evaluated.length,
      unknown_checks: findings.length - evaluated.length,
      complete: requested.length > 0 && unknowns.length === 0 && evaluated.length === findings.length,
    },
    findings,
    unknowns,
    observed_metrics: metrics,
    warnings: [
      ...(input.report ? [] : ['No performance report was supplied.']),
      ...(money.conflict ? ['Conflicting or invalid currencies prevent monetary aggregation.'] : []),
      ...(canAggregate ? [] : ['Overlapping dates or unknown report grain prevent metric aggregation.']),
      'Findings use current configuration and observed reporting rows. They do not establish causation, attribution accuracy, or historical configuration.',
    ],
    automated_changes: false,
  };
}

/** Comparisons require one explicitly returned row for every day; absent days are never filled with zero. */
function trend(input: CampaignAuditInput): JsonObject {
  const period = range(input),
    rows = reportRows(input, period);
  if (!period || input.report?.granularity !== 'day')
    return {available: false, reason: 'Daily reporting with an explicit date range is required.'};
  const days = Math.round((Date.parse(period.until) - Date.parse(period.since)) / 86400000) + 1;
  if (days < 2 || rows.length !== days || new Set(rows.map(row => row.date)).size !== days)
    return {
      available: false,
      reason:
        'A distinct returned campaign row is required for every calendar day; missing days are not assumed to be zero.',
    };
  const ordered = [...rows].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (
    ordered.some((row, i) => row.date !== new Date(Date.parse(period.since) + i * 86400000).toISOString().slice(0, 10))
  )
    return {available: false, reason: 'Daily rows are not contiguous.'};
  const split = Math.floor(days / 2),
    curr = currency(input, rows).value,
    first = totals(ordered.slice(0, split), curr),
    second = totals(ordered.slice(split), curr);
  const values = (part: JsonObject, count: number): JsonObject => ({
    ...part,
    days: count,
    spend_per_day: divide(part.spend, count),
    conversions_per_day: divide(part.conversions, count),
    ctr: divide(part.clicks, part.impressions, 100),
    cpc: divide(part.spend, part.clicks),
    cpa: divide(part.spend, part.conversions),
    roas: divide(part.conversion_value, part.spend),
  });
  const earlier = values(first, split),
    later = values(second, days - split),
    changes: JsonObject = {};
  for (const name of ['spend_per_day', 'conversions_per_day', 'ctr', 'cpc', 'cpa', 'roas']) {
    const a = earlier[name],
      b = later[name];
    changes[name] = {earlier: a, later: b, change_pct: a !== null && b !== null ? divide(b - a, a, 100) : null};
  }
  return {
    available: true,
    currency: curr,
    earlier: {since: ordered[0]!.date, until: ordered[split - 1]!.date, ...earlier},
    later: {since: ordered[split]!.date, until: ordered.at(-1)!.date, ...later},
    changes,
    method:
      'Two contiguous calendar halves; per-day volumes account for unequal half lengths. Changes are descriptive, not statistical significance or causal estimates.',
    evidence: [evidence('report', '/date_range', period), evidence('report', '/rows', rows)],
  };
}
export function optimizationSuggestions(
  input: CampaignAuditInput,
  options: {budget_reallocation?: boolean} = {},
): JsonObject {
  const audit = auditCampaign(input),
    comparison = trend(input),
    requested = options.budget_reallocation !== false;
  const suggestions: JsonObject[] = audit.findings
    .filter(f => f.recommendation && f.status !== 'pass' && (requested || f.check !== 'budget'))
    .map(f => ({
      id: f.check,
      priority: f.status === 'critical' ? 1 : f.status === 'warning' ? 2 : 3,
      kind: f.status === 'unknown' ? 'gather_evidence' : 'review',
      rationale: f.explanation,
      action: f.recommendation,
      evidence: f.evidence,
      requires_approval_for_changes: true,
    }));
  const change = comparison.available ? comparison.changes : null;
  if (
    change?.cpa?.earlier > 0 &&
    change.cpa.later > change.cpa.earlier &&
    change.conversions_per_day.later !== null &&
    change.conversions_per_day.earlier !== null &&
    change.conversions_per_day.later < change.conversions_per_day.earlier
  )
    suggestions.push({
      id: 'declining_efficiency',
      priority: 2,
      kind: 'review',
      rationale: `Observed CPA increased from ${change.cpa.earlier} to ${change.cpa.later} ${comparison.currency}, while conversions per day fell from ${change.conversions_per_day.earlier} to ${change.conversions_per_day.later}.`,
      action:
        'Inspect conversion tracking, attribution delay, search or audience mix, and dated creative performance before changing bids or budgets.',
      evidence: comparison.evidence,
      requires_approval_for_changes: true,
    });
  if (audit.observed_metrics.spend > 0 && audit.observed_metrics.conversions === 0)
    suggestions.push({
      id: 'zero_reported_conversions',
      priority: 2,
      kind: 'review',
      rationale: `The returned rows contain ${audit.observed_metrics.spend} ${audit.observed_metrics.currency} spend and zero reported conversions. Missing conversions were not substituted with zero.`,
      action:
        'Confirm that conversions are relevant to this campaign objective, then inspect tracking configuration and attribution delay before judging performance.',
      evidence: [evidence('report', '/rows', input.report!.rows)],
      requires_approval_for_changes: true,
    });
  suggestions.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  return {
    platform: input.platform,
    account_id: input.account_id,
    campaign_id: input.campaign_id,
    audit,
    suggestions,
    trend: comparison,
    budget_reallocation: {
      requested,
      available: false,
      reason: requested
        ? 'A single campaign report cannot establish which alternative campaign should receive budget; comparable objectives, currencies, attribution windows and approved constraints are required.'
        : 'Budget reallocation suggestions were disabled.',
    },
    evidence: 'INDEPENDENT_DESIGN',
    method: 'deterministic_evidence_rules',
    ai_generated: false,
    automated_changes: false,
  };
}

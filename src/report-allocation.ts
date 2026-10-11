import {bad, fingerprint, validate} from './workspace-core.js';
import type {JsonObject} from './types.js';
import {snapchatReportId} from './snapchat-evidence.js';
import {metricRoundingLimitation} from './provider-decimal.js';
// A cyclic import of functions only (allocation-calibration reuses allocationEvidence); nothing runs at load time.
import {calibrateAllocation} from './allocation-calibration.js';

const day = 86400000;
const amount = (value: unknown, places: number, label: string): bigint => {
  const text = String(value);
  if (
    !['string', 'number'].includes(typeof value) ||
    !new RegExp('^\\d{1,18}(?:\\.\\d{1,' + places + '})?$').test(text)
  )
    bad('Use a nonnegative decimal ' + label + ' with at most ' + places + ' decimal places.');
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole!) * 10n ** BigInt(places) + BigInt(fraction.padEnd(places, '0'));
};
const decimal = (value: bigint, places: number) => {
  const sign = value < 0n ? '-' : '';
  value = value < 0n ? -value : value;
  const scale = 10n ** BigInt(places),
    fraction = String(value % scale)
      .padStart(places, '0')
      .replace(/0+$/, '');
  return sign + value / scale + (fraction ? '.' + fraction : '');
};
function dateValue(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    bad('Retain valid evidence dates.', 'SCENARIO_EVIDENCE_REQUIRED');
  const time = Date.parse(value as string);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value)
    bad('Retain valid evidence dates.', 'SCENARIO_EVIDENCE_REQUIRED');
  return time;
}
type CampaignEvidence = {
  id: string;
  name: string;
  date: string;
  spend: bigint | null;
  conversions: bigint | null;
  /** DEC-02: the lowest and highest observed spend of one day with a row (nine places); null when any is unknown. */
  minDaily: bigint | null;
  maxDaily: bigint | null;
};
function linkedinSourceRange(sem: JsonObject) {
  const date = (value: string) => {
    dateValue(value);
    const [year, month, day] = value.split('-').map(Number);
    return '(year:' + year + ',month:' + month + ',day:' + day + ')';
  };
  return '(start:' + date(sem.date_from) + ',end:' + date(sem.date_to) + ')';
}
function campaigns(report: JsonObject) {
  const squad = report.preset === 'snapchat_adsquad';
  const linkedin = report.preset === 'linkedin_campaign';
  const gateway = {
    google_campaign: 'google_ads_native_action',
    meta_campaign: 'meta_native_action',
    linkedin_campaign: 'linkedin_native_action',
    snapchat_adsquad: 'snapchat_native_action',
  }[report.preset as string];
  if (
    !gateway ||
    report.gateway !== gateway ||
    report.source !== 'provider_read' ||
    report.grain !== (squad ? 'ad squad × day' : 'campaign × day')
  )
    bad(
      'Capture a guided Google, Meta or LinkedIn campaign-by-day report, or a Snapchat ad-squad-by-day report, before modeling allocations.',
      'SCENARIO_EVIDENCE_REQUIRED',
    );
  if (
    squad &&
    (!snapchatReportId(report.source_request?.path_params?.campaign_id) ||
      report.source_request?.action !== 'snapchat_campaign_stats_get' ||
      report.source_request?.query?.breakdown !== 'adsquad' ||
      report.native_account_evidence?.parent_campaign?.id !== report.source_request.path_params.campaign_id ||
      report.native_account_evidence.parent_campaign.account_id !== report.account_id)
  )
    bad('Retain exact Snapchat campaign ownership and ad-squad source evidence.', 'SCENARIO_EVIDENCE_REQUIRED');
  if (
    linkedin &&
    (report.source_collection !== 'linkedin_analytics' ||
      report.source_request?.action !== 'linkedin_rest_ad_analytics_get' ||
      report.source_request.account_id !== report.account_id ||
      report.source_request.connection_id !== report.connection_id ||
      report.source_request.query?.pivot !== 'CAMPAIGN' ||
      report.source_request.query?.q !== 'analytics' ||
      report.source_request.query?.timeGranularity !== 'DAILY' ||
      report.source_request.query?.accounts !== 'List(urn:li:sponsoredAccount:' + report.account_id + ')' ||
      report.semantics?.timezone !== 'UTC' ||
      report.semantics?.conversion_definition !== 'externalWebsiteConversions' ||
      report.source_request.query?.dateRange !== linkedinSourceRange(report.semantics) ||
      report.mapping?.entity_id !== '/pivotValues/0' ||
      report.mapping?.date?.path !== '/dateRange/start' ||
      report.mapping?.date?.format !== 'linkedin_utc_date' ||
      report.mapping?.spend !== '/costInLocalCurrency' ||
      report.mapping?.conversions !== '/externalWebsiteConversions' ||
      report.native_account_evidence?.account_id !== report.account_id ||
      report.native_account_evidence?.currency !== report.semantics?.currency ||
      !Array.isArray(report.native_account_evidence?.checks) ||
      report.native_account_evidence.checks.length !== 2 ||
      report.native_account_evidence.checks.some(
        (check: JsonObject) =>
          check.source_request?.action !== 'linkedin_rest_ad_accounts_ad_account_id_get' ||
          check.source_request.account_id !== report.account_id ||
          check.source_request.connection_id !== report.connection_id ||
          check.source_request.path_params?.ad_account_id !== report.account_id ||
          typeof check.source_hash !== 'string' ||
          !/^[a-f0-9]{64}$/.test(check.source_hash),
      ) ||
      report.native_account_evidence.checks[0].source_hash !== report.native_account_evidence.checks[1].source_hash)
  )
    bad(
      'Retain the original LinkedIn campaign URNs, UTC daily analytics mapping and verified account currency evidence.',
      'SCENARIO_EVIDENCE_REQUIRED',
    );
  if (!Array.isArray(report.rows) || report.rows.length > 10000)
    bad(
      report.preset === 'snapchat_adsquad'
        ? 'Use at most 10,000 retained daily ad-squad rows.'
        : 'Use at most 10,000 retained daily campaign rows.',
      'SCENARIO_EVIDENCE_REQUIRED',
    );
  const sem = report.semantics,
    start = dateValue(sem.date_from),
    end = dateValue(sem.date_to);
  if (end < start) bad('Evidence dates must increase.', 'SCENARIO_EVIDENCE_REQUIRED');
  const groups = new Map<string, CampaignEvidence>(),
    seen = new Set<string>();
  for (const row of report.rows) {
    if (
      squad
        ? !snapchatReportId(row.entity_id)
        : typeof row.entity_id !== 'string' ||
          !(linkedin ? /^urn:li:sponsoredCampaign:[1-9][0-9]{0,19}$/ : /^\d{1,40}$/).test(row.entity_id)
    )
      bad(
        report.preset === 'snapchat_adsquad'
          ? 'Retain exact native ad-squad IDs.'
          : 'Retain exact native campaign IDs.',
        'SCENARIO_EVIDENCE_REQUIRED',
      );
    const date = dateValue(row.date),
      key = row.entity_id + '/' + row.date;
    if (date < start || date > end || seen.has(key))
      bad(
        report.preset === 'snapchat_adsquad'
          ? 'Ad-squad evidence must have one row per ad squad/day inside the declared period.'
          : 'Campaign evidence must have one row per campaign/day inside the declared period.',
        'SCENARIO_EVIDENCE_REQUIRED',
      );
    seen.add(key);
    const group = groups.get(row.entity_id) ?? {
      id: row.entity_id,
      name: '',
      date: '',
      spend: 0n,
      conversions: 0n,
      minDaily: undefined as unknown as bigint | null,
      maxDaily: undefined as unknown as bigint | null,
    };
    if (row.date >= group.date) {
      group.name = String(row.entity_name ?? row.entity_id);
      group.date = row.date;
    }
    for (const metric of ['spend', 'conversions'] as const)
      group[metric] =
        group[metric] === null || row[metric] == null ? null : group[metric]! + amount(row[metric], 9, metric);
    const daily = row.spend == null ? null : amount(row.spend, 9, 'spend');
    if (daily === null || group.minDaily === null) group.minDaily = group.maxDaily = null;
    else {
      group.minDaily = group.minDaily === undefined || daily < group.minDaily ? daily : group.minDaily;
      group.maxDaily = group.maxDaily === undefined || daily > group.maxDaily! ? daily : group.maxDaily;
    }
    groups.set(row.entity_id, group);
  }
  return [...groups.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
export function allocationCandidates(report: JsonObject, input: JsonObject) {
  const offset = input.offset ?? 0,
    limit = input.limit ?? 20;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    bad('Use an offset >= 0 and page size 1–100.');
  const rows = campaigns(report);
  return {
    report_id: report.id,
    entity_kind: report.preset === 'snapchat_adsquad' ? 'ad_squad' : 'campaign',
    ...(report.preset === 'snapchat_adsquad'
      ? {parent_campaign_id: report.source_request.path_params.campaign_id}
      : {}),
    currency: report.semantics.currency,
    semantics: report.semantics,
    source_hash: report.source_hash,
    candidates: rows.slice(offset, offset + limit).map(row => ({
      entity_id: row.id,
      name: row.name,
      observed_spend: row.spend === null ? null : decimal(row.spend, 9),
      observed_conversions: row.conversions === null ? null : decimal(row.conversions, 9),
    })),
    next_offset: offset + limit < rows.length ? offset + limit : null,
    network_requests: 0,
  };
}
/** The same closed-period, source/grain/identity and freshness gates used by allocation and its diagnostics. */
export function allocationEvidence(report: JsonObject, age: number) {
  if (!Number.isInteger(age) || age < 1 || age > 90)
    bad('Declare an evidence age of 1–90 days.', 'SCENARIO_EVIDENCE_REQUIRED');
  const sem = report.semantics,
    now = Date.now();
  if (
    sem.complete !== true ||
    !/^[A-Z]{3}$/.test(sem.currency) ||
    sem.currency === 'XXX' ||
    typeof sem.timezone !== 'string' ||
    !sem.timezone.trim() ||
    ['attribution', 'conversion_definition'].some(
      k => typeof sem[k] !== 'string' || !sem[k].trim() || sem[k].trim().toLowerCase() === 'unknown',
    ) ||
    !Number.isFinite(report.captured_at) ||
    report.captured_at > now ||
    now - report.captured_at > age * day
  )
    bad(
      'Use recent complete evidence with known currency, attribution and conversion definitions.',
      'SCENARIO_EVIDENCE_REQUIRED',
    );
  let today: number;
  try {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone: sem.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
    today = dateValue(values.year + '-' + values.month + '-' + values.day);
  } catch {
    bad('Use the native IANA reporting timezone.', 'SCENARIO_EVIDENCE_REQUIRED');
  }
  const end = dateValue(sem.date_to),
    start = dateValue(sem.date_from);
  if (end >= today || today - end > age * day)
    bad(
      'Use a closed reporting period within your declared evidence-age limit. A fresh capture cannot make old dates recent.',
      'SCENARIO_EVIDENCE_REQUIRED',
    );
  return {semantics: sem, start, end, evidence: campaigns(report)};
}

/** DEC-02: shown when efficiency factors were typed rather than derived from a retained calibration. */
export const declaredFactorsLimitation =
  'The efficiency factors were entered directly, without a retained calibration; they are assumptions with no historical provenance.';
/** DEC-02: shown when the factors come from a retained calibration of this report. */
export const calibratedFactorsLimitation =
  'The efficiency factors come from a one-day, spend-conditioned calibration of this report. The allocation applies them to a multi-day period at new spend levels, which that calibration did not test.';
/**
 * DEC-02 factor provenance: `factor_source {kind:'calibration', evidence_fingerprint, ids, options}` names the retained
 * calibration the factors were copied from. The calibration is recomputed here; a fingerprint, factor or entity that does
 * not match is refused, so a proposal can never claim historical provenance it does not have.
 */
function factorProvenance(report: JsonObject, input: JsonObject, entityIds: string[]): JsonObject {
  const source = input.factor_source;
  if (source === undefined) return {kind: 'declared'};
  const code = 'ALLOCATION_FACTOR_PROVENANCE';
  if (!source || typeof source !== 'object' || Array.isArray(source))
    bad('Name the calibration the efficiency factors came from, or omit factor_source.', code);
  validate(source, ['kind', 'evidence_fingerprint', 'ids', 'options'], undefined, 'factor source');
  if (source.kind !== 'calibration' || typeof source.evidence_fingerprint !== 'string')
    bad('Name the calibration the efficiency factors came from, or omit factor_source.', code);
  const calibration = calibrateAllocation(report, source.ids, source.options ?? {});
  if (calibration.evidence_fingerprint !== source.evidence_fingerprint)
    bad(
      'The named calibration does not match this report’s current evidence. Calibrate again before using its factors.',
      code,
    );
  const envelope = calibration.factor_envelope;
  if (
    envelope.applicable !== true ||
    Number(envelope.efficiency_low) !== input.efficiency_low ||
    Number(envelope.efficiency_high) !== input.efficiency_high
  )
    bad(
      'The efficiency factors differ from the named calibration. Use its factors unchanged, or omit factor_source.',
      code,
    );
  if (entityIds.some(id => !source.ids.includes(id)))
    bad('Every allocated entity must be one the named calibration evaluated.', code);
  return {
    kind: 'calibration',
    evidence_fingerprint: calibration.evidence_fingerprint,
    report_id: calibration.report_id,
    source_hash: calibration.source_hash,
    ids: [...source.ids],
    options: {
      training_days: calibration.training_days,
      minimum_training_conversions: calibration.minimum_training_conversions,
      maximum_age_days: calibration.maximum_age_days,
      central_share_percent: calibration.central_share_percent,
    },
    period: calibration.period,
    method: calibration.method,
    horizon_days: calibration.horizon_days,
    factor_envelope: envelope,
  };
}
/** DEC-02: shown when a proposed daily average lies outside an entity's observed daily spend. */
export const outsideRangeLimitation =
  'At least one proposed daily average lies outside the daily spend observed in the evidence, so the linear model is extrapolating there.';
/** a / b at `places` decimal places, truncated (both already scaled by their own places). */
const ratioText = (a: bigint, aPlaces: number, b: bigint, bPlaces: number, places: number) =>
  decimal((a * 10n ** BigInt(bPlaces + places)) / (b * 10n ** BigInt(aPlaces)), places);

/** A linear constrained sensitivity model, never a native budget change or delivery forecast. */
export function reportAllocation(report: JsonObject, input: JsonObject) {
  validate(input, [
    'budget',
    'allocations',
    'efficiency_low',
    'efficiency_high',
    'minimum_conversions',
    'maximum_age_days',
    'factor_source',
  ]);
  const {efficiency_low: low, efficiency_high: high, minimum_conversions: threshold, maximum_age_days: age} = input;
  if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high < low || high > 10)
    bad('Declare efficiency factors with 0 < low ≤ high ≤ 10.');
  if (
    !Number.isFinite(threshold) ||
    threshold < 1 ||
    threshold > 1000000 ||
    !Number.isInteger(age) ||
    age < 1 ||
    age > 90
  )
    bad(
      report.preset === 'snapchat_adsquad'
        ? 'Declare a minimum of 1–1,000,000 observed conversions per ad squad and an evidence age of 1–90 days.'
        : 'Declare a minimum of 1–1,000,000 observed conversions per campaign and an evidence age of 1–90 days.',
    );
  const {semantics: sem, start, end, evidence} = allocationEvidence(report, age);
  const budget = amount(input.budget, 6, 'total budget');
  if (budget <= 0n || budget > 1000000000000000000n) bad('Use a positive total budget up to 1 trillion.');
  if (!Array.isArray(input.allocations) || input.allocations.length < 2 || input.allocations.length > 50)
    bad(
      report.preset === 'snapchat_adsquad'
        ? 'Select 2–50 distinct ad squads and supply a floor and cap for each.'
        : 'Select 2–50 distinct campaigns and supply a floor and cap for each.',
    );
  const seen = new Set<string>();
  const rows = input.allocations.map((bounds: JsonObject) => {
    validate(bounds, ['entity_id', 'minimum', 'maximum']);
    const row = evidence.find(r => r.id === bounds.entity_id);
    if (!row || seen.has(row.id))
      bad(
        report.preset === 'snapchat_adsquad'
          ? 'Choose distinct ad-squad IDs from this retained report.'
          : 'Choose distinct campaign IDs from this retained report.',
      );
    seen.add(row.id);
    if (
      row.spend === null ||
      row.conversions === null ||
      row.spend <= 0n ||
      Number(decimal(row.conversions, 9)) < threshold
    )
      bad(
        report.preset === 'snapchat_adsquad'
          ? 'Every selected ad squad needs known positive spend and the declared minimum conversions. Narrow the selection or collect enough evidence.'
          : 'Every selected campaign needs known positive spend and the declared minimum conversions. Narrow the selection or collect enough evidence.',
        'SCENARIO_EVIDENCE_REQUIRED',
      );
    const minimum = amount(
        bounds.minimum,
        6,
        report.preset === 'snapchat_adsquad' ? 'ad-squad floor' : 'campaign floor',
      ),
      maximum = amount(bounds.maximum, 6, report.preset === 'snapchat_adsquad' ? 'ad-squad cap' : 'campaign cap');
    if (minimum > maximum || maximum > 1000000000000000000n)
      bad('Each floor must be at most its cap, and each cap at most 1 trillion.');
    return {...row, spend: row.spend, conversions: row.conversions, minimum, maximum, allocated: minimum};
  });
  const minimum = rows.reduce((n, r) => n + r.minimum, 0n),
    maximum = rows.reduce((n, r) => n + r.maximum, 0n);
  if (budget < minimum || budget > maximum)
    bad(
      'The total budget must be between the sum of floors (' +
        decimal(minimum, 6) +
        ') and caps (' +
        decimal(maximum, 6) +
        ').',
    );
  let remaining = budget - minimum;
  const ranked = [...rows].sort((a, b) => {
    const difference = a.conversions * b.spend - b.conversions * a.spend;
    return difference > 0n ? -1 : difference < 0n ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  for (const row of ranked) {
    const capacity = row.maximum - row.allocated,
      extra = remaining < capacity ? remaining : capacity;
    row.allocated += extra;
    remaining -= extra;
  }
  const days = (end - start) / day + 1,
    provenance = factorProvenance(
      report,
      input,
      rows.map(row => row.id),
    );
  // DEC-02 indicators (descriptive, never a gate): how far each proposal moves from what was observed. The observed
  // daily range covers days with a row; a proposed daily average outside it extrapolates the linear model.
  const indicators = rows.map(row => {
    const average = (row.allocated * 1000n) / BigInt(days),
      known = row.minDaily !== null && row.maxDaily !== null;
    return {
      entity_id: row.id,
      observed_daily_spend_min: known ? decimal(row.minDaily!, 9) : null,
      observed_daily_spend_max: known ? decimal(row.maxDaily!, 9) : null,
      proposed_daily_average: decimal(average, 9),
      proposed_to_observed_spend: ratioText(row.allocated, 6, row.spend, 9, 6),
      position: !known ? 'unknown' : average > row.maxDaily! ? 'above' : average < row.minDaily! ? 'below' : 'within',
      outside_observed_range: known ? average > row.maxDaily! || average < row.minDaily! : null,
    };
  });
  const allocations = rows.map(row => {
    const baseline = (Number(row.conversions) / Number(row.spend)) * Number(decimal(row.allocated, 6));
    return {
      entity_id: row.id,
      name: row.name,
      observed_spend: decimal(row.spend, 9),
      observed_conversions: decimal(row.conversions, 9),
      observed_cpa: Number(row.spend) / Number(row.conversions),
      minimum: decimal(row.minimum, 6),
      maximum: decimal(row.maximum, 6),
      proposed_budget: decimal(row.allocated, 6),
      change_from_observed_spend: decimal(row.allocated * 1000n - row.spend, 9),
      modeled_conversions_low: baseline * low,
      modeled_conversions_high: baseline * high,
      binding_constraints: [
        ...(row.allocated === row.minimum ? ['floor'] : []),
        ...(row.allocated === row.maximum ? ['cap'] : []),
      ],
    };
  });
  return {
    version: 1,
    proposal_type: 'illustrative_allocation',
    entity_kind: report.preset === 'snapchat_adsquad' ? 'ad_squad' : 'campaign',
    ...(report.preset === 'snapchat_adsquad'
      ? {parent_campaign_id: report.source_request.path_params.campaign_id}
      : {}),
    report_id: report.id,
    source_hash: report.source_hash,
    captured_at: report.captured_at,
    semantics: sem,
    currency: sem.currency,
    period: {days, unit: 'total over a comparable period, not a native daily budget'},
    total_budget: decimal(budget, 6),
    allocations,
    allocation_indicators: indicators,
    modeled_conversions_low: allocations.reduce((n, r) => n + r.modeled_conversions_low, 0),
    modeled_conversions_high: allocations.reduce((n, r) => n + r.modeled_conversions_high, 0),
    assumptions: {
      response:
        report.preset === 'snapchat_adsquad'
          ? 'linear at each ad squad’s observed cost per conversion'
          : 'linear at each campaign’s observed cost per conversion',
      efficiency_low: low,
      efficiency_high: high,
      minimum_conversions: threshold,
      maximum_age_days: age,
      objective: 'maximize modeled conversions within explicit floors and caps',
      tie_break:
        report.preset === 'snapchat_adsquad'
          ? 'native ad-squad ID, lexicographic'
          : 'native campaign ID, lexicographic',
      factor_provenance: provenance,
    },
    // factor_source is part of the input, so a proposal with calibration provenance has its own fingerprint (DEC-02).
    model_fingerprint: fingerprint({report_id: report.id, source: report.source_hash, semantics: sem, input}),
    limitations: [
      'Illustrative constrained sensitivity model, not a forecast or statistical confidence interval.',
      'Linear response ignores saturation, auction changes, audience overlap, creative changes and causal incrementality. Caps are user assumptions, not verified provider limits.',
      'Budgets cover a comparable period with the same number of days as the evidence. They are not native daily or lifetime budgets.',
      'No live budget or approval is created. Any later change needs current native budget ownership, units, eligibility, preflight and a separate reviewed plan.',
      'Measurement completeness and timezone retain the original report declarations; the minimum conversion threshold is a user assumption, not statistical significance.',
      ...(sem.metric_rounding ? [metricRoundingLimitation] : []),
      ...(provenance.kind === 'calibration' ? [calibratedFactorsLimitation] : [declaredFactorsLimitation]),
      ...(indicators.some(i => i.outside_observed_range) ? [outsideRangeLimitation] : []),
    ],
    network_requests: 0,
    advertising_writes: 0,
  };
}

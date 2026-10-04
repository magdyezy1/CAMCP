import type {JsonObject} from './types.js';
import {bad, fingerprint, validate} from './workspace-core.js';
import {allocationEvidence} from './report-allocation.js';

const scale = 1000000000n,
  day = 86400000;
type Fraction = {n: bigint; d: bigint};
const abs = (n: bigint) => (n < 0n ? -n : n);
const compare = (a: Fraction, b: Fraction) => (a.n * b.d < b.n * a.d ? -1 : a.n * b.d > b.n * a.d ? 1 : 0);
function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a;
}
function add(a: Fraction, b: Fraction): Fraction {
  const common = gcd(a.d, b.d),
    n = a.n * (b.d / common) + b.n * (a.d / common),
    d = a.d * (b.d / common);
  const divisor = gcd(abs(n), d);
  return {n: n / divisor, d: d / divisor};
}
/** Exact rational arithmetic until final text projection; factor bounds round outward, metrics truncate at nine places. */
function decimal(value: Fraction, places = 9, outward = false) {
  const factor = 10n ** BigInt(places),
    numerator = abs(value.n) * factor;
  let integer = numerator / value.d;
  if (outward && numerator % value.d) integer++;
  const fraction = String(integer % factor)
    .padStart(places, '0')
    .replace(/0+$/, '');
  return (value.n < 0n && integer ? '-' : '') + String(integer / factor) + (fraction ? '.' + fraction : '');
}
function metric(value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d{1,18}(?:\.\d{1,9})?$/.test(value))
    bad(
      'Calibration needs exact known daily spend and conversions; missing values are not zero.',
      'CALIBRATION_EVIDENCE_REQUIRED',
    );
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * scale + BigInt(fraction.padEnd(9, '0'));
}
const date = (time: number) => new Date(time).toISOString().slice(0, 10);
const quantile = (values: Fraction[], percentage: number) =>
  values[Math.max(0, Math.ceil((values.length * percentage) / 100) - 1)]!;

/** Retrospective, spend-conditioned one-day efficiency diagnostics. Never an unconditional forecast or native plan. */
export function calibrateAllocation(report: JsonObject, ids: unknown, options: JsonObject = {}) {
  validate(options, ['training_days', 'minimum_training_conversions', 'maximum_age_days', 'central_share_percent']);
  const training = options.training_days ?? 7,
    minimum = options.minimum_training_conversions ?? 10,
    age = options.maximum_age_days ?? 7,
    share = options.central_share_percent ?? 80;
  if (
    !Number.isInteger(training) ||
    training < 7 ||
    training > 21 ||
    !Number.isSafeInteger(minimum) ||
    minimum < 1 ||
    minimum > 1000000 ||
    ![50, 60, 70, 80, 90].includes(share)
  )
    bad(
      'Choose 7–21 training days, 1–1,000,000 minimum training conversions and a central share of 50, 60, 70, 80 or 90 percent.',
    );
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > 20 ||
    ids.some(id => typeof id !== 'string') ||
    new Set(ids).size !== ids.length
  )
    bad('Choose 1–20 distinct original report entity IDs for calibration.');
  const {semantics, start, end, evidence} = allocationEvidence(report, age),
    days = (end - start) / day + 1;
  if (days < training + 7 || days > 31)
    bad(
      'Calibration needs 14–31 consecutive closed days, including at least seven test days after the selected training window.',
      'CALIBRATION_EVIDENCE_REQUIRED',
    );
  if (typeof report.source_hash !== 'string' || !/^[a-f0-9]{64}$/.test(report.source_hash))
    bad('Retain the original report source SHA-256 for calibration.', 'CALIBRATION_EVIDENCE_REQUIRED');
  const selected = ids.map(id => {
    const row = evidence.find(r => r.id === id);
    if (!row) bad('Choose calibration IDs from this exact retained report.', 'CALIBRATION_EVIDENCE_REQUIRED');
    return row;
  });
  const tail = (100 - share) / 2,
    bands: {low: Fraction; high: Fraction}[] = [];
  let allApplicable = true;
  const entities = selected.map(entity => {
    const rows = report.rows
      .filter((row: JsonObject) => row.entity_id === entity.id)
      .sort((a: JsonObject, b: JsonObject) => a.date.localeCompare(b.date));
    if (rows.length !== days || rows.some((row: JsonObject, i: number) => row.date !== date(start + i * day)))
      bad(
        'Every selected entity needs one explicit row for every calendar day. Missing days are not zero.',
        'CALIBRATION_EVIDENCE_REQUIRED',
      );
    const series: {spend: bigint; conversions: bigint}[] = rows.map((row: JsonObject) => ({
      spend: metric(row.spend),
      conversions: metric(row.conversions),
    }));
    let trainedSpend = series.slice(0, training).reduce((n: bigint, r: {spend: bigint}) => n + r.spend, 0n),
      trainedConversions = series
        .slice(0, training)
        .reduce((n: bigint, r: {conversions: bigint}) => n + r.conversions, 0n),
      absoluteError: Fraction = {n: 0n, d: 1n},
      totalError: Fraction = {n: 0n, d: 1n},
      eligible = 0;
    const ratios: Fraction[] = [],
      folds: JsonObject[] = [];
    for (let i = training; i < days; i++) {
      const observed = series[i]!,
        enough = trainedSpend > 0n && trainedConversions >= BigInt(minimum) * scale;
      const fold: JsonObject = {
        training_date_from: date(start + (i - training) * day),
        training_date_to: date(start + (i - 1) * day),
        test_date: date(start + i * day),
        training_spend: decimal({n: trainedSpend, d: scale}),
        training_conversions: decimal({n: trainedConversions, d: scale}),
        test_spend: decimal({n: observed.spend, d: scale}),
        observed_conversions: decimal({n: observed.conversions, d: scale}),
        expected_conversions: null,
        error: null,
        observed_to_expected: null,
        status: enough ? 'known' : 'insufficient_training',
      };
      if (enough) {
        const expected: Fraction = {n: trainedConversions * observed.spend, d: trainedSpend},
          error: Fraction = {n: observed.conversions * trainedSpend - expected.n, d: trainedSpend * scale};
        fold.expected_conversions = decimal({n: expected.n, d: expected.d * scale});
        fold.error = decimal(error);
        absoluteError = add(absoluteError, {n: abs(error.n), d: error.d});
        totalError = add(totalError, error);
        eligible++;
        if (expected.n > 0n) {
          const ratio = {n: observed.conversions * expected.d, d: expected.n};
          ratios.push(ratio);
          fold.observed_to_expected = decimal(ratio);
        } else fold.status = 'zero_expected';
      }
      folds.push(fold);
      trainedSpend += observed.spend - series[i - training]!.spend;
      trainedConversions += observed.conversions - series[i - training]!.conversions;
    }
    ratios.sort(compare);
    const low = ratios.length >= 7 ? quantile(ratios, tail) : null,
      high = ratios.length >= 7 ? quantile(ratios, 100 - tail) : null,
      lowText = low ? decimal(low, 6) : null,
      highText = high ? decimal(high, 6, true) : null,
      applicable = !!low && !!high && Number(lowText) > 0 && Number(highText) <= 10 && ratios.length === folds.length;
    allApplicable &&= applicable;
    if (applicable) bands.push({low: low!, high: high!});
    const inside = low && high ? ratios.filter(r => compare(r, low) >= 0 && compare(r, high) <= 0).length : null;
    return {
      entity_id: entity.id,
      name: entity.name,
      folds,
      test_days: folds.length,
      known_error_days: eligible,
      known_ratio_days: ratios.length,
      unknown_ratio_days: folds.length - ratios.length,
      mean_absolute_error: eligible ? decimal({n: absoluteError.n, d: absoluteError.d * BigInt(eligible)}) : null,
      mean_error: eligible ? decimal({n: totalError.n, d: totalError.d * BigInt(eligible)}) : null,
      efficiency_low: lowText,
      efficiency_high: highText,
      applicable,
      observed_inside_band: inside,
      observed_band_denominator: ratios.length,
      meaning: applicable
        ? 'Historical factors fit the allocation input bounds. Inspect them before applying.'
        : 'Historical factors cannot be applied: at least seven known ratios, no unknown test days and positive factors at most ten are required. No values were clipped.',
    };
  });
  const low = allApplicable ? bands.map(b => b.low).sort(compare)[0]! : null,
    high = allApplicable
      ? bands
          .map(b => b.high)
          .sort(compare)
          .at(-1)!
      : null;
  return {
    version: 1,
    record_kind: 'allocation_calibration',
    report_id: report.id,
    source_hash: report.source_hash,
    evidence_fingerprint: fingerprint({
      report_id: report.id,
      gateway: report.gateway,
      account_id: report.account_id,
      connection_id: report.connection_id,
      preset: report.preset,
      source_hash: report.source_hash,
      captured_at: report.captured_at,
      semantics,
      ids,
      options: {
        training_days: training,
        minimum_training_conversions: minimum,
        maximum_age_days: age,
        central_share_percent: share,
      },
      entities,
    }),
    account_id: report.account_id,
    connection_id: report.connection_id,
    gateway: report.gateway,
    preset: report.preset,
    entity_kind: report.preset === 'snapchat_adsquad' ? 'ad_squad' : 'campaign',
    ...(report.preset === 'snapchat_adsquad'
      ? {parent_campaign_id: report.source_request.path_params.campaign_id}
      : {}),
    currency: semantics.currency,
    semantics,
    captured_at: report.captured_at,
    checked_at: Date.now(),
    horizon_days: 1,
    training_days: training,
    minimum_training_conversions: minimum,
    maximum_age_days: age,
    central_share_percent: share,
    period: {date_from: date(start), date_to: date(end), days, test_date_from: date(start + training * day)},
    entities,
    factor_envelope: {
      efficiency_low: low ? decimal(low, 6) : null,
      efficiency_high: high ? decimal(high, 6, true) : null,
      applicable: allApplicable,
    },
    method: 'rolling_prior_window_spend_conditioned_efficiency',
    limitations: [
      'Retrospective one-day diagnostics conditioned on the actual test-day spend, not a forecast of future spend, delivery or causal budget effects.',
      'Each test uses only the selected preceding training days. The held-out conversion count is never used to fit that test estimate.',
      'Nearest-rank empirical factor quantiles describe these observed test days. The central share is not a confidence level or a guarantee of future coverage.',
      'The factor envelope uses the lowest entity low and highest entity high. It is not pooled campaign attribution or an account-wide probability interval.',
      'Zero predictions, insufficient training and missing ratios remain explicit. Factors outside allocation bounds are not clipped or silently applied.',
      'Original currency, timezone, attribution, conversion lag, completeness declarations and exact entity identity remain unchanged. Auction, creative and measurement changes can invalidate this history.',
      'Metrics truncate to nine decimal places; factor bounds round outward to six. No provider read, saved change, native plan or advertising mutation is made.',
    ],
    network_requests: 0,
    advertising_writes: 0,
  };
}

import {MirrorError} from './errors.js';
import {calculateMetrics, metricDefinitions, parseMetricFormula} from './report-metrics.js';
import type {JsonObject} from './types.js';

/**
 * RPT-07 period comparison of two retained Overview snapshots: "this window versus an earlier window of the same
 * report". Read-only and local: no provider request, no saved change.
 *
 * Validity rules:
 *  - both snapshots finished collecting (complete or marked partial) and are different snapshots;
 *  - the same grouping (total, daily, weekly or monthly);
 *  - equal-length windows, and the baseline ends before the current window starts;
 *  - at least one account appears in both.
 * Rows are matched per native entity (platform, account, entity level and native ID) and compared only when their
 * compatibility key matches: platform, account, currency, time zone, result definition, attribution, entity level and
 * grain. An entity in only one window is listed, never treated as zero. Additive metrics are summed exactly over the
 * window; ratios are recomputed from those sums; reach, frequency, users and position are compared only for single-day
 * native values. Deltas and percentages use nine decimal places, rounded half to even (owner decision D10).
 */
export const comparisonKeyFields = [
  'platform',
  'account_id',
  'currency',
  'timezone',
  'result_definition',
  'attribution',
  'entity_level',
  'grain',
] as const;
/** Snapshot-level reasons, in a stable order, with the English text the website translates. */
export const comparisonReasons: Record<string, string> = {
  same_snapshot: 'Choose a different snapshot.',
  not_finished: 'This snapshot has not finished collecting.',
  grain: 'The grouping differs (total, daily, weekly or monthly).',
  window_length: 'The windows have different lengths.',
  window_order: 'The baseline must end before the current window starts.',
  no_shared_accounts: 'No account appears in both snapshots.',
};
export const comparisonLimitations = [
  'Observational evidence does not establish causality or adjust for seasonality.',
  'Entities present in only one window are listed separately, never counted as zero.',
  'Reach, frequency, users and position are compared only for single-day native values.',
];
const dayMs = 86400000;
const shift = (date: string, days: number) => new Date(Date.parse(date) + days * dayMs).toISOString().slice(0, 10);
export const windowDays = (range: {since: string; until: string}) =>
  Math.round((Date.parse(range.until) - Date.parse(range.since)) / dayMs) + 1;
/** The equal-length window that ends the day before `range` starts. */
export function previousEqualWindow(range: {since: string; until: string}) {
  const days = windowDays(range);
  return {since: shift(range.since, -days), until: shift(range.since, -1)};
}
const finished = (r: JsonObject) => ['complete', 'partial'].includes(r.state) && typeof r.completed_at === 'number';
const accounts = (r: JsonObject) =>
  new Set<string>(
    (r.config?.sources ?? []).map((s: JsonObject) => s.platform + ':' + String(s.account_id).replace(/^act_/, '')),
  );
/** Whether `baseline` may be compared with `current`, with every failing rule's reason code. */
export function comparisonEligibility(current: JsonObject, baseline: JsonObject) {
  const reasons: string[] = [];
  if (current.id !== undefined && current.id === baseline.id) reasons.push('same_snapshot');
  if (!finished(current) || !finished(baseline)) reasons.push('not_finished');
  if ((current.config?.grain ?? 'total') !== (baseline.config?.grain ?? 'total')) reasons.push('grain');
  const a = current.config?.date_range,
    b = baseline.config?.date_range;
  if (a?.since && a?.until && b?.since && b?.until) {
    if (windowDays(a) !== windowDays(b)) reasons.push('window_length');
    if (b.until >= a.since) reasons.push('window_order');
  } else reasons.push('window_length');
  const shared = accounts(baseline);
  if (![...accounts(current)].some(key => shared.has(key))) reasons.push('no_shared_accounts');
  return {eligible: reasons.length === 0, reasons};
}

/** Exact decimals: values scaled by 10^9, rounded half to even from the shortest numeric text. */
const scale = 1000000000n;
function scaled(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  let text: string;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' && Number.isFinite(value))
    text = Number.isInteger(value) ? String(value) : value.toFixed(12);
  else return null;
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return null;
  const fraction = (m[3] ?? '').padEnd(10, '0'),
    kept = BigInt(m[2]! + fraction.slice(0, 9)),
    rest = fraction.slice(9),
    first = Number(rest[0]),
    beyond = /[1-9]/.test(rest.slice(1));
  const rounded = first > 5 || (first === 5 && (beyond || kept % 2n === 1n)) ? kept + 1n : kept;
  return m[1] ? -rounded : rounded;
}
function decimal(n: bigint): string {
  const sign = n < 0n ? '-' : '',
    abs = n < 0n ? -n : n,
    fraction = (abs % scale).toString().padStart(9, '0').replace(/0+$/, '');
  return sign + (abs / scale).toString() + (fraction ? '.' + fraction : '');
}
/** a / b at nine places, rounded half to even. */
function divide(a: bigint, b: bigint): bigint {
  const negative = a < 0n !== b < 0n,
    x = a < 0n ? -a : a,
    y = b < 0n ? -b : b,
    q = (x * scale) / y,
    r = (x * scale) % y,
    up = r * 2n > y || (r * 2n === y && q % 2n === 1n),
    out = up ? q + 1n : q;
  return negative ? -out : out;
}
const additive = Object.entries(metricDefinitions)
  .filter(([, d]) => !d.formula && d.aggregation === 'sum')
  .map(([k]) => k);
const nonAdditive = Object.entries(metricDefinitions)
  .filter(([, d]) => !d.formula && d.aggregation !== 'sum')
  .map(([k]) => k);
const ratios = Object.entries(metricDefinitions)
  .filter(([, d]) => d.formula)
  .map(([k]) => k);
const entityKey = (row: JsonObject) => String(row.entity_key ?? row.campaign_key);
const keyOf = (row: JsonObject, grain: string): JsonObject =>
  Object.fromEntries(
    comparisonKeyFields.map(k => [k, k === 'grain' ? grain : k === 'entity_level' ? (row[k] ?? 'campaign') : row[k]]),
  );
interface Entity {
  rows: JsonObject[];
  key: JsonObject;
  consistent: boolean;
}
function entities(report: JsonObject) {
  const grain = report.config?.grain ?? 'total',
    out = new Map<string, Entity>();
  for (const row of report.rows ?? []) {
    const id = entityKey(row),
      key = keyOf(row, grain),
      prior = out.get(id);
    if (!prior) out.set(id, {rows: [row], key, consistent: true});
    else {
      prior.rows.push(row);
      if (JSON.stringify(prior.key) !== JSON.stringify(key)) prior.consistent = false;
    }
  }
  return out;
}
/** A row's metric: its exact retained native total when one exists (detailed rows), otherwise its value. */
const metricOf = (row: JsonObject, key: string) =>
  (row.entity_level ? row.native?.exact_totals?.[key] : undefined) ?? row.metrics?.[key];
/**
 * The window a report asked for an entity (r25-mf-jobs 6): the range of its source, which an account's time zone can
 * set apart from the report's, else the report's own. Not the first to the last day of its rows: an entity has no row
 * for a day it had no spend on, so a campaign idle on the last day of a window looked a day shorter than the other
 * window and was left out, and one idle on the first day was compared over other days than its baseline.
 */
function windowOf(report: JsonObject, row: JsonObject) {
  const sources: JsonObject[] = report.sources ?? [],
    source =
      row.source_ref !== undefined
        ? sources[row.source_ref]
        : sources.find(
            s =>
              s.source?.platform === row.platform &&
              String(s.source?.account_id) === String(row.account_id) &&
              s.source?.connection_id === row.connection_id,
          ),
    range = source?.date_range ?? report.config?.date_range;
  return {since: range?.since, until: range?.until};
}
/** Exact sums of additive metrics (null when any period is unknown) and single-day non-additive values. */
function totals(entity: Entity, singleDay: boolean) {
  const values: JsonObject = {},
    exact: Record<string, bigint | null> = {};
  for (const key of additive) {
    let sum = 0n,
      known = entity.rows.length > 0;
    for (const row of entity.rows) {
      const v = scaled(metricOf(row, key));
      if (v === null) {
        known = false;
        break;
      }
      sum += v;
    }
    exact[key] = known ? sum : null;
    values[key] = known ? Number(decimal(sum)) : null;
  }
  for (const key of nonAdditive) {
    const v = singleDay && entity.rows.length === 1 ? scaled(entity.rows[0]!.metrics?.[key]) : null;
    exact[key] = v;
    values[key] = v === null ? null : Number(decimal(v));
  }
  return {values, exact};
}
function delta(current: bigint | null, baseline: bigint | null) {
  if (current === null || baseline === null)
    return {current: null, baseline: null, delta: null, delta_percent: null, reason: 'unknown'};
  const d = current - baseline;
  return {
    current: decimal(current),
    baseline: decimal(baseline),
    delta: decimal(d),
    delta_percent: baseline === 0n ? null : decimal(divide(d * 100n, baseline)),
    ...(baseline === 0n ? {reason: 'baseline_zero'} : {}),
  };
}
/** Custom metrics whose formula reads only standard additive metrics can be recomputed; native fields cannot. */
function comparableCustom(current: JsonObject, baseline: JsonObject) {
  const custom: JsonObject[] = current.config?.custom_metrics ?? [],
    excluded: JsonObject[] = [];
  if (!custom.length) return {custom: [], excluded};
  if (current.config?.formula_fingerprint !== baseline.config?.formula_fingerprint)
    return {custom: [], excluded: custom.map(m => ({metric: m.id, reason: 'formula_changed'}))};
  const ids = new Set(custom.map(m => m.id)),
    usable: JsonObject[] = [];
  for (const m of custom) {
    const deps = parseMetricFormula(m.formula).dependencies;
    if (deps.some(d => d.startsWith('native_') || nonAdditive.includes(d)))
      excluded.push({metric: m.id, reason: 'native_or_non_additive_dependency'});
    else if (deps.some(d => ids.has(d) && !usable.some(u => u.id === d)))
      excluded.push({metric: m.id, reason: 'depends_on_excluded_metric'});
    else usable.push(m);
  }
  return {custom: usable, excluded};
}
const listLimit = 200;
/**
 * Compares `current` with `baseline` (two retained Overview snapshots). Refuses an ineligible pair with
 * REPORT_COMPARISON_INVALID naming each rule; rows are paged with offset/limit (total, has_more, next_offset).
 */
export function compareSnapshots(
  current: JsonObject,
  baseline: JsonObject,
  page: {offset?: number; limit?: number} = {},
): JsonObject {
  const eligibility = comparisonEligibility(current, baseline);
  if (!eligibility.eligible)
    throw new MirrorError(
      'REPORT_COMPARISON_INVALID',
      'These snapshots cannot be compared: ' + eligibility.reasons.map(r => comparisonReasons[r]).join(' '),
      {reasons: eligibility.reasons},
      409,
    );
  const offset = page.offset ?? 0,
    limit = page.limit ?? 100;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new MirrorError('INVALID_PAGE', 'Use an offset and limit of 1–500 rows.');
  const grain = current.config?.grain ?? 'total',
    singleDay = windowDays(current.config.date_range) === 1 && windowDays(baseline.config.date_range) === 1,
    {custom, excluded} = comparableCustom(current, baseline),
    customIds = new Set<string>((current.config?.custom_metrics ?? []).map((m: JsonObject) => m.id)),
    // A provider field (native_*) has no known aggregation; a custom metric is identified by its own ID.
    nativeField = (k: string) => k.startsWith('native_') && !customIds.has(k),
    requested: string[] = [...new Set<string>([...(current.config?.metrics ?? []), ...custom.map(m => m.id)])].filter(
      k => !nativeField(k),
    ),
    metrics = requested.filter(
      k => additive.includes(k) || nonAdditive.includes(k) || ratios.includes(k) || custom.some(m => m.id === k),
    ),
    excludedMetrics = [
      ...(singleDay
        ? []
        : nonAdditive.filter(k => requested.includes(k)).map(metric => ({metric, reason: 'non_additive_multi_day'}))),
      ...excluded,
      ...(current.config?.metrics ?? [])
        .filter(nativeField)
        .map((metric: string) => ({metric, reason: 'native_field_not_comparable'})),
    ];
  const now = entities(current),
    before = entities(baseline),
    rows: JsonObject[] = [],
    incompatible: JsonObject[] = [],
    onlyCurrent: JsonObject[] = [],
    onlyBaseline: JsonObject[] = [],
    groups = new Map<string, {key: JsonObject; entities: number; current: JsonObject; baseline: JsonObject}>();
  const identity = (row: JsonObject) => ({
    entity_key: entityKey(row),
    platform: row.platform,
    account_id: row.account_id,
    entity_level: row.entity_level ?? 'campaign',
    entity_id: String(row.entity_id ?? row.campaign_id),
    entity_name: row.entity_name ?? row.campaign_name ?? null,
  });
  const compareValues = (a: ReturnType<typeof totals>, b: ReturnType<typeof totals>) => {
    const out: JsonObject = {};
    const currentRatios = calculateMetrics(a.values, custom),
      baselineRatios = calculateMetrics(b.values, custom);
    for (const key of metrics) {
      if (excludedMetrics.some(x => x.metric === key)) continue;
      out[key] =
        additive.includes(key) || nonAdditive.includes(key)
          ? delta(a.exact[key] ?? null, b.exact[key] ?? null)
          : delta(scaled(currentRatios[key]), scaled(baselineRatios[key]));
    }
    return out;
  };
  for (const [id, entity] of now) {
    const prior = before.get(id),
      first = entity.rows[0]!;
    if (!prior) {
      onlyCurrent.push({...identity(first), reason: 'not_in_baseline'});
      continue;
    }
    const mismatch = [
      ...(!entity.consistent || !prior.consistent ? ['definition_changed_within_window'] : []),
      ...comparisonKeyFields.filter(k => entity.key[k] !== prior.key[k]),
    ];
    const currentWindow = windowOf(current, first),
      baselineWindow = windowOf(baseline, prior.rows[0]!);
    // Per-source windows (accounts resolved in their own time zone) must also be equal and ordered.
    if (windowDays(currentWindow) !== windowDays(baselineWindow) || baselineWindow.until >= currentWindow.since)
      mismatch.push('window');
    if (mismatch.length) {
      incompatible.push({...identity(first), reasons: mismatch});
      continue;
    }
    const a = totals(entity, singleDay),
      b = totals(prior, singleDay);
    rows.push({
      ...identity(first),
      currency: first.currency ?? null,
      timezone: first.timezone ?? null,
      attribution: first.attribution ?? null,
      result_definition: first.result_definition ?? null,
      current_window: currentWindow,
      baseline_window: baselineWindow,
      complete: {
        current: entity.rows.every(r => r.complete === true),
        baseline: prior.rows.every(r => r.complete === true),
      },
      values: compareValues(a, b),
    });
    const groupKey = JSON.stringify(entity.key),
      group = groups.get(groupKey) ?? {key: entity.key, entities: 0, current: {}, baseline: {}};
    group.entities++;
    for (const key of additive) {
      for (const [side, t] of [
        ['current', a],
        ['baseline', b],
      ] as const) {
        const prev = group[side][key];
        group[side][key] = prev === null || t.exact[key] === null ? null : (prev ?? 0n) + t.exact[key]!;
      }
    }
    groups.set(groupKey, group);
  }
  for (const [id, entity] of before)
    if (!now.has(id)) onlyBaseline.push({...identity(entity.rows[0]!), reason: 'not_in_current'});
  const groupTotals = [...groups.values()].map(g => {
    const values = (exact: JsonObject) => {
      const v: JsonObject = {};
      for (const key of additive) v[key] = exact[key] == null ? null : Number(decimal(exact[key]));
      return {values: v, exact: Object.fromEntries(additive.map(k => [k, exact[k] ?? null]))};
    };
    const a = values(g.current),
      b = values(g.baseline);
    return {
      ...g.key,
      entity_count: g.entities,
      matched_entities_only: true,
      values: compareValues(a as ReturnType<typeof totals>, b as ReturnType<typeof totals>),
    };
  });
  const sorted = rows.sort((x, y) => (x.entity_key < y.entity_key ? -1 : x.entity_key > y.entity_key ? 1 : 0));
  const snapshot = (r: JsonObject) => ({
    id: r.id,
    name: r.config?.name ?? null,
    state: r.state,
    grain: r.config?.grain ?? 'total',
    date_range: {since: r.config.date_range.since, until: r.config.date_range.until},
    window_days: windowDays(r.config.date_range),
    completed_at: r.completed_at ?? null,
  });
  return {
    current: snapshot(current),
    baseline: snapshot(baseline),
    grain,
    compatibility_key: [...comparisonKeyFields],
    metrics: metrics.filter(k => !excludedMetrics.some(x => x.metric === k)),
    excluded_metrics: excludedMetrics,
    rows: sorted.slice(offset, offset + limit),
    row_count: sorted.length,
    // The paging fields every AMCP list carries (MCP-07): total, has_more and next_offset while it is true.
    total: sorted.length,
    offset,
    has_more: offset + limit < sorted.length,
    next_offset: offset + limit < sorted.length ? offset + limit : null,
    group_totals: groupTotals,
    incompatible: incompatible.slice(0, listLimit),
    incompatible_count: incompatible.length,
    only_current: onlyCurrent.slice(0, listLimit),
    only_current_count: onlyCurrent.length,
    only_baseline: onlyBaseline.slice(0, listLimit),
    only_baseline_count: onlyBaseline.length,
    rounding: 'nine decimal places, half to even',
    limitations: [
      ...comparisonLimitations,
      ...(current.state === 'partial' || baseline.state === 'partial'
        ? ['At least one snapshot is partial; check each row’s completeness before drawing conclusions.']
        : []),
    ],
    network_requests: 0,
  };
}

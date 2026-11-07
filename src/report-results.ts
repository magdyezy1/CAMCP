import {parseProviderDecimal, providerMetricRounding} from './provider-decimal.js';
import {reportScaledText} from './report-math-v4.js';

/** Provider-owned meaning of a result. Shared code never guesses a metric from a platform or objective name. */
export interface ReportResultDefinition {
  id: string;
  metric: string;
  label: string;
  native_metric: string;
  aggregation: 'sum' | 'non_additive';
  unit: 'number' | 'currency';
  /** Some providers price a result per 1,000 reached/impressions. Native cost values already use that unit. */
  cost_multiplier?: 1 | 1000;
}
export interface ReportResultValue {
  metric: string | null;
  label: string | null;
  value: string | null;
  cost_per_result: string | null;
  definition_id: string | null;
}
export type ResultUnavailableReason =
  | 'missing_metric'
  | 'missing_goal'
  | 'mixed_goals'
  | 'unsupported_goal'
  | 'unverified_native_shape'
  | 'non_additive'
  | 'unknown_currency';
export interface ResolvedReportResult {
  definition: ReportResultDefinition | null;
  result: ReportResultValue;
  source: 'provider' | 'mapped' | 'unknown';
  cost_source: 'provider' | 'derived' | 'unknown';
  unavailable_reason: ResultUnavailableReason | null;
  rounding: Record<string, number>;
  provider_omitted?: true;
}
export interface ReportResultInput {
  value: unknown;
  spend?: unknown;
  cost_per_result?: unknown;
  value_divisor?: number;
  spend_divisor?: number;
  cost_divisor?: number;
}
export interface ReportResultContext {
  level: string;
  range: {since: string; until: string};
  objective?: unknown;
  goal?: unknown;
  event?: unknown;
  format?: unknown;
  report_options?: {result_action_type?: unknown};
}
/** A declared native field path, never an inherited property or an arbitrary object traversal. */
export function reportResultField(row: unknown, path: string): unknown {
  let current = row;
  for (const key of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || !Object.hasOwn(current, key))
      return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
/** Ordered native selectors: a required unknown selector cannot fall through to a misleading default. */
export interface ReportResultRules {
  selectors: readonly {
    field: 'goal' | 'objective' | 'format';
    required?: boolean;
    values: Readonly<Record<string, ReportResultDefinition | null>>;
  }[];
  default?: ReportResultDefinition;
}
export function selectReportResultDefinition(
  rules: ReportResultRules,
  context: {goal?: unknown; objective?: unknown; format?: unknown},
): {definition: ReportResultDefinition | null; unavailable_reason: ResultUnavailableReason | null} {
  for (const selector of rules.selectors) {
    const value = Object.hasOwn(context, selector.field) ? context[selector.field] : undefined,
      native = typeof value === 'string' && value.trim() ? value : null;
    if (native !== null && Object.hasOwn(selector.values, native)) {
      const definition = selector.values[native] ?? null;
      return {definition, unavailable_reason: definition ? null : 'unsupported_goal'};
    }
    if (selector.required)
      return {definition: null, unavailable_reason: native === null ? 'missing_goal' : 'unsupported_goal'};
  }
  return rules.default
    ? {definition: rules.default, unavailable_reason: null}
    : {definition: null, unavailable_reason: 'missing_goal'};
}
const scale = 10n ** BigInt(providerMetricRounding.places);
const unavailable = (value: unknown) =>
  value === undefined || value === null || (typeof value === 'string' && ['', '-', '--'].includes(value.trim()));
function decimal(value: unknown, field: string, rounding: Record<string, number>, divisor = 1): bigint | null {
  if (unavailable(value)) return null;
  const parsed = parseProviderDecimal(typeof value === 'string' ? value.trim() : value, {field, divisor});
  if (parsed.rounded) rounding[field] = (rounding[field] ?? 0) + 1;
  return parsed.scaled;
}
function cost(spend: bigint | null, value: bigint | null, multiplier: number, rounding: Record<string, number>) {
  if (spend === null || value === null || value === 0n) return null;
  const numerator = spend * BigInt(multiplier) * scale,
    quotient = numerator / value,
    remainder = numerator % value,
    twice = remainder * 2n;
  if (remainder !== 0n) rounding.cost_per_result = (rounding.cost_per_result ?? 0) + 1;
  return twice > value || (twice === value && quotient % 2n === 1n) ? quotient + 1n : quotient;
}
export function unavailableReportResult(reason: ResultUnavailableReason): ResolvedReportResult {
  return {
    definition: null,
    result: {metric: null, label: null, value: null, cost_per_result: null, definition_id: null},
    source: 'unknown',
    cost_source: 'unknown',
    unavailable_reason: reason,
    rounding: {},
  };
}
/** Prefer the provider's cost. Derived costs use exact arithmetic and explicitly declared units. */
export function resolveReportResult(
  definition: ReportResultDefinition,
  input: ReportResultInput,
  source: 'provider' | 'mapped',
): ResolvedReportResult {
  const rounding: Record<string, number> = {},
    value = decimal(input.value, 'result', rounding, input.value_divisor),
    nativeCost = decimal(input.cost_per_result, 'cost_per_result', rounding, input.cost_divisor),
    spend = decimal(input.spend, 'spend', rounding, input.spend_divisor),
    derived = nativeCost === null ? cost(spend, value, definition.cost_multiplier ?? 1, rounding) : null,
    selectedCost = nativeCost ?? derived;
  return {
    definition,
    result: {
      metric: definition.metric,
      label: definition.label,
      value: value === null ? null : reportScaledText(value),
      cost_per_result: selectedCost === null ? null : reportScaledText(selectedCost),
      definition_id: definition.id,
    },
    source,
    cost_source: nativeCost !== null ? 'provider' : derived !== null ? 'derived' : 'unknown',
    unavailable_reason: value === null ? 'missing_metric' : null,
    rounding,
  };
}
/** A provider's pinned mapping. A field omitted by the provider remains unknown unless its adapter applies a rule. */
export function mappedReportResult(
  rules: ReportResultRules,
  context: {goal?: unknown; objective?: unknown; format?: unknown},
  row: unknown,
  input: Omit<ReportResultInput, 'value'>,
): ResolvedReportResult {
  const selected = selectReportResultDefinition(rules, context);
  return selected.definition
    ? resolveReportResult(
        selected.definition,
        {...input, value: reportResultField(row, selected.definition.native_metric)},
        'mapped',
      )
    : unavailableReportResult(selected.unavailable_reason!);
}

export interface ReportResultGroupInput {
  resolved: ResolvedReportResult;
  currency: string | null;
  /** The collector binds the window/attribution/entity scope; different scopes never share a total. */
  scope: string;
  /** Already normalized to the account currency's major units. */
  spend: string | null;
  cost_basis?: {spend: string | null; result: string | null};
  /** Preserve native measurement coverage when an already grouped entity is grouped again. */
  coverage?: {known: number; total: number};
  cost_coverage?: {known_pairs: number; total: number};
}
export interface ReportResultGroup {
  source: 'provider' | 'mapped' | 'unknown';
  definition: ReportResultDefinition | null;
  currency: string | null;
  scope: string;
  result: ReportResultValue;
  coverage: {known: number; total: number};
  cost_coverage: {known_pairs: number; total: number};
  cost_source: 'provider' | 'derived' | 'unknown';
  cost_basis: {spend: string | null; result: string | null};
  unavailable_reason: ResultUnavailableReason | null;
  rounding: Record<string, number>;
}
/** Same definition, currency and collection scope only. Native reach/other non-additive results never add. */
export function groupReportResults(rows: ReportResultGroupInput[]): ReportResultGroup[] {
  const groups = new Map<string, ReportResultGroupInput[]>();
  for (const row of rows) {
    const d = row.resolved.definition,
      key = JSON.stringify([
        row.scope,
        row.currency,
        d?.id,
        d?.metric,
        d?.native_metric,
        d?.unit,
        d?.aggregation,
        d?.cost_multiplier ?? 1,
        d ? null : row.resolved.unavailable_reason,
      ]);
    const members = groups.get(key);
    if (members) members.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.values()].map(items => {
    const {definition, result} = items[0]!.resolved,
      {currency, scope} = items[0]!,
      rounding: Record<string, number> = {};
    let known = 0,
      pairs = 0,
      total = 0,
      value = 0n,
      pairedValue = 0n,
      pairedSpend = 0n;
    for (const row of items) {
      total += row.coverage?.total ?? 1;
      for (const [metric, count] of Object.entries(row.resolved.rounding))
        rounding[metric] = (rounding[metric] ?? 0) + count;
      const current = decimal(row.resolved.result.value, 'result', rounding),
        spend = decimal(row.cost_basis ? row.cost_basis.spend : row.spend, 'spend', rounding),
        costValue = row.cost_basis ? decimal(row.cost_basis.result, 'result', rounding) : current;
      if (current !== null) {
        known += row.coverage?.known ?? 1;
        value += current;
        if (spend !== null && costValue !== null) {
          pairs += row.cost_coverage?.known_pairs ?? 1;
          pairedValue += costValue;
          pairedSpend += spend;
        }
      }
    }
    const blocked =
        !definition || !known
          ? (items[0]!.resolved.unavailable_reason ?? 'missing_metric')
          : definition.aggregation === 'non_additive' && items.length > 1
            ? 'non_additive'
            : definition.unit === 'currency' && currency === null && items.length > 1
              ? 'unknown_currency'
              : null,
      unverified = items.some(row => row.resolved.unavailable_reason === 'unsupported_goal'),
      nativeCost = items.length === 1 ? decimal(result.cost_per_result, 'cost_per_result', rounding) : null,
      aggregateCost =
        blocked || currency === null
          ? null
          : (nativeCost ??
            (!unverified && pairs ? cost(pairedSpend, pairedValue, definition?.cost_multiplier ?? 1, rounding) : null));
    return {
      source:
        items.length === 1
          ? items[0]!.resolved.source
          : definition && known
            ? ('mapped' as const)
            : ('unknown' as const),
      definition,
      currency,
      scope,
      result: {
        ...result,
        value: blocked ? null : reportScaledText(value),
        cost_per_result: aggregateCost === null ? null : reportScaledText(aggregateCost),
      },
      coverage: {known, total},
      cost_coverage: {known_pairs: pairs, total},
      cost_basis: {
        spend: pairs ? reportScaledText(pairedSpend) : null,
        result: pairs ? reportScaledText(pairedValue) : null,
      },
      cost_source:
        aggregateCost === null ? 'unknown' : nativeCost !== null ? items[0]!.resolved.cost_source : 'derived',
      unavailable_reason: blocked ?? (unverified ? 'unsupported_goal' : null),
      rounding,
    };
  });
}

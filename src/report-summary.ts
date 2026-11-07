import {calculateMetrics, metricDefinitions} from './report-metrics.js';
import type {JsonObject} from './types.js';
import {
  calculateMetricsV4,
  evaluateReportFormulaExact,
  formulaDependencies,
  isCalculationLimit,
  roundReportValue,
  sumReportValuesV4,
  type ExactValues,
} from './report-math-v4.js';
import {groupReportResults, unavailableReportResult} from './report-results.js';

/**
 * One entry of `metrics_coverage`: the units a figure was calculated from (docs/REPORTING-OVERVIEW.md). Typed so that a
 * producer which writes another shape does not compile (F-L5-31 found three shapes, each an untyped object).
 */
export interface MetricCoverage {
  known_rows: number;
  total_rows: number;
  basis: 'report_rows' | 'native_measurements';
  report_rows: number;
  known_pairs?: number;
  unavailable_reason?: 'unknown_currency' | 'non_additive_inputs' | 'calculation_limit';
}
/**
 * The summary of a group of rows. Every entry of `metrics_coverage` has one shape (F-L5-31, docs/REPORTING-OVERVIEW.md):
 * `{known_rows, total_rows, basis, report_rows, known_pairs?, unavailable_reason?}`. `basis` says what is counted:
 * `report_rows` when each counted unit is a row of the report, `native_measurements` when a row was built from the
 * provider's own rows (daily cells), so `total_rows` can exceed `report_rows`. A ratio uses only the units that have
 * every value it needs, and a two-part one says how many with `known_pairs`.
 */
export function reportMetricsSummaryV4(group: JsonObject[], custom: JsonObject[] = []) {
  const cells: JsonObject[] = group.flatMap(row =>
      row.native?.exact_rows?.length ? row.native.exact_rows.map((metrics: JsonObject) => ({metrics})) : [row],
    ),
    basis: MetricCoverage['basis'] = group.some(row => row.native?.exact_rows?.length)
      ? 'native_measurements'
      : 'report_rows';
  const metrics: JsonObject = {},
    coverage: Record<string, MetricCoverage> = {},
    rounding: JsonObject = {},
    definitions: Record<string, JsonObject> = {
      ...metricDefinitions,
      ...Object.fromEntries(custom.map(metric => [metric.id, metric])),
    },
    baseCache = new Map<string, Set<string> | null>(),
    currencyKnown = !!group[0]!.currency && group.every(row => row.currency === group[0]!.currency);
  definitions.primary_result = {
    aggregation:
      group.every(row => row.result_context?.definition?.aggregation === 'sum') &&
      new Set(group.map(row => row.result?.definition_id)).size === 1
        ? 'sum'
        : 'non_additive',
  };
  const single = cells.length === 1 ? calculateMetricsV4(cells[0]!.metrics, custom) : undefined;
  const bases = (name: string, visiting = new Set<string>()): Set<string> | null => {
    if (baseCache.has(name)) return baseCache.get(name)!;
    const definition = definitions[name];
    if (!definition || visiting.has(name)) return null;
    if (definition.aggregation === 'sum') {
      const own = new Set([name]);
      baseCache.set(name, own);
      return own;
    }
    if (!definition.formula) {
      baseCache.set(name, null);
      return null;
    }
    const next = new Set(visiting).add(name),
      result = new Set<string>();
    for (const dependency of formulaDependencies(definition.formula)) {
      const child = bases(dependency, next);
      if (!child) {
        baseCache.set(name, null);
        return null;
      }
      for (const key of child) result.add(key);
    }
    baseCache.set(name, result);
    return result;
  };
  // Each metric is walked once: a chain in which every custom metric uses all the later ones has exponentially many
  // paths and one distinct answer per metric (F-L9-01).
  const leafCache = new Map<string, string[]>();
  const leaves = (name: string): string[] => {
    const known = leafCache.get(name);
    if (known) return known;
    const found = definitions[name]?.formula
      ? [...new Set(formulaDependencies(definitions[name]!.formula).flatMap(leaves))]
      : [name];
    leafCache.set(name, found);
    return found;
  };
  for (const [key, definition] of Object.entries(metricDefinitions)) {
    if (definition.formula) continue;
    if (definition.aggregation !== 'sum') {
      metrics[key] = null;
      continue;
    }
    const summed = sumReportValuesV4(cells.map(row => row.metrics[key])),
      currencyUnknown = definition.format === 'currency' && cells.length > 1 && !currencyKnown;
    metrics[key] = currencyUnknown ? null : summed.value;
    coverage[key] = {
      ...summed.coverage,
      basis,
      report_rows: group.length,
      ...(currencyUnknown ? {unavailable_reason: 'unknown_currency'} : {}),
    };
  }
  for (const [key, definition] of [
    ...Object.entries(metricDefinitions),
    ...custom.map(metric => [metric.id, metric] as [string, JsonObject]),
  ]) {
    if (!definition.formula) continue;
    const baseFields = bases(key),
      dependencies = baseFields === null ? leaves(key) : [...baseFields],
      additive = baseFields !== null,
      paired = cells.filter(row =>
        dependencies.every(name => row.metrics[name] !== null && row.metrics[name] !== undefined),
      ),
      unknownCurrency = !currencyKnown && dependencies.some(name => definitions[name]?.format === 'currency'),
      values: JsonObject =
        additive && paired.length && !unknownCurrency
          ? Object.fromEntries(
              dependencies.map(name => [name, sumReportValuesV4(paired.map(row => row.metrics[name])).value]),
            )
          : {};
    // A metric that depends on another starts from its exact fraction and is rounded once, on output (F-L5-20); one that
    // reaches a calculation bound is unavailable and says why (F-L9-01).
    const exact: ExactValues = new Map(),
      evaluateDependency = (name: string) => {
        if (Object.hasOwn(values, name) || exact.has(name)) return;
        const formula = definitions[name]?.formula;
        if (!formula) return;
        for (const dependency of formulaDependencies(formula)) evaluateDependency(dependency);
        exact.set(name, evaluateReportFormulaExact(formula, values, exact));
      };
    let evaluated: {value: string | null; rounded: boolean} = {value: null, rounded: false},
      limited = false;
    if (additive && paired.length && !unknownCurrency)
      try {
        for (const dependency of formulaDependencies(definition.formula)) evaluateDependency(dependency);
        evaluated = roundReportValue(evaluateReportFormulaExact(definition.formula, values, exact));
      } catch (error) {
        if (!isCalculationLimit(error)) throw error;
        limited = true;
      }
    metrics[key] = !additive && single && !unknownCurrency ? (single.metrics[key] ?? null) : evaluated.value;
    coverage[key] = {
      known_rows: paired.length,
      total_rows: cells.length,
      basis,
      report_rows: group.length,
      ...(dependencies.length === 2 ? {known_pairs: paired.length} : {}),
      ...(unknownCurrency
        ? {unavailable_reason: 'unknown_currency'}
        : !additive && !single
          ? {unavailable_reason: 'non_additive_inputs'}
          : limited || (!additive && single?.limited[key])
            ? {unavailable_reason: 'calculation_limit'}
            : {}),
    };
    if (evaluated.rounded) rounding[key] = 1;
  }
  const scope = JSON.stringify([
      group[0]!.platform,
      group[0]!.account_id,
      group.map(row => row.date_from).sort()[0],
      group
        .map(row => row.date_to)
        .sort()
        .at(-1),
      group[0]!.attribution,
      group[0]!.entity_level ?? 'campaign',
    ]),
    resultGroups = groupReportResults(
      group.flatMap(row => {
        const contexts: JsonObject[] = row.result_groups?.length
          ? row.result_groups
          : [{...row.result_context, result: row.result}];
        return contexts.map(context => ({
          resolved: context.result
            ? {
                definition: context.definition ?? null,
                result: context.result,
                source: context.source ?? 'unknown',
                cost_source: context.cost_source ?? 'unknown',
                unavailable_reason: context.unavailable_reason ?? null,
                rounding: context.rounding ?? {},
              }
            : unavailableReportResult('missing_metric'),
          scope,
          currency: row.currency ?? null,
          spend: row.metrics.spend ?? null,
          ...(context.cost_basis ? {cost_basis: context.cost_basis} : {}),
          ...(context.coverage ? {coverage: context.coverage} : {}),
          ...(context.cost_coverage ? {cost_coverage: context.cost_coverage} : {}),
        }));
      }),
    );
  const primary = resultGroups.length === 1 ? resultGroups[0]!.result : unavailableReportResult('mixed_goals').result;
  metrics.primary_result = primary.value;
  metrics.cost_per_result = primary.cost_per_result;
  if (resultGroups.length === 1) {
    const {coverage: own, cost_coverage: cost} = resultGroups[0]!;
    coverage.primary_result = {known_rows: own.known, total_rows: own.total, basis, report_rows: group.length};
    coverage.cost_per_result = {
      known_rows: cost.known_pairs,
      total_rows: cost.total,
      known_pairs: cost.known_pairs,
      basis,
      report_rows: group.length,
    };
  }
  return {
    metrics,
    metrics_coverage: coverage,
    result_groups: resultGroups,
    result: primary,
    ...(Object.keys(rounding).length
      ? {metric_calculation_rounding: {places: 9, rule: 'half_even', rounded_operations: rounding}}
      : {}),
  };
}

/** Additive totals of a group of rows; non-additive metrics (reach, frequency, users) stay null. */
function additiveValues(group: JsonObject[]) {
  const values: JsonObject = {};
  for (const [key, definition] of Object.entries(metricDefinitions)) {
    if (definition.formula) continue;
    values[key] =
      definition.aggregation === 'sum' && group.every(r => typeof r.metrics[key] === 'number')
        ? group.reduce((n, r) => n + r.metrics[key], 0)
        : null;
  }
  return values;
}
/**
 * The sorted definition ids of the result groups a row holds. A row whose ad groups disagree has no single result
 * (`result.definition_id` is null), so what it mixes is the only thing that tells two such rows apart: rows that mix
 * different results never share a summary.
 */
const resultGroupIds = (row: JsonObject): string[] =>
  Array.isArray(row.result_groups)
    ? row.result_groups.map((group: JsonObject) => String(group.definition?.id ?? '')).sort()
    : [];
/**
 * A total over rows rolled up from the selected children of a parent (F-L5-11) is not a native total of that parent, so it
 * never shares a summary with one and the summary says what it is: `aggregation.kind` is `rolled_up_from_selected`, with
 * the level it was rolled up from and the label the rows carry. A summary of native rows has no `aggregation`.
 */
const rolledUpKey = (row: JsonObject) =>
  row.aggregation?.kind === 'rolled_up' ? [row.aggregation.from_level, row.aggregation.scope_field] : null;
const summaryAggregation = (row: JsonObject): JsonObject =>
  row.aggregation?.kind === 'rolled_up'
    ? {
        aggregation: {
          kind: 'rolled_up_from_selected',
          from_level: row.aggregation.from_level,
          scope_field: row.aggregation.scope_field,
          label: row.aggregation.label,
        },
      }
    : {};
/** The most recent periods a window summary keeps for its sparkline. */
export const windowSeriesLimit = 400;
/**
 * RPT-05: one summary per account, currency, timezone, objective and measurement definition over the whole window,
 * keyed without dates. Additive metrics are totalled across every period (reach and frequency are never summed),
 * decisions are counted once per entity (grouped rows share their entity-window recommendation), and `series` holds
 * the spend of each period (by its first day), oldest first, for a sparkline. Grouped (daily, weekly, monthly) snapshots store it as
 * `window_summary`.
 */
export function reportWindowSummary(rows: JsonObject[], custom: JsonObject[] = [], v4 = false): JsonObject[] {
  const groups = new Map<string, JsonObject[]>();
  for (const row of rows) {
    const key = JSON.stringify([
      row.platform,
      row.account_id,
      row.currency,
      row.timezone,
      row.objective_group,
      row.result_definition,
      row.attribution,
      row.entity_level ?? 'campaign',
      row.native_entity_type ?? null,
      ...(v4 ? [row.result?.definition_id ?? null, resultGroupIds(row), rolledUpKey(row)] : []),
    ]);
    const members = groups.get(key);
    if (members) members.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.values()].map(group => {
    const first = group[0]!,
      periods = new Map<string, JsonObject[]>(),
      entities = new Map<string, JsonObject>();
    for (const row of group) {
      const period = row.date_from + '/' + row.date_to;
      const inPeriod = periods.get(period);
      if (inPeriod) inPeriod.push(row);
      else periods.set(period, [row]);
      const entity = String(row.entity_key ?? row.campaign_key ?? row.entity_id ?? row.campaign_id);
      if (!entities.has(entity)) entities.set(entity, row);
    }
    const ordered = [...periods.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      values = additiveValues(group),
      omitted: Record<string, number> = {};
    for (const row of group)
      for (const key of Array.isArray(row.omitted_as_zero) ? row.omitted_as_zero : [])
        if (v4 ? row.metrics[key] !== null && row.metrics[key] !== undefined : typeof values[key] === 'number')
          omitted[key] = (omitted[key] ?? 0) + 1;
    return {
      platform: first.platform,
      account_id: first.account_id,
      currency: first.currency,
      timezone: first.timezone,
      objective_group: first.objective_group,
      result_definition: first.result_definition,
      attribution: first.attribution,
      ...(v4 ? summaryAggregation(first) : {}),
      date_from: ordered[0]![1][0]!.date_from,
      date_to: ordered.at(-1)![1][0]!.date_to,
      period_count: periods.size,
      ...(first.entity_level ? {entity_level: first.entity_level, native_entity_type: first.native_entity_type} : {}),
      entity_count: entities.size,
      complete: group.every(r => r.complete),
      ...(v4 ? reportMetricsSummaryV4(group, custom) : {metrics: calculateMetrics(values, custom)}),
      ...(Object.keys(omitted).length ? {omitted_as_zero: omitted} : {}),
      decisions: [...entities.values()].reduce((counts: JsonObject, r) => {
        const k = r.recommendation?.decision ?? 'unknown';
        counts[k] = (counts[k] ?? 0) + 1;
        return counts;
      }, {}),
      series: ordered.slice(-windowSeriesLimit).map(([, rows]) => ({
        date_from: rows[0]!.date_from,
        spend: v4 ? sumReportValuesV4(rows.map(row => row.metrics.spend)).value : additiveValues(rows).spend,
      })),
    };
  });
}
/** Sum only additive columns within one account, currency and result definition. */
export function reportSummary(rows: JsonObject[], custom: JsonObject[] = [], v4 = false): JsonObject[] {
  const groups = new Map<string, JsonObject[]>();
  for (const row of rows) {
    const key = JSON.stringify([
      row.platform,
      row.account_id,
      row.currency,
      row.timezone,
      row.objective_group,
      row.result_definition,
      row.attribution,
      row.date_from,
      row.date_to,
      row.entity_level ?? 'campaign',
      row.native_entity_type ?? null,
      ...(v4 ? [row.result?.definition_id ?? null, resultGroupIds(row), rolledUpKey(row)] : []),
    ]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => {
    const first = group[0]!,
      values = additiveValues(group),
      omitted: Record<string, number> = {};
    // RPT-04: how many summed rows count a provider-omitted value as 0, per metric.
    for (const row of group)
      for (const key of Array.isArray(row.omitted_as_zero) ? row.omitted_as_zero : [])
        if (v4 ? row.metrics[key] !== null && row.metrics[key] !== undefined : typeof values[key] === 'number')
          omitted[key] = (omitted[key] ?? 0) + 1;
    return {
      platform: first.platform,
      account_id: first.account_id,
      currency: first.currency,
      timezone: first.timezone,
      objective_group: first.objective_group,
      date_from: first.date_from,
      date_to: first.date_to,
      result_definition: first.result_definition,
      attribution: first.attribution,
      ...(v4 ? summaryAggregation(first) : {}),
      ...(first.entity_level
        ? {entity_level: first.entity_level, native_entity_type: first.native_entity_type, entity_count: group.length}
        : {campaign_count: group.length}),
      complete: group.every(r => r.complete),
      ...(v4 ? reportMetricsSummaryV4(group, custom) : {metrics: calculateMetrics(values, custom)}),
      ...(Object.keys(omitted).length ? {omitted_as_zero: omitted} : {}),
      decisions: group.reduce((counts: JsonObject, r) => {
        const k = r.recommendation.decision;
        counts[k] = (counts[k] ?? 0) + 1;
        return counts;
      }, {}),
    };
  });
}

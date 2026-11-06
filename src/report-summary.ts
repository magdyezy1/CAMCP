import {calculateMetrics, metricDefinitions, parseMetricFormula} from './report-metrics.js';
import type {JsonObject} from './types.js';
import {calculateMetricsV4, evaluateReportFormulaV4, sumReportValuesV4} from './report-math-v4.js';
import {groupReportResults, unavailableReportResult} from './report-results.js';

export function reportMetricsSummaryV4(group: JsonObject[], custom: JsonObject[] = []) {
  const cells: JsonObject[] = group.flatMap(row =>
    row.native?.exact_rows?.length ? row.native.exact_rows.map((metrics: JsonObject) => ({metrics})) : [row],
  );
  const metrics: JsonObject = {},
    coverage: JsonObject = {},
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
  const single = cells.length === 1 ? calculateMetricsV4(cells[0]!.metrics, custom).metrics : undefined;
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
    for (const dependency of parseMetricFormula(definition.formula).dependencies) {
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
  const leaves = (name: string): string[] =>
    definitions[name]?.formula
      ? [...new Set(parseMetricFormula(definitions[name]!.formula).dependencies.flatMap(leaves))]
      : [name];
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
      basis: 'native_measurements',
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
    const evaluateDependency = (name: string) => {
      if (Object.hasOwn(values, name)) return;
      const formula = definitions[name]?.formula;
      if (!formula) return;
      for (const dependency of parseMetricFormula(formula).dependencies) evaluateDependency(dependency);
      values[name] = evaluateReportFormulaV4(formula, values).value;
    };
    if (additive && paired.length && !unknownCurrency)
      for (const dependency of parseMetricFormula(definition.formula).dependencies) evaluateDependency(dependency);
    const evaluated =
      additive && paired.length && !unknownCurrency
        ? evaluateReportFormulaV4(definition.formula, values)
        : {value: null, rounded: false};
    metrics[key] = !additive && single && !unknownCurrency ? (single[key] ?? null) : evaluated.value;
    coverage[key] = {
      known_rows: paired.length,
      total: cells.length,
      basis: 'native_measurements',
      report_rows: group.length,
      ...(dependencies.length === 2 ? {known_pairs: paired.length} : {}),
      ...(unknownCurrency
        ? {unavailable_reason: 'unknown_currency'}
        : !additive && !single
          ? {unavailable_reason: 'non_additive_inputs'}
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
    coverage.primary_result = {...resultGroups[0]!.coverage, basis: 'native_measurements', report_rows: group.length};
    coverage.cost_per_result = {
      ...resultGroups[0]!.cost_coverage,
      basis: 'native_measurements',
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
      ...(v4 ? [row.result?.definition_id ?? null, resultGroupIds(row)] : []),
    ]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map(group => {
    const first = group[0]!,
      periods = new Map<string, JsonObject[]>(),
      entities = new Map<string, JsonObject>();
    for (const row of group) {
      const period = row.date_from + '/' + row.date_to;
      periods.set(period, [...(periods.get(period) ?? []), row]);
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
      ...(v4 ? [row.result?.definition_id ?? null, resultGroupIds(row)] : []),
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

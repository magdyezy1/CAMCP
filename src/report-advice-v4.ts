import {MirrorError} from './errors.js';
import {
  campaignRecommendation,
  metricDefinitions,
  parseMetricFormula,
  windowRecommendations,
  type ReportAdviceMath,
} from './report-metrics.js';
import {compareReportValuesV4, evaluateReportFormulaV4, isCalculationLimit} from './report-math-v4.js';
import {reportMetricsSummaryV4} from './report-summary.js';
import type {JsonObject} from './types.js';

const math: ReportAdviceMath = {
  primaryResult: true,
  compare: compareReportValuesV4,
  formula: (formula, values) => evaluateReportFormulaV4(formula, values).value,
};
/** The legacy policy retains its context/lag/sample/authority constraints; exact v4 metrics supply its comparison inputs. */
export function recommendationV4(
  row: JsonObject,
  policy: JsonObject = {},
  custom: JsonObject[] = [],
  now = Date.now(),
): JsonObject {
  if (
    row.source_kind !== 'paid' ||
    !row.complete ||
    row.quality?.open_window ||
    row.quality?.measurement_complete === false
  )
    return campaignRecommendation(row, policy, now, math);
  const review = (reason: string) => ({...campaignRecommendation({...row, complete: false}, policy, now), reason});
  if (
    !row.result ||
    row.result.value === null ||
    row.result_context?.unavailable_reason === 'unsupported_goal' ||
    row.result_groups?.some((group: JsonObject) => group.unavailable_reason === 'unsupported_goal')
  )
    return review('Confirm this campaign’s objective and primary result metric.');
  const p =
      policy[row.campaign_key] ?? policy[row.objective_group + ':' + row.currency] ?? policy[row.objective_group] ?? {},
    definitions = {...metricDefinitions, ...Object.fromEntries(custom.map(metric => [metric.id, metric]))},
    needed = new Set<string>([
      'spend',
      'primary_result',
      'cost_per_result',
      p.kpi ?? 'cost_per_result',
      p.result_metric ?? 'primary_result',
    ]),
    numeric = {...row.metrics, primary_result: row.result.value, cost_per_result: row.result.cost_per_result};
  if (p.kpi === 'cost_per_engagement') needed.add('engagements');
  if (p.context?.secondary_kpi?.kpi) needed.add(p.context.secondary_kpi.kpi);
  // One seen set for the whole walk: every metric is expanded once, however many metrics depend on it (F-L9-01). It
  // also ends a cycle, which validation refuses before a report is saved.
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const formula = definitions[name]?.formula;
    if (!formula) return;
    for (const dependency of parseMetricFormula(formula).dependencies) {
      needed.add(dependency);
      visit(dependency);
    }
  };
  for (const name of [...needed]) visit(name);
  const coverages = [...needed].map(name => row.metrics_coverage?.[name]).filter(Boolean),
    resultCoverage = row.result_context?.coverage,
    groups: JsonObject[] = row.result_groups ?? [];
  if (
    row.metrics.spend === null ||
    row.metrics.spend === undefined ||
    (resultCoverage && resultCoverage.known < resultCoverage.total) ||
    groups.some(group => group.coverage?.known < group.coverage?.total) ||
    coverages.some(value => (value.known ?? value.known_rows ?? value.known_pairs) < value.total)
  )
    return review('Some report metrics are incomplete. Review their coverage before recommending a change.');
  try {
    for (const key of needed) {
      const value = numeric[key];
      if (value === null || value === undefined) continue;
      const exact = evaluateReportFormulaV4('v', {v: value}).value,
        number = Number(exact);
      if (
        Math.abs(number) > Number.MAX_SAFE_INTEGER ||
        !Number.isFinite(number) ||
        evaluateReportFormulaV4('v', {v: number}).value !== exact
      )
        return review('A metric exceeds supported numeric precision. Use the retained native source.');
      numeric[key] = number;
    }
    return campaignRecommendation({...row, metrics: numeric}, policy, now, math);
  } catch (error) {
    // A calculation that reaches a bound (a metric past the size limit, or the report's calculation time) holds the
    // advice like a precision loss does (F-L9-01).
    if (!(error instanceof MirrorError) || (error.code !== 'METRIC_PRECISION_LOSS' && !isCalculationLimit(error)))
      throw error;
    return review('A metric exceeds supported numeric precision. Use the retained native source.');
  }
}
/** Generic objective targets cannot silently compare unlike native result definitions. */
export function assignRecommendationsV4(
  rows: JsonObject[],
  policy: JsonObject,
  custom: JsonObject[],
  grouped: boolean,
) {
  const meanings = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = row.objective_group + ':' + row.currency,
      definitions = meanings.get(key) ?? new Set<string>();
    for (const definition of row.result_groups?.length
      ? row.result_groups.map((group: JsonObject) => group.result?.definition_id)
      : [row.result?.definition_id])
      if (definition) definitions.add(definition);
    meanings.set(key, definitions);
    row.recommendation = recommendationV4(row, policy, custom);
  }
  if (grouped) windowRecommendationsV4(rows, policy, custom);
  for (const row of rows)
    if (!policy[row.campaign_key] && (meanings.get(row.objective_group + ':' + row.currency)?.size ?? 0) > 1)
      row.recommendation = {
        ...campaignRecommendation({...row, complete: false}, policy),
        reason:
          'This objective contains different result definitions. Set a campaign-specific target before comparing costs.',
      };
  return rows;
}
export function windowRecommendationsV4(
  rows: JsonObject[],
  policy: JsonObject,
  custom: JsonObject[],
  now = Date.now(),
) {
  return windowRecommendations(rows, policy, custom, now, {
    aggregate: group => {
      const summary = reportMetricsSummaryV4(group, custom),
        one = summary.result_groups.length === 1 ? summary.result_groups[0] : undefined;
      return {...summary, result_context: one ?? {unavailable_reason: 'mixed_goals'}};
    },
    recommend: (row, targets, at) => recommendationV4(row, targets, custom, at),
  });
}

import {evaluateReportFormulaV4, sumReportValuesV4} from './report-math-v4.js';
import type {JsonObject} from './types.js';

/** Comparable delivery counts and money only: result meanings and non-additive reach are never reconciled by addition. */
const metrics = ['spend', 'impressions', 'clicks'] as const;
const order = ['campaign', 'adset', 'ad'];

/** Evidence about visible rows, separate from the provider's page/closure/completeness declarations. */
export function reportLevelReconciliation(rows: JsonObject[], packets: JsonObject[], requested: string[]) {
  const levels = order.filter(level => requested.includes(level));
  if (levels.length < 2) return [];
  const scopes = new Map<string, JsonObject[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.currency ?? null, row.timezone ?? null]);
    scopes.set(key, [...(scopes.get(key) ?? []), row]);
  }
  if (!scopes.size) scopes.set(JSON.stringify([null, null]), []);
  const comparisons: JsonObject[] = [];
  for (const [key, scoped] of scopes) {
    const [currency, timezone] = JSON.parse(key),
      totals = (level: string, metric: string) => {
        const selected = scoped.filter(row => (row.entity_level ?? 'campaign') === level),
          sum = sumReportValuesV4(selected.map(row => row.metrics[metric]));
        const coverage = selected.reduce(
          (value, row) => {
            const own = row.metrics_coverage?.[metric];
            value.known += own?.known ?? (row.metrics[metric] == null ? 0 : 1);
            value.total += own?.total ?? 1;
            return value;
          },
          {known: 0, total: 0},
        );
        return {value: metric === 'spend' && !currency ? null : sum.value, coverage};
      };
    for (let index = 1; index < levels.length; index++) {
      const baselineLevel = levels[index - 1]!,
        comparisonLevel = levels[index]!,
        baseline = packets.find(packet => packet.source.level === baselineLevel),
        comparison = packets.find(packet => packet.source.level === comparisonLevel),
        sameWindow =
          !!baseline && !!comparison && JSON.stringify(baseline.date_range) === JSON.stringify(comparison.date_range),
        collected =
          baseline?.collection_complete !== false &&
          comparison?.collection_complete !== false &&
          !baseline?.error &&
          !comparison?.error &&
          !baseline?.scope?.excluded_unknown_rows &&
          !comparison?.scope?.excluded_unknown_rows,
        differentStatuses = baseline?.scope?.excluded_status_rows > 0 || comparison?.scope?.excluded_status_rows > 0,
        differentObjectives = [baseline, comparison].some(
          packet =>
            Array.isArray(packet?.rows) &&
            packet.rows.length > rows.filter(row => (row.entity_level ?? 'campaign') === packet.source.level).length,
        ),
        derived = !!baseline?.scope?.rollup || !!comparison?.scope?.rollup;
      for (const metric of metrics) {
        const a = totals(baselineLevel, metric),
          b = totals(comparisonLevel, metric),
          unavailable = derived
            ? 'derived_parent_population'
            : !sameWindow
              ? 'different_or_unavailable_windows'
              : differentStatuses
                ? 'different_status_populations'
                : differentObjectives
                  ? 'different_objective_populations'
                  : a.value === null || b.value === null
                    ? metric === 'spend' && !currency
                      ? 'unknown_currency'
                      : 'missing_metric'
                    : null,
          partial = !collected || a.coverage.known < a.coverage.total || b.coverage.known < b.coverage.total,
          delta = unavailable ? null : evaluateReportFormulaV4('b - a', {a: a.value, b: b.value}).value;
        comparisons.push({
          metric,
          currency,
          timezone,
          basis: 'visible_rows',
          date_range: sameWindow ? baseline!.date_range : null,
          baseline: {level: baselineLevel, ...a},
          comparison: {level: comparisonLevel, ...b},
          state: unavailable ? 'unavailable' : partial ? 'partial' : delta === '0' ? 'agree' : 'gap',
          delta,
          coverage_percent: unavailable ? null : evaluateReportFormulaV4('b / a * 100', {a: a.value, b: b.value}).value,
          unavailable_reason: unavailable,
        });
      }
    }
  }
  return comparisons;
}

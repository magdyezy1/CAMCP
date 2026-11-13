import {overviewConfigV4} from './overview-v4.js';
import {chartKindIds, type ChartKind, type ChartSpec} from './report-chart-spec.js';
import {atTopLevel, topLevels, type Context} from './report-chart-kit.js';
import {objectiveCharts, spendByEntity, topAdsCharts} from './report-chart-breakdowns.js';
import {costCharts, kpiCharts, trendCharts} from './report-chart-measures.js';
import type {JsonObject} from './types.js';

/** The parts of a finished snapshot the charts are computed from. */

export interface ChartParts {
  config: JsonObject;
  state?: string;
  rows: JsonObject[];
  summary?: JsonObject[];
  window_summary?: JsonObject[];
}
export interface ChartOptions {
  /** Platform id to the name a reader knows it by ("Meta"). */
  platformNames?: Readonly<Record<string, string>>;
}

const builders: Record<ChartKind, (context: Context) => ChartSpec[]> = {
  kpi: kpiCharts,
  trend: trendCharts,
  spend_by_entity: spendByEntity,
  cost_vs_target: costCharts,
  spend_by_objective: objectiveCharts,
  top_ads: topAdsCharts,
};

/**
 * The charts of a finished snapshot, computed from its rows once and stored with it (V2-EXP-01, plan 6.1). Pure: no
 * provider, no job, no clock. Only a v4 report has charts; a snapshot from before them has none and is not recomputed.
 * A chart the report switched off (`config.charts.disabled`) is not computed.
 */
export function reportCharts(parts: ChartParts, options: ChartOptions = {}): ChartSpec[] {
  if (parts.config?.contract_version !== overviewConfigV4 || !parts.rows.length) return [];
  const disabled = new Set<string>(parts.config.charts?.disabled ?? []),
    best = topLevels(parts.rows),
    context: Context = {
      config: parts.config,
      partial: parts.state === 'partial',
      names: options.platformNames ?? {},
      rows: parts.rows,
      top: atTopLevel(parts.rows, best),
      summaries: atTopLevel(parts.window_summary ?? parts.summary ?? [], best),
    };
  return chartKindIds.flatMap(kind => (disabled.has(kind) ? [] : builders[kind as ChartKind](context)));
}

/**
 * The charts to store with a snapshot: none when it has none, and none when computing them failed. A report's charts are an
 * addition to its rows, so a chart that cannot be computed never fails the report; `onError` is told, to record it.
 */
export function reportChartsOrNone(
  parts: ChartParts,
  options: ChartOptions = {},
  onError: (error: unknown) => void = () => {},
): ChartSpec[] | undefined {
  try {
    const charts = reportCharts(parts, options);
    return charts.length ? charts : undefined;
  } catch (error) {
    onError(error);
    return undefined;
  }
}

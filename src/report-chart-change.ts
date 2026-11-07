import {compareSnapshots, comparisonEligibility} from './report-compare.js';
import {chartNote, type ChartSpec} from './report-chart-spec.js';
import type {JsonObject} from './types.js';

/** Reading the change of the key figures when a report is read (V2-EXP-01). */

const changeKeys = ['spend', 'impressions', 'clicks'];
const compareFields = [
  'platform',
  'account_id',
  'currency',
  'timezone',
  'result_definition',
  'attribution',
  'entity_level',
] as const;
/**
 * The key figures with their change since the previous period, read when the report is (the linked baseline can finish
 * after the report does). The comparison is the report comparison's (src/report-compare.ts): same grouping, windows of
 * equal length, rows matched per entity and only compared when their currency, time zone, attribution and result
 * definition agree, so a change never crosses a currency and counts only the campaigns and ads in both periods. A tile is
 * compared only when it is the only tile of its comparison group (two objectives of one account share a group, and the
 * change would be both of theirs). Without a baseline, or when the pair is not comparable, the charts are returned as they
 * are. Nothing is changed in place.
 */
export function chartsWithChange(
  charts: ChartSpec[],
  current: JsonObject,
  baseline: JsonObject | undefined,
): ChartSpec[] {
  if (!baseline || !charts.some(spec => spec.kind === 'kpi' && spec.context.compare)) return charts;
  let totals: JsonObject[];
  try {
    if (!comparisonEligibility(current, baseline).eligible) return charts;
    totals = compareSnapshots(current, baseline, {limit: 1}).group_totals;
  } catch {
    return charts;
  }
  const grain = current.config?.grain ?? 'total',
    same = (a: unknown, b: unknown) => String(a ?? '') === String(b ?? ''),
    tiles = charts.filter(spec => spec.kind === 'kpi' && spec.context.compare),
    sharing = (spec: ChartSpec) =>
      tiles.filter(other =>
        compareFields.every(field => same(other.context.compare![field], spec.context.compare![field])),
      ).length;
  return charts.map(spec => {
    if (spec.kind !== 'kpi' || !spec.context.compare || sharing(spec) !== 1) return spec;
    const group = totals.find(
      total =>
        same(total.grain, grain) && compareFields.every(field => same(total[field], spec.context.compare![field])),
    );
    if (!group) return spec;
    let changed = false;
    const series = spec.series.map(item => {
      const found = changeKeys.includes(item.key) ? group.values?.[item.key] : undefined;
      if (!found || found.baseline == null || found.delta == null) return item;
      changed = true;
      return {
        ...item,
        change: {
          baseline: String(found.baseline),
          delta: String(found.delta),
          delta_percent: found.delta_percent ?? null,
        },
      };
    });
    return changed
      ? {
          ...spec,
          series,
          notes: [...spec.notes, chartNote('The change compares the campaigns and ads that appear in both periods.')],
        }
      : spec;
  });
}

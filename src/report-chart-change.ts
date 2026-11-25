import {compareSnapshots, comparisonEligibility, comparisonPartialLimitation} from './report-compare.js';
import {valueLabel} from './report-chart-kit.js';
import {formatFixed, parseChartDecimal} from './report-chart-scale.js';
import {chartNote, type ChartChange, type ChartColumn, type ChartSeries, type ChartSpec} from './report-chart-spec.js';
import type {JsonObject} from './types.js';

/** Reading the change of the key figures when a report is read (V2-EXP-01). */

const changeKeys = ['spend', 'impressions', 'clicks'];
/** A label with the sign of its change: a minus stays, a figure that reads as zero has none, anything else gets a plus. */
const signed = (label: string) => (label.startsWith('-') || /^[0.,]+$/.test(label) ? label : '+' + label);
/** The percentage as the comparison table shows it: two places at most, half up on the exact digits, no trailing zeros. */
function percentLabel(text: string | null): string | null {
  if (text === null || !parseChartDecimal(text)) return null;
  const fixed = formatFixed(text, 2);
  return signed(fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed) + '%';
}
/** The change of one figure with the words a reader sees, or null when the exact numbers are not decimals (unknown stays unknown). */
function changeOf(item: ChartSeries, found: JsonObject): ChartChange | null {
  const baseline = String(found.baseline),
    delta = String(found.delta);
  if (!parseChartDecimal(baseline) || !parseChartDecimal(delta)) return null;
  return {
    baseline,
    delta,
    delta_percent: found.delta_percent ?? null,
    delta_label: signed(valueLabel(delta, item.unit, item.currency) ?? delta),
    percent_label: percentLabel(found.delta_percent ?? null),
  };
}
/** The columns the table of key figures gains with a change: what the tile says, for a reader of the table. */
const changeColumns: ChartColumn[] = [
  {label: 'Previous period', label_kind: 'label', type: 'decimal'},
  {label: 'Change', label_kind: 'label', type: 'decimal'},
  {label: 'Change in percent', label_kind: 'label', type: 'percent'},
];
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
  let totals: JsonObject[],
    // Whether the comparison says one of the two snapshots is partial: the change then says so too (r25-mf-jobs F1).
    partial: boolean;
  try {
    if (!comparisonEligibility(current, baseline).eligible) return charts;
    const compared = compareSnapshots(current, baseline, {limit: 1});
    totals = compared.group_totals;
    partial = compared.limitations.includes(comparisonPartialLimitation);
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
      const change = changeOf(item, found);
      if (!change) return item;
      changed = true;
      return {...item, change};
    });
    if (!changed) return spec;
    return {
      ...spec,
      series,
      notes: [
        ...spec.notes,
        chartNote('The change compares the campaigns and ads that appear in both periods.'),
        ...(partial ? [chartNote(comparisonPartialLimitation)] : []),
      ],
      // The rows of the table are the series, in order: each gains its previous value, its change and its percentage.
      table: spec.table && {
        ...spec.table,
        columns: [...spec.table.columns, ...changeColumns],
        rows: spec.table.rows.map((cells, index) => {
          const change = series[index]?.change;
          return [...cells, change?.baseline ?? null, change?.delta ?? null, change?.delta_percent ?? null];
        }),
      },
    };
  });
}

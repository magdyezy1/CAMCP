import {sumReportValuesV4} from './report-math-v4.js';
import {reportCoverageLine, reportCoverageNotes} from './report-coverage-notes.js';
import {metricSumCoverage, seriesCoverage} from './report-summary.js';
import {
  chartDecimalText,
  compareChartDecimals,
  formatChartNumber,
  formatFixed,
  parseChartDecimal,
  percentText,
  zeroBasedScale,
  type ChartDecimal,
} from './report-chart-scale.js';
import {
  boundedChartName,
  chartId,
  chartMessage,
  chartNote,
  chartNoteFromLabel,
  type ChartKind,
  type ChartMessage,
  type ChartMessageKey,
  type ChartNote,
  type ChartSpec,
  type ChartTable,
} from './report-chart-spec.js';
import type {JsonObject} from './types.js';

/**
 * What the chart builders share (V2-EXP-01): the context the charts of a snapshot are computed in, the grouping and the
 * exact decimal helpers, the two chart shapes (a ranked bar and a line over periods) and the notes every chart of a kind
 * carries.
 */

/** Entries of a bar chart beyond this are folded into Other (plan 6.1). */
export const topLimit = 10;
/** A kind with more groups than this (currencies, result definitions) charts the first ones and says so. */
export const groupLimit = 12;
export const levelRank = ['campaign', 'adset', 'ad'];

export interface Context {
  config: JsonObject;
  partial: boolean;
  names: Readonly<Record<string, string>>;
  /** Every row of the snapshot. */
  rows: JsonObject[];
  /** The rows of each source's top level: the ones that can be added up without counting a campaign and its ads twice. */
  top: JsonObject[];
  /** The summaries of the top level: whole-window totals for a grouped report, else the report's own. */
  summaries: JsonObject[];
}

export const levelOf = (row: JsonObject): string => row.entity_level ?? 'campaign';
export const sourceOf = (row: JsonObject): string => String(row.platform) + ':' + String(row.account_id);
export const entityKeyOf = (row: JsonObject): string => String(row.entity_key ?? row.campaign_key);
export const entityNameOf = (row: JsonObject): string =>
  boundedChartName(row.entity_name ?? row.campaign_name ?? row.entity_id ?? row.campaign_id);
const rolledUp = (row: JsonObject): JsonObject | null =>
  row.aggregation?.kind === 'rolled_up' ? row.aggregation : null;
/** A rolled-up total and a native total of one level never share a chart (F-L5-11). */
export const aggregationOf = (row: JsonObject): string => {
  const rolled = rolledUp(row);
  return rolled ? String(rolled.from_level) + '/' + String(rolled.scope_field) : '';
};
const rank = (row: JsonObject): number => {
  const index = levelRank.indexOf(levelOf(row));
  return index < 0 ? levelRank.length : index;
};
/** The level each source was reported at first (campaign, else ad set, else ad), as a rank. */
export function topLevels(rows: JsonObject[]): Map<string, number> {
  const best = new Map<string, number>();
  for (const row of rows) best.set(sourceOf(row), Math.min(best.get(sourceOf(row)) ?? levelRank.length, rank(row)));
  return best;
}
/** The rows (or summaries) of each source's top level: the ones that can be added up without counting a campaign and its ads twice. */
export const atTopLevel = (items: JsonObject[], best: Map<string, number>): JsonObject[] =>
  items.filter(item => rank(item) === best.get(sourceOf(item)));
export function groupRows(rows: JsonObject[], key: (row: JsonObject) => string): [string, JsonObject[]][] {
  const groups = new Map<string, JsonObject[]>();
  for (const row of rows) {
    const id = key(row),
      members = groups.get(id);
    if (members) members.push(row);
    else groups.set(id, [row]);
  }
  return [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
/** A metric as normalized decimal text, or null when the row does not have it: unknown is never zero. */
export function decimalOf(value: unknown): string | null {
  const parsed = parseChartDecimal(value);
  return parsed ? chartDecimalText(parsed) : null;
}
export const decimalIn = (text: string): ChartDecimal => parseChartDecimal(text)!;
export const compareText = (a: string, b: string) => compareChartDecimals(decimalIn(a), decimalIn(b));

const minorUnits = new Map<string, number>();
/** The minor units of an ISO 4217 currency (USD 2, KWD 3, JPY 0); 2 when the code is not one the runtime knows. */
function currencyDigits(currency: string): number {
  let digits = minorUnits.get(currency);
  if (digits === undefined) {
    try {
      digits = new Intl.NumberFormat('en', {style: 'currency', currency}).resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
      digits = 2;
    }
    minorUnits.set(currency, digits);
  }
  return digits;
}
/** An amount as a reader sees it: grouped thousands, the currency's minor units, the code after it. */
export const amountText = (value: string, currency: string | null): string =>
  currency ? formatFixed(value, currencyDigits(currency)) + ' ' + currency : formatChartNumber(value);
/** A value as a bar or a point is labelled: the amount without its code (a unit names it), or a grouped number. */
export const valueLabel = (
  value: string | null,
  unit: 'currency' | 'number',
  currency: string | null,
): string | null =>
  value === null
    ? null
    : unit === 'currency' && currency
      ? formatFixed(value, currencyDigits(currency))
      : formatChartNumber(value);

export const metricLabels: Record<string, ChartMessageKey> = {
  spend: 'Spend',
  impressions: 'Impressions',
  clicks: 'Clicks',
  primary_result: 'Results',
  cost_per_result: 'Cost per result',
};
/** The coverage of a group's figures in the shared helper's words (F-L5-01): "Spend: 26 of 28 rows". */
export function coverageNotes(group: JsonObject[], metrics: string[]): ChartNote[] {
  const source = {
    metrics_coverage: Object.fromEntries(metrics.map(metric => [metric, metricSumCoverage(group, metric)])),
  };
  return reportCoverageNotes(source, metrics).map(note => ({
    kind: 'coverage' as const,
    ...note,
    text: reportCoverageLine(note, metricLabels[note.metric] ?? note.metric, 'en'),
  }));
}
/**
 * What every chart of a group says about where its rows come from: the label of a total rolled up from selected children
 * (on a row, and on a summary of such rows), and that the report is partial.
 */
export function groupNotes(context: Context, group: JsonObject[]): ChartNote[] {
  const label = group[0]!.aggregation?.label;
  return [
    ...(label ? [chartNoteFromLabel(String(label))] : []),
    ...(context.partial
      ? [chartNote('This report is partial: totals leave out the sources or periods that are missing.')]
      : []),
  ];
}

export interface Entry {
  key: string;
  label: string;
  detail?: string;
  value: string | null;
}
/** Known entries, largest first (ties by key, so the order never depends on the rows' order). */
export function ranked(entries: Entry[]): Entry[] {
  return entries
    .filter(entry => entry.value !== null)
    .sort((a, b) => compareText(b.value!, a.value!) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
export interface Shown extends Entry {
  other?: true;
}
/** The top entries and the exact sum of the rest as one "Other" entry. */
function foldTop(known: Entry[]): {shown: Shown[]; folded: number} {
  if (known.length <= topLimit) return {shown: known, folded: 0};
  const rest = known.slice(topLimit),
    other: Shown = {
      key: 'other',
      label: 'Other',
      value: sumReportValuesV4(rest.map(entry => entry.value)).value,
      other: true,
    };
  return {shown: [...known.slice(0, topLimit), other], folded: rest.length};
}

interface BarInput {
  id: string;
  kind: ChartKind;
  title: ChartMessageKey;
  context: ChartSpec['context'];
  entries: Entry[];
  entityColumn: ChartMessageKey;
  measure: 'spend' | 'primary_result' | 'cost_per_result';
  seriesName: ChartMessageKey;
  unit: 'currency' | 'number';
  currency: string | null;
  notes: ChartNote[];
  /** False shows only the top ten (a ranking); the default folds the rest into Other (a breakdown of a whole). */
  fold?: boolean;
  /** The sentence for the largest entry; by default its share of the exact total, for a spend chart. */
  takeaway?: (top: Shown) => ChartMessage | null;
}
/**
 * A ranked bar chart: bars from zero on one axis, the top ten and the rest as Other, a value at the tip of every bar, the
 * table of the same rows with each share of the exact total. A chart that cannot honestly be drawn (one entry, a value
 * below zero, nothing known) keeps its table and says why.
 */
export function barChart(input: BarInput): ChartSpec {
  const known = ranked(input.entries),
    {shown, folded}: {shown: Shown[]; folded: number} =
      input.fold === false ? {shown: known.slice(0, topLimit), folded: 0} : foldTop(known),
    values = shown.map(entry => entry.value),
    negative = known.some(entry => decimalIn(entry.value!).units < 0n),
    total = sumReportValuesV4(known.map(entry => entry.value)).value,
    withShare = input.measure === 'spend',
    shareOf = (value: string | null): string | null =>
      !negative && value !== null && total !== null ? percentText(decimalIn(value), decimalIn(total), 1) : null,
    notes = [...input.notes];
  const table: ChartTable = {
    columns: [
      {label: input.entityColumn, label_kind: 'label', type: 'text', cell_kind: 'entity'},
      {
        label: input.seriesName,
        label_kind: 'label',
        type: input.unit === 'currency' ? 'currency' : 'decimal',
        currency: input.currency,
      },
      ...(withShare ? [{label: 'Share of spend', label_kind: 'label' as const, type: 'percent' as const}] : []),
    ],
    rows: (known.length ? shown : input.entries.slice(0, topLimit)).map(entry => [
      entry.label,
      entry.value,
      ...(withShare ? [shareOf(entry.value)] : []),
    ]),
    ...(shown.some(entry => entry.other) ? {other: shown.length - 1} : {}),
  };
  const base: ChartSpec = {
    id: input.id,
    kind: input.kind,
    type: 'bar',
    title: chartMessage(input.title),
    takeaway: null,
    context: input.context,
    x: null,
    series: [],
    scale: null,
    notes,
    table,
    drawn: false,
  };
  if (!known.length) {
    notes.unshift(chartNote('No value is known, so there is nothing to draw.'));
    return base;
  }
  if (negative) {
    notes.unshift(chartNote('Values below zero cannot be drawn from a zero baseline. The table has them.'));
    return base;
  }
  if (known.length < 2) {
    notes.unshift(chartNote('There is only one entry, so there is nothing to compare. The table has it.'));
    return base;
  }
  if (folded) notes.unshift(chartNote('The smaller entries are combined as Other: {count}.', {count: String(folded)}));
  const top = shown[0]!,
    topShare = shareOf(top.value);
  return {
    ...base,
    takeaway: input.takeaway
      ? input.takeaway(top)
      : withShare && topShare !== null && total !== null
        ? chartMessage('The largest share of spend is {name}: {share} of {total}.', {
            name: top.label,
            share: topShare + '%',
            total: amountText(total, input.currency),
          })
        : null,
    x: {
      kind: 'category',
      items: shown.map(entry => ({
        key: entry.key,
        label: entry.label,
        ...(entry.detail ? {detail: entry.detail} : {}),
        ...(entry.other ? {other: true as const} : {}),
      })),
    },
    series: [
      {
        key: input.measure,
        name: input.seriesName,
        name_kind: 'label',
        unit: input.unit,
        currency: input.currency,
        values,
        value_labels: values.map(value => valueLabel(value, input.unit, input.currency)),
        color_index: input.measure === 'spend' ? 0 : input.measure === 'primary_result' ? 1 : 2,
        label_at: values.map((_, index) => index),
      },
    ],
    scale: zeroBasedScale(
      decimalIn(values.reduce<string>((max, value) => (compareText(value!, max) > 0 ? value! : max), '0')),
    ),
    drawn: true,
  };
}

export const levelTitles: Record<string, ChartMessageKey> = {
  campaign: 'Spend by campaign',
  adset: 'Spend by ad set or ad group',
  ad: 'Spend by ad',
};
export const levelColumns: Record<string, ChartMessageKey> = {
  campaign: 'Campaign',
  adset: 'Ad set or ad group',
  ad: 'Ad',
};

/** The rows with a known currency, in groups of one currency and one kind of total; how many rows had none. */
export function pricedGroups(rows: JsonObject[]) {
  const priced = rows.filter(row => row.currency);
  return {
    groups: groupRows(priced, row => `${row.currency}|${aggregationOf(row)}`).map(([, group]) => group),
    unpriced: rows.length - priced.length,
  };
}
/** The note that says each currency has its own chart, when a kind has more than one. */
function currencyNote(specs: ChartSpec[]): ChartNote[] {
  const currencies = [
    ...new Set(specs.map(spec => spec.context.currency).filter((value): value is string => !!value)),
  ].sort();
  return currencies.length > 1
    ? [
        chartNote(
          'Each currency has its own chart ({currencies}). Amounts in different currencies are never combined.',
          {
            currencies: currencies.join(', '),
          },
        ),
      ]
    : [];
}
/** A chart that is not drawn because nothing in the report could be: only its note. */
export function omitted(kind: ChartKind, title: ChartMessageKey, note: ChartNote): ChartSpec {
  return {
    id: chartId(kind, 'omitted'),
    kind,
    type: 'bar',
    title: chartMessage(title),
    takeaway: null,
    context: {},
    x: null,
    series: [],
    scale: null,
    notes: [note],
    table: null,
    drawn: false,
  };
}
/**
 * Caps the charts of a kind, adds the notes every chart of the kind shares (each currency has its own chart) and says
 * once that rows without a currency are not charted.
 */
export function finishKind(specs: ChartSpec[], unpriced: number): ChartSpec[] {
  const kept = specs.slice(0, groupLimit),
    shared = currencyNote(kept);
  for (const spec of kept) spec.notes.push(...shared);
  if (unpriced && kept[0]) kept[0].notes.push(chartNote('Amounts without a known currency are not charted.'));
  if (specs.length > kept.length)
    kept.at(-1)!.notes.push(
      chartNote('Only the first {count} groups are charted. The report table has the rest.', {
        count: String(kept.length),
      }),
    );
  return kept;
}

interface LineInput {
  id: string;
  title: ChartMessageKey;
  context: ChartSpec['context'];
  periods: string[];
  values: (string | null)[];
  short: ({known: number; total: number; unit: 'rows' | 'measurements'} | null)[];
  measure: 'spend' | 'primary_result';
  unit: 'currency' | 'number';
  currency: string | null;
  highest:
    | 'Spend was highest in the period starting {date}: {value}.'
    | 'Results were highest in the period starting {date}: {value}.';
  notes: ChartNote[];
}
/**
 * A line over periods, from zero, on one axis. A period with no row is a gap and a period calculated from some of its rows
 * is a short point, drawn hollow and off the line, so a week with one unknown campaign never reads as a dip (F-L5-26). The
 * highest period named is the highest whole one. A line of fewer than two known periods is not drawn.
 */
export function lineChart(input: LineInput): ChartSpec {
  const known = input.values.flatMap((value, index) => (value === null ? [] : [{value, index}])),
    negative = known.some(point => decimalIn(point.value).units < 0n),
    anyShort = input.short.some(Boolean),
    notes = [...input.notes],
    table: ChartTable = {
      columns: [
        {label: 'Period', label_kind: 'label', type: 'date'},
        {
          label: input.measure === 'spend' ? 'Spend' : 'Results',
          label_kind: 'label',
          type: input.unit === 'currency' ? 'currency' : 'decimal',
          currency: input.currency,
        },
        ...(anyShort
          ? [{label: 'Rows with a value' as const, label_kind: 'label' as const, type: 'text' as const}]
          : []),
      ],
      rows: input.periods.map((period, index) => [
        period,
        input.values[index] ?? null,
        ...(anyShort ? [input.short[index] ? `${input.short[index]!.known}/${input.short[index]!.total}` : null] : []),
      ]),
    },
    base: ChartSpec = {
      id: input.id,
      kind: 'trend',
      type: 'line',
      title: chartMessage(input.title),
      takeaway: null,
      context: input.context,
      x: null,
      series: [],
      scale: null,
      notes,
      table,
      drawn: false,
    };
  if (!known.length) {
    notes.unshift(chartNote('No value is known, so there is nothing to draw.'));
    return base;
  }
  if (negative) {
    notes.unshift(chartNote('Values below zero cannot be drawn from a zero baseline. The table has them.'));
    return base;
  }
  if (known.length < 2) {
    notes.unshift(chartNote('There is only one entry, so there is nothing to compare. The table has it.'));
    return base;
  }
  let peak: {value: string; index: number} | null = null;
  for (const point of known)
    if (!input.short[point.index] && (!peak || compareText(point.value, peak.value) > 0)) peak = point;
  const shortCount = input.short.filter(Boolean).length,
    last = known.at(-1)!;
  if (shortCount)
    notes.unshift(
      chartNote('Hollow marks are periods calculated from some of their rows only: {count}.', {
        count: String(shortCount),
      }),
    );
  return {
    ...base,
    takeaway: peak
      ? chartMessage(input.highest, {date: input.periods[peak.index]!, value: amountOrNumber(peak.value, input)})
      : null,
    x: {kind: 'time', items: input.periods.map(period => ({key: period, label: period}))},
    series: [
      {
        key: input.measure,
        name: input.measure === 'spend' ? 'Spend' : 'Results',
        name_kind: 'label',
        unit: input.unit,
        currency: input.currency,
        values: input.values,
        value_labels: input.values.map(value => valueLabel(value, input.unit, input.currency)),
        color_index: input.measure === 'spend' ? 0 : 1,
        label_at: [...new Set([...(peak ? [peak.index] : []), last.index])].sort((a, b) => a - b),
        short: input.short,
      },
    ],
    scale: zeroBasedScale(
      decimalIn(known.reduce<string>((max, point) => (compareText(point.value, max) > 0 ? point.value : max), '0')),
    ),
    drawn: true,
  };
}
export const amountOrNumber = (value: string, input: {unit: 'currency' | 'number'; currency: string | null}) =>
  input.unit === 'currency' ? amountText(value, input.currency) : formatChartNumber(value);
/** The value of a metric over each period, with the periods calculated from some of their rows marked short. */
export function periodValues(group: JsonObject[], periods: string[], metric: 'spend' | 'primary_result') {
  const byPeriod = new Map(groupRows(group, row => String(row.date_from)));
  return periods.map(period => {
    const rows = byPeriod.get(period);
    if (!rows) return {value: null, short: null};
    const value = sumReportValuesV4(rows.map(row => decimalOf(row.metrics?.[metric]))).value,
      coverage = seriesCoverage(rows, metric).coverage;
    return {
      value,
      short:
        coverage && coverage.known_rows > 0
          ? {
              known: coverage.known_rows,
              total: coverage.total_rows,
              unit: coverage.basis === 'native_measurements' ? ('measurements' as const) : ('rows' as const),
            }
          : null,
    };
  });
}

/** Said once on each chart of a kind that holds several result definitions: each has its own chart. */
export function definitionNotes(specs: ChartSpec[]): void {
  const definitions = [...new Set(specs.flatMap(spec => (spec.context.result ? [spec.context.result] : [])))].sort();
  if (definitions.length > 1)
    for (const spec of specs)
      if (spec.context.result)
        spec.notes.push(
          chartNote('Each result definition has its own chart ({definitions}). Different results are never added.', {
            definitions: definitions.join(', '),
          }),
        );
}

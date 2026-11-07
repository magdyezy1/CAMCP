import {overviewConfigV4} from './overview-v4.js';
import {evaluateReportFormulaV4, sumReportValuesV4} from './report-math-v4.js';
import {reportCoverageLine, reportCoverageNotes} from './report-coverage-notes.js';
import {metricSumCoverage, seriesCoverage} from './report-summary.js';
import {
  assignChartColors,
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
  chartKindIds,
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

/** Entries of a bar chart beyond this are folded into Other (plan 6.1). */
const topLimit = 10;
/** A kind with more groups than this (currencies, result definitions) charts the first ones and says so. */
const groupLimit = 12;
const levelRank = ['campaign', 'adset', 'ad'];

interface Context {
  config: JsonObject;
  partial: boolean;
  names: Readonly<Record<string, string>>;
  /** Every row of the snapshot. */
  rows: JsonObject[];
  /** The rows of each source's top level: the ones that can be added up without counting a campaign and its ads twice. */
  top: JsonObject[];
}

const levelOf = (row: JsonObject): string => row.entity_level ?? 'campaign';
const sourceOf = (row: JsonObject): string => String(row.platform) + ':' + String(row.account_id);
const entityKeyOf = (row: JsonObject): string => String(row.entity_key ?? row.campaign_key);
const entityNameOf = (row: JsonObject): string =>
  boundedChartName(row.entity_name ?? row.campaign_name ?? row.entity_id ?? row.campaign_id);
const rolledUp = (row: JsonObject): JsonObject | null =>
  row.aggregation?.kind === 'rolled_up' ? row.aggregation : null;
/** A rolled-up total and a native total of one level never share a chart (F-L5-11). */
const aggregationOf = (row: JsonObject): string => {
  const rolled = rolledUp(row);
  return rolled ? String(rolled.from_level) + '/' + String(rolled.scope_field) : '';
};
const rank = (row: JsonObject): number => {
  const index = levelRank.indexOf(levelOf(row));
  return index < 0 ? levelRank.length : index;
};
/** The rows of the level each source was reported at first (campaign, else ad set, else ad). */
function topLevelRows(rows: JsonObject[]): JsonObject[] {
  const best = new Map<string, number>();
  for (const row of rows) best.set(sourceOf(row), Math.min(best.get(sourceOf(row)) ?? levelRank.length, rank(row)));
  return rows.filter(row => rank(row) === best.get(sourceOf(row)));
}
function groupRows(rows: JsonObject[], key: (row: JsonObject) => string): [string, JsonObject[]][] {
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
function decimalOf(value: unknown): string | null {
  const parsed = parseChartDecimal(value);
  return parsed ? chartDecimalText(parsed) : null;
}
const decimalIn = (text: string): ChartDecimal => parseChartDecimal(text)!;
const compareText = (a: string, b: string) => compareChartDecimals(decimalIn(a), decimalIn(b));

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
const amountText = (value: string, currency: string | null): string =>
  currency ? formatFixed(value, currencyDigits(currency)) + ' ' + currency : formatChartNumber(value);

const metricLabels: Record<string, ChartMessageKey> = {
  spend: 'Spend',
  impressions: 'Impressions',
  clicks: 'Clicks',
  primary_result: 'Results',
  cost_per_result: 'Cost per result',
};
/** The coverage of a group's figures in the shared helper's words (F-L5-01): "Spend: 26 of 28 rows". */
function coverageNotes(group: JsonObject[], metrics: string[]): ChartNote[] {
  const source = {
    metrics_coverage: Object.fromEntries(metrics.map(metric => [metric, metricSumCoverage(group, metric)])),
  };
  return reportCoverageNotes(source, metrics).map(note => ({
    kind: 'coverage' as const,
    ...note,
    text: reportCoverageLine(note, metricLabels[note.metric] ?? note.metric, 'en'),
  }));
}
/** What every chart of a group says about where its rows come from: a rolled-up label, a partial report. */
function groupNotes(context: Context, group: JsonObject[]): ChartNote[] {
  const rolled = rolledUp(group[0]!);
  return [
    ...(rolled?.label ? [chartNoteFromLabel(String(rolled.label))] : []),
    ...(context.partial
      ? [chartNote('This report is partial: totals leave out the sources or periods that are missing.')]
      : []),
  ];
}

interface Entry {
  key: string;
  label: string;
  detail?: string;
  value: string | null;
}
/** Known entries, largest first (ties by key, so the order never depends on the rows' order). */
function ranked(entries: Entry[]): Entry[] {
  return entries
    .filter(entry => entry.value !== null)
    .sort((a, b) => compareText(b.value!, a.value!) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
interface Shown extends Entry {
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
function barChart(input: BarInput): ChartSpec {
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

const levelTitles: Record<string, ChartMessageKey> = {
  campaign: 'Spend by campaign',
  adset: 'Spend by ad set or ad group',
  ad: 'Spend by ad',
};
const levelColumns: Record<string, ChartMessageKey> = {campaign: 'Campaign', adset: 'Ad set or ad group', ad: 'Ad'};

/** The rows with a known currency, in groups of one currency and one kind of total; how many rows had none. */
function pricedGroups(rows: JsonObject[]) {
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
function omitted(kind: ChartKind, title: ChartMessageKey, note: ChartNote): ChartSpec {
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
function finishKind(specs: ChartSpec[], unpriced: number): ChartSpec[] {
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

function spendByEntity(context: Context): ChartSpec[] {
  const {groups, unpriced} = pricedGroups(context.top),
    specs: ChartSpec[] = [];
  if (!groups.length)
    return unpriced
      ? [
          omitted(
            'spend_by_entity',
            'Spend by campaign',
            chartNote('Amounts without a known currency are not charted.'),
          ),
        ]
      : [];
  for (const group of groups) {
    const currency = String(group[0]!.currency),
      platforms = groupRows(group, row => String(row.platform));
    if (platforms.length > 1)
      specs.push(
        barChart({
          id: chartId('spend_by_entity', 'platform', currency, aggregationOf(group[0]!)),
          kind: 'spend_by_entity',
          title: 'Spend by platform',
          context: {currency},
          entries: platforms.map(([platform, rows]) => ({
            key: platform,
            label: context.names[platform] ?? platform,
            value: sumReportValuesV4(rows.map(row => decimalOf(row.metrics?.spend))).value,
          })),
          entityColumn: 'Platform',
          measure: 'spend',
          seriesName: 'Spend',
          unit: 'currency',
          currency,
          notes: [...coverageNotes(group, ['spend']), ...groupNotes(context, group)],
        }),
      );
    for (const [level, rows] of groupRows(group, levelOf)) {
      const severalSources = new Set(rows.map(sourceOf)).size > 1;
      specs.push(
        barChart({
          id: chartId('spend_by_entity', level, currency, aggregationOf(rows[0]!)),
          kind: 'spend_by_entity',
          title: levelTitles[level] ?? 'Spend by campaign',
          context: {currency, level},
          entries: groupRows(rows, entityKeyOf).map(([key, members]) => ({
            key,
            label: entityNameOf(members[0]!),
            ...(severalSources
              ? {
                  detail:
                    (context.names[String(members[0]!.platform)] ?? String(members[0]!.platform)) +
                    ' · ' +
                    String(members[0]!.account_id),
                }
              : {}),
            value: sumReportValuesV4(members.map(row => decimalOf(row.metrics?.spend))).value,
          })),
          entityColumn: levelColumns[level] ?? 'Campaign',
          measure: 'spend',
          seriesName: 'Spend',
          unit: 'currency',
          currency,
          notes: [...coverageNotes(rows, ['spend']), ...groupNotes(context, rows)],
        }),
      );
    }
  }
  return finishKind(specs, unpriced);
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
function lineChart(input: LineInput): ChartSpec {
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
const amountOrNumber = (value: string, input: {unit: 'currency' | 'number'; currency: string | null}) =>
  input.unit === 'currency' ? amountText(value, input.currency) : formatChartNumber(value);
/** The value of a metric over each period, with the periods calculated from some of their rows marked short. */
function periodValues(group: JsonObject[], periods: string[], metric: 'spend' | 'primary_result') {
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
function trendCharts(context: Context): ChartSpec[] {
  if ((context.config.grain ?? 'total') === 'total') return [];
  const periods = [...new Set(context.top.map(row => String(row.date_from)))].sort();
  if (periods.length < 2)
    return [
      omitted(
        'trend',
        'Spend over time',
        chartNote('A trend needs at least two periods; this report has {count}.', {count: String(periods.length)}),
      ),
    ];
  const specs: ChartSpec[] = [],
    {groups, unpriced: unpricedSpend} = pricedGroups(context.top);
  // Nothing priced at all: the spend chart is the one that says why it is missing.
  if (!groups.length && unpricedSpend)
    specs.push(omitted('trend', 'Spend over time', chartNote('Amounts without a known currency are not charted.')));
  for (const group of groups) {
    const currency = String(group[0]!.currency),
      series = periodValues(group, periods, 'spend');
    specs.push(
      lineChart({
        id: chartId('trend', 'spend', currency, aggregationOf(group[0]!)),
        title: 'Spend over time',
        context: {currency},
        periods,
        values: series.map(point => point.value),
        short: series.map(point => point.short),
        measure: 'spend',
        unit: 'currency',
        currency,
        highest: 'Spend was highest in the period starting {date}: {value}.',
        notes: [...coverageNotes(group, ['spend']), ...groupNotes(context, group)],
      }),
    );
  }
  const resolved = context.top.filter(row => row.result?.definition_id && row.result_context?.definition),
    unresolved = context.top.length - resolved.length;
  let unpricedResults = 0;
  const resultSpecs: ChartSpec[] = [];
  for (const [, group] of groupRows(resolved, row => {
    const definition = row.result_context.definition;
    return `${definition.id}|${definition.unit === 'currency' ? (row.currency ?? '') : ''}|${aggregationOf(row)}`;
  })) {
    const definition = group[0]!.result_context.definition,
      currency = definition.unit === 'currency' ? (group[0]!.currency ? String(group[0]!.currency) : null) : null;
    if (definition.unit === 'currency' && !currency) {
      unpricedResults += group.length;
      continue;
    }
    const series = periodValues(group, periods, 'primary_result');
    resultSpecs.push(
      lineChart({
        id: chartId('trend', 'results', String(definition.id), currency, aggregationOf(group[0]!)),
        title: 'Results over time',
        context: {...(currency ? {currency} : {}), result: String(definition.label)},
        periods,
        values: series.map(point => point.value),
        short: series.map(point => point.short),
        measure: 'primary_result',
        unit: definition.unit === 'currency' ? 'currency' : 'number',
        currency,
        highest: 'Results were highest in the period starting {date}: {value}.',
        notes: [
          ...(unresolved
            ? [
                chartNote('Rows with no single result definition are left out of this chart: {count}.', {
                  count: String(unresolved),
                }),
              ]
            : []),
          ...coverageNotes(group, ['primary_result']),
          ...groupNotes(context, group),
        ],
      }),
    );
  }
  definitionNotes(resultSpecs);
  return finishKind([...specs, ...resultSpecs], (groups.length ? unpricedSpend : 0) + unpricedResults);
}

/**
 * The target a row's cost per result is compared with, as the recommendation holds it (src/report-advice-v4.ts): the
 * campaign's own target, else the currency's for its objective, else the objective's. A target is usable only in the row's
 * currency and for the cost per result, and an objective's target does not compare unlike results: where the objective
 * holds more than one result definition only a target set for the campaign itself counts.
 */
function targetOf(row: JsonObject, policy: JsonObject, definitionsOf: Map<string, Set<string>>): string | null {
  const own = policy[row.campaign_key],
    objective = `${row.objective_group}:${row.currency}`,
    chosen = own ?? policy[objective] ?? policy[row.objective_group];
  if (!chosen || typeof chosen !== 'object' || chosen.currency !== row.currency) return null;
  if (chosen.kpi !== undefined && chosen.kpi !== 'cost_per_result') return null;
  if (!own && (definitionsOf.get(objective)?.size ?? 0) > 1) return null;
  const value = decimalOf(chosen.target);
  return value !== null && decimalIn(value).units > 0n ? value : null;
}
/**
 * An entity's cost per result: the platform's own (or derived) cost when it has one row, otherwise its spend over its
 * results, counting only the rows that have both, with the definition's price unit (some results are priced per 1,000).
 */
function entityCost(rows: JsonObject[]): string | null {
  if (rows.length === 1) return decimalOf(rows[0]!.result?.cost_per_result);
  const paired = rows.filter(row => decimalOf(row.metrics?.spend) !== null && decimalOf(row.result?.value) !== null),
    result = sumReportValuesV4(paired.map(row => decimalOf(row.result.value))).value,
    spend = sumReportValuesV4(paired.map(row => decimalOf(row.metrics.spend))).value;
  if (result === null || spend === null) return null;
  const factor = String(rows[0]!.result_context?.definition?.cost_multiplier ?? 1);
  return evaluateReportFormulaV4('spend * factor / result', {spend, factor, result}).value;
}
/** The coverage of a ratio in the shared helper's words: the rows that have every value it needs, of all of them. */
function ratioCoverageNotes(rows: JsonObject[], metric: 'cost_per_result'): ChartNote[] {
  const pairs = rows.filter(
      row => decimalOf(row.metrics?.spend) !== null && decimalOf(row.result?.value) !== null,
    ).length,
    source = {
      metrics_coverage: {
        [metric]: {
          known_rows: pairs,
          total_rows: rows.length,
          basis: 'report_rows',
          report_rows: rows.length,
          known_pairs: pairs,
        },
      },
    };
  return reportCoverageNotes(source, [metric]).map(note => ({
    kind: 'coverage' as const,
    ...note,
    text: reportCoverageLine(note, metricLabels[note.metric] ?? note.metric, 'en'),
  }));
}
function costCharts(context: Context): ChartSpec[] {
  const policy: JsonObject = context.config.targets ?? {},
    eligible = context.top.filter(
      row =>
        row.currency &&
        row.result?.definition_id &&
        row.result_context?.definition &&
        row.result_context.definition.unit !== 'currency',
    );
  if (!eligible.length) return [];
  // The result definitions each objective and currency holds, over every row, as the recommendation counts them.
  const definitionsOf = new Map<string, Set<string>>();
  for (const row of context.rows) {
    const key = `${row.objective_group}:${row.currency}`,
      ids = definitionsOf.get(key) ?? new Set<string>();
    for (const id of row.result_groups?.length
      ? row.result_groups.map((group: JsonObject) => group.result?.definition_id)
      : [row.result?.definition_id])
      if (id) ids.add(String(id));
    definitionsOf.set(key, ids);
  }
  const specs: ChartSpec[] = [];
  for (const [, group] of groupRows(
    eligible,
    row => `${row.result_context.definition.id}|${row.currency}|${aggregationOf(row)}`,
  )) {
    const definition = group[0]!.result_context.definition,
      currency = String(group[0]!.currency),
      level = levelOf(group[0]!),
      entities = groupRows(group, entityKeyOf)
        .map(([key, rows]) => ({
          key,
          rows,
          target: targetOf(rows[0]!, policy, definitionsOf),
          spend: sumReportValuesV4(rows.map(row => decimalOf(row.metrics?.spend))).value,
        }))
        .filter(entity => entity.target !== null);
    if (!entities.length) continue;
    // The ten with the most spend; the cost of the rest is in the report's table.
    const byspend = [...entities].sort(
        (a, b) =>
          (a.spend === null ? 1 : 0) - (b.spend === null ? 1 : 0) ||
          (a.spend !== null && b.spend !== null ? compareText(b.spend, a.spend) : 0) ||
          (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
      ),
      shown = byspend.slice(0, topLimit).map(entity => ({...entity, cost: entityCost(entity.rows)})),
      withCost = shown.filter(entity => entity.cost !== null).sort((a, b) => compareText(b.cost!, a.cost!)),
      listed = [...withCost, ...shown.filter(entity => entity.cost === null)],
      severalSources = new Set(group.map(sourceOf)).size > 1,
      atOrUnder = withCost.filter(entity => compareText(entity.cost!, entity.target!) <= 0).length,
      values = listed.map(entity => entity.cost),
      targets = listed.map(entity => entity.target),
      notes: ChartNote[] = [
        ...(byspend.length > shown.length
          ? [
              chartNote('Only the {count} entries with the most spend are shown. The report table has the rest.', {
                count: String(shown.length),
              }),
            ]
          : []),
        ...ratioCoverageNotes(
          shown.flatMap(entity => entity.rows),
          'cost_per_result',
        ),
        ...groupNotes(context, group),
      ];
    const table: ChartTable = {
      columns: [
        {label: levelColumns[level] ?? 'Campaign', label_kind: 'label', type: 'text', cell_kind: 'entity'},
        {label: 'Cost per result', label_kind: 'label', type: 'currency', currency},
        {label: 'Target', label_kind: 'label', type: 'currency', currency},
        {label: 'Against target', label_kind: 'label', type: 'text', cell_kind: 'label'},
      ],
      rows: listed.map(entity => [
        entityNameOf(entity.rows[0]!),
        entity.cost,
        entity.target,
        entity.cost === null
          ? null
          : compareText(entity.cost, entity.target!) <= 0
            ? 'At or under target'
            : 'Over target',
      ]),
    };
    const base: ChartSpec = {
      id: chartId('cost_vs_target', String(definition.id), currency, aggregationOf(group[0]!)),
      kind: 'cost_vs_target',
      type: 'bar',
      title: chartMessage('Cost per result against target'),
      takeaway: null,
      context: {currency, result: String(definition.label), level},
      x: null,
      series: [],
      scale: null,
      notes,
      table,
      drawn: false,
    };
    if (!withCost.length) {
      notes.unshift(chartNote('No value is known, so there is nothing to draw.'));
      specs.push(base);
      continue;
    }
    specs.push({
      ...base,
      takeaway: chartMessage('Campaigns at or under their target cost per result: {count} of {total}.', {
        count: String(atOrUnder),
        total: String(withCost.length),
      }),
      x: {
        kind: 'category',
        items: listed.map(entity => ({
          key: entity.key,
          label: entityNameOf(entity.rows[0]!),
          ...(severalSources
            ? {
                detail:
                  (context.names[String(entity.rows[0]!.platform)] ?? String(entity.rows[0]!.platform)) +
                  ' · ' +
                  String(entity.rows[0]!.account_id),
              }
            : {}),
        })),
      },
      series: [
        {
          key: 'cost_per_result',
          name: 'Cost per result',
          name_kind: 'label',
          unit: 'currency',
          currency,
          values,
          targets,
          color_index: 2,
          label_at: values.flatMap((value, index) => (value === null ? [] : [index])),
        },
      ],
      scale: zeroBasedScale(
        decimalIn(
          [...values, ...targets].reduce<string>(
            (max, value) => (value !== null && compareText(value, max) > 0 ? value : max),
            '0',
          ),
        ),
      ),
      drawn: true,
    });
  }
  if (!specs.length)
    return [
      omitted(
        'cost_vs_target',
        'Cost per result against target',
        chartNote('No campaign has a cost per result target, so there is nothing to compare costs with.'),
      ),
    ];
  definitionNotes(specs);
  return finishKind(specs, 0);
}

const objectiveLabels: Record<string, ChartMessageKey> = {
  awareness: 'Awareness',
  traffic: 'Traffic',
  engagement: 'Engagement',
  video_views: 'Video views',
  leads: 'Leads',
  sales: 'Sales',
  app_installs: 'App installs',
  unknown: 'Unknown',
};
/** Said once on each chart of a kind that holds several result definitions: each has its own chart. */
function definitionNotes(specs: ChartSpec[]): void {
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

/**
 * Spend by objective as a stacked bar per platform: the three largest objectives, each with its own hue, and the rest as
 * Other (the neutral). A hue follows the objective, so a filter that removes one does not repaint the others, and two
 * objectives on one chart never share one. One objective is nothing to compare.
 */
function objectiveCharts(context: Context): ChartSpec[] {
  const {groups, unpriced} = pricedGroups(context.top),
    specs: ChartSpec[] = [];
  if (!groups.length)
    return unpriced
      ? [
          omitted(
            'spend_by_objective',
            'Spend by objective',
            chartNote('Amounts without a known currency are not charted.'),
          ),
        ]
      : [];
  for (const group of groups) {
    const currency = String(group[0]!.currency),
      id = chartId('spend_by_objective', currency, aggregationOf(group[0]!)),
      objectives = ranked(
        groupRows(group, row => String(row.objective_group ?? 'unknown')).map(([key, rows]) => ({
          key,
          label: key,
          value: sumReportValuesV4(rows.map(row => decimalOf(row.metrics?.spend))).value,
        })),
      ),
      notes = [...coverageNotes(group, ['spend']), ...groupNotes(context, group)],
      title = chartMessage('Spend by objective');
    const none: ChartSpec = {
      id,
      kind: 'spend_by_objective',
      type: 'stacked_bar',
      title,
      takeaway: null,
      context: {currency},
      x: null,
      series: [],
      scale: null,
      notes,
      table: null,
      drawn: false,
    };
    if (objectives.length < 2) {
      notes.unshift(
        chartNote(
          objectives.length
            ? 'All spend is on one objective, so there is nothing to compare.'
            : 'No value is known, so there is nothing to draw.',
        ),
      );
      specs.push(none);
      continue;
    }
    const top = objectives.slice(0, 3),
      rest = objectives.slice(3),
      hues = assignChartColors(top.map(objective => objective.key)),
      platforms = groupRows(group, row => String(row.platform))
        .map(([platform, rows]) => ({
          platform,
          rows,
          total: sumReportValuesV4(rows.map(row => decimalOf(row.metrics?.spend))).value,
        }))
        .sort(
          (a, b) =>
            (a.total === null ? 1 : 0) - (b.total === null ? 1 : 0) ||
            (a.total !== null && b.total !== null ? compareText(b.total, a.total) : 0) ||
            (a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0),
        ),
      cell = (rows: JsonObject[], keys: string[]): string | null => {
        const members = rows.filter(row => keys.includes(String(row.objective_group ?? 'unknown')));
        return members.length ? sumReportValuesV4(members.map(row => decimalOf(row.metrics?.spend))).value : null;
      },
      series = [
        ...top.map((objective, index) => ({
          key: objective.key,
          name: objectiveLabels[objective.key] ?? objectiveLabels.unknown!,
          color_index: hues[index]!,
          values: platforms.map(platform => cell(platform.rows, [objective.key])),
        })),
        ...(rest.length
          ? [
              {
                key: 'other',
                name: 'Other' as ChartMessageKey,
                color_index: null,
                values: platforms.map(platform =>
                  cell(
                    platform.rows,
                    rest.map(objective => objective.key),
                  ),
                ),
              },
            ]
          : []),
      ],
      totals = platforms.map(platform => platform.total),
      negative = [...series.flatMap(item => item.values), ...totals].some(
        value => value !== null && decimalIn(value).units < 0n,
      ),
      all = sumReportValuesV4(objectives.map(objective => objective.value)).value,
      table: ChartTable = {
        columns: [
          {label: 'Platform', label_kind: 'label', type: 'text', cell_kind: 'entity'},
          ...series.map(item => ({
            label: item.name,
            label_kind: 'label' as const,
            type: 'currency' as const,
            currency,
          })),
          {label: 'Total', label_kind: 'label', type: 'currency', currency},
        ],
        rows: platforms.map((platform, row) => [
          context.names[platform.platform] ?? platform.platform,
          ...series.map(item => item.values[row]!),
          totals[row]!,
        ]),
      };
    if (negative) {
      notes.unshift(chartNote('Values below zero cannot be drawn from a zero baseline. The table has them.'));
      specs.push({...none, table});
      continue;
    }
    if (rest.length)
      notes.unshift(chartNote('The smaller entries are combined as Other: {count}.', {count: String(rest.length)}));
    const share = all === null ? null : percentText(decimalIn(top[0]!.value!), decimalIn(all), 1);
    specs.push({
      ...none,
      takeaway:
        share !== null && all !== null
          ? chartMessage(
              'The largest share of spend is {name}: {share} of {total}.',
              {
                name: objectiveLabels[top[0]!.key] ?? objectiveLabels.unknown!,
                share: share + '%',
                total: amountText(all, currency),
              },
              ['name'],
            )
          : null,
      x: {
        kind: 'category',
        items: platforms.map(platform => ({
          key: platform.platform,
          label: context.names[platform.platform] ?? platform.platform,
        })),
      },
      series: series.map(item => ({
        key: item.key,
        name: item.name,
        name_kind: 'label' as const,
        unit: 'currency' as const,
        currency,
        values: item.values,
        color_index: item.color_index,
        label_at: [],
      })),
      scale: zeroBasedScale(
        decimalIn(
          totals.reduce<string>((max, value) => (value !== null && compareText(value, max) > 0 ? value : max), '0'),
        ),
      ),
      table,
      drawn: true,
    });
  }
  return finishKind(specs, unpriced);
}

/**
 * The ads with the most results, a bar each from zero. A result is not spend: ads are ranked within one result definition,
 * one chart for each (a result counted in money in its currency), and never added to another's. Previews will supply each
 * ad's picture in round 3; until then an entry has none.
 */
function topAdsCharts(context: Context): ChartSpec[] {
  const ads = context.rows.filter(row => levelOf(row) === 'ad');
  if (!ads.length) return [omitted('top_ads', 'Top ads by result', chartNote('This report has no ad-level rows.'))];
  const resolved = ads.filter(row => row.result?.definition_id && row.result_context?.definition),
    specs: ChartSpec[] = [];
  let unpriced = 0;
  for (const [, group] of groupRows(resolved, row => {
    const definition = row.result_context.definition;
    return `${definition.id}|${definition.unit === 'currency' ? (row.currency ?? '') : ''}|${aggregationOf(row)}`;
  })) {
    const definition = group[0]!.result_context.definition,
      currency = definition.unit === 'currency' ? (group[0]!.currency ? String(group[0]!.currency) : null) : null,
      unit = definition.unit === 'currency' ? ('currency' as const) : ('number' as const);
    if (unit === 'currency' && !currency) {
      unpriced += group.length;
      continue;
    }
    const severalSources = new Set(group.map(sourceOf)).size > 1;
    specs.push(
      barChart({
        id: chartId('top_ads', String(definition.id), currency, aggregationOf(group[0]!)),
        kind: 'top_ads',
        title: 'Top ads by result',
        context: {...(currency ? {currency} : {}), result: String(definition.label), level: 'ad'},
        entries: groupRows(group, entityKeyOf).map(([key, rows]) => ({
          key,
          label: entityNameOf(rows[0]!),
          ...(severalSources
            ? {
                detail:
                  (context.names[String(rows[0]!.platform)] ?? String(rows[0]!.platform)) +
                  ' · ' +
                  String(rows[0]!.account_id),
              }
            : {}),
          value: sumReportValuesV4(rows.map(row => decimalOf(row.metrics?.primary_result))).value,
        })),
        entityColumn: 'Ad',
        measure: 'primary_result',
        seriesName: 'Results',
        unit,
        currency,
        fold: false,
        takeaway: top =>
          chartMessage('The ad with the most results is {name}: {value}.', {
            name: top.label,
            value: amountOrNumber(top.value!, {unit, currency}),
          }),
        notes: [...coverageNotes(group, ['primary_result']), ...groupNotes(context, group)],
      }),
    );
  }
  definitionNotes(specs);
  return finishKind(specs, unpriced);
}

const builders: Record<ChartKind, (context: Context) => ChartSpec[]> = {
  kpi: () => [],
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
    context: Context = {
      config: parts.config,
      partial: parts.state === 'partial',
      names: options.platformNames ?? {},
      rows: parts.rows,
      top: topLevelRows(parts.rows),
    };
  return chartKindIds.flatMap(kind => (disabled.has(kind) ? [] : builders[kind as ChartKind](context)));
}

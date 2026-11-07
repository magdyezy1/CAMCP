import {overviewConfigV4} from './overview-v4.js';
import {sumReportValuesV4} from './report-math-v4.js';
import {reportCoverageLine, reportCoverageNotes} from './report-coverage-notes.js';
import {metricSumCoverage} from './report-summary.js';
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
  chartKindIds,
  chartMessage,
  chartNote,
  chartNoteFromLabel,
  type ChartKind,
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
}
/**
 * A ranked bar chart: bars from zero on one axis, the top ten and the rest as Other, a value at the tip of every bar, the
 * table of the same rows with each share of the exact total. A chart that cannot honestly be drawn (one entry, a value
 * below zero, nothing known) keeps its table and says why.
 */
function barChart(input: BarInput): ChartSpec {
  const known = ranked(input.entries),
    {shown, folded} = foldTop(known),
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
    takeaway:
      withShare && topShare !== null && total !== null
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
  if (unpriced && kept[0]) kept[0].notes.push(chartNote('Spend without a known currency is not charted.'));
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
      ? [omitted('spend_by_entity', 'Spend by campaign', chartNote('Spend without a known currency is not charted.'))]
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

const builders: Record<ChartKind, (context: Context) => ChartSpec[]> = {
  kpi: () => [],
  trend: () => [],
  spend_by_entity: spendByEntity,
  cost_vs_target: () => [],
  spend_by_objective: () => [],
  top_ads: () => [],
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

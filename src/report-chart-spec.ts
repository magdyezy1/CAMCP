import type {ChartColorIndex, ChartScale} from './report-chart-scale.js';
import type {CoverageNote} from './report-coverage-notes.js';

/**
 * The shape of a chart (V2-EXP-01, plan 6.1). The server computes it once, when a snapshot finishes, and stores it with
 * the snapshot; the website, the SVG back end and the PDF back end only draw it, and an MCP client receives it as data.
 * Every number in it is exact decimal text. Unknown is `null`, never `0`.
 */

/** The charts a report can show, and the unit of the `charts.disabled` setting. The labels are what the editor lists. */
export const chartKinds = [
  {id: 'kpi', label: 'Key figures'},
  {id: 'trend', label: 'Spend and results over time'},
  {id: 'spend_by_entity', label: 'Spend by platform and by campaign'},
  {id: 'cost_vs_target', label: 'Cost per result against target'},
  {id: 'spend_by_objective', label: 'Spend by objective'},
  {id: 'top_ads', label: 'Top ads by result'},
] as const;
export type ChartKind = (typeof chartKinds)[number]['id'];
export const chartKindIds: readonly string[] = chartKinds.map(kind => kind.id);

/**
 * Every sentence and label AMCP writes into a chart, in English. A message travels as `{key, params, text}`: the website
 * says `uiText(key, params)`, the artifact back ends say it in the report's language from the artifact catalogue, and
 * `text` is the English reading for a client that renders nothing itself. Names from a provider are never in this list:
 * they are parameters or labels of their own and are never translated.
 */
export const reportChartMessages = [
  // The charts, and the settings that switch them off.
  'Key figures',
  'Spend over time',
  'Results over time',
  'Spend by platform',
  'Spend by campaign',
  'Spend by ad set or ad group',
  'Spend by ad',
  'Cost per result against target',
  'Spend by objective',
  'Top ads by result',
  'Spend and results over time',
  'Spend by platform and by campaign',
  // What each chart says, in one sentence from its data.
  'Spend was highest in the period starting {date}: {value}.',
  'Results were highest in the period starting {date}: {value}.',
  'The largest share of spend is {name}: {share} of {total}.',
  'Campaigns at or under their target cost per result: {count} of {total}.',
  'The ad with the most results is {name}: {value}.',
  // The names of series, rows and columns.
  'Spend',
  'Impressions',
  'Clicks',
  'Results',
  'Cost per result',
  'Target',
  'Total',
  'Other',
  'Unknown',
  'Share of spend',
  'Platform',
  'Campaign',
  'Ad set or ad group',
  'Ad',
  'Period',
  'Metric',
  'Value',
  'Objective',
  'Against target',
  'At or under target',
  'Over target',
  'Rows with a value',
  'Currency',
  'Awareness',
  'Traffic',
  'Engagement',
  'Video views',
  'Leads',
  'Sales',
  'App installs',
  // Why a chart is partial or absent.
  'Each currency has its own chart ({currencies}). Amounts in different currencies are never combined.',
  'Each result definition has its own chart ({definitions}). Different results are never added.',
  'This report is partial: totals leave out the sources or periods that are missing.',
  'Values below zero cannot be drawn from a zero baseline. The table has them.',
  'Amounts without a known currency are not charted.',
  'A trend needs at least two periods; this report has {count}.',
  'No campaign has a cost per result target, so there is nothing to compare costs with.',
  'This report has no ad-level rows.',
  'All spend is on one objective, so there is nothing to compare.',
  'There is only one entry, so there is nothing to compare. The table has it.',
  'No value is known, so there is nothing to draw.',
  'The smaller entries are combined as Other: {count}.',
  'Hollow marks are periods calculated from some of their rows only: {count}.',
  'No data',
  'Since the previous period',
  'Previous period',
  'Change',
  'Change in percent',
  'The change compares the campaigns and ads that appear in both periods.',
  'Rows with no single result definition are left out of this chart: {count}.',
  'Only the first {count} groups are charted. The report table has the rest.',
  'Only the {count} entries with the most spend are shown. The report table has the rest.',
] as const;
export type ChartMessageKey = (typeof reportChartMessages)[number];

/** A sentence or label with its parts: see `reportChartMessages`. */
export interface ChartMessage {
  key: string;
  params: Record<string, string>;
  text: string;
  /** The parameters whose values are names AMCP wrote ("Sales"), which a renderer translates; the rest are data. */
  labels?: string[];
}
/** A coverage line in the words of the shared helper (`reportCoverageLine`), kept structured so a surface can re-word it. */
export interface ChartCoverageNote extends CoverageNote {
  kind: 'coverage';
  text: string;
}
export type ChartNote = (ChartMessage & {kind: 'message'}) | ChartCoverageNote;

/** One entry of a category axis: a campaign, a platform, an ad, a period. `other` marks the combined remainder. */
export interface ChartItem {
  key: string;
  label: string;
  /** Where it comes from, for a tooltip and the table ("Meta · 123"): provider data. */
  detail?: string;
  other?: true;
  /** A stacked bar's total, as a reader sees it (the series' value labels do not add up to it). */
  total_label?: string;
  /** The picture of an ad, when previews supply one (round 3). Absent until then. */
  thumbnail?: string;
}
export interface ChartAxis {
  /** `time` items are ISO dates (YYYY-MM-DD), drawn left to right in every language. */
  kind: 'time' | 'category';
  items: ChartItem[];
}
export interface ChartSeries {
  key: string;
  name: string;
  /** `label` is a name AMCP wrote (translated); `entity` is provider data (never translated). */
  name_kind: 'label' | 'entity';
  unit: 'currency' | 'number';
  currency: string | null;
  values: (string | null)[];
  /**
   * The values as a reader sees them: thousands grouped, a currency in its minor units, no currency code (the unit names
   * it). Made once here so every renderer prints the same text; the exact text stays in `values`.
   */
  value_labels: (string | null)[];
  /** The hue (0, 1 or 2), or null for the neutral "Other". */
  color_index: ChartColorIndex | null;
  /** Which values carry a direct label (the endpoint, the extreme; every bar of a short list). */
  label_at: number[];
  /** A bar's target, aligned with `values`: the mark a cost is compared with, and its label. */
  targets?: (string | null)[];
  target_labels?: (string | null)[];
  /** A line's point calculated from fewer rows than it has: drawn hollow, off the line (F-L5-26). */
  short?: ({known: number; total: number; unit: 'rows' | 'measurements'} | null)[];
  /** KPI only: the change since the previous period, added when the report is read (it needs the linked baseline). */
  change?: ChartChange;
}
export interface ChartChange {
  baseline: string;
  delta: string;
  delta_percent: string | null;
  /**
   * The change as a reader reads it, made once here like `value_labels`: the sign of the exact change ("+50.00", "-12", and no
   * sign when there is none), the value in the series' own unit, and a percentage rounded half up to two places with its zeros
   * dropped, as the comparison table shows it. `percent_label` is null when the earlier value is zero.
   */
  delta_label: string;
  percent_label: string | null;
}
export interface ChartColumn {
  label: string;
  /** `label` is a name AMCP wrote (translated); `entity` is provider data. */
  label_kind: 'label' | 'entity';
  type: 'text' | 'date' | 'decimal' | 'currency' | 'percent';
  currency?: string | null;
  /** For a text column: whether its cells are names AMCP wrote (translated) or provider data (never translated). */
  cell_kind?: 'label' | 'entity';
}
export interface ChartTable {
  columns: ChartColumn[];
  /** Exact decimal text for numbers, `null` for unknown. The first column names the row. */
  rows: (string | null)[][];
  /** The row that holds the combined remainder: its first cell is a name AMCP wrote ("Other"), not provider data. */
  other?: number;
}
export interface ChartContext {
  platform?: string;
  account_id?: string;
  currency?: string | null;
  level?: string;
  objective?: string;
  /** The result's own name (a definition's label), when the chart is about results. */
  result?: string;
  date_from?: string;
  date_to?: string;
  /** Key figures only: the fields a previous period's group is matched by (src/report-compare.ts). */
  compare?: {
    platform: string;
    account_id: string;
    currency: string | null;
    timezone: string | null;
    result_definition: string | null;
    attribution: string | null;
    entity_level: string;
  };
}
export interface ChartSpec {
  id: string;
  kind: ChartKind;
  type: 'kpi' | 'line' | 'bar' | 'stacked_bar';
  title: ChartMessage;
  takeaway: ChartMessage | null;
  /** Which group of rows the chart is of, when a report has several (a currency, a result definition). */
  context: ChartContext;
  x: ChartAxis | null;
  series: ChartSeries[];
  scale: ChartScale | null;
  notes: ChartNote[];
  table: ChartTable | null;
  /** False when the chart is not drawn: `notes` says why, and the table stays when there is data for it. */
  drawn: boolean;
}

/** The English reading of a message with its parameters filled in. */
export function fillChartMessage(key: string, params: Record<string, string>): string {
  return key.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (slot, name: string) =>
    Object.hasOwn(params, name) ? params[name]! : slot,
  );
}
export function chartMessage(
  key: ChartMessageKey,
  params: Record<string, string> = {},
  labels: string[] = [],
): ChartMessage {
  return {key, params, text: fillChartMessage(key, params), ...(labels.length ? {labels} : {})};
}
export const chartNote = (key: ChartMessageKey, params: Record<string, string> = {}): ChartNote => ({
  kind: 'message',
  ...chartMessage(key, params),
});
/** A label that arrives as a message the report already carries (a rolled-up label): its key is its own English. */
export const chartNoteFromLabel = (label: string): ChartNote => ({
  kind: 'message',
  key: label,
  params: {},
  text: label,
});

const maxNameLength = 160;
/** A provider's name, bounded so one very long name cannot grow a stored chart. It is data, escaped by every renderer. */
export function boundedChartName(name: unknown): string {
  const text = String(name ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  return text.length > maxNameLength ? text.slice(0, maxNameLength - 1) + '…' : text;
}
/** A stable, ASCII id from the parts of a chart's identity. */
export const chartId = (...parts: (string | null | undefined)[]): string =>
  parts.map(part => String(part ?? '-').replace(/[^A-Za-z0-9_.-]+/g, '_')).join(':');

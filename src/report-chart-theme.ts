import type {SceneHue, SceneItem} from './report-chart-layout.js';
import {metricLabels, valueLabel} from './report-chart-kit.js';
import {formatChartNumber} from './report-chart-scale.js';
import {reportCoverageLine} from './report-coverage-notes.js';
import {
  fillChartMessage,
  type ChartColumn,
  type ChartMessage,
  type ChartNote,
  type ChartSeries,
  type ChartSpec,
} from './report-chart-spec.js';

/**
 * What the artifact renderers of a chart share (V2-EXP-01): the colours of both themes, the one function that escapes text
 * into markup, and the words of a spec in the report's language. The page reads the same colours from `--chart-*` tokens in
 * web/tokens-v2.css; tests/report-chart-palette.test.mjs holds the two to each other and checks them with the data
 * visualisation validator's checks in both themes.
 */

export type ChartTheme = 'light' | 'dark';
export interface ChartColors {
  /** The surface the palette was validated on; a chart always draws its own, so the contrast it was checked for is the one a reader gets. */
  surface: string;
  ink: string;
  ink2: string;
  grid: string;
  axis: string;
  /** The three data hues, in the fixed order of the palette. */
  hues: readonly [string, string, string];
  /** The neutral of the combined remainder ("Other"). */
  other: string;
  /** The ink of a label set on a fill of each hue, and of Other: at least 4.5:1 against it. */
  on: readonly [string, string, string];
  onOther: string;
}
export const chartPalette: Readonly<Record<ChartTheme, ChartColors>> = {
  light: {
    surface: '#fffdf8',
    ink: '#222137',
    ink2: '#696678',
    grid: '#e5e1eb',
    axis: '#8e87a0',
    hues: ['#6250d6', '#eb6834', '#1baf7a'],
    other: '#8e87a0',
    on: ['#ffffff', '#222137', '#222137'],
    onOther: '#222137',
  },
  dark: {
    surface: '#17141f',
    ink: '#f2edf8',
    ink2: '#c0b5ce',
    grid: '#51475f',
    axis: '#988aab',
    hues: ['#9085e9', '#d95926', '#199e70'],
    // Darker than the hues here: the lighter neutral the light theme uses is 9.9 from the dark violet, below the 15 a
    // reader with full colour vision needs to tell two neighbours apart.
    other: '#6e6880',
    on: ['#17141f', '#17141f', '#17141f'],
    onOther: '#f2edf8',
  },
};
export const hueColor = (colors: ChartColors, hue: SceneHue): string =>
  hue === null ? colors.other : colors.hues[hue];
export const hueInk = (colors: ChartColors, hue: SceneHue): string => (hue === null ? colors.onOther : colors.on[hue]);
/**
 * The ink of a text mark: a label inside a fill is set in the ink made for that fill; names and figures in the primary ink,
 * ticks, captions and the words "No data" in the secondary one.
 */
export function chartTextInk(colors: ChartColors, item: Extract<SceneItem, {t: 'text'}>): string {
  if (item.role === 'inside') return hueInk(colors, item.color ?? null);
  return ['tick', 'nodata', 'kpi-label', 'kpi-unit', 'kpi-caption'].includes(item.role) ? colors.ink2 : colors.ink;
}

// Characters XML 1.0 cannot carry, and unpaired surrogates, are replaced by a space; the five markup characters become entities.
const notXml =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const entities: Record<string, string> = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
/**
 * The one place a string becomes markup. Every string a chart draws, text or attribute, comes through it: names are provider
 * data, and a campaign called `</svg><script>alert(1)</script>` is text, never markup.
 */
export const escapeChartText = (value: unknown): string =>
  String(value ?? '')
    .replace(notXml, ' ')
    .replace(/[&<>"']/g, character => entities[character]!);

/** The language of an artifact: `artifactLocale()` of src/report-localization.ts satisfies it. */
export interface ChartLocale {
  language: 'en' | 'ar';
  text: (english: string) => string;
}
// First-strong isolate and pop-directional-isolate (U+2068, U+2069): what the report's other Arabic lines wrap their values in.
const isolateStart = String.fromCodePoint(0x2068),
  isolateEnd = String.fromCodePoint(0x2069);
/**
 * A message in the report's language: names AMCP wrote are translated, provider data and numbers are kept as they are. In
 * Arabic every value is isolated from the sentence around it, so a date, a percentage or an amount keeps its own order inside
 * a right-to-left sentence (a day read as 19-10-2026 for 2026-10-19 is the mistake this prevents).
 */
export function chartMessageText(message: ChartMessage, locale: ChartLocale): string {
  const params = {...message.params},
    words = new Set(message.labels ?? []);
  for (const [name, value] of Object.entries(params))
    params[name] = words.has(name)
      ? locale.text(value)
      : locale.language === 'ar'
        ? isolateStart + value + isolateEnd
        : value;
  return fillChartMessage(locale.text(message.key), params);
}
/** A note in the report's language; a coverage note is re-worded by the shared helper that wrote it. */
export function chartNoteText(note: ChartNote, locale: ChartLocale): string {
  if (note.kind === 'message') return chartMessageText(note, locale);
  return reportCoverageLine(note, locale.text(metricLabels[note.metric] ?? note.metric), locale.language);
}
/** The name of a series: AMCP's own words are translated, an entity's name is not. */
export const chartSeriesName = (series: ChartSeries, locale: ChartLocale): string =>
  series.name_kind === 'label' ? locale.text(series.name) : series.name;

export interface ChartTableText {
  columns: {label: string; align: 'start' | 'end'}[];
  rows: string[][];
}
const numericColumn = (column: ChartColumn) => ['decimal', 'currency', 'percent'].includes(column.type);
/**
 * The table of a chart as a reader reads it, in the report's language: a heading that names its currency, grouped thousands,
 * a currency in its minor units, a percentage with its sign, the combined remainder named by AMCP. A number nobody has says
 * "No data" and is never drawn as zero; a text cell with nothing to say is empty; a name from a provider is left exactly as it
 * came (the renderers escape it). Latin digits in both languages. Names start, numbers end.
 */
export function chartTableText(spec: ChartSpec, locale: ChartLocale): ChartTableText {
  const table = spec.table;
  if (!table) return {columns: [], rows: []};
  const heading = (column: ChartColumn) => {
    const label = column.label_kind === 'label' ? locale.text(column.label) : column.label;
    return column.type === 'currency' && column.currency ? `${label} (${column.currency})` : label;
  };
  const cell = (column: ChartColumn, value: string | null, other: boolean): string => {
    if (value === null) return numericColumn(column) ? locale.text('No data') : '';
    if (column.type === 'currency') return valueLabel(value, 'currency', column.currency ?? null) ?? value;
    if (column.type === 'decimal') return formatChartNumber(value);
    if (column.type === 'percent') return formatChartNumber(value) + '%';
    return other || column.cell_kind === 'label' ? locale.text(value) : value;
  };
  return {
    columns: table.columns.map(column => ({label: heading(column), align: numericColumn(column) ? 'end' : 'start'})),
    rows: table.rows.map((row, index) =>
      row.map((value, column) => cell(table.columns[column]!, value, column === 0 && table.other === index)),
    ),
  };
}

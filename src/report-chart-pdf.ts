import type PDFDocument from 'pdfkit';
import {
  chartBarPath,
  chartLayout,
  chartTexture,
  fitChartText,
  sceneInDrawingOrder,
  wrapChartText,
  type SceneItem,
} from './report-chart-layout.js';
import {fillChartMessage, type ChartSpec} from './report-chart-spec.js';
import {
  chartMessageText,
  chartNoteText,
  chartPalette,
  chartTableText,
  chartTextInk,
  hueColor,
  type ChartLocale,
  type ChartTableText,
} from './report-chart-theme.js';
import {drawPdfTextAt, pdfTextWidth} from './pdf-text.js';

/**
 * The PDF back end (V2-EXP-01): draws the scene of src/report-chart-layout.ts with pdfkit, in the light palette and in print
 * texture (the fills other than the first hue are hatched or dotted, the hatch clipped to its bar, so colour is not the only
 * encoding on paper), and lists each chart's table beneath it. Every text goes through `drawPdfTextAt`, so Arabic is shaped
 * and ordered as the rest of the report is and the words of every chart can be read back from the file.
 */

type Doc = InstanceType<typeof PDFDocument>;
export interface ChartPdfOptions {
  locale: ChartLocale;
  /** Whether the embedded font can draw a character. One that it cannot is shown as "?" (see `printableChartText`). */
  hasGlyph: (code: number) => boolean;
}
export interface ChartBox {
  x: number;
  y: number;
  width: number;
}
/** The charts a PDF holds: the first 24, in the order the report has them. The report page has the rest. */
export const pdfChartLimit = 24;

// What the PDF text layer drops anyway: line breaks, and the characters that only steer the direction of text.
const invisible = /[\n\r\t\p{Bidi_Control}]/u;
/**
 * A text the embedded font can draw. A character it has no glyph for (an emoji, a script it lacks) is shown as "?", one "?"
 * for a run of them, and `replaced` says that it happened so the report can say so: a name is never dropped silently, and a
 * campaign called after an emoji does not stop the whole report from being exported.
 */
export function printableChartText(
  value: string,
  hasGlyph: (code: number) => boolean,
): {text: string; replaced: boolean} {
  let text = '',
    replaced = false,
    after = false;
  for (const character of value) {
    if (invisible.test(character) || hasGlyph(character.codePointAt(0)!)) {
      text += character;
      after = false;
    } else {
      if (!after) text += '?';
      replaced = after = true;
    }
  }
  return {text, replaced};
}
const hasArabic = /\p{Script=Arabic}/u;

/**
 * Draws a chart in its box (its left, top and width; the height is the layout's, returned) and returns null for one that is
 * not drawn. `replaced` says that a character the font lacks was shown as "?".
 */
export function drawChartPdf(
  doc: Doc,
  spec: ChartSpec,
  box: ChartBox,
  options: ChartPdfOptions,
): {height: number; replaced: boolean} | null {
  const {locale} = options,
    scene = chartLayout(spec, {width: box.width, language: locale.language, t: locale.text});
  if (!scene) return null;
  const colors = chartPalette.light,
    {period, stripe, dot} = chartTexture,
    // The distance between two diagonal stripes is `period` measured across them: along the x axis it is a little more.
    step = period * Math.SQRT2;
  let replaced = false;
  doc.save();
  doc.rect(box.x, box.y, box.width, scene.height).fill(colors.surface);
  /** The outline of a fill, as a path to fill and to clip to. */
  const outline = (item: Extract<SceneItem, {t: 'rect'}>) =>
    item.round ? doc.path(chartBarPath(item, box.x, box.y)) : doc.rect(box.x + item.x, box.y + item.y, item.w, item.h);
  const fillMark = (item: Extract<SceneItem, {t: 'rect'}>) => {
    outline(item).fill(hueColor(colors, item.color));
    if (item.color === 0) return;
    // Print texture: stripes or dots in the colour of the surface, clipped to the fill.
    doc.save();
    outline(item).clip();
    const left = box.x + item.x,
      top = box.y + item.y,
      right = left + item.w,
      bottom = top + item.h;
    if (item.color === null) {
      // Dots on a grid that starts at the corner of the chart, so neighbouring fills share it.
      for (let y = box.y + period / 2 + Math.floor((top - box.y) / period) * period; y < bottom + period; y += period)
        for (let x = box.x + period / 2 + Math.floor((left - box.x) / period) * period; x < right + period; x += period)
          doc.circle(x, y, dot).fill(colors.surface);
    } else {
      doc.lineWidth(stripe).lineCap('butt').strokeColor(colors.surface);
      if (item.color === 1) {
        // Up to the right: the lines x + y = c. Each is cut to the box by the clip.
        const base = box.x + box.y;
        for (let c = base + Math.ceil((left + top - base) / step) * step; c <= right + bottom; c += step)
          doc
            .moveTo(c - bottom, bottom)
            .lineTo(c - top, top)
            .stroke();
      } else {
        // Down to the right: the lines x - y = d.
        const base = box.x - box.y;
        for (let d = base + Math.ceil((left - bottom - base) / step) * step; d <= right - top; d += step)
          doc
            .moveTo(d + top, top)
            .lineTo(d + bottom, bottom)
            .stroke();
      }
    }
    doc.restore();
  };
  for (const item of sceneInDrawingOrder(scene)) {
    switch (item.t) {
      case 'rect':
        fillMark(item);
        break;
      case 'line':
        doc
          .moveTo(box.x + item.x1, box.y + item.y1)
          .lineTo(box.x + item.x2, box.y + item.y2)
          .lineWidth(item.role === 'axis' || item.role === 'grid' ? 0.75 : 2)
          .lineCap('butt')
          .strokeColor(item.role === 'axis' ? colors.axis : item.role === 'grid' ? colors.grid : colors.ink)
          .stroke();
        break;
      case 'polyline':
        for (const [index, [x, y]] of item.points.entries())
          if (index) doc.lineTo(box.x + x, box.y + y);
          else doc.moveTo(box.x + x, box.y + y);
        doc.lineWidth(2).lineJoin('round').lineCap('round').strokeColor(hueColor(colors, item.color)).stroke();
        break;
      case 'circle':
        if (item.role === 'point') {
          doc.circle(box.x + item.cx, box.y + item.cy, item.r + 2).fill(colors.surface);
          doc.circle(box.x + item.cx, box.y + item.cy, item.r).fill(hueColor(colors, item.color));
        } else
          doc
            .circle(box.x + item.cx, box.y + item.cy, item.r)
            .lineWidth(2)
            .fillAndStroke(colors.surface, hueColor(colors, item.color));
        break;
      case 'text': {
        const printable = printableChartText(item.text, options.hasGlyph),
          patterned = item.role === 'inside' && item.color !== 0;
        replaced ||= printable.replaced;
        drawPdfTextAt(doc, printable.text, box.x + item.x, box.y + item.y, item.anchor, {
          size: item.size,
          color: chartTextInk(colors, item),
          rtl: item.rtl,
          bold: item.bold,
          ...(patterned ? {halo: {color: hueColor(colors, item.color ?? null), width: 3}} : {}),
        });
        break;
      }
    }
  }
  doc.restore();
  return {height: scene.height, replaced};
}

const rowHeight = 14,
  headLine = 10.5,
  tableSize = 8;
interface TablePlan {
  table: ChartTableText;
  /** The left and right edge of each column. */
  spans: {left: number; right: number}[];
  /** The lines of each heading: a heading that does not fit its column goes on a second and a third line. */
  head: string[][];
  headHeight: number;
  height: number;
}
/**
 * Where the columns of a chart's table go and how tall it is, measured with the embedded font. A column asks for what its
 * widest cell or longest heading word needs; the first column (a name) has what is left, never less than 110pt, and the others
 * give way together when they ask for more than that. In Arabic the first column is at the right.
 */
function planChartTable(doc: Doc, spec: ChartSpec, width: number, options: ChartPdfOptions): TablePlan | null {
  const table = chartTableText(spec, options.locale);
  if (!table.columns.length) return null;
  const measure = (text: string, size: number) => pdfTextWidth(doc, text, size),
    asks = table.columns
      .slice(1)
      .map((column, index) =>
        Math.min(
          100,
          Math.max(
            56,
            12 +
              Math.max(
                ...table.rows.map(row => measure(row[index + 1] ?? '', tableSize)),
                ...column.label.split(/\s+/).map(word => measure(word, tableSize)),
              ),
          ),
        ),
      ),
    asked = asks.reduce((sum, ask) => sum + ask, 0),
    give = asked > width - 110 ? (width - 110) / asked : 1,
    widths = [width - asked * give, ...asks.map(ask => ask * give)];
  const rtl = options.locale.language === 'ar';
  let edge = rtl ? width : 0;
  const spans = widths.map(size => {
    const span = rtl ? {left: edge - size, right: edge} : {left: edge, right: edge + size};
    edge = rtl ? span.left : span.right;
    return span;
  });
  const head = table.columns.map((column, index) =>
      wrapChartText(column.label, widths[index]! - 8, tableSize, 3, measure),
    ),
    headHeight = 8 + headLine * Math.max(1, ...head.map(lines => lines.length));
  return {table, spans, head, headHeight, height: headHeight + table.rows.length * rowHeight + 2};
}
/** What the table of a chart takes in height on a page of this width (0 for a chart with no table). */
export const chartTableHeight = (doc: Doc, spec: ChartSpec, width: number, options: ChartPdfOptions): number =>
  planChartTable(doc, spec, width, options)?.height ?? 0;
/**
 * The table of a chart under it: its heading and its rows, in the report's language (numbers end, names start; in Arabic the
 * first column is at the right), with a hairline between rows. A name too long for its column is cut with an ellipsis; the
 * workbook has it whole.
 */
export function drawChartTablePdf(
  doc: Doc,
  spec: ChartSpec,
  box: ChartBox,
  options: ChartPdfOptions,
): {height: number; replaced: boolean} {
  const plan = planChartTable(doc, spec, box.width, options);
  if (!plan) return {height: 0, replaced: false};
  const colors = chartPalette.light,
    rtl = options.locale.language === 'ar',
    measure = (text: string, size: number) => pdfTextWidth(doc, text, size);
  let replaced = false;
  const cell = (text: string, index: number, baseline: number, colour: string) => {
    const printable = printableChartText(text, options.hasGlyph),
      span = plan.spans[index]!,
      arabic = rtl && hasArabic.test(printable.text);
    replaced ||= printable.replaced;
    if (!printable.text) return;
    const fitted = fitChartText(printable.text, span.right - span.left - 8, tableSize, measure),
      at = box.x + (rtl || plan.table.columns[index]!.align === 'end' ? span.right - 4 : span.left + 4),
      anchor = rtl || plan.table.columns[index]!.align === 'end' ? 'right' : 'left';
    // Numbers are right-aligned in both languages, so their digits line up; a name starts at the edge its language starts from.
    drawPdfTextAt(doc, fitted, at, baseline, anchor, {size: tableSize, color: colour, ...(rtl ? {rtl: arabic} : {})});
  };
  plan.head.forEach((lines, index) =>
    lines.forEach((line, k) => cell(line, index, box.y + 10 + headLine * k, colors.ink2)),
  );
  doc
    .moveTo(box.x, box.y + plan.headHeight)
    .lineTo(box.x + box.width, box.y + plan.headHeight)
    .lineWidth(0.75)
    .strokeColor(colors.axis)
    .stroke();
  plan.table.rows.forEach((row, rowIndex) => {
    const top = box.y + plan.headHeight + rowIndex * rowHeight;
    row.forEach((text, index) => cell(text, index, top + 10.5, colors.ink));
    doc
      .moveTo(box.x, top + rowHeight)
      .lineTo(box.x + box.width, top + rowHeight)
      .lineWidth(0.5)
      .strokeColor(colors.grid)
      .stroke();
  });
  return {height: plan.height, replaced};
}

/** The charts a retained snapshot holds, or none: a report from before charts has no `charts`, and a malformed entry is not one. */
export function readableCharts(value: unknown): ChartSpec[] {
  return Array.isArray(value)
    ? value.filter(
        (spec): spec is ChartSpec =>
          !!spec &&
          typeof spec === 'object' &&
          typeof spec.id === 'string' &&
          typeof spec.title?.key === 'string' &&
          Array.isArray(spec.series) &&
          Array.isArray(spec.notes),
      )
    : [];
}

export interface ChartSectionDeps extends ChartPdfOptions {
  doc: Doc;
  /** The flowing text of the report: a line of text at a size and a colour, wrapped to the page. */
  text: (value: string, size?: number, color?: string) => void;
  /** Starts a new page when the next `height` points would not fit on this one. */
  room: (height: number) => void;
  accent: string;
}
/**
 * The Charts section of a PDF: for each of the first 24 charts its title, its takeaway, the picture (when it is drawn), its
 * notes and its table, then a line that says how many more there are, and one that says a character was shown as "?".
 * A chart that is not drawn keeps its notes and its table: the source data stays when a chart cannot honestly show it.
 */
export function drawChartsSection(charts: ChartSpec[], deps: ChartSectionDeps): void {
  const {doc, locale} = deps,
    say = locale.text,
    clean = (value: string) => printableChartText(value, deps.hasGlyph);
  let replaced = false;
  const line = (value: string, size: number, color?: string) => {
    const printable = clean(value);
    replaced ||= printable.replaced;
    deps.text(printable.text, size, color);
  };
  deps.room(160);
  deps.text(say('Charts'), 15);
  doc.moveDown(0.3);
  for (const spec of charts.slice(0, pdfChartLimit)) {
    const scene = chartLayout(spec, {width: 507, language: locale.language, t: locale.text});
    deps.room((scene?.height ?? 0) + 70);
    line(chartMessageText(spec.title, locale), 12, deps.accent);
    if (spec.takeaway) line(chartMessageText(spec.takeaway, locale), 10);
    if (scene) {
      const top = doc.y + 4,
        drawn = drawChartPdf(doc, spec, {x: 44, y: top, width: 507}, deps)!;
      replaced ||= drawn.replaced;
      doc.y = top + drawn.height + 8;
    }
    for (const note of spec.notes) line('- ' + chartNoteText(note, locale), 8.5, '#5B677B');
    if (spec.table) {
      deps.room(chartTableHeight(doc, spec, 507, deps) + 6);
      const top = doc.y + 4,
        table = drawChartTablePdf(doc, spec, {x: 44, y: top, width: 507}, deps);
      replaced ||= table.replaced;
      doc.y = top + table.height + 6;
    }
    doc.moveDown(0.8);
  }
  if (charts.length > pdfChartLimit)
    deps.text(
      '- ' +
        fillChartMessage(say('Only the first {count} charts are in this file. The report page has the rest.'), {
          count: String(pdfChartLimit),
        }),
      9,
    );
  if (replaced)
    deps.text(
      '- ' + say('Characters missing from the PDF font are shown as ?. The Excel download has every name in full.'),
      9,
    );
}

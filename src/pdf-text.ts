import bidiFactory from 'bidi-js';
import type PDFDocument from 'pdfkit';
import {MirrorError} from './errors.js';

const bidi = bidiFactory();
const controls = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const rtlScript = /[\p{Script=Arabic}\p{Script=Hebrew}]/u;
// PDFKit 0.20 supports feature objects; its 0.17 typings only expose arrays. Mirroring is applied once by Unicode.
const features = {rtlm: false} as unknown as PDFKit.Mixins.TextOptions['features'];
// Fontkit places a combining mark on the glyph before it, and throws (`TypeError ... xCoordinate`) when that glyph is a space or
// a no-break space, which has no anchor for a mark. The font has the mark, so the glyph filter lets it through, and a campaign
// name is provider text (P2B-02). Such a run is shaped again without mark placement: the mark has no advance and is drawn where
// the cursor is, as a mark with no base can only be.
const featuresWithoutMarks = {rtlm: false, mark: false} as unknown as PDFKit.Mixins.TextOptions['features'];
type Run = {text: string; rtl: boolean};
type Line = {logical: string; runs: Run[]; width: number; rtl: boolean};

/**
 * Unicode bidi reorders runs; Fontkit receives logical Arabic text so contextual shaping remains intact. The base direction
 * is found in the text unless `direction` gives it (the picture of a chart sets the direction of its report, not of its text).
 */
export function pdfTextLines(
  value: string,
  width: number,
  measure: (text: string) => number,
  direction?: 'ltr' | 'rtl',
): Line[] {
  if (value.length > 8192 || !Number.isFinite(width) || width <= 0)
    throw new MirrorError('REPORT_ARTIFACT_LIMIT', 'Narrow the report text before PDF rendering.');
  const lines: Line[] = [];
  for (const paragraph of value.split(/\r\n|[\r\n]/)) {
    const text = paragraph.trim(),
      embedding = bidi.getEmbeddingLevels(text, direction),
      rtl = !!(embedding.paragraphs[0]?.level! & 1);
    const range = (start: number, end: number): Line => {
      const order = bidi.getReorderedIndices(text, embedding, start, end).slice(start, end + 1);
      // The pinned implementation takes the levels array here, unlike its reorder API (and README example).
      const mirrored = bidi.getMirroredCharactersMap(text, embedding.levels, start, end);
      const groups: number[][] = [];
      for (const index of order) {
        const previous = groups.at(-1),
          last = previous?.at(-1),
          odd = embedding.levels[index]! % 2;
        if (previous && last !== undefined && embedding.levels[last]! % 2 === odd && index === last + (odd ? -1 : 1))
          previous.push(index);
        else groups.push([index]);
      }
      const runs = groups
        .map(indices => {
          const odd = embedding.levels[indices[0]!]! % 2 === 1;
          const logical = [...indices]
            .sort((a, b) => a - b)
            .map(i => mirrored.get(i) ?? text[i])
            .join('')
            .replace(controls, '');
          // RTL punctuation-only runs have no script from which Fontkit can infer direction.
          const shaped = odd && rtlScript.test(logical);
          return {
            text: shaped
              ? logical
              : indices
                  .map(i => mirrored.get(i) ?? text[i])
                  .join('')
                  .replace(controls, ''),
            rtl: shaped,
          };
        })
        .filter(run => run.text.length > 0);
      return {logical: text.slice(start, end + 1), runs, width: runs.reduce((sum, r) => sum + measure(r.text), 0), rtl};
    };
    if (!text) {
      lines.push({logical: '', runs: [], width: 0, rtl});
      continue;
    }
    const graphemes = [...new Intl.Segmenter('und', {granularity: 'grapheme'}).segment(text)].map(s => s.index);
    graphemes.push(text.length);
    let start = 0;
    while (start < text.length) {
      const boundaries = graphemes.filter(i => i > start);
      let low = 0,
        high = boundaries.length - 1,
        best = -1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (range(start, boundaries[mid]! - 1).width <= width) {
          best = mid;
          low = mid + 1;
        } else high = mid - 1;
      }
      if (best < 0) throw new MirrorError('REPORT_ARTIFACT_LIMIT', 'A report glyph is wider than its PDF text area.');
      let stop = boundaries[best]!;
      if (stop < text.length) {
        const candidate = text.slice(start, stop),
          space = candidate.search(/\s+\S*$/u);
        if (space > 0) stop = start + space;
      }
      const logical = text.slice(start, stop).trimEnd();
      lines.push(range(start, start + logical.length - 1));
      start = stop;
      while (/\s/u.test(text[start] ?? '') && start < text.length) start++;
    }
  }
  return lines;
}

type Doc = InstanceType<typeof PDFDocument>;
/**
 * The width of a text in the embedded font and the features it was shaped with: the draw of the same text uses those, so
 * what is measured is what is drawn, and a text fontkit cannot place a mark in is measured and drawn, never thrown.
 */
function shapedWidth(doc: Doc, text: string): {width: number; features: typeof features} {
  try {
    return {width: doc.widthOfString(text, {features}), features};
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return {width: doc.widthOfString(text, {features: featuresWithoutMarks}), features: featuresWithoutMarks};
  }
}
/** The width of a text as it is drawn. */
const measureText = (doc: Doc) => (text: string) => shapedWidth(doc, text).width;
/**
 * Paints the runs of one line from `at` to the right, at `y`: the top of the text, or with `onBaseline` its baseline; `mode`
 * says how the letters are painted (filled by default, or as an outline, or both).
 */
function paintRuns(
  doc: Doc,
  line: Line,
  at: number,
  y: number,
  onBaseline = false,
  mode: {stroke?: boolean; fill?: boolean} = {},
) {
  for (const run of line.runs) {
    // Numeric Arabic-script runs are LTR under Unicode. Shaping each grapheme prevents Fontkit reversing digits.
    const pieces =
      !run.rtl && rtlScript.test(run.text)
        ? [...new Intl.Segmenter('und', {granularity: 'grapheme'}).segment(run.text)].map(s => s.segment)
        : [run.text];
    for (const piece of pieces) {
      const shaped = shapedWidth(doc, piece);
      doc.text(piece, at, y, {
        lineBreak: false,
        features: shaped.features,
        ...(onBaseline ? {baseline: 'alphabetic' as const} : {}),
        ...mode,
      });
      at += shaped.width;
    }
  }
}

export function drawPdfText(doc: Doc, value: string, alignRight: boolean) {
  const width = 507,
    x = 44,
    lineHeight = doc.currentLineHeight(true) + 3;
  const lines = pdfTextLines(value, width, measureText(doc));
  for (const line of lines) {
    if (doc.y + lineHeight > doc.page.height - 65) doc.addPage();
    const y = doc.y;
    doc.markContent('Span', {actual: line.logical});
    paintRuns(doc, line, x + (alignRight || line.rtl ? width - line.width : 0), y);
    doc.endMarkedContent();
    doc.x = x;
    doc.y = y + lineHeight;
  }
}

/** The width a text has in the embedded font at a size, measured the way it is drawn. */
export function pdfTextWidth(doc: Doc, value: string, size: number, rtl?: boolean): number {
  doc.fontSize(size);
  const [line] = pdfTextLines(value, 100000, measureText(doc), rtl === undefined ? undefined : rtl ? 'rtl' : 'ltr');
  return line?.width ?? 0;
}

export interface PdfTextAtOptions {
  size?: number;
  color?: string;
  /** The base direction of the text: the report's, not found in the text, so a number in an Arabic report sets as the report does. */
  rtl?: boolean;
  /** A figure that stands out: its letters filled and stroked a little. */
  bold?: boolean;
  /** An outline of this colour and width drawn before the letters, so a label can be read over a hatch. */
  halo?: {color: string; width: number};
}
/**
 * One line of text at an absolute position, for the labels of a chart: the left, centre or right edge of the text is at `x`
 * (physical, whatever the language) and `baseline` is where its letters stand. Arabic is shaped and reordered as the flowing
 * text is, the logical text travels with it (so a reader and an extraction get the words), and the cursor of the flowing text
 * is left where it was. Returns the width the text has in the embedded font.
 */
export function drawPdfTextAt(
  doc: Doc,
  value: string,
  x: number,
  baseline: number,
  anchor: 'left' | 'center' | 'right',
  options: PdfTextAtOptions = {},
): number {
  const size = options.size ?? 10;
  doc.fontSize(size);
  const [line] = pdfTextLines(
    value,
    100000,
    measureText(doc),
    options.rtl === undefined ? undefined : options.rtl ? 'rtl' : 'ltr',
  );
  if (!line?.runs.length) return 0;
  const cursor = {x: doc.x, y: doc.y},
    start = x - (anchor === 'right' ? line.width : anchor === 'center' ? line.width / 2 : 0);
  if (options.halo) {
    // The outline is decoration, not text: a reader of the file does not meet it twice.
    doc.markContent('Artifact');
    doc.save();
    doc.lineWidth(options.halo.width).lineJoin('round').strokeColor(options.halo.color);
    paintRuns(doc, line, start, baseline, true, {stroke: true});
    doc.restore();
    doc.endMarkedContent();
  }
  const color = options.color ?? '#000000';
  doc.fillColor(color);
  doc.markContent('Span', {actual: line.logical});
  if (options.bold) {
    doc.save();
    doc.lineWidth(size * 0.04).strokeColor(color);
    paintRuns(doc, line, start, baseline, true, {stroke: true, fill: true});
    doc.restore();
  } else paintRuns(doc, line, start, baseline, true);
  doc.endMarkedContent();
  doc.x = cursor.x;
  doc.y = cursor.y;
  return line.width;
}

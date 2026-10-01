import bidiFactory from 'bidi-js';
import type PDFDocument from 'pdfkit';
import {MirrorError} from './errors.js';

const bidi = bidiFactory();
const controls = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const rtlScript = /[\p{Script=Arabic}\p{Script=Hebrew}]/u;
// PDFKit 0.20 supports feature objects; its 0.17 typings only expose arrays. Mirroring is applied once by Unicode.
const features = {rtlm: false} as unknown as PDFKit.Mixins.TextOptions['features'];
type Run = {text: string; rtl: boolean};
type Line = {logical: string; runs: Run[]; width: number; rtl: boolean};

/** Unicode bidi reorders runs; Fontkit receives logical Arabic text so contextual shaping remains intact. */
export function pdfTextLines(value: string, width: number, measure: (text: string) => number): Line[] {
  if (value.length > 8192 || !Number.isFinite(width) || width <= 0)
    throw new MirrorError('REPORT_ARTIFACT_LIMIT', 'Narrow the report text before PDF rendering.');
  const lines: Line[] = [];
  for (const paragraph of value.split(/\r\n|[\r\n]/)) {
    const text = paragraph.trim(),
      embedding = bidi.getEmbeddingLevels(text),
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

export function drawPdfText(doc: InstanceType<typeof PDFDocument>, value: string, alignRight: boolean) {
  const width = 507,
    x = 44,
    lineHeight = doc.currentLineHeight(true) + 3;
  const lines = pdfTextLines(value, width, text => doc.widthOfString(text, {features}));
  for (const line of lines) {
    if (doc.y + lineHeight > doc.page.height - 65) doc.addPage();
    const y = doc.y;
    let at = x + (alignRight || line.rtl ? width - line.width : 0);
    doc.markContent('Span', {actual: line.logical});
    for (const run of line.runs) {
      // Numeric Arabic-script runs are LTR under Unicode. Shaping each grapheme prevents Fontkit reversing digits.
      const pieces =
        !run.rtl && rtlScript.test(run.text)
          ? [...new Intl.Segmenter('und', {granularity: 'grapheme'}).segment(run.text)].map(s => s.segment)
          : [run.text];
      for (const piece of pieces) {
        doc.text(piece, at, y, {lineBreak: false, features});
        at += doc.widthOfString(piece, {features});
      }
    }
    doc.endMarkedContent();
    doc.x = x;
    doc.y = y + lineHeight;
  }
}

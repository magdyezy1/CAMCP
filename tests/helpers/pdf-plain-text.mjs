import {inflateSync} from 'node:zlib';

/**
 * The text the report PDF draws in Latin script, read back from the file: PDFKit writes glyph numbers, so each glyph is
 * mapped through the font's own ToUnicode table. One string per text-showing operator (a wrapped paragraph is several).
 * Arabic text carries ActualText spans instead, which `pdfActualText` reads (tests/helpers/pdf-actual-text.mjs).
 */
export function pdfPlainText(bytes) {
  const raw = bytes.toString('latin1'),
    streams = [...raw.matchAll(/<<[^]*?\/Length (\d+)\s*\/Filter \/FlateDecode\s*>>\s*stream\r?\n/g)].map(match =>
      inflateSync(bytes.subarray(match.index + match[0].length, match.index + match[0].length + Number(match[1]))),
    ),
    glyphs = new Map();
  for (const stream of streams) {
    const text = stream.toString('latin1');
    if (!text.includes('beginbfrange') && !text.includes('beginbfchar')) continue;
    for (const range of text.matchAll(/<([0-9a-f]{4})>\s*<([0-9a-f]{4})>\s*\[([^\]]*)\]/g)) {
      const first = parseInt(range[1], 16);
      [...range[3].matchAll(/<([0-9a-f]+)>/g)].forEach((unit, offset) =>
        glyphs.set(first + offset, String.fromCodePoint(parseInt(unit[1], 16))),
      );
    }
    for (const pair of text.matchAll(/<([0-9a-f]{4})>\s*<([0-9a-f]+)>/g))
      if (!glyphs.has(parseInt(pair[1], 16)))
        glyphs.set(parseInt(pair[1], 16), String.fromCodePoint(parseInt(pair[2], 16)));
  }
  const lines = [];
  for (const stream of streams) {
    const text = stream.toString('latin1');
    if (!/ T[Jj]\b/.test(text)) continue;
    for (const operator of text.matchAll(/\[((?:<[0-9a-f]*>|\s|-?[\d.]+)*)\]\s*TJ/g))
      lines.push(
        [...operator[1].matchAll(/<([0-9a-f]*)>/g)]
          .map(hex => (hex[1].match(/.{4}/g) ?? []).map(code => glyphs.get(parseInt(code, 16)) ?? '?').join(''))
          .join(''),
      );
  }
  return lines;
}

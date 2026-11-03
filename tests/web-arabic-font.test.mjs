// V2-WEB-01: a local Arabic-only browser subset, with the original PDF font preserved.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {create} from 'fontkit';

const ranges = [
    [0x20, 0x20],
    [0xa0, 0xa0],
    [0x600, 0x6ff],
    [0x200c, 0x200f],
    [0x2066, 0x2069],
  ],
  allowed = point => ranges.some(([from, to]) => point >= from && point <= to),
  rangeText = 'U+0020, U+00A0, U+0600-06FF, U+200C-200F, U+2066-2069';
test('both website font faces load the Arabic WOFF2 subset for the declared code points only', () => {
  for (const file of ['web/localization.css', 'web/privacy.css']) {
    const css = fs.readFileSync(file, 'utf8'),
      face = [...css.matchAll(/@font-face\s*{([^}]+)}/g)].find(match =>
        /font-family:\s*['"]Noto Sans Arabic['"]/.test(match[1]),
      );
    assert.ok(face, file);
    const properties = Object.fromEntries(
      face[1]
        .split(';')
        .filter(text => text.includes(':'))
        .map(text => {
          const separator = text.indexOf(':');
          return [
            text.slice(0, separator).trim(),
            text
              .slice(separator + 1)
              .trim()
              .replace(/\s+/g, ' '),
          ];
        }),
    );
    assert.match(
      properties.src,
      /^url\(['"]\/assets\/fonts\/NotoSansArabic-subset\.woff2['"]\) format\(['"]woff2['"]\)$/,
    );
    assert.equal(properties['font-weight'], '100 900', file);
    assert.equal(properties['font-display'], 'swap', file);
    assert.equal(properties['unicode-range']?.toUpperCase(), rangeText, file);
  }
});
const strings = value =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(strings)
      : value && typeof value === 'object'
        ? Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)])
        : [];
test('the WOFF2 is under 250000 bytes, keeps only the weight axis and covers every displayed Arabic character', () => {
  const bytes = fs.readFileSync('web/fonts/NotoSansArabic-subset.woff2');
  assert.equal(bytes.subarray(0, 4).toString(), 'wOF2');
  assert.ok(bytes.length < 250000, 'subset bytes: ' + bytes.length);
  const font = create(bytes);
  assert.deepEqual(Object.keys(font.variationAxes), ['wght']);
  assert.deepEqual(
    [font.variationAxes.wght.min, font.variationAxes.wght.default, font.variationAxes.wght.max],
    [100, 400, 900],
  );
  const catalogs = [
      'web/locales/ar.json',
      ...fs
        .readdirSync('web/locales/ar')
        .filter(file => file.endsWith('.json'))
        .map(file => 'web/locales/ar/' + file),
    ],
    html = fs
      .readdirSync('web')
      .filter(file => file.endsWith('-ar.html'))
      .map(file => fs.readFileSync('web/' + file, 'utf8')),
    content = [...catalogs.flatMap(file => strings(JSON.parse(fs.readFileSync(file, 'utf8')))), ...html]
      .join(' ')
      .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_, hex, decimal) =>
        String.fromCodePoint(Number.parseInt(hex ?? decimal, hex ? 16 : 10)),
      )
      .replaceAll('&nbsp;', '\u00a0'),
    points = new Set([...content].map(char => char.codePointAt(0)).filter(allowed));
  for (const expected of [0x20, 0x627, 0x644]) assert.ok(points.has(expected), 'Arabic/space coverage input');
  assert.deepEqual(
    [...points]
      .filter(point => !font.hasGlyphForCodePoint(point))
      .map(point => 'U+' + point.toString(16).toUpperCase()),
    [],
  );
});
test('the PDF font is the unchanged original TTF', () => {
  const original = fs.readFileSync('web/fonts/NotoSansArabic.ttf');
  assert.equal(original.length, 844676);
  assert.equal(
    createHash('sha256').update(original).digest('hex'),
    '63111b5b2e074dd48cc67692e0a2726d86ee94c1c37fe8598257b7b4e87e869e',
  );
  assert.match(fs.readFileSync('src/report-artifacts.ts', 'utf8'), /NotoSansArabic\.ttf/);
});

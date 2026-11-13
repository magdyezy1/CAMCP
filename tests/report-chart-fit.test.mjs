import test from 'node:test';
import assert from 'node:assert/strict';
import PDFDocument from 'pdfkit';
import {chartTextWidth, fitChartText, wrapChartText} from '../dist/src/report-chart-layout.js';
import {pdfTextWidth} from '../dist/src/pdf-text.js';

/**
 * P2A-05 (differential review, wave 5 round 2 part 2a): fitChartText cut a long name one character at a time and measured
 * the joined text again after each, so a 160-character name cost 135 measures; with the PDF's real measure (bidi levels,
 * grapheme segmentation) that is 22 to 54 ms a cell, on the request's thread, for up to 24 charts of 11 rows. The cut is now
 * found by binary search on the prefix length, about 8 measures, and what it cuts is the same text.
 */
// The cut as it was made before: the reference of every comparison below.
function fitLikeBefore(text, max, size, measure = chartTextWidth) {
  if (measure(text, size) <= max) return text;
  const letters = [...text];
  while (letters.length && measure(letters.join('') + '…', size) > max) letters.pop();
  return letters.join('').trimEnd() + '…';
}
const repeat = (unit, length) => unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
const names = {
  latin: repeat('Spring sale retargeting for returning customers in North America and Europe, ', 160),
  mixed: repeat('حملة الصيف Summer sale 2026 — عرض خاص for returning customers مرحبا ', 160),
  arabic: repeat('حملة بيع الربيع لإعادة الاستهداف للعملاء العائدين في جميع المناطق ', 160),
};
const counted = measure => {
  const probe = (text, size) => (probe.calls++, measure(text, size));
  probe.calls = 0;
  return probe;
};
function pdfMeasure() {
  const doc = new PDFDocument({size: 'A4', margin: 44});
  doc.font('web/fonts/NotoSansArabic.ttf');
  return (text, size) => pdfTextWidth(doc, text, size);
}

test('a 160-character name is cut in about 8 measures, not one per character: Latin, mixed and Arabic', () => {
  for (const [label, name] of Object.entries(names)) {
    assert.equal([...name].length, 160, label);
    for (const [kind, measure] of [
      ['the layout’s width', chartTextWidth],
      ['the PDF’s width', pdfMeasure()],
    ]) {
      const size = 8,
        max = measure(name, size) / 2;
      const now = counted(measure),
        before = counted(measure);
      const fitted = fitChartText(name, max, size, now);
      assert.equal(fitted, fitLikeBefore(name, max, size, before), label + ' ' + kind + ': the same cut');
      assert.ok(fitted.endsWith('…') && fitted.length > 20 && fitted.length < 140, label + ': cut in the middle');
      assert.ok(measure(fitted, size) <= max + 0.01, label + ' ' + kind + ': it fits');
      // 1 for the whole text and about log2(160) = 8 for the cut; the old loop made one for each character it removed.
      assert.ok(now.calls <= 12, label + ' ' + kind + ': ' + now.calls + ' measures');
      assert.ok(before.calls > 60, label + ' ' + kind + ': the bound tells the old loop apart (' + before.calls + ')');
    }
  }
});

test('the cut of long names costs several times less than one measure per character, for any measure that costs by the length of its text', () => {
  // A measure that does work in proportion to the text it is given, as shaping and bidi do in the PDF's: the cost of a cut is
  // then the sum of the lengths measured, so the loop that measured every prefix pays for each, and the search for about 8.
  const costly = (text, size) => {
    let width = 0;
    for (let pass = 0; pass < 600; pass++) width = chartTextWidth(text, size);
    return width;
  };
  const run = fit => {
    const started = performance.now();
    for (let round = 0; round < 3; round++)
      for (const name of Object.values(names))
        for (const share of [0.3, 0.5, 0.8]) fit(name, chartTextWidth(name, 8) * share, 8, costly);
    return performance.now() - started;
  };
  run(fitChartText); // the measure and the engine warm
  const now = run(fitChartText),
    before = run(fitLikeBefore);
  assert.ok(now * 4 < before, `${now.toFixed(1)} ms against ${before.toFixed(1)} ms for the loop of before`);
});

test('the cut is the same text as before: random strings, widths and sizes, with both measures', () => {
  let seed = 20261113;
  const next = n => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return Math.floor(seed / 65536) % n;
  };
  // Latin, digits, spaces, Arabic, combining marks, CJK, an emoji (a surrogate pair) and punctuation.
  const alphabet = [...'abcdeXYZ 0123 ,.-—ابتثجحخدذرزسشصضطظعغفقكلمنهوي ًٌٍ中文日本😀é'];
  for (let i = 0; i < 4000; i++) {
    const text = Array.from({length: next(60)}, () => alphabet[next(alphabet.length)]).join(''),
      size = 8 + next(8),
      max = next(Math.ceil(chartTextWidth(text, size)) + 40) - 10;
    assert.equal(fitChartText(text, max, size), fitLikeBefore(text, max, size), JSON.stringify({text, max, size}));
  }
  // The PDF's own width (the embedded font, bidi levels, shaping): a few short strings, each cut at several widths.
  const pdf = pdfMeasure(),
    letters = [...'abcdeXYZ 0123 ,.-ابتثجحخدذرزسشصضطظعغفقكلمنهوي'];
  for (let i = 0; i < 12; i++) {
    const text = Array.from({length: 8 + next(24)}, () => letters[next(letters.length)]).join('');
    for (const share of [0.25, 0.5, 0.9])
      assert.equal(
        fitChartText(text, pdf(text, 8) * share, 8, pdf),
        fitLikeBefore(text, pdf(text, 8) * share, 8, pdf),
        JSON.stringify({text, share}),
      );
  }
  // The edges: nothing fits, only the ellipsis fits, a text that fits whole, an empty text, a trailing space before the cut.
  for (const [text, max] of [
    ['x', 3],
    ['abcdefghij', 1],
    ['abcdefghij', 0],
    ['abcdefghij', -5],
    ['', 100],
    ['', -1],
    ['abc', 1000],
    ['aaaa bbbb', 36],
    ['…', 5],
  ])
    assert.equal(fitChartText(text, max, 12), fitLikeBefore(text, max, 12), JSON.stringify({text, max}));
  // A measure of ten pixels a letter, as tests/report-chart-layout.test.mjs uses to show the cut is made by whatever measures.
  const tenEach = text => [...text].length * 10;
  assert.equal(fitChartText('x', 3, 12), '…');
  assert.equal(fitChartText('abcdefghij', 55, 12, tenEach), 'abcd…');
  assert.equal(fitChartText('abcdefghij', 55, 12, tenEach), fitLikeBefore('abcdefghij', 55, 12, tenEach));
});
test('wrapChartText cuts a long word and a last line the same way, in few measures', () => {
  const measure = counted(chartTextWidth),
    lines = wrapChartText(names.latin, 120, 12, 2, measure);
  assert.equal(lines.length, 2);
  assert.ok(lines.at(-1).endsWith('…'));
  const word = counted(chartTextWidth);
  assert.equal(wrapChartText('x'.repeat(160), 60, 12, 1, word)[0], fitLikeBefore('x'.repeat(160), 60, 12));
  assert.ok(word.calls <= 20, 'one long word: ' + word.calls + ' measures');
});

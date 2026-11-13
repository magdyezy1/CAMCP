// V2-EXP-01: text at an absolute position in a PDF, for the labels of a chart. The anchor is physical (the left, the centre or
// the right edge of the text sits at x), the y is the baseline, Arabic is shaped and reordered the way the flowing text of the
// report is, the logical text travels with it for readers and extraction, and the cursor of the flowing text is not moved.
import test from 'node:test';
import assert from 'node:assert/strict';
import {inflateSync} from 'node:zlib';
import PDFDocument from 'pdfkit';
import {drawPdfTextAt, pdfTextLines} from '../dist/src/pdf-text.js';
import {pdfActualText} from './helpers/pdf-actual-text.mjs';

const fontPath = 'web/fonts/NotoSansArabic.ttf';
const features = {rtlm: false};

/** Draws with `draw(doc)` on a fresh one-page document and returns the PDF bytes and the document. */
async function render(draw) {
  const doc = new PDFDocument({size: 'A4', margin: 44}),
    chunks = [],
    done = new Promise(resolve => {
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
    });
  doc.font(fontPath);
  const result = draw(doc);
  doc.end();
  return {bytes: await done, doc, result};
}
const streams = bytes =>
  [...bytes.toString('latin1').matchAll(/<<[^]*?\/Length (\d+)\s*\/Filter \/FlateDecode\s*>>\s*stream\r?\n/g)].map(
    match =>
      inflateSync(
        bytes.subarray(match.index + match[0].length, match.index + match[0].length + Number(match[1])),
      ).toString('latin1'),
  );
/**
 * Where each piece of text starts: the first text matrix of each text object, [x, y] in PDF space (y up). A piece of shaped
 * Arabic moves its marks with matrices of their own inside the same object; those are not where the piece starts.
 */
const matrices = bytes =>
  streams(bytes).flatMap(stream =>
    [...stream.matchAll(/BT\s+1 0 0 1 ([\d.-]+) ([\d.-]+) Tm/g)].map(match => [Number(match[1]), Number(match[2])]),
  );
const near = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 0.02, `${message}: ${actual} is not ${expected}`);

test('pdfTextLines takes the base direction when it is given, and finds it in the text when it is not', () => {
  const width = text => Array.from(text).length;
  assert.equal(pdfTextLines('12.50 USD', 100, width)[0].rtl, false);
  assert.equal(
    pdfTextLines('12.50 USD', 100, width, 'rtl')[0].rtl,
    true,
    'an Arabic report sets its numbers right to left',
  );
  assert.equal(pdfTextLines('تقرير', 100, width)[0].rtl, true);
  assert.equal(pdfTextLines('تقرير', 100, width, 'ltr')[0].rtl, false);
  assert.equal(pdfTextLines('Meta', 100, width, 'ltr')[0].rtl, false);
});

test('a text is anchored by its left, centre or right edge at x, on the baseline y, and its width is returned', async () => {
  const {bytes, doc, result} = await render(pdf => ({
    left: drawPdfTextAt(pdf, '12,345.60', 100, 200, 'left', {size: 12}),
    center: drawPdfTextAt(pdf, '12,345.60', 300, 300, 'center', {size: 12}),
    right: drawPdfTextAt(pdf, '12,345.60', 500, 400, 'right', {size: 12}),
  }));
  const width = result.left;
  assert.ok(width > 30 && width < 90, 'the width of the text at 12pt: ' + width);
  assert.equal(result.center, width);
  assert.equal(result.right, width);
  const [left, center, right] = matrices(bytes);
  near(left[0], 100, 'left');
  near(center[0], 300 - width / 2, 'centre');
  near(right[0], 500 - width, 'right');
  // PDF space has y up: the baseline of the text is page height minus y.
  for (const [matrix, y] of [
    [left, 200],
    [center, 300],
    [right, 400],
  ])
    near(matrix[1], doc.page.height - y, 'baseline');
  void features;
});

test('the width is the real width of the text in the embedded font, measured the way the flowing text is', async () => {
  const {result, doc} = await render(pdf => drawPdfTextAt(pdf, 'Campaign c1', 50, 100, 'left', {size: 10}));
  doc.fontSize(10);
  near(result, doc.widthOfString('Campaign c1', {features}), 'width');
  const bigger = await render(pdf => drawPdfTextAt(pdf, 'Campaign c1', 50, 100, 'left', {size: 20}));
  near(bigger.result, result * 2, 'twice the size, twice the width');
});

test('the cursor of the flowing text is where it was, and nothing is drawn for an empty text', async () => {
  const {doc, bytes} = await render(pdf => {
    pdf.x = 44;
    pdf.y = 120;
    drawPdfTextAt(pdf, 'Meta', 200, 300, 'left', {size: 10});
    drawPdfTextAt(pdf, 'مرحبا', 200, 320, 'right', {size: 10, rtl: true});
    assert.equal(drawPdfTextAt(pdf, '', 200, 340, 'left', {size: 10}), 0);
    assert.equal(drawPdfTextAt(pdf, '   ', 200, 340, 'left', {size: 10}), 0);
  });
  assert.deepEqual([doc.x, doc.y], [44, 120]);
  assert.equal(matrices(bytes).length >= 2, true);
});

test('the logical text travels with what is drawn, in English and Arabic, so a reader and an extraction get the words', async () => {
  const {bytes} = await render(pdf => {
    drawPdfTextAt(pdf, 'Spend by campaign', 44, 100, 'left', {size: 12});
    drawPdfTextAt(pdf, 'الإنفاق حسب الحملة', 551, 130, 'right', {size: 12, rtl: true});
    drawPdfTextAt(pdf, '</svg><script>alert(1)</script>', 44, 160, 'left', {size: 12});
  });
  const words = pdfActualText(bytes);
  assert.ok(words.includes('Spend by campaign'), words);
  assert.ok(words.includes('الإنفاق حسب الحملة'), words);
  assert.ok(words.includes('</svg><script>alert(1)</script>'), 'a name that is markup is only text');
  assert.doesNotMatch(bytes.toString('latin1'), /\/JavaScript|\/OpenAction/);
});

test('Arabic is drawn in the order a reader reads it: shaped runs, numbers kept left to right', async () => {
  const text = 'الإنفاق 12.50 USD';
  const {bytes, doc} = await render(pdf => drawPdfTextAt(pdf, text, 300, 100, 'right', {size: 12, rtl: true}));
  const lines = pdfTextLines(
    text,
    10000,
    string => {
      doc.fontSize(12);
      return doc.widthOfString(string, {features});
    },
    'rtl',
  );
  assert.equal(lines.length, 1);
  assert.ok(lines[0].runs.some(run => run.text === '12.50'));
  // One text-showing operation for each piece, at increasing x: the runs follow one another from the left.
  const xs = matrices(bytes).map(matrix => matrix[0]);
  assert.ok(xs.length >= 2);
  assert.deepEqual(
    [...xs].sort((a, b) => a - b),
    xs,
    'pieces are laid out from left to right',
  );
  near(xs[0], 300 - lines[0].width, 'the right edge of the whole line is at x');
});

test('a halo is drawn first and a bold figure is fill and stroke, so a label can be read over a hatch and a figure stands out', async () => {
  const plain = await render(pdf => drawPdfTextAt(pdf, '100.00', 100, 100, 'left', {size: 12}));
  const halo = await render(pdf =>
    drawPdfTextAt(pdf, '100.00', 100, 100, 'left', {size: 12, halo: {color: '#1baf7a', width: 3}}),
  );
  const bold = await render(pdf => drawPdfTextAt(pdf, '100.00', 100, 100, 'left', {size: 22, bold: true}));
  const modes = bytes => streams(bytes).flatMap(stream => [...stream.matchAll(/(\d) Tr/g)].map(match => match[1]));
  assert.deepEqual(modes(plain.bytes), []);
  assert.deepEqual(modes(halo.bytes), ['1'], 'one pass strokes the outline of the letters');
  assert.equal(matrices(halo.bytes).length, 2, 'then the letters are drawn on top');
  assert.deepEqual(modes(bold.bytes), ['2']);
});

test('a text of any size is drawn in the colour it is given', async () => {
  const {bytes} = await render(pdf => drawPdfTextAt(pdf, 'x', 10, 10, 'left', {size: 12, color: '#6250d6'}));
  // 0x62 0x50 0xd6 as fractions of 255.
  assert.ok(streams(bytes).some(stream => /0\.3843\d* 0\.3137\d* 0\.8392\d* scn/.test(stream)));
});

// P2B-02 (differential review, wave 5 round 2 part 2b): a combining mark directly after a space or a no-break space made
// fontkit throw inside its mark placement (`TypeError ... xCoordinate`) whenever the string was measured or drawn with the
// shaping option the PDF text carries, so one provider-controlled campaign name failed the whole report PDF export. Measuring
// and drawing are total: such a string is measured and drawn, and nothing is thrown. The glyph filter is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import PDFDocument from 'pdfkit';
import {reportPdf} from '../dist/src/report-artifacts.js';
import {drawPdfText, drawPdfTextAt, pdfTextWidth} from '../dist/src/pdf-text.js';
import {chartRow} from './helpers/chart-rows.mjs';
import {charts, of} from './helpers/chart-specimens.mjs';
import {packFixture} from './fixtures/report-pack-data.mjs';
import {pdfActualText} from './helpers/pdf-actual-text.mjs';
import {pdfPlainText} from './helpers/pdf-plain-text.mjs';

const marks = [
  ['ً', 'ARABIC FATHATAN'],
  ['ّ', 'ARABIC SHADDA'],
  ['́', 'COMBINING ACUTE ACCENT'],
];
const spaces = [
  [' ', 'a space'],
  [' ', 'a no-break space'],
];
const bases = [
  ['Y', 'a letter'],
  ['Summer sale', 'two Latin words'],
  ['مرحبا', 'an Arabic word'],
];
const withCharts = specs => ({...packFixture(), charts: specs});
const pdfWords = bytes => (pdfPlainText(bytes).join(' ') + ' ' + pdfActualText(bytes)).replace(/\s+/g, ' ');
const newDoc = () => {
  const doc = new PDFDocument({size: 'A4', margin: 44});
  doc.font('web/fonts/NotoSansArabic.ttf');
  return doc;
};
const finish = doc => {
  const chunks = [],
    done = new Promise(accept => doc.on('end', accept));
  doc.on('data', chunk => chunks.push(chunk));
  doc.end();
  return done.then(() => Buffer.concat(chunks));
};

test('a mark after a space or a no-break space is measured, and adds no width (P2B-02)', () => {
  const doc = newDoc();
  let cases = 0;
  for (const [base, baseName] of bases)
    for (const [space, spaceName] of spaces)
      for (const rtl of [undefined, false, true]) {
        const widths = [],
          label = `${baseName}, ${spaceName}, rtl ${rtl}`;
        for (const [mark, markName] of marks) {
          let width;
          assert.doesNotThrow(() => (width = pdfTextWidth(doc, base + space + mark, 8, rtl)), `${label}, ${markName}`);
          assert.ok(Number.isFinite(width) && width > 0, `${label}, ${markName}: ${width}`);
          widths.push(width);
          cases++;
        }
        // A mark has no advance of its own: every mark gives the same width, and the space before it (which is not at the end
        // of the text, so it is not trimmed) makes the text wider than its base alone.
        assert.ok(
          widths.every(width => Math.abs(width - widths[0]) < 1e-9),
          `${label}: ${widths}`,
        );
        assert.ok(widths[0] > pdfTextWidth(doc, base, 8, rtl), `${label}: the space counts`);
      }
  assert.equal(cases, 3 * 2 * 3 * 3);
});

test('a mark after white space is drawn by drawPdfText and drawPdfTextAt, and the text can be read back (P2B-02)', async () => {
  const doc = newDoc(),
    names = [];
  for (const [base] of bases)
    for (const [space] of spaces)
      for (const [mark] of marks) {
        const name = base + space + mark;
        names.push(name);
        assert.doesNotThrow(() => drawPdfText(doc, name, false), 'drawPdfText ' + JSON.stringify(name));
        let width;
        assert.doesNotThrow(
          () => (width = drawPdfTextAt(doc, name, 300, doc.y + 20, 'left', {size: 8})),
          'drawPdfTextAt ' + JSON.stringify(name),
        );
        assert.equal(
          width,
          pdfTextWidth(doc, name, 8),
          'the width drawn is the width measured: ' + JSON.stringify(name),
        );
      }
  const read = pdfActualText(await finish(doc));
  // Every name is in the file as its reader would read it (the flowing text keeps the logical text beside the letters).
  for (const name of names)
    assert.ok(read.includes(name.trim().replace(/\s+/gu, ' ')), 'not read back: ' + JSON.stringify(name));
});

test('a whole report PDF with charts is exported when a campaign name has a mark after a space, in both languages (P2B-02)', async () => {
  const campaignNames = ['Summer sale ً', 'Summer sale ً', 'Spring ́', 'Spring ́', 'مرحبا ً', 'مرحبا ً', 'Plain name'];
  const rows = campaignNames.map((name, i) =>
      chartRow('c' + (i + 1), String(100 - i * 10), '2', {campaign_name: name}),
    ),
    specs = [of(charts(rows), 'spend_by_entity')[0]];
  for (const options of [{}, {artifact_language: 'ar'}]) {
    const bytes = await reportPdf(withCharts(specs), options),
      words = pdfWords(bytes);
    assert.ok(bytes.length > 2000, JSON.stringify(options) + ': a PDF');
    assert.ok(words.includes('Plain name'), JSON.stringify(options) + ': the other names are drawn too');
    assert.ok(words.includes('Summer sale'), JSON.stringify(options) + ': the name with the mark is drawn');
  }
  // Each name once as the largest entity of its chart: the sentences that quote the largest entity (the takeaway, the notes) are
  // flowing text, which a Latin report draws with PDFKit's own text call, and which threw for a no-break space and a mark with
  // or without the shaping option.
  for (const name of campaignNames)
    for (const options of [{}, {artifact_language: 'ar'}]) {
      const lone = [
          chartRow('c1', '100', '2', {campaign_name: name}),
          chartRow('c2', '50', '2', {campaign_name: 'Plain name'}),
          chartRow('c3', '10', '2', {campaign_name: 'Other name'}),
        ],
        label = JSON.stringify(name) + ' ' + JSON.stringify(options);
      let bytes;
      await assert.doesNotReject(
        async () => (bytes = await reportPdf(withCharts([of(charts(lone), 'spend_by_entity')[0]]), options)),
        label,
      );
      const words = pdfWords(bytes);
      assert.ok(words.includes('Plain name'), label + ': the other names are drawn');
      assert.ok(words.includes(name.split(/[\s ]/u)[0]), label + ': the name is drawn');
    }
});

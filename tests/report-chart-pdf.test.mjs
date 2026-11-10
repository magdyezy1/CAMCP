// V2-EXP-01: the PDF back end. A report that carries charts has a Charts section in its PDF: for each chart a title, a
// takeaway, the picture (drawn with the layout every back end shares, in print texture), its notes and its table, so the
// words of every chart can be read back from the file, in English and Arabic (probe 16, PDF side: a name that is markup is
// text). A chart that cannot honestly be drawn keeps its notes and its table. A report without charts is as it was.
import test from 'node:test';
import assert from 'node:assert/strict';
import {inflateSync} from 'node:zlib';
import {openSync} from 'fontkit';
import PDFDocument from 'pdfkit';
import {reportPdf} from '../dist/src/report-artifacts.js';
import {drawChartPdf} from '../dist/src/report-chart-pdf.js';
import {chartLayout} from '../dist/src/report-chart-layout.js';
import {pdfTextLines} from '../dist/src/pdf-text.js';
import {chartMessageText, chartNoteText, chartTableText} from '../dist/src/report-chart-theme.js';
import {artifactLocale} from '../dist/src/report-localization.js';
import {chartRow} from './helpers/chart-rows.mjs';
import {
  barsSpec,
  campaigns,
  charts,
  costSpec,
  foldedBarsSpec,
  foldedStackSpec,
  lineSpec,
  of,
  shortLineSpec,
  stackSpec,
  tilesSpec,
} from './helpers/chart-specimens.mjs';
import {packFixture} from './fixtures/report-pack-data.mjs';
import {pdfActualText} from './helpers/pdf-actual-text.mjs';
import {pdfPlainText} from './helpers/pdf-plain-text.mjs';

const en = artifactLocale({artifact_language: 'en'}),
  ar = artifactLocale({artifact_language: 'ar'});
const withCharts = specs => ({...packFixture(), charts: specs});
const pdfWords = bytes => (pdfPlainText(bytes).join(' ') + ' ' + pdfActualText(bytes)).replace(/\s+/g, ' ');
const streams = bytes =>
  [...bytes.toString('latin1').matchAll(/<<[^]*?\/Length (\d+)\s*\/Filter \/FlateDecode\s*>>\s*stream\r?\n/g)].map(
    match =>
      inflateSync(
        bytes.subarray(match.index + match[0].length, match.index + match[0].length + Number(match[1])),
      ).toString('latin1'),
  );
const font = openSync('web/fonts/NotoSansArabic.ttf');
const everyKind = () => [tilesSpec(), foldedBarsSpec(), costSpec(), stackSpec(), lineSpec(), shortLineSpec()];

/** What a chart says in words, in one language: its title, takeaway, notes and the cells of its table. */
function wordsOf(spec, locale) {
  const table = chartTableText(spec, locale);
  return [
    chartMessageText(spec.title, locale),
    ...(spec.takeaway ? [chartMessageText(spec.takeaway, locale)] : []),
    ...spec.notes.map(note => chartNoteText(note, locale)),
    // A heading that does not fit its column goes on a second line, so it is read back word by word.
    ...table.columns.flatMap(column => column.label.split(/\s+/)),
    ...table.rows.flat().filter(Boolean),
  ];
}

test('a report with charts has a Charts section, and every word of every chart can be read back from the PDF', async () => {
  const specs = everyKind(),
    words = pdfWords(await reportPdf(withCharts(specs)));
  assert.ok(words.includes('Charts'), 'the section has its heading');
  // Nothing is cut short: these charts have no name too long for its column, and a heading goes on more lines instead.
  assert.ok(!words.includes('…'), 'a text was cut with an ellipsis');
  for (const spec of specs)
    for (const word of wordsOf(spec, en)) assert.ok(words.includes(word), `${spec.kind} ${spec.id}: "${word}"`);
});

test('in Arabic the section, the titles, the sentences, the notes and the headings are in Arabic, and the numbers are as they were', async () => {
  const specs = everyKind(),
    bytes = await reportPdf(withCharts(specs), {artifact_language: 'ar'}),
    words = pdfActualText(bytes);
  assert.ok(words.includes(ar.text('Charts')));
  assert.notEqual(ar.text('Charts'), 'Charts');
  assert.ok(!words.includes('…'), 'a text was cut with an ellipsis');
  for (const spec of specs)
    for (const word of wordsOf(spec, ar)) assert.ok(words.includes(word), `${spec.kind}: "${word}"`);
  assert.match(bytes.toString('latin1'), /\/Lang \(ar\)/);
});

test('a date and an amount in an Arabic sentence keep their own order: they are drawn as one run each', () => {
  const sentence = chartMessageText(lineSpec().takeaway, ar),
    [line] = pdfTextLines(sentence, 100000, text => Array.from(text).length);
  assert.equal(line.rtl, true);
  const runs = line.runs.map(run => run.text);
  assert.ok(runs.includes('2026-10-19'), 'the day is not turned around: ' + JSON.stringify(runs));
  assert.ok(runs.includes('90.00 USD'), 'nor is the amount: ' + JSON.stringify(runs));
  // The same sentence without isolates is what went wrong: the day was drawn as 19-10-2026.
  const bare = pdfTextLines(sentence.replace(/\p{Bidi_Control}/gu, ''), 100000, text => Array.from(text).length)[0];
  assert.ok(!bare.runs.some(run => run.text === '2026-10-19'));
});

test('probe 16: a name that is markup is text in the PDF, and the file carries no script', async () => {
  const bytes = await reportPdf(withCharts([barsSpec()])),
    raw = bytes.toString('latin1');
  assert.ok(pdfWords(bytes).includes('</svg><script>alert(1)</script>'));
  assert.doesNotMatch(raw, /\/JavaScript|\/JS\b|\/OpenAction|\/Launch/);
  assert.equal(raw.slice(0, 5), '%PDF-');
});

test('print texture: the fills other than the first hue are hatched or dotted, clipped to their bar', async () => {
  const plain = streams(await reportPdf(withCharts([foldedBarsSpec()]))).join('\n'),
    bytes = await reportPdf(withCharts([foldedStackSpec()])),
    content = streams(bytes).join('\n');
  // Clipping operators: one for each hatched or dotted mark (three series, the segments of Other too, the legend swatches).
  const clips = text => (text.match(/\bW n\b/g) ?? []).length;
  assert.ok(clips(content) >= 6, 'clipped marks: ' + clips(content));
  // Ranked bars of one hue (and the neutral Other) have far fewer.
  assert.ok(clips(plain) < clips(content));
});

test('a name the PDF font cannot draw is shown as ? with a note, and the export still works', async () => {
  const emoji = String.fromCodePoint(0x1f525);
  assert.equal(font.hasGlyphForCodePoint(0x1f525), false, 'the font has no emoji');
  assert.equal(font.hasGlyphForCodePoint('中'.codePointAt(0)), false, 'and no Chinese');
  const rows = [
      chartRow('c1', '100', '2', {campaign_name: `${emoji} Summer sale`}),
      chartRow('c2', '50', '2', {campaign_name: '中文活动'}),
      chartRow('c3', '25', '2', {campaign_name: 'Plain name'}),
    ],
    [spec] = of(charts(rows), 'spend_by_entity'),
    bytes = await reportPdf(withCharts([spec])),
    words = pdfWords(bytes);
  assert.ok(words.includes('? Summer sale'), 'the emoji is one ?');
  assert.ok(words.includes('Plain name'));
  assert.ok(
    words.includes('Characters missing from the PDF font are shown as ?. The Excel download has every name in full.'),
  );
  // The same names do not stop the report in Arabic.
  const arabic = pdfActualText(await reportPdf(withCharts([spec]), {artifact_language: 'ar'}));
  assert.ok(
    arabic.includes(
      ar.text('Characters missing from the PDF font are shown as ?. The Excel download has every name in full.'),
    ),
  );
  // A report with no such name has no such note.
  assert.ok(!pdfWords(await reportPdf(withCharts([barsSpec()]))).includes('Characters missing from the PDF font'));
});

test('a chart that cannot honestly be drawn keeps its notes and its table', async () => {
  const [one] = of(charts(campaigns([30])), 'spend_by_entity');
  assert.equal(one.drawn, false);
  const words = pdfWords(await reportPdf(withCharts([one])));
  for (const word of wordsOf(one, en)) assert.ok(words.includes(word), `"${word}"`);
  assert.ok(words.includes('There is only one entry, so there is nothing to compare. The table has it.'));
  assert.ok(words.includes('Campaign c1') && words.includes('30.00'));
});

test('a report without charts is as it was: no Charts section, and the same few pages', async () => {
  const bytes = await reportPdf(packFixture()),
    arabic = await reportPdf(packFixture(), {artifact_language: 'ar'});
  assert.ok(!pdfWords(bytes).includes('Charts'));
  assert.ok(!pdfActualText(arabic).includes(ar.text('Charts')));
  for (const file of [bytes, arabic]) assert.ok((file.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length <= 4);
  // An empty list of charts is no charts.
  assert.ok(!pdfWords(await reportPdf({...packFixture(), charts: []})).includes('Charts'));
});

test('no more than 24 charts are drawn, in order, and the section says there are more', async () => {
  const many = Array.from({length: 30}, (_, index) => {
    const title = `Chart number ${index + 1}`;
    return {...lineSpec(), id: 'line:' + index, title: {key: title, params: {}, text: title}};
  });
  const words = pdfWords(await reportPdf(withCharts(many)));
  assert.ok(words.includes('Chart number 1') && words.includes('Chart number 24'));
  assert.ok(!words.includes('Chart number 25'));
  assert.ok(words.includes('Only the first 24 charts are in this file. The report page has the rest.'));
});

test('everything is drawn on the page: no text starts below the margin or above the top, over many pages', async () => {
  const bytes = await reportPdf(withCharts(Array.from({length: 12}, () => foldedBarsSpec()))),
    pages = (bytes.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
  assert.ok(pages > 3, 'twelve ranked charts take several pages: ' + pages);
  // The page number at the foot of each page is drawn below the margin on purpose (its baseline is 24pt from the bottom);
  // everything else stays inside the margins.
  for (const content of streams(bytes))
    for (const match of content.matchAll(/BT\s+1 0 0 1 ([\d.-]+) ([\d.-]+) Tm/g)) {
      const [x, y] = [Number(match[1]), Number(match[2])];
      assert.ok(x > 0 && x < 595.28, 'x ' + x);
      if (y > 30) assert.ok(y >= 55 && y < 800, 'y ' + y);
      else assert.ok(y > 20, 'the page number: ' + y);
    }
});

test('drawChartPdf draws the chart in its box and says how tall it is, or draws nothing for a chart that is not drawn', async () => {
  const chunks = [],
    doc = new PDFDocument({size: 'A4', margin: 44});
  doc.on('data', chunk => chunks.push(chunk));
  doc.font('web/fonts/NotoSansArabic.ttf');
  const spec = costSpec(),
    drawn = drawChartPdf(
      doc,
      spec,
      {x: 44, y: 100, width: 507},
      {locale: en, hasGlyph: code => font.hasGlyphForCodePoint(code)},
    ),
    scene = chartLayout(spec, {width: 507, language: 'en', t: text => text});
  assert.equal(drawn.height, scene.height);
  assert.equal(drawn.replaced, false);
  const [one] = of(charts(campaigns([30])), 'spend_by_entity');
  assert.equal(drawChartPdf(doc, one, {x: 44, y: 100, width: 507}, {locale: en, hasGlyph: () => true}), null);
  doc.end();
});

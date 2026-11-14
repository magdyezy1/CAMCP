// Ruling 16 (7): the browser kind `report-pdf-export` asserts that a downloaded report is a PDF that opens. There is no PDF reader in
// the headless browser it runs in, so `openPdf` (tests/helpers/pdf-structure.mjs) does what a reader does before it shows a page: it
// finds the end marker and the cross-reference table, reads every object where the table says it is, follows the trailer to the
// catalog and the page tree, and inflates every compressed stream. This file holds that helper to what it claims: it opens the files
// the product writes and refuses a file that a reader would refuse.
import test from 'node:test';
import assert from 'node:assert/strict';
import PDFDocument from 'pdfkit';
import {reportPdf} from '../dist/src/report-artifacts.js';
import {packFixture} from './fixtures/report-pack-data.mjs';
import {openPdf} from './helpers/pdf-structure.mjs';

const finish = doc => {
  const chunks = [],
    done = new Promise(accept => doc.on('end', accept));
  doc.on('data', chunk => chunks.push(chunk));
  doc.end();
  return done.then(() => Buffer.concat(chunks));
};
async function twoPages() {
  const doc = new PDFDocument({size: 'A4', margin: 44});
  doc.fontSize(14).text('A first page of synthetic text.');
  doc.addPage().text('A second page.');
  return finish(doc);
}
const refused = (bytes, message) => assert.throws(() => openPdf(bytes), {code: 'ERR_ASSERTION', message});

test('a PDF the library writes opens: its pages, objects and compressed streams are read', async () => {
  const opened = openPdf(await twoPages());
  assert.equal(opened.pages, 2);
  assert.ok(opened.objects >= 6, 'objects: ' + opened.objects);
  assert.ok(opened.streams >= 2, 'a content stream for each page: ' + opened.streams);
  assert.ok(opened.inflated > 20, 'the streams hold something: ' + opened.inflated);
});

test('the report PDF of the product opens, in English and in Arabic', async () => {
  for (const options of [{}, {artifact_language: 'ar'}]) {
    const opened = openPdf(await reportPdf(packFixture(), options));
    assert.ok(opened.pages >= 1, JSON.stringify(options) + ': pages ' + opened.pages);
    assert.ok(opened.streams > opened.pages, JSON.stringify(options) + ': fonts and content are streams too');
  }
});

test('a file a reader would refuse is refused, each for its own reason', async () => {
  const good = await twoPages(),
    text = good.toString('latin1');
  refused(Buffer.from('not a pdf at all'), /header/);
  refused(good.subarray(0, good.length - 60), /startxref/);
  refused(Buffer.concat([good, Buffer.from('trailing bytes after the marker')]), /startxref/);
  // The cross-reference offset names a place where the table is not.
  const at = Number(/startxref\s+(\d+)/.exec(text)[1]);
  refused(Buffer.from(text.replace(/startxref\s+\d+/, 'startxref ' + (at + 3)), 'latin1'), /cross-reference/);
  // An object is not where the table says: the first in-use offset is moved by one byte.
  const entry = /(\d{10}) 00000 n/.exec(text);
  refused(
    Buffer.from(text.replace(entry[0], String(Number(entry[1]) + 1).padStart(10, '0') + ' 00000 n'), 'latin1'),
    /object/,
  );
  // A compressed stream is damaged in the middle of its data.
  const start = text.indexOf('stream\n') + 'stream\n'.length,
    damaged = Buffer.from(good);
  damaged[start + 8] ^= 0xff;
  damaged[start + 9] ^= 0xff;
  assert.throws(() => openPdf(damaged), {code: 'ERR_ASSERTION', message: /stream/});
  // The page tree counts a page it does not have.
  refused(Buffer.from(text.replace(/\/Count 2/, '/Count 3'), 'latin1'), /pages/);
});

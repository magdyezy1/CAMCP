import assert from 'node:assert/strict';
import {inflateSync} from 'node:zlib';

/**
 * Whether a file is a PDF that a reader opens, by what a reader does first: finds the end marker and the cross-reference table,
 * reads each object where the table says it is, follows the trailer to the catalog and the page tree, and inflates every
 * compressed stream. Returns what it found; throws an assertion where a reader would refuse the file. It reads the classic
 * cross-reference table that PDFKit writes (the product's only PDF writer), not a cross-reference stream.
 */
export function openPdf(bytes) {
  const text = bytes.toString('latin1');
  assert.equal(text.slice(0, 5), '%PDF-', 'a PDF starts with its header');
  const eof = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(text.slice(-200));
  assert.ok(eof, 'a PDF ends with startxref and the end-of-file marker');
  const tableAt = Number(eof[1]);
  assert.equal(text.slice(tableAt, tableAt + 4), 'xref', 'startxref names the cross-reference table');
  const table = /^xref\s+([\s\S]*?)trailer\s*<<([\s\S]*?)>>/.exec(text.slice(tableAt));
  assert.ok(table, 'the cross-reference table is followed by a trailer');
  // The subsections: `first count`, then `count` entries of `offset generation n|f`.
  const tokens = table[1].trim().split(/\s+/),
    inUse = new Map();
  let entries = 0;
  for (let i = 0; i < tokens.length;) {
    const first = Number(tokens[i++]),
      count = Number(tokens[i++]);
    assert.ok(Number.isInteger(first) && Number.isInteger(count), 'a cross-reference subsection header');
    for (let k = 0; k < count; k++, i += 3) {
      const offset = Number(tokens[i]),
        kind = tokens[i + 2];
      assert.ok(kind === 'n' || kind === 'f', 'a cross-reference entry is in use or free');
      entries++;
      if (kind === 'n') inUse.set(first + k, offset);
    }
  }
  assert.equal(Number(/\/Size\s+(\d+)/.exec(table[2])?.[1]), entries, 'the trailer counts the entries of the table');
  const bodies = new Map();
  for (const [number, offset] of inUse) {
    assert.ok(
      text.startsWith(number + ' 0 obj', offset),
      `object ${number} is not where the cross-reference table says (byte ${offset})`,
    );
    const end = text.indexOf('endobj', offset);
    assert.ok(end > offset, `object ${number} has no end`);
    bodies.set(number, text.slice(offset, end));
  }
  const reference = (body, key) => Number(new RegExp('/' + key + '\\s+(\\d+)\\s+0\\s+R').exec(body)?.[1]);
  const catalog = bodies.get(reference(table[2], 'Root'));
  assert.match(catalog ?? '', /\/Type\s*\/Catalog/, 'the trailer names the catalog');
  const tree = bodies.get(reference(catalog, 'Pages'));
  assert.match(tree ?? '', /\/Type\s*\/Pages/, 'the catalog names the page tree');
  const kids = [...(/\/Kids\s*\[([^\]]*)\]/.exec(tree)?.[1] ?? '').matchAll(/(\d+)\s+0\s+R/g)].map(m => Number(m[1])),
    counted = Number(/\/Count\s+(\d+)/.exec(tree)?.[1]);
  assert.equal(counted, kids.length, 'the page tree counts its pages');
  for (const kid of kids) assert.match(bodies.get(kid) ?? '', /\/Type\s*\/Page(?![s\w])/, `page object ${kid}`);
  // Every stream has its declared length and, when compressed, inflates.
  let streams = 0,
    inflated = 0;
  for (const [number, body] of bodies) {
    const at = body.indexOf('stream');
    if (at < 0 || !/>>\s*stream/.test(body)) continue;
    const length = Number(/\/Length\s+(\d+)/.exec(body.slice(0, at))?.[1]);
    assert.ok(Number.isInteger(length), `the stream of object ${number} declares its length`);
    const start = inUse.get(number) + at + (body.startsWith('\r\n', at + 6) ? 'stream\r\n'.length : 'stream\n'.length);
    assert.ok(
      /^\s*endstream/.test(text.slice(start + length, start + length + 12)),
      `the stream of object ${number} ends where it declares`,
    );
    streams++;
    if (/\/FlateDecode/.test(body.slice(0, at))) {
      try {
        inflated += inflateSync(bytes.subarray(start, start + length)).length;
      } catch (error) {
        assert.fail(`the stream of object ${number} does not inflate: ${error.message}`);
      }
    }
  }
  return {pages: kids.length, objects: inUse.size, streams, inflated};
}

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  changedStateFields,
  changedComparableFields,
  comparableStateHash,
  reviewStateHash,
  normalizeComparable,
} from '../dist/src/review-state.js';

/**
 * R2.5 M1 (package r25-m1-hash, lead review S3-1): a link write must not verify as applied when it was not sent as
 * reviewed. The review projection drops the signing and expiry parameters of the links a provider signs itself, because they
 * rotate between two reads of the same state; a verification compares what a write SENT with what the provider STORED, and a
 * link is a value the provider must return as it was sent. So a family that verifies its own write compares with
 * `changedComparableFields` (the table's names left out, every URL left whole), never with the review's `changedStateFields`.
 * Synthetic values only.
 */
const table = Object.freeze(['stats', 'signed-host:cdn.example', 'signed-field:preview_link']);
const sent = {uri: 'https://cdn.example/book?ticket=NEW&a=1', preview_link: 'https://x.example/p?sig=NEW', stats: 1};
const stored = {uri: 'https://cdn.example/book?ticket=OLD&a=1', preview_link: 'https://x.example/p?sig=OLD', stats: 2};

test('a link that differs only by a signing parameter is the same state to a review and another value to a verification', () => {
  // The review's comparison of two reads of one state: the rotating parameters are no change.
  assert.deepEqual(changedStateFields(sent, stored, table), []);
  assert.equal(reviewStateHash(sent, table), reviewStateHash(stored, table));
  // A verification of a write: what was stored is not what was sent, in both places it stands.
  assert.deepEqual(changedComparableFields(sent, stored, table), ['$["preview_link"]', '$["uri"]']);
  assert.notEqual(comparableStateHash(sent, table), comparableStateHash(stored, table));
});

test('a verification still leaves out what the table says changes by itself, and keeps the order and the names', () => {
  const same = {...sent, stats: 99};
  assert.deepEqual(changedComparableFields(sent, same, table), []);
  assert.equal(comparableStateHash(sent, table), comparableStateHash(same, table));
  assert.deepEqual(normalizeComparable({b: 1, stats: 5, a: [1, 2]}, table), {a: [1, 2], b: 1});
  // The paths are the review's: from the root, a key as JSON, an index in brackets.
  assert.deepEqual(changedComparableFields({rows: [{uri: 'a'}]}, {rows: [{uri: 'b'}]}, table), ['$["rows"][0]["uri"]']);
});

test('where a table declares no link the two comparisons are the same (property)', () => {
  let seed = 20261116;
  const r = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0), seed / 4294967296),
    names = ['id', 'name', 'stats', 'uri', 'budget'],
    plain = ['https://shop.example/p?ticket=1', 'https://shop.example/p?ticket=2', 'a', 7, true, null],
    random = depth =>
      depth > 2 || r() < 0.4
        ? plain[Math.floor(r() * plain.length)]
        : r() < 0.4
          ? Array.from({length: Math.floor(r() * 3)}, () => random(depth + 1))
          : Object.fromEntries(
              Array.from({length: Math.floor(r() * 4)}, () => [
                names[Math.floor(r() * names.length)],
                random(depth + 1),
              ]),
            );
  for (const declared of [[], ['stats']])
    for (let i = 0; i < 300; i++) {
      const a = random(0),
        b = random(0);
      assert.deepEqual(
        changedComparableFields(a, b, declared),
        changedStateFields(a, b, declared),
        JSON.stringify({a, b}),
      );
      assert.equal(comparableStateHash(a, declared), reviewStateHash(a, declared));
    }
});

// --- Where the URL rule may be applied: the review side only ----------------------------------------------------------------

const sources = fs
  .readdirSync(new URL('../src/', import.meta.url))
  .filter(name => name.endsWith('.ts'))
  .map(name => [name, fs.readFileSync(new URL('../src/' + name, import.meta.url), 'utf8')]);
const callers = call => sources.filter(([, text]) => text.includes(call)).map(([name]) => name);

test('only the review applies the value-shape rule of URLs: no family verification calls the review’s comparison or hash', () => {
  // The review side: it hashes and compares two reads of the SAME state, where a link a provider signs anew at every read is
  // no change (src/write-review.ts, the media transfer's own review of an account read, and the reconciliation of an
  // uncertain write against the state before it). Every other module of src/ that compares a write with what the provider
  // stores uses the comparable forms.
  assert.deepEqual(callers('changedStateFields('), ['media-upload.ts', 'review-state-core.ts', 'write-review.ts']);
  assert.deepEqual(callers('reviewStateHash('), ['media-upload.ts', 'write-reconciliation.ts', 'write-review.ts']);
});

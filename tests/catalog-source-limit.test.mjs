import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {catalogSizeProblems, catalogSourceLimit, checkWebLocales} from '../tools/check-locales.mjs';

// R2.5 M4a merge, the lead's decision of 2026-11-21: the authored Arabic catalog (web/locales/ar.json) may be 2,359,296 bytes
// (2.25 MiB), up from 2 MiB, because the merged M4 packages together cross the old bound. It is AMCP's own build-time ratchet:
// the browser loads the generated chunks, never this file. Two checks read the one constant, tools/check-locales.mjs
// `catalogSourceLimit`: the build (here) and the deployed byte comparison (tools/check-public-website.mjs, pinned at the bound
// and one byte over it in tests/public-website-comparison.test.mjs).
const limit = 2359296;

test('the Arabic catalog bound is 2,359,296 bytes (2.25 MiB), the lead’s value', () => {
  assert.equal(catalogSourceLimit, limit);
});

const exceeded = ['Arabic catalog exceeds the 2,359,296 byte UTF-8 limit (2.25 MiB).'];

test('a catalog of exactly the bound passes, one byte over it is a problem that names the bound', () => {
  assert.deepEqual(catalogSizeProblems(' '.repeat(limit)), []);
  assert.deepEqual(catalogSizeProblems(' '.repeat(limit + 1)), exceeded);
  assert.deepEqual(catalogSizeProblems(''), []);
});

test('the bound counts UTF-8 bytes, not characters (an Arabic letter is two)', () => {
  assert.deepEqual(catalogSizeProblems('ب'.repeat(limit / 2)), []);
  assert.deepEqual(catalogSizeProblems('ب'.repeat(limit / 2) + ' '), exceeded);
  assert.deepEqual(catalogSizeProblems('ب'.repeat(limit / 2 + 1)), exceeded);
});

test('check-locales, run on the real tree with a catalog one byte over the bound, reports that and nothing else', t => {
  const file = path.resolve('web/locales/ar.json'),
    real = fs.readFileSync(file, 'utf8'),
    read = fs.readFileSync;
  assert.ok(Buffer.byteLength(real, 'utf8') <= limit, 'the real catalog is within the bound');
  // JSON allows trailing white space, so the padded catalog is the real one and only its size changes. check-locales reads it
  // through fs.readFileSync: serve the padded text for that one path and leave every other read real.
  const padded = real + ' '.repeat(limit + 1 - Buffer.byteLength(real, 'utf8'));
  assert.equal(Buffer.byteLength(padded, 'utf8'), limit + 1);
  t.mock.method(fs, 'readFileSync', (target, ...rest) =>
    typeof target === 'string' && path.resolve(target) === file ? padded : read(target, ...rest),
  );
  assert.deepEqual(checkWebLocales().problems, exceeded);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as locales from '../tools/check-locales.mjs';
import * as collection from '../dist/src/tiktok-report-pagination.js';
import * as request from '../dist/src/tiktok-report-request.js';

/**
 * Audit note N10: the Arabic gate (tools/check-locales.mjs) asked for only two of the TikTok collection sentences, so
 * the others had Arabic but nothing failed when their English was edited.
 */
const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
const authored = [
  [
    'src/tiktok-report-pagination.ts',
    [
      collection.tiktokPageCountMessage,
      collection.tiktokTotalsMismatchMessage,
      collection.tiktokTotalsMatchWarning,
      collection.tiktokTotalsGapTemplate,
    ],
  ],
  ['src/tiktok-report-request.ts', [request.tiktokStatusFilterRefusedWarning]],
];

test('the locale gate scans every file that authors a TikTok collection sentence', () => {
  assert.ok(Array.isArray(locales.reportingFailureSources), 'the gate exports the files it scans');
  for (const [file] of authored) assert.ok(locales.reportingFailureSources.includes(file), file);
});

test('each TikTok collection sentence is required in Arabic, so editing its English fails the gate', () => {
  for (const [file, sentences] of authored) {
    const source = readFileSync(file, 'utf8'),
      required = locales.inspectReportingFailures(source, file);
    for (const sentence of sentences) {
      assert.ok(required.has(sentence), file + ' requires: ' + sentence);
      assert.match(catalog[sentence] ?? '', /[؀-ۿ]/, 'Arabic for: ' + sentence);
      // A changed English sentence is a new requirement the catalog does not meet.
      const edited = sentence + ' (edited)';
      assert.ok(locales.inspectReportingFailures(source.replace(sentence, edited), file).has(edited));
      assert.equal(catalog[edited], undefined);
    }
  }
});

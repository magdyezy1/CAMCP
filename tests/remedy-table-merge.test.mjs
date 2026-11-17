import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {MirrorError, errorRemedy, errorResult} from '../dist/src/errors.js';
import {providerRemedy} from '../dist/src/provider-remedies.js';
import {localeProblems} from '../tools/check-locales.mjs';

/**
 * R2.5 M2 merge, the design join "one remedy table" (r25-m2-merge brief, join 4). Three packages add remedies, in three places:
 * r25-m2-refusal's TikTok remedy for a parameter refusal that TikTok declared in an HTTP 200 answer (a row of TikTok's own table, src/tiktok-remedies.ts, asked
 * before the shared rules), r25-m2-reconcile's remedies for the two codes of the duplicate guard (src/errors.ts, reviewRemedy), and
 * r12-gpreview's remedy for a write whose provider answer did not match what AMCP reviewed (src/errors.ts, reviewRemedy, narrowed by the
 * marker the family sets). Each package's own tests pin its own wording; this file pins what only the merged table can get wrong: that
 * each of them still answers its own refusal, that none answers another's, that every one keeps its Arabic, and that the codes the three
 * share (PLATFORM_ERROR, WRITE_PARTIAL_OR_FAILED) keep the remedy they had for everything else.
 */
const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
const remedy = (code, details = {}, status = 409) => errorRemedy(new MirrorError(code, 'Synthetic.', details, status));
const answerMismatch = {
  native_response_valid: false,
  response_hash: 'b'.repeat(64),
  response_mismatch: {check: 'expiration', reason: 'format', entry: 0},
};
const rejectedAtOk = {submission: 'rejected', http_status: 200};
// What these codes answered before the three packages: the shared remedy of a provider's own refusal, and of a failed write.
const failedWrite =
  'Inspect the native error and request ID. Check account access, granted scopes, app access tier and payload against the named endpoint; HTTP status alone does not identify the cause.';

const rows = [
  [
    'refusal: TikTok parameter refusal',
    remedy('PLATFORM_ERROR', rejectedAtOk),
    /^TikTok refused a parameter of this request and applied nothing/,
  ],
  [
    'reconcile: an identical create AMCP can look up',
    remedy('DUPLICATE_OF_UNCERTAIN_WRITE', {earlier_checkable: true}),
    /^Nothing was prepared or sent\. An identical create is already uncertain or still being sent/,
  ],
  [
    'reconcile: an identical create AMCP cannot look up',
    remedy('DUPLICATE_OF_UNCERTAIN_WRITE', {earlier_checkable: false}),
    /AMCP cannot check this kind of create by reading the provider/,
  ],
  [
    'reconcile: an identical create that completed',
    remedy('DUPLICATE_OF_COMPLETED_WRITE'),
    /^Nothing was sent\. An identical create completed after this review was prepared/,
  ],
  [
    'gpreview: a provider answer that did not match',
    remedy('WRITE_PARTIAL_OR_FAILED', answerMismatch),
    /response did not match AMCP’s contract for this route/,
  ],
];

test('each package’s remedy answers its own refusal, with its own wording, and the five are five different remedies', () => {
  for (const [name, found, wording] of rows) assert.match(found.action, wording, name);
  assert.equal(
    new Set(rows.map(([, found]) => found.action)).size,
    rows.length,
    'no two rows answer with one sentence',
  );
  // None of them is marked safe to retry: an unsent or an uncertain write is the person's to settle, and a new request does not help.
  for (const [name, found] of rows) assert.equal(found.mutation_retry_safe, false, name);
});

test('none of the rows answers another package’s refusal, and the codes they share keep the remedy they had for everything else', () => {
  // TikTok's row answers a rejected refusal of an HTTP 200 answer and no other PLATFORM_ERROR.
  for (const details of [{}, {http_status: 200}, {submission: 'rejected'}, {submission: 'rejected', http_status: 400}])
    assert.equal(providerRemedy('PLATFORM_ERROR', details), undefined, JSON.stringify(details));
  assert.doesNotMatch(
    remedy('PLATFORM_ERROR', {submission: 'rejected', http_status: 400}).action,
    /^TikTok refused a parameter/,
  );
  // gpreview's row answers the marker of an answer AMCP did not accept, and no other failed write.
  assert.equal(remedy('WRITE_PARTIAL_OR_FAILED').action, failedWrite);
  assert.equal(remedy('WRITE_PARTIAL_OR_FAILED', {native_response_valid: true}).action, failedWrite);
  assert.equal(
    remedy('WRITE_PARTIAL_OR_FAILED', rejectedAtOk).action,
    failedWrite,
    'a rejected write is not a mismatched answer',
  );
  // The guard's codes are answered by their own rows whatever else the details carry.
  assert.notEqual(
    remedy('DUPLICATE_OF_UNCERTAIN_WRITE', answerMismatch).action,
    remedy('WRITE_PARTIAL_OR_FAILED', answerMismatch).action,
  );
  assert.equal(
    remedy('DUPLICATE_OF_COMPLETED_WRITE', rejectedAtOk).action,
    remedy('DUPLICATE_OF_COMPLETED_WRITE').action,
  );
});

test('what an MCP caller receives is the same remedy twice, in each row', () => {
  const errors = [
    new MirrorError('PLATFORM_ERROR', 'Synthetic.', rejectedAtOk, 200),
    new MirrorError('DUPLICATE_OF_UNCERTAIN_WRITE', 'Synthetic.', {earlier_checkable: true}, 409),
    new MirrorError('DUPLICATE_OF_COMPLETED_WRITE', 'Synthetic.', {}, 409),
    new MirrorError('WRITE_PARTIAL_OR_FAILED', 'Synthetic.', answerMismatch, 502),
  ];
  for (const error of errors) {
    const sent = errorResult(error, 'request-1', 1).error;
    assert.equal(sent.remedy.action, errorRemedy(error).action, error.code);
    assert.equal(sent.next_action, sent.remedy.action, error.code);
  }
});

test('every row has its Arabic, which keeps the native names and numbers of the English and is not the English', () => {
  const sentences = rows.map(([, found]) => found.action);
  assert.deepEqual(localeProblems(catalog, sentences), []);
  for (const sentence of sentences) {
    assert.match(catalog[sentence] ?? '', /[؀-ۿ]/u, sentence.slice(0, 60));
    assert.notEqual(catalog[sentence], sentence);
    for (const token of new Set(sentence.match(/\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/g) ?? []))
      assert.ok(catalog[sentence].includes(token), 'keeps ' + token + ' in: ' + sentence.slice(0, 60));
  }
});

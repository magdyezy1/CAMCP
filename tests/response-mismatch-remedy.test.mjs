import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {MirrorError, errorRemedy, errorResult} from '../dist/src/errors.js';

// r12-gpreview item 3, found live 2026-11-16: Google answered a shareable-preview generation with HTTP 200, AMCP did not accept
// the answer (src/google-preview-writes.ts marks it native_response_valid: false), and the refusal told the caller to check
// access, scopes and tier. When the provider's answer does not match what AMCP reviewed, nothing in the request is the
// caller's to change. The remedy now says what happened, that a new request will not help, and to report it, as
// tests/vendor-schema-remedy.test.mjs pins for UPSTREAM_RESPONSE_INVALID, whose wording it follows. Every other
// WRITE_PARTIAL_OR_FAILED keeps the remedy it had.
const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
const message =
  'The provider answered, but its answer does not match what AMCP reviewed for this request, so AMCP did not accept it.';
const details = {
  native_response_valid: false,
  response_hash: 'a'.repeat(64),
  response_mismatch: {check: 'link', reason: 'host_not_accepted', entry: 0, field: 'shareablePreviewUrl'},
};
// The remedy this refusal had, which every other WRITE_PARTIAL_OR_FAILED keeps.
const oldRemedy =
  'Inspect the native error and request ID. Check account access, granted scopes, app access tier and payload against the named endpoint; HTTP status alone does not identify the cause.';

test('WRITE_PARTIAL_OR_FAILED for an answer that does not match says what happened, where it is named and what to do', () => {
  const error = new MirrorError('WRITE_PARTIAL_OR_FAILED', message, details),
    remedy = errorRemedy(error);
  assert.notEqual(remedy.action, oldRemedy);
  // What happened.
  assert.match(remedy.action, /response did not match AMCP’s contract for this route/);
  // Where the mismatch is named, and only when AMCP could determine it: an outcome stored before the mismatch was named, replayed
  // after its 24-hour receipt expired, has only the answer's hash in its details (r12-gpreview, lead review S3-2).
  assert.match(
    remedy.action,
    /the details name the mismatch when AMCP could determine it\. A new request will not help\./,
  );
  // That nothing the caller sends changes it, and what to do.
  assert.match(remedy.action, /A new request will not help/);
  assert.match(remedy.action, /Report these details to support/);
  // Never advice to correct access, scopes, tier or payload.
  assert.doesNotMatch(remedy.action, /account access|granted scopes|access tier|payload/i);
  // A write that reached the provider is never sent again.
  assert.match(remedy.action, /If this was a write, it may have been applied/);
  assert.match(remedy.action, /do not send it again/);
  // The report goes to AMCP, and no write is marked safe to retry.
  assert.deepEqual([remedy.category, remedy.owner, remedy.mutation_retry_safe], ['provider', 'amcp', false]);
  // What an MCP caller receives: the facts, in the error's details, and the same remedy twice.
  const sent = errorResult(error, 'request-1', 1).error;
  assert.equal(sent.message, message);
  assert.deepEqual(sent.details, details);
  assert.equal(sent.remedy.action, remedy.action);
  assert.equal(sent.next_action, remedy.action);
  assert.equal(sent.category, 'provider');
  // The same details on another code are not this remedy: the code and the flag decide together.
  for (const code of ['UPSTREAM_ERROR', 'UPSTREAM_RESPONSE_INVALID', 'WRITE_OUTCOME_UNCERTAIN', 'INTERNAL_ERROR'])
    assert.notEqual(errorRemedy(new MirrorError(code, 'Synthetic.', details)).action, remedy.action, code);
});

// The gate: what the remedy of WRITE_PARTIAL_OR_FAILED said before, it still says for everything but the one answer above.
test('every other WRITE_PARTIAL_OR_FAILED keeps its remedy, and only the flag of the answer that does not match changes it', () => {
  const other = [
    new MirrorError('WRITE_PARTIAL_OR_FAILED', 'Synthetic.'),
    // The answer was valid, or the flag is not the one the family sets.
    new MirrorError('WRITE_PARTIAL_OR_FAILED', 'Synthetic.', {native_response_valid: true}),
    new MirrorError('WRITE_PARTIAL_OR_FAILED', 'Synthetic.', {native_response_valid: 'false'}),
    new MirrorError('WRITE_PARTIAL_OR_FAILED', 'Synthetic.', {native_response_valid: 0}),
    // A mismatch named without the flag is no mismatch of the answer: the flag decides.
    new MirrorError('WRITE_PARTIAL_OR_FAILED', 'Synthetic.', {response_mismatch: details.response_mismatch}),
    // The provider's own refusal.
    new MirrorError('WRITE_PARTIAL_OR_FAILED', 'Synthetic.', {upstream: {status: 400}}),
  ];
  for (const error of other) assert.equal(errorRemedy(error).action, oldRemedy, JSON.stringify(error.details));
  // A group that stopped before a part was sent keeps its own remedy, whatever else it names.
  const part = errorRemedy(
    new MirrorError('WRITE_PARTIAL_OR_FAILED', 'Synthetic.', {
      ...details,
      part_error: 'INVALID_ARGUMENT',
      part_submitted: false,
    }),
  );
  assert.match(part.action, /Earlier parts were applied and stay applied/);
  // UPSTREAM_RESPONSE_INVALID keeps the remedy of r25-hotfix.
  assert.match(
    errorRemedy(new MirrorError('UPSTREAM_RESPONSE_INVALID', 'Synthetic.', {vendor_method: 'Get Ad Account'})).action,
    /did not match AMCP’s pinned contract for this route/,
  );
});

test('the message and the remedy have their Arabic strings, and are not left as the English text', () => {
  const remedy = errorRemedy(new MirrorError('WRITE_PARTIAL_OR_FAILED', message, details)).action;
  for (const text of [message, remedy]) {
    assert.match(catalog[text] ?? '', /[؀-ۿ]/, 'Arabic for: ' + text);
    assert.notEqual(catalog[text], text);
  }
  // The Arabic keeps what the English says it does not do: it never tells the caller to correct access, scopes or tier.
  assert.notEqual(catalog[remedy], catalog[oldRemedy]);
  // The clause was reworded in place (S3-2): the sentence it replaced is not left in the catalogue beside it, so no count moves.
  const earlier = Object.keys(catalog).filter(key =>
    /and the details name the mismatch\. A new request will not help/.test(key),
  );
  assert.deepEqual(earlier, []);
});

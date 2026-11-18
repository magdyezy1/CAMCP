import test from 'node:test';
import assert from 'node:assert/strict';
import * as errors from '../dist/src/errors.js';
import {googleBudgetFixture} from './fixtures/google-budget-writes.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';

const {MirrorError, errorResult} = errors;

/**
 * r12-gpreview round 2, lead review S4-1. A failed write is refused with the message and the remedy of "the provider answered,
 * and AMCP did not accept the answer" only when the outcome is the one a family stores for that (src/reviewed-family.ts,
 * `safeOutcome`): its `data` holds nothing but the marker, the answer's hash and the closed-set facts of where it differed.
 * For a write whose family stores no outcome of its own, `data` is the provider's own body, which could carry a top-level
 * `native_response_valid: false` and fields of its own. That must not switch the refusal, and no key a provider chose may
 * reach the error's details.
 */
const hash = 'a'.repeat(64);
const family = {
  native_response_valid: false,
  response_hash: hash,
  response_mismatch: {
    check: 'link',
    reason: 'host_not_accepted',
    entry: 0,
    field: 'shareablePreviewUrl',
    also: [{check: 'expiration', reason: 'format', entry: 0}],
    unexpected: ['requestId'],
  },
};

test('only the outcome of a family that did not accept the answer switches the refusal, and only its fixed vocabulary is carried', () => {
  // What the family stores: its facts become the error's details, without the lists, which stay in the outcome.
  assert.deepEqual(errors.mismatchedAnswerDetails(family), {
    native_response_valid: false,
    response_hash: hash,
    response_mismatch: {check: 'link', reason: 'host_not_accepted', entry: 0, field: 'shareablePreviewUrl'},
  });
  // Stored before the mismatch was named (the live outcome), or with the receipt gone: the marker and the hash only.
  assert.deepEqual(errors.mismatchedAnswerDetails({native_response_valid: false, response_hash: hash}), {
    native_response_valid: false,
    response_hash: hash,
  });
  assert.deepEqual(errors.mismatchedAnswerDetails({native_response_valid: false}), {native_response_valid: false});
  // Every number and word of the closed set of the family, in one mismatch.
  assert.deepEqual(
    errors.mismatchedAnswerDetails({
      native_response_valid: false,
      response_mismatch: {
        check: 'count',
        reason: 'differs',
        entries: 2,
        targets: 1,
        http_status: 202,
        entry: 1,
        field: 'f',
      },
    }),
    {
      native_response_valid: false,
      response_mismatch: {
        check: 'count',
        reason: 'differs',
        entries: 2,
        targets: 1,
        http_status: 202,
        entry: 1,
        field: 'f',
      },
    },
  );
  // The check the delivery makes when a later release accepts the answer a stored refusal had (lead review S4-2).
  assert.deepEqual(
    errors.mismatchedAnswerDetails({
      native_response_valid: false,
      response_mismatch: {check: 'none', reason: 'accepted_now'},
    }),
    {native_response_valid: false, response_mismatch: {check: 'none', reason: 'accepted_now'}},
  );
});

test('a provider body, an outcome with fields of its own and a mismatch with keys of its own switch nothing', () => {
  const others = [
    // A provider's own body that carries the marker and fields of its own.
    {native_response_valid: false, partialFailureError: {code: 3, message: 'Synthetic'}, results: []},
    {native_response_valid: false, foreign: 'x'},
    // The family's outcome with one more field.
    {...family, results: []},
    // A mismatch that names a key the family never writes: the key is the provider's choice.
    {native_response_valid: false, response_mismatch: {secret_key: 'planted'}},
    {native_response_valid: false, response_mismatch: {...family.response_mismatch, secret_key: 'planted'}},
    // A mismatch that is no object.
    {native_response_valid: false, response_mismatch: 'x'},
    {native_response_valid: false, response_mismatch: ['check']},
    {native_response_valid: false, response_mismatch: null},
    // Not the marker.
    {native_response_valid: true, response_hash: hash},
    {native_response_valid: 'false'},
    {response_hash: hash},
    {},
    // Not an object.
    null,
    undefined,
    'native_response_valid',
    [family],
    false,
  ];
  for (const data of others) assert.equal(errors.mismatchedAnswerDetails(data), undefined, JSON.stringify(data));
});

test('a field of an answer that is not a closed-set word or a number is not carried, and an odd hash is dropped', () => {
  const carried = errors.mismatchedAnswerDetails({
    native_response_valid: false,
    response_hash: 'not-a-hash',
    response_mismatch: {
      check: 'link',
      reason: 'has spaces and a link https://example.org/x?token=1',
      entry: 0.5,
      field: 'f',
    },
  });
  assert.deepEqual(carried, {native_response_valid: false, response_mismatch: {check: 'link', field: 'f'}});
});

// r25-m3-gpreview, decision item 4: a refused expiry names its `shape` (src/google-preview-writes.ts), the value with each digit as 9,
// each of T Z + - : . and the space kept, every other character as ?, cut at 40 characters with an ellipsis. It is a closed
// alphabet, so it is the one string of the mismatch that reaches the error besides the words: a shape of this alphabet is carried,
// and a "shape" of anything else is not, whatever else it looks like.
test('the shape of a refused expiry is carried into the refusal when it is in its closed alphabet, and is dropped otherwise', () => {
  const named = (shape, more = {}) => ({
    native_response_valid: false,
    response_mismatch: {check: 'expiration', reason: 'format', entry: 0, shape, ...more},
  });
  for (const shape of [
    '9999-99-99T99:99Z',
    '9999?99?99 99:99:99Z',
    '',
    '?',
    'T',
    '+-:. ?',
    '9'.repeat(40),
    '?'.repeat(40) + '…',
  ])
    assert.deepEqual(errors.mismatchedAnswerDetails(named(shape)), named(shape), JSON.stringify(shape));
  // The shape is there, and the refusal still switches, with the shape left out: a word of the identifier kind is not a shape.
  const dropped = {
    native_response_valid: false,
    response_mismatch: {check: 'expiration', reason: 'format', entry: 0},
  };
  for (const shape of [
    'abc',
    'https://example.org/x?token=1',
    '9'.repeat(41),
    '9'.repeat(40) + '……',
    '9…9',
    '9999-99-99\n',
    'z',
    ['9'],
    7,
    null,
    {x: '9'},
  ])
    assert.deepEqual(errors.mismatchedAnswerDetails(named(shape)), dropped, JSON.stringify(shape));
  // A shape beside a key the family never writes still switches nothing.
  assert.equal(errors.mismatchedAnswerDetails(named('9999', {secret_key: 'planted'})), undefined);
});

test('errorResult marks response_mismatch untrusted, like provider_errors, and marks nothing for a refusal without it', () => {
  const marked = errorResult(
    new MirrorError('WRITE_PARTIAL_OR_FAILED', 'Synthetic.', {
      native_response_valid: false,
      response_mismatch: {check: 'link', reason: 'host_not_accepted'},
    }),
    'ref-1',
    0,
  );
  assert.deepEqual(marked.meta.untrusted_paths, ['error.details.response_mismatch']);
  assert.equal(typeof marked.meta.untrusted_provider_content, 'string');
  const plain = errorResult(new MirrorError('WRITE_PARTIAL_OR_FAILED', 'Synthetic.'), 'ref-2', 0);
  assert.equal(plain.meta.untrusted_paths, undefined);
  // The marker and the hash alone name no provider text.
  const alone = errorResult(
    new MirrorError('WRITE_PARTIAL_OR_FAILED', 'Synthetic.', {native_response_valid: false, response_hash: hash}),
    'ref-3',
    0,
  );
  assert.equal(alone.meta.untrusted_paths, undefined);
});

const oldMessage =
  'Provider reported an incomplete or failed mutation; inspect the retained outcome before further action.';

// Google's own body, as a hostile or odd answer could be. Each carries the marker; the first adds a failure that makes the write
// fail and keys of its own at the top, the second only a `response_mismatch` with a key of its own (a Google mutation that
// answers no results is not confirmed, so it fails too), so each guard is pinned end to end on its own.
const providerBodies = [
  [
    'foreign keys beside the marker',
    {
      native_response_valid: false,
      partialFailureError: {code: 3, message: 'Synthetic failure'},
      planted_key: 'planted-value',
    },
  ],
  [
    'a response_mismatch with a key of its own',
    {native_response_valid: false, response_mismatch: {planted_mismatch_key: 'planted-mismatch-value', check: 'link'}},
  ],
];
for (const [label, body] of providerBodies)
  test(
    'a provider body that carries native_response_valid false and ' +
      label +
      ' is refused as any failed mutation is, with none of its keys in the error',
    async () => {
      const f = googleBudgetFixture();
      try {
        const prepared = await f.update(100000001);
        assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 400));
        f.hooks.respond = () => Response.json(body);
        const e = await f.execute(prepared.data.review_id);
        assertRefused(e, 'WRITE_PARTIAL_OR_FAILED');
        // The provider's body is the outcome's data, as it was: that is where this case stands.
        assert.equal(e.data.data.native_response_valid, false);
        assert.equal(e.error.message, oldMessage);
        assert.equal(e.error.details, undefined);
        assert.match(e.error.next_action, /Check account access, granted scopes, app access tier and payload/);
        assert.doesNotMatch(e.error.next_action, /did not match AMCP’s contract/);
        for (const text of ['planted_key', 'planted-value', 'planted_mismatch_key', 'planted-mismatch-value'])
          assert.ok(!JSON.stringify(e.error).includes(text), text);
        assert.deepEqual(e.meta.untrusted_paths, ['data']);
      } finally {
        f.close();
      }
    },
  );

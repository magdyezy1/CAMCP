// Package r12-fix, the lead's ruling on item 1 (decision 2, recency, 2026-11-16). A window longer than 31 days is read in spans, and
// each span's capture may carry the state of its collection: whether it is complete, and the reasons it is not. Merging them into the
// window's capture must keep the reasons of every span, not only the first one's: a later span that Snapchat did not confirm is the
// one that makes the capture partial, and its reason is what says why.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeCaptures, windowSpans} from '../dist/src/overview-detail-spans.js';

const range = {since: '2023-03-13', until: '2023-05-07'};
const capture = (collection, at = 1) => ({
  semantics: {timezone: 'America/Los_Angeles', date_from: '2023-03-13', date_to: '2023-04-12'},
  source_request: {query: {}},
  source_hash: 'hash-' + at,
  source_pages: [{page: 1}],
  native_account_evidence: {checks: [{stage: 'account'}]},
  captured_at: at,
  rows: [],
  native_rows: [],
  ...(collection ? {collection} : {}),
});
const state = (complete, ...warnings) => ({complete, declared: null, returned: 0, warnings});

test('the window of the Overview tests is read in two spans', () => {
  assert.equal(windowSpans(range, 31).length, 2);
});

test('a later span that is not complete makes the merged capture incomplete, and its reason is kept', () => {
  const merged = mergeCaptures(
    [capture(undefined, 1), capture(state(false, 'The later span is not confirmed.'), 2)],
    range,
  );
  assert.equal(merged.collection.complete, false);
  assert.deepEqual(merged.collection.warnings, ['The later span is not confirmed.']);
});

test('the reasons of every span are kept once, in the order of the spans', () => {
  const merged = mergeCaptures(
    [
      capture(state(false, 'First reason.', 'Shared reason.'), 1),
      capture(state(true), 2),
      capture(state(false, 'Shared reason.', 'Last reason.'), 3),
    ],
    range,
  );
  assert.equal(merged.collection.complete, false);
  assert.deepEqual(merged.collection.warnings, ['First reason.', 'Shared reason.', 'Last reason.']);
});

test('captures that are all complete, or carry no state, keep their meaning', () => {
  assert.equal(
    Object.hasOwn(mergeCaptures([capture(undefined, 1), capture(undefined, 2)], range), 'collection'),
    false,
  );
  const complete = mergeCaptures([capture(state(true), 1), capture(state(true), 2)], range);
  assert.equal(complete.collection.complete, true);
  assert.deepEqual(complete.collection.warnings, []);
  const single = capture(state(false, 'Only reason.'));
  assert.equal(mergeCaptures([single], range), single, 'one capture is returned as it is');
});

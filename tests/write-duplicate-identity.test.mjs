import test from 'node:test';
import assert from 'node:assert/strict';
import {googleBudgetFixture} from './fixtures/google-budget-writes.mjs';
import {assertCreateNotRepeated, requestIdentity} from '../dist/src/write-duplicates.js';

/**
 * R2.5 M2, lead re-review 2, merge join 4: the guard's identity of a request is the caller's, stored on the review at prepare, never the
 * body of the stored plan. The refusal package (r25-m2-refusal) lets a provider's `dedupeBody` put a deduplication key into the body before
 * the review is stored, and that key differs per review: an identity recomputed from the stored plan would call two reviews of one request
 * different, and the guard would warn of, hold back and refuse neither. The identity is therefore computed from the caller's body at the
 * start of prepare and compared as stored, for the earlier reviews (at prepare and at execute) and for the review itself (at execute); a
 * review prepared before it was stored falls back to its plan.
 *
 * This branch has no `dedupeBody` seam (it is the refusal package's), so these tests store the body that such a key would have made: the
 * stored plan of a review gets one more key (`dedupe`), which is not a per-prepare key the identity drops by name.
 */
const lost = () => {
  throw new TypeError('synthetic lost response');
};
const identical = f => f.creates(1, 5000000);
/** The stored plan of review `id` as a provider's deduplication key would have made it: its body carries one more key. */
const dedupe = (f, id, key = 'dedupe-' + id) => {
  const {id: _id, revision: _revision, ...doc} = f.store.document(f.actor.tenantId, 'write_review', id);
  f.store.putDocument(f.actor.tenantId, 'write_review', id, {
    ...doc,
    plan: {...doc.plan, body: {...doc.plan.body, dedupe_key: key}},
  });
};
const storedIdentity = (f, id) => f.store.document(f.actor.tenantId, 'write_review', id).request_identity;

test('the review stores the identity of the caller’s request, the one its plan gives before anything changes its body', async () => {
  const f = googleBudgetFixture();
  try {
    const a = (await identical(f)).data.review_id,
      b = (await identical(f)).data.review_id;
    const doc = f.store.document(f.actor.tenantId, 'write_review', a);
    assert.equal(typeof doc.request_identity, 'string', 'an identity is stored with the review');
    assert.equal(
      doc.request_identity,
      requestIdentity(doc.plan),
      'it is the identity of the request as the caller sent it',
    );
    assert.equal(storedIdentity(f, b), doc.request_identity, 'two reviews of one request have one identity');
  } finally {
    f.close();
  }
});

test('an identical create that completed is a twin whatever key its stored plan carries: the next prepare is warned', async () => {
  const f = googleBudgetFixture();
  try {
    const a = (await identical(f)).data.review_id;
    assert.equal((await f.execute(a)).success, true);
    dedupe(f, a);
    const b = await identical(f);
    assert.equal(b.success, true, JSON.stringify(b).slice(0, 400));
    assert.equal(b.data.duplicate_warning?.earlier_review_id, a, 'the completed twin is named in the warning');
  } finally {
    f.close();
  }
});

test('an identical create that is uncertain is a twin whatever key its stored plan carries: the next prepare is refused as identical', async () => {
  const f = googleBudgetFixture();
  try {
    const a = (await identical(f)).data.review_id;
    f.hooks.respond = lost;
    assert.equal((await f.execute(a)).error?.code, 'WRITE_OUTCOME_UNCERTAIN');
    f.hooks.respond = undefined;
    dedupe(f, a);
    const b = await identical(f);
    assert.equal(b.error?.code, 'DUPLICATE_OF_UNCERTAIN_WRITE', JSON.stringify(b).slice(0, 500));
    assert.equal(b.error.details.earlier_match, 'identical', 'identical, not merely the same object');
    assert.equal(b.error.details.earlier_review_id, a);
  } finally {
    f.close();
  }
});

test('a review prepared before an identical create completed is refused at execute, whatever key the stored plan of the first carries', async () => {
  const f = googleBudgetFixture();
  try {
    const a = (await identical(f)).data.review_id,
      b = await identical(f);
    assert.equal(b.data.duplicate_warning, undefined, 'nothing had completed when it was prepared');
    assert.equal((await f.execute(a)).success, true);
    dedupe(f, a);
    const refused = await f.execute(b.data.review_id);
    assert.equal(refused.error?.code, 'DUPLICATE_OF_COMPLETED_WRITE', JSON.stringify(refused).slice(0, 500));
    assert.equal(refused.error.details.submission, 'not_sent');
    assert.equal(f.writes.length, 1, 'no second object');
  } finally {
    f.close();
  }
});

test('the execute comparison uses the identity stored with the review, not the body of its plan', async () => {
  const f = googleBudgetFixture();
  try {
    const a = (await identical(f)).data.review_id;
    assert.equal((await f.execute(a)).success, true);
    // A review of the same request whose plan carries a key (as a provider's deduplication key would put it), with the identity stored at prepare.
    const first = f.store.document(f.actor.tenantId, 'write_review', a),
      plan = {...first.plan, body: {...first.plan.body, dedupe_key: 'another-review'}};
    assert.notEqual(requestIdentity(plan), first.request_identity, 'the key changes the identity of the plan');
    const review = {id: 'next', plan, request_identity: first.request_identity};
    assert.throws(
      () => assertCreateNotRepeated(f.store, f.actor, plan, review, 'next', {}),
      error => error.code === 'DUPLICATE_OF_COMPLETED_WRITE' && error.details.earlier_review_id === a,
    );
    // Without a stored identity (a review prepared before it was stored) the plan is all there is, and it differs: nothing is held.
    assert.doesNotThrow(() => assertCreateNotRepeated(f.store, f.actor, plan, {id: 'old', plan}, 'old', {}));
  } finally {
    f.close();
  }
});

test('a review prepared before the identity was stored is compared by its plan, as it was', async () => {
  const f = googleBudgetFixture();
  try {
    const a = (await identical(f)).data.review_id;
    assert.equal((await f.execute(a)).success, true);
    // Strip the stored identity: the review is as an older one.
    const {
      id: _id,
      revision: _revision,
      request_identity: _stored,
      ...doc
    } = f.store.document(f.actor.tenantId, 'write_review', a);
    f.store.putDocument(f.actor.tenantId, 'write_review', a, doc);
    const b = await identical(f);
    assert.equal(b.data.duplicate_warning?.earlier_review_id, a, 'still a twin: its plan gives the same identity');
  } finally {
    f.close();
  }
});

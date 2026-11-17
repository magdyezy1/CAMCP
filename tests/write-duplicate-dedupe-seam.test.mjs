import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {registerHooks} from 'node:module';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * R2.5 M2 merge, the join of r25-m2-reconcile's duplicate guard with r25-m2-refusal's `dedupeBody` seam (lead re-review 2, "Merge joins" 4).
 *
 * A provider may declare `writes.dedupeBody(plan, reviewId)`, which prepare applies to the body of a create before the review is stored: a
 * deduplication key that differs for every review. The guard against creating twice must call two creates of one request twins whatever
 * key each carries, so prepare takes the identity of the caller's request before the hook runs and stores it with the review
 * (`request_identity`), and the guard compares the stored identity on both sides. The reconcile package could only simulate the key (its
 * branch had no seam); this test goes through the real one.
 *
 * No provider declares the hook (the refusal package's S1-1: a key per review would switch off TikTok's own same-name refusal), the
 * registry is frozen, and tests/tiktok-request-id.test.mjs pins that nothing does. So this test file, in its own process, gives TikTok the
 * hook through a module load hook that adds one declaration to the built adapter, with a key name the guard does not drop by itself
 * (`dedupe_key`; a `request_id` is dropped by name, so it would prove nothing). Nothing of it reaches another test or the source.
 */
const declaration = 'rejectionIsNonApplied: tiktokRejectionIsNonApplied,';
globalThis.__dedupeCalls = [];
const hooks = registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith('/dist/src/tiktok-adapter.js')) return result;
    const text = Buffer.from(result.source).toString('utf8');
    if (!text.includes(declaration)) throw new Error('The built TikTok adapter no longer declares ' + declaration);
    return {
      ...result,
      source: text.replace(
        declaration,
        declaration +
          ' dedupeBody: (plan, reviewId) => { globalThis.__dedupeCalls.push(reviewId); return {...plan.body, dedupe_key: reviewId}; },',
      ),
    };
  },
});
after(() => hooks.deregister());
const {tiktokReconcileFixture} = await import('./helpers/tiktok-reconcile-fixture.mjs');
const {providerHooks} = await import('../dist/src/provider-hooks.js');
const {requestIdentity} = await import('../dist/src/write-duplicates.js');

const stored = (f, id) => f.store.document(f.actor.tenantId, 'write_review', id);
/** The body of a review's plan without the key the seam put there: what the caller sent. */
const callers = review => {
  const {dedupe_key: _key, ...body} = review.plan.body;
  return {...review.plan, body};
};

test('the test’s own declaration is the only one: the source declares no dedupeBody, and this process has it through the load hook', () => {
  const source = fs
    .readFileSync(new URL('../src/tiktok-adapter.ts', import.meta.url), 'utf8')
    .split('\n')
    .filter(line => !/^\s*(?:\/\/|\/?\*)/.test(line))
    .join('\n');
  assert.equal(/\bdedupeBody\b/.test(source), false, 'no provider declares the hook in the source');
  assert.equal(typeof providerHooks('tiktok_native_action').writes.dedupeBody, 'function');
});

test('two identical TikTok creates carry different keys in their stored bodies and one identity: the first left uncertain, the second’s prepare is refused as identical', async () => {
  const f = tiktokReconcileFixture({tenant: 'dedupe-uncertain'});
  try {
    globalThis.__dedupeCalls.length = 0;
    const {id, refused} = await f.lose('campaign', {applied: true});
    assertRefused(refused, 'WRITE_OUTCOME_UNCERTAIN');
    const first = stored(f, id);
    assert.equal(
      first.plan.body.dedupe_key,
      id,
      'the seam put the first review’s key into the body that is stored and sent',
    );
    assert.equal(f.sent[0].body.dedupe_key, id);
    assert.equal(
      first.request_identity,
      requestIdentity(callers(first)),
      'the identity is the caller’s request, not the stored body',
    );
    assert.notEqual(
      first.request_identity,
      requestIdentity(first.plan),
      'the stored body gives another identity: the key is in it',
    );

    const same = await f.prepare('campaign');
    assertRefused(same, 'DUPLICATE_OF_UNCERTAIN_WRITE');
    assert.equal(same.error.details.earlier_match, 'identical', 'identical, not merely the same object');
    assert.equal(same.error.details.earlier_review_id, id);
    // The hook ran for the second prepare too, so its body carried a key of its own when the guard looked: the guard ignored it.
    assert.equal(globalThis.__dedupeCalls.length, 2);
    assert.notEqual(globalThis.__dedupeCalls[1], id);
    assert.equal(f.sent.length, 1);
  } finally {
    f.close();
  }
});

test('an identical create that completed is a twin whatever key each review carries: the next prepare is warned, and the stored bodies differ by the key', async () => {
  const f = tiktokReconcileFixture({tenant: 'dedupe-completed'});
  try {
    const a = (await f.prepare('campaign')).data.review_id;
    assert.equal((await f.execute(a)).success, true);
    const b = await f.prepare('campaign');
    assert.equal(b.success, true, JSON.stringify(b).slice(0, 400));
    assert.equal(b.data.duplicate_warning?.earlier_review_id, a, 'the completed twin is named in the warning');
    const first = stored(f, a),
      second = stored(f, b.data.review_id);
    assert.notEqual(first.plan.body.dedupe_key, second.plan.body.dedupe_key, 'two keys');
    assert.notDeepEqual(first.plan.body, second.plan.body, 'the stored bodies differ');
    assert.equal(first.request_identity, second.request_identity, 'one identity');
  } finally {
    f.close();
  }
});

test('a review prepared before an identical create completed is refused at execute, whatever key either carries: no second object', async () => {
  const f = tiktokReconcileFixture({tenant: 'dedupe-execute'});
  try {
    const a = (await f.prepare('campaign')).data.review_id,
      b = await f.prepare('campaign');
    assert.equal(b.data.duplicate_warning, undefined, 'nothing had completed when it was prepared');
    assert.notEqual(stored(f, a).plan.body.dedupe_key, stored(f, b.data.review_id).plan.body.dedupe_key);
    assert.equal((await f.execute(a)).success, true);
    const refused = await f.execute(b.data.review_id);
    assertRefused(refused, 'DUPLICATE_OF_COMPLETED_WRITE');
    assert.equal(refused.error.details.submission, 'not_sent');
    assert.equal(f.sent.length, 1, 'no second object');
  } finally {
    f.close();
  }
});

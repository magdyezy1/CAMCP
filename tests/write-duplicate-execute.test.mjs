import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {googleBudgetFixture} from './fixtures/google-budget-writes.mjs';
import {tiktokReconcileFixture} from './helpers/tiktok-reconcile-fixture.mjs';

/**
 * R2.5 M2, lead review S2-1: the duplicate-create guard also runs at execute. A review has a claim only from its execute on, so two
 * identical creates prepared before either was sent were both invisible to the prepare-time guard, and both could send (probe E: two
 * campaigns). At execute, inside the transaction that takes the claim, a create is refused (nothing claimed or sent) when an
 * identical create is unresolved, or completed in the last ten minutes without this review having been shown that as a warning at
 * prepare: the person sees the warning first, by preparing again. The review that replaces an uncertain write is the exception for it.
 */
before(() => {
  process.env.AMCP_WRITE_RECONCILE_DELAY_MS = '0';
  process.env.AMCP_WRITE_RECONCILE_ROUND_MS = '0';
});
after(() => {
  delete process.env.AMCP_WRITE_RECONCILE_DELAY_MS;
  delete process.env.AMCP_WRITE_RECONCILE_ROUND_MS;
});

const lost = () => {
  throw new TypeError('synthetic lost response');
};
const claims = f => f.store.db.prepare('SELECT count(*) AS n FROM idempotency').get().n;

test('two identical creates prepared before either was sent never both send: the second is refused at execute while the first is unresolved', async () => {
  const f = googleBudgetFixture();
  try {
    const a = (await f.creates(1, 5000000)).data.review_id,
      b = (await f.creates(1, 5000000)).data.review_id;
    f.hooks.respond = lost;
    assert.equal((await f.execute(a)).error?.code, 'WRITE_OUTCOME_UNCERTAIN');
    f.hooks.respond = undefined;
    const before = claims(f);
    const refused = await f.execute(b);
    assert.equal(refused.error?.code, 'DUPLICATE_OF_UNCERTAIN_WRITE', JSON.stringify(refused).slice(0, 600));
    assert.equal(refused.error.details.submission, 'not_sent');
    assert.equal(refused.error.details.earlier_review_id, a);
    assert.equal(f.writes.length, 1, 'nothing was sent for the second');
    assert.equal(f.claim(b), undefined, 'its claim was not taken');
    assert.equal(claims(f), before);
  } finally {
    f.close();
  }
});

test('the review that replaces an uncertain write still executes, and the one it replaced still cannot', async () => {
  const f = googleBudgetFixture();
  try {
    const a = (await f.creates(1, 5000000)).data.review_id;
    f.hooks.respond = lost;
    assert.equal((await f.execute(a)).error?.code, 'WRITE_OUTCOME_UNCERTAIN');
    f.hooks.respond = undefined;
    const found = await f.write({action: 'reconcile', review_id: a});
    assert.equal(found.data.classification, 'appears_not_applied', JSON.stringify(found.data));
    const replacement = await f.write(found.data.next_call.arguments);
    assert.equal(replacement.success, true, JSON.stringify(replacement).slice(0, 400));
    const done = await f.execute(replacement.data.review_id);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 400));
    assert.equal((await f.execute(a)).error?.code, 'WRITE_OUTCOME_UNCERTAIN', 'the replaced review is never sent');
    assert.equal(f.writes.length, 2);
  } finally {
    f.close();
  }
});

test('two identical creates executed at once send once', async () => {
  const f = googleBudgetFixture();
  try {
    const a = (await f.creates(1, 5000000)).data.review_id,
      b = (await f.creates(1, 5000000)).data.review_id;
    const results = await Promise.all([f.execute(a), f.execute(b)]);
    assert.equal(f.writes.length, 1, 'one create was sent');
    assert.equal(results.filter(r => r.success).length, 1);
    const refused = results.find(r => !r.success);
    assert.match(
      refused.error.code,
      /^DUPLICATE_OF_(UNCERTAIN|COMPLETED)_WRITE$/,
      JSON.stringify(refused).slice(0, 400),
    );
    assert.equal(refused.error.details.submission, 'not_sent');
  } finally {
    f.close();
  }
});

test('an identical create that completed after this review was prepared is refused once; prepared again it carries the warning and may run', async () => {
  const f = googleBudgetFixture();
  try {
    const a = (await f.creates(1, 5000000)).data.review_id,
      b = await f.creates(1, 5000000);
    assert.equal(b.data.duplicate_warning, undefined, 'nothing had completed when it was prepared');
    assert.equal((await f.execute(a)).success, true);
    const refused = await f.execute(b.data.review_id);
    assert.equal(refused.error?.code, 'DUPLICATE_OF_COMPLETED_WRITE', JSON.stringify(refused).slice(0, 600));
    assert.equal(refused.error.details.submission, 'not_sent');
    assert.equal(refused.error.details.earlier_review_id, a);
    assert.equal(refused.error.details.next_call.arguments.action, 'prepare', 'the call that shows the warning');
    assert.equal(f.writes.length, 1);
    assert.equal(f.claim(b.data.review_id), undefined, 'the claim was not taken');
    // Prepared again, the review carries the warning (the person has seen it) and executes: the person may want two.
    const again = await f.write(refused.error.details.next_call.arguments);
    assert.equal(again.success, true, JSON.stringify(again).slice(0, 400));
    assert.equal(again.data.duplicate_warning.earlier_review_id, a);
    const done = await f.execute(again.data.review_id);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 400));
    assert.equal(f.writes.length, 2);
  } finally {
    f.close();
  }
});

test('probe E: two identical TikTok campaign creates prepared before either was sent make one campaign, not two', async () => {
  const f = tiktokReconcileFixture();
  try {
    const a = await f.prepare('campaign'),
      b = await f.prepare('campaign');
    assert.deepEqual([a.success, b.success], [true, true]);
    assert.equal((await f.execute(a.data.review_id)).success, true);
    const second = await f.execute(b.data.review_id);
    assert.equal(second.error?.code, 'DUPLICATE_OF_COMPLETED_WRITE', JSON.stringify(second).slice(0, 500));
    assert.equal(f.sent.length, 1, 'one create was sent');
    assert.equal(f.rows.campaign.filter(row => row.campaign_name === 'Synthetic campaign').length, 1);
  } finally {
    f.close();
  }
});

test('an update that repeats itself is never refused at execute: only a create can make a second object', async () => {
  const f = googleBudgetFixture();
  try {
    const a = (await f.update(100000000)).data.review_id,
      b = (await f.update(100000000)).data.review_id;
    f.hooks.respond = lost;
    assert.equal((await f.execute(a)).error?.code, 'WRITE_OUTCOME_UNCERTAIN');
    f.hooks.respond = undefined;
    const second = await f.execute(b);
    assert.equal(second.success, true, JSON.stringify(second).slice(0, 400));
  } finally {
    f.close();
  }
});

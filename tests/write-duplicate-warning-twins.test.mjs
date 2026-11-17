import test from 'node:test';
import assert from 'node:assert/strict';
import {googleBudgetFixture} from './fixtures/google-budget-writes.mjs';

/**
 * R2.5 M2, lead re-review N9 (second part): a warning covers the identical creates it named. A review prepared after an identical create
 * completed carries a warning (the person has seen that two objects are wanted), and executes. It used to execute whatever had completed
 * since, so a review warned about one twin still ran after a second identical create completed, and made a third object the person had not
 * been shown. At execute, a warned review is refused (DUPLICATE_OF_COMPLETED_WRITE, nothing sent) when an identical create has completed that
 * its warning did not name: it is prepared again, and the new warning names it too.
 */
const identical = f => f.creates(1, 5000000);
const claimOf = (f, id) =>
  f.store.db.prepare('SELECT state FROM idempotency WHERE tenant_id=? AND key=?').get(f.actor.tenantId, id);

test('a review warned about one completed twin is refused when a second identical create completed since: it is prepared again', async () => {
  const f = googleBudgetFixture();
  try {
    const a = (await identical(f)).data.review_id;
    assert.equal((await f.execute(a)).success, true);
    const b = await identical(f),
      c = await identical(f);
    assert.equal(
      b.data.duplicate_warning?.earlier_review_id,
      a,
      'b was prepared after a completed: it carries the warning',
    );
    assert.equal(c.data.duplicate_warning?.earlier_review_id, a);
    // c executes: a second object, which its warning named. b's warning named only a.
    assert.equal((await f.execute(c.data.review_id)).success, true);
    assert.equal(f.writes.length, 2);
    const refused = await f.execute(b.data.review_id);
    assert.equal(refused.error?.code, 'DUPLICATE_OF_COMPLETED_WRITE', JSON.stringify(refused).slice(0, 600));
    assert.equal(refused.error.details.submission, 'not_sent');
    assert.equal(refused.error.details.earlier_review_id, c.data.review_id, 'the create it did not name');
    assert.equal(refused.error.details.next_call.arguments.action, 'prepare');
    assert.equal(f.writes.length, 2, 'nothing was sent: no third object');
    assert.equal(claimOf(f, b.data.review_id), undefined, 'the claim was not taken');
    // Prepared again, the review is warned about the twins that exist now, and it executes if the person wants a third.
    const again = await f.write(refused.error.details.next_call.arguments);
    assert.equal(again.success, true, JSON.stringify(again).slice(0, 400));
    assert.ok(again.data.duplicate_warning);
    const done = await f.execute(again.data.review_id);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 400));
    assert.equal(f.writes.length, 3);
  } finally {
    f.close();
  }
});

test('a review warned about a twin still executes when that is the only completed twin', async () => {
  const f = googleBudgetFixture();
  try {
    const a = (await identical(f)).data.review_id;
    assert.equal((await f.execute(a)).success, true);
    const b = await identical(f);
    const done = await f.execute(b.data.review_id);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 400));
    assert.equal(f.writes.length, 2);
  } finally {
    f.close();
  }
});

test('a twin that left the ten-minute window since the warning is no reason to refuse: nothing is made that was not shown', async () => {
  const f = googleBudgetFixture();
  try {
    const a = (await identical(f)).data.review_id;
    assert.equal((await f.execute(a)).success, true);
    const b = await identical(f);
    assert.ok(b.data.duplicate_warning);
    // The twin is older than ten minutes by the time b executes: fewer twins than the warning named.
    f.store.db
      .prepare('UPDATE idempotency SET created_at=created_at-? WHERE tenant_id=? AND key=?')
      .run(11 * 60000, f.actor.tenantId, a);
    const done = await f.execute(b.data.review_id);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 400));
    assert.equal(f.writes.length, 2);
  } finally {
    f.close();
  }
});

test('a review without a warning is still refused for a completed twin, with the same code', async () => {
  const f = googleBudgetFixture();
  try {
    const a = (await identical(f)).data.review_id,
      b = await identical(f);
    assert.equal(b.data.duplicate_warning, undefined);
    assert.equal((await f.execute(a)).success, true);
    const refused = await f.execute(b.data.review_id);
    assert.equal(refused.error?.code, 'DUPLICATE_OF_COMPLETED_WRITE', JSON.stringify(refused).slice(0, 600));
    assert.equal(f.writes.length, 1);
  } finally {
    f.close();
  }
});

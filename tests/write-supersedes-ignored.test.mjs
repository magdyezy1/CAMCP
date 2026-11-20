import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {account, budgetAction, budgetName, gateway, googleBudgetFixture} from './fixtures/google-budget-writes.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * r25-field-tiktok (#13; the lead's option A, 2026-11-19). `supersedes_review_id` was built to replace an uncertain write that a
 * reconciliation found not applied (R2.5 M2), and it refused every other review, even one that was never sent: an unsubmitted review,
 * one an execute refused before anything reached the provider, an expired one. Such a review needs no replacement. It holds no claim, so
 * the guard against creating twice never sees it, and a prepare without the parameter succeeds; the refusal only failed a call that
 * named the wrong review for no reason of safety. Naming one now goes on, as the same prepare without the parameter would, and the answer
 * says `supersedes_ignored`. Nothing is marked on the old review: it expires by itself. What holds a claim is refused as before, the
 * uncertain path (the seal, its lifting, `supersedes_uncertain`) is unchanged, and the same person, gateway, account and connection
 * are required as they are for a replacement.
 */
before(() => {
  process.env.AMCP_WRITE_RECONCILE_DELAY_MS = '0';
  process.env.AMCP_WRITE_RECONCILE_ROUND_MS = '0';
});
after(() => {
  delete process.env.AMCP_WRITE_RECONCILE_DELAY_MS;
  delete process.env.AMCP_WRITE_RECONCILE_ROUND_MS;
});

const update = amount => ({
  action: budgetAction,
  account_id: account,
  payload: {
    operations: [{update: {resourceName: budgetName(1), amountMicros: String(amount)}, updateMask: 'amount_micros'}],
  },
});
const create = amount => ({
  action: budgetAction,
  account_id: account,
  payload: {operations: [{create: {name: 'Synthetic 0', amountMicros: String(amount), deliveryMethod: 'STANDARD'}}]},
});
/** A prepare of the budget request `request`, as `who` on `connection`, with the arguments of `extra` beside it. */
const prepare = (f, request, extra = {}, who = f.actor, connection = 'g') =>
  f.call('amcp_write', {action: 'prepare', gateway, connection_id: connection, arguments: request, ...extra}, who);
const status = (f, id, who = f.actor) => f.call('amcp_write', {action: 'status', review_id: id}, who);
const reviews = f => f.store.db.prepare("SELECT count(*) AS n FROM documents WHERE kind='write_review'").get().n;
const expire = (f, id, at) => {
  const saved = f.store.document(f.actor.tenantId, 'write_review', id);
  f.store.putDocument(f.actor.tenantId, 'write_review', id, {...saved, expires_at: at});
};

test('an unsent review named in supersedes_review_id does not fail the prepare: it is ignored, and the answer says so', async () => {
  const f = googleBudgetFixture();
  try {
    const old = await prepare(f, update(95000000));
    assert.equal(old.success, true, JSON.stringify(old).slice(0, 400));
    assert.equal((await status(f, old.data.review_id)).data.state, 'unsubmitted');
    const next = await prepare(f, update(96000000), {supersedes_review_id: old.data.review_id});
    assert.equal(next.success, true, JSON.stringify(next).slice(0, 600));
    assert.deepEqual(next.data.supersedes_ignored, {
      review_id: old.data.review_id,
      reason: 'never_sent',
      expires_at: old.data.expires_at,
    });
    assert.equal(next.data.supersedes_uncertain, undefined, 'nothing uncertain was replaced');
    assert.notEqual(next.data.review_id, old.data.review_id);
    // Nothing is marked on the old review: it is as it was prepared, and expires by itself.
    const left = (await status(f, old.data.review_id)).data;
    assert.equal(left.state, 'unsubmitted');
    assert.equal(left.reconciliation, null);
    assert.equal(left.supersedes_uncertain, undefined);
    // The new review is an ordinary one: it carries no supersede, and it executes.
    assert.equal((await status(f, next.data.review_id)).data.supersedes_uncertain, undefined);
    assert.equal((await f.execute(next.data.review_id)).success, true);
    assert.equal(f.writes.length, 1);
    // A prepare that names no review answers no such field.
    assert.equal((await prepare(f, update(97000000))).data.supersedes_ignored, undefined);
  } finally {
    f.close();
  }
});

test('a review that was refused at execute before anything was sent, and one that expired, are ignored too', async () => {
  const f = googleBudgetFixture();
  try {
    const refused = await prepare(f, update(95000000));
    // No spend confirmation: execute refuses before it claims anything.
    const answer = await f.write({action: 'execute', review_id: refused.data.review_id, confirmed: true});
    assertRefused(answer, 'SPEND_CONFIRMATION_REQUIRED', {writes: () => f.writes.length});
    assert.equal(f.claim(refused.data.review_id), undefined, 'a refused execute leaves no claim');
    const a = await prepare(f, update(96000000), {supersedes_review_id: refused.data.review_id});
    assert.equal(a.data.supersedes_ignored?.review_id, refused.data.review_id, JSON.stringify(a).slice(0, 500));
    assert.equal(a.data.supersedes_ignored.reason, 'never_sent');
    // An expired review: its own time is named, past as it is.
    const old = await prepare(f, update(95500000));
    const at = Date.now() - 60000;
    expire(f, old.data.review_id, at);
    assert.equal((await status(f, old.data.review_id)).data.state, 'expired');
    const b = await prepare(f, update(96500000), {supersedes_review_id: old.data.review_id});
    assert.deepEqual(b.data.supersedes_ignored, {
      review_id: old.data.review_id,
      reason: 'never_sent',
      expires_at: new Date(at).toISOString(),
    });
    assert.equal(f.writes.length, 0, 'nothing was sent for any of them');
  } finally {
    f.close();
  }
});

test('an unsent create named in supersedes_review_id is ignored: the guard against creating twice never saw it', async () => {
  const f = googleBudgetFixture();
  try {
    const old = await prepare(f, create(5000000));
    assert.equal(old.success, true, JSON.stringify(old).slice(0, 400));
    // Without the parameter the same prepare succeeds (an unsent review holds no claim); with it, it is the same prepare, and says so.
    assert.equal((await prepare(f, create(5000000))).success, true);
    const next = await prepare(f, create(5000000), {supersedes_review_id: old.data.review_id});
    assert.equal(next.success, true, JSON.stringify(next).slice(0, 500));
    assert.equal(next.data.supersedes_ignored?.review_id, old.data.review_id);
    assert.equal(next.data.duplicate_warning, undefined);
  } finally {
    f.close();
  }
});

test('a review that holds a claim is still refused as it was: a completed write, and one still being sent', async () => {
  const f = googleBudgetFixture();
  try {
    const done = await prepare(f, update(95000000));
    assert.equal((await f.execute(done.data.review_id)).success, true);
    const before = reviews(f);
    const complete = await prepare(f, update(96000000), {supersedes_review_id: done.data.review_id});
    assertRefused(complete, 'RECONCILIATION_UNAVAILABLE', {
      message: /Only a write whose outcome is uncertain is reconciled/,
    });
    assert.equal(complete.error.details.state, 'complete');
    assert.equal(complete.error.details.next_call.arguments.action, 'status');
    // A claim that is pending and not stale: the write may still be on its way.
    const sending = await prepare(f, update(97000000));
    f.store.db
      .prepare("INSERT INTO idempotency(tenant_id,key,fingerprint,state,created_at) VALUES(?,?,?,'pending',?)")
      .run(f.actor.tenantId, sending.data.review_id, 'synthetic', Date.now());
    const pending = await prepare(f, update(98000000), {supersedes_review_id: sending.data.review_id});
    assertRefused(pending, 'RECONCILIATION_UNAVAILABLE', {
      message: /Only a write whose outcome is uncertain is reconciled/,
    });
    assert.equal(pending.error.details.state, 'executing');
    assert.equal(
      reviews(f),
      before + 1,
      'neither refused prepare stored a review (the one added is the prepared "sending" one)',
    );
  } finally {
    f.close();
  }
});

test('another person’s review is refused, an administrator’s too, and nothing is prepared', async () => {
  const f = googleBudgetFixture({role: 'operator'});
  try {
    const member = {tenantId: f.actor.tenantId, userId: 'member', role: 'operator'},
      admin = {tenantId: f.actor.tenantId, userId: 'administrator', role: 'admin'};
    const theirs = await prepare(f, update(95000000), {}, member);
    assert.equal(theirs.success, true, JSON.stringify(theirs).slice(0, 400));
    const before = reviews(f);
    // A colleague cannot read it at all; an administrator can, and may not replace it (nor may the workspace owner: it is the preparer's).
    assertRefused(await prepare(f, update(96000000), {supersedes_review_id: theirs.data.review_id}), 'FORBIDDEN');
    const byAdmin = await prepare(f, update(96000000), {supersedes_review_id: theirs.data.review_id}, admin);
    // Round 2 (the lead's review, S4-3): the review is not an uncertain write, so the refusal does not say it is.
    assertRefused(byAdmin, 'FORBIDDEN', {
      message: /^Only the person who prepared a review names it in supersedes_review_id\.$/,
    });
    assert.equal(reviews(f), before, 'no review was prepared');
    // Its owner may name it.
    const own = await prepare(f, update(96000000), {supersedes_review_id: theirs.data.review_id}, member);
    assert.equal(own.data.supersedes_ignored?.review_id, theirs.data.review_id, JSON.stringify(own).slice(0, 400));
  } finally {
    f.close();
  }
});

test('a review on another connection is refused: a replacement is prepared where the review was', async () => {
  const f = googleBudgetFixture();
  try {
    f.store.putConnection(
      {...f.actor, role: 'admin'},
      {
        id: 'g2',
        tenantId: f.actor.tenantId,
        gateway,
        accounts: [account],
        writeAccounts: [account],
        enabled: true,
        label: 'Second Synthetic Google Ads',
        scopes: ['https://www.googleapis.com/auth/adwords'],
      },
      {accessToken: 'synthetic', developerToken: 'synthetic'},
    );
    const old = await prepare(f, update(95000000));
    assert.equal(old.success, true, JSON.stringify(old).slice(0, 400));
    const before = reviews(f);
    const other = await prepare(f, update(96000000), {supersedes_review_id: old.data.review_id}, f.actor, 'g2');
    assertRefused(other, 'INVALID_ARGUMENT', {message: /same gateway, account and connection/});
    assert.equal(other.error.details.field, 'supersedes_review_id');
    assert.equal(reviews(f), before, 'no review was prepared');
    // The same call on the connection the review was prepared on goes on.
    const same = await prepare(f, update(96000000), {supersedes_review_id: old.data.review_id}, f.actor, 'g');
    assert.equal(same.data.supersedes_ignored?.review_id, old.data.review_id);
  } finally {
    f.close();
  }
});

test('a review that does not exist is still refused, and so is one named by a reader', async () => {
  const f = googleBudgetFixture();
  try {
    assertRefused(await prepare(f, update(96000000), {supersedes_review_id: 'no-such-review'}), 'NOT_FOUND');
    const old = await prepare(f, update(95000000));
    const reader = {...f.actor, userId: 'reader', role: 'reader'};
    assert.notEqual(
      (await prepare(f, update(96000000), {supersedes_review_id: old.data.review_id}, reader)).success,
      true,
    );
  } finally {
    f.close();
  }
});

test('the uncertain path is unchanged: a write found not applied is replaced and sealed, and the answer says supersedes_uncertain', async () => {
  const f = googleBudgetFixture();
  try {
    const old = await prepare(f, create(5000000));
    f.hooks.respond = () => {
      throw new TypeError('synthetic lost response');
    };
    assertRefused(await f.execute(old.data.review_id), 'WRITE_OUTCOME_UNCERTAIN');
    f.hooks.respond = undefined;
    const found = await f.write({action: 'reconcile', review_id: old.data.review_id});
    assert.equal(found.data.classification, 'appears_not_applied', JSON.stringify(found.data));
    const replacement = await f.write(found.data.next_call.arguments);
    assert.equal(replacement.success, true, JSON.stringify(replacement).slice(0, 600));
    assert.equal(replacement.data.supersedes_uncertain, old.data.review_id);
    assert.equal(replacement.data.supersedes_ignored, undefined, 'a replaced write is not an ignored one');
    assert.equal((await status(f, old.data.review_id)).data.state, 'superseded');
  } finally {
    f.close();
  }
});

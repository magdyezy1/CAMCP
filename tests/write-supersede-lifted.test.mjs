import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {budgetName, googleBudgetFixture} from './fixtures/google-budget-writes.mjs';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {ReportWorker} from '../dist/src/worker.js';

/**
 * R2.5 M2, lead re-review N4: a replacement seals the old review only while it can still settle the matter. The seal (`superseded_by`)
 * started at the replacement's prepare and was never lifted, so a replacement that was rejected, or expired unsent, left the old review
 * settled for good: never reconciled, accepted or replaced again, and the object it may have made owned by no review. The likeliest
 * rejection is the provider's own duplicate-name refusal, the strongest sign that the old create was applied.
 *
 * The seal is in force while the replacement is unexpired, or holds a claim that is not rejected (pending, uncertain, complete). It is
 * lifted in the transaction that rejects the replacement, and where a status, a reconciliation or the worker's check finds the replacement
 * expired without a claim: the old review's `superseded_by` is cleared, an audit row says why, and (for the rejection and a status) its
 * check is queued again. A release of the replacement's claim by a refusal before dispatch (a pause, a rate limit) does NOT lift it (the
 * lead's decision, 2026-11-17): the replacement is still alive, and the same review executes again after the cooldown without the old
 * write being settled again.
 *
 * The rejection here is the generic path of this branch: a Google per-service Mutate refused with an error body (HTTP 400), which
 * Google's proof declares applied nothing. (The refusal package's TikTok HTTP-200 refusals reach the same `store.rejected`.)
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
/** The provider's own refusal of a name that is taken: a definitive 4xx with its error body, which applied nothing. */
const nameTaken = () =>
  Response.json(
    {error: {code: 400, message: 'Synthetic: the name is taken.', status: 'INVALID_ARGUMENT'}},
    {status: 400},
  );
const pause = f =>
  f.call('amcp_workspace', {action: 'pause_writes', reason: 'Synthetic incident', confirmed: true}).then(r => {
    assert.equal(r.success, true, JSON.stringify(r));
  });
const resume = f =>
  f.call('amcp_workspace', {action: 'resume_writes', confirmed: true}).then(r => {
    assert.equal(r.success, true, JSON.stringify(r));
  });
/**
 * A budget create lost without being applied, found not applied, and its replacement prepared (the old review is sealed). The old review's
 * own check has run, unless `keepJobs`: none is waiting, so a queued one afterwards is the lift's.
 */
async function replaced(f, {keepJobs = false} = {}) {
  const old = (await f.creates(1, 5000000)).data.review_id;
  f.hooks.respond = lost;
  assert.equal((await f.execute(old)).error?.code, 'WRITE_OUTCOME_UNCERTAIN');
  f.hooks.respond = undefined;
  const found = await f.write({action: 'reconcile', review_id: old});
  assert.equal(found.data.classification, 'appears_not_applied', JSON.stringify(found.data));
  const replacement = await f.write(found.data.next_call.arguments);
  assert.equal(replacement.success, true, JSON.stringify(replacement).slice(0, 500));
  if (!keepJobs) f.store.db.prepare("DELETE FROM jobs WHERE kind='write_reconcile'").run();
  return {old, replacement: replacement.data.review_id, call: found.data.next_call.arguments};
}
/** The provider applies the old write after all, late: its budget now exists under the name both creates carry. */
const appliedLate = f => {
  const name = budgetName(77);
  f.budgets.set(name, '5000000');
  f.names.set(name, 'Synthetic 0');
  return name;
};
/** The review IDs that have an automatic check waiting. */
const queuedChecks = f =>
  f.store.db
    .prepare(
      "SELECT json_extract(input,'$.review_id') AS review_id FROM jobs WHERE kind='write_reconcile' AND state='queued'",
    )
    .all()
    .map(r => r.review_id);
const lifts = f => f.audit().filter(e => e.event === 'write_supersede_lifted');
const expire = (f, id) => {
  const {id: _id, revision: _revision, ...doc} = f.store.document(f.actor.tenantId, 'write_review', id);
  f.store.putDocument(f.actor.tenantId, 'write_review', id, {...doc, expires_at: Date.now() - 1});
};
const status = (f, id) => f.write({action: 'status', review_id: id});
const reconcile = (f, id) => f.write({action: 'reconcile', review_id: id});
/** The person accepts what the latest reconciliation found. */
const accept = (f, id, found) =>
  f.write({action: 'reconcile', review_id: id, accept_applied: true, reconciliation_id: found.data.reconciliation_id});

test('a replacement the provider refused leaves the old review reconcilable and acceptable', async () => {
  const f = googleBudgetFixture();
  try {
    const {old, replacement} = await replaced(f);
    // The old write was applied after all (late), so the replacement's name is taken: the provider refuses it, applying nothing.
    const made = appliedLate(f);
    f.hooks.respond = nameTaken;
    const refused = await f.execute(replacement);
    assert.equal(refused.error.details.submission, 'rejected', JSON.stringify(refused.error).slice(0, 400));
    assert.equal(f.claim(replacement).state, 'rejected');
    // The seal was lifted by the transaction that rejected the replacement, with an audit row and the old review's check queued again.
    const [lifted, ...others] = lifts(f);
    assert.equal(others.length, 0);
    assert.equal(lifted.review_id, old);
    assert.equal(lifted.replacement_id, replacement);
    assert.equal(lifted.reason, 'rejected');
    assert.equal(lifted.check_queued, true);
    assert.deepEqual(queuedChecks(f), [old]);
    const shown = await status(f, old);
    assert.equal(shown.data.state, 'uncertain', JSON.stringify(shown.data).slice(0, 500));
    assert.equal(shown.data.reconciliation?.superseded_by, undefined);
    // It is reconcilable: the object the refusal pointed at is found, and acceptable.
    const found = await reconcile(f, old);
    assert.equal(found.data.classification, 'appears_applied', JSON.stringify(found.data).slice(0, 500));
    assert.deepEqual(found.data.observed_ids, [made]);
    const accepted = await accept(f, old, found);
    assert.equal(accepted.success, true, JSON.stringify(accepted).slice(0, 500));
    assert.equal(f.claim(old).state, 'complete');
    assert.equal((await status(f, old)).data.state, 'reconciled');
    assert.equal(f.writes.length, 2, 'the lost write and the refused replacement, each sent once');
  } finally {
    f.close();
  }
});

test('after the replacement was refused, the old create counts as unresolved again: an identical create is held back', async () => {
  const f = googleBudgetFixture();
  try {
    const {old, replacement} = await replaced(f);
    f.hooks.respond = nameTaken;
    assert.equal((await f.execute(replacement)).error.details.submission, 'rejected');
    f.hooks.respond = undefined;
    const again = await f.creates(1, 5000000);
    assert.equal(again.error?.code, 'DUPLICATE_OF_UNCERTAIN_WRITE', JSON.stringify(again).slice(0, 500));
    assert.equal(again.error.details.earlier_review_id, old);
  } finally {
    f.close();
  }
});

test('a replacement that expired without being executed leaves the old review reconcilable: a status finds it', async () => {
  const f = googleBudgetFixture();
  try {
    const {old, replacement} = await replaced(f);
    // Sealed while the replacement can still be executed.
    assert.equal((await status(f, old)).data.state, 'superseded');
    assert.deepEqual(lifts(f), []);
    expire(f, replacement);
    const shown = await status(f, old);
    assert.equal(shown.data.state, 'uncertain', JSON.stringify(shown.data).slice(0, 500));
    assert.equal(shown.data.reconciliation?.superseded_by, undefined);
    const [lifted, ...others] = lifts(f);
    assert.equal(others.length, 0);
    assert.deepEqual(
      [lifted.review_id, lifted.replacement_id, lifted.reason, lifted.check_queued],
      [old, replacement, 'expired', true],
    );
    assert.deepEqual(queuedChecks(f), [old]);
    // Reconcilable and acceptable: the old write was applied after all.
    const made = appliedLate(f);
    const found = await reconcile(f, old);
    assert.equal(found.data.classification, 'appears_applied', JSON.stringify(found.data).slice(0, 500));
    assert.deepEqual(found.data.observed_ids, [made]);
    assert.equal((await accept(f, old, found)).success, true);
    assert.equal(f.claim(old).state, 'complete');
  } finally {
    f.close();
  }
});

test('a reader’s status lifts the seal over an expired replacement, and queues no check: a reader cannot run one', async () => {
  const f = googleBudgetFixture();
  try {
    const {old, replacement} = await replaced(f);
    expire(f, replacement);
    const shown = await f.call('amcp_write', {action: 'status', review_id: old}, {...f.actor, role: 'reader'});
    assert.equal(shown.data.state, 'uncertain', JSON.stringify(shown).slice(0, 500));
    assert.deepEqual(
      lifts(f).map(e => [e.review_id, e.reason, e.check_queued]),
      [[old, 'expired', false]],
    );
    assert.deepEqual(queuedChecks(f), []);
  } finally {
    f.close();
  }
});

test('a replacement that expired without being executed leaves the old review replaceable again, found by its own reconcile', async () => {
  const f = googleBudgetFixture();
  try {
    const {old, replacement} = await replaced(f);
    expire(f, replacement);
    // No status first: the reconciliation itself finds the seal over, as the worker's check does.
    const found = await reconcile(f, old);
    assert.equal(found.data.classification, 'appears_not_applied', JSON.stringify(found.data).slice(0, 500));
    assert.deepEqual(
      lifts(f).map(e => [e.review_id, e.replacement_id, e.reason]),
      [[old, replacement, 'expired']],
    );
    const second = await f.write(found.data.next_call.arguments);
    assert.equal(second.success, true, JSON.stringify(second).slice(0, 500));
    const done = await f.execute(second.data.review_id);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 500));
    // The seal is back, now for the second replacement, which was sent once.
    const shown = await status(f, old);
    assert.equal(shown.data.state, 'superseded');
    assert.equal(shown.data.reconciliation.superseded_by, second.data.review_id);
    assert.equal(f.writes.length, 2, 'the lost write and the second replacement');
  } finally {
    f.close();
  }
});

test('a replacement released by a refusal before it was sent keeps the old review sealed, and executes again inside its window', async () => {
  const f = googleBudgetFixture();
  try {
    const {old, replacement} = await replaced(f);
    // A pause during the transport's permit wait refuses the write before it is dispatched: the claim is released (D12).
    f.hooks.duringPermit = () => pause(f);
    const refused = await f.execute(replacement);
    assert.equal(refused.error.code, 'WRITES_PAUSED', JSON.stringify(refused.error).slice(0, 400));
    assert.equal(refused.error.details.submission, 'not_sent');
    assert.equal(f.claim(replacement), undefined, 'the replacement’s claim is released');
    // The replacement is alive, so the old review stays sealed: nothing is lifted and no check is queued for it.
    assert.deepEqual(lifts(f), []);
    assert.deepEqual(queuedChecks(f), []);
    const shown = await status(f, old);
    assert.equal(shown.data.state, 'superseded', JSON.stringify(shown.data).slice(0, 500));
    assert.equal(shown.data.reconciliation.superseded_by, replacement);
    assert.equal((await reconcile(f, old)).error?.code, 'RECONCILIATION_UNAVAILABLE');
    // The cause clears, and the same replacement is executed again, without the old write being settled again.
    await resume(f);
    const done = await f.execute(replacement);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 500));
    assert.equal(f.claim(replacement).state, 'complete');
    assert.equal(f.writes.length, 2, 'the lost original and the replacement, each sent once');
    const after = await status(f, old);
    assert.equal(after.data.state, 'superseded');
    assert.equal(after.data.reconciliation.superseded_by, replacement);
    assert.deepEqual(lifts(f), []);
  } finally {
    f.close();
  }
});

test('a replacement that was released and then expired unsent no longer seals the old review: a status finds it', async () => {
  const f = googleBudgetFixture();
  try {
    const {old, replacement} = await replaced(f);
    f.hooks.duringPermit = () => pause(f);
    assert.equal((await f.execute(replacement)).error.code, 'WRITES_PAUSED');
    await resume(f);
    assert.equal((await status(f, old)).data.state, 'superseded', 'sealed while the replacement can still be executed');
    assert.deepEqual(lifts(f), []);
    // Its window passes with no claim: nothing of it was ever sent, so it settles nothing.
    expire(f, replacement);
    const shown = await status(f, old);
    assert.equal(shown.data.state, 'uncertain', JSON.stringify(shown.data).slice(0, 500));
    assert.deepEqual(
      lifts(f).map(e => [e.review_id, e.replacement_id, e.reason, e.check_queued]),
      [[old, replacement, 'expired', true]],
    );
    assert.deepEqual(queuedChecks(f), [old]);
    assert.equal(f.writes.length, 1, 'only the lost original was ever sent');
  } finally {
    f.close();
  }
});

test('the worker’s next check of the old review finds an expired replacement, lifts the seal and reads the provider', async () => {
  const f = googleBudgetFixture();
  try {
    // The old review's own check is still waiting (it was left alone while the replacement stood).
    const {old, replacement} = await replaced(f, {keepJobs: true});
    assert.deepEqual(queuedChecks(f), [old]);
    expire(f, replacement);
    // What the person last found is older than fifteen minutes, so the check reads the provider afresh.
    const {id: _id, revision: _revision, ...record} = f.store.document(f.actor.tenantId, 'write_reconciliation', old);
    f.store.putDocument(f.actor.tenantId, 'write_reconciliation', old, {
      ...record,
      checked_at: Date.now() - 20 * 60000,
    });
    const overview = new ReportingOverview(f.service),
      worker = new ReportWorker(
        f.store,
        async () => ({}),
        (tenant, kind, input) => overview.work(tenant, kind, input),
      );
    f.store.db.prepare("UPDATE jobs SET available_at=0 WHERE kind='write_reconcile' AND state='queued'").run();
    const requests = f.requests.length;
    assert.equal(await worker.once(), true, 'the worker leased the check');
    assert.deepEqual(
      lifts(f).map(e => [e.review_id, e.replacement_id, e.reason]),
      [[old, replacement, 'expired']],
    );
    assert.ok(f.requests.length > requests, 'the check read the provider');
    const shown = await status(f, old);
    assert.equal(shown.data.state, 'uncertain', JSON.stringify(shown.data).slice(0, 500));
    assert.equal(shown.data.reconciliation.superseded_by, undefined);
    assert.equal(shown.data.reconciliation.automatic, true, 'the worker’s answer is the record now');
    assert.equal(shown.data.reconciliation.classification, 'appears_not_applied');
    assert.equal(f.writes.length, 1, 'the check sent nothing');
  } finally {
    f.close();
  }
});

test('a completed replacement keeps the old review sealed', async () => {
  const f = googleBudgetFixture();
  try {
    const {old, replacement} = await replaced(f);
    assert.equal((await f.execute(replacement)).success, true);
    const again = await reconcile(f, old);
    assert.equal(again.error?.code, 'RECONCILIATION_UNAVAILABLE', JSON.stringify(again).slice(0, 400));
    const shown = await status(f, old);
    assert.equal(shown.data.state, 'superseded');
    assert.equal(shown.data.reconciliation.superseded_by, replacement);
    assert.deepEqual(lifts(f), []);
  } finally {
    f.close();
  }
});

test('an uncertain replacement keeps the old review sealed', async () => {
  const f = googleBudgetFixture();
  try {
    const {old, replacement} = await replaced(f);
    f.hooks.respond = lost;
    assert.equal((await f.execute(replacement)).error?.code, 'WRITE_OUTCOME_UNCERTAIN');
    f.hooks.respond = undefined;
    assert.equal(f.claim(replacement).state, 'uncertain');
    // Neither the passing of the replacement’s window nor a reconciliation of the old review opens it.
    expire(f, replacement);
    const again = await reconcile(f, old);
    assert.equal(again.error?.code, 'RECONCILIATION_UNAVAILABLE', JSON.stringify(again).slice(0, 400));
    const shown = await status(f, old);
    assert.equal(shown.data.state, 'superseded');
    assert.equal(shown.data.reconciliation.superseded_by, replacement);
    assert.deepEqual(lifts(f), []);
  } finally {
    f.close();
  }
});

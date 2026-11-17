import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {budgetName, googleBudgetFixture} from './fixtures/google-budget-writes.mjs';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {ReportWorker} from '../dist/src/worker.js';
import {earlierCreates, requestIdentity} from '../dist/src/write-duplicates.js';

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
/** The worker the server runs, over the fixture's own service, and one turn of it with every waiting check made due. */
const workerOf = f => {
  const overview = new ReportingOverview(f.service);
  return new ReportWorker(
    f.store,
    async () => ({}),
    (tenant, kind, input) => overview.work(tenant, kind, input),
  );
};
const runDue = (f, worker) => {
  f.store.db.prepare("UPDATE jobs SET available_at=0 WHERE kind='write_reconcile' AND state='queued'").run();
  return worker.once();
};
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

test('after a rejected replacement the check the lift queues reads the provider, finds the late object and offers the accept', async () => {
  const f = googleBudgetFixture();
  try {
    const {old, replacement} = await replaced(f);
    const made = appliedLate(f);
    f.hooks.respond = nameTaken;
    assert.equal((await f.execute(replacement)).error.details.submission, 'rejected');
    f.hooks.respond = undefined;
    assert.deepEqual(queuedChecks(f), [old], 'the lift queued the old review’s check');
    // The record the lift restores is the not-applied answer the replacement was prepared on, minutes old: it must not settle
    // anything, so the worker reads (lead re-review 2, F1).
    const requests = f.requests.length;
    assert.equal(await runDue(f, workerOf(f)), true, 'the worker leased the check');
    assert.ok(f.requests.length > requests, 'the check read the provider');
    const shown = await status(f, old);
    assert.equal(shown.data.state, 'uncertain');
    assert.equal(shown.data.reconciliation.automatic, true, 'the worker’s answer is the record now');
    assert.equal(
      shown.data.reconciliation.classification,
      'appears_applied',
      JSON.stringify(shown.data.reconciliation),
    );
    assert.deepEqual(shown.data.reconciliation.observed_ids, [made]);
    assert.deepEqual(shown.data.next_call, {
      tool: 'amcp_write',
      arguments: {action: 'reconcile', review_id: old, reconciliation_id: shown.data.reconciliation.reconciliation_id},
      add_after_user_approval: {accept_applied: true},
    });
    const accepted = await f.write({
      action: 'reconcile',
      review_id: old,
      accept_applied: true,
      reconciliation_id: shown.data.reconciliation.reconciliation_id,
    });
    assert.equal(accepted.success, true, JSON.stringify(accepted).slice(0, 500));
    assert.equal(f.claim(old).state, 'complete');
    assert.equal(f.writes.length, 2, 'the lost write and the refused replacement, each sent once');
  } finally {
    f.close();
  }
});

test('right after the lift the old review is not offered for a replacement: a new one needs a fresh check', async () => {
  const f = googleBudgetFixture();
  try {
    const {old, replacement, call} = await replaced(f);
    // The replacement is refused for a reason that made nothing (the old write was not applied).
    f.hooks.respond = nameTaken;
    assert.equal((await f.execute(replacement)).error.details.submission, 'rejected');
    f.hooks.respond = undefined;
    const shown = await status(f, old);
    assert.equal(shown.data.state, 'uncertain');
    // What it kept (found, undated) is shown, but it is no longer an answer: not decisive, with the reason, and no replacement offered.
    assert.equal(shown.data.reconciliation.classification, 'indeterminate', JSON.stringify(shown.data.reconciliation));
    assert.equal(shown.data.reconciliation.reason, 'replacement_rejected');
    assert.deepEqual(shown.data.next_call, {tool: 'amcp_write', arguments: {action: 'reconcile', review_id: old}});
    // The replacement offered before the lift is refused until a check has read the provider again.
    const refused = await f.write(call);
    assert.equal(refused.error?.code, 'RECOVERY_NOT_SAFE', JSON.stringify(refused).slice(0, 500));
    assert.equal(refused.error.details.classification, 'indeterminate');
    assert.equal(refused.error.details.required, 'appears_not_applied');
    const fresh = await reconcile(f, old);
    assert.equal(fresh.data.classification, 'appears_not_applied', JSON.stringify(fresh.data).slice(0, 500));
    const second = await f.write(fresh.data.next_call.arguments);
    assert.equal(second.success, true, JSON.stringify(second).slice(0, 500));
    assert.equal(f.writes.length, 2, 'the lost write and the refused replacement: no new write was sent');
  } finally {
    f.close();
  }
});

test('after the lift of an expired replacement the record says so, and a status offers the check, not a replacement', async () => {
  const f = googleBudgetFixture();
  try {
    const {old, replacement} = await replaced(f);
    expire(f, replacement);
    const shown = await status(f, old);
    assert.equal(shown.data.reconciliation.classification, 'indeterminate');
    assert.equal(shown.data.reconciliation.reason, 'replacement_expired');
    assert.deepEqual(shown.data.next_call, {tool: 'amcp_write', arguments: {action: 'reconcile', review_id: old}});
    // The check that the status queued reads the provider, with no back-dating, and settles it again.
    const requests = f.requests.length;
    assert.equal(await runDue(f, workerOf(f)), true);
    assert.ok(f.requests.length > requests, 'the check read the provider');
    const again = (await status(f, old)).data;
    assert.equal(again.reconciliation.classification, 'appears_not_applied');
    assert.equal(again.reconciliation.automatic, true);
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
    // No back-dating (lead re-review 2, F1): the record the lift restores settles nothing, so the check reads the provider although
    // what the person last found is only minutes old.
    const requests = f.requests.length;
    assert.equal(await runDue(f, workerOf(f)), true, 'the worker leased the check');
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

// Lead re-review 2, F6 (the cost of the guard, which runs inside the write lock at execute): a review a replacement seals stays uncertain for
// ever, and the guard used to build the lookup keys of its plan before it noticed the seal, once for every create it checks.
test('the guard sets a sealed review aside before it builds its lookup keys: a superseded create costs it nothing', async () => {
  const f = googleBudgetFixture();
  try {
    // Two budgets of one name and another amount: the same object to a lookup, but not one request. Both prepare while nothing is claimed.
    const a = (await f.creates(1, 5000000)).data.review_id,
      c = (await f.creates(1, 6000000)).data.review_id;
    f.hooks.respond = lost;
    assert.equal((await f.execute(a)).error?.code, 'WRITE_OUTCOME_UNCERTAIN');
    f.hooks.respond = undefined;
    const document = f.store.document.bind(f.store),
      plan = document(f.actor.tenantId, 'write_review', c).plan;
    // Counts how often the state a review kept is read: only building the lookup keys of its plan reads it.
    let reads = 0;
    f.store.document = (tenant, kind, id) => {
      const doc = document(tenant, kind, id);
      if (kind !== 'write_review' || id !== a) return doc;
      const kept = doc.state;
      return Object.defineProperty(doc, 'state', {
        get() {
          reads++;
          return kept;
        },
        enumerable: true,
        configurable: true,
      });
    };
    const guard = () => earlierCreates(f.store, f.actor, plan, requestIdentity(plan), [c]);
    // The instrument is live: the uncertain create that looks for the same object is held against this one, and its keys were built.
    const held = guard();
    assert.equal(held.unresolved.length, 1, JSON.stringify(held));
    assert.equal(held.unresolved[0].match, 'same_object');
    assert.ok(reads > 0, 'the keys of an unsealed review are built from its state');
    // Reconciled as not applied and replaced, the old review is sealed: it holds nothing back, and its keys are never built.
    const found = await reconcile(f, a);
    assert.equal(found.data.classification, 'appears_not_applied', JSON.stringify(found.data).slice(0, 300));
    assert.equal((await f.write(found.data.next_call.arguments)).success, true);
    reads = 0;
    const sealed = guard();
    assert.deepEqual(sealed.unresolved, []);
    assert.equal(reads, 0, 'the seal is checked before the lookup keys of the sealed review are built');
  } finally {
    f.close();
  }
});

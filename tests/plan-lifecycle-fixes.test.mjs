import test from 'node:test';
import assert from 'node:assert/strict';
import {campaign, googleWorld} from '../dist/tests/helpers/google-write-fake.js';
import {createPlan, on} from './helpers/google-policy-failure.mjs';
import {keywordWorld} from './helpers/google-keyword-group.mjs';
import {runModelCase} from './helpers/plan-lifecycle-model.mjs';

/**
 * r25-planmodel: what the seeded model of the campaign-plan lifecycle (tests/plan-lifecycle-model.test.mjs) found on f6f5490d, one block for each finding. Each block
 * pins the seeds the model found it with (the same case, run again) and says it again as a direct test of the transition that changed. Synthetic customer 123.
 */
const T = 'google-world',
  budgetAction = 'campaign_budget_mutate_campaign_budgets',
  budgets = (n, label = 'Synthetic budget ') =>
    Array.from({length: n}, (_, i) => ({
      create: {name: label + i, amount_micros: '50000000', delivery_method: 'STANDARD'},
    })),
  statusAction = 'campaign_mutate_campaigns',
  // The step that turns a campaign on: its target is read back, so a reconcile can tell that nothing was applied (a created budget may reconcile as indeterminate).
  statusUpdate = [{update: {resource_name: campaign(9), status: 'ENABLED'}, update_mask: 'status'}],
  step = (operations, id = 'step1', action = budgetAction) => ({
    id,
    kind: 'write',
    gateway: 'google_ads_native_action',
    connection_id: 'g',
    account_id: '123',
    description: id,
    arguments: {action: 'google_ads_v23_' + action, payload: {operations}},
  }),
  approver = {tenantId: T, userId: 'approver', role: 'admin'},
  executeNext = (x, id, review_id) =>
    x.call('amcp_campaign', {
      action: 'execute_next',
      id,
      review_id,
      idempotency_key: review_id,
      confirmed: true,
      spend_change_confirmed: true,
    }),
  stored = (x, id) => x.store.document(T, 'campaign_run', id),
  tick = ms => new Promise(resolve => setTimeout(resolve, ms)),
  writesHolding = (x, text) => x.log.filter(r => r.kind === 'write' && JSON.stringify(r.body).includes(text)).length;
/** A plan with one prepared step, waiting for its execute. */
async function planned(operations, {action = budgetAction} = {}) {
  const x = googleWorld({
      policy: on,
      world:
        action === statusAction
          ? {...keywordWorld(), campaignBudgets: {'customers/123/campaignBudgets/1': {}}}
          : keywordWorld(),
    }),
    id = await createPlan(x, [step(operations, 'step1', action)]);
  assert.equal((await x.call('amcp_campaign', {action: 'prepare_next', id})).success, true);
  return {x, id, review: stored(x, id).steps[0].review_id};
}
/** Every attempt to take the target lock is refused until `release`: an execute that has saved its step as executing waits there, before anything is claimed or sent. */
function holdTargetLock(x) {
  const take = x.store.acquireLocks.bind(x.store),
    lock = {held: true, attempts: 0};
  x.store.acquireLocks = (...args) => {
    if (!lock.held) return take(...args);
    lock.attempts++;
    return false;
  };
  return {
    release: () => {
      lock.held = false;
    },
    waiting: async () => {
      for (let i = 0; i < 1000 && lock.attempts === 0; i++) await tick(10);
      assert.ok(lock.attempts > 0, 'the execute came to wait for its target');
    },
  };
}
/** Another person approves the plan as it is now. */
async function approveAs(x, id) {
  const preview = await x.service.call('amcp_campaign', {action: 'approve', id}, approver);
  assert.equal(preview.success, true, JSON.stringify(preview).slice(0, 300));
  const approved = await x.service.call(
    'amcp_campaign',
    {...preview.data.next_call.arguments, ...preview.data.next_call.add_after_user_approval},
    approver,
  );
  assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 300));
}
/**
 * The model's own case for a seed, run again: it must hold every invariant, and says which one it broke when it does not. The seeds of F1 to F4 are pinned on the generator they
 * were found with (the plain plans); the seeds of item 4 are cases of the plan kinds (`flavors`).
 */
const modelCase = async (seed, options = {}) => {
  const result = await runModelCase({seed, ...options});
  assert.equal(result.ok, true, 'seed ' + seed + ': ' + String(result.error?.message) + '\n' + result.trace.join('\n'));
};

// ---- F2: the outcome of an execute is saved onto the plan as it is now ------------------------------------------------------------------------------------------
// execute_next saves its step as executing, awaits the provider (the state, the write, the read-back), and saved the copy of the plan it took before: any save another
// call made meanwhile (an approval, from the owner or another person) made that save REVISION_CONFLICT after the write was applied, and the step stayed executing,
// no crash and no fault. The step's outcome is now saved onto a fresh read of the plan, by step id, and what the other call saved stays.
for (const seed of [336, 538])
  test('F2 (the model, seed ' + seed + '): an approval during an execute leaves no step executing', () =>
    modelCase(seed),
  );

test('F2: an approval recorded while a step executes is kept, the step settles, and the write is sent once', async () => {
  const {x, id, review} = await planned(budgets(2));
  try {
    const lock = holdTargetLock(x),
      inflight = executeNext(x, id, review);
    await lock.waiting();
    assert.equal(stored(x, id).steps[0].status, 'executing');
    await approveAs(x, id);
    const approval = stored(x, id).approval;
    assert.equal(approval.by, 'approver');
    lock.release();
    const done = await inflight;
    assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 400));
    const plan = stored(x, id);
    assert.equal(plan.steps[0].status, 'verified', 'the step settled');
    assert.deepEqual(plan.approval, approval, 'and the approval the other call recorded is still there');
    assert.equal(plan.state, 'complete');
    assert.equal(x.writes(), 1, 'the write was sent once');
    assert.equal(writesHolding(x, 'Synthetic budget 0"'), 1);
  } finally {
    x.store.close();
  }
});

test('F2: when the plan keeps changing, the outcome is not lost: the refusal names the resume, which replays the receipt and settles the step with no second write', async () => {
  const {x, id, review} = await planned(budgets(2));
  try {
    // Another process saves the plan just before each attempt to save the outcome: the revision of every attempt is out of date.
    const put = x.store.putDocument.bind(x.store);
    let armed = false,
      competing = 0;
    x.store.putDocument = (tenant, kind, doc, data, ...rest) => {
      if (armed && kind === 'campaign_run' && doc === id) {
        const {id: _id, revision, ...current} = stored(x, id);
        put(tenant, kind, id, current, revision);
        competing++;
      }
      return put(tenant, kind, doc, data, ...rest);
    };
    const lock = holdTargetLock(x),
      inflight = executeNext(x, id, review);
    await lock.waiting();
    armed = true;
    lock.release();
    const lost = await inflight;
    armed = false;
    assert.equal(lost.error?.code, 'REVISION_CONFLICT', JSON.stringify(lost.error ?? lost).slice(0, 300));
    assert.equal(competing, 5, 'five attempts, no more');
    assert.equal(lost.error.details.step_id, 'step1');
    assert.equal(lost.error.details.next_call.tool, 'amcp_campaign');
    assert.deepEqual(lost.error.details.next_call.arguments, {
      action: 'execute_next',
      id,
      review_id: review,
      idempotency_key: review,
      confirmed: true,
    });
    assert.equal(stored(x, id).steps[0].status, 'executing', 'the outcome was not saved');
    assert.equal(x.writes(), 1, 'but the write was applied once');
    // The call it names replays the receipt under the same key: nothing is sent again, and the step settles.
    const resumed = await x.call('amcp_campaign', {
      ...lost.error.details.next_call.arguments,
      ...lost.error.details.next_call.add_after_user_approval,
    });
    assert.equal(resumed.success, true, JSON.stringify(resumed.error ?? resumed).slice(0, 300));
    assert.equal(stored(x, id).steps[0].status, 'verified');
    assert.equal(x.writes(), 1, 'no second write');
  } finally {
    x.store.close();
  }
});

// ---- F1: a retirement and the plan's save are one step, and an execute refused as retired puts its step back ---------------------------------------------------------
// cancel retired the unsettled steps' reviews and then saved the plan, two steps: a save that failed or conflicted (another process saved the plan) left a live plan holding
// retired reviews. The next execute_next of its step saved the step executing, was refused REVIEW_RETIRED and, taking the plan to have been saved by whatever retired the
// review, saved nothing more: executing for good, with no read naming a way out. The retirement and the save are one transaction now, and an execute refused before it
// claimed anything puts its step back to what it was before the call when nobody saved the plan.
for (const seed of [43, 774, 809, 928])
  test(
    'F1 (the model, seed ' + seed + '): a cancel that did not happen retires nothing, and no step is left executing',
    () => modelCase(seed),
  );

for (const [label, operations] of [
  ['a single review', budgets(2)],
  ['a write group of 30', budgets(30)],
])
  test(
    'F1 (a): a cancel whose plan save fails retires nothing (' +
      label +
      '): the plan goes on, and its step is executed through it once',
    async () => {
      const {x, id, review} = await planned(operations),
        parts = x.store.db.prepare("SELECT 1 FROM documents WHERE kind='write_review_group' AND id=?").get(review)
          ? x.store.document(T, 'write_review_group', review).parts
          : [];
      try {
        const put = x.store.putDocument.bind(x.store);
        let failed = false;
        x.store.putDocument = (tenant, kind, doc, ...rest) => {
          if (!failed && kind === 'campaign_run' && doc === id) {
            failed = true;
            throw new Error('synthetic failure of the plan save');
          }
          return put(tenant, kind, doc, ...rest);
        };
        const cancelled = await x.call('amcp_campaign', {action: 'cancel', id, confirmed: true});
        x.store.putDocument = put;
        assert.equal(failed, true, 'the save failed');
        assert.equal(cancelled.error?.code, 'INTERNAL_ERROR');
        assert.equal(stored(x, id).state, 'awaiting_review', 'the plan is as it was');
        for (const kind of [
          [parts.length ? 'write_review_group' : 'write_review', review],
          ...parts.map(part => ['write_review', part]),
        ])
          assert.equal(
            x.store.document(T, kind[0], kind[1]).retired,
            undefined,
            kind[1] + ' is not retired by a cancel that did not happen',
          );
        const done = await executeNext(x, id, review);
        assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 300));
        assert.equal(x.writes(), Math.max(1, parts.length));
        assert.equal(writesHolding(x, 'Synthetic budget 0"'), 1);
      } finally {
        x.store.close();
      }
    },
  );

test('F1 (a): a cancel whose plan save conflicts with another process’s save retires nothing either', async () => {
  const {x, id, review} = await planned(budgets(2));
  try {
    const put = x.store.putDocument.bind(x.store);
    let raced = false;
    x.store.putDocument = (tenant, kind, doc, data, ...rest) => {
      if (!raced && kind === 'campaign_run' && doc === id) {
        raced = true;
        // Another process saves the plan just before the cancel does: its revision is out of date.
        const {id: _id, revision, ...current} = stored(x, id);
        put(tenant, kind, id, current, revision);
      }
      return put(tenant, kind, doc, data, ...rest);
    };
    const cancelled = await x.call('amcp_campaign', {action: 'cancel', id, confirmed: true});
    x.store.putDocument = put;
    assert.equal(cancelled.error?.code, 'REVISION_CONFLICT');
    assert.equal(x.store.document(T, 'write_review', review).retired, undefined);
    assert.equal((await executeNext(x, id, review)).success, true);
    assert.equal(x.writes(), 1);
  } finally {
    x.store.close();
  }
});

test('F1 (b): an execute refused as a retired review, with nobody having saved the plan, puts its step back: ready, and the plan as it was', async () => {
  const {retireReview} = await import('../dist/src/write-record-repository.js'),
    {x, id, review} = await planned(budgets(2));
  try {
    const lock = holdTargetLock(x),
      inflight = executeNext(x, id, review);
    await lock.waiting();
    assert.equal(stored(x, id).steps[0].status, 'executing');
    // The review is retired by a call whose plan save never happened: the marks are there, and the plan is as the execute saved it.
    assert.equal(retireReview(x.store, T, review, {plan_id: id, step_id: 'step1', reason: 'cancelled'}), 'marked');
    lock.release();
    const refused = await inflight;
    assert.equal(refused.error?.code, 'REVIEW_RETIRED', JSON.stringify(refused.error ?? refused).slice(0, 300));
    const plan = stored(x, id);
    assert.equal(plan.steps[0].status, 'review_ready', 'the step is not left executing');
    assert.equal(plan.state, 'awaiting_review');
    assert.equal(x.writes(), 0);
    assert.equal(x.store.db.prepare('SELECT count(*) AS n FROM idempotency').get().n, 0, 'nothing was claimed');
  } finally {
    x.store.close();
  }
});

// ---- F3: a step left executing: the reads name the call that settles it ---------------------------------------------------------------------------------------------------
// A step is saved executing before its review is sent. A call that ends before it saves the outcome (the process died, or its save failed) leaves it so, with the write
// applied and its claim complete. No read named the way on: get named no call, and the review's status named verify, which answers verified and leaves the step executing;
// only prepare_next said "resume", and no read said prepare_next. The plan's get (compact, full and a step's own) and the review's status now name execute_next with the
// exact review and its key, which replays the receipt recorded under that key and sends nothing twice.
for (const seed of [348, 633])
  test(
    'F3 (the model, seed ' + seed + '): a step left executing after the write is settled by the call the reads name',
    () => modelCase(seed),
  );

/** What a call names, without the sentence that explains it: the tool, its arguments, and what the user adds after approving. */
const callOf = call =>
  call && {tool: call.tool, arguments: call.arguments, add_after_user_approval: call.add_after_user_approval};
/** The state a crash between the provider write and the plan save leaves: the final save fails (the call ends there), the step is executing and its claim is complete. */
async function endedAfterTheWrite(operations) {
  const {x, id, review} = await planned(operations),
    put = x.store.putDocument.bind(x.store);
  let saves = 0;
  x.store.putDocument = (tenant, kind, doc, ...rest) => {
    if (kind === 'campaign_run' && doc === id && ++saves === 2)
      throw new Error('synthetic failure of the plan save after the write');
    return put(tenant, kind, doc, ...rest);
  };
  const cut = await executeNext(x, id, review);
  x.store.putDocument = put;
  assert.equal(cut.error?.code, 'INTERNAL_ERROR');
  assert.equal(stored(x, id).steps[0].status, 'executing');
  assert.equal(x.writes(), 1);
  return {x, id, review};
}
const statusOf = async (x, id) => (await x.call('amcp_write', {action: 'status', review_id: id})).data;

test('F3: a step left executing after the write: the plan’s get, compact, full and by step, and the review’s status, name execute_next with the review and its key, and it settles the step with no second write', async () => {
  const {x, id, review} = await endedAfterTheWrite(budgets(2)),
    realNow = Date.now;
  try {
    // The call ended (the lease its execute holds, two minutes, has run out): until then the reads say that a call may still be executing it (M2, tests/plan-lifecycle-inflight.test.mjs).
    Date.now = () => realNow() + 3 * 60000;
    const flags = stored(x, id).steps[0].review.execute_requirements?.spend_change_confirmed
        ? {spend_change_confirmed: true}
        : undefined,
      resume = {
        tool: 'amcp_campaign',
        arguments: {action: 'execute_next', id, review_id: review, idempotency_key: review, confirmed: true},
        add_after_user_approval: flags,
      };
    for (const read of [
      {action: 'get', id},
      {action: 'get', id, detail: 'full'},
      {action: 'get', id, step_id: 'step1'},
    ]) {
      const got = await x.call('amcp_campaign', read);
      assert.equal(got.success, true, JSON.stringify(got).slice(0, 300));
      assert.deepEqual(callOf(got.data.next_call), resume, JSON.stringify(read));
    }
    const status = await statusOf(x, review);
    // The execute got as far as the read-back before its save failed, so the review reads verified; a crash at the read-back (the model's seeds) leaves it complete.
    assert.equal(status.state, 'verified');
    assert.deepEqual(
      callOf(status.next_call),
      resume,
      'the review’s status leads back to the plan, not to verify alone',
    );
    // The call it names replays the receipt under the same key: nothing is sent again, and the step settles.
    const done = await x.call('amcp_campaign', {...resume.arguments, ...resume.add_after_user_approval});
    assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 300));
    assert.equal(stored(x, id).steps[0].status, 'verified');
    assert.equal(x.writes(), 1, 'one write in all');
    // A step that is not executing is read as it was: no call is named for a plan that is done.
    assert.equal((await x.call('amcp_campaign', {action: 'get', id})).data.next_call, undefined);
  } finally {
    Date.now = realNow;
    x.store.close();
  }
});

// ---- F4: a step left executing with its claim pending or uncertain: the reads lead back to the plan -------------------------------------------------------------------
// A crash with the claim pending (at the write, or just after the provider applied it) leaves the step executing and its outcome unknown. The review's status named itself,
// then (once the claim aged) reconcile, and a reconcile that found the change not applied offered a standalone replacement: a prepare with supersedes_review_id, a review no
// step holds, whose execute creates the object outside the plan and leaves the plan's step executing for good. For the review of a step left executing, the status names the
// plan's resume (which sends nothing: the step then reads uncertain, and the plan names the read-only lookups), the reconcile reads the step in its plan, and the plan's get names
// the resume with the read after it. A step that is uncertain keeps the replacement of R2.5 M2 (journey J14). (The model reads the review's status on its own as well: the
// status of a crashed step must lead back to the plan when the plan's own read is not the one made first.)
for (const seed of [20, 797, 763, 843])
  test(
    'F4 (the model, seed ' +
      seed +
      '): a step left executing with its claim pending is settled by the call the reads name',
    () => modelCase(seed),
  );

test('F4: a step left executing with its claim open: get and the status name the status while the claim is young and the resume once it reads uncertain, the reconcile reads the step in its plan and offers no standalone replacement, and the resume sends nothing', async () => {
  const {x, id, review} = await planned(statusUpdate, {action: statusAction}),
    realNow = Date.now;
  try {
    // The state a crash right after the claim leaves: the step executing, the review claimed and nothing sent.
    const {id: _id, revision, ...data} = stored(x, id);
    data.steps[0].status = 'executing';
    data.state = 'in_progress';
    x.store.putDocument(T, 'campaign_run', id, data, revision);
    x.store.claim(T, review, x.store.document(T, 'write_review', review).fingerprint);
    const named = call => call && {tool: call.tool, arguments: call.arguments},
      resume = {
        tool: 'amcp_campaign',
        arguments: {action: 'execute_next', id, review_id: review, idempotency_key: review, confirmed: true},
      },
      readStep = {tool: 'amcp_campaign', arguments: {action: 'get', id, step_id: 'step1'}},
      lookup = action => ({tool: 'amcp_write', arguments: {action, review_id: review}});
    // Being sent (the claim is younger than ten minutes): the request may still be going out, so the plan and the review's status name the status, to be read again (M2): the
    // resume is named once the claim reads uncertain.
    let got = await x.call('amcp_campaign', {action: 'get', id});
    assert.deepEqual(
      named(got.data.next_call),
      lookup('status'),
      'being sent: read the status, never execute it twice',
    );
    let status = await statusOf(x, review);
    assert.equal(status.state, 'executing');
    assert.deepEqual(named(status.next_call), lookup('status'));
    // The claim has aged: the resume, with the reconcile after it.
    Date.now = () => realNow() + 11 * 60000;
    got = await x.call('amcp_campaign', {action: 'get', id});
    assert.deepEqual(named(got.data.next_call), resume);
    assert.deepEqual(got.data.next_call.then, lookup('reconcile'), 'aged: reconcile it');
    status = await statusOf(x, review);
    assert.equal(status.state, 'uncertain');
    assert.deepEqual(named(status.next_call), resume);
    // The reconcile finds nothing was applied (the provider never saw the write): it reads the step in its plan, and offers no review that no step holds.
    const reconciled = await x.call('amcp_write', {action: 'reconcile', review_id: review});
    assert.equal(reconciled.success, true, JSON.stringify(reconciled.error ?? reconciled).slice(0, 300));
    assert.equal(reconciled.data.classification, 'appears_not_applied');
    assert.deepEqual(named(reconciled.data.next_call), readStep);
    assert.ok(!JSON.stringify(reconciled.data.next_call).includes('supersedes_review_id'), 'no standalone replacement');
    assert.deepEqual(
      named((await statusOf(x, review)).next_call),
      resume,
      'and its status still leads back to the plan',
    );
    // The resume is refused as uncertain, sends nothing, and the step reads uncertain.
    const resumed = await x.call('amcp_campaign', {...resume.arguments, spend_change_confirmed: true});
    assert.equal(stored(x, id).steps[0].status, 'uncertain', JSON.stringify(resumed.error ?? resumed).slice(0, 300));
    assert.equal(x.writes(), 0);
    // The step is uncertain now, not executing: the review whose last check found nothing applied is replaced as it always was (R2.5 M2, journey J14).
    status = await statusOf(x, review);
    assert.equal(status.next_call.arguments.supersedes_review_id, review);
  } finally {
    Date.now = realNow;
    x.store.close();
  }
});

test('F4: a step left executing that holds a write group names its status after the resume, not a reconcile (a group is read part by part)', async () => {
  const {x, id, review} = await planned(budgets(30)),
    parts = x.store.document(T, 'write_review_group', review).parts;
  try {
    // The state a crash right after the first part was claimed leaves: the step executing, a part claimed, nothing sent.
    const {id: _id, revision, ...data} = stored(x, id);
    data.steps[0].status = 'executing';
    data.state = 'in_progress';
    x.store.putDocument(T, 'campaign_run', id, data, revision);
    x.store.claim(T, parts[0], x.store.document(T, 'write_review', parts[0]).fingerprint);
    const got = await x.call('amcp_campaign', {action: 'get', id});
    assert.equal(got.data.next_call.arguments.action, 'execute_next');
    assert.deepEqual(got.data.next_call.then, {tool: 'amcp_write', arguments: {action: 'status', review_id: review}});
  } finally {
    x.store.close();
  }
});

// ---- Item 4 of the audit of 2026-11-25: a continuation keeps what bound its plan, or is not made -------------------------------------------------------------------------
// continue_as_new made a new plan without `activation_of` (the platform's gates and the second approver) or `catalog_retirement` (the check that a retired product exists). The
// model draws plan kinds for it (`flavors`): an activation plan whose gates pass or refuse, a catalog retirement plan. These are seeds that were red before the continuation of
// such a plan was refused: the plan that continues one lost its binding (10b), a claim was taken where the gates refuse (10a), and execute_next sent with no second person (8).
// The direct tests are in tests/campaign-activation.test.mjs and tests/catalog-retirement.test.mjs.
for (const seed of [2, 10, 54, 55, 34, 37, 82, 83])
  test(
    'item 4 (the model, seed ' +
      seed +
      '): a plan bound by an activation or a retirement is not continued without its binding',
    () => modelCase(seed, {flavors: true}),
  );

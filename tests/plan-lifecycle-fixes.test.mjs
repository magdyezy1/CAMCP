import test from 'node:test';
import assert from 'node:assert/strict';
import {googleWorld} from '../dist/tests/helpers/google-write-fake.js';
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
  step = (operations, id = 'step1') => ({
    id,
    kind: 'write',
    gateway: 'google_ads_native_action',
    connection_id: 'g',
    account_id: '123',
    description: id,
    arguments: {action: 'google_ads_v23_' + budgetAction, payload: {operations}},
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
async function planned(operations) {
  const x = googleWorld({policy: on, world: keywordWorld()}),
    id = await createPlan(x, [step(operations)]);
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
/** The model's own case for a seed, run again: it must hold every invariant, and says which one it broke when it does not. */
const modelCase = async seed => {
  const result = await runModelCase({seed});
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

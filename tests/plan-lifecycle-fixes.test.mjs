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

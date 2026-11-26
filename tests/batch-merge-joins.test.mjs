import test from 'node:test';
import assert from 'node:assert/strict';
import {groupLeaseLive, groupLock} from '../dist/src/write-record-repository.js';
import {
  budgets,
  claimState,
  door,
  executeNext,
  follow,
  gateTransport,
  planned,
  show,
  stored,
  T,
} from './helpers/plan-lifecycle-kit.mjs';

/**
 * The joins of the must-fix batch merge (r25-batch-merge): what two packages that pass alone must say together.
 *
 * J1, r25-planmodel x r25-mf-groups: planmodel reads a step as being executed for the two minutes after its execute stamped it, or while its claim is pending; mf-groups sends a
 * write group part by part under a lease that its sender renews, and the claims of a group with a part sent read `uncertain`, never `pending`. A group has up to 40 parts, so
 * after two minutes every read of the plan named `execute_next` for a group that was being sent, and a second call took the step over (it saved the step ready again while the
 * group went on). The check that a call is executing a step now asks for the group's lease too. A group of 60 budgets is three parts, of 25, 25 and 10.
 */
const GROUP = 60;
const threeMinutes = 3 * 60000;
/** The calls an answer names (a plan read, the status of a review), as the kit's reads give them. */
const named = read => read.data?.next_call ?? read.error?.details?.next_call;
const sends = ['execute_next', 'execute', 'prepare', 'prepare_next', 'reconcile', 'recover_step', 'continue_as_new'];

/**
 * A plan whose only step is a write group of three parts, being sent: parts 1 and 2 are applied, the write of part 3 waits at a gate, and the clock says the execute began three
 * minutes ago. The sender renews its lease every 30 seconds while it sends; the clock moves at once, so the test renews it as the heartbeat would.
 */
async function groupSentForThreeMinutes() {
  const realNow = Date.now,
    {x, id, review} = await planned(budgets(GROUP)),
    gate = gateTransport(x),
    third = door();
  assert.equal(stored(x, id).steps[0].review.parts.length, 3, 'a group of three parts');
  gate.rules = [{kind: 'write', nth: 3, hold: third.p}];
  const first = executeNext(x, id, review);
  await gate.arrived();
  assert.equal(x.writes(), 2, 'parts 1 and 2 are applied, and part 3 waits at its gate');
  assert.equal(show(x, id), 'in_progress [step1=executing]');
  Date.now = () => realNow() + threeMinutes;
  x.store.db
    .prepare('UPDATE service_locks SET expires_at=? WHERE key=?')
    .run(Date.now() + 120000, groupLock(T, review));
  assert.equal(groupLeaseLive(x.store, T, review), true, 'the sender still holds the group’s lease');
  return {
    x,
    id,
    review,
    first,
    third,
    finish: () => {
      Date.now = realNow;
      third.open();
    },
  };
}

test('J1: a write group that has been sent for three minutes is still being sent: the reads name executing and no call that sends, and the group settles once with three writes', async () => {
  const {x, id, review, first, finish} = await groupSentForThreeMinutes();
  try {
    const reads = {
      get: await x.call('amcp_campaign', {action: 'get', id}),
      'get, full': await x.call('amcp_campaign', {action: 'get', id, detail: 'full'}),
      'get, the step': await x.call('amcp_campaign', {action: 'get', id, step_id: 'step1'}),
      status: await x.call('amcp_write', {action: 'status', review_id: review}),
      prepare_next: await x.call('amcp_campaign', {action: 'prepare_next', id}),
    };
    for (const [name, read] of Object.entries(reads))
      assert.equal(read.success, true, name + ': ' + JSON.stringify(read.error ?? read).slice(0, 300));
    assert.equal(reads.get.data.steps[0].status, 'executing', 'get: the step is executing');
    assert.equal(reads.status.data.state, 'executing', 'status: the group is executing');
    for (const [name, read] of Object.entries(reads)) {
      const next = named(read);
      assert.ok(next?.tool && next.arguments, name + ': names a call to read it again: ' + JSON.stringify(next));
      assert.equal(
        sends.includes(next.arguments.action),
        false,
        name + ': names a call that sends or changes the plan: ' + JSON.stringify(next.arguments),
      );
      // Its request is going out, so the call is the status of the group's review, never a read of the step "begun less than two minutes ago".
      assert.deepEqual(next.arguments, {action: 'status', review_id: review}, name);
      // The call it names is a read: following it leaves the step as it is.
      const done = await follow(x, next);
      assert.equal(done.success, true, name + ': ' + JSON.stringify(done.error ?? done).slice(0, 300));
      assert.equal(show(x, id), 'in_progress [step1=executing]', name + ': following the named call changed the plan');
    }
    assert.equal(x.writes(), 2, 'nothing was sent by a read');
    finish();
    const done = await first;
    assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 300));
    assert.equal(show(x, id), 'complete [step1=verified]');
    assert.equal(stored(x, id).steps[0].error, undefined, 'a verified step carries no error');
    assert.equal(x.writes(), 3, 'three parts, sent once each');
    assert.equal(claimState(x, review), 'complete', 'the group’s receipt');
    assert.equal(groupLeaseLive(x.store, T, review), false, 'the lease is released');
  } finally {
    finish();
    await first.catch(() => {});
    x.store.close();
  }
});

/** A second call of a step the first call is executing: refused for what is its own, or for nothing but the busy group. Nothing of it is the step's. */
const secondCall = {
  'nothing of its own': (x, id, review) => executeNext(x, id, review),
  'a flag the review does not take (creative_edit_confirmed)': (x, id, review) =>
    executeNext(x, id, review, {creative_edit_confirmed: true}),
  'writes disabled for the call': async (x, id, review) => {
    x.service.policy.allowWrites = false;
    try {
      return await executeNext(x, id, review);
    } finally {
      x.service.policy.allowWrites = true;
    }
  },
};
for (const [mistake, call] of Object.entries(secondCall))
  test(`J1: while a group has been sent for three minutes, a second execute_next refused for ${mistake} saves nothing: the step is still the first call’s and the group is sent once`, async () => {
    const {x, id, review, first, finish} = await groupSentForThreeMinutes();
    try {
      const second = await call(x, id, review);
      assert.equal(second.success, true, JSON.stringify(second.error ?? second).slice(0, 300));
      assert.match(
        String(second.data.notice),
        /is being executed by another call of this plan, so this call changed nothing/,
        'the second call is told the step is being executed',
      );
      assert.equal(show(x, id), 'in_progress [step1=executing]', 'the step is not failed, ready again or uncertain');
      assert.equal(stored(x, id).steps[0].error, undefined);
      assert.equal(x.writes(), 2, 'the second call sent nothing');
      finish();
      const done = await first;
      assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 300));
      assert.equal(show(x, id), 'complete [step1=verified]');
      assert.equal(x.writes(), 3, 'sent once, by the first call');
      assert.equal(claimState(x, review), 'complete');
    } finally {
      finish();
      await first.catch(() => {});
      x.store.close();
    }
  });

import test from 'node:test';
import assert from 'node:assert/strict';
import {googleWorld} from '../dist/tests/helpers/google-write-fake.js';
import {createPlan, on} from './helpers/google-policy-failure.mjs';
import {keywordWorld} from './helpers/google-keyword-group.mjs';
import {budgets, follow, show, step, stored} from './helpers/plan-lifecycle-kit.mjs';

/**
 * r25-planmodel, the second round (M3 of the independent review of 451169fd): run stops `waiting` when a step's read-back is still settling, and named run, whatever the plan
 * had named: a read-back that reading again cannot settle needs the person's answer (accept what was observed, or correct it), and run named itself for ever, three calls in
 * a row, with the answer hidden from the call and from the website. Only the call that prepares the next step is run's to replace.
 */
const approveSelf = async (x, id) => {
  const shown = await x.call('amcp_campaign', {action: 'approve', id});
  assert.equal(shown.success, true, JSON.stringify(shown.error ?? shown).slice(0, 300));
  const approved = await follow(x, shown.data.next_call);
  assert.equal(approved.success, true, JSON.stringify(approved.error ?? approved).slice(0, 300));
};
const plan = async count => {
  const x = googleWorld({policy: on, world: keywordWorld()}),
    id = await createPlan(
      x,
      Array.from({length: count}, (_, i) => ({
        ...step(budgets(1, 'Step ' + (i + 1) + ' budget '), 's' + (i + 1)),
        ...(i ? {depends_on: ['s' + i]} : {}),
      })),
    );
  await approveSelf(x, id);
  return {x, id};
};

test('M3 (R1): a read-back reading again cannot settle keeps the decision it names: run stops waiting at it, call after call, and says what the person can do', async () => {
  const {x, id} = await plan(2);
  try {
    x.service.verifyWrite = async () => ({
      status: 'inconclusive',
      actual_hash: 'observed-hash',
      checks: [{resource_id: 'r', status: 'inconclusive', changed_fields: ['/amount']}],
    });
    for (let call = 1; call <= 3; call++) {
      const ran = await x.call('amcp_campaign', {action: 'run', id});
      assert.equal(ran.success, true, JSON.stringify(ran.error ?? ran).slice(0, 300));
      assert.equal(ran.data.run.stopped, 'waiting', 'call ' + call);
      const named = ran.data.next_call;
      assert.equal(named?.arguments?.action, 'reconcile_step', 'call ' + call + ': ' + JSON.stringify(named));
      assert.equal(named.arguments.step_id, 's1');
      assert.equal(named.add_after_user_approval.accept_observed, true, 'the answer only the person gives');
      assert.equal(named.arguments.actual_hash, 'observed-hash', 'of the state the person saw');
      assert.equal(ran.data.run.next_call?.arguments?.action, 'reconcile_step', 'and the stop names it too');
      assert.match(ran.data.decision, /Accept the observed state if the user agrees/);
      assert.deepEqual(
        stored(x, id).steps.map(s => s.status),
        ['verifying', 'pending'],
        'call ' + call + ': ' + show(x, id),
      );
    }
    assert.equal(x.writes(), 1, 'the step was sent once, and nothing else was');
  } finally {
    x.store.close();
  }
});

test('M3 (R2): a read-back nothing can settle and no decision exists for names no call: run does not name itself for ever', async () => {
  const {x, id} = await plan(1);
  try {
    x.service.verifyWrite = async () => ({status: 'unverified', checks: []});
    for (let call = 1; call <= 2; call++) {
      const ran = await x.call('amcp_campaign', {action: 'run', id});
      assert.equal(ran.success, true, JSON.stringify(ran.error ?? ran).slice(0, 300));
      assert.equal(ran.data.run.stopped, 'waiting', 'call ' + call);
      assert.equal(ran.data.next_call, null, 'call ' + call + ': ' + JSON.stringify(ran.data.next_call));
      assert.equal(ran.data.run.next_call ?? null, null);
    }
    assert.equal(x.writes(), 1);
  } finally {
    x.store.close();
  }
});

test('M3: a read-back still settling that reading again can settle keeps run as its next call, and the step is sent once', async () => {
  const {x, id} = await plan(2);
  try {
    const real = x.service.verifyWrite.bind(x.service),
      seen = {};
    // The first two read-backs of each review are not caught up (the one after the write, and the one prepare_next makes); the third is (the provider's lag).
    x.service.verifyWrite = async (actor, review) =>
      (seen[review] = (seen[review] ?? 0) + 1) <= 2
        ? {
            status: 'unverified',
            checks: [],
            next_call: {tool: 'amcp_campaign', arguments: {action: 'verify', review_id: review}},
            retry_read_after_ms: 1000,
          }
        : real(actor, review);
    const first = await x.call('amcp_campaign', {action: 'run', id});
    assert.equal(first.data.run.stopped, 'waiting');
    assert.deepEqual(first.data.next_call.arguments, {action: 'run', id});
    assert.deepEqual(first.data.run.next_call.arguments, {action: 'run', id});
    assert.equal(first.data.retry_read_after_ms, 1000);
    const second = await x.call('amcp_campaign', {action: 'run', id});
    assert.equal(second.success, true, JSON.stringify(second.error ?? second).slice(0, 300));
    assert.equal(x.writes() <= 2, true, 'each step was sent once');
    assert.equal(stored(x, id).steps[0].status, 'verified', 'the read-back caught up: ' + show(x, id));
  } finally {
    x.store.close();
  }
});

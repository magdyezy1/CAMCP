import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {googleWorld} from '../dist/tests/helpers/google-write-fake.js';
import {MirrorError} from '../dist/src/errors.js';
import {createPlan, on} from './helpers/google-policy-failure.mjs';
import {keywordWorld} from './helpers/google-keyword-group.mjs';
import {
  T,
  amendment,
  budgets,
  claimState,
  door,
  executeNext,
  gateTransport,
  holdTargetLock,
  planned,
  plannedSteps,
  show,
  step,
  stored,
  tick,
  withEnv,
} from './helpers/plan-lifecycle-kit.mjs';

/**
 * r25-planmodel, the second round (the independent review of 451169fd): what an execute saves after it awaited the provider is applied only to the step it executed, in the
 * state it left it in. The probes are the reviewer's: each is a call that ends while another call has moved the same step on, and each left the plan in a state no call
 * named (M1: a step without a review, a verified step taken back, a complete plan's step ready again; M4: two steps settled and the plan still live; M7: the put-back of a
 * retired review undoing a live execute of the amended one).
 */

/**
 * The call that fails a step another call is executing: a second execute of the same review that takes the target (the first call waits for it) and sends the write, which the
 * provider refuses, so the step reads failed. A flag of its own that the review does not take is no longer this: a second call's own refusal saves nothing (N2, third round).
 */
const failing = async (x, id, review) => {
  x.hooks.writeReply = () => ({
    status: 400,
    body: {error: {code: 400, status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.'}},
  });
  try {
    return await executeNext(x, id, review);
  } finally {
    x.hooks.writeReply = undefined;
  }
};
const amend = (x, id) =>
  x.call('amcp_campaign', {action: 'recover_step', id, step_id: 'step1', confirmed: true, patch: amendment});

test('M1 (S1): an execute that ends STATE_BUSY does not put its outcome on a step another call amended: the step keeps what recover_step left, and the plan goes on', async () => {
  await withEnv('AMCP_WRITE_TARGET_WAIT_MS', '800', async () => {
    const {x, id, review} = await planned(budgets(2));
    try {
      const lock = holdTargetLock(x, {only: true}),
        a = executeNext(x, id, review);
      await lock.waiting();
      // Another call sends the step and the provider refuses it, and the person amends it: the step holds no review until it is prepared again.
      const refused = await failing(x, id, review);
      assert.equal(stored(x, id).steps[0].status, 'failed', JSON.stringify(refused).slice(0, 300));
      const amended = await amend(x, id);
      assert.equal(amended.success, true, JSON.stringify(amended).slice(0, 300));
      const before = stored(x, id).steps[0];
      assert.equal(before.status, 'pending');
      assert.equal(before.review, undefined);
      // A's wait for its target ends: it is refused as busy, and that is not the outcome of the step as it is now.
      await a;
      lock.release();
      const after = stored(x, id).steps[0];
      assert.equal(after.status, 'pending', 'the amended step is as recover_step left it: ' + show(x, id));
      assert.equal(after.review, undefined);
      assert.equal(after.review_id, undefined);
      // The plan goes on: prepare_next prepares the amended step, and executing it settles the plan.
      const prepared = await x.call('amcp_campaign', {action: 'prepare_next', id});
      assert.equal(prepared.success, true, JSON.stringify(prepared.error ?? prepared).slice(0, 300));
      const second = stored(x, id).steps[0].review_id;
      assert.notEqual(second, review);
      assert.equal((await executeNext(x, id, second)).success, true);
      assert.equal(show(x, id), 'complete [step1=verified]');
      assert.equal(x.writes(), 2, 'the refused write, and the amended one');
    } finally {
      x.store.close();
    }
  });
});

test('M1 (S2): an execute that ends STATE_BUSY does not take the amended step, sent and verified meanwhile, back to review_ready in a complete plan', async () => {
  await withEnv('AMCP_WRITE_TARGET_WAIT_MS', '3000', async () => {
    const {x, id, review} = await planned(budgets(2));
    try {
      const lock = holdTargetLock(x, {only: true}),
        a = executeNext(x, id, review);
      await lock.waiting();
      await failing(x, id, review);
      assert.equal((await amend(x, id)).success, true);
      assert.equal((await x.call('amcp_campaign', {action: 'prepare_next', id})).success, true);
      const second = stored(x, id).steps[0].review_id,
        done = await executeNext(x, id, second);
      assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 300));
      assert.equal(show(x, id), 'complete [step1=verified]');
      assert.equal(x.writes(), 2, 'the refused write, and the amended one');
      const ended = await a;
      lock.release();
      assert.equal(
        show(x, id),
        'complete [step1=verified]',
        'the verified step stays verified, and the plan complete (the execute ended: ' +
          JSON.stringify(ended.error ?? ended.data?.current ?? '').slice(0, 200) +
          ')',
      );
      assert.equal(x.writes(), 2, 'nothing was sent again');
    } finally {
      x.store.close();
    }
  });
});

test('M1 (S3): a read-back that lags behind another call’s settled step does not take the step back to verifying, in a plan whose next step has run', async () => {
  const {x, id, review} = await plannedSteps(2, {depends: true}),
    transport = x.service.transport,
    real = transport.fetcher,
    als = new AsyncLocalStorage(),
    lag = door();
  try {
    let afterWrite = false,
      came = false;
    // Every read call A makes after the write is answered late, and empty: the provider has not caught up.
    transport.fetcher = async (url, init) => {
      const isRead = String(url).endsWith('googleAds:search');
      if (isRead && afterWrite && als.getStore() === 'A') {
        came = true;
        await lag.p;
        return Response.json({results: []});
      }
      const out = await real(url, init);
      if (!isRead && !JSON.parse(String(init?.body ?? '{}')).validateOnly) afterWrite = true;
      return out;
    };
    const a = als.run('A', () => executeNext(x, id, review));
    for (let i = 0; i < 1000 && !came; i++) await tick(10);
    assert.ok(came, 'A came to its read-back');
    assert.equal(claimState(x, review), 'complete');
    // Another call executes the same review (the resume of a step a client was told to resume): the receipt is replayed and the step settles.
    const second = await executeNext(x, id, review);
    assert.equal(second.success, true, JSON.stringify(second.error ?? second).slice(0, 300));
    assert.equal(stored(x, id).steps[0].status, 'verified');
    assert.equal((await x.call('amcp_campaign', {action: 'prepare_next', id})).success, true);
    const next = await executeNext(x, id, stored(x, id).steps[1].review_id);
    assert.equal(next.success, true, JSON.stringify(next.error ?? next).slice(0, 300));
    assert.equal(show(x, id), 'complete [s1=verified s2=verified]');
    // A's read-back ends, still empty.
    lag.open();
    await a;
    assert.equal(show(x, id), 'complete [s1=verified s2=verified]', 'the step another call settled stays settled');
    assert.equal(x.writes(), 2, 'each step was sent once');
  } finally {
    lag.open();
    x.store.close();
  }
});

test('M1: an outcome that applied the write removes an error another call left on the step, and the plan is as complete as its steps', async () => {
  const {x, id, review} = await planned(budgets(2)),
    gate = gateTransport(x),
    written = door();
  try {
    gate.rules = [{kind: 'write', nth: 1, hold: written.p, when: 'after'}];
    const a = executeNext(x, id, review);
    await gate.arrived();
    assert.equal(claimState(x, review), 'pending');
    // What a call refused as uncertain over the claim in flight saved meanwhile: the step uncertain, with the refusal on it.
    const {id: _id, revision, ...data} = stored(x, id);
    data.steps[0].status = 'uncertain';
    data.steps[0].error = {code: 'WRITE_OUTCOME_UNCERTAIN', message: 'This review was already submitted.'};
    data.state = 'attention';
    x.store.putDocument(T, 'campaign_run', id, data, revision);
    written.open();
    await a;
    const plan = stored(x, id);
    assert.equal(plan.steps[0].status, 'verified');
    assert.equal(plan.steps[0].error, undefined, 'a verified step carries no error');
    assert.equal(plan.state, 'complete');
    assert.equal(x.writes(), 1);
  } finally {
    written.open();
    x.store.close();
  }
});

test('M4 (P6): two steps that settle at once leave the plan as complete as its steps: archive works', async () => {
  const {x, id, review: first} = await plannedSteps(2);
  try {
    assert.equal((await executeNext(x, id, first)).success, true);
    assert.equal((await x.call('amcp_campaign', {action: 'prepare_next', id})).success, true);
    const second = stored(x, id).steps[1].review_id;
    // The first step's read-back disagreed (it is a mismatch, as the runner saves it); the second executes while a person's reconcile settles the first.
    const {id: _id, revision, ...data} = stored(x, id);
    data.steps[0].status = 'mismatch';
    data.state = 'attention';
    x.store.putDocument(T, 'campaign_run', id, data, revision);
    const gate = gateTransport(x),
      written = door();
    gate.rules = [{kind: 'write', nth: 1, hold: written.p, when: 'after'}];
    const a = executeNext(x, id, second);
    await gate.arrived();
    const reconciled = await x.call('amcp_campaign', {action: 'reconcile_step', id, step_id: 's1'});
    assert.equal(reconciled.success, true, JSON.stringify(reconciled.error ?? reconciled).slice(0, 300));
    assert.equal(stored(x, id).steps[0].status, 'verified');
    assert.equal(stored(x, id).steps[1].status, 'executing');
    written.open();
    const done = await a;
    assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 300));
    assert.equal(show(x, id), 'complete [s1=verified s2=verified]');
    assert.equal((await x.call('amcp_campaign', {action: 'archive', id, confirmed: true})).success, true);
    assert.equal(x.writes(), 2);
  } finally {
    x.store.close();
  }
});

test('M5 (P4): a person unassigned while their write is in flight has its outcome saved: the step settles, and the owner’s reads name no call to resume it', async () => {
  const x = googleWorld({policy: on, world: keywordWorld()}),
    gate = gateTransport(x),
    written = door();
  try {
    for (const user of ['operator', 'editor2'])
      x.store.db
        .prepare('INSERT OR IGNORE INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,?,?)')
        .run(T, user, 'operator', Date.now());
    const id = await createPlan(x, [step(budgets(2))]);
    assert.equal(
      (await x.call('amcp_campaign', {action: 'assign', id, user_id: 'editor2', role: 'editor'})).success,
      true,
    );
    const editor = {tenantId: T, userId: 'editor2', role: 'operator'},
      as = (tool, input) => x.service.call(tool, input, editor);
    assert.equal((await as('amcp_campaign', {action: 'prepare_next', id})).success, true);
    const review = stored(x, id).steps[0].review_id;
    gate.rules = [{kind: 'write', nth: 1, hold: written.p, when: 'after'}];
    const a = as('amcp_campaign', {
      action: 'execute_next',
      id,
      review_id: review,
      idempotency_key: review,
      confirmed: true,
      spend_change_confirmed: true,
    });
    await gate.arrived();
    // The owner takes the editor off the plan while the editor's write is going out.
    assert.equal((await x.call('amcp_campaign', {action: 'unassign', id, user_id: 'editor2'})).success, true);
    written.open();
    const ended = await a;
    // The editor is shown nothing of a plan they are no longer on; the write was applied, and the plan knows it.
    assert.equal(ended.error?.code, 'FORBIDDEN', JSON.stringify(ended).slice(0, 300));
    assert.equal(claimState(x, review), 'complete');
    assert.equal(x.writes(), 1);
    assert.equal(stored(x, id).steps[0].status, 'verified', 'the step is not left executing: ' + show(x, id));
    assert.equal(stored(x, id).state, 'complete');
    const got = await x.call('amcp_campaign', {action: 'get', id});
    assert.equal(got.data.next_call, undefined);
  } finally {
    written.open();
    x.store.close();
  }
});

test('M5 (the person is deactivated right after the write): the outcome is saved before the refusal: the step reads verifying, the plan reads it again, and nothing is sent twice', async () => {
  const {x, id, review} = await planned(budgets(2)),
    check = x.store.assertActorActive.bind(x.store);
  try {
    let fired = false;
    // The runner's own check after the nested execute (the first check once the claim is complete) finds the person deactivated.
    x.store.assertActorActive = actor => {
      const caller = new Error().stack.split('\n').slice(2, 3).join('');
      if (!fired && /executeNext/.test(caller)) {
        fired = true;
        throw new MirrorError('ACTOR_INACTIVE', 'This person is no longer active.', {}, 403);
      }
      return check(actor);
    };
    const ended = await executeNext(x, id, review);
    x.store.assertActorActive = check;
    assert.ok(fired, 'the check came after the write');
    assert.equal(ended.error?.code, 'ACTOR_INACTIVE', JSON.stringify(ended).slice(0, 300));
    assert.equal(claimState(x, review), 'complete');
    assert.equal(x.writes(), 1);
    const step = stored(x, id).steps[0];
    assert.equal(step.status, 'verifying', 'the step is not left executing: ' + show(x, id));
    assert.ok(step.result, 'the receipt is on the step');
    // The next call of the plan reads it back (no request on the deactivated person's connection was made for it), and settles it, with no second write.
    const read = await x.call('amcp_campaign', {action: 'prepare_next', id});
    assert.equal(read.success, true, JSON.stringify(read.error ?? read).slice(0, 300));
    assert.equal(show(x, id), 'complete [step1=verified]');
    assert.equal(x.writes(), 1);
  } finally {
    x.store.assertActorActive = check;
    x.store.close();
  }
});

test('M7 (S6): the put-back of an execute refused as retired does not undo a live execute of the amended review', async () => {
  await withEnv('AMCP_WRITE_TARGET_WAIT_MS', '4000', async () => {
    const {x, id, review} = await planned(budgets(2)),
      lock = holdTargetLock(x, {only: true}),
      read = door();
    try {
      const a = executeNext(x, id, review);
      await lock.waiting();
      await failing(x, id, review);
      assert.equal((await amend(x, id)).success, true);
      assert.equal((await x.call('amcp_campaign', {action: 'prepare_next', id})).success, true);
      const second = stored(x, id).steps[0].review_id;
      assert.notEqual(second, review);
      // The amended review is executed, and held at its read-back: it is executing, its claim complete.
      const transport = x.service.transport,
        real = transport.fetcher;
      let afterWrite = false,
        came = false;
      transport.fetcher = async (url, init) => {
        const isRead = String(url).endsWith('googleAds:search');
        if (isRead && afterWrite && !came) {
          came = true;
          await read.p;
        }
        const out = await real(url, init);
        if (!isRead && !JSON.parse(String(init?.body ?? '{}')).validateOnly) afterWrite = true;
        return out;
      };
      const c = executeNext(x, id, second);
      for (let i = 0; i < 1000 && !came; i++) await tick(10);
      assert.ok(came, 'the amended review came to its read-back');
      assert.equal(show(x, id), 'in_progress [step1=executing]');
      // Call A's wait for the retired review ends: it is refused (retired or busy), and that is nothing to put back on a step that is executing another review.
      lock.release();
      await a;
      assert.equal(
        show(x, id),
        'in_progress [step1=executing]',
        'the live execute of the amended review is not undone by the refusal of the retired one',
      );
      read.open();
      assert.equal((await c).success, true);
      assert.equal(show(x, id), 'complete [step1=verified]');
      assert.equal(x.writes(), 2, 'the refused write, and the amended one');
    } finally {
      read.open();
      x.store.close();
    }
  });
});

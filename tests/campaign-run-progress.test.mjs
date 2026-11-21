import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {assertRefused} from './helpers/assert-refused.mjs';
import {amend, approve, fixture, writes} from './helpers/campaign-run-fixture.mjs';

/**
 * R2.5 field3, package r25-field3-approvals, AMCP-12 (the owner's second Google report of 2026-11-21): `run` stopped on its 25 s budget with no
 * count of what was left, and a step started at 24 s ran past the budget (the owner saw 41 and 58 seconds). Every stop of a run now carries
 * `progress` (how many steps are settled and left, how long this call has run, and, once a step has a recorded time, an estimate labelled as one),
 * and the budget is checked before each step against the median time of the plan's steps, only between steps, so a stop never lands between
 * a review and its execution. A step a call started is finished: nothing is left executing or claimed.
 *
 * The clock is pinned (node:test mock timers on Date) and the stand-in for the provider advances it by the time a step takes.
 */
const start = Date.UTC(2026, 10, 21, 12, 0, 0);
/** A clock pinned at `start` for the test `t`, given back when it ends; `take(ms)` makes ms pass, as a step does. */
function pinned(t) {
  mock.timers.enable({apis: ['Date'], now: start});
  t.after(() => mock.timers.reset());
  return ms => mock.timers.tick(ms);
}
const five = ['s1', 's2', 's3', 's4', 's5'];
/** The idempotency claims of a store: every key with its state. */
const claims = f => f.store.db.prepare('SELECT key, state FROM idempotency ORDER BY rowid').all();
const unsettledMidStep = plan => plan.steps.filter(s => ['executing', 'verifying'].includes(s.status));

test('a plan of five 8-second steps: the first call runs three and stops with time before a fourth that would overrun, with its progress', async t => {
  const take = pinned(t),
    f = fixture({hooks: {execute: () => take(8000)}});
  try {
    const id = await f.plan(five);
    await approve(f, id);
    const first = await f.alice({action: 'run', id});
    assert.equal(first.run.stopped, 'time');
    assert.deepEqual(first.run.executed, ['s1', 's2', 's3'], 'the budget check keeps the fourth from starting');
    // The stop is before a prepare, never between a prepare and its execute (lead review S4-1): the fourth step was not prepared, so it holds no
    // review that could expire between two calls, and the claims below are all the plan has.
    assert.deepEqual(f.state.prepares, ['s1', 's2', 's3'], 'the fourth step was not prepared');
    assert.equal(f.stored(id).steps.find(s => s.id === 's4').status, 'pending', 'and holds no review');
    assert.deepEqual(first.run.progress, {
      steps_total: 5,
      settled: 3,
      remaining: 2,
      executed_this_call: 3,
      elapsed_ms: 24000,
      budget_ms: 25000,
      estimate: {kind: 'estimate', seconds: 16, basis: 'median of 3 steps of this plan', not_a_promise: true},
    });
    assert.ok(first.run.progress.elapsed_ms <= 25000 + 8000, 'never more than one step over the budget');
    assert.deepEqual(first.run.next_call, {tool: 'amcp_campaign', arguments: {action: 'run', id}});
    // Nothing is left half done: no step executing, and every claim made is a completed one.
    assert.deepEqual(unsettledMidStep(f.stored(id)), []);
    assert.deepEqual(
      claims(f).map(c => c.state),
      ['complete', 'complete', 'complete'],
    );
    assert.deepEqual(writes(f), ['s1', 's2', 's3']);
    // The next run continues where this stopped: two steps, one prepare and one claim each, and the plan completes.
    const second = await f.alice({action: 'run', id});
    assert.equal(second.run.stopped, 'complete', JSON.stringify(second.run));
    assert.deepEqual(second.run.executed, ['s4', 's5']);
    assert.deepEqual(second.run.progress, {
      steps_total: 5,
      settled: 5,
      remaining: 0,
      executed_this_call: 2,
      elapsed_ms: 16000,
      budget_ms: 25000,
    });
    assert.deepEqual(writes(f), five, 'every step was sent once');
    assert.deepEqual(f.state.prepares, five, 'and prepared once');
    assert.equal(claims(f).length, 5);
    assert.ok(claims(f).every(c => c.state === 'complete'));
  } finally {
    f.store.close();
  }
});

test('the time a step took is recorded where its native requests are metered: its prepare, its execute and its read-back', async t => {
  const take = pinned(t),
    f = fixture({hooks: {prepare: () => take(1000), execute: () => take(5000), verify: () => take(2000)}});
  try {
    const id = await f.plan(['one', 'two']);
    await approve(f, id);
    const ran = await f.alice({action: 'run', id});
    assert.equal(ran.run.stopped, 'complete');
    for (const step of f.stored(id).steps) {
      assert.deepEqual(step.timing_ms, {prepare: 1000, execute: 5000, verify: 2000}, step.id);
      assert.ok(step.native_requests, 'the requests it made are still recorded beside it');
    }
    // The estimate is the median of what each step took in all: 8 seconds.
    assert.equal(ran.run.progress.executed_this_call, 2);
  } finally {
    f.store.close();
  }
});

test('the estimate is absent while no step of the plan has a recorded time, and every stop still counts what is settled and left', async t => {
  pinned(t);
  const f = fixture({
    effects: new Map([['s1', true]]),
    needs: {s1: {spend_change_confirmed: true}},
  });
  try {
    const id = await f.plan(five);
    // Approved without the spend flag: the first step spends, so the run stops at once, before any step ran.
    await approve(f, id, {flag: false});
    const ran = await f.alice({action: 'run', id});
    assert.equal(ran.run.stopped, 'needs_spend_change_confirmed');
    assert.deepEqual(ran.run.executed, []);
    assert.deepEqual(ran.run.progress, {
      steps_total: 5,
      settled: 0,
      remaining: 5,
      executed_this_call: 0,
      elapsed_ms: 0,
      budget_ms: 25000,
    });
    assert.equal(ran.run.progress.estimate, undefined);
    // The one step the run prepared has its prepare time and nothing else, and a step that has not settled is not a whole pass: it counts for
    // no estimate, so none is invented for a plan whose steps have not run.
    const [prepared, ...rest] = f.stored(id).steps;
    assert.deepEqual(prepared.timing_ms, {prepare: 0});
    assert.equal(prepared.status, 'review_ready');
    assert.equal(
      rest.some(s => s.timing_ms),
      false,
    );
  } finally {
    f.store.close();
  }
});

test('a spend step the approval does not cover still stops needs_spend_change_confirmed after a step ran, with its progress', async t => {
  const take = pinned(t),
    f = fixture({
      effects: new Map([['s2', true]]),
      needs: {s2: {spend_change_confirmed: true}},
      hooks: {execute: () => take(3000)},
    });
  try {
    const id = await f.plan(five);
    await approve(f, id, {flag: false});
    const ran = await f.alice({action: 'run', id});
    assert.equal(ran.run.stopped, 'needs_spend_change_confirmed');
    assert.deepEqual(ran.run.executed, ['s1']);
    assert.equal(ran.run.progress.settled, 1);
    assert.equal(ran.run.progress.remaining, 4);
    assert.equal(ran.run.progress.estimate.kind, 'estimate');
    assert.equal(ran.run.progress.estimate.seconds, 12, 'four steps of 3 seconds');
    assert.deepEqual(
      f.state.attempts.map(a => a.marker),
      ['s1'],
      'the spend step was never tried without its flag',
    );
    assert.deepEqual(writes(f), ['s1']);
  } finally {
    f.store.close();
  }
});

test('the budget is only checked between steps: a first step longer than the whole budget is finished, and the next call still makes progress', async t => {
  const take = pinned(t),
    f = fixture({hooks: {prepare: () => take(20000), execute: () => take(15000)}});
  try {
    const id = await f.plan(['one', 'two', 'three']);
    await approve(f, id);
    const first = await f.alice({action: 'run', id});
    // A step started at 0 ran for 35 seconds: it was prepared and executed whole, not stopped between the two.
    assert.equal(first.run.stopped, 'time');
    assert.deepEqual(first.run.executed, ['one']);
    assert.deepEqual(unsettledMidStep(f.stored(id)), []);
    assert.deepEqual(
      f.stored(id).steps.map(s => s.status),
      ['verified', 'pending', 'pending'],
    );
    assert.deepEqual(
      claims(f).map(c => c.state),
      ['complete'],
    );
    // The median step now takes longer than the budget, yet every call makes progress: a call always tries its first step.
    const second = await f.alice({action: 'run', id});
    assert.deepEqual(second.run.executed, ['two'], 'a step per call at least, never a stop with nothing done');
    assert.equal(second.run.stopped, 'time');
    const third = await f.alice({action: 'run', id});
    assert.equal(third.run.stopped, 'complete');
    assert.deepEqual(writes(f), ['one', 'two', 'three']);
  } finally {
    f.store.close();
  }
});

test('a time stop leaves a review that was ready: the next run executes that same review, with no second prepare and no second claim', async t => {
  const take = pinned(t),
    f = fixture({hooks: {execute: () => take(8000)}});
  try {
    const id = await f.plan(five);
    await approve(f, id);
    const first = await f.alice({action: 'run', id});
    assert.equal(first.run.stopped, 'time');
    // The person prepares the fourth step by hand before running again: its review is ready.
    const prepared = await f.alice({action: 'prepare_next', id});
    assert.equal(prepared.step_id, 's4');
    const reviewId = prepared.review.review_id;
    assert.deepEqual(f.state.prepares, ['s1', 's2', 's3', 's4']);
    const second = await f.alice({action: 'run', id});
    assert.equal(second.run.stopped, 'complete', JSON.stringify(second.run));
    assert.deepEqual(f.state.prepares, five, 's4 was not prepared again, s5 once');
    assert.equal(f.stored(id).steps[3].review_id, reviewId, 'the review that was ready is the one executed');
    assert.equal(claims(f).length, 5, 'one claim for each step');
    assert.ok(claims(f).every(c => c.state === 'complete'));
    assert.deepEqual(writes(f), five);
  } finally {
    f.store.close();
  }
});

test('an approval revoked between two calls gives APPROVAL_REQUIRED on the next run, which sends nothing', async t => {
  const take = pinned(t),
    f = fixture({hooks: {execute: () => take(8000)}});
  try {
    const id = await f.plan(five);
    await approve(f, id);
    const first = await f.alice({action: 'run', id});
    assert.equal(first.run.stopped, 'time');
    // The plan is amended (a step amended in place changes its hash, and the approval was of the old plan).
    await amend(f, id, 's5', 'amended');
    await assert.rejects(
      () => f.alice({action: 'run', id}),
      e => assertRefused(e, 'APPROVAL_REQUIRED'),
    );
    assert.deepEqual(writes(f), ['s1', 's2', 's3'], 'nothing more was sent');
  } finally {
    f.store.close();
  }
});

test('an approval older than a day is not stretched by a run that keeps being resumed: the next run after it is refused', async t => {
  const take = pinned(t),
    f = fixture({hooks: {execute: () => take(8000)}});
  try {
    const id = await f.plan(five);
    await approve(f, id);
    assert.equal((await f.alice({action: 'run', id})).run.stopped, 'time');
    take(24 * 3600 * 1000 + 1);
    await assert.rejects(
      () => f.alice({action: 'run', id}),
      e => assertRefused(e, 'APPROVAL_REQUIRED'),
    );
    assert.deepEqual(writes(f), ['s1', 's2', 's3']);
  } finally {
    f.store.close();
  }
});

test('progress stays under 300 bytes on the largest plan, at every stop', async t => {
  const take = pinned(t),
    ids = Array.from({length: 50}, (_, i) => 'step_' + String(i + 1).padStart(2, '0')),
    f = fixture({hooks: {execute: () => take(8000)}});
  try {
    const id = await f.plan(ids);
    await approve(f, id);
    const first = await f.alice({action: 'run', id});
    assert.equal(first.run.stopped, 'time');
    const bytes = Buffer.byteLength(JSON.stringify(first.run.progress));
    assert.ok(bytes < 300, 'progress is ' + bytes + ' bytes');
    assert.equal(first.run.progress.steps_total, 50);
    assert.equal(first.run.progress.settled + first.run.progress.remaining, 50);
    assert.deepEqual(Object.keys(first.run.progress).sort(), [
      'budget_ms',
      'elapsed_ms',
      'estimate',
      'executed_this_call',
      'remaining',
      'settled',
      'steps_total',
    ]);
  } finally {
    f.store.close();
  }
});

test('every field a run answered before is still there beside progress', async t => {
  const take = pinned(t),
    f = fixture({hooks: {execute: () => take(8000)}});
  try {
    const id = await f.plan(five);
    await approve(f, id);
    const first = await f.alice({action: 'run', id});
    // The website reads run.stopped, run.executed and run.next_call, and the compact plan view around them.
    assert.deepEqual(Object.keys(first.run).sort(), ['executed', 'next_call', 'progress', 'stopped']);
    assert.equal(first.view, 'compact');
    assert.equal(first.id, id);
    assert.deepEqual(
      first.steps.map(s => [s.id, s.status]),
      [
        ['s1', 'verified'],
        ['s2', 'verified'],
        ['s3', 'verified'],
        ['s4', 'pending'],
        ['s5', 'pending'],
      ],
    );
  } finally {
    f.store.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {googleWorld} from '../dist/tests/helpers/google-write-fake.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {
  action,
  createPlan,
  expectedRow,
  failure,
  on,
  planStep,
  rejecting,
  signals,
  theme,
  world,
} from './helpers/google-policy-failure.mjs';

/**
 * r25-field3-errors (M5-a, the owner's report of 2026-11-21): a plan step whose review the provider rejected when it validated it at prepare
 * was still named `review_ready`, with `execute_next` as its next call, and `run` went on to execute it: the execute was refused
 * (PROVIDER_VALIDATION_FAILED, with two field paths), the step ended failed, and the error was poorer than the prepare's. The step now stops at
 * prepare: failed and unsent, with the rows the provider named, and the call it names is the step's correction. Synthetic customer 123.
 */
const prepareNext = (x, id) => x.call('amcp_campaign', {action: 'prepare_next', id});
/** The approval of a plan: the summary, then the call that records it, with the flags the summary offers (the person approving). */
async function approve(x, id) {
  const summary = (await x.call('amcp_campaign', {action: 'approve', id})).data,
    approved = await x.call('amcp_campaign', {
      ...summary.next_call.arguments,
      ...(summary.next_call.add_after_user_approval ?? {}),
    });
  assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 600));
}
const stored = (x, id) => x.store.document('google-world', 'campaign_run', id);

test('prepare_next stops a step the provider rejected at validate-only: failed and unsent, the rows, the correction, and no execute anywhere', async () => {
  const x = rejecting();
  try {
    const id = await createPlan(x, [planStep()]),
      out = await prepareNext(x, id);
    assert.equal(out.success, true, JSON.stringify(out).slice(0, 800));
    const d = out.data;
    assert.equal(d.blocked, true);
    assert.equal(d.state, 'attention');
    assert.equal(d.steps[0].status, 'failed');
    assert.equal(d.steps[0].error, 'PROVIDER_VALIDATION_FAILED');
    assert.equal(d.review, undefined, 'no review is offered: a run stops here, as at any step whose prepare failed');
    const step = stored(x, id).steps[0];
    assert.equal(d.current.step_id, 'signals');
    assert.equal(d.current.status, 'failed');
    assert.equal(d.current.submission, 'not_submitted');
    assert.equal(d.current.review_id, step.review_id, 'the review id stays on the step');
    assert.equal(d.current.error.code, 'PROVIDER_VALIDATION_FAILED');
    assert.deepEqual(d.current.error.details.provider_errors, [expectedRow]);
    assert.equal(d.current.error.details.provider_message, 'The search theme violates a policy.');
    assert.equal(d.current.error.details.review_id, step.review_id);
    assert.equal(d.next_call.arguments.action, 'recover_step');
    assert.equal(d.next_call.arguments.step_id, 'signals');
    assert.ok(
      !JSON.stringify(out).includes('execute_next'),
      'no execute_next in the answer: ' + JSON.stringify(d.next_call),
    );
    // The stored step keeps its review without the provider's whole answer, and nothing was claimed or sent but the validate-only request.
    assert.equal(step.status, 'failed');
    assert.equal(step.submission, 'not_submitted');
    assert.equal(step.review.provider_check.status, 'provider_rejected');
    assert.equal(step.review.provider_check.response, undefined);
    assert.equal(step.error.code, 'PROVIDER_VALIDATION_FAILED');
    assert.equal(x.validations(), 1);
    assert.equal(x.writes(), 0);
    assert.equal(x.store.db.prepare('SELECT count(*) AS n FROM idempotency').get().n, 0);
    // The step's journal says why nothing was claimed, where it said "Legacy phase unknown".
    const got = (await x.call('amcp_campaign', {action: 'get', id, step_id: 'signals'})).data;
    assert.equal(got.execution_journal[0].phase, 'validation_rejected');
    assert.equal(got.execution_journal[0].provider_errors[0].policy.name, 'HEALTH_IN_PERSONALIZED_ADS');
  } finally {
    x.store.close();
  }
});

test('run stops at a step the provider rejected as needs_attention: nothing is executed and only the validate-only request is sent', async () => {
  const x = rejecting();
  try {
    const id = await createPlan(x, [planStep()]);
    await approve(x, id);
    const out = await x.call('amcp_campaign', {action: 'run', id});
    assert.equal(out.success, true, JSON.stringify(out).slice(0, 800));
    assert.equal(out.data.run.stopped, 'needs_attention');
    assert.deepEqual(out.data.run.executed, []);
    assert.equal(out.data.next_call.arguments.action, 'recover_step');
    assert.ok(!JSON.stringify(out).includes('execute_next'));
    assert.equal(x.validations(), 1);
    assert.equal(x.writes(), 0);
  } finally {
    x.store.close();
  }
});

test('the old review of a stopped step is still not executed: a replayed execute_next is answered with the correction and a direct execute is refused, and nothing is sent', async () => {
  const x = rejecting();
  try {
    const id = await createPlan(x, [planStep()]);
    await prepareNext(x, id);
    const review = stored(x, id).steps[0].review_id,
      // An agent that kept the review id of the earlier prepare and replays the call that used to follow it: the step is failed, so the
      // answer is the blocked view with the step's correction, as for any failed step.
      replay = await x.call('amcp_campaign', {
        action: 'execute_next',
        id,
        review_id: review,
        idempotency_key: review,
        confirmed: true,
      });
    assert.equal(replay.data.blocked, true, JSON.stringify(replay).slice(0, 400));
    assert.equal(replay.data.next_call.arguments.action, 'recover_step');
    assert.equal(replay.data.steps[0].status, 'failed');
    // The review itself is refused where it always was.
    assertRefused(await x.execute({data: {review_id: review}}), 'PROVIDER_VALIDATION_FAILED', {writes: x.writes});
    assert.equal(x.writes(), 0);
    assert.equal(x.store.db.prepare('SELECT count(*) AS n FROM idempotency').get().n, 0);
  } finally {
    x.store.close();
  }
});
test('after recover_step with a corrected request the step is prepared again, no repeat of an uncertain create holds it, and the plan’s approval rule is as it was', async () => {
  const x = rejecting();
  try {
    const id = await createPlan(x, [planStep()]);
    await approve(x, id);
    const stopped = await x.call('amcp_campaign', {action: 'run', id}),
      oldReview = stored(x, id).steps[0].review_id;
    assert.equal(stopped.data.run.stopped, 'needs_attention');
    // The provider accepts the corrected theme.
    x.hooks.validationReply = () => undefined;
    const recovered = await x.call('amcp_campaign', {
      ...stopped.data.next_call.arguments,
      patch: [{path: '/payload/operations/0/create/search_theme/text', value: 'orthodontics'}],
    });
    assert.equal(recovered.success, true, JSON.stringify(recovered).slice(0, 600));
    // The approval rule is unchanged (AMCP-09 is not applied here): the amendment voids the plan's approval, as it always did.
    assertRefused(await x.call('amcp_campaign', {action: 'run', id}), 'APPROVAL_REQUIRED', {writes: x.writes});
    const prepared = await prepareNext(x, id);
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 600));
    assert.notEqual(prepared.data.review.review_id, oldReview, 'a new review');
    assert.equal(prepared.data.review.provider_check.status, 'provider_validated');
    assert.equal(prepared.data.next_call.arguments.action, 'execute_next');
    // The earlier prepare's review id, replayed now that the step holds a new review, is refused and nothing is sent.
    assertRefused(
      await x.call('amcp_campaign', {
        action: 'execute_next',
        id,
        review_id: oldReview,
        idempotency_key: oldReview,
        confirmed: true,
      }),
      'INVALID_ARGUMENT',
      {writes: x.writes},
    );
    await approve(x, id);
    // The corrected step is executed once (the fake serves no read-back of a search theme, so the step's own verification is not asserted).
    const done = await x.call('amcp_campaign', {action: 'run', id});
    assert.deepEqual(done.data.run.executed, ['signals'], JSON.stringify(done.data.run));
    assert.equal(x.writes(), 1);
  } finally {
    x.store.close();
  }
});

test('a check that could not run still gives a ready review and the execute_next that follows it', async () => {
  const x = googleWorld({policy: on, world: world(), validation: 'rate_limit'});
  try {
    const id = await createPlan(x, [planStep()]),
      out = await prepareNext(x, id);
    assert.equal(out.success, true, JSON.stringify(out).slice(0, 800));
    assert.equal(out.data.blocked, undefined);
    assert.equal(out.data.review.provider_check.status, 'not_run');
    assert.equal(out.data.next_call.arguments.action, 'execute_next');
    assert.equal(stored(x, id).steps[0].status, 'review_ready');
  } finally {
    x.store.close();
  }
});

test('a step stored ready with a rejected check, prepared before this release, is stopped the same way from the stored check', async () => {
  const x = googleWorld({policy: on, world: world()});
  try {
    const id = await createPlan(x, [planStep()]),
      ready = await prepareNext(x, id);
    assert.equal(ready.data.next_call.arguments.action, 'execute_next');
    // A plan saved by an earlier release: the step's review carries a rejected check and the provider's whole answer.
    const {id: _id, revision, ...run} = stored(x, id);
    run.steps[0].review.provider_check = {
      status: 'provider_rejected',
      checked_at: Date.now(),
      default: true,
      field_paths: ['operations[0].create.search_theme.text'],
      http_status: 400,
      provider_errors: [expectedRow],
      response: failure(),
    };
    x.store.putDocument('google-world', 'campaign_run', id, run, revision);
    const out = await prepareNext(x, id);
    assert.equal(out.success, true, JSON.stringify(out).slice(0, 800));
    assert.equal(out.data.blocked, true);
    assert.equal(out.data.steps[0].status, 'failed');
    assert.equal(out.data.review, undefined);
    assert.deepEqual(out.data.current.error.details.provider_errors, [expectedRow]);
    assert.equal(out.data.next_call.arguments.action, 'recover_step');
    assert.ok(!JSON.stringify(out).includes('execute_next'));
    assert.equal(stored(x, id).steps[0].review.provider_check.response, undefined);
    assert.equal(x.writes(), 0);
  } finally {
    x.store.close();
  }
});

test('a request of 30 operations whose second part the provider rejects is refused at prepare with the operation of the whole list, and no group is stored', async () => {
  const x = googleWorld({policy: on, world: world(), validation: 'custom'}),
    operations = Array.from({length: 30}, (_, i) => signals('synthetic theme ' + i)[0]);
  try {
    // The 28th operation is the third of the second part: the provider names it by its place in that part (operations[2]).
    operations[27] = signals(theme)[0];
    x.hooks.validationReply = body => {
      const at = body.operations.findIndex(o => o.create.search_theme.text === theme);
      return at < 0 ? undefined : failure({index: at});
    };
    const refused = await x.prepare(action, operations);
    assertRefused(refused, 'PROVIDER_VALIDATION_FAILED', {writes: x.writes});
    const details = refused.error.details;
    assert.equal(details.provider_errors[0].operation_index, 27);
    assert.equal(details.provider_errors[0].field_path, 'operations[27].create.search_theme.text');
    assert.deepEqual(details.field_paths, ['operations[27].create.search_theme.text']);
    assert.equal(x.validations(), 2, 'each part was validated');
    assert.equal(x.store.documents('google-world', 'write_review_group').length, 0, 'no group exists to execute');
    // When the provider accepts every part, the same request is a group, as it always was.
    x.hooks.validationReply = () => undefined;
    const group = await x.prepare(action, operations);
    assert.equal(group.data.group, true, JSON.stringify(group).slice(0, 400));
    assert.equal(group.data.parts.length, 2);
  } finally {
    x.store.close();
  }
});

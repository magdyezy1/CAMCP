import test from 'node:test';
import assert from 'node:assert/strict';
import {googleWorld} from '../dist/tests/helpers/google-write-fake.js';
import {savePlanPolicy} from '../dist/src/campaign-inventory.js';
import {createPlan, on, signals, world as themeWorld} from './helpers/google-policy-failure.mjs';
import {firstKeyword, keywordAction, keywordWorld, keywords, writesHolding} from './helpers/google-keyword-group.mjs';

/**
 * r25-field3-errors, the third re-review of 2026-11-22 (P4, S2): a plan's write group that stopped part-way could not be finished. Part 1 applied, then the
 * owner paused writes and part 2 was refused before it was claimed: the group stopped (its key claimed, never run again), the step was uncertain, and every
 * way on was closed. The stop's own next_call was part 2's execute, which the distinct-approver rule refuses for a part of a plan's group; execute_next stayed
 * blocked; prepare_next named amcp_write reconcile of the group, which is refused (each part is reconciled by its own review_id); and the status sentences
 * said that the plan resumes it, which it did not. Under the owner's policy nothing could send part 2 through the plan at all. While the review windows of the
 * parts not sent last, execute_next under the plan's current approval now sends only those parts (the applied ones replay and are never sent twice) and
 * completes the group; once they have ended, the step says so and what is left. Synthetic customer 123, 30 budgets (a group of two parts: 25 and 5).
 */
const T = 'google-world',
  budgetAction = 'campaign_budget_mutate_campaign_budgets',
  budgets = (n, label = 'P4 budget ') =>
    Array.from({length: n}, (_, i) => ({
      create: {name: label + i, amount_micros: '50000000', delivery_method: 'STANDARD'},
    })),
  step = (operations, action = budgetAction) => ({
    id: 'step1',
    kind: 'write',
    gateway: 'google_ads_native_action',
    connection_id: 'g',
    account_id: '123',
    description: 'step1',
    arguments: {action: 'google_ads_v23_' + action, payload: {operations}},
  }),
  owner = {tenantId: T, userId: 'owner', role: 'admin'},
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
  statusOf = async (x, id) => (await x.call('amcp_write', {action: 'status', review_id: id})).data,
  claimOf = (x, key) =>
    x.store.db.prepare('SELECT state FROM idempotency WHERE tenant_id=? AND key=?').get(T, key)?.state,
  holding = (x, text) => x.log.filter(r => r.kind === 'write' && JSON.stringify(r.body).includes(text)).length,
  pause = x =>
    x.store.putDocument(T, 'write_pause', 'workspace', {
      paused: true,
      scope: 'all',
      reason: 'synthetic pause',
      paused_by: 'owner',
      paused_at: Date.now(),
    }),
  unpause = x => x.store.repo('write_pause', T).delete('workspace');
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
 * A plan of 30 budgets (the policy on or off), approved by another person when the owner requires one, whose group stops after part 1: the owner pauses
 * writes once part 1 has been sent, so part 2 is refused before it is claimed. The pause is lifted at once: the cause is gone, the group is still stopped.
 */
async function stoppedPlan({policy, operations = budgets(30), action = budgetAction, world = keywordWorld()} = {}) {
  const x = googleWorld({policy: on, world});
  if (policy) savePlanPolicy(x.store, owner, {require_distinct_approver: true, confirmed: true});
  const id = await createPlan(x, [step(operations, action)]),
    prepared = await x.call('amcp_campaign', {action: 'prepare_next', id});
  assert.equal(prepared.success, true);
  const review = stored(x, id).steps[0].review_id,
    parts = x.store.document(T, 'write_review_group', review).parts;
  if (policy) await approveAs(x, id);
  let sent = 0;
  x.hooks.writeReply = () => {
    if (++sent === 1) pause(x);
    return undefined;
  };
  await executeNext(x, id, review);
  x.hooks.writeReply = undefined;
  unpause(x);
  return {x, id, review, parts, call: prepared.data.next_call};
}

for (const policy of [true, false])
  test(
    'P4: execute_next finishes a stopped plan group (the policy ' +
      (policy ? 'on, another person approved' : 'off') +
      '): part 2 is sent once, each record reaches the provider once',
    async () => {
      const {x, id, review, parts, call} = await stoppedPlan({policy});
      try {
        const s = stored(x, id).steps[0];
        assert.equal(s.status, 'uncertain');
        assert.equal(s.error.code, 'WRITE_PARTIAL_OR_FAILED');
        assert.equal(s.error.details.part_error, 'WRITES_PAUSED');
        assert.equal(s.error.details.part_submitted, false, 'part 2 was refused before it was claimed');
        assert.equal(claimOf(x, review), 'uncertain', 'the group is stopped: its own key is claimed');
        assert.equal(claimOf(x, parts[0]), 'complete');
        assert.equal(claimOf(x, parts[1]), undefined);
        assert.equal(x.writes(), 1);
        // What the stop names is the plan's call, not part 2's own execute (which the plan’s rule refuses) and not the reconcile of the group.
        assert.deepEqual(
          s.error.details.next_call,
          call,
          'the call prepare_next named for the step: execute_next with the exact review',
        );
        assert.deepEqual(s.error.details.not_sent, [], 'part 2 is the part that stopped, and is listed apart');
        assert.deepEqual(
          s.error.details.not_sent_parts.map(p => p.review_id),
          [parts[1]],
        );
        for (const part of s.error.details.not_sent_parts)
          assert.ok(!JSON.stringify(part).includes('"amcp_write"'), 'no part call outside the plan');
        // The plan says the same: prepare_next on the stopped step names it, and never the refused reconcile of the group.
        const blocked = await x.call('amcp_campaign', {action: 'prepare_next', id});
        assert.equal(blocked.data.blocked, true);
        assert.deepEqual(blocked.data.next_call, call);
        assert.ok(!JSON.stringify(blocked.data).includes('"reconcile"'), 'no reconcile of the group');
        assert.match(blocked.data.recovery, /execute_next/);
        assert.match(blocked.data.recovery, /never sent again/);
        // The status of the group and of part 2 reads the step in its plan, and that read names the call.
        const read = await statusOf(x, review);
        assert.deepEqual(read.next_call, {tool: 'amcp_campaign', arguments: {action: 'get', id, step_id: 'step1'}});
        const got = (await x.call('amcp_campaign', {action: 'get', id, step_id: 'step1'})).data;
        assert.deepEqual(got.next_call, call, 'the read of the step names the call');
        assert.match(got.recovery, /execute_next/);
        // Following the call sends part 2 once and completes the group; part 1 is replayed, never sent twice.
        const resumed = await x.call(call.tool, {...call.arguments, ...call.add_after_user_approval});
        assert.equal(resumed.success, true, JSON.stringify(resumed.error ?? resumed).slice(0, 400));
        assert.equal(x.writes(), 2, 'part 1 once, part 2 once');
        for (let i = 0; i < 30; i++)
          assert.equal(holding(x, '"P4 budget ' + i + '"'), 1, 'budget ' + i + ' reached the provider once');
        const done = stored(x, id).steps[0];
        assert.equal(done.status, 'verified', JSON.stringify(done.error ?? done.verification ?? {}).slice(0, 300));
        assert.equal(done.error, undefined);
        assert.equal(claimOf(x, review), 'complete', 'the group has its receipt');
        assert.equal(claimOf(x, parts[1]), 'complete');
        assert.equal(
          x.store.db.prepare("SELECT count(*) AS n FROM documents WHERE kind='write_review_group'").get().n,
          1,
        );
      } finally {
        x.store.close();
      }
    },
  );

test('P4: run stops at a stopped group as at any step that needs a person, and names the call that finishes it', async () => {
  const {x, id, review, call} = await stoppedPlan({policy: true});
  try {
    const run = await x.service.call('amcp_campaign', {action: 'run', id}, approver);
    assert.equal(run.success, true, JSON.stringify(run.error ?? run).slice(0, 300));
    assert.equal(run.data.run.stopped, 'needs_attention', JSON.stringify(run.data.run).slice(0, 300));
    assert.deepEqual(run.data.next_call, call, 'it names the plan’s execute_next');
    assert.equal(x.writes(), 1, 'run sent nothing');
    assert.equal(stored(x, id).steps[0].status, 'uncertain');
    // The person’s call then finishes it, once.
    assert.equal((await x.call(call.tool, {...call.arguments, ...call.add_after_user_approval})).success, true);
    assert.equal(x.writes(), 2);
    assert.equal(stored(x, id).steps[0].status, 'verified');
  } finally {
    x.store.close();
  }
});

test('P4: the resume is a new execution of the parts not sent, so it needs the plan’s current approval', async () => {
  const {x, id, review, call} = await stoppedPlan({policy: true});
  try {
    const {id: _id, revision, ...run} = stored(x, id),
      approval = run.approval;
    assert.ok(approval, 'another person approved the plan');
    delete run.approval;
    x.store.putDocument(T, 'campaign_run', id, run, revision);
    const refused = await executeNext(x, id, review);
    assert.equal(
      refused.error?.code,
      'DISTINCT_APPROVER_REQUIRED',
      JSON.stringify(refused.error ?? refused).slice(0, 300),
    );
    assert.equal(x.writes(), 1, 'nothing was sent');
    assert.equal(stored(x, id).steps[0].status, 'uncertain', 'the step is as it was');
    const again = stored(x, id),
      {id: _again, revision: current, ...data} = again;
    x.store.putDocument(T, 'campaign_run', id, {...data, approval}, current);
    assert.equal((await x.call(call.tool, {...call.arguments, ...call.add_after_user_approval})).success, true);
    assert.equal(x.writes(), 2);
  } finally {
    x.store.close();
  }
});

test('P4: once the review windows have ended the plan cannot send the parts not sent, and says so: no call that is refused, and nothing is sent', async () => {
  const {x, id, review, parts} = await stoppedPlan({policy: false});
  try {
    for (const [kind, key] of [['write_review_group', review], ...parts.map(p => ['write_review', p])]) {
      const doc = x.store.document(T, kind, key);
      x.store.putDocument(T, kind, key, {...doc, expires_at: 1});
    }
    // The plan's own answer to the call: the step is blocked, and nothing is sent.
    const refused = await executeNext(x, id, review);
    assert.equal(refused.data?.blocked, true, JSON.stringify(refused.error ?? refused).slice(0, 300));
    assert.match(refused.data.recovery, /windows have ended/);
    assert.equal(x.writes(), 1, 'nothing more was sent');
    assert.equal(stored(x, id).steps[0].status, 'uncertain');
    const blocked = await x.call('amcp_campaign', {action: 'prepare_next', id});
    assert.equal(blocked.data.blocked, true);
    assert.match(blocked.data.recovery, /windows have ended/, JSON.stringify(blocked.data.recovery));
    assert.ok(!/execute_next/.test(blocked.data.recovery), 'it does not name a call that is refused');
    assert.deepEqual(blocked.data.next_call?.arguments?.topic, 'parts', 'it names the read of the parts');
    assert.ok(!JSON.stringify(blocked.data).includes('"reconcile"'));
    // The status sentences promise only what is true.
    const read = await statusOf(x, review);
    assert.doesNotMatch(read.next_safe_action, /resumes it/);
    assert.equal(
      (await x.call('amcp_campaign', {action: 'recover_step', id, step_id: 'step1', confirmed: true})).error?.code,
      'RECOVERY_NOT_SAFE',
    );
    assert.equal(
      (await x.call('amcp_campaign', {action: 'continue_as_new', id, confirmed: true})).error?.code,
      'RECOVERY_NOT_SAFE',
    );
    assert.equal(x.store.db.prepare("SELECT count(*) AS n FROM documents WHERE kind='write_review_group'").get().n, 1);
    assert.equal(x.writes(), 1);
  } finally {
    x.store.close();
  }
});

test('P4: a group whose sent part did not apply (its receipt failed) is never resumed: the plan names no call that sends the parts not sent', async () => {
  const themes = n => Array.from({length: n}, (_, i) => signals('synthetic theme ' + i)[0]),
    x = googleWorld({policy: on, world: themeWorld()});
  try {
    const id = await createPlan(x, [step(themes(30), 'asset_group_signal_mutate_asset_group_signals')]);
    assert.equal((await x.call('amcp_campaign', {action: 'prepare_next', id})).success, true);
    const review = stored(x, id).steps[0].review_id,
      parts = x.store.document(T, 'write_review_group', review).parts,
      {id: _id, revision, ...run} = stored(x, id);
    // The crash: the step was saved executing and part 1 was sent; the fake cannot read a search theme back, so its receipt failed.
    run.steps[0].status = 'executing';
    run.state = 'in_progress';
    x.store.putDocument(T, 'campaign_run', id, run, revision);
    await x.call('amcp_write', {
      action: 'execute',
      review_id: parts[0],
      idempotency_key: parts[0],
      confirmed: true,
      spend_change_confirmed: true,
    });
    assert.equal(x.writes(), 1);
    await executeNext(x, id, review);
    assert.equal(stored(x, id).steps[0].status, 'uncertain');
    assert.equal(claimOf(x, review), 'uncertain');
    const blocked = await x.call('amcp_campaign', {action: 'prepare_next', id});
    assert.equal(blocked.data.blocked, true);
    assert.ok(
      !/execute_next/.test(JSON.stringify(blocked.data.next_call ?? '') + blocked.data.recovery),
      'no resume is offered for a part that did not apply',
    );
    assert.equal(
      blocked.data.next_call.arguments.action,
      'status',
      'the group is read part by part: its reconcile is refused',
    );
    assert.equal(blocked.data.next_call.arguments.review_id, review);
    assert.ok(!JSON.stringify(blocked.data).includes('\"reconcile\"'));
    await executeNext(x, id, review);
    assert.equal(x.writes(), 1, 'part 2 was never sent');
    assert.equal(claimOf(x, parts[1]), undefined);
  } finally {
    x.store.close();
  }
});

test('P4: a resume that is refused again leaves the group as it was, and the plan finishes it once the cause is gone', async () => {
  const {x, id, review, parts, call} = await stoppedPlan({policy: false});
  try {
    // The owner still has writes paused: the resume is refused before anything is claimed or sent, and the group is as the stop left it.
    pause(x);
    await executeNext(x, id, review);
    unpause(x);
    assert.equal(x.writes(), 1, 'nothing was sent');
    assert.equal(claimOf(x, review), 'uncertain');
    assert.equal(claimOf(x, parts[0]), 'complete');
    assert.equal(claimOf(x, parts[1]), undefined);
    assert.equal(x.store.db.prepare("SELECT count(*) AS n FROM documents WHERE kind='write_review_group'").get().n, 1);
    // Once it is gone, the same call finishes the group: part 2 once.
    const done = await executeNext(x, id, review);
    assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 300));
    assert.equal(x.writes(), 2);
    assert.equal(stored(x, id).steps[0].status, 'verified');
    assert.equal(claimOf(x, review), 'complete');
    assert.equal(call.arguments.action, 'execute_next');
  } finally {
    x.store.close();
  }
});

test('P4: a resume the deployment refused before the group’s own execute (the step failed, the group’s key free) is finished the same way', async () => {
  const x = googleWorld({policy: on, world: keywordWorld()});
  try {
    const id = await createPlan(x, [step(keywords(30), keywordAction)]);
    assert.equal((await x.call('amcp_campaign', {action: 'prepare_next', id})).success, true);
    const review = stored(x, id).steps[0].review_id,
      parts = x.store.document(T, 'write_review_group', review).parts,
      {id: _id, revision, ...run} = stored(x, id);
    // The crash: the step was saved executing and part 1 was sent.
    run.steps[0].status = 'executing';
    run.state = 'in_progress';
    x.store.putDocument(T, 'campaign_run', id, run, revision);
    await x.call('amcp_write', {
      action: 'execute',
      review_id: parts[0],
      idempotency_key: parts[0],
      confirmed: true,
      spend_change_confirmed: true,
    });
    // The owner turned the deployment read-only: the resume is refused before the group's own execute, and the plan marks the step failed.
    x.service.policy.allowWrites = false;
    await executeNext(x, id, review);
    x.service.policy.allowWrites = true;
    assert.equal(stored(x, id).steps[0].status, 'failed');
    assert.equal(stored(x, id).steps[0].error.code, 'LIVE_WRITES_DISABLED');
    assert.equal(claimOf(x, review), undefined, 'the group’s key is free');
    // The step is not described as unsent, nothing amends or carries it, and the call that finishes it is the plan's.
    const blocked = await x.call('amcp_campaign', {action: 'prepare_next', id});
    assert.equal(blocked.data.blocked, true);
    assert.equal(blocked.data.next_call.arguments.action, 'execute_next', JSON.stringify(blocked.data).slice(0, 300));
    assert.doesNotMatch(blocked.data.recovery, /failed before reaching the provider/);
    assert.equal(
      (await x.call('amcp_campaign', {action: 'recover_step', id, step_id: 'step1', confirmed: true})).error?.code,
      'RECOVERY_NOT_SAFE',
    );
    const done = await x.call(blocked.data.next_call.tool, {
      ...blocked.data.next_call.arguments,
      ...blocked.data.next_call.add_after_user_approval,
    });
    assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 300));
    assert.equal(x.writes(), 2, 'part 1 once, part 2 once');
    assert.equal(writesHolding(x, firstKeyword), 1, 'the first keyword reached the provider once');
    assert.equal(stored(x, id).steps[0].status, 'verified');
    assert.equal(x.store.db.prepare("SELECT count(*) AS n FROM documents WHERE kind='write_review_group'").get().n, 1);
  } finally {
    x.store.close();
  }
});

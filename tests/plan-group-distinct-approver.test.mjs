import test from 'node:test';
import assert from 'node:assert/strict';
import {googleWorld} from '../dist/tests/helpers/google-write-fake.js';
import {savePlanPolicy} from '../dist/src/campaign-inventory.js';
import {createPlan, on} from './helpers/google-policy-failure.mjs';
import {keywordAction, keywordWorld, keywords} from './helpers/google-keyword-group.mjs';

/**
 * r25-field3-errors, the lead's item 8 (owner rule: no bypass of reviewed-write controls). While the owner requires a distinct approver (CMP-05), a
 * step of a plan that changes spending or activates a launch executes only through its plan (execute_next or run), which checks another person's
 * current approval of the exact plan. The check of a direct `amcp_write execute` found the step by the review id it was given, and a plan's write
 * group holds the id of the group while its parts hold their own: the plan owner (member A) executed the group, or one of its parts, directly and
 * went past the check `execute_next` applies. A review a plan holds, a group a plan holds and the parts of that group are one rule now, and the
 * status of each names the plan's own call. Synthetic customer 123.
 */
const budgetAction = 'campaign_budget_mutate_campaign_budgets',
  budgets = (n, label = 'Synthetic budget ') =>
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
  owner = {tenantId: 'google-world', userId: 'owner', role: 'admin'},
  /** Another person, who may approve member A's plan. */
  approver = {tenantId: 'google-world', userId: 'approver', role: 'admin'},
  direct = (x, review_id) =>
    x.call('amcp_write', {
      action: 'execute',
      review_id,
      idempotency_key: review_id,
      confirmed: true,
      spend_change_confirmed: true,
    }),
  executeNext = (x, id, review_id) =>
    x.call('amcp_campaign', {
      action: 'execute_next',
      id,
      review_id,
      idempotency_key: review_id,
      confirmed: true,
      spend_change_confirmed: true,
    }),
  stored = (x, id) => x.store.document('google-world', 'campaign_run', id),
  statusOf = async (x, id) => (await x.call('amcp_write', {action: 'status', review_id: id})).data,
  isGroup = (x, id) => !!x.store.db.prepare("SELECT 1 FROM documents WHERE kind='write_review_group' AND id=?").get(id);
/**
 * A synthetic account with a plan prepared by member A (the fake's operator) that has one step, prepared and waiting for its execute. `policy`:
 * whether the owner requires a distinct approver.
 */
async function planned(
  operations,
  {policy = true, action = budgetAction, prepare = true, world = keywordWorld()} = {},
) {
  const x = googleWorld({policy: on, world});
  if (policy) savePlanPolicy(x.store, owner, {require_distinct_approver: true, confirmed: true});
  const id = await createPlan(x, [step(operations, action)]);
  if (!prepare) return {x, id, review: undefined, parts: [], call: undefined};
  const prepared = await x.call('amcp_campaign', {action: 'prepare_next', id});
  assert.equal(prepared.success, true);
  const review = stored(x, id).steps[0].review_id,
    parts = isGroup(x, review) ? x.store.document('google-world', 'write_review_group', review).parts : [];
  // `call`: the call the plan itself names for the prepared step.
  return {x, id, review, parts, call: prepared.data.next_call};
}
/** The refusal of a direct execute: the plan that holds the review, and the read of it. */
function assertRefused(refused, id, when) {
  assert.equal(refused.success, false, when);
  assert.equal(
    refused.error.code,
    'DISTINCT_APPROVER_REQUIRED',
    when + ' ' + JSON.stringify(refused.error).slice(0, 300),
  );
  assert.equal(refused.error.details.plan_id, id, when);
  assert.equal(refused.error.details.step_id, 'step1', when);
  // The step in its plan (the third re-review P4): the read that names the call that executes it, or says what is left.
  assert.deepEqual(
    refused.error.details.next_call,
    {tool: 'amcp_campaign', arguments: {action: 'get', id, step_id: 'step1'}},
    when,
  );
  assert.match(refused.error.message, /read its step in the plan/, when);
}

test('a plan step that is a write group is not executed directly through amcp_write under the distinct-approver policy, as execute_next refuses it too', async () => {
  const {x, id, review, parts} = await planned(budgets(30));
  try {
    assert.equal(parts.length, 2, 'the step is a group of two parts');
    // The plan's own path: member A, the plan's owner, has no other person's approval.
    const viaPlan = await executeNext(x, id, review);
    assert.equal(viaPlan.error?.code, 'DISTINCT_APPROVER_REQUIRED', JSON.stringify(viaPlan).slice(0, 300));
    assert.equal(x.writes(), 0);
    // The direct path refuses in the same terms, and sends and claims nothing.
    assertRefused(await direct(x, review), id, 'the group, directly');
    assert.equal(x.writes(), 0, 'nothing was sent');
    assert.equal(
      x.store.db.prepare('SELECT count(*) AS n FROM idempotency WHERE key IN (?,?,?)').get(review, parts[0], parts[1])
        .n,
      0,
      'nothing was claimed',
    );
  } finally {
    x.store.close();
  }
});

test('nor is one part of that group executed directly: each part is held by its group, which the plan holds', async () => {
  const {x, id, parts} = await planned(budgets(30));
  try {
    for (const [i, part] of parts.entries()) assertRefused(await direct(x, part), id, 'part ' + (i + 1));
    assert.equal(x.writes(), 0, 'nothing was sent');
  } finally {
    x.store.close();
  }
});

test('a single plan-step review is held by the same rule; the rule applies only under the policy and only to a plan that changes spending', async () => {
  // The review a plan holds as its step's review (the rule as it was).
  const one = await planned(budgets(5));
  try {
    assert.equal(isGroup(one.x, one.review), false, 'five budgets are one review, not a group');
    assertRefused(await direct(one.x, one.review), one.id, 'a single review');
    assert.equal(one.x.writes(), 0);
  } finally {
    one.x.store.close();
  }
  // The policy off: a direct execute of a plan's group is not refused, as it never was.
  const off = await planned(budgets(30), {policy: false});
  try {
    const done = await direct(off.x, off.review);
    assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 300));
    assert.equal(off.x.writes(), 2);
  } finally {
    off.x.store.close();
  }
  // The policy on and a plan that sets no money field (keywords): the policy does not govern it, so a direct execute is as it was.
  const free = await planned(keywords(30), {action: keywordAction});
  try {
    assert.equal(isGroup(free.x, free.review), true);
    const done = await direct(free.x, free.review);
    assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 300));
    assert.equal(free.x.writes(), 2);
  } finally {
    free.x.store.close();
  }
});

test('another person’s approval opens the plan’s own path: execute_next runs the group, every part once, and a group no plan holds is executed directly as before', async () => {
  const {x, id, review} = await planned(budgets(30));
  try {
    const own = await x.call('amcp_campaign', {action: 'approve', id});
    assert.equal(own.data.approver_required, true, 'member A is told another person approves');
    const preview = await x.service.call('amcp_campaign', {action: 'approve', id}, approver);
    assert.equal(preview.success, true, JSON.stringify(preview).slice(0, 400));
    const approved = await x.service.call(
      'amcp_campaign',
      {...preview.data.next_call.arguments, ...preview.data.next_call.add_after_user_approval},
      approver,
    );
    assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 400));
    // The plan's owner executes the step through the plan: the group and its parts are the plan's own call, which the rule must not refuse.
    const ran = await executeNext(x, id, review);
    assert.equal(ran.success, true, JSON.stringify(ran.error ?? ran).slice(0, 400));
    assert.equal(x.writes(), 2, 'both parts were sent, once');
    assert.notEqual(stored(x, id).steps[0].status, 'pending');
    assert.equal(stored(x, id).steps[0].error, undefined);
    // A group that no plan holds is executed directly, as before, with the policy on.
    const standalone = await x.prepare(budgetAction, budgets(30, 'Standalone budget '));
    assert.equal(standalone.data.group, true);
    const sent = await direct(x, standalone.data.review_id);
    assert.equal(sent.success, true, JSON.stringify(sent.error ?? sent).slice(0, 400));
    assert.equal(x.writes(), 4);
    // The plan's `run` is the same path: another plan of member A's, approved by the other person, who runs it and sends its group.
    const again = await planned(budgets(30, 'Second plan budget '), {prepare: false});
    try {
      const shown = await again.x.service.call('amcp_campaign', {action: 'approve', id: again.id}, approver);
      await again.x.service.call(
        'amcp_campaign',
        {...shown.data.next_call.arguments, ...shown.data.next_call.add_after_user_approval},
        approver,
      );
      const run = await again.x.service.call('amcp_campaign', {action: 'run', id: again.id}, approver);
      assert.equal(run.success, true, JSON.stringify(run.error ?? run).slice(0, 400));
      assert.equal(run.data.run.stopped, 'complete', JSON.stringify(run.data.run).slice(0, 300));
      assert.equal(again.x.writes(), 2, 'run executed the group through the plan');
    } finally {
      again.x.store.close();
    }
  } finally {
    x.store.close();
  }
});

test('the status of an unsubmitted review a plan holds names the plan’s own call, not amcp_write execute, for the group, its parts and a single review', async () => {
  // The group: the plan's execute_next with the exact review and its key, the flags after the user approves, as prepare_next names it.
  const g = await planned(budgets(30));
  try {
    const status = await statusOf(g.x, g.review);
    assert.equal(status.state, 'unsubmitted');
    assert.equal(status.next_call.tool, 'amcp_campaign');
    assert.deepEqual(status.next_call.arguments, {
      action: 'execute_next',
      id: g.id,
      review_id: g.review,
      idempotency_key: g.review,
      confirmed: true,
    });
    assert.deepEqual(status.next_call, g.call, 'the call the plan itself names for the prepared step');
    assert.match(status.next_safe_action, /step of a plan/);
    assert.match(status.next_safe_action, /execute_next/);
    assert.ok(!JSON.stringify(status.next_call).includes('amcp_write'), 'no amcp_write execute for the plan’s group');
    // A part is not executed on its own: its status reads the step in its plan.
    for (const part of g.parts) {
      const read = await statusOf(g.x, part);
      assert.equal(read.state, 'unsubmitted');
      assert.deepEqual(read.next_call, {tool: 'amcp_campaign', arguments: {action: 'get', id: g.id, step_id: 'step1'}});
      assert.match(read.next_safe_action, /part of a write group/);
    }
    assert.equal(g.x.writes(), 0);
  } finally {
    g.x.store.close();
  }
  // The acknowledgements its execute asks for are added after the user approves, as prepare_next names them: keywords under serving parents ask for one.
  const serving = keywordWorld();
  for (const kind of ['campaigns', 'adGroups'])
    for (const key of Object.keys(serving[kind])) serving[kind][key].status = 'ENABLED';
  const flagged = await planned(keywords(30), {action: keywordAction, world: serving});
  try {
    const named = await statusOf(flagged.x, flagged.review);
    assert.deepEqual(named.next_call, flagged.call);
    assert.deepEqual(named.next_call.add_after_user_approval, {spend_change_confirmed: true});
  } finally {
    flagged.x.store.close();
  }
  // A single review a plan holds.
  const one = await planned(budgets(5));
  try {
    const status = await statusOf(one.x, one.review);
    assert.equal(status.next_call.tool, 'amcp_campaign');
    assert.equal(status.next_call.arguments.action, 'execute_next');
    assert.equal(status.next_call.arguments.id, one.id);
    assert.equal(status.next_call.arguments.review_id, one.review);
    assert.deepEqual(status.next_call, one.call, 'the call the plan itself names for the prepared step');
    // A standalone review and a standalone group, with its parts, keep the execute of their own.
    const alone = await one.x.prepare(budgetAction, budgets(3, 'Standalone review '));
    assert.equal((await statusOf(one.x, alone.data.review_id)).next_call.arguments.action, 'execute');
    const group = await one.x.prepare(budgetAction, budgets(30, 'Standalone budget '));
    const read = await statusOf(one.x, group.data.review_id);
    assert.equal(read.next_call.tool, 'amcp_write');
    assert.equal(read.next_call.arguments.action, 'execute');
    assert.equal((await statusOf(one.x, group.data.parts[0].review_id)).next_call.arguments.action, 'execute');
  } finally {
    one.x.store.close();
  }
});

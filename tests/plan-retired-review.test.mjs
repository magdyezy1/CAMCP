import test from 'node:test';
import assert from 'node:assert/strict';
import {googleWorld} from '../dist/tests/helpers/google-write-fake.js';
import {savePlanPolicy} from '../dist/src/campaign-inventory.js';
import {createPlan, on} from './helpers/google-policy-failure.mjs';
import {
  AD_GROUP,
  firstKeyword,
  keywordAction,
  keywordWorld,
  keywords,
  writesHolding,
} from './helpers/google-keyword-group.mjs';

/**
 * r25-field3-errors, the third re-review of 2026-11-22 (P2, S1, and C1): a review a campaign plan has gone on from is retired by its plan. A step goes
 * on from an unclaimed review when recover_step amends it, when prepare_next prepares it again while the review is still open, and when the plan is
 * cancelled. Nothing retired the review: it stayed valid for its five minutes, its status named a direct `amcp_write execute`, and that execute skipped
 * the plan's approvals (the distinct-approver check, or the plan's approval itself once an amendment moved the plan's hash), and with the amended
 * step's own review made a second object. A retired review is refused before anything is claimed, whoever asks and whether or not the owner's policy
 * is on. Synthetic customer 123.
 */
const T = 'google-world',
  budgetAction = 'campaign_budget_mutate_campaign_budgets',
  budgets = (n, label = 'Synthetic budget ') =>
    Array.from({length: n}, (_, i) => ({
      create: {name: label + i, amount_micros: '50000000', delivery_method: 'STANDARD'},
    })),
  step = (operations, action = budgetAction, id = 'step1') => ({
    id,
    kind: 'write',
    gateway: 'google_ads_native_action',
    connection_id: 'g',
    account_id: '123',
    description: id,
    arguments: {action: 'google_ads_v23_' + action, payload: {operations}},
  }),
  owner = {tenantId: T, userId: 'owner', role: 'admin'},
  /** Another person, who may approve member A's plan. */
  approver = {tenantId: T, userId: 'approver', role: 'admin'},
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
  stored = (x, id) => x.store.document(T, 'campaign_run', id),
  statusOf = async (x, id) => (await x.call('amcp_write', {action: 'status', review_id: id})).data,
  isGroup = (x, id) => !!x.store.db.prepare("SELECT 1 FROM documents WHERE kind='write_review_group' AND id=?").get(id),
  claims = (x, ...keys) =>
    x.store.db
      .prepare('SELECT count(*) AS n FROM idempotency WHERE key IN (' + keys.map(() => '?').join(',') + ')')
      .get(...keys).n,
  getStep = (id, step_id = 'step1') => ({tool: 'amcp_campaign', arguments: {action: 'get', id, step_id}}),
  /** Member A's plan with one step, prepared and waiting for its execute; `policy`: whether the owner requires a distinct approver. */
  planned = async (operations, {policy = true, action = budgetAction, world = keywordWorld()} = {}) => {
    const x = googleWorld({policy: on, world});
    if (policy) savePlanPolicy(x.store, owner, {require_distinct_approver: true, confirmed: true});
    const id = await createPlan(x, [step(operations, action)]);
    assert.equal((await x.call('amcp_campaign', {action: 'prepare_next', id})).success, true);
    const review = stored(x, id).steps[0].review_id,
      parts = isGroup(x, review) ? x.store.document(T, 'write_review_group', review).parts : [];
    return {x, id, review, parts};
  };
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
/** The deployment is read-only for one call (the owner's switch): the execute is refused before anything is claimed, and the plan marks the step failed. */
async function failedBeforeSending(x, id, review) {
  x.service.policy.allowWrites = false;
  await executeNext(x, id, review);
  x.service.policy.allowWrites = true;
  const s = stored(x, id).steps[0];
  assert.equal(s.error.code, 'LIVE_WRITES_DISABLED');
  assert.equal(s.status, 'failed');
  assert.equal(x.writes(), 0);
}
/** A direct execute of a retired review: refused before anything is claimed, naming the step in its plan. */
function assertRetired(refused, id, reason, when) {
  assert.equal(refused.success, false, when);
  assert.equal(refused.error.code, 'REVIEW_RETIRED', when + ' ' + JSON.stringify(refused.error).slice(0, 300));
  assert.equal(refused.error.details.plan_id, id, when);
  assert.equal(refused.error.details.step_id, 'step1', when);
  assert.equal(refused.error.details.reason, reason, when);
  assert.deepEqual(refused.error.details.next_call, getStep(id), when);
  assert.ok(typeof refused.error.remedy?.action === 'string' && /plan/.test(refused.error.remedy.action), when);
}

for (const policy of [true, false])
  for (const [label, operations, patch] of [
    ['a single review', budgets(5), undefined],
    [
      'a single review amended by a patch',
      budgets(5),
      [{path: '/payload/operations/0/create/amount_micros', value: '60000000'}],
    ],
    ['a write group of 30', budgets(30), undefined],
  ])
    test(
      'P2: recover_step retires the review it goes on from (' +
        label +
        ', the policy ' +
        (policy ? 'on' : 'off') +
        '): a direct execute of it is refused, and the plan sends the step once',
      async () => {
        const {x, id, review, parts} = await planned(operations, {policy});
        try {
          if (policy) await approveAs(x, id);
          await failedBeforeSending(x, id, review);
          const amended = await x.call('amcp_campaign', {
            action: 'recover_step',
            id,
            step_id: 'step1',
            confirmed: true,
            ...(patch ? {patch} : {}),
          });
          assert.equal(amended.success, true, JSON.stringify(amended).slice(0, 300));
          assert.equal((await x.call('amcp_campaign', {action: 'prepare_next', id})).success, true);
          const second = stored(x, id).steps[0].review_id;
          assert.notEqual(second, review, 'the step holds a new review');
          assert.equal(
            stored(x, id).steps[0].previous_attempts.at(-1).review_id,
            review,
            'and keeps the one it went on from',
          );
          // The review the step went on from is unexpired and unclaimed, and nothing may send it now: not the plan owner directly, not any part of a group.
          assertRetired(await direct(x, review), id, 'amended', 'the review the plan went on from');
          for (const [i, part] of parts.entries())
            assertRetired(await direct(x, part), id, 'amended', 'part ' + (i + 1));
          assert.equal(x.writes(), 0, 'nothing was sent before the plan’s own execute');
          assert.equal(claims(x, review, ...parts), 0, 'and nothing was claimed');
          // Its status says so and names the step in its plan: no direct execute.
          const read = await statusOf(x, review);
          assert.deepEqual(read.next_call, getStep(id), 'the call is the step in its plan');
          assert.equal(read.retired.reason, 'amended');
          assert.match(read.next_safe_action, /went on from it/);
          assert.ok(!JSON.stringify(read.next_call).includes('"execute"'), 'no execute is offered');
          for (const part of parts) assert.deepEqual((await statusOf(x, part)).next_call, getStep(id));
          // The plan's own review is the one that is sent, once.
          if (policy && patch) {
            const refused = await executeNext(x, id, second);
            assert.equal(
              refused.error?.code,
              'DISTINCT_APPROVER_REQUIRED',
              'the amendment moved the plan’s hash: it needs approving again',
            );
            await approveAs(x, id);
          }
          const done = await executeNext(x, id, second);
          assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 300));
          assert.equal(
            x.writes(),
            Math.max(1, parts.length),
            'the amended step reached the provider once: one request for each of its parts',
          );
          const first = x.log.filter(r => r.kind === 'write' && JSON.stringify(r.body).includes('Synthetic budget 0"'));
          assert.equal(first.length, 1, 'the first budget exists once');
          if (patch) assert.ok(JSON.stringify(first[0].body).includes('"60000000"'), 'with the amended amount');
        } finally {
          x.store.close();
        }
      },
    );

test('P2 (E2): prepare_next that replaces a review still open retires the one it replaces, and records it among the step’s earlier attempts', async () => {
  const {x, id, review} = await planned(keywords(5), {policy: false, action: keywordAction});
  try {
    const ad = state => {
      for (const k of Object.keys(x.world.adGroups)) x.world.adGroups[k].status = state;
    };
    // The state the review read moved: the plan's execute refuses it before anything is claimed, and the step goes back to pending.
    ad('ENABLED');
    await executeNext(x, id, review);
    assert.equal(stored(x, id).steps[0].status, 'pending');
    assert.equal(stored(x, id).steps[0].error.code, 'STATE_CHANGED');
    assert.equal((await x.call('amcp_campaign', {action: 'prepare_next', id})).success, true);
    const second = stored(x, id).steps[0].review_id;
    assert.notEqual(second, review, 'prepared again');
    assert.equal(
      stored(x, id).steps[0].previous_attempts.at(-1).review_id,
      review,
      'the replaced review is an earlier attempt',
    );
    // The state is as the replaced review read it: only its being replaced can stop it.
    ad('PAUSED');
    assertRetired(await direct(x, review), id, 'replaced', 'the replaced review');
    assert.equal(x.writes(), 0);
    ad('ENABLED');
    const done = await executeNext(x, id, second);
    assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 300));
    assert.equal(x.writes(), 1);
    assert.equal(writesHolding(x, firstKeyword), 1, 'one keyword at the end');
  } finally {
    x.store.close();
  }
});

test('P2 (E2): a review that expired and is prepared again is not retired: it can never be executed, and its status is the expired review’s', async () => {
  const {x, id, review} = await planned(keywords(5), {policy: false, action: keywordAction});
  try {
    const doc = x.store.document(T, 'write_review', review);
    x.store.putDocument(T, 'write_review', review, {...doc, expires_at: 1});
    const run = stored(x, id),
      {id: _id, revision, ...data} = run;
    data.steps[0].review = {...data.steps[0].review, expires_at: new Date(1).toISOString()};
    x.store.putDocument(T, 'campaign_run', id, data, revision);
    await executeNext(x, id, review);
    assert.equal(stored(x, id).steps[0].status, 'pending');
    assert.equal(stored(x, id).steps[0].error.code, 'REVIEW_EXPIRED');
    assert.equal((await x.call('amcp_campaign', {action: 'prepare_next', id})).success, true);
    assert.notEqual(stored(x, id).steps[0].review_id, review, 'prepared again');
    assert.equal(
      x.store.document(T, 'write_review', review).retired,
      undefined,
      'an expired review needs no retirement',
    );
    const read = await statusOf(x, review);
    assert.equal(read.state, 'expired');
    assert.equal(read.retired, undefined);
    // An execute of it is the expired review’s refusal, as it always was.
    assert.equal((await direct(x, review)).error.code, 'REVIEW_EXPIRED');
  } finally {
    x.store.close();
  }
});

for (const policy of [false, true])
  test(
    'C1 (E1): cancel retires the unclaimed reviews of the plan’s unsettled steps (the policy ' +
      (policy ? 'on, a money plan' : 'off') +
      '): a direct execute is refused and its status says the plan was cancelled',
    async () => {
      const {x, id, review} = await planned(policy ? budgets(5) : keywords(5), {
        policy,
        action: policy ? budgetAction : keywordAction,
      });
      try {
        const cancelled = await x.call('amcp_campaign', {action: 'cancel', id, confirmed: true});
        assert.equal(cancelled.success, true, JSON.stringify(cancelled).slice(0, 300));
        assertRetired(await direct(x, review), id, 'cancelled', 'the cancelled plan’s review');
        assert.equal(x.writes(), 0, 'nothing was sent');
        const read = await statusOf(x, review);
        assert.deepEqual(read.next_call, getStep(id), 'the status does not offer a call the cancelled plan refuses');
        assert.equal(read.retired.reason, 'cancelled');
        assert.match(read.next_safe_action, /cancelled/);
        assert.ok(!JSON.stringify(read.next_call).includes('execute'), 'no execute is offered');
        // Once its window ended the status still says the plan was cancelled: the plan will not prepare it again, which an expired plan review's status offers.
        const doc = x.store.document(T, 'write_review', review);
        x.store.putDocument(T, 'write_review', review, {...doc, expires_at: 1});
        const late = await statusOf(x, review);
        assert.equal(late.state, 'expired');
        assert.match(late.next_safe_action, /cancelled/);
        assert.deepEqual(late.next_call, getStep(id));
      } finally {
        x.store.close();
      }
    },
  );

test('C1: cancel retires only what the plan never sent: the review of a step that was sent keeps its claim and its receipt', async () => {
  const x = googleWorld({policy: on, world: keywordWorld()});
  try {
    const later = Array.from({length: 4}, (_, i) => ({
        create: {ad_group: AD_GROUP, keyword: {text: 'second step keyword ' + i, match_type: 'BROAD'}},
      })),
      id = await createPlan(x, [step(keywords(3), keywordAction, 'first'), step(later, keywordAction, 'second')]);
    assert.equal((await x.call('amcp_campaign', {action: 'prepare_next', id})).success, true);
    const sent = stored(x, id).steps[0].review_id;
    assert.equal((await executeNext(x, id, sent)).success, true);
    assert.equal(x.writes(), 1);
    assert.equal((await x.call('amcp_campaign', {action: 'prepare_next', id})).success, true);
    const live = stored(x, id).steps[1].review_id;
    assert.notEqual(live, sent);
    assert.equal((await x.call('amcp_campaign', {action: 'cancel', id, confirmed: true})).success, true);
    assert.equal(
      x.store.document(T, 'write_review', sent).retired,
      undefined,
      'the review that was sent is not retired',
    );
    assert.equal(x.store.document(T, 'write_review', live).retired.reason, 'cancelled');
    const refused = await direct(x, live);
    assert.equal(refused.error.code, 'REVIEW_RETIRED');
    assert.equal(refused.error.details.step_id, 'second');
    assert.equal(x.writes(), 1, 'only the first step was ever sent');
    // The receipt of the step that was sent still replays for whoever asks.
    const replay = await direct(x, sent);
    assert.equal(replay.success, true, JSON.stringify(replay.error ?? replay).slice(0, 200));
    assert.equal(x.writes(), 1);
  } finally {
    x.store.close();
  }
});

test('P2 (the same rule): continue_as_new retires the reviews of the steps the old plan no longer runs, and the new plan sends the step once', async () => {
  const {x, id, review} = await planned(keywords(5), {policy: false, action: keywordAction});
  try {
    const carried = await x.call('amcp_campaign', {action: 'continue_as_new', id, confirmed: true});
    assert.equal(carried.success, true, JSON.stringify(carried).slice(0, 300));
    const next = carried.data.id;
    assert.notEqual(next, id);
    const refused = await direct(x, review);
    assert.equal(refused.error?.code, 'REVIEW_RETIRED', JSON.stringify(refused.error ?? refused).slice(0, 300));
    assert.equal(refused.error.details.plan_id, id, 'the plan that went on from it');
    assert.equal(refused.error.details.reason, 'continued');
    assert.equal(x.writes(), 0, 'nothing was sent');
    assert.match((await statusOf(x, review)).next_safe_action, /went on from it/);
    // The new plan prepares and sends its own review of the step, once.
    assert.equal((await x.call('amcp_campaign', {action: 'prepare_next', id: next})).success, true);
    const own = stored(x, next).steps[0].review_id;
    assert.notEqual(own, review);
    assert.equal((await executeNext(x, next, own)).success, true);
    assert.equal(x.writes(), 1);
    assert.equal(writesHolding(x, firstKeyword), 1, 'one keyword at the end');
  } finally {
    x.store.close();
  }
});

test('a review that holds a claim is never retired, and a group is retired with its parts only while none of them holds one', async () => {
  const {retireReview} = await import('../dist/src/write-record-repository.js'),
    x = googleWorld({policy: on, world: keywordWorld()});
  try {
    const group = await x.prepare(keywordAction, keywords(30)),
      groupId = group.data.review_id,
      parts = group.data.parts.map(p => p.review_id),
      mark = {plan_id: 'plan-x', step_id: 'step1', reason: 'amended'};
    assert.equal((await direct(x, parts[0])).data.executed, true);
    assert.equal(retireReview(x.store, T, groupId, mark), false, 'a part was sent: the group is not retired');
    assert.equal(retireReview(x.store, T, parts[0], mark), false, 'a review that holds a claim is not retired');
    const marked = id =>
      x.store.db
        .prepare(
          "SELECT json_extract(data,'$.retired.reason') AS reason FROM documents WHERE tenant_id=? AND kind IN ('write_review','write_review_group') AND id=?",
        )
        .get(T, id).reason;
    for (const id of [groupId, ...parts]) assert.equal(marked(id), null, id + ' carries no mark');
    const free = await x.prepare(keywordAction, keywords(30)),
      freeParts = free.data.parts.map(p => p.review_id);
    assert.equal(retireReview(x.store, T, free.data.review_id, mark), true);
    for (const id of [free.data.review_id, ...freeParts]) assert.equal(marked(id), 'amended', id);
    // The group's own execute refuses it too, with the same refusal.
    const refused = await direct(x, free.data.review_id);
    assert.equal(refused.error.code, 'REVIEW_RETIRED', JSON.stringify(refused.error).slice(0, 200));
    assert.equal(refused.error.details.plan_id, 'plan-x');
  } finally {
    x.store.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {admin, google, googleWorld} from '../dist/tests/helpers/google-write-fake.js';
import {savePlanPolicy} from '../dist/src/campaign-inventory.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
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
    assert.equal(
      refused.error.details.review_id,
      free.data.review_id,
      'the group itself is named, not one of its parts',
    );
    assert.equal(x.writes(), 1, 'only the part sent above was ever sent');
  } finally {
    x.store.close();
  }
});

test('a part retired alone refuses the group that holds it before any part is sent', async () => {
  const {retireReview} = await import('../dist/src/write-record-repository.js'),
    x = googleWorld({policy: on, world: keywordWorld()});
  try {
    const group = await x.prepare(keywordAction, keywords(30)),
      parts = group.data.parts.map(p => p.review_id);
    assert.equal(retireReview(x.store, T, parts[1], {plan_id: 'plan-x', step_id: 'step1', reason: 'amended'}), true);
    const refused = await direct(x, group.data.review_id);
    assert.equal(refused.error?.code, 'REVIEW_RETIRED', JSON.stringify(refused.error ?? refused).slice(0, 300));
    assert.equal(refused.error.details.review_id, parts[1], 'the part the plan went on from is named');
    assert.equal(x.writes(), 0, 'part 1 was not sent either: every part is checked before the first is sent');
    assert.equal(claims(x, group.data.review_id, ...parts), 0, 'and nothing was claimed');
  } finally {
    x.store.close();
  }
});

test('a group whose only claims are its parts’ refusals is retired with the parts that hold none, and the refused part is left as it is', async () => {
  const {retireReview} = await import('../dist/src/write-record-repository.js'),
    x = googleWorld({policy: on, world: keywordWorld()});
  try {
    const group = await x.prepare(keywordAction, keywords(30)),
      groupId = group.data.review_id,
      parts = group.data.parts.map(p => p.review_id),
      reason = id =>
        x.store.db
          .prepare(
            "SELECT json_extract(data,'$.retired.reason') AS reason FROM documents WHERE tenant_id=? AND kind IN ('write_review','write_review_group') AND id=?",
          )
          .get(T, id).reason;
    // Part 1 was sent and the provider refused it without applying it: its key is retired, and the group's own key was never claimed.
    x.store.claim(T, parts[0], 'fingerprint');
    assert.ok(x.store.rejected(T, parts[0], 'fingerprint'));
    assert.equal(retireReview(x.store, T, groupId, {plan_id: 'plan-x', step_id: 'step1', reason: 'amended'}), true);
    assert.equal(reason(groupId), 'amended', 'the group');
    assert.equal(
      reason(parts[1]),
      'amended',
      'the part that holds no claim: it would otherwise stay executable beside the amended step',
    );
    assert.equal(reason(parts[0]), null, 'the refused part keeps its own refusal');
    assert.equal((await direct(x, parts[1])).error?.code, 'REVIEW_RETIRED');
    const refusedPart = await direct(x, parts[0]);
    assert.equal(refusedPart.success, false);
    assert.notEqual(refusedPart.error.code, 'REVIEW_RETIRED', 'its own claim answers it, not the plan’s mark');
    assert.equal(x.writes(), 0);
    // A single review whose own claim is a refusal is not retired: its key is retired already.
    const single = await x.prepare(keywordAction, keywords(3));
    x.store.claim(T, single.data.review_id, 'fingerprint');
    assert.ok(x.store.rejected(T, single.data.review_id, 'fingerprint'));
    assert.equal(
      retireReview(x.store, T, single.data.review_id, {plan_id: 'plan-x', step_id: 'step1', reason: 'amended'}),
      false,
    );
  } finally {
    x.store.close();
  }
});

/**
 * r25-field3-errors, the fourth check of 2026-11-22 (F1, S1): a review that prepare_next replaces is retired whatever its window and whatever the new review
 * turns out to be. It used to be retired only when the step's copy of its window was still open, and only after the stop for a review the provider
 * rejected, so two kinds of replaced review stayed executable by their status, outside the plan: a group whose own window ended while its parts' windows
 * had not (a group's window ends at least 3 s per part before every part's), and a review replaced by one the provider rejected at validate-only.
 */
/** The group's own window ends while each part keeps its own, as it does 3 s per part before them: the step's copy of the group's window says so too. */
function groupWindowEnded(x, id, review) {
  const doc = x.store.document(T, 'write_review_group', review);
  for (const part of doc.parts)
    assert.ok(x.store.document(T, 'write_review', part).expires_at > Date.now() + 60000, 'each part keeps its window');
  x.store.putDocument(T, 'write_review_group', review, {...doc, expires_at: Date.now() - 1000});
  const {id: _id, revision, ...data} = stored(x, id);
  data.steps[0].review = {...data.steps[0].review, expires_at: new Date(Date.now() - 1000).toISOString()};
  x.store.putDocument(T, 'campaign_run', id, data, revision);
}
/** How many requests that reached the provider hold each of the first n budgets: every one of them exactly once. */
const eachBudgetOnce = (x, n) => Array.from({length: n}, (_, i) => writesHolding(x, 'Synthetic budget ' + i + '"'));

for (const policy of [true, false])
  test(
    'F1 (a): prepare_next that replaces a group whose own window ended, its parts’ windows still open, retires it with its parts (the policy ' +
      (policy ? 'on, nobody approved the plan' : 'off') +
      '): no part is sent outside the plan, and the plan sends each budget once',
    async () => {
      const {x, id, review, parts} = await planned(budgets(30), {policy});
      try {
        assert.ok(parts.length >= 2, 'a group of parts');
        if (policy)
          assert.equal(
            (await executeNext(x, id, review)).error?.code,
            'DISTINCT_APPROVER_REQUIRED',
            'nobody approved the plan',
          );
        groupWindowEnded(x, id, review);
        assert.equal((await x.call('amcp_campaign', {action: 'prepare_next', id})).success, true);
        const second = stored(x, id).steps[0].review_id;
        assert.notEqual(second, review, 'the step holds a new group');
        assert.equal(
          stored(x, id).steps[0].previous_attempts.at(-1).review_id,
          review,
          'and keeps the old group among its earlier attempts',
        );
        assert.equal(x.store.document(T, 'write_review_group', review).retired.reason, 'replaced', 'the old group');
        for (const [i, part] of parts.entries()) {
          assert.equal(x.store.document(T, 'write_review', part).retired.reason, 'replaced', 'part ' + (i + 1));
          // The status of a part names the step in its plan, and no execute; a direct execute of it is refused before anything is claimed.
          const read = await statusOf(x, part);
          assert.deepEqual(read.next_call, getStep(id), 'part ' + (i + 1) + ': the step in its plan');
          assert.ok(!JSON.stringify(read.next_call).includes('"execute"'), 'no execute is offered');
          assertRetired(await direct(x, part), id, 'replaced', 'old part ' + (i + 1));
        }
        assertRetired(await direct(x, review), id, 'replaced', 'the old group');
        assert.equal(x.writes(), 0, 'nothing was sent outside the plan');
        assert.equal(claims(x, review, ...parts), 0, 'and nothing was claimed');
        // The plan's own group is the one that is sent, once: with the policy on, after another person approves the plan.
        if (policy) {
          assert.equal((await executeNext(x, id, second)).error?.code, 'DISTINCT_APPROVER_REQUIRED');
          assert.equal(x.writes(), 0);
          await approveAs(x, id);
        }
        const done = await executeNext(x, id, second);
        assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 300));
        assert.equal(x.writes(), parts.length, 'one request for each part of the new group');
        assert.deepEqual(
          eachBudgetOnce(x, 30),
          Array(30).fill(1),
          'every budget reached the provider once, none of them twice',
        );
      } finally {
        x.store.close();
      }
    },
  );

test('F1 (b): prepare_next whose new review the provider rejects at validate-only still retires the review it replaces, and records it among the step’s attempts', async () => {
  const {x, id, review: first} = await planned(keywords(5), {policy: false, action: keywordAction});
  try {
    const ad = state => {
      for (const k of Object.keys(x.world.adGroups)) x.world.adGroups[k].status = state;
    };
    ad('ENABLED');
    await executeNext(x, id, first);
    assert.equal(stored(x, id).steps[0].status, 'pending');
    assert.equal(stored(x, id).steps[0].error.code, 'STATE_CHANGED');
    x.state.validation = 'reject';
    const again = await x.call('amcp_campaign', {action: 'prepare_next', id});
    x.state.validation = 'pass';
    assert.equal(again.data.blocked, true, 'the plan stops at the rejected review');
    const held = stored(x, id).steps[0];
    assert.equal(held.status, 'failed');
    assert.notEqual(held.review_id, first, 'the step holds the rejected review');
    assert.equal(held.previous_attempts?.at(-1)?.review_id, first, 'and keeps the review it replaced');
    assert.equal(held.previous_attempts.at(-1).replaced_by, held.review_id);
    assert.equal(held.previous_attempts.at(-1).error?.code, 'STATE_CHANGED', 'with the refusal that sent it back');
    // The state is as the replaced review read it: only its being replaced can stop it.
    ad('PAUSED');
    assertRetired(await direct(x, first), id, 'replaced', 'the replaced review');
    assert.equal(x.writes(), 0);
    const read = await statusOf(x, first);
    assert.deepEqual(read.next_call, getStep(id), 'its status names the step, not an execute');
    assert.equal(read.retired.reason, 'replaced');
    // The plan goes on as it always did: amend, prepare, execute. The first keyword reaches the provider once.
    const amended = await x.call('amcp_campaign', {action: 'recover_step', id, step_id: 'step1', confirmed: true});
    assert.equal(amended.success, true, JSON.stringify(amended).slice(0, 300));
    assert.equal((await x.call('amcp_campaign', {action: 'prepare_next', id})).success, true);
    const third = stored(x, id).steps[0].review_id;
    const done = await executeNext(x, id, third);
    assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 300));
    assert.equal(x.writes(), 1);
    assert.equal(writesHolding(x, firstKeyword), 1, 'the first keyword reached the provider once');
  } finally {
    x.store.close();
  }
});

test('F1 (the claim fallback): prepare_next that finds the review it replaces claimed while it prepared does not replace it: the step is uncertain, and the review prepared meanwhile is never executed', async () => {
  const {x, id, review: first} = await planned(keywords(5), {policy: false, action: keywordAction});
  try {
    const ad = state => {
      for (const k of Object.keys(x.world.adGroups)) x.world.adGroups[k].status = state;
    };
    ad('ENABLED');
    await executeNext(x, id, first);
    assert.equal(stored(x, id).steps[0].error.code, 'STATE_CHANGED');
    ad('PAUSED');
    // Another process sends the review while the plan prepares its replacement: the claim appears during the provider's validate-only check.
    x.hooks.beforeValidationReply = () => {
      x.hooks.beforeValidationReply = undefined;
      x.store.claim(T, first, 'fingerprint');
    };
    const again = await x.call('amcp_campaign', {action: 'prepare_next', id});
    x.hooks.beforeValidationReply = undefined;
    assert.equal(claims(x, first), 1, 'the review was claimed while the plan prepared');
    assert.equal(again.data.blocked, true, JSON.stringify(again).slice(0, 300));
    const held = stored(x, id).steps[0];
    assert.equal(held.status, 'uncertain', 'the review was sent: the outcome is not settled');
    assert.equal(held.review_id, first, 'the step keeps the review that was sent');
    assert.equal(held.previous_attempts, undefined, 'and replaces nothing');
    assert.equal(x.store.document(T, 'write_review', first).retired, undefined, 'a sent review is never retired');
    // The review prepared meanwhile is the plan’s and no step keeps it: it is retired, so nobody sends it, and its status names the step.
    const other = x.store.db
      .prepare("SELECT id FROM documents WHERE tenant_id=? AND kind='write_review' AND id<>?")
      .all(T, first)
      .map(r => r.id);
    assert.equal(other.length, 1, 'one review was prepared meanwhile');
    assertRetired(await direct(x, other[0]), id, 'replaced', 'the review prepared meanwhile');
    assert.equal(x.writes(), 0, 'nothing was sent');
    assert.equal(claims(x, other[0]), 0);
    assert.deepEqual((await statusOf(x, other[0])).next_call, getStep(id));
  } finally {
    x.store.close();
  }
});

for (const policy of [true, false])
  test(
    'F1 (item 4, the class): a plan’s review, and the parts of a plan’s group, that no step holds are refused whatever the policy (the policy ' +
      (policy ? 'on' : 'off') +
      '), and their status names no execute',
    async () => {
      const {x, id, review, parts} = await planned(budgets(30), {policy});
      try {
        // The plan is gone (the store dropped it): nothing names the group, and nothing marks it.
        x.store.deleteDocument(T, 'campaign_run', id);
        assert.equal(x.store.document(T, 'write_review_group', review).retired, undefined, 'nothing retired it');
        for (const [label, target] of [
          ['the group', review],
          ['part 1', parts[0]],
          ['part 2', parts[1]],
        ]) {
          const read = await statusOf(x, target);
          assert.equal(read.next_call, null, label + ': no plan names it, so no call is offered');
          assert.match(read.next_safe_action, /never executed/, label + ': it says so');
          assert.match(read.next_safe_action, /no plan holds it any longer/, label + ': and that no plan holds it');
          assert.equal(read.approval, undefined, label + ': and shows no approval for it');
          const refused = await direct(x, target);
          assert.equal(refused.success, false, label);
          assert.equal(refused.error.code, 'REVIEW_RETIRED', label + ' ' + JSON.stringify(refused.error).slice(0, 300));
          assert.equal(refused.error.details.review_id, target, label);
        }
        assert.equal(x.writes(), 0, 'nothing was sent');
        assert.equal(claims(x, review, ...parts), 0, 'and nothing was claimed');
      } finally {
        x.store.close();
      }
    },
  );

test('F1 (item 4, the class): an expired review of a plan that no step holds keeps the expired review’s refusal, and a review of no plan is as it always was', async () => {
  const {x, id, review} = await planned(keywords(5), {policy: false, action: keywordAction});
  try {
    const doc = x.store.document(T, 'write_review', review);
    x.store.putDocument(T, 'write_review', review, {...doc, expires_at: 1});
    x.store.deleteDocument(T, 'campaign_run', id);
    assert.equal((await direct(x, review)).error.code, 'REVIEW_EXPIRED');
    // A review nobody’s plan prepared is a standalone review: executed directly, as ever.
    const own = await x.prepare(keywordAction, keywords(3));
    assert.equal((await direct(x, own.data.review_id)).data.executed, true);
    assert.equal(x.writes(), 1);
  } finally {
    x.store.close();
  }
});

/**
 * The mutation check of the fourth follow-up showed what the tests above left alone: the refusal and the status of a review the step went on from that carries
 * no mark. A release before this one replaced a review without retiring it (a group whose window ended, a review replaced by one the provider rejected): it is
 * among the step's attempts, nothing wrote on it, and its status offered the execute that the plan itself had gone past. The refusal names the step (reason
 * detached), the status names the step read and says the plan went on from it, and no approval is shown for it.
 */
async function unmarkedAttempt(x, id, review, parts, group) {
  if (group) groupWindowEnded(x, id, review);
  else {
    const ad = state => {
      for (const k of Object.keys(x.world.adGroups)) x.world.adGroups[k].status = state;
    };
    ad('ENABLED');
    await executeNext(x, id, review);
    assert.equal(stored(x, id).steps[0].error.code, 'STATE_CHANGED');
    ad('PAUSED');
  }
  assert.equal((await x.call('amcp_campaign', {action: 'prepare_next', id})).success, true);
  assert.equal(stored(x, id).steps[0].previous_attempts.at(-1).review_id, review, 'the step went on from it');
  // As a release before this one left it: among the step's attempts, and with no mark.
  for (const [kind, doc] of [
    [group ? 'write_review_group' : 'write_review', review],
    ...parts.map(p => ['write_review', p]),
  ]) {
    const {retired: _mark, ...unmarked} = x.store.document(T, kind, doc);
    x.store.putDocument(T, kind, doc, unmarked);
  }
}
for (const [label, operations, action] of [
  ['a single review', keywords(5), keywordAction],
  ['a write group of 30', budgets(30), budgetAction],
])
  test(
    'F1 (item 4, the class): a review the step went on from that carries no mark is refused as detached, naming the step, and its status says the plan went on from it (' +
      label +
      ')',
    async () => {
      const {x, id, review, parts} = await planned(operations, {policy: false, action});
      try {
        await unmarkedAttempt(x, id, review, parts, isGroup(x, review));
        // The parts of a group, whose own window ended: a part keeps its window. A single review keeps its own.
        for (const target of parts.length ? parts : [review]) {
          const refused = await direct(x, target);
          assert.equal(refused.error?.code, 'REVIEW_RETIRED', target + ' ' + JSON.stringify(refused).slice(0, 300));
          assert.equal(refused.error.details.reason, 'detached', 'the plan went on from it');
          assert.equal(refused.error.details.plan_id, id);
          assert.equal(refused.error.details.step_id, 'step1');
          assert.deepEqual(refused.error.details.next_call, getStep(id));
          const read = await statusOf(x, target);
          assert.deepEqual(read.next_call, getStep(id), 'its status names the step in its plan');
          assert.match(read.next_safe_action, /went on from it/);
          assert.equal(read.retired, undefined, 'and it carries no mark');
        }
        assert.equal(x.writes(), 0, 'nothing was sent');
      } finally {
        x.store.close();
      }
    },
  );

test('F1 (item 4, the class): under website approval the status of a review the step went on from shows no approval for it, and the plan’s own review still shows one', async () => {
  const {x, id, review, parts} = await planned(budgets(30), {policy: false});
  try {
    saveSpendPolicy(x.store, admin, {
      confirmed: true,
      gateway: google,
      account_id: '123',
      policy: {approval_mode: 'website_approval'},
    });
    // A budget create under a paused parent asks for no spend acknowledgement: the reviews are written as ones that do.
    const asking = parts => {
      for (const part of parts) {
        const doc = x.store.document(T, 'write_review', part);
        x.store.putDocument(T, 'write_review', part, {...doc, required_acknowledgements: ['spend_change_confirmed']});
      }
    };
    asking(parts);
    assert.ok((await statusOf(x, parts[0])).approval, 'a part the step holds shows the approval it needs');
    await unmarkedAttempt(x, id, review, parts, true);
    assert.equal(
      (await statusOf(x, parts[0])).approval,
      undefined,
      'a part of the group the step went on from does not',
    );
    const own = x.store.document(T, 'write_review_group', stored(x, id).steps[0].review_id).parts;
    asking(own);
    assert.ok((await statusOf(x, own[0])).approval, 'and a part of the plan’s own group still does');
  } finally {
    x.store.close();
  }
});

/**
 * r25-field3-errors, the fourth check (F2, S2): the retirement and the claim race. An execute checks that its review is not retired at its top and takes its
 * claim later, after it waited for the target (up to 10 s), read the state and fetched the credentials, so a plan that went on from the review in that
 * window retired it (no claim yet) and the execute then claimed and sent it. The claim transaction now looks again, and the plan retires before it awaits
 * anything. The target lock is held as another execute of the same target holds it: `store.acquireLocks` answers false until it is released.
 */
const tick = ms => new Promise(resolve => setTimeout(resolve, ms)),
  plans = x => x.store.db.prepare("SELECT count(*) AS n FROM documents WHERE kind='campaign_run'").get().n;
/** Every attempt to take the target lock is refused until the returned function releases it. */
function holdTargetLock(x) {
  const take = x.store.acquireLocks.bind(x.store),
    lock = {held: true};
  x.store.acquireLocks = (...args) => (lock.held ? false : take(...args));
  return () => {
    lock.held = false;
  };
}
/**
 * Another process claims the review right after the next read of a review's own claim (the read a plan makes before it decides): the plan found no claim and
 * then, as it retires the review, finds one. Returns a function that says whether the claim was made.
 */
function claimAfterNextClaimRead(x, review) {
  const prepare = x.store.db.prepare.bind(x.store.db),
    state = {armed: true, made: false};
  x.store.db.prepare = sql => {
    const statement = prepare(sql);
    if (state.armed && /state,result,created_at FROM idempotency WHERE tenant_id=\? AND key=\?/.test(sql)) {
      const get = statement.get.bind(statement);
      statement.get = (...args) => {
        const row = get(...args);
        if (state.armed) {
          state.armed = false;
          x.store.claim(T, review, 'fingerprint');
          state.made = true;
        }
        return row;
      };
    }
    return statement;
  };
  return () => state.made;
}
const amount = [{path: '/payload/operations/0/create/amount_micros', value: '60000000'}];

test('F2 (B1): a direct execute of a plan’s review that waits for its target is refused when the plan amends the step meanwhile: only the plan’s own review is sent', async () => {
  const {x, id, review} = await planned(budgets(5), {policy: false});
  try {
    await failedBeforeSending(x, id, review);
    const release = holdTargetLock(x),
      inflight = direct(x, review);
    await tick(250);
    assert.equal(claims(x, review), 0, 'the execute waits: nothing is claimed');
    const amended = await x.call('amcp_campaign', {
      action: 'recover_step',
      id,
      step_id: 'step1',
      confirmed: true,
      patch: amount,
    });
    assert.equal(amended.success, true, JSON.stringify(amended).slice(0, 300));
    assert.equal(x.store.document(T, 'write_review', review).retired.reason, 'amended');
    release();
    assertRetired(await inflight, id, 'amended', 'the execute that waited');
    assert.equal(x.writes(), 0, 'nothing was sent by it');
    assert.equal(claims(x, review), 0, 'and nothing was claimed');
    // The plan prepares and sends its own review of the amended step, once.
    assert.equal((await x.call('amcp_campaign', {action: 'prepare_next', id})).success, true);
    const done = await executeNext(x, id, stored(x, id).steps[0].review_id);
    assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 300));
    assert.equal(x.writes(), 1);
    assert.equal(writesHolding(x, 'Synthetic budget 0"'), 1, 'the first budget exists once');
    assert.equal(writesHolding(x, '"60000000"'), 1, 'with the amended amount');
    assert.equal(writesHolding(x, '"50000000"'), 1, 'and the others as they were');
  } finally {
    x.store.close();
  }
});

test('F2 (B3): continue_as_new does not carry a step whose execute is in flight (executing, no claim yet): the execute sends it once and no second plan exists', async () => {
  const {x, id, review} = await planned(budgets(5), {policy: false});
  try {
    const release = holdTargetLock(x),
      inflight = executeNext(x, id, review);
    await tick(250);
    assert.equal(stored(x, id).steps[0].status, 'executing');
    assert.equal(claims(x, review), 0, 'no claim yet');
    const carried = await x.call('amcp_campaign', {action: 'continue_as_new', id, confirmed: true});
    assert.equal(carried.success, false, JSON.stringify(carried).slice(0, 300));
    assert.equal(carried.error.code, 'RECOVERY_NOT_SAFE');
    assert.deepEqual(
      carried.error.details.blocked_steps.map(b => [b.step_id, b.status]),
      [['step1', 'executing']],
      'the step whose execute is in flight is the one it names',
    );
    assert.deepEqual(carried.error.details.blocked_steps[0].next_call, getStep(id), 'and the call that reads it');
    assert.equal(plans(x), 1, 'no second plan');
    assert.equal(x.store.document(T, 'write_review', review).retired, undefined, 'the review is not retired');
    release();
    const done = await inflight;
    assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 300));
    assert.equal(x.writes(), 1);
    assert.equal(writesHolding(x, 'Synthetic budget 0"'), 1, 'the first budget exists once');
    assert.equal(stored(x, id).steps[0].status, 'verified');
  } finally {
    x.store.close();
  }
});

test('F2 (B3, a review that is ready): continue_as_new retires the reviews before it awaits the new plan: a direct execute that waited is refused, and the new plan sends the step once', async () => {
  const {x, id, review} = await planned(budgets(5), {policy: false});
  try {
    const release = holdTargetLock(x),
      inflight = direct(x, review);
    await tick(250);
    const carried = await x.call('amcp_campaign', {action: 'continue_as_new', id, confirmed: true});
    assert.equal(carried.success, true, JSON.stringify(carried).slice(0, 300));
    release();
    assertRetired(await inflight, id, 'continued', 'the execute that waited');
    assert.equal(x.writes(), 0, 'nothing was sent by it');
    const next = carried.data.id;
    assert.equal((await x.call('amcp_campaign', {action: 'prepare_next', id: next})).success, true);
    const own = stored(x, next).steps[0].review_id;
    assert.notEqual(own, review);
    assert.equal((await executeNext(x, next, own)).success, true);
    assert.equal(x.writes(), 1);
    assert.equal(writesHolding(x, 'Synthetic budget 0"'), 1, 'the first budget exists once');
    assert.equal(stored(x, next).steps[0].status, 'verified');
  } finally {
    x.store.close();
  }
});

test('F2: continue_as_new that finds a review claimed as it retires it is refused before the new plan is made, and takes back what it retired', async () => {
  const x = googleWorld({policy: on, world: keywordWorld()});
  try {
    const id = await createPlan(x, [
      step(keywords(3), keywordAction, 'first'),
      step(keywords(4), keywordAction, 'second'),
    ]);
    assert.equal((await x.call('amcp_campaign', {action: 'prepare_next', id})).success, true);
    const first = stored(x, id).steps[0].review_id;
    assert.equal((await executeNext(x, id, first)).success, true);
    assert.equal((await x.call('amcp_campaign', {action: 'prepare_next', id})).success, true);
    const second = stored(x, id).steps[1].review_id;
    assert.notEqual(second, first);
    // Another process sends the second review after the plan read its claims and before it retires it.
    const made = claimAfterNextClaimRead(x, second),
      carried = await x.call('amcp_campaign', {action: 'continue_as_new', id, confirmed: true});
    assert.equal(made(), true, 'the claim was made');
    assert.equal(carried.success, false, JSON.stringify(carried).slice(0, 300));
    assert.equal(carried.error.code, 'RECOVERY_NOT_SAFE');
    assert.equal(plans(x), 1, 'no second plan was made');
    assert.notEqual(stored(x, id).state, 'superseded');
    assert.equal(x.store.document(T, 'write_review', second).retired, undefined, 'the sent review is not retired');
    assert.equal(x.store.document(T, 'write_review', first).retired, undefined, 'and no other is');
  } finally {
    x.store.close();
  }
});

for (const [label, n] of [
  ['a single review', 5],
  ['a write group of 30', 30],
])
  test(
    'F2: a continuation that fails after it retired the reviews reopens them (' +
      label +
      '): the old plan’s step is executed through its plan, once',
    async () => {
      const {x, id, review, parts} = await planned(budgets(n), {policy: false});
      try {
        const put = x.store.putDocument.bind(x.store);
        let refused = false;
        x.store.putDocument = (tenant, kind, doc, ...rest) => {
          if (kind === 'campaign_run' && doc !== id && !refused) {
            refused = true;
            throw new Error('synthetic failure while the new plan is saved');
          }
          return put(tenant, kind, doc, ...rest);
        };
        const carried = await x.call('amcp_campaign', {action: 'continue_as_new', id, confirmed: true});
        x.store.putDocument = put;
        assert.equal(refused, true, 'the new plan could not be saved');
        assert.equal(carried.error?.code, 'INTERNAL_ERROR', 'the continuation failed with the store’s failure');
        assert.equal(plans(x), 1, 'no second plan');
        const kind = isGroup(x, review) ? 'write_review_group' : 'write_review';
        for (const doc of [[kind, review], ...parts.map(part => ['write_review', part])])
          assert.equal(x.store.document(T, doc[0], doc[1]).retired, undefined, doc[1] + ' is open again');
        assert.notEqual(stored(x, id).state, 'superseded');
        const done = await executeNext(x, id, review);
        assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 300));
        assert.equal(x.writes(), Math.max(1, parts.length));
        assert.equal(writesHolding(x, 'Synthetic budget 0"'), 1);
      } finally {
        x.store.close();
      }
    },
  );

test('F2: recover_step that finds the review claimed as it retires it is refused: the step reached the provider', async () => {
  const {x, id, review} = await planned(budgets(5), {policy: false});
  try {
    await failedBeforeSending(x, id, review);
    const made = claimAfterNextClaimRead(x, review),
      amended = await x.call('amcp_campaign', {
        action: 'recover_step',
        id,
        step_id: 'step1',
        confirmed: true,
        patch: amount,
      });
    assert.equal(made(), true, 'the claim was made');
    assert.equal(amended.success, false, JSON.stringify(amended).slice(0, 300));
    assert.equal(amended.error.code, 'RECOVERY_NOT_SAFE');
    const held = stored(x, id).steps[0];
    assert.equal(held.review_id, review, 'the step still holds the review that was sent');
    assert.equal(held.previous_attempts, undefined, 'and was not amended');
    assert.equal(x.store.document(T, 'write_review', review).retired, undefined);
  } finally {
    x.store.close();
  }
});

test('F2 (B2): a plan’s execute_next that waits for its target when the plan is cancelled is refused as a retired review, and nothing is sent', async () => {
  const {x, id, review} = await planned(budgets(5), {policy: false});
  try {
    const release = holdTargetLock(x),
      inflight = executeNext(x, id, review);
    await tick(250);
    const cancelled = await x.call('amcp_campaign', {action: 'cancel', id, confirmed: true});
    assert.equal(cancelled.success, true, JSON.stringify(cancelled).slice(0, 300));
    release();
    assertRetired(await inflight, id, 'cancelled', 'the execute_next that waited');
    assert.equal(x.writes(), 0, 'nothing was sent after the cancel');
    assert.equal(claims(x, review), 0);
    assert.equal(stored(x, id).state, 'cancelled');
  } finally {
    x.store.close();
  }
});

/**
 * r25-field3-errors, the fourth check (F3, S3): cancel left the parts of a stopped group that hold no claim executable. A group whose key the stop claimed
 * uncertain is read as sent by retireReview, which marked nothing, so after "Steps not yet run will not run" the part that was never sent could still be sent
 * directly. The parts that hold no claim are retired when the plan is cancelled; the group itself is not (a part of it was sent, and its record is read).
 */
test('F3: cancel retires the parts of a stopped group that hold no claim, and not the group or the part that was sent: the part not sent is refused', async () => {
  const {x, id, review, parts} = await planned(budgets(30), {policy: false});
  try {
    // The owner pauses writes as part 1 reaches the provider: part 1 is sent and applied, part 2 is refused before it is claimed, and the stop claims the
    // group's own key uncertain.
    x.hooks.writeReply = () => {
      x.hooks.writeReply = undefined;
      x.store.putDocument(T, 'write_pause', 'workspace', {
        paused: true,
        scope: 'all',
        reason: 'synthetic',
        paused_by: 'owner',
        paused_at: Date.now(),
      });
      return undefined;
    };
    await executeNext(x, id, review);
    x.store.deleteDocument(T, 'write_pause', 'workspace');
    assert.equal(stored(x, id).steps[0].status, 'uncertain', 'the group stopped part-way');
    assert.equal(x.writes(), 1, 'part 1 was sent');
    assert.equal(claims(x, review), 1, 'the group’s key is claimed by the stop');
    assert.equal(claims(x, parts[1]), 0, 'part 2 holds no claim');
    const cancelled = await x.call('amcp_campaign', {action: 'cancel', id, confirmed: true});
    assert.equal(cancelled.success, true, JSON.stringify(cancelled).slice(0, 300));
    assert.equal(x.store.document(T, 'write_review', parts[1]).retired.reason, 'cancelled', 'part 2 is retired');
    assert.equal(x.store.document(T, 'write_review', parts[0]).retired, undefined, 'part 1 was sent: it is not');
    assert.equal(x.store.document(T, 'write_review_group', review).retired, undefined, 'and nor is the group');
    // Part 2 is refused whoever asks, and its status says the plan was cancelled; nothing more reaches the provider.
    assertRetired(await direct(x, parts[1]), id, 'cancelled', 'part 2 of the stopped group');
    assert.equal(x.writes(), 1, 'only part 1 was ever sent');
    assert.equal(claims(x, parts[1]), 0);
    const read = await statusOf(x, parts[1]);
    assert.equal(read.retired.reason, 'cancelled');
    assert.deepEqual(read.next_call, getStep(id), 'the call is the step in its plan');
    assert.match(read.next_safe_action, /cancelled/);
    // The group is still read as a group in doubt, with the part that was sent.
    const group = await statusOf(x, review);
    assert.equal(group.retired, undefined);
    assert.equal(group.state, 'uncertain');
    assert.equal(stored(x, id).steps[0].status, 'uncertain', 'the step is as the stop left it');
  } finally {
    x.store.close();
  }
});

/**
 * r25-field3-errors, the fourth check (F4b, S4): an execute that waits for its target holds its step executing, and saves the plan only when it comes back. A
 * cancel that arrives meanwhile saves the plan first, so the execute's copy is stale and it can never record how it ended: the cancelled plan showed the step
 * executing for good. The cancel itself now says what the step is: ready, and never executed, when it retired the review (nothing was claimed, and the execute
 * in flight is refused at its claim); uncertain when the review holds a claim (the execute got that far, so the change may have reached the provider).
 */
test('F4 (b): a cancelled plan does not show a step executing: it shows it ready when the cancel retired its review, and the execute in flight is refused', async () => {
  const {x, id, review} = await planned(budgets(5), {policy: false});
  try {
    const release = holdTargetLock(x),
      inflight = executeNext(x, id, review);
    await tick(250);
    assert.equal(stored(x, id).steps[0].status, 'executing');
    assert.equal((await x.call('amcp_campaign', {action: 'cancel', id, confirmed: true})).success, true);
    assert.equal(stored(x, id).steps[0].status, 'review_ready', 'at once, whatever the execute does next');
    release();
    assertRetired(await inflight, id, 'cancelled', 'the execute_next that waited');
    assert.equal(x.writes(), 0);
    assert.equal(stored(x, id).steps[0].status, 'review_ready', 'and it stays so');
    assert.equal(stored(x, id).state, 'cancelled');
    const read = await x.call('amcp_campaign', {action: 'get', id, step_id: 'step1'});
    assert.equal(read.data.state, 'cancelled');
    assert.equal(read.data.step.status, 'review_ready', 'as the plan shows it');
    assert.equal((await statusOf(x, review)).retired.reason, 'cancelled', 'and its review says the plan was cancelled');
  } finally {
    x.store.close();
  }
});

test('F4 (b): a cancelled plan shows a step uncertain when its review holds a claim: the change may have reached the provider, and nothing more is sent', async () => {
  const {x, id, review} = await planned(budgets(5), {policy: false});
  try {
    const release = holdTargetLock(x),
      inflight = executeNext(x, id, review);
    await tick(250);
    assert.equal(stored(x, id).steps[0].status, 'executing');
    // The claim is there when the plan is cancelled (another process, or the execute a moment ahead of the lock it waits for).
    x.store.claim(T, review, 'fingerprint');
    assert.equal((await x.call('amcp_campaign', {action: 'cancel', id, confirmed: true})).success, true);
    assert.equal(stored(x, id).steps[0].status, 'uncertain');
    assert.equal(x.store.document(T, 'write_review', review).retired, undefined, 'a claimed review is never retired');
    release();
    await inflight;
    assert.equal(x.writes(), 0, 'the execute that waited sent nothing: the review is claimed already');
    assert.equal(stored(x, id).steps[0].status, 'uncertain', 'and the step stays so');
    assert.equal(stored(x, id).state, 'cancelled');
  } finally {
    x.store.close();
  }
});

test('F3: only a cancel retires the unclaimed parts of a group that holds a claim; a plan that goes on from the group (amended, replaced, continued) leaves them to its resume', async () => {
  const {retireReview} = await import('../dist/src/write-record-repository.js'),
    x = googleWorld({policy: on, world: keywordWorld()});
  try {
    const reason = id =>
      x.store.db
        .prepare(
          "SELECT json_extract(data,'$.retired.reason') AS reason FROM documents WHERE tenant_id=? AND kind IN ('write_review','write_review_group') AND id=?",
        )
        .get(T, id).reason;
    const mark = why => ({plan_id: 'plan-x', step_id: 'step1', reason: why});
    for (const why of ['amended', 'replaced', 'continued']) {
      const group = await x.prepare(keywordAction, keywords(30)),
        groupId = group.data.review_id,
        parts = group.data.parts.map(p => p.review_id);
      assert.equal((await direct(x, parts[0])).data.executed, true, 'part 1 is sent');
      assert.equal(retireReview(x.store, T, groupId, mark(why)), false, why + ': the group is not retired');
      for (const id of [groupId, ...parts]) assert.equal(reason(id), null, why + ': ' + id + ' keeps no mark');
    }
    const group = await x.prepare(keywordAction, keywords(30)),
      groupId = group.data.review_id,
      parts = group.data.parts.map(p => p.review_id);
    assert.equal((await direct(x, parts[0])).data.executed, true);
    assert.equal(retireReview(x.store, T, groupId, mark('cancelled')), false, 'the group is not retired');
    assert.equal(reason(groupId), null, 'the group keeps no mark');
    assert.equal(reason(parts[0]), null, 'the part that was sent keeps none');
    assert.equal(reason(parts[1]), 'cancelled', 'the part that holds no claim is retired');
    // A single review that holds a claim is never marked, whatever the reason.
    const single = await x.prepare(keywordAction, keywords(3));
    assert.equal((await direct(x, single.data.review_id)).data.executed, true);
    assert.equal(retireReview(x.store, T, single.data.review_id, mark('cancelled')), false);
    assert.equal(reason(single.data.review_id), null);
  } finally {
    x.store.close();
  }
});

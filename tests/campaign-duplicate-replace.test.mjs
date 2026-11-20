import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import {tiktokReconcileFixture} from './helpers/tiktok-reconcile-fixture.mjs';
import {standardBodies} from './helpers/tiktok-standard-creates.mjs';
import {duplicateReason} from '../dist/src/campaign-runner.js';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * Round 2.5, package r25-field-plan, item 3 (the lead's re-review of r25-m3-dupstep, R-2, option (a)). A plan step held by the guard against
 * creating twice waits for the earlier create to be settled, and the words said "if it was not applied, prepare the step again". That branch
 * was a dead end: an uncertain create that a reconciliation found not applied stays uncertain until a replacement review seals it, and only a
 * standalone `amcp_write prepare` with `supersedes_review_id` could, which no plan path passed. A step's `prepare_next` now passes it when the
 * earlier review is the actor's own and its fresh reconciliation (under fifteen minutes old) found it not applied, so the plan step becomes the
 * replacement: its review seals the earlier one, which is never sent, and executing it sends exactly one create. The seal and the replacement
 * rules are the existing ones (`replaceable`, `supersede`); a colleague's earlier create, a stale or other reconciliation and a create still
 * being sent keep the step held, as before.
 */
const tenant = 'plan-duplicate-replace',
  gateway = 'tiktok_native_action';
before(() => {
  process.env.AMCP_WRITE_RECONCILE_DELAY_MS = '0';
  process.env.AMCP_WRITE_RECONCILE_ROUND_MS = '0';
});
after(() => {
  delete process.env.AMCP_WRITE_RECONCILE_DELAY_MS;
  delete process.env.AMCP_WRITE_RECONCILE_ROUND_MS;
});
const colleague = {tenantId: tenant, userId: 'colleague', role: 'operator'},
  owner = {tenantId: tenant, userId: 'owner', role: 'admin'};

function world() {
  const f = tiktokReconcileFixture({tenant});
  for (const user of ['operator', 'colleague'])
    f.store.db
      .prepare('INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,?,?)')
      .run(tenant, user, 'operator', Date.now());
  return f;
}
/** The campaign create of the plan below, prepared on its own by `who` and lost (applied or not): an uncertain review that is `who`'s. */
async function loseAs(f, who, applied) {
  const body = standardBodies(f.world.id).campaign,
    prepared = await f.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        connection_id: f.connection.id,
        arguments: {action: body.action, account_id: f.world.id, payload: structuredClone(body.payload)},
      },
      who,
    );
  assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 600));
  f.state.applied = applied;
  f.state.lose = true;
  const refused = await f.call(
    'amcp_write',
    {action: 'execute', review_id: prepared.data.review_id, confirmed: true},
    who,
  );
  f.state.lose = false;
  f.state.applied = undefined;
  assert.equal(refused.error?.code, 'WRITE_OUTCOME_UNCERTAIN', JSON.stringify(refused).slice(0, 500));
  return prepared.data.review_id;
}
const reconcile = (f, id, who = f.actor) => f.call('amcp_write', {action: 'reconcile', review_id: id}, who);
const status = async (f, id, who = f.actor) =>
  (await f.call('amcp_write', {action: 'status', review_id: id}, who)).data;
/** An approved plan of the one campaign create, whose request is the earlier create's. */
async function approvedPlan(f, who = f.actor, name = 'Replace plan', login = f.connection.id) {
  const body = standardBodies(f.world.id).campaign,
    call = input => f.call('amcp_campaign', input, who);
  const created = await call({
    action: 'create',
    name,
    brief: 'One paused create.',
    steps: [
      {
        id: 'campaign',
        kind: 'write',
        gateway,
        connection_id: login,
        account_id: f.world.id,
        description: 'Create the paused campaign',
        arguments: {action: body.action, payload: body.payload},
      },
    ],
  });
  assert.equal(created.success, true, JSON.stringify(created).slice(0, 800));
  const id = created.data.id,
    preview = await call({action: 'approve', id}),
    approved = await call({
      action: 'approve',
      id,
      confirmed: true,
      plan_hash: preview.data.plan_hash,
      summary_hash: preview.data.summary_hash,
    });
  assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 800));
  assert.equal((await call({action: 'preflight', id})).success, true);
  return {id, call};
}
const stepOf = result => result.data.steps.find(s => s.id === 'campaign');
const heldBy = async (plan, expected = 'DUPLICATE_OF_UNCERTAIN_WRITE') => {
  const held = await plan.call({action: 'prepare_next', id: plan.id});
  assert.equal(held.success, true, JSON.stringify(held).slice(0, 600));
  assert.equal(stepOf(held).status, 'pending', JSON.stringify(held.data).slice(0, 500));
  assert.equal(stepOf(held).error, expected);
  return held;
};
const executeNext = (plan, prepared) =>
  plan.call({
    action: 'execute_next',
    id: plan.id,
    review_id: prepared.data.review.review_id,
    idempotency_key: prepared.data.review.idempotency_key,
    confirmed: true,
  });
/** The failed nested calls the audit recorded for amcp_write: a replacement tried and refused leaves one. */
const refusedWrites = f =>
  f.store.db
    .prepare('SELECT event FROM audit WHERE tenant_id=?')
    .all(tenant)
    .map(r => JSON.parse(r.event))
    .filter(e => e.tool === 'amcp_write' && e.input?.action === 'prepare' && e.outcome?.success === false)
    .map(e => e.outcome.error.code);

test('the lead’s probe: after reconcile finds the earlier create not applied, prepare_next replaces it, and execute sends exactly one create', async () => {
  const f = world();
  try {
    const earlier = await loseAs(f, f.actor, false);
    const plan = await approvedPlan(f);
    await heldBy(plan);
    assert.equal(f.sent.length, 1, 'only the lost create was ever sent');
    // Nothing is settled yet: asking again is held again, and nothing was prepared for the step.
    await heldBy(plan);
    const found = await reconcile(f, earlier);
    assert.equal(found.data.classification, 'appears_not_applied', JSON.stringify(found).slice(0, 500));
    // The step is prepared as the replacement: its review is ready, and it says which earlier review it replaces.
    const prepared = await plan.call({action: 'prepare_next', id: plan.id});
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 800));
    assert.ok(prepared.data.review, 'a review was prepared');
    assert.equal(prepared.data.step_id, 'campaign');
    assert.equal(stepOf(await plan.call({action: 'get', id: plan.id})).status, 'review_ready');
    const review = f.store.document(tenant, 'write_review', prepared.data.review.review_id);
    assert.equal(review.supersedes_uncertain, earlier);
    assert.notEqual(prepared.data.review.review_id, earlier);
    assert.equal(f.sent.length, 1, 'preparing sends nothing');
    // The earlier create is sealed while the replacement stands: it is settled, never reconciled, accepted or sent again.
    assert.equal((await status(f, earlier)).state, 'superseded');
    const done = await executeNext(plan, prepared);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 800));
    assert.equal(done.data.state, 'complete', JSON.stringify(done.data).slice(0, 500));
    assert.equal(f.sent.length, 2, 'exactly one create was sent for the step');
    assert.equal(f.sent[1].body.campaign_name, f.sent[0].body.campaign_name, 'the step’s own request');
    assert.equal(f.claim(earlier).state, 'uncertain', 'the earlier key is never reset or sent again');
    assert.equal(
      (await status(f, earlier)).state,
      'superseded',
      'and it still shows superseded once the replacement executed',
    );
    assertRefused(await reconcile(f, earlier), 'RECONCILIATION_UNAVAILABLE');
  } finally {
    f.close();
  }
});

test('run does the same: it stops once at the replacement’s review, shown before anything is sent, and the next run sends the one create', async () => {
  const f = world();
  try {
    const earlier = await loseAs(f, f.actor, false);
    const plan = await approvedPlan(f);
    const first = await plan.call({action: 'run', id: plan.id});
    assert.equal(first.data.run.stopped, 'needs_attention', JSON.stringify(first.data.run));
    assert.equal(f.sent.length, 1);
    assert.equal((await reconcile(f, earlier)).data.classification, 'appears_not_applied');
    const shown = await plan.call({action: 'run', id: plan.id});
    assert.equal(shown.data.run.stopped, 'needs_attention', JSON.stringify(shown.data.run));
    assert.ok(shown.data.review, 'the replacement’s review is shown before it is sent');
    assert.equal(f.store.document(tenant, 'write_review', shown.data.review.review_id).supersedes_uncertain, earlier);
    assert.equal(f.sent.length, 1);
    const ran = await plan.call({action: 'run', id: plan.id});
    assert.equal(ran.data.run.stopped, 'complete', JSON.stringify(ran.data.run));
    assert.equal(f.sent.length, 2);
  } finally {
    f.close();
  }
});

test('a step the guard has not held yet is held first, and replaces the earlier create on its next prepare: a replacement is always shown before it is sent', async () => {
  const f = world();
  try {
    const earlier = await loseAs(f, f.actor, false);
    assert.equal((await reconcile(f, earlier)).data.classification, 'appears_not_applied');
    const plan = await approvedPlan(f);
    // The first prepare of the step is the guard's refusal, as before: the step is held, and nothing is replaced behind anyone's back.
    await heldBy(plan);
    assert.equal((await status(f, earlier)).state, 'uncertain');
    // Held, its next prepare is the replacement, and a run stops at it so that the review is shown before it is sent.
    const shown = await plan.call({action: 'run', id: plan.id});
    assert.equal(shown.data.run.stopped, 'needs_attention', JSON.stringify(shown.data.run));
    assert.equal(f.store.document(tenant, 'write_review', shown.data.review.review_id).supersedes_uncertain, earlier);
    assert.equal(f.sent.length, 1);
  } finally {
    f.close();
  }
});
test('a colleague’s earlier create is still not replaced, whatever its reconciliation found', async () => {
  const f = world();
  try {
    const earlier = await loseAs(f, colleague, false);
    assert.equal((await reconcile(f, earlier, colleague)).data.classification, 'appears_not_applied');
    // The operator's plan cannot read it, so the step names no review to replace: it stays held, nothing is prepared or sent.
    const plan = await approvedPlan(f);
    const held = await heldBy(plan);
    assert.equal(held.data.next_call.arguments.action, 'prepare_next');
    assert.equal(stepOf(await plan.call({action: 'get', id: plan.id})).status, 'pending');
    await heldBy(plan);
    assert.equal(f.sent.length, 1);
    assert.deepEqual(
      refusedWrites(f).filter(code => code !== 'DUPLICATE_OF_UNCERTAIN_WRITE' && code !== 'WRITE_OUTCOME_UNCERTAIN'),
      [],
    );
    // The workspace owner can read it, and it is still not the owner’s own: the step stays held, and no replacement is even tried.
    const ownerPlan = await approvedPlan(f, owner, 'Owner plan');
    await ownerPlan.call({action: 'prepare_next', id: ownerPlan.id});
    const ownerHeld = await ownerPlan.call({action: 'prepare_next', id: ownerPlan.id});
    assert.equal(stepOf(ownerHeld).status, 'pending', JSON.stringify(ownerHeld.data).slice(0, 500));
    assert.equal(stepOf(ownerHeld).error, 'DUPLICATE_OF_UNCERTAIN_WRITE');
    assert.equal(f.sent.length, 1);
    assert.deepEqual(
      refusedWrites(f).filter(code => code !== 'DUPLICATE_OF_UNCERTAIN_WRITE' && code !== 'WRITE_OUTCOME_UNCERTAIN'),
      [],
    );
    assert.equal((await status(f, earlier, colleague)).state, 'uncertain', 'the colleague’s review was not sealed');
  } finally {
    f.close();
  }
});

test('a reconciliation that found the object keeps the step held: the way out is to accept it, never to replace it', async () => {
  const f = world();
  try {
    const applied = await loseAs(f, f.actor, true);
    const plan = await approvedPlan(f);
    await heldBy(plan);
    assert.equal((await reconcile(f, applied)).data.classification, 'appears_applied');
    await heldBy(plan);
    assert.equal((await status(f, applied)).state, 'uncertain', 'the earlier create was not sealed');
    assert.equal(f.sent.length, 1);
    assert.deepEqual(
      refusedWrites(f).filter(code => code !== 'DUPLICATE_OF_UNCERTAIN_WRITE' && code !== 'WRITE_OUTCOME_UNCERTAIN'),
      [],
      'no replacement was even tried',
    );
  } finally {
    f.close();
  }
});

test('a reconciliation more than fifteen minutes old keeps the step held until it is read again', async () => {
  const f = world();
  try {
    const earlier = await loseAs(f, f.actor, false);
    const plan = await approvedPlan(f);
    await heldBy(plan);
    assert.equal((await reconcile(f, earlier)).data.classification, 'appears_not_applied');
    const {id: _id, revision, ...data} = f.store.document(tenant, 'write_reconciliation', earlier);
    f.store.putDocument(
      tenant,
      'write_reconciliation',
      earlier,
      {...data, checked_at: Date.now() - 16 * 60000},
      revision,
    );
    await heldBy(plan);
    assert.equal(f.sent.length, 1);
    assert.equal((await status(f, earlier)).state, 'uncertain');
    assert.deepEqual(
      refusedWrites(f).filter(code => code !== 'DUPLICATE_OF_UNCERTAIN_WRITE' && code !== 'WRITE_OUTCOME_UNCERTAIN'),
      [],
    );
    // Read again, it is fresh, and the step replaces it.
    assert.equal((await reconcile(f, earlier)).data.classification, 'appears_not_applied');
    const prepared = await plan.call({action: 'prepare_next', id: plan.id});
    assert.equal(prepared.data.step_id, 'campaign', JSON.stringify(prepared.data).slice(0, 500));
    assert.equal(
      f.store.document(tenant, 'write_review', prepared.data.review.review_id).supersedes_uncertain,
      earlier,
    );
  } finally {
    f.close();
  }
});

test('a replacement the rule refuses leaves the step held on the guard’s own refusal, and seals nothing', async () => {
  const f = world();
  try {
    // The guard compares requests, not logins: a second login of the same account meets the earlier create, but a replacement must be
    // prepared on the login of the write it replaces, so the replacement is refused and the step stays as the guard held it.
    f.store.putConnection(
      owner,
      {
        id: 'second-login',
        tenantId: tenant,
        gateway,
        accounts: [f.world.id],
        writeAccounts: [f.world.id],
        enabled: true,
        label: 'Second synthetic login',
        scopes: [],
      },
      {accessToken: 'synthetic'},
    );
    const earlier = await loseAs(f, f.actor, false);
    const plan = await approvedPlan(f, f.actor, 'Second login plan', 'second-login');
    await heldBy(plan);
    assert.equal((await reconcile(f, earlier)).data.classification, 'appears_not_applied');
    // The replacement is tried (the earlier create is the actor's own, and freshly found not applied), is refused, and the step is held.
    await heldBy(plan);
    assert.deepEqual(
      refusedWrites(f).filter(code => code !== 'DUPLICATE_OF_UNCERTAIN_WRITE' && code !== 'WRITE_OUTCOME_UNCERTAIN'),
      ['INVALID_ARGUMENT'],
      'the replacement was refused by its own rule',
    );
    assert.equal((await status(f, earlier)).state, 'uncertain', 'nothing was sealed');
    assert.equal(f.sent.length, 1);
  } finally {
    f.close();
  }
});
test('an earlier create still being sent is waited for, never replaced', async () => {
  const f = world();
  try {
    // A review with a young claim and no answer: still being sent.
    const prepared = await f.prepare('campaign');
    f.store.claim(tenant, prepared.data.review_id, 'request');
    // Even a decisive record, written as a reconciliation of a create that was uncertain would, does not make it replaceable while it is being sent.
    f.store.putDocument(tenant, 'write_reconciliation', prepared.data.review_id, {
      review_id: prepared.data.review_id,
      reconciliation_id: 'synthetic-record',
      classification: 'appears_not_applied',
      checked_at: Date.now(),
    });
    const plan = await approvedPlan(f);
    await plan.call({action: 'prepare_next', id: plan.id});
    const waiting = await plan.call({action: 'prepare_next', id: plan.id});
    assert.equal(waiting.success, true, JSON.stringify(waiting).slice(0, 600));
    assert.equal(waiting.data.busy, true, JSON.stringify(waiting.data).slice(0, 500));
    assert.equal(stepOf(waiting).status, 'pending');
    assert.ok(waiting.data.retry_after_ms > 0);
    assert.equal(f.sent.length, 0);
    assert.deepEqual(
      refusedWrites(f).filter(code => code !== 'DUPLICATE_OF_UNCERTAIN_WRITE'),
      [],
      'no replacement was tried',
    );
  } finally {
    f.close();
  }
});
test('the words say what the step does now: the actor’s own create is replaced by prepare_next, a colleague’s where it was prepared', () => {
  const usual = duplicateReason('campaign', 'DUPLICATE_OF_UNCERTAIN_WRITE', false, true, {details: {}});
  assert.match(usual, /If it was not applied, prepare_next replaces it/);
  assert.match(usual, /If it was applied, accept that/);
  const colleagues = duplicateReason('campaign', 'DUPLICATE_OF_UNCERTAIN_WRITE', false, true, {
    details: {readable: false},
  });
  assert.match(colleagues, /ask them to replace it where it was prepared/);
  assert.doesNotMatch(colleagues, /prepare_next replaces it/);
  // A create AMCP cannot look up has nothing to reconcile, so it has no replacement to offer.
  const unreadable = duplicateReason('campaign', 'DUPLICATE_OF_UNCERTAIN_WRITE', false, true, {
    details: {earlier_checkable: false},
  });
  assert.doesNotMatch(unreadable, /replaces it/);
});

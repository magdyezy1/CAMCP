import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {googleWorld} from '../dist/tests/helpers/google-write-fake.js';
import {createPlan, on} from './helpers/google-policy-failure.mjs';
import {firstKeyword, keywordAction, keywordWorld, keywords, writesHolding} from './helpers/google-keyword-group.mjs';

/**
 * r25-field3-errors, the third re-review of 2026-11-22 (N1-c, S1; the same root as N1-b): a write group's own key is claimed after its parts ran, and each
 * part is claimed under its own, so a crash, a resume a deployment refused, or a part sent alone leaves a part sent and the group's key free. Every reader
 * of the plan runner that looked only at the group's key saw "never sent": continue_as_new carried the step, a resume refused before it was sent was
 * amended by recover_step, and the group's own "nothing of the group was sent" branch handed back the prepare of the whole group. Each time a second group
 * was prepared and its first part sent a record the provider already had. Synthetic customer 123; the keyword creates the fake reads back.
 */
const T = 'google-world',
  stepOf = operations => ({
    id: 'step1',
    kind: 'write',
    gateway: 'google_ads_native_action',
    connection_id: 'g',
    account_id: '123',
    description: 'step1',
    arguments: {action: 'google_ads_v23_' + keywordAction, payload: {operations}},
  }),
  stored = (x, id) => x.store.document(T, 'campaign_run', id),
  count = (x, kind) => x.store.db.prepare('SELECT count(*) AS n FROM documents WHERE kind=?').get(kind).n,
  claimOf = (x, key) =>
    x.store.db.prepare('SELECT state FROM idempotency WHERE tenant_id=? AND key=?').get(T, key)?.state,
  send = (x, review_id) =>
    x.call('amcp_write', {
      action: 'execute',
      review_id,
      idempotency_key: review_id,
      confirmed: true,
      spend_change_confirmed: true,
    }),
  resume = (x, id, review_id) =>
    x.call('amcp_campaign', {
      action: 'execute_next',
      id,
      review_id,
      idempotency_key: review_id,
      confirmed: true,
      spend_change_confirmed: true,
    }),
  recover = (x, id) => x.call('amcp_campaign', {action: 'recover_step', id, step_id: 'step1', confirmed: true}),
  carry = (x, id) => x.call('amcp_campaign', {action: 'continue_as_new', id, confirmed: true}),
  /** The state part 1 and part 2 read moved: the campaign and the ad group are enabled. */
  moveState = x => {
    for (const k of Object.keys(x.world.campaigns)) x.world.campaigns[k].status = 'ENABLED';
    for (const k of Object.keys(x.world.adGroups)) x.world.adGroups[k].status = 'ENABLED';
  },
  endWindow = (x, groupId, parts) => {
    const group = x.store.document(T, 'write_review_group', groupId);
    x.store.putDocument(T, 'write_review_group', groupId, {...group, expires_at: 1});
    for (const id of parts) {
      const part = x.store.document(T, 'write_review', id);
      x.store.putDocument(T, 'write_review', id, {...part, expires_at: 1});
    }
  };
/** A plan of 30 keywords, its group prepared, the step saved executing (the crash) and part 1 sent, as the deploy that stopped the process left it. */
async function crashedPlan() {
  const x = googleWorld({policy: on, world: keywordWorld()}),
    id = await createPlan(x, [stepOf(keywords(30))]);
  assert.equal((await x.call('amcp_campaign', {action: 'prepare_next', id})).success, true);
  const groupId = stored(x, id).steps[0].review_id,
    parts = x.store.document(T, 'write_review_group', groupId).parts,
    {id: _id, revision, ...run} = stored(x, id);
  assert.equal(parts.length, 2);
  run.steps[0].status = 'executing';
  run.state = 'in_progress';
  x.store.putDocument(T, 'campaign_run', id, run, revision);
  assert.equal((await send(x, parts[0])).data.executed, true);
  assert.equal(x.writes(), 1);
  return {x, id, groupId, parts};
}
/** Nothing was prepared or sent beyond the one part: the first record reached the provider once, and no second group or plan exists. */
function assertNothingMore(x, when) {
  assert.equal(x.writes(), 1, when + ': only part 1 ever reached the provider');
  assert.equal(writesHolding(x, firstKeyword), 1, when + ': the first record reached the provider once');
  assert.equal(count(x, 'write_review_group'), 1, when + ': no second group was prepared');
  assert.equal(count(x, 'campaign_run'), 1, when + ': no second plan was made');
}
/** A refusal that says the step is not safe to amend or carry. */
function assertNotSafe(refused, when) {
  assert.equal(refused.success, false, when + ' ' + JSON.stringify(refused).slice(0, 300));
  assert.equal(refused.error.code, 'RECOVERY_NOT_SAFE', when + ' ' + JSON.stringify(refused.error).slice(0, 300));
}

test('N1-c (a): continue_as_new does not carry the step a resume left uncertain, whose group has a part that was sent', async () => {
  const {x, id, groupId, parts} = await crashedPlan();
  try {
    endWindow(x, groupId, parts);
    await resume(x, id, groupId);
    assert.equal(stored(x, id).steps[0].status, 'uncertain', 'N1-b: the step is uncertain, not pending');
    const carried = await carry(x, id);
    assertNotSafe(carried, 'continue_as_new');
    assert.deepEqual(
      carried.error.details.blocked_steps.map(b => b.step_id),
      ['step1'],
      'the step that holds the sent part is the one it names',
    );
    assertNotSafe(await recover(x, id), 'recover_step');
    // Nothing the plan offers prepares or sends the group again.
    await x.call('amcp_campaign', {action: 'prepare_next', id});
    assert.equal(stored(x, id).steps[0].review_id, groupId, 'the step still holds the group that was sent');
    assertNothingMore(x, 'after continue_as_new, recover_step and prepare_next');
  } finally {
    x.store.close();
  }
});

test('N1-c (b): a resume the deployment refused before sending (writes disabled) does not make the step amendable: recover_step and continue_as_new are not safe', async () => {
  const {x, id, groupId} = await crashedPlan();
  try {
    // The owner turned the deployment read-only: the resume is refused by the service, before the group's own execute.
    x.service.policy.allowWrites = false;
    await resume(x, id, groupId);
    x.service.policy.allowWrites = true;
    const step = stored(x, id).steps[0];
    assert.equal(step.error.code, 'LIVE_WRITES_DISABLED');
    assert.equal(step.review_id, groupId);
    assertNotSafe(await recover(x, id), 'recover_step');
    assertNotSafe(await carry(x, id), 'continue_as_new');
    await x.call('amcp_campaign', {action: 'prepare_next', id});
    assert.equal(stored(x, id).steps[0].review_id, groupId, 'the step still holds the group that was sent');
    // The step does not say that it failed before reaching the provider: a part of it did.
    const read = await x.call('amcp_campaign', {action: 'get', id, step_id: 'step1'});
    assert.doesNotMatch(
      JSON.stringify(read),
      /failed before reaching the provider/,
      'the step is not described as unsent',
    );
    assertNothingMore(x, 'after the refusal, recover_step, continue_as_new and prepare_next');
  } finally {
    x.store.close();
  }
});

test('N1-c (c): part 2 sent alone, then part 1 refused for a changed state: the standalone group is a stopped group, never "nothing of the group was sent"', async () => {
  const x = googleWorld({policy: on, world: keywordWorld()});
  try {
    const group = await x.prepare(keywordAction, keywords(30)),
      groupId = group.data.review_id,
      parts = group.data.parts.map(p => p.review_id);
    assert.equal(group.data.group, true);
    assert.equal((await send(x, parts[1])).data.executed, true, 'part 2 is sent on its own, as its status offers');
    assert.equal(x.writes(), 1);
    moveState(x);
    // The group's execute: part 1 is refused before it is sent (its state moved); part 2 holds a claim.
    const stopped = await send(x, groupId);
    assert.equal(stopped.success, false, JSON.stringify(stopped).slice(0, 300));
    assert.equal(stopped.error.code, 'WRITE_PARTIAL_OR_FAILED', JSON.stringify(stopped.error).slice(0, 300));
    assert.equal(stopped.error.details.part_error, 'STATE_CHANGED');
    assert.equal(claimOf(x, groupId), 'uncertain', 'the group is stopped: its key is claimed, and never run again');
    assert.deepEqual(stopped.error.details.not_sent, [], 'part 2 holds a claim: it is not listed as not sent');
    assert.deepEqual(
      stopped.error.details.not_sent_parts.map(p => p.review_id),
      [parts[0]],
      'only the part with no claim is offered',
    );
    assert.ok(
      !/"action":"prepare"/.test(JSON.stringify(stopped.error.details)),
      'no prepare of the whole group is offered',
    );
    // Following what it names sends part 1 once and never part 2 again.
    const retry = await x.call(stopped.error.details.next_call.tool, {
      ...stopped.error.details.next_call.arguments,
      ...(stopped.error.details.next_call.add_after_user_approval ?? {}),
    });
    assert.equal(retry.error?.code, 'STATE_CHANGED', 'the part is refused again until it is prepared again');
    const again = retry.error.details.next_call;
    assert.equal(again.arguments.action, 'prepare');
    assert.equal(again.arguments.arguments.payload.operations.length, 25, 'part 1’s own 25 records');
    const prepared = await x.call(again.tool, again.arguments);
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 300));
    assert.notEqual(prepared.data.group, true, 'a review of 25 records, not a group');
    assert.equal((await send(x, prepared.data.review_id)).success, true);
    assert.equal(x.writes(), 2, 'part 2 once, part 1 once');
    assert.equal(writesHolding(x, 'synthetic keyword 25"'), 1, 'keyword 25 reached the provider once');
    assert.equal(writesHolding(x, firstKeyword), 1, 'keyword 0 reached the provider once');
    assert.equal(count(x, 'write_review_group'), 1, 'no second group was prepared');
  } finally {
    x.store.close();
  }
});

test('N1-c (c): part 2 sent alone, then part 1 refused for a changed state, in a plan: the step is uncertain, not pending, and no second group is prepared', async () => {
  const x = googleWorld({policy: on, world: keywordWorld()});
  try {
    const id = await createPlan(x, [stepOf(keywords(30))]);
    assert.equal((await x.call('amcp_campaign', {action: 'prepare_next', id})).success, true);
    const groupId = stored(x, id).steps[0].review_id,
      parts = x.store.document(T, 'write_review_group', groupId).parts;
    assert.equal(
      (await send(x, parts[1])).data.executed,
      true,
      'part 2 is sent on its own (a plan the policy does not govern)',
    );
    moveState(x);
    await resume(x, id, groupId);
    const step = stored(x, id).steps[0];
    assert.equal(step.status, 'uncertain', 'not pending: part 2 was sent');
    assert.equal(step.error.code, 'WRITE_PARTIAL_OR_FAILED');
    assert.equal(step.review_id, groupId);
    assertNotSafe(await carry(x, id), 'continue_as_new');
    assertNotSafe(await recover(x, id), 'recover_step');
    await x.call('amcp_campaign', {action: 'prepare_next', id});
    assert.equal(stored(x, id).steps[0].review_id, groupId, 'the step still holds the group that was sent');
    assert.equal(count(x, 'write_review_group'), 1, 'no second group was prepared');
    assert.equal(x.writes(), 1, 'only part 2 ever reached the provider');
    assert.equal(writesHolding(x, 'synthetic keyword 25"'), 1, 'keyword 25 reached the provider once');
    assert.equal(count(x, 'campaign_run'), 1, 'no second plan was made');
  } finally {
    x.store.close();
  }
});

test('the claim of a review as the plan reads it: the group’s key, else uncertain when a part holds a claim, rejected when only rejected parts do', async () => {
  const {reviewClaim} = await import('../dist/src/write-record-repository.js'),
    x = googleWorld({policy: on, world: keywordWorld()});
  try {
    const group = await x.prepare(keywordAction, keywords(30)),
      groupId = group.data.review_id,
      parts = group.data.parts.map(p => p.review_id),
      single = await x.prepare(keywordAction, keywords(3)),
      singleId = single.data.review_id,
      read = id => reviewClaim(x.store, T, id);
    assert.equal(read(groupId), undefined, 'a group none of whose parts holds a claim');
    assert.equal(read(parts[0]), undefined, 'a part with no claim');
    assert.equal(read(singleId), undefined, 'a review with no claim');
    assert.equal(read('no-such-review'), undefined);
    // A part that holds a claim, whatever its state, makes the group read uncertain: part of it may have reached the provider.
    x.store.claim(T, parts[0], 'fp0');
    assert.equal(read(groupId).state, 'uncertain', 'a pending part');
    assert.equal(read(parts[0]).state, 'pending', 'the part itself reads as it is');
    x.store.complete(T, parts[0], {success: true});
    assert.equal(read(groupId).state, 'uncertain', 'a part that completed');
    assert.ok(Number.isInteger(read(groupId).created_at), 'it dates the claim of its earliest part');
    // Only refused parts: nothing was applied, and the group reads as a refused one.
    x.store.db.prepare('DELETE FROM idempotency WHERE tenant_id=? AND key=?').run(T, parts[0]);
    x.store.claim(T, parts[1], 'fp1');
    assert.ok(x.store.rejected(T, parts[1], 'fp1'));
    assert.equal(read(groupId).state, 'rejected', 'only a rejected part holds a claim');
    // A rejected part and a part that was sent: the group is not a refused one.
    x.store.claim(T, parts[0], 'fp0');
    assert.equal(read(groupId).state, 'uncertain', 'a rejected part and a sent one');
    // The group's own key, once claimed, is the claim.
    x.store.claim(T, groupId, 'fpg');
    x.store.complete(T, groupId, {success: true});
    assert.equal(read(groupId).state, 'complete', 'the group’s own claim wins over its parts');
    // A review that is no group reads at its own key.
    x.store.claim(T, singleId, 'fps');
    assert.equal(read(singleId).state, 'pending');
  } finally {
    x.store.close();
  }
});

test('the plan runner reads whether a step’s review was sent in one place only: the claim of src/write-record-repository.ts reviewClaim', () => {
  const text = fs.readFileSync(new URL('../src/campaign-runner.ts', import.meta.url), 'utf8'),
    code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  // `assert.ok` with a regular expression: a failure must not print the whole source of the runner.
  assert.ok(!/\b(?:FROM|JOIN)\s+idempotency\b/i.test(code), 'no statement of its own on the claims');
  assert.ok(!/\bwriteClaim(?:ed|Fingerprint)?\b/.test(code), 'no read of the job repository’s claims');
  assert.equal(code.match(/\breviewClaim\(/g)?.length, 1, 'one call of the helper');
  assert.ok(
    /private claim\(actor: Actor, reviewId: unknown\): JsonObject \| undefined \{\s*return typeof reviewId === 'string' \? reviewClaim\(this\.store, actor\.tenantId, reviewId\) : undefined;\s*\}/.test(
      code,
    ),
    'and it is the body of the runner’s one claim reader',
  );
  assert.ok(/from '\.\/write-record-repository\.js'/.test(text), 'imported from the repository of the write records');
});

/**
 * r25-field3-errors, the fourth check (F4a, S4): the scan above sees raw statements and the claim helpers of the job repository, and passed a read of a group's
 * own key through `groupProgress(...).key`, which is the same read through a helper that says nothing of the group's parts. The runner may use the helpers of
 * the repository of the write records that are listed here, and may read the parts a progress holds, never the group's key it also carries: the key is
 * `undefined` for a group that was never run to its end, however many of its parts were sent.
 */
test('the plan runner never reads a write group’s own key: the repository helpers it takes are the listed ones, and no groupProgress result is read for its key', () => {
  const text = fs.readFileSync(new URL('../src/campaign-runner.ts', import.meta.url), 'utf8'),
    code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  const taken = /import\s*\{([^}]*)\}\s*from\s*'\.\/write-record-repository\.js'/
    .exec(code)?.[1]
    .split(',')
    .map(name => name.trim().replace(/^type\s+/, ''))
    .filter(Boolean)
    .sort();
  // r25-batch-merge (J1): `groupLeaseLive` joins the list. It reads the group's lease, a service lock, and no claim at all, so no claim of the group's own key is read through it;
  // the plan's reads ask it whether a call is still sending the group (src/campaign-runner.ts `groupLeased`).
  assert.deepEqual(
    taken,
    [
      'Retired',
      'Retirement',
      'groupLeaseLive',
      'groupProgress',
      'groupResumable',
      'reopenReview',
      'retireReview',
      'reviewClaim',
    ],
    'the helpers of the repository the runner may take',
  );
  assert.ok(/\bgroupProgress\(/.test(code), 'the scan sees the helper it checks');
  // The key of a progress, read where it is made...
  assert.ok(!/groupProgress\([^;]*\)\s*\??\.key\b/.test(code), 'no groupProgress(...).key');
  // ...or through the name it is bound to.
  const names = [...code.matchAll(/\b(?:const|let)\s+(\w+)\s*(?::[^=;]+)?=\s*groupProgress\(/g)].map(m => m[1]);
  assert.ok(names.length > 0, 'the scan sees the name a progress is bound to');
  for (const name of names)
    assert.ok(!new RegExp('\\b' + name + '\\s*\\??\\.key\\b').test(code), 'no ' + name + '.key');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {MirrorError, errorResult} from '../dist/src/errors.js';
import {standardCreates, standardBodies} from './helpers/tiktok-standard-creates.mjs';
import {advertiserWorld} from './helpers/tiktok-advertiser-noise.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * Round 2.5, package r25-m1-diff (L5-04, T2): a STATE_CHANGED that says what changed and what to do next. The check
 * itself is untouched: execute reads the provider's state again and refuses a review whose state is not the one it was
 * prepared on, before anything is claimed or sent. Only what the refusal tells the agent and the user is new: the fields
 * that matter (`material`) and the one call that prepares the same request again (`next_call`). Every case runs the real
 * review lifecycle (MirrorService, NativeTransport, the store) against a synthetic TikTok whose advertiser changes
 * between prepare and execute. No flag, auto-accept or automatic retry exists, and these tests keep it so.
 */
const currencyPath = '$[0]["data"]["list"][0]["currency"]';
const gateway = 'tiktok_native_action';

/** The call a person made to prepare the standard campaign create, as the refusal must hand it back. */
const preparedCall = world => ({
  tool: 'amcp_write',
  arguments: {
    action: 'prepare',
    gateway,
    connection_id: 'login',
    arguments: {
      action: standardBodies(world.id).campaign.action,
      account_id: world.id,
      payload: standardBodies(world.id).campaign.payload,
    },
  },
});

/** A prepared campaign create whose advertiser then changed currency: the refused execute, and the fixture. */
async function changedCurrency(tenant, body) {
  const world = advertiserWorld(),
    f = standardCreates(world, {tenant});
  try {
    const prepared = await f.prepare('campaign');
    assert.equal(prepared.success, true, JSON.stringify(prepared.error));
    world.currency = 'EUR';
    const refused = await f.execute(prepared.data);
    assertRefused(refused, 'STATE_CHANGED', {writes: () => f.sent.length});
    return await body({f, world, review: prepared.data, refused});
  } finally {
    f.close();
  }
}

test('a changed advertiser currency is refused with the field that matters named first', async () => {
  await changedCurrency('diff-material', ({refused}) => {
    const details = refused.error.details;
    // What the refusal always said: the hashes and every changed path.
    assert.deepEqual(details.changed_fields, [currencyPath]);
    assert.match(details.expected_state_hash, /^[0-9a-f]{64}$/);
    assert.match(details.actual_state_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(details.expected_state_hash, details.actual_state_hash);
    // What is new: the changed fields that matter, and the mark that nothing was claimed or sent (lead review S2-2).
    assert.deepEqual(details.material, [currencyPath]);
    assert.equal(details.submission, 'not_sent');
  });
});

test('the refusal hands back the exact call that prepares the same request again, and that call recovers the write', async () => {
  await changedCurrency('diff-next-call', async ({f, world, review, refused}) => {
    assert.deepEqual(refused.error.details.next_call, preparedCall(world));
    // The old review stays refused: its state is not the provider's any more.
    assertRefused(await f.execute(review), 'STATE_CHANGED', {writes: () => f.sent.length});
    // One call prepares it again, over the state as it is now; its answer shows the change the user must look at.
    const again = await f.write(refused.error.details.next_call.arguments);
    assert.equal(again.success, true, JSON.stringify(again.error));
    assert.notEqual(again.data.review_id, review.review_id);
    assert.equal(
      JSON.stringify(again.data.before_state).includes('"EUR"'),
      true,
      'the new review reads the new currency',
    );
    assert.equal(f.sent.length, 0, 'preparing again sends nothing');
    // Only the new review executes, and it sends exactly one write.
    const done = await f.execute(again.data);
    assert.equal(done.success, true, JSON.stringify(done.error));
    assert.equal(f.sent.length, 1);
  });
});

test('the refusal lists the changed target before the changed account, by the roles the reads of the review carry', async () => {
  const world = advertiserWorld(),
    f = standardCreates(world, {tenant: 'diff-roles'});
  try {
    // An ad group create reads the advertiser (the account), then the campaign it goes into (the parent).
    const prepared = await f.prepare('adgroup');
    assert.equal(prepared.success, true, JSON.stringify(prepared.error));
    const saved = f.store.document(f.tenant, 'write_review', prepared.data.review_id);
    assert.deepEqual(
      saved.reads.map(r => r.path),
      ['/v1.3/advertiser/info/', '/v1.3/campaign/get/'],
    );
    const statusPath = '$[1]["data"]["list"][0]["operation_status"]';
    world.currency = 'EUR';
    f.parents.campaign = 'ENABLE';
    // A read that carries no role is a target: every change matters, in the order the diff found it.
    const unlabelled = await f.execute(prepared.data);
    assertRefused(unlabelled, 'STATE_CHANGED', {writes: () => f.sent.length});
    assert.deepEqual(unlabelled.error.details.changed_fields, [currencyPath, statusPath]);
    assert.deepEqual(unlabelled.error.details.material, [currencyPath, statusPath]);
    // Once the reads are labelled (the hash package's `stateRole`: the advertiser the account, the campaign the parent), the
    // parent's change comes first, and the account's identity change after it. Neither is left out.
    f.store.putDocument(f.tenant, 'write_review', prepared.data.review_id, {
      ...saved,
      reads: [
        {...saved.reads[0], stateRole: 'account'},
        {...saved.reads[1], stateRole: 'parent'},
      ],
    });
    const labelled = await f.execute(prepared.data);
    assertRefused(labelled, 'STATE_CHANGED', {writes: () => f.sent.length});
    assert.deepEqual(labelled.error.details.changed_fields, [currencyPath, statusPath], 'the diff itself is the same');
    assert.deepEqual(labelled.error.details.material, [statusPath, currencyPath]);
  } finally {
    f.close();
  }
});

const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
/** What the refusal of a changed state must tell a reader, in this order, whatever its wording. */
const remedyMeaning = [
  /Nothing was sent/,
  /details\.material/,
  /details\.next_call/,
  /before_state/,
  /No flag skips this check/,
  /details\.recurring_paths/,
  /report those paths/,
];

test('the refusal says that nothing was sent, what to check, how to prepare again, and that no flag skips the check', async () => {
  await changedCurrency('diff-remedy', ({refused}) => {
    const {remedy, next_action: nextAction} = refused.error;
    assert.equal(remedy.category, 'state');
    assert.equal(remedy.mutation_retry_safe, false);
    for (const [what, text] of [
      ['remedy.action', remedy.action],
      ['next_action', nextAction],
    ])
      for (const part of remedyMeaning) assert.match(text, part, what);
  });
});

test('both words of the refusal are in Arabic, with the names of the fields and of the call kept', async () => {
  await changedCurrency('diff-remedy-ar', ({refused}) => {
    for (const english of new Set([refused.error.remedy.action, refused.error.next_action])) {
      const arabic = catalog[english];
      assert.equal(typeof arabic, 'string', 'no Arabic for: ' + english);
      assert.match(arabic, /[؀-ۿ]/u);
      for (const name of ['details.material', 'details.next_call', 'before_state', 'details.recurring_paths'])
        assert.ok(arabic.includes(name), name + ' in: ' + arabic);
    }
  });
});

test('a STATE_CHANGED that is not the refusal of the review check keeps its general remedy, which never says nothing was sent', () => {
  // The acceptance of a read-back that moved on (src/campaign-runner.ts) happens after the write was sent; a state read
  // that did not hold still (a family's) has no review check behind it. "Nothing was sent" is true of neither.
  const acceptance = new MirrorError(
      'STATE_CHANGED',
      'The state changed since that diff.',
      {field: 'actual_hash', step_id: 's1', actual_hash: 'h'},
      409,
    ),
    unsteady = new MirrorError('STATE_CHANGED', 'The feed changed while it was read. Prepare again.');
  for (const e of [acceptance, unsteady]) {
    const {error} = errorResult(e, 'request', 1);
    assert.equal(error.remedy.category, 'state');
    assert.equal(error.remedy.mutation_retry_safe, false);
    for (const text of [error.remedy.action, error.next_action]) assert.doesNotMatch(text, /Nothing was sent/);
    assert.ok(error.next_action);
  }
  // The review check is told apart by what it carries: the two hashes, the changed fields and the mark of a refusal
  // raised before anything was claimed (lead review S2-2). The mark is tested, not the shape alone.
  const shape = {expected_state_hash: 'a', actual_state_hash: 'b', changed_fields: ['$[0]["x"]']},
    review = new MirrorError('STATE_CHANGED', 'Changed.', {...shape, submission: 'not_sent'}),
    asReview = errorResult(review, 'request', 1).error;
  assert.match(asReview.remedy.action, /Nothing was sent/);
  assert.match(asReview.next_action, /Nothing was sent/);
  // The same fields without the mark (a resume refused after a claim) are not one that sent nothing: the agent is sent to
  // the status and the receipt, and told never to send it again blindly. The general remedy is not used for it either.
  const claimed = errorResult(new MirrorError('STATE_CHANGED', 'Changed.', shape), 'request', 1).error;
  assert.equal(claimed.remedy.category, 'state');
  assert.equal(claimed.remedy.mutation_retry_safe, false);
  for (const text of [claimed.remedy.action, claimed.next_action]) {
    assert.doesNotMatch(text, /Nothing was sent/i);
    assert.match(text, /status or receipt/);
    assert.match(text, /never send it again blindly/);
    assert.match(text, /No flag skips this check/);
  }
  assert.notEqual(claimed.remedy.action, asReview.remedy.action);
});

test('no flag skips the state check: every acknowledgement together still leaves the changed review refused', async () => {
  await changedCurrency('diff-no-flag', async ({f, review}) => {
    for (const flags of [
      {},
      {spend_change_confirmed: true},
      {spend_change_confirmed: true, cap_override_confirmed: true, destructive_confirmed: true},
    ])
      assertRefused(await f.execute(review, flags), 'STATE_CHANGED', {writes: () => f.sent.length});
    // A creative-edit acknowledgement cannot be added at execute either (it is refused as another gate, before the state).
    assertRefused(await f.execute(review, {creative_edit_confirmed: true}), 'REVIEW_CHANGED', {
      writes: () => f.sent.length,
    });
    // provider_check is an argument of prepare, and no value of it reaches execute.
    for (const provider_check of [true, false])
      assertRefused(await f.execute(review, {provider_check}), 'INVALID_ARGUMENT', {writes: () => f.sent.length});
    // The review itself is not spoiled by being refused: once the provider is as it was prepared, it executes.
    f.world.currency = 'USD';
    const done = await f.execute(review);
    assert.equal(done.success, true, JSON.stringify(done.error));
    assert.equal(f.sent.length, 1);
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {googleWorld} from '../dist/tests/helpers/google-write-fake.js';
import {createPlan, on} from './helpers/google-policy-failure.mjs';
import {firstKeyword, keywordAction, keywordWorld, keywords, writesHolding} from './helpers/google-keyword-group.mjs';

/**
 * r25-field3-errors, the third follow-up's sweep (the same root as N1-b and N1-c): prepare_next prepares a new review for a step that is pending, or whose
 * review expired, and read nothing of the review the step holds. A step whose review holds a claim (a write group a part of which was sent) was prepared
 * again, and its first part sent a record the provider already had. The path is reachable without a bug elsewhere: a resume after a crash is refused by
 * an owner's pause (the plan keeps the step ready, which is right), the pause outlasts the group's five minutes, and the plan is then asked for its next
 * call. A step whose review holds a claim is never prepared again: it is read, and the plan says what it can do. Synthetic customer 123.
 */
const T = 'google-world',
  step = operations => ({
    id: 'step1',
    kind: 'write',
    gateway: 'google_ads_native_action',
    connection_id: 'g',
    account_id: '123',
    description: 'step1',
    arguments: {action: 'google_ads_v23_' + keywordAction, payload: {operations}},
  }),
  stored = (x, id) => x.store.document(T, 'campaign_run', id),
  groups = x => x.store.db.prepare("SELECT count(*) AS n FROM documents WHERE kind='write_review_group'").get().n,
  pause = x =>
    x.store.putDocument(T, 'write_pause', 'workspace', {
      paused: true,
      scope: 'all',
      reason: 'synthetic pause',
      paused_by: 'owner',
      paused_at: Date.now(),
    }),
  unpause = x => x.store.repo('write_pause', T).delete('workspace'),
  executeNext = (x, id, review_id) =>
    x.call('amcp_campaign', {
      action: 'execute_next',
      id,
      review_id,
      idempotency_key: review_id,
      confirmed: true,
      spend_change_confirmed: true,
    }),
  endWindow = (x, planId, review, parts) => {
    for (const [kind, id] of [['write_review_group', review], ...parts.map(p => ['write_review', p])]) {
      const doc = x.store.document(T, kind, id);
      x.store.putDocument(T, kind, id, {...doc, expires_at: 1});
    }
    // The plan's own copy of the review carries its window too.
    const {id: _id, revision, ...run} = stored(x, planId);
    run.steps[0].review = {...run.steps[0].review, expires_at: new Date(1).toISOString()};
    x.store.putDocument(T, 'campaign_run', planId, run, revision);
  };

test('prepare_next never prepares a second group for a step whose group has a part that was sent: the resume was refused by a pause, and the window ended', async () => {
  const x = googleWorld({policy: on, world: keywordWorld()});
  try {
    const id = await createPlan(x, [step(keywords(30))]);
    assert.equal((await x.call('amcp_campaign', {action: 'prepare_next', id})).success, true);
    const review = stored(x, id).steps[0].review_id,
      parts = x.store.document(T, 'write_review_group', review).parts,
      {id: _id, revision, ...run} = stored(x, id);
    // The crash: the step was saved executing and part 1 was sent.
    run.steps[0].status = 'executing';
    run.state = 'in_progress';
    x.store.putDocument(T, 'campaign_run', id, run, revision);
    assert.equal(
      (
        await x.call('amcp_write', {
          action: 'execute',
          review_id: parts[0],
          idempotency_key: parts[0],
          confirmed: true,
          spend_change_confirmed: true,
        })
      ).data.executed,
      true,
    );
    // The owner has paused writes: the resume is refused before anything is claimed, and the step stays ready for the person.
    pause(x);
    await executeNext(x, id, review);
    unpause(x);
    assert.equal(stored(x, id).steps[0].status, 'review_ready');
    assert.equal(stored(x, id).steps[0].error.code, 'WRITES_PAUSED');
    assert.equal(x.writes(), 1);
    // The pause outlasts the group's window.
    endWindow(x, id, review, parts);
    const next = await x.call('amcp_campaign', {action: 'prepare_next', id});
    assert.equal(groups(x), 1, 'no second group was prepared');
    assert.equal(stored(x, id).steps[0].review_id, review, 'the step still holds the group that was sent');
    assert.equal(stored(x, id).steps[0].status, 'uncertain', 'it is read as a step whose outcome is not settled');
    assert.equal(next.data.blocked, true, JSON.stringify(next.error ?? next.data).slice(0, 300));
    assert.match(next.data.recovery, /windows have ended/, 'and the plan says what it can do');
    // Nothing the plan offers sends it again.
    await x.call('amcp_campaign', {action: 'prepare_next', id});
    await executeNext(x, id, review);
    assert.equal(x.writes(), 1, 'only part 1 ever reached the provider');
    assert.equal(writesHolding(x, firstKeyword), 1, 'the first record reached the provider once');
    assert.equal(groups(x), 1);
  } finally {
    x.store.close();
  }
});

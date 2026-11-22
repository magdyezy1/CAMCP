import test from 'node:test';
import assert from 'node:assert/strict';
import {googleWorld} from '../dist/tests/helpers/google-write-fake.js';
import {createPlan, on, signals, world as themeWorld} from './helpers/google-policy-failure.mjs';
import {firstKeyword, keywordAction, keywordWorld, keywords, writesHolding} from './helpers/google-keyword-group.mjs';

/**
 * r25-field3-errors, the second re-review of 2026-11-22 (N1-b, the duplicate-write guard): the execute of a write group read only the group's own key.
 * That key is claimed after the parts ran, and each part is claimed under its own key, so a crash or a deploy between the parts leaves a part sent and
 * the group's key free. Once the group's window ended, or too little of it was left, the execute said "nothing was submitted" and attached the prepare of
 * the whole group; a plan that resumed the step (execute_next) sent it back to pending, and prepare_next prepared the group again: the first record
 * reached the provider twice. A group any part of which holds a claim is refused as an uncertain outcome, never as an unsent one. Synthetic customer 123.
 */
// Keyword creates the fake reads back, so a part that was sent settles as applied; search themes it cannot read back, so such a part settles as failed.
const kinds = {
  'keywords': {action: keywordAction, world: keywordWorld, operations: keywords, first: firstKeyword},
  'search themes': {
    action: 'asset_group_signal_mutate_asset_group_signals',
    world: themeWorld,
    operations: n => Array.from({length: n}, (_, i) => signals('synthetic theme ' + i)[0]),
    first: 'synthetic theme 0"',
  },
};
const send = (x, review_id) =>
  x.call('amcp_write', {
    action: 'execute',
    review_id,
    idempotency_key: review_id,
    confirmed: true,
    spend_change_confirmed: true,
  });
const statusCall = review_id => ({tool: 'amcp_write', arguments: {action: 'status', review_id}});
/** The window of the group, and of each part, ended. */
function endWindow(x, groupId, parts) {
  const group = x.store.document('google-world', 'write_review_group', groupId);
  x.store.putDocument('google-world', 'write_review_group', groupId, {...group, expires_at: 1});
  for (const id of parts) {
    const part = x.store.document('google-world', 'write_review', id);
    x.store.putDocument('google-world', 'write_review', id, {...part, expires_at: 1});
  }
}
/** The refusal of a group a part of which was sent says no such thing as "nothing was submitted" and names no prepare. */
function assertUncertainRefusal(refused, groupId, when) {
  assert.equal(refused.success, false, when);
  assert.equal(refused.error.code, 'WRITE_OUTCOME_UNCERTAIN', when + ' ' + JSON.stringify(refused.error).slice(0, 300));
  assert.doesNotMatch(refused.error.message, /nothing was submitted|prepare the same request again/i, when);
  assert.match(refused.error.message, /Part of this review was sent under its parts’ own keys/, when);
  assert.match(refused.error.message, /never prepare the same change again/i, when);
  assert.deepEqual(refused.error.details.next_call, statusCall(groupId), when);
  assert.equal(refused.error.details.parts_claimed, 1, when);
  assert.ok(!/"action":"prepare"/.test(JSON.stringify(refused.error)), when + ': no call that prepares anything');
}

for (const [label, kind] of Object.entries(kinds))
  for (const age of ['fresh', 'eleven minutes old'])
    test(
      'a plan that resumes a group of ' +
        label +
        ' whose part 1 was sent (claim ' +
        age +
        ') after its window does not prepare it again',
      async () => {
        const x = googleWorld({policy: on, world: kind.world()}),
          step = {
            id: 'step1',
            kind: 'write',
            gateway: 'google_ads_native_action',
            connection_id: 'g',
            account_id: '123',
            description: 'step1',
            arguments: {action: 'google_ads_v23_' + kind.action, payload: {operations: kind.operations(30)}},
          };
        try {
          const id = await createPlan(x, [step]),
            stored = () => x.store.document('google-world', 'campaign_run', id),
            prepared = await x.call('amcp_campaign', {action: 'prepare_next', id});
          assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 400));
          const groupId = stored().steps[0].review_id,
            parts = x.store.document('google-world', 'write_review_group', groupId).parts;
          assert.equal(parts.length, 2);
          // The crash: the step was saved executing, and part 1 was sent.
          const {id: _id, revision, ...run} = stored();
          run.steps[0].status = 'executing';
          run.state = 'in_progress';
          x.store.putDocument('google-world', 'campaign_run', id, run, revision);
          assert.equal((await send(x, parts[0])).data.executed, true);
          assert.equal(x.writes(), 1);
          if (age !== 'fresh')
            x.store.db
              .prepare('UPDATE idempotency SET created_at=? WHERE tenant_id=? AND key=?')
              .run(Date.now() - 11 * 60000, 'google-world', parts[0]);
          endWindow(x, groupId, parts);
          // The plan resumes the step.
          await x.call('amcp_campaign', {
            action: 'execute_next',
            id,
            review_id: groupId,
            idempotency_key: groupId,
            confirmed: true,
            spend_change_confirmed: true,
          });
          const step1 = stored().steps[0];
          assert.equal(step1.status, 'uncertain', 'the step is uncertain, not pending');
          assert.equal(step1.error.code, 'WRITE_OUTCOME_UNCERTAIN');
          assertUncertainRefusal({success: false, error: step1.error}, groupId, 'the step’s error');
          // The plan does not prepare the group again, and nothing more is sent.
          await x.call('amcp_campaign', {action: 'prepare_next', id});
          assert.equal(stored().steps[0].review_id, groupId, 'the step still holds the group that was sent');
          assert.equal(stored().steps[0].status, 'uncertain');
          assert.equal(
            x.store.db.prepare("SELECT count(*) AS n FROM documents WHERE kind='write_review_group'").get().n,
            1,
            'no second group was prepared',
          );
          assert.equal(x.writes(), 1, 'nothing more reached the provider');
          assert.equal(writesHolding(x, kind.first), 1, 'the first record reached the provider once');
          // The status of the group the step holds (the second re-review, choice 3): a plan's group is not finished by a prepare outside the plan.
          const read = (await x.call('amcp_write', {action: 'status', review_id: groupId})).data;
          assert.equal(read.state, 'uncertain');
          assert.ok(
            !/"action":"prepare"/.test(JSON.stringify([read.next_call, read.parts])),
            'no prepare of the group or of a part',
          );
          if (label === 'keywords') {
            // Every part that was sent applied: the change is read in its plan.
            assert.deepEqual(read.next_call, {tool: 'amcp_campaign', arguments: {action: 'get', id, step_id: 'step1'}});
            assert.equal(read.parts[1].next_call, undefined);
            assert.match(read.next_safe_action, /step of a plan/);
          } else assert.deepEqual(read.next_call, statusCall(parts[0]), 'a part whose receipt failed is read');
        } finally {
          x.store.close();
        }
      },
    );

// The documented resume of a plan after a crash or a deploy, while the review is still open: the group's execute replays the part that was sent, which is
// never sent twice, and sends the parts not sent once. A part whose receipt failed is never sent again, and nothing after it is.
for (const [label, kind] of Object.entries(kinds))
  test(
    'a plan that resumes a group of ' +
      label +
      ' whose part 1 was sent, while its review is open, never sends part 1 again',
    async () => {
      const x = googleWorld({policy: on, world: kind.world()}),
        step = {
          id: 'step1',
          kind: 'write',
          gateway: 'google_ads_native_action',
          connection_id: 'g',
          account_id: '123',
          description: 'step1',
          arguments: {action: 'google_ads_v23_' + kind.action, payload: {operations: kind.operations(30)}},
        };
      try {
        const id = await createPlan(x, [step]),
          stored = () => x.store.document('google-world', 'campaign_run', id);
        assert.equal((await x.call('amcp_campaign', {action: 'prepare_next', id})).success, true);
        const groupId = stored().steps[0].review_id,
          parts = x.store.document('google-world', 'write_review_group', groupId).parts,
          {id: _id, revision, ...run} = stored();
        run.steps[0].status = 'executing';
        run.state = 'in_progress';
        x.store.putDocument('google-world', 'campaign_run', id, run, revision);
        assert.equal((await send(x, parts[0])).data.executed, true);
        assert.equal(x.writes(), 1);
        await x.call('amcp_campaign', {
          action: 'execute_next',
          id,
          review_id: groupId,
          idempotency_key: groupId,
          confirmed: true,
          spend_change_confirmed: true,
        });
        assert.equal(writesHolding(x, kind.first), 1, 'the first record reached the provider once');
        if (label === 'keywords') {
          assert.equal(x.writes(), 2, 'part 1 replayed, part 2 sent once');
          assert.equal(stored().steps[0].status, 'verified');
          assert.equal(stored().steps[0].review_id, groupId);
        } else {
          // The fake cannot read a search theme back, so part 1's receipt failed: the group stops at it, and part 2 is not sent.
          assert.equal(x.writes(), 1, 'nothing more was sent after a part whose receipt failed');
          assert.equal(stored().steps[0].status, 'uncertain');
        }
      } finally {
        x.store.close();
      }
    },
  );

test('a standalone group a part of which was sent is refused as uncertain after its window, and in a short window, with no prepare and no "nothing was submitted"', async () => {
  const kind = kinds.keywords,
    x = googleWorld({policy: on, world: kind.world()});
  try {
    const group = await x.prepare(kind.action, kind.operations(30)),
      groupId = group.data.review_id,
      parts = group.data.parts.map(p => p.review_id);
    assert.equal(group.data.group, true);
    assert.equal((await send(x, parts[0])).data.executed, true);
    // A short window: the group's own window is left (more than five seconds), but the second part cannot have the seconds it needs.
    const live = x.store.document('google-world', 'write_review_group', groupId);
    x.store.putDocument('google-world', 'write_review_group', groupId, {
      ...live,
      slowest_prepare_ms: 20000,
      expires_at: Date.now() + 60000,
    });
    const second = x.store.document('google-world', 'write_review', parts[1]);
    x.store.putDocument('google-world', 'write_review', parts[1], {...second, expires_at: Date.now() + 20000});
    assertUncertainRefusal(await send(x, groupId), groupId, 'in a short window');
    // After its window.
    endWindow(x, groupId, parts);
    assertUncertainRefusal(await send(x, groupId), groupId, 'after its window');
    assert.equal(x.writes(), 1, 'nothing more was sent');
    assert.equal(writesHolding(x, kind.first), 1);
  } finally {
    x.store.close();
  }
});

test('a group no part of which holds a claim is still refused as unsent: expired or short of time, with the prepare of the whole group; a released claim is no claim', async () => {
  const kind = kinds.keywords,
    x = googleWorld({policy: on, world: kind.world()});
  try {
    const group = await x.prepare(kind.action, kind.operations(30)),
      groupId = group.data.review_id,
      parts = group.data.parts.map(p => p.review_id);
    // A claim that was released before anything was sent (a refusal before dispatch) is no claim.
    x.store.claim('google-world', parts[0], 'fingerprint');
    x.store.release('google-world', parts[0], 'fingerprint', {code: 'WRITES_PAUSED'});
    const live = x.store.document('google-world', 'write_review_group', groupId);
    x.store.putDocument('google-world', 'write_review_group', groupId, {
      ...live,
      slowest_prepare_ms: 20000,
      expires_at: Date.now() + 60000,
    });
    const first = x.store.document('google-world', 'write_review', parts[0]);
    x.store.putDocument('google-world', 'write_review', parts[0], {...first, expires_at: Date.now() + 20000});
    const short = await send(x, groupId);
    assert.equal(short.error.code, 'REVIEW_EXPIRED', JSON.stringify(short.error).slice(0, 300));
    assert.match(short.error.message, /Nothing was submitted; prepare the same request again/);
    assert.equal(short.error.details.next_call.arguments.action, 'prepare');
    assert.equal(short.error.details.part, 1);
    endWindow(x, groupId, parts);
    const expired = await send(x, groupId);
    assert.equal(expired.error.code, 'REVIEW_EXPIRED');
    assert.match(expired.error.message, /nothing was submitted/);
    assert.equal(expired.error.details.next_call.arguments.action, 'prepare');
    assert.equal(x.writes(), 0);
  } finally {
    x.store.close();
  }
});

test('the time a resume needs is counted for the parts not sent only: a part that was sent needs no seconds of its own', async () => {
  const kind = kinds.keywords,
    x = googleWorld({policy: on, world: kind.world()});
  try {
    const group = await x.prepare(kind.action, kind.operations(30)),
      groupId = group.data.review_id,
      parts = group.data.parts.map(p => p.review_id);
    assert.equal((await send(x, parts[0])).data.executed, true);
    // Each part is given 40 seconds. Part 1 was sent and has 10 seconds of its window left; part 2, the only one still to send, has 60.
    const live = x.store.document('google-world', 'write_review_group', groupId);
    x.store.putDocument('google-world', 'write_review_group', groupId, {
      ...live,
      slowest_prepare_ms: 20000,
      expires_at: Date.now() + 60000,
    });
    const first = x.store.document('google-world', 'write_review', parts[0]),
      second = x.store.document('google-world', 'write_review', parts[1]);
    x.store.putDocument('google-world', 'write_review', parts[0], {...first, expires_at: Date.now() + 10000});
    x.store.putDocument('google-world', 'write_review', parts[1], {...second, expires_at: Date.now() + 60000});
    const resumed = await send(x, groupId);
    assert.equal(resumed.success, true, JSON.stringify(resumed.error ?? resumed).slice(0, 400));
    assert.equal(resumed.data.parts.length, 2);
    assert.equal(x.writes(), 2, 'part 1 replayed, part 2 sent once');
    assert.equal(writesHolding(x, kind.first), 1, 'the first record reached the provider once');
  } finally {
    x.store.close();
  }
});

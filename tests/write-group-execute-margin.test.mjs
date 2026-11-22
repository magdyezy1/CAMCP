import test from 'node:test';
import assert from 'node:assert/strict';
import {googleWorld} from '../dist/tests/helpers/google-write-fake.js';
import {on} from './helpers/google-policy-failure.mjs';
import {keywordAction, keywordWorld, keywords} from './helpers/google-keyword-group.mjs';

/**
 * r25-field3-errors, the third re-review of 2026-11-22 (S4-a): a write group's execute is refused when its window ends within five seconds (src/write-groups.ts),
 * and the status of a group in doubt offers that execute, or the execute of a part, only while it can be made (src/write-records.ts groupExecuteMarginMs).
 * Nothing pinned the margin: a status that offered the group's execute with two seconds left sent the person to a call that is refused, which sends nothing.
 * Synthetic customer 123; a group of 30 keywords (two parts of 25 and 5), part 1 applied.
 */
const T = 'google-world',
  statusOf = async (x, id) => (await x.call('amcp_write', {action: 'status', review_id: id})).data,
  /** The window of the group, and of each part named, to end `ms` from now. */
  endsIn = (x, group, ms, parts = {}) => {
    const doc = x.store.document(T, 'write_review_group', group);
    x.store.putDocument(T, 'write_review_group', group, {...doc, expires_at: Date.now() + ms});
    for (const [id, left] of Object.entries(parts)) {
      const part = x.store.document(T, 'write_review', id);
      x.store.putDocument(T, 'write_review', id, {...part, expires_at: Date.now() + left});
    }
  },
  /** A standalone group whose part 1 was sent and applied: the group is in doubt, resumable while its window lasts. */
  withPartOneApplied = async () => {
    const x = googleWorld({policy: on, world: keywordWorld()}),
      group = await x.prepare(keywordAction, keywords(30)),
      groupId = group.data.review_id,
      parts = group.data.parts.map(p => p.review_id),
      sent = await x.call('amcp_write', {
        action: 'execute',
        review_id: parts[0],
        idempotency_key: parts[0],
        confirmed: true,
        spend_change_confirmed: true,
      });
    assert.equal(sent.data.executed, true);
    return {x, groupId, parts};
  };

test('the status offers the group’s execute only while its window is more than five seconds from ending; inside the margin, the part not sent is sent on its own', async () => {
  const {x, groupId, parts} = await withPartOneApplied();
  try {
    // Ten seconds left: the group's execute resumes it, replaying part 1 and sending part 2.
    endsIn(x, groupId, 10000);
    const open = await statusOf(x, groupId);
    assert.equal(open.state, 'uncertain');
    assert.equal(open.next_call.arguments.action, 'execute');
    assert.equal(open.next_call.arguments.review_id, groupId, 'the group’s own execute');
    // Three seconds left, inside the margin: that execute is refused before anything is sent, so it is not offered. Part 2 has its own window.
    endsIn(x, groupId, 3000);
    const inside = await statusOf(x, groupId);
    assert.equal(inside.state, 'uncertain');
    assert.equal(inside.next_call.arguments.action, 'execute');
    assert.equal(inside.next_call.arguments.review_id, parts[1], 'part 2’s own execute, not the group’s');
    assert.notEqual(inside.next_call.arguments.review_id, groupId);
    // The call it offered for the group inside the margin is refused, as the status says, and sends nothing.
    const refused = await x.call('amcp_write', {
      action: 'execute',
      review_id: groupId,
      idempotency_key: groupId,
      confirmed: true,
      spend_change_confirmed: true,
    });
    assert.equal(
      refused.error?.code,
      'WRITE_OUTCOME_UNCERTAIN',
      JSON.stringify(refused.error ?? refused).slice(0, 300),
    );
    assert.equal(x.writes(), 1, 'only part 1 was ever sent');
  } finally {
    x.store.close();
  }
});

test('and the same margin governs the part: its own execute is offered while its window is more than five seconds from ending, and its prepare after', async () => {
  const {x, groupId, parts} = await withPartOneApplied();
  try {
    // The group's window has ended: each part not sent is sent on its own.
    endsIn(x, groupId, -1000, {[parts[1]]: 60000});
    const live = await statusOf(x, groupId);
    assert.equal(live.next_call.arguments.action, 'execute');
    assert.equal(live.next_call.arguments.review_id, parts[1], 'part 2 has a minute');
    endsIn(x, groupId, -1000, {[parts[1]]: 3000});
    const inside = await statusOf(x, groupId);
    assert.equal(
      inside.next_call.arguments.action,
      'prepare',
      'part 2 has three seconds: its records are prepared again',
    );
    assert.equal(
      inside.next_call.arguments.arguments.payload.operations.length,
      5,
      'part 2’s own five records, never the whole 30',
    );
    const row = inside.parts.find(p => p.review_id === parts[1]);
    assert.equal(row.next_call.arguments.action, 'prepare');
    assert.equal(x.writes(), 1);
  } finally {
    x.store.close();
  }
});

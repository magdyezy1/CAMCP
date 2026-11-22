import test from 'node:test';
import assert from 'node:assert/strict';
import {operationsPage} from '../dist/src/operations-feed.js';
import {pendingUncertainMs, writeRecordState} from '../dist/src/write-records.js';
import {admin, googleWorld} from '../dist/tests/helpers/google-write-fake.js';
import {action, on, signals, world} from './helpers/google-policy-failure.mjs';

/**
 * r25-field3-errors, the lead re-review of 2026-11-22 (N1, the duplicate-write guard): a write group is claimed only after its parts ran, and each
 * part is claimed under its own key. Between the parts, or after a crash between them, the group's own key has no claim while a part of it is sent,
 * and `amcp_write status` read the group by that key alone: "Prepared and not executed" until its window ended, then "Nothing was submitted and the
 * review expired. Prepare the same request again", with the whole group's prepare as the call. The group is judged by its parts now, as its journal is
 * (tests/provider-validation-errors.test.mjs). Synthetic customer 123.
 */
const operations = (label = 'synthetic theme ') => Array.from({length: 30}, (_, i) => signals(label + i)[0]);
const statusOf = async (x, id) => (await x.call('amcp_write', {action: 'status', review_id: id})).data;
/** The group's window ends: the group's own record, as the clock would have left it. */
function expire(x, id) {
  const group = x.store.document('google-world', 'write_review_group', id);
  x.store.putDocument('google-world', 'write_review_group', id, {...group, expires_at: 1});
}
/** A 30-operation group (two parts) of which part 1 was sent alone, as after a crash between the parts. */
async function sentGroup() {
  const x = googleWorld({policy: on, world: world()}),
    group = await x.prepare(action, operations());
  assert.equal(group.data.group, true, JSON.stringify(group).slice(0, 400));
  const [first, second] = group.data.parts,
    sent = await x.call('amcp_write', {
      action: 'execute',
      review_id: first.review_id,
      idempotency_key: first.review_id,
      confirmed: true,
      spend_change_confirmed: true,
    });
  // The fake models no read-back of a search theme, so the receipt is `partial_or_failed`; the write itself was sent.
  assert.equal(sent.data.executed, true, JSON.stringify(sent).slice(0, 400));
  assert.equal(x.writes(), 1, 'one part reached the provider');
  return {x, id: group.data.review_id, first, second};
}
const statusCall = review_id => ({tool: 'amcp_write', arguments: {action: 'status', review_id}});

test('the status of a write group a part of which was sent never says nothing was submitted and never prepares it again, before or after its window', async () => {
  const {x, id, first, second} = await sentGroup();
  try {
    for (const when of ['live', 'expired']) {
      if (when === 'expired') expire(x, id);
      const s = await statusOf(x, id);
      assert.equal(s.state, 'uncertain', when);
      assert.doesNotMatch(s.next_safe_action, /Nothing was submitted|Prepared and not executed|expired/, when);
      assert.match(s.next_safe_action, /part/i, when);
      assert.match(s.next_safe_action, /never prepare/i, when);
      // Each part's state is named, and the part that was sent has its own status call.
      assert.equal(s.parts.length, 2);
      assert.equal(s.parts[0].review_id, first.review_id);
      assert.notEqual(s.parts[0].state, 'unsubmitted', when);
      assert.equal(s.parts[1].review_id, second.review_id);
      assert.deepEqual(s.parts[0].next_call, statusCall(first.review_id), when);
      assert.equal(s.parts[1].next_call, undefined, 'a part nothing of which was sent has nothing to read');
      assert.equal(s.claim.state, 'none');
      assert.equal(s.claim.parts_claimed, 1);
      // The call is the status of the part to read: a read, never a prepare, and never the group's execute.
      assert.deepEqual(s.next_call, statusCall(first.review_id), when);
      const calls = JSON.stringify([s.next_call, s.parts]);
      assert.ok(!/"action":"prepare"|"action":"execute"|"action":"reconcile"/.test(calls), when + ' ' + calls);
      assert.ok(!JSON.stringify(s).includes('synthetic theme 0'), 'no request text comes back in the group’s status');
      assert.equal(x.writes(), 1, 'a status sends nothing');
    }
  } finally {
    x.store.close();
  }
});

test('the call to read is the status of the part that was sent, whichever part it was: the second alone is read as the first alone is', async () => {
  const x = googleWorld({policy: on, world: world()}),
    group = await x.prepare(action, operations('second theme '));
  try {
    const [first, second] = group.data.parts,
      sent = await x.call('amcp_write', {
        action: 'execute',
        review_id: second.review_id,
        idempotency_key: second.review_id,
        confirmed: true,
        spend_change_confirmed: true,
      });
    assert.equal(sent.data.executed, true, JSON.stringify(sent).slice(0, 400));
    assert.equal(x.writes(), 1, 'one part reached the provider');
    for (const when of ['live', 'expired']) {
      if (when === 'expired') expire(x, group.data.review_id);
      const s = await statusOf(x, group.data.review_id);
      assert.equal(s.state, 'uncertain', when);
      assert.equal(s.claim.parts_claimed, 1, when);
      // The part that was not sent has its state and no call; the part that was sent has the call that reads it, and the group offers the same call.
      assert.equal(s.parts[0].review_id, first.review_id);
      assert.equal(s.parts[0].next_call, undefined, when);
      assert.deepEqual(s.parts[1].next_call, statusCall(second.review_id), when);
      assert.deepEqual(s.next_call, statusCall(second.review_id), when);
      assert.ok(!/"action":"prepare"|"action":"execute"|"action":"reconcile"/.test(JSON.stringify(s.next_call)), when);
    }
  } finally {
    x.store.close();
  }
});

test('a group nothing of which was sent reads as it always did: unsubmitted with its execute, then expired with its prepare; a released claim is no part sent', async () => {
  const x = googleWorld({policy: on, world: world()});
  try {
    const group = await x.prepare(action, operations('untouched theme ')),
      id = group.data.review_id;
    let s = await statusOf(x, id);
    assert.equal(s.state, 'unsubmitted');
    assert.equal(s.next_call.arguments.action, 'execute');
    assert.equal(s.claim.parts_claimed, undefined);
    // A claim of a part released before anything was sent (a refusal before dispatch) is not a part sent.
    x.store.claim('google-world', group.data.parts[0].review_id, 'fingerprint');
    x.store.release('google-world', group.data.parts[0].review_id, 'fingerprint', {code: 'WRITES_PAUSED'});
    s = await statusOf(x, id);
    assert.equal(s.state, 'unsubmitted');
    expire(x, id);
    s = await statusOf(x, id);
    assert.equal(s.state, 'expired');
    assert.match(s.next_safe_action, /Nothing was submitted/);
    assert.equal(s.next_call.arguments.action, 'prepare');
  } finally {
    x.store.close();
  }
});

test('a part still being sent makes the group executing, and its claim left pending for ten minutes makes it uncertain', async () => {
  const x = googleWorld({policy: on, world: world()});
  try {
    const group = await x.prepare(action, operations('pending theme ')),
      id = group.data.review_id,
      part = group.data.parts[0].review_id;
    x.store.claim('google-world', part, 'fingerprint');
    let s = await statusOf(x, id);
    assert.equal(s.state, 'executing');
    assert.deepEqual(s.next_call, statusCall(id), 'read this status again in a moment; never execute it twice');
    assert.match(s.next_safe_action, /never execute it twice/);
    x.store.db
      .prepare('UPDATE idempotency SET created_at=? WHERE tenant_id=? AND key=?')
      .run(Date.now() - pendingUncertainMs - 1000, 'google-world', part);
    s = await statusOf(x, id);
    assert.equal(s.state, 'uncertain');
    assert.deepEqual(s.next_call, statusCall(part));
  } finally {
    x.store.close();
  }
});

test('the Operations projection judges a group by its parts too: attention, never expired or unsubmitted, once a part was sent', async () => {
  const {x, id} = await sentGroup();
  try {
    const row = () => operationsPage(x.store, admin, {kind: 'write'}, true).operations.find(o => o.id === id);
    assert.equal(row().state, 'uncertain');
    assert.equal(row().category, 'attention');
    expire(x, id);
    assert.equal(row().state, 'uncertain', 'the window is not what decides it');
    // The same projection of a group nothing of which was sent.
    const untouched = await x.prepare(action, operations('feed theme ')),
      other = () =>
        operationsPage(x.store, admin, {kind: 'write'}, true).operations.find(o => o.id === untouched.data.review_id);
    assert.equal(other().state, 'unsubmitted');
    expire(x, untouched.data.review_id);
    assert.equal(other().state, 'expired');
  } finally {
    x.store.close();
  }
});

test('writeRecordState judges a group with no claim of its own by its parts, and its own claim still decides first', () => {
  const group = {expires_at: 1, claim_state: undefined};
  assert.equal(writeRecordState({...group, parts_claimed: 0}), 'expired', 'no part sent: nothing was submitted');
  assert.equal(writeRecordState({...group, parts_claimed: 1}), 'uncertain', 'a part sent, the window over');
  assert.equal(writeRecordState({...group, expires_at: Date.now() + 60000, parts_claimed: 2}), 'uncertain');
  const now = Date.now();
  assert.equal(writeRecordState({...group, parts_claimed: 1, parts_pending_at: now - 1000}, now), 'executing');
  assert.equal(
    writeRecordState({...group, parts_claimed: 1, parts_pending_at: now - pendingUncertainMs - 1}, now),
    'uncertain',
  );
  assert.equal(writeRecordState({...group, claim_state: 'complete', parts_claimed: 2}), 'complete');
  assert.equal(writeRecordState({...group, claim_state: 'uncertain', parts_claimed: 1}), 'uncertain');
});

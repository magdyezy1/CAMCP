import test from 'node:test';
import assert from 'node:assert/strict';
import {operationsPage} from '../dist/src/operations-feed.js';
import {pendingUncertainMs, writeRecordState} from '../dist/src/write-records.js';
import {admin, googleWorld} from '../dist/tests/helpers/google-write-fake.js';
import {action, expectedRow, on, signals, world} from './helpers/google-policy-failure.mjs';
import {firstKeyword, keywordAction, keywordWorld, keywords, writesHolding} from './helpers/google-keyword-group.mjs';

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

// The second re-review's T1: the guard's in-doubt cases, each claim a part can hold. A part claimed and then left uncertain (a request that timed out
// when it was sent alone) or rejected (a refusal that applied nothing) is a part that holds a claim, and the group reads as one that may have been
// sent, before and after its window. A group that read unsubmitted, and after its window expired with the whole group's prepare, would be the
// duplicate the guard exists to prevent.
/** A part's claim in the state a crash or a provider's answer left it in. */
function claimPart(x, part, state) {
  x.store.claim('google-world', part, 'fingerprint');
  if (state === 'uncertain') x.store.uncertain('google-world', part);
  if (state === 'rejected') x.store.rejected('google-world', part, 'fingerprint', {code: 'WRITE_REJECTED'});
  if (state === 'released') x.store.release('google-world', part, 'fingerprint', {code: 'WRITES_PAUSED'});
}
for (const state of ['uncertain', 'rejected'])
  test(
    'a group a part of which holds a claim marked ' +
      state +
      ' reads uncertain before and after its window, with the status of that part',
    async () => {
      const x = googleWorld({policy: on, world: world()});
      try {
        const group = await x.prepare(action, operations(state + ' theme ')),
          id = group.data.review_id,
          part = group.data.parts[0].review_id;
        claimPart(x, part, state);
        for (const when of ['live', 'expired']) {
          if (when === 'expired') expire(x, id);
          const s = await statusOf(x, id);
          assert.equal(s.state, 'uncertain', state + ' ' + when);
          assert.equal(s.claim.state, 'none', 'the group’s own key has no claim');
          assert.equal(s.claim.parts_claimed, 1, state + ' ' + when);
          assert.equal(s.parts[0].review_id, part);
          assert.equal(s.parts[0].state, state, 'the part says what its claim holds');
          assert.deepEqual(s.parts[0].next_call, statusCall(part), state + ' ' + when);
          assert.equal(s.parts[1].next_call, undefined, 'the part nothing of which was sent has no call');
          assert.deepEqual(s.next_call, statusCall(part), state + ' ' + when);
          assert.doesNotMatch(
            s.next_safe_action,
            /Nothing was submitted|Prepared and not executed/,
            state + ' ' + when,
          );
          assert.ok(
            !/"action":"prepare"|"action":"execute"|"action":"reconcile"/.test(JSON.stringify([s.next_call, s.parts])),
            state + ' ' + when + ': a read, never a prepare, an execute or a reconcile',
          );
        }
      } finally {
        x.store.close();
      }
    },
  );

test('the Operations projection reads each claim a part can hold: pending fresh executing, pending for ten minutes, uncertain and rejected attention, a released claim none', async () => {
  const x = googleWorld({policy: on, world: world()});
  try {
    const row = id => operationsPage(x.store, admin, {kind: 'write'}, true).operations.find(o => o.id === id),
      groups = {};
    for (const [name, claim] of [
      ['pending', 'pending'],
      ['stale', 'pending'],
      ['uncertain', 'uncertain'],
      ['rejected', 'rejected'],
      ['released', 'released'],
    ]) {
      const group = await x.prepare(action, operations(name + ' feed theme ')),
        part = group.data.parts[0].review_id;
      claimPart(x, part, claim);
      if (name === 'stale')
        x.store.db
          .prepare('UPDATE idempotency SET created_at=? WHERE tenant_id=? AND key=?')
          .run(Date.now() - pendingUncertainMs - 1000, 'google-world', part);
      groups[name] = group.data.review_id;
    }
    // The window is not what decides it: each is read live, and again after its window.
    const read = () => Object.fromEntries(Object.entries(groups).map(([name, id]) => [name, row(id)]));
    let rows = read();
    assert.equal(rows.pending.state, 'executing');
    assert.notEqual(rows.pending.category, 'attention', 'a part being sent is not yet a case for a person');
    for (const name of ['stale', 'uncertain', 'rejected']) {
      assert.equal(rows[name].state, 'uncertain', name);
      assert.equal(rows[name].category, 'attention', name);
    }
    assert.equal(rows.released.state, 'unsubmitted', 'a released claim is no claim');
    for (const id of Object.values(groups)) expire(x, id);
    rows = read();
    assert.equal(rows.pending.state, 'executing', 'expired');
    for (const name of ['stale', 'uncertain', 'rejected']) {
      assert.equal(rows[name].state, 'uncertain', name + ' expired');
      assert.equal(rows[name].category, 'attention', name + ' expired');
    }
    assert.equal(rows.released.state, 'expired', 'nothing of it was sent');
  } finally {
    x.store.close();
  }
});

// The second re-review's choice 2 and 3: a group whose sent parts all applied is not a case to stop at. While its review is open it is resumed by its own
// execute (the applied parts replay and are never sent twice, the parts not sent are sent once); once its window has ended each part not sent has its own
// call, the prepare of its own records. Any other part in doubt (pending, uncertain, rejected, a failed receipt) is read, never executed again.
const send = (x, review_id) =>
  x.call('amcp_write', {
    action: 'execute',
    review_id,
    idempotency_key: review_id,
    confirmed: true,
    spend_change_confirmed: true,
  });
/** A 30-keyword group (two parts: 25 and 5) of which part 1 was sent alone and settled as applied, as after a crash between the parts. */
async function appliedGroup() {
  const x = googleWorld({policy: on, world: keywordWorld()}),
    group = await x.prepare(keywordAction, keywords(30)),
    parts = group.data.parts.map(p => p.review_id);
  assert.equal(group.data.group, true, JSON.stringify(group).slice(0, 400));
  assert.equal((await send(x, parts[0])).data.executed, true);
  assert.equal(x.writes(), 1, 'one part reached the provider');
  return {x, id: group.data.review_id, parts};
}
/** The window of the group, and of each of its parts, ended. */
function endWindow(x, id, parts) {
  expire(x, id);
  for (const part of parts) {
    const review = x.store.document('google-world', 'write_review', part);
    x.store.putDocument('google-world', 'write_review', part, {...review, expires_at: 1});
  }
}
test('a group whose sent parts all applied is resumed by its own execute while its review is open: only the parts not sent are sent, once', async () => {
  const {x, id, parts} = await appliedGroup();
  try {
    const s = await statusOf(x, id);
    assert.equal(s.state, 'uncertain');
    assert.equal(s.claim.parts_claimed, 1);
    assert.equal(s.parts[0].state, 'complete');
    assert.equal(s.parts[1].state, 'unsubmitted');
    // The call is the group's execute, after the user approves.
    assert.equal(s.next_call.tool, 'amcp_write');
    assert.deepEqual(s.next_call.arguments, {action: 'execute', review_id: id});
    assert.deepEqual(s.next_call.add_after_user_approval, {confirmed: true});
    assert.match(s.next_safe_action, /replayed, never sent twice/);
    assert.match(s.next_safe_action, /only the parts not sent are sent/);
    assert.match(s.next_safe_action, /never prepare the same change again/i);
    assert.doesNotMatch(s.next_safe_action, /Nothing was submitted|Nothing is prepared or sent again for you/);
    // Each part that was sent keeps the call that reads it; the part not sent is sent by the group's execute, so it has none.
    assert.deepEqual(s.parts[0].next_call, statusCall(parts[0]));
    assert.equal(s.parts[1].next_call, undefined);
    // Following the call: part 1 is replayed, part 2 is sent once, and the group reads complete.
    const done = await x.call('amcp_write', {...s.next_call.arguments, ...s.next_call.add_after_user_approval});
    assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 400));
    assert.equal(done.data.parts.length, 2);
    assert.equal(x.writes(), 2, 'one write moved from 1 to 2');
    assert.equal(writesHolding(x, firstKeyword), 1, 'the first keyword is in exactly one write body');
    assert.equal((await statusOf(x, id)).state, 'complete');
    assert.equal((await send(x, id)).data.replayed, true, 'a second execute replays');
    assert.equal(x.writes(), 2);
  } finally {
    x.store.close();
  }
});

for (const [label, claim] of [
  ['pending (still being sent)', 'pending'],
  ['pending for over ten minutes', 'stale'],
  ['uncertain', 'uncertain'],
  ['rejected', 'rejected'],
])
  test(
    'a group part 1 of which holds a claim ' + label + ' is never offered its execute, before or after its window',
    async () => {
      const x = googleWorld({policy: on, world: keywordWorld()});
      try {
        const group = await x.prepare(keywordAction, keywords(30)),
          id = group.data.review_id,
          parts = group.data.parts.map(p => p.review_id);
        claimPart(x, parts[0], claim === 'stale' ? 'pending' : claim);
        if (claim === 'stale')
          x.store.db
            .prepare('UPDATE idempotency SET created_at=? WHERE tenant_id=? AND key=?')
            .run(Date.now() - pendingUncertainMs - 1000, 'google-world', parts[0]);
        for (const when of ['live', 'expired']) {
          if (when === 'expired') endWindow(x, id, parts);
          const s = await statusOf(x, id);
          assert.equal(s.next_call.arguments.action, 'status', label + ' ' + when);
          assert.ok(
            !/"action":"execute"|"action":"prepare"|"action":"reconcile"/.test(JSON.stringify([s.next_call, s.parts])),
            label + ' ' + when,
          );
        }
        assert.equal(x.writes(), 0, 'a status sends nothing');
      } finally {
        x.store.close();
      }
    },
  );

test('a part of which only a failed receipt was recorded is read, not executed again, before or after the group’s window', async () => {
  const {x, id, first} = await sentGroup();
  try {
    for (const when of ['live', 'expired']) {
      if (when === 'expired') expire(x, id);
      const s = await statusOf(x, id);
      assert.equal(s.parts[0].state, 'failed');
      assert.deepEqual(s.next_call, statusCall(first.review_id), when);
      assert.ok(!/"action":"execute"|"action":"prepare"/.test(JSON.stringify([s.next_call, s.parts])), when);
    }
  } finally {
    x.store.close();
  }
});

test('once the window has ended and every sent part applied, each part not sent carries its own call: the prepare of its own records, never the whole group', async () => {
  const {x, id, parts} = await appliedGroup();
  try {
    endWindow(x, id, parts);
    const s = await statusOf(x, id);
    assert.equal(s.state, 'uncertain');
    assert.equal(s.parts[1].state, 'expired');
    const call = s.parts[1].next_call;
    assert.equal(call.tool, 'amcp_write');
    assert.equal(call.arguments.action, 'prepare');
    // Its own five records (keywords 25 to 29), none of the 25 that were sent.
    assert.deepEqual(call.arguments.arguments.payload.operations, keywords(30).slice(25));
    assert.ok(!JSON.stringify(call).includes(firstKeyword), 'no record that was sent comes again');
    assert.deepEqual(s.parts[0].next_call, statusCall(parts[0]), 'the part that was sent keeps its read');
    assert.deepEqual(s.next_call, call, 'the group offers the first part not sent');
    assert.match(s.next_safe_action, /each part not sent is sent on its own/);
    assert.match(s.next_safe_action, /never prepare the whole change again/i);
    assert.doesNotMatch(s.next_safe_action, /Nothing is prepared or sent again for you|Nothing was submitted/);
    // Following it: the five records are prepared as a review of their own, which the user approves and executes. The first keyword is sent once.
    const prepared = await x.call('amcp_write', call.arguments);
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 400));
    assert.equal(prepared.data.group, undefined, 'five records are one review, not a group');
    assert.equal((await x.execute(prepared)).success, true);
    assert.equal(x.writes(), 2);
    assert.equal(writesHolding(x, firstKeyword), 1);
  } finally {
    x.store.close();
  }
});

test('a group whose own key holds a claim is not resumed by its execute, which refuses it; the part not sent has its own call', async () => {
  const {x, id, parts} = await appliedGroup();
  try {
    // The stopped group: its own key is claimed uncertain.
    x.store.claim('google-world', id, 'group-fingerprint');
    x.store.uncertain('google-world', id);
    const s = await statusOf(x, id);
    assert.equal(s.state, 'uncertain');
    assert.equal(s.claim.state, 'uncertain');
    assert.notDeepEqual(s.next_call.arguments, {action: 'execute', review_id: id});
    assert.equal(s.next_call.arguments.action, 'execute');
    assert.equal(s.next_call.arguments.review_id, parts[1], 'the part not sent, on its own, while its review lasts');
    assert.deepEqual(s.parts[1].next_call, s.next_call);
    assert.equal((await send(x, id)).error.code, 'WRITE_OUTCOME_UNCERTAIN', 'the group’s execute refuses it');
  } finally {
    x.store.close();
  }
});

// The second re-review's S4-c: a part whose claim is only `rejected` (the provider refused it and applied nothing, its key is retired) keeps the group
// among the cases that need a person, but nothing of the change reached the provider as a change, so the sentence no longer says it may have.
test('a group whose only claimed part the provider rejected says nothing of it was applied, keeps the attention state and names that part’s status for its rows', async () => {
  const x = googleWorld({policy: on, world: world()});
  try {
    const group = await x.prepare(action, operations('refused theme ')),
      id = group.data.review_id,
      part = group.data.parts[0].review_id;
    x.store.claim('google-world', part, 'fingerprint');
    x.store.rejected(
      'google-world',
      part,
      'fingerprint',
      {code: 'WRITE_REJECTED', http_status: 400},
      {provider_errors: [expectedRow]},
    );
    for (const when of ['live', 'expired']) {
      if (when === 'expired') expire(x, id);
      const s = await statusOf(x, id);
      assert.equal(s.state, 'uncertain', 'the attention state: ' + when);
      assert.doesNotMatch(s.next_safe_action, /may have reached the provider|Nothing was submitted/, when);
      assert.match(s.next_safe_action, /without applying it/, when);
      assert.match(s.next_safe_action, /nothing of this change was applied/, when);
      assert.match(s.next_safe_action, /never executed/, when);
      assert.deepEqual(s.next_call, statusCall(part), when);
      assert.ok(!/"action":"execute"|"action":"prepare"/.test(JSON.stringify([s.next_call, s.parts])), when);
      // The status of that part carries the rows the provider named.
      const read = await statusOf(x, part);
      assert.equal(read.state, 'rejected');
      assert.equal(read.last_error.provider_errors[0].enum, 'SEARCH_THEME_POLICY_VIOLATION');
    }
  } finally {
    x.store.close();
  }
});

test('a group of which one part applied and another was rejected keeps the careful sentence and reads the part that did not apply first', async () => {
  const {x, id, parts} = await appliedGroup();
  try {
    x.store.claim('google-world', parts[1], 'fingerprint');
    x.store.rejected('google-world', parts[1], 'fingerprint', {code: 'WRITE_REJECTED', http_status: 400});
    const s = await statusOf(x, id);
    assert.equal(s.state, 'uncertain');
    assert.equal(s.claim.parts_claimed, 2);
    assert.match(s.next_safe_action, /may have reached the provider/, 'a part was applied');
    assert.deepEqual(s.next_call, statusCall(parts[1]), 'the part that did not apply is the one to read');
    assert.ok(!/"action":"execute"|"action":"prepare"/.test(JSON.stringify([s.next_call, s.parts])));
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

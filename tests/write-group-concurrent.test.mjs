import test from 'node:test';
import assert from 'node:assert/strict';
import {googleBudgetFixture} from './fixtures/google-budget-writes.mjs';
import {googleWorld} from '../dist/tests/helpers/google-write-fake.js';
import {createPlan, on} from './helpers/google-policy-failure.mjs';
import {keywordAction, keywordWorld, keywords} from './helpers/google-keyword-group.mjs';
import * as groups from '../dist/src/write-groups.js';

/**
 * r25-mf-groups, the audit of 2026-11-25, finding 3: a second execute of a write group that was still being sent was told "2 parts were not
 * sent" while the first sent them, then claimed the group's own key uncertain, so the first, which had sent every part, ended
 * WRITE_OUTCOME_UNCERTAIN and the group (and the plan that held it) stayed stuck with nothing to recover it. The group now sends under a lease
 * (src/write-groups.ts groupLock): a second execute is refused as busy before it claims anything, and names the status read. 30 synthetic
 * budgets are two parts, of 25 and 5.
 */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const statusOf = id => ({tool: 'amcp_write', arguments: {action: 'status', review_id: id}});
const leases = f => f.store.db.prepare("SELECT key FROM service_locks WHERE key LIKE 'write-group:%'").all();
const claims = f => f.store.db.prepare('SELECT key,state FROM idempotency ORDER BY created_at').all();
/** A group of 30 budget creates, prepared; the writes of the provider wait at a gate until `release()`. */
async function gated(f) {
  const prepared = await f.creates(30, 5000000);
  assert.equal(prepared.data?.group, true, JSON.stringify(prepared).slice(0, 400));
  let release;
  const gate = new Promise(resolve => (release = resolve));
  f.hooks.beforeWrite = () => gate;
  return {id: prepared.data.review_id, parts: prepared.data.parts.map(p => p.review_id), release};
}
const writing = async (f, n = 1) => {
  while (f.writes.length < n) await sleep(5);
};

test('a second execute of a group that is being sent is refused as busy, says it sent nothing, names the status read, and the first sends every part once', async () => {
  const f = googleBudgetFixture();
  try {
    const {id, release} = await gated(f);
    const first = f.execute(id);
    await writing(f);
    const claimed = claims(f);
    const second = await f.execute(id);
    assert.equal(second.success, false);
    assert.equal(second.error.code, 'STATE_BUSY', JSON.stringify(second.error).slice(0, 500));
    assert.deepEqual(second.error.details.next_call, statusOf(id));
    assert.equal(second.error.details.review_id, id);
    assert.equal(second.error.category, 'state');
    assert.match(
      second.error.next_action,
      /write group.*sent nothing.*status/,
      'the remedy is the group’s own, not the target lock’s',
    );
    // It never says of the parts that they were not sent: another call is sending them.
    assert.doesNotMatch(second.error.message, /were not sent|was not sent|not sent/i);
    assert.match(second.error.message, /another call/i);
    assert.match(second.error.message, /sent nothing/i);
    assert.equal(f.writes.length, 1, 'the refused call sent nothing');
    assert.deepEqual(claims(f), claimed, 'and claimed nothing: not the groupâ€™s key, not a partâ€™s');
    assert.equal(leases(f).length, 1, 'the first call still holds the lease');
    release();
    const done = await first;
    assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 500));
    assert.equal(done.data.parts.length, 2);
    assert.equal(f.writes.length, 2, 'both parts were sent once each');
    assert.equal(f.claim(id).state, 'complete', 'the groupâ€™s receipt was recorded by the call that sent it');
    assert.equal(leases(f).length, 0, 'the lease is released');
    // Whoever asks next is given the receipt; nothing is sent again.
    f.hooks.beforeWrite = undefined;
    const again = await f.execute(id);
    assert.equal(again.success, true);
    assert.equal(again.data.replayed, true);
    assert.equal(f.writes.length, 2);
    assert.equal(f.claim(id).state, 'complete', 'a refused or replayed call never moves a completed group');
  } finally {
    f.close();
  }
});

test('a refused second call changes nothing a status can read: the group is not uncertain while it is sent, and the first callâ€™s answer is the groupâ€™s own', async () => {
  const f = googleBudgetFixture();
  try {
    const {id, release} = await gated(f);
    const first = f.execute(id);
    await writing(f);
    for (let i = 0; i < 3; i++) assert.equal((await f.execute(id)).error?.code, 'STATE_BUSY');
    const status = await f.write({action: 'status', review_id: id});
    assert.equal(status.success, true);
    assert.notEqual(status.data.claim.state, 'uncertain', 'no call marked the group uncertain');
    release();
    assert.equal((await first).success, true);
    assert.equal(f.writes.length, 2);
    assert.equal((await f.write({action: 'status', review_id: id})).data.state, 'complete');
  } finally {
    f.close();
  }
});

test('the lease is released when the group stops, and a group that stopped is refused as uncertain, never as busy', async () => {
  const f = googleBudgetFixture();
  try {
    const prepared = await f.creates(30, 5000000),
      id = prepared.data.review_id;
    // The second part's answer is lost: part 1 applied, part 2 uncertain.
    f.hooks.respond = body => {
      if (f.writes.length === 2) throw new TypeError('synthetic lost response');
      return undefined;
    };
    const stopped = await f.execute(id);
    assert.equal(stopped.error?.code, 'WRITE_OUTCOME_UNCERTAIN', JSON.stringify(stopped.error).slice(0, 400));
    assert.equal(f.writes.length, 2);
    assert.equal(leases(f).length, 0, 'the lease is released after a stop');
    f.hooks.respond = undefined;
    const again = await f.execute(id);
    assert.equal(again.error?.code, 'WRITE_OUTCOME_UNCERTAIN', 'a stopped group is read, never sent again');
    assert.equal(f.writes.length, 2);
    // A group refused before anything was sent releases it too.
    const refused = await f.creates(30, 5000000, 'Other'),
      other = refused.data.review_id;
    f.store.putDocument(f.actor.tenantId, 'write_review_group', other, {
      ...f.store.document(f.actor.tenantId, 'write_review_group', other),
      expires_at: 1,
    });
    assert.equal((await f.execute(other)).error?.code, 'REVIEW_EXPIRED');
    assert.equal(leases(f).length, 0, 'a refusal that sent nothing releases the lease');
    assert.equal(f.writes.length, 2);
  } finally {
    f.close();
  }
});

test('a lease whose holder died blocks the group only until it lapses; a live one blocks it with nothing claimed or sent', async () => {
  const f = googleBudgetFixture();
  try {
    const prepared = await f.creates(30, 5000000),
      id = prepared.data.review_id,
      key = groups.groupLock(f.actor.tenantId, id);
    assert.equal(f.store.acquireLock(key, 'a-process-that-died', 120000), true);
    const blocked = await f.execute(id);
    assert.equal(blocked.error?.code, 'STATE_BUSY', JSON.stringify(blocked.error).slice(0, 400));
    assert.deepEqual(blocked.error.details.next_call, statusOf(id));
    assert.equal(f.writes.length, 0);
    assert.deepEqual(claims(f), [], 'nothing was claimed');
    // The holder never comes back: its lease lapses, and the group is sent once.
    f.store.db.prepare('UPDATE service_locks SET expires_at=? WHERE key=?').run(Date.now() - 1, key);
    const done = await f.execute(id);
    assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 400));
    assert.equal(f.writes.length, 2);
    assert.equal(leases(f).length, 0);
  } finally {
    f.close();
  }
});

// A plan whose step is a group (synthetic Google, 30 keywords: a group of two parts, which the fake reads back, so a part that was sent settles as applied).
const T = 'google-world',
  planStep = {
    id: 'step1',
    kind: 'write',
    gateway: 'google_ads_native_action',
    connection_id: 'g',
    account_id: '123',
    description: 'step1',
    arguments: {action: 'google_ads_v23_' + keywordAction, payload: {operations: keywords(30)}},
  },
  executeNext = (x, id, review_id) =>
    x.call('amcp_campaign', {
      action: 'execute_next',
      id,
      review_id,
      idempotency_key: review_id,
      confirmed: true,
      spend_change_confirmed: true,
    }),
  stepOf = (x, id) => x.store.document(T, 'campaign_run', id).steps[0];

test('a plan whose group step is executed twice at once is not stuck: the second call waits, the group is sent once, and the next call settles the step from its receipt', async () => {
  const x = googleWorld({policy: on, world: keywordWorld()});
  try {
    const id = await createPlan(x, [planStep]);
    assert.equal((await x.call('amcp_campaign', {action: 'prepare_next', id})).success, true);
    const group = stepOf(x, id).review_id,
      parts = x.store.document(T, 'write_review_group', group).parts;
    assert.equal(parts.length, 2);
    let release;
    const gate = new Promise(resolve => (release = resolve));
    x.hooks.beforeWrite = () => gate;
    const first = executeNext(x, id, group);
    while (x.writes() < 1) await sleep(5);
    const second = await executeNext(x, id, group);
    // Refused before anything was claimed: the step waits, ready, with the refusal on it; it is not uncertain, and the plan names the call that goes on.
    assert.equal(second.success, true, JSON.stringify(second.error ?? second).slice(0, 500));
    assert.equal(stepOf(x, id).status, 'review_ready', JSON.stringify(stepOf(x, id)).slice(0, 400));
    assert.equal(stepOf(x, id).error.code, 'STATE_BUSY');
    assert.deepEqual(stepOf(x, id).error.details.next_call, statusOf(group));
    assert.equal(x.writes(), 1, 'the second call sent nothing');
    release();
    await first;
    x.hooks.beforeWrite = undefined;
    assert.equal(x.writes(), 2, 'both parts were sent, once each');
    assert.equal(
      x.store.db.prepare('SELECT state FROM idempotency WHERE tenant_id=? AND key=?').get(T, group).state,
      'complete',
    );
    // The plan is not stuck: whatever the first call managed to save, the step is not uncertain, and executing it again replays the group's receipt.
    assert.notEqual(stepOf(x, id).status, 'uncertain');
    const again = await executeNext(x, id, group);
    assert.equal(again.success, true, JSON.stringify(again.error ?? again).slice(0, 500));
    assert.equal(stepOf(x, id).status, 'verified', JSON.stringify(stepOf(x, id)).slice(0, 400));
    assert.equal(x.writes(), 2, 'the keywords were created once');
  } finally {
    x.store.close();
  }
});

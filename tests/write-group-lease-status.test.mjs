import test from 'node:test';
import assert from 'node:assert/strict';
import {googleBudgetFixture} from './fixtures/google-budget-writes.mjs';
import {groupLeaseLive, groupLock} from '../dist/src/write-record-repository.js';

/**
 * r25-mf-groups, the Opus review (S3-3): while another call holds a write group's lease the group is being sent, whatever its claims say so far. Its
 * status, and the status of each part nothing has claimed yet, read `executing` and name the status read: never "execute it again" (the group's own
 * `group_resumable`), and never a direct execute of an unsent part, which would send it beside the group's own call. `groupLeaseLive` is the one
 * place that says whether a group's lease is live. 30 synthetic budgets are two parts, of 25 and 5.
 */
const statusOf = id => ({tool: 'amcp_write', arguments: {action: 'status', review_id: id}});
const sendsAnything = value => /"action":"(?:execute|prepare|reconcile)"/.test(JSON.stringify(value));

test('a group whose lease is live reads executing, and so does each part not yet claimed; nothing offers an execute', async () => {
  const f = googleBudgetFixture();
  try {
    const group = await f.creates(30, 5000000),
      id = group.data.review_id,
      [one, two] = group.data.parts.map(p => p.review_id),
      tenant = f.actor.tenantId,
      status = review_id => f.write({action: 'status', review_id}).then(r => r.data),
      lease = groupLock(tenant, id);
    // Part 1 was sent on its own: the group is in doubt, and while nobody sends it its execute is the call (as it was).
    assert.equal((await f.execute(one)).success, true);
    const idle = await status(id);
    assert.equal(idle.state, 'uncertain');
    assert.equal(idle.next_call.arguments.action, 'execute', 'nobody is sending: execute resumes it');
    assert.equal((await status(two)).next_call.arguments.action, 'execute');
    assert.equal(groupLeaseLive(f.store, tenant, id), false);

    // Another call holds the lease: the group is being sent.
    assert.equal(f.store.acquireLock(lease, 'the-sender', 120000), true);
    assert.equal(groupLeaseLive(f.store, tenant, id), true);
    const live = await status(id);
    assert.equal(live.state, 'executing', JSON.stringify(live).slice(0, 400));
    assert.deepEqual(live.next_call, statusOf(id));
    assert.match(live.next_safe_action, /being sent now/);
    assert.equal(
      sendsAnything([live.next_call, live.parts]),
      false,
      'no execute, prepare or reconcile is offered: ' + JSON.stringify(live.parts),
    );
    assert.deepEqual(
      live.parts.map(p => p.part),
      [1, 2],
    );
    assert.notEqual(live.parts[0].state, 'executing', 'part 1 was applied and says so');
    assert.equal(live.parts[1].state, 'executing', 'part 2 is not claimed yet and is about to be sent');
    // The part's own status: the same, and never a direct execute of it.
    const part = await status(two);
    assert.equal(part.state, 'executing');
    assert.deepEqual(part.next_call, statusOf(two));
    assert.match(part.next_safe_action, /being sent now/);
    assert.notEqual((await status(one)).state, 'executing', 'a part that holds its claim keeps its own state');

    // The holder never comes back: the lease lapses, and the reads are as they were.
    f.store.db.prepare('UPDATE service_locks SET expires_at=? WHERE key=?').run(Date.now() - 1, lease);
    assert.equal(groupLeaseLive(f.store, tenant, id), false, 'a lapsed lease is no lease');
    const lapsed = await status(id);
    assert.equal(lapsed.state, 'uncertain');
    assert.equal(lapsed.next_call.arguments.action, 'execute');
    assert.equal((await status(two)).next_call.arguments.action, 'execute');
  } finally {
    f.close();
  }
});

test('the lease belongs to one group: another group of the workspace is not live, and is not read as executing', async () => {
  const f = googleBudgetFixture();
  try {
    const sending = await f.creates(30, 5000000),
      other = await f.creates(30, 5000000, 'Other'),
      tenant = f.actor.tenantId;
    assert.equal(f.store.acquireLock(groupLock(tenant, sending.data.review_id), 'the-sender', 120000), true);
    assert.equal(groupLeaseLive(f.store, tenant, sending.data.review_id), true);
    assert.equal(groupLeaseLive(f.store, tenant, other.data.review_id), false);
    assert.notEqual(groupLock(tenant, sending.data.review_id), groupLock(tenant, other.data.review_id));
    assert.equal((await f.write({action: 'status', review_id: other.data.review_id})).data.state, 'unsubmitted');
    assert.equal(
      (await f.write({action: 'status', review_id: other.data.parts[1].review_id})).data.state,
      'unsubmitted',
    );
    assert.equal(
      groupLeaseLive(f.store, 'another-workspace', sending.data.review_id),
      false,
      'nor is it another workspace’s',
    );
  } finally {
    f.close();
  }
});

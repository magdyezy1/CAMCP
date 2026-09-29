import test from 'node:test';
import assert from 'node:assert/strict';
import type {JsonObject} from '../src/types.js';
import {actor, bytes, campaignStep, createPlan, fixture, squadPlan, squadStep} from './snapchat-plan-fixture.js';

/**
 * The owner's item 5 (2026-09-29): a 19-step build needed 19 approvals. A plan can now be approved once: approve
 * shows what the approval covers, approve with confirmed records it for that exact plan, and run prepares and
 * executes every step under it, each still a frozen review with its own state check, idempotency key and read-back.
 */
const approveAndRun = async (f: ReturnType<typeof fixture>, id: string, spend = true) => {
  const summary = (await f.call('amcp_campaign', {action: 'approve', id})).data;
  const approved = await f.call('amcp_campaign', {
    ...summary.next_call.arguments,
    ...(spend ? summary.next_call.add_after_user_approval : {}),
  });
  assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 600));
  return {summary, approved, ran: await f.call('amcp_campaign', {action: 'run', id})};
};

test('an 11-step plan is approved once and run in one call', async () => {
  const f = fixture();
  try {
    const id = (await createPlan(f, squadPlan(11))).data.id;
    const summary = (await f.call('amcp_campaign', {action: 'approve', id})).data;
    // What the approval covers: every step, with the money and status fields it sets.
    assert.equal(summary.approval.steps.length, 11);
    const squad = summary.approval.steps.find((s: JsonObject) => s.id === 'squad_1');
    assert.deepEqual(squad.spend, [
      {field: '/payload/adsquads/0/bid_strategy', value: 'AUTO_BID'},
      {field: '/payload/adsquads/0/daily_budget_micro', value: 179260000},
    ]);
    assert.deepEqual(squad.status, [{field: '/payload/adsquads/0/status', value: 'PAUSED'}]);
    assert.deepEqual(summary.next_call.add_after_user_approval, {spend_change_confirmed: true});
    assert.equal(f.writes.length, 0);
    const {ran} = await approveAndRun(f, id);
    assert.equal(ran.success, true, JSON.stringify(ran).slice(0, 800));
    assert.equal(ran.data.state, 'complete');
    assert.equal(ran.data.run.stopped, 'complete');
    assert.equal(ran.data.run.executed.length, 11);
    assert.equal(f.writes.length, 11);
    assert.ok(bytes(ran) <= 12 * 1024, String(bytes(ran)));
    const events = (
      f.store.db.prepare('SELECT event FROM audit WHERE tenant_id=?').all(actor.tenantId) as {event: string}[]
    ).map(r => JSON.parse(r.event));
    assert.ok(events.some(e => e.event === 'campaign_plan_approved' && e.steps === 11));
    // Running again sends nothing.
    const again = await f.call('amcp_campaign', {action: 'run', id});
    assert.equal(again.data.run.stopped, 'complete');
    assert.equal(f.writes.length, 11);
  } finally {
    f.close();
  }
});

test('run needs a current approval for this exact plan', async () => {
  const f = fixture({pixels: ['pixel-own']});
  try {
    const id = (await createPlan(f, squadPlan(3))).data.id;
    const unapproved = await f.call('amcp_campaign', {action: 'run', id});
    assert.equal(unapproved.error.code, 'APPROVAL_REQUIRED');
    assert.equal(unapproved.error.details.next_call.arguments.action, 'approve');
    const summary = (await f.call('amcp_campaign', {action: 'approve', id})).data;
    const stale = await f.call('amcp_campaign', {...summary.next_call.arguments, plan_hash: 'not-the-plan'});
    assert.equal(stale.error.code, 'PLAN_CHANGED');
    assert.equal(f.writes.length, 0);
  } finally {
    f.close();
  }
});

test('an approval without the spending acknowledgement stops at the first budget', async () => {
  const f = fixture();
  try {
    const id = (await createPlan(f, squadPlan(3))).data.id;
    const {ran} = await approveAndRun(f, id, false);
    assert.equal(ran.data.run.stopped, 'needs_spend_change_confirmed');
    assert.deepEqual(ran.data.run.executed, ['campaign']);
    assert.equal(ran.data.step_id, 'squad_1');
    assert.ok(ran.data.review, 'the review the user must see');
    assert.equal(f.writes.length, 1);
  } finally {
    f.close();
  }
});

test('amending a step voids the approval', async () => {
  const pixels = ['pixel-own', 'pixel-2'];
  const f = fixture({pixels});
  try {
    const id = (await createPlan(f, [campaignStep(), squadStep(1), squadStep(2, {}, {pixel_id: 'pixel-2'})])).data.id;
    const summary = (await f.call('amcp_campaign', {action: 'approve', id})).data;
    await f.call('amcp_campaign', {...summary.next_call.arguments, spend_change_confirmed: true});
    // The account stops owning squad_1's pixel before the run; preflight blocks it and the user amends it.
    pixels.splice(0, 1, 'pixel-new');
    assert.equal((await f.call('amcp_campaign', {action: 'preflight', id})).data.blocked, true);
    await f.call('amcp_campaign', {
      action: 'recover_step',
      id,
      step_id: 'squad_1',
      confirmed: true,
      patch: [{path: '/payload/adsquads/0/pixel_id', value: 'pixel-new'}],
    });
    const refused = await f.call('amcp_campaign', {action: 'run', id});
    assert.equal(refused.error.code, 'APPROVAL_REQUIRED', 'the amended plan is not the approved one');
    assert.equal(f.writes.length, 0);
  } finally {
    f.close();
  }
});

test('a mismatch stops the run for the user, with the acceptance as the next call', async () => {
  const f = fixture({readSquad: s => (s.id === 'squad1' ? {...s, name: String(s.name).trim()} : s)});
  try {
    const id = (
      await createPlan(f, [
        campaignStep(),
        squadStep(1, {}, {name: 'AMCP squad 1 '}),
        squadStep(2, {depends_on: ['campaign', 'squad_1']}),
      ])
    ).data.id;
    const {ran} = await approveAndRun(f, id);
    assert.notEqual(ran.data.state, 'complete');
    // Two rounds of reads settle the disagreement; run once more to reach the decision.
    const next = await f.call('amcp_campaign', {action: 'run', id});
    assert.equal(next.data.run.stopped, 'needs_attention', JSON.stringify(next.data.run));
    assert.equal(next.data.next_call.add_after_user_approval.accept_observed, true);
    assert.equal(f.writes.length, 2, 'the dependant waits');
  } finally {
    f.close();
  }
});

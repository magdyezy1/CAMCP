import test from 'node:test';
import assert from 'node:assert/strict';
import type {JsonObject} from '../src/types.js';
import {actor, campaignStep, createPlan, fixture, runAll, squadStep} from './snapchat-plan-fixture.js';

/**
 * Snapchat S5, from the owner's live test on 2026-09-25: an ad squad's read-back disagreed with what was sent in the
 * same field on every read. Verification said inconclusive and pointed back to itself, reconcile_step returned the
 * same, recover_step refused, and the only exit was cancelling the plan. A disagreement that stays the same across
 * two verification rounds is now a mismatch with its diff, and the operator can accept the observed state by its
 * hash: audited, nothing sent, and the plan continues.
 */
// Snapchat stores the name trimmed; the plan sent a trailing space, so every read disagrees in the same way.
const trims = (s: JsonObject) => ({...s, name: String(s.name).trim()});
const plan = () => [
  campaignStep(),
  squadStep(1, {}, {name: 'AMCP view test | squad 1 '}),
  squadStep(2, {depends_on: ['campaign', 'squad_1']}),
];
async function mismatched(f: ReturnType<typeof fixture>) {
  const id = (await createPlan(f, plan())).data.id;
  await runAll(f, id);
  // The first round of reads is inconclusive; the next round sees the same state and settles it.
  const view = (await f.call('amcp_campaign', {action: 'prepare_next', id})).data;
  return {id, view};
}

test('a disagreement that stays the same becomes a mismatch with its diff, never an endless verify loop', async () => {
  const f = fixture({readSquad: trims});
  try {
    const {id, view} = await mismatched(f);
    const squad = view.steps.find((s: JsonObject) => s.id === 'squad_1');
    assert.equal(squad.status, 'mismatch');
    assert.equal(view.current.step_id, 'squad_1');
    const verification = view.current.verification;
    assert.equal(verification.status, 'mismatch');
    assert.equal(verification.checks[0].code, 'VERIFICATION_MISMATCH');
    assert.deepEqual(verification.checks[0].diff, [
      {field: '/name', expected: 'AMCP view test | squad 1 ', actual: 'AMCP view test | squad 1'},
    ]);
    assert.match(verification.actual_hash, /^[0-9a-f]{64}$/);
    // The way forward is the operator's decision, not the same read again.
    assert.deepEqual(view.next_call, {
      tool: 'amcp_campaign',
      arguments: {action: 'reconcile_step', id, step_id: 'squad_1', actual_hash: verification.actual_hash},
      add_after_user_approval: {accept_observed: true},
    });
    assert.equal(JSON.stringify(view).includes('"action":"verify"'), false);
    assert.match(view.recovery, /\/name/);
    // The dependant waits; nothing further was sent.
    assert.equal(view.steps.find((s: JsonObject) => s.id === 'squad_2').status, 'pending');
    assert.equal(f.writes.length, 2);
  } finally {
    f.close();
  }
});

test('the operator accepts the observed state by its hash: audited, nothing sent, and dependants continue', async () => {
  const f = fixture({readSquad: trims});
  try {
    const {id, view} = await mismatched(f);
    const accepted = await f.call('amcp_campaign', {
      ...view.next_call.arguments,
      ...view.next_call.add_after_user_approval,
    });
    assert.equal(accepted.success, true, JSON.stringify(accepted));
    const row = accepted.data.steps.find((s: JsonObject) => s.id === 'squad_1');
    assert.equal(row.status, 'verified_with_acceptance');
    assert.equal(f.writes.length, 2, 'accepting sends nothing');
    const events = (
      f.store.db.prepare('SELECT event FROM audit WHERE tenant_id=?').all(actor.tenantId) as {event: string}[]
    ).map(r => JSON.parse(r.event));
    const audit = events.find(e => e.event === 'campaign_step_accepted');
    assert.ok(audit, 'the acceptance is in the audit trail');
    assert.equal(audit.step_id, 'squad_1');
    assert.equal(audit.actual_hash, view.next_call.arguments.actual_hash);
    assert.deepEqual(audit.changed_fields, ['/name']);
    const done = await runAll(f, id);
    assert.equal(done.at(-1)!.result.data.state, 'complete');
    assert.equal(f.writes.length, 3);
    const step = (await f.call('amcp_campaign', {action: 'get', id, step_id: 'squad_1'})).data.step;
    assert.equal(step.acceptance.actual_hash, view.next_call.arguments.actual_hash);
    assert.equal(step.acceptance.by, actor.userId);
  } finally {
    f.close();
  }
});

test('a state that changed since the diff is refused, with the new hash to review', async () => {
  const f = fixture({readSquad: trims});
  try {
    const {view} = await mismatched(f);
    // Someone edits the ad squad in Snapchat after the operator saw the diff.
    f.squads.get('squad1')!.name = 'Edited elsewhere';
    const refused = await f.call('amcp_campaign', {
      ...view.next_call.arguments,
      ...view.next_call.add_after_user_approval,
    });
    assert.equal(refused.success, false);
    assert.equal(refused.error.code, 'STATE_CHANGED');
    assert.match(refused.error.message, /actual_hash/);
    assert.notEqual(refused.error.details.actual_hash, view.next_call.arguments.actual_hash);
    assert.equal(f.writes.length, 2);
  } finally {
    f.close();
  }
});

test('a difference that clears on the next read still verifies normally', async () => {
  let reads = 0;
  // The first read after the write is stale; the provider catches up on the next one.
  const f = fixture({readSquad: s => (s.id === 'squad1' && reads++ === 0 ? {...s, name: 'stale'} : s)});
  try {
    const id = (await createPlan(f, [campaignStep(), squadStep(1)])).data.id;
    const done = await runAll(f, id);
    assert.equal(done.at(-1)!.result.data.state, 'complete');
    const step = (await f.call('amcp_campaign', {action: 'get', id, step_id: 'squad_1'})).data.step;
    assert.equal(step.status, 'verified');
    assert.equal(step.verification.checks[0].read_attempts, 2);
  } finally {
    f.close();
  }
});

test('acceptance needs the observed hash and a step whose read-back disagrees', async () => {
  const f = fixture({readSquad: trims});
  try {
    const {id, view} = await mismatched(f);
    const accept = (extra: JsonObject) =>
      f.call('amcp_campaign', {action: 'reconcile_step', id, accept_observed: true, ...extra});
    const noHash = await accept({step_id: 'squad_1'});
    assert.equal(noHash.error.code, 'INVALID_ARGUMENT');
    assert.match(noHash.error.message, /actual_hash/);
    const verified = await accept({step_id: 'campaign', actual_hash: view.next_call.arguments.actual_hash});
    assert.equal(verified.error.code, 'RECOVERY_NOT_SAFE');
    const pending = await accept({step_id: 'squad_2', actual_hash: view.next_call.arguments.actual_hash});
    assert.equal(pending.error.code, 'RECOVERY_NOT_SAFE');
    assert.equal(f.writes.length, 2);
  } finally {
    f.close();
  }
});

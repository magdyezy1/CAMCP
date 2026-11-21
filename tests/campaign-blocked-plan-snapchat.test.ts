import test from 'node:test';
import assert from 'node:assert/strict';
import type {JsonObject} from '../src/types.js';
import {campaignStep, createPlan, fixture, squadStep} from './snapchat-plan-fixture.js';

/**
 * R2.5 field3, package r25-field3-approvals, M5-b on the real Snapchat preflight (tests/campaign-blocked-plan.test.mjs holds the stand-in and the TikTok
 * cases): a plan whose ad squad names a pixel the account does not own is blocked by preflight, and approve, approval_summary and run now say so in
 * fields a client can stop on, beside the blocked view they always answered. The whole path is the real one: the service, the Snapchat pixel read, the
 * plan engine and the reviewed writes; the synthetic account never receives a write.
 */
const blockedPlan = async (f: ReturnType<typeof fixture>) =>
  (await createPlan(f, [campaignStep(), squadStep(1, {}, {pixel_id: 'pixel-x'})])).data.id;

test('a plan blocked for a pixel the account does not own: approve, approval_summary and run answer with the fields, and nothing is sent', async () => {
  const f = fixture({pixels: ['pixel-own']});
  try {
    const id = await blockedPlan(f);
    const preview = (await f.call('amcp_campaign', {action: 'approve', id})).data;
    assert.equal(preview.approvable, false);
    assert.equal(preview.approved, false);
    assert.equal(preview.refusal.code, 'PLAN_PREFLIGHT_BLOCKED');
    assert.deepEqual(preview.refusal.details, {blocked_steps: 1});
    assert.equal(preview.approval, undefined);
    // The old fields, which the website reads.
    assert.equal(preview.blocked, true);
    assert.equal(preview.missing_requirements[0].step, 'squad_1');
    assert.equal(preview.missing_requirements[0].error.code, 'SNAPCHAT_PIXEL_NOT_OWNED');
    assert.equal(typeof preview.missing_requirements[0].error.message, 'string');
    assert.equal(preview.next_call.arguments.action, 'recover_step');
    // The summary reads the preflight approve stored: the same blocked answer, and no request of its own.
    const requests = f.requests.length;
    const summary = (await f.call('amcp_campaign', {action: 'approval_summary', id})).data;
    assert.equal(f.requests.length, requests, 'approval_summary sent no request');
    assert.deepEqual(summary, preview);
    // approve with confirmed and any hashes stores no approval.
    const confirmed = (
      await f.call('amcp_campaign', {
        action: 'approve',
        id,
        confirmed: true,
        plan_hash: preview.plan_hash,
        summary_hash: 'not-a-summary',
        spend_change_confirmed: true,
      })
    ).data;
    assert.equal(confirmed.approvable, false);
    assert.equal(confirmed.approved, false);
    // run stops on the block as needs_attention with nothing executed.
    const ran = (await f.call('amcp_campaign', {action: 'run', id})).data;
    assert.deepEqual(ran.run, {executed: [], stopped: 'needs_attention', reason: 'preflight_blocked'});
    const stored = (await f.call('amcp_campaign', {action: 'get', id, detail: 'full'})).data;
    assert.equal(stored.approval?.plan_hash, undefined, 'no approval was recorded');
    assert.equal(f.writes.length, 0);
  } finally {
    f.close();
  }
});

test('after the pixel is corrected and the preflight passes, the same calls approve and run as before', async () => {
  const f = fixture({pixels: ['pixel-own']});
  try {
    const id = await blockedPlan(f);
    const blocked = (await f.call('amcp_campaign', {action: 'approve', id})).data;
    assert.equal(blocked.approvable, false);
    // The correction the answer names: the pixel the account owns, which the user chooses.
    const fixed = await f.call('amcp_campaign', {
      action: 'recover_step',
      id,
      step_id: 'squad_1',
      confirmed: true,
      patch: [{path: '/payload/adsquads/0/pixel_id', value: 'pixel-own'}],
    });
    assert.equal(fixed.success, true, JSON.stringify(fixed).slice(0, 600));
    const preview = (await f.call('amcp_campaign', {action: 'approve', id})).data;
    assert.equal(preview.approvable, undefined);
    assert.equal(preview.refusal, undefined);
    assert.equal(preview.approval.steps.length, 2);
    const approved = await f.call('amcp_campaign', {
      ...preview.next_call.arguments,
      ...preview.next_call.add_after_user_approval,
    });
    assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 600));
    const ran = (await f.call('amcp_campaign', {action: 'run', id})).data;
    assert.equal(ran.run.stopped, 'complete', JSON.stringify(ran.run));
    assert.equal(ran.run.reason, undefined);
    assert.equal(f.writes.length, 2);
    assert.ok((ran.run as JsonObject).progress, 'a stop of a run carries its progress');
  } finally {
    f.close();
  }
});

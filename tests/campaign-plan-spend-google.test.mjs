import test from 'node:test';
import assert from 'node:assert/strict';
import {at, googleReconcileFixture} from './helpers/google-reconcile-fixture.mjs';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {savePlanPolicy} from '../dist/src/campaign-inventory.js';

/**
 * Round 2.5, package r25-field-plan, item 1, end to end: the owner's Google issue 2. A plan that switches on ad groups under an existing
 * paused campaign names no money field, so its approval was never offered spend_change_confirmed, while every review of it asks for the
 * flag: `run` stopped at each step and cost two calls a step (about 30 for a 16-step plan). The approval now names each step's spend
 * effect, decided by the same local compile the review applies, and one approval with the flag covers every step it showed. A synthetic
 * Google account answers the reads and applies the writes; nothing leaves the process.
 */
const adGroupAction = 'google_ads_v23_ad_group_mutate_ad_groups',
  campaign = at('campaigns', '10');
let tenants = 0;

/** An account with one paused campaign and `groups` paused ad groups under it. */
function account(groups) {
  const f = googleReconcileFixture({tenant: 'plan-spend-google-' + ++tenants});
  f.row('campaign', {resource_name: campaign, name: 'Existing campaign', status: 'PAUSED'});
  for (let i = 1; i <= groups; i++)
    f.row('ad_group', {resource_name: at('adGroups', String(20 + i)), name: 'Group ' + i, status: 'PAUSED', campaign});
  return f;
}
const step = (id, arguments_) => ({
  id,
  kind: 'write',
  gateway: 'google_ads_native_action',
  connection_id: 'g',
  account_id: '123',
  description: id,
  arguments: arguments_,
});
const update = (n, fields, mask) => ({
  action: adGroupAction,
  payload: {operations: [{update: {resource_name: at('adGroups', String(20 + n)), ...fields}, update_mask: mask}]},
});
/** The status-only change of the owner's report: switch an existing ad group on. */
const enable = n => step('enable_' + n, update(n, {status: 'ENABLED'}, 'status'));
/** A change of a name, which a review asks no spending acknowledgement for. */
const rename = n => step('rename_' + n, update(n, {name: 'Renamed ' + n}, 'name'));

/** A plan counted in calls: each call an agent makes to amcp_campaign. */
async function agent(f, steps, name = 'Go live') {
  let calls = 0;
  const call = input => {
    calls++;
    return f.call('amcp_campaign', input);
  };
  const created = await call({action: 'create', name, brief: 'Synthetic.', steps});
  assert.equal(created.success, true, JSON.stringify(created).slice(0, 800));
  const id = created.data.id;
  calls = 0;
  return {
    id,
    call,
    calls: () => calls,
    /** The summary, then the approval it names, with the flag it offers or without it. */
    async approve({flag = true} = {}) {
      const preview = await call({action: 'approve', id});
      assert.equal(preview.success, true, JSON.stringify(preview).slice(0, 800));
      const approved = await call({
        ...preview.data.next_call.arguments,
        ...(flag ? preview.data.next_call.add_after_user_approval : {}),
      });
      assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 800));
      return {preview: preview.data, approved: approved.data};
    },
    /** Runs until the plan is complete, answering a stop for the flag the way its next call says; counts the stops. */
    async finish() {
      const stops = [];
      for (let i = 0; i < 20; i++) {
        const ran = await call({action: 'run', id});
        assert.equal(ran.success, true, JSON.stringify(ran).slice(0, 800));
        const stopped = ran.data.run.stopped;
        if (stopped === 'complete') return {ran: ran.data, stops};
        if (stopped === 'time' || stopped === 'limit') continue;
        stops.push(stopped);
        if (stopped !== 'needs_spend_change_confirmed') return {ran: ran.data, stops};
        const next = ran.data.next_call,
          answered = await call({...next.arguments, ...next.add_after_user_approval});
        assert.equal(answered.success, true, JSON.stringify(answered).slice(0, 800));
      }
      throw new Error('the plan did not finish');
    },
  };
}

test('a status-only plan: the approval names each step’s spend effect and offers the flag; with it run completes with no stop', async () => {
  const f = account(4);
  try {
    const a = await agent(f, [enable(1), rename(2), enable(3), enable(4)]);
    const {preview, approved} = await a.approve();
    assert.deepEqual(
      preview.approval.steps.map(s => [s.id, s.spend_effect]),
      [
        ['enable_1', true],
        ['rename_2', false],
        ['enable_3', true],
        ['enable_4', true],
      ],
    );
    assert.deepEqual(preview.approval.spend_steps, ['enable_1', 'enable_3', 'enable_4']);
    assert.deepEqual(preview.next_call.add_after_user_approval, {spend_change_confirmed: true});
    assert.deepEqual(approved.approved.spend_steps, ['enable_1', 'enable_3', 'enable_4']);
    const ran = await a.call({action: 'run', id: a.id});
    assert.equal(ran.data.run.stopped, 'complete', JSON.stringify(ran.data.run));
    assert.equal(ran.data.run.executed.length, 4);
    assert.equal(f.writes.length, 4, 'one write for each step');
    // The summary, the approval and one run: three calls, however many steps.
    assert.equal(a.calls(), 3);
    for (const n of [1, 3, 4])
      assert.equal(f.db.ad_group.find(g => g.resource_name === at('adGroups', String(20 + n))).status, 'ENABLED');
  } finally {
    f.close();
  }
});

test('the same plan approved without the flag stops once, and one re-approval completes it within three calls of the approved case', async () => {
  const steps = () => [enable(1), rename(2), enable(3), enable(4)];
  const whole = account(4),
    base = await agent(whole, steps());
  let approvedCalls;
  try {
    await base.approve();
    assert.equal((await base.call({action: 'run', id: base.id})).data.run.stopped, 'complete');
    approvedCalls = base.calls();
  } finally {
    whole.close();
  }
  const f = account(4);
  try {
    const a = await agent(f, steps());
    const {approved} = await a.approve({flag: false});
    assert.equal(approved.approved.spend_change_confirmed, false);
    const stopped = await a.call({action: 'run', id: a.id});
    assert.equal(stopped.data.run.stopped, 'needs_spend_change_confirmed', JSON.stringify(stopped.data.run));
    assert.deepEqual(stopped.data.run.executed, [], 'the first step is one that spends');
    assert.equal(stopped.data.step_id, 'enable_1');
    assert.equal(stopped.data.next_call.arguments.action, 'approve');
    assert.equal(stopped.data.next_call.arguments.confirmed, true);
    assert.deepEqual(stopped.data.next_call.add_after_user_approval, {spend_change_confirmed: true});
    assert.deepEqual(stopped.data.run.spend_steps, ['enable_1', 'enable_3', 'enable_4']);
    // Nothing that spends was sent while the approval lacked the flag.
    assert.equal(f.writes.length, 0);
    assert.equal((await a.call({action: 'run', id: a.id})).data.run.stopped, 'needs_spend_change_confirmed');
    assert.equal(f.writes.length, 0);
    const again = await a.call({
      ...stopped.data.next_call.arguments,
      ...stopped.data.next_call.add_after_user_approval,
    });
    assert.equal(again.success, true, JSON.stringify(again).slice(0, 600));
    const ran = await a.call({action: 'run', id: a.id});
    assert.equal(ran.data.run.stopped, 'complete', JSON.stringify(ran.data.run));
    assert.equal(f.writes.length, 4);
    // The pinned cost: the re-approval and the stop, not two calls for each of the steps that spend.
    assert.ok(a.calls() <= approvedCalls + 3, a.calls() + ' calls against ' + approvedCalls);
  } finally {
    f.close();
  }
});

test('a step-by-step execute_next without the flag is still refused, and the stop the plan gave sent nothing', async () => {
  const f = account(2);
  try {
    const a = await agent(f, [enable(1), enable(2)]);
    await a.approve({flag: false});
    const stopped = await a.call({action: 'run', id: a.id});
    assert.equal(stopped.data.run.stopped, 'needs_spend_change_confirmed');
    const review = stopped.data.review;
    const refused = await a.call({
      action: 'execute_next',
      id: a.id,
      review_id: review.review_id,
      idempotency_key: review.idempotency_key,
      confirmed: true,
    });
    assert.equal(refused.data.current.error.code, 'SPEND_CONFIRMATION_REQUIRED', JSON.stringify(refused.data.current));
    assert.equal(f.writes.length, 0);
  } finally {
    f.close();
  }
});

test('a deletion under the owner’s destructive tier still stops for its own acknowledgement, whatever the approval covers', async () => {
  const f = account(2);
  try {
    // The owner asks for an explicit acknowledgement before anything is deleted on this account (WRT-09); a plan approval never gives it.
    saveSpendPolicy(
      f.store,
      {tenantId: f.actor.tenantId, userId: 'owner', role: 'admin'},
      {
        gateway: 'google_ads_native_action',
        account_id: '123',
        confirmed: true,
        policy: {allow_deletion: true, require_destructive_confirmation: true},
      },
    );
    const a = await agent(f, [
      enable(1),
      step('remove_2', {action: adGroupAction, payload: {operations: [{remove: at('adGroups', '22')}]}}),
    ]);
    const {approved} = await a.approve();
    assert.deepEqual(
      approved.approved.spend_steps,
      ['enable_1'],
      'the approval covers the step that spends, not the deletion',
    );
    const ran = await a.call({action: 'run', id: a.id});
    assert.equal(ran.data.run.stopped, 'needs_destructive_confirmed', JSON.stringify(ran.data.run).slice(0, 400));
    assert.deepEqual(ran.data.run.executed, ['enable_1']);
    assert.equal(ran.data.step_id, 'remove_2');
    assert.equal(f.writes.length, 1);
    assert.equal(f.db.ad_group.length, 2, 'nothing was deleted');
  } finally {
    f.close();
  }
});

test('the distinct-approver policy still reads money fields, not spend effects: a status-only go-live is approved, run and executed by its own owner', async () => {
  // Lead review of r25-field-plan, S4-1. The approval now offers spend_change_confirmed by spend effect (approvalSpends), but the owner's
  // policy (CMP-05) governs a plan by its money fields (approvalMoney), as it always has: widening it would change who may approve a plan,
  // which is the owner's to decide. Three places read the policy: approve, the run's check before each step, and a direct execute of a plan's
  // review (write-review.ts). The plan that sets a bid is the control that the policy is on and each of them reads it.
  const f = account(3);
  try {
    savePlanPolicy(
      f.store,
      {tenantId: f.actor.tenantId, userId: 'owner', role: 'admin'},
      {require_distinct_approver: true, confirmed: true},
    );
    const governed = await agent(f, [step('bid_1', update(1, {cpc_bid_micros: '1000000'}, 'cpc_bid_micros'))], 'Bid');
    const shown = await governed.call({action: 'approve', id: governed.id});
    assert.equal(shown.data.approver_required, true, 'a plan that sets a bid needs another person to approve it');
    const held = await governed.call({action: 'prepare_next', id: governed.id});
    assert.equal(held.success, true, JSON.stringify(held).slice(0, 400));
    const refused = await f.execute(held.data.review.review_id);
    assert.equal(refused.success, false);
    assert.equal(refused.error.code, 'DISTINCT_APPROVER_REQUIRED');
    assert.equal(f.writes.length, 0);
    // A plan that spends only by effect is not governed: its owner is shown the summary, is offered the flag, approves with it and runs it.
    const a = await agent(f, [enable(2), enable(3)], 'Go live');
    const preview = await a.call({action: 'approve', id: a.id});
    assert.equal(preview.success, true, JSON.stringify(preview).slice(0, 400));
    assert.equal(preview.data.approver_required, undefined, 'the policy does not govern a plan by its spend effects');
    assert.deepEqual(preview.data.approval.spend_steps, ['enable_2', 'enable_3']);
    assert.deepEqual(preview.data.next_call.add_after_user_approval, {spend_change_confirmed: true});
    const approved = await a.call({
      ...preview.data.next_call.arguments,
      ...preview.data.next_call.add_after_user_approval,
    });
    assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 400));
    const ran = await a.call({action: 'run', id: a.id});
    assert.equal(ran.data.run.stopped, 'complete', JSON.stringify(ran.data.run).slice(0, 400));
    assert.equal(f.writes.length, 2);
    // Nor is a direct execute of one of its reviews refused for the policy.
    const lone = await agent(f, [enable(1)], 'One ad group');
    const review = await lone.call({action: 'prepare_next', id: lone.id});
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 400));
    const sent = await f.execute(review.data.review.review_id);
    assert.equal(sent.success, true, JSON.stringify(sent).slice(0, 400));
    assert.equal(f.writes.length, 3);
  } finally {
    f.close();
  }
});

test('the shape of the M5 go-live: 40 status-only steps are all named by one approval, which is offered the flag', async () => {
  // Each of the 40 steps is compiled locally for the summary (a hundred milliseconds in all) and none is sent. Running 40 real steps takes
  // half a minute on a synthetic account (the engine's own cost per step), so the run is pinned at 40 in campaign-plan-spend.test.mjs and
  // at twelve steps with the real compile below.
  const f = account(40);
  try {
    const a = await agent(
      f,
      Array.from({length: 40}, (_, i) => enable(i + 1)),
      'Go live, 40 ad groups',
    );
    const {preview, approved} = await a.approve();
    assert.deepEqual(preview.next_call.add_after_user_approval, {spend_change_confirmed: true});
    assert.equal(preview.approval.steps.length, 40);
    assert.ok(preview.approval.steps.every(s => s.spend_effect === true));
    assert.equal(preview.approval.spend_steps.length, 40);
    assert.equal(approved.approved.spend_steps.length, 40);
    assert.equal(f.writes.length, 0);
  } finally {
    f.close();
  }
});

test('a go-live of twelve status-only steps runs under one approval with no stop for the flag', async () => {
  const f = account(12);
  try {
    const a = await agent(
      f,
      Array.from({length: 12}, (_, i) => enable(i + 1)),
      'Go live, 12 ad groups',
    );
    await a.approve();
    const {ran, stops} = await a.finish();
    assert.deepEqual(stops, [], 'no step stopped for the flag');
    assert.equal(ran.run.stopped, 'complete');
    assert.equal(f.writes.length, 12);
    assert.ok(f.db.ad_group.every(g => g.status === 'ENABLED'));
  } finally {
    f.close();
  }
});

test('the local compile decides each step by the rule a review applies: spending, not spending, undecidable and with a predecessor’s result', async () => {
  const {stepSpendEffects} = await import('../dist/src/campaign-spend-effects.js'),
    f = account(1);
  try {
    const campaignStep = step('campaign', {
        action: 'google_ads_v23_campaign_mutate_campaigns',
        payload: {
          operations: [
            {
              create: {
                name: 'New campaign',
                status: 'PAUSED',
                advertising_channel_type: 'SEARCH',
                campaign_budget: 'customers/123/campaignBudgets/5',
                manual_cpc: {},
              },
            },
          ],
        },
      }),
      // An ad group created paused under the campaign the first step makes: it names a predecessor's result, not yet known.
      childStep = {
        ...step('child', {
          action: adGroupAction,
          payload: {
            operations: [
              {
                create: {
                  name: 'New group',
                  status: 'PAUSED',
                  campaign: {$ref: 'campaign#/data/results/0/resourceName'},
                },
              },
            ],
          },
        }),
        depends_on: ['campaign'],
      },
      unknown = step('unknown', {action: 'google_ads_v23_not_an_action', payload: {}}),
      media = {id: 'upload', kind: 'media', arguments: {platform: 'google_ads', action: 'prepare'}, depends_on: []};
    const effects = stepSpendEffects(f.service, [enable(1), rename(1), campaignStep, childStep, unknown, media]);
    assert.deepEqual(
      [...effects],
      [
        ['enable_1', true],
        ['rename_1', false],
        ['campaign', true],
        ['child', false],
        ['unknown', true],
      ],
      'a media step is not a write and names none; a step that cannot be compiled counts as spending',
    );
  } finally {
    f.close();
  }
});

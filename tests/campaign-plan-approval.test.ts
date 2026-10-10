import test from 'node:test';
import assert from 'node:assert/strict';
import type {JsonObject} from '../src/types.js';
import {
  actor,
  bytes,
  campaignStep,
  createPlan,
  fixture,
  squadBody,
  squadPlan,
  squadStep,
} from './snapchat-plan-fixture.js';
import {approvalStep, approvalSummary} from '../src/plan-approval.js';

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

/**
 * WRT-05 Stage A: the summary used to stop after 12 money and status fields per step, so a step with 20 ad squads
 * showed 6 budgets and 6 statuses while the approval covered all 20. Every field is now counted; a large step is
 * aggregated (count, distinct values, smallest and largest amount) with the call that lists every field, and the
 * approval must name the summary it approved (summary_hash).
 */
test('a 20-ad-squad step is summarized whole, and approval needs the matching summary_hash', async () => {
  const f = fixture();
  try {
    const squads = Array.from({length: 20}, (_, i) => squadBody(i + 1, {daily_budget_micro: 1000000 * (i + 1)}));
    const step = squadStep(1, {}, {});
    step.arguments.payload = {adsquads: squads};
    const id = (await createPlan(f, [campaignStep(), step])).data.id;
    const preview = (await f.call('amcp_campaign', {action: 'approve', id})).data;
    const squad = preview.approval.steps.find((s: JsonObject) => s.id === 'squad_1');
    assert.equal(squad.fields_total, 60, 'bid strategy, daily budget and status of each of 20 squads');
    assert.equal(squad.truncated, true);
    const budgets = squad.aggregates.find((a: JsonObject) => a.field === '/payload/adsquads/*/daily_budget_micro');
    assert.deepEqual(
      {count: budgets.count, min: budgets.min, max: budgets.max, kind: budgets.kind},
      {count: 20, min: 1000000, max: 20000000, kind: 'spend'},
    );
    const statuses = squad.aggregates.find((a: JsonObject) => a.field === '/payload/adsquads/*/status');
    assert.deepEqual([statuses.count, statuses.values], [20, ['PAUSED']]);
    assert.deepEqual(squad.all_fields.arguments, {action: 'approve', id, step_id: 'squad_1'});
    assert.equal(preview.approval.truncated, true);
    assert.equal(preview.next_call.arguments.summary_hash, preview.approval.summary_hash);
    assert.equal(preview.summary_hash, preview.approval.summary_hash);
    assert.ok(bytes(preview) <= 12 * 1024, String(bytes(preview)));
    // The complete list of the aggregated step.
    const all = (await f.call('amcp_campaign', {action: 'approve', id, step_id: 'squad_1'})).data;
    assert.equal(all.fields.length, 60);
    assert.equal(all.summary_hash, preview.approval.summary_hash);
    assert.deepEqual(
      all.fields.filter((x: JsonObject) => x.field.endsWith('/daily_budget_micro')).map((x: JsonObject) => x.value),
      squads.map(s => s.daily_budget_micro),
    );
    const {summary_hash: _hash, ...withoutSummary} = preview.next_call.arguments;
    const missing = await f.call('amcp_campaign', {...withoutSummary, spend_change_confirmed: true});
    assert.equal(missing.error.code, 'PLAN_CHANGED');
    assert.equal(missing.error.details.field, 'summary_hash');
    const wrong = await f.call('amcp_campaign', {
      ...preview.next_call.arguments,
      summary_hash: 'not-the-summary',
      spend_change_confirmed: true,
    });
    assert.equal(wrong.error.code, 'PLAN_CHANGED');
    assert.equal(f.writes.length, 0);
    const approved = await f.call('amcp_campaign', {...preview.next_call.arguments, spend_change_confirmed: true});
    assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 600));
    const events = (
      f.store.db.prepare('SELECT event FROM audit WHERE tenant_id=?').all(actor.tenantId) as {event: string}[]
    ).map(r => JSON.parse(r.event));
    const audited = events.find(e => e.event === 'campaign_plan_approved');
    assert.equal(audited.summary_hash, preview.approval.summary_hash);
    assert.equal(audited.truncated_steps, 1);
  } finally {
    f.close();
  }
});

test('a 1,000-operation step is aggregated within the view budget with exact decimal extremes', () => {
  const operations = Array.from({length: 1000}, (_, i) => ({
    update: {
      resourceName: 'customers/1/adGroups/' + (i + 1),
      cpc_bid_micros: String(1000000 + i * 10),
      status: i % 2 ? 'PAUSED' : 'ENABLED',
    },
    updateMask: 'cpc_bid_micros,status',
  }));
  const run = {
    id: 'plan-1000',
    plan_hash: 'hash',
    steps: [
      {
        id: 'bids',
        kind: 'write',
        gateway: 'google_ads_native_action',
        account_id: '1',
        depends_on: [],
        arguments: {action: 'google_ads_v23_ad_group_mutate_ad_groups', payload: {operations}},
      },
    ],
  };
  const summary = approvalSummary(run);
  const step = summary.steps[0];
  assert.equal(step.fields_total, 2000);
  assert.equal(step.truncated, true);
  const bids = step.aggregates.find((a: JsonObject) => a.field === '/payload/operations/*/update/cpc_bid_micros');
  assert.deepEqual([bids.count, bids.distinct_count, bids.min, bids.max], [1000, 1000, '1000000', '1009990']);
  assert.equal(bids.values.length, 5);
  const status = step.aggregates.find((a: JsonObject) => a.field === '/payload/operations/*/update/status');
  assert.deepEqual([status.count, status.values], [1000, ['ENABLED', 'PAUSED']]);
  assert.equal(status.min, undefined, 'statuses have no range');
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 6 * 1024);
  assert.equal(approvalStep(run, 'bids')!.fields.length, 2000);
  // The hash changes with what is shown, and is stable for the same plan.
  assert.equal(approvalSummary(run).summary_hash, summary.summary_hash);
  operations[0]!.update.cpc_bid_micros = '999';
  assert.notEqual(approvalSummary(run).summary_hash, summary.summary_hash);
});

test('a step of a few fields is still listed field by field', () => {
  const run = {
    id: 'p',
    plan_hash: 'h',
    steps: [
      {
        id: 'one',
        kind: 'write',
        gateway: 'google_ads_native_action',
        account_id: '1',
        depends_on: [],
        arguments: {
          action: 'google_ads_v23_campaign_budget_mutate_campaign_budgets',
          payload: {operations: [{remove: 'customers/1/campaignBudgets/2'}]},
        },
      },
    ],
  };
  const summary = approvalSummary(run);
  assert.equal(summary.steps[0].truncated, undefined);
  assert.equal(summary.truncated, undefined);
  assert.deepEqual(summary.effects, [{step_id: 'one', destructive: true, irreversible: true}]);
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

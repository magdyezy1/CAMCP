import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRefused} from './helpers/assert-refused.mjs';
import {savePlanPolicy} from '../dist/src/campaign-inventory.js';
import {approvalSummary} from '../dist/src/plan-approval.js';
import {admin, amend, approve, fixture, readyPreflight, writes} from './helpers/campaign-run-fixture.mjs';

/**
 * R2.5 field3, package r25-field3-approvals, AMCP-07 (the owner's second Google report of 2026-11-21): showing a person what they are about to
 * approve needed `approve` without `confirmed`, an action whose contract hints are destructive and which saves a plan, runs a live
 * preflight and may re-read the provider, so Claude Code's auto-mode check blocked the read-only summary and the session had to stop and
 * ask. `approval_summary` is that summary as a read: it returns what `approve` without `confirmed` returns, from the stored preflight, and
 * saves, audits and sends nothing. It can never record an approval, so what the person was shown is still approved by `approve` with
 * `confirmed` and the hashes of that summary, exactly as before.
 */
const spendEffects = new Map([
  ['go_a', true],
  ['hold', false],
  ['go_b', true],
]);
const ids = ['go_a', 'hold', 'go_b'];
const needsFlag = {go_a: {spend_change_confirmed: true}, go_b: {spend_change_confirmed: true}};

test('approval_summary answers exactly what approve without confirmed answers, for a ready plan', async () => {
  const f = fixture({effects: new Map(ids.map(id => [id, false]))});
  try {
    const id = await f.plan(ids);
    // A stored preflight, as the person's earlier preflight call (or the one approve runs) leaves it: neither call then saves.
    await f.alice({action: 'preflight', id});
    const before = f.snapshot();
    const summary = await f.alice({action: 'approval_summary', id});
    assert.deepEqual(summary, await f.alice({action: 'approve', id}));
    assert.equal(f.snapshot(), before, 'neither call saved, audited or claimed anything');
    assert.equal(summary.approval.steps.length, 3);
    assert.equal(summary.summary_hash, summary.approval.summary_hash);
    assert.deepEqual(summary.next_call.arguments, {
      action: 'approve',
      id,
      plan_hash: summary.plan_hash,
      summary_hash: summary.summary_hash,
      confirmed: true,
    });
    assert.equal(f.state.preflights, 1, 'only the one the test ran');
    assert.deepEqual([f.state.prepares, f.state.attempts], [[], []], 'no tool call of any kind');
  } finally {
    f.store.close();
  }
});

test('approval_summary offers the spend flag of a spending plan, as approve does', async () => {
  const f = fixture({effects: spendEffects});
  try {
    const id = await f.plan(ids);
    await f.alice({action: 'preflight', id});
    const summary = await f.alice({action: 'approval_summary', id});
    assert.deepEqual(summary, await f.alice({action: 'approve', id}));
    assert.deepEqual(summary.approval.spend_steps, ['go_a', 'go_b']);
    assert.deepEqual(summary.next_call.add_after_user_approval, {spend_change_confirmed: true});
  } finally {
    f.store.close();
  }
});

test('approval_summary answers the owner of a plan under the distinct-approver policy with the notice approve gives, and anyone else with the summary', async () => {
  const f = fixture({effects: new Map([['go_a', true]])});
  try {
    savePlanPolicy(f.store, admin, {require_distinct_approver: true, confirmed: true});
    const id = await f.plan(['go_a'], undefined, 'Budget plan', {money: true});
    await f.alice({action: 'preflight', id});
    const summary = await f.alice({action: 'approval_summary', id});
    assert.equal(summary.approver_required, true);
    assert.deepEqual(summary, await f.alice({action: 'approve', id}));
    assert.equal(summary.next_call.arguments.action, 'assign', 'the call that names an approver');
    await f.alice({action: 'assign', id, user_id: 'bob', role: 'approver'});
    const shown = await f.bob({action: 'approval_summary', id});
    assert.equal(shown.approver_required, undefined);
    assert.deepEqual(shown, await f.bob({action: 'approve', id}));
    assert.deepEqual(shown.approval.spend_steps, ['go_a']);
    // Reading it recorded nothing: the owner still cannot approve it.
    assert.equal(f.stored(id).approval?.plan_hash, undefined);
    await assert.rejects(
      () => f.alice({...shown.next_call.arguments, spend_change_confirmed: true}),
      e => assertRefused(e, 'DISTINCT_APPROVER_REQUIRED'),
    );
  } finally {
    f.store.close();
  }
});

test('approval_summary with a step_id lists that step’s fields, as approve with a step_id does', async () => {
  const f = fixture();
  try {
    const id = await f.plan(['go_a'], undefined, 'Budget plan', {money: true});
    await f.alice({action: 'preflight', id});
    const fields = await f.alice({action: 'approval_summary', id, step_id: 'go_a'});
    assert.deepEqual(fields, await f.alice({action: 'approve', id, step_id: 'go_a'}));
    assert.equal(fields.step_id, 'go_a');
    assert.equal(fields.fields_total, 1);
    assert.deepEqual(fields.fields, [{field: '/payload/daily_budget_micro', value: 1000000, kind: 'spend'}]);
    await assert.rejects(
      () => f.alice({action: 'approval_summary', id, step_id: 'no_such_step'}),
      e => assertRefused(e, 'INVALID_ARGUMENT') && e.details.field === 'step_id',
    );
  } finally {
    f.store.close();
  }
});

test('a truncated summary names approval_summary for the full field list of each aggregated step', () => {
  // plan-approval.ts: the call that lists every field of a step the summary aggregated is a read, so it is the read-only action.
  const operations = Array.from({length: 30}, (_, i) => ({
    update: {cpc_bid_micros: String(1000000 + i), status: 'PAUSED'},
  }));
  const run = {
    id: 'plan-1',
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
  const step = approvalSummary(run).steps[0];
  assert.equal(step.truncated, true);
  assert.deepEqual(step.all_fields, {
    tool: 'amcp_campaign',
    arguments: {action: 'approval_summary', id: 'plan-1', step_id: 'bids'},
  });
});

test('without a stored preflight approval_summary runs none: it says so, and saves and sends nothing', async () => {
  const f = fixture({effects: spendEffects});
  try {
    const id = await f.plan(ids);
    const before = f.snapshot(),
      revision = f.stored(id).revision;
    const summary = await f.alice({action: 'approval_summary', id});
    assert.equal(f.state.preflights, 0, 'no prerequisite check ran');
    assert.equal(f.snapshot(), before, 'nothing was saved, audited or claimed');
    assert.equal(summary.preflight.status, 'not_run');
    assert.match(summary.preflight.note, /approve runs/);
    assert.equal(summary.revision, revision);
    assert.equal(summary.approval.steps.length, 3);
    assert.deepEqual(summary.next_call.add_after_user_approval, {spend_change_confirmed: true});
    // approve then runs the preflight first, as it always did, and its summary is the one approval_summary showed.
    const shown = await f.alice({action: 'approve', id});
    assert.equal(f.state.preflights, 1);
    assert.equal(shown.summary_hash, summary.summary_hash);
    assert.deepEqual(shown.next_call, summary.next_call);
    assert.equal(shown.preflight, undefined, 'approve’s answer is what it was');
    assert.deepEqual([f.state.prepares, f.state.attempts], [[], []]);
  } finally {
    f.store.close();
  }
});

test('approving what approval_summary showed records exactly that summary, and run then covers its spend steps', async () => {
  const f = fixture({effects: spendEffects, needs: needsFlag});
  try {
    const id = await f.plan(ids);
    const shown = await f.alice({action: 'approval_summary', id});
    const approved = await f.alice({...shown.next_call.arguments, ...shown.next_call.add_after_user_approval});
    assert.deepEqual(approved.approved, {by: 'alice', spend_change_confirmed: true, spend_steps: ['go_a', 'go_b']});
    assert.equal(f.stored(id).approval.summary_hash, shown.summary_hash);
    const ran = await f.alice({action: 'run', id});
    assert.equal(ran.run.stopped, 'complete', JSON.stringify(ran.run));
    assert.deepEqual(writes(f), ids);
  } finally {
    f.store.close();
  }
});

test('approval_summary takes no confirmed, plan_hash, summary_hash or spend_change_confirmed: it can never record an approval', async () => {
  const f = fixture({effects: spendEffects});
  try {
    const id = await f.plan(ids);
    const shown = await f.alice({action: 'approval_summary', id}),
      before = f.snapshot();
    for (const [field, value] of [
      ['confirmed', true],
      ['confirmed', false],
      ['plan_hash', shown.plan_hash],
      ['summary_hash', shown.summary_hash],
      ['spend_change_confirmed', true],
    ])
      await assert.rejects(
        () => f.alice({action: 'approval_summary', id, [field]: value}),
        e =>
          assertRefused(e, 'INVALID_ARGUMENT') &&
          e.details.field === field &&
          /approve with confirmed/.test(e.message) &&
          e.details.next_call.arguments.action === 'approval_summary',
        field + ' ' + value,
      );
    // The whole approval, handed to the read-only action, is refused as it stands: nothing is recorded.
    await assert.rejects(
      () =>
        f.alice({...shown.next_call.arguments, ...shown.next_call.add_after_user_approval, action: 'approval_summary'}),
      e => assertRefused(e, 'INVALID_ARGUMENT'),
    );
    assert.equal(f.snapshot(), before, 'the refused calls saved nothing');
    assert.equal(f.stored(id).approval?.plan_hash, undefined, 'no approval was recorded');
    // run afterwards is as it was before: it asks for the approval, and sends nothing.
    await assert.rejects(
      () => f.alice({action: 'run', id}),
      e => assertRefused(e, 'APPROVAL_REQUIRED'),
    );
    assert.deepEqual([f.state.prepares, f.state.attempts], [[], []]);
  } finally {
    f.store.close();
  }
});

test('a viewer reads the summary, and approve with confirmed is still the approver’s: FORBIDDEN for a viewer, nothing recorded', async () => {
  const f = fixture({effects: spendEffects});
  try {
    const id = await f.plan(ids);
    await f.alice({action: 'assign', id, user_id: 'bob', role: 'viewer'});
    const mine = await f.alice({action: 'approval_summary', id}),
      theirs = await f.bob({action: 'approval_summary', id});
    assert.deepEqual(theirs, mine, 'the viewer is shown exactly what the owner is shown');
    await assert.rejects(
      () => f.bob({...theirs.next_call.arguments, ...theirs.next_call.add_after_user_approval}),
      e => assertRefused(e, 'FORBIDDEN') && e.details.plan_role === 'viewer',
    );
    assert.equal(f.stored(id).approval?.plan_hash, undefined);
    // A person the plan was never shared with reads nothing: the refusal is the one get gives.
    await assert.rejects(
      () => f.carol({action: 'approval_summary', id}),
      e => assertRefused(e, 'FORBIDDEN'),
    );
  } finally {
    f.store.close();
  }
});

test('a plan amended after the summary is refused PLAN_CHANGED at approve with confirmed, and the new summary names the new hashes', async () => {
  const f = fixture({effects: spendEffects});
  try {
    const id = await f.plan(ids);
    const shown = await f.alice({action: 'approval_summary', id});
    await amend(f, id, 'hold', 'amended');
    const now = await f.alice({action: 'approval_summary', id});
    assert.notEqual(now.plan_hash, shown.plan_hash);
    await assert.rejects(
      () => f.alice({...shown.next_call.arguments, ...shown.next_call.add_after_user_approval}),
      e => assertRefused(e, 'PLAN_CHANGED') && e.details.field === 'plan_hash',
    );
    assert.equal(f.stored(id).approval?.plan_hash, undefined);
    // The summary_hash of the old summary with the new plan_hash is refused too.
    await assert.rejects(
      () =>
        f.alice({
          ...now.next_call.arguments,
          summary_hash: shown.summary_hash,
          ...now.next_call.add_after_user_approval,
        }),
      e => assertRefused(e, 'PLAN_CHANGED') && e.details.field === 'summary_hash',
    );
    assert.deepEqual([f.state.prepares, f.state.attempts], [[], []]);
  } finally {
    f.store.close();
  }
});

test('the spend flag is still required for every spend step: an approval given without it stops the run at the first one', async () => {
  const f = fixture({effects: spendEffects, needs: needsFlag});
  try {
    const id = await f.plan(ids);
    const shown = await f.alice({action: 'approval_summary', id});
    // The approval the summary offers, given without the flag the summary says to add after the user approves.
    await f.alice({...shown.next_call.arguments});
    const ran = await f.alice({action: 'run', id});
    assert.equal(ran.run.stopped, 'needs_spend_change_confirmed');
    assert.deepEqual(writes(f), [], 'the first step spends, so nothing was sent');
    assert.deepEqual(f.state.attempts, [], 'run did not even try it without the flag');
  } finally {
    f.store.close();
  }
});

test('an approval revoked by amending the plan gives APPROVAL_REQUIRED, and its next call is the read-only summary', async () => {
  const f = fixture({effects: spendEffects});
  try {
    const id = await f.plan(ids);
    await approve(f, id);
    await amend(f, id, 'go_b', 'amended');
    await assert.rejects(
      () => f.alice({action: 'run', id}),
      e => assertRefused(e, 'APPROVAL_REQUIRED') && e.details.next_call.arguments.action === 'approval_summary',
    );
    assert.deepEqual(f.state.attempts, []);
  } finally {
    f.store.close();
  }
});

test('an approval recorded from another connection is refused with the read-only summary as its next call', async () => {
  const f = fixture({effects: spendEffects});
  try {
    const id = await f.plan(ids);
    await f.alice({action: 'assign', id, user_id: 'bob', role: 'approver'});
    await approve(f, id, {who: f.alice});
    await assert.rejects(
      () => f.bob({action: 'run', id}),
      e =>
        assertRefused(e, 'APPROVAL_REQUIRED') &&
        /another connection/.test(e.message) &&
        e.details.next_call.arguments.action === 'approval_summary',
    );
    assert.deepEqual(f.state.attempts, []);
  } finally {
    f.store.close();
  }
});

test('the refusals that send a person back to the summary name the read-only action in their words', async () => {
  const f = fixture({effects: spendEffects});
  try {
    const id = await f.plan(ids);
    const shown = await f.alice({action: 'approval_summary', id});
    // A plan_hash that is not the plan’s, then the plan’s without a summary_hash, then with one that is not the summary’s.
    for (const given of [
      {plan_hash: 'not-the-plan'},
      {plan_hash: shown.plan_hash},
      {plan_hash: shown.plan_hash, summary_hash: 'no'},
    ])
      await assert.rejects(
        () => f.alice({action: 'approve', id, confirmed: true, ...given}),
        e => assertRefused(e, 'PLAN_CHANGED') && /approval_summary/.test(e.message),
        JSON.stringify(given),
      );
    await assert.rejects(
      () => f.alice({action: 'run', id}),
      e => assertRefused(e, 'APPROVAL_REQUIRED') && /approval_summary/.test(e.message),
    );
    assert.equal(f.stored(id).approval?.plan_hash, undefined);
  } finally {
    f.store.close();
  }
});

test('a cancelled, archived or unknown plan has no approval to show: approval_summary is refused as approve is', async () => {
  const f = fixture();
  try {
    // A plan that is open is shown; the other plans below are not.
    const open = await f.plan(['one'], undefined, 'Open plan');
    assert.equal((await f.alice({action: 'approval_summary', id: open})).approval.steps.length, 1);
    const id = await f.plan(['one'], undefined, 'Cancelled plan');
    await f.alice({action: 'cancel', id, confirmed: true});
    await assert.rejects(
      () => f.alice({action: 'approval_summary', id}),
      e => assertRefused(e, 'INVALID_ARGUMENT', {message: /cancelled/}),
    );
    await f.alice({action: 'archive', id, confirmed: true});
    await assert.rejects(
      () => f.alice({action: 'approval_summary', id}),
      e => assertRefused(e, 'PLAN_ARCHIVED') && e.details.next_call.arguments.action === 'unarchive',
    );
    await assert.rejects(
      () => f.alice({action: 'approval_summary', id: 'no-such-plan'}),
      e => assertRefused(e, 'NOT_FOUND'),
    );
  } finally {
    f.store.close();
  }
});

test('approval_summary is a read: it does not need the write grants approve checks before it answers', async () => {
  const f = fixture({effects: spendEffects});
  try {
    const id = await f.plan(ids);
    await f.alice({action: 'assign', id, user_id: 'bob', role: 'viewer'});
    // The account’s write grant is taken away: approve (which checks it before the summary) is refused, the read is not.
    f.store.putConnection(
      admin,
      {
        id: 'snap',
        tenantId: admin.tenantId,
        gateway: 'snapchat_native_action',
        accounts: ['123'],
        writeAccounts: [],
        enabled: true,
        label: 'Snapchat',
        scopes: [],
      },
      {accessToken: 'synthetic'},
    );
    const shown = await f.bob({action: 'approval_summary', id});
    assert.equal(shown.approval.steps.length, 3);
    await assert.rejects(
      () => f.alice({action: 'approve', id}),
      e => assertRefused(e, 'WRITE_ACCOUNT_FORBIDDEN'),
    );
  } finally {
    f.store.close();
  }
});

test('a ready preflight is read, never repeated, and approval_summary never runs the one approve would', async () => {
  const f = fixture({effects: spendEffects, preflight: steps => readyPreflight(steps)});
  try {
    const id = await f.plan(ids);
    await f.alice({action: 'approval_summary', id});
    await f.alice({action: 'approval_summary', id});
    assert.equal(f.state.preflights, 0);
    await f.alice({action: 'preflight', id});
    await f.alice({action: 'approval_summary', id});
    assert.equal(f.state.preflights, 1, 'the one the person asked for');
  } finally {
    f.store.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {googleWorld} from '../dist/tests/helpers/google-write-fake.js';
import {savePlanPolicy} from '../dist/src/campaign-inventory.js';
import {createPlan, on} from './helpers/google-policy-failure.mjs';
import {keywordWorld} from './helpers/google-keyword-group.mjs';
import {
  T,
  budgets,
  executeNext,
  owner,
  planned,
  statusAction,
  statusUpdate,
  step,
  stored,
} from './helpers/plan-lifecycle-kit.mjs';

/**
 * r25-planmodel, N6 of the second review (S2): a continuation an earlier release made from a plan this release refuses to continue (a plan that activates a launch, one that retires
 * catalog products, or one saved from a preview), which carries none of its gates, its second approver or its check of the catalog. The old plan says "Continue there", and the
 * owner alone then prepared and executed the new plan: with the second approver required and the gates closed, the campaign was enabled (the reviewer's probe pn3-legacy: 1 write).
 * Now such a plan refuses to be approved, prepared, executed or run (RECOVERY_NOT_SAFE, with the cancel that works), and says so when it is read. Two states an earlier release
 * leaves: (a) the continuation finished (the new plan names the old one in `supersedes`), and (b) cut short after the new plan was made (the old plan is held and names it in
 * `superseded_by.to`, and the new plan has no `supersedes`).
 */
const activation = {id: 'launch', plan_hash: 'launch-hash', recipe_id: 'google_search_clicks', platform: 'google'},
  viewer = {tenantId: T, userId: 'viewer2', role: 'operator'},
  approving = {tenantId: T, userId: 'approver2', role: 'operator'},
  world = () => ({...keywordWorld(), campaignBudgets: {'customers/123/campaignBudgets/1': {}}}),
  named = call =>
    call && {tool: call.tool, arguments: call.arguments, add_after_user_approval: call.add_after_user_approval},
  cancelCall = id => ({
    tool: 'amcp_campaign',
    arguments: {action: 'cancel', id},
    add_after_user_approval: {confirmed: true},
  });
/** Every action the plan refuses, as the owner makes it. */
const refused = id => [
  {action: 'approve', id},
  {action: 'approve', id, confirmed: true},
  {action: 'run', id},
  {action: 'run_background', id},
  {action: 'prepare_next', id},
  {action: 'execute_next', id, review_id: 'none', confirmed: true},
  {action: 'activation_plan', id},
];
/** Rewrites a stored plan (the state an earlier release left). */
const put = (x, id, change) => {
  const {id: _id, revision, ...data} = stored(x, id);
  change(data);
  x.store.putDocument(T, 'campaign_run', id, data, revision);
};
/**
 * Two plans that enable a campaign, the second owner-only (the second approver is required, and the gates are closed). `bind` makes the first one bound (an activation plan) and
 * superseded by the second: finished (`superseded_by.id`, and the second names it in `supersedes`) or `held` (`superseded_by.pending` and `to`, the second has no `supersedes`).
 * The second plan is shared with a plan viewer and a plan approver.
 */
async function legacy({held = false, bind = true} = {}) {
  const x = googleWorld({policy: on, world: world()});
  savePlanPolicy(x.store, owner, {require_distinct_approver: true, confirmed: true});
  const make = () => createPlan(x, [step(statusUpdate, 's1', statusAction)]),
    p = await make(),
    n = await make();
  for (const user of ['operator', viewer.userId, approving.userId])
    x.store.db
      .prepare('INSERT OR IGNORE INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,?,?)')
      .run(T, user, 'operator', Date.now());
  put(x, n, d => {
    d.collaborators = [
      {user_id: viewer.userId, role: 'viewer', by: 'operator', at: Date.now()},
      {user_id: approving.userId, role: 'approver', by: 'operator', at: Date.now()},
    ];
    if (bind && !held) d.supersedes = {id: p, plan_hash: 'h', at: Date.now(), by: 'operator'};
  });
  if (bind) bindOld(x, p, n, held);
  return {x, p, n};
}
/** The old plan as an earlier release left it: an activation plan, superseded by `n` (finished), or held for it with the plan made. */
const bindOld = (x, p, n, held) =>
  put(x, p, d => {
    d.activation_of = {...activation, conversion_goals: {currency: 'USD'}};
    d.state = 'superseded';
    d.superseded_by = held
      ? {pending: true, to: n, at: Date.now() - 11 * 60000, by: 'operator'}
      : {id: n, at: Date.now(), by: 'operator'};
  });

for (const [kind, held] of [
  ['a finished continuation', false],
  ['a continuation cut short after its plan was made (the old plan is held, the new plan has no supersedes)', true],
])
  test(
    'N6: ' +
      kind +
      ' of an activation plan cannot be approved, prepared, executed or run, and says so; the cancel works (red on bbaa671b: the owner alone enabled the campaign)',
    async () => {
      const {x, p, n} = await legacy({held});
      try {
        for (const input of refused(n)) {
          const result = await x.call('amcp_campaign', input);
          assert.equal(result.success, false, input.action + ' is refused');
          assert.equal(
            result.error.code,
            'RECOVERY_NOT_SAFE',
            input.action + ': ' + JSON.stringify(result.error).slice(0, 300),
          );
          assert.equal(result.error.details.continues, p, input.action + ' names the plan it continues');
          assert.deepEqual(named(result.error.details.next_call), cancelCall(n), input.action + ' names the cancel');
          assert.match(result.error.message, /continues plan/, input.action);
        }
        assert.equal(x.writes(), 0, 'nothing was sent');
        // The reads say it, and name the cancel, not the plan's own actions.
        for (const input of [
          {action: 'get', id: n},
          {action: 'get', id: n, detail: 'full'},
        ]) {
          const read = await x.call('amcp_campaign', input);
          assert.equal(read.success, true);
          assert.match(String(read.data.notice), /continues plan/, JSON.stringify(input));
          assert.deepEqual(named(read.data.next_call), cancelCall(n), JSON.stringify(input));
        }
        const summary = await x.call('amcp_campaign', {action: 'approval_summary', id: n});
        assert.equal(
          summary.error?.code,
          'RECOVERY_NOT_SAFE',
          'the summary of what approve would cover is refused too',
        );
        // Cancelling stays possible, and releases the plan.
        const done = await x.call('amcp_campaign', {action: 'cancel', id: n, confirmed: true});
        assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 300));
        assert.equal(stored(x, n).state, 'cancelled');
        assert.equal(x.writes(), 0);
      } finally {
        x.store.close();
      }
    },
  );

test('N6: a plan viewer and a plan approver are told the plan cannot run, and that an editor can cancel it; no call that would be refused is named', async () => {
  const {x, p, n} = await legacy(),
    asViewer = input => x.service.call('amcp_campaign', input, viewer),
    asApprover = input => x.service.call('amcp_campaign', input, approving);
  try {
    const read = await asViewer({action: 'get', id: n}),
      approve = await asApprover({action: 'approve', id: n});
    for (const [who, result] of [
      ['the viewer reads', read],
      ['the approver approves', approve],
    ]) {
      const text = String(result.data?.notice ?? result.error?.message ?? '');
      assert.equal(result.data?.next_call ?? result.error?.details?.next_call ?? null, null, who + ' is named no call');
      assert.match(text, new RegExp('continues plan ' + p), who);
      assert.match(text, /An editor of this plan can cancel it/, who);
      assert.doesNotMatch(JSON.stringify(result), /"cancel"/, who);
    }
    assert.equal(approve.error.code, 'RECOVERY_NOT_SAFE');
    assert.equal(x.writes(), 0);
  } finally {
    x.store.close();
  }
});

test('N6: the lineage is followed through a plain plan, and a plan with a binding of its own is not refused', async () => {
  const {x, p, n} = await legacy(),
    third = await createPlan(x, [step(statusUpdate, 's1', statusAction)]);
  try {
    // A continuation of the continuation (made by this release, which can continue a plain plan): the bound plan is two links back.
    put(x, n, d => {
      d.state = 'superseded';
      d.superseded_by = {id: third, at: Date.now(), by: 'operator'};
    });
    put(x, third, d => {
      d.supersedes = {id: n, plan_hash: 'h', at: Date.now(), by: 'operator'};
    });
    const result = await x.call('amcp_campaign', {action: 'prepare_next', id: third});
    assert.equal(result.error?.code, 'RECOVERY_NOT_SAFE', JSON.stringify(result).slice(0, 300));
    assert.equal(result.error.details.continues, p, 'it names the plan that binds the lineage');
    assert.equal(x.writes(), 0);
    // A plan with a binding of its own carries it: it is not this refusal's.
    put(x, third, d => {
      d.catalog_retirement = {retailer_ids: ['SKU-OWN'], availability: 'discontinued'};
    });
    const read = await x.call('amcp_campaign', {action: 'get', id: third});
    assert.equal(read.success, true);
    assert.equal(read.data.notice, undefined, 'no notice: the plan has its own binding');
  } finally {
    x.store.close();
  }
});

test('N6: a continuation with nothing left to run is read as any plan: no notice, and no cancel offered', async () => {
  const {x, n} = await legacy();
  try {
    put(x, n, d => {
      d.steps[0].status = 'verified';
      d.state = 'complete';
    });
    const read = await x.call('amcp_campaign', {action: 'get', id: n});
    assert.equal(read.success, true);
    assert.equal(read.data.notice, undefined);
    assert.notDeepEqual(named(read.data.next_call), cancelCall(n));
  } finally {
    x.store.close();
  }
});

test('N6: a continuation made by this release from a plan with no binding is untouched: it prepares and executes', async () => {
  const {x, id} = await planned(budgets(2)),
    continued = await x.call('amcp_campaign', {action: 'continue_as_new', id, confirmed: true});
  try {
    assert.equal(continued.success, true, JSON.stringify(continued.error ?? continued).slice(0, 300));
    const next = continued.data.id,
      read = await x.call('amcp_campaign', {action: 'get', id: next});
    assert.equal(read.data.notice, undefined, 'no notice');
    const prepared = await x.call('amcp_campaign', {action: 'prepare_next', id: next});
    assert.equal(prepared.success, true, JSON.stringify(prepared.error ?? prepared).slice(0, 300));
    const sent = await executeNext(x, next, stored(x, next).steps[0].review_id);
    assert.equal(sent.success, true, JSON.stringify(sent.error ?? sent).slice(0, 300));
    assert.equal(x.writes(), 1, 'the first budget was sent once, by the continuation');
  } finally {
    x.store.close();
  }
});

test('N6: what is known of a workspace is kept for thirty seconds and looked up again after: a legacy state made meanwhile is refused once they have passed', async () => {
  const {x, p, n} = await legacy({bind: false}),
    realNow = Date.now;
  try {
    const first = await x.call('amcp_campaign', {action: 'get', id: n});
    assert.equal(first.data.notice, undefined, 'nothing binds it yet');
    // An older release process makes the continuation of an activation plan, cut short after its plan was made.
    bindOld(x, p, n, true);
    Date.now = () => realNow() + 31000;
    const result = await x.call('amcp_campaign', {action: 'prepare_next', id: n});
    assert.equal(result.error?.code, 'RECOVERY_NOT_SAFE', JSON.stringify(result).slice(0, 300));
    assert.equal(x.writes(), 0);
  } finally {
    Date.now = realNow;
    x.store.close();
  }
});

test('N6: a loop in the lineage (corrupt data) ends: the plan is read, and not refused', {timeout: 30000}, async () => {
  const {x, n} = await legacy({bind: false}),
    other = await createPlan(x, [step(statusUpdate, 's1', statusAction)]);
  try {
    put(x, n, d => {
      d.supersedes = {id: other, plan_hash: 'h', at: Date.now(), by: 'operator'};
    });
    put(x, other, d => {
      d.supersedes = {id: n, plan_hash: 'h', at: Date.now(), by: 'operator'};
    });
    const read = await x.call('amcp_campaign', {action: 'get', id: n});
    assert.equal(read.success, true);
    assert.equal(read.data.notice, undefined);
  } finally {
    x.store.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../dist/src/store.js';
import {CampaignRunner} from '../dist/src/campaign-runner.js';
import {savePlanPolicy} from '../dist/src/campaign-inventory.js';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * Round 2.5, package r25-field-plan, item 1 (the owner's Google issue 2, fix (a)): one plan approval covers the spend it showed.
 * The approval summary names each write step's spend effect (decided by the one rule each review applies, here a stand-in for the local
 * compile that src/campaign-spend-effects.ts makes); `summary_hash` binds that list; approve with spend_change_confirmed records the
 * steps it covers (`approval.spend_steps`); `run` passes the flag only to a step in that list, and for any other step that needs it, or
 * for an approval given without the flag, it stops. Where the approval showed the step and lacks the flag, the stop's next call approves
 * the same plan and summary again with the flag, and `run` then covers every such step: one stop instead of two calls a step.
 *
 * These cases drive the real plan engine with a stand-in for the tool calls it makes, so that every acknowledgement a review asks for
 * is the test's to choose. The end-to-end cases, with the real compile and a synthetic Google account, are in
 * campaign-plan-spend-google.test.mjs.
 */
const tenantId = 'plan-spend-' + randomUUID();
const alice = {tenantId, userId: 'alice', role: 'operator'},
  bob = {tenantId, userId: 'bob', role: 'operator'},
  admin = {tenantId, userId: 'owner-admin', role: 'admin'};

/**
 * A runner over a synthetic Snapchat connection. `needs` says, by step, what that step's review asks execute for (the keys of
 * execute_requirements); `state.effects` is what the local compile says of each step's spend effect, which a test may change.
 * `state.attempts` is every execute the runner asked for, and `state.sent` those the stand-in accepted: it refuses, as execute does, a
 * review whose flags are missing, so an attempt without a flag is visible even though nothing was sent.
 */
function fixture({needs = {}, effects = new Map(), provide = true} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 61).toString('base64'));
  for (const user of ['alice', 'bob'])
    store.db
      .prepare('INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,?,?)')
      .run(tenantId, user, 'operator', Date.now());
  store.putConnection(
    admin,
    {
      id: 'snap',
      tenantId,
      gateway: 'snapchat_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Snapchat',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const state = {needs, effects, reviews: new Map(), prepared: [], attempts: [], sent: [], count: 0},
    flags = ['spend_change_confirmed', 'cap_override_confirmed', 'creative_edit_confirmed', 'destructive_confirmed'];
  const call = async (name, input) => {
    assert.equal(name, 'amcp_write');
    if (input.action === 'prepare') {
      const marker = input.arguments.payload.marker,
        id = 'review-' + ++state.count;
      state.reviews.set(id, marker);
      state.prepared.push(marker);
      return {
        success: true,
        data: {
          review_id: id,
          idempotency_key: id,
          expires_at: new Date(Date.now() + 300000).toISOString(),
          request: input.arguments,
          execute_requirements: {
            confirmed: true,
            idempotency_key: id,
            ...Object.fromEntries(flags.map(flag => [flag, state.needs[marker]?.[flag] === true])),
            reasons: [],
          },
        },
      };
    }
    assert.equal(input.action, 'execute');
    const marker = state.reviews.get(input.review_id),
      attempt = {marker, ...Object.fromEntries(flags.map(flag => [flag, input[flag]]))};
    state.attempts.push(attempt);
    // Execute refuses a review whose acknowledgement it was not given, before anything is sent.
    const missing = flags.find(flag => state.needs[marker]?.[flag] === true && input[flag] !== true);
    if (missing)
      return {
        success: false,
        error: {code: 'SPEND_CONFIRMATION_REQUIRED', message: 'This review needs ' + missing + '.', details: {}},
      };
    state.sent.push(attempt);
    store.claim(tenantId, input.review_id, 'request');
    const result = {data: {marker}};
    store.complete(tenantId, input.review_id, result);
    return {success: true, data: result};
  };
  const runner = new CampaignRunner(
    store,
    call,
    async () => ({status: 'verified'}),
    async () => ({}),
    async () => ({status: 'ready', checks: []}),
    undefined,
    undefined,
    undefined,
    undefined,
    provide ? () => state.effects : undefined,
  );
  const as = who => input => runner.handle(input, who);
  /** The plan with these step IDs, one write step each, saved by `who`. */
  const plan = async (ids, who = alice, name = 'Go live') =>
    (
      await as(who)({
        action: 'create',
        name,
        brief: 'Synthetic.',
        steps: ids.map(id => ({
          id,
          kind: 'write',
          gateway: 'snapchat_native_action',
          connection_id: 'snap',
          account_id: '123',
          description: id,
          arguments: {action: 'snapchat_campaign_update', payload: {marker: id}},
        })),
      })
    ).id;
  /** What a stored plan holds now. */
  const stored = id => store.document(tenantId, 'campaign_run', id);
  return {store, state, runner, alice: as(alice), bob: as(bob), as, plan, stored};
}
/** Approves a plan the way an agent does: the summary, then its next call with, or without, the flag the call adds. */
async function approve(f, id, {flag = true, who = f.alice} = {}) {
  const preview = await who({action: 'approve', id});
  const approved = await who({
    ...preview.next_call.arguments,
    ...(flag ? preview.next_call.add_after_user_approval : {}),
  });
  return {preview, approved};
}
const writes = f => f.state.sent.map(s => s.marker);
const attempts = f => f.state.attempts.map(s => s.marker);

test('approve names each write step’s spend effect, lists the steps it covers and binds that list in its hash', async () => {
  const f = fixture({
    effects: new Map([
      ['go_a', true],
      ['hold', false],
      ['go_b', true],
    ]),
  });
  try {
    const id = await f.plan(['go_a', 'hold', 'go_b']);
    const preview = await f.alice({action: 'approve', id});
    assert.deepEqual(
      preview.approval.steps.map(s => [s.id, s.spend_effect]),
      [
        ['go_a', true],
        ['hold', false],
        ['go_b', true],
      ],
    );
    assert.deepEqual(
      preview.approval.spend_steps,
      ['go_a', 'go_b'],
      'the approval names the steps whose spend it shows',
    );
    // No step names a money field, yet the approval offers the flag: the flag follows the spend effect, not the field names.
    assert.deepEqual(preview.next_call.add_after_user_approval, {spend_change_confirmed: true});
    assert.equal(preview.next_call.arguments.summary_hash, preview.approval.summary_hash);
    // The list is part of what the user approves: another list is another summary, so an approval of the first is refused.
    f.state.effects = new Map([
      ['go_a', true],
      ['hold', true],
      ['go_b', true],
    ]);
    const other = await f.alice({action: 'approve', id});
    assert.notEqual(other.summary_hash, preview.summary_hash);
    assert.deepEqual(other.approval.spend_steps, ['go_a', 'hold', 'go_b']);
    await assert.rejects(
      () => f.alice({...preview.next_call.arguments, ...preview.next_call.add_after_user_approval}),
      e => assertRefused(e, 'PLAN_CHANGED'),
    );
    assert.equal(f.state.attempts.length, 0);
  } finally {
    f.store.close();
  }
});

test('a plan whose steps show no spend effect is offered no flag', async () => {
  const f = fixture({
    effects: new Map([
      ['hold_a', false],
      ['hold_b', false],
    ]),
  });
  try {
    const id = await f.plan(['hold_a', 'hold_b']);
    const preview = await f.alice({action: 'approve', id});
    assert.deepEqual(
      preview.approval.steps.map(s => [s.id, s.spend_effect]),
      [
        ['hold_a', false],
        ['hold_b', false],
      ],
    );
    assert.deepEqual(preview.approval.spend_steps, []);
    assert.equal(preview.next_call.add_after_user_approval, undefined);
  } finally {
    f.store.close();
  }
});

test('a runner given no way to decide spend effects names none, and offers the flag by money fields alone, as before', async () => {
  const f = fixture({provide: false});
  try {
    const id = await f.plan(['one', 'two']);
    const preview = await f.alice({action: 'approve', id});
    assert.deepEqual(
      preview.approval.steps.map(s => s.spend_effect),
      [undefined, undefined],
    );
    assert.equal(preview.approval.spend_steps, undefined);
    assert.equal(preview.next_call.add_after_user_approval, undefined);
    const approved = await f.alice({...preview.next_call.arguments});
    assert.deepEqual(approved.approved, {by: 'alice', spend_change_confirmed: false});
    assert.equal(f.stored(id).approval.spend_steps, undefined);
  } finally {
    f.store.close();
  }
});

test('a step whose spend effect cannot be decided counts as spending (fail closed)', async () => {
  // The provider names no step: every write step of the plan counts as one that spends, and the approval offers the flag.
  const f = fixture({effects: new Map()});
  try {
    const id = await f.plan(['one', 'two']);
    const preview = await f.alice({action: 'approve', id});
    assert.deepEqual(
      preview.approval.steps.map(s => s.spend_effect),
      [true, true],
    );
    assert.deepEqual(preview.next_call.add_after_user_approval, {spend_change_confirmed: true});
    // A provider that fails altogether is the same: nothing is shown as safe because it could not be checked.
    const broken = fixture();
    const runner = new CampaignRunner(
      broken.store,
      async () => assert.fail('no tool call is expected'),
      async () => ({status: 'verified'}),
      async () => ({}),
      async () => ({status: 'ready', checks: []}),
      undefined,
      undefined,
      undefined,
      undefined,
      () => {
        throw new Error('the compile failed');
      },
    );
    const created = await runner.handle(
      {
        action: 'create',
        name: 'Broken',
        brief: 'Synthetic.',
        steps: [
          {
            id: 'only',
            kind: 'write',
            gateway: 'snapchat_native_action',
            connection_id: 'snap',
            account_id: '123',
            arguments: {action: 'snapchat_campaign_update', payload: {marker: 'only'}},
          },
        ],
      },
      alice,
    );
    const shown = await runner.handle({action: 'approve', id: created.id}, alice);
    assert.deepEqual(
      shown.approval.steps.map(s => s.spend_effect),
      [true],
    );
    broken.store.close();
  } finally {
    f.store.close();
  }
});

test('approve with the flag records the steps it covers, and without it records none', async () => {
  const f = fixture({
    effects: new Map([
      ['go_a', true],
      ['hold', false],
      ['go_b', true],
    ]),
  });
  try {
    const flagged = await f.plan(['go_a', 'hold', 'go_b'], alice, 'Flagged'),
      plain = await f.plan(['go_a', 'hold', 'go_b'], alice, 'Plain');
    const given = await approve(f, flagged);
    assert.deepEqual(given.approved.approved, {
      by: 'alice',
      spend_change_confirmed: true,
      spend_steps: ['go_a', 'go_b'],
    });
    assert.deepEqual(f.stored(flagged).approval.spend_steps, ['go_a', 'go_b']);
    const without = await approve(f, plain, {flag: false});
    assert.equal(without.approved.approved.spend_change_confirmed, false);
    assert.deepEqual(without.approved.approved.spend_steps, []);
    assert.deepEqual(f.stored(plain).approval.spend_steps, [], 'an approval without the flag covers no step');
    // It still records what the summary showed, so that run can offer the one re-approval for those steps.
    assert.deepEqual(f.stored(plain).approval.spend_effect_steps, ['go_a', 'go_b']);
    const audited = f.store.db
      .prepare('SELECT event FROM audit WHERE tenant_id=?')
      .all(tenantId)
      .map(r => JSON.parse(r.event))
      .filter(e => e.event === 'campaign_plan_approved');
    assert.deepEqual(
      audited.map(e => [e.spend_change_confirmed, e.spend_steps]),
      [
        [true, ['go_a', 'go_b']],
        [false, []],
      ],
    );
  } finally {
    f.store.close();
  }
});

test('run passes the flag only to a step the approval covers, and runs a plan approved with it without a stop', async () => {
  const f = fixture({
    needs: {go_a: {spend_change_confirmed: true}, go_b: {spend_change_confirmed: true}},
    effects: new Map([
      ['go_a', true],
      ['hold', false],
      ['go_b', true],
    ]),
  });
  try {
    const id = await f.plan(['go_a', 'hold', 'go_b']);
    await approve(f, id);
    const ran = await f.alice({action: 'run', id});
    assert.equal(ran.run.stopped, 'complete', JSON.stringify(ran.run));
    assert.deepEqual(ran.run.executed, ['go_a', 'hold', 'go_b']);
    // One execute for each step, and the flag only where the review asked for it.
    assert.deepEqual(
      f.state.sent.map(s => [s.marker, s.spend_change_confirmed]),
      [
        ['go_a', true],
        ['hold', undefined],
        ['go_b', true],
      ],
    );
  } finally {
    f.store.close();
  }
});

test('the shape of the M5 go-live: 40 status-only steps approved with the flag run in one call, with no stop for it', async () => {
  const ids = Array.from({length: 40}, (_, i) => 'enable_' + (i + 1));
  const f = fixture({
    needs: Object.fromEntries(ids.map(step => [step, {spend_change_confirmed: true}])),
    effects: new Map(ids.map(step => [step, true])),
  });
  try {
    const id = await f.plan(ids, alice, 'Go live, 40 steps');
    const {preview} = await approve(f, id);
    assert.deepEqual(preview.next_call.add_after_user_approval, {spend_change_confirmed: true});
    assert.equal(preview.approval.spend_steps.length, 40);
    const ran = await f.alice({action: 'run', id});
    assert.equal(ran.run.stopped, 'complete', JSON.stringify(ran.run).slice(0, 400));
    assert.equal(ran.run.executed.length, 40);
    assert.equal(f.state.sent.length, 40);
    assert.ok(f.state.sent.every(s => s.spend_change_confirmed === true));
  } finally {
    f.store.close();
  }
});

test('an approval given without the flag never sends a flagged step: run stops once, and the next call approves the same plan with the flag', async () => {
  const f = fixture({
    needs: {go_a: {spend_change_confirmed: true}, go_b: {spend_change_confirmed: true}},
    effects: new Map([
      ['go_a', true],
      ['hold', false],
      ['go_b', true],
    ]),
  });
  try {
    const id = await f.plan(['hold', 'go_a', 'go_b']);
    const {approved} = await approve(f, id, {flag: false});
    const approval = f.stored(id).approval;
    const first = await f.alice({action: 'run', id});
    assert.equal(first.run.stopped, 'needs_spend_change_confirmed', JSON.stringify(first.run));
    assert.deepEqual(first.run.executed, ['hold']);
    assert.equal(first.step_id, 'go_a');
    assert.ok(first.review, 'the review of the step it stopped at');
    // The stop is the one place the flag is asked for: its next call approves this plan and this summary again, with the flag.
    assert.deepEqual(first.next_call, {
      tool: 'amcp_campaign',
      arguments: {
        action: 'approve',
        id,
        plan_hash: approval.plan_hash,
        summary_hash: approval.summary_hash,
        confirmed: true,
      },
      add_after_user_approval: {spend_change_confirmed: true},
    });
    assert.equal(approved.approved.spend_change_confirmed, false);
    // It lists the steps the flag will cover, and keeps the one-step alternative.
    assert.deepEqual(first.run.spend_steps, ['go_a', 'go_b']);
    assert.equal(first.run.step_call.arguments.action, 'execute_next');
    assert.deepEqual(first.run.step_call.add_after_user_approval, {spend_change_confirmed: true});
    // Nothing flagged was sent, or even asked of execute, and calling run again changes nothing.
    assert.deepEqual(writes(f), ['hold']);
    assert.deepEqual(attempts(f), ['hold']);
    assert.equal((await f.alice({action: 'run', id})).run.stopped, 'needs_spend_change_confirmed');
    assert.deepEqual(attempts(f), ['hold']);
    // One re-approval, then run covers every flagged step.
    const again = await f.alice({...first.next_call.arguments, ...first.next_call.add_after_user_approval});
    assert.equal(again.approved.spend_change_confirmed, true);
    assert.deepEqual(f.stored(id).approval.spend_steps, ['go_a', 'go_b']);
    const ran = await f.alice({action: 'run', id});
    assert.equal(ran.run.stopped, 'complete', JSON.stringify(ran.run));
    assert.deepEqual(writes(f), ['hold', 'go_a', 'go_b']);
    assert.deepEqual(
      f.state.sent.map(s => s.spend_change_confirmed),
      [undefined, true, true],
    );
  } finally {
    f.store.close();
  }
});

test('a step outside spend_steps stops on its own: the flag is never given to a step the approval did not show', async () => {
  // go_b's local compile said it needs nothing, and its review (prepared with the real predecessor values) asks for the flag.
  const f = fixture({
    needs: {go_a: {spend_change_confirmed: true}, go_b: {spend_change_confirmed: true}},
    effects: new Map([
      ['go_a', true],
      ['go_b', false],
    ]),
  });
  try {
    const id = await f.plan(['go_a', 'go_b']);
    await approve(f, id);
    assert.deepEqual(f.stored(id).approval.spend_steps, ['go_a']);
    const ran = await f.alice({action: 'run', id});
    assert.equal(ran.run.stopped, 'needs_spend_change_confirmed', JSON.stringify(ran.run));
    assert.deepEqual(ran.run.executed, ['go_a']);
    assert.equal(ran.step_id, 'go_b');
    // Approving the same summary again cannot cover it (the summary did not show it), so the stop is the step's own: execute_next.
    assert.equal(ran.next_call.arguments.action, 'execute_next');
    assert.equal(ran.next_call.arguments.review_id, ran.review.review_id);
    assert.deepEqual(ran.next_call.add_after_user_approval, {spend_change_confirmed: true});
    assert.deepEqual(attempts(f), ['go_a'], 'the step was not even asked of execute');
    const done = await f.alice({...ran.next_call.arguments, spend_change_confirmed: true});
    assert.equal(done.state, 'complete');
    assert.deepEqual(writes(f), ['go_a', 'go_b']);
  } finally {
    f.store.close();
  }
});

test('a cap override, a creative edit and a destructive step still stop per step, whatever the approval covers', async () => {
  const f = fixture({
    needs: {
      capped: {spend_change_confirmed: true, cap_override_confirmed: true},
      edited: {creative_edit_confirmed: true},
      removed: {destructive_confirmed: true},
    },
    effects: new Map([
      ['capped', true],
      ['edited', true],
      ['removed', true],
    ]),
  });
  try {
    const id = await f.plan(['capped', 'edited', 'removed']);
    await approve(f, id);
    for (const [step, stopped, flag] of [
      ['capped', 'needs_cap_override_confirmed', 'cap_override_confirmed'],
      ['edited', 'needs_creative_edit_confirmed', 'creative_edit_confirmed'],
      ['removed', 'needs_destructive_confirmed', 'destructive_confirmed'],
    ]) {
      const before = attempts(f).length,
        ran = await f.alice({action: 'run', id});
      assert.equal(ran.run.stopped, stopped, step + ': ' + JSON.stringify(ran.run).slice(0, 300));
      assert.equal(ran.step_id, step);
      assert.equal(attempts(f).length, before, step + ' was not sent, or asked of execute');
      // The person's own acknowledgement of that one review, as before.
      const flags = {...ran.next_call.add_after_user_approval};
      assert.equal(flags[flag], true, step);
      const done = await f.alice({...ran.next_call.arguments, ...flags});
      assert.ok(done.steps.find(s => s.id === step).status === 'verified', step);
    }
    assert.deepEqual(writes(f), ['capped', 'edited', 'removed']);
    assert.equal((await f.alice({action: 'run', id})).run.stopped, 'complete');
  } finally {
    f.store.close();
  }
});

test('an approval recorded before this change covers what it did: the flag, for every step', async () => {
  const f = fixture({
    needs: {go_a: {spend_change_confirmed: true}, go_b: {spend_change_confirmed: true}},
    effects: new Map(),
  });
  try {
    // An approval that names no steps (it was recorded before the approval named them) with the flag covers every step, as it did.
    const flagged = await f.plan(['go_a', 'go_b'], alice, 'Recorded with the flag'),
      plain = await f.plan(['go_a', 'go_b'], alice, 'Recorded without it');
    for (const id of [flagged, plain]) await approve(f, id, {flag: id === flagged});
    const forget = id => {
      const {id: _id, revision, ...data} = f.stored(id),
        {spend_steps: _covered, spend_effect_steps: _shown, ...approval} = data.approval;
      f.store.putDocument(tenantId, 'campaign_run', id, {...data, approval}, revision);
    };
    forget(flagged);
    forget(plain);
    assert.equal(f.stored(flagged).approval.spend_steps, undefined);
    const ran = await f.alice({action: 'run', id: flagged});
    assert.equal(ran.run.stopped, 'complete', JSON.stringify(ran.run));
    assert.deepEqual(writes(f), ['go_a', 'go_b']);
    // Without the flag it stops per step, as it did: the step's own execute_next, since it names no step the approval showed.
    const stopped = await f.alice({action: 'run', id: plain});
    assert.equal(stopped.run.stopped, 'needs_spend_change_confirmed');
    assert.equal(stopped.next_call.arguments.action, 'execute_next');
    assert.deepEqual(writes(f), ['go_a', 'go_b'], 'nothing more was sent');
  } finally {
    f.store.close();
  }
});

test('the distinct-approver policy is unchanged: the owner cannot approve a plan that changes spending, an approver can and records its steps', async () => {
  const f = fixture({
    needs: {go_a: {spend_change_confirmed: true}},
    effects: new Map([['go_a', true]]),
  });
  try {
    savePlanPolicy(f.store, admin, {require_distinct_approver: true, confirmed: true});
    // A plan with a budget field changes spending by the name of its field, as the policy has always read it.
    const id = (
      await f.alice({
        action: 'create',
        name: 'Budget plan',
        brief: 'Synthetic.',
        steps: [
          {
            id: 'go_a',
            kind: 'write',
            gateway: 'snapchat_native_action',
            connection_id: 'snap',
            account_id: '123',
            arguments: {action: 'snapchat_adsquad_update', payload: {marker: 'go_a', daily_budget_micro: 1000000}},
          },
        ],
      })
    ).id;
    const preview = await f.alice({action: 'approve', id});
    assert.equal(preview.approver_required, true);
    await assert.rejects(
      () =>
        f.alice({
          action: 'approve',
          id,
          plan_hash: preview.plan_hash,
          summary_hash: preview.summary_hash,
          confirmed: true,
          spend_change_confirmed: true,
        }),
      e => assertRefused(e, 'DISTINCT_APPROVER_REQUIRED'),
    );
    await f.alice({action: 'assign', id, user_id: 'bob', role: 'approver'});
    const shown = await f.bob({action: 'approve', id});
    assert.equal(shown.approver_required, undefined);
    assert.deepEqual(shown.approval.spend_steps, ['go_a']);
    const given = await f.bob({...shown.next_call.arguments, ...shown.next_call.add_after_user_approval});
    assert.deepEqual(given.approved, {by: 'bob', spend_change_confirmed: true, spend_steps: ['go_a']});
    // Its steps execute only under that other person's approval, as before.
    const ran = await f.bob({action: 'run', id});
    assert.equal(ran.run.stopped, 'complete', JSON.stringify(ran.run));
    assert.deepEqual(writes(f), ['go_a']);
  } finally {
    f.store.close();
  }
});

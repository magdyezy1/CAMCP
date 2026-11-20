import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../dist/src/store.js';
import {CampaignRunner} from '../dist/src/campaign-runner.js';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * Round 2.5, package r25-field-plan, item 2 (the owner's Google issue 1, fix 1b): a saved plan could not lose a step. continue_as_new carried
 * every step still to write into a new linked plan, and only that, so the way to leave a step out was to cancel the plan and create it again
 * with the other steps sent over. continue_as_new now takes `changes: {drop: [step_id]}`, with the drop rule of a clone (a dropped step takes
 * its dependants with it). Only a step nothing was sent for (pending, or its review ready) may be dropped: a step that reached the provider
 * keeps the guard continue_as_new always had (RECOVERY_NOT_SAFE), so a drop cannot hide a write that may have been applied. The new plan has
 * its own plan_hash, so it needs its own approval. A second call on a plan already superseded is refused when its drop differs from the one
 * recorded, where it used to return the earlier continuation without a word, and a plan that is one atomic Google clone, whose ad groups are
 * operations inside a single build and no steps, is told to cancel and clone again with the ad groups it wants.
 */
const tenantId = 'continue-drop-' + randomUUID();
const alice = {tenantId, userId: 'alice', role: 'operator'},
  admin = {tenantId, userId: 'owner-admin', role: 'admin'};
const ref = step => ({$ref: step + '#/data/id'});
const write = (id, depends = [], payload = {}) => ({
  id,
  kind: 'write',
  gateway: 'snapchat_native_action',
  connection_id: 'snap',
  account_id: '123',
  description: id,
  arguments: {action: 'snapchat_campaign_update', payload: {marker: id, ...payload}},
  depends_on: depends,
});
/** A campaign, two ad sets under it, and an ad under each: the campaign is the one that runs first. */
const launch = () => [
  write('campaign'),
  write('adset_a', ['campaign'], {campaign_id: ref('campaign')}),
  write('ad_a', ['adset_a'], {adset_id: ref('adset_a')}),
  write('adset_b', ['campaign'], {campaign_id: ref('campaign')}),
  write('ad_b', ['adset_b'], {adset_id: ref('adset_b')}),
];

/** A runner whose tool calls are a script: what each step's prepare and execute answer is the test's to set (`state`). */
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 67).toString('base64'));
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
  // `uncertain`: steps whose execute is sent and whose answer is lost. `refused`: steps whose prepare is refused before anything is sent.
  const state = {reviews: new Map(), sent: [], uncertain: new Set(), refused: new Set(), count: 0};
  const runner = new CampaignRunner(
    store,
    async (name, input) => {
      assert.equal(name, 'amcp_write');
      if (input.action === 'prepare') {
        const marker = input.arguments.payload.marker;
        if (state.refused.has(marker))
          return {success: false, error: {code: 'INVALID_ARGUMENT', message: 'The request is refused.', details: {}}};
        const id = 'review-' + ++state.count;
        state.reviews.set(id, marker);
        return {
          success: true,
          data: {
            review_id: id,
            idempotency_key: id,
            expires_at: new Date(Date.now() + 300000).toISOString(),
            request: input.arguments,
            execute_requirements: {confirmed: true, idempotency_key: id, spend_change_confirmed: false, reasons: []},
          },
        };
      }
      const marker = state.reviews.get(input.review_id);
      state.sent.push(marker);
      store.claim(tenantId, input.review_id, 'request');
      if (state.uncertain.has(marker)) {
        store.uncertain(tenantId, input.review_id);
        return {success: false, error: {code: 'WRITE_OUTCOME_UNCERTAIN', message: 'The answer was lost.', details: {}}};
      }
      const result = {data: {id: String(700 + state.sent.length)}};
      store.complete(tenantId, input.review_id, result);
      return {success: true, data: result};
    },
    async () => ({status: 'verified'}),
    async () => ({}),
    async () => ({status: 'ready', checks: []}),
  );
  const call = input => runner.handle(input, alice);
  /** Saves the plan and runs its first step, so that the campaign is verified and the rest still to write. */
  const started = async (steps = launch()) => {
    const plan = await call({action: 'create', name: 'Launch', brief: 'Synthetic.', steps});
    const prepared = await call({action: 'prepare_next', id: plan.id});
    await call({
      action: 'execute_next',
      id: plan.id,
      review_id: prepared.review.review_id,
      idempotency_key: prepared.review.idempotency_key,
      confirmed: true,
    });
    return plan.id;
  };
  const plans = () => store.documents(tenantId, 'campaign_run');
  const stored = id => store.document(tenantId, 'campaign_run', id);
  const audits = () =>
    store.db
      .prepare('SELECT event FROM audit WHERE tenant_id=?')
      .all(tenantId)
      .map(r => JSON.parse(r.event));
  return {store, state, call, started, plans, stored, audits};
}

test('continue_as_new with a drop leaves the steps out with their dependants, adopts the verified IDs and links the plans', async () => {
  const f = fixture();
  try {
    const id = await f.started();
    const next = await f.call({
      action: 'continue_as_new',
      id,
      confirmed: true,
      changes: {drop: ['adset_a']},
      detail: 'full',
    });
    // The ad under the dropped ad set goes with it; the other ad set and its ad are carried, over the campaign the first plan made.
    assert.deepEqual(
      next.steps.map(s => s.id),
      ['adset_b', 'ad_b'],
    );
    assert.deepEqual(next.dropped, ['adset_a', 'ad_a']);
    assert.equal(
      next.steps[0].arguments.payload.campaign_id,
      '701',
      'the verified campaign is adopted as a literal ID',
    );
    assert.equal(next.steps[0].adopted_from[0].step_id, 'campaign');
    assert.deepEqual(next.steps[1].depends_on, ['adset_b']);
    assert.equal(next.supersedes.id, id);
    assert.equal(next.state, 'draft');
    assert.deepEqual(next.next_call.arguments, {action: 'approve', id: next.id});
    // The first plan is superseded, and records the drop it was continued with.
    const old = f.stored(id);
    assert.equal(old.state, 'superseded');
    assert.equal(old.superseded_by.id, next.id);
    assert.deepEqual(old.superseded_by.drop, ['adset_a']);
    assert.deepEqual(old.superseded_by.dropped, ['adset_a', 'ad_a']);
    assert.ok(
      f
        .audits()
        .some(e => e.event === 'campaign_plan_superseded' && e.id === id && e.dropped?.join() === 'adset_a,ad_a'),
    );
    // Nothing was sent for the dropped steps, and nothing more was sent at all.
    assert.deepEqual(f.state.sent, ['campaign']);
  } finally {
    f.store.close();
  }
});

test('a step whose review is ready is unsent and may be dropped; the review is left to lapse', async () => {
  const f = fixture();
  try {
    const id = await f.started();
    const prepared = await f.call({action: 'prepare_next', id});
    assert.equal(prepared.step_id, 'adset_a');
    assert.equal(f.stored(id).steps.find(s => s.id === 'adset_a').status, 'review_ready');
    const next = await f.call({
      action: 'continue_as_new',
      id,
      confirmed: true,
      changes: {drop: ['adset_a']},
      detail: 'full',
    });
    assert.deepEqual(
      next.steps.map(s => s.id),
      ['adset_b', 'ad_b'],
    );
    assert.deepEqual(f.state.sent, ['campaign'], 'the ready review was never executed');
  } finally {
    f.store.close();
  }
});

test('a step that reached the provider cannot be dropped: the guard of continue_as_new stands, and nothing is continued', async () => {
  const f = fixture();
  try {
    f.state.uncertain.add('adset_a');
    const id = await f.started();
    const prepared = await f.call({action: 'prepare_next', id});
    const lost = await f.call({
      action: 'execute_next',
      id,
      review_id: prepared.review.review_id,
      idempotency_key: prepared.review.idempotency_key,
      confirmed: true,
    });
    assert.equal(lost.steps.find(s => s.id === 'adset_a').status, 'uncertain');
    const before = f.plans().length;
    // Neither a drop of that step nor a drop of another one gets past it: it may have been applied.
    for (const drop of [['adset_a'], ['adset_b'], ['ad_a']])
      await assert.rejects(
        () => f.call({action: 'continue_as_new', id, confirmed: true, changes: {drop}}),
        e => {
          assertRefused(e, 'RECOVERY_NOT_SAFE');
          assert.deepEqual(
            e.details.blocked_steps.map(b => b.step_id),
            ['adset_a'],
          );
          return true;
        },
      );
    assert.equal(f.plans().length, before, 'no plan was saved');
    assert.equal(f.stored(id).state, 'attention', 'the plan was not superseded');
    assert.equal(f.stored(id).superseded_by, undefined);
  } finally {
    f.store.close();
  }
});

test('only a step nothing was sent for is dropped: a failed step is amended or cancelled, not dropped', async () => {
  const f = fixture();
  try {
    f.state.refused.add('adset_a');
    const id = await f.started();
    const failed = await f.call({action: 'prepare_next', id});
    assert.equal(failed.steps.find(s => s.id === 'adset_a').status, 'failed');
    await assert.rejects(
      () => f.call({action: 'continue_as_new', id, confirmed: true, changes: {drop: ['adset_a']}}),
      e => {
        assertRefused(e, 'RECOVERY_NOT_SAFE');
        assert.equal(e.details.step_id, 'adset_a');
        assert.equal(e.details.status, 'failed');
        return true;
      },
    );
    assert.equal(f.stored(id).state, 'attention');
    // A dependant that goes with a dropped step is held to the same rule. The engine never prepares a step before its predecessor is
    // verified, so the stored plan is made so: the ad under adset_b is failed, and dropping adset_b would take it with it.
    const other = await f.started();
    const {id: _id, revision, ...data} = f.stored(other);
    f.store.putDocument(
      tenantId,
      'campaign_run',
      other,
      {...data, steps: data.steps.map(s => (s.id === 'ad_b' ? {...s, status: 'failed'} : s))},
      revision,
    );
    await assert.rejects(
      () => f.call({action: 'continue_as_new', id: other, confirmed: true, changes: {drop: ['adset_b']}}),
      e => {
        assertRefused(e, 'RECOVERY_NOT_SAFE');
        assert.equal(e.details.step_id, 'ad_b');
        assert.equal(e.details.status, 'failed');
        return true;
      },
    );
    assert.equal(f.stored(other).state, 'in_progress');
  } finally {
    f.store.close();
  }
});

test('a drop that names no step still to write, or asks for more than a drop, is refused and changes nothing', async () => {
  const f = fixture();
  try {
    const id = await f.started();
    const before = f.plans().length;
    for (const [changes, field] of [
      // The settled campaign is not a step still to write; an unknown step is none of the plan's.
      [{drop: ['campaign']}, 'changes.drop'],
      [{drop: ['nope']}, 'changes.drop'],
      [{drop: 'adset_a'}, 'changes.drop'],
      [{drop: [7]}, 'changes.drop'],
      // A saved plan is amended with recover_step: only the drop is taken here.
      [{set: [{step_id: 'adset_a', path: '/payload/name', value: 'x'}]}, 'changes'],
      [{drop: ['adset_a'], set: []}, 'changes'],
      [{drops: ['adset_a']}, 'changes'],
      ['adset_a', 'changes'],
      // Every step still to write would be dropped.
      [{drop: ['adset_a', 'adset_b']}, 'changes.drop'],
    ])
      await assert.rejects(
        () => f.call({action: 'continue_as_new', id, confirmed: true, changes}),
        e => {
          assertRefused(e, 'INVALID_ARGUMENT');
          assert.equal(e.details.field, field, JSON.stringify(changes));
          return true;
        },
      );
    assert.equal(f.plans().length, before);
    assert.equal(f.stored(id).state, 'in_progress');
    // Without the user's confirmation nothing is continued either, and the refusal names the steps that would be.
    await assert.rejects(
      () => f.call({action: 'continue_as_new', id, changes: {drop: ['adset_a']}}),
      e => {
        assertRefused(e, 'INVALID_ARGUMENT');
        assert.deepEqual(e.details.carried, ['adset_b', 'ad_b']);
        return true;
      },
    );
    assert.equal(f.plans().length, before);
  } finally {
    f.store.close();
  }
});

test('the old approval does not cover the new plan: it has its own plan_hash and needs its own approval', async () => {
  const f = fixture();
  try {
    const id = await f.started();
    const preview = await f.call({action: 'approve', id});
    await f.call({...preview.next_call.arguments});
    const next = await f.call({action: 'continue_as_new', id, confirmed: true, changes: {drop: ['adset_a']}});
    assert.notEqual(next.plan_hash, preview.plan_hash);
    assert.equal(f.stored(next.id).approval?.plan_hash, undefined, 'the new plan holds no approval');
    await assert.rejects(
      () => f.call({action: 'run', id: next.id}),
      e => assertRefused(e, 'APPROVAL_REQUIRED'),
    );
    // The first approval, given to the new plan, names the plan it was for.
    await assert.rejects(
      () => f.call({...preview.next_call.arguments, id: next.id}),
      e => assertRefused(e, 'PLAN_CHANGED'),
    );
    // The superseded plan runs nothing under it either.
    await assert.rejects(
      () => f.call({action: 'run', id}),
      e => assertRefused(e, 'INVALID_ARGUMENT'),
    );
    assert.deepEqual(f.state.sent, ['campaign']);
  } finally {
    f.store.close();
  }
});

test('a second continue_as_new of a superseded plan returns the continuation only for the same drop, and refuses another', async () => {
  const f = fixture();
  try {
    const id = await f.started();
    const first = await f.call({action: 'continue_as_new', id, confirmed: true, changes: {drop: ['adset_a']}});
    const plansAfter = f.plans().length;
    // The same drop, in any order or with a repeat, is the same continuation.
    const same = await f.call({
      action: 'continue_as_new',
      id,
      confirmed: true,
      changes: {drop: ['adset_a', 'adset_a']},
    });
    assert.equal(same.id, first.id);
    assert.equal(f.plans().length, plansAfter);
    // Another drop, or none, is not what was done: the earlier continuation is no answer to it.
    for (const changes of [{drop: ['adset_b']}, {drop: ['adset_a', 'adset_b']}, undefined])
      await assert.rejects(
        () => f.call({action: 'continue_as_new', id, confirmed: true, ...(changes ? {changes} : {})}),
        e => {
          assertRefused(e, 'INVALID_ARGUMENT');
          assert.equal(e.details.superseded_by, first.id);
          assert.deepEqual(e.details.recorded_drop, ['adset_a']);
          assert.equal(e.details.field, 'changes.drop');
          return true;
        },
      );
    assert.equal(f.plans().length, plansAfter);
    // A plan continued without a drop stays so: the same call returns it, and a drop is refused, with nothing recorded as a drop.
    const plain = await f.started();
    const kept = await f.call({action: 'continue_as_new', id: plain, confirmed: true});
    assert.equal(f.stored(plain).superseded_by.drop, undefined);
    assert.equal((await f.call({action: 'continue_as_new', id: plain, confirmed: true})).id, kept.id);
    await assert.rejects(
      () => f.call({action: 'continue_as_new', id: plain, confirmed: true, changes: {drop: ['adset_a']}}),
      e => {
        assertRefused(e, 'INVALID_ARGUMENT');
        assert.deepEqual(e.details.recorded_drop, []);
        return true;
      },
    );
  } finally {
    f.store.close();
  }
});

test('a plan that is one atomic Google clone is told to cancel and clone again with the ad groups it wants', async () => {
  const f = fixture();
  try {
    // The plan a Google clone saves by default: one all-or-nothing build, which holds the ad groups as operations and not as steps.
    const build = {...write('build'), gateway: 'snapchat_native_action'};
    const created = await f.call({action: 'create', name: 'Clone of a campaign', brief: 'Synthetic.', steps: [build]});
    const {id: _id, revision, ...data} = f.stored(created.id);
    f.store.putDocument(
      tenantId,
      'campaign_run',
      created.id,
      {
        ...data,
        clone: {source: {campaign_id: '10', ad_groups: 4}, not_copied: [], all_or_nothing: true, steps: ['build']},
      },
      revision,
    );
    const before = f.plans().length;
    for (const changes of [{drop: ['build']}, {drop: ['ad_group_1']}])
      await assert.rejects(
        () => f.call({action: 'continue_as_new', id: created.id, confirmed: true, changes}),
        e => {
          assertRefused(e, 'INVALID_ARGUMENT');
          assert.equal(e.details.field, 'changes.drop');
          assert.deepEqual(e.details.next_call, {
            tool: 'amcp_campaign',
            arguments: {action: 'cancel', id: created.id},
            add_after_user_approval: {confirmed: true},
            then: {
              tool: 'amcp_campaign',
              arguments: {
                action: 'clone',
                gateway: 'snapchat_native_action',
                connection_id: 'snap',
                account_id: '123',
                name: 'Clone of a campaign',
                source: {campaign_id: '10'},
              },
              add: ['source.ad_group_ids'],
            },
          });
          return true;
        },
      );
    assert.equal(f.plans().length, before);
    // Without a drop the plan continues as it did, whole. Once it has, it is superseded, and a drop is answered as for any superseded plan
    // (lead review of r25-field-plan, S2-1): it is not the continuation made, which had none, and the cancel the atomic refusal would offer
    // would itself be refused for a superseded plan.
    const kept = await f.call({action: 'continue_as_new', id: created.id, confirmed: true});
    assert.deepEqual(
      kept.steps.map(s => s.id),
      ['build'],
    );
    await assert.rejects(
      () => f.call({action: 'continue_as_new', id: created.id, confirmed: true, changes: {drop: ['build']}}),
      e => {
        assertRefused(e, 'INVALID_ARGUMENT');
        assert.equal(e.details.field, 'changes.drop');
        assert.equal(e.details.superseded_by, kept.id);
        assert.deepEqual(e.details.recorded_drop, []);
        assert.deepEqual(e.details.next_call, {tool: 'amcp_campaign', arguments: {action: 'get', id: kept.id}});
        assert.equal(JSON.stringify(e.details).includes('cancel'), false, 'a superseded plan is not offered a cancel');
        return true;
      },
    );
  } finally {
    f.store.close();
  }
});

/**
 * The plan a Google clone saves by default, one all-or-nothing build. The clone marker is set by hand: the tests need the saved shape, not a
 * clone. `reviewed` prepares the build's review and, with `send`, executes it (the fixture's `uncertain` and `refused` sets say what happens).
 */
async function atomicClone(f) {
  const created = await f.call({
    action: 'create',
    name: 'Clone of a campaign',
    brief: 'Synthetic.',
    steps: [write('build')],
  });
  const {id: _id, revision, ...data} = f.stored(created.id);
  f.store.putDocument(
    tenantId,
    'campaign_run',
    created.id,
    {
      ...data,
      clone: {source: {campaign_id: '10', ad_groups: 4}, not_copied: [], all_or_nothing: true, steps: ['build']},
    },
    revision,
  );
  return created.id;
}
async function reviewed(f, id, send) {
  const prepared = await f.call({action: 'prepare_next', id});
  if (send)
    await f.call({
      action: 'execute_next',
      id,
      review_id: prepared.review.review_id,
      idempotency_key: prepared.review.idempotency_key,
      confirmed: true,
    });
  return prepared;
}
const dropAdGroup = (f, id) =>
  f.call({action: 'continue_as_new', id, confirmed: true, changes: {drop: ['ad_group_2']}});

test('an atomic clone whose build reached the provider is not told to cancel and clone again: the guard of continue_as_new answers first', async () => {
  // Lead review of r25-field-plan, S2-1. The atomic refusal used to run before the guard, so an agent that followed its next_call, with the
  // user's yes to the cancel, cloned the campaign again while the first copy might exist (uncertain) or did exist (verified).
  const lost = fixture();
  try {
    lost.state.uncertain.add('build');
    const id = await atomicClone(lost);
    await reviewed(lost, id, true);
    assert.equal(lost.stored(id).steps[0].status, 'uncertain');
    const before = lost.plans().length;
    await assert.rejects(
      () => dropAdGroup(lost, id),
      e => {
        assertRefused(e, 'RECOVERY_NOT_SAFE');
        assert.deepEqual(
          e.details.blocked_steps.map(b => b.step_id),
          ['build'],
        );
        assert.equal(e.details.next_call, undefined, 'no call to cancel the plan and clone it again');
        return true;
      },
    );
    assert.equal(lost.plans().length, before, 'no plan was saved');
    assert.equal(lost.stored(id).superseded_by, undefined);
    assert.deepEqual(lost.state.sent, ['build'], 'the build was sent once, and not again');
  } finally {
    lost.store.close();
  }
  const done = fixture();
  try {
    const id = await atomicClone(done);
    await reviewed(done, id, true);
    assert.equal(done.stored(id).steps[0].status, 'verified');
    const before = done.plans().length;
    await assert.rejects(
      () => dropAdGroup(done, id),
      e => {
        assertRefused(e, 'INVALID_ARGUMENT', {message: /settled/});
        assert.equal(e.details?.next_call, undefined, 'no call to cancel the plan and clone it again');
        assert.equal(JSON.stringify(e.details ?? {}).includes('cancel'), false);
        return true;
      },
    );
    assert.equal(done.plans().length, before);
    assert.deepEqual(done.state.sent, ['build']);
  } finally {
    done.store.close();
  }
});

test('an atomic clone nothing was sent for is told to cancel and clone again, and the cancel it names is accepted; a failed build is not offered one', async () => {
  for (const ready of [false, true]) {
    const f = fixture();
    try {
      const id = await atomicClone(f);
      if (ready) {
        await reviewed(f, id, false);
        assert.equal(f.stored(id).steps[0].status, 'review_ready');
      }
      await assert.rejects(
        () => dropAdGroup(f, id),
        e => {
          assertRefused(e, 'INVALID_ARGUMENT');
          assert.equal(e.details.field, 'changes.drop');
          assert.deepEqual(e.details.next_call.arguments, {action: 'cancel', id});
          assert.deepEqual(e.details.next_call.add_after_user_approval, {confirmed: true});
          assert.equal(e.details.next_call.then.arguments.action, 'clone');
          assert.deepEqual(e.details.next_call.then.add, ['source.ad_group_ids']);
          return true;
        },
      );
      // The user's yes to that cancel is accepted, and nothing was ever sent for this build.
      await f.call({action: 'cancel', id, confirmed: true});
      assert.equal(f.stored(id).state, 'cancelled');
      assert.deepEqual(f.state.sent, []);
    } finally {
      f.store.close();
    }
  }
  // A build that failed (its prepare was refused) is the plan's to settle first, and the refusal says so without handing over a cancel.
  const failed = fixture();
  try {
    failed.state.refused.add('build');
    const id = await atomicClone(failed);
    await reviewed(failed, id, false);
    assert.equal(failed.stored(id).steps[0].status, 'failed');
    await assert.rejects(
      () => dropAdGroup(failed, id),
      e => {
        assertRefused(e, 'INVALID_ARGUMENT', {message: /failed/});
        assert.equal(e.details.field, 'changes.drop');
        assert.equal(e.details.next_call, undefined, 'no call to cancel the plan and clone it again');
        return true;
      },
    );
  } finally {
    failed.store.close();
  }
});

test('the old shape is unchanged: continue_as_new with only id and confirmed carries every step still to write', async () => {
  const f = fixture();
  try {
    const id = await f.started();
    const next = await f.call({action: 'continue_as_new', id, confirmed: true, detail: 'full'});
    assert.deepEqual(
      next.steps.map(s => s.id),
      ['adset_a', 'ad_a', 'adset_b', 'ad_b'],
    );
    assert.equal(next.dropped, undefined);
    assert.equal(f.stored(id).superseded_by.dropped, undefined);
    assert.equal(f.audits().find(e => e.event === 'campaign_plan_superseded').dropped, undefined);
    // `changes: {drop: []}` is no drop.
    const again = await f.call({action: 'continue_as_new', id, confirmed: true, changes: {drop: []}});
    assert.equal(again.id, next.id);
  } finally {
    f.store.close();
  }
});

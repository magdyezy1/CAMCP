import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import * as errors from '../dist/src/errors.js';
import * as runner from '../dist/src/campaign-runner.js';
import {advertiserWorld, advertiserAnswer, answer} from './helpers/tiktok-advertiser-noise.mjs';
import {standardBodies} from './helpers/tiktok-standard-creates.mjs';

/**
 * R2.5 M2, lead re-review N7: the guard against creating twice, refused at execute INSIDE A PLAN. A step whose review was refused as a
 * duplicate of another create had nothing claimed or sent, but it ended `failed`/`not_submitted` (a dead end that needs recover_step), as
 * if the provider had been reached, and the refusal's standalone prepare names a review that no step holds (the lesson of the STATE_CHANGED
 * routing, R25 M1). Now:
 * - both codes, raised before anything was claimed, send the step back to `pending` with the plan's own `prepare_next`, as a refusal of the
 *   state check does; `run` stops there (never prepares and executes the step again on its own: the person is shown the new review, which
 *   carries the warning, before a second object is made);
 * - DUPLICATE_OF_UNCERTAIN_WRITE while the earlier create is still being sent waits, as STATE_BUSY does: the review stays ready.
 */
const gateway = 'tiktok_native_action',
  actor = {tenantId: 'plan-duplicates', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'};

function setup() {
  const world = advertiserWorld(),
    store = new Store(':memory:', Buffer.alloc(32, 82).toString('base64')),
    campaigns = new Map(),
    writes = [];
  store.putConnection(
    admin,
    {
      id: 'login',
      tenantId: actor.tenantId,
      gateway,
      accounts: [world.id],
      writeAccounts: [world.id],
      enabled: true,
      label: 'Synthetic TikTok',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const page = list => answer({list, page_info: {page: 1, page_size: 100, total_number: list.length, total_page: 1}});
  // `afterPrepare`: runs once, on the first read made once a review exists (the state read of the execute after a prepare).
  // `gate`: a promise the next campaign create waits for before it is answered. `lose`: the next create is applied and its answer lost.
  const behaviour = {afterPrepare: undefined, gate: undefined, lose: false};
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (raw, init = {}) => {
        const url = new URL(String(raw)),
          path = url.pathname.replace('/open_api', ''),
          method = init.method ?? 'GET';
        if (method === 'GET' && path === '/v1.3/advertiser/info/') {
          if (behaviour.afterPrepare && store.documents(actor.tenantId, 'write_review').length) {
            const hook = behaviour.afterPrepare;
            behaviour.afterPrepare = undefined;
            await hook();
          }
          return Response.json(page([advertiserAnswer(world, url)]));
        }
        if (method === 'GET' && path === '/v1.3/campaign/get/') {
          const ids = JSON.parse(url.searchParams.get('filtering') ?? '{}').campaign_ids ?? [];
          return Response.json(page([...campaigns.values()].filter(c => ids.includes(c.campaign_id))));
        }
        if (method === 'POST' && path === '/v1.3/campaign/create/') {
          const body = JSON.parse(String(init.body)),
            id = String(300 + campaigns.size + 1);
          writes.push({path, body});
          if (behaviour.gate) {
            const gate = behaviour.gate;
            behaviour.gate = undefined;
            await gate;
          }
          campaigns.set(id, {...body, campaign_id: id});
          if (behaviour.lose) {
            behaviour.lose = false;
            throw new TypeError('synthetic lost response');
          }
          return Response.json(answer({campaign_id: id}));
        }
        throw new Error('Unexpected TikTok request ' + method + ' ' + path);
      },
      undefined,
      undefined,
      undefined,
      10000,
    ),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const call = input => service.call('amcp_campaign', input, actor),
    write = input => service.call('amcp_write', input, actor);
  /** The same create, prepared and executed on its own (outside any plan). `lose` and `gate` act on its write. */
  const standalone = async () => {
    const body = standardBodies(world.id).campaign,
      prepared = await write({
        action: 'prepare',
        gateway,
        connection_id: 'login',
        arguments: {action: body.action, account_id: world.id, payload: body.payload},
      });
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 600));
    return {
      id: prepared.data.review_id,
      execute: () => write({action: 'execute', review_id: prepared.data.review_id, confirmed: true}),
    };
  };
  return {
    world,
    store,
    writes,
    behaviour,
    call,
    write,
    standalone,
    reviews: () => store.documents(actor.tenantId, 'write_review'),
  };
}

/** An approved plan of one paused campaign create (the same request as the standalone one). */
async function approvedPlan(f) {
  const created = await f.call({
    action: 'create',
    name: 'Synthetic launch',
    brief: 'One paused campaign.',
    steps: [
      {
        id: 'campaign',
        kind: 'write',
        gateway,
        connection_id: 'login',
        account_id: f.world.id,
        description: 'Create the paused campaign',
        arguments: {
          action: standardBodies(f.world.id).campaign.action,
          payload: standardBodies(f.world.id).campaign.payload,
        },
      },
    ],
  });
  assert.equal(created.success, true, JSON.stringify(created).slice(0, 1200));
  const id = created.data.id,
    preview = await f.call({action: 'approve', id});
  assert.equal(preview.success, true, JSON.stringify(preview).slice(0, 1200));
  const approved = await f.call({
    action: 'approve',
    id,
    confirmed: true,
    plan_hash: preview.data.plan_hash,
    summary_hash: preview.data.summary_hash,
  });
  assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 1200));
  return id;
}
const row = (result, step = 'campaign') => result.data.steps.find(s => s.id === step);
const prepareNext = id => ({tool: 'amcp_campaign', arguments: {action: 'prepare_next', id}});
const executeNext = (id, review) => ({
  action: 'execute_next',
  id,
  review_id: review.review_id,
  idempotency_key: review.idempotency_key,
  confirmed: true,
});

test('a step refused as a duplicate of a create that completed goes back to pending, with the plan’s own prepare_next', async () => {
  const f = setup();
  try {
    const id = await approvedPlan(f),
      prepared = await f.call({action: 'prepare_next', id});
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 800));
    // The same create completes on its own after the step's review was prepared.
    const other = await f.standalone();
    assert.equal((await other.execute()).success, true);
    const refused = await f.call(executeNext(id, prepared.data.review));
    assert.equal(refused.success, true, JSON.stringify(refused).slice(0, 1200));
    assert.equal(f.writes.length, 1, 'only the standalone create was sent');
    assert.equal(row(refused).status, 'pending', 'not failed: nothing was claimed or sent');
    assert.equal(row(refused).error, 'DUPLICATE_OF_COMPLETED_WRITE');
    assert.equal(refused.data.state, 'attention');
    const current = refused.data.current;
    assert.equal(current.status, 'pending');
    assert.equal(current.error.code, 'DUPLICATE_OF_COMPLETED_WRITE');
    assert.equal(current.error.details.submission, 'not_sent');
    // The plan's call, not the standalone prepare of the write that no step holds.
    assert.deepEqual(current.error.details.next_call, prepareNext(id));
    assert.deepEqual(refused.data.next_call, prepareNext(id));
    assert.notEqual(row(refused).submission, 'not_submitted');
  } finally {
    f.store.close();
  }
});

test('the step is prepared again with the warning shown in the plan’s view, executed once on the person’s word, and the plan completes', async () => {
  const f = setup();
  try {
    const id = await approvedPlan(f),
      prepared = await f.call({action: 'prepare_next', id});
    assert.equal((await (await f.standalone()).execute()).success, true);
    const refused = await f.call(executeNext(id, prepared.data.review));
    assert.equal(row(refused).status, 'pending');
    const again = await f.call(refused.data.next_call.arguments);
    assert.equal(again.success, true, JSON.stringify(again).slice(0, 1200));
    assert.notEqual(again.data.review.review_id, prepared.data.review.review_id);
    // The warning is in the plan’s compact review: the agent shows it, and only the person’s word makes the second object.
    assert.equal(again.data.review.duplicate_warning?.earlier_state, 'complete', JSON.stringify(again.data.review));
    assert.match(again.data.review.duplicate_warning.message, /second object/);
    const plan = await f.call({action: 'get', id});
    assert.equal(row(plan).status, 'review_ready');
    assert.equal(row(plan).error, undefined, 'the refusal does not outlive the review it concerned');
    assert.equal(f.writes.length, 1, 'preparing again sent nothing');
    const done = await f.call(executeNext(id, again.data.review));
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 1200));
    assert.equal(f.writes.length, 2, 'the second object, once');
    assert.equal(done.data.state, 'complete');
  } finally {
    f.store.close();
  }
});

test('a step refused as a duplicate of an uncertain create goes back to pending too, and keeps the call that settles the earlier one', async () => {
  const f = setup();
  try {
    const id = await approvedPlan(f),
      prepared = await f.call({action: 'prepare_next', id});
    // The same create is sent on its own and its answer is lost: it is uncertain.
    const other = await f.standalone();
    f.behaviour.lose = true;
    const lost = await other.execute();
    assert.equal(lost.error?.code, 'WRITE_OUTCOME_UNCERTAIN', JSON.stringify(lost).slice(0, 500));
    const refused = await f.call(executeNext(id, prepared.data.review));
    assert.equal(refused.success, true, JSON.stringify(refused).slice(0, 1200));
    assert.equal(f.writes.length, 1, 'the step’s review was never sent');
    assert.equal(row(refused).status, 'pending');
    assert.equal(row(refused).error, 'DUPLICATE_OF_UNCERTAIN_WRITE');
    const details = refused.data.current.error.details;
    assert.equal(details.earlier_state, 'uncertain');
    assert.deepEqual(details.next_call, prepareNext(id));
    assert.deepEqual(refused.data.next_call, prepareNext(id));
    // What settles the earlier create is not lost: the standalone review's own call.
    assert.equal(details.earlier_review_id, other.id);
    assert.equal(details.earlier_next_call?.arguments?.review_id, other.id);
  } finally {
    f.store.close();
  }
});

/**
 * Two creates that read the same targets are serialized by the target lock before the guard sees them (STATE_BUSY); the guard's own
 * answer to one that is still being sent (or that completes between a run's prepare and its execute, which also runs inside the first
 * one's lock) is met where they do not share a lock, so these two tests turn the lock off.
 */
const targetLock = {
  off: () => {
    process.env.AMCP_WRITE_TARGET_LOCK = 'false';
  },
  restore: () => {
    delete process.env.AMCP_WRITE_TARGET_LOCK;
  },
};

test('a duplicate of a create that is still being sent waits: the review stays ready, as for a busy target', async () => {
  const f = setup();
  targetLock.off();
  try {
    const id = await approvedPlan(f),
      prepared = await f.call({action: 'prepare_next', id});
    const other = await f.standalone();
    let open;
    f.behaviour.gate = new Promise(resolve => (open = resolve));
    const sending = other.execute();
    // Wait until its claim exists: it is being sent.
    for (let i = 0; i < 200 && !f.writes.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.writes.length, 1, 'the standalone create is in flight');
    const refused = await f.call(executeNext(id, prepared.data.review));
    assert.equal(refused.success, true, JSON.stringify(refused).slice(0, 1200));
    assert.equal(row(refused).status, 'review_ready', 'it waits: nothing is wrong with the review');
    assert.equal(row(refused).error, 'DUPLICATE_OF_UNCERTAIN_WRITE');
    assert.equal(refused.data.current.error.details.earlier_state, 'executing');
    assert.equal(f.writes.length, 1, 'nothing more was sent');
    open();
    assert.equal((await sending).success, true);
    // Once the other create completed, the same review is refused as the duplicate of a completed one and goes back to pending.
    const later = await f.call(executeNext(id, prepared.data.review));
    assert.equal(row(later).status, 'pending');
    assert.equal(row(later).error, 'DUPLICATE_OF_COMPLETED_WRITE');
    assert.equal(f.writes.length, 1);
  } finally {
    targetLock.restore();
    f.store.close();
  }
});

test('run stops at a step refused as a duplicate, then shows the new review and stops again: it never makes the second object on its own', async () => {
  const f = setup();
  targetLock.off();
  try {
    const id = await approvedPlan(f);
    // The same create completes on its own between the run's prepare and its execute.
    f.behaviour.afterPrepare = async () => {
      assert.equal((await (await f.standalone()).execute()).success, true);
    };
    const stopped = await f.call({action: 'run', id});
    assert.equal(stopped.success, true, JSON.stringify(stopped).slice(0, 1200));
    assert.equal(stopped.data.run.stopped, 'duplicate_create', JSON.stringify(stopped.data.run));
    assert.deepEqual(stopped.data.run.executed, ['campaign'], 'the step was attempted once');
    assert.deepEqual(stopped.data.run.next_call, prepareNext(id));
    assert.match(stopped.data.run.reason, /DUPLICATE_OF_COMPLETED_WRITE/);
    assert.equal(row(stopped).status, 'pending');
    assert.equal(f.writes.length, 1, 'only the standalone create was sent');
    // Called again, it prepares the step over what exists now and STOPS with the new review, which carries the warning.
    const shown = await f.call({action: 'run', id});
    assert.equal(shown.success, true, JSON.stringify(shown).slice(0, 1200));
    assert.equal(shown.data.run.stopped, 'duplicate_create', JSON.stringify(shown.data.run));
    assert.deepEqual(shown.data.run.executed, [], 'nothing was executed in this call');
    assert.equal(f.writes.length, 1, 'the second run sent nothing');
    assert.equal(shown.data.review.duplicate_warning?.earlier_state, 'complete');
    assert.equal(row(await f.call({action: 'get', id})).status, 'review_ready');
    // Only an explicit execute_next with that review makes the second object, once.
    const done = await f.call(executeNext(id, shown.data.review));
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 1200));
    assert.equal(f.writes.length, 2);
    assert.equal(done.data.state, 'complete');
  } finally {
    targetLock.restore();
    f.store.close();
  }
});

test('a step refused as a duplicate is amended in place with recover_step: it never reached the provider', async () => {
  const f = setup();
  try {
    const id = await approvedPlan(f),
      prepared = await f.call({action: 'prepare_next', id});
    assert.equal((await (await f.standalone()).execute()).success, true);
    await f.call(executeNext(id, prepared.data.review));
    // A changed request is a new create, which the guard does not hold back.
    const amended = await f.call({
      action: 'recover_step',
      id,
      step_id: 'campaign',
      confirmed: true,
      patch: [{path: '/payload/campaign_name', value: 'Another campaign'}],
    });
    assert.equal(amended.success, true, JSON.stringify(amended).slice(0, 1200));
    assert.deepEqual(amended.data.next_call, prepareNext(id));
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
});

test('a refusal of the guard is told apart as one that sent nothing only without a claim and with the mark', () => {
  const {refusedByDuplicateGuard} = errors,
    {unsentDuplicate} = runner;
  const error = {code: 'DUPLICATE_OF_COMPLETED_WRITE', details: {submission: 'not_sent'}};
  assert.equal(refusedByDuplicateGuard(error), true);
  assert.equal(
    refusedByDuplicateGuard({code: 'DUPLICATE_OF_UNCERTAIN_WRITE', details: {submission: 'not_sent'}}),
    true,
  );
  assert.equal(unsentDuplicate(error, undefined), true);
  for (const state of ['pending', 'uncertain', 'complete', 'rejected'])
    assert.equal(unsentDuplicate(error, {state}), false, state + ' claim');
  // At prepare the refusal carries no mark, and another code is no duplicate refusal.
  assert.equal(refusedByDuplicateGuard({code: 'DUPLICATE_OF_UNCERTAIN_WRITE', details: {}}), false);
  assert.equal(refusedByDuplicateGuard({code: 'STATE_CHANGED', details: {submission: 'not_sent'}}), false);
  assert.equal(refusedByDuplicateGuard(undefined), false);
});

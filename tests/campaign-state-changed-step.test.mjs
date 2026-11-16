import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {MirrorError, refusedByStateCheck} from '../dist/src/errors.js';
import {unsentStateChange} from '../dist/src/campaign-runner.js';
import {advertiserWorld, advertiserAnswer, answer} from './helpers/tiktok-advertiser-noise.mjs';
import {standardBodies} from './helpers/tiktok-standard-creates.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * Round 2.5, package r25-m1-diff (L5-04): a plan step whose execute is refused as STATE_CHANGED goes back to `pending`.
 * Nothing was claimed or sent, so the step is not failed and needs no recover_step: prepare_next prepares it again over the
 * state as it is now, and the new review is executed like any other. The plan's run never does that on its own. A plan
 * approval is of the plan, not of a provider state that moved, so the run stops at such a step and hands it to the agent
 * and the user: no flag, auto-accept or automatic retry exists. Every case drives the real plan engine and review
 * lifecycle against a synthetic TikTok advertiser that changes between prepare and execute.
 */
const gateway = 'tiktok_native_action',
  currencyPath = '$[0]["data"]["list"][0]["currency"]',
  actor = {tenantId: 'plan-state-changed', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'};

function setup() {
  const world = advertiserWorld(),
    store = new Store(':memory:', Buffer.alloc(32, 81).toString('base64')),
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
  // `changeOnExecute`: the advertiser changes currency on the first read made once a review exists, which is the read of
  // the execute that follows a prepare (the prepare itself reads it before its review is saved).
  const behaviour = {changeOnExecute: undefined, refuseWrite: false};
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (raw, init = {}) => {
        const url = new URL(String(raw)),
          path = url.pathname.replace('/open_api', ''),
          method = init.method ?? 'GET';
        if (method === 'GET' && path === '/v1.3/advertiser/info/') {
          if (behaviour.changeOnExecute && store.documents(actor.tenantId, 'write_review').length) {
            world.currency = behaviour.changeOnExecute;
            behaviour.changeOnExecute = undefined;
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
          if (behaviour.refuseWrite)
            return Response.json({code: 40002, message: 'Invalid parameter', request_id: 'synthetic', data: {}});
          campaigns.set(id, {...body, campaign_id: id});
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
  const call = input => service.call('amcp_campaign', input, actor);
  return {
    world,
    store,
    writes,
    behaviour,
    call,
    workspace: input => service.call('amcp_workspace', input, admin),
    reviews: () => store.documents(actor.tenantId, 'write_review'),
  };
}

/** An approved plan of one paused campaign create. */
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

/** A prepared step whose advertiser then changes currency, and the execute_next that was refused. */
async function refusedStep(f, id) {
  const prepared = await f.call({action: 'prepare_next', id});
  assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 1200));
  f.world.currency = 'EUR';
  const refused = await f.call({
    action: 'execute_next',
    id,
    review_id: prepared.data.review.review_id,
    idempotency_key: prepared.data.review.idempotency_key,
    confirmed: true,
  });
  return {prepared, refused};
}

test('a step refused as STATE_CHANGED goes back to pending, unsent, with what changed and the call that prepares it again', async () => {
  const f = setup();
  try {
    const id = await approvedPlan(f),
      {refused} = await refusedStep(f, id);
    assert.equal(refused.success, true, JSON.stringify(refused).slice(0, 1200));
    assert.equal(f.writes.length, 0, 'nothing was sent');
    assert.equal(row(refused).status, 'pending', 'not failed: nothing was sent, so nothing needs recovering');
    assert.equal(row(refused).error, 'STATE_CHANGED');
    assert.equal(refused.data.state, 'attention');
    const current = refused.data.current;
    assert.equal(current.step_id, 'campaign');
    assert.equal(current.status, 'pending');
    assert.equal(current.error.code, 'STATE_CHANGED');
    // What changed, and what matters of it: the same words as the refusal of a single write.
    assert.deepEqual(current.error.details.changed_fields, [currencyPath]);
    assert.deepEqual(current.error.details.material, [currencyPath]);
    assert.ok(Array.isArray(current.error.details.recurring_paths));
    // The call that prepares it again is the plan's, not a standalone prepare of the write that nobody tracks.
    assert.deepEqual(current.error.details.next_call, prepareNext(id));
    assert.deepEqual(refused.data.next_call, prepareNext(id));
    assert.match(current.error.remedy.action, /No flag skips this check/);
  } finally {
    f.store.close();
  }
});

test('the step is prepared again, reviewed on the new state, executed once, and the plan completes', async () => {
  const f = setup();
  try {
    const id = await approvedPlan(f),
      {prepared, refused} = await refusedStep(f, id);
    // The step is prepared again, with the call the refusal named: no recover_step, no amendment.
    const again = await f.call(refused.data.next_call.arguments);
    assert.equal(again.success, true, JSON.stringify(again).slice(0, 1200));
    const plan = await f.call({action: 'get', id});
    assert.equal(row(plan).status, 'review_ready');
    assert.equal(row(plan).error, undefined, 'the refusal does not outlive the step it concerned');
    assert.notEqual(again.data.review.review_id, prepared.data.review.review_id);
    assert.equal(JSON.stringify(again.data.review.state_summary).includes('"EUR"'), true, 'reviewed on the new state');
    assert.equal(f.writes.length, 0, 'preparing again sends nothing');
    const done = await f.call({
      action: 'execute_next',
      id,
      review_id: again.data.review.review_id,
      idempotency_key: again.data.review.idempotency_key,
      confirmed: true,
    });
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 1200));
    assert.equal(f.writes.length, 1, 'exactly one write');
    assert.equal(done.data.current.status, 'verified', JSON.stringify(done.data.current).slice(0, 800));
    assert.equal(done.data.state, 'complete');
  } finally {
    f.store.close();
  }
});

test('the old review of a refused step cannot be executed, whatever the step has become', async () => {
  const f = setup();
  try {
    const id = await approvedPlan(f),
      {prepared} = await refusedStep(f, id),
      old = {
        action: 'execute_next',
        id,
        review_id: prepared.data.review.review_id,
        idempotency_key: prepared.data.review.idempotency_key,
        confirmed: true,
      };
    // Pending: its review is not ready, so execute_next has nothing to execute.
    assertRefused(await f.call(old), 'INVALID_ARGUMENT', {writes: () => f.writes.length});
    // Prepared again: only the new review is the step's.
    await f.call({action: 'prepare_next', id});
    assertRefused(await f.call(old), 'INVALID_ARGUMENT', {writes: () => f.writes.length});
  } finally {
    f.store.close();
  }
});

test('run never prepares and executes a step again after its state changed: it stops, then shows the new review and stops again', async () => {
  const f = setup();
  try {
    const id = await approvedPlan(f);
    // The advertiser changes between the run's prepare and its execute (the first read once a review exists).
    f.behaviour.changeOnExecute = 'EUR';
    const stopped = await f.call({action: 'run', id});
    assert.equal(stopped.success, true, JSON.stringify(stopped).slice(0, 1200));
    assert.equal(stopped.data.run.stopped, 'state_changed');
    assert.deepEqual(stopped.data.run.executed, ['campaign'], 'the step was attempted once');
    assert.deepEqual(stopped.data.run.next_call, prepareNext(id));
    assert.equal(row(stopped).status, 'pending');
    assert.equal(f.writes.length, 0, 'nothing was sent');
    // The run did not re-prepare on its own: the one review it prepared is the only one.
    assert.equal(f.reviews().length, 1, 'no second review was prepared');
    // Lead review S2-1: called again, it prepares the step over the state as it is now and STOPS with the new review: the
    // plan approval never carries the write across a state that moved without the new review being shown first.
    const shown = await f.call({action: 'run', id});
    assert.equal(shown.success, true, JSON.stringify(shown).slice(0, 1200));
    assert.equal(shown.data.run.stopped, 'state_changed', JSON.stringify(shown.data.run));
    assert.deepEqual(shown.data.run.executed, [], 'nothing was executed in this call');
    assert.equal(f.writes.length, 0, 'the second run sent nothing');
    assert.equal(f.reviews().length, 2, 'the step was prepared again, once');
    assert.equal(row(await f.call({action: 'get', id})).status, 'review_ready');
    const review = shown.data.review;
    assert.ok(review?.review_id, 'the new review is returned');
    assert.equal(JSON.stringify(shown.data).includes('"EUR"'), true, 'reviewed on the new state');
    const execute = {
      tool: 'amcp_campaign',
      arguments: {
        action: 'execute_next',
        id,
        review_id: review.review_id,
        idempotency_key: review.idempotency_key,
        confirmed: true,
      },
    };
    assert.deepEqual(shown.data.run.next_call, execute);
    assert.deepEqual(shown.data.next_call, execute);
    assert.match(shown.data.run.reason, /No flag skips this check/);
    // Only an explicit execute_next with that review sends it, once.
    const done = await f.call(execute.arguments);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 1200));
    assert.equal(f.writes.length, 1, 'exactly one write');
    assert.equal(done.data.state, 'complete');
    assert.equal(f.reviews().length, 2, 'the second review is the one it sent');
  } finally {
    f.store.close();
  }
});

test('a step prepared again after a changed state and left ready is not refused for it again, and a later run sends only that review', async () => {
  const f = setup();
  try {
    const id = await approvedPlan(f);
    f.behaviour.changeOnExecute = 'EUR';
    await f.call({action: 'run', id});
    const shown = await f.call({action: 'run', id});
    assert.equal(shown.data.run.stopped, 'state_changed');
    // The review is the person's to execute. A run called after it sends the review that was shown, not another one.
    const done = await f.call({action: 'run', id});
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 1200));
    assert.equal(done.data.run.stopped, 'complete', JSON.stringify(done.data.run));
    assert.equal(f.writes.length, 1, 'exactly one write');
    assert.equal(f.reviews().length, 2, 'no third review was prepared');
  } finally {
    f.store.close();
  }
});

test('a refusal that is not a changed state keeps the outcome it had: a paused workspace leaves the review ready', async () => {
  const f = setup();
  try {
    const id = await approvedPlan(f),
      prepared = await f.call({action: 'prepare_next', id}),
      pause = await f.workspace({action: 'pause_writes', reason: 'Audit', confirmed: true});
    assert.equal(pause.success, true, JSON.stringify(pause).slice(0, 600));
    const refused = await f.call({
      action: 'execute_next',
      id,
      review_id: prepared.data.review.review_id,
      idempotency_key: prepared.data.review.idempotency_key,
      confirmed: true,
    });
    assert.equal(row(refused).status, 'review_ready', 'the review is still valid; only the pause holds it');
    assert.equal(row(refused).error, 'WRITES_PAUSED');
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

test('a write the provider refuses after it was sent still stops the plan as an attention step, never as a pending one', async () => {
  const f = setup();
  try {
    const id = await approvedPlan(f);
    f.behaviour.refuseWrite = true;
    const stopped = await f.call({action: 'run', id});
    assert.equal(stopped.success, true, JSON.stringify(stopped).slice(0, 1200));
    assert.equal(f.writes.length, 1, 'it was sent, so it is not the unsent refusal of a changed state');
    assert.equal(stopped.data.run.stopped, 'needs_attention');
    assert.notEqual(row(stopped).status, 'pending');
    assert.ok(['failed', 'uncertain'].includes(row(stopped).status), row(stopped).status);
  } finally {
    f.store.close();
  }
});

test('a refusal with a claim for its review is never taken for one that sent nothing, whatever it says', () => {
  const error = {
    code: 'STATE_CHANGED',
    details: {
      expected_state_hash: 'a',
      actual_state_hash: 'b',
      changed_fields: ['$[0]["x"]'],
      submission: 'not_sent',
    },
  };
  assert.equal(unsentStateChange(error, undefined), true);
  for (const state of ['pending', 'uncertain', 'complete', 'rejected'])
    assert.equal(unsentStateChange(error, {state}), false, state + ' claim');
  assert.equal(unsentStateChange({code: 'STATE_CHANGED', details: {}}, undefined), false);
  assert.equal(unsentStateChange(undefined, undefined), false);
  // The fields of the check without the mark of a refusal raised before the claim (a resume) are not one that sent nothing.
  assert.equal(unsentStateChange({...error, details: {...error.details, submission: undefined}}, undefined), false);
});

test('a STATE_CHANGED that is not the refusal of the review check is not told apart as one that sent nothing', () => {
  const review = {
    code: 'STATE_CHANGED',
    details: {
      expected_state_hash: 'a',
      actual_state_hash: 'b',
      changed_fields: ['$[0]["x"]'],
      submission: 'not_sent',
    },
  };
  assert.equal(refusedByStateCheck(review), true);
  assert.equal(refusedByStateCheck(new MirrorError('STATE_CHANGED', 'x', review.details)), true);
  for (const e of [
    {code: 'STATE_CHANGED', details: {field: 'actual_hash', step_id: 's', actual_hash: 'h'}},
    {code: 'STATE_CHANGED', details: {}},
    {code: 'STATE_CHANGED'},
    {code: 'STATE_CHANGED', details: {expected_state_hash: 'a', actual_state_hash: 'b'}},
    {code: 'STATE_CHANGED', details: {...review.details, changed_fields: 'not a list'}},
    {code: 'REVIEW_EXPIRED', details: review.details},
    // The two hashes and the fields of a resume refused after a claim: the mark of "not sent" is what is missing.
    {code: 'STATE_CHANGED', details: {...review.details, submission: undefined}},
    {code: 'STATE_CHANGED', details: {...review.details, submission: 'rejected'}},
    undefined,
  ])
    assert.equal(refusedByStateCheck(e), false, JSON.stringify(e));
});

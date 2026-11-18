import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {refusedByDuplicateGuard} from '../dist/src/errors.js';
import {heldByStateCheck, nextUpload} from '../dist/src/campaign-background.js';
import {advertiserWorld, advertiserAnswer, answer} from './helpers/tiktok-advertiser-noise.mjs';
import {standardBodies} from './helpers/tiktok-standard-creates.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * Round 2.5, package r25-m3-dupstep (a follow-up of M2's L5-06). A plan step that meets the guard against creating twice is
 * waiting, not broken. At execute the step already went back to `pending` with the refusal on it (lead re-review N7 and F3). At
 * prepare it ended `failed`/`not_submitted` with `blocked: true` and a `recover_step` call, which told an agent and the website to
 * amend a request that only needs the earlier create settled first: changing the request to get past the guard can make the
 * second object the guard exists to prevent. Now both paths are one rule (one helper in src/campaign-runner.ts):
 * - the step stays `pending`, keeps the refusal, and its `next_call` is the earlier create's call with `prepare_next` after it
 *   (or `prepare_next` alone where the earlier create is a colleague's);
 * - a twin still being sent waits, as a busy target does (`busy`, `retry_after_ms`);
 * - where the earlier review belongs to a step of a plan the actor can read, the step's error names that plan and step
 *   (`earlier_plan_id`, `earlier_step_id`), found from the store with no provider call; for a colleague's review, or one no plan holds,
 *   nothing is added;
 * - every other prepare refusal ends as it did: `failed`, `blocked`, `recover_step`.
 * Every case drives the real plan engine and review lifecycle against a synthetic TikTok advertiser; nothing leaves the process.
 */
const gateway = 'tiktok_native_action',
  actor = {tenantId: 'plan-duplicates-held', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'},
  editor = {...actor, userId: 'editor'},
  colleague = {...actor, userId: 'colleague'};

function setup() {
  const world = advertiserWorld(),
    store = new Store(':memory:', Buffer.alloc(32, 83).toString('base64')),
    campaigns = new Map(),
    writes = [],
    requests = [];
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
  // The people of the workspace a plan can be shared with (campaign-inventory.test.mjs does the same).
  for (const user of ['operator', 'editor', 'colleague'])
    store.db
      .prepare('INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,?,?)')
      .run(actor.tenantId, user, 'operator', Date.now());
  const page = list => answer({list, page_info: {page: 1, page_size: 100, total_number: list.length, total_page: 1}});
  // `gate`: a promise the next campaign create waits for before it is answered. `lose`: the next create is applied and its answer lost.
  const behaviour = {gate: undefined, lose: false};
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (raw, init = {}) => {
        const url = new URL(String(raw)),
          path = url.pathname.replace('/open_api', ''),
          method = init.method ?? 'GET';
        requests.push(method + ' ' + path);
        if (method === 'GET' && path === '/v1.3/advertiser/info/')
          return Response.json(page([advertiserAnswer(world, url)]));
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
  const as = who => input => service.call('amcp_campaign', input, who),
    writeAs = who => input => service.call('amcp_write', input, who);
  /** The same create as a plan step makes, prepared on its own (outside any plan) by `who`. `lose` and `gate` act on its write. */
  const standalone = async (who = actor, name) => {
    const body = standardBodies(world.id).campaign,
      prepared = await writeAs(who)({
        action: 'prepare',
        gateway,
        connection_id: 'login',
        arguments: {
          action: body.action,
          account_id: world.id,
          payload: {...body.payload, ...(name ? {campaign_name: name} : {})},
        },
      });
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 600));
    return {
      id: prepared.data.review_id,
      execute: () => writeAs(who)({action: 'execute', review_id: prepared.data.review_id, confirmed: true}),
    };
  };
  /** A standalone create whose answer is lost: it is uncertain, and the provider holds the campaign. */
  const lostStandalone = async (who = actor) => {
    const other = await standalone(who);
    behaviour.lose = true;
    const lost = await other.execute();
    assert.equal(lost.error?.code, 'WRITE_OUTCOME_UNCERTAIN', JSON.stringify(lost).slice(0, 500));
    return other;
  };
  return {
    world,
    store,
    writes,
    requests,
    behaviour,
    as,
    call: as(actor),
    writeAs,
    standalone,
    lostStandalone,
  };
}

/**
 * An approved plan of one paused campaign create (the same request as the standalone one, unless `campaignName` changes it).
 * `body` is another standard create (an ad group, whose parent campaign this advertiser does not have), under the step `step`.
 */
async function approvedPlan(
  f,
  {
    who = actor,
    name = 'Synthetic launch',
    campaignName,
    body = standardBodies(f.world.id).campaign,
    step = 'campaign',
  } = {},
) {
  const call = f.as(who);
  const created = await call({
    action: 'create',
    name,
    brief: 'One paused create.',
    steps: [
      {
        id: step,
        kind: 'write',
        gateway,
        connection_id: 'login',
        account_id: f.world.id,
        description: 'Create the paused object',
        arguments: {
          action: body.action,
          payload: campaignName ? {...body.payload, campaign_name: campaignName} : body.payload,
        },
      },
    ],
  });
  assert.equal(created.success, true, JSON.stringify(created).slice(0, 1200));
  const id = created.data.id,
    preview = await call({action: 'approve', id});
  assert.equal(preview.success, true, JSON.stringify(preview).slice(0, 1200));
  const approved = await call({
    action: 'approve',
    id,
    confirmed: true,
    plan_hash: preview.data.plan_hash,
    summary_hash: preview.data.summary_hash,
  });
  assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 1200));
  // Prerequisites are read once here, so a later prepare_next of the plan reads nothing before the write's own prepare.
  const checked = await call({action: 'preflight', id});
  assert.equal(checked.success, true, JSON.stringify(checked).slice(0, 1200));
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
/** The stored step of a plan, as the website reads it (detail "full"). */
const stored = async (f, id, who = actor) => {
  const full = await f.as(who)({action: 'get', id, detail: 'full'});
  assert.equal(full.success, true, JSON.stringify(full).slice(0, 600));
  return full.data.steps[0];
};
/** A plan whose step was executed and whose answer was lost: its create is uncertain, and the plan holds its review. */
async function uncertainPlan(f, who = actor, options = {}) {
  const id = await approvedPlan(f, {who, ...options}),
    prepared = await f.as(who)({action: 'prepare_next', id});
  assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 1200));
  f.behaviour.lose = true;
  const lost = await f.as(who)(executeNext(id, prepared.data.review));
  assert.equal(lost.success, true, JSON.stringify(lost).slice(0, 1200));
  assert.equal(row(lost).status, 'uncertain', JSON.stringify(lost).slice(0, 800));
  return {id, review: prepared.data.review.review_id};
}
/**
 * Two creates that read the same targets are serialized by the target lock before the guard sees them; the guard's own answer to one
 * that is still being sent is met where they do not share a lock, so the busy-twin tests turn the lock off (as the execute tests do).
 */
const targetLock = {
  off: () => {
    process.env.AMCP_WRITE_TARGET_LOCK = 'false';
  },
  restore: () => {
    delete process.env.AMCP_WRITE_TARGET_LOCK;
  },
};

test('a step whose prepare meets an uncertain identical create waits: pending, the refusal kept, the earlier create settled first', async () => {
  const f = setup();
  try {
    const other = await f.lostStandalone(),
      id = await approvedPlan(f),
      before = f.requests.length;
    const held = await f.call({action: 'prepare_next', id});
    assert.equal(held.success, true, JSON.stringify(held).slice(0, 1200));
    // Not failed, not blocked, no amendment: the step only waits for the earlier create to be settled.
    assert.equal(row(held).status, 'pending', 'not failed: the request is fine, it is a twin of an unsettled one');
    assert.equal(row(held).error, 'DUPLICATE_OF_UNCERTAIN_WRITE');
    assert.equal(held.data.blocked, undefined, 'not a blocked step');
    assert.doesNotMatch(JSON.stringify(held.data), /recover_step/, 'amending the request is not what is offered');
    assert.equal(held.data.state, 'attention');
    const current = held.data.current,
      details = current.error.details;
    assert.equal(current.status, 'pending');
    assert.equal(current.error.code, 'DUPLICATE_OF_UNCERTAIN_WRITE');
    assert.equal(current.submission, undefined, 'the step was never submitted');
    assert.equal(details.earlier_state, 'uncertain');
    assert.equal(details.earlier_review_id, other.id);
    assert.equal(details.submission, 'not_sent');
    // The call that moves the plan on is the earlier create's, with the plan's own prepare_next after it: exactly as at execute.
    const settle = details.earlier_next_call;
    assert.equal(settle?.arguments?.review_id, other.id);
    assert.deepEqual(details.next_call, {...settle, then: prepareNext(id)});
    assert.deepEqual(held.data.next_call, {...settle, then: prepareNext(id)});
    assert.equal(f.writes.length, 1, 'only the standalone create was sent');
    assert.equal(f.requests.length, before, 'the provider was not called: the guard refuses before any state is read');
    // The stored step is the one the website reads: pending, no failure mark, the refusal on it.
    const step = await stored(f, id);
    assert.equal(step.status, 'pending');
    assert.equal(step.submission, undefined);
    assert.equal(step.review_id, undefined, 'no review was prepared');
    assert.equal(step.error.code, 'DUPLICATE_OF_UNCERTAIN_WRITE');
  } finally {
    f.store.close();
  }
});

test('a step whose prepare meets a twin still being sent waits for it, as for a busy target: pending, with a wait', async () => {
  const f = setup();
  targetLock.off();
  try {
    const other = await f.standalone(),
      id = await approvedPlan(f);
    let open;
    f.behaviour.gate = new Promise(resolve => (open = resolve));
    const sending = other.execute();
    for (let i = 0; i < 200 && !f.writes.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.writes.length, 1, 'the standalone create is in flight');
    const waiting = await f.call({action: 'prepare_next', id});
    assert.equal(waiting.success, true, JSON.stringify(waiting).slice(0, 1200));
    assert.equal(row(waiting).status, 'pending');
    assert.equal(row(waiting).error, 'DUPLICATE_OF_UNCERTAIN_WRITE');
    assert.equal(
      row(waiting).waiting,
      'DUPLICATE_OF_UNCERTAIN_WRITE',
      'the row says the step waits, as a busy upload does',
    );
    assert.equal(waiting.data.busy, true);
    assert.ok(
      Number.isInteger(waiting.data.retry_after_ms) &&
        waiting.data.retry_after_ms >= 1000 &&
        waiting.data.retry_after_ms <= 60000,
      'a wait of one to sixty seconds: ' + waiting.data.retry_after_ms,
    );
    assert.deepEqual(waiting.data.next_call, prepareNext(id), 'prepare again after the wait');
    assert.equal(waiting.data.blocked, undefined);
    assert.doesNotMatch(JSON.stringify(waiting.data), /recover_step/);
    assert.equal(waiting.data.current.error.details.earlier_state, 'executing');
    assert.equal(f.writes.length, 1, 'nothing more was sent');
    // The earlier create completes: the next prepare is only warned about it, and the wait and the refusal leave the step.
    open();
    assert.equal((await sending).success, true);
    const again = await f.call({action: 'prepare_next', id});
    assert.equal(again.success, true, JSON.stringify(again).slice(0, 1200));
    assert.equal(again.data.review.duplicate_warning?.earlier_state, 'complete', JSON.stringify(again.data.review));
    const step = await stored(f, id);
    assert.equal(step.status, 'review_ready');
    assert.equal(step.error, undefined, 'the refusal does not outlive the review it concerned');
    assert.equal(step.busy, undefined, 'nor does the wait');
    assert.equal(f.writes.length, 1, 'preparing again sent nothing');
  } finally {
    targetLock.restore();
    f.store.close();
  }
});

test('a wait for a twin still being sent ends when the twin turns out uncertain: the step holds as for any uncertain twin and no longer says it waits', async () => {
  const f = setup();
  targetLock.off();
  try {
    const other = await f.standalone(),
      id = await approvedPlan(f);
    let open;
    f.behaviour.gate = new Promise(resolve => (open = resolve));
    f.behaviour.lose = true;
    const sending = other.execute();
    for (let i = 0; i < 200 && !f.writes.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    const waiting = await f.call({action: 'prepare_next', id});
    assert.equal(waiting.data.busy, true, JSON.stringify(waiting.data).slice(0, 600));
    assert.equal(row(waiting).waiting, 'DUPLICATE_OF_UNCERTAIN_WRITE');
    // The twin was applied and its answer lost: it is uncertain now, not still being sent.
    open();
    assert.equal((await sending).error?.code, 'WRITE_OUTCOME_UNCERTAIN');
    const held = await f.call({action: 'prepare_next', id});
    assert.equal(held.success, true, JSON.stringify(held).slice(0, 1200));
    assert.equal(row(held).status, 'pending');
    assert.equal(row(held).error, 'DUPLICATE_OF_UNCERTAIN_WRITE');
    assert.equal(row(held).waiting, undefined, 'it no longer waits for a create that is still being sent');
    assert.equal(held.data.busy, undefined);
    assert.equal(held.data.current.error.details.earlier_state, 'uncertain');
    assert.deepEqual(held.data.next_call, {
      ...held.data.current.error.details.earlier_next_call,
      then: prepareNext(id),
    });
    assert.equal((await stored(f, id)).busy, undefined);
    assert.equal(f.writes.length, 1, 'nothing more was sent');
  } finally {
    targetLock.restore();
    f.store.close();
  }
});

test('a step whose prepare meets a colleague’s twin waits too: pending, the plan’s own prepare_next, and no plan is named', async () => {
  const f = setup();
  try {
    const theirs = await f.lostStandalone(colleague),
      id = await approvedPlan(f);
    const held = await f.call({action: 'prepare_next', id});
    assert.equal(held.success, true, JSON.stringify(held).slice(0, 1200));
    assert.equal(row(held).status, 'pending');
    assert.equal(row(held).error, 'DUPLICATE_OF_UNCERTAIN_WRITE');
    assert.equal(held.data.blocked, undefined);
    const details = held.data.current.error.details;
    // A colleague's review is not named, and there is no call of theirs to offer: only the plan's own call stands.
    assert.equal(details.readable, false);
    assert.equal(details.earlier_review_id, undefined);
    assert.equal(details.earlier_next_call, undefined);
    assert.equal(details.earlier_plan_id, undefined, 'nothing is added where the earlier create is a colleague’s');
    assert.equal(details.earlier_step_id, undefined);
    assert.deepEqual(details.next_call, prepareNext(id));
    assert.deepEqual(held.data.next_call, prepareNext(id));
    assert.ok(!JSON.stringify(held).includes(theirs.id), 'a colleague’s review is still not named');
    assert.equal(heldByStateCheck(await stored(f, id)), true);
  } finally {
    f.store.close();
  }
});

test('a held step is amended in place only on purpose: recover_step still works on it, and nothing was sent', async () => {
  const f = setup();
  try {
    await f.lostStandalone();
    const id = await approvedPlan(f);
    assert.equal(row(await f.call({action: 'prepare_next', id})).status, 'pending');
    // A changed request is a new create, which the guard does not hold back: the person may still choose to change it.
    const amended = await f.call({
      action: 'recover_step',
      id,
      step_id: 'campaign',
      confirmed: true,
      patch: [{path: '/payload/campaign_name', value: 'Another campaign'}],
    });
    assert.equal(amended.success, true, JSON.stringify(amended).slice(0, 1200));
    assert.deepEqual(amended.data.next_call, prepareNext(id));
    const prepared = await f.call({action: 'prepare_next', id});
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 1200));
    assert.equal(typeof prepared.data.review?.review_id, 'string', 'the changed request prepares a review');
    assert.equal(f.writes.length, 1, 'nothing was sent by amending or by preparing');
  } finally {
    f.store.close();
  }
});

test('run stops at a step held at prepare, names the earlier create’s call first, and never executes it', async () => {
  const f = setup();
  try {
    const other = await f.lostStandalone(),
      id = await approvedPlan(f);
    const stopped = await f.call({action: 'run', id});
    assert.equal(stopped.success, true, JSON.stringify(stopped).slice(0, 1200));
    // The stop is the one the website already words (needs_attention): a stop of its own would need website wording and Arabic.
    assert.equal(stopped.data.run.stopped, 'needs_attention', JSON.stringify(stopped.data.run));
    assert.match(stopped.data.run.reason, /DUPLICATE_OF_UNCERTAIN_WRITE/);
    assert.deepEqual(stopped.data.run.executed, [], 'nothing was attempted');
    assert.equal(row(stopped).status, 'pending');
    const settle = stopped.data.current.error.details.earlier_next_call;
    assert.equal(settle?.arguments?.review_id, other.id);
    assert.deepEqual(stopped.data.run.next_call, {...settle, then: prepareNext(id)});
    assert.equal(stopped.data.blocked, undefined);
    assert.equal(f.writes.length, 1, 'only the standalone create was sent');
    // Run again: the same stop, still nothing sent.
    const again = await f.call({action: 'run', id});
    assert.equal(again.data.run.stopped, 'needs_attention', JSON.stringify(again.data.run));
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
});

test('the background runner leaves a held step alone on both paths: each stores the refusal with the mark that holds it', async () => {
  const f = setup();
  try {
    await f.lostStandalone();
    // At prepare.
    const atPrepare = await approvedPlan(f, {name: 'Held at prepare'});
    assert.equal(row(await f.call({action: 'prepare_next', id: atPrepare})).status, 'pending');
    // At execute: a second step prepared before its twin went uncertain is refused when it is executed.
    const fresh = setup();
    try {
      const id = await approvedPlan(fresh),
        prepared = await fresh.call({action: 'prepare_next', id});
      await fresh.lostStandalone();
      const refused = await fresh.call(executeNext(id, prepared.data.review));
      assert.equal(row(refused).status, 'pending', JSON.stringify(refused).slice(0, 600));
      for (const [label, step] of [
        ['prepare', await stored(f, atPrepare)],
        ['execute', await stored(fresh, id)],
      ]) {
        assert.equal(step.status, 'pending', label);
        assert.equal(step.error.code, 'DUPLICATE_OF_UNCERTAIN_WRITE', label);
        assert.equal(step.error.details.submission, 'not_sent', label + ': the mark of a refusal that sent nothing');
        assert.equal(refusedByDuplicateGuard(step.error), true, label);
        assert.equal(heldByStateCheck(step), true, label + ': held until a person prepares it again');
        // The run of a plan of independent uploads skips a held upload, and never takes it as the next one to move.
        assert.equal(nextUpload({steps: [step]}), undefined, label);
        assert.equal(
          nextUpload({steps: [step, {id: 'other', kind: 'media', status: 'pending', depends_on: []}]})?.id,
          'other',
          label,
        );
      }
    } finally {
      fresh.store.close();
    }
  } finally {
    f.store.close();
  }
});

test('the step’s next call differs by who holds the earlier create, and the refusal at execute is shaped by the same rule', async () => {
  const f = setup();
  try {
    const id = await approvedPlan(f),
      prepared = await f.call({action: 'prepare_next', id}),
      other = await f.lostStandalone();
    const refused = await f.call(executeNext(id, prepared.data.review));
    assert.equal(refused.success, true, JSON.stringify(refused).slice(0, 1200));
    assert.equal(row(refused).status, 'pending');
    const details = refused.data.current.error.details;
    assert.equal(details.submission, 'not_sent');
    assert.equal(details.earlier_review_id, other.id);
    assert.deepEqual(details.next_call, {...details.earlier_next_call, then: prepareNext(id)});
    assert.deepEqual(refused.data.next_call, details.next_call);
    assert.equal(f.writes.length, 1, 'the step’s review was never sent');
  } finally {
    f.store.close();
  }
});

// The gates this package touches keep refusing what they refused before. The one thing removed is the dead end of a step
// that only waits for an earlier create.
const standardCreate = f => {
  const body = standardBodies(f.world.id).campaign;
  return {action: body.action, account_id: f.world.id, payload: body.payload};
};
test('negative: the guard still refuses an identical create, at prepare on its own and at execute, while the earlier one is uncertain', async () => {
  const f = setup();
  try {
    const other = await f.lostStandalone();
    // On its own at prepare, the refusal is the guard's, unchanged: the code, the earlier review and the call that settles it.
    const refused = await f.writeAs(actor)({
      action: 'prepare',
      gateway,
      connection_id: 'login',
      arguments: standardCreate(f),
    });
    assertRefused(refused, 'DUPLICATE_OF_UNCERTAIN_WRITE');
    assert.equal(f.writes.length, 1, 'only the earlier create was sent');
    assert.equal(refused.error.details.earlier_review_id, other.id);
    assert.equal(
      refused.error.details.submission,
      undefined,
      'the refusal at prepare carries no mark: the step’s copy does',
    );
    assert.equal(refusedByDuplicateGuard(refused.error), false);
    // In a plan at execute, the step is held and nothing is sent.
    const id = await approvedPlan(f, {campaignName: 'A step prepared before its twin was sent'}),
      twin = await f.standalone(actor, 'A step prepared before its twin was sent'),
      prepared = await f.call({action: 'prepare_next', id});
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 800));
    f.behaviour.lose = true;
    assert.equal((await twin.execute()).error?.code, 'WRITE_OUTCOME_UNCERTAIN');
    const held = await f.call(executeNext(id, prepared.data.review));
    assert.equal(row(held).status, 'pending');
    assert.equal(row(held).error, 'DUPLICATE_OF_UNCERTAIN_WRITE');
    assert.equal(f.writes.length, 2, 'the plan’s own create was not sent: only the two standalone ones');
  } finally {
    f.store.close();
  }
});
test('negative: a changed request still prepares while an earlier create is uncertain', async () => {
  const f = setup();
  try {
    await f.lostStandalone();
    const id = await approvedPlan(f, {campaignName: 'A different campaign'});
    const prepared = await f.call({action: 'prepare_next', id});
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 1200));
    assert.equal(typeof prepared.data.review?.review_id, 'string', 'a changed request is a new create');
    assert.equal(prepared.data.blocked, undefined);
    assert.equal((await stored(f, id)).status, 'review_ready');
  } finally {
    f.store.close();
  }
});

test('negative: another prepare refusal still ends the step failed, blocked, with the call that amends it', async () => {
  const f = setup();
  try {
    // A refusal that is not the guard's, with an earlier create uncertain beside it: an ad group names a parent campaign this
    // advertiser does not have, so its review cannot be made. That request is wrong, not a twin: the step is broken and is amended.
    await f.lostStandalone();
    const id = await approvedPlan(f, {body: standardBodies(f.world.id).adgroup, step: 'adgroup'});
    const refused = await f.call({action: 'prepare_next', id});
    assert.equal(refused.success, true, JSON.stringify(refused).slice(0, 1200));
    assert.equal(row(refused, 'adgroup').status, 'failed', JSON.stringify(refused.data.current?.error).slice(0, 500));
    assert.equal(row(refused, 'adgroup').error, 'STATE_TARGET_MISMATCH');
    assert.equal(refused.data.blocked, true);
    assert.equal(refused.data.next_call.arguments.action, 'recover_step', 'the step is amended in place');
    assert.equal(refused.data.current.submission, 'not_submitted');
    assert.equal(refused.data.state, 'attention');
    assert.equal(refused.data.current.error.details?.earlier_plan_id, undefined, 'nothing of the guard is added');
    assert.equal(f.writes.length, 1, 'only the earlier create was sent');
  } finally {
    f.store.close();
  }
});

test('earlier_plan_id names the plan that holds the earlier create, at prepare and at execute', async () => {
  const f = setup();
  try {
    const first = await uncertainPlan(f, actor, {name: 'The first launch'});
    // At prepare.
    const second = await approvedPlan(f, {name: 'The second launch'}),
      held = await f.call({action: 'prepare_next', id: second});
    assert.equal(row(held).status, 'pending', JSON.stringify(held).slice(0, 800));
    const details = held.data.current.error.details;
    assert.equal(details.earlier_review_id, first.review);
    assert.equal(details.earlier_plan_id, first.id, 'the plan whose step holds the earlier review');
    assert.equal(details.earlier_step_id, 'campaign', 'and that step');
    assert.equal(heldByStateCheck(await stored(f, second)), true);
    assert.equal((await stored(f, second)).error.details.earlier_plan_id, first.id, 'the stored step keeps both');
    // At execute: a third plan prepared before the first was executed, so its review exists when the guard looks at execute.
    const g = setup();
    try {
      const a = await approvedPlan(g, {name: 'The first launch'}),
        b = await approvedPlan(g, {name: 'The third launch'}),
        preparedA = await g.call({action: 'prepare_next', id: a}),
        preparedB = await g.call({action: 'prepare_next', id: b});
      g.behaviour.lose = true;
      assert.equal(row(await g.call(executeNext(a, preparedA.data.review))).status, 'uncertain');
      const refused = await g.call(executeNext(b, preparedB.data.review));
      assert.equal(row(refused).status, 'pending', JSON.stringify(refused).slice(0, 800));
      const atExecute = refused.data.current.error.details;
      assert.equal(atExecute.earlier_plan_id, a, 'the same fields from the same rule');
      assert.equal(atExecute.earlier_step_id, 'campaign');
    } finally {
      g.store.close();
    }
  } finally {
    f.store.close();
  }
});

test('earlier_plan_id is not added where no plan holds the earlier create: a standalone write', async () => {
  const f = setup();
  try {
    await f.lostStandalone();
    const id = await approvedPlan(f),
      held = await f.call({action: 'prepare_next', id});
    const details = held.data.current.error.details;
    assert.equal(typeof details.earlier_review_id, 'string', 'the review is named: it is the actor’s own');
    assert.equal(details.earlier_plan_id, undefined, 'no plan holds it');
    assert.equal(details.earlier_step_id, undefined);
  } finally {
    f.store.close();
  }
});

test('earlier_plan_id is only for a plan the actor can read: a colleague’s plan is never named', async () => {
  const f = setup();
  try {
    // The owner's plan, shared with the editor, whose step the editor runs; its answer is lost, so the review is the editor's own.
    const shared = await approvedPlan(f, {name: 'A shared launch'});
    assert.equal(
      (await f.call({action: 'assign', id: shared, user_id: 'editor', role: 'editor'})).success,
      true,
      'the owner shares the plan',
    );
    const prepared = await f.as(editor)({action: 'prepare_next', id: shared});
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 800));
    f.behaviour.lose = true;
    const lost = await f.as(editor)(executeNext(shared, prepared.data.review));
    assert.equal(row(lost).status, 'uncertain', JSON.stringify(lost).slice(0, 800));
    // The editor's own plan of the same create: the plan that holds the earlier review is one the editor can read.
    const own = await approvedPlan(f, {who: editor, name: 'The editor’s launch'}),
      named = await f.as(editor)({action: 'prepare_next', id: own});
    assert.equal(row(named).status, 'pending', JSON.stringify(named).slice(0, 800));
    assert.equal(named.data.current.error.details.earlier_review_id, prepared.data.review.review_id);
    assert.equal(named.data.current.error.details.earlier_plan_id, shared, 'a collaborator reads the plan');
    // The owner takes the editor off the plan: the review is still the editor's own, the plan is no longer theirs to read.
    assert.equal((await f.call({action: 'unassign', id: shared, user_id: 'editor'})).success, true);
    const after = await f.as(editor)({action: 'prepare_next', id: own});
    assert.equal(row(after).status, 'pending', JSON.stringify(after).slice(0, 800));
    const details = after.data.current.error.details;
    assert.equal(details.earlier_review_id, prepared.data.review.review_id, 'the review is still the editor’s own');
    assert.equal(details.earlier_plan_id, undefined, 'a plan the actor cannot read is not named');
    assert.equal(details.earlier_step_id, undefined);
  } finally {
    f.store.close();
  }
});

test('negative: a step refused for a changed provider state is pending with prepare_next and carries nothing of the guard', async () => {
  const f = setup();
  try {
    const id = await approvedPlan(f),
      prepared = await f.call({action: 'prepare_next', id});
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 800));
    f.world.currency = 'EUR';
    const refused = await f.call(executeNext(id, prepared.data.review));
    assert.equal(row(refused).status, 'pending', JSON.stringify(refused).slice(0, 800));
    assert.equal(row(refused).error, 'STATE_CHANGED');
    const details = refused.data.current.error.details;
    assert.equal(details.submission, 'not_sent');
    assert.deepEqual(details.next_call, prepareNext(id), 'the plan’s own call, as in M1');
    assert.deepEqual(refused.data.next_call, prepareNext(id));
    for (const field of ['earlier_next_call', 'earlier_review_id', 'earlier_plan_id', 'earlier_step_id'])
      assert.equal(details[field], undefined, field);
    assert.equal(heldByStateCheck(await stored(f, id)), true);
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {openWriteClaims} from '../dist/src/job-repository.js';
import {stamp, tiktokReconcileFixture} from './helpers/tiktok-reconcile-fixture.mjs';
import {standardBodies} from './helpers/tiktok-standard-creates.mjs';

/**
 * Round 2.5, package r25-m3-dupstep, fix round 2, item 1 (lead review S2-1 b). A create that was settled as applied is never invisible
 * to the guard against creating twice. The guard warns of an identical create that completed in the last ten minutes, and it dated a
 * completed claim by the time the claim was taken. Accepting an uncertain create as applied completes its claim without moving that time
 * (src/write-reconciliation.ts), so a create accepted more than ten minutes after it was sent was invisible: the plan step that had been
 * held for it prepared a clean review with no warning and no refusal, and `run` made the second object. A claim whose result is
 * `reconciled: true` is now dated by `reconciled_at`, the moment of the acceptance, so the twin is warned about for ten minutes from it.
 * Every case drives the real reconcile and accept calls and the real plan engine against a synthetic TikTok advertiser; nothing leaves
 * the process, and the age of the claim is the only thing set by hand (the clock is not waited for).
 */
before(() => {
  process.env.AMCP_WRITE_RECONCILE_DELAY_MS = '0';
  process.env.AMCP_WRITE_RECONCILE_ROUND_MS = '0';
});
after(() => {
  delete process.env.AMCP_WRITE_RECONCILE_DELAY_MS;
  delete process.env.AMCP_WRITE_RECONCILE_ROUND_MS;
});

const tenant = 'plan-duplicates-settled',
  minute = 60000;
const plan = (f, input, who = f.actor) => f.call('amcp_campaign', input, who);
const reconcile = (f, id, extra = {}) => f.call('amcp_write', {action: 'reconcile', review_id: id, ...extra});
const row = (result, step = 'campaign') => result.data.steps.find(s => s.id === step);
const executeNext = (id, review) => ({
  action: 'execute_next',
  id,
  review_id: review.review_id,
  idempotency_key: review.idempotency_key,
  confirmed: true,
});
const claim = (f, id) =>
  f.store.db.prepare('SELECT state,result,created_at FROM idempotency WHERE tenant_id=? AND key=?').get(tenant, id);

/**
 * A create that was sent and whose answer was lost (so it is uncertain), and the provider made the object: both the claim and the
 * object are `ageMs` old, as they are when the person settles it later.
 */
async function lostLongAgo(f, ageMs = 11 * minute) {
  const lost = await f.lose('campaign', {applied: true});
  assert.equal(lost.refused.error?.code, 'WRITE_OUTCOME_UNCERTAIN', JSON.stringify(lost.refused).slice(0, 500));
  f.store.db
    .prepare('UPDATE idempotency SET created_at=created_at-? WHERE tenant_id=? AND key=?')
    .run(ageMs, tenant, lost.id);
  for (const made of f.rows.campaign)
    if (made._at) {
      made._at -= ageMs;
      made.create_time = stamp(made._at);
    }
  return lost;
}
/** The person reads the earlier create back (read-only lookups) and accepts that it was applied: the real reconcile, then accept. */
async function acceptApplied(f, id) {
  const found = await reconcile(f, id);
  assert.equal(found.data?.classification, 'appears_applied', JSON.stringify(found).slice(0, 600));
  const accepted = await reconcile(f, id, {accept_applied: true, reconciliation_id: found.data.reconciliation_id});
  assert.equal(accepted.success, true, JSON.stringify(accepted).slice(0, 600));
  assert.equal(claim(f, id).state, 'complete');
}
/** An approved, checked plan of one paused campaign create: the same request as the lost one. */
async function approvedPlan(f, name = 'Synthetic launch') {
  const body = standardBodies(f.world.id).campaign,
    created = await plan(f, {
      action: 'create',
      name,
      brief: 'One paused create.',
      steps: [
        {
          id: 'campaign',
          kind: 'write',
          gateway: f.connection.gateway,
          connection_id: f.connection.id,
          account_id: f.world.id,
          description: 'Create the paused object',
          arguments: {action: body.action, payload: body.payload},
        },
      ],
    });
  assert.equal(created.success, true, JSON.stringify(created).slice(0, 1200));
  const id = created.data.id,
    preview = await plan(f, {action: 'approve', id}),
    approved = await plan(f, {
      action: 'approve',
      id,
      confirmed: true,
      plan_hash: preview.data.plan_hash,
      summary_hash: preview.data.summary_hash,
    });
  assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 1200));
  const checked = await plan(f, {action: 'preflight', id});
  assert.equal(checked.success, true, JSON.stringify(checked).slice(0, 1200));
  return id;
}

test('a twin accepted as applied after ten minutes still warns for ten minutes from the acceptance: the held step shows the warning, run stops for it, and only execute_next makes the second object', async () => {
  const f = tiktokReconcileFixture({tenant});
  try {
    const lost = await lostLongAgo(f),
      id = await approvedPlan(f);
    // Held while the earlier create is uncertain: nothing is sent.
    const held = await plan(f, {action: 'run', id});
    assert.equal(held.data.run.stopped, 'needs_attention', JSON.stringify(held.data.run).slice(0, 600));
    assert.equal(row(held).status, 'pending');
    assert.equal(row(held).error, 'DUPLICATE_OF_UNCERTAIN_WRITE');
    assert.equal(f.sent.length, 1, 'only the lost create was sent');
    // The person accepts the lost create as applied, eleven minutes after it was sent.
    await acceptApplied(f, lost.id);
    const settled = claim(f, lost.id),
      result = JSON.parse(settled.result);
    assert.equal(result.reconciled, true);
    assert.ok(Date.now() - settled.created_at > 10 * minute, 'the claim is older than the warning window');
    assert.ok(Date.now() - result.reconciled_at < minute, 'the acceptance is not');
    // The held step is prepared again over what exists now: the review carries the warning, and run stops for it.
    const shown = await plan(f, {action: 'run', id});
    assert.equal(shown.success, true, JSON.stringify(shown).slice(0, 1200));
    assert.equal(shown.data.run.stopped, 'needs_attention', JSON.stringify(shown.data.run).slice(0, 600));
    assert.equal(
      shown.data.review.duplicate_warning?.earlier_review_id,
      lost.id,
      'the twin settled as applied is warned about: ' + JSON.stringify(shown.data.review).slice(0, 600),
    );
    assert.equal(shown.data.review.duplicate_warning.earlier_state, 'complete');
    assert.deepEqual(shown.data.run.executed, [], 'nothing was executed in this call');
    assert.equal(f.sent.length, 1, 'the second run sent nothing');
    // The reason is true of that review: it says the review carries a warning, and it does.
    assert.match(shown.data.run.reason, /carries a warning/);
    // And true of the run after it (fix round 3, lead re-review R-1): the next run executes that review, so the reason does not say it never does.
    assert.match(
      shown.data.run.reason,
      /A run called again after this stop executes it, so call run again only once the user has seen the warning and wants it\.$/,
    );
    assert.doesNotMatch(shown.data.run.reason, /never sends it on its own/);
    // Only an explicit execute_next with that review makes the second object, once.
    const done = await plan(f, executeNext(id, shown.data.review));
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 1200));
    assert.equal(f.sent.length, 2);
  } finally {
    f.close();
  }
});

test('the reason of run says a warning exists only when the review carries one: a twin accepted as applied long ago is no longer warned about, and the reason does not claim it', async () => {
  const f = tiktokReconcileFixture({tenant});
  try {
    const lost = await lostLongAgo(f, 30 * minute),
      id = await approvedPlan(f);
    assert.equal((await plan(f, {action: 'run', id})).data.run.stopped, 'needs_attention');
    await acceptApplied(f, lost.id);
    // The acceptance itself is eleven minutes old: outside the window the guard warns for.
    f.store.db
      .prepare("UPDATE idempotency SET result=json_set(result,'$.reconciled_at',?) WHERE tenant_id=? AND key=?")
      .run(Date.now() - 11 * minute, tenant, lost.id);
    const shown = await plan(f, {action: 'run', id});
    assert.equal(shown.success, true, JSON.stringify(shown).slice(0, 1200));
    assert.equal(
      shown.data.run.stopped,
      'needs_attention',
      'the step was held earlier: the new review is still shown first',
    );
    assert.equal(
      shown.data.review.duplicate_warning,
      undefined,
      'nothing within ten minutes: the review carries no warning',
    );
    assert.doesNotMatch(
      shown.data.run.reason,
      /carries a warning/,
      'the reason does not claim a warning the review lacks',
    );
    assert.match(shown.data.run.reason, /carries no warning/, 'it says so');
    assert.match(shown.data.run.reason, /A run called again executes it\.$/, 'and what the next run does');
    assert.doesNotMatch(shown.data.run.reason, /never sends it on its own/);
    assert.deepEqual(shown.data.run.executed, []);
    assert.equal(f.sent.length, 1, 'nothing was sent');
  } finally {
    f.close();
  }
});

test('a review prepared before its twin was settled as applied is refused at execute, held, and sends nothing', async () => {
  const f = tiktokReconcileFixture({tenant});
  try {
    // Two identical creates are prepared before either is sent (the guard sees no claim yet): the plan's review, then the standalone one.
    const id = await approvedPlan(f),
      prepared = await plan(f, {action: 'prepare_next', id});
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 800));
    assert.equal(prepared.data.review.duplicate_warning, undefined, 'nothing had completed when it was prepared');
    // The standalone one is sent and its answer lost; the person accepts it as applied, eleven minutes after it was sent.
    const lost = await lostLongAgo(f);
    await acceptApplied(f, lost.id);
    // The twin is visible to the guard at execute (it completed a moment ago), and this review was not shown it: refused, never sent.
    const refused = await plan(f, executeNext(id, prepared.data.review));
    assert.equal(refused.success, true, JSON.stringify(refused).slice(0, 800));
    assert.equal(row(refused).status, 'pending', JSON.stringify(refused).slice(0, 800));
    assert.equal(row(refused).error, 'DUPLICATE_OF_COMPLETED_WRITE', 'a create settled as applied is a completed twin');
    assert.equal(f.sent.length, 1, 'the second object was not made');
  } finally {
    f.close();
  }
});

test('control: a twin that completed within ten minutes still warns, and one that completed earlier is still not counted', async () => {
  const f = tiktokReconcileFixture({tenant});
  try {
    const first = await f.prepare('campaign');
    assert.equal((await f.execute(first.data.review_id)).success, true);
    const warned = await f.prepare('campaign');
    assert.equal(warned.data.duplicate_warning?.earlier_review_id, first.data.review_id, 'completed just now');
    // The same claim eleven minutes old, never reconciled: outside the window.
    f.store.db
      .prepare('UPDATE idempotency SET created_at=created_at-? WHERE tenant_id=? AND key=?')
      .run(11 * minute, tenant, first.data.review_id);
    const unwarned = await f.prepare('campaign');
    assert.equal(unwarned.data.duplicate_warning, undefined, 'a plain completion of eleven minutes ago is not counted');
  } finally {
    f.close();
  }
});

test('openWriteClaims dates a completed claim by its acceptance when its result says reconciled, and by its creation otherwise', () => {
  const store = new Store(':memory:', Buffer.alloc(32, 7).toString('base64')),
    now = Date.now(),
    since = now - 10 * minute;
  const put = (key, createdAgo, result, state = 'complete') =>
    store.db
      .prepare('INSERT INTO idempotency(tenant_id,key,fingerprint,state,result,created_at) VALUES(?,?,?,?,?,?)')
      .run(
        tenant,
        key,
        'fp-' + key,
        state,
        result === undefined ? null : typeof result === 'string' ? result : JSON.stringify(result),
        now - createdAgo,
      );
  try {
    const settled = (agoMs, extra = {}) => ({
      success: true,
      executed: true,
      outcome: 'reconciled',
      reconciled: true,
      reconciled_at: now - agoMs,
      ...extra,
    });
    // In the window: made recently; accepted recently though made long ago.
    put('plain-recent', 2 * minute, {success: true});
    put('accepted-recently', 40 * minute, settled(minute));
    // Out of it: made long ago; accepted long ago; reconciled with no time, a time that is not a number, or not reconciled at all.
    put('plain-old', 11 * minute, {success: true});
    put('accepted-long-ago', 40 * minute, settled(11 * minute));
    put('flag-without-time', 40 * minute, {success: true, reconciled: true});
    put('time-as-text', 40 * minute, settled(minute, {reconciled_at: new Date(now - minute).toISOString()}));
    put('time-without-flag', 40 * minute, {success: true, reconciled: false, reconciled_at: now - minute});
    put('not-json', 40 * minute, 'not json {"reconciled_at": 1');
    put('no-result', 40 * minute, undefined);
    // A claim in another workspace never shows up here.
    store.db
      .prepare('INSERT INTO idempotency(tenant_id,key,fingerprint,state,result,created_at) VALUES(?,?,?,?,?,?)')
      .run('someone-else', 'theirs', 'fp-theirs', 'complete', JSON.stringify(settled(0)), now - 40 * minute);
    const keys = openWriteClaims(store, tenant, since).map(claim => String(claim.key));
    assert.deepEqual(keys.sort(), ['accepted-recently', 'plain-recent']);
    // The row keeps the time the claim was taken (the lookups date the provider's objects by it), not the acceptance.
    const accepted = openWriteClaims(store, tenant, since).find(claim => claim.key === 'accepted-recently');
    assert.equal(Number(accepted.created_at), now - 40 * minute);
  } finally {
    store.close();
  }
});

test('openWriteClaims still bounds the completed claims to the newest 200 by the time they settled, and lists the unsettled first', () => {
  const store = new Store(':memory:', Buffer.alloc(32, 9).toString('base64')),
    now = Date.now();
  try {
    const insert = store.db.prepare(
      'INSERT INTO idempotency(tenant_id,key,fingerprint,state,result,created_at) VALUES(?,?,?,?,?,?)',
    );
    // 205 plain completions, one a second apart; one accepted just now though made long ago; and an uncertain one that is never cut by
    // count. 206 completed claims fall in the window, so the newest 200 by the time they settled leave out the oldest six plain ones.
    for (let i = 0; i < 205; i++)
      insert.run(tenant, 'plain-' + i, 'fp', 'complete', JSON.stringify({success: true}), now - (300 - i) * 1000);
    insert.run(
      tenant,
      'accepted',
      'fp',
      'complete',
      JSON.stringify({success: true, reconciled: true, reconciled_at: now}),
      now - 40 * minute,
    );
    insert.run(tenant, 'uncertain', 'fp', 'uncertain', null, now - 5 * minute);
    const claims = openWriteClaims(store, tenant, now - 10 * minute),
      keys = claims.map(claim => String(claim.key));
    assert.equal(keys[0], 'uncertain', 'the unsettled come first');
    assert.equal(keys.length, 201, 'the uncertain one and the newest 200 completed');
    assert.equal(keys.at(-1), 'accepted', 'oldest first: the one settled just now is last');
    assert.ok(!keys.includes('plain-5') && keys.includes('plain-6'), 'the oldest six plain completions were cut');
  } finally {
    store.close();
  }
});

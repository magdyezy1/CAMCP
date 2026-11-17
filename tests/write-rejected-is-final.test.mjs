import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {stamp, tiktokReconcileFixture} from './helpers/tiktok-reconcile-fixture.mjs';
import {standardBodies} from './helpers/tiktok-standard-creates.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * R2.5 M2 merge, the design joins between r25-m2-refusal and r25-m2-reconcile (lead re-review of r25-m2-reconcile, "Merge joins" 1 and 2).
 *
 * A rejected review is final. The refusal package makes a TikTok refusal in the body of an HTTP 200 answer (a parameter, role, consent or
 * eligibility code with no data, such as 40002) a `rejected` write: it applied nothing, so its key is retired and a corrected request, or
 * the identical one, is a new review. The reconcile package watches every write from its claim and checks an uncertain one by reads. The
 * two meet where the claim is rejected: the watch must go with the rejection (nothing is left to check), the created lookups never run for
 * it, the duplicate guard never counts it as an unresolved create, and, when the rejected review was a replacement, the review it
 * replaced is unsealed and read again (lead re-review N4 and F1). After an uncertain create the guard still holds an identical one back.
 *
 * Every provider answer here is synthetic; the review lifecycle, the guard, the lookups and the worker are the real ones.
 */
before(() => {
  process.env.AMCP_WRITE_RECONCILE_DELAY_MS = '0';
  process.env.AMCP_WRITE_RECONCILE_ROUND_MS = '0';
});
after(() => {
  delete process.env.AMCP_WRITE_RECONCILE_DELAY_MS;
  delete process.env.AMCP_WRITE_RECONCILE_ROUND_MS;
});

const kind = 'write_reconcile';
const jobs = f =>
  f.store.db
    .prepare('SELECT id,state,available_at,attempts,input FROM jobs WHERE tenant_id=? AND kind=? ORDER BY created_at')
    .all(f.actor.tenantId, kind)
    .map(row => ({...row, input: JSON.parse(row.input)}));
const queuedFor = f =>
  jobs(f)
    .filter(job => job.state === 'queued')
    .map(job => job.input.review_id);
const status = (f, id) => f.call('amcp_write', {action: 'status', review_id: id});
const reconcile = (f, id) => f.call('amcp_write', {action: 'reconcile', review_id: id});
const runDue = (f, worker = f.worker) => {
  f.store.db.prepare("UPDATE jobs SET available_at=0 WHERE kind=? AND state='queued'").run(kind);
  return worker.once();
};
/** TikTok's own refusal of a parameter, in the body of an HTTP 200 answer with no data (the live shape, LV-8). */
const budgetRefusal = {code: 40002, message: 'Your budget must be $50 or more.'};
const nameRefusal = {code: 40002, message: 'The campaign name already exists.'};
const campaign = standardBodies('x').campaign.payload;
/** The campaign the review froze, as it exists at TikTok when the create was applied late: the fields TikTok echoes agree. */
const lateCampaign = (f, id = '77') => ({
  campaign_id: id,
  advertiser_id: f.world.id,
  campaign_name: campaign.campaign_name,
  objective_type: campaign.objective_type,
  budget_mode: campaign.budget_mode,
  operation_status: 'DISABLE',
  create_time: stamp(Date.now()),
});

test('TikTok refuses a create with 40002 in an HTTP 200 answer: it is rejected, no watch is left, nothing is read for it, and the same request prepares and executes as a new review', async () => {
  const f = tiktokReconcileFixture({tenant: 'rejected-final'});
  try {
    f.state.refusal = budgetRefusal;
    const first = await f.prepare('campaign');
    assert.equal(first.success, true, JSON.stringify(first).slice(0, 400));
    const id = first.data.review_id;
    // The claim queues the watch, as it does for every write; the refusal then arrives.
    let watching;
    f.state.onWrite = () => {
      watching = queuedFor(f);
    };
    const refused = await f.execute(id);
    f.state.onWrite = undefined;
    assert.deepEqual(watching, [id], 'the write was watched from its claim');
    assertRefused(refused, 'PLATFORM_ERROR');
    assert.equal(refused.error.details.submission, 'rejected', JSON.stringify(refused.error.details).slice(0, 400));
    assert.equal(f.claim(id).state, 'rejected');
    // The watch went in the transaction that rejected the claim: nothing is left for the job to pick up, or to read.
    assert.deepEqual(jobs(f), [], 'no write_reconcile job is left for a rejected write');
    const requests = f.requests.length;
    assert.equal(await runDue(f), false, 'the worker has nothing to check');
    assertRefused(await reconcile(f, id), 'RECONCILIATION_UNAVAILABLE');
    assert.equal((await status(f, id)).data.state, 'rejected');
    assert.equal(f.requests.length, requests, 'no lookup ran for a rejected write');

    // The identical request is a new review: not held back as an unresolved create, not warned of as a completed one.
    f.state.refusal = undefined;
    const again = await f.prepare('campaign');
    assert.equal(again.success, true, JSON.stringify(again).slice(0, 500));
    assert.notEqual(again.data.review_id, id);
    assert.equal(again.data.duplicate_warning, undefined);
    const done = await f.execute(again.data.review_id);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 500));
    assert.equal(f.sent.length, 2, 'the refused create and the new one, each sent once');
    assert.equal(f.claim(again.data.review_id).state, 'complete');
    assert.equal(f.claim(id).state, 'rejected', 'the rejected review stays rejected');
    assert.deepEqual(jobs(f), [], 'a completed write leaves no watch either');
    assertRefused(await f.execute(id), 'WRITE_REJECTED', {writes: () => f.sent.length - 2});
  } finally {
    f.close();
  }
});

test('a corrected request after the refusal prepares as a new review too', async () => {
  const f = tiktokReconcileFixture({tenant: 'rejected-corrected'});
  try {
    f.state.refusal = budgetRefusal;
    const id = (await f.prepare('campaign')).data.review_id;
    assert.equal((await f.execute(id)).error.details.submission, 'rejected');
    f.state.refusal = undefined;
    const corrected = await f.prepare('campaign', p => ({...p, campaign_name: 'Corrected campaign'}));
    assert.equal(corrected.success, true, JSON.stringify(corrected).slice(0, 500));
    assert.equal(corrected.data.duplicate_warning, undefined);
    assert.equal((await f.execute(corrected.data.review_id)).success, true);
    assert.deepEqual(
      f.sent.map(s => s.body.campaign_name),
      ['Synthetic campaign', 'Corrected campaign'],
    );
  } finally {
    f.close();
  }
});

test('after an uncertain create the guard still holds an identical one back, and the write stays watched and checkable', async () => {
  const f = tiktokReconcileFixture({tenant: 'uncertain-held'});
  try {
    const {id, refused} = await f.lose('campaign', {applied: true});
    assertRefused(refused, 'WRITE_OUTCOME_UNCERTAIN');
    assert.equal(f.claim(id).state, 'uncertain');
    assert.deepEqual(queuedFor(f), [id], 'an uncertain write is watched');
    // Nothing of the rejected path applies: an identical request is refused as the same unresolved create, naming the earlier review.
    const same = await f.prepare('campaign');
    assertRefused(same, 'DUPLICATE_OF_UNCERTAIN_WRITE');
    assert.equal(same.error.details.earlier_review_id, id);
    assert.equal(same.error.details.earlier_match, 'identical');
    // A create of another object is not held back.
    const other = await f.prepare('campaign', p => ({...p, campaign_name: 'Another campaign'}));
    assert.equal(other.success, true, JSON.stringify(other).slice(0, 500));
    // The check finds the applied object, by reads only.
    assert.equal(await runDue(f), true);
    const shown = (await status(f, id)).data.reconciliation;
    assert.equal(shown.classification, 'appears_applied', JSON.stringify(shown));
    assert.equal(f.sent.length, 1, 'the lost create was the only write');
  } finally {
    f.close();
  }
});

test('a replacement TikTok refuses in an HTTP 200 answer is rejected and lifts the supersede: the old review reads indeterminate, and the worker’s check reads the provider and finds the late object', async () => {
  const f = tiktokReconcileFixture({tenant: 'rejected-replacement'});
  try {
    // The create is lost and TikTok made nothing; the check says so and offers the replacement, which the person prepares.
    const lost = await f.lose('campaign', {applied: false});
    assertRefused(lost.refused, 'WRITE_OUTCOME_UNCERTAIN');
    const old = lost.id,
      found = await reconcile(f, old);
    assert.equal(found.data.classification, 'appears_not_applied', JSON.stringify(found.data));
    f.store.db.prepare("DELETE FROM jobs WHERE kind='write_reconcile'").run();
    const replacement = await f.call('amcp_write', found.data.next_call.arguments);
    assert.equal(replacement.success, true, JSON.stringify(replacement).slice(0, 500));
    const next = replacement.data.review_id;
    // The first create was applied after all, late, and TikTok refuses the replacement's name in the body of an HTTP 200 answer.
    f.rows.campaign.push(lateCampaign(f));
    f.state.refusal = nameRefusal;
    const refused = await f.execute(next);
    f.state.refusal = undefined;
    assertRefused(refused, 'PLATFORM_ERROR');
    assert.equal(refused.error.details.submission, 'rejected', JSON.stringify(refused.error.details).slice(0, 400));
    assert.equal(f.claim(next).state, 'rejected');
    assert.equal(f.sent.length, 2, 'the lost create and the refused replacement, each sent once');

    // The rejected replacement is final (nothing is queued for it) and it no longer seals the old review: the old review's own check is
    // queued, and the record it is left with does not settle anything, so a replacement is not offered on it again.
    assert.deepEqual(queuedFor(f), [old], 'only the old review is checked again');
    const lifts = f.store
      .audit(f.actor.tenantId, 10000)
      .map(row => JSON.parse(row.event))
      .filter(event => event.event === 'write_supersede_lifted');
    assert.equal(lifts.length, 1, 'the lift is audited');
    assert.equal(lifts[0].review_id, old);
    assert.equal(lifts[0].replacement_id, next);
    assert.equal(lifts[0].reason, 'rejected');
    const after = (await status(f, old)).data;
    assert.equal(after.reconciliation.classification, 'indeterminate', JSON.stringify(after.reconciliation));
    assert.equal(after.reconciliation.reason, 'replacement_rejected');
    assert.equal(after.reconciliation.superseded_by, undefined);
    assertRefused(await reconcile(f, next), 'RECONCILIATION_UNAVAILABLE');

    // The worker's check reads the provider (it used to find a fresh not-applied record and read nothing), finds the late object, and the
    // person is offered the accept, not the replacement the provider just refused.
    const requests = f.requests.length;
    assert.equal(await runDue(f), true, 'the worker leased the old review’s check');
    assert.ok(f.requests.length > requests, 'the check read the provider');
    assert.ok(
      f.requests.slice(requests).every(r => r.startsWith('GET ')),
      'by reads only: ' + f.requests.slice(requests).join(', '),
    );
    const shown = await status(f, old);
    assert.equal(shown.data.state, 'uncertain');
    assert.equal(shown.data.reconciliation.automatic, true, 'the worker’s answer is the record now');
    assert.equal(
      shown.data.reconciliation.classification,
      'appears_applied',
      JSON.stringify(shown.data.reconciliation),
    );
    assert.deepEqual(shown.data.reconciliation.observed_ids, ['77']);
    assert.equal(shown.data.next_call.arguments.accept_applied, undefined);
    assert.deepEqual(shown.data.next_call.add_after_user_approval, {accept_applied: true});
    const accepted = await f.call('amcp_write', {
      action: 'reconcile',
      review_id: old,
      accept_applied: true,
      reconciliation_id: shown.data.reconciliation.reconciliation_id,
    });
    assert.equal(accepted.success, true, JSON.stringify(accepted).slice(0, 500));
    assert.equal(f.claim(old).state, 'complete');
    assert.equal(f.sent.length, 2, 'the check and the accept sent nothing');
    // Join 2: AMCP sends no request_id of its own on a TikTok create (the refusal package's S1-1), and nothing of the reconcile path (the
    // lost create, its replacement, the lookups the check made) sends or asks for one: a key per review would switch off TikTok's own
    // same-name refusal, which is the evidence that a replacement was refused for a reason.
    assert.deepEqual(
      f.sent.filter(s => Object.hasOwn(s.body, 'request_id')),
      [],
      'no write carries a request_id',
    );
    assert.equal(JSON.stringify(f.filters).includes('request_id'), false, 'no lookup asks for or filters by one');
  } finally {
    f.close();
  }
});

test('a rejected replacement does not make the old review replaceable on its stale not-applied answer: a new replacement waits for a fresh check', async () => {
  const f = tiktokReconcileFixture({tenant: 'rejected-replacement-stale'});
  try {
    const lost = await f.lose('campaign', {applied: false});
    const old = lost.id,
      found = await reconcile(f, old);
    assert.equal(found.data.classification, 'appears_not_applied');
    const replacement = await f.call('amcp_write', found.data.next_call.arguments);
    f.state.refusal = nameRefusal;
    assert.equal((await f.execute(replacement.data.review_id)).error.details.submission, 'rejected');
    f.state.refusal = undefined;
    // The replacement TikTok refused is the evidence the old create may have been applied: no second replacement on the old answer.
    const again = await f.call('amcp_write', found.data.next_call.arguments);
    assertRefused(again, 'RECOVERY_NOT_SAFE');
    // A fresh check that finds nothing makes the replacement possible again.
    const fresh = await reconcile(f, old);
    assert.equal(fresh.data.classification, 'appears_not_applied', JSON.stringify(fresh.data));
    const second = await f.call('amcp_write', fresh.data.next_call.arguments);
    assert.equal(second.success, true, JSON.stringify(second).slice(0, 500));
    assert.equal((await f.execute(second.data.review_id)).success, true);
    assert.equal(
      f.sent.length,
      3,
      'the lost create, the refused replacement and the second replacement, each sent once',
    );
  } finally {
    f.close();
  }
});

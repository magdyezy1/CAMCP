import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {at, googleReconcileFixture} from './helpers/google-reconcile-fixture.mjs';
import {tiktokReconcileFixture} from './helpers/tiktok-reconcile-fixture.mjs';

/**
 * R2.5 M2, lead re-review N1 (probes P1a, P1b, P1c) and N5: the rule that leaves out the objects another review made left out any ID
 * that any finished write's answer mentioned. A lost create that WAS applied, and an AMCP status or budget update of that object that
 * then completed (the ordinary path: the agent reads the provider, finds the object and acts on it), made every later check say
 * "appears not applied" and offer the replacement, which duplicated the ad. The exclusion is now narrow: only an object that another
 * create of the same kind made (a completed claim or an accepted reconciliation whose review creates objects, of the same gateway and
 * path), read at the paths where this lookup's own receipt puts an ID, and without a cut by count or by age.
 */
before(() => {
  process.env.AMCP_WRITE_RECONCILE_DELAY_MS = '0';
  process.env.AMCP_WRITE_RECONCILE_ROUND_MS = '0';
});
after(() => {
  delete process.env.AMCP_WRITE_RECONCILE_DELAY_MS;
  delete process.env.AMCP_WRITE_RECONCILE_ROUND_MS;
});

const budgetAction = 'google_ads_v23_campaign_budget_mutate_campaign_budgets';
/** A completed write of the workspace whose answer names `data`, as Store.complete keeps an outcome. */
const completedOther = (f, key, action, data) => {
  f.store.claim(f.actor.tenantId, key, 'synthetic-fingerprint-' + key);
  f.store.complete(f.actor.tenantId, key, {success: true, executed: true, outcome: 'succeeded', action, data});
};
const reconcile = (f, id) => f.call('amcp_write', {action: 'reconcile', review_id: id});

test('P1a: a status update of the campaign a lost create made does not make that create absent', async () => {
  const f = tiktokReconcileFixture();
  try {
    const {id} = await f.lose('campaign', {applied: true});
    const [made] = f.rows.campaign.filter(r => r.campaign_name === 'Synthetic campaign').map(r => r.campaign_id);
    const before = await reconcile(f, id);
    assert.equal(before.data.classification, 'appears_applied', JSON.stringify(before.data));
    // TikTok's reply to a status update lists the IDs it changed.
    completedOther(f, 'status-update-of-' + made, 'tiktok_campaign_status_update', {
      code: 0,
      message: 'OK',
      data: {campaign_ids: [made]},
    });
    const after = await reconcile(f, id);
    assert.equal(after.data.classification, 'appears_applied', JSON.stringify(after.data));
    assert.deepEqual(after.data.observed_ids, [made]);
    assert.equal(after.data.next_call.add_after_user_approval?.accept_applied, true, 'the accept is what is offered');
  } finally {
    f.close();
  }
});

test('P1b: the worker’s check of a lost ad that an update then named offers the accept, never a second ad', async () => {
  const f = tiktokReconcileFixture();
  try {
    const {id} = await f.lose('ad', {applied: true});
    const [made] = f.rows.ad.map(r => r.ad_id);
    completedOther(f, 'status-update-of-ad-' + made, 'tiktok_ad_status_update', {
      code: 0,
      message: 'OK',
      data: {ad_ids: [made]},
    });
    f.store.db.prepare("UPDATE jobs SET available_at=0 WHERE kind='write_reconcile' AND state='queued'").run();
    assert.equal(await f.worker.once(), true);
    const status = await f.call('amcp_write', {action: 'status', review_id: id});
    assert.equal(
      status.data.reconciliation.classification,
      'appears_applied',
      JSON.stringify(status.data.reconciliation),
    );
    assert.deepEqual(status.data.reconciliation.observed_ids, [made]);
    assert.equal(status.data.next_call.arguments.supersedes_review_id, undefined, 'no replacement is offered');
    assert.equal(f.rows.ad.filter(a => a.ad_name === 'Synthetic ad').length, 1);
  } finally {
    f.close();
  }
});

test('P1c: an update of the budget a lost create made, completed through AMCP, leaves that create applied', async () => {
  const f = googleReconcileFixture();
  try {
    const create = {name: 'Spring budget', amount_micros: '5000000', delivery_method: 'STANDARD'};
    const {id} = await f.lose(budgetAction, {operations: [{create}]}, {applied: true});
    const [made] = f.db.campaign_budget.filter(r => r.name === 'Spring budget').map(r => r.resource_name);
    const before = await reconcile(f, id);
    assert.equal(before.data.classification, 'appears_applied', JSON.stringify(before.data));
    // The agent found the budget and changed it: Google's reply to that update names the very resource the create made.
    const update = await f.prepare(budgetAction, {
      operations: [{update: {resource_name: made, explicitly_shared: true}, update_mask: 'explicitly_shared'}],
    });
    assert.equal(update.success, true, JSON.stringify(update).slice(0, 500));
    const done = await f.execute(update.data.review_id);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 500));
    const after = await reconcile(f, id);
    assert.equal(after.data.classification, 'appears_applied', JSON.stringify(after.data));
    assert.deepEqual(after.data.observed_ids, [made]);
  } finally {
    f.close();
  }
});

test('an update that changes a field the create froze leaves the object a doubt, shown and never called absent', async () => {
  const f = googleReconcileFixture();
  try {
    const create = {name: 'Spring budget', amount_micros: '5000000', delivery_method: 'STANDARD'};
    const {id} = await f.lose(budgetAction, {operations: [{create}]}, {applied: true});
    const [made] = f.db.campaign_budget.filter(r => r.name === 'Spring budget').map(r => r.resource_name);
    const update = await f.prepare(budgetAction, {
      operations: [{update: {resource_name: made, amount_micros: '6000000'}, update_mask: 'amount_micros'}],
    });
    assert.equal((await f.execute(update.data.review_id)).success, true);
    const r = await reconcile(f, id);
    assert.equal(r.data.classification, 'indeterminate', JSON.stringify(r.data));
    assert.deepEqual(r.data.undated, [{id: made}]);
    assert.equal(r.data.next_call.arguments.supersedes_review_id, undefined, 'no replacement is offered');
  } finally {
    f.close();
  }
});
test('a child create whose answer echoes the parent leaves the parent the lost create made found', async () => {
  const f = tiktokReconcileFixture();
  try {
    const {id} = await f.lose('campaign', {applied: true});
    const [made] = f.rows.campaign.filter(r => r.campaign_name === 'Synthetic campaign').map(r => r.campaign_id);
    // The agent lists the account's campaigns, finds it, and creates an ad group under it; TikTok's answer names the parent too.
    f.store.rememberResource(f.connection, f.world.id, made);
    f.state.echoParent = true;
    const group = await f.prepare('adgroup', p => ({...p, campaign_id: made}));
    assert.equal(group.success, true, JSON.stringify(group).slice(0, 500));
    const done = await f.execute(group.data.review_id);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 500));
    assert.ok(JSON.stringify(done).includes('\"campaign_id\":\"' + made + '\"'), 'the child’s answer names the parent');
    const r = await reconcile(f, id);
    assert.equal(r.data.classification, 'appears_applied', JSON.stringify(r.data));
    assert.deepEqual(r.data.observed_ids, [made]);
  } finally {
    f.close();
  }
});

test('N5: another create’s object that agrees in every echoed field is not the lost create’s, so the lost one appears not applied', async () => {
  const f = tiktokReconcileFixture();
  try {
    // A is an identical create that completed a moment ago; B is prepared after it (with the duplicate warning), sent, and lost
    // without being applied. A's campaign is in B's window, has B's name and agrees in every field TikTok echoes.
    const a = await f.prepare('campaign');
    assert.equal((await f.execute(a.data.review_id)).success, true);
    const [others] = f.rows.campaign.filter(r => r.campaign_name === 'Synthetic campaign').map(r => r.campaign_id);
    const {id} = await f.lose('campaign', {applied: false});
    const r = await reconcile(f, id);
    assert.equal(r.data.classification, 'appears_not_applied', JSON.stringify(r.data));
    assert.equal(r.data.observed_ids, undefined);
    assert.equal(r.data.found?.length, 0, 'A’s campaign ' + others + ' is not found for B');
  } finally {
    f.close();
  }
});

test('the other create is found whatever the number of writes since: no read is cut at 200 claims', async () => {
  const f = tiktokReconcileFixture();
  try {
    const a = await f.prepare('campaign');
    assert.equal((await f.execute(a.data.review_id)).success, true);
    // Two hundred and fifty writes of the workspace complete after it.
    for (let i = 0; i < 250; i++)
      completedOther(f, 'noise-' + i, 'tiktok_campaign_status_update', {code: 0, data: {campaign_ids: ['9' + i]}});
    f.store.db.prepare("UPDATE idempotency SET created_at=created_at+1000 WHERE key LIKE 'noise-%'").run();
    const {id} = await f.lose('campaign', {applied: false});
    const r = await reconcile(f, id);
    assert.equal(r.data.classification, 'appears_not_applied', JSON.stringify(r.data));
  } finally {
    f.close();
  }
});

test('a Google create that completed long before is still the other’s: no look-back of a few minutes', async () => {
  const f = googleReconcileFixture();
  try {
    const create = {name: 'Spring budget', amount_micros: '5000000', delivery_method: 'STANDARD'};
    // B is prepared first; A (a different request, so the guard lets it through) then completes and makes the budget B's lookup would
    // find. Ten minutes pass before B is sent, lost and not applied.
    const b = await f.prepare(budgetAction, {operations: [{create}]});
    assert.equal(b.success, true, JSON.stringify(b).slice(0, 500));
    const a = await f.prepare(budgetAction, {operations: [{create: {...create, explicitly_shared: true}}]});
    assert.equal(a.success, true, JSON.stringify(a).slice(0, 500));
    assert.equal((await f.execute(a.data.review_id)).success, true);
    f.store.db
      .prepare('UPDATE idempotency SET created_at=created_at-? WHERE tenant_id=? AND key=?')
      .run(10 * 60000, f.actor.tenantId, a.data.review_id);
    f.state.applied = false;
    f.state.lose = true;
    const refused = await f.execute(b.data.review_id);
    f.state.lose = false;
    f.state.applied = undefined;
    assert.equal(refused.error.code, 'WRITE_OUTCOME_UNCERTAIN', JSON.stringify(refused).slice(0, 400));
    const r = await reconcile(f, b.data.review_id);
    assert.equal(r.data.classification, 'appears_not_applied', JSON.stringify(r.data));
    assert.equal(at('campaignBudgets', '500') !== undefined, true);
  } finally {
    f.close();
  }
});

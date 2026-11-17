import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {budgetName, googleBudgetFixture} from './fixtures/google-budget-writes.mjs';

/**
 * R2.5 M2, lead re-review N10: the refusal of a create that is identical to a COLLEAGUE'S unresolved one said "ask them, or the workspace
 * owner, to settle it". But only the person who prepared an uncertain write replaces it; the workspace owner can accept one that was applied,
 * and cannot replace it. The message now says exactly that, so a member does not go to the owner for a replacement the owner cannot make.
 * No permission is widened: the owner still cannot replace a colleague's write, and still can accept an applied one.
 */
before(() => {
  process.env.AMCP_WRITE_RECONCILE_DELAY_MS = '0';
  process.env.AMCP_WRITE_RECONCILE_ROUND_MS = '0';
});
after(() => {
  delete process.env.AMCP_WRITE_RECONCILE_DELAY_MS;
  delete process.env.AMCP_WRITE_RECONCILE_ROUND_MS;
});

const prepare = (f, who, extra = {}) =>
  f.call(
    'amcp_write',
    {
      action: 'prepare',
      gateway: 'google_ads_native_action',
      connection_id: 'g',
      arguments: {
        action: 'google_ads_v23_campaign_budget_mutate_campaign_budgets',
        account_id: '123',
        payload: {operations: [{create: {name: 'Synthetic 0', amountMicros: '5000000', deliveryMethod: 'STANDARD'}}]},
      },
      ...extra,
    },
    who,
  );
/** The operator's create, whose answer is lost; `applied`: Google made the budget first. */
async function uncertain(f, applied) {
  const review = await prepare(f, f.actor);
  assert.equal(review.success, true, JSON.stringify(review).slice(0, 400));
  f.hooks.respond = body => {
    if (applied) {
      f.budgets.set(budgetName(101), String(body.operations[0].create.amountMicros));
      f.names.set(budgetName(101), body.operations[0].create.name);
    }
    throw new TypeError('synthetic lost response');
  };
  const lost = await f.execute(review.data.review_id);
  f.hooks.respond = undefined;
  assert.equal(lost.error?.code, 'WRITE_OUTCOME_UNCERTAIN');
  return review.data.review_id;
}

test('a colleague’s unresolved identical create is refused with the truth about who can settle it', async () => {
  const f = googleBudgetFixture({role: 'operator'});
  try {
    const id = await uncertain(f, false);
    const member = {tenantId: f.actor.tenantId, userId: 'member', role: 'operator'};
    const refused = await prepare(f, member);
    assert.equal(refused.error?.code, 'DUPLICATE_OF_UNCERTAIN_WRITE', JSON.stringify(refused).slice(0, 600));
    assert.equal(refused.error.details.readable, false, 'a colleague’s review is still not named');
    assert.ok(!JSON.stringify(refused).includes(id));
    const message = refused.error.message;
    assert.match(message, /only the person who prepared it can replace it/i, message);
    assert.match(message, /workspace owner can accept it/i, message);
    assert.doesNotMatch(message, /ask them, or the workspace owner, to settle it/, 'the owner cannot replace it');
    assert.match(message, /change the request/i, 'a way out for a write nobody can settle');
  } finally {
    f.close();
  }
});

test('no permission is widened: the workspace owner cannot replace a colleague’s write, and can still accept an applied one', async () => {
  const f = googleBudgetFixture({role: 'operator'});
  try {
    const id = await uncertain(f, true);
    const owner = {tenantId: f.actor.tenantId, userId: 'administrator', role: 'admin'};
    // The owner reconciles (an administrator may), finds it applied, and accepts it: the owner may accept.
    const found = await f.call('amcp_write', {action: 'reconcile', review_id: id}, owner);
    assert.equal(found.data.classification, 'appears_applied', JSON.stringify(found).slice(0, 500));
    // A replacement is the preparer's: the owner's prepare naming it is refused, whatever was reconciled.
    const replaced = await prepare(f, owner, {supersedes_review_id: id});
    assert.equal(replaced.error?.code, 'FORBIDDEN', JSON.stringify(replaced).slice(0, 500));
    const accepted = await f.call(
      'amcp_write',
      {action: 'reconcile', review_id: id, accept_applied: true, reconciliation_id: found.data.reconciliation_id},
      owner,
    );
    assert.equal(accepted.success, true, JSON.stringify(accepted).slice(0, 500));
    assert.equal(f.claim(id).state, 'complete');
  } finally {
    f.close();
  }
});

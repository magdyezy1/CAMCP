// Package r25-m3-live, F1 (live evidence of the lead, 2026-11-20): Google names a budget created with explicitly_shared: false after the
// campaign that uses it. Every Google guided recipe creates exactly such a budget ("<name> budget") in the one build it compiles to, so the
// budget read back under the campaign's name, and a standard google_search run (create_from_recipe, approve, run) ended in "attention" with
// VERIFICATION_MISMATCH on /name of its budget, with every other resource verified. These tests run each Google recipe through the real
// campaign runner against a synthetic Google that answers as Google does (the two fixtures' `unsharedBudgetNamedAfterCampaign`).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {campaignRecipes} from '../dist/src/campaign-recipes.js';
import {googleSearchFixture} from './fixtures/google-search-recipe-data.mjs';
import {pmaxCustomer} from './fixtures/google-pmax-data.mjs';

const examples = JSON.parse(readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'));
const {cpc_bid, ...shared} = examples.recipe_business;
/** The brief of each Google guided recipe that creates a non-shared budget (every one of them), as its own tests write it. */
const search = {
  google_search: {...shared, cpc_bid},
  google_search_clicks: {...shared, cpc_bid_ceiling: '1.37'},
  google_search_conversions: {...shared, conversion_goal_policy: 'ACCOUNT_DEFAULT'},
  google_search_target_cpa: {...shared, conversion_goal_policy: 'ACCOUNT_DEFAULT', target_cpa: '15.250001'},
  google_search_conversion_value: {
    ...shared,
    conversion_goal_policy: 'ACCOUNT_DEFAULT',
    conversion_value_policy: 'ACCOUNT_RECORDED_VALUES',
  },
  google_search_target_roas: {
    ...shared,
    conversion_goal_policy: 'ACCOUNT_DEFAULT',
    conversion_value_policy: 'ACCOUNT_RECORDED_VALUES',
    target_roas: '3.5',
  },
};
const pmax = {...examples.google_pmax_business, connection_id: 'g'};

/** create_from_recipe, approve (preview, then with its hashes) and run, as an agent does; one re-approval for the spend flag at most. */
async function runRecipe(call, recipe, business) {
  const created = await call({action: 'create_from_recipe', recipe, business});
  assert.equal(created.success, true, recipe + ': ' + JSON.stringify(created).slice(0, 1500));
  const id = created.data.id,
    preview = await call({action: 'approve', id});
  assert.equal(preview.success, true, recipe + ': ' + JSON.stringify(preview).slice(0, 1500));
  const approved = await call({
    action: 'approve',
    id,
    confirmed: true,
    plan_hash: preview.data.plan_hash,
    summary_hash: preview.data.summary_hash,
  });
  assert.equal(approved.success, true, recipe + ': ' + JSON.stringify(approved).slice(0, 1500));
  let result = await call({action: 'run', id});
  for (let n = 0; n < 2 && result.success && result.data.run?.stopped === 'needs_spend_change_confirmed'; n++) {
    const again = await call({...result.data.next_call.arguments, confirmed: true, spend_change_confirmed: true});
    assert.equal(again.success, true, recipe + ': ' + JSON.stringify(again).slice(0, 1500));
    result = await call({action: 'run', id});
  }
  assert.equal(result.success, true, recipe + ': ' + JSON.stringify(result).slice(0, 1500));
  return {id, run: (await call({action: 'get', id, detail: 'full'})).data};
}
/** A failure message that says what the run ended in and which checks of each step were not verified, with the fields they differ in. */
const outcome = run =>
  JSON.stringify([
    run.state,
    ...run.steps.map(s => ({
      id: s.id,
      status: s.status,
      error: s.error,
      notVerified: (s.verification?.checks ?? [])
        .filter(c => c.status !== 'verified')
        .map(c => [c.resource_id, c.status, c.code, c.changed_fields]),
    })),
  ]).slice(0, 1500);

/** What the run shows of the budget: one check of the one build step, the one that reads the budget back. */
function budgetCheck(run) {
  const checks = run.steps.flatMap(s => s.verification?.checks ?? []);
  return checks.find(c => /\/campaignBudgets\//.test(String(c.resource_id)));
}

test('the standard google_search recipe ends complete with a verified step when Google names its non-shared budget after its campaign, and needs no accept_observed', async t => {
  const business = search.google_search,
    f = googleSearchFixture(t, business, {native: true, unsharedBudgetNamedAfterCampaign: true});
  const {run} = await runRecipe(input => f.call(input), 'google_search', business);
  assert.equal(run.state, 'complete', outcome(run));
  assert.deepEqual(
    run.steps.map(s => [s.id, s.status]),
    [['build', 'verified']],
  );
  assert.equal(f.mutations.length, 1, 'one request created everything');
  // Google really did rename it: the budget was sent as "<name> budget" and the campaign is "<name>", which is what the read-back answers.
  const [budget, campaign] = ['campaignBudget', 'campaign'].map(
    kind => [...f.resources.values()].find(r => r.kind === kind).value,
  );
  assert.equal(budget.name, business.name + ' budget');
  assert.equal(campaign.name, business.name);
  assert.ok(
    f.requests.some(r => / FROM campaign_budget /.test(r.body.query ?? '')),
    'the budget was read back',
  );
  // The check of the budget compares every field but its name, and every check of the build is verified.
  const check = budgetCheck(run);
  assert.equal(check?.status, 'verified', JSON.stringify(check));
  assert.deepEqual(check.changed_fields, []);
  assert.ok(!check.checked_fields.includes('name'), 'the name Google gives a non-shared budget is not compared');
  for (const field of ['amount_micros', 'delivery_method', 'explicitly_shared'])
    assert.ok(check.checked_fields.includes(field), field + ' is still compared');
  assert.ok(run.steps.every(s => s.verification.checks.every(c => c.status === 'verified')));
});

test('every Google guided recipe that creates a non-shared budget takes the same path and ends complete, verified, under Google’s naming', async t => {
  const ids = campaignRecipes.filter(r => r.platform === 'google').map(r => r.id);
  assert.deepEqual(
    ids.sort(),
    [...Object.keys(search), 'google_performance_max'].sort(),
    'no Google recipe is left out',
  );
  for (const [recipe, business] of Object.entries(search)) {
    const f = googleSearchFixture(t, business, {native: true, unsharedBudgetNamedAfterCampaign: true});
    const {run} = await runRecipe(input => f.call(input), recipe, business);
    assert.equal(run.state, 'complete', recipe + ': ' + outcome(run));
    assert.deepEqual(
      run.steps.map(s => [s.id, s.status]),
      [['build', 'verified']],
      recipe,
    );
    assert.equal(f.mutations.length, 1, recipe);
    assert.equal(budgetCheck(run)?.status, 'verified', recipe);
    assert.ok(!budgetCheck(run).checked_fields.includes('name'), recipe);
  }
  const x = pmaxCustomer({unsharedBudgetNamedAfterCampaign: true});
  t.after(() => x.store.close());
  const {run} = await runRecipe(input => x.call('amcp_campaign', input), 'google_performance_max', pmax);
  assert.equal(run.state, 'complete', 'google_performance_max: ' + outcome(run));
  assert.deepEqual(
    run.steps.map(s => [s.id, s.status]),
    [['build', 'verified']],
  );
  assert.equal(x.mutates.length, 1);
  assert.equal(budgetCheck(run)?.status, 'verified');
  assert.ok(!budgetCheck(run).checked_fields.includes('name'));
});

test('the same recipes end complete and verified when nothing renames the budget (the fixtures do not change what they did)', async t => {
  const f = googleSearchFixture(t, search.google_search, {native: true});
  const {run} = await runRecipe(input => f.call(input), 'google_search', search.google_search);
  assert.equal(run.state, 'complete', outcome(run));
  const x = pmaxCustomer();
  t.after(() => x.store.close());
  assert.equal(
    (await runRecipe(input => x.call('amcp_campaign', input), 'google_performance_max', pmax)).run.state,
    'complete',
  );
});

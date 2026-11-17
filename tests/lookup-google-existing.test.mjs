import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Compiler} from '../dist/src/compiler.js';
import {applyExecutionRisk} from '../dist/src/execution-risk.js';
import {findCreated} from '../dist/src/write-reconciliation.js';
import {at, gateway as googleGateway, googleReconcileFixture} from './helpers/google-reconcile-fixture.mjs';

/**
 * R2.5 M2, lead re-review N3 (probe P6): a Google create whose name was already taken read as applied, with the older object. Google refuses a
 * duplicate name for every kind its lookup covers, and its objects carry no creation time, so an older object of the name is exactly why such
 * a create fails: nothing is made, the answer is lost, and the lookup found the older object by name and parent and offered the accept. The review
 * now freezes at prepare the live objects of the frozen names under the frozen parents (one search per kind, as Meta's sets and feeds freeze their
 * catalog), and only an object that is not among them can be this write's. Where that list could not be read whole, nothing can be told from an
 * older object, so every match is a doubt.
 */
before(() => {
  process.env.AMCP_WRITE_RECONCILE_DELAY_MS = '0';
  process.env.AMCP_WRITE_RECONCILE_ROUND_MS = '0';
});
after(() => {
  delete process.env.AMCP_WRITE_RECONCILE_DELAY_MS;
  delete process.env.AMCP_WRITE_RECONCILE_ROUND_MS;
});

const adGroupAction = 'google_ads_v23_ad_group_mutate_ad_groups',
  budgetAction = 'google_ads_v23_campaign_budget_mutate_campaign_budgets';
const adGroupCreate = {name: 'Ad group 1', campaign: at('campaigns', '100'), status: 'PAUSED', type: 'SEARCH_STANDARD'};
const reconcile = (f, id) => f.call('amcp_write', {action: 'reconcile', review_id: id});
/** The account of probe P6: campaign 100 holds "Ad group 1", made last week. */
function withOlderAdGroup() {
  const f = googleReconcileFixture();
  f.row('campaign_budget', {resource_name: at('campaignBudgets', '10'), name: 'Existing budget', status: 'ENABLED'});
  f.row('campaign', {
    resource_name: at('campaigns', '100'),
    name: 'Mine',
    status: 'PAUSED',
    advertising_channel_type: 'SEARCH',
    campaign_budget: at('campaignBudgets', '10'),
  });
  f.row('ad_group', {
    resource_name: at('adGroups', '7000'),
    name: 'Ad group 1',
    status: 'PAUSED',
    type: 'SEARCH_STANDARD',
    campaign: at('campaigns', '100'),
  });
  return f;
}

test('P6: a create of a name that is already taken, refused by Google and lost, is not applied, and the older object is not its', async () => {
  const f = withOlderAdGroup();
  try {
    const {id} = await f.lose(adGroupAction, {operations: [{create: adGroupCreate}]}, {applied: false});
    const r = await reconcile(f, id);
    assert.equal(r.data.classification, 'appears_not_applied', JSON.stringify(r.data));
    assert.equal(r.data.reason, 'not_found');
    assert.equal(r.data.observed_ids, undefined, 'nothing is offered for acceptance');
    assert.notEqual(r.data.next_call.add_after_user_approval?.accept_applied, true);
  } finally {
    f.close();
  }
});

test('the review froze what existed at prepare: the older object, whole, and nothing of another parent', async () => {
  const f = withOlderAdGroup();
  try {
    f.row('ad_group', {
      resource_name: at('adGroups', '7001'),
      name: 'Ad group 1',
      status: 'PAUSED',
      type: 'SEARCH_STANDARD',
      campaign: at('campaigns', '999'),
    });
    const prepared = await f.prepare(adGroupAction, {operations: [{create: adGroupCreate}]});
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 400));
    const review = f.store.document(f.actor.tenantId, 'write_review', prepared.data.review_id);
    assert.deepEqual(review.existing, {ids: [at('adGroups', '7000')], whole: true});
  } finally {
    f.close();
  }
});

test('an object made after the prepare is this write’s, beside the older one of the same name', async () => {
  const f = withOlderAdGroup();
  try {
    // Google would refuse the name; the synthetic provider keeps both, which is what a lost create that was applied looks like.
    const {id} = await f.lose(adGroupAction, {operations: [{create: adGroupCreate}]}, {applied: true});
    const made = f.db.ad_group.filter(r => r.resource_name !== at('adGroups', '7000')).map(r => r.resource_name);
    assert.equal(made.length, 1);
    const r = await reconcile(f, id);
    assert.equal(r.data.classification, 'appears_applied', JSON.stringify(r.data));
    assert.deepEqual(r.data.observed_ids, made, 'the new object only, never the older one');
  } finally {
    f.close();
  }
});

const buildAction = 'google_ads_v23_google_ads_mutate';
/** A build: an ad group named "Ad group 1" under campaign 100, with one keyword. */
const adGroupBuild = {
  mutate_operations: [
    {
      ad_group_operation: {
        create: {
          resource_name: at('adGroups', '-3'),
          name: 'Ad group 1',
          campaign: at('campaigns', '100'),
          status: 'PAUSED',
          type: 'SEARCH_STANDARD',
          cpc_bid_micros: '1500000',
        },
      },
    },
    {
      ad_group_criterion_operation: {
        create: {ad_group: at('adGroups', '-3'), keyword: {text: 'acme', match_type: 'EXACT'}, status: 'ENABLED'},
      },
    },
  ],
};

test('a build whose ad group name is already taken under the campaign is not applied, and the older ad group is not its', async () => {
  const f = withOlderAdGroup();
  try {
    const {id} = await f.lose(buildAction, adGroupBuild, {applied: false});
    const r = await reconcile(f, id);
    assert.equal(r.data.classification, 'appears_not_applied', JSON.stringify(r.data));
    assert.equal(r.data.observed_ids, undefined);
  } finally {
    f.close();
  }
});

test('a build applied beside an older ad group of its name finds the ad group it made, not the older one', async () => {
  const f = withOlderAdGroup();
  try {
    // Google would refuse the name; the synthetic provider keeps both, which is what a lost build that was applied looks like.
    const {id} = await f.lose(buildAction, adGroupBuild, {applied: true});
    const made = f.db.ad_group.filter(r => r.resource_name !== at('adGroups', '7000')).map(r => r.resource_name);
    assert.equal(made.length, 1);
    const r = await reconcile(f, id);
    assert.equal(r.data.classification, 'appears_applied', JSON.stringify(r.data));
    assert.deepEqual(r.data.observed_ids, made, 'the new ad group only, never the older one');
  } finally {
    f.close();
  }
});

test('a build whose list could not be frozen whole shows what it finds as a doubt, never applied', async () => {
  // No older ad group: the one object under the campaign is the build’s own, but nothing can say so once the list is unknown.
  const f = googleReconcileFixture();
  try {
    f.row('campaign_budget', {resource_name: at('campaignBudgets', '10'), name: 'Existing budget', status: 'ENABLED'});
    f.row('campaign', {
      resource_name: at('campaigns', '100'),
      name: 'Mine',
      status: 'PAUSED',
      advertising_channel_type: 'SEARCH',
      campaign_budget: at('campaignBudgets', '10'),
    });
    f.state.refuse = /FROM ad_group/;
    const prepared = await f.prepare(buildAction, adGroupBuild);
    f.state.refuse = undefined;
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 400));
    const review = f.store.document(f.actor.tenantId, 'write_review', prepared.data.review_id);
    assert.deepEqual(review.existing, {ids: [], whole: false});
    f.state.applied = true;
    f.state.lose = true;
    const lost = await f.execute(prepared.data.review_id);
    f.state.lose = false;
    f.state.applied = undefined;
    assert.equal(lost.error.code, 'WRITE_OUTCOME_UNCERTAIN', JSON.stringify(lost).slice(0, 300));
    const made = f.db.ad_group.map(r => r.resource_name);
    assert.equal(made.length, 1, 'the build made its ad group');
    const r = await reconcile(f, prepared.data.review_id);
    assert.equal(r.data.classification, 'indeterminate', JSON.stringify(r.data));
    assert.equal(r.data.reason, 'undated_match');
    assert.deepEqual(
      r.data.undated.map(u => u.id),
      made,
      'the ad group is shown, as a doubt',
    );
    assert.equal(r.data.observed_ids, undefined, 'nothing is offered for acceptance');
  } finally {
    f.close();
  }
});

test('a list that could not be frozen whole leaves every match a doubt: nothing is told from an older object, so nothing is applied or absent', async () => {
  const f = withOlderAdGroup();
  try {
    // The provider cannot answer the search of what already exists when the review is prepared.
    f.state.refuse = /FROM ad_group/;
    const prepared = await f.prepare(adGroupAction, {operations: [{create: adGroupCreate}]});
    f.state.refuse = undefined;
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 400));
    const review = f.store.document(f.actor.tenantId, 'write_review', prepared.data.review_id);
    assert.deepEqual(review.existing, {ids: [], whole: false});
    f.state.applied = true;
    f.state.lose = true;
    const lost = await f.execute(prepared.data.review_id);
    f.state.lose = false;
    f.state.applied = undefined;
    assert.equal(lost.error.code, 'WRITE_OUTCOME_UNCERTAIN', JSON.stringify(lost).slice(0, 300));
    const r = await reconcile(f, prepared.data.review_id);
    assert.equal(r.data.classification, 'indeterminate', JSON.stringify(r.data));
    assert.equal(r.data.reason, 'undated_match');
    assert.equal(r.data.undated.length, 2, 'the older object and the new one are both shown');
    assert.equal(r.data.observed_ids, undefined);
  } finally {
    f.close();
  }
});

// ----- the lookup, on its own -----
const compiler = new Compiler(new Registry()),
  options = {mode: 'strict', flags: {}};
const plan = applyExecutionRisk(
  compiler.compile(
    googleGateway,
    {
      action: budgetAction,
      account_id: '123',
      payload: {operations: [{create: {name: 'Spring budget', amountMicros: '5000000', deliveryMethod: 'STANDARD'}}]},
      dry_run: true,
    },
    options,
  ),
);
const claimed = Date.parse('2026-10-10T10:00:00Z');
const answer = rows => [{status: 200, headers: {}, data: {results: rows}}];
const row = n => ({
  campaignBudget: {
    resourceName: at('campaignBudgets', n),
    name: 'Spring budget',
    amountMicros: '5000000',
    deliveryMethod: 'STANDARD',
  },
});

test('the lookup reports what it sees before the write, and leaves out what the review saw', () => {
  const lookup = findCreated(plan, {state: [], claimedAt: claimed});
  assert.equal(typeof lookup.existing, 'function', 'a Google create freezes what exists');
  assert.deepEqual(lookup.existing(answer([row('1'), row('2')])), {
    ids: [at('campaignBudgets', '1'), at('campaignBudgets', '2')],
    whole: true,
  });
  assert.equal(
    lookup.existing(answer(Array.from({length: 100}, (_, i) => row(String(i))))).whole,
    false,
    'a search cut at its limit',
  );
  const frozen = {ids: [at('campaignBudgets', '1')], whole: true},
    context = {state: [], claimedAt: claimed, existing: frozen};
  const kept = findCreated(plan, context).match(answer([row('1'), row('2')]), claimed);
  assert.deepEqual(
    kept.found.map(f => f.id),
    [at('campaignBudgets', '2')],
    'only the object the review did not see',
  );
  const older = findCreated(plan, context).match(answer([row('1')]), claimed);
  assert.deepEqual(
    [older.found.length, older.undated?.length ?? 0, older.complete],
    [0, 0, true],
    'the older object is nobody’s',
  );
  const blind = findCreated(plan, {...context, existing: {ids: [], whole: false}}).match(answer([row('3')]), claimed);
  assert.deepEqual([blind.found.length, blind.undated.map(u => u.id)], [0, [at('campaignBudgets', '3')]]);
  // A review without a frozen list (prepared before this change) is read as it was.
  assert.deepEqual(
    findCreated(plan, {state: [], claimedAt: claimed}).match(answer([row('3')]), claimed).found.length,
    1,
  );
});

// The design joins of the M3 merge (r25-m3-merge): what only the merged tree can say, because each rule lives in a different package.
// A synthetic Google answers; nothing reaches Google. Every ID and name is synthetic (customer 123).
//   join 1  the default validate-only on the builds of pmax and trees and on trees' route B requests (targeting, L2-12)
//   join 2  Q1 with pmax: an ENABLED asset group under an existing serving Performance Max campaign (targeting, pmax)
//   join 3  Q1 with trees: the same tree under a parent that serves, is paused or cannot be read, through route B and through a build
//   join 4  dupstep before validation: a build held by the duplicate guard sends no validation request
//   join 5  the refusal locator with trees' composite temporary names
//   join 6  pmax's asset group on an existing campaign with trees' tree
//   join 7  G8 with Shopping nodes: J11 under allow_activation false
//   join 9  J10 composed from one builder, with the default validate-only on (the numbers of the journey)
//   join 13 callshape's lift of the gateway from `arguments` does not change the identity the duplicate guard compares
// Join 8 is tests/google-shopping-tree.test.mjs ("a removal is a deletion for the owner's switch, and a change under a serving ad
// group is an activation") and joins 14 to 16 are re-runs of existing suites; the merge REPORT lists them.
import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRefused} from './helpers/assert-refused.mjs';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {MirrorError} from '../dist/src/errors.js';
import {locateRefusedRecord} from '../dist/src/write-review.js';
import {familyOf} from '../dist/src/reviewed-families.js';
import {registeredProviderHooks} from '../dist/src/provider-hooks.js';
import * as retail from './fixtures/google-pmax-retail-tree.mjs';
import * as shop from './fixtures/google-shopping-build.mjs';
import * as pmax from './fixtures/google-pmax-retail-build.mjs';

/** The production policy (server/runtime.ts): the default provider check is on, so a Google prepare sends one validate-only request. */
const production = {providerCheckByDefault: true};
const switchOff = (x, f) =>
  saveSpendPolicy(x.store, f.admin, {
    gateway: f.google,
    account_id: f.account,
    confirmed: true,
    policy: {allow_activation: false},
  });
const sent = x => ({reads: x.queries.length, validations: x.validations.length, writes: x.mutates.length});
const withoutStatus = ({status: _status, ...rest}) => rest;

// ---- join 1 -------------------------------------------------------------------------------------------------------------------------

test('join 1: the default validate-only runs on the builds of pmax and trees and on trees’ route B requests, and only the four routes without validateOnly are left out', async t => {
  // A retail Performance Max build (pmax's asset group and links, trees' 24-node tree): one validate-only request, the whole build.
  const j10 = retail.retailCustomer({policy: production});
  t.after(() => j10.store.close());
  const build = retail.retailPmaxBuild();
  const review = await j10.prepare(build);
  assert.equal(review.success, true, JSON.stringify(review).slice(0, 800));
  assert.deepEqual(
    [review.data.provider_check.status, review.data.provider_check.default],
    ['provider_validated', true],
    'checked by default, not asked for',
  );
  assert.equal(j10.validations.length, 1);
  assert.equal(j10.validations[0].path, '/v25/customers/123/googleAds:mutate');
  assert.deepEqual(Object.keys(j10.validations[0].body).sort(), ['mutate_operations', 'validate_only']);
  assert.equal(j10.validations[0].body.validate_only, true);
  assert.equal(j10.validations[0].body.mutate_operations.length, build.length, 'Google validates the whole build');
  assert.equal(j10.mutates.length, 0, 'a validate-only request applies nothing');
  // pmax's own J10 build, without a tree, under an existing campaign.
  const own = pmax.pmaxRetailWorld({policy: production});
  t.after(() => own.close());
  const ownReview = await own.prepareBuild(pmax.j10Build());
  assert.equal(ownReview.data.provider_check.status, 'provider_validated', JSON.stringify(ownReview).slice(0, 600));
  assert.equal(own.log.validations.length, 1);
  assert.equal(own.log.validations[0].mutate_operations.length, 66);
  // trees' Standard Shopping build, and the one-service review of a Shopping tree (route B: adGroupCriteria:mutate).
  const j11 = shop.shoppingCustomer({policy: production});
  t.after(() => j11.store.close());
  assert.equal((await j11.prepare(shop.shoppingBuild())).data.provider_check.status, 'provider_validated');
  assert.equal(j11.validations.length, 1);
  assert.equal(j11.validations[0].path, '/v25/customers/123/googleAds:mutate');
  const edit = shop.shoppingCustomer({...shop.existingAdGroup(), policy: production});
  t.after(() => edit.store.close());
  const routeB = await edit.prepareEdit(shop.treeEdit());
  assert.equal(routeB.data.provider_check.status, 'provider_validated', JSON.stringify(routeB).slice(0, 600));
  assert.deepEqual(
    edit.validations.map(v => [v.path, Object.keys(v.body).sort().join()]),
    [['/v25/customers/123/adGroupCriteria:mutate', 'operations,validate_only']],
  );
  // The Performance Max tree review (route B: assetGroupListingGroupFilters:mutate) is trees' family and is validated; the four routes
  // the pinned Discovery document gives no validateOnly are the only ones that are not.
  const planOf = (service, body = {operations: [{create: {}}]}) => ({
    gateway: retail.google,
    action: 'google_ads_v23_' + service,
    method: 'POST',
    path: '/v25/customers/123/' + service + ':mutate',
    query: {},
    headers: {},
    body,
    readOnly: false,
    destructive: false,
    requiresConfirmation: true,
    accountId: retail.account,
    evidence: '',
    warnings: [],
  });
  const google = registeredProviderHooks.find(h => h.gateway === retail.google);
  assert.equal(familyOf(planOf('assetGroupListingGroupFilters', {operations: []}))?.name, 'google_listing_groups');
  for (const service of ['googleAds', 'adGroupCriteria', 'assetGroupListingGroupFilters']) {
    const request = google.validation.request(planOf(service));
    assert.ok(request, service + ' is validated');
    assert.equal(request.body.validate_only, true, service);
  }
  for (const service of ['batchJobs', 'billingSetups', 'customerUserAccessInvitations', 'customerUserAccesses'])
    assert.equal(google.validation.request(planOf(service, {operation: {create: {}}})), undefined, service);
  // The opt-out is still the caller's: nothing is sent to validate.
  const optedOut = retail.retailCustomer({policy: production});
  t.after(() => optedOut.store.close());
  const call = await optedOut.call('amcp_write', {
    action: 'prepare',
    gateway: retail.google,
    provider_check: false,
    arguments: {
      action: 'google_ads_v23_google_ads_mutate',
      account_id: retail.account,
      payload: {mutate_operations: build},
    },
  });
  assert.equal(call.success, true);
  assert.equal(optedOut.validations.length, 0);
});

// ---- join 2 -------------------------------------------------------------------------------------------------------------------------

const existingCampaign = retail.at('campaigns', '77');
const pmaxCampaign = (extra = {}) => ({
  advertisingChannelType: 'PERFORMANCE_MAX',
  status: 'ENABLED',
  brandGuidelinesEnabled: false,
  shoppingSetting: {merchantId: '555'},
  ...extra,
});
/** The retail build with its asset group under a campaign that exists: the budget and campaign operations leave, the group names it. */
const underExistingCampaign = ({status = 'ENABLED', tree = []} = {}) =>
  retail
    .retailPmaxBuild({tree, group: {campaign: existingCampaign, status}})
    .filter(o => !o.campaign_budget_operation && !o.campaign_operation);

test('join 2, Q1 with pmax: an ENABLED asset group under an existing serving Performance Max campaign prepares, asks for the spend flag, and is refused by allow_activation false', async t => {
  const x = retail.retailCustomer({campaigns: {[existingCampaign]: pmaxCampaign()}, policy: production});
  t.after(() => x.store.close());
  const review = await x.prepare(underExistingCampaign());
  assert.equal(review.success, true, JSON.stringify(review).slice(0, 800));
  assert.equal(
    review.data.execute_requirements.spend_change_confirmed,
    true,
    'a child that serves at once is a spending change',
  );
  assert.equal(review.data.provider_check.status, 'provider_validated');
  assert.equal(x.validations.length, 1);
  // Without the flag nothing is sent; with it the build is.
  const bare = await x.call('amcp_write', {action: 'execute', review_id: review.data.review_id, confirmed: true});
  assertRefused(bare, 'SPEND_CONFIRMATION_REQUIRED', {writes: () => x.mutates.length});
  assert.equal((await x.execute(review)).success, true);
  assert.equal(x.mutates.length, 1);
  assert.equal(
    x.mutates[0].mutate_operations.find(o => o.asset_group_operation).asset_group_operation.create.campaign,
    existingCampaign,
  );
  // The owner's switch: the ENABLED group is an activation, a PAUSED one under the same serving campaign is not.
  const refused = retail.retailCustomer({campaigns: {[existingCampaign]: pmaxCampaign()}, policy: production});
  t.after(() => refused.store.close());
  switchOff(refused, retail);
  assertRefused(await refused.prepare(underExistingCampaign()), 'POLICY_ACTIVATION_FORBIDDEN', {
    writes: () => refused.mutates.length,
  });
  assert.equal(refused.validations.length, 0, 'a build the owner’s policy refuses is never sent to Google to validate');
  const paused = await refused.prepare(underExistingCampaign({status: 'PAUSED'}));
  assert.equal(paused.success, true, JSON.stringify(paused).slice(0, 600));
});

test('join 2: a campaign whose status cannot be read is never prepared: pmax’s own check answers before the paused-parent check, and nothing is sent', async t => {
  // The order the merge keeps (assertPmaxExistingAssets, assertPmaxExistingCampaigns, the states, the per-operation loop, the trees'
  // campaigns): an asset group's campaign is read by pmax first, so a row with no status is INVALID_GOOGLE_BUILD at the group's
  // campaign field, and no row at all is the state read's STATE_NOT_FOUND. PARENT_SERVING with parent_unread (join 3, the build side)
  // is what an ad group, an ad or a keyword under such a campaign gets; an asset group never reaches it.
  const row = retail.retailCustomer({
    campaigns: {[existingCampaign]: withoutStatus(pmaxCampaign())},
    policy: production,
  });
  t.after(() => row.store.close());
  const build = underExistingCampaign();
  const unreadStatus = await row.prepare(build);
  assertRefused(unreadStatus, 'INVALID_GOOGLE_BUILD', {writes: () => row.mutates.length});
  const at = build.findIndex(o => o.asset_group_operation);
  assert.equal(unreadStatus.error.details.operation, at);
  assert.equal(unreadStatus.error.details.field, 'mutate_operations[' + at + '].asset_group_operation.create.campaign');
  assert.equal(row.validations.length, 0);
  const none = retail.retailCustomer({policy: production});
  t.after(() => none.store.close());
  assertRefused(await none.prepare(build), 'STATE_NOT_FOUND', {writes: () => none.mutates.length});
  assert.equal(none.validations.length, 0);
});

// ---- join 3 -------------------------------------------------------------------------------------------------------------------------

const shopCampaignId = shop.at('campaigns', '40');
const shopCampaign = (extra = {}) => ({
  status: 'ENABLED',
  advertisingChannelType: 'SHOPPING',
  shoppingSetting: {merchantId: '555'},
  ...extra,
});
/** J11 with its ad group under a campaign that exists (its budget, campaign and campaign criteria leave); `status` is the group's and the ad's. */
const shoppingUnder = status =>
  shop
    .shoppingBuild({adGroup: {campaign: shopCampaignId, status}})
    .filter(o => !o.campaign_budget_operation && !o.campaign_operation && !o.campaign_criterion_operation)
    .map(o =>
      o.ad_group_ad_operation ? {ad_group_ad_operation: {create: {...o.ad_group_ad_operation.create, status}}} : o,
    );
/** The same Standard Shopping tree under the three states of a parent, through a build (a new ad group) and through route B (an existing one). */
const parentStates = {
  serving: {
    build: {campaigns: {[shopCampaignId]: shopCampaign()}, group: 'ENABLED'},
    routeB: shop.existingAdGroup({
      adGroups: {
        [shop.at('adGroups', '55')]: {status: 'ENABLED', type: 'SHOPPING_PRODUCT_ADS', campaign: shopCampaignId},
      },
      campaigns: {[shopCampaignId]: shopCampaign()},
    }),
  },
  paused: {
    // A PAUSED group under a campaign that serves: created paused, so nothing serves; route B's twin is a paused ad group.
    build: {campaigns: {[shopCampaignId]: shopCampaign()}, group: 'PAUSED'},
    routeB: shop.existingAdGroup({
      adGroups: {
        [shop.at('adGroups', '55')]: {status: 'PAUSED', type: 'SHOPPING_PRODUCT_ADS', campaign: shopCampaignId},
      },
      campaigns: {[shopCampaignId]: shopCampaign({status: 'PAUSED'})},
    }),
  },
  unread: {
    build: {campaigns: {[shopCampaignId]: withoutStatus(shopCampaign())}, group: 'ENABLED'},
    routeB: shop.existingAdGroup({
      adGroups: {[shop.at('adGroups', '55')]: {type: 'SHOPPING_PRODUCT_ADS', campaign: shopCampaignId}},
      campaigns: {[shopCampaignId]: withoutStatus(shopCampaign())},
    }),
  },
};
const answerOf = r => (r.success ? 'prepared' : r.error.code);

test('join 3, Q1 with trees: the same tree under a serving, a paused or an unread parent gets the same allow_activation answer through route B and through a build', async t => {
  const answers = {};
  for (const [state, world] of Object.entries(parentStates))
    for (const policy of ['owner allows activation', 'owner forbids activation']) {
      const build = shop.shoppingCustomer({campaigns: world.build.campaigns, policy: production}),
        routeB = shop.shoppingCustomer({...world.routeB, policy: production});
      t.after(() => build.store.close());
      t.after(() => routeB.store.close());
      if (policy === 'owner forbids activation') {
        switchOff(build, shop);
        switchOff(routeB, shop);
      }
      const viaBuild = await build.prepare(shoppingUnder(world.build.group)),
        viaRouteB = await routeB.prepareEdit(shop.treeEdit());
      answers[state + ' / ' + policy] = [answerOf(viaBuild), answerOf(viaRouteB)];
      for (const [name, r, x] of [
        ['build', viaBuild, build],
        ['route B', viaRouteB, routeB],
      ]) {
        const label = state + ', ' + policy + ', ' + name;
        if (r.success) {
          assert.equal(r.data.execute_requirements.spend_change_confirmed, true, label);
          assert.equal(r.data.provider_check.status, 'provider_validated', label);
          assert.equal(x.validations.length, 1, label);
        } else {
          assert.equal(x.validations.length, 0, label + ': a refused review is never validated');
          assert.equal(x.mutates.length, 0, label);
        }
      }
      // No request has two owners: a tree under a serving ad group is trees' own activation (it says so), never a targeting write that
      // must start PAUSED (TARGETING_PARENT_SERVING), and a node of a build is never checked as a targeting create.
      if (state === 'serving' && policy === 'owner allows activation')
        assert.equal(viaRouteB.data.creative_impact.may_affect_serving, true);
      if (state === 'unread') {
        assertRefused(viaBuild, 'PARENT_SERVING', {writes: () => build.mutates.length});
        assert.equal(
          viaBuild.error.details.parent_unread,
          true,
          'the child would serve under a parent whose status is unknown',
        );
        assertRefused(viaRouteB, 'INVALID_SHOPPING_LISTING_GROUP', {writes: () => routeB.mutates.length});
      }
    }
  assert.deepEqual(answers, {
    'serving / owner allows activation': ['prepared', 'prepared'],
    'serving / owner forbids activation': ['POLICY_ACTIVATION_FORBIDDEN', 'POLICY_ACTIVATION_FORBIDDEN'],
    'paused / owner allows activation': ['prepared', 'prepared'],
    'paused / owner forbids activation': ['prepared', 'prepared'],
    // Refused before the owner's switch is asked, so the switch changes nothing; the two routes spell it in their own codes.
    'unread / owner allows activation': ['PARENT_SERVING', 'INVALID_SHOPPING_LISTING_GROUP'],
    'unread / owner forbids activation': ['PARENT_SERVING', 'INVALID_SHOPPING_LISTING_GROUP'],
  });
});

// ---- join 4 -------------------------------------------------------------------------------------------------------------------------

test('join 4: the duplicate guard runs before the default validate-only, so a build held for an uncertain twin sends no validation request, no read and no write', async t => {
  const x = retail.retailCustomer({policy: production});
  t.after(() => x.store.close());
  const build = retail.retailPmaxBuild();
  const first = await x.prepare(build);
  assert.equal(first.success, true);
  assert.deepEqual(sent(x), {reads: 4, validations: 1, writes: 0});
  // Google applies the build and the answer is lost: the write is uncertain.
  x.mode.lose = true;
  assertRefused(await x.execute(first), 'WRITE_OUTCOME_UNCERTAIN');
  const before = sent(x);
  assert.deepEqual(before, {reads: 6, validations: 1, writes: 1});
  const second = await x.prepare(build);
  assertRefused(second, 'DUPLICATE_OF_UNCERTAIN_WRITE', {writes: () => x.mutates.length - 1});
  assert.equal(second.error.details.earlier_match, 'identical');
  assert.deepEqual(sent(x), before, 'nothing was asked of Google: not the validation, not even a state read');
  // A request whose objects are all named otherwise is another request and is prepared, and validated: the guard compares each named
  // create of the build (a budget of the same name under the same customer is the same object), so one name left alone would hold it.
  const renamed = retail
    .retailPmaxBuild({campaign: {name: 'Retail PMax, another'}, group: {name: 'Another group'}})
    .map(o =>
      o.campaign_budget_operation
        ? {campaign_budget_operation: {create: {...o.campaign_budget_operation.create, name: 'Another budget'}}}
        : o,
    );
  const other = await x.prepare(renamed);
  assert.equal(other.success, true, JSON.stringify(other).slice(0, 600));
  assert.equal(x.validations.length, 2);
});

// ---- join 5 -------------------------------------------------------------------------------------------------------------------------

test('join 5: the refusal locator never slices a request that temporary names link, in either grammar, and still slices one that holds only real IDs', () => {
  const plan = operations => ({
    gateway: retail.google,
    action: 'google_ads_v23_ad_group_criterion_mutate_ad_group_criteria',
    method: 'POST',
    path: '/v25/customers/123/adGroupCriteria:mutate',
    query: {},
    headers: {},
    body: {operations},
    readOnly: false,
    destructive: false,
    requiresConfirmation: true,
    accountId: retail.account,
    evidence: '',
    warnings: [],
  });
  const records = names =>
    names.map(resourceName => ({
      create: {resourceName, adGroup: 'customers/123/adGroups/55', listingGroup: {type: 'UNIT'}},
    }));
  const name = tail => 'customers/123/adGroupCriteria/' + tail;
  const whole = () => new MirrorError('RECORD_REFUSED', 'operations[1].create.listingGroup: rule A is broken.');
  let alone = 0;
  const check = () => {
    alone += 1;
    throw new MirrorError('RECORD_REFUSED', 'operations[0].create.listingGroup: rule A is broken.');
  };
  for (const [label, names] of [
    ['trees’ composite names (55~-1)', [name('55~-1'), name('55~-2'), name('55~-3')]],
    ['a plain temporary name (-1)', [name('-1'), name('-2'), name('-3')]],
  ]) {
    alone = 0;
    const linked = whole();
    locateRefusedRecord(plan(records(names)), linked, check);
    assert.equal(alone, 0, label + ': no record is checked alone');
    assert.equal(linked.details.operation, undefined, label + ': a record of a linked request cannot be named');
  }
  // The same list with real IDs has a record list: the first record refused with the same code and message is named.
  alone = 0;
  const located = whole();
  locateRefusedRecord(plan(records([name('55~11'), name('55~12'), name('55~13')])), located, check);
  assert.ok(alone > 0);
  assert.equal(located.details.operation, 0);
  assert.equal(located.code, 'RECORD_REFUSED');
});

// ---- join 6 -------------------------------------------------------------------------------------------------------------------------

test('join 6: a retail tree under a new asset group of an existing retail campaign is one review, checked by pmax’s campaign check and then trees’', async t => {
  const campaigns = {[existingCampaign]: pmaxCampaign({status: 'PAUSED'})};
  const x = retail.retailCustomer({campaigns, policy: production});
  t.after(() => x.store.close());
  const build = underExistingCampaign({status: 'PAUSED', tree: retail.retailTreeOperations()});
  const review = await x.prepare(build);
  assert.equal(review.success, true, JSON.stringify(review).slice(0, 1000));
  const trees = review.data.creative_impact.build.trees;
  assert.deepEqual([trees.length, trees[0].nodes, trees[0].final_tree.length], [1, 24, 24]);
  assert.equal(
    x.validations[0].body.mutate_operations.length,
    build.length,
    'the group, its assets, its links and its tree are validated whole',
  );
  assert.equal((await x.execute(review)).success, true);
  assert.equal(x.mutates.length, 1);
  assert.equal(x.mutates[0].mutate_operations.filter(o => o.asset_group_listing_group_filter_operation).length, 24);
  assert.equal(
    x.mutates[0].mutate_operations.find(o => o.asset_group_operation).asset_group_operation.create.campaign,
    existingCampaign,
  );
  // A Performance Max campaign without a Merchant Center account passes pmax's check and is refused by trees' (a retail tree needs one).
  const plain = retail.retailCustomer({
    campaigns: {[existingCampaign]: withoutShopping(pmaxCampaign())},
    policy: production,
  });
  t.after(() => plain.store.close());
  const noMerchant = await plain.prepare(build);
  assertRefused(noMerchant, 'INVALID_LISTING_GROUP', {writes: () => plain.mutates.length, message: /Merchant Center/});
  // A campaign that is not Performance Max is refused by pmax first, naming the group's campaign field (the order of the merge).
  const search = retail.retailCustomer({
    campaigns: {[existingCampaign]: pmaxCampaign({advertisingChannelType: 'SEARCH'})},
    policy: production,
  });
  t.after(() => search.store.close());
  const refused = await search.prepare(build);
  assertRefused(refused, 'INVALID_GOOGLE_BUILD', {writes: () => search.mutates.length});
  assert.equal(refused.error.details.channel, 'SEARCH');
  assert.equal(plain.validations.length + search.validations.length, 0);
});
const withoutShopping = ({shoppingSetting: _shoppingSetting, ...rest}) => rest;

// ---- join 7 -------------------------------------------------------------------------------------------------------------------------

test('join 7, G8 with Shopping nodes: J11 under allow_activation false prepares with its ad group PAUSED, and is refused with it ENABLED', async t => {
  const paused = shop
    .shoppingBuild({adGroup: {status: 'PAUSED'}})
    .map(o =>
      o.ad_group_ad_operation
        ? {ad_group_ad_operation: {create: {...o.ad_group_ad_operation.create, status: 'PAUSED'}}}
        : o,
    );
  const x = shop.shoppingCustomer({policy: production});
  t.after(() => x.store.close());
  switchOff(x, shop);
  const review = await x.prepare(paused);
  assert.equal(review.success, true, JSON.stringify(review).slice(0, 800));
  // The nodes carry no status: under a temporary ad group they never count as an activation (their parent is the build's own).
  assert.equal(paused.filter(o => o.ad_group_criterion_operation).length, 5);
  assert.ok(
    paused
      .filter(o => o.ad_group_criterion_operation)
      .every(o => o.ad_group_criterion_operation.create.status === undefined),
  );
  assert.equal(review.data.provider_check.status, 'provider_validated');
  // The same build with its ad group ENABLED (J11 as it is written) is an activation, as every ENABLED create has been.
  const enabled = shop.shoppingCustomer({policy: production});
  t.after(() => enabled.store.close());
  switchOff(enabled, shop);
  assertRefused(await enabled.prepare(shop.shoppingBuild()), 'POLICY_ACTIVATION_FORBIDDEN', {
    writes: () => enabled.mutates.length,
  });
  assert.equal(enabled.validations.length, 0);
});

// ---- join 9 -------------------------------------------------------------------------------------------------------------------------

test('join 9: J10 with its tree, composed from trees’ builder, is 2 MCP calls and 8 provider requests under the production policy (7 without), and pmax’s own J10 build is 9 (8)', async t => {
  const x = retail.retailCustomer({policy: production});
  t.after(() => x.store.close());
  const review = await x.prepare(retail.retailPmaxBuild());
  assert.equal(review.success, true, JSON.stringify(review).slice(0, 800));
  assert.equal((await x.execute(review)).success, true);
  // Prepare: the customer, the existing image assets, the names of the new campaign and asset group (4 reads) and the validate-only
  // request; execute: the customer and the image assets again and the one mutate.
  assert.deepEqual(sent(x), {reads: 6, validations: 1, writes: 1});
  assert.equal(x.queries.length + x.validations.length + x.mutates.length, 8);
  const before = x.queries.length;
  const verified = await x.call('amcp_campaign', {action: 'verify', review_id: review.data.review_id});
  assert.equal(verified.data.status, 'verified', JSON.stringify(verified.data).slice(0, 1200));
  assert.equal(x.queries.length - before, 21, 'the verification: 20 reads and one of the whole tree, a third call');
  // pmax's builder (an asset group under an existing campaign, no tree): 7 reads and one mutate, and the validate-only request.
  const own = pmax.pmaxRetailWorld({policy: production});
  t.after(() => own.close());
  const ownReview = await own.prepareBuild(pmax.j10Build());
  assert.equal(ownReview.success, true, JSON.stringify(ownReview).slice(0, 800));
  assert.equal((await own.execute(ownReview)).success, true);
  assert.equal(own.calls(), 2);
  assert.deepEqual(
    {
      reads: own.log.queries.length,
      validations: own.log.validations.length,
      mutates: own.log.mutates.length,
      requests: own.log.requests.length,
    },
    {reads: 7, validations: 1, mutates: 1, requests: 9},
  );
});

// ---- join 13 ------------------------------------------------------------------------------------------------------------------------

test('join 13: a prepare whose gateway callshape lifts from arguments computes the same identity: the uncertain twin still holds it and the completed twin still warns', async t => {
  const lifted = build => ({
    action: 'prepare',
    arguments: {
      gateway: retail.google,
      action: 'google_ads_v23_google_ads_mutate',
      account_id: retail.account,
      payload: {mutate_operations: build},
    },
  });
  // Uncertain: the identical build, with the gateway inside arguments, is held as the canonical call is.
  const uncertain = retail.retailCustomer({policy: production});
  t.after(() => uncertain.store.close());
  const build = retail.retailPmaxBuild();
  const first = await uncertain.prepare(build);
  uncertain.mode.lose = true;
  assertRefused(await uncertain.execute(first), 'WRITE_OUTCOME_UNCERTAIN');
  const before = sent(uncertain);
  const canonical = await uncertain.prepare(build),
    inner = await uncertain.call('amcp_write', lifted(build));
  assertRefused(canonical, 'DUPLICATE_OF_UNCERTAIN_WRITE');
  assertRefused(inner, 'DUPLICATE_OF_UNCERTAIN_WRITE');
  assert.equal(inner.error.details.earlier_match, canonical.error.details.earlier_match);
  assert.equal(
    inner.error.details.earlier_review_id,
    canonical.error.details.earlier_review_id,
    'the same earlier review',
  );
  assert.deepEqual(sent(uncertain), before, 'held before anything was asked of Google, as join 4 says');
  // Completed: the identical build warns within ten minutes, by either call, with the same warning, and the lift is reported.
  const done = retail.retailCustomer({policy: production});
  t.after(() => done.store.close());
  assert.equal((await done.execute(await done.prepare(build))).success, true);
  const twin = await done.prepare(build),
    liftedTwin = await done.call('amcp_write', lifted(build));
  assert.equal(twin.success, true);
  assert.equal(liftedTwin.success, true);
  assert.equal(twin.data.duplicate_warning.earlier_state, 'complete');
  assert.deepEqual(
    liftedTwin.data.duplicate_warning,
    twin.data.duplicate_warning,
    'the same twin, found by the same identity',
  );
  assert.deepEqual(
    (liftedTwin.meta?.argument_warnings ?? []).map(w => [w.code, w.field]),
    [['GATEWAY_PLACEMENT_DEPRECATED', 'arguments.gateway']],
    'the call was lifted, and is told so',
  );
});

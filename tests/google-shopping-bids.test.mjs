// Package r25-m3-live, F4 (the lead's live validate-only of 2026-11-20 on a Google test account): Google refused a biddable Standard Shopping unit
// that carries no cpc_bid_micros while its campaign bids Manual CPC (fieldError REQUIRED at
// ...ad_group_criterion_operation.create.cpc_bid_micros), applying nothing, although the ad group had a default bid of its own. AMCP refuses it at
// prepare: in a build from the Manual CPC the campaign it creates names (before any request) or the bidding strategy of an existing campaign it
// reads, and on route B from the strategy of the campaign it reads. Another strategy, or one the review did not read, changes nothing
// (UNVERIFIED: the default validate-only answers). This settles the trees REPORT's found-not-fixed 5. A synthetic Google answers; customer 123.
import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRefused} from './helpers/assert-refused.mjs';
import * as shop from './fixtures/google-shopping-build.mjs';

const production = {providerCheckByDefault: true};
const brand = v => ({productBrand: v ? {value: v} : {}});
const message =
  /^(mutate_operations\[\d+\]: )?A unit that bids needs cpc_bid_micros while its campaign bids Manual CPC/;
/** The five nodes of the fixture's tree with the bid of the node that has `bid` taken away (the "Other" unit is the one at 700000). */
const withoutBid = bid =>
  shop.shoppingTree({adGroup: '55', first: 1}).map(n => (n.bid === bid ? {...n, bid: undefined} : n));
const nothingSent = (x, label) => {
  assert.equal(x.mutates.length, 0, label + ': no write');
  assert.equal(x.validations.length, 0, label + ': no validate-only request');
};

// ---- route B -------------------------------------------------------------------------------------------------------------------------

/** An existing PAUSED Standard Shopping ad group whose campaign bids as `biddingStrategyType` says (none: the row does not carry it). */
const world = biddingStrategyType => {
  const base = shop.existingAdGroup(),
    campaign = shop.at('campaigns', '40');
  return {
    ...base,
    campaigns: {[campaign]: {...base.campaigns[campaign], ...(biddingStrategyType ? {biddingStrategyType} : {})}},
    policy: production,
  };
};

test('route B: a positive unit created without cpc_bid_micros under a campaign read as Manual CPC is refused at prepare, naming the unit and its field; no write, no validation', async t => {
  const x = shop.shoppingCustomer(world('MANUAL_CPC'));
  t.after(() => x.store.close());
  // The nodes are the root (operation 0), Acme (1), Beta (2, bid 900000), the excluded Zeta (3) and "Other" (4, bid 700000).
  const r = await x.prepareEdit(shop.treeEdit({adGroup: '55', nodes: withoutBid('900000')}));
  assertRefused(r, 'INVALID_SHOPPING_LISTING_GROUP', {writes: x.mutates.length, message});
  assert.deepEqual(
    [r.error.details.operation, r.error.details.field, r.error.details.bidding_strategy_type],
    [2, 'operations[2].create.cpcBidMicros', 'MANUAL_CPC'],
  );
  assert.equal(typeof r.error.details.node, 'string', 'the unit is named');
  nothingSent(x, 'route B');
  assert.ok(x.queries.length > 0, 'the campaign was read: its strategy is what refused');
  // The "Other" node bids as any other unit does, and the first unit without a bid is the one named.
  const other = await x.prepareEdit(shop.treeEdit({adGroup: '55', nodes: withoutBid('700000')}));
  assertRefused(other, 'INVALID_SHOPPING_LISTING_GROUP', {writes: x.mutates.length, message});
  assert.equal(other.error.details.field, 'operations[4].create.cpcBidMicros');
  // Every positive unit with its bid prepares, validated; an excluded unit takes no bid (Zeta has none) and is no unit that bids.
  const ok = await x.prepareEdit(shop.treeEdit({adGroup: '55'}));
  assert.equal(ok.success, true, JSON.stringify(ok).slice(0, 800));
  assert.equal(ok.data.provider_check.status, 'provider_validated');
});

test('route B: under another bidding strategy, or one the review did not read, a unit without a bid is left to the validate-only, and a bid-less unit Google lists never fails a review of something else', async t => {
  for (const strategy of ['TARGET_SPEND', 'TARGET_ROAS', 'MAXIMIZE_CONVERSION_VALUE', undefined]) {
    const x = shop.shoppingCustomer(world(strategy));
    t.after(() => x.store.close());
    const r = await x.prepareEdit(shop.treeEdit({adGroup: '55', nodes: withoutBid('900000')}));
    assert.equal(r.success, true, String(strategy) + ': ' + JSON.stringify(r).slice(0, 800));
    assert.equal(x.validations.length, 1, String(strategy) + ': Google is asked to validate it');
  }
  // A positive unit that exists without a bid is Google's own state: an edit that adds a unit with a bid prepares under Manual CPC.
  const existing = [
    shop.existingNode(1, 'SUBDIVISION'),
    shop.existingNode(2, 'UNIT', 1, {product_brand: {value: 'Acme'}}),
    shop.existingNode(3, 'UNIT', 1, {product_brand: {}}, {cpc_bid_micros: '700000'}),
  ];
  const y = shop.shoppingCustomer({...world('MANUAL_CPC'), criteria: existing});
  t.after(() => y.store.close());
  const gamma = {
    create: {
      adGroup: shop.at('adGroups', '55'),
      listingGroup: {
        type: 'UNIT',
        parentAdGroupCriterion: shop.at('adGroupCriteria', '55~1'),
        caseValue: brand('Gamma'),
      },
      cpcBidMicros: '1100000',
    },
  };
  const ok = await y.prepareEdit({operations: [gamma]});
  assert.equal(ok.success, true, JSON.stringify(ok).slice(0, 800));
  // The same unit without its bid is the request's own create, and is refused.
  const bare = await y.prepareEdit({operations: [{create: {...gamma.create, cpcBidMicros: undefined}}]});
  assertRefused(bare, 'INVALID_SHOPPING_LISTING_GROUP', {writes: y.mutates.length, message});
});

// ---- a build -------------------------------------------------------------------------------------------------------------------------

const buildWith = (tree, campaign = {}) => shop.shoppingBuild({tree: shop.treeOperations({}, tree), campaign});
const firstNode = () => shop.shoppingBuild().findIndex(o => o.ad_group_criterion_operation);

test('a build: a positive unit without cpc_bid_micros under the Manual CPC campaign it creates is refused at prepare, before any request, with the field of the build', async t => {
  const x = shop.shoppingCustomer({policy: production});
  t.after(() => x.store.close());
  const nodes = shop.shoppingTree().map(n => (n.bid === '900000' ? {...n, bid: undefined} : n)),
    r = await x.prepare(buildWith(nodes));
  const at = firstNode() + 2;
  assertRefused(r, 'INVALID_SHOPPING_LISTING_GROUP', {
    writes: x.mutates.length,
    message: new RegExp('^mutate_operations\\[' + at + '\\]: A unit that bids needs cpc_bid_micros'),
  });
  assert.deepEqual(
    [r.error.details.operation, r.error.details.field, r.error.details.bidding_strategy_type],
    [at, 'mutate_operations[' + at + '].ad_group_criterion_operation.create.cpc_bid_micros', 'MANUAL_CPC'],
  );
  nothingSent(x, 'in-build campaign');
  assert.equal(x.queries.length, 0, 'the campaign is the build’s own, so its strategy is known without a read');
  // The excluded unit has no bid and is no unit that bids: the build of every bid prepares.
  assert.equal((await x.prepare(shop.shoppingBuild())).success, true);
});

test('a build: under a campaign that bids another way, a unit without a bid is left to the validate-only', async t => {
  // Maximize Clicks (target_spend) instead of Manual CPC: the build's one-service shape accepts it for the campaign, and nothing is refused here.
  const x = shop.shoppingCustomer({policy: production});
  t.after(() => x.store.close());
  const nodes = shop.shoppingTree().map(n => (n.bid === '900000' ? {...n, bid: undefined} : n)),
    r = await x.prepare(buildWith(nodes, {manual_cpc: undefined, target_spend: {cpc_bid_ceiling_micros: '1000000'}}));
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 800));
  assert.equal(x.validations.length, 1);
});

/** J11's ad group and tree under a campaign that exists (its budget, campaign and campaign criteria leave), the ad group's own `status`. */
const underExisting = (tree, campaign) =>
  shop
    .shoppingBuild({adGroup: {campaign, status: 'PAUSED'}, tree: shop.treeOperations({}, tree)})
    .filter(o => !o.campaign_budget_operation && !o.campaign_operation && !o.campaign_criterion_operation)
    .map(o =>
      o.ad_group_ad_operation
        ? {ad_group_ad_operation: {create: {...o.ad_group_ad_operation.create, status: 'PAUSED'}}}
        : o,
    );

test('a build: the tree of a new ad group under an existing campaign read as Manual CPC is refused after the read; another strategy, or none read, is left to the validate-only', async t => {
  const campaign = shop.at('campaigns', '40'),
    row = extra => ({
      status: 'PAUSED',
      advertisingChannelType: 'SHOPPING',
      shoppingSetting: {merchantId: '555'},
      ...extra,
    });
  const nodes = shop.shoppingTree().map(n => (n.bid === '900000' ? {...n, bid: undefined} : n));
  const x = shop.shoppingCustomer({
    policy: production,
    campaigns: {[campaign]: row({biddingStrategyType: 'MANUAL_CPC'})},
  });
  t.after(() => x.store.close());
  const r = await x.prepare(underExisting(nodes, campaign));
  const at = underExisting(nodes, campaign).findIndex(o => o.ad_group_criterion_operation) + 2;
  assertRefused(r, 'INVALID_SHOPPING_LISTING_GROUP', {writes: x.mutates.length, message});
  assert.deepEqual(
    [r.error.details.operation, r.error.details.field],
    [at, 'mutate_operations[' + at + '].ad_group_criterion_operation.create.cpc_bid_micros'],
  );
  nothingSent(x, 'existing Manual CPC campaign');
  assert.ok(x.queries.length > 0, 'the campaign was read: its strategy is what refused');
  for (const strategy of ['TARGET_SPEND', 'TARGET_ROAS', undefined]) {
    const y = shop.shoppingCustomer({
      policy: production,
      campaigns: {[campaign]: row(strategy ? {biddingStrategyType: strategy} : {})},
    });
    t.after(() => y.store.close());
    const ok = await y.prepare(underExisting(nodes, campaign));
    assert.equal(ok.success, true, String(strategy) + ': ' + JSON.stringify(ok).slice(0, 800));
    assert.equal(y.validations.length, 1, String(strategy));
  }
  // With every bid in place the same build prepares under Manual CPC.
  const z = shop.shoppingCustomer({
    policy: production,
    campaigns: {[campaign]: row({biddingStrategyType: 'MANUAL_CPC'})},
  });
  t.after(() => z.store.close());
  assert.equal((await z.prepare(underExisting(shop.shoppingTree(), campaign))).success, true);
});

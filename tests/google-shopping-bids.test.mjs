// Package r25-m3-live, F4 (the lead's live validate-only of 2026-11-20 on a Google test account): Google refused a biddable Standard Shopping unit
// that carries no cpc_bid_micros while its campaign bids Manual CPC (fieldError REQUIRED at
// ...ad_group_criterion_operation.create.cpc_bid_micros), applying nothing, although the ad group had a default bid of its own. AMCP refuses it at
// prepare: in a build from the Manual CPC the campaign it creates names (before any request) or the bidding strategy of an existing campaign it
// reads, and on route B from the strategy of the campaign it reads. Another strategy, or one the review did not read, changes nothing
// (UNVERIFIED: the default validate-only answers). This settles the trees REPORT's found-not-fixed 5. A synthetic Google answers; customer 123.
import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRefused} from './helpers/assert-refused.mjs';
import {googleShoppingTreeSnapshots} from '../dist/src/google-shopping-tree.js';
import {normalizeSnapshot, reviewStateHash, reviewVolatile} from '../dist/src/review-state.js';
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

// ---- a review prepared before this package (the lead's review, S3-1) ------------------------------------------------------------------

// The ad group read of a route B review now selects campaign.bidding_strategy_type and its projection carried the key as null when the row had
// none. A review prepared before the deploy stored a state without the key and froze a query that does not select it; at execute that state is
// projected again as it is, and the frozen query is read again, so the new projection of a row without the field added `bidding_strategy_type:
// null` and the hashes differed: STATE_CHANGED, nothing sent, for a review that was still valid (the rule of src/write-review.ts, "a still-valid
// review prepared before an upgrade must not conflict solely because its stored envelope was wider"). The key is written only when the row has it.
const adGroupRead = () =>
  googleShoppingTreeSnapshots({
    gateway: shop.google,
    action: 'google_ads_v23_ad_group_criterion_mutate_ad_group_criteria',
    method: 'POST',
    path: '/v25/customers/123/adGroupCriteria:mutate',
    query: {},
    headers: {},
    body: shop.treeEdit(),
    readOnly: false,
    destructive: false,
    requiresConfirmation: true,
    accountId: shop.account,
    evidence: '',
    warnings: [],
  })[0];
/** What Google answers the ad group read, in its own spelling, with the campaign's fields `extra` added. */
const rawRow = (extra = {}) => ({
  results: [
    {
      adGroup: {
        resourceName: shop.at('adGroups', '55'),
        status: 'PAUSED',
        type: 'SHOPPING_PRODUCT_ADS',
        campaign: shop.at('campaigns', '40'),
      },
      campaign: {status: 'PAUSED', advertisingChannelType: 'SHOPPING', shoppingSetting: {merchantId: '555'}, ...extra},
    },
  ],
});
/** The state the code before this package stored for that row: the campaign has no bidding strategy key. */
const storedBefore = () => ({
  ad_group: {
    resource_name: shop.at('adGroups', '55'),
    status: 'PAUSED',
    type: 'SHOPPING_PRODUCT_ADS',
    campaign: shop.at('campaigns', '40'),
  },
  campaign: {status: 'PAUSED', advertising_channel_type: 'SHOPPING', merchant_id: '555'},
});

test('S3-1: a state stored without the bidding strategy and a raw ad group row that does not carry it hash equal under reviewStateHash; a row that carries it keeps it', () => {
  const read = adGroupRead(),
    volatile = reviewVolatile(shop.google);
  assert.ok(
    !/bidding_strategy_type/.test(JSON.stringify(storedBefore())),
    'the stored state is the one of the code before',
  );
  // A saved envelope is projected again at execute and stays as it was; the frozen query reads the row again and projects it.
  const before = normalizeSnapshot(read, storedBefore()),
    now = normalizeSnapshot(read, rawRow());
  assert.equal(Object.hasOwn(now.campaign, 'bidding_strategy_type'), false, 'a row without the field projects no key');
  assert.equal(reviewStateHash([now], volatile), reviewStateHash([before], volatile));
  // A row that carries the strategy projects it (it is what F4 decides on), which is another state than one stored without it: a review
  // prepared after the deploy has it at prepare and at execute.
  const manual = normalizeSnapshot(read, rawRow({biddingStrategyType: 'MANUAL_CPC'}));
  assert.equal(manual.campaign.bidding_strategy_type, 'MANUAL_CPC');
  assert.notEqual(reviewStateHash([manual], volatile), reviewStateHash([before], volatile));
  assert.equal(
    reviewStateHash([manual], volatile),
    reviewStateHash([normalizeSnapshot(read, rawRow({biddingStrategyType: 'MANUAL_CPC'}))], volatile),
    'prepare and execute of a review prepared after the deploy project the same state',
  );
});

test('S3-1: a route B review whose stored state and frozen read predate the strategy field executes after the upgrade, with no false STATE_CHANGED, and F4 decides nothing for it', async t => {
  const x = shop.shoppingCustomer(world(undefined));
  t.after(() => x.store.close());
  const p = await x.prepareEdit(shop.treeEdit());
  assert.equal(p.success, true, JSON.stringify(p).slice(0, 800));
  // Make it the review the code before this package prepared: no strategy key in its state, and a frozen read that does not select the field.
  const tenant = shop.actor.tenantId,
    review = x.store.document(tenant, 'write_review', p.data.review_id),
    state = structuredClone(review.state),
    reads = structuredClone(review.reads);
  delete state[0].campaign.bidding_strategy_type;
  const frozen = reads[0].body.query;
  reads[0].body.query = frozen.replace(', campaign.bidding_strategy_type', '');
  assert.notEqual(reads[0].body.query, frozen, 'the review read the field: the frozen query is made the old one');
  assert.ok(!/bidding_strategy_type/.test(JSON.stringify(state)) && !/bidding_strategy_type/.test(reads[0].body.query));
  x.store.putDocument(tenant, 'write_review', p.data.review_id, {
    ...review,
    state,
    reads,
    state_hash: reviewStateHash(state, reviewVolatile(shop.google)),
  });
  const e = await x.execute(p);
  assert.equal(e.success, true, JSON.stringify(e).slice(0, 900));
  assert.equal(x.mutates.length, 1, 'the review was sent once');
});

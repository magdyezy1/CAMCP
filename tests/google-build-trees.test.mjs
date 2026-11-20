// R2.5 M3 (r25-m3-trees, L2-09 and G5 route A): a product tree inside an all-or-nothing Google build. A Performance Max asset
// group is created with its tree under composite temporary names (`-g~-n`), and so is a Standard Shopping ad group (`-ag~-n`);
// each tree is checked as the one-service tree review checks it. A synthetic Google answers; nothing reaches Google.
import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRefused} from './helpers/assert-refused.mjs';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {assertGoogleAtomicBuild, googleAtomicPrerequisites} from '../dist/src/google-atomic-builds.js';
import {assertGoogleListingGroups, validateGoogleListingGroupPrerequisites} from '../dist/src/google-listing-groups.js';
import {assertGoogleShoppingTree, validateGoogleShoppingTreePrerequisites} from '../dist/src/google-shopping-tree.js';
import {temporaryParentForms, withTemporaryParentForms} from '../dist/src/google-temp-names.js';
import {
  account,
  admin,
  at,
  google,
  retailCustomer,
  retailPmaxBuild,
  retailTree,
  retailTreeOperations,
} from './fixtures/google-pmax-retail-tree.mjs';
import * as shop from './fixtures/google-shopping-build.mjs';

const treeQuery = q => / FROM asset_group_listing_group_filter WHERE /.test(q);

test('J10, the tree part: a retail asset group with its 24-node tree is one review, one mutate request and one read-back read for the tree', async t => {
  const x = retailCustomer();
  t.after(() => x.store.close());
  const review = await x.prepare(retailPmaxBuild());
  assert.equal(review.success, true, JSON.stringify(review).slice(0, 1500));
  assert.equal(x.mutates.length, 0);
  const trees = review.data.creative_impact.build.trees;
  assert.equal(trees.length, 1);
  assert.deepEqual([trees[0].asset_group, trees[0].nodes, trees[0].final_tree.length], ['All products', 24, 24]);
  assert.ok(trees[0].final_tree.includes('root [SUBDIVISION]'));
  assert.equal(review.data.execute_requirements.spend_change_confirmed, true);
  const before = x.queries.length;
  const done = await x.execute(review);
  assert.equal(done.success, true, JSON.stringify(done).slice(0, 1500));
  assert.equal(x.mutates.length, 1, 'one mutate request');
  const sent = x.mutates[0].mutate_operations;
  assert.equal(sent.length, 44);
  assert.equal(sent.filter(o => o.asset_group_listing_group_filter_operation).length, 24);
  assert.ok(
    sent
      .filter(o => o.asset_group_listing_group_filter_operation)
      .every(o =>
        /\/assetGroupListingGroupFilters\/-20~-3\d\d$/.test(
          o.asset_group_listing_group_filter_operation.create.resource_name,
        ),
      ),
    'every node is named after the new asset group',
  );
  // The tree is in the nodes Google created, under the asset group it allocated.
  const nodes = [...x.created.values()].filter(r =>
    String(r.resource_name).includes('/assetGroupListingGroupFilters/'),
  );
  assert.equal(nodes.length, 24);
  const group = [...x.created.keys()].find(n => n.includes('/assetGroups/'));
  assert.ok(nodes.every(n => n.asset_group === group && n.resource_name.includes('/' + group.split('/').at(-1) + '~')));
  // The journey's budget (J10, M3 merge), on the same basis as J11's: "build: 2 calls, N requests; verify: 1 call, M reads". The build is
  // 2 MCP calls, prepare and execute, and 7 provider requests: prepare reads the customer, the existing image assets the build links, and
  // the names of the new campaign and asset group (4 reads); execute reads the customer and the image assets again and sends the one
  // mutate (3). Its verification is a third call of 21 reads: one per operation but the tree's (20), and one of the whole tree. (R2.5 M3
  // round 2, S4-1: J10 was counted with its verification and J11 without, and J10 was not pinned.)
  const requests = x.queries.length + x.mutates.length;
  assert.equal(requests, 7, 'provider requests of prepare and execute: ' + x.queries.join(' | ').slice(0, 800));
  const verified = await x.call('amcp_campaign', {action: 'verify', review_id: review.data.review_id});
  assert.equal(verified.data.status, 'verified', JSON.stringify(verified.data).slice(0, 2000));
  assert.equal(verified.data.checks.length, 44 - 24 + 1, 'every other operation keeps its own read; the tree is one');
  const reads = x.queries.slice(before).filter(treeQuery);
  assert.equal(reads.length, 1, 'one read for the whole tree, not one per node');
  assert.match(reads[0], new RegExp("asset_group = '" + group.replace(/\//g, '\\/') + "'$"));
  assert.equal(x.queries.length + x.mutates.length - requests, 21, 'the verification: 20 reads and 1 read of the tree');
  t.diagnostic(
    'retail build: 2 MCP calls (prepare, execute) and ' +
      requests +
      ' provider requests; verification: 1 call, 21 reads',
  );
});

/** The nodes of a small tree, rendered for the one-service tree review and for a build, so one malformed case meets both. */
const spec = (...nodes) => nodes;
const unit = (parent, caseValue, type = 'UNIT_INCLUDED') => ({type, parent, caseValue});
const sub = (parent, caseValue) => ({type: 'SUBDIVISION', parent, caseValue});
const brand = v => (v === undefined ? {productBrand: {}} : {productBrand: {value: v}});
const condition = v => (v === undefined ? {productCondition: {}} : {productCondition: {condition: v}});
const ptype = (level, value) => ({productType: value === undefined ? {level} : {level, value}});
/** The one-service request for the tree of asset group 500, created whole: node i is named `500~-(i+1)`. */
const oneService = (nodes, extra = {}) => ({
  operations: nodes.map((n, i) => ({
    create: {
      ...(n.type === 'SUBDIVISION' || n.named
        ? {resourceName: at('assetGroupListingGroupFilters', '500~-' + (i + 1))}
        : {}),
      assetGroup: at('assetGroups', '500'),
      type: n.type,
      listingSource: n.source ?? 'SHOPPING',
      ...(n.parent !== undefined
        ? {parentListingGroupFilter: at('assetGroupListingGroupFilters', '500~-' + n.parent)}
        : {}),
      ...(n.caseValue ? {caseValue: n.caseValue} : {}),
      ...extra,
    },
  })),
});
const snake = s => s.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
const snakeKeys = v =>
  Array.isArray(v)
    ? v.map(snakeKeys)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [snake(k), snakeKeys(x)]))
      : v;
/** The same nodes in a build, named after a new asset group `-20` (node n is `-20~-(300 + n)`); the build is only checked, never sent. */
const inBuild = nodes => {
  const body = oneService(nodes),
    renamed = name => name.replace(/\/500~-(\d+)$/, (_, n) => '/-20~-' + (300 + Number(n)));
  return retailPmaxBuild({
    tree: body.operations.map(op => {
      const c = snakeKeys(op.create);
      return {
        asset_group_listing_group_filter_operation: {
          create: {
            ...c,
            asset_group: at('assetGroups', '-20'),
            ...(c.resource_name ? {resource_name: renamed(c.resource_name)} : {}),
            ...(c.parent_listing_group_filter
              ? {parent_listing_group_filter: renamed(c.parent_listing_group_filter)}
              : {}),
          },
        },
      };
    }),
  });
};
const plan = (path, body, action) => ({
  gateway: google,
  action,
  method: 'POST',
  path,
  query: {},
  headers: {},
  body,
  readOnly: false,
  destructive: false,
  requiresConfirmation: true,
  accountId: account,
  evidence: '',
  warnings: [],
});
const treeAction = 'google_ads_v23_asset_group_listing_group_filter_mutate_asset_group_listing_group_filters';
/** What the one-service review refuses a new tree on an empty asset group with: its code and rule, or undefined. */
function refusalOfReview(nodes) {
  const p = plan('/v25/customers/123/assetGroupListingGroupFilters:mutate', oneService(nodes), treeAction);
  const state = [
    {
      asset_group: {resource_name: at('assetGroups', '500'), status: 'PAUSED', campaign: at('campaigns', '40')},
      campaign: {
        resource_name: at('campaigns', '40'),
        status: 'PAUSED',
        advertising_channel_type: 'PERFORMANCE_MAX',
        merchant_id: '9',
      },
    },
    {nodes: []},
  ];
  try {
    assertGoogleListingGroups(p);
    validateGoogleListingGroupPrerequisites(p, state);
  } catch (e) {
    return {code: e.code, rule: e.details?.rule, message: e.message};
  }
}
/** What the build refuses the same tree with, when the campaign and the minimum assets are as a valid build has them. */
function refusalOfBuild(nodes) {
  const p = plan(
    '/v25/customers/123/googleAds:mutate',
    {mutate_operations: inBuild(nodes)},
    'google_ads_v23_google_ads_mutate',
  );
  try {
    assertGoogleAtomicBuild(
      p,
      () => {},
      () => {},
    );
  } catch (e) {
    return {code: e.code, rule: e.details?.rule, message: e.message, operation: e.details?.operation};
  }
}

test('parity: every malformed node of a new tree that the tree review refuses is refused in a build, with the same code and rule', () => {
  const okTree = spec(sub(undefined), unit(1, brand('a')), unit(1, brand()));
  assert.equal(refusalOfReview(okTree), undefined, 'the review accepts the valid tree');
  assert.equal(refusalOfBuild(okTree), undefined, 'and so does the build');
  const cases = [
    ['no "Other" node', spec(sub(undefined), unit(1, brand('a')), unit(1, brand('b')))],
    ['two "Other" nodes', spec(sub(undefined), unit(1, brand()), unit(1, brand()))],
    ['mixed dimensions', spec(sub(undefined), unit(1, brand('a')), unit(1, condition()))],
    [
      'a repeated value, in another case',
      spec(sub(undefined), unit(1, brand('Acme')), unit(1, brand('ACME')), unit(1, brand())),
    ],
    ['a subdivision with one child', spec(sub(undefined), unit(1, brand('a')))],
    ['an excluded root', spec({type: 'UNIT_EXCLUDED'})],
    ['a second root', spec({type: 'UNIT_INCLUDED'}, {type: 'UNIT_INCLUDED'})],
    ['a child of a unit', spec({type: 'UNIT_INCLUDED', named: true}, unit(1, brand('a')))],
    ['a child before its parent', spec(unit(2, brand('a')), sub(undefined))],
    [
      'a subdivision without a temporary name',
      spec({type: 'UNIT_INCLUDED'}, {...sub(undefined), type: 'SUBDIVISION', named: false}),
    ],
    ['an unknown dimension', spec(sub(undefined), unit(1, {webpage: {}}), unit(1, brand()))],
    ['a child without a case value', spec(sub(undefined), unit(1, undefined), unit(1, brand()))],
    ['a root with a case value', spec({...unit(undefined, brand('a'))}, unit(1, brand()))],
    ['a webpage listing source', spec({type: 'UNIT_INCLUDED', source: 'WEBPAGE'})],
    // R2.5 M3 round 2, S3-1: trees Google refuses at execute are refused at prepare, in a build as in a review.
    [
      'a dimension used twice on a path',
      spec(sub(undefined), sub(1, brand('a')), unit(2, brand('x')), unit(2, brand()), unit(1, brand())),
    ],
    [
      'a level without the level before it',
      spec(sub(undefined), unit(1, ptype('LEVEL2', 'a')), unit(1, ptype('LEVEL2'))),
    ],
    [
      'the "Other" node of a level refined by the next level',
      spec(
        sub(undefined),
        unit(1, ptype('LEVEL1', 'a')),
        sub(1, ptype('LEVEL1')),
        unit(3, ptype('LEVEL2', 'b')),
        unit(3, ptype('LEVEL2')),
      ),
    ],
  ];
  const met = new Set();
  for (const [label, nodes] of cases) {
    const review = refusalOfReview(nodes),
      build = refusalOfBuild(nodes);
    assert.ok(review, label + ': the tree review refuses it');
    assert.ok(build, label + ': the build refuses it too');
    assert.ok(review.rule, label + ': the refusal carries a closed rule (R2.5 M3 round 2, S4-4): ' + review.message);
    assert.equal(build.code, review.code, label + ': ' + build.message);
    assert.equal(build.rule, review.rule, label + ': the same rule');
    if (build.rule) met.add(build.rule);
  }
  assert.ok(met.size >= 13, 'the tree rules the cases reach: ' + [...met].join(', '));
  // A build names the operation it came from: a node's own check by its path, a tree's check by the prefix a one-service check
  // inside a build has, and both carry the operation in the details.
  const dimension = refusalOfBuild(spec(sub(undefined), unit(1, {webpage: {}}), unit(1, brand())));
  assert.match(dimension.message, /^mutate_operations\[\d+\]\.asset_group_listing_group_filter_operation\.create /);
  assert.equal(typeof dimension.operation, 'number');
  const incomplete = refusalOfBuild(spec(sub(undefined), unit(1, brand('a')), unit(1, brand('b'))));
  assert.equal(incomplete.rule, 'other_missing');
  assert.match(incomplete.message, /^mutate_operations\[\d+\]: Subdivision /);
});

test('a tree for an existing asset group is refused in a build, naming the one-service tree review; nothing is read or sent', async t => {
  const x = retailCustomer();
  t.after(() => x.store.close());
  const existing = retailPmaxBuild({
    tree: retailTreeOperations({group: '55'}).map(op => {
      // The tree of an asset group that exists: its filters are named `55~-n`, and the asset group is an ID.
      const c = op.asset_group_listing_group_filter_operation.create;
      return {asset_group_listing_group_filter_operation: {create: {...c, asset_group: at('assetGroups', '55')}}};
    }),
  });
  const r = await x.prepare(existing);
  assertRefused(r, 'INVALID_GOOGLE_BUILD', {writes: x.mutates.length});
  assert.match(r.error.message, /asset group that exists/);
  assert.match(r.error.message, new RegExp(treeAction));
  assert.equal(r.error.details.route, treeAction);
  assert.match(
    r.error.details.field,
    /^mutate_operations\[\d+\]\.asset_group_listing_group_filter_operation\.create\.asset_group$/,
  );
  assert.equal(x.queries.length, 0, 'no reads');
});

test('the asset group’s campaign must be Performance Max with a Merchant Center account: a temporary campaign from its own create, an existing one from the read', async t => {
  const x = retailCustomer();
  t.after(() => x.store.close());
  const build = retailPmaxBuild();
  delete build[1].campaign_operation.create.shopping_setting;
  const r = await x.prepare(build);
  assertRefused(r, 'INVALID_LISTING_GROUP', {writes: x.mutates.length});
  assert.match(r.error.message, /^mutate_operations\[\d+\]: .*Merchant Center/);
  // An existing campaign is read, and its channel and Merchant Center account are the proof (the parent read lists them).
  const ops = retailPmaxBuild();
  const existing = at('campaigns', '77');
  const adGroupOps = ops.map(o =>
    o.asset_group_operation
      ? {asset_group_operation: {create: {...o.asset_group_operation.create, campaign: existing}}}
      : o,
  );
  const rows = campaign => [
    {results: [{customer: {id: account, currencyCode: 'USD', timeZone: 'UTC'}}]},
    {results: [{campaign: {resourceName: existing, status: 'PAUSED', ...campaign}}]},
    {results: ['501', '502', '503'].map(id => ({asset: {resourceName: at('assets', id), type: 'IMAGE'}}))},
  ];
  const p = plan(
    '/v25/customers/123/googleAds:mutate',
    {mutate_operations: adGroupOps.filter(o => !o.campaign_operation && !o.campaign_budget_operation)},
    'google_ads_v23_google_ads_mutate',
  );
  const refused = campaign => {
    try {
      googleAtomicPrerequisites(p, rows(campaign));
    } catch (e) {
      return e;
    }
  };
  // Merge r25-m3-merge, merge 3: the asset group's own campaign is checked by r25-m3-pmax (assertPmaxExistingCampaigns, which
  // runs first, before the paused-parent check and before the tree check), so an asset group under an existing SEARCH campaign is
  // refused as INVALID_GOOGLE_BUILD, at the asset group's campaign field, before its tree is looked at. This case expected the tree
  // check's INVALID_LISTING_GROUP before pmax was merged; the order is pmax's, and the Performance Max campaign that has no
  // Merchant Center account below still reaches the tree check.
  const search = refused({advertisingChannelType: 'SEARCH', shoppingSetting: {merchantId: '555'}});
  const groupAt = p.body.mutate_operations.findIndex(o => o.asset_group_operation);
  assert.ok(groupAt >= 0);
  assertRefused(search, 'INVALID_GOOGLE_BUILD', {message: /SEARCH/});
  assert.equal(search.details.operation, groupAt);
  assert.equal(search.details.field, 'mutate_operations[' + groupAt + '].asset_group_operation.create.campaign');
  assertRefused(refused({advertisingChannelType: 'PERFORMANCE_MAX'}), 'INVALID_LISTING_GROUP', {
    message: /Merchant Center/,
  });
  assert.equal(refused({advertisingChannelType: 'PERFORMANCE_MAX', shoppingSetting: {merchantId: '555'}}), undefined);
});

test('the temporary asset group inside a node name is one switch (Q7): switched off, the build refuses a tree under a new asset group and names the two-phase route', async t => {
  const x = retailCustomer();
  t.after(() => x.store.close());
  assert.deepEqual(
    temporaryParentForms,
    {adGroupCriteria: true, assetGroupListingGroupFilters: true},
    'both forms are built (Q7, 2026-11-17)',
  );
  // The value is frozen; the seam changes what a build accepts for the length of the run (R2.5 M3 round 2, S4-3).
  await withTemporaryParentForms({assetGroupListingGroupFilters: false}, async () => {
    const r = await x.prepare(retailPmaxBuild());
    assertRefused(r, 'INVALID_GOOGLE_BUILD', {writes: x.mutates.length});
    assert.match(r.error.message, /create the asset group in the build, then add its tree/);
    assert.match(r.error.message, new RegExp(treeAction));
    assert.equal(r.error.details.rule, 'temporary_parent_refused');
    assert.equal(r.error.details.route, treeAction);
    assert.equal(x.queries.length, 0);
    // The other form is its own switch: this one does not touch a build without a tree.
    assert.equal((await x.prepare(retailPmaxBuild({tree: []}))).success, true);
  });
  assert.equal((await x.prepare(retailPmaxBuild())).success, true, 'switched on again, the tree is accepted');
});

test('the gates of a build hold for a tree: spending is confirmed, a refused build leaves nothing, an enabled asset group needs the activation switch, a read-back that differs is no success', async t => {
  // Spend: the build asks for it, and execute without it sends nothing.
  const x = retailCustomer();
  t.after(() => x.store.close());
  const review = await x.prepare(retailPmaxBuild());
  assert.equal(review.success, true);
  const refused = await x.call('amcp_write', {action: 'execute', review_id: review.data.review_id, confirmed: true});
  assertRefused(refused, 'SPEND_CONFIRMATION_REQUIRED', {writes: x.mutates.length});
  // Activation: an asset group that starts ENABLED is the owner's switch.
  const y = retailCustomer();
  t.after(() => y.store.close());
  saveSpendPolicy(y.store, admin, {
    confirmed: true,
    gateway: google,
    account_id: account,
    policy: {enforcement: 'block', allow_activation: false, allow_deletion: false},
  });
  const enabled = await y.prepare(retailPmaxBuild({group: {status: 'ENABLED'}}));
  const policy = enabled.success ? await y.execute(enabled) : enabled;
  assertRefused(policy, 'POLICY_ACTIVATION_FORBIDDEN', {writes: y.mutates.length});
  assert.equal((await y.prepare(retailPmaxBuild())).success, true, 'a paused asset group with its tree passes');
  // A tree whose read-back is not the reviewed one (a node of another type) is not verified.
  const z = retailCustomer({
    tamper: (record, name) =>
      name.includes('/assetGroupListingGroupFilters/') && record.type === 'UNIT_EXCLUDED'
        ? {type: 'UNIT_INCLUDED'}
        : {},
  });
  t.after(() => z.store.close());
  const p = await z.prepare(retailPmaxBuild());
  assert.equal((await z.execute(p)).success, true);
  const v = await z.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id});
  assert.notEqual(v.data.status, 'verified', JSON.stringify(v.data).slice(0, 600));
  assert.equal(v.data.checks.filter(c => c.status !== 'verified').length, 1, 'only the tree differs');
});

test('a build Google refuses leaves no part of the tree, and the tree counts as one chain: 24 nodes are never cut into parts', async t => {
  const x = retailCustomer({reject: true});
  t.after(() => x.store.close());
  const review = await x.prepare(retailPmaxBuild());
  assert.equal(review.success, true);
  assert.equal(review.data.group, undefined, 'one review, never a group of parts');
  const failed = await x.execute(review);
  assertRefused(failed, 'UPSTREAM_ERROR');
  assert.equal(x.created.size, 0);
  assertRefused(await x.execute(review), 'WRITE_REJECTED', {writes: x.mutates.length - 1});
  assert.equal(x.mutates.length, 1, 'never sent again');
});

test('the retail tree has 24 nodes of both kinds and is the tree of the journey: parents first, one root, an "Other" in each subdivision', () => {
  const nodes = retailTree();
  assert.equal(nodes.length, 24);
  assert.equal(nodes.filter(n => n.type === 'SUBDIVISION').length, 4);
  assert.equal(nodes.filter(n => n.parent === undefined).length, 1);
  assert.equal(new Set(nodes.map(n => n.name)).size, 24);
});

// ----- G5 route A: a Standard Shopping tree inside a build (J11) -----
const shoppingAction = 'google_ads_v23_ad_group_criterion_mutate_ad_group_criteria';
const adGroupTreeQuery = q => / FROM ad_group_criterion WHERE ad_group_criterion\.ad_group = /.test(q);
/** The build of the journey with every create PAUSED, so that the owner's activation switch has nothing to refuse. */
const pausedShopping = (options = {}) => {
  const ops = shop.shoppingBuild({...options, adGroup: {status: 'PAUSED', ...options.adGroup}});
  ops[5].ad_group_ad_operation.create.status = 'PAUSED';
  return ops;
};

test('J11: a Standard Shopping campaign with its 5-node product tree is one review, one mutate request and one read-back read for the tree', async t => {
  const x = shop.shoppingCustomer();
  t.after(() => x.store.close());
  const review = await x.prepare(shop.shoppingBuild());
  assert.equal(review.success, true, JSON.stringify(review).slice(0, 1500));
  assert.equal(x.mutates.length, 0);
  assert.equal(review.data.group, undefined, 'one review, never a group of parts');
  const trees = review.data.creative_impact.build.trees;
  assert.equal(trees.length, 1);
  assert.deepEqual([trees[0].ad_group, trees[0].nodes, trees[0].final_tree.length], ['All products', 5, 5]);
  assert.ok(trees[0].final_tree.includes('root [SUBDIVISION]'));
  assert.ok(trees[0].final_tree.includes('root > productBrand=acme [UNIT bid=1500000]'));
  assert.ok(trees[0].final_tree.includes('root > productBrand=zeta [UNIT_EXCLUDED]'));
  assert.equal(review.data.execute_requirements.spend_change_confirmed, true);
  const before = x.queries.length;
  const done = await x.execute(review);
  assert.equal(done.success, true, JSON.stringify(done).slice(0, 1500));
  assert.equal(x.mutates.length, 1, 'one mutate request');
  const sent = x.mutates[0].body.mutate_operations;
  assert.equal(sent.length, 11);
  const nodes = sent.filter(o => o.ad_group_criterion_operation).map(o => o.ad_group_criterion_operation.create);
  assert.equal(nodes.length, 5);
  assert.ok(
    nodes.every(n => !n.resource_name || /\/adGroupCriteria\/-3~-\d+$/.test(n.resource_name)),
    'every named node is named after the new ad group',
  );
  assert.ok(
    nodes.every(n => n.ad_group === at('adGroups', '-3') && n.listing_group),
    'sent as the review showed it',
  );
  // The tree is in the nodes Google created, under the ad group it allocated.
  assert.equal(x.nodes.size, 5);
  const group = [...x.created.keys()].find(n => n.includes('/adGroups/'));
  assert.ok(
    [...x.nodes.values()].every(
      n => n.ad_group === group && n.resource_name.includes('/' + group.split('/').at(-1) + '~'),
    ),
  );
  // The journey's budget (J11, M3 merge): the build is 2 MCP calls, prepare and execute, and 5 provider requests. Prepare reads the
  // customer and looks up the names of the new campaign and ad group (3 reads); execute reads the customer again and sends the one
  // mutate. Its verification is a third call of 7 reads: one per operation but the tree's, and one of the whole tree.
  const requests = x.queries.length + x.mutates.length;
  assert.equal(requests, 5, 'provider requests of prepare and execute: ' + x.queries.join(' | ').slice(0, 600));
  const verified = await x.verify(review);
  assert.equal(verified.data.status, 'verified', JSON.stringify(verified.data).slice(0, 2000));
  assert.equal(verified.data.checks.length, 6 + 1, 'every other operation keeps its own read; the tree is one');
  const reads = x.queries.slice(before).filter(adGroupTreeQuery);
  assert.equal(reads.length, 1, 'one read for the whole tree, not one per node');
  assert.match(
    reads[0],
    new RegExp(
      "ad_group = '" +
        group.replace(/\//g, '\\/') +
        "' AND ad_group_criterion\\.type = 'LISTING_GROUP' AND ad_group_criterion\\.status != 'REMOVED'$",
    ),
  );
  assert.equal(x.queries.length + x.mutates.length - requests, 7, 'the verification: 6 reads and 1 read of the tree');
  t.diagnostic(
    'Shopping build: 2 MCP calls (prepare, execute) and ' +
      requests +
      ' provider requests; verification: 1 call, 7 reads',
  );
});

test('camelCase keys are accepted in a Shopping build, as they are in every build: the same review, the same tree', async t => {
  const camel = v =>
    Array.isArray(v)
      ? v.map(camel)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v).map(([k, x]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), camel(x)]),
          )
        : v;
  const x = shop.shoppingCustomer();
  t.after(() => x.store.close());
  const prepare = payload =>
    x.call('amcp_write', {
      action: 'prepare',
      gateway: google,
      arguments: {action: 'google_ads_v23_google_ads_mutate', account_id: account, payload},
    });
  const snakeReview = await prepare({mutate_operations: shop.shoppingBuild()});
  const camelReview = await prepare(camel({mutate_operations: shop.shoppingBuild()}));
  assert.equal(camelReview.success, true, JSON.stringify(camelReview).slice(0, 1200));
  assert.deepEqual(camelReview.data.creative_impact.build.trees, snakeReview.data.creative_impact.build.trees);
  const done = await x.execute(camelReview);
  assert.equal(done.success, true, JSON.stringify(done).slice(0, 1200));
  assert.equal(x.nodes.size, 5);
  assert.equal((await x.verify(camelReview)).data.status, 'verified');
});

/** The nodes of a Standard Shopping tree for the review and for a build: a unit is a UNIT, an excluded one a negative UNIT. */
const sunit = (parent, caseValue, extra = {}) => ({type: 'UNIT', parent, caseValue, ...extra});
const ssub = (parent, caseValue, extra = {}) => ({type: 'SUBDIVISION', parent, caseValue, ...extra});
/** The one-service request for the tree of ad group 500, created whole: node i is named `500~-(i+1)`. */
const shoppingOneService = nodes => ({
  operations: nodes.map((n, i) => ({
    create: {
      ...(!n.unnamed && (n.type === 'SUBDIVISION' || n.named)
        ? {resourceName: at('adGroupCriteria', '500~-' + (i + 1))}
        : {}),
      adGroup: at('adGroups', '500'),
      listingGroup: {
        type: n.type,
        ...(n.parent !== undefined ? {parentAdGroupCriterion: at('adGroupCriteria', '500~-' + n.parent)} : {}),
        ...(n.caseValue ? {caseValue: n.caseValue} : {}),
      },
      ...(n.negative ? {negative: true} : {}),
      ...(n.bid ? {cpcBidMicros: n.bid} : {}),
    },
  })),
});
/** The same nodes in a build, named after a new ad group `-3` (node n is `-3~-(300 + n)`); the build is only checked, never sent. */
const inShoppingBuild = nodes => {
  const renamed = name => name.replace(/\/500~-(\d+)$/, (_, n) => '/-3~-' + (300 + Number(n)));
  return shop.shoppingBuild({
    tree: shoppingOneService(nodes).operations.map(op => {
      const c = snakeKeys(op.create),
        parent = c.listing_group.parent_ad_group_criterion;
      return {
        ad_group_criterion_operation: {
          create: {
            ...c,
            ad_group: at('adGroups', '-3'),
            ...(c.resource_name ? {resource_name: renamed(c.resource_name)} : {}),
            ...(parent ? {listing_group: {...c.listing_group, parent_ad_group_criterion: renamed(parent)}} : {}),
          },
        },
      };
    }),
  });
};
/** What the one-service review refuses a new tree on an empty ad group with: its code and rule, or undefined. */
function refusalOfShoppingReview(nodes) {
  const p = plan('/v25/customers/123/adGroupCriteria:mutate', shoppingOneService(nodes), shoppingAction);
  const state = [
    {
      ad_group: {
        resource_name: at('adGroups', '500'),
        status: 'PAUSED',
        type: 'SHOPPING_PRODUCT_ADS',
        campaign: at('campaigns', '40'),
      },
      campaign: {status: 'PAUSED', advertising_channel_type: 'SHOPPING', merchant_id: '555'},
    },
    {nodes: []},
  ];
  try {
    assertGoogleShoppingTree(p);
    validateGoogleShoppingTreePrerequisites(p, state);
  } catch (e) {
    return {code: e.code, rule: e.details?.rule, message: e.message};
  }
}
/** What the build refuses the same tree with, when the campaign and the ad group are as a valid build has them. */
function refusalOfShoppingBuild(nodes) {
  const p = plan(
    '/v25/customers/123/googleAds:mutate',
    {mutate_operations: inShoppingBuild(nodes)},
    'google_ads_v23_google_ads_mutate',
  );
  try {
    assertGoogleAtomicBuild(
      p,
      () => {},
      () => {},
    );
  } catch (e) {
    return {code: e.code, rule: e.details?.rule, message: e.message, operation: e.details?.operation};
  }
}

test('parity: every malformed node of a new Shopping tree that the tree review refuses is refused in a build, with the same code and rule', () => {
  const okTree = spec(ssub(undefined), sunit(1, brand('a'), {bid: '100000'}), sunit(1, brand()));
  assert.equal(refusalOfShoppingReview(okTree), undefined, 'the review accepts the valid tree');
  assert.equal(refusalOfShoppingBuild(okTree), undefined, 'and so does the build');
  const cases = [
    ['no "Other" node', spec(ssub(undefined), sunit(1, brand('a')), sunit(1, brand('b')))],
    ['two "Other" nodes', spec(ssub(undefined), sunit(1, brand()), sunit(1, brand()))],
    ['mixed dimensions', spec(ssub(undefined), sunit(1, brand('a')), sunit(1, condition()))],
    [
      'a repeated value, in another case',
      spec(ssub(undefined), sunit(1, brand('Acme')), sunit(1, brand('ACME')), sunit(1, brand())),
    ],
    ['a subdivision with one child', spec(ssub(undefined), sunit(1, brand('a')))],
    ['an excluded root', spec({type: 'UNIT', negative: true})],
    ['a second root', spec({type: 'UNIT'}, {type: 'UNIT'})],
    ['a child of a unit', spec({type: 'UNIT', named: true}, sunit(1, brand('a')))],
    ['a child before its parent', spec(sunit(2, brand('a')), ssub(undefined))],
    ['a subdivision without a temporary name', spec(ssub(undefined, undefined, {unnamed: true}), sunit(1, brand()))],
    [
      'an unsupported dimension (a hotel feed’s)',
      spec(ssub(undefined), sunit(1, {hotelId: {value: 'h1'}}), sunit(1, brand())),
    ],
    ['a child without a case value', spec(ssub(undefined), sunit(1, undefined), sunit(1, brand()))],
    ['a root with a case value', spec(sunit(undefined, brand('a')), sunit(1, brand()))],
    [
      'a bid on a subdivision',
      spec(ssub(undefined, undefined, {bid: '100000'}), sunit(1, brand('a')), sunit(1, brand())),
    ],
    [
      'a negative subdivision',
      spec(ssub(undefined, undefined, {negative: true}), sunit(1, brand('a')), sunit(1, brand())),
    ],
    // R2.5 M3 round 2, S3-1: trees Google refuses at execute are refused at prepare, in a build as in a review.
    [
      'a dimension used twice on a path',
      spec(ssub(undefined), ssub(1, brand('a')), sunit(2, brand('x')), sunit(2, brand()), sunit(1, brand())),
    ],
    [
      'a level without the level before it',
      spec(ssub(undefined), sunit(1, ptype('LEVEL2', 'a')), sunit(1, ptype('LEVEL2'))),
    ],
    [
      'the "Other" node of a level refined by the next level',
      spec(
        ssub(undefined),
        sunit(1, ptype('LEVEL1', 'a')),
        ssub(1, ptype('LEVEL1')),
        sunit(3, ptype('LEVEL2', 'b')),
        sunit(3, ptype('LEVEL2')),
      ),
    ],
    [
      'a bid on an excluded unit',
      spec(ssub(undefined), sunit(1, brand('a'), {negative: true, bid: '100000'}), sunit(1, brand())),
    ],
  ];
  const met = new Set();
  for (const [label, nodes] of cases) {
    const review = refusalOfShoppingReview(nodes),
      build = refusalOfShoppingBuild(nodes);
    assert.ok(review, label + ': the tree review refuses it');
    assert.ok(build, label + ': the build refuses it too');
    assert.ok(review.rule, label + ': the refusal carries a closed rule (R2.5 M3 round 2, S4-4): ' + review.message);
    assert.equal(build.code, review.code, label + ': ' + build.message);
    assert.equal(build.rule, review.rule, label + ': the same rule');
    if (build.rule) met.add(build.rule);
  }
  assert.ok(met.size >= 12, 'the tree rules the cases reach: ' + [...met].join(', '));
  // A build names the operation it came from: a node's own check by its path, a tree's check by the prefix a one-service check
  // inside a build has, and both carry the operation in the details.
  const dimension = refusalOfShoppingBuild(
    spec(ssub(undefined), sunit(1, {hotelId: {value: 'h1'}}), sunit(1, brand())),
  );
  assert.match(dimension.message, /^mutate_operations\[\d+\]\.ad_group_criterion_operation\.create\.listingGroup /);
  assert.equal(typeof dimension.operation, 'number');
  const incomplete = refusalOfShoppingBuild(spec(ssub(undefined), sunit(1, brand('a')), sunit(1, brand('b'))));
  assert.equal(incomplete.rule, 'other_missing');
  assert.match(incomplete.message, /^mutate_operations\[\d+\]: Subdivision /);
});

test('a tree for an existing ad group is refused in a build, naming the one-service tree review; nothing is read or sent', async t => {
  const x = shop.shoppingCustomer();
  t.after(() => x.store.close());
  const r = await x.prepare(shop.shoppingBuild({tree: shop.treeOperations({adGroup: '55'})}));
  assertRefused(r, 'INVALID_GOOGLE_BUILD', {writes: x.mutates.length});
  assert.match(r.error.message, /ad group that exists/);
  assert.match(r.error.message, new RegExp(shoppingAction));
  assert.equal(r.error.details.route, shoppingAction);
  assert.equal(r.error.details.rule, 'tree_of_existing_group');
  assert.match(r.error.details.field, /^mutate_operations\[\d+\]\.ad_group_criterion_operation\.create\.ad_group$/);
  assert.equal(x.queries.length, 0, 'no reads');
});

test('a tree node must come after the ad group it is named after: the build refuses a node placed before its ad group, as it refuses any use of a temporary name before its creation', async t => {
  const x = shop.shoppingCustomer();
  t.after(() => x.store.close());
  const ops = shop.shoppingBuild(),
    group = ops.findIndex(o => o.ad_group_operation),
    tree = ops.filter(o => o.ad_group_criterion_operation);
  const early = [...ops.slice(0, group), ...tree, ...ops.slice(group).filter(o => !o.ad_group_criterion_operation)];
  const r = await x.prepare(early);
  assertRefused(r, 'INVALID_GOOGLE_BUILD', {
    writes: x.mutates.length,
    message: /no earlier operation of this build creates as one of its adGroups/,
  });
  assert.equal(r.error.details.operation, group);
  // The build field rule (the M3 merge's last code commit): the path in the build's own payload, with the operation's key.
  assert.equal(r.error.details.field, 'mutate_operations[' + group + '].ad_group_criterion_operation.create.ad_group');
  assert.equal(x.queries.length, 0, 'no reads');
});

test('a criterion that is no listing group keeps today’s rule in a build: no temporary name, and the refusal names both tree forms', async t => {
  const x = shop.shoppingCustomer();
  t.after(() => x.store.close());
  for (const name of [at('adGroupCriteria', '-9'), at('adGroupCriteria', '-3~-9')]) {
    const ops = shop.shoppingBuild({tree: []});
    ops.push({
      ad_group_criterion_operation: {
        create: {
          resource_name: name,
          ad_group: at('adGroups', '-3'),
          keyword: {text: 'acme', match_type: 'EXACT'},
        },
      },
    });
    const r = await x.prepare(ops);
    assertRefused(r, 'INVALID_GOOGLE_BUILD', {writes: x.mutates.length});
    assert.match(r.error.message, /only budgets, campaigns, ad groups, assets and asset groups take one/, name);
    assert.match(r.error.message, /-g~-n/);
    assert.match(r.error.message, /-ag~-n/);
  }
  // A keyword that is named by nothing is as before.
  const ops = shop.shoppingBuild({tree: []});
  ops.push({
    ad_group_criterion_operation: {
      create: {ad_group: at('adGroups', '-3'), keyword: {text: 'acme', match_type: 'EXACT'}},
    },
  });
  assert.equal((await x.prepare(ops)).success, true);
});

test('the ad group of a tree is Standard Shopping under a Shopping campaign with a Merchant Center account: a temporary campaign from its own create, an existing one from the read', async t => {
  const x = shop.shoppingCustomer();
  t.after(() => x.store.close());
  const noMerchant = await x.prepare(shop.shoppingBuild({campaign: {shopping_setting: {campaign_priority: 0}}}));
  assertRefused(noMerchant, 'INVALID_SHOPPING_LISTING_GROUP', {
    writes: x.mutates.length,
    message: /^mutate_operations\[\d+\]: .*Merchant Center/,
  });
  const other = await x.prepare(shop.shoppingBuild({adGroup: {type: 'SEARCH_STANDARD'}}));
  assertRefused(other, 'INVALID_SHOPPING_LISTING_GROUP', {writes: x.mutates.length, message: /SEARCH_STANDARD/});
  const untyped = shop.shoppingBuild();
  delete untyped[4].ad_group_operation.create.type;
  assertRefused(await x.prepare(untyped), 'INVALID_SHOPPING_LISTING_GROUP', {
    writes: x.mutates.length,
    message: /SHOPPING_PRODUCT_ADS/,
  });
  // An existing campaign is read, and its channel and Merchant Center account are the proof (the parent read lists them).
  const existing = at('campaigns', '77');
  const adGroupOps = shop
    .shoppingBuild()
    .filter(o => o.ad_group_operation || o.ad_group_ad_operation || o.ad_group_criterion_operation)
    .map(o =>
      o.ad_group_operation ? {ad_group_operation: {create: {...o.ad_group_operation.create, campaign: existing}}} : o,
    );
  const rows = campaign => [
    {results: [{customer: {id: account, currencyCode: 'USD', timeZone: 'UTC'}}]},
    {results: [{campaign: {resourceName: existing, status: 'PAUSED', ...campaign}}]},
  ];
  const p = plan(
    '/v25/customers/123/googleAds:mutate',
    {mutate_operations: adGroupOps},
    'google_ads_v23_google_ads_mutate',
  );
  const refused = campaign => {
    try {
      googleAtomicPrerequisites(p, rows(campaign));
    } catch (e) {
      return e;
    }
  };
  assertRefused(
    refused({advertisingChannelType: 'SEARCH', shoppingSetting: {merchantId: '555'}}),
    'INVALID_SHOPPING_LISTING_GROUP',
    {message: /SEARCH/},
  );
  assertRefused(refused({advertisingChannelType: 'SHOPPING'}), 'INVALID_SHOPPING_LISTING_GROUP', {
    message: /Merchant Center/,
  });
  assert.equal(refused({advertisingChannelType: 'SHOPPING', shoppingSetting: {merchantId: '555'}}), undefined);
});

test('the temporary ad group inside a node name is one switch (Q7): switched off, the build refuses a tree under a new ad group and names the two-phase route', async t => {
  const x = shop.shoppingCustomer();
  t.after(() => x.store.close());
  await withTemporaryParentForms({adGroupCriteria: false}, async () => {
    const r = await x.prepare(shop.shoppingBuild());
    assertRefused(r, 'INVALID_GOOGLE_BUILD', {writes: x.mutates.length});
    assert.match(r.error.message, /create the ad group in the build, then add its tree/);
    assert.match(r.error.message, new RegExp(shoppingAction));
    assert.equal(r.error.details.rule, 'temporary_parent_refused');
    assert.equal(r.error.details.route, shoppingAction);
    assert.equal(x.queries.length, 0);
    // The other form is its own switch, and a build without a tree is not touched by this one.
    assert.equal((await x.prepare(shop.shoppingBuild({tree: []}))).success, true);
  });
  assert.equal((await x.prepare(shop.shoppingBuild())).success, true, 'switched on again, the tree is accepted');
});

test('the gates of a build hold for a Shopping tree: spending is confirmed, the owner’s activation switch and bid cap apply, a refused build leaves nothing, a read-back that differs is no success', async t => {
  // Spend: the build asks for it, and execute without it sends nothing.
  const x = shop.shoppingCustomer();
  t.after(() => x.store.close());
  const review = await x.prepare(shop.shoppingBuild());
  assert.equal(review.success, true);
  assertRefused(
    await x.call('amcp_write', {action: 'execute', review_id: review.data.review_id, confirmed: true}),
    'SPEND_CONFIRMATION_REQUIRED',
    {writes: x.mutates.length},
  );
  // Activation: an ad group and an ad that start ENABLED are the owner's switch; the same build PAUSED passes.
  const y = shop.shoppingCustomer();
  t.after(() => y.store.close());
  saveSpendPolicy(y.store, shop.admin, {
    confirmed: true,
    gateway: google,
    account_id: account,
    policy: {enforcement: 'block', allow_activation: false, allow_deletion: false},
  });
  const enabled = await y.prepare(shop.shoppingBuild());
  const policy = enabled.success ? await y.execute(enabled) : enabled;
  assertRefused(policy, 'POLICY_ACTIVATION_FORBIDDEN', {writes: y.mutates.length});
  assert.equal((await y.prepare(pausedShopping())).success, true, 'a paused build with its tree passes');
  // The owner's bid cap is in Google's native unit, micros: a unit bid above it is refused as a keyword's bid is.
  const z = shop.shoppingCustomer();
  t.after(() => z.store.close());
  saveSpendPolicy(z.store, shop.admin, {
    confirmed: true,
    gateway: google,
    account_id: account,
    policy: {enforcement: 'block', allow_activation: true, allow_deletion: true, max_bid_native: 1000000},
  });
  const capped = await z.prepare(shop.shoppingBuild());
  assertRefused(capped, 'POLICY_BID_LIMIT', {writes: z.mutates.length});
  assert.match(capped.error.details.field, /cpc_bid_micros|cpcBidMicros/);
  const low = shop.shoppingBuild({
    tree: shop.treeOperations(
      {},
      shop.shoppingTree().map(n => ({...n, bid: n.bid ? '500000' : undefined})),
    ),
  });
  assert.equal((await z.prepare(low)).success, true, 'every unit bid within the cap passes');
});

// Package r25-m3-live (F2) replaced this test, 'a Shopping node sent PAUSED in a build is read back with its status, which the per-node read
// used to cover (R2.5 M3 round 2, S3-3)', which built a unit PAUSED and verified it stored PAUSED. The lead's live run of 2026-11-20 shows that
// Google does not keep a listing group's status (a unit sent PAUSED reads back ENABLED), so a build that sends one is refused at prepare, before
// any request, as the one-service review refuses it; a unit sent ENABLED or with no status is the same node.
test('a Shopping node built with a status other than ENABLED is refused at prepare, before any request, in a build as on route B (r25-m3-live, F2)', async t => {
  const status = (status, pick) => shop.shoppingTree().map(n => (pick(n) ? {...n, status} : n));
  const refusedAt = async (label, nodes, operation) => {
    const x = shop.shoppingCustomer({policy: {providerCheckByDefault: true}});
    t.after(() => x.store.close());
    const r = await x.prepare(shop.shoppingBuild({tree: shop.treeOperations({}, nodes)}));
    assertRefused(r, 'INVALID_SHOPPING_LISTING_GROUP', {
      writes: x.mutates.length,
      message: /^Google does not keep a listing group’s status/,
    });
    // The tree comes after the budget, the campaign, its criteria, the ad group and the ad.
    const first = shop.shoppingBuild().findIndex(o => o.ad_group_criterion_operation);
    assert.deepEqual(
      [r.error.details.rule, r.error.details.operation, r.error.details.field, r.error.details.allowed],
      [
        'status_value',
        first + operation,
        'mutate_operations[' + (first + operation) + '].ad_group_criterion_operation.create.status',
        ['ENABLED'],
      ],
      label,
    );
    assert.deepEqual(
      [x.queries.length, x.validations.length, x.mutates.length],
      [0, 0, 0],
      label + ': no request of any kind, not even a read',
    );
  };
  // The nodes are the root (0), Acme (1), Beta (2, bid 900000), the excluded Zeta (3) and "Other" (4).
  await refusedAt(
    'a unit PAUSED',
    status('PAUSED', n => n.bid === '900000'),
    2,
  );
  await refusedAt(
    'the root subdivision PAUSED',
    status('PAUSED', n => n.type === 'SUBDIVISION'),
    0,
  );
  await refusedAt(
    'a status that does not exist',
    status('REMOVED', n => n.bid === '900000'),
    2,
  );
  // ENABLED, and a status left out, are the same node: prepared, executed, verified.
  for (const sent of ['ENABLED', undefined]) {
    const x = shop.shoppingCustomer();
    t.after(() => x.store.close());
    const nodes = sent ? status(sent, () => true) : shop.shoppingTree(),
      p = await x.prepare(shop.shoppingBuild({tree: shop.treeOperations({}, nodes)}));
    assert.equal(p.success, true, String(sent) + ': ' + JSON.stringify(p).slice(0, 800));
    assert.ok(
      p.data.creative_impact.build.trees[0].final_tree.includes('root > productBrand=beta [UNIT bid=900000]'),
      String(sent),
    );
    assert.equal((await x.execute(p)).success, true, String(sent));
    assert.equal((await x.verify(p)).data.status, 'verified', String(sent));
  }
  // A unit Google lists PAUSED, which the build never asked for, is not the ENABLED unit that was sent: the shape still compares a unit's status.
  const y = shop.shoppingCustomer({
    tamper: (record, name) =>
      name.includes('/adGroupCriteria/') && record.cpc_bid_micros === '900000' ? {status: 'PAUSED'} : {},
  });
  t.after(() => y.store.close());
  const q = await y.prepare(shop.shoppingBuild());
  assert.equal((await y.execute(q)).success, true);
  const v = await y.verify(q);
  assert.notEqual(v.data.status, 'verified', JSON.stringify(v.data).slice(0, 800));
  assert.equal(v.data.checks.filter(c => c.status !== 'verified').length, 1, 'only the tree differs');
});

// Package r25-m3-live (F1, F2), the lead's live run of 2026-11-20: a Standard Shopping build (J11) with everything PAUSED, executed. Google had
// created exactly what was sent, and the verification answered VERIFICATION_MISMATCH twice: the budget (explicitly_shared false) read back
// under its campaign's name, and the root SUBDIVISION, sent with no status, read back PAUSED.
test('J11 as Google answers it live is verified: the budget under its campaign’s name, every subdivision PAUSED (r25-m3-live, F1, F2)', async t => {
  const x = shop.shoppingCustomer();
  x.mode.asGoogleAnswers = true;
  t.after(() => x.store.close());
  const review = await x.prepare(shop.shoppingBuild());
  assert.equal(review.success, true, JSON.stringify(review).slice(0, 1200));
  assert.equal((await x.execute(review)).success, true);
  // The fixture answered as Google did, so the two differences were really there to be told apart from what was sent.
  const budget = [...x.created.values()].find(r => r.explicitly_shared === false),
    campaign = [...x.created.values()].find(r => r.advertising_channel_type === 'SHOPPING');
  assert.notEqual(budget.name, campaign.name, 'the build sent the budget its own name');
  const verified = await x.verify(review);
  assert.equal(verified.data.status, 'verified', JSON.stringify(verified.data).slice(0, 1500));
  assert.deepEqual(
    verified.data.checks.filter(c => c.status !== 'verified'),
    [],
  );
});
test('a Shopping tree whose read-back is not the reviewed one is not verified, and a build Google refuses leaves no part of the tree', async t => {
  // A unit whose bid reads back as another (Google changed it, or someone did): not verified, and it is the only check that differs.
  const z = shop.shoppingCustomer({
    tamper: (record, name) =>
      name.includes('/adGroupCriteria/') && record.cpc_bid_micros === '1500000' ? {cpc_bid_micros: '1600000'} : {},
  });
  t.after(() => z.store.close());
  const p = await z.prepare(shop.shoppingBuild());
  assert.equal((await z.execute(p)).success, true);
  const v = await z.verify(p);
  assert.notEqual(v.data.status, 'verified', JSON.stringify(v.data).slice(0, 600));
  assert.equal(v.data.checks.filter(c => c.status !== 'verified').length, 1, 'only the tree differs');
  // All or nothing: Google refuses the build, and nothing of it exists; the tree is one chain, never cut into parts.
  const x = shop.shoppingCustomer({reject: true});
  t.after(() => x.store.close());
  const review = await x.prepare(shop.shoppingBuild());
  assert.equal(review.success, true);
  assert.equal(review.data.group, undefined, 'one review, never a group of parts');
  assertRefused(await x.execute(review), 'UPSTREAM_ERROR');
  assert.equal(x.created.size + x.nodes.size, 0);
  assertRefused(await x.execute(review), 'WRITE_REJECTED', {writes: x.mutates.length - 1});
  assert.equal(x.mutates.length, 1, 'never sent again');
});

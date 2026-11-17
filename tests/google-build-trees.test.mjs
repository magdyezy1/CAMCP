// R2.5 M3 (r25-m3-trees, L2-09 and G5 route A): a product tree inside an all-or-nothing Google build. A Performance Max asset
// group is created with its tree under composite temporary names (`-g~-n`), and its tree is checked as the one-service tree
// review checks it. A synthetic Google answers; nothing reaches Google.
import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRefused} from './helpers/assert-refused.mjs';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {assertGoogleAtomicBuild, googleAtomicPrerequisites} from '../dist/src/google-atomic-builds.js';
import {assertGoogleListingGroups, validateGoogleListingGroupPrerequisites} from '../dist/src/google-listing-groups.js';
import {temporaryParentForms} from '../dist/src/google-temp-names.js';
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
  const verified = await x.call('amcp_campaign', {action: 'verify', review_id: review.data.review_id});
  assert.equal(verified.data.status, 'verified', JSON.stringify(verified.data).slice(0, 2000));
  assert.equal(verified.data.checks.length, 44 - 24 + 1, 'every other operation keeps its own read; the tree is one');
  const reads = x.queries.slice(before).filter(treeQuery);
  assert.equal(reads.length, 1, 'one read for the whole tree, not one per node');
  assert.match(reads[0], new RegExp("asset_group = '" + group.replace(/\//g, '\\/') + "'$"));
  // The MCP calls of this build and the provider requests it made, for the journey baseline (J10, M3 merge).
  t.diagnostic(
    'retail build: 2 MCP calls (prepare, execute) and ' +
      (x.queries.length + x.mutates.length) +
      ' provider requests with the verification read-back',
  );
});

/** The nodes of a small tree, rendered for the one-service tree review and for a build, so one malformed case meets both. */
const spec = (...nodes) => nodes;
const unit = (parent, caseValue, type = 'UNIT_INCLUDED') => ({type, parent, caseValue});
const sub = (parent, caseValue) => ({type: 'SUBDIVISION', parent, caseValue});
const brand = v => (v === undefined ? {productBrand: {}} : {productBrand: {value: v}});
const condition = v => (v === undefined ? {productCondition: {}} : {productCondition: {condition: v}});
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
  ];
  const met = new Set();
  for (const [label, nodes] of cases) {
    const review = refusalOfReview(nodes),
      build = refusalOfBuild(nodes);
    assert.ok(review, label + ': the tree review refuses it');
    assert.ok(build, label + ': the build refuses it too');
    assert.equal(build.code, review.code, label + ': ' + build.message);
    assert.equal(build.rule, review.rule, label + ': the same rule');
    if (build.rule) met.add(build.rule);
  }
  assert.ok(met.size >= 10, 'the tree rules the cases reach: ' + [...met].join(', '));
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
  assertRefused(
    refused({advertisingChannelType: 'SEARCH', shoppingSetting: {merchantId: '555'}}),
    'INVALID_LISTING_GROUP',
    {message: /SEARCH/},
  );
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
  try {
    temporaryParentForms.assetGroupListingGroupFilters = false;
    const r = await x.prepare(retailPmaxBuild());
    assertRefused(r, 'INVALID_GOOGLE_BUILD', {writes: x.mutates.length});
    assert.match(r.error.message, /create the asset group in the build, then add its tree/);
    assert.match(r.error.message, new RegExp(treeAction));
    assert.equal(r.error.details.rule, 'temporary_parent_refused');
    assert.equal(r.error.details.route, treeAction);
    assert.equal(x.queries.length, 0);
    // The other form is its own switch: this one does not touch a build without a tree.
    assert.equal((await x.prepare(retailPmaxBuild({tree: []}))).success, true);
  } finally {
    temporaryParentForms.assetGroupListingGroupFilters = true;
  }
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

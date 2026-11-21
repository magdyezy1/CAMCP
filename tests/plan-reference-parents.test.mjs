import test from 'node:test';
import assert from 'node:assert/strict';
import {at, googleReconcileFixture} from './helpers/google-reconcile-fixture.mjs';
import {retailPmaxBuild} from './fixtures/google-pmax-retail-tree.mjs';
import {providerHooks} from '../dist/src/provider-hooks.js';
import {campaignPreflight} from '../dist/src/campaign-preflight.js';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * Package r25-field3-refs, fix round item 2 (the lead's review S3-2): the parent part of a composite stand-in follows the parent, not the child. The
 * stand-in of a created resource has the parts of its resource name (item 3), and every ID part was the ordinal of the reference that names the
 * resource: the node `adGroupCriteria/{ad_group_id}~{criterion_id}` an earlier step creates was `1~1` or `2~2` whatever ad group its create names. The
 * tree reviews check that a node's parent is a node of the SAME ad group or asset group (`parent_link`: Standard Shopping, src/google-shopping-tree.ts;
 * Performance Max, src/google-listing-groups.ts), comparing the group part of the parent's name with the group the unit itself names, so a later tree
 * edit under a node an earlier step created was refused at the preflight although the real names agree (an old false alarm, kept by the first round), and a
 * unit whose ad group and parent node are both references to earlier steps was refused where the collapsed stand-ins had passed it.
 *
 * Each ID part of a composite stand-in whose create names the resource it is the ID of (`ad_group_id` by `adGroup`, `asset_id` by `asset`) is now that
 * resource's ID: the literal ID the create names, or the stand-in number of the reference it names when the step being checked names that reference too, so
 * that the unit's own ad group and the parent's ad group are the same identity. An ID Google makes up (`criterion_id`, `ad_id`), and one a create does not
 * name or names only as a temporary name outside a build, keeps the ordinal of the reference, as before; two results are two identities and one result,
 * named twice, stays one. A build's temporary names are followed to the operation that creates them. No check is loosened: a real mismatch of parents is
 * still refused (the negatives). Customer 123 and invented numbers only.
 */
const googleHook = providerHooks('google_ads_native_action').campaign.preflight.reference;
const account = {gateway: 'google_ads_native_action', account_id: '123', arguments: {action: 'a'}};
/** The stand-in the hook gives the result `ref` names, for a predecessor that mutates `collection` with this create; `known` are the references the step names. */
const standIn = (collection, create, {ordinal = 5, known = {}} = {}) =>
  googleHook({
    path: '/payload/x',
    ref: 'p#/data/results/0/resourceName',
    ordinal,
    ordinalOf: ref => known[ref],
    parent: account,
    compile: () => ({path: '/v25/customers/123/' + collection + ':mutate', body: {operations: [{create}]}}),
  });
const name = (collection, id) => 'customers/123/' + collection + '/' + id;
const ref = pointer => ({$ref: pointer});

test('the ID parts of a composite stand-in are the IDs the create names, the number of the reference it names, or the ordinal', () => {
  const group = at('adGroups', '20'),
    assetGroup = at('assetGroups', '77');
  // A parent named by its ID: the group part is that ID, and the ID Google makes up (the criterion) is the ordinal.
  assert.equal(standIn('adGroupCriteria', {adGroup: group}), name('adGroupCriteria', '20~5'));
  assert.equal(standIn('assetGroupListingGroupFilters', {assetGroup}), name('assetGroupListingGroupFilters', '77~5'));
  assert.equal(standIn('assetGroupSignals', {assetGroup}), name('assetGroupSignals', '77~5'));
  assert.equal(standIn('campaignCriteria', {campaign: at('campaigns', '10')}), name('campaignCriteria', '10~5'));
  assert.equal(standIn('adGroupBidModifiers', {adGroup: group}), name('adGroupBidModifiers', '20~5'));
  // A parent named by a reference the step names too: the group part is that reference's number.
  const known = {'ag#/data/results/0/resourceName': 3};
  assert.equal(
    standIn('adGroupCriteria', {adGroup: ref('ag#/data/results/0/resourceName')}, {known}),
    name('adGroupCriteria', '3~5'),
  );
  // A parent named by a reference the step does not name, or by none of the above: the ordinal, as the first round did.
  assert.equal(
    standIn('adGroupCriteria', {adGroup: ref('ag#/data/results/0/resourceName')}),
    name('adGroupCriteria', '5~5'),
  );
  assert.equal(
    standIn('adGroupCriteria', {adGroup: ref('ag#/data/results/0/resourceName')}, {known: {other: 9}}),
    name('adGroupCriteria', '5~5'),
  );
  assert.equal(
    standIn('adGroupCriteria', {adGroup: at('adGroups', '-1')}),
    name('adGroupCriteria', '5~5'),
    'a temporary name',
  );
  assert.equal(
    standIn('adGroupCriteria', {adGroup: 'adGroups/20'}),
    name('adGroupCriteria', '5~5'),
    'not a resource name',
  );
  assert.equal(standIn('adGroupCriteria', {}), name('adGroupCriteria', '5~5'), 'no parent named');
  assert.equal(standIn('adGroupCriteria', {adGroup: 20}), name('adGroupCriteria', '5~5'), 'not text');
});

test('every ID part a create names is that ID, and the parts that are no ID or that Google makes up are untouched', () => {
  const assetGroup = at('assetGroups', '77');
  // An association names its parent, its asset and its field type: three parts of its name.
  assert.equal(
    standIn('assetGroupAssets', {assetGroup, asset: at('assets', '500'), fieldType: 'HEADLINE'}),
    name('assetGroupAssets', '77~500~HEADLINE'),
  );
  assert.equal(
    standIn(
      'assetGroupAssets',
      {assetGroup, asset: ref('tx#/data/results/1/resourceName'), fieldType: 'HEADLINE'},
      {known: {'tx#/data/results/1/resourceName': 2}},
    ),
    name('assetGroupAssets', '77~2~HEADLINE'),
  );
  assert.equal(
    standIn('campaignAssets', {campaign: at('campaigns', '10'), asset: at('assets', '900'), fieldType: 'SITELINK'}),
    name('campaignAssets', '10~900~SITELINK'),
  );
  assert.equal(
    standIn('customerAssets', {asset: at('assets', '55'), fieldType: 'CALL'}),
    name('customerAssets', '55~CALL'),
  );
  assert.equal(
    standIn('adGroupLabels', {adGroup: at('adGroups', '20'), label: at('labels', '8')}),
    name('adGroupLabels', '20~8'),
  );
  // The ad of an ad group ad is an object Google gives an ID: the ordinal. A collection of one part is the resource's own ID, whatever the create names.
  assert.equal(
    standIn('adGroupAds', {adGroup: at('adGroups', '20'), ad: {finalUrls: ['https://example.test/']}}),
    name('adGroupAds', '20~5'),
  );
  assert.equal(
    standIn('campaigns', {campaign: at('campaigns', '9'), baseCampaign: at('campaigns', '9')}),
    name('campaigns', '5'),
  );
  assert.equal(standIn('adGroups', {adGroup: at('adGroups', '9')}), name('adGroups', '5'));
  // A part that is no ID is not read from a field of the create (the field type is, as before).
  assert.equal(standIn('adGroupCriterionLabels', {type: 'KEYWORD'}), name('adGroupCriterionLabels', '5~5~5'));
});

// ---- The preflight of a plan: the shapes of the lead's probes. ----
let tenants = 0;
const google = () => googleReconcileFixture({tenant: 'plan-reference-parents-' + ++tenants});
const step = (id, args, depends_on = []) => ({
  id,
  kind: 'write',
  gateway: 'google_ads_native_action',
  connection_id: 'g',
  account_id: '123',
  description: id,
  arguments: args,
  depends_on,
});
const criteria = 'google_ads_v23_ad_group_criterion_mutate_ad_group_criteria',
  adGroups = 'google_ads_v23_ad_group_mutate_ad_groups',
  filters = 'google_ads_v23_asset_group_listing_group_filter_mutate_asset_group_listing_group_filters';
const checks = async (f, steps) => {
  const out = await campaignPreflight(f.service, f.actor, steps);
  return id => out.checks.find(c => c.step === id);
};
const refused = check => {
  assert.equal(check.status, 'blocked', JSON.stringify(check));
  assertRefused({code: check.error.code}, ['INVALID_SHOPPING_LISTING_GROUP', 'INVALID_LISTING_GROUP']);
  assert.equal(check.error.details.rule, 'parent_link', 'the parent rule is what refuses it: ' + check.error.message);
};

// Standard Shopping. A step edits the tree of an existing ad group (the guide tells a person to split a tree of more than 500 nodes into edits that each leave
// a complete tree), and a later step adds a unit under a node the first one created.
const editTree = group => {
  const root = at('adGroupCriteria', group.split('/').at(-1) + '~-1');
  return step('tree', {
    action: criteria,
    payload: {
      operations: [
        {create: {resource_name: root, ad_group: group, listing_group: {type: 'SUBDIVISION'}}},
        {
          create: {
            ad_group: group,
            listing_group: {type: 'UNIT', parent_ad_group_criterion: root, case_value: {product_brand: {}}},
            cpc_bid_micros: '100000',
          },
        },
      ],
    },
  });
};
const unitUnder = (group, parent, depends_on) =>
  step(
    'unit',
    {
      action: criteria,
      payload: {
        operations: [
          {
            create: {
              ad_group: group,
              listing_group: {
                type: 'UNIT',
                parent_ad_group_criterion: parent,
                case_value: {product_brand: {value: 'Synthetic'}},
              },
              cpc_bid_micros: '100000',
            },
          },
        ],
      },
    },
    depends_on,
  );

test('R1: a unit under a node an earlier step created, in an ad group the plan names by ID, passes the parent rule', async () => {
  const f = google();
  try {
    const check = await checks(f, [
      editTree(at('adGroups', '20')),
      unitUnder(at('adGroups', '20'), ref('tree#/data/results/0/resourceName'), ['tree']),
    ]);
    assert.equal(check('tree').status, 'contract_checked', JSON.stringify(check('tree').error));
    assert.equal(check('unit').status, 'contract_checked', JSON.stringify(check('unit').error));
    assert.equal(check('unit').references_deferred, 1);
  } finally {
    f.close();
  }
});

// N1 (the parent rule stays): the parent is a node of another ad group than the one the unit names.
test('N1: a unit that names another ad group than its parent’s is still refused parent_link', async () => {
  const f = google();
  try {
    const check = await checks(f, [
      editTree(at('adGroups', '20')),
      unitUnder(at('adGroups', '21'), ref('tree#/data/results/0/resourceName'), ['tree']),
    ]);
    refused(check('unit'));
  } finally {
    f.close();
  }
});

// A unit whose ad group and parent node are both references: the ad group is made by one step, the node, in that ad group, by another.
const newGroup = id =>
  step(id, {
    action: adGroups,
    payload: {operations: [{create: {campaign: at('campaigns', '10'), name: 'Synthetic group', status: 'PAUSED'}}]},
  });
const rootIn = (id, group, depends_on) =>
  step(
    id,
    {
      action: criteria,
      payload: {operations: [{create: {ad_group: group, listing_group: {type: 'UNIT'}, cpc_bid_micros: '100000'}}]},
    },
    depends_on,
  );
const groupRef = id => ref(id + '#/data/results/0/resourceName');

test('R2: a unit whose ad group and parent node are both references passes the parent rule when the node is in that ad group', async () => {
  const f = google();
  try {
    const check = await checks(f, [
      newGroup('ag'),
      rootIn('root', groupRef('ag'), ['ag']),
      unitUnder(groupRef('ag'), groupRef('root'), ['ag', 'root']),
    ]);
    assert.equal(check('root').status, 'contract_checked', JSON.stringify(check('root').error));
    assert.equal(check('unit').status, 'contract_checked', JSON.stringify(check('unit').error));
    assert.equal(check('unit').references_deferred, 2);
  } finally {
    f.close();
  }
});

// N2: the node is in another ad group than the one the unit names, however each is named.
test('N2: a unit whose ad group is not the ad group of its parent node is still refused, by reference or by ID', async () => {
  const f = google();
  try {
    // The node is in the ad group the first step made; the unit names the ad group a second step made.
    const apart = await checks(f, [
      newGroup('ag'),
      newGroup('other'),
      rootIn('root', groupRef('ag'), ['ag']),
      unitUnder(groupRef('other'), groupRef('root'), ['other', 'root']),
    ]);
    refused(apart('unit'));
    // The node is in an ad group named by ID, the unit's ad group is a reference: the preflight cannot know they are the same, and they are not the same name.
    const mixed = await checks(f, [
      newGroup('ag'),
      rootIn('root', at('adGroups', '20'), []),
      unitUnder(groupRef('ag'), groupRef('root'), ['ag', 'root']),
    ]);
    refused(mixed('unit'));
  } finally {
    f.close();
  }
});

// Performance Max: the same parent rule for a listing group filter and the asset group it belongs to.
const filterTree = group => {
  const root = at('assetGroupListingGroupFilters', group.split('/').at(-1) + '~-1'),
    child = condition => ({
      create: {
        asset_group: group,
        type: 'UNIT_INCLUDED',
        listing_source: 'SHOPPING',
        parent_listing_group_filter: root,
        case_value: {product_condition: condition ? {condition} : {}},
      },
    });
  return step('tree', {
    action: filters,
    payload: {
      operations: [
        {create: {resource_name: root, asset_group: group, type: 'SUBDIVISION', listing_source: 'SHOPPING'}},
        child('NEW'),
        child(undefined),
      ],
    },
  });
};
const filterUnder = (group, parent, depends_on) =>
  step(
    'unit',
    {
      action: filters,
      payload: {
        operations: [
          {
            create: {
              asset_group: group,
              type: 'UNIT_INCLUDED',
              listing_source: 'SHOPPING',
              parent_listing_group_filter: parent,
              case_value: {product_brand: {value: 'Synthetic'}},
            },
          },
        ],
      },
    },
    depends_on,
  );

test('R3: a listing group filter under a node an earlier step created passes the parent rule, and one in another asset group is still refused', async () => {
  const f = google();
  try {
    const ok = await checks(f, [
      filterTree(at('assetGroups', '77')),
      filterUnder(at('assetGroups', '77'), ref('tree#/data/results/0/resourceName'), ['tree']),
    ]);
    assert.equal(ok('tree').status, 'contract_checked', JSON.stringify(ok('tree').error));
    assert.equal(ok('unit').status, 'contract_checked', JSON.stringify(ok('unit').error));
    const apart = await checks(f, [
      filterTree(at('assetGroups', '77')),
      filterUnder(at('assetGroups', '78'), ref('tree#/data/results/0/resourceName'), ['tree']),
    ]);
    refused(apart('unit'));
  } finally {
    f.close();
  }
});

// A build: the asset group and its tree are made by one build under temporary names (`-20`, `-20~-300`), and a later step names the asset group and a node of
// the tree by the results of the build's operations. The preflight follows the node's temporary asset group to the operation that creates it.
const buildOps = retailPmaxBuild(),
  groupOp = buildOps.findIndex(op => op.asset_group_operation),
  nodeOps = buildOps.flatMap((op, i) => (op.asset_group_listing_group_filter_operation ? [i] : []));
const build = () =>
  step('shop_build', {action: 'google_ads_v23_google_ads_mutate', payload: {mutate_operations: buildOps}});
const buildRef = (i, result) => ref('shop_build#/data/mutateOperationResponses/' + i + '/' + result + '/resourceName');

test('R4: a listing group filter under a node a build created, in the asset group the build created, passes the parent rule', async () => {
  const f = google();
  try {
    assert.equal(groupOp, 9, 'the build’s asset group is operation 9');
    assert.equal(nodeOps[0], 20, 'and the root of its tree operation 20');
    const check = await checks(f, [
      build(),
      filterUnder(buildRef(groupOp, 'assetGroupResult'), buildRef(nodeOps[0], 'assetGroupListingGroupFilterResult'), [
        'shop_build',
      ]),
    ]);
    assert.equal(check('shop_build').status, 'contract_checked', JSON.stringify(check('shop_build').error));
    assert.equal(check('unit').status, 'contract_checked', JSON.stringify(check('unit').error));
    assert.equal(check('unit').references_deferred, 2);
  } finally {
    f.close();
  }
});

test('N3: a listing group filter whose asset group is not the build’s is still refused parent_link, by ID or by another reference', async () => {
  const f = google();
  try {
    const parent = buildRef(nodeOps[0], 'assetGroupListingGroupFilterResult');
    const byId = await checks(f, [build(), filterUnder(at('assetGroups', '77'), parent, ['shop_build'])]);
    refused(byId('unit'));
    // The build's node is in the build's asset group; the unit names the asset group of another step.
    const other = step('other_group', {
      action: 'google_ads_v23_asset_group_mutate_asset_groups',
      payload: {
        operations: [
          {
            create: {
              campaign: at('campaigns', '10'),
              name: 'Synthetic group',
              final_urls: ['https://example.test/'],
              status: 'PAUSED',
            },
          },
        ],
      },
    });
    const byRef = await checks(f, [
      build(),
      other,
      filterUnder(ref('other_group#/data/results/0/resourceName'), parent, ['shop_build', 'other_group']),
    ]);
    refused(byRef('unit'));
  } finally {
    f.close();
  }
});

// The same result twice is one identity, and two results are two: the parts now carry IDs, and no check that compares two references is the weaker for it.
// Two links of one campaign, each to an asset an earlier step creates, are removed by a later step through the results of the step that created them.
const links = step(
    'links',
    {
      action: 'google_ads_v23_campaign_asset_mutate_campaign_assets',
      payload: {
        operations: [0, 1].map(i => ({
          create: {
            campaign: at('campaigns', '10'),
            field_type: 'SITELINK',
            asset: ref('texts#/data/results/' + i + '/resourceName'),
          },
        })),
      },
    },
    ['texts'],
  ),
  texts = step('texts', {
    action: 'google_ads_v23_asset_mutate_assets',
    payload: {operations: [0, 1].map(i => ({create: {text_asset: {text: 'Synthetic text ' + i}}}))},
  }),
  unlink = (...results) =>
    step(
      'unlink',
      {
        action: 'google_ads_v23_campaign_asset_mutate_campaign_assets',
        payload: {operations: results.map(i => ({remove: ref('links#/data/results/' + i + '/resourceName')}))},
      },
      ['links'],
    );

test('N4: two references to one link are still one result, and two links of one campaign are two results', async () => {
  const f = google();
  try {
    const same = await checks(f, [texts, links, unlink(0, 0)]);
    assert.equal(
      same('unlink').status,
      'blocked',
      'one link named twice is a duplicate: ' + JSON.stringify(same('unlink')),
    );
    assertRefused({code: same('unlink').error.code}, 'INVALID_ASSET_LINK');
    const apart = await checks(f, [texts, links, unlink(0, 1)]);
    assert.equal(apart('unlink').status, 'contract_checked', JSON.stringify(apart('unlink').error));
  } finally {
    f.close();
  }
});

// R2.5 M3 (r25-m3-trees, L2-07): every input refusal of the listing group modules (Performance Max, Standard Shopping, the shared
// tree module) and of a build's temporary names and trees names the field it is about; the operation, when one operation is at
// fault; and `allowed`, the closed list a value was refused against, where there is one. A build spells its fields as its own
// payload does (snake_case keys, mutate_operations). The three codes that now have a remedy name the next call, in English and in
// Arabic. Nothing here reaches a provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {assertRefused} from './helpers/assert-refused.mjs';
import {MirrorError, errorRemedy} from '../dist/src/errors.js';
import {
  assertGoogleListingGroups,
  pmaxCreate,
  validateGoogleListingGroupPrerequisites,
} from '../dist/src/google-listing-groups.js';
import {
  assertGoogleShoppingTree,
  shoppingCreate,
  validateGoogleShoppingTreePrerequisites,
} from '../dist/src/google-shopping-tree.js';
import {assertGoogleAtomicBuild} from '../dist/src/google-atomic-builds.js';
import {chainTooLong, withTemporaryParentForms} from '../dist/src/google-temp-names.js';
import * as treeModule from '../dist/src/google-tree.js';
import {googleRemedies} from '../dist/src/google-remedies.js';
import {retailPmaxBuild} from './fixtures/google-pmax-retail-tree.mjs';
import * as shop from './fixtures/google-shopping-build.mjs';

const google = 'google_ads_native_action',
  at = (collection, id) => 'customers/123/' + collection + '/' + id;
const plan = (path, body, action, extra = {}) => ({
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
  accountId: '123',
  evidence: '',
  warnings: [],
  ...extra,
});
const pmaxAction = 'google_ads_v23_asset_group_listing_group_filter_mutate_asset_group_listing_group_filters',
  shoppingAction = 'google_ads_v23_ad_group_criterion_mutate_ad_group_criteria',
  buildAction = 'google_ads_v23_google_ads_mutate';
const pmaxPlan = (body, extra) =>
  plan('/v25/customers/123/assetGroupListingGroupFilters:mutate', body, pmaxAction, extra);
const shoppingPlan = (body, extra) => plan('/v25/customers/123/adGroupCriteria:mutate', body, shoppingAction, extra);
const buildPlan = operations =>
  plan('/v25/customers/123/googleAds:mutate', {mutate_operations: operations}, buildAction);
const thrown = (fn, label = '') => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  assert.fail('a refusal was expected: ' + label);
};
/**
 * The closed rule each refusal of this file carries (R2.5 M3 round 2, S4-4), by the label of its case: a rule of `treeRules` (about
 * the tree) or of `nodeRules` (about one create, one operation, or a tree inside a build). `null` is a refusal about the whole request
 * or about what the review read of Google (the query, the body, the number of operations, the campaign), which has none.
 */
const ruleOf = {
  'an unknown key': 'create_keys',
  'another customer’s asset group': 'create_group',
  'another customer’s ad group': 'create_group',
  'a type that does not exist': 'node_type',
  'a webpage listing source': 'listing_source',
  'a name that is not temporary': 'node_name',
  'a subdivision without a name': 'subdivision_unnamed',
  'a parent in another asset group': 'parent_link',
  'a parent in another ad group': 'parent_link',
  'a root with a case value': 'root_case_value',
  'an unknown dimension': 'dimension_kind',
  'an unsupported dimension': 'dimension_kind',
  'a query override': null,
  'a header override': null,
  'a key beside operations': null,
  'a response content type that is not the one': null,
  'no operation': null,
  'too many operations': null,
  'the removal of a node that is not an existing one': 'remove_target',
  'the same node twice': 'node_twice',
  'an operation that is neither a create nor a remove': 'operation_kind',
  'a campaign that is not Performance Max': null,
  'an asset group that is removed': null,
  'an ad group that is not Standard Shopping': null,
  'an ad group that is removed': null,
  'a tree left empty': 'empty_tree',
  'an unknown listing group key': 'listing_group_keys',
  'a listing group type that does not exist': 'node_type',
  'a negative that is no boolean': 'negative_value',
  'a status that does not exist': 'status_value',
  'a status Google does not keep': 'status_value',
  'a bid that is no number of micros': 'bid_value',
  'more asset groups than a review takes': 'group_limit',
  'a node of another ad group': 'one_group',
  'a criterion that is no listing group': 'other_criterion',
  'an operation of no type': null,
  'an update': null,
  'a keyword named by a temporary name': null,
  'a number used twice': null,
  'a parent that no earlier operation creates': null,
  'a parent that is no resource name': null,
  'a temporary name in a field that does not take one': null,
  'a resource of another customer': null,
  'a Performance Max node of a type that does not exist': 'node_type',
  'a Performance Max node with a parent in another asset group': 'parent_link',
  'a Shopping node of a type that does not exist': 'node_type',
  'a Shopping node with a parent in another ad group': 'parent_link',
  'a Shopping node with a bid that is no number': 'bid_value',
  'a subdivision without its "Other" node': 'other_missing',
  'a bid on a Shopping subdivision in a build': 'bid_on_subdivision',
  'a bid on an excluded Shopping unit in a build': 'bid_on_excluded_unit',
  'a child before its parent': 'missing_parent',
  'a tree of an asset group that exists': 'tree_of_existing_group',
  'a tree of an ad group that exists': 'tree_of_existing_group',
  'a tree under a new asset group while its form is off': 'temporary_parent_refused',
  'a tree under a new ad group while its form is off': 'temporary_parent_refused',
};
/** The rules the refusals of this file have met: the closed set must be met whole (the last test of the file). */
const metRules = new Set();
/** The refusal `fn` throws has this code, names this field, and this operation (none when undefined), the list it was refused against, and its closed rule. */
function refusal(label, fn, code, {field, operation, allowed, limit}) {
  const e = thrown(fn, label);
  assertRefused(e, code);
  assert.equal(e.details.field, field, label + ': field (' + e.message.slice(0, 120) + ')');
  assert.equal(e.details.operation, operation, label + ': operation');
  if (allowed !== undefined) assert.deepEqual(e.details.allowed, allowed, label + ': allowed');
  if (limit !== undefined) assert.equal(e.details.limit, limit, label + ': limit');
  assert.ok(
    Object.hasOwn(ruleOf, label),
    label + ': the case names its rule, or null for a refusal about the whole request',
  );
  const expected = ruleOf[label];
  assert.equal(e.details.rule, expected ?? undefined, label + ': rule');
  if (expected) {
    assert.ok(
      treeModule.treeRules.includes(expected) || treeModule.nodeRules.includes(expected),
      label + ': ' + expected + ' is in a closed set',
    );
    metRules.add(expected);
  }
  return e;
}

// ----- Performance Max -----
const pmaxGroup = at('assetGroups', '500'),
  pmaxRoot = {assetGroup: pmaxGroup, type: 'UNIT_INCLUDED', listingSource: 'SHOPPING'},
  pmaxNode = id => at('assetGroupListingGroupFilters', '500~' + id),
  pmaxCode = 'INVALID_LISTING_GROUP';
const pmaxCreateOf = create => pmaxCreate('123', create, 'operations[0]', 0);

test('Performance Max: every refusal of a create names its operation and field, and the closed list where there is one', () => {
  const keys = ['resourceName', 'assetGroup', 'type', 'listingSource', 'caseValue', 'parentListingGroupFilter'],
    f = name => 'operations[0].create' + name;
  refusal('an unknown key', () => pmaxCreateOf({...pmaxRoot, bogus: 1}), pmaxCode, {
    field: f(''),
    operation: 0,
    allowed: keys,
  });
  refusal(
    'another customer’s asset group',
    () => pmaxCreateOf({...pmaxRoot, assetGroup: 'customers/9/assetGroups/5'}),
    pmaxCode,
    {
      field: f('.assetGroup'),
      operation: 0,
    },
  );
  refusal('a type that does not exist', () => pmaxCreateOf({...pmaxRoot, type: 'UNIT'}), pmaxCode, {
    field: f('.type'),
    operation: 0,
    allowed: ['SUBDIVISION', 'UNIT_INCLUDED', 'UNIT_EXCLUDED'],
  });
  refusal('a webpage listing source', () => pmaxCreateOf({...pmaxRoot, listingSource: 'WEBPAGE'}), pmaxCode, {
    field: f('.listingSource'),
    operation: 0,
    allowed: ['SHOPPING'],
  });
  refusal('a name that is not temporary', () => pmaxCreateOf({...pmaxRoot, resourceName: pmaxNode('7')}), pmaxCode, {
    field: f('.resourceName'),
    operation: 0,
  });
  refusal('a subdivision without a name', () => pmaxCreateOf({...pmaxRoot, type: 'SUBDIVISION'}), pmaxCode, {
    field: f('.resourceName'),
    operation: 0,
  });
  refusal(
    'a parent in another asset group',
    () =>
      pmaxCreateOf({
        ...pmaxRoot,
        parentListingGroupFilter: at('assetGroupListingGroupFilters', '501~-1'),
        caseValue: {productBrand: {}},
      }),
    pmaxCode,
    {field: f('.parentListingGroupFilter'), operation: 0},
  );
  refusal('a root with a case value', () => pmaxCreateOf({...pmaxRoot, caseValue: {productBrand: {}}}), pmaxCode, {
    field: f('.caseValue'),
    operation: 0,
  });
  refusal(
    'an unknown dimension',
    () =>
      pmaxCreateOf({
        ...pmaxRoot,
        parentListingGroupFilter: pmaxNode('-1'),
        caseValue: {webpage: {}},
      }),
    pmaxCode,
    {
      field: f('.caseValue'),
      operation: 0,
      allowed: [
        'productBrand',
        'productCategory',
        'productChannel',
        'productCondition',
        'productCustomAttribute',
        'productItemId',
        'productType',
      ],
    },
  );
});
test('Performance Max: the refusals of a whole request name its field, and the operation where one is at fault', () => {
  const ok = [{create: {...pmaxRoot}}];
  refusal(
    'a query override',
    () => assertGoogleListingGroups(pmaxPlan({operations: ok}, {query: {x: '1'}})),
    pmaxCode,
    {
      field: 'query',
    },
  );
  refusal(
    'a header override',
    () => assertGoogleListingGroups(pmaxPlan({operations: ok}, {headers: {h: '1'}})),
    pmaxCode,
    {
      field: 'headers',
    },
  );
  refusal(
    'a key beside operations',
    () => assertGoogleListingGroups(pmaxPlan({operations: ok, validateOnly: true})),
    pmaxCode,
    {field: 'validateOnly', allowed: ['operations', 'responseContentType']},
  );
  refusal(
    'a response content type that is not the one',
    () => assertGoogleListingGroups(pmaxPlan({operations: ok, responseContentType: 'MUTABLE_RESOURCE'})),
    pmaxCode,
    {field: 'responseContentType', allowed: ['RESOURCE_NAME_ONLY']},
  );
  refusal('no operation', () => assertGoogleListingGroups(pmaxPlan({operations: []})), pmaxCode, {
    field: 'operations',
    limit: 500,
  });
  refusal(
    'the removal of a node that is not an existing one',
    () => assertGoogleListingGroups(pmaxPlan({operations: [{remove: pmaxNode('-1')}]})),
    pmaxCode,
    {field: 'operations[0].remove', operation: 0},
  );
  refusal(
    'the same node twice',
    () =>
      assertGoogleListingGroups(
        pmaxPlan({
          operations: [
            {create: {...pmaxRoot, type: 'SUBDIVISION', resourceName: pmaxNode('-1')}},
            {create: {...pmaxRoot, type: 'SUBDIVISION', resourceName: pmaxNode('-1')}},
          ],
        }),
      ),
    pmaxCode,
    {field: 'operations[1].create.resourceName', operation: 1},
  );
  refusal(
    'an operation that is neither a create nor a remove',
    () =>
      assertGoogleListingGroups(
        pmaxPlan({operations: [{update: {resourceName: pmaxNode('10'), type: 'UNIT_EXCLUDED'}, updateMask: 'type'}]}),
      ),
    pmaxCode,
    {field: 'operations[0]', operation: 0, allowed: ['create', 'remove']},
  );
  // A review edits the trees of at most ten asset groups (G4b): the eleventh is the operation at fault.
  refusal(
    'more asset groups than a review takes',
    () =>
      assertGoogleListingGroups(
        pmaxPlan({
          operations: Array.from({length: 11}, (_, i) => ({
            remove: at('assetGroupListingGroupFilters', 600 + i + '~10'),
          })),
        }),
      ),
    pmaxCode,
    {field: 'operations[10].remove', operation: 10, limit: 10},
  );
});

test('Performance Max: what the review reads of the asset group and its campaign is refused at the operation that names the group', () => {
  const state = (campaign, group = {status: 'PAUSED'}) => [
    {asset_group: {resource_name: pmaxGroup, ...group}, campaign},
    {nodes: []},
  ];
  const p = pmaxPlan({
    operations: [
      {create: {...pmaxRoot, type: 'SUBDIVISION', resourceName: pmaxNode('-1')}},
      {create: {...pmaxRoot, parentListingGroupFilter: pmaxNode('-1'), caseValue: {productBrand: {}}}},
      {create: {...pmaxRoot, parentListingGroupFilter: pmaxNode('-1'), caseValue: {productBrand: {value: 'a'}}}},
    ],
  });
  refusal(
    'a campaign that is not Performance Max',
    () => validateGoogleListingGroupPrerequisites(p, state({advertising_channel_type: 'SEARCH', merchant_id: '5'})),
    pmaxCode,
    {field: 'operations[0].create.assetGroup', operation: 0},
  );
  refusal(
    'an asset group that is removed',
    () =>
      validateGoogleListingGroupPrerequisites(
        p,
        state({advertising_channel_type: 'PERFORMANCE_MAX', merchant_id: '5'}, {status: 'REMOVED'}),
      ),
    pmaxCode,
    {field: 'operations[0].create.assetGroup', operation: 0, allowed: ['ENABLED', 'PAUSED']},
  );
  // The tree the request leaves, as a whole: no node is created, and the root is removed.
  const onlyRoot = pmaxPlan({operations: [{remove: pmaxNode('9')}]});
  const existing = [
    {
      asset_group: {resource_name: pmaxGroup, status: 'PAUSED'},
      campaign: {advertising_channel_type: 'PERFORMANCE_MAX', merchant_id: '5'},
    },
    {
      nodes: [
        {
          resource_name: pmaxNode('9'),
          type: 'UNIT_INCLUDED',
          listing_source: 'SHOPPING',
          parent: null,
          case_value: null,
        },
      ],
    },
  ];
  const e = refusal('a tree left empty', () => validateGoogleListingGroupPrerequisites(onlyRoot, existing), pmaxCode, {
    field: 'operations',
  });
  assert.equal(e.details.rule, 'empty_tree');
});

// ----- Standard Shopping -----
const shoppingGroup = at('adGroups', '500'),
  shoppingRoot = {adGroup: shoppingGroup, listingGroup: {type: 'UNIT'}},
  shoppingNode = id => at('adGroupCriteria', '500~' + id),
  shoppingCode = 'INVALID_SHOPPING_LISTING_GROUP';
const shoppingCreateOf = create => shoppingCreate('123', create, 'operations[0]', 0);

test('Standard Shopping: every refusal of a create names its operation and field, and the closed list where there is one', () => {
  const f = name => 'operations[0].create' + name;
  refusal('an unknown key', () => shoppingCreateOf({...shoppingRoot, bogus: 1}), shoppingCode, {
    field: f(''),
    operation: 0,
    allowed: ['resourceName', 'adGroup', 'listingGroup', 'negative', 'cpcBidMicros', 'status'],
  });
  refusal(
    'another customer’s ad group',
    () => shoppingCreateOf({...shoppingRoot, adGroup: 'customers/9/adGroups/5'}),
    shoppingCode,
    {
      field: f('.adGroup'),
      operation: 0,
    },
  );
  refusal(
    'an unknown listing group key',
    () => shoppingCreateOf({...shoppingRoot, listingGroup: {type: 'UNIT', x: 1}}),
    shoppingCode,
    {
      field: f('.listingGroup'),
      operation: 0,
      allowed: ['type', 'caseValue', 'parentAdGroupCriterion'],
    },
  );
  refusal(
    'a listing group type that does not exist',
    () => shoppingCreateOf({...shoppingRoot, listingGroup: {type: 'UNIT_INCLUDED'}}),
    shoppingCode,
    {
      field: f('.listingGroup.type'),
      operation: 0,
      allowed: ['SUBDIVISION', 'UNIT'],
    },
  );
  refusal('a negative that is no boolean', () => shoppingCreateOf({...shoppingRoot, negative: 'yes'}), shoppingCode, {
    field: f('.negative'),
    operation: 0,
  });
  // Package r25-m3-live (F2) changed this case: the `allowed` list was ['ENABLED', 'PAUSED']. Google does not keep a listing group's status
  // (the lead's live runs of 2026-11-20), so a create may send ENABLED only, and PAUSED is refused by the same rule as a status that does not exist.
  refusal('a status that does not exist', () => shoppingCreateOf({...shoppingRoot, status: 'REMOVED'}), shoppingCode, {
    field: f('.status'),
    operation: 0,
    allowed: ['ENABLED'],
  });
  refusal('a status Google does not keep', () => shoppingCreateOf({...shoppingRoot, status: 'PAUSED'}), shoppingCode, {
    field: f('.status'),
    operation: 0,
    allowed: ['ENABLED'],
  });
  refusal(
    'a bid that is no number of micros',
    () => shoppingCreateOf({...shoppingRoot, cpcBidMicros: 'abc'}),
    shoppingCode,
    {
      field: f('.cpcBidMicros'),
      operation: 0,
    },
  );
  refusal(
    'a name that is not temporary',
    () => shoppingCreateOf({...shoppingRoot, resourceName: shoppingNode('7')}),
    shoppingCode,
    {
      field: f('.resourceName'),
      operation: 0,
    },
  );
  refusal(
    'a subdivision without a name',
    () => shoppingCreateOf({...shoppingRoot, listingGroup: {type: 'SUBDIVISION'}}),
    shoppingCode,
    {field: f('.resourceName'), operation: 0},
  );
  refusal(
    'a parent in another ad group',
    () =>
      shoppingCreateOf({
        ...shoppingRoot,
        listingGroup: {
          type: 'UNIT',
          parentAdGroupCriterion: at('adGroupCriteria', '501~-1'),
          caseValue: {productBrand: {}},
        },
      }),
    shoppingCode,
    {field: f('.listingGroup.parentAdGroupCriterion'), operation: 0},
  );
  refusal(
    'a root with a case value',
    () => shoppingCreateOf({...shoppingRoot, listingGroup: {type: 'UNIT', caseValue: {productBrand: {}}}}),
    shoppingCode,
    {field: f('.listingGroup.caseValue'), operation: 0},
  );
  refusal(
    'an unsupported dimension',
    () =>
      shoppingCreateOf({
        ...shoppingRoot,
        listingGroup: {type: 'UNIT', parentAdGroupCriterion: shoppingNode('-1'), caseValue: {hotelId: {value: 'h'}}},
      }),
    shoppingCode,
    {
      field: f('.listingGroup.caseValue'),
      operation: 0,
      allowed: [
        'productBrand',
        'productCategory',
        'productChannel',
        'productChannelExclusivity',
        'productCondition',
        'productCustomAttribute',
        'productItemId',
        'productType',
      ],
    },
  );
});

test('Standard Shopping: the refusals of a whole request and of what the review read name their field, and the operation where one is at fault', () => {
  const ok = [{create: {...shoppingRoot}}];
  refusal(
    'a query override',
    () => assertGoogleShoppingTree(shoppingPlan({operations: ok}, {query: {x: '1'}})),
    shoppingCode,
    {
      field: 'query',
    },
  );
  refusal(
    'a key beside operations',
    () => assertGoogleShoppingTree(shoppingPlan({operations: ok, validateOnly: true})),
    shoppingCode,
    {field: 'validateOnly', allowed: ['operations', 'responseContentType']},
  );
  // A request with no listing group create is the targeting family's, not this review's, so the count that is refused is the top one.
  refusal(
    'too many operations',
    () =>
      assertGoogleShoppingTree(
        shoppingPlan({
          operations: [
            {create: {...shoppingRoot}},
            ...Array.from({length: 500}, (_, i) => ({remove: shoppingNode(String(100 + i))})),
          ],
        }),
      ),
    shoppingCode,
    {field: 'operations', limit: 500},
  );
  refusal(
    'the same node twice',
    () =>
      assertGoogleShoppingTree(
        shoppingPlan({
          operations: [
            {create: {...shoppingRoot, resourceName: shoppingNode('-1'), listingGroup: {type: 'SUBDIVISION'}}},
            {create: {...shoppingRoot, resourceName: shoppingNode('-1'), listingGroup: {type: 'SUBDIVISION'}}},
          ],
        }),
      ),
    shoppingCode,
    {field: 'operations[1].create.resourceName', operation: 1},
  );
  // The operations of one review: one ad group, a node that exists to remove, a create or a remove, a listing group.
  refusal(
    'a node of another ad group',
    () =>
      assertGoogleShoppingTree(
        shoppingPlan({operations: [{create: {...shoppingRoot}}, {remove: at('adGroupCriteria', '56~9')}]}),
      ),
    shoppingCode,
    {field: 'operations[1].remove', operation: 1},
  );
  refusal(
    'the removal of a node that is not an existing one',
    () =>
      assertGoogleShoppingTree(shoppingPlan({operations: [{create: {...shoppingRoot}}, {remove: shoppingNode('-1')}]})),
    shoppingCode,
    {field: 'operations[1].remove', operation: 1},
  );
  refusal(
    'an operation that is neither a create nor a remove',
    () =>
      assertGoogleShoppingTree(
        shoppingPlan({
          operations: [
            {create: {...shoppingRoot}},
            {update: {resourceName: shoppingNode('9'), cpcBidMicros: '1'}, updateMask: 'cpcBidMicros'},
          ],
        }),
      ),
    shoppingCode,
    {field: 'operations[1]', operation: 1, allowed: ['create', 'remove']},
  );
  refusal(
    'a criterion that is no listing group',
    () =>
      assertGoogleShoppingTree(
        shoppingPlan({
          operations: [
            {create: {...shoppingRoot}},
            {create: {adGroup: shoppingGroup, keyword: {text: 'acme', matchType: 'EXACT'}}},
          ],
        }),
      ),
    shoppingCode,
    {field: 'operations[1].create', operation: 1},
  );
  const p = shoppingPlan({
    operations: [
      {create: {...shoppingRoot, resourceName: shoppingNode('-1'), listingGroup: {type: 'SUBDIVISION'}}},
      {
        create: {
          adGroup: shoppingGroup,
          listingGroup: {type: 'UNIT', parentAdGroupCriterion: shoppingNode('-1'), caseValue: {productBrand: {}}},
        },
      },
      {
        create: {
          adGroup: shoppingGroup,
          listingGroup: {
            type: 'UNIT',
            parentAdGroupCriterion: shoppingNode('-1'),
            caseValue: {productBrand: {value: 'a'}},
          },
        },
      },
    ],
  });
  const state = (adGroup, campaign) => [{ad_group: {resource_name: shoppingGroup, ...adGroup}, campaign}, {nodes: []}];
  const shoppingCampaign = {advertising_channel_type: 'SHOPPING', merchant_id: '5'};
  refusal(
    'an ad group that is not Standard Shopping',
    () =>
      validateGoogleShoppingTreePrerequisites(p, state({status: 'PAUSED', type: 'SEARCH_STANDARD'}, shoppingCampaign)),
    shoppingCode,
    {field: 'operations[0].create.adGroup', operation: 0},
  );
  refusal(
    'an ad group that is removed',
    () =>
      validateGoogleShoppingTreePrerequisites(
        p,
        state({status: 'REMOVED', type: 'SHOPPING_PRODUCT_ADS'}, shoppingCampaign),
      ),
    shoppingCode,
    {field: 'operations[0].create.adGroup', operation: 0, allowed: ['ENABLED', 'PAUSED']},
  );
});

// ----- Builds -----
test('a build names the operation and field of each refusal of its temporary names, in the spelling of its own payload', () => {
  const budget = n => ({
    campaign_budget_operation: {
      create: {resource_name: at('campaignBudgets', '-' + n), name: 'DNU budget ' + n, amount_micros: '1000000'},
    },
  });
  const build = ops => () =>
    assertGoogleAtomicBuild(
      buildPlan(ops),
      () => {},
      () => {},
    );
  const code = 'INVALID_GOOGLE_BUILD';
  const types = refusal('an operation of no type', build([{bogus_operation: {}}]), code, {
    field: 'mutate_operations[0]',
    operation: 0,
  });
  for (const key of [
    'campaign_operation',
    'ad_group_criterion_operation',
    'asset_group_listing_group_filter_operation',
  ])
    assert.ok(types.details.allowed.includes(key), key);
  refusal('an update', build([{campaign_budget_operation: {update: {}}}]), code, {
    field: 'mutate_operations[0].campaign_budget_operation',
    operation: 0,
  });
  // The lead's review of the M3 merge, S4-3: the path a message names is the path its details name, with the operation's key.
  const namesItsField = e =>
    assert.ok(
      e.message.startsWith(e.details.field + ' '),
      'the message starts with its field: ' + e.message.slice(0, 140),
    );
  const named = refusal(
    'a keyword named by a temporary name',
    build([
      ...shop.shoppingBuild({tree: []}),
      {
        ad_group_criterion_operation: {
          create: {
            resource_name: at('adGroupCriteria', '-9'),
            ad_group: at('adGroups', '-3'),
            keyword: {text: 'a', match_type: 'EXACT'},
          },
        },
      },
    ]),
    code,
    // The build field rule (the M3 merge's last code commit): the path in the build's own payload, with the operation's key.
    {field: 'mutate_operations[6].ad_group_criterion_operation.create.resource_name', operation: 6},
  );
  namesItsField(named);
  refusal('a number used twice', build([budget(1), budget(1)]), code, {
    field: 'mutate_operations[1].campaign_budget_operation.create.resource_name',
    operation: 1,
  });
  const orphan = refusal(
    'a parent that no earlier operation creates',
    build([
      {
        ad_group_operation: {
          create: {name: 'g', campaign: at('campaigns', '-5'), status: 'PAUSED', type: 'SEARCH_STANDARD'},
        },
      },
    ]),
    code,
    {field: 'mutate_operations[0].ad_group_operation.create.campaign', operation: 0},
  );
  namesItsField(orphan);
  const noName = refusal(
    'a parent that is no resource name',
    build([{ad_group_operation: {create: {name: 'g', campaign: 'DNU', status: 'PAUSED'}}}]),
    code,
    {field: 'mutate_operations[0].ad_group_operation.create.campaign', operation: 0},
  );
  namesItsField(noName);
  // A refusal about the whole operation, with its key known, names the operation and its key (S4-3: the rule's last bullet).
  refusal(
    'a temporary name in a field that does not take one',
    build([{campaign_budget_operation: {create: {name: at('campaigns', '-4'), amount_micros: '1'}}}]),
    code,
    {field: 'mutate_operations[0].campaign_budget_operation', operation: 0},
  );
  refusal(
    'a resource of another customer',
    build([{campaign_budget_operation: {create: {name: 'customers/999/campaignBudgets/5', amount_micros: '1'}}}]),
    code,
    {field: 'mutate_operations[0].campaign_budget_operation', operation: 0},
  );
});

test('the nodes of a tree in a build are refused in the build’s own spelling: snake_case fields, the operation, the closed lists, mutate_operations for the whole tree', () => {
  const build = ops => () =>
    assertGoogleAtomicBuild(
      buildPlan(ops),
      () => {},
      () => {},
    );
  const pmaxOps = retailPmaxBuild(),
    firstNode = pmaxOps.findIndex(o => o.asset_group_listing_group_filter_operation);
  const withNode = (ops, index, key, change) =>
    ops.map((o, i) => (i === index ? {[key]: {create: {...o[key].create, ...change}}} : o));
  const pmaxKey = 'asset_group_listing_group_filter_operation';
  refusal(
    'a Performance Max node of a type that does not exist',
    build(withNode(pmaxOps, firstNode, pmaxKey, {type: 'UNIT'})),
    pmaxCode,
    {
      field: 'mutate_operations[' + firstNode + '].' + pmaxKey + '.create.type',
      operation: firstNode,
      allowed: ['SUBDIVISION', 'UNIT_INCLUDED', 'UNIT_EXCLUDED'],
    },
  );
  refusal(
    'a Performance Max node with a parent in another asset group',
    build(
      withNode(pmaxOps, firstNode + 1, pmaxKey, {
        parent_listing_group_filter: at('assetGroupListingGroupFilters', '501~-1'),
      }),
    ),
    pmaxCode,
    {
      field: 'mutate_operations[' + (firstNode + 1) + '].' + pmaxKey + '.create.parent_listing_group_filter',
      operation: firstNode + 1,
    },
  );
  const shoppingOps = shop.shoppingBuild(),
    first = shoppingOps.findIndex(o => o.ad_group_criterion_operation),
    key = 'ad_group_criterion_operation';
  const listing = (index, change) => {
    const create = shoppingOps[index][key].create;
    return withNode(shoppingOps, index, key, {listing_group: {...create.listing_group, ...change}});
  };
  refusal(
    'a Shopping node of a type that does not exist',
    build(listing(first, {type: 'UNIT_INCLUDED'})),
    shoppingCode,
    {
      field: 'mutate_operations[' + first + '].' + key + '.create.listing_group.type',
      operation: first,
      allowed: ['SUBDIVISION', 'UNIT'],
    },
  );
  refusal(
    'a Shopping node with a parent in another ad group',
    build(listing(first + 1, {parent_ad_group_criterion: at('adGroupCriteria', '501~-1')})),
    shoppingCode,
    {
      field: 'mutate_operations[' + (first + 1) + '].' + key + '.create.listing_group.parent_ad_group_criterion',
      operation: first + 1,
    },
  );
  refusal(
    'a Shopping node with a bid that is no number',
    build(withNode(shoppingOps, first + 1, key, {cpc_bid_micros: 'abc'})),
    shoppingCode,
    {
      field: 'mutate_operations[' + (first + 1) + '].' + key + '.create.cpc_bid_micros',
      operation: first + 1,
    },
  );
  // A bid on a subdivision, and on an excluded unit: the tree rules name the bid in the build’s own key, cpc_bid_micros, where a review’s
  // create has cpcBidMicros (R2.5 M3 round 3, N1).
  const withBid = change => build(shop.shoppingBuild({tree: shop.treeOperations({}, shop.shoppingTree().map(change))}));
  refusal(
    'a bid on a Shopping subdivision in a build',
    withBid(n => (n.type === 'SUBDIVISION' ? {...n, bid: '1500000'} : n)),
    shoppingCode,
    {field: 'mutate_operations[' + first + '].' + key + '.create.cpc_bid_micros', operation: first},
  );
  refusal(
    'a bid on an excluded Shopping unit in a build',
    withBid(n => (n.negative ? {...n, bid: '100000'} : n)),
    shoppingCode,
    {field: 'mutate_operations[' + (first + 3) + '].' + key + '.create.cpc_bid_micros', operation: first + 3},
  );
  // A tree rule names the node it is about, by the build’s own path to it.
  const incomplete = shoppingOps.filter((_, i) => i !== first + 4);
  const e = refusal('a subdivision without its "Other" node', build(incomplete), shoppingCode, {
    field: 'mutate_operations[' + first + '].' + key + '.create',
    operation: first,
  });
  assert.equal(e.details.rule, 'other_missing');
  assert.match(e.message, new RegExp('^mutate_operations\\[' + first + '\\]: '));
  // A child created before its parent names the build’s field for the parent link.
  const reordered = [
    ...shoppingOps.slice(0, first),
    shoppingOps[first + 1],
    shoppingOps[first],
    ...shoppingOps.slice(first + 2),
  ];
  const before = refusal('a child before its parent', build(reordered), shoppingCode, {
    field: 'mutate_operations[' + first + '].' + key + '.create.listing_group.parent_ad_group_criterion',
    operation: first,
  });
  assert.equal(before.details.rule, 'missing_parent');
  // A tree of an asset group or ad group that exists is no build's, and a form Google may refuse is one switch (S4-4: both have a rule).
  const existingGroup = ops =>
    ops.map(o => {
      const k = Object.keys(o)[0];
      return o[k].create?.asset_group || o[k].create?.listing_group
        ? {
            [k]: {
              create: {
                ...o[k].create,
                ...(o[k].create.asset_group
                  ? {asset_group: at('assetGroups', '55')}
                  : {ad_group: at('adGroups', '55')}),
              },
            },
          }
        : o;
    });
  refusal('a tree of an asset group that exists', build(existingGroup(pmaxOps)), 'INVALID_GOOGLE_BUILD', {
    field: 'mutate_operations[' + firstNode + '].' + pmaxKey + '.create.asset_group',
    operation: firstNode,
  });
  refusal('a tree of an ad group that exists', build(existingGroup(shoppingOps)), 'INVALID_GOOGLE_BUILD', {
    field: 'mutate_operations[' + first + '].' + key + '.create.ad_group',
    operation: first,
  });
});

test('a tree under a new asset group or ad group is refused while its form is off, with its rule (R2.5 M3 round 2, S4-4)', async () => {
  const build = ops => () =>
    assertGoogleAtomicBuild(
      buildPlan(ops),
      () => {},
      () => {},
    );
  const pmaxOps = retailPmaxBuild(),
    shoppingOps = shop.shoppingBuild();
  await withTemporaryParentForms({assetGroupListingGroupFilters: false}, () =>
    refusal('a tree under a new asset group while its form is off', build(pmaxOps), 'INVALID_GOOGLE_BUILD', {
      field:
        'mutate_operations[' +
        pmaxOps.findIndex(o => o.asset_group_listing_group_filter_operation) +
        '].asset_group_listing_group_filter_operation.create.asset_group',
      operation: pmaxOps.findIndex(o => o.asset_group_listing_group_filter_operation),
    }),
  );
  await withTemporaryParentForms({adGroupCriteria: false}, () =>
    refusal('a tree under a new ad group while its form is off', build(shoppingOps), 'INVALID_GOOGLE_BUILD', {
      field:
        'mutate_operations[' +
        shoppingOps.findIndex(o => o.ad_group_criterion_operation) +
        '].ad_group_criterion_operation.create.ad_group',
      operation: shoppingOps.findIndex(o => o.ad_group_criterion_operation),
    }),
  );
});

test('a chain of temporary names over its route’s limit names its field, and the three tree and chain codes carry a remedy that names the next call, in English and in Arabic', () => {
  for (const [limit, route] of [
    [25, 'google_ads_v23_campaign_mutate_campaigns'],
    [500, pmaxAction],
    [1000, buildAction],
  ]) {
    const e = chainTooLong(limit + 1, limit, route);
    assert.deepEqual(e.details, {operations: limit + 1, limit, route, field: 'operations'});
  }
  const remedy = (code, details) => errorRemedy(new MirrorError(code, 'a message', details));
  const catalogue = JSON.parse(fs.readFileSync(new URL('../web/locales/ar.json', import.meta.url), 'utf8'));
  const named = [
    ['INVALID_LISTING_GROUP', {field: 'operations[2].create.type'}, pmaxAction],
    [
      'INVALID_LISTING_GROUP',
      {field: 'mutate_operations[7].asset_group_listing_group_filter_operation.create.type'},
      buildAction,
    ],
    ['INVALID_SHOPPING_LISTING_GROUP', {field: 'operations[2].create.listingGroup.type'}, shoppingAction],
    [
      'INVALID_SHOPPING_LISTING_GROUP',
      {field: 'mutate_operations[9].ad_group_criterion_operation.create.cpc_bid_micros'},
      buildAction,
    ],
    ['TEMP_ID_CHAIN_TOO_LONG', {limit: 25, operations: 26}, buildAction],
    ['TEMP_ID_CHAIN_TOO_LONG', {limit: 500, operations: 501}, buildAction],
    ['TEMP_ID_CHAIN_TOO_LONG', {limit: 1000, operations: 1001}, 'amcp_campaign with action create'],
  ];
  for (const [code, details, next] of named) {
    const r = remedy(code, details);
    assert.equal(r.category, 'request', code);
    assert.equal(r.owner, 'operator', code);
    assert.equal(r.mutation_retry_safe, false, code + ': a refusal before any request is a new review, never a resend');
    assert.match(r.action, /^Nothing was sent/, code);
    assert.ok(r.action.includes(next), code + ' names ' + next + ': ' + r.action);
    assert.ok(
      typeof catalogue[r.action] === 'string' && catalogue[r.action].length > 20,
      code + ': Arabic for ' + r.action.slice(0, 60),
    );
  }
  // A chain refusal names the plan too, as the other way forward, and a build's own limit offers no longer build.
  assert.match(remedy('TEMP_ID_CHAIN_TOO_LONG', {limit: 25}).action, /\$ref/);
  assert.doesNotMatch(remedy('TEMP_ID_CHAIN_TOO_LONG', {limit: 1000}).action, /up to 1,000 operations/);
  // R2.5 M3 round 2, S3-4: a tree review over 500 operations is helped by neither a build (which refuses the tree of an asset group or ad
  // group that exists) nor a plan (a step that leaves no complete tree is refused as an empty tree): the way forward is a smaller edit.
  const treeReview = remedy('TEMP_ID_CHAIN_TOO_LONG', {limit: 500, operations: 501}).action;
  assert.match(treeReview, /^Nothing was sent\. Send a smaller tree edit, each review leaving a complete tree;/);
  assert.match(treeReview, /a new ad group’s or asset group’s tree goes in the build that creates it/);
  assert.doesNotMatch(treeReview, /\$ref|plan|Send them as a build/);
  // The new rules come before the one the table already had, which keeps its own code.
  const codes = googleRemedies.flatMap(r => r.codes);
  assert.ok(codes.indexOf('INVALID_LISTING_GROUP') < codes.indexOf('GOOGLE_LOGIN_CUSTOMER_UNMAPPED'));
  assert.ok(codes.indexOf('TEMP_ID_CHAIN_TOO_LONG') < codes.indexOf('GOOGLE_LOGIN_CUSTOMER_UNMAPPED'));
});

test('every rule of the closed set of node rules is met by a refusal of this file, and every refusal met a rule of a closed set (R2.5 M3 round 2, S4-4)', () => {
  // The last test of the file: the cases above ran first. A rule no case reaches is a rule no test pins; a rule outside both sets is an
  // open value.
  const {treeRules, nodeRules} = treeModule;
  assert.deepEqual(
    [...metRules].filter(rule => nodeRules.includes(rule)).sort(),
    [...nodeRules].sort(),
    'the node rules this file has met',
  );
  assert.deepEqual(
    [...metRules].filter(rule => !nodeRules.includes(rule) && !treeRules.includes(rule)),
    [],
    'every rule met is in a closed set',
  );
  assert.equal(
    nodeRules.some(rule => treeRules.includes(rule)),
    false,
    'the two sets share no value',
  );
});

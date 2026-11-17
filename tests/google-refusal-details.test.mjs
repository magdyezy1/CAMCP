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
import {chainTooLong} from '../dist/src/google-temp-names.js';
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
/** The refusal `fn` throws has this code, names this field, and this operation (none when undefined), and the list it was refused against. */
function refusal(label, fn, code, {field, operation, allowed, limit}) {
  const e = thrown(fn, label);
  assertRefused(e, code);
  assert.equal(e.details.field, field, label + ': field (' + e.message.slice(0, 120) + ')');
  assert.equal(e.details.operation, operation, label + ': operation');
  if (allowed !== undefined) assert.deepEqual(e.details.allowed, allowed, label + ': allowed');
  if (limit !== undefined) assert.equal(e.details.limit, limit, label + ': limit');
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
  refusal('a status that does not exist', () => shoppingCreateOf({...shoppingRoot, status: 'REMOVED'}), shoppingCode, {
    field: f('.status'),
    operation: 0,
    allowed: ['ENABLED', 'PAUSED'],
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
  refusal(
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
    {field: 'mutate_operations[6].create.resource_name', operation: 6},
  );
  refusal('a number used twice', build([budget(1), budget(1)]), code, {
    field: 'mutate_operations[1].create.resource_name',
    operation: 1,
  });
  refusal(
    'a parent that no earlier operation creates',
    build([
      {
        ad_group_operation: {
          create: {name: 'g', campaign: at('campaigns', '-5'), status: 'PAUSED', type: 'SEARCH_STANDARD'},
        },
      },
    ]),
    code,
    {field: 'mutate_operations[0].create.campaign', operation: 0},
  );
  refusal(
    'a parent that is no resource name',
    build([{ad_group_operation: {create: {name: 'g', campaign: 'DNU', status: 'PAUSED'}}}]),
    code,
    {field: 'mutate_operations[0].create.campaign', operation: 0},
  );
  refusal(
    'a temporary name in a field that does not take one',
    build([{campaign_budget_operation: {create: {name: at('campaigns', '-4'), amount_micros: '1'}}}]),
    code,
    {field: 'mutate_operations[0]', operation: 0},
  );
  refusal(
    'a resource of another customer',
    build([{campaign_budget_operation: {create: {name: 'customers/999/campaignBudgets/5', amount_micros: '1'}}}]),
    code,
    {field: 'mutate_operations[0]', operation: 0},
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
  // The new rules come before the one the table already had, which keeps its own code.
  const codes = googleRemedies.flatMap(r => r.codes);
  assert.ok(codes.indexOf('INVALID_LISTING_GROUP') < codes.indexOf('GOOGLE_LOGIN_CUSTOMER_UNMAPPED'));
  assert.ok(codes.indexOf('TEMP_ID_CHAIN_TOO_LONG') < codes.indexOf('GOOGLE_LOGIN_CUSTOMER_UNMAPPED'));
});

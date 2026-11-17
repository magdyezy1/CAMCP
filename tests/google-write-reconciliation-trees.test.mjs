import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Compiler} from '../dist/src/compiler.js';
import {applyExecutionRisk} from '../dist/src/execution-risk.js';
import {findCreated} from '../dist/src/write-reconciliation.js';
import {account, at, gateway} from './helpers/google-reconcile-fixture.mjs';

/**
 * R2.5 M3 (r25-m3-trees): the lookup of an uncertain listing group tree edit (M2, L2-13: a tree is compared by shape, never by
 * name) now covers every asset group a review edits (G4b) and a Standard Shopping tree (G5, route B). Everything is synthetic.
 */
const compiler = new Compiler(new Registry()),
  options = {mode: 'strict', flags: {}};
const compile = (action, payload) =>
  applyExecutionRisk(compiler.compile(gateway, {action, account_id: account, payload, dry_run: true}, options));
const claimed = Date.parse('2026-10-10T10:00:00Z'),
  context = (state = []) => ({state, claimedAt: claimed});

// ----- Performance Max: several asset groups in one review -----
const treeAction = 'google_ads_v23_asset_group_listing_group_filter_mutate_asset_group_listing_group_filters';
const node = (group, id) => at('assetGroupListingGroupFilters', group + '~' + id);
const create = (group, fields) => ({
  create: {assetGroup: at('assetGroups', group), listingSource: 'SHOPPING', ...fields},
});
/** A subdivision by brand with an "Acme" unit and an excluded "Other" unit, created in `group`. */
const brandTree = group => [
  create(group, {resourceName: node(group, '-1'), type: 'SUBDIVISION'}),
  create(group, {
    type: 'UNIT_INCLUDED',
    parentListingGroupFilter: node(group, '-1'),
    caseValue: {productBrand: {value: 'Acme'}},
  }),
  create(group, {type: 'UNIT_EXCLUDED', parentListingGroupFilter: node(group, '-1'), caseValue: {productBrand: {}}}),
];
const review = (...groups) => ({operations: groups.flatMap(brandTree)});
const asset = group => ({
  asset_group: {resource_name: at('assetGroups', group), status: 'PAUSED', campaign: at('campaigns', '100')},
  campaign: {},
});
/** A tree as Google lists it: nodes with their names, types, parents and case values. */
const listed = (group, nodes) => ({
  status: 200,
  data: {
    results: nodes.map(n => ({
      assetGroupListingGroupFilter: {
        resourceName: node(group, n.id),
        assetGroup: at('assetGroups', group),
        type: n.type,
        listingSource: 'SHOPPING',
        ...(n.parent ? {parentListingGroupFilter: node(group, n.parent)} : {}),
        ...(n.value !== undefined ? {caseValue: {productBrand: n.value ? {value: n.value} : {}}} : {}),
      },
    })),
  },
});
const finalNodes = [
  {id: '1', type: 'SUBDIVISION'},
  {id: '2', type: 'UNIT_INCLUDED', parent: '1', value: 'Acme'},
  {id: '3', type: 'UNIT_EXCLUDED', parent: '1', value: ''},
];

test('a review of two asset groups is looked up in each group’s tree: applied when both have the reviewed shape, not applied when both have the one read before', () => {
  const lookup = findCreated(
    compile(treeAction, review('103', '102')),
    context([asset('102'), {nodes: []}, asset('103'), {nodes: []}]),
  );
  assert.ok(lookup, 'a review of several groups has a lookup');
  assert.deepEqual(
    lookup.reads.map(r => r.body.query.match(/asset_group = '([^']+)'$/)?.[1]),
    [at('assetGroups', '102'), at('assetGroups', '103')],
    'one read of each group’s whole tree, in the order of the group IDs',
  );
  const applied = lookup.match([listed('102', finalNodes), listed('103', finalNodes)], claimed);
  assert.deepEqual(
    applied.found.map(f => [f.index, f.id]),
    [
      [0, at('assetGroups', '102') + ' listing groups'],
      [1, at('assetGroups', '103') + ' listing groups'],
    ],
  );
  assert.equal(applied.expected, 2);
  assert.equal(applied.complete, true);
  assert.deepEqual(lookup.receipt(applied.found), {
    results: ['102', '103'].flatMap(g => ['1', '2', '3'].map(id => ({resourceName: node(g, id)}))),
  });
  const absent = lookup.match([listed('102', []), listed('103', [])], claimed);
  assert.deepEqual(absent.found, []);
  assert.equal(absent.complete, true);
  assert.equal(absent.expected, 2);
});

test('anything else settles nothing: one group applied and the other not, a group changed by someone else, an unread page', () => {
  const lookup = findCreated(
    compile(treeAction, review('102', '103')),
    context([asset('102'), {nodes: []}, asset('103'), {nodes: []}]),
  );
  const nothing = answer => {
    const m = lookup.match(answer, claimed);
    assert.deepEqual(m.found, [], JSON.stringify(answer).slice(0, 200));
    assert.equal(m.complete, false);
  };
  // The first group's tree is the reviewed one and the second is as it was: half of the review is there.
  nothing([listed('102', finalNodes), listed('103', [])]);
  nothing([listed('102', []), listed('103', finalNodes)]);
  // A group that has another tree than the reviewed one or the one read before is someone else's change.
  nothing([listed('102', finalNodes), listed('103', finalNodes.slice(0, 2))]);
  nothing([
    listed('102', finalNodes),
    listed('103', [finalNodes[0], {...finalNodes[1], value: 'Another'}, finalNodes[2]]),
  ]);
  nothing([{status: 200, data: {results: [], nextPageToken: 'more'}}, listed('103', finalNodes)]);
  // A tree that cannot be read at all settles nothing either.
  nothing([
    listed('102', finalNodes),
    {status: 200, data: {results: [{assetGroupListingGroupFilter: {resourceName: 'x'}}]}},
  ]);
});

test('a group the edit leaves as it is proves nothing: with another that changes, the reviewed shape means applied; with none that changes, nothing is settled', () => {
  // Group 103 is replaced by an identical root: its shape before and after is the same.
  const sameRoot = [{remove: node('103', '10')}, create('103', {type: 'UNIT_INCLUDED'})];
  const state = [asset('102'), {nodes: []}, asset('103'), {nodes: [rootRow('103', '10')]}];
  const mixed = findCreated(compile(treeAction, {operations: [...brandTree('102'), ...sameRoot]}), context(state));
  assert.ok(mixed);
  const rootNow = listed('103', [{id: '10', type: 'UNIT_INCLUDED'}]);
  assert.equal(
    mixed.match([listed('102', finalNodes), rootNow], claimed).found.length,
    2,
    '102 changed, 103 is as it was',
  );
  const absent = mixed.match([listed('102', []), rootNow], claimed);
  assert.deepEqual(absent.found, []);
  assert.equal(absent.complete, true);
  const unchanged = findCreated(compile(treeAction, {operations: sameRoot}), context(state.slice(2)));
  assert.ok(unchanged);
  const none = unchanged.match([rootNow], claimed);
  assert.deepEqual(none.found, []);
  assert.equal(none.complete, false, 'an edit that changes no group cannot tell applied from not applied');
});
// ----- Standard Shopping: the tree of one ad group (G5, route B) -----
const shoppingAction = 'google_ads_v23_ad_group_criterion_mutate_ad_group_criteria';
const criterionName = id => at('adGroupCriteria', '55~' + id);
const shoppingEdit = () => ({
  operations: [
    {create: {resourceName: criterionName('-1'), adGroup: at('adGroups', '55'), listingGroup: {type: 'SUBDIVISION'}}},
    {
      create: {
        adGroup: at('adGroups', '55'),
        cpcBidMicros: '1500000',
        listingGroup: {
          type: 'UNIT',
          parentAdGroupCriterion: criterionName('-1'),
          caseValue: {productBrand: {value: 'Acme'}},
        },
      },
    },
    {
      create: {
        adGroup: at('adGroups', '55'),
        negative: true,
        listingGroup: {type: 'UNIT', parentAdGroupCriterion: criterionName('-1'), caseValue: {productBrand: {}}},
      },
    },
  ],
});
/** A Standard Shopping tree as Google lists it: nodes with their names, types, parents, case values, exclusions and bids. */
const listedShopping = nodes => ({
  status: 200,
  data: {
    results: nodes.map(n => ({
      adGroupCriterion: {
        resourceName: criterionName(n.id),
        adGroup: at('adGroups', '55'),
        type: 'LISTING_GROUP',
        ...(n.negative ? {negative: true} : {}),
        ...(n.bid ? {cpcBidMicros: n.bid} : {}),
        listingGroup: {
          type: n.type,
          ...(n.parent
            ? {
                parentAdGroupCriterion: criterionName(n.parent),
                caseValue: {productBrand: n.value ? {value: n.value} : {}},
              }
            : {}),
        },
      },
    })),
  },
});
const finalShopping = [
  {id: '1', type: 'SUBDIVISION'},
  {id: '2', type: 'UNIT', parent: '1', value: 'Acme', bid: '1500000'},
  {id: '3', type: 'UNIT', parent: '1', value: '', negative: true},
];

test('a Standard Shopping tree edit is looked up by the tree’s shape, bids and exclusions included: applied, not applied, or nothing', () => {
  const ad = {
    ad_group: {
      resource_name: at('adGroups', '55'),
      status: 'PAUSED',
      type: 'SHOPPING_PRODUCT_ADS',
      campaign: at('campaigns', '40'),
    },
    campaign: {status: 'PAUSED', advertising_channel_type: 'SHOPPING', merchant_id: '555'},
  };
  const lookup = findCreated(compile(shoppingAction, shoppingEdit()), context([ad, {nodes: []}]));
  assert.ok(lookup, 'a Standard Shopping tree edit has a lookup');
  assert.equal(lookup.reads.length, 1);
  assert.match(
    lookup.reads[0].body.query,
    / FROM ad_group_criterion WHERE ad_group_criterion\.ad_group = 'customers\/123\/adGroups\/55' AND ad_group_criterion\.type = 'LISTING_GROUP'$/,
  );
  const applied = lookup.match([listedShopping(finalShopping)], claimed);
  assert.equal(applied.found.length, 1);
  assert.equal(applied.found[0].id, at('adGroups', '55') + ' listing groups');
  assert.equal(applied.complete, true);
  assert.deepEqual(lookup.receipt(applied.found), {
    results: ['1', '2', '3'].map(id => ({resourceName: criterionName(id)})),
  });
  const absent = lookup.match([listedShopping([])], claimed);
  assert.deepEqual(absent.found, []);
  assert.equal(absent.complete, true);
  // Half of it, another bid, an exclusion that is not there, and an unread page settle nothing.
  for (const [label, nodes] of [
    ['half of the tree', finalShopping.slice(0, 2)],
    ['another bid', [finalShopping[0], {...finalShopping[1], bid: '2000000'}, finalShopping[2]]],
    ['no exclusion', [finalShopping[0], finalShopping[1], {...finalShopping[2], negative: false}]],
    ['another brand', [finalShopping[0], {...finalShopping[1], value: 'Another'}, finalShopping[2]]],
  ]) {
    const other = lookup.match([listedShopping(nodes)], claimed);
    assert.deepEqual(other.found, [], label);
    assert.equal(other.complete, false, label);
  }
  assert.equal(lookup.match([{status: 200, data: {results: [], nextPageToken: 'more'}}], claimed).complete, false);
  // A request that is no tree edit (a keyword create) has no such lookup.
  assert.equal(
    findCreated(
      compile(shoppingAction, {
        operations: [{create: {adGroup: at('adGroups', '55'), keyword: {text: 'acme', matchType: 'EXACT'}}}],
      }),
      context(),
    ),
    undefined,
  );
});

/** The state a review froze of an existing root. */
function rootRow(group, id) {
  return {
    resource_name: node(group, id),
    type: 'UNIT_INCLUDED',
    listing_source: 'SHOPPING',
    parent: null,
    case_value: null,
  };
}

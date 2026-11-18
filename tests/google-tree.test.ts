import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  assertTree,
  dimension,
  finalTree,
  shape,
  treeRules,
  type TreeAdapter,
  type TreeNode,
  type TreeOperation,
} from '../src/google-tree.js';
import {pmaxTree} from '../src/google-listing-groups.js';
import {shoppingDimensions, shoppingTree} from '../src/google-shopping-tree.js';
import type {JsonObject} from '../src/types.js';
import {assertRefused} from './helpers/assert-refused.js';

/**
 * R2.5 M3 (r25-m3-trees, G5 and L2-09): the one tree validation of Performance Max asset group listing group filters and
 * Standard Shopping ad group listing groups. Each adapter is driven through the same cases: a tree is one root, each
 * subdivision completely partitioned along one dimension with an "Other" node, units as leaves; a refusal names its rule.
 */
const brand = (value?: string): JsonObject => ({productBrand: value === undefined ? {} : {value}});
const condition = (value?: string): JsonObject => ({productCondition: value === undefined ? {} : {condition: value}});
const itemId = (value?: string): JsonObject => ({productItemId: value === undefined ? {} : {value}});
const productType = (level: string, value?: string): JsonObject => ({
  productType: value === undefined ? {level} : {level, value},
});

interface Kit {
  name: string;
  adapter: TreeAdapter;
  /** The words of the sentences that name what the tree belongs to. */
  owner: RegExp;
  /** Where a node's parent link and case value are in a create (L2-07), written out here, not read from the adapter. */
  parentField: string;
  caseField: string;
  root(name: string): TreeNode;
  sub(name: string, parent?: string, caseValue?: JsonObject): TreeNode;
  unit(name: string, parent: string, caseValue: JsonObject, extra?: Partial<TreeNode>): TreeNode;
  excluded(name: string, parent?: string, caseValue?: JsonObject): TreeNode;
  /** The label a unit has in the shape. */
  unitLabel: string;
  excludedLabel: string;
}
const kits: Kit[] = [
  {
    name: 'Performance Max',
    adapter: pmaxTree,
    owner: /asset group/,
    parentField: 'parentListingGroupFilter',
    caseField: 'caseValue',
    root: name => ({name, type: 'UNIT_INCLUDED', source: 'SHOPPING'}),
    sub: (name, parent, caseValue) => ({
      name,
      type: 'SUBDIVISION',
      source: 'SHOPPING',
      ...(parent ? {parent} : {}),
      ...(caseValue ? {caseValue} : {}),
    }),
    unit: (name, parent, caseValue, extra = {}) => ({
      name,
      type: 'UNIT_INCLUDED',
      source: 'SHOPPING',
      parent,
      caseValue,
      ...extra,
    }),
    excluded: (name, parent, caseValue) => ({
      name,
      type: 'UNIT_EXCLUDED',
      source: 'SHOPPING',
      ...(parent ? {parent} : {}),
      ...(caseValue ? {caseValue} : {}),
    }),
    unitLabel: 'UNIT_INCLUDED',
    excludedLabel: 'UNIT_EXCLUDED',
  },
  {
    name: 'Standard Shopping',
    adapter: shoppingTree,
    owner: /ad group/,
    parentField: 'listingGroup.parentAdGroupCriterion',
    caseField: 'listingGroup.caseValue',
    root: name => ({name, type: 'UNIT'}),
    sub: (name, parent, caseValue) => ({
      name,
      type: 'SUBDIVISION',
      ...(parent ? {parent} : {}),
      ...(caseValue ? {caseValue} : {}),
    }),
    unit: (name, parent, caseValue, extra = {}) => ({name, type: 'UNIT', parent, caseValue, ...extra}),
    excluded: (name, parent, caseValue) => ({
      name,
      type: 'UNIT',
      negative: true,
      ...(parent ? {parent} : {}),
      ...(caseValue ? {caseValue} : {}),
    }),
    unitLabel: 'UNIT',
    excludedLabel: 'UNIT_EXCLUDED',
  },
];
/** The creates of a list of nodes, as a request's operations carry them. */
const creates = (nodes: TreeNode[]): TreeOperation[] =>
  nodes.map((n, i) => ({
    create: {...n, op: i, at: 'operations[' + i + '].create'},
    op: i,
    at: 'operations[' + i + ']',
  }));
const removes = (names: string[], from = 0): TreeOperation[] =>
  names.map((remove, i) => ({remove, op: from + i, at: 'operations[' + (from + i) + '].remove'}));
const built = (kit: Kit, nodes: TreeNode[], current: TreeNode[] = []) =>
  finalTree(kit.adapter, creates(nodes), current);
const asRefusal = (e: unknown) => e as {code: string; message: string; details: JsonObject};

/** Every rule a refusal below carries: the closed set must be exercised whole. */
const seen = new Set<string>();
function refuses(run: () => unknown, code: string, rule: string, message: RegExp): JsonObject {
  let details: JsonObject | undefined;
  assert.throws(run, e => {
    assertRefused(e, code, {message});
    details = asRefusal(e).details;
    return true;
  });
  assert.equal(details?.rule, rule, 'the rule of the refusal: ' + JSON.stringify(details));
  assert.ok((treeRules as readonly string[]).includes(rule), rule + ' is in the closed set');
  seen.add(rule);
  return details!;
}

for (const kit of kits) {
  const invalid = kit.adapter.code;
  test(
    kit.name +
      ': a one-level and a two-level tree are valid, and their shape is the path of dimension values to each node',
    () => {
      const one = built(kit, [kit.sub('-1'), kit.unit('-2', '-1', brand('Acme')), kit.unit('-3', '-1', brand())]);
      assertTree(kit.adapter, one);
      assert.deepEqual(shape(kit.adapter, one), [
        'root > productBrand=* [' + kit.unitLabel + ']',
        'root > productBrand=acme [' + kit.unitLabel + ']',
        'root [SUBDIVISION]',
      ]);
      const two = built(kit, [
        kit.sub('-1'),
        kit.unit('-2', '-1', condition('NEW')),
        kit.sub('-3', '-1', condition()),
        kit.unit('-4', '-3', brand('Acme')),
        kit.excluded('-5', '-3', brand('Cheap')),
        kit.unit('-6', '-3', brand()),
      ]);
      assertTree(kit.adapter, two);
      assert.deepEqual(shape(kit.adapter, two), [
        'root > productCondition=* > productBrand=* [' + kit.unitLabel + ']',
        'root > productCondition=* > productBrand=acme [' + kit.unitLabel + ']',
        'root > productCondition=* > productBrand=cheap [' + kit.excludedLabel + ']',
        'root > productCondition=* [SUBDIVISION]',
        'root > productCondition=new [' + kit.unitLabel + ']',
        'root [SUBDIVISION]',
      ]);
      // A single included unit is a valid tree ("all products").
      assertTree(kit.adapter, built(kit, [kit.root('-1')]));
    },
  );

  test(
    kit.name +
      ': the paths of dimensions Google accepts are valid: levels one after the other, other dimensions between them',
    () => {
      // Product type level 1, then level 2 below it; the "Other" node of each level is a unit.
      assertTree(
        kit.adapter,
        built(kit, [
          kit.sub('-1'),
          kit.sub('-2', '-1', productType('LEVEL1', 'Shoes')),
          kit.unit('-3', '-2', productType('LEVEL2', 'Boots')),
          kit.unit('-4', '-2', productType('LEVEL2')),
          kit.unit('-5', '-1', productType('LEVEL1')),
        ]),
      );
      // Another dimension between the two levels: the level before is still on the path.
      assertTree(
        kit.adapter,
        built(kit, [
          kit.sub('-1'),
          kit.sub('-2', '-1', productType('LEVEL1', 'Shoes')),
          kit.sub('-3', '-2', brand('Acme')),
          kit.unit('-4', '-3', productType('LEVEL2', 'Boots')),
          kit.unit('-5', '-3', productType('LEVEL2')),
          kit.unit('-6', '-2', brand()),
          kit.unit('-7', '-1', productType('LEVEL1')),
        ]),
      );
      // The "Other" node of a level may be subdivided by another dimension, only not by the hierarchy.
      assertTree(
        kit.adapter,
        built(kit, [
          kit.sub('-1'),
          kit.unit('-2', '-1', productType('LEVEL1', 'Shoes')),
          kit.sub('-3', '-1', productType('LEVEL1')),
          kit.unit('-4', '-3', brand('Acme')),
          kit.unit('-5', '-3', brand()),
        ]),
      );
      // A dimension used on two branches, never twice on one path.
      assertTree(
        kit.adapter,
        built(kit, [
          kit.sub('-1'),
          kit.sub('-2', '-1', brand('Acme')),
          kit.unit('-3', '-2', condition('NEW')),
          kit.unit('-4', '-2', condition()),
          kit.sub('-5', '-1', brand()),
          kit.unit('-6', '-5', condition('NEW')),
          kit.unit('-7', '-5', condition()),
        ]),
      );
    },
  );

  test(
    kit.name +
      ': a dimension used twice on a path, a level without the level before it, and the "Other" node of a hierarchy refined by the hierarchy are refused with their rule and their node (R2.5 M3 round 2, S3-1)',
    () => {
      // Brand subdivided by brand again: Google refuses the same dimension type as an ancestor.
      const same = refuses(
        () =>
          assertTree(
            kit.adapter,
            built(kit, [
              kit.sub('-1'),
              kit.sub('-2', '-1', brand('a')),
              kit.unit('-3', '-2', brand('x')),
              kit.unit('-4', '-2', brand()),
              kit.unit('-5', '-1', brand()),
            ]),
          ),
        invalid,
        'ancestor_dimension',
        /one of its ancestors already splits by/,
      );
      assert.equal(same.node, '-3');
      assert.equal(same.operation, 2);
      assert.equal(same.field, 'operations[2].create.' + kit.caseField);
      assert.equal(same.dimension, 'productBrand');
      // The same level twice on a path is the same dimension too.
      refuses(
        () =>
          assertTree(
            kit.adapter,
            built(kit, [
              kit.sub('-1'),
              kit.sub('-2', '-1', productType('LEVEL1', 'Shoes')),
              kit.unit('-3', '-2', productType('LEVEL1', 'Boots')),
              kit.unit('-4', '-2', productType('LEVEL1')),
              kit.unit('-5', '-1', productType('LEVEL1')),
            ]),
          ),
        invalid,
        'ancestor_dimension',
        /one of its ancestors already splits by/,
      );
      // A level above 1 with no level before it on its path, and one that skips a level.
      const first = refuses(
        () =>
          assertTree(
            kit.adapter,
            built(kit, [
              kit.sub('-1'),
              kit.unit('-2', '-1', productType('LEVEL2', 'Boots')),
              kit.unit('-3', '-1', productType('LEVEL2')),
            ]),
          ),
        invalid,
        'level_order',
        /needs the level before it/,
      );
      assert.equal(first.node, '-2');
      assert.equal(first.operation, 1);
      assert.deepEqual([first.dimension, first.level, first.required], ['productType', 'LEVEL2', 'LEVEL1']);
      const skipped = refuses(
        () =>
          assertTree(
            kit.adapter,
            built(kit, [
              kit.sub('-1'),
              kit.sub('-2', '-1', productType('LEVEL1', 'Shoes')),
              kit.unit('-3', '-2', productType('LEVEL3', 'Boots')),
              kit.unit('-4', '-2', productType('LEVEL3')),
              kit.unit('-5', '-1', productType('LEVEL1')),
            ]),
          ),
        invalid,
        'level_order',
        /needs the level before it/,
      );
      assert.deepEqual([skipped.level, skipped.required], ['LEVEL3', 'LEVEL2']);
      // The category hierarchy is a hierarchy of its own: a product type level 1 is no level before a category level 2.
      refuses(
        () =>
          assertTree(
            kit.adapter,
            built(kit, [
              kit.sub('-1'),
              kit.sub('-2', '-1', productType('LEVEL1', 'Shoes')),
              kit.unit('-3', '-2', {productCategory: {categoryId: '1', level: 'LEVEL2'}}),
              kit.unit('-4', '-2', {productCategory: {level: 'LEVEL2'}}),
              kit.unit('-5', '-1', productType('LEVEL1')),
            ]),
          ),
        invalid,
        'level_order',
        /needs the level before it/,
      );
      // The "Other" node of a level subdivided by the next level of the same hierarchy.
      const other = refuses(
        () =>
          assertTree(
            kit.adapter,
            built(kit, [
              kit.sub('-1'),
              kit.unit('-2', '-1', productType('LEVEL1', 'Shoes')),
              kit.sub('-3', '-1', productType('LEVEL1')),
              kit.unit('-4', '-3', productType('LEVEL2', 'Boots')),
              kit.unit('-5', '-3', productType('LEVEL2')),
            ]),
          ),
        invalid,
        'other_refined',
        /cannot be subdivided by a level of the same hierarchy/,
      );
      assert.equal(other.node, '-4');
      assert.equal(other.parent, '-3');
      assert.equal(other.dimension, 'productType');
    },
  );

  test(
    kit.name +
      ': an existing tree is edited in order: leaves first on removal, parents first on creation, and the result is complete',
    () => {
      const current = [kit.sub('n/1'), kit.unit('n/2', 'n/1', brand('Acme')), kit.unit('n/3', 'n/1', brand())];
      const replaced = finalTree(
        kit.adapter,
        [
          ...removes(['n/2', 'n/3', 'n/1']),
          ...creates([kit.sub('-1'), kit.unit('-2', '-1', condition('NEW')), kit.unit('-3', '-1', condition())]).map(
            (o, i) => ({...o, op: 3 + i}),
          ),
        ],
        current,
      );
      assertTree(kit.adapter, replaced);
      assert.deepEqual([...replaced.keys()].sort(), ['-1', '-2', '-3'], 'the old nodes are gone, the new ones are in');
    },
  );

  test(kit.name + ': a tree that is not complete is refused with its rule', () => {
    // Two children and no "Other" node, then two "Other" nodes.
    refuses(
      () =>
        assertTree(
          kit.adapter,
          built(kit, [kit.sub('-1'), kit.unit('-2', '-1', brand('a')), kit.unit('-3', '-1', brand('b'))]),
        ),
      invalid,
      'other_missing',
      /exactly one "Other"/,
    );
    const two = refuses(
      () =>
        assertTree(
          kit.adapter,
          built(kit, [kit.sub('-1'), kit.unit('-2', '-1', brand()), kit.unit('-3', '-1', brand())]),
        ),
      invalid,
      'other_repeated',
      /exactly one "Other"/,
    );
    assert.equal(two.node, '-1');
    assert.equal(two.found, 2);
    // One child only: a subdivision needs a product group and an "Other" node.
    refuses(
      () => assertTree(kit.adapter, built(kit, [kit.sub('-1'), kit.unit('-2', '-1', brand())])),
      invalid,
      'subdivision_children',
      /at least one product group/,
    );
    // Mixed dimensions among siblings, and a repeated value in any case.
    const mixed = refuses(
      () =>
        assertTree(
          kit.adapter,
          built(kit, [kit.sub('-1'), kit.unit('-2', '-1', brand('a')), kit.unit('-3', '-1', condition())]),
        ),
      invalid,
      'mixed_dimensions',
      /same dimension/,
    );
    assert.deepEqual(mixed.dimensions, ['productBrand', 'productCondition']);
    refuses(
      () =>
        assertTree(
          kit.adapter,
          built(kit, [
            kit.sub('-1'),
            kit.unit('-2', '-1', brand('Acme')),
            kit.unit('-3', '-1', brand('ACME')),
            kit.unit('-4', '-1', brand()),
          ]),
        ),
      invalid,
      'repeated_value',
      /repeats a product group/,
    );
    // An excluded root excludes every product.
    refuses(() => assertTree(kit.adapter, built(kit, [kit.excluded('-1')])), invalid, 'excluded_root', /excluded root/);
    // Two roots, and a unit that has children (a tree read that Google would never return).
    refuses(
      () =>
        assertTree(
          kit.adapter,
          new Map([
            ['a', kit.root('a')],
            ['b', kit.root('b')],
          ]),
        ),
      invalid,
      'root_count',
      /exactly one root/,
    );
    refuses(
      () =>
        assertTree(
          kit.adapter,
          new Map([
            ['a', kit.root('a')],
            ['b', kit.unit('b', 'a', brand('x'))],
          ]),
        ),
      invalid,
      'unit_children',
      /cannot have children/,
    );
    // The tree would be empty.
    refuses(
      () => assertTree(kit.adapter, finalTree(kit.adapter, removes(['n/1']), [kit.root('n/1')])),
      invalid,
      'empty_tree',
      kit.owner,
    );
  });

  test(
    kit.name + ': operations that do not apply in order are refused with their rule, and each names its operation',
    () => {
      // A child before its parent, and a child under a unit.
      const before = refuses(
        () => built(kit, [kit.unit('-2', '-1', brand('a')), kit.sub('-1')]),
        invalid,
        'missing_parent',
        /create parents before their children/,
      );
      assert.equal(before.operation, 0);
      assert.equal(before.node, '-2');
      // L2-07 (item 9): the field is the one the request has, in each service's own spelling, not an abstract "parent".
      assert.equal(before.field, 'operations[0].create.' + kit.parentField);
      assert.deepEqual(kit.adapter.fields, {parent: kit.parentField, caseValue: kit.caseField});
      refuses(
        () => built(kit, [kit.root('-1'), kit.unit('-2', '-1', brand('a'))]),
        invalid,
        'parent_is_unit',
        /is a unit/,
      );
      // A removal before its children, a removal of what is not there, a node that exists, a second root.
      const current = [kit.sub('n/1'), kit.unit('n/2', 'n/1', brand('a')), kit.unit('n/3', 'n/1', brand())];
      const early = refuses(
        () => finalTree(kit.adapter, removes(['n/1']), current),
        invalid,
        'remove_before_children',
        /leaves first/,
      );
      assert.equal(early.node, 'n/1');
      assert.equal(early.operation, 0);
      const missing = refuses(
        () => finalTree(kit.adapter, removes(['n/9']), current),
        'STATE_NOT_FOUND',
        'node_missing',
        /does not exist/,
      );
      assert.equal(missing.resource_name, 'n/9');
      refuses(
        () => finalTree(kit.adapter, creates([kit.unit('n/2', 'n/1', brand('z'))]), current),
        invalid,
        'node_exists',
        /already exists/,
      );
      refuses(() => finalTree(kit.adapter, creates([kit.root('-1')]), current), invalid, 'existing_root', kit.owner);
    },
  );

  test(
    kit.name + ': the dimension of a case value is read as the family lists dimensions, and a refusal names its field',
    () => {
      const at = 'operations[2].create';
      const where = {operation: 2, field: at + '.caseValue'};
      assert.deepEqual(dimension(kit.adapter, brand('Acme'), at), {key: 'productBrand', other: false, value: 'acme'});
      assert.deepEqual(dimension(kit.adapter, brand(), at), {key: 'productBrand', other: true, value: ''});
      assert.deepEqual(dimension(kit.adapter, {productType: {level: 'LEVEL2', value: 'Shoes'}}, at), {
        key: 'productType:LEVEL2',
        other: false,
        value: 'shoes',
      });
      assert.deepEqual(dimension(kit.adapter, itemId(' 7 '), at), {key: 'productItemId', other: false, value: '7'});
      const kind = refuses(
        () => dimension(kit.adapter, {webpage: {}}, at, where),
        invalid,
        'dimension_kind',
        /exactly one retail dimension/,
      );
      assert.deepEqual(kind.allowed, Object.keys(kit.adapter.dimensions));
      assert.equal(kind.operation, 2);
      assert.equal(kind.field, at + '.caseValue');
      refuses(
        () => dimension(kit.adapter, {productBrand: {value: 'a', extra: 1}}, at, where),
        invalid,
        'dimension_fields',
        /accepts only value/,
      );
      refuses(
        () => dimension(kit.adapter, {productType: {value: 'Shoes'}}, at, where),
        invalid,
        'dimension_level',
        /needs its level/,
      );
      refuses(
        () => dimension(kit.adapter, {productBrand: {value: '   '}}, at, where),
        invalid,
        'dimension_value',
        /nonblank value/,
      );
    },
  );
}

test('Performance Max: a node that is not a retail (SHOPPING) filter is refused, and the channel exclusivity is no dimension of it', () => {
  const kit = kits[0]!;
  refuses(
    () => assertTree(kit.adapter, new Map([['a', {...kit.root('a'), source: 'WEBPAGE'}]])),
    pmaxTree.code,
    'foreign_source',
    /webpage listing groups/,
  );
  refuses(
    () => dimension(pmaxTree, {productChannelExclusivity: {channelExclusivity: 'SINGLE_CHANNEL'}}, 'x'),
    pmaxTree.code,
    'dimension_kind',
    /exactly one retail dimension/,
  );
});

test('Standard Shopping: a bid is on units only, a subdivision is never negative, a tree has a unit, and the shape shows both', () => {
  const kit = kits[1]!;
  const bid = refuses(
    () =>
      assertTree(
        kit.adapter,
        built(kit, [
          {...kit.sub('-1'), bid: '1500000'},
          kit.unit('-2', '-1', brand('a')),
          kit.unit('-3', '-1', brand()),
        ]),
      ),
    shoppingTree.code,
    'bid_on_subdivision',
    /takes no bid/,
  );
  assert.equal(bid.operation, 0);
  assert.equal(bid.node, '-1');
  assert.equal(bid.field, 'operations[0].create.cpc_bid_micros');
  // R2.5 M3 round 2, S4-5: the node is in the details, so the message is one fixed sentence (with its Arabic), whatever the node.
  assert.throws(
    () =>
      assertTree(
        kit.adapter,
        built(kit, [
          {...kit.sub('-1'), bid: '1500000'},
          kit.unit('-2', '-1', brand('a')),
          kit.unit('-3', '-1', brand()),
        ]),
      ),
    (e: unknown) => asRefusal(e).message === 'A subdivision takes no bid; only a unit does.',
  );
  // A bid on an excluded unit: Google refuses a bid on a negative criterion (CriterionError FIELD_INCOMPATIBLE_WITH_NEGATIVE_TARGETING).
  const excludedBid = refuses(
    () =>
      assertTree(
        kit.adapter,
        built(kit, [
          kit.sub('-1'),
          {...kit.excluded('-2', '-1', brand('a')), bid: '100000'},
          kit.unit('-3', '-1', brand()),
        ]),
      ),
    shoppingTree.code,
    'bid_on_excluded_unit',
    /excluded unit takes no bid/,
  );
  assert.equal(excludedBid.node, '-2');
  assert.equal(excludedBid.operation, 1);
  assert.equal(excludedBid.field, 'operations[1].create.cpc_bid_micros');
  assertTree(
    kit.adapter,
    built(kit, [kit.sub('-1'), kit.excluded('-2', '-1', brand('a')), kit.unit('-3', '-1', brand())]),
  );
  // A node read from Google is Google's own state, not the request's bid: it never fails a review of something else.
  assertTree(
    kit.adapter,
    finalTree(
      kit.adapter,
      [],
      [kit.sub('n/1'), {...kit.excluded('n/2', 'n/1', brand('a')), bid: '100000'}, kit.unit('n/3', 'n/1', brand())],
    ),
  );
  const negative = refuses(
    () =>
      assertTree(
        kit.adapter,
        built(kit, [
          {...kit.sub('-1'), negative: true},
          kit.unit('-2', '-1', brand('a')),
          kit.unit('-3', '-1', brand()),
        ]),
      ),
    shoppingTree.code,
    'negative_subdivision',
    /cannot be negative/,
  );
  assert.equal(negative.field, 'operations[0].create.negative');
  // No unit: the root alone is a subdivision (its own rule comes first), and a tree of subdivisions never reaches a unit.
  refuses(
    () => assertTree(shoppingTree, built(kit, [kit.sub('-1')])),
    shoppingTree.code,
    'no_unit',
    /at least one unit/,
  );
  // A unit's exclusion and its bid are in the shape, so a read-back that finds another bid or another exclusion differs.
  const tree = built(kit, [
    kit.sub('-1'),
    kit.unit('-2', '-1', brand('a'), {bid: '1500000'}),
    kit.excluded('-3', '-1', brand('b')),
    kit.unit('-4', '-1', brand()),
  ]);
  assertTree(shoppingTree, tree);
  assert.deepEqual(shape(shoppingTree, tree), [
    'root > productBrand=* [UNIT]',
    'root > productBrand=a [UNIT bid=1500000]',
    'root > productBrand=b [UNIT_EXCLUDED]',
    'root [SUBDIVISION]',
  ]);
  // The channel exclusivity is a Shopping dimension (SINGLE_CHANNEL or MULTI_CHANNEL; "Other" has no value).
  assert.deepEqual(dimension(shoppingTree, {productChannelExclusivity: {channelExclusivity: 'SINGLE_CHANNEL'}}, 'x'), {
    key: 'productChannelExclusivity',
    other: false,
    value: 'single_channel',
  });
  assert.deepEqual(dimension(shoppingTree, {productChannelExclusivity: {}}, 'x'), {
    key: 'productChannelExclusivity',
    other: true,
    value: '',
  });
});

test('the Shopping dimensions are the ones ListingDimensionInfo lists in the pinned v25 document, field for field', () => {
  const doc = JSON.parse(fs.readFileSync('.mirror/VENDOR/google-ads-v25.json', 'utf8')),
    schemas = (doc.document ?? doc).schemas as Record<string, {properties: Record<string, {$ref?: string}>}>,
    info = schemas.GoogleAdsGoogleadsV25Common__ListingDimensionInfo!.properties;
  for (const [name, spec] of Object.entries(shoppingDimensions)) {
    assert.ok(info[name], name + ' is a ListingDimensionInfo field');
    const sub = schemas[info[name]!.$ref!]!;
    assert.deepEqual(
      Object.keys(sub.properties).sort(),
      [spec.value, spec.level].filter((f): f is string => !!f).sort(),
      name + ': the value and level fields are exactly the message’s',
    );
  }
  // What the document lists and a Shopping tree does not use, so a dimension Google adds is noticed here.
  const unused = Object.keys(info)
    .filter(name => !Object.hasOwn(shoppingDimensions, name))
    .sort();
  assert.deepEqual(unused, [
    'activityCity',
    'activityCountry',
    'activityId',
    'activityRating',
    'activityState',
    'hotelCity',
    'hotelClass',
    'hotelCountryRegion',
    'hotelId',
    'hotelState',
    'productGrouping',
    'productLabels',
    'productLegacyCondition',
    'productTypeFull',
    'unknownListingDimension',
  ]);
  // The rules a tree refuses with are a closed set, and this file has met every one of them.
  assert.deepEqual([...seen].sort(), [...treeRules].sort());
});

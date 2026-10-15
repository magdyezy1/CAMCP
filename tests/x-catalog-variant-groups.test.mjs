import test from 'node:test';
import assert from 'node:assert/strict';
import {xCatalogComparisonFixture, xProductSource} from './fixtures/x-catalog-comparison.mjs';
import {product} from './x-catalog-fixture.mjs';
import {authorizeXCatalogRead, xCatalogRead} from '../dist/src/x-catalogs.js';

/**
 * COM-02 E: X variant groups. X lists only the first product of a group, so before this change any grouped record made
 * every absent SKU an unexplained `hidden_variant` block. Now the comparison and the native review name the grouped
 * records that keep a SKU's absence unestablished and point to the scheduled feed. After an owner-authorized read
 * qualifies X's item_group_key listing (AMCP_X_CATALOG_GROUP_EXPANSION=qualified), every listed group is read in full,
 * within bounds; a SKU's absence is established only when every group was read completely and consistently.
 */
const key = '7700001',
  action = 'x_product_catalogs_product_catalog_id_products_put',
  ok = result => {
    assert.equal(result.success, true, JSON.stringify(result).slice(0, 1500));
    return result.data;
  };
function qualify(t, value) {
  const previous = process.env.AMCP_X_CATALOG_GROUP_EXPANSION;
  if (value === null) delete process.env.AMCP_X_CATALOG_GROUP_EXPANSION;
  else process.env.AMCP_X_CATALOG_GROUP_EXPANSION = value;
  t.after(() => {
    if (previous === undefined) delete process.env.AMCP_X_CATALOG_GROUP_EXPANSION;
    else process.env.AMCP_X_CATALOG_GROUP_EXPANSION = previous;
  });
}
const member = (i, extra = {}) => product(i, {item_group_id: 'Shoe', item_group_key: key, ...extra});
/** sku-3 is listed as the first product of group "Shoe"; sku-30 and sku-31 are members X does not list. */
function groupedWorld(t, options = {}) {
  const f = xCatalogComparisonFixture(options);
  t.after(() => f.store.close());
  Object.assign(f.items[9001][2], {item_group_id: 'Shoe', item_group_key: key});
  f.groups[9001][key] = [f.items[9001][2], member(30), member(31)];
  return f;
}
/** The native product the import sends for a listed fixture product. */
const native = row => {
  const {product_key, inventory, sale_price, item_group_id, additional_image_link, item_group_key, ...fields} = row;
  return fields;
};
const groupReads = f => f.calls.filter(c => c.query.item_group_key !== undefined);
const states = out => out.items.map(i => [i.retailer_id, i.state, i.blocked_reason]);

test('before qualification the block stays, names the grouped records and points to the scheduled feed, without group reads', async t => {
  qualify(t, null);
  const f = groupedWorld(t);
  const out = ok(await f.call());
  assert.deepEqual(states(out), [
    ['sku-4', 'unknown', 'hidden_variant'],
    ['sku-1', 'changed', null],
    ['sku-2', 'matching', null],
    ['sku-3', 'unknown', 'grouped_product'],
  ]);
  assert.deepEqual(out.variant_groups, {
    expansion: 'not_qualified',
    reason: null,
    grouped_record_count: 1,
    grouped_records: [
      {
        retailer_id: 'sku-3',
        product_id: '5000003',
        group_status: 'grouped',
        item_group_id: 'Shoe',
        item_group_key: key,
      },
    ],
    member_count: 0,
    membership_hash: null,
    remedy: 'scheduled_feed',
  });
  assert.equal(groupReads(f).length, 0, 'no item_group_key read before the owner qualifies it');
  // The native review refuses the same SKU and names what hides it.
  const refused = await f.prepare(action, {products: [native(product(4))]}, {product_catalog_id: '9001'});
  assert.equal(refused.success, false);
  assert.equal(refused.error.code, 'INVALID_X_CATALOG_PRODUCT');
  assert.match(refused.error.message, /can hide the supplied SKU/);
  assert.equal(refused.error.details.remedy, 'scheduled_feed');
  assert.equal(refused.error.details.group_expansion, 'not_qualified');
  assert.deepEqual(
    refused.error.details.grouped_records.map(r => r.retailer_id),
    ['sku-3'],
  );
  assert.equal(f.writes(), 0);
  // A catalog without grouped records carries no variant-group evidence at all (the pinned responses stay unchanged).
  const plain = xCatalogComparisonFixture();
  t.after(() => plain.store.close());
  assert.equal(Object.hasOwn(ok(await plain.call()), 'variant_groups'), false);
});

test('qualified: absence is established only when every listed group is read in full; a hidden member is a grouped product', async t => {
  qualify(t, 'qualified');
  const f = groupedWorld(t);
  const out = ok(await f.call());
  assert.deepEqual(states(out), [
    ['sku-4', 'new', null],
    ['sku-1', 'changed', null],
    ['sku-2', 'matching', null],
    ['sku-3', 'unknown', 'grouped_product'],
  ]);
  assert.equal(out.variant_groups.expansion, 'complete');
  assert.equal(out.variant_groups.remedy, null);
  assert.equal(out.variant_groups.member_count, 3);
  assert.match(out.variant_groups.membership_hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(out.review_retailer_ids, ['sku-4', 'sku-1']);
  // Each of the two agreeing scans reads the group once; members are never returned, only counted and hashed.
  assert.equal(groupReads(f).length, 2);
  assert.doesNotMatch(JSON.stringify(out), /sku-30|sku-31/);
  // A supplied SKU that is a hidden member of the group is a grouped product, never a new one.
  const hidden = ok(await f.call({...f.input, products: [xProductSource(member(30))]}));
  assert.deepEqual(states(hidden), [['sku-30', 'unknown', 'grouped_product']]);
  assert.equal(hidden.items[0].product_id, '5000030');

  // The native review establishes the same: the new SKU is created and read back, the hidden member is refused.
  const created = await f.prepare(action, {products: [native(product(4))]}, {product_catalog_id: '9001'});
  assert.equal(created.success, true, JSON.stringify(created).slice(0, 1500));
  assert.equal(created.data.creative_impact.operation, 'create');
  ok(await f.execute(created));
  ok(await f.verify(created));
  assert.equal(f.writes(), 1);
  assert.ok(f.items[9001].some(row => row.id === 'sku-4'));
  const grouped = await f.prepare(action, {products: [native(member(30))]}, {product_catalog_id: '9001'});
  assert.equal(grouped.success, false);
  assert.match(grouped.error.message, /existing product is grouped/);
  assert.equal(f.writes(), 1);
});

test('qualified: a group read beyond its bounds, an unreadable group or a group read missing its listed record keeps the block', async t => {
  qualify(t, 'qualified');
  const cases = {
    page_limit: f => {
      f.groups[9001][key] = [f.items[9001][2], ...Array.from({length: 300}, (_, i) => member(100 + i))];
    },
    group_limit: f => {
      for (let i = 0; i < 10; i++)
        f.items[9001].push(product(40 + i, {item_group_id: 'Group ' + i, item_group_key: String(7710000 + i)}));
    },
    group_status_unknown: f => {
      delete f.items[9001][2].item_group_key;
    },
    listed_member_missing: f => {
      f.groups[9001][key] = [member(30), member(31)];
    },
  };
  for (const [reason, mutate] of Object.entries(cases)) {
    const f = groupedWorld(t);
    mutate(f);
    const out = ok(await f.call());
    assert.deepEqual(states(out)[0], ['sku-4', 'unknown', 'hidden_variant'], reason);
    assert.equal(out.variant_groups.expansion, 'incomplete', reason);
    assert.equal(out.variant_groups.reason, reason);
    assert.equal(out.variant_groups.remedy, 'scheduled_feed', reason);
    assert.equal(out.variant_groups.membership_hash, null, reason);
    assert.ok(out.variant_groups.grouped_records.length <= 10, reason);
    if (reason === 'group_limit') {
      assert.equal(out.variant_groups.grouped_record_count, 11);
      assert.equal(groupReads(f).length, 0, 'more groups than one read takes are not read at all');
    }
    if (reason === 'page_limit') assert.equal(groupReads(f).length, 6, 'at most three pages per group and scan');
    // The native review withholds the absent SKU the same way.
    const refused = await f.prepare(action, {products: [native(product(4))]}, {product_catalog_id: '9001'});
    assert.equal(refused.success, false, reason);
    assert.equal(refused.error.code, 'INVALID_X_CATALOG_PRODUCT', reason);
    assert.equal(refused.error.details.group_expansion, 'incomplete', reason);
    assert.equal(f.writes(), 0, reason);
  }
});

test('qualified: a foreign, repeated or colliding group member and membership that changes between scans are refused', async t => {
  qualify(t, 'qualified');
  for (const [name, mutate] of [
    ['foreign key', f => f.groups[9001][key].push(member(32, {item_group_key: '7700002'}))],
    ['repeated member', f => f.groups[9001][key].push(member(30))],
    [
      'listed individual product',
      f => f.groups[9001][key].push(product(2, {item_group_id: 'Shoe', item_group_key: key})),
    ],
    ['malformed key', f => f.groups[9001][key].push(member(33, {product_key: 'not-a-key'}))],
  ]) {
    const f = groupedWorld(t);
    mutate(f);
    const refused = await f.call();
    assert.equal(refused.success, false, name);
    assert.equal(refused.error.code, 'INCOMPLETE_STATE', name);
    assert.equal(refused.error.message, 'X returned a malformed, repeated or foreign member of a product group.');
    assert.equal(refused.data, undefined, name);
    assert.equal(f.writes(), 0, name);
  }
  let reads = 0;
  const f = groupedWorld(t, {
    read: ({request, result}) => {
      if (request.query?.item_group_key === key && ++reads === 2) result.data.data.push(member(34));
    },
  });
  const changed = await f.call();
  assert.equal(changed.success, false);
  assert.equal(changed.error.code, 'CATALOG_COMPARISON_CHANGED');
  assert.equal(f.writes(), 0);
});

test('the scope guard admits a group-member read of a catalog in scope by one plain group key only', () => {
  const base = {
      gateway: 'x_ads_native_action',
      accountId: 'acct1',
      action: 'x_product_catalogs_product_catalog_id_products_put',
      method: 'PUT',
      path: '/12/product_catalogs/9001/products',
      query: {},
      headers: {},
      readOnly: false,
      destructive: false,
      requiresConfirmation: true,
      evidence: 'synthetic',
      warnings: [],
    },
    read = (query, path = '/12/product_catalogs/9001/products') =>
      xCatalogRead(base, path, query, {xCatalogId: '9001'});
  assert.equal(authorizeXCatalogRead(read({count: 100, item_group_key: key}), 'acct1'), true);
  assert.equal(authorizeXCatalogRead(read({count: 100, item_group_key: key, cursor: '100'}), 'acct1'), true);
  for (const query of [
    {count: 100, item_group_key: ''},
    {count: 100, item_group_key: ' 7700001'},
    {count: 100, item_group_key: 'a\u0000b'},
    {count: 100, item_group_key: key, item_group_id: 'Shoe'},
  ])
    assert.throws(() => authorizeXCatalogRead(read(query), 'acct1'), /Unqualified internal catalog read/);
  assert.throws(
    () => authorizeXCatalogRead(read({item_group_key: key}, '/12/product_catalogs/9001/product_sets'), 'acct1'),
    /Unqualified internal catalog read/,
  );
});

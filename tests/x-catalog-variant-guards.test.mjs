import test from 'node:test';
import assert from 'node:assert/strict';
import {setup, product} from './x-catalog-fixture.mjs';
const source = (native, extra = {}) => {
  const {product_key, inventory, sale_price, item_group_id, additional_image_link, item_group_key, ...fields} = native;
  return {...fields, ...extra};
};
const action = 'x_product_catalogs_product_catalog_id_products_put';

test('native X review withholds absent SKUs when listed group records can hide another variant', async t => {
  const f = setup();
  t.after(() => f.store.close());
  f.items[9001][0].item_group_id = 'Original group';
  const result = await f.prepare(action, {products: [source(product(4))]}, {product_catalog_id: '9001'});
  assert.equal(result.success, false, JSON.stringify(result).slice(0, 1400));
  assert.equal(result.error.code, 'INVALID_X_CATALOG_PRODUCT');
  assert.equal(f.writes(), 0);
  assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 0);
});

test('native X review recognizes key-only groups and refuses missing group evidence while retaining known individual updates', async () => {
  for (const grouping of ['key', 'unknown']) {
    const f = setup();
    try {
      if (grouping === 'key') f.items[9001][0].item_group_key = '7000001';
      else delete f.items[9001][0].item_group_id;
      const result = await f.prepare(
        action,
        {products: [source(product(1), {title: 'Changed individually'})]},
        {product_catalog_id: '9001'},
      );
      assert.equal(result.success, false, grouping + ':' + JSON.stringify(result).slice(0, 1200));
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
  const f = setup();
  try {
    f.items[9001][1].item_group_id = 'Other group';
    const result = await f.prepare(
      action,
      {products: [source(product(1), {title: 'Changed individually'})]},
      {product_catalog_id: '9001'},
    );
    assert.equal(result.success, true, JSON.stringify(result).slice(0, 1200));
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('a key-only group introduced after native X review invalidates unsent before-state without a PUT', async t => {
  const f = setup();
  t.after(() => f.store.close());
  const prepared = await f.prepare(
    action,
    {products: [source(product(1), {title: 'Changed individually'})]},
    {product_catalog_id: '9001'},
  );
  assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 1200));
  f.items[9001][0].item_group_key = '7000001';
  const result = await f.execute(prepared);
  assert.equal(result.success, false, JSON.stringify(result).slice(0, 1400));
  assert.equal(f.writes(), 0);
});

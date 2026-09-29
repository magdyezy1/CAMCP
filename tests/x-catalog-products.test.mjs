import test from 'node:test';
import assert from 'node:assert/strict';
import {actionContracts} from '../dist/src/action-contracts.js';
import {registry, setup, product} from './x-catalog-fixture.mjs';

/**
 * Products of X catalogs, opened by the owner on 2026-09-29, from X's "Catalog Management API Reference" (docs.x.com,
 * read 2026-09-29): PUT products creates an unknown id and updates a known one; DELETE takes product_keys ("a permanent
 * deletion"); GET products lists 100 at a time and shows one product of a group.
 */
const actions = {
  upsert: 'x_product_catalogs_product_catalog_id_products_put',
  remove: 'x_product_catalogs_product_catalog_id_products_delete',
};
const catalog = {product_catalog_id: '9001'};
const item = (extra = {}) => ({
  id: 'sku-new',
  title: 'Abaya',
  description: 'Black abaya\nwith pockets',
  availability: 'in stock',
  condition: 'new',
  price: '250 SAR',
  sale_price: '199.5 SAR',
  link: 'https://shop.example.test/p/new',
  image_link: 'https://shop.example.test/i/new.jpg',
  brand: 'Brand',
  inventory: 4,
  ...extra,
});
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 1200));
  return r;
};
const refused = (r, code) => assert.equal(r.error?.code, code, JSON.stringify(r).slice(0, 800));

test('an unknown id creates one product, sent as JSON and read back with prices as amounts', async () => {
  const x = setup();
  try {
    const p = ok(await x.prepare(actions.upsert, {products: [item()]}, catalog));
    assert.equal(p.data.creative_impact.operation, 'create');
    assert.deepEqual(p.data.creative_impact.creating.price, {amount: 250, currency: 'SAR'});
    ok(await x.execute(p));
    const sent = x.calls.find(c => c.method === 'PUT');
    assert.match(sent.type, /application\/json/);
    assert.deepEqual(sent.body, {products: [item()]});
    assert.equal(x.items[9001].find(r => r.id === 'sku-new').price, '250.00 SAR');
    assert.equal(ok(await x.verify(p)).data.status, 'verified');
  } finally {
    x.store.close();
  }
});

test('a known id replaces the product, names what is not sent, and refuses a no-op', async () => {
  const x = setup();
  try {
    x.items[9001][1] = product(2, {color: 'black', gtin: '12345678'});
    const p = ok(
      await x.prepare(actions.upsert, {products: [item({id: 'sku-2', title: 'Product 2 renamed'})]}, catalog),
    );
    const impact = p.data.creative_impact;
    assert.equal(impact.operation, 'replace');
    assert.equal(impact.before.title, 'Product 2');
    assert.match(impact.warning, /Not sent, with a value today: gtin, color\. X does not say/);
    ok(await x.execute(p));
    assert.equal(ok(await x.verify(p)).data.status, 'verified');
    refused(
      await x.prepare(actions.upsert, {products: [item({id: 'sku-2', title: 'Product 2 renamed'})]}, catalog),
      'INVALID_X_CATALOG_PRODUCT',
    );
    x.items[9001][2] = product(3, {item_group_id: 'grp-1'});
    refused(await x.prepare(actions.upsert, {products: [item({id: 'sku-3'})]}, catalog), 'INVALID_X_CATALOG_PRODUCT');
  } finally {
    x.store.close();
  }
});

test('shapes are refused before any request', async () => {
  const x = setup();
  try {
    for (const [label, payload] of [
      ['two products', {products: [item(), item({id: 'sku-other'})]}],
      ['variant', {products: [item({item_group_id: 'grp'})]}],
      ['product_key', {products: [item({product_key: '5000001'})]}],
      ['no brand, gtin or mpn', {products: [item({brand: undefined})]}],
      ['sale price above price', {products: [item({sale_price: '300 SAR'})]}],
      ['sale price in another currency', {products: [item({sale_price: '10 USD'})]}],
      ['price without currency', {products: [item({price: '250'})]}],
      ['http link', {products: [item({link: 'http://shop.example.test/p'})]}],
      ['HTML description', {products: [item({description: '<b>Bold</b>'})]}],
      ['in stock with none', {products: [item({inventory: 0})]}],
      ['long title', {products: [item({title: 'x'.repeat(151)})]}],
      [
        'eleven images',
        {products: [item({additional_image_link: Array(11).fill('https://s.example.test/a.jpg').join(',')})]},
      ],
      ['unknown availability', {products: [item({availability: 'soon'})]}],
      ['missing image', {products: [item({image_link: undefined})]}],
    ])
      assert.equal(
        (await x.prepare(actions.upsert, JSON.parse(JSON.stringify(payload)), catalog)).success,
        false,
        label,
      );
    for (const payload of [{product_keys: ['5000001', '5000002']}, {product_keys: [5000001]}, {ids: ['sku-1']}])
      assert.equal((await x.prepare(actions.remove, payload, catalog)).success, false, JSON.stringify(payload));
    assert.equal(x.calls.length, 0);
  } finally {
    x.store.close();
  }
});

test('one product is deleted by its key and read back gone; unknown keys and large catalogs are not guessed', async () => {
  const x = setup();
  try {
    const p = ok(await x.prepare(actions.remove, {product_keys: ['5000001']}, catalog));
    assert.equal(p.data.creative_impact.deleting.id, 'sku-1');
    assert.match(p.data.creative_impact.effect, /may come back at its next import/);
    ok(await x.execute(p));
    assert.match(x.calls.find(c => c.method === 'DELETE').type, /application\/json/);
    assert.equal(ok(await x.verify(p)).data.status, 'verified');
    refused(await x.prepare(actions.remove, {product_keys: ['5000999']}, catalog), 'STATE_NOT_FOUND');
    refused(
      await x.prepare(actions.remove, {product_keys: ['5000002']}, {product_catalog_id: '9009'}),
      'STATE_TARGET_MISMATCH',
    );
  } finally {
    x.store.close();
  }
  const big = setup({products: 1200});
  try {
    refused(await big.prepare(actions.upsert, {products: [item()]}, catalog), 'CATALOG_SCAN_LIMIT');
    refused(
      await big.prepare(actions.remove, {product_keys: [product(1150).product_key]}, catalog),
      'CATALOG_SCAN_LIMIT',
    );
    const near = ok(await big.prepare(actions.upsert, {products: [item({id: 'sku-7'})]}, catalog));
    assert.equal(near.data.creative_impact.operation, 'replace');
    assert.equal(big.writes(), 0);
  } finally {
    big.store.close();
  }
  assert.deepEqual(
    actionContracts(registry)
      .filter(r => r.family === 'x_catalog_products')
      .map(r => r.action)
      .sort(),
    Object.values(actions).sort(),
  );
});

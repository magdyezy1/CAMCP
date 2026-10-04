import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogIngestion} from '../dist/src/catalog-ingestion.js';
import {assertMetaCatalogProduct} from '../dist/src/meta-catalog-products.js';
import {metaPrefix} from '../dist/src/meta-version.js';
import {wooSourceFixture, wooSourceInput, wooSourceProduct} from './fixtures/woocommerce-source-data.mjs';

const product = {
  retailer_id: 'SKU-001',
  name: 'Original <shoe>',
  price: '0012.34',
  currency: 'SAR',
  image_url: 'https://shop.example.test/shoe.jpg',
};
const input = products => ({
  gateway: 'meta_native_action',
  account_id: '123',
  connection_id: 'meta',
  catalog_id: '555',
  allow_upsert: false,
  products,
});
const assertNative = body =>
  assertMetaCatalogProduct({
    gateway: 'meta_native_action',
    action: 'meta_product_catalog_id_products_create',
    method: 'POST',
    path: metaPrefix + '555/products',
    accountId: '123',
    headers: {},
    query: {},
    body,
  });

test('WooCommerce preserves surrounding source whitespace and blocks its incompatible destination mapping', async () => {
  for (const extra of [
    {sku: ' SKU-001'},
    {sku: 'SKU-001 '},
    {name: ' Original shoe'},
    {name: 'Original shoe '},
    {sku: '\u00a0SKU-001'},
    {name: 'Original shoe\u00a0'},
  ]) {
    const f = wooSourceFixture();
    try {
      const original = wooSourceProduct(extra);
      f.respond(url =>
        Response.json(url.pathname.includes('/settings/') ? {id: 'woocommerce_currency', value: 'SAR'} : [original], {
          headers: url.pathname.includes('/settings/') ? {} : {'x-wp-total': '1', 'x-wp-totalpages': '1'},
        }),
      );
      const out = await f.service.call('amcp_workspace', wooSourceInput(), f.actor);
      assert.equal(out.success, true, JSON.stringify(out));
      assert.equal(out.data.items[0].sku, original.sku);
      assert.equal(out.data.items[0].name, original.name);
      assert.ok(
        out.data.items[0].blockers.some(message => /surrounding whitespace/.test(message)),
        'The source must not offer an unchanged SKU/name that its native destination refuses',
      );
      assert.equal(out.data.provider_mutations, 0);
      assert.equal(f.calls.length, 4);
      assert.equal(f.store.documents(f.actor.tenantId, 'campaign').length, 0);
    } finally {
      f.close();
    }
  }
});

test('supplied Meta previews refuse the same exact text and URL bounds as their native review', () => {
  for (const extra of [
    {retailer_id: ' SKU-001'},
    {name: 'Original shoe '},
    {brand: 'Brand '},
    {brand: 'B'.repeat(501)},
    {description: ''},
    {description: 'D'.repeat(5001)},
    {image_url: 'https://shop.example.test/' + 'a'.repeat(2049)},
  ]) {
    const original = {...product, ...extra};
    assert.throws(() => assertNative({...original, price: 1234, allow_upsert: false}), {
      code: 'INVALID_META_CATALOG_PRODUCT',
    });
    assert.throws(
      () => catalogIngestion(input([original])),
      {code: 'INVALID_META_CATALOG_PRODUCT'},
      'A local preview must refuse a payload that the existing reviewed native contract refuses',
    );
    assert.deepEqual(original, {...product, ...extra}, 'Reject rather than trim, truncate or replace source fields');
  }
});

test('eligible unchanged WooCommerce source maps to a native-valid payload without write approval', async () => {
  const f = wooSourceFixture();
  try {
    const out = await f.service.call('amcp_workspace', wooSourceInput(), f.actor);
    assert.equal(out.success, true, JSON.stringify(out));
    const row = out.data.items[0];
    assert.deepEqual(row.blockers, []);
    const preview = catalogIngestion(
      input([
        {
          retailer_id: row.sku,
          name: row.name,
          price: row.selected_price,
          currency: out.data.native_currency,
          image_url: row.first_image_url,
          url: row.product_url,
          availability: 'in stock',
        },
      ]),
    );
    const payload = preview.plan.steps[0].arguments.payload;
    assert.doesNotThrow(() => assertNative(payload));
    assert.equal(payload.retailer_id, row.sku);
    assert.equal(payload.name, row.name);
    assert.equal(payload.price, 1234);
    assert.equal(row.selected_price, '0012.34');
    assert.equal(preview.network_requests, 0);
    assert.equal(preview.plan.confirmed, undefined);
    assert.equal(f.calls.length, 4);
    assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 0);
  } finally {
    f.close();
  }
});

test('valid Arabic and literal supplier values retain exact identity, optional text and native price conversion', () => {
  const original = {
    ...product,
    retailer_id: '9007199254740993',
    name: 'حذاء أصلي',
    brand: 'ACME',
    description: 'Supplier <description>',
    price: '0000.01',
    availability: 'out of stock',
  };
  const preview = catalogIngestion(input([original])),
    payload = preview.plan.steps[0].arguments.payload;
  assert.doesNotThrow(() => assertNative(payload));
  for (const key of Object.keys(original).filter(key => key !== 'price')) assert.equal(payload[key], original[key]);
  assert.equal(payload.price, 1);
  assert.equal(original.price, '0000.01');
  assert.equal(preview.network_requests, 0);
  assert.equal(preview.destructive_deletions, 0);
});

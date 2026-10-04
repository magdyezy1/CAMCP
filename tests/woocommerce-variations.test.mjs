import test from 'node:test';
import assert from 'node:assert/strict';
import {wooVariationsFixture, wooVariationInput} from './fixtures/woocommerce-variations-data.mjs';
import {catalogIngestion} from '../dist/src/catalog-ingestion.js';
import {assertMetaCatalogProductFields} from '../dist/src/meta-catalog-products.js';

test('selected variations bracket their exact native parent membership, repeated child values and currency without writes', async () => {
  const f = wooVariationsFixture();
  try {
    const out = await f.service.call('amcp_workspace', wooVariationInput(), f.actor);
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.data.record_kind, 'catalog_source');
    assert.equal(out.data.scope.source_kind, 'variations');
    assert.equal(out.data.scope.parent_product_id, '101');
    assert.equal(out.data.parent.product_id, '101');
    assert.equal(out.data.parent.sku, 'GROUP-001');
    assert.equal(out.data.parent.name, 'Original <shoe>');
    assert.equal(out.data.items[0].product_id, '102');
    assert.equal(out.data.items[0].sku, 'VAR-001');
    assert.equal(out.data.items[0].selected_price, '0012.34');
    assert.equal(out.data.items[0].name, null, 'WooCommerce supplies no native variation name');
    assert.equal(out.data.items[0].requires_title_review, true);
    assert.deepEqual(out.data.items[0].attributes, [
      {id: '1', name: 'Color', option: 'Red'},
      {id: '2', name: 'Size', option: 'Small'},
    ]);
    assert.equal(out.data.native_requests, 6);
    assert.equal(out.data.collected_rows, 4);
    assert.equal(out.data.provider_mutations, 0);
    assert.equal(out.data.full_inventory, false);
    assert.equal(out.data.source_saved, false);
    assert.equal(f.calls.length, 6);
    assert.deepEqual(
      f.calls.map(c => c.url.pathname),
      [
        '/wp-json/wc/v3/settings/general/woocommerce_currency',
        '/wp-json/wc/v3/products/101',
        '/wp-json/wc/v3/products/101/variations',
        '/wp-json/wc/v3/products/101/variations',
        '/wp-json/wc/v3/products/101',
        '/wp-json/wc/v3/settings/general/woocommerce_currency',
      ],
    );
    for (const call of f.calls) {
      assert.equal(call.url.origin, 'https://shop.example.test');
      assert.match(call.options.headers.Authorization, /^Basic /);
      assert.doesNotMatch(call.url.href, /consumer|secret|key/);
    }
    assert.doesNotMatch(JSON.stringify(out), /UNUSED-PRIVATE-WOO|synthetickey|syntheticsecret/);
    assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 0);
  } finally {
    f.close();
  }
});

test('explicit Meta group mapping retains native child SKU, reviewed title and parent group identity', () => {
  const original = {
    retailer_id: 'VAR-001',
    name: 'Reviewed shoe — red, small',
    retailer_product_group_id: 'GROUP-001',
    price: '0012.34',
    currency: 'SAR',
    image_url: 'https://shop.example.test/red-shoe.jpg',
  };
  const preview = catalogIngestion({
      gateway: 'meta_native_action',
      account_id: '123',
      connection_id: 'meta',
      catalog_id: '555',
      allow_upsert: false,
      products: [original],
    }),
    payload = preview.plan.steps[0].arguments.payload;
  assert.doesNotThrow(() => assertMetaCatalogProductFields(payload));
  assert.equal(payload.retailer_id, 'VAR-001');
  assert.equal(payload.retailer_product_group_id, 'GROUP-001');
  assert.equal(payload.name, original.name);
  assert.equal(payload.price, 1234);
  assert.equal(original.price, '0012.34');
  assert.equal(preview.network_requests, 0);
  assert.equal(preview.destructive_deletions, 0);
  assert.equal(preview.plan.confirmed, undefined);
});

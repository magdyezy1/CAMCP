import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogIngestion} from '../dist/src/catalog-ingestion.js';
import {MirrorError} from '../dist/src/errors.js';
import {setup, product} from './x-catalog-fixture.mjs';
import {actor, ok, start, end, metaWorld, metaInput, metaShoe, runPlan} from './fixtures/meta-catalog-world.mjs';

/**
 * COM-02 A: a supplied sale price for Meta and X. Before, the import refused "Unsupported product field: sale_price", so
 * a merchant lost the reference (strike-through) price and a destination's own sale conflicted with every comparison.
 * A synthetic sale round-trips through preview, comparison, native review and read-back for both destinations; a sale
 * at or above the price, in another currency or with an unqualified period is refused before anything is read.
 */
test('Meta: a sale price round-trips through preview, comparison, native review and read-back (regression: Unsupported product field: sale_price)', async t => {
  const f = metaWorld([
    {
      retailer_id: 'SKU-1',
      name: 'Trail shoe',
      price: 49900,
      sale_price: 39900,
      currency: 'SAR',
      image_url: 'https://cdn.example.test/shoe.jpg',
    },
  ]);
  t.after(() => f.store.close());
  const source = metaShoe({sale_price: '349.50', sale_price_start_date: start, sale_price_end_date: end}),
    preview = ok(await f.service.call('amcp_workspace', {action: 'catalog_preview', ...metaInput([source])}, actor));
  assert.equal(preview.items[0].sale_price_minor_units, 34950);
  assert.deepEqual(preview.plan.steps[0].arguments.payload, {
    ...source,
    price: 49900,
    sale_price: 34950,
    allow_upsert: true,
  });
  const before = ok(await f.service.call('amcp_workspace', {action: 'catalog_compare', ...metaInput([source])}, actor));
  const item = before.items[0];
  assert.equal(item.state, 'changed');
  assert.equal(item.price_matches, true);
  assert.equal(item.sale_price_matches, false, "Meta's own sale_price_amount filter decides");
  assert.deepEqual(
    item.changes.find(c => c.field === 'sale_price'),
    {field: 'sale_price', before: '399.00 SAR', after_minor_units: 34950, currency: 'SAR'},
  );
  assert.ok(!item.unsent_fields.includes('sale_price'), 'a sent sale is not a destination-only value');
  assert.ok(f.calls.some(c => /sale_price_amount/.test(c.query.filter ?? '')));
  const plan = ok(await f.service.call('amcp_workspace', {action: 'catalog_plan', ...metaInput([source])}, actor));
  const done = await runPlan(f.service, actor, plan.id);
  assert.equal(done.state, 'complete', JSON.stringify(done.steps).slice(0, 800));
  assert.deepEqual(
    done.steps.map(s => s.status),
    ['verified'],
  );
  assert.equal(f.products.get('SKU-1').sale_price, 34950);
  assert.equal(f.products.get('SKU-1').sale_price_start_date, start, 'the period is kept as written');
  const after = ok(await f.service.call('amcp_workspace', {action: 'catalog_compare', ...metaInput([source])}, actor));
  assert.equal(after.items[0].state, 'matching');
  assert.equal(after.items[0].sale_price_matches, true);
  assert.deepEqual(after.review_retailer_ids, []);
});

test('Meta and X refuse a sale at or above the price, in another currency, below a hundredth for Meta or with an unqualified period', () => {
  const refused = (input, pattern) => {
    let error;
    try {
      catalogIngestion(input);
    } catch (e) {
      error = e;
    }
    assert.ok(error instanceof MirrorError, 'refused: ' + JSON.stringify(input.products[0]));
    assert.match(error.message, pattern);
    return error;
  };
  const x = (extra = {}) => ({
    gateway: 'x_ads_native_action',
    account_id: 'acct1',
    connection_id: 'x',
    catalog_id: '9001',
    allow_upsert: true,
    products: [
      {
        retailer_id: 'sku-1',
        name: 'Product 1',
        price: '20',
        currency: 'SAR',
        image_url: 'https://shop.example.test/i/1.jpg',
        url: 'https://shop.example.test/p/1',
        availability: 'in stock',
        condition: 'new',
        brand: 'Brand',
        description: 'Synthetic product 1',
        ...extra,
      },
    ],
  });
  for (const input of [metaInput([metaShoe({sale_price: '499'})]), x({sale_price: '20.00'})])
    assert.equal(refused(input, /lower than the price/).code, 'INVALID_CATALOG_SALE');
  for (const input of [metaInput([metaShoe({sale_price: '600'})]), x({sale_price: '25'})])
    refused(input, /lower than the price/);
  for (const input of [metaInput([metaShoe({sale_price: '9.99 USD'})]), x({sale_price: '9.99 USD'})]) {
    const error = refused(input, /in the product currency/);
    assert.equal(error.details.currency, 'SAR');
  }
  refused(metaInput([metaShoe({sale_price: '9.999'})]), /hundredths/);
  for (const input of [metaInput([metaShoe({sale_price_start_date: start})]), x({sale_price_end_date: end})])
    refused(input, /needs a sale price/);
  for (const time of ['2026-11-01', '2026-11-01T00:00:00', 'next week'])
    refused(metaInput([metaShoe({sale_price: '9', sale_price_start_date: time})]), /explicit offset/);
  refused(
    metaInput([metaShoe({sale_price: '9', sale_price_start_date: end, sale_price_end_date: start})]),
    /end after it starts/,
  );
  refused(x({sale_price: '9', sale_price_start_date: start}), /both the sale start and the sale end/);
  for (const sale of ['-1', 'abc', '1e3', '12.'])
    refused(metaInput([metaShoe({sale_price: sale})]), /nonnegative decimal sale price/);
  // A sale without a period, and a currency suffix equal to the product currency, are accepted exactly.
  assert.equal(catalogIngestion(metaInput([metaShoe({sale_price: '9.90 SAR'})])).items[0].sale_price_minor_units, 990);
  assert.equal(catalogIngestion(x({sale_price: '19.999999'})).items[0].native_sale_price, '19.999999 SAR');
});

test('X: a sale price and period round-trip through preview, comparison, native review and read-back', async t => {
  const world = setup({tenant: actor.tenantId});
  t.after(() => world.store.close());
  const source = {
      retailer_id: 'sku-1',
      name: 'Product 1',
      price: '20',
      currency: 'SAR',
      image_url: 'https://shop.example.test/i/1.jpg',
      url: 'https://shop.example.test/p/1',
      availability: 'in stock',
      condition: 'new',
      brand: 'Brand',
      description: 'Synthetic product 1',
      sale_price: '15',
      sale_price_start_date: start,
      sale_price_end_date: end,
    },
    input = {
      gateway: 'x_ads_native_action',
      account_id: 'acct1',
      connection_id: 'x',
      catalog_id: '9001',
      allow_upsert: true,
      products: [source],
    },
    call = args => world.service.call('amcp_workspace', args, world.actor);
  const preview = ok(await call({action: 'catalog_preview', ...input}));
  assert.equal(preview.items[0].native_sale_price, '15 SAR');
  assert.equal(preview.items[0].sale_price_effective_date, start + '/' + end);
  const compared = ok(await call({action: 'catalog_compare', ...input}));
  const item = compared.items[0];
  assert.equal(item.state, 'changed');
  assert.equal(item.sale_price_matches, false);
  assert.deepEqual(item.changes, [
    {field: 'sale_price', before: null, after_native_price: '15 SAR'},
    {field: 'sale_price_effective_date', before: null, after: start + '/' + end},
  ]);
  assert.ok(!item.unsent_fields.includes('sale_price'));
  const plan = ok(await call({action: 'catalog_plan', ...input}));
  const done = await runPlan(world.service, world.actor, plan.id);
  assert.equal(done.state, 'complete', JSON.stringify(done.steps).slice(0, 800));
  assert.equal(world.items[9001][0].sale_price, '15.00 SAR', 'X shows the sale with two decimals');
  const again = ok(await call({action: 'catalog_compare', ...input}));
  assert.equal(again.items[0].state, 'matching', 'the exact value matches whatever its written form');
  assert.equal(again.items[0].sale_price_matches, true);
  // A destination sale the source does not send stays a named destination-only value for X (P9 concerns Meta).
  const noSale = {...source};
  delete noSale.sale_price;
  delete noSale.sale_price_start_date;
  delete noSale.sale_price_end_date;
  const kept = ok(await call({action: 'catalog_compare', ...input, products: [noSale]}));
  assert.deepEqual(
    kept.items[0].unsent_fields.filter(k => k.startsWith('sale_price')),
    ['sale_price', 'sale_price_effective_date'],
  );
  assert.equal(kept.items[0].state, 'matching');
  assert.equal(kept.items[0].sale_price_matches, undefined);
  // An unparseable current sale stays unknown instead of becoming a change.
  world.items[9001][0].sale_price = 'on request';
  const unknown = ok(await call({action: 'catalog_compare', ...input}));
  assert.equal(unknown.items[0].state, 'unknown');
  assert.deepEqual(unknown.items[0].unknown_fields, ['sale_price']);
  assert.equal(unknown.items[0].sale_price_matches, null);
  assert.equal(product(2).sale_price, null);
});

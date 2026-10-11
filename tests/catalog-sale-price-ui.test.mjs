import test from 'node:test';
import assert from 'node:assert/strict';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
import {setup} from './x-catalog-fixture.mjs';
import {catalogIngestion} from '../dist/src/catalog-ingestion.js';
import {metaWorld, metaInput, metaShoe, start, end} from './fixtures/meta-catalog-world.mjs';

/**
 * COM-02 A and owner decision P9 on the Commerce page. Each test names the defect it guards against:
 * - a supplied sale price could not be mapped or previewed, and a comparison could not show a sale change;
 * - a Meta product holding values the source does not send read as "Submitted fields match" and left the review set.
 */
const plain = value => JSON.parse(JSON.stringify(value));
const xSource = {
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
};

test('an X CSV with sale columns previews the native sale and compares it exactly in English and Arabic (regression: sale columns refused)', async () => {
  for (const locale of ['en', 'ar']) {
    const world = setup({tenant: 'sale-ui-' + locale});
    try {
      const ui = accountWorkflowFixture(locale);
      ui.context.platforms.push({
        id: 'x',
        gateway: 'x_ads_native_action',
        connections: [{id: 'x', enabled: true, accounts: ['acct1']}],
      });
      const form = ui.node('#catalog-import');
      form.elements.target.value = '1';
      form.elements.catalog_id.value = '9001';
      form.elements.allow_upsert.value = 'true';
      const csv = Object.keys(xSource).join(',') + '\n' + Object.values(xSource).join(',');
      form.elements.file.files = [{size: Buffer.byteLength(csv), text: async () => csv}];
      ui.respond(async args => {
        const result = await world.service.call('amcp_workspace', args, world.actor);
        assert.equal(result.success, true, JSON.stringify(result).slice(0, 800));
        return result.data;
      });
      await ui.run('renderCommerce()');
      await ui.bindings.get('#catalog-import')(form);
      const preview = ui.node('#catalog-preview').innerHTML;
      assert.match(preview, locale === 'ar' ? /سعر التخفيض/ : /Sale price/);
      assert.match(preview, /<bdi>15 SAR<\/bdi><br><bdi>15 SAR<\/bdi>/, 'source and native sale');
      assert.ok(preview.includes(start), 'the literal period is shown');
      assert.deepEqual(plain(ui.calls[0].products), [xSource], 'the sale columns are sent as written');
      await ui.bindings.get('#compare-catalog-products')();
      const html = ui.node('#catalog-comparison').innerHTML;
      assert.match(
        html,
        locale === 'ar'
          ? /سعر التخفيض: <bdi>غير محدد<\/bdi> → <bdi>15 SAR<\/bdi>/
          : /Sale price: <bdi>Not set<\/bdi> → <bdi>15 SAR<\/bdi>/,
      );
      assert.match(html, locale === 'ar' ? /فترة التخفيض/ : /Sale period/);
      assert.match(html, /id="save-catalog-changes"/);
    } finally {
      world.store.close();
    }
  }
});

test('the comparison validator refuses a tampered sale change, a missing or flipped sale match and a sale the source did not send', async () => {
  const ui = accountWorkflowFixture();
  // X: real server evidence for a supplied sale.
  const world = setup({tenant: 'sale-ui-tamper'});
  try {
    const input = {
        gateway: 'x_ads_native_action',
        account_id: 'acct1',
        connection_id: 'x',
        catalog_id: '9001',
        allow_upsert: true,
        products: [xSource],
      },
      out = await world.service.call('amcp_workspace', {action: 'catalog_compare', ...input}, world.actor),
      preview = catalogIngestion(input);
    assert.equal(out.success, true);
    ui.context.args = [out.data, input, preview];
    assert.match(ui.run('catalogComparisonMarkup(...args)'), /15 SAR/);
    for (const mutate of [
      o => (o.items[0].changes[0].after_native_price = '14 SAR'),
      o => (o.items[0].sale_price_matches = true),
      o => delete o.items[0].sale_price_matches,
      o => (o.items[0].changes = o.items[0].changes.slice(1)),
      o => (o.items[0].changes[1].after = start),
      o => (o.items[0].before.sale_price = '15 SAR'),
    ]) {
      const tampered = plain(out.data);
      mutate(tampered);
      ui.context.args = [tampered, input, preview];
      assert.throws(() => ui.run('catalogComparisonMarkup(...args)'), /scope or evidence changed/, mutate.toString());
    }
  } finally {
    world.store.close();
  }
  // Meta: the sale leg of Meta's own filter decides; the change carries the preview's hundredths.
  const meta = metaWorld([
    {
      retailer_id: 'SKU-1',
      name: 'Trail shoe',
      price: 49900,
      sale_price: 39900,
      currency: 'SAR',
      image_url: 'https://cdn.example.test/shoe.jpg',
    },
  ]);
  try {
    const input = metaInput([metaShoe({sale_price: '349.50'})]),
      out = await meta.service.call(
        'amcp_workspace',
        {action: 'catalog_compare', ...input},
        {
          tenantId: 'catalog-sale-price',
          userId: 'operator',
          role: 'operator',
        },
      ),
      preview = catalogIngestion(input);
    assert.equal(out.success, true, JSON.stringify(out).slice(0, 600));
    ui.context.args = [out.data, input, preview];
    assert.match(ui.run('catalogComparisonMarkup(...args)'), /Sale price: 399\.00 SAR → 349\.50 SAR/);
    for (const mutate of [
      o => (o.items[0].changes.find(c => c.field === 'sale_price').after_minor_units = 34900),
      o => (o.items[0].sale_price_matches = true),
      o => (o.items[0].changes = o.items[0].changes.filter(c => c.field !== 'sale_price')),
    ]) {
      const tampered = plain(out.data);
      mutate(tampered);
      ui.context.args = [tampered, input, preview];
      assert.throws(() => ui.run('catalogComparisonMarkup(...args)'), /scope or evidence changed/, mutate.toString());
    }
    // A sale change for a source that sends no sale is refused.
    const noSale = metaInput([metaShoe()]),
      noSalePreview = catalogIngestion(noSale),
      tampered = plain(out.data);
    // Only the sale differs: the scope and source hash are the no-sale source's own.
    tampered.source_hash = noSalePreview.source_hash;
    ui.context.args = [tampered, noSale, noSalePreview];
    assert.throws(() => ui.run('catalogComparisonMarkup(...args)'), /scope or evidence changed/);
    const honest = plain(tampered);
    // Without the sale only the destination's own sale differs: P9 names it and keeps the product in review.
    honest.items[0].changes = honest.items[0].changes.filter(c => c.field !== 'sale_price');
    assert.deepEqual(honest.items[0].changes, []);
    delete honest.items[0].sale_price_matches;
    Object.assign(honest.items[0], {state: 'unknown', unsent_fields: ['sale_price']});
    Object.assign(honest.summary, {changed: 0, unknown: 1, with_destination_only_values: 1});
    ui.context.args = [honest, noSale, noSalePreview];
    assert.doesNotThrow(() => ui.run('catalogComparisonMarkup(...args)'), 'without the sale the same evidence renders');
  } finally {
    meta.store.close();
  }
});

test('P9: a Meta product holding values the source does not send is shown as unknown, enters the review set and names its serving note (regression: read as matching)', async () => {
  for (const locale of ['en', 'ar']) {
    const meta = metaWorld([
      {
        retailer_id: 'SKU-1',
        name: 'Trail shoe',
        price: 49900,
        currency: 'SAR',
        image_url: 'https://cdn.example.test/shoe.jpg',
        visibility: 'staging',
      },
    ]);
    try {
      const input = metaInput([metaShoe()]),
        out = await meta.service.call(
          'amcp_workspace',
          {action: 'catalog_compare', ...input},
          {
            tenantId: 'catalog-sale-price',
            userId: 'operator',
            role: 'operator',
          },
        );
      assert.equal(out.success, true);
      assert.equal(out.data.items[0].state, 'unknown');
      assert.deepEqual(out.data.review_retailer_ids, ['SKU-1']);
      const ui = accountWorkflowFixture(locale);
      ui.context.args = [out.data, input, catalogIngestion(input)];
      const html = ui.run('catalogComparisonMarkup(...args)');
      assert.match(html, locale === 'ar' ? /بعض الحقول غير معروفة/ : /Some fields are unknown/);
      assert.match(
        html,
        locale === 'ar' ? /المنتج الحالي في وضع التجهيز/ : /The current product is in staging, so ads do not show it/,
      );
      assert.match(html, /id="save-catalog-changes"/, 'the product can be saved for review');
      // The same evidence presented as matching is refused.
      const matching = plain(out.data);
      Object.assign(matching.items[0], {state: 'matching'});
      Object.assign(matching.summary, {matching: 1, unknown: 0, needs_review: 0});
      matching.review_retailer_ids = [];
      ui.context.args = [matching, input, catalogIngestion(input)];
      assert.throws(() => ui.run('catalogComparisonMarkup(...args)'), /changed|تغير/);
    } finally {
      meta.store.close();
    }
  }
});

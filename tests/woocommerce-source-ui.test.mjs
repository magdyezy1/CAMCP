import test from 'node:test';
import assert from 'node:assert/strict';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
import {wooSourceFixture, wooSourceInput} from './fixtures/woocommerce-source-data.mjs';
import {catalogIngestion} from '../dist/src/catalog-ingestion.js';
const plain = v => JSON.parse(JSON.stringify(v));
async function fixture(locale = 'en') {
  const f = accountWorkflowFixture(locale),
    backend = wooSourceFixture();
  let evidence;
  try {
    evidence = (await backend.service.call('amcp_workspace', wooSourceInput(), backend.actor)).data;
  } finally {
    backend.close();
  }
  f.context.commerceSources = [
    {
      connection_id: 'woo-login',
      account_id: 'store-1',
      label: 'Original <store>',
      store_origin: 'https://shop.example.test',
    },
  ];
  const form = f.node('#woo-source'),
    importForm = f.node('#catalog-import');
  form.elements.target.value = '0';
  form.elements.product_ids.value = '101';
  form.elements.price_field.value = 'price';
  f.respond(args => (args.action === 'catalog_source' ? plain(evidence) : catalogIngestion(args)));
  await f.run('renderCommerce()');
  return {...f, form, importForm, evidence};
}

test('English and Arabic source readers show exact scoped fields, escape native text and map only explicitly checked products', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = await fixture(locale);
    assert.match(f.node('content').innerHTML, /Original &lt;store&gt;/);
    assert.equal(f.calls.length, 0);
    await f.bindings.get('#woo-source')();
    const html = f.node('#woo-source-result').innerHTML;
    assert.match(html, /Original &lt;shoe&gt;/);
    assert.doesNotMatch(html, /<shoe>|UNUSED-PRIVATE-WOO/);
    assert.match(html, /0012\.34 SAR/);
    assert.match(html, /dir="ltr"/);
    assert.match(html, /scope="col"/);
    assert.match(html, /tabindex="0"/);
    assert.match(html, locale === 'ar' ? /قراءات متتابعة|الضريبة/ : /sequential source evidence|tax calculation/);
    assert.equal(f.node('#woo-source-heading').focused, true);
    assert.throws(() => f.bindings.get('#use-woo-products')(), locale === 'ar' ? /حدّد منتج/ : /Select at least one/);
    f.node('#woo-product-101').checked = true;
    f.bindings.get('#use-woo-products')();
    assert.equal(f.importForm.elements.source_mode.value, 'woocommerce');
    assert.equal(f.importForm.elements.file.required, false);
    assert.equal(f.node('#catalog-csv-controls').hidden, true);
    f.importForm.elements.file.files = [];
    await f.bindings.get('#catalog-import')(f.importForm);
    assert.deepEqual(f.calls[1].products, [
      {
        retailer_id: 'SKU-001',
        name: 'Original <shoe>',
        price: '0012.34',
        currency: 'SAR',
        image_url: 'https://shop.example.test/shoe.jpg',
        url: 'https://shop.example.test/product/shoe',
        availability: 'in stock',
      },
    ]);
    assert.equal(f.calls[1].action, 'catalog_preview');
    assert.equal(f.calls[1].requirements, undefined);
    assert.equal(f.calls[1].source_hash, undefined);
    assert.doesNotMatch(JSON.stringify(f.calls[1]), /tax_status|downloadable|virtual|meta_data|sale_price|description/);
    assert.equal(f.bindings.has('#compare-catalog-products'), true);
    assert.equal(f.calls.length, 2);
    f.respond(() => ({id: 'original source draft'}));
    await f.bindings.get('#create-catalog-plan')();
    assert.equal(f.calls[2].action, 'catalog_plan');
    assert.deepEqual(f.calls[2].products, f.calls[1].products);
    assert.equal(f.calls[2].confirmed, undefined);
    assert.deepEqual(f.visits, ['/campaigns?id=original%20source%20draft']);
    transcripts.push(f.calls);
  }
  assert.deepEqual(transcripts[0], transcripts[1]);
});

test('blockers stay visible, wrong scope cannot render and selected source products cannot bypass X explicit fields', async () => {
  const f = await fixture();
  f.evidence.items[0].blockers = [
    'Only standalone simple products are mapped. Grouped products and variants require separate reconciliation.',
  ];
  await f.bindings.get('#woo-source')();
  assert.match(f.node('#woo-source-result').innerHTML, /standalone simple/);
  assert.doesNotMatch(f.node('#woo-source-result').innerHTML, /id="woo-product-101"/);
  f.evidence.items[0].blockers = [];
  f.evidence.scope.account_id = 'foreign-store';
  await assert.rejects(() => f.bindings.get('#woo-source')(), /selection or scope changed/);
  assert.equal(f.node('#woo-source-result').innerHTML, '');
  f.evidence.scope.account_id = 'store-1';
  await f.bindings.get('#woo-source')();
  f.node('#woo-product-101').checked = true;
  f.bindings.get('#use-woo-products')();
  f.context.platforms.push({
    id: 'x',
    gateway: 'x_ads_native_action',
    connections: [{id: 'x', enabled: true, accounts: ['acct1']}],
  });
  await f.run('renderCommerce()');
  await f.bindings.get('#woo-source')();
  f.node('#woo-product-101').checked = true;
  f.bindings.get('#use-woo-products')();
  f.importForm.elements.target.value = '1';
  await assert.rejects(() => f.bindings.get('#catalog-import')(f.importForm), /all ten explicit CSV fields/);
});

test('source edits or checkbox changes invalidate staged imports and delayed source/preview responses cannot replace a current view', async () => {
  for (const reason of ['source-edit', 'route', 'identity', 'detach']) {
    const f = await fixture();
    let release;
    f.respond(
      () =>
        new Promise(resolve => {
          release = resolve;
        }),
    );
    const pending = f.bindings.get('#woo-source')();
    await new Promise(resolve => setImmediate(resolve));
    if (reason === 'source-edit') f.form.events.get('input')();
    if (reason === 'route') f.context.navigationGeneration++;
    if (reason === 'identity') f.context.identityGeneration++;
    if (reason === 'detach') f.node('#woo-source-result').isConnected = false;
    release(f.evidence);
    await pending;
    assert.equal(f.node('#woo-source-result').innerHTML, '', reason);
    assert.equal(f.bindings.has('#use-woo-products'), false);
  }
  for (const reason of ['source-edit', 'checkbox']) {
    const f = await fixture();
    await f.bindings.get('#woo-source')();
    f.node('#woo-product-101').checked = true;
    f.bindings.get('#use-woo-products')();
    if (reason === 'source-edit') f.form.events.get('input')();
    else f.node('#woo-product-101').events.get('change')();
    assert.equal(f.node('#catalog-woo-selection').innerHTML, '');
    await assert.rejects(() => f.bindings.get('#catalog-import')(f.importForm), /Read and select/);
    assert.equal(f.calls.length, 1);
  }
  const f = await fixture();
  await f.bindings.get('#woo-source')();
  f.node('#woo-product-101').checked = true;
  f.bindings.get('#use-woo-products')();
  let release;
  f.respond(
    () =>
      new Promise(resolve => {
        release = resolve;
      }),
  );
  const pending = f.bindings.get('#catalog-import')(f.importForm);
  await new Promise(resolve => setImmediate(resolve));
  f.form.events.get('change')();
  release(
    catalogIngestion({
      gateway: 'meta_native_action',
      catalog_id: '0001',
      allow_upsert: false,
      products: [
        {
          retailer_id: 'SKU-001',
          name: 'Shoe',
          price: '12.34',
          currency: 'SAR',
          image_url: 'https://shop.example.test/shoe.jpg',
        },
      ],
    }),
  );
  await pending;
  assert.equal(f.node('#catalog-preview').innerHTML, '');
});

test('source handoffs preselect exact current store, product IDs and price field without automatic source reads', async () => {
  for (const locale of ['en', 'ar']) {
    const f = await fixture(locale);
    f.context.location.search =
      '?woo_source=1&connection_id=woo-login&account_id=store-1&product_ids=102%2C101&price_field=sale_price';
    await f.run('renderCommerce()');
    assert.equal(f.form.elements.target.value, '0');
    assert.equal(f.form.elements.product_ids.value, '102, 101');
    assert.equal(f.form.elements.price_field.value, 'sale_price');
    assert.equal(f.calls.length, 0);
    for (const query of [
      '?woo_source=1&connection_id=other&account_id=store-1&product_ids=101&price_field=price',
      '?woo_source=1&connection_id=woo-login&account_id=store-1&product_ids=101&product_ids=102&price_field=price',
      '?woo_source=1&connection_id=woo-login&account_id=store-1&product_ids=01&price_field=price',
    ]) {
      f.form.elements.target.value = '';
      f.form.elements.product_ids.value = '';
      f.form.elements.price_field.value = '';
      f.context.location.search = query;
      await f.run('renderCommerce()');
      assert.equal(f.form.elements.target.value, '');
      assert.equal(f.form.elements.product_ids.value, '');
      assert.equal(f.calls.length, 0);
    }
  }
});

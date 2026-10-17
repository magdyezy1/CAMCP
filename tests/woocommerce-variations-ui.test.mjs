import test from 'node:test';
import assert from 'node:assert/strict';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
import {wooVariationsFixture, wooVariationInput} from './fixtures/woocommerce-variations-data.mjs';
import {catalogIngestion} from '../dist/src/catalog-ingestion.js';
import {offerParkedProviders} from './helpers/parked-providers.mjs';

// WooCommerce is parked (ARC-01, P9): this suite exercises it, so it offers it like a
// deployment whose AMCP_PROVIDERS names it.
offerParkedProviders('woocommerce');
const plain = value => JSON.parse(JSON.stringify(value));
async function fixture(locale = 'en') {
  const f = accountWorkflowFixture(locale),
    backend = wooVariationsFixture();
  let evidence;
  try {
    evidence = (await backend.service.call('amcp_workspace', wooVariationInput(), backend.actor)).data;
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
  form.elements.source_kind.value = 'variations';
  form.elements.parent_product_id.value = '101';
  form.elements.product_ids.value = '102';
  form.elements.price_field.value = 'price';
  f.respond(args => (args.action === 'catalog_source' ? plain(evidence) : catalogIngestion(args)));
  await f.run('renderCommerce()');
  return {...f, form, importForm, evidence};
}

test('English and Arabic variants preserve original hierarchy and require an explicit checked reviewed title before Meta handoff', async () => {
  const payloads = [];
  for (const locale of ['en', 'ar']) {
    const f = await fixture(locale);
    assert.equal(f.calls.length, 0);
    assert.equal(f.form.elements.parent_product_id.disabled, false);
    assert.equal(f.form.elements.parent_product_id.required, true);
    await f.bindings.get('#woo-source')();
    const html = f.node('#woo-source-result').innerHTML;
    assert.match(html, /Original &lt;shoe&gt;/);
    assert.match(html, /GROUP-001/);
    assert.match(html, /VAR-001/);
    assert.match(html, /Color: Red/);
    assert.match(html, /0012\.34 SAR/);
    assert.doesNotMatch(html, /<shoe>|UNUSED-PRIVATE-WOO/);
    assert.match(
      html,
      locale === 'ar'
        ? /اقتراح يراجعه|عنوان المنتج في الوجهة/
        : /operator-reviewed suggestion|Review destination title/,
    );
    assert.throws(() => f.bindings.get('#use-woo-products')(), locale === 'ar' ? /حدّد منتج/ : /Select at least one/);
    f.node('#woo-product-102').checked = true;
    f.node('#woo-title-102').value = ' Reviewed title ';
    assert.throws(() => f.bindings.get('#use-woo-products')(), locale === 'ar' ? /راجع عنوانًا/ : /Review an exact/);
    f.node('#woo-title-102').value = '🙂'.repeat(251);
    assert.throws(() => f.bindings.get('#use-woo-products')(), locale === 'ar' ? /راجع عنوانًا/ : /Review an exact/);
    f.node('#woo-title-102').value = 'My reviewed <shoe> — red, small';
    f.bindings.get('#use-woo-products')();
    assert.equal(f.importForm.elements.source_mode.value, 'woocommerce');
    await f.bindings.get('#catalog-import')(f.importForm);
    assert.deepEqual(f.calls[1].products, [
      {
        retailer_id: 'VAR-001',
        name: 'My reviewed <shoe> — red, small',
        retailer_product_group_id: 'GROUP-001',
        price: '0012.34',
        currency: 'SAR',
        image_url: 'https://shop.example.test/red-shoe.jpg',
        url: 'https://shop.example.test/product/shoe?attribute_color=red',
        availability: 'in stock',
      },
    ]);
    assert.equal(f.calls[1].action, 'catalog_preview');
    assert.equal(f.calls[1].confirmed, undefined);
    assert.equal(f.calls.length, 2);
    payloads.push(f.calls);
    f.node('#woo-title-102').events.get('input')();
    assert.equal(f.node('#woo-product-102').checked, false);
    assert.equal(f.node('#catalog-woo-selection').innerHTML, '');
    await assert.rejects(
      () => f.bindings.get('#catalog-import')(f.importForm),
      locale === 'ar' ? /اقرأ منتجات مصدر WooCommerce/ : /Read and select/,
    );
  }
  assert.deepEqual(payloads[0], payloads[1]);
});

test('variant handoffs preselect exact parent children and price without reading and malformed parent scope cannot render', async () => {
  const f = await fixture();
  f.context.location.search =
    '?woo_source=1&connection_id=woo-login&account_id=store-1&product_ids=102&price_field=sale_price&source_kind=variations&parent_product_id=101';
  await f.run('renderCommerce()');
  assert.equal(f.form.elements.source_kind.value, 'variations');
  assert.equal(f.form.elements.parent_product_id.value, '101');
  assert.equal(f.form.elements.product_ids.value, '102');
  assert.equal(f.form.elements.price_field.value, 'sale_price');
  assert.equal(f.calls.length, 0);
  f.form.elements.price_field.value = 'price';
  f.evidence.scope.parent_product_id = 'foreign';
  await assert.rejects(() => f.bindings.get('#woo-source')(), /source selection or scope changed/);
  assert.equal(f.node('#woo-source-result').innerHTML, '');
});

test('source edits title edits and delayed variant responses cannot reuse a different selected hierarchy or view', async () => {
  for (const reason of ['scope', 'route', 'identity', 'detach']) {
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
    if (reason === 'scope') {
      f.form.elements.parent_product_id.value = '999';
      f.form.events.get('input')();
    }
    if (reason === 'route') f.context.navigationGeneration++;
    if (reason === 'identity') f.context.identityGeneration++;
    if (reason === 'detach') f.node('#woo-source-result').isConnected = false;
    release(f.evidence);
    await pending;
    assert.equal(f.node('#woo-source-result').innerHTML, '', reason);
    assert.equal(f.bindings.has('#use-woo-products'), false, reason);
  }
});

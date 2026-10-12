import test from 'node:test';
import assert from 'node:assert/strict';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
import {
  snapWorld,
  snapProduct,
  snapSource,
  snapAccount,
  snapCatalog,
  snapConnection,
} from './fixtures/snapchat-catalog-world.mjs';
import {catalogIngestion} from '../dist/src/catalog-ingestion.js';

/**
 * COM-02 D on the Commerce page. Before, Commerce offered Meta and X only and said Snapchat catalogs are managed through
 * feeds, so drift between a source and a Snapchat catalog could not be seen. A Snapchat account now opens a read-only
 * comparison: exact native prices, a "fix in the feed" note per product that differs, and no save, retire or removal
 * control, in English and Arabic. The single comparison validator refuses tampered Snapchat evidence.
 */
const plain = value => JSON.parse(JSON.stringify(value));
const csvOf = rows =>
  Object.keys(rows[0]).join(',') +
  '\n' +
  rows
    .map(r =>
      Object.values(r)
        .map(v => '"' + String(v).replaceAll('"', '""') + '"')
        .join(','),
    )
    .join('\n');

async function page(locale) {
  const native = snapWorld([snapProduct(1), snapProduct(2, {title: 'Old name'})], {tenant: 'snap-ui-' + locale});
  const ui = accountWorkflowFixture(locale);
  ui.context.platforms.push({
    id: 'snapchat',
    gateway: 'snapchat_native_action',
    connections: [{id: snapConnection, enabled: true, accounts: [snapAccount]}],
  });
  const form = ui.node('#catalog-import');
  ui.respond(async args => {
    const result = await native.service.call('amcp_workspace', args, native.actor);
    if (!result.success) throw Object.assign(Error(result.error.message), {code: result.error.code});
    return result.data;
  });
  await ui.run('renderCommerce()');
  form.elements.target.value = '1';
  form.elements.target.events?.get('change')?.();
  form.elements.catalog_id.value = snapCatalog;
  const csv = csvOf([snapSource(1), snapSource(2), snapSource(3)]);
  form.elements.file.files = [{size: Buffer.byteLength(csv), text: async () => csv}];
  return {ui, native, form};
}

test('D: a Snapchat account opens a read-only comparison that names the feed as the fix and offers no save, in English and Arabic', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const {ui, native, form} = await page(locale);
    try {
      await ui.bindings.get('#catalog-import')(form);
      const preview = ui.node('#catalog-preview').innerHTML;
      assert.match(preview, locale === 'ar' ? /السعر الأصلي في Snapchat/ : /Native Snapchat price/);
      assert.match(preview, /<bdi>20 SAR<\/bdi>/);
      assert.doesNotMatch(preview, /id="create-catalog-plan"/, 'no draft can be saved for Snapchat');
      assert.doesNotMatch(preview, /inspect-catalog-inventory/);
      assert.equal(ui.calls[0].action, 'catalog_preview');
      await ui.bindings.get('#compare-catalog-products')();
      const html = ui.node('#catalog-comparison').innerHTML;
      assert.match(html, locale === 'ar' ? /مقارنة منتجات Snapchat المرسلة/ : /Supplied Snapchat product comparison/);
      assert.match(
        html,
        locale === 'ar' ? /أصلح هذا المنتج في خلاصة المنتجات\./ : /Fix this product in the product feed\./,
      );
      assert.match(
        html,
        locale === 'ar'
          ? /أصلح المنتجات المختلفة وعددها 2 في خلاصتك/
          : /Fix the 2 products that differ in your feed; AMCP saves no draft for Snapchat\./,
      );
      assert.match(html, /Old name/);
      for (const control of ['save-catalog-changes', 'catalog-retire-', 'save-catalog-retirement', 'catalog-remove-'])
        assert.doesNotMatch(html, new RegExp(control), control);
      assert.equal(native.writes(), 0);
      assert.equal(native.store.documents(native.actor.tenantId, 'campaign_run').length, 0);
      transcripts.push(ui.calls.map(c => c.action));
    } finally {
      native.store.close();
    }
  }
  assert.deepEqual(transcripts[0], transcripts[1]);
  assert.deepEqual(transcripts[0], ['catalog_preview', 'catalog_compare']);
});

test('D: the comparison validator refuses tampered Snapchat evidence and a Snapchat handoff preselects its account and catalog', async () => {
  const native = snapWorld([snapProduct(1), snapProduct(2, {price: {value: '19', currency: 'SAR'}})]);
  try {
    const request = {...native.scope, products: [snapSource(1), snapSource(2)]},
      out = (await native.call({action: 'catalog_compare', ...request})).data,
      preview = catalogIngestion(request);
    const ui = accountWorkflowFixture();
    ui.context.args = [out, request, preview];
    assert.match(ui.run('catalogComparisonMarkup(...args)'), /19 SAR/);
    for (const mutate of [
      o => (o.writes = undefined),
      o => (o.remedy = 'save_draft'),
      o => (o.items[1].fix_in = null),
      o => (o.items[0].fix_in = 'feed'),
      o => (o.items[1].changes[0].after_native_price = '21 SAR'),
      o => (o.items[1].before.price = '20 SAR'),
      o => (o.items[1].price_matches = true),
      o => (o.items[0].unsent_fields = ['visibility']),
      o => (o.review_retailer_ids = []),
    ]) {
      const tampered = plain(out);
      mutate(tampered);
      ui.context.args = [tampered, request, preview];
      assert.throws(() => ui.run('catalogComparisonMarkup(...args)'), /scope or evidence changed/, mutate.toString());
    }
    // A Meta or X comparison never claims the feed-only remedy.
    const meta = {...plain(out), writes: 'feed_only'};
    ui.context.args = [meta, {...request, gateway: 'meta_native_action'}, preview];
    assert.throws(() => ui.run('catalogComparisonMarkup(...args)'), /scope or evidence changed/);
  } finally {
    native.store.close();
  }
  const ui = accountWorkflowFixture();
  ui.context.platforms.push({
    id: 'snapchat',
    gateway: 'snapchat_native_action',
    connections: [{id: snapConnection, enabled: true, accounts: [snapAccount]}],
  });
  ui.context.location.search =
    '?catalog_comparison=1&gateway=snapchat_native_action&connection_id=' +
    snapConnection +
    '&account_id=' +
    snapAccount +
    '&catalog_id=' +
    snapCatalog;
  await ui.run('renderCommerce()');
  const form = ui.node('#catalog-import');
  assert.equal(form.elements.target.value, '1');
  assert.equal(form.elements.catalog_id.value, snapCatalog);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
import {catalogServer} from './fixtures/catalog-server.mjs';

/**
 * COM-03 Phase 2 on the Commerce page: a supplier mapping is saved as the account catalog's versioned profile. Before,
 * the mapping lived only in one browser session, so every import started from nothing and nothing kept the retailer ID
 * column the same between imports. Now loading a file fills the saved columns, names the saved version and identity
 * column, and changing the identity column needs an explicit choice, in English and Arabic.
 */
const csv =
  'SKU,Barcode,Name,Regular price,Images,Private notes\n001,629000001,Home,0012.34,https://example.test/a.png,PRIVATE-1\n002,629000002,Lamp,5,https://example.test/b.png,PRIVATE-2\n';
const columns = {retailer_id: 'SKU', name: 'Name', price: 'Regular price', image_url: 'Images'};
const scope = {gateway: 'meta_native_action', account_id: '001', connection_id: 'meta-login', catalog_id: '0001'};
async function page(t, locale) {
  const ui = accountWorkflowFixture(locale),
    server = catalogServer({tenant: 'catalog-mapping-ui-' + locale});
  t.after(() => server.close());
  const form = ui.node('#catalog-import');
  form.elements.column_mode.value = 'mapped';
  form.elements.fixed_currency.value = 'SAR';
  form.elements.file.files = [{size: Buffer.byteLength(csv), text: async () => csv}];
  ui.respond(server.respond);
  await ui.run('renderCommerce()');
  return {ui, server, form};
}

test('a saved mapping fills the loaded columns and its retailer ID column changes only by explicit choice', async t => {
  for (const locale of ['en', 'ar']) {
    const {ui, server, form} = await page(t, locale);
    // A first import saves version 1 of this account catalog's profile.
    await ui.bindings.get('#catalog-load-columns')();
    for (const [field, column] of Object.entries(columns)) ui.node('#catalog-map-' + field).value = column;
    await ui.bindings.get('#catalog-import')(form);
    const first = ui.calls.find(c => c.action === 'save_catalog_mapping');
    assert.equal(first.revision, 0);
    assert.doesNotMatch(JSON.stringify(ui.calls), /PRIVATE-|Private notes|629000001/);
    // Loading the file again reads only the mapping: its columns are filled and its version and identity are named.
    ui.calls.length = 0;
    await ui.bindings.get('#catalog-load-columns')();
    assert.deepEqual(
      ui.calls.map(c => c.action),
      ['catalog_mapping'],
    );
    for (const [field, column] of Object.entries(columns)) assert.equal(ui.node('#catalog-map-' + field).value, column);
    assert.equal(ui.node('#catalog-map-description').value, '');
    const loaded = ui.node('#catalog-mapping').innerHTML;
    assert.match(loaded, locale === 'ar' ? /الإصدار 1/ : /Saved mapping version 1 of this catalog/);
    assert.match(loaded, /id="catalog-replace-identity"/);
    // Another identity column without the explicit choice is refused before anything is sent.
    ui.node('#catalog-map-retailer_id').value = 'Barcode';
    await assert.rejects(
      () => ui.bindings.get('#catalog-import')(form),
      locale === 'ar' ? /تُعرَّف منتجات هذا الكتالوج بالعمود SKU/ : /identified by the column SKU/,
    );
    assert.deepEqual(
      ui.calls.map(c => c.action),
      ['catalog_mapping'],
    );
    // The explicit choice saves version 2 with the new identity column.
    ui.node('#catalog-replace-identity').checked = true;
    await ui.bindings.get('#catalog-import')(form);
    const replaced = ui.calls.find(c => c.action === 'save_catalog_mapping');
    assert.equal(replaced.revision, 1);
    assert.equal(replaced.requirements.replace_identity_column, true);
    const read = await server.respond({action: 'catalog_mapping', ...scope});
    assert.equal(read.profile.version, 2);
    assert.equal(read.profile.columns.retailer_id, 'Barcode');
    assert.match(ui.node('#catalog-preview').innerHTML, /629000001/);
  }
});

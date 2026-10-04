import test from 'node:test';
import assert from 'node:assert/strict';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
import {catalogIngestion} from '../dist/src/catalog-ingestion.js';
const plain = value => JSON.parse(JSON.stringify(value));
const csv =
  'retailer_id,name,price,currency,image_url,retailer_product_group_id\nVAR-001,Reviewed shoe,0012.34,SAR,https://example.test/child.png,GROUP-001\n';
const supplier =
  'SKU,Title,Price,Image,Parent group,Ignored\nVAR-001,Reviewed shoe,0012.34,https://example.test/child.png,GROUP-001,PRIVATE-COLUMN\n';
const columns = {
  retailer_id: 'SKU',
  name: 'Title',
  price: 'Price',
  image_url: 'Image',
  retailer_product_group_id: 'Parent group',
};

test('canonical and explicitly mapped Meta group CSV preserve native strings and omit unused columns and blank groups', () => {
  const f = accountWorkflowFixture();
  f.context.csv = csv;
  f.context.supplier = supplier;
  f.context.settings = {gateway: 'meta_native_action', columns, fixed_currency: 'SAR', image_mode: 'single'};
  const canonical = plain(f.run('parseProductCSV(csv,"meta_native_action")')),
    mapped = plain(f.run('mapProductCSV(parseProductCSVTable(supplier),settings)'));
  assert.deepEqual(mapped, canonical);
  assert.equal(canonical[0].price, '0012.34');
  assert.equal(canonical[0].retailer_product_group_id, 'GROUP-001');
  assert.doesNotMatch(JSON.stringify(mapped), /PRIVATE-COLUMN|Ignored|Parent group/);
  f.context.settings.columns = {...columns};
  delete f.context.settings.columns.retailer_product_group_id;
  assert.equal(
    Object.hasOwn(
      plain(f.run('mapProductCSV(parseProductCSVTable(supplier),settings)'))[0],
      'retailer_product_group_id',
    ),
    false,
    'A parent-looking supplier column is never inferred',
  );
  f.context.csv = csv.replace('GROUP-001', '');
  assert.equal(Object.hasOwn(plain(f.run('parseProductCSV(csv)'))[0], 'retailer_product_group_id'), false);
});

test('X and unknown destinations reject group CSV or mapping without coercing or silently dropping explicit intent', async () => {
  const f = accountWorkflowFixture();
  f.context.csv = csv;
  f.context.supplier = supplier;
  f.context.settings = {gateway: 'x_ads_native_action', columns, fixed_currency: 'SAR', image_mode: 'single'};
  assert.throws(() => f.run('parseProductCSV(csv,"x_ads_native_action")'), /only product fields/);
  assert.throws(() => f.run('mapProductCSV(parseProductCSVTable(supplier),settings)'), /only columns/);
  assert.throws(() => f.run('parseProductCSV(csv,"foreign_native_action")'), /exact account/);
  f.context.settings.gateway = 'foreign_native_action';
  assert.throws(() => f.run('mapProductCSV(parseProductCSVTable(supplier),settings)'), /exact account/);
  assert.equal(f.calls.length, 0);
  for (const locale of ['en', 'ar']) {
    const current = accountWorkflowFixture(locale),
      form = current.node('#catalog-import');
    current.context.platforms.push({
      id: 'x',
      gateway: 'x_ads_native_action',
      connections: [{id: 'x', enabled: true, accounts: ['acct1']}],
    });
    form.elements.target.value = '1';
    form.elements.file.files = [{size: csv.length, text: async () => csv}];
    await current.run('renderCommerce()');
    await assert.rejects(() => current.bindings.get('#catalog-import')(form));
    assert.equal(current.calls.length, 0, 'Unsupported canonical X group fields stop before workspace submission');
  }
});

test('English and Arabic canonical and supplier group forms preview exact native payloads and clear changed destination columns', async () => {
  const requests = [];
  for (const locale of ['en', 'ar']) {
    const f = accountWorkflowFixture(locale),
      form = f.node('#catalog-import');
    f.context.platforms.push({
      id: 'x',
      gateway: 'x_ads_native_action',
      connections: [{id: 'x', enabled: true, accounts: ['acct1']}],
    });
    form.elements.file.files = [{size: supplier.length, text: async () => supplier}];
    form.elements.column_mode.value = 'mapped';
    form.elements.fixed_currency.value = 'SAR';
    f.respond(catalogIngestion);
    await f.run('renderCommerce()');
    assert.equal(f.calls.length, 0);
    await f.bindings.get('#catalog-load-columns')();
    assert.match(
      f.node('#catalog-mapping').innerHTML,
      locale === 'ar' ? /معرّف مجموعة المنتجات في Meta/ : /Meta product group ID/,
    );
    assert.equal(f.node('#catalog-map-retailer_product_group_id').value, '');
    for (const [field, value] of Object.entries(columns)) f.node('#catalog-map-' + field).value = value;
    await f.bindings.get('#catalog-import')(form);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].products[0].retailer_product_group_id, 'GROUP-001');
    assert.equal(f.calls[0].products[0].price, '0012.34');
    assert.match(f.node('#catalog-preview').innerHTML, /GROUP-001/);
    assert.equal(f.calls[0].confirmed, undefined);
    requests.push(f.calls[0]);
    form.elements.target.value = '1';
    await assert.rejects(
      () => f.bindings.get('#catalog-import')(form),
      locale === 'ar' ? /حمّل أعمدة/ : /Load the selected CSV columns/,
    );
    assert.equal(f.calls.length, 1, 'Column evidence cannot cross a different destination without a change event');
    form.elements.target.value = '0';
    form.elements.target.events.get('change')();
    assert.equal(f.node('#catalog-preview').innerHTML, '');
    assert.equal(f.node('#catalog-mapping').innerHTML, '');
    await assert.rejects(
      () => f.bindings.get('#catalog-import')(form),
      locale === 'ar' ? /حمّل أعمدة/ : /Load the selected CSV columns/,
    );
    form.elements.column_mode.value = 'canonical';
    form.elements.file.files = [{size: csv.length, text: async () => csv}];
    await f.bindings.get('#catalog-import')(form);
    assert.equal(f.calls[1].products[0].retailer_product_group_id, 'GROUP-001');
    requests.push(f.calls[1]);
    form.elements.source_mode.value = 'woocommerce';
    form.elements.source_mode.events.get('change')();
    assert.equal(f.node('#catalog-csv-mapping').hidden, true);
    assert.equal(f.node('#catalog-csv-controls').hidden, true);
    form.elements.source_mode.value = 'csv';
    form.elements.source_mode.events.get('change')();
    assert.equal(f.node('#catalog-csv-mapping').hidden, false);
    assert.equal(f.node('#catalog-csv-controls').hidden, false);
  }
  assert.deepEqual(requests[0], requests[2]);
  assert.deepEqual(requests[1], requests[3]);
  assert.deepEqual(requests[0].products, requests[1].products);
});

test('changing file destination identity or view discards pending group column and preview results', async () => {
  for (const operation of ['columns', 'preview'])
    for (const reason of ['file', 'destination', 'route', 'identity', 'detach']) {
      const f = accountWorkflowFixture(),
        form = f.node('#catalog-import');
      let release;
      const data = new Promise(resolve => {
        release = resolve;
      });
      form.elements.file.files = [{size: csv.length, text: async () => (operation === 'columns' ? data : csv)}];
      form.elements.column_mode.value = operation === 'columns' ? 'mapped' : 'canonical';
      f.respond(() => data);
      await f.run('renderCommerce()');
      const pending =
        operation === 'columns' ? f.bindings.get('#catalog-load-columns')() : f.bindings.get('#catalog-import')(form);
      await new Promise(resolve => setImmediate(resolve));
      if (reason === 'file') {
        form.elements.file.files = [{size: 1, text: async () => ''}];
        form.elements.file.events.get('change')();
      }
      if (reason === 'destination') form.elements.target.events.get('change')();
      if (reason === 'route') f.context.navigationGeneration++;
      if (reason === 'identity') f.context.identityGeneration++;
      if (reason === 'detach')
        f.node(operation === 'columns' ? '#catalog-import' : '#catalog-preview').isConnected = false;
      release(
        operation === 'columns' ? csv : {items: [], source_hash: 'STALE-GROUP-RESULT', meaning: 'STALE-GROUP-RESULT'},
      );
      await pending;
      assert.equal(f.node('#catalog-mapping').innerHTML, '', operation + ':' + reason);
      assert.equal(f.node('#catalog-preview').innerHTML, '', operation + ':' + reason);
    }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogIngestion} from '../dist/src/catalog-ingestion.js';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
import {xImportProduct, xImportInput} from './fixtures/x-catalog-import-data.mjs';
const plain = value => JSON.parse(JSON.stringify(value));
async function fixture(locale = 'en', product = xImportProduct()) {
  const f = accountWorkflowFixture(locale);
  f.context.platforms.push({
    id: 'x',
    gateway: 'x_ads_native_action',
    connections: [{id: 'x', enabled: true, accounts: ['acct1']}],
  });
  const form = f.node('#catalog-import');
  form.elements.target.value = '1';
  form.elements.catalog_id.value = '9001';
  form.elements.allow_upsert.value = 'true';
  const encode = value => '"' + value.replaceAll('"', '""') + '"';
  const text = Object.keys(product).join(',') + '\n' + Object.values(product).map(encode).join(',');
  form.elements.file.files = [{size: Buffer.byteLength(text), text: async () => text}];
  f.respond(args => catalogIngestion(args));
  await f.run('renderCommerce()');
  return {...f, form, product};
}

test('X import renderer offers exact destination fields and bilingual source/native prices without Meta-only comparison', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = await fixture(locale, xImportProduct({price: '999999999999.000002', name: 'Original <label>'}));
    assert.match(f.node('content').innerHTML, /value="1">x/);
    assert.match(
      f.node('#catalog-destination-help').innerHTML,
      locale === 'ar' ? /الوصف النصي/ : /plain text description/,
    );
    assert.equal(f.calls.length, 0);
    await f.bindings.get('#catalog-import')(f.form);
    const html = f.node('#catalog-preview').innerHTML;
    assert.match(html, /999999999999\.000002 SAR/);
    assert.match(html, /000002/);
    assert.match(html, /Original &lt;label&gt;/);
    assert.doesNotMatch(html, /<label>Original|id="compare-catalog-products"/);
    assert.equal(f.bindings.has('#compare-catalog-products'), false);
    assert.match(html, /scope="col"/);
    assert.match(html, /tabindex="0"/);
    assert.match(html, locale === 'ar' ? /وصول مبكر|المبكر/ : /early-access/);
    f.respond(() => ({id: 'saved / x'}));
    await f.bindings.get('#create-catalog-plan')();
    assert.equal(f.calls[1].action, 'catalog_plan');
    assert.equal(f.calls[1].products[0].retailer_id, '001');
    assert.equal(f.calls[1].products[0].price, '999999999999.000002');
    assert.equal(f.calls[1].confirmed, undefined);
    assert.deepEqual(f.visits, ['/campaigns?id=saved%20%2F%20x']);
    transcripts.push(f.calls);
  }
  assert.deepEqual(transcripts[0], transcripts[1]);
});

test('X source mapping requires explicit native fields and keeps unused supplier columns local', async () => {
  const f = await fixture();
  const table = {
    headers: Object.keys(f.product).concat('Private notes'),
    rows: [{...f.product, 'Private notes': 'UNUSED-PRIVATE-X'}],
  };
  const columns = Object.fromEntries(
    Object.keys(f.product)
      .filter(k => k !== 'currency')
      .map(k => [k, k]),
  );
  f.context.mappingArgs = [
    table,
    {gateway: 'x_ads_native_action', columns, fixed_currency: 'SAR', image_mode: 'single'},
  ];
  const products = plain(f.run('mapProductCSV(...mappingArgs)'));
  assert.deepEqual(products, [f.product]);
  assert.doesNotMatch(JSON.stringify(products), /UNUSED-PRIVATE-X/);
  for (const field of ['description', 'url', 'availability', 'condition', 'brand']) {
    f.context.mappingArgs[1].columns = {...columns, [field]: ''};
    assert.throws(() => f.run('mapProductCSV(...mappingArgs)'), /source column/);
  }
});

test('canonical product mode refuses unsupported source columns locally before submitting a preview', async () => {
  const f = await fixture();
  const source =
    Object.keys(f.product).concat('Private notes').join(',') +
    '\n' +
    Object.values(f.product).concat('UNUSED-PRIVATE-X').join(',');
  f.form.elements.file.files = [{size: Buffer.byteLength(source), text: async () => source}];
  await assert.rejects(() => f.bindings.get('#catalog-import')(f.form), /Choose supplier mapping/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.node('#catalog-preview').innerHTML, '');
});

test('X destination changes invalidate old previews and do not silently approve upserts', async () => {
  const f = await fixture();
  f.form.elements.allow_upsert.value = 'false';
  await assert.rejects(() => f.bindings.get('#catalog-import')(f.form), /explicit upsert/);
  assert.equal(f.node('#catalog-preview').innerHTML, '');
  f.form.elements.allow_upsert.value = 'true';
  await f.bindings.get('#catalog-import')(f.form);
  const save = f.bindings.get('#create-catalog-plan'),
    previous = f.calls.length;
  f.form.elements.target.value = '0';
  f.form.elements.target.events.get('change')();
  assert.match(f.node('#catalog-destination-help').innerHTML, /two decimal places/);
  assert.equal(f.node('#catalog-preview').innerHTML, '');
  await save();
  assert.equal(f.calls.length, previous);
});

test('pending X preview or save responses cannot cross an edited form, route, identity or detached view', async () => {
  for (const phase of ['preview', 'save'])
    for (const reason of ['edit', 'route', 'identity', 'detach']) {
      const f = await fixture();
      if (phase === 'save') await f.bindings.get('#catalog-import')(f.form);
      let release;
      f.respond(
        () =>
          new Promise(resolve => {
            release = resolve;
          }),
      );
      const pending =
        phase === 'save' ? f.bindings.get('#create-catalog-plan')() : f.bindings.get('#catalog-import')(f.form);
      await new Promise(resolve => setImmediate(resolve));
      if (reason === 'edit') f.form.events.get('input')();
      if (reason === 'route') f.context.navigationGeneration++;
      if (reason === 'identity') f.context.identityGeneration++;
      if (reason === 'detach') f.node('#catalog-preview').isConnected = false;
      const before = f.node('#catalog-preview').innerHTML;
      release(phase === 'save' ? {id: 'old x plan'} : catalogIngestion(xImportInput()));
      await pending;
      assert.equal(f.node('#catalog-preview').innerHTML, before, phase + ':' + reason);
      assert.equal(f.visits.length, 0);
    }
});

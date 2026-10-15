import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {actor, ok, metaWorld} from './fixtures/meta-catalog-world.mjs';
import {parseCatalogCsv} from '../dist/src/catalog-sources.js';

/**
 * COM-03 Phase 2: the CSV projection runs on the server. Before, the supplier-column mapping (mapProductCSV) ran only
 * in the browser, so an MCP client had to re-implement it and a saved plan could not show which CSV or mapping produced
 * it. A CSV source is now projected by AMCP with its own product columns or the catalog's saved mapping profile; the
 * rules the browser applied are kept exactly: the chosen price column, the fixed currency, the first image of a list,
 * unused columns withheld from the products, nothing guessed, and a row without a required value refused by number.
 */
const scope = {gateway: 'meta_native_action', account_id: '123', connection_id: 'm', catalog_id: '555'},
  csv =
    'SKU,Name,Regular price,Sale price,Images,Private notes\r\n001,Home,0012.34,9.99,"https://example.test/first.png, https://example.test/second.png",UNSELECTED-PRIVATE\r\n',
  columns = {retailer_id: 'SKU', name: 'Name', price: 'Regular price', image_url: 'Images'},
  sha = text => createHash('sha256').update(text).digest('hex');
function world(t) {
  const f = metaWorld();
  t.after(() => f.store.close());
  const call = args => f.service.call('amcp_workspace', {...scope, ...args}, actor);
  return {
    ...f,
    call,
    map: (requirements, extra = {}) => call({action: 'save_catalog_mapping', requirements, ...extra}),
    preview: (source, extra = {}) =>
      call({action: 'catalog_preview', allow_upsert: false, requirements: {source}, ...extra}),
  };
}

test('a profile projects the chosen price, fixed currency and first image exactly and withholds every unused column', async t => {
  const f = world(t);
  const saved = ok(await f.map({columns, fixed_currency: 'SAR', image_mode: 'first_list'}));
  const out = ok(await f.preview({kind: 'csv', text: csv, columns: 'profile', profile_version: 1}));
  assert.deepEqual(out.supplied_products, [
    {retailer_id: '001', name: 'Home', price: '0012.34', image_url: 'https://example.test/first.png', currency: 'SAR'},
  ]);
  assert.doesNotMatch(JSON.stringify(out.supplied_products), /9.99|second.png|UNSELECTED-PRIVATE|Private notes/);
  assert.equal(out.items[0].price_minor_units, 1234, 'the exact source string reaches the destination projection');
  assert.deepEqual(out.source, {
    source_kind: 'csv',
    catalog_source_hash: sha(csv),
    source_rows: 1,
    columns: 'profile',
    mapping_profile: {profile_id: saved.profile.profile_id, version: 1, profile_hash: saved.profile.profile_hash},
    selected_rows: null,
  });
  // Choosing the sale column as the price is an explicit choice, never a guess.
  ok(await f.map({columns: {...columns, price: 'Sale price'}, fixed_currency: 'SAR', image_mode: 'first_list'}));
  const sale = ok(await f.preview({kind: 'csv', text: csv, columns: 'profile'}));
  assert.equal(sale.supplied_products[0].price, '9.99');
  assert.equal(sale.source.mapping_profile.version, 2);
  assert.equal(f.calls.length, 0, 'a preview makes no provider request');
});

test('a currency column keeps each row, single-image mode never splits a URL, and blank optional values stay out', async t => {
  const f = world(t);
  ok(
    await f.map({
      columns: {
        retailer_id: 'id',
        name: 'title',
        price: 'price',
        image_url: 'image',
        currency: 'currency',
        brand: 'brand',
      },
      fixed_currency: '',
      image_mode: 'single',
    }),
  );
  const text =
    'id,title,price,image,currency,brand\n001,Home,0,"https://example.test/a,b.png",SAR,\n002,Second,1.50,https://example.test/c.png,USD,';
  const out = ok(await f.preview({kind: 'csv', text, columns: 'profile'}));
  const [first, second] = out.supplied_products;
  assert.equal(first.image_url, 'https://example.test/a,b.png');
  assert.equal(first.price, '0');
  assert.equal(first.currency, 'SAR');
  assert.equal(second.currency, 'USD');
  assert.equal(Object.hasOwn(first, 'brand'), false);
});

test('AMCP columns need no profile; a source is refused for other columns, missing values, a stale profile or bad CSV', async t => {
  const f = world(t);
  const canonical =
    'retailer_id,name,price,currency,image_url\n001,Home,12.34,SAR,https://example.test/a.png\n002,Lamp,5,SAR,https://example.test/b.png';
  const out = ok(await f.preview({kind: 'csv', text: canonical, columns: 'canonical'}));
  assert.equal(out.supplied_products.length, 2);
  assert.equal(out.source.columns, 'canonical');
  assert.equal(out.source.mapping_profile, null);
  assert.equal(out.item_count, 2);
  const refusals = [
    [{kind: 'csv', text: csv, columns: 'canonical'}, /AMCP columns accept only product fields/],
    [{kind: 'csv', text: csv, columns: 'profile'}, /Save a column mapping for this catalog first/],
    [{kind: 'csv', text: canonical, columns: 'canonical', profile_version: 1}, /A CSV source names kind/],
    [{kind: 'json', text: canonical, columns: 'canonical'}, /A CSV source names kind/],
    [{kind: 'csv', text: 'SKU,SKU\n1,2', columns: 'canonical'}, /unique named CSV columns/],
    [{kind: 'csv', text: 'SKU,Name\n1', columns: 'canonical'}, /match the header columns/],
    [{kind: 'csv', text: 'SKU\n"unclosed', columns: 'canonical'}, /not closed/],
    [{kind: 'csv', text: 'SKU\n"x"extra', columns: 'canonical'}, /after a quoted CSV value/],
    [{kind: 'csv', text: 'retailer_id\n' + Array(501).fill('1').join('\n'), columns: 'canonical'}, /500 products/],
    [{kind: 'csv', text: 'retailer_id\n' + 'a'.repeat(196609), columns: 'canonical'}, /192 KiB/],
    [{kind: 'csv', text: 'retailer_id,name\n', columns: 'canonical'}, /no product rows/],
  ];
  for (const [source, pattern] of refusals) {
    const refused = await f.preview(source);
    assert.equal(refused.success, false, JSON.stringify(source).slice(0, 120));
    assert.match(refused.error.message, pattern, JSON.stringify(source).slice(0, 120));
  }
  ok(await f.map({columns, fixed_currency: 'SAR', image_mode: 'first_list'}));
  const missing = await f.preview({kind: 'csv', text: csv.replace('001,Home', ',Home'), columns: 'profile'});
  assert.equal(missing.success, false);
  assert.match(missing.error.message, /no value for a required product field/);
  assert.deepEqual(missing.error.details, {row: 1, field: 'retailer_id'});
  const absent = await f.preview({kind: 'csv', text: csv.replace('Regular price', 'Price'), columns: 'profile'});
  assert.match(absent.error.message, /only columns from the loaded CSV/);
  const stale = await f.preview({kind: 'csv', text: csv, columns: 'profile', profile_version: 7});
  assert.equal(stale.error.code, 'CATALOG_MAPPING_CHANGED');
  // A source and supplied products together, or a row selection outside catalog_plan, are refused.
  const both = await f.call({
    action: 'catalog_preview',
    products: [{retailer_id: '1'}],
    requirements: {source: {kind: 'csv', text: canonical, columns: 'canonical'}},
  });
  assert.match(both.error.message, /products or a CSV source, not both/);
  const selected = await f.call({
    action: 'catalog_preview',
    requirements: {source: {kind: 'csv', text: canonical, columns: 'canonical'}, select_retailer_ids: ['001']},
  });
  assert.equal(selected.success, false);
  assert.equal(f.calls.length, 0);
});

test('the CSV parser keeps literal quoted content, strips a byte-order mark and leaves blank cells out', () => {
  const table = parseCatalogCsv('﻿SKU,Name,Note\r\n001,"عرض, خاص ""جديد""",\r\n\r\n');
  assert.deepEqual(table.headers, ['SKU', 'Name', 'Note']);
  assert.deepEqual(table.rows, [{SKU: '001', Name: 'عرض, خاص "جديد"'}]);
  assert.deepEqual(parseCatalogCsv('﻿"SKU",Name\n001,Home').headers, ['SKU', 'Name']);
  assert.throws(() => parseCatalogCsv(',Name\n1,2'), /unique named CSV columns/);
  assert.throws(
    () => parseCatalogCsv(Array.from({length: 101}, (_, i) => 'h' + i).join(',') + '\n1'),
    /unique named CSV columns/,
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {mappedCatalogRows, parseCatalogCsv} from '../dist/src/catalog-sources.js';
import {catalogDestinations} from '../dist/src/catalog-destinations.js';
const context = createContext({uiText: (s, vars = {}) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k]), URL});
new Script(readFileSync('web/account-workflows.js', 'utf8')).runInContext(context);
const call = (fn, ...args) => {
  context.args = args;
  return JSON.parse(JSON.stringify(new Script(`${fn}(...args)`).runInContext(context)));
};
const csv =
  'SKU,Name,Regular price,Sale price,Images,Private notes\r\n001,Home,0012.34,9.99,"https://example.test/first.png, https://example.test/second.png",UNSELECTED-PRIVATE\r\n';
const config = {
  columns: {retailer_id: 'SKU', name: 'Name', price: 'Regular price', image_url: 'Images'},
  fixed_currency: 'SAR',
  image_mode: 'first_list',
};
/**
 * COM-03 moved the column mapping to the server: the browser sends only the selected columns
 * (selectedCatalogSource) and AMCP projects them with the catalog's saved mapping profile (mappedCatalogRows). These
 * cases called the browser-only mapProductCSV before; they now check the same rules across both halves.
 */
const mapped = (table, settings, gateway = 'meta_native_action') => {
  const selected = call('selectedCatalogSource', table, {gateway, ...settings});
  return {
    selected,
    products: mappedCatalogRows(parseCatalogCsv(selected.text), catalogDestinations[gateway], {
      columns: selected.columns,
      fixed_currency: settings.fixed_currency,
      image_mode: settings.image_mode,
    }),
  };
};

test('mapped catalog CSV preserves exact source strings, explicitly selects price and image policy and withholds unused columns', () => {
  const table = call('parseProductCSVTable', csv);
  const {selected, products} = mapped(table, config);
  assert.deepEqual(products, [
    {retailer_id: '001', name: 'Home', price: '0012.34', image_url: 'https://example.test/first.png', currency: 'SAR'},
  ]);
  assert.doesNotMatch(JSON.stringify(products), /9.99|second.png|UNSELECTED-PRIVATE|Private notes/);
  // Only the selected columns leave the browser, and of an image list read by its first URL only that URL.
  assert.doesNotMatch(selected.text, /9.99|second.png|UNSELECTED-PRIVATE|Private notes|Sale price/);
  const sale = mapped(table, {...config, columns: {...config.columns, price: 'Sale price'}});
  assert.equal(sale.products[0].price, '9.99');
  assert.equal(table.rows[0]['Private notes'], 'UNSELECTED-PRIVATE', 'local source is not rewritten');
});

test('mapped CSV refuses missing selections, missing required row values and ambiguous currency before preview', () => {
  const table = call('parseProductCSVTable', csv);
  for (const c of [
    {...config, columns: {...config.columns, price: ''}},
    {...config, columns: {...config.columns, price: 'Nonexistent'}},
    {...config, columns: {...config.columns, currency: 'SKU'}},
    {...config, fixed_currency: ''},
    {...config, fixed_currency: 'sar'},
    {...config, image_mode: 'guess'},
    {...config, columns: {...config.columns, invented: 'SKU'}},
  ])
    assert.throws(() => call('selectedCatalogSource', table, c));
  assert.throws(
    () => call('selectedCatalogSource', call('parseProductCSVTable', csv.replace('001,Home', ',Home')), config),
    /row 1.*Retailer ID/,
  );
});

test('CSV parsing rejects duplicate or blank headers and malformed widths, with bounded rows and literal quoted content', () => {
  for (const invalid of [
    'SKU,SKU\n1,2',
    ',Name\n1,2',
    'SKU,Name\n1',
    'SKU\n"unclosed',
    'SKU\n"x"extra',
    Array.from({length: 101}, (_, i) => 'h' + i).join(',') + '\n1',
  ])
    assert.throws(() => call('parseProductCSVTable', invalid));
  // COM-03: a CSV holds at most 500 products in 192 KiB (more than 50 become one plan group); before, the website
  // refused a 51st product and had no way to save a larger store except by splitting it by hand.
  assert.equal(call('parseProductCSVTable', 'SKU\n' + Array(500).fill('1').join('\n')).rows.length, 500);
  assert.throws(() => call('parseProductCSVTable', 'SKU\n' + Array(501).fill('1').join('\n')), /500 products/);
  assert.throws(() => call('parseProductCSVTable', 'SKU\n' + 'a'.repeat(196609)), /192 KiB/);
  const table = call('parseProductCSVTable', '\ufeffSKU,Name\r\n001,"عرض, خاص ""جديد"""\r\n');
  assert.equal(table.rows[0].Name, 'عرض, خاص "جديد"');
  assert.equal(table.rows[0].SKU, '001');
  assert.deepEqual(call('parseProductCSVTable', '\ufeff"SKU",Name\n001,Home').headers, ['SKU', 'Name']);
});

test('mapped currency columns preserve each row and single-image mode never splits a literal URL', () => {
  const table = call(
    'parseProductCSVTable',
    'id,title,price,image,currency,brand\n001,Home,0,"https://example.test/a,b.png",SAR,\n002,Second,1.50,https://example.test/c.png,USD,',
  );
  const {products} = mapped(table, {
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
  });
  assert.equal(products[0].image_url, 'https://example.test/a,b.png');
  assert.equal(products[0].price, '0');
  assert.equal(products[0].currency, 'SAR');
  assert.equal(products[1].currency, 'USD');
  assert.equal(Object.hasOwn(products[0], 'brand'), false);
});

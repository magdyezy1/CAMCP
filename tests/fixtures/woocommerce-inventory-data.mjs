import {wooSourceFixture, wooSourceProduct} from './woocommerce-source-data.mjs';

export const wooInventoryInput = extra => ({
  action: 'catalog_source',
  gateway: 'commerce_native_action',
  account_id: 'store-1',
  connection_id: 'woo-login',
  requirements: {source_kind: 'inventory', price_field: 'price', absent_source_policy: 'retain'},
  ...extra,
});
export const inventoryProduct = (id = 101, extra = {}) =>
  wooSourceProduct({
    id,
    sku: 'SKU-' + id,
    name: 'Native product ' + id,
    variations: [],
    grouped_products: [],
    ...extra,
  });
export const inventoryVariation = (id, extra = {}) => ({
  id,
  sku: 'CHILD-' + id,
  status: 'publish',
  price: '0008.34567',
  regular_price: '10.00',
  sale_price: '',
  stock_status: 'instock',
  tax_status: 'taxable',
  virtual: false,
  downloadable: false,
  date_modified_gmt: '2026-10-06T01:00:00',
  attributes: [{id: 6, name: 'Native <colour>', option: 'Blue & white'}],
  name: 'UNUSED-PRIVATE-INVENTORY',
  meta_data: [{key: 'private', value: 'UNUSED-PRIVATE-INVENTORY'}],
  ...extra,
});
export const inventoryResponse = (body, total, pages, extraHeaders = {}) =>
  new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json',
      'x-wp-total': String(total),
      'x-wp-totalpages': String(pages),
      ...extraHeaders,
    },
  });
export function wooInventoryFixture({products = [inventoryProduct()], variations = new Map(), ...options} = {}) {
  const f = wooSourceFixture(options);
  let handler;
  const native = url => {
    if (url.pathname === '/wp-json/wc/v3/settings/general/woocommerce_currency')
      return new Response(JSON.stringify({id: 'woocommerce_currency', value: 'SAR'}), {
        headers: {'content-type': 'application/json'},
      });
    if (
      url.searchParams.get('context') !== 'view' ||
      url.searchParams.get('orderby') !== 'id' ||
      url.searchParams.get('order') !== 'asc' ||
      url.searchParams.get('per_page') !== '100'
    )
      throw Error('Unqualified synthetic inventory query');
    const match = /^\/wp-json\/wc\/v3\/products\/([1-9][0-9]*)\/variations$/.exec(url.pathname);
    if (!match && url.pathname !== '/wp-json/wc/v3/products') throw Error('Unqualified synthetic inventory route');
    if (url.searchParams.get('status') !== (match ? 'any' : 'publish')) throw Error('Incorrect collection status');
    const rows = match ? (variations.get(match[1]) ?? []) : products,
      page = Number(url.searchParams.get('page'));
    return inventoryResponse(rows.slice((page - 1) * 100, page * 100), rows.length, Math.ceil(rows.length / 100));
  };
  f.respond((url, opts, attempt) => (handler ? handler(url, opts, attempt, native) : native(url)));
  return {
    ...f,
    products,
    variations,
    native,
    inventoryRespond: fn => {
      handler = fn;
    },
  };
}

export const wooInventoryChangedReason =
  'WooCommerce inventory or currency changed between complete scans. Read it again; no changes are proposed.';
export function wooInventoryBrowserData() {
  const products = Array.from({length: 121}, (_, i) => inventoryProduct(i + 1));
  Object.assign(products[0], {type: 'variable', variations: [1001, 1002, '9223372036854775807'], sku: '0001'});
  Object.assign(products[1], {type: 'grouped', grouped_products: [3]});
  products[2].type = 'external';
  Object.assign(products[4], {
    name: '<img src=x onerror="window.wooInventoryUnsafe=1">',
    sku: 'NATIVE-0005',
    price: '999999999999.000001',
  });
  const variations = new Map([
    [
      '1',
      [
        inventoryVariation(1001, {status: 'private'}),
        inventoryVariation(1002, {status: 'draft', price: '', sku: ''}),
        inventoryVariation('9223372036854775807', {price: undefined}),
      ],
    ],
  ]);
  return {products, variations};
}
export function wooInventoryBrowserFixture() {
  const f = wooInventoryFixture(wooInventoryBrowserData());
  let fault = false;
  f.inventoryRespond(async (url, _options, n, native) => {
    const response = native(url);
    if (fault && ((n - 1) % 9) + 1 === 6) {
      const rows = await response.json();
      rows[0].price = '0000.000001';
      return inventoryResponse(rows, 121, 2);
    }
    return response;
  });
  return {
    ...f,
    setFault: value => {
      fault = value;
    },
  };
}

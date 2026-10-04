import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';

export const wooSourceInput = (extra = {}) => ({
  action: 'catalog_source',
  gateway: 'commerce_native_action',
  connection_id: 'woo-login',
  account_id: 'store-1',
  requirements: {product_ids: ['101'], price_field: 'price'},
  ...extra,
});
export const wooSourceProduct = (extra = {}) => ({
  id: 101,
  sku: 'SKU-001',
  name: 'Original <shoe>',
  type: 'simple',
  status: 'publish',
  parent_id: 0,
  price: '0012.34',
  regular_price: '20.00',
  sale_price: '12.34',
  stock_status: 'instock',
  tax_status: 'taxable',
  virtual: false,
  downloadable: false,
  images: [{id: 11, src: 'https://shop.example.test/shoe.jpg', private_note: 'UNUSED-PRIVATE-WOO'}],
  permalink: 'https://shop.example.test/product/shoe',
  date_modified_gmt: '2026-10-04T10:00:00',
  meta_data: [{key: 'private', value: 'UNUSED-PRIVATE-WOO'}],
  downloads: [{file: 'UNUSED-PRIVATE-WOO'}],
  description: 'UNUSED-PRIVATE-WOO',
  ...extra,
});
export function wooSourceFixture({tenant = 'synthetic-woo-source', role = 'reader', allowWrites = false} = {}) {
  const actor = {tenantId: tenant, userId: 'synthetic-reader', role},
    store = new Store(':memory:', Buffer.alloc(32, 41).toString('base64')),
    connection = {
      id: 'woo-login',
      tenantId: tenant,
      gateway: 'commerce_native_action',
      accounts: ['store-1'],
      enabled: true,
      label: 'Synthetic store',
      baseUrl: 'https://shop.example.test',
      apiVersion: 'wc/v3',
      scopes: ['read'],
    },
    credentials = {consumerKey: 'ck_synthetickey', consumerSecret: 'cs_syntheticsecret'};
  store.putConnection({...actor, role: 'admin'}, connection, credentials);
  const calls = [];
  let respond = url =>
    url.pathname.includes('/settings/')
      ? new Response(JSON.stringify({id: 'woocommerce_currency', value: 'SAR', private: 'UNUSED-PRIVATE-WOO'}), {
          headers: {'content-type': 'application/json'},
        })
      : new Response(JSON.stringify([wooSourceProduct()]), {
          headers: {'content-type': 'application/json', 'x-wp-total': '1', 'x-wp-totalpages': '1'},
        });
  const request = async (url, options) => {
    calls.push({url: new URL(url), options});
    return respond(url, options, calls.length);
  };
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      throw Error('Unqualified generic egress');
    }),
    undefined,
    {allowWrites},
    undefined,
    undefined,
    request,
  );
  return {
    actor,
    store,
    service,
    calls,
    connection,
    credentials,
    request,
    respond: fn => {
      respond = fn;
    },
    close: () => store.close(),
  };
}

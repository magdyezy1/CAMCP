import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {wooSourceProduct} from './woocommerce-source-data.mjs';

export const wooConnectionInput = (extra = {}) => ({
  connection_id: '12345678-1234-4123-8123-123456789abc',
  store_origin: 'https://shop.example.test',
  label: 'Synthetic <store>',
  consumer_key: 'ck_setupSyntheticKey',
  consumer_secret: 'cs_setupSyntheticSecret',
  key_permission: 'read',
  confirmed: true,
  ...extra,
});
export const wooConnectionJSON = (value, headers = {}) =>
  new Response(JSON.stringify(value), {headers: {'content-type': 'application/json', ...headers}});
export function wooConnectionFixture({tenant = 'synthetic-woo-connection', encryption = true} = {}) {
  const keyByte = 41,
    store = new Store(':memory:', encryption ? Buffer.alloc(32, keyByte).toString('base64') : undefined),
    actor = {tenantId: tenant, userId: 'synthetic-setup-owner', role: 'admin'},
    calls = [];
  const native = url =>
    url.pathname.includes('/settings/')
      ? wooConnectionJSON({id: 'woocommerce_currency', value: 'SAR', private: 'PRIVATE-SETUP-NATIVE'})
      : wooConnectionJSON([wooSourceProduct({private: 'PRIVATE-SETUP-NATIVE'})], {
          'x-wp-total': '1',
          'x-wp-totalpages': '1',
        });
  let response = native;
  const request = async (url, options) => {
    calls.push({url: new URL(url), options});
    return response(url, options, calls.length, native);
  };
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      throw Error('Unqualified generic egress');
    }),
    undefined,
    {allowWrites: true},
    undefined,
    undefined,
    request,
  );
  return {
    store,
    actor,
    service,
    calls,
    request,
    native,
    keyByte,
    respond: fn => {
      response = fn;
    },
    close: () => store.close(),
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {wooSourceFixture, wooSourceInput, wooSourceProduct} from './fixtures/woocommerce-source-data.mjs';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {wooCommerceRequest} from '../dist/src/woocommerce-source.js';
import {guardedLookup} from '../dist/src/media-link.js';

const productsResponse = (products, headers = {}) =>
  new Response(JSON.stringify(products), {
    headers: {
      'content-type': 'application/json',
      'x-wp-total': String(products.length),
      'x-wp-totalpages': '1',
      ...headers,
    },
  });
const currencyResponse = value =>
  new Response(JSON.stringify({id: 'woocommerce_currency', value}), {headers: {'content-type': 'application/json'}});
const run = f => f.service.call('amcp_workspace', wooSourceInput(), f.actor);

test('selected WooCommerce product source brackets exact native products and currency without provider writes', async () => {
  const f = wooSourceFixture();
  try {
    const out = await f.service.call('amcp_workspace', wooSourceInput(), f.actor);
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.data.record_kind, 'catalog_source');
    assert.equal(out.data.items[0].sku, 'SKU-001');
    assert.equal(out.data.items[0].selected_price, '0012.34');
    assert.equal(out.data.native_currency, 'SAR');
    assert.equal(f.calls.length, 4);
    assert.equal(out.data.provider_mutations, 0);
    assert.equal(out.data.source_saved, false);
    assert.equal(out.data.full_inventory, false);
    assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 0);
    assert.equal(f.store.documents(f.actor.tenantId, 'campaign').length, 0);
    assert.match(out.meta.workflow.website_path, /woo_source=1.*product_ids=101&price_field=price/);
    assert.deepEqual(
      f.calls.map(c => c.url.pathname),
      [
        '/wp-json/wc/v3/settings/general/woocommerce_currency',
        '/wp-json/wc/v3/products',
        '/wp-json/wc/v3/products',
        '/wp-json/wc/v3/settings/general/woocommerce_currency',
      ],
    );
    for (const call of f.calls) {
      assert.match(call.options.headers.Authorization, /^Basic /);
      assert.equal(
        call.options.headers.Authorization,
        'Basic ' + Buffer.from(f.credentials.consumerKey + ':' + f.credentials.consumerSecret).toString('base64'),
      );
      assert.equal(call.url.origin, 'https://shop.example.test');
      assert.doesNotMatch(call.url.href, /consumer|secret|key|token/);
      assert.equal(call.options.signal.aborted, false);
      if (call.url.pathname.endsWith('/products')) {
        assert.equal(call.url.searchParams.get('include'), '101');
        assert.equal(call.url.searchParams.get('status'), 'publish');
        assert.equal(call.url.searchParams.get('per_page'), '100');
        assert.doesNotMatch(
          call.url.searchParams.get('_fields'),
          /description|downloads|meta_data|regular_price|sale_price/,
        );
      }
    }
    assert.doesNotMatch(JSON.stringify(out), /UNUSED-PRIVATE-WOO|synthetickey|syntheticsecret|consumerSecret/);
  } finally {
    f.close();
  }
});

test('source selection preserves exact native integer IDs, chosen price and complete order-independent projections', async () => {
  const f = wooSourceFixture();
  try {
    f.respond((url, _options, n) =>
      url.pathname.includes('/settings/')
        ? currencyResponse('SAR')
        : new Response(
            n === 2
              ? '[{"id":9007199254740993,"sku":"LARGE","name":"Large","type":"simple","status":"publish","parent_id":0,"sale_price":"0001.2300","stock_status":"onbackorder","tax_status":"none","virtual":false,"downloadable":false,"images":[],"permalink":"https://shop.example.test/p/large","date_modified_gmt":"2026-10-04T10:00:00"}]'
              : '[{"id":9007199254740993,"sku":"LARGE","name":"Large","type":"simple","status":"publish","parent_id":0,"sale_price":"0001.2300","stock_status":"onbackorder","tax_status":"none","virtual":false,"downloadable":false,"images":[],"permalink":"https://shop.example.test/p/large","date_modified_gmt":"2026-10-04T10:00:00"}]',
            {headers: {'content-type': 'application/json', 'x-wp-total': '1', 'x-wp-totalpages': '1'}},
          ),
    );
    const out = await f.service.call(
      'amcp_workspace',
      wooSourceInput({requirements: {product_ids: ['9007199254740993'], price_field: 'sale_price'}}),
      f.actor,
    );
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.data.items[0].product_id, '9007199254740993');
    assert.equal(out.data.items[0].selected_price, '0001.2300');
    assert.equal(out.data.items[0].stock_status, 'onbackorder');
    assert.equal(out.data.items[0].blockers.length, 2);
    assert.equal(f.calls[1].url.searchParams.get('_fields').endsWith(',sale_price'), true);
    f.respond((url, _options, n) =>
      url.pathname.includes('/settings/')
        ? currencyResponse('SAR')
        : productsResponse(
            n % 2 === 0
              ? [wooSourceProduct({id: 102, sku: 'TWO'}), wooSourceProduct()]
              : [wooSourceProduct(), wooSourceProduct({id: 102, sku: 'TWO'})],
          ),
    );
    assert.equal(
      (
        await f.service.call(
          'amcp_workspace',
          wooSourceInput({requirements: {product_ids: ['102', '101'], price_field: 'price'}}),
          f.actor,
        )
      ).success,
      true,
    );
  } finally {
    f.close();
  }
});

test('unsupported product types, delivery, duplicate SKUs and missing or unsafe selected fields remain visible blockers', async () => {
  const f = wooSourceFixture();
  try {
    f.respond(url =>
      url.pathname.includes('/settings/')
        ? currencyResponse('SAR')
        : productsResponse([
            wooSourceProduct({id: 101, type: 'variable', parent_id: 0}),
            wooSourceProduct({id: 102, virtual: true}),
            wooSourceProduct({id: 103, sku: '', name: '', price: '99999999999999999999999', images: []}),
          ]),
    );
    const out = await f.service.call(
      'amcp_workspace',
      wooSourceInput({requirements: {product_ids: ['101', '102', '103'], price_field: 'price'}}),
      f.actor,
    );
    assert.equal(out.success, true, JSON.stringify(out));
    assert.match(out.data.items[0].blockers.join(' '), /standalone simple|duplicate SKUs/);
    assert.match(out.data.items[1].blockers.join(' '), /Digital|duplicate SKUs/);
    assert.match(out.data.items[2].blockers.join(' '), /SKU|product name|integer bound|first native image/);
    assert.equal(out.data.items[2].sku, '');
    assert.equal(out.data.items[2].selected_price, '99999999999999999999999');
  } finally {
    f.close();
  }
});

test('missing, foreign, private, duplicate, count or cursor-like pages refuse the entire selected collection', async () => {
  for (const kind of ['missing', 'foreign', 'private', 'duplicate', 'total', 'pages', 'parent', 'malformed']) {
    const f = wooSourceFixture();
    try {
      f.respond(url =>
        url.pathname.includes('/settings/')
          ? currencyResponse('SAR')
          : kind === 'malformed'
            ? new Response('{"private":"cs_syntheticsecret"', {headers: {'content-type': 'application/json'}})
            : productsResponse(
                kind === 'missing'
                  ? []
                  : kind === 'foreign'
                    ? [wooSourceProduct({id: 999})]
                    : kind === 'private'
                      ? [wooSourceProduct({status: 'private'})]
                      : kind === 'duplicate'
                        ? [wooSourceProduct(), wooSourceProduct()]
                        : [wooSourceProduct(kind === 'parent' ? {parent_id: 'not-an-id'} : {})],
                kind === 'total' ? {'x-wp-total': '2'} : kind === 'pages' ? {'x-wp-totalpages': '2'} : {},
              ),
      );
      const out = await run(f);
      assert.equal(out.success, false, kind);
      assert.equal(out.error.code, 'WOOCOMMERCE_SOURCE_INCOMPLETE', kind);
      assert.doesNotMatch(JSON.stringify(out), /SKU-001|cs_syntheticsecret|rows|native_currency/);
    } finally {
      f.close();
    }
  }
});

test('source and currency changes between repeated observations withhold every product', async () => {
  for (const kind of ['price', 'name', 'image', 'sku', 'modified', 'currency']) {
    const f = wooSourceFixture();
    try {
      f.respond((url, _options, n) =>
        url.pathname.includes('/settings/')
          ? currencyResponse(kind === 'currency' && n === 4 ? 'USD' : 'SAR')
          : productsResponse([
              wooSourceProduct(
                n === 3
                  ? kind === 'price'
                    ? {price: '12.35'}
                    : kind === 'name'
                      ? {name: 'Changed'}
                      : kind === 'image'
                        ? {images: [{id: 12, src: 'https://shop.example.test/changed.jpg'}]}
                        : kind === 'sku'
                          ? {sku: 'Changed'}
                          : kind === 'modified'
                            ? {date_modified_gmt: '2026-10-04T11:00:00'}
                            : {}
                  : {},
              ),
            ]),
      );
      const out = await run(f);
      assert.equal(out.success, false, kind);
      assert.equal(out.error.code, 'WOOCOMMERCE_SOURCE_INCOMPLETE');
      assert.equal(out.data, undefined);
      assert.equal(f.calls.length, 4);
    } finally {
      f.close();
    }
  }
});

test('invalid input or unqualified origin, account binding, key or permission stops before authenticated egress', async () => {
  for (const change of [
    {baseUrl: 'http://shop.example.test'},
    {baseUrl: 'https://127.0.0.1'},
    {baseUrl: 'https://shop.example.test/private'},
    {baseUrl: 'https://name:secret@shop.example.test'},
    {baseUrl: 'https://shop.example.test:8443'},
    {baseUrl: 'https://shop.example.test?token=secret'},
    {apiVersion: 'wc/v2'},
    {accounts: ['store-1', 'store-2']},
    {scopes: ['write']},
  ]) {
    const f = wooSourceFixture();
    try {
      f.store.putConnection({...f.actor, role: 'admin'}, {...f.connection, ...change}, f.credentials);
      const out = await run(f);
      assert.equal(out.success, false, JSON.stringify(change));
      assert.equal(f.calls.length, 0);
    } finally {
      f.close();
    }
  }
  for (const requirements of [
    {product_ids: [], price_field: 'price'},
    {product_ids: ['101', '101'], price_field: 'price'},
    {product_ids: ['01'], price_field: 'price'},
    {product_ids: [101], price_field: 'price'},
    {product_ids: ['101'], price_field: 'guessed'},
    {product_ids: ['101'], price_field: 'price', url: 'https://private.test'},
    {product_ids: Array.from({length: 51}, (_, i) => String(i + 1)), price_field: 'price'},
  ]) {
    const f = wooSourceFixture();
    try {
      assert.equal((await f.service.call('amcp_workspace', wooSourceInput({requirements}), f.actor)).success, false);
      assert.equal(f.calls.length, 0);
    } finally {
      f.close();
    }
  }
  const f = wooSourceFixture();
  try {
    f.store.replaceCredentials(f.actor.tenantId, 'woo-login', {accessToken: 'UNUSED-PRIVATE-WOO'});
    assert.equal((await run(f)).success, false);
    assert.equal(f.calls.length, 0);
  } finally {
    f.close();
  }
});

test('current key, origin, scope, connection and actor withdrawal stop all further source egress', async () => {
  for (const change of ['key', 'origin', 'scope', 'connection', 'actor']) {
    const f = wooSourceFixture();
    const key = f.store.createKey({...f.actor, role: 'operator'}),
      actor = f.store.authenticate(key);
    try {
      f.respond((url, _options, n) => {
        if (n === 2) {
          if (change === 'key')
            f.store.replaceCredentials(f.actor.tenantId, 'woo-login', {
              ...f.credentials,
              consumerSecret: 'cs_newsecret',
            });
          if (change === 'origin')
            f.store.putConnection(
              {...f.actor, role: 'admin'},
              {...f.connection, baseUrl: 'https://other.example.test'},
              f.credentials,
            );
          if (change === 'scope')
            f.store.putConnection({...f.actor, role: 'admin'}, {...f.connection, scopes: ['write']}, f.credentials);
          if (change === 'connection')
            f.store.putConnection({...f.actor, role: 'admin'}, {...f.connection, enabled: false}, f.credentials);
          if (change === 'actor') f.store.revokeKey(key);
        }
        return url.pathname.includes('/settings/') ? currencyResponse('SAR') : productsResponse([wooSourceProduct()]);
      });
      const out = await f.service.call('amcp_workspace', wooSourceInput(), actor);
      assert.equal(out.success, false, change);
      assert.equal(f.calls.length, 2, change);
      assert.equal(out.data, undefined);
      assert.doesNotMatch(JSON.stringify(out), /SKU-001|syntheticsecret/);
    } finally {
      f.close();
    }
  }
});

test('body withdrawal, overflow, length mismatch, redirect and native error text are withheld without retries', async () => {
  for (const kind of ['body-key', 'bytes', 'length', 'redirect', 'native-error', 'utf8', 'body-error']) {
    const f = wooSourceFixture();
    try {
      f.respond((url, _options, n) => {
        if (n !== 2) return currencyResponse('SAR');
        if (kind === 'redirect')
          return new Response(null, {
            status: 302,
            headers: {location: 'https://other.example.test?secret=cs_syntheticsecret'},
          });
        if (kind === 'native-error') return new Response('cs_syntheticsecret', {status: 401});
        if (kind === 'bytes')
          return new Response(' '.repeat(4 * 1024 * 1024), {
            headers: {'content-type': 'application/json', 'x-wp-total': '1', 'x-wp-totalpages': '1'},
          });
        if (kind === 'length') return productsResponse([wooSourceProduct()], {'content-length': '1'});
        if (kind === 'utf8')
          return new Response(new Uint8Array([0xc3, 0x28]), {headers: {'content-type': 'application/json'}});
        return new Response(
          new ReadableStream(
            {
              pull(controller) {
                if (kind === 'body-error') {
                  controller.error(Error('cs_syntheticsecret'));
                  return;
                }
                controller.enqueue(new TextEncoder().encode(JSON.stringify([wooSourceProduct()])));
                f.store.replaceCredentials(f.actor.tenantId, 'woo-login', {
                  ...f.credentials,
                  consumerSecret: 'cs_newsecret',
                });
                controller.close();
              },
            },
            {highWaterMark: 0},
          ),
          {headers: {'content-type': 'application/json', 'x-wp-total': '1', 'x-wp-totalpages': '1'}},
        );
      });
      const out = await run(f);
      assert.equal(out.success, false, kind);
      assert.equal(f.calls.length, 2);
      assert.doesNotMatch(JSON.stringify(out), /SKU-001|cs_syntheticsecret|cs_newsecret/);
      assert.equal(out.data, undefined);
    } finally {
      f.close();
    }
  }
});

test('source metadata is local, current and omits disabled, ambiguous or unqualified stores and every credential', async () => {
  const f = wooSourceFixture();
  try {
    const out = await f.service.call('amcp_workspace', {action: 'catalog_sources'}, f.actor);
    assert.equal(out.success, true);
    assert.equal(out.data.items[0].account_id, 'store-1');
    assert.equal(out.data.network_requests, 0);
    assert.equal(f.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(out), /consumer|syntheticsecret|synthetickey/);
    f.store.putConnection({...f.actor, role: 'admin'}, {...f.connection, enabled: false}, f.credentials);
    assert.deepEqual((await f.service.call('amcp_workspace', {action: 'catalog_sources'}, f.actor)).data.items, []);
  } finally {
    f.close();
  }
});

test('fifty selected source IDs fit one native page and custom store reads cannot bypass sandbox selection', async () => {
  const f = wooSourceFixture();
  try {
    const products = Array.from({length: 50}, (_, i) => wooSourceProduct({id: i + 1, sku: 'SKU-' + (i + 1)}));
    f.respond(url => (url.pathname.includes('/settings/') ? currencyResponse('SAR') : productsResponse(products)));
    const out = await f.service.call(
      'amcp_workspace',
      wooSourceInput({requirements: {product_ids: products.map(p => String(p.id)), price_field: 'price'}}),
      f.actor,
    );
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.data.items.length, 50);
    assert.equal(out.data.collected_rows, 100);
    assert.equal(f.calls.length, 4);
    f.service.transport.environment = 'sandbox';
    const rejected = await run(f);
    assert.equal(rejected.success, false);
    assert.equal(rejected.error.code, 'SANDBOX_ROUTE_UNQUALIFIED');
    assert.equal(f.calls.length, 4);
  } finally {
    f.close();
  }
});

test('native WooCommerce HTTPS helper fixes GET, fresh public DNS-checked socket, selected headers and Basic credentials', async t => {
  let observed;
  t.mock.method(https, 'request', (url, options, callback) => {
    observed = {url, options};
    const req = new EventEmitter();
    req.end = () => {
      const response = Readable.from([Buffer.from('{"id":"woocommerce_currency","value":"SAR"}')]);
      response.statusCode = 200;
      response.headers = {'content-type': 'application/json', 'x-private': 'UNUSED-PRIVATE-WOO'};
      callback(response);
    };
    return req;
  });
  const signal = AbortSignal.timeout(30000),
    lookup = guardedLookup(async () => [{address: '8.8.8.8', family: 4}]);
  const response = await wooCommerceRequest(
    new URL('https://shop.example.test/wp-json/wc/v3/settings/general/woocommerce_currency'),
    {signal, lookup, headers: {Authorization: 'Basic synthetic', Accept: 'application/json'}},
  );
  assert.equal(observed.options.method, 'GET');
  assert.equal(observed.options.agent, false);
  assert.equal(observed.options.lookup, lookup);
  assert.equal(observed.options.signal, signal);
  assert.equal(observed.options.headers.Authorization, 'Basic synthetic');
  assert.equal(response.headers.get('x-private'), null);
  assert.equal((await response.json()).value, 'SAR');
  const resolved = await new Promise((resolve, reject) =>
    lookup('shop.example.test', {family: 4, all: false}, (err, address, family) =>
      err ? reject(err) : resolve({address, family}),
    ),
  );
  assert.deepEqual(resolved, {address: '8.8.8.8', family: 4});
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1'])
    await assert.rejects(
      () =>
        new Promise((resolve, reject) =>
          guardedLookup(async () => [{address, family: address.includes(':') ? 6 : 4}])(
            'shop.example.test',
            {all: false},
            error => (error ? reject(error) : resolve()),
          ),
        ),
      /public internet address/,
    );
});

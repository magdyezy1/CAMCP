import test from 'node:test';
import assert from 'node:assert/strict';
import {wooCommerceInventory} from '../dist/src/woocommerce-inventory.js';
import {
  inventoryProduct,
  inventoryVariation,
  inventoryResponse,
  wooInventoryFixture,
  wooInventoryInput,
} from './fixtures/woocommerce-inventory-data.mjs';
import {offerParkedProviders} from './helpers/parked-providers.mjs';

// WooCommerce is parked (ARC-01, P9): this suite exercises it, so it offers it like a
// deployment whose AMCP_PROVIDERS names it.
offerParkedProviders('woocommerce');

const call = f => f.service.call('amcp_workspace', wooInventoryInput(), f.actor);
test('complete multi-page published products and every reported child preserve exact observations, lineage and retention without mutations', async () => {
  const products = Array.from({length: 121}, (_, i) => inventoryProduct(i + 1)),
    children = [
      inventoryVariation(1001, {status: 'private'}),
      inventoryVariation(1002),
      inventoryVariation(1003, {status: 'draft'}),
    ];
  products[69] = inventoryProduct(70, {
    type: 'variable',
    variations: [1003, 1001, 1002],
    name: 'Native <parent>',
    price: '',
  });
  const f = wooInventoryFixture({products, variations: new Map([['70', children]])});
  try {
    const result = await call(f),
      out = result.data;
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(out.record_kind, 'catalog_source_inventory');
    assert.equal(out.complete_collected_inventory, true);
    assert.equal(out.product_count, 121);
    assert.equal(out.variation_count, 3);
    assert.equal(out.item_count, 124);
    assert.equal(out.collected_rows, 248);
    assert.equal(out.native_requests, 9);
    assert.equal(f.calls.length, 9);
    assert.equal(out.native_currency, 'SAR');
    assert.equal(out.items[0].selected_price, '0012.34');
    assert.equal(out.items[121].selected_price, '0008.34567');
    assert.equal(out.items[121].status, 'private');
    assert.equal(out.items[123].status, 'draft');
    assert.equal(out.items[121].name, null);
    assert.equal(out.items[121].parent_name, 'Native <parent>');
    assert.equal(out.items[121].requires_title_review, true);
    assert.deepEqual(out.items[69].variation_ids, ['1001', '1002', '1003']);
    assert.deepEqual(out.items[121].attributes, [{id: '6', name: 'Native <colour>', option: 'Blue & white'}]);
    assert.equal(out.scope.absent_source_policy, 'retain');
    assert.equal(out.scope.product_status, 'publish');
    assert.equal(out.scope.variation_status, 'any');
    assert.equal(out.point_in_time, false);
    assert.equal(out.unpublished_parents_collected, false);
    assert.equal(out.grouped_membership, 'not_independently_verified');
    assert.equal(out.provider_mutations, 0);
    assert.equal(out.destructive_deletions, 0);
    assert.equal(out.saved_drafts, 0);
    assert.equal(out.source_saved, false);
    assert.equal(out.scans.length, 2);
    assert.equal(out.scans[0].pages.length, 3);
    assert.equal(out.scans[0].source_hash, out.scans[1].source_hash);
    assert.equal(out.currency_evidence.length, 3);
    assert.doesNotMatch(
      JSON.stringify(out),
      /UNUSED-PRIVATE|consumerKey|consumerSecret|synthetickey|syntheticsecret|description|downloads|first_image_url/,
    );
    assert.deepEqual(f.store.documents(f.actor.tenantId, 'campaign'), []);
    assert.deepEqual(f.store.documents(f.actor.tenantId, 'write_review'), []);
    for (const {url, options} of f.calls) {
      assert.equal(url.origin, 'https://shop.example.test');
      assert.equal(url.searchParams.has('consumer_key'), false);
      assert.equal(Object.isFrozen(options.headers), true);
      assert.match(options.headers.Authorization, /^Basic /);
      assert.equal(typeof options.lookup, 'function');
      assert.equal(options.signal.aborted, true);
    }
  } finally {
    f.close();
  }
});
test('valid empty inventories and empty memberships remain complete under zero native count metadata', async () => {
  for (const products of [[], [inventoryProduct(1, {type: 'variable'})]]) {
    const f = wooInventoryFixture({products});
    try {
      const result = await call(f);
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(result.data.item_count, products.length);
      assert.equal(result.data.variation_count, 0);
      assert.equal(result.data.native_requests, products.length ? 7 : 5);
    } finally {
      f.close();
    }
  }
});
test('raw unsafe integer IDs are retained from exact JSON source and native empty sale prices are not invented', async () => {
  const f = wooInventoryFixture({products: [inventoryProduct('9223372036854775807')]});
  f.inventoryRespond((url, _opts, _attempt, native) => {
    const response = native(url);
    if (url.pathname.includes('/settings/')) return response;
    const body = JSON.stringify(f.products).replace('"9223372036854775807"', '9223372036854775807');
    return new Response(body, {headers: response.headers});
  });
  try {
    const result = await f.service.call(
      'amcp_workspace',
      wooInventoryInput({requirements: {source_kind: 'inventory', price_field: 'sale_price'}}),
      f.actor,
    );
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.data.items[0].product_id, '9223372036854775807');
    assert.equal(result.data.items[0].selected_price, '12.34');
    f.products[0].sale_price = '';
    const empty = await f.service.call(
      'amcp_workspace',
      wooInventoryInput({requirements: {source_kind: 'inventory', price_field: 'sale_price'}}),
      f.actor,
    );
    assert.equal(empty.success, true, JSON.stringify(empty));
    assert.equal(empty.data.items[0].selected_price, '');
  } finally {
    f.close();
  }
});
test('unknown selectors, caller URLs, mixed modes and destructive source policies refuse before any native read', async () => {
  for (const extra of [
    {requirements: {source_kind: 'inventory', price_field: 'price', absent_source_policy: 'delete'}},
    {requirements: {source_kind: 'inventory', price_field: 'price', product_ids: ['101']}},
    {requirements: {source_kind: 'inventory', price_field: 'price', parent_product_id: '101'}},
    {requirements: {source_kind: 'inventory', price_field: 'price', url: 'https://other.example.test'}},
    {requirements: {source_kind: 'inventory', price_field: 'price', include_variations: false}},
    {requirements: {source_kind: 'inventory', price_field: 'unknown'}},
    {gateway: 'meta_native_action'},
    {payload: {provider: 'anything'}},
  ]) {
    const f = wooInventoryFixture();
    try {
      assert.equal((await f.service.call('amcp_workspace', wooInventoryInput(extra), f.actor)).success, false);
      assert.equal(f.calls.length, 0);
    } finally {
      f.close();
    }
  }
});
test('sandbox, private origin, expired keys and unqualified connection bindings refuse before transport', async () => {
  for (const reason of ['sandbox', 'origin', 'version', 'accounts', 'permission', 'expired']) {
    const f = wooInventoryFixture();
    try {
      if (reason === 'sandbox') {
        await assert.rejects(() => wooCommerceInventory(f.store, f.actor, wooInventoryInput(), f.request, 'sandbox'), {
          code: 'SANDBOX_ROUTE_UNQUALIFIED',
        });
      } else {
        const c = {...f.connection},
          key = {...f.credentials};
        if (reason === 'origin') c.baseUrl = 'https://127.0.0.1';
        if (reason === 'version') c.apiVersion = 'wc/v2';
        if (reason === 'accounts') c.accounts.push('other-store');
        if (reason === 'permission') c.scopes = [];
        if (reason === 'expired') key.expiresAt = Date.now() - 1;
        f.store.putConnection({...f.actor, role: 'admin'}, c, key);
        assert.equal((await call(f)).success, false);
      }
      assert.equal(f.calls.length, 0);
    } finally {
      f.close();
    }
  }
});
test('incomplete counts, changed totals, duplicate or unordered IDs and malformed memberships never produce inventory', async t => {
  const cases = [
    [
      'missing-header',
      (_u, _o, _n, native, url) => {
        const r = native(url);
        r.headers.delete('x-wp-total');
        return r;
      },
    ],
    [
      'noncanonical-count',
      (_u, _o, _n, native, url) => {
        const r = native(url);
        r.headers.set('x-wp-total', '01');
        return r;
      },
    ],
    ['over-limit', () => inventoryResponse([inventoryProduct()], 1001, 11)],
    ['short-page', () => inventoryResponse([inventoryProduct()], 2, 1)],
    ['duplicate', () => inventoryResponse([inventoryProduct(1), inventoryProduct(1)], 2, 1)],
    ['unordered', () => inventoryResponse([inventoryProduct(2), inventoryProduct(1)], 2, 1)],
    ['foreign-status', () => inventoryResponse([inventoryProduct(1, {status: 'private'})], 1, 1)],
    ['foreign-parent', () => inventoryResponse([inventoryProduct(1, {parent_id: 2})], 1, 1)],
    ['duplicate-member', () => inventoryResponse([inventoryProduct(1, {type: 'variable', variations: [2, 2]})], 1, 1)],
    ['self-member', () => inventoryResponse([inventoryProduct(1, {type: 'variable', variations: [1]})], 1, 1)],
    ['unsupported-type', () => inventoryResponse([inventoryProduct(1, {type: 'future-plugin'})], 1, 1)],
    ['unsafe-shape', () => inventoryResponse([inventoryProduct(1, {price: 12.34})], 1, 1)],
  ];
  for (const [name, mutate] of cases)
    await t.test(name, async () => {
      const f = wooInventoryFixture();
      f.inventoryRespond((url, opts, n, native) =>
        url.pathname.includes('/settings/') ? native(url) : mutate(url, opts, n, native, url),
      );
      try {
        const result = await call(f);
        assert.equal(result.success, false);
        assert.equal(result.error.code, 'WOOCOMMERCE_INVENTORY_INCOMPLETE');
      } finally {
        f.close();
      }
    });
  const products = Array.from({length: 101}, (_, i) => inventoryProduct(i + 1)),
    f = wooInventoryFixture({products});
  f.inventoryRespond((url, _opts, _n, native) =>
    url.searchParams.get('page') === '2' ? inventoryResponse([inventoryProduct(101)], 102, 2) : native(url),
  );
  try {
    assert.equal((await call(f)).success, false);
  } finally {
    f.close();
  }
});
test('every variation must belong to its reported parent and memberships cannot overlap another product or child', async t => {
  for (const reason of ['missing-child', 'foreign-child', 'overlap-parent', 'overlap-child', 'duplicate-attributes'])
    await t.test(reason, async () => {
      const products = [
          inventoryProduct(1, {type: 'variable', variations: [10]}),
          inventoryProduct(2, {type: 'variable', variations: [20]}),
        ],
        variations = new Map([
          ['1', [inventoryVariation(10)]],
          ['2', [inventoryVariation(20)]],
        ]);
      if (reason === 'missing-child') variations.set('1', []);
      if (reason === 'foreign-child') variations.set('1', [inventoryVariation(11)]);
      if (reason === 'overlap-parent') products[0].variations = [2];
      if (reason === 'overlap-child') {
        products[1].variations = [10];
        variations.set('2', [inventoryVariation(10)]);
      }
      if (reason === 'duplicate-attributes')
        variations.get('1')[0].attributes.push({...variations.get('1')[0].attributes[0]});
      const f = wooInventoryFixture({products, variations});
      try {
        const out = await call(f);
        assert.equal(out.success, false);
        assert.equal(out.error.code, 'WOOCOMMERCE_INVENTORY_INCOMPLETE');
      } finally {
        f.close();
      }
    });
});
test('unchanged modification dates cannot hide material price, membership, status or currency changes between complete scans', async t => {
  for (const reason of ['price', 'sku', 'status', 'membership', 'currency'])
    await t.test(reason, async () => {
      const products = [inventoryProduct(1, {type: 'variable', variations: [10]})],
        variations = new Map([['1', [inventoryVariation(10)]]]),
        f = wooInventoryFixture({products, variations});
      let parentReads = 0,
        currencyReads = 0;
      f.inventoryRespond((url, _opts, _n, native) => {
        if (url.pathname.includes('/settings/') && ++currencyReads === 2 && reason === 'currency')
          return new Response(JSON.stringify({id: 'woocommerce_currency', value: 'USD'}), {
            headers: {'content-type': 'application/json'},
          });
        if (url.pathname === '/wp-json/wc/v3/products' && ++parentReads === 2) {
          if (reason === 'price') products[0].price = '0012.35';
          if (reason === 'sku') products[0].sku = 'different';
          if (reason === 'status') variations.get('1')[0].status = 'private';
          if (reason === 'membership') {
            products[0].variations = [11];
            variations.set('1', [inventoryVariation(11)]);
          }
        }
        return native(url);
      });
      try {
        const out = await call(f);
        assert.equal(out.success, false);
        assert.equal(out.error.code, 'WOOCOMMERCE_INVENTORY_CHANGED');
      } finally {
        f.close();
      }
    });
});
test('original authorization changes during a read fence the response and prevent further native requests', async () => {
  const f = wooInventoryFixture();
  f.inventoryRespond((url, _opts, n, native) => {
    const response = native(url);
    if (n === 2)
      f.store.putConnection({...f.actor, role: 'admin'}, {...f.connection, scopes: ['read_write']}, f.credentials);
    return response;
  });
  try {
    const out = await call(f);
    assert.equal(out.success, false);
    assert.equal(out.error.code, 'WOOCOMMERCE_SOURCE_CHANGED');
    assert.equal(f.calls.length, 2);
  } finally {
    f.close();
  }
});
test('request ceilings refuse the next operation and never return an incomplete subset', async () => {
  const products = Array.from({length: 32}, (_, i) =>
      inventoryProduct(i + 1, {type: 'variable', variations: [1001 + i]}),
    ),
    variations = new Map(products.map((p, i) => [String(p.id), [inventoryVariation(1001 + i)]])),
    f = wooInventoryFixture({products, variations});
  try {
    const out = await call(f);
    assert.equal(out.success, false);
    assert.equal(out.error.code, 'WOOCOMMERCE_INVENTORY_INCOMPLETE');
    assert.equal(f.calls.length, 64);
  } finally {
    f.close();
  }
});
test('the full item ceiling is collected exactly and combined parent-child overflow is refused', async () => {
  const f = wooInventoryFixture({products: Array.from({length: 1000}, (_, i) => inventoryProduct(i + 1))});
  try {
    const out = await call(f);
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.data.item_count, 1000);
    assert.equal(out.data.collected_rows, 2000);
    assert.equal(out.data.native_requests, 23);
    assert.equal(out.data.scans[0].pages.length, 10);
  } finally {
    f.close();
  }
  const products = Array.from({length: 999}, (_, i) => inventoryProduct(i + 1));
  products[0] = inventoryProduct(1, {type: 'variable', variations: [1001, 1002]});
  const overflow = wooInventoryFixture({
    products,
    variations: new Map([['1', [inventoryVariation(1001), inventoryVariation(1002)]]]),
  });
  try {
    const out = await call(overflow);
    assert.equal(out.success, false);
    assert.equal(out.error.code, 'WOOCOMMERCE_INVENTORY_INCOMPLETE');
  } finally {
    overflow.close();
  }
});
test('every original read boundary cancels its response after authority withdrawal', async t => {
  for (let boundary = 1; boundary <= 7; boundary++)
    await t.test('read ' + boundary, async () => {
      const f = wooInventoryFixture({
        products: [inventoryProduct(1, {type: 'variable', variations: [10]})],
        variations: new Map([['1', [inventoryVariation(10)]]]),
      });
      let cancelled = 0;
      f.inventoryRespond((url, _opts, n, native) => {
        if (n !== boundary) return native(url);
        f.store.putConnection({...f.actor, role: 'admin'}, {...f.connection, scopes: ['read_write']}, f.credentials);
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled++;
            },
          }),
          {headers: {'content-type': 'application/json'}},
        );
      });
      try {
        const out = await call(f);
        assert.equal(out.success, false);
        assert.equal(out.error.code, 'WOOCOMMERCE_SOURCE_CHANGED');
        assert.equal(f.calls.length, boundary);
        assert.equal(cancelled, 1);
      } finally {
        f.close();
      }
    });
});
test('a body-chunk authority change withholds the entire inventory and releases its reader', async () => {
  const f = wooInventoryFixture();
  let cancelled = 0;
  f.inventoryRespond((url, _opts, n, native) => {
    if (n !== 2) return native(url);
    let reads = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (++reads === 1) controller.enqueue(new TextEncoder().encode('['));
        else {
          f.store.putConnection({...f.actor, role: 'admin'}, {...f.connection, scopes: ['read_write']}, f.credentials);
          controller.enqueue(new TextEncoder().encode(']'));
        }
      },
      cancel() {
        cancelled++;
      },
    });
    return new Response(body, {
      headers: {'content-type': 'application/json', 'x-wp-total': '0', 'x-wp-totalpages': '0'},
    });
  });
  try {
    const out = await call(f);
    assert.equal(out.success, false);
    assert.equal(out.error.code, 'WOOCOMMERCE_SOURCE_CHANGED');
    assert.equal(f.calls.length, 2);
    assert.equal(cancelled, 1);
  } finally {
    f.close();
  }
});
test('one monotonic deadline spans all reads and cancels a late response without retry', async t => {
  const now = performance.now.bind(performance),
    initial = now();
  let elapsed = 0;
  t.mock.method(performance, 'now', () => initial + elapsed);
  const f = wooInventoryFixture();
  let cancelled = 0;
  f.inventoryRespond((url, _opts, n, native) => {
    if (n !== 3) return native(url);
    elapsed = 60001;
    return new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
        },
      }),
      {headers: {'content-type': 'application/json'}},
    );
  });
  try {
    const out = await call(f);
    assert.equal(out.success, false);
    assert.equal(out.error.code, 'WOOCOMMERCE_INVENTORY_UNAVAILABLE');
    assert.equal(f.calls.length, 3);
    assert.equal(cancelled, 1);
  } finally {
    f.close();
    t.mock.restoreAll();
  }
});
test('redirects, non-JSON, length mismatch, invalid UTF-8 and endless empty chunks refuse without exposing native bodies', async t => {
  for (const reason of ['redirect', 'html', 'length', 'utf8', 'empty', 'oversize'])
    await t.test(reason, async () => {
      const f = wooInventoryFixture();
      let cancelled = 0;
      f.inventoryRespond((url, _opts, _n, native) => {
        if (url.pathname.includes('/settings/')) return native(url);
        if (reason === 'redirect')
          return new Response('UNUSED-PRIVATE-INVENTORY', {
            status: 302,
            headers: {location: 'https://other.example.test'},
          });
        if (reason === 'html')
          return new Response('UNUSED-PRIVATE-INVENTORY', {headers: {'content-type': 'text/html'}});
        if (reason === 'length') return inventoryResponse(f.products, 1, 1, {'content-length': '1'});
        if (reason === 'utf8')
          return new Response(Buffer.from([0xc3, 0x28]), {headers: {'content-type': 'application/json'}});
        const body = new ReadableStream({
          start(controller) {
            if (reason === 'empty') for (let i = 0; i < 65; i++) controller.enqueue(new Uint8Array());
            else controller.enqueue(new Uint8Array(8 * 1024 * 1024));
          },
          cancel() {
            cancelled++;
          },
        });
        return new Response(body, {
          headers: {'content-type': 'application/json', 'x-wp-total': '1', 'x-wp-totalpages': '1'},
        });
      });
      try {
        const out = await call(f);
        assert.equal(out.success, false);
        assert.doesNotMatch(JSON.stringify(out), /UNUSED-PRIVATE-INVENTORY/);
        if (['empty', 'oversize'].includes(reason)) assert.equal(cancelled, 1);
      } finally {
        f.close();
      }
    });
});

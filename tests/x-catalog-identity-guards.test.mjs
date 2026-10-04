import test from 'node:test';
import assert from 'node:assert/strict';
import {xCatalogComparisonFixture} from './fixtures/x-catalog-comparison.mjs';
import {product} from './x-catalog-fixture.mjs';
import {xCatalogOutcome, xCatalogVerification} from '../dist/src/x-product-catalogs.js';
import {xCatalogProductOutcome} from '../dist/src/x-catalog-products.js';
import {xProductSetOutcome, xProductSetVerification} from '../dist/src/x-product-sets.js';
import {xScheduledFeedOutcome, xScheduledFeedVerification} from '../dist/src/x-scheduled-feeds.js';
const gateway = 'x_ads_native_action',
  catalog = {product_catalog_id: '9001'};
const source = ({product_key, inventory, sale_price, item_group_id, additional_image_link, ...value}) => value;
const operations = [
  ['catalog', 'x_product_catalogs_product_catalog_id_put', {name: 'Changed catalog'}, catalog],
  [
    'product',
    'x_product_catalogs_product_catalog_id_products_put',
    {products: [source(product(1, {title: 'Changed product'}))]},
    catalog,
  ],
  [
    'set',
    'x_product_catalogs_product_catalog_id_product_sets_product_set_id_put',
    {name: 'Changed set'},
    {...catalog, product_set_id: '7001'},
  ],
  [
    'feed',
    'x_product_catalogs_product_catalog_id_scheduled_feeds_scheduled_feed_id_put',
    {start_time: '07:30'},
    {...catalog, scheduled_feed_id: '8001'},
  ],
];
const checked = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 1200));
  return r;
};

test('all four native X catalog families refuse numeric or contradictory catalog ownership instead of coercing it', async () => {
  for (const [name, action, payload, params] of operations)
    for (const malformed of ['numeric', 'owner']) {
      const f = xCatalogComparisonFixture({
        read: ({request, result}) => {
          if (request.path === '/12/product_catalogs' && request.query.user_id === '111') {
            if (malformed === 'numeric') result.data.data[0].id = 9001;
            else result.data.data[0].user_id = '999';
          }
        },
      });
      try {
        const r = await f.prepare(action, payload, params);
        assert.equal(r.success, false, name + ':' + malformed + ':' + JSON.stringify(r).slice(0, 800));
        assert.equal(r.error.code, 'INCOMPLETE_STATE');
        assert.equal(f.writes(), 0);
        assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 0);
      } finally {
        f.store.close();
      }
    }
});

test('product preparation refuses numeric, missing and duplicate native product identities across the scanned collection', async () => {
  for (const malformed of [
    'sku-number',
    'key-number',
    'missing',
    'duplicate-sku',
    'duplicate-key',
    'numeric-cursor',
    'oversize',
  ]) {
    const f = xCatalogComparisonFixture({
      read: ({request, result}) => {
        if (!request.path.endsWith('/products')) return;
        const rows = result.data.data;
        if (malformed === 'sku-number') rows[0].id = 123;
        if (malformed === 'key-number') rows[0].product_key = 5000001;
        if (malformed === 'missing') delete rows[1].product_key;
        if (malformed === 'duplicate-sku') rows[2].id = rows[1].id;
        if (malformed === 'duplicate-key') rows[2].product_key = rows[1].product_key;
        if (malformed === 'numeric-cursor') result.data.next_cursor = 300;
        if (malformed === 'oversize') result.data.data = Array.from({length: 101}, (_, i) => product(i + 1));
      },
    });
    try {
      const payload = {
        products: [source(product(1, {id: malformed === 'sku-number' ? '123' : 'sku-1', title: 'Changed product'}))],
      };
      const r = await f.prepare(operations[1][1], payload, catalog);
      assert.equal(r.success, false, malformed + ':' + JSON.stringify(r).slice(0, 800));
      assert.equal(r.error.code, 'INCOMPLETE_STATE');
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});

test('product deletion and manual-set product selection refuse numeric generated product keys', async () => {
  for (const [action, payload] of [
    ['x_product_catalogs_product_catalog_id_products_delete', {product_keys: ['5000001']}],
    [
      'x_product_catalogs_product_catalog_id_product_sets_post',
      {name: 'New source set', type: 'MANUAL', product_keys: ['5000001']},
    ],
  ]) {
    const f = xCatalogComparisonFixture({
      read: ({request, result}) => {
        if (request.path.endsWith('/products')) result.data.data[0].product_key = 5000001;
      },
    });
    try {
      const r = await f.prepare(action, payload, catalog);
      assert.equal(r.success, false, JSON.stringify(r).slice(0, 800));
      assert.equal(r.error.code, 'INCOMPLETE_STATE');
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});

test('set and feed identity, parent and manual membership evidence remain typed and complete', async () => {
  for (const operation of operations.slice(2))
    for (const malformed of ['numeric', 'duplicate', 'parent', 'membership', 'missing_membership']) {
      if (operation[0] === 'feed' && ['membership', 'missing_membership'].includes(malformed)) continue;
      const f = xCatalogComparisonFixture({
        read: ({request, result}) => {
          if (!request.path.endsWith(operation[0] === 'set' ? '/product_sets' : '/scheduled_feeds')) return;
          const row = result.data.data[0];
          if (malformed === 'numeric') row.id = Number(row.id);
          if (malformed === 'duplicate') result.data.data.push(structuredClone(row));
          if (malformed === 'parent') row.product_catalog_id = '9009';
          if (malformed === 'membership') row.product_ids = [123];
          if (malformed === 'missing_membership') delete row.product_ids;
        },
      });
      try {
        const r = await f.prepare(operation[1], operation[2], operation[3]);
        assert.equal(r.success, false, operation[0] + ':' + malformed + ':' + JSON.stringify(r).slice(0, 800));
        assert.equal(r.error.code, 'INCOMPLETE_STATE');
        assert.equal(f.writes(), 0);
      } finally {
        f.store.close();
      }
    }
});

test('accepted X product receipts recover read-only after malformed identity read-back and never repeat the original PUT', async t => {
  let malformed = false;
  const f = xCatalogComparisonFixture({
    read: ({request, result}) => {
      if (malformed && request.path.endsWith('/products')) result.data.data[0].product_key = 5000001;
    },
  });
  t.after(() => f.store.close());
  const p = checked(await f.prepare(operations[1][1], operations[1][2], catalog));
  const accepted = checked(await f.execute(p));
  assert.equal(f.writes(), 1);
  malformed = true;
  const observed = checked(await f.verify(p));
  assert.equal(observed.data.status, 'unverified');
  const replay = checked(await f.execute(p));
  assert.equal(replay.data.replayed, true);
  assert.deepEqual(replay.data.data, accepted.data.data);
  assert.equal(f.writes(), 1);
  malformed = false;
  const recovered = checked(await f.verify(p));
  assert.equal(recovered.data.status, 'verified');
  assert.equal(recovered.data.verification_cache_version, 'x-catalog-identities-v3');
  const reads = f.calls.length;
  assert.equal(checked(await f.verify(p)).data.cached, true);
  assert.equal(f.calls.length, reads);
  assert.equal(f.writes(), 1);
});

test('each native X catalog family retires legacy verified identity caches while retaining original accepted receipt recovery', async () => {
  for (const [name, action, payload, params] of operations) {
    const f = xCatalogComparisonFixture();
    try {
      const p = checked(await f.prepare(action, payload, params)),
        accepted = checked(await f.execute(p));
      f.store.putDocument(f.actor.tenantId, 'write_verification', p.data.review_id, {
        status: 'verified',
        checked_at: Date.now(),
        checks: [],
        ...(name === 'product' || name === 'set' ? {verification_cache_version: 'x-catalog-decimal-v2'} : {}),
      });
      const reads = f.calls.length,
        result = checked(await f.verify(p)).data;
      assert.equal(result.cached, undefined, name);
      assert.ok(f.calls.length > reads, name);
      assert.equal(result.status, 'verified', name);
      assert.equal(result.verification_cache_version, 'x-catalog-identities-v3');
      const cachedReads = f.calls.length;
      assert.equal(checked(await f.verify(p)).data.cached, true);
      assert.equal(f.calls.length, cachedReads);
      const replay = checked(await f.execute(p));
      assert.equal(replay.data.replayed, true);
      assert.deepEqual(replay.data.data, accepted.data.data);
      assert.equal(f.writes(), 1);
    } finally {
      f.store.close();
    }
  }
});

test('native X catalog outcomes require exact string receipt identities without coercing provider numbers', () => {
  const plan = (path, body, method = 'PUT') => ({
    gateway,
    accountId: 'acct1',
    path,
    body,
    method,
    query: {},
    headers: {},
    readOnly: false,
  });
  const cases = [
    [xCatalogOutcome, plan('/12/product_catalogs/9001', {name: 'Changed'}), {id: '9001', name: 'Changed'}, 'id'],
    [
      xProductSetOutcome,
      plan('/12/product_catalogs/9001/product_sets/7001', {name: 'Changed'}),
      {id: '7001', name: 'Changed'},
      'id',
    ],
    [
      xScheduledFeedOutcome,
      plan('/12/product_catalogs/9001/scheduled_feeds/8001', {start_time: '07:30'}),
      {id: '8001', start_time: '07:30'},
      'id',
    ],
    [
      xCatalogProductOutcome,
      plan('/12/product_catalogs/9001/products', {products: [source(product(1, {id: '123'}))]}),
      {products_response: [{id: '123', status: 'UPDATE_SUCCESS'}]},
      'product',
    ],
    [
      xCatalogProductOutcome,
      plan('/12/product_catalogs/9001/products', {product_keys: ['5000001']}, 'DELETE'),
      {delete_products: [{product_key: '5000001'}]},
      'delete',
    ],
  ];
  for (const [outcome, p, data, kind] of cases) {
    assert.equal(outcome(p, {status: 200, headers: {}, data: {data}}), true, kind);
    const wrong = structuredClone(data);
    if (kind === 'product') wrong.products_response[0].id = 123;
    else if (kind === 'delete') wrong.delete_products[0].product_key = 5000001;
    else wrong.id = Number(wrong.id);
    assert.equal(outcome(p, {status: 200, headers: {}, data: {data: wrong}}), false, kind);
  }
});

test('create verification never derives catalog, set or feed identity from a numeric original receipt', () => {
  const base = {gateway, accountId: 'acct1', method: 'POST', query: {}, headers: {}, readOnly: false};
  for (const [verify, path, body] of [
    [xCatalogVerification, '/12/product_catalogs', {name: 'New', user_id: '333'}],
    [
      xProductSetVerification,
      '/12/product_catalogs/9001/product_sets',
      {name: 'New', type: 'MANUAL', product_keys: ['5000001']},
    ],
    [
      xScheduledFeedVerification,
      '/12/product_catalogs/9001/scheduled_feeds',
      {
        feed_url: 'https://shop.example.test/feed.csv',
        feed_format: 'CSV',
        frequency: 'DAILY',
        start_time: '03:00',
        time_zone: 'Asia/Riyadh',
      },
    ],
  ]) {
    const p = {...base, path, body};
    assert.throws(
      () => verify(p, {data: {data: {id: 9001}}}, []),
      error => error.code === 'INCOMPLETE_STATE',
    );
  }
});

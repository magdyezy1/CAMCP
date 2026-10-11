import test from 'node:test';
import assert from 'node:assert/strict';
import {xCatalogComparisonFixture, xProductSource} from './fixtures/x-catalog-comparison.mjs';
import {product} from './x-catalog-fixture.mjs';
const ok = result => {
  assert.equal(result.success, true, JSON.stringify(result).slice(0, 1200));
  return result.data;
};

test('X source comparison returns exact supplied new/changed/matching/unknown products using bounded read-only ownership evidence', async t => {
  const f = xCatalogComparisonFixture();
  t.after(() => f.store.close());
  delete f.items[9001][2].image_link;
  f.items[9001][0].private_unknown_field = 'UNRELATED-PRIVATE-MARKER';
  const original = structuredClone(f.input),
    out = ok(await f.call(f.input, {...f.actor, role: 'reader'}));
  assert.deepEqual(
    out.items.map(i => i.state),
    ['new', 'changed', 'matching', 'unknown'],
  );
  assert.deepEqual(out.summary, {
    new: 1,
    changed: 1,
    matching: 1,
    unknown: 1,
    blocked: 0,
    needs_review: 3,
    with_destination_only_values: 3,
  });
  assert.deepEqual(out.review_retailer_ids, ['sku-4', 'sku-1', 'sku-3']);
  assert.deepEqual(
    out.items[1].changes.map(c => c.field),
    ['name'],
  );
  assert.deepEqual(out.items[3].unknown_fields, ['image_url']);
  assert.equal(out.items[2].price_matches, true);
  assert.equal(out.items[2].before.price, '20.00 SAR');
  assert.equal(out.items[1].product_id, '5000001');
  assert.equal(out.complete, true);
  assert.equal(out.network_requests, 8);
  assert.equal(out.provider_mutations, 0);
  assert.equal(out.destructive_deletions, 0);
  assert.ok(f.calls.every(c => c.method === 'GET'));
  assert.deepEqual(f.input, original);
  assert.doesNotMatch(JSON.stringify(out), /UNRELATED-PRIVATE-MARKER|synthetic-token|tokenSecret|accessToken/);
  assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
  assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 0);
});

test('X comparison keeps adjacent supported millionths distinct and equivalent decimal strings matching without Number conversion', async t => {
  const f = xCatalogComparisonFixture();
  t.after(() => f.store.close());
  f.items[9001][0].price = '999999999999.000001 SAR';
  f.items[9001][1].price = '000020.000000 SAR';
  f.items[9001][2].price = 'native unknown';
  f.input.products = [
    xProductSource(product(1), {price: '999999999999.000002'}),
    xProductSource(product(2)),
    xProductSource(product(3)),
  ];
  const out = ok(await f.call());
  assert.deepEqual(
    out.items.map(i => i.state),
    ['changed', 'matching', 'unknown'],
  );
  assert.deepEqual(out.items[0].changes, [
    {field: 'price', before: '999999999999.000001 SAR', after_native_price: '999999999999.000002 SAR'},
  ]);
  assert.equal(out.items[1].price_matches, true);
  assert.equal(out.items[2].price_matches, null);
  assert.deepEqual(out.items[2].unknown_fields, ['price', 'currency']);
  assert.equal(out.items[0].before.price, '999999999999.000001 SAR');
});

test('grouped X products and absent potentially hidden variants are blocked without inventing new-product evidence', async t => {
  const f = xCatalogComparisonFixture();
  t.after(() => f.store.close());
  f.items[9001][0].item_group_id = 'Original group';
  const out = ok(await f.call());
  assert.equal(out.items[0].state, 'unknown');
  assert.equal(out.items[0].before.present, null);
  assert.equal(out.items[0].blocked, true);
  assert.equal(out.items[0].blocked_reason, 'hidden_variant');
  assert.equal(out.items[1].blocked, true);
  assert.equal(out.items[1].blocked_reason, 'grouped_product');
  assert.equal(out.items[1].state, 'unknown');
  assert.deepEqual(out.review_retailer_ids, []);
  assert.equal(out.summary.blocked, 2);
  assert.equal(f.writes(), 0);
});

test('malformed, repeated, foreign, failed and inconsistent X collection evidence is withheld', async () => {
  const mutations = [
    ({request, result}) => {
      if (request.path.endsWith('/products')) result.data.data[0].id = 123;
    },
    ({request, result}) => {
      if (request.path.endsWith('/products')) result.data.data[0].product_key = 9007199254740992;
    },
    ({request, result}) => {
      if (request.path === '/12/product_catalogs') result.data.data[0].id = 9001;
    },
    ({request, result}) => {
      if (request.path.endsWith('/products')) result.data.data.push(structuredClone(result.data.data[0]));
    },
    ({request, result}) => {
      if (request.path.endsWith('/products')) result.data.data[1].product_key = result.data.data[0].product_key;
    },
    ({request, result}) => {
      if (request.path.endsWith('/products')) result.data.data[0].title = {private: 'bad'};
    },
    ({request, result}) => {
      if (request.path.endsWith('/products')) result.data.next_cursor = 'repeat';
    },
    ({request, result}) => {
      if (request.path.endsWith('/products')) result.status = 500;
    },
    ({request, result}) => {
      if (request.path.endsWith('/products')) result.data.errors = [{message: 'provider failure'}];
    },
  ];
  for (const read of mutations) {
    const f = xCatalogComparisonFixture({read});
    try {
      const result = await f.call();
      assert.equal(result.success, false, JSON.stringify(result).slice(0, 1000));
      assert.equal(f.writes(), 0);
      assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 0);
    } finally {
      f.store.close();
    }
  }
  const f = xCatalogComparisonFixture();
  try {
    assert.equal((await f.call({...f.input, catalog_id: '9009'})).success, false);
    assert.ok(!f.calls.some(c => c.path.includes('/9009/products')));
  } finally {
    f.store.close();
  }
});

test('changed selected X products or catalog ownership between repeated reads cannot produce a comparison', async () => {
  for (const change of ['price', 'identity', 'owner']) {
    let reads = 0;
    const f = xCatalogComparisonFixture({
      read: ({request, result}) => {
        if (request.path.endsWith('/products') && ++reads === 2) {
          if (change === 'price') result.data.data[0].price = '21.00 SAR';
          if (change === 'identity') result.data.data[0].product_key = '9007199254740993';
        }
        if (
          change === 'owner' &&
          reads === 2 &&
          request.path === '/12/product_catalogs' &&
          request.query.user_id === '111'
        )
          result.data.data = [];
      },
    });
    try {
      assert.equal((await f.call()).success, false, change);
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});

test('X comparison rechecks current account, login and client authority after pending provider reads', async () => {
  for (const reason of ['account', 'login', 'client']) {
    let actor, key;
    const f = xCatalogComparisonFixture({
      read: ({request, f}) => {
        if (!request.path.endsWith('/products')) return;
        const current = f.store.resolveConnection(f.actor, 'x_ads_native_action', 'acct1', 'x');
        if (reason === 'account')
          f.store.putConnection(
            {...f.actor, role: 'admin'},
            {...current, accounts: [], writeAccounts: []},
            {
              accessToken: 'synthetic-token',
              consumerKey: 'synthetic-key',
              consumerSecret: 'synthetic-secret',
              tokenSecret: 'synthetic-token-secret',
            },
          );
        if (reason === 'login')
          f.store.putConnection({...f.actor, role: 'admin'}, current, {
            accessToken: 'changed-synthetic',
            consumerKey: 'synthetic-key',
            consumerSecret: 'synthetic-secret',
            tokenSecret: 'synthetic-token-secret',
          });
        if (reason === 'client') f.store.revokeKey(key);
      },
    });
    try {
      key = f.store.createKey(f.actor);
      actor = f.store.authenticate(key);
      const result = await f.call(f.input, actor);
      assert.equal(result.success, false, reason);
      assert.equal(f.writes(), 0);
      assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
    } finally {
      f.store.close();
    }
  }
});

test('X comparison shares complete bounded catalog scans across fifty source rows and refuses a 1001-row catalog', async () => {
  const f = xCatalogComparisonFixture({products: 1000});
  try {
    f.input.products = Array.from({length: 50}, (_, i) => xProductSource(product(i + 951)));
    const out = ok(await f.call());
    assert.equal(out.item_count, 50);
    assert.equal(out.summary.matching, 50);
    assert.equal(out.network_requests, 26);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
  const large = xCatalogComparisonFixture({products: 1001});
  try {
    const r = await large.call();
    assert.equal(r.success, false);
    assert.equal(r.error.code, 'CATALOG_SCAN_LIMIT');
    assert.equal(large.calls.filter(c => c.path.endsWith('/products')).length, 10);
    assert.equal(large.writes(), 0);
  } finally {
    large.store.close();
  }
});

test('invalid X comparison imports and inaccessible accounts are refused before provider egress', async t => {
  const f = xCatalogComparisonFixture();
  t.after(() => f.store.close());
  for (const patch of [
    {catalog_id: 9001},
    {catalog_id: '0'},
    {allow_upsert: false},
    {products: []},
    {products: [xProductSource(product(1)), xProductSource(product(1))]},
    {account_id: 'foreign'},
    {connection_id: 'foreign'},
  ]) {
    assert.equal((await f.call({...f.input, ...patch})).success, false, JSON.stringify(patch));
    assert.equal(f.calls.length, 0);
  }
});

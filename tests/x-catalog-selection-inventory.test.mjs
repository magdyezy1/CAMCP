import test from 'node:test';
import assert from 'node:assert/strict';
import {xCatalogComparisonFixture, xProductSource} from './fixtures/x-catalog-comparison.mjs';
import {product} from './x-catalog-fixture.mjs';

const inspected = f => ({...f.input, products: [xProductSource(product(1))], inspect_other_listed_products: true});
const ok = result => {
  assert.equal(result.success, true, JSON.stringify(result).slice(0, 1200));
  return result.data;
};
function untouched(f) {
  assert.equal(f.writes(), 0);
  assert.ok(f.calls.every(c => c.method === 'GET'));
  for (const kind of ['campaign_run', 'write_review', 'x_catalog_removal_preview'])
    assert.equal(f.store.documents(f.actor.tenantId, kind).length, 0);
}

test('explicit reader inspection exposes other listed X products with retained selection boundaries and no draft or deletion', async t => {
  const f = xCatalogComparisonFixture();
  t.after(() => f.store.close());
  const request = inspected(f),
    original = structuredClone(request);
  const out = ok(await f.call(request, {...f.actor, role: 'reader'})),
    inventory = out.listed_inventory;
  assert.equal(out.item_count, 1);
  assert.equal(
    out.meaning,
    'Products outside this supplied selection are retained. Their store absence is unverified. X listing can hide other variants, so this is not a complete variant inventory or a point-in-time snapshot.',
  );
  assert.equal(out.items[0].retailer_id, 'sku-1');
  assert.deepEqual(out.review_retailer_ids, []);
  assert.deepEqual(inventory.scope, out.scope);
  assert.equal(inventory.source_hash, out.source_hash);
  assert.equal(inventory.requested_at, out.requested_at);
  assert.equal(inventory.captured_at, out.captured_at);
  assert.match(inventory.material_hash, /^[a-f0-9]{64}$/);
  assert.match(inventory.observations_hash, /^[a-f0-9]{64}$/);
  assert.equal(inventory.record_kind, 'x_catalog_selection_inventory');
  assert.equal(inventory.coverage, 'bounded_listed_products');
  assert.equal(inventory.listed_scan_complete, true);
  assert.equal(inventory.source_coverage, 'supplied_products_only');
  assert.equal(inventory.variant_inventory_complete, false);
  assert.equal(inventory.source_absence_established, false);
  assert.equal(inventory.absent_source_policy, 'retain');
  assert.equal(inventory.source_selection_count, 1);
  assert.equal(inventory.supplied_listed_count, 1);
  assert.equal(inventory.listed_product_count, 3);
  assert.equal(inventory.outside_selection_count, 2);
  assert.deepEqual(
    inventory.items.map(p => [p.retailer_id, p.product_id]),
    [
      ['sku-2', '5000002'],
      ['sku-3', '5000003'],
    ],
  );
  assert.deepEqual(inventory.outside_selection_group_counts, {individual: 2, grouped: 0, unknown: 0});
  assert.equal(out.network_requests, 8);
  assert.equal(inventory.provider_mutations, 0);
  assert.equal(inventory.destructive_deletions, 0);
  assert.deepEqual(request, original);
  untouched(f);
});

test('ordinary supplied-product comparison retains its original output and does not inspect unrelated field changes', async t => {
  let reads = 0;
  const f = xCatalogComparisonFixture({
    read: ({request, result}) => {
      if (request.path.endsWith('/products') && ++reads === 2) result.data.data[2].title = 'Other changed title';
    },
  });
  t.after(() => f.store.close());
  const out = ok(await f.call({...f.input, products: [xProductSource(product(1))]}));
  assert.equal(Object.hasOwn(out, 'listed_inventory'), false);
  assert.equal(
    out.meaning,
    'Current evidence for supplied X product IDs only, using repeated bounded native reads and exact supported decimal prices. Grouped or potentially hidden variants are blocked. Missing fields stay unknown. This is sequential evidence, not a point-in-time inventory snapshot. Every saved product still requires a fresh native review and independent read-back; products outside the supplied source are not returned or deleted.',
  );
  assert.equal(out.item_count, 1);
  assert.equal(out.network_requests, 8);
  untouched(f);
});

test('new inspection refuses changed other product identity, exact price, title or grouping across the two bounded scans', async () => {
  for (const mutate of [
    p => (p.product_key = '900719925474099312345'),
    p => (p.price = '20.000001 SAR'),
    p => (p.title = 'Other changed title'),
    p => (p.item_group_id = 'Other group'),
    p => (p.item_group_key = '900719925474099312346'),
    p => {
      delete p.item_group_id;
      delete p.item_group_key;
    },
    p => (p.id = 'Changed-other-SKU'),
  ]) {
    let reads = 0;
    const f = xCatalogComparisonFixture({
      read: ({request, result}) => {
        if (request.path.endsWith('/products') && ++reads === 2) mutate(result.data.data[2]);
      },
    });
    try {
      const result = await f.call(inspected(f));
      assert.equal(result.success, false);
      assert.equal(result.error.code, 'CATALOG_COMPARISON_CHANGED');
      assert.match(result.error.message, /listed catalog observations changed/);
      assert.equal(result.data, undefined);
      untouched(f);
    } finally {
      f.store.close();
    }
  }
});

test('reordered pages preserve first-read observations while arbitrary unselected native fields and credential URLs are never returned', async t => {
  let reads = 0;
  const f = xCatalogComparisonFixture({
    read: ({request, result}) => {
      if (request.path.endsWith('/products') && ++reads === 2) {
        result.data.data.reverse();
        result.data.data[0].private_unknown = 'SECOND-PRIVATE-NATIVE-MARKER';
      }
    },
  });
  t.after(() => f.store.close());
  f.items[9001][2].private_unknown = 'FIRST-PRIVATE-NATIVE-MARKER';
  f.items[9001][2].link = 'https://secret:credential@example.test/private';
  f.items[9001][2].image_link = 'https://example.test/private?token=PRIVATE-IMAGE-MARKER';
  const out = ok(await f.call(inspected(f)));
  assert.deepEqual(
    out.listed_inventory.items.map(p => p.retailer_id),
    ['sku-2', 'sku-3'],
  );
  assert.doesNotMatch(
    JSON.stringify(out),
    /PRIVATE-NATIVE|PRIVATE-IMAGE|secret:credential|synthetic-token|consumerSecret/,
  );
  assert.equal(out.network_requests, 8);
  untouched(f);
});

test('other listed native prices, large string identifiers and literal title/group values remain lossless while missing group evidence stays unknown', async t => {
  const f = xCatalogComparisonFixture({products: 4});
  t.after(() => f.store.close());
  Object.assign(f.items[9001][1], {
    price: '999999999999.000001 SAR',
    product_key: '900719925474099312345',
    title: 'Title <literal>',
    item_group_id: 'Group <literal>',
    item_group_key: '900719925474099312346',
  });
  delete f.items[9001][2].item_group_id;
  f.items[9001][2].price = 'unrecognized native price';
  f.items[9001][3].price = '000020.000000 SAR';
  const inventory = ok(await f.call(inspected(f))).listed_inventory;
  assert.equal(inventory.items[0].product_id, '900719925474099312345');
  assert.equal(inventory.items[0].price, '999999999999.000001 SAR');
  assert.equal(inventory.items[0].name, 'Title <literal>');
  assert.equal(inventory.items[0].item_group_id, 'Group <literal>');
  assert.equal(inventory.items[0].item_group_key, '900719925474099312346');
  assert.equal(inventory.items[0].group_status, 'grouped');
  assert.equal(inventory.items[1].group_status, 'unknown');
  assert.equal(inventory.items[1].price, null);
  assert.equal(inventory.items[1].currency, null);
  assert.equal(inventory.items[2].price, '000020.000000 SAR');
  assert.deepEqual(inventory.outside_selection_group_counts, {individual: 1, grouped: 1, unknown: 1});
  assert.equal(inventory.variant_inventory_complete, false);
  assert.equal(inventory.source_absence_established, false);
  untouched(f);
});

test('malformed optional observations remain unknown and do not echo unrecognized native objects', async t => {
  const f = xCatalogComparisonFixture();
  t.after(() => f.store.close());
  Object.assign(f.items[9001][1], {
    title: {private: 'PRIVATE-TITLE'},
    price: {private: 'PRIVATE-PRICE'},
    item_group_id: {private: 'PRIVATE-GROUP'},
  });
  f.items[9001][2].price = '000999999999999.000001 SAR';
  const inventory = ok(await f.call(inspected(f))).listed_inventory;
  assert.equal(inventory.items[0].name, null);
  assert.equal(inventory.items[0].price, null);
  assert.equal(inventory.items[0].item_group_id, null);
  assert.equal(inventory.items[0].group_status, 'unknown');
  assert.equal(inventory.items[1].price, null);
  assert.equal(inventory.items[1].currency, null);
  assert.doesNotMatch(JSON.stringify(inventory), /PRIVATE-TITLE|PRIVATE-PRICE|PRIVATE-GROUP/);
  untouched(f);
});

test('the original 1000-row bound is shared across 50 selected products and 950 other listed observations', async t => {
  const f = xCatalogComparisonFixture({products: 1000});
  t.after(() => f.store.close());
  const request = {
    ...f.input,
    products: Array.from({length: 50}, (_, i) => xProductSource(product(i + 951))),
    inspect_other_listed_products: true,
  };
  const out = ok(await f.call(request));
  assert.equal(out.item_count, 50);
  assert.equal(out.listed_inventory.listed_product_count, 1000);
  assert.equal(out.listed_inventory.supplied_listed_count, 50);
  assert.equal(out.listed_inventory.outside_selection_count, 950);
  assert.equal(out.listed_inventory.items.length, 950);
  assert.equal(out.network_requests, 26);
  assert.ok(Buffer.byteLength(JSON.stringify(out)) < 1024 * 1024);
  untouched(f);
});

test('an incomplete 1001-row scan is refused rather than returning inventory counts or absence claims', async t => {
  const f = xCatalogComparisonFixture({products: 1001});
  t.after(() => f.store.close());
  const out = await f.call(inspected(f));
  assert.equal(out.success, false);
  assert.equal(out.error.code, 'CATALOG_SCAN_LIMIT');
  assert.equal(out.data, undefined);
  assert.equal(f.calls.filter(c => c.path.endsWith('/products')).length, 10);
  untouched(f);
});

test('a qualified empty listed catalog does not establish whole-store or variant absence', async t => {
  const f = xCatalogComparisonFixture();
  t.after(() => f.store.close());
  const out = ok(await f.call({...inspected(f), catalog_id: '9002'}));
  assert.equal(out.listed_inventory.listed_product_count, 0);
  assert.equal(out.listed_inventory.supplied_listed_count, 0);
  assert.deepEqual(out.listed_inventory.items, []);
  assert.equal(out.listed_inventory.source_absence_established, false);
  assert.equal(out.listed_inventory.variant_inventory_complete, false);
  assert.equal(out.listed_inventory.absent_source_policy, 'retain');
  untouched(f);
});

test('destructive missing-source intent, malformed inspection flags and other providers fail before any provider read', async t => {
  const f = xCatalogComparisonFixture();
  t.after(() => f.store.close());
  for (const patch of [
    {inspect_other_listed_products: 'true'},
    {inspect_other_listed_products: 1},
    {inspect_other_listed_products: null},
    {absent_source_policy: 'delete'},
    {absent_source_policy: {action: 'delete'}},
    {absent_source_policy: null},
    {gateway: 'meta_native_action', inspect_other_listed_products: true},
  ]) {
    const out = await f.call({...inspected(f), ...patch});
    assert.equal(out.success, false, JSON.stringify(patch));
    assert.equal(f.calls.length, 0);
  }
  untouched(f);
});

test('an explicit retain policy permits a bounded observation but grants no write authority', async t => {
  const f = xCatalogComparisonFixture();
  t.after(() => f.store.close());
  const out = ok(await f.call({...inspected(f), absent_source_policy: 'retain'}, {...f.actor, role: 'reader'}));
  assert.equal(out.listed_inventory.absent_source_policy, 'retain');
  untouched(f);
});

test('inspection fields cannot silently cross into other workspace actions or create a draft', async t => {
  const f = xCatalogComparisonFixture({writable: true});
  t.after(() => f.store.close());
  for (const action of ['catalog_preview', 'catalog_plan', 'preview_catalog_removal', 'operations']) {
    const out = await f.call({...inspected(f), action, absent_source_policy: 'retain'});
    assert.equal(out.success, false, action);
    assert.match(out.error.message, /arguments apply only to catalog_compare/);
  }
  assert.equal(f.calls.length, 0);
  untouched(f);
});

test('pending inventory inspection retains original current-account and credential revocation fences', async () => {
  for (const reason of ['account', 'login', 'client']) {
    let key;
    const f = xCatalogComparisonFixture({
      read: ({request, f}) => {
        if (!request.path.endsWith('/products')) return;
        if (reason === 'client') {
          f.store.revokeKey(key);
          return;
        }
        const c = f.store.resolveConnection(f.actor, 'x_ads_native_action', 'acct1', 'x');
        f.store.putConnection(
          {...f.actor, role: 'admin'},
          reason === 'account' ? {...c, accounts: [], writeAccounts: []} : c,
          {
            accessToken: reason === 'login' ? 'changed-synthetic' : 'synthetic-token',
            consumerKey: 'synthetic-key',
            consumerSecret: 'synthetic-secret',
            tokenSecret: 'synthetic-token-secret',
          },
        );
      },
    });
    try {
      key = f.store.createKey(f.actor);
      const out = await f.call(inspected(f), f.store.authenticate(key));
      assert.equal(out.success, false, reason);
      assert.equal(out.data, undefined);
      untouched(f);
    } finally {
      f.store.close();
    }
  }
});

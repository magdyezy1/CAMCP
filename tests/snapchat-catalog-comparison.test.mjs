import test from 'node:test';
import assert from 'node:assert/strict';
import {snapWorld, snapProduct, snapSource, snapAccount, snapCatalog} from './fixtures/snapchat-catalog-world.mjs';
import {authorizeSnapCatalogComparisonRead} from '../dist/src/snapchat-catalog-reads.js';
import {snapPrice} from '../dist/src/snapchat-catalog-comparison.js';
import {catalogDestinations} from '../dist/src/catalog-destinations.js';

/**
 * COM-02 D: Snapchat catalogs had configuration-only families, so Snapchat dynamic-ads users could not see drift between
 * their source and the catalog inside AMCP. A read-only comparison now reads the supplied product IDs (one IS_ANY search,
 * twice, bracketed by the catalog's organization), keeps prices as exact decimal strings, refuses repeated or partial
 * pages, and names the feed as the fix: Snapchat has no per-product write, so nothing is saved.
 */
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 1500));
  return r.data;
};
const refused = (r, code) => {
  assert.equal(r.success, false, JSON.stringify(r).slice(0, 800));
  assert.equal(r.error.code, code, JSON.stringify(r.error));
  return r.error;
};
const input = (f, products) => ({...f.scope, products});

test('D: a Snapchat comparison reads the supplied IDs twice under the catalog organization, keeps exact decimal prices and saves nothing', async t => {
  const f = snapWorld([
    snapProduct(1, {price: {value: '20.000', currency: 'SAR'}}),
    snapProduct(2, {title: 'Old name', price: {value: 24.5, currency: 'SAR'}}),
    snapProduct(4, {price: {value: '20', currency: 'SAR'}, sale_price: {value: '18', currency: 'SAR'}}),
    snapProduct(5, {availability: 'SOMETHING_NEW'}),
  ]);
  t.after(() => f.store.close());
  const products = [
    snapSource(1),
    snapSource(2, {price: '25'}),
    snapSource(3),
    snapSource(4),
    snapSource(5),
    snapSource(6, {sale_price: '15'}),
  ];
  const preview = ok(await f.call({action: 'catalog_preview', ...input(f, products)}));
  assert.equal(preview.plan, null, 'no reviewed step exists for a feed-only destination');
  assert.equal(preview.writes, 'feed_only');
  assert.equal(preview.items[1].native_price, '25 SAR', 'the exact decimal the source wrote');
  const out = ok(await f.call({action: 'catalog_compare', ...input(f, products)}));
  assert.equal(out.record_kind, 'catalog_comparison');
  assert.equal(out.item_schema_version, 'catalog-comparison-item-v2');
  assert.equal(out.writes, 'feed_only');
  assert.equal(out.remedy, 'fix_in_feed');
  assert.deepEqual(out.catalog, {id: snapCatalog, organization_id: 'org-1', name: 'Synthetic shop'});
  assert.equal(out.source_hash, preview.source_hash);
  const [one, two, three, four, five] = out.items;
  // 20.000 SAR is the same exact value as the source's 20: matching, with no rounding anywhere.
  assert.equal(one.state, 'matching');
  assert.equal(one.price_matches, true);
  assert.equal(one.before.price, '20.000 SAR');
  assert.equal(one.fix_in, null);
  // A JSON number keeps its exact decimal form; a different price and name are changes.
  assert.equal(two.state, 'changed');
  assert.equal(two.before.price, '24.5 SAR');
  assert.deepEqual(two.changes, [
    {field: 'name', before: 'Old name', after: 'Product 2'},
    {field: 'price', before: '24.5 SAR', after_native_price: '25 SAR'},
  ]);
  assert.equal(two.fix_in, 'feed');
  assert.deepEqual([three.state, three.before.present, three.product_id, three.fix_in], ['new', false, null, 'feed']);
  // A sale the catalog holds and the source does not send is named, never cleared or inferred.
  assert.deepEqual(four.unsent_fields, ['sale_price']);
  assert.equal(four.state, 'matching');
  // An availability value AMCP cannot read stays unknown.
  assert.equal(five.state, 'unknown');
  assert.deepEqual(five.unknown_fields, ['availability']);
  assert.equal(out.items[5].state, 'new');
  assert.deepEqual(out.summary, {
    new: 2,
    changed: 1,
    matching: 2,
    unknown: 1,
    blocked: 0,
    needs_review: 4,
    with_destination_only_values: 1,
  });
  assert.deepEqual(out.review_retailer_ids, ['SKU-2', 'SKU-3', 'SKU-5', 'SKU-6']);
  assert.equal(out.provider_mutations, 0);
  // One IS_ANY search per scan, two scans, every supplied ID; the account and catalog bracket them.
  const searches = f.searches();
  assert.equal(searches.length, 2);
  for (const s of searches) {
    assert.deepEqual(s.body, {filter: {ID: {IS_ANY: products.map(p => p.retailer_id)}}});
    assert.equal(s.query.limit, '1000');
  }
  assert.deepEqual(
    f.calls.map(c => c.method + ' ' + c.path),
    [
      'GET /v1/adaccounts/' + snapAccount,
      'GET /v1/catalogs/' + snapCatalog,
      'POST /v1/catalogs/' + snapCatalog + '/products/search',
      'POST /v1/catalogs/' + snapCatalog + '/products/search',
      'GET /v1/adaccounts/' + snapAccount,
      'GET /v1/catalogs/' + snapCatalog,
    ],
  );
  assert.equal(out.network_requests, 6);
  assert.equal(f.writes(), 0);
  // Nothing can be saved for Snapchat: its products change only through feeds.
  refused(await f.call({action: 'catalog_plan', ...input(f, products)}), 'CATALOG_FEED_ONLY');
  assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
  // The destination contract says the same.
  assert.equal(catalogDestinations.snapchat_native_action.writes, 'feed_only');
  assert.equal(catalogDestinations.snapchat_native_action.removal, 'none');
});

test('D: repeated, empty-but-continued, foreign, duplicated or endless pages and evidence that changes between scans are refused; nothing partial is returned', async t => {
  const four = [1, 2, 3, 4].map(i => snapProduct(i)),
    sources = [1, 2, 3, 4].map(i => snapSource(i));
  for (const [mode, code, page] of [
    ['repeat', 'INCOMPLETE_STATE', 2],
    ['empty', 'INCOMPLETE_STATE', 0],
    ['foreign', 'INCOMPLETE_STATE', 0],
    ['duplicate', 'INCOMPLETE_STATE', 0],
    ['endless', 'CATALOG_SCAN_LIMIT', 1],
    ['drift', 'CATALOG_COMPARISON_CHANGED', 0],
  ]) {
    const f = snapWorld(four, {mode, page});
    t.after(() => f.store.close());
    const error = refused(await f.call({action: 'catalog_compare', ...input(f, sources)}), code);
    assert.equal(error.details?.items, undefined, mode + ': no partial comparison');
    assert.equal(f.writes(), 0);
  }
  // Pages that are complete and distinct are followed, within the bound.
  const paged = snapWorld(four, {page: 2});
  t.after(() => paged.store.close());
  const out = ok(await paged.call({action: 'catalog_compare', ...input(paged, sources)}));
  assert.equal(out.summary.matching, 4);
  assert.equal(paged.searches().length, 4, 'two pages per scan, two scans');
  assert.deepEqual(
    paged.searches().map(s => s.query.cursor ?? null),
    [null, '1', null, '1'],
  );
});

test("D: a catalog of another organization is refused before any product is read; a retirement or another destination's input is refused", async t => {
  const f = snapWorld([snapProduct(1)], {mode: 'foreign_catalog'});
  t.after(() => f.store.close());
  const error = refused(
    await f.call({action: 'catalog_compare', ...input(f, [snapSource(1)])}),
    'STATE_TARGET_MISMATCH',
  );
  assert.equal(error.details.product_catalog_id, snapCatalog);
  assert.equal(f.searches().length, 0);
  const g = snapWorld([snapProduct(1)]);
  t.after(() => g.store.close());
  refused(
    await g.call({
      action: 'catalog_compare',
      ...input(g, [snapSource(1)]),
      allow_upsert: true,
      requirements: {retire_retailer_ids: ['SKU-1'], retire_availability: 'discontinued'},
    }),
    'INVALID_SNAPCHAT_CATALOG_COMPARISON',
  );
  // Sale dates are not qualified for Snapchat; listed inspection is X only.
  refused(
    await g.call({
      action: 'catalog_compare',
      ...input(g, [snapSource(1, {sale_price: '15', sale_price_start_date: '2026-11-01T00:00:00+03:00'})]),
    }),
    'INVALID_ARGUMENT',
  );
  refused(
    await g.call({
      action: 'catalog_compare',
      ...input(g, [snapSource(1)]),
      inspect_other_listed_products: true,
      absent_source_policy: 'retain',
    }),
    'INVALID_ARGUMENT',
  );
  refused(
    await g.call({action: 'catalog_compare', ...input(g, [snapSource(1)]), catalog_id: 'cat/../x'}),
    'INVALID_SNAPCHAT_CATALOG_COMPARISON',
  );
  assert.equal(g.calls.length, 0);
});

test('D: the scope guard admits only the comparison reads it tags, and Snapchat prices stay exact decimal strings', () => {
  const connection = {gateway: 'snapchat_native_action', accounts: [snapAccount]};
  const base = {
    gateway: 'snapchat_native_action',
    accountId: snapAccount,
    action: 'AMCP_SNAPCHAT_CATALOG_COMPARISON_READ',
    method: 'GET',
    path: '/v1/adaccounts/' + snapAccount,
    query: {},
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    evidence: 'test',
    warnings: [],
  };
  const search = {
    ...base,
    method: 'POST',
    path: '/v1/catalogs/' + snapCatalog + '/products/search',
    query: {limit: 1000},
    body: {filter: {ID: {IS_ANY: ['SKU-1']}}},
    snapCompareOrg: 'org-1',
    snapCompareCatalog: snapCatalog,
  };
  assert.equal(authorizeSnapCatalogComparisonRead(base, connection, snapAccount), true);
  assert.equal(authorizeSnapCatalogComparisonRead(search, connection, snapAccount), true);
  assert.equal(authorizeSnapCatalogComparisonRead({...base, action: 'other'}, connection, snapAccount), false);
  for (const forged of [
    {...search, snapCompareOrg: undefined},
    {...search, snapCompareCatalog: 'cat-other'},
    {...search, body: {filter: {BRAND: {EQ: 'x'}}}},
    {...search, body: {filter: {ID: {IS_ANY: []}}}},
    {...search, body: {filter: {ID: {IS_ANY: ['a', 'a']}}}},
    {...search, body: undefined},
    {...search, query: {limit: 50}},
    {...search, query: {limit: 1000, fields: 'all'}},
    {...search, readOnly: false},
    {...search, method: 'DELETE'},
    {...base, path: '/v1/adaccounts/' + snapAccount + '/campaigns'},
    {...base, snapCompareOrg: 'org-1'},
    {...base, accountId: 'other'},
  ])
    assert.throws(
      () => authorizeSnapCatalogComparisonRead(forged, connection, snapAccount),
      e => e.code === 'RESOURCE_SCOPE_REQUIRED',
    );
  assert.equal(snapPrice({value: '19.990', currency: 'SAR'}), '19.990 SAR');
  assert.equal(snapPrice({value: 19.99, currency: 'SAR'}), '19.99 SAR');
  for (const unreadable of [
    {value: 1e21, currency: 'SAR'},
    {value: '19.9999999', currency: 'SAR'},
    {value: '-1', currency: 'SAR'},
    {value: '1', currency: 'sar'},
    {value: 0.1 + 0.2, currency: 'SAR'},
    '19.99 SAR',
    null,
  ])
    assert.equal(snapPrice(unreadable), undefined, JSON.stringify(unreadable));
});

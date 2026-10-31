import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogDestination, catalogDestinations, fallbackCatalogDestination} from '../dist/src/catalog-destinations.js';
import {catalogRetirementOf} from '../dist/src/catalog-retirement.js';
import {catalogDestinationOrder, providerAdapters, providerOf} from '../dist/src/provider-adapters.js';
import {catalogIngestion, catalogRetirement, retired} from '../dist/src/catalog-ingestion.js';
import * as supplied from '../dist/src/supplied-catalog-ingestion.js';
import {metaCatalogIngestion} from '../dist/src/meta-catalog-ingestion.js';
import {xCatalogIngestion} from '../dist/src/x-catalog-ingestion.js';
import {snapchatCatalogIngestion} from '../dist/src/snapchat-catalog-ingestion.js';
import {providerHooks, registeredProviderHooks} from '../dist/src/provider-hooks.js';
import * as removal from '../dist/src/x-catalog-removal.js';
import * as removalBinding from '../dist/src/x-catalog-removal-binding.js';
import {MirrorError} from '../dist/src/errors.js';
import fs from 'node:fs';
import {catalogComparison} from '../dist/src/catalog-comparison.js';
import {assetUsageReader, catalogComparisonSteps} from '../dist/src/provider-workflows.js';
import {normalizeAccount} from '../dist/src/account-id.js';
import {metaCatalogComparison} from '../dist/src/meta-catalog-comparison.js';
import {xCatalogComparison, xCatalogListedSelection} from '../dist/src/x-catalog-comparison.js';
import {snapchatCatalogComparison} from '../dist/src/snapchat-catalog-comparison.js';
import {catalogInventoryRequested, listedSelectionRequested} from '../dist/src/x-catalog-selection-inventory.js';

/**
 * ARC-01 (wave 4c round 6): the catalog destinations (COM-03) are facts of their providers' adapters, and the shared
 * catalog modules consult them instead of naming gateways. These pins hold the destinations to the table they were
 * in src/catalog-destinations.ts, in the same order and shape, and the retirement of a plan step to the branches it
 * replaced, so a fact that moves or changes is seen here.
 */
const shared = ['retailer_id', 'name', 'price', 'currency', 'image_url'],
  described = ['url', 'availability', 'condition', 'brand', 'description'],
  sale = ['sale_price', 'sale_price_start_date', 'sale_price_end_date'];
const expected = {
  meta_native_action: {
    gateway: 'meta_native_action',
    provider: 'meta',
    sourceFields: {required: shared, optional: [...described, 'retailer_product_group_id', ...sale]},
    catalogId: '^[1-9][0-9]{0,31}$',
    identity: {source: 'retailer_id', native: 'product_id', pattern: '^[1-9][0-9]{0,31}$'},
    writes: 'reviewed_steps',
    upsert: 'explicit_choice',
    removal: 'retire',
    destinationOnlyValues: 'review',
    itemSchemaVersion: 'catalog-comparison-item-v2',
  },
  x_ads_native_action: {
    gateway: 'x_ads_native_action',
    provider: 'x',
    sourceFields: {required: [...shared, ...described], optional: sale},
    catalogId: '^[1-9][0-9]{0,24}$',
    identity: {source: 'retailer_id', native: 'product_key', pattern: '^[1-9][0-9]{0,24}$'},
    writes: 'reviewed_steps',
    upsert: 'required',
    removal: 'retire_and_selected_deletion',
    destinationOnlyValues: 'note',
    itemSchemaVersion: 'catalog-comparison-item-v2',
  },
  snapchat_native_action: {
    gateway: 'snapchat_native_action',
    provider: 'snapchat',
    sourceFields: {required: shared, optional: [...described, 'sale_price']},
    catalogId: '^[A-Za-z0-9-]{1,64}$',
    identity: {source: 'retailer_id', native: 'retailer_id', pattern: '^[^\\u0000-\\u001f\\u007f]{1,100}$'},
    writes: 'feed_only',
    upsert: 'none',
    removal: 'none',
    destinationOnlyValues: 'note',
    itemSchemaVersion: 'catalog-comparison-item-v2',
  },
};
const plain = d => ({
  ...d,
  sourceFields: {required: [...d.sourceFields.required], optional: [...d.sourceFields.optional]},
  catalogId: d.catalogId.source,
  identity: {...d.identity, pattern: d.identity.pattern.source},
});

test('the catalog destinations are their adapters facts, in the order and shape of the table they replaced', () => {
  assert.deepEqual(Object.keys(catalogDestinations), Object.keys(expected));
  assert.deepEqual(
    catalogDestinationOrder.map(id => providerAdapters.find(a => a.id === id).gateway),
    Object.keys(expected),
  );
  for (const [gateway, destination] of Object.entries(catalogDestinations)) {
    assert.deepEqual(Object.keys(destination), Object.keys(expected[gateway]), gateway + ' field order');
    assert.deepEqual(plain(destination), expected[gateway], gateway);
    assert.equal(catalogDestination(gateway), destination);
    // The adapter's own facts are frozen; the listed destination carries no registry-only fact.
    const facts = providerOf(gateway).catalogDestination;
    assert.ok(Object.isFrozen(facts), gateway + ' facts are frozen');
    assert.equal(destination.catalogId, facts.catalogId);
    assert.ok(!('fallback' in destination) && !('stepRetailerId' in destination), gateway);
  }
  // Exactly the three adapters carry a destination; every other gateway is no destination.
  assert.deepEqual(
    providerAdapters.filter(a => a.catalogDestination).map(a => a.id),
    ['meta', 'snapchat', 'x'],
  );
  for (const gateway of [
    'google_ads_native_action',
    'linkedin_native_action',
    'amcp_workspace',
    'toString',
    undefined,
    7,
  ])
    assert.equal(catalogDestination(gateway), undefined, String(gateway));
});

test('a gateway that is no catalog destination is compared as the fallback destination, Meta', () => {
  assert.equal(fallbackCatalogDestination, catalogDestinations.meta_native_action);
  assert.deepEqual(
    providerAdapters.filter(a => a.catalogDestination?.fallback).map(a => a.id),
    ['meta'],
  );
});

test('a plan step retires its destination product only when the plan retires that retailer ID', () => {
  const run = {catalog_retirement: {retailer_ids: ['SKU-1', 'SKU-2']}},
    step = (gateway, payload, kind = 'write') => ({kind, gateway, arguments: {payload}});
  // Meta's product create names the retailer ID; X's product put names one product.
  assert.equal(catalogRetirementOf(run, step('meta_native_action', {retailer_id: 'SKU-1'})), 'SKU-1');
  assert.equal(catalogRetirementOf(run, step('x_ads_native_action', {products: [{id: 'SKU-2'}]})), 'SKU-2');
  // Refusals: a retailer ID the plan does not retire, a feed-only destination, other gateways, other shapes.
  assert.equal(catalogRetirementOf(run, step('meta_native_action', {retailer_id: 'SKU-3'})), undefined);
  assert.equal(catalogRetirementOf(run, step('x_ads_native_action', {products: {id: 'SKU-2'}})), undefined);
  assert.equal(catalogRetirementOf(run, step('x_ads_native_action', {retailer_id: 'SKU-1'})), undefined);
  assert.equal(catalogRetirementOf(run, step('meta_native_action', {products: [{id: 'SKU-1'}]})), undefined);
  assert.equal(catalogRetirementOf(run, step('snapchat_native_action', {retailer_id: 'SKU-1'})), undefined);
  assert.equal(catalogRetirementOf(run, step('google_ads_native_action', {retailer_id: 'SKU-1'})), undefined);
  assert.equal(catalogRetirementOf(run, step('meta_native_action', {retailer_id: 'SKU-1'}, 'read')), undefined);
  assert.equal(catalogRetirementOf(run, step('meta_native_action', undefined)), undefined);
  assert.equal(catalogRetirementOf({}, step('meta_native_action', {retailer_id: 'SKU-1'})), undefined);
  assert.equal(catalogRetirementOf(run, {kind: 'write', gateway: {}, arguments: {payload: {}}}), undefined);
  assert.equal(catalogRetirementOf(run, step('meta_native_action', {retailer_id: 7})), undefined);
});

test('each catalog destination projects supplied products through its own provider hooks', () => {
  const projections = {
    meta_native_action: metaCatalogIngestion,
    x_ads_native_action: xCatalogIngestion,
    snapchat_native_action: snapchatCatalogIngestion,
  };
  for (const gateway of Object.keys(catalogDestinations))
    assert.equal(providerHooks(gateway).catalogProjection, projections[gateway], gateway);
  // Only the destinations project; the hooks list them in its own order.
  assert.deepEqual(
    registeredProviderHooks.filter(h => h.catalogProjection).map(h => h.gateway),
    ['meta_native_action', 'snapchat_native_action', 'x_ads_native_action'],
  );
  // The moved exports keep their old import paths.
  assert.equal(catalogRetirement, supplied.catalogRetirement);
  assert.equal(retired, supplied.retired);
  for (const name of ['assertCatalogRemovalStep', 'catalogRemovalChanged', 'catalogRemovalCreationBinding'])
    assert.equal(removal[name], removalBinding[name], name);
});

test('the shared ingestion keeps its refusal for a gateway that is no destination, and X alone needs a whole sale period', () => {
  const refusal = input => {
    try {
      catalogIngestion(input);
    } catch (error) {
      assert.ok(error instanceof MirrorError);
      return {code: error.code, message: error.message, details: error.details};
    }
    assert.fail('accepted ' + JSON.stringify(input));
  };
  for (const gateway of ['google_ads_native_action', 'toString', undefined])
    assert.deepEqual(refusal({gateway, products: []}), {
      code: 'INVALID_ARGUMENT',
      message: 'Choose a numeric Meta product catalog ID and selected Meta ad account.',
      details: {},
    });
  const start = '2026-11-01T00:00:00+03:00',
    product = {
      retailer_id: 'sku-1',
      name: 'Product 1',
      price: '20',
      currency: 'SAR',
      image_url: 'https://shop.example.test/i/1.jpg',
      url: 'https://shop.example.test/p/1',
      availability: 'in stock',
      condition: 'new',
      brand: 'Brand',
      description: 'Synthetic product 1',
      sale_price: '9',
      sale_price_start_date: start,
    };
  const x = {gateway: 'x_ads_native_action', account_id: 'acct1', connection_id: 'x', catalog_id: '9001'};
  assert.deepEqual(refusal({...x, allow_upsert: true, products: [product]}), {
    code: 'INVALID_CATALOG_SALE',
    message: 'X needs both the sale start and the sale end, or neither.',
    details: {product: 1},
  });
  // Meta keeps a sale that only starts: the period check is X's own.
  const meta = catalogIngestion({
    gateway: 'meta_native_action',
    account_id: '123',
    connection_id: 'm',
    catalog_id: '555',
    allow_upsert: true,
    products: [product],
  });
  assert.equal(meta.plan.steps[0].arguments.payload.sale_price_start_date, start);
  // A sale shared rule still refuses first, for every destination: a period without a price.
  const {sale_price, ...unpriced} = product;
  for (const input of [
    {...x, allow_upsert: true, products: [unpriced]},
    {
      gateway: 'meta_native_action',
      account_id: '123',
      connection_id: 'm',
      catalog_id: '555',
      allow_upsert: true,
      products: [unpriced],
    },
  ])
    assert.equal(refusal(input).message, 'A sale start or end needs a sale price.');
});

// The shared module names no gateway and imports only shared modules and the provider workflows registry.
const sharedSource = file => fs.readFileSync(new URL('../src/' + file, import.meta.url), 'utf8');
const importsOf = source => [...source.matchAll(/from '\.\/([^']+)\.js'/g)].map(m => m[1]);

test('each catalog destination compares through its provider workflows step, after the X selection checks', async () => {
  const steps = catalogComparisonSteps;
  assert.deepEqual(Object.keys(steps.comparisons), Object.keys(catalogDestinations));
  assert.equal(steps.comparisons.meta_native_action, metaCatalogComparison);
  assert.equal(steps.comparisons.x_ads_native_action, xCatalogComparison);
  assert.equal(steps.comparisons.snapchat_native_action, snapchatCatalogComparison);
  assert.equal(steps.inventoryRequested, catalogInventoryRequested);
  assert.equal(steps.listedSelectionRequested, listedSelectionRequested);
  assert.equal(steps.listedSelection, xCatalogListedSelection);
  assert.ok(Object.isFrozen(steps) && Object.isFrozen(steps.comparisons));
  const source = sharedSource('catalog-comparison.ts');
  assert.doesNotMatch(source, /_native_action/);
  assert.deepEqual(importsOf(source), [
    'provider-workflows',
    'catalog-destinations',
    'store',
    'catalog',
    'transport',
    'auth',
    'types',
  ]);
  // Success: a Meta comparison passes its checks and resolves the connection next (the store here stops it).
  const reached = new Error('connection resolved'),
    store = {
      resolveConnection() {
        throw reached;
      },
    };
  const product = {
      retailer_id: 'sku-1',
      name: 'Product 1',
      price: '20',
      currency: 'SAR',
      image_url: 'https://shop.example.test/i/1.jpg',
    },
    meta = {
      gateway: 'meta_native_action',
      account_id: '123',
      connection_id: 'm',
      catalog_id: '555',
      allow_upsert: true,
      products: [product],
    };
  await assert.rejects(catalogComparison(store, null, null, null, {}, meta), reached);
  // Refusals, in the order they were checked: X's inspection check first, whatever the gateway, then X's listed
  // selection check, then the fallback destination's (Meta's) catalog ID, then the shared projection's refusal of a
  // gateway that is no destination.
  const refused = async (input, message) => {
    await assert.rejects(catalogComparison(store, null, null, null, {}, input), error => {
      assert.ok(error instanceof MirrorError);
      assert.deepEqual({code: error.code, message: error.message}, {code: 'INVALID_ARGUMENT', message});
      return true;
    });
  };
  const listed = {requirements: {selection_source: 'listed_inventory', product_keys: ['1']}};
  await refused(
    {...meta, inspect_other_listed_products: true, ...listed},
    'Inspection of other listed products is qualified for X catalogs only.',
  );
  await refused(
    {...meta, gateway: 'snapchat_native_action', ...listed},
    'Selection of listed products is qualified for X catalogs only.',
  );
  await refused(
    {...meta, gateway: 'google_ads_native_action', catalog_id: 'x1'},
    'Choose an exact positive numeric Meta product catalog ID.',
  );
  for (const gateway of ['google_ads_native_action', 'toString', undefined])
    await refused({...meta, gateway}, 'Choose a numeric Meta product catalog ID and selected Meta ad account.');
});

// The creative library's native usage fields as src/creative-library.ts computed them before ARC-01 moved them into
// the Google Ads, Snapchat and Meta hooks (mediaUsage), copied verbatim, and as it computes them now.
function usageBefore(p) {
  const googleImage =
    p.platform === 'google_ads' &&
    p.media_type === 'image' &&
    typeof p.account_id === 'string' &&
    /^\d{1,20}$/.test(normalizeAccount('google_ads_native_action', p.account_id)) &&
    typeof p.media_id === 'string' &&
    new RegExp(
      '^customers/' + normalizeAccount('google_ads_native_action', p.account_id) + '/assets/[1-9][0-9]{0,19}$',
    ).test(p.media_id) &&
    typeof p.uploaded_sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(p.uploaded_sha256);
  const snapchatMedia =
    p.platform === 'snapchat' &&
    ['image', 'video'].includes(p.media_type) &&
    [p.account_id, p.media_id].every(
      v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
    ) &&
    typeof p.uploaded_sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(p.uploaded_sha256);
  return {
    native_usage_supported:
      googleImage || snapchatMedia || (p.platform === 'meta' && ['image', 'video'].includes(p.media_type)),
    native_usage_kind: googleImage
      ? 'google_image_links'
      : snapchatMedia
        ? 'snapchat_top_snap'
        : p.platform === 'meta'
          ? 'meta_scalar_references'
          : null,
    ...(googleImage ? {native_usage_views: ['ad_images', 'performance_max', 'performance_max_brand']} : {}),
    ...(snapchatMedia ? {native_usage_views: ['snapchat_top_snap']} : {}),
  };
}
function usageAfter(p) {
  const usage =
    typeof p.platform === 'string' ? providerHooks(p.platform + '_native_action')?.mediaUsage?.(p) : undefined;
  return {
    native_usage_supported: usage?.supported ?? false,
    native_usage_kind: usage?.kind ?? null,
    ...(usage?.views ? {native_usage_views: [...usage.views]} : {}),
  };
}
const gatewayLiteral = /['"][a-z0-9]+(?:_[a-z0-9]+)*_native_action['"]/;

test('a library asset offers the native usage its platform hooks name, as the creative library computed it', () => {
  // Exactly Google Ads, Meta and Snapchat name one, each a kind an asset usage reader reads.
  assert.deepEqual(
    registeredProviderHooks.filter(h => h.mediaUsage).map(h => h.gateway),
    ['google_ads_native_action', 'meta_native_action', 'snapchat_native_action'],
  );
  const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e',
    other = '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    hash = 'ab'.repeat(32);
  const kinds = new Map();
  for (const platform of ['google_ads', 'snapchat', 'meta', 'tiktok', 'linkedin', 'x_ads', 'dv360', 'toString', 7])
    for (const media_type of ['image', 'video', 'document', undefined])
      for (const account_id of ['123-456-7890', '1234567890', uuid, 'act_1', '', undefined])
        for (const media_id of ['customers/1234567890/assets/42', 'customers/1234567890/assets/0', other, undefined])
          for (const uploaded_sha256 of [hash, hash.toUpperCase(), undefined]) {
            const p = {platform, media_type, account_id, media_id, uploaded_sha256},
              after = usageAfter(p);
            assert.deepEqual(after, usageBefore(p), JSON.stringify(p));
            if (after.native_usage_supported) kinds.set(after.native_usage_kind, after.native_usage_views);
          }
  // Success: each kind is reached, and an asset usage reader reads it.
  assert.deepEqual([...kinds.keys()].sort(), ['google_image_links', 'meta_scalar_references', 'snapchat_top_snap']);
  for (const kind of kinds.keys()) assert.equal(typeof assetUsageReader(kind), 'function', kind);
  // Refusals: another customer's Google asset, a Snapchat asset without UUIDs, a Meta document, another platform.
  const google = {platform: 'google_ads', media_type: 'image', account_id: '1234567890', uploaded_sha256: hash};
  assert.equal(usageAfter({...google, media_id: 'customers/1234567890/assets/42'}).native_usage_supported, true);
  assert.deepEqual(usageAfter({...google, media_id: 'customers/99/assets/42'}), {
    native_usage_supported: false,
    native_usage_kind: null,
  });
  assert.deepEqual(
    usageAfter({platform: 'snapchat', media_type: 'video', account_id: uuid, media_id: '42', uploaded_sha256: hash}),
    {native_usage_supported: false, native_usage_kind: null},
  );
  assert.deepEqual(usageAfter({platform: 'meta', media_type: 'document'}), {
    native_usage_supported: false,
    native_usage_kind: 'meta_scalar_references',
  });
  assert.deepEqual(usageAfter({platform: 'tiktok', media_type: 'image'}), {
    native_usage_supported: false,
    native_usage_kind: null,
  });
  // The shared module names no gateway.
  assert.doesNotMatch(sharedSource('creative-library.ts'), gatewayLiteral);
});

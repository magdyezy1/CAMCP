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

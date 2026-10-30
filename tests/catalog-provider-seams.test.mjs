import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogDestination, catalogDestinations, fallbackCatalogDestination} from '../dist/src/catalog-destinations.js';
import {catalogRetirementOf} from '../dist/src/catalog-retirement.js';
import {catalogDestinationOrder, providerAdapters, providerOf} from '../dist/src/provider-adapters.js';

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

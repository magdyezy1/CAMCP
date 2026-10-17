import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {providerContracts} from '../dist/src/provider-contracts.js';
import {reviewedFamilies} from '../dist/src/reviewed-families.js';
import {
  familyProvider,
  parkedProviderIds,
  providerAdapters,
  providerLifecycle,
  providerOf,
  unknownProviderIds,
} from '../dist/src/provider-adapters.js';
import {assertGatewayOffered, gatewayOffered} from '../dist/src/provider-offering.js';
import {MirrorError, errorRemedy} from '../dist/src/errors.js';
import {loadConfig} from '../dist/server/config.js';
import {platforms} from '../dist/server/platform-oauth.js';

// The provider adapter registry and its lifecycle status (ARC-01). Each test passes its environment explicitly, so
// the deployment's own AMCP_PROVIDERS never changes what it checks.

test('every provider gateway, provider contract and website platform has exactly one adapter', () => {
  assert.equal(new Set(providerAdapters.map(a => a.gateway)).size, providerAdapters.length, 'one adapter per gateway');
  assert.equal(new Set(providerAdapters.map(a => a.id)).size, providerAdapters.length, 'one adapter per provider ID');
  const gateways = [...new Registry().tools.keys()].filter(
    name => name.endsWith('_native_action') && name !== 'amcp_native_action',
  );
  assert.ok(gateways.length >= 17);
  for (const gateway of gateways) assert.ok(providerOf(gateway), gateway + ' has a lifecycle status');
  for (const contract of providerContracts)
    assert.equal(providerOf(contract.gateway)?.id, contract.id, contract.gateway + ' is the adapter of ' + contract.id);
  for (const p of platforms) if (p.gateway) assert.ok(providerOf(p.gateway), p.id + ' platform has an adapter');
  for (const a of providerAdapters) {
    assert.equal(a.status === 'parked', a.parked !== undefined, a.id + ': parked exactly when its status says so');
    assert.ok(Object.isFrozen(a) && a.familyPrefixes.length, a.id);
  }
  // AMCP's own tools have no provider and are always offered.
  for (const tool of ['amcp_workspace', 'amcp_native_action', 'amcp_tool_help', undefined, 42])
    assert.equal(gatewayOffered(tool, {}), true, String(tool));
});

test('every registered reviewed family belongs to one provider, by its longest name prefix', () => {
  for (const family of reviewedFamilies()) assert.ok(familyProvider(family.name), family.name);
  assert.equal(familyProvider('google_business_lodging')?.id, 'google_business');
  assert.equal(familyProvider('google_targeting')?.id, 'google');
  assert.equal(familyProvider('search_console_sites')?.id, 'gsc');
  assert.equal(familyProvider('x_tracking_tags')?.id, 'x');
  assert.equal(familyProvider('unknown_family'), undefined);
});

test('a parked provider is offered only where AMCP_PROVIDERS names it; active providers always are', () => {
  const amazon = providerOf('amazon_native_action');
  assert.deepEqual([amazon.status, amazon.parked.reason], ['parked', 'unimplemented']);
  assert.ok(parkedProviderIds().has('amazon'));
  assert.equal(gatewayOffered('amazon_native_action', {}), false);
  assert.equal(gatewayOffered('amazon_native_action', {AMCP_PROVIDERS: 'meta, amazon'}), true);
  assert.equal(gatewayOffered('amazon_native_action', {AMCP_PROVIDERS: 'amazonads'}), false, 'exact IDs only');
  assert.equal(gatewayOffered('meta_native_action', {}), true);
  assert.equal(providerLifecycle({}).find(p => p.provider === 'amazon').offered, false);
  assert.equal(providerLifecycle({AMCP_PROVIDERS: 'amazon'}).find(p => p.provider === 'amazon').offered, true);
  // The refusal names the provider and why it is parked; nothing else is offered in its place.
  assert.throws(
    () => assertGatewayOffered('amazon_native_action', {}),
    e =>
      e instanceof MirrorError &&
      e.code === 'GATEWAY_NOT_OFFERED' &&
      e.status === 404 &&
      /no website connection or account discovery yet/.test(e.message) &&
      JSON.stringify(e.details) ===
        JSON.stringify({
          gateway: 'amazon_native_action',
          provider: 'amazon',
          status: 'parked',
          reason: 'unimplemented',
        }),
  );
  assert.doesNotThrow(() => assertGatewayOffered('amazon_native_action', {AMCP_PROVIDERS: 'amazon'}));
  assert.doesNotThrow(() => assertGatewayOffered('meta_native_action', {}));
});

test('P9: Criteo and WooCommerce are owner-parked, their families are not offered, and no website login page belongs to a parked provider', () => {
  for (const [gateway, id] of [
    ['criteo_native_action', 'criteo'],
    ['commerce_native_action', 'woocommerce'],
  ]) {
    const provider = providerOf(gateway);
    assert.deepEqual([provider.id, provider.status, provider.parked.reason], [id, 'parked', 'owner_parked']);
    assert.equal(gatewayOffered(gateway, {}), false);
    assert.equal(gatewayOffered(gateway, {AMCP_PROVIDERS: id}), true);
  }
  assert.deepEqual([...parkedProviderIds()].sort(), ['amazon', 'criteo', 'woocommerce']);
  // The family registry stays complete for the ledger, by design; a parked provider's families are offered exactly as
  // its gateway is, because the listings that show families filter them by their gateway's status.
  const criteoFamilies = reviewedFamilies().filter(f => familyProvider(f.name)?.id === 'criteo');
  assert.equal(criteoFamilies.length, 12);
  for (const family of criteoFamilies) {
    assert.equal(gatewayOffered(familyProvider(family.name).gateway, {}), false, family.name);
    assert.equal(gatewayOffered(familyProvider(family.name).gateway, {AMCP_PROVIDERS: 'criteo'}), true, family.name);
  }
  assert.equal(gatewayOffered(familyProvider('meta_pixels').gateway, {}), true);
  // OAuth pages: a parked provider has no website login, so Connections never offers one; gate a platform here first.
  for (const p of platforms) assert.equal(providerOf(p.gateway)?.status ?? 'active', 'active', p.id);
});

test('the remedy of a parked provider names the operator switch; an unimplemented one names the missing onboarding', () => {
  const remedy = reason =>
    errorRemedy(new MirrorError('GATEWAY_NOT_OFFERED', 'x', {gateway: 'g', provider: 'p', reason}, 404)).action;
  assert.match(remedy('owner_parked'), /its work is parked.*AMCP_PROVIDERS/);
  assert.match(remedy('unimplemented'), /no website connection or account discovery yet/);
});

test('a misspelt AMCP_PROVIDERS name is a startup problem and offers nothing', () => {
  assert.deepEqual(unknownProviderIds({AMCP_PROVIDERS: 'amazon, amazn,criteo  shopify'}), ['amazn', 'shopify']);
  assert.deepEqual(unknownProviderIds({}), []);
  const config = loadConfig({AMCP_PROVIDERS: 'amazn'}, 'http');
  assert.ok(config.problems.some(p => /^AMCP_PROVIDERS names no provider: amazn\. Provider IDs: google, /.test(p)));
  assert.equal(loadConfig({AMCP_PROVIDERS: 'amazon'}, 'http').problems.length, 0);
  assert.equal(familyProvider('amazn_family'), undefined, 'a misspelt name is no provider and no family prefix');
});

test('ARC-04 stage B: each provider adapter declares its account ID form, read by a leaf that scope.ts re-exports', async () => {
  const leaf = await import('../dist/src/account-id.js'),
    scope = await import('../dist/src/scope.js');
  assert.equal(scope.normalizeAccount, leaf.normalizeAccount, 'one function, two import paths');
  const {normalizeAccount} = leaf;
  assert.equal(normalizeAccount('meta_native_action', 'act_123'), '123');
  assert.equal(normalizeAccount('meta_native_action', '123'), '123');
  assert.equal(normalizeAccount('meta_native_action', 'xact_123'), 'xact_123', 'only a leading act_');
  assert.equal(normalizeAccount('google_ads_native_action', '123-456-7890'), '1234567890');
  assert.equal(normalizeAccount('google_ads_native_action', 1234567890), '1234567890');
  // Every other provider's ID is kept as given, dashes and prefixes included.
  for (const adapter of providerAdapters.filter(a => !['google', 'meta'].includes(a.id)))
    assert.equal(normalizeAccount(adapter.gateway, 'act_1-2'), 'act_1-2', adapter.id);
  assert.equal(normalizeAccount('amcp_native_action', 'act_1-2'), 'act_1-2');
  // Only Google Ads and Meta transform their IDs; the rest of each account model (ARC-01 phase B: fields, references,
  // paths, kind) is checked in tests/provider-account-model.test.mjs.
  assert.deepEqual(
    providerAdapters.filter(a => a.account?.normalize).map(a => a.id),
    ['google', 'meta'],
  );
});

test('ARC-04 stage B: the review-state projection helpers come from one leaf, re-exported by review-state.ts', async () => {
  const core = await import('../dist/src/review-state-core.js'),
    state = await import('../dist/src/review-state.js');
  for (const name of ['normalizeReviewState', 'reviewStateHash', 'changedStateFields'])
    assert.equal(state[name], core[name], name);
  // The projection drops volatile fields, sorts keys and membership-only arrays, and keeps other arrays in order.
  assert.deepEqual(core.normalizeReviewState({b: 1, updatedTime: 'x', countries: ['US', 'DE'], ids: [2, 1]}), {
    b: 1,
    countries: ['DE', 'US'],
    ids: [2, 1],
  });
  assert.equal(core.reviewStateHash({a: 1, stats: {x: 1}}), core.reviewStateHash({a: 1}));
  assert.deepEqual(core.changedStateFields({a: 1, b: [1, 2]}, {a: 2, b: [1]}), ['$["a"]', '$["b"][1]']);
});

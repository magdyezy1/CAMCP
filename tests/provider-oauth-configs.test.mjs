import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as registry from '../dist/src/provider-adapters.js';
import * as grants from '../dist/src/provider-grants.js';
import {platforms} from '../dist/server/platform-oauth.js';

// ARC-01 phase B, the OAuth configuration: the grant registry (src/provider-grants.ts) and the website's platforms
// (server/platform-oauth.ts) named each provider's gateway. Each grant is now a fact of its provider's adapter (`grant`
// in src/provider-adapters.ts, with the scope names it uses), listed in the registry's grant order, and each website
// platform takes its gateway and default scopes from the adapter its ID names. The OAuth flows' provider steps and asset
// discovery are the provider's website login steps (src/<provider>-login.ts; tests/provider-oauth-steps.test.mjs and
// tests/provider-asset-discovery.test.mjs, ARCHITECTURE section 9).

test('the grant registry and the website platforms name no gateway', () => {
  for (const file of ['src/provider-grants.ts', 'server/platform-oauth.ts']) {
    const source = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /['"][a-z0-9_]+_native_action['"]/, file);
  }
});

test('each grant is its adapter’s, listed in the grant order', () => {
  assert.deepEqual(registry.grantOrder, [
    'meta',
    'google',
    'linkedin',
    'reddit',
    'microsoft',
    'snapchat',
    'tiktok',
    'x',
    'dv360',
    'ga4',
    'gtm',
    'gsc',
    'apple',
    'google_business',
    'criteo',
    'sheets',
    'drive',
  ]);
  assert.deepEqual(
    grants.providerGrants.map(g => g.gateway),
    registry.grantOrder.map(id => registry.providerById(id).gateway),
  );
  // Exactly the adapters with a grant are listed, each once.
  assert.deepEqual(
    registry.providerAdapters
      .filter(a => a.grant)
      .map(a => a.id)
      .sort(),
    [...registry.grantOrder].sort(),
  );
  const fields = ['requestedRead', 'requestedWrite', 'read', 'write', 'grantSource', 'accountReadContract'];
  for (const g of grants.providerGrants) {
    const adapter = registry.providerOf(g.gateway);
    assert.ok(Object.isFrozen(adapter.grant), g.gateway);
    // The grant registry's field order (Criteo has no website platform).
    assert.deepEqual(Object.keys(g), ['gateway', ...(adapter.id === 'criteo' ? [] : ['platform']), ...fields]);
    // The entry is the gateway and then the adapter's facts, in their order.
    assert.deepEqual(Object.keys(g), ['gateway', ...Object.keys(adapter.grant)]);
    assert.deepEqual({...g}, {gateway: adapter.gateway, ...adapter.grant});
    assert.equal(grants.providerGrant(g.gateway), g);
  }
  // A provider without a grant has none: no requested scopes, no recorded write grant.
  assert.equal(grants.providerGrant('adjust_native_action'), undefined);
  assert.deepEqual(grants.requestedScopes('adjust_native_action', true), []);
  // The scope names other modules import from the grant registry are the registry's.
  for (const name of [
    'gtmWriteScopes',
    'googleAdsScope',
    'dv360Scope',
    'businessScope',
    'snapchatScope',
    'microsoftManageScope',
    'analyticsScopes',
    'searchConsoleWriteScope',
    'appleScope',
  ])
    assert.equal(grants[name], registry[name], name);
});

test('each website platform takes its gateway and default scopes from the adapter its ID names', () => {
  // The platforms and their gateways, as the table named them before.
  assert.deepEqual(Object.fromEntries(platforms.map(p => [p.id, p.gateway])), {
    sheets: 'google_sheets_native_action',
    drive: 'google_drive_native_action',
    microsoft: 'microsoft_ads_native_action',
    google: 'google_ads_native_action',
    meta: 'meta_native_action',
    tiktok: 'tiktok_native_action',
    snapchat: 'snapchat_native_action',
    linkedin: 'linkedin_native_action',
    x: 'x_ads_native_action',
    ga4: 'ga4_native_action',
    gtm: 'gtm_native_action',
    gsc: 'google_search_console_native_action',
    apple: 'apple_ads_native_action',
    dv360: 'dv360_native_action',
    google_business: 'google_business_native_action',
    reddit: 'reddit_native_action',
  });
  for (const p of platforms) {
    assert.equal(p.gateway, registry.providerById(p.id).gateway, p.id);
    assert.deepEqual(p.scopes, [...registry.providerById(p.id).grant.requestedRead], p.id);
    // A grant names the website platform that authorizes it.
    assert.equal(grants.providerGrant(p.gateway).platform, p.id, p.id);
  }
});

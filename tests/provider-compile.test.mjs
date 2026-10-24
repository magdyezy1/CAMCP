import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../dist/src/catalog.js';
import {Compiler} from '../dist/src/compiler.js';
import {registeredProviderHooks} from '../dist/src/provider-hooks.js';
import {linkedinVersion} from '../dist/src/linkedin-version.js';
import {isProviderModule, providerRegistries} from '../tools/architecture-map.mjs';

// ARC-01 phase B, the catalog compiler (wave 4c): src/compiler.ts keeps the input guards, the catalog lookup, the alias,
// account, body, path, query and method rules and the order of every step; what only a provider says about its
// requests is its adapter's compile hooks (src/<provider>-adapter.ts), consulted only for its own gateway. These tests
// fail if a provider's rule leaks into another gateway's requests or the compiler names a provider again.
const registry = new Registry(),
  compiler = new Compiler(registry),
  strict = {mode: 'strict', flags: {}},
  enhanced = {mode: 'enhanced', flags: {nativeRequests: true}};
const refusal = (code, message) => error => {
  assert.equal(error.code, code, error.message);
  if (message) assert.match(error.message, message);
  return true;
};

test('the catalog compiler names no provider: it consults the providers’ compile hooks', () => {
  const source = fs.readFileSync(new URL('../src/compiler.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /['"][a-z0-9_]+_native_action['"]/, 'no gateway literal in src/compiler.ts');
  for (const [, module] of source.matchAll(/from '\.\/([^']+)\.js'/g))
    assert.ok(
      !isProviderModule('src/' + module + '.ts') || providerRegistries.includes('src/' + module + '.ts'),
      'src/compiler.ts imports no provider module (' + module + ')',
    );
});

test('the providers that take part in compilation, each with frozen hooks of the contract', () => {
  const known = new Set([
    'own',
    'legacy',
    'resourceAction',
    'joinedFields',
    'accountValues',
    'required',
    'queryParameters',
    'request',
    'batchParameter',
    'beforeJob',
    'afterJob',
  ]);
  const declared = registeredProviderHooks.filter(h => h.compile).map(h => h.gateway);
  assert.deepEqual(declared.sort(), [
    'apple_ads_native_action',
    'dv360_native_action',
    'google_ads_native_action',
    'linkedin_native_action',
    'meta_native_action',
    'microsoft_ads_native_action',
    'snapchat_native_action',
    'tiktok_native_action',
    'x_ads_native_action',
  ]);
  for (const hooks of registeredProviderHooks.filter(h => h.compile)) {
    assert.ok(Object.isFrozen(hooks.compile), hooks.gateway + ' compile hooks are frozen');
    for (const key of Object.keys(hooks.compile)) assert.ok(known.has(key), hooks.gateway + ' declares ' + key);
    if (hooks.compile.required) assert.ok(Object.isFrozen(hooks.compile.required), hooks.gateway + ' required');
  }
});

test('Meta’s field lists, act_ account form and Graph batch apply to Meta’s requests only', () => {
  const meta = compiler.compile(
    'meta_native_action',
    {
      action: 'meta_ad_account_id_campaigns_get',
      account_id: 'act_1',
      ad_account_id: '1',
      params: {fields: ['id', 'name']},
    },
    strict,
  );
  assert.equal(meta.path, '/v26.0/act_1/campaigns');
  assert.equal(meta.query.fields, 'id,name');
  // TikTok keeps a field list as the list it was given.
  const tiktok = compiler.compile(
    'tiktok_native_action',
    {action: 'tiktok_campaign_get', advertiser_id: '9', params: {fields: ['a', 'b']}},
    strict,
  );
  assert.deepEqual(tiktok.query.fields, ['a', 'b']);
  // A Graph batch carries other requests, so it is never a read; the same query is a plain read elsewhere.
  const batch = query => ({native_request: {method: 'GET', path: '/v1/x', query}});
  assert.equal(
    compiler.compile('meta_native_action', {action: 'x', account_id: '1', ...batch({batch: '[]'})}, enhanced).readOnly,
    false,
  );
  assert.equal(
    compiler.compile('tiktok_native_action', {action: 'x', advertiser_id: '1', ...batch({batch: '[]'})}, enhanced)
      .readOnly,
    true,
  );
});

test('Google Ads’ customer form and required request fields are its own', () => {
  const read = compiler.compile(
    'google_ads_native_action',
    {
      action: 'google_ads_v23_google_ads_search',
      account_id: '123-456-7890',
      payload: {query: 'SELECT campaign.id FROM campaign'},
    },
    strict,
  );
  assert.equal(read.path, '/v25/customers/1234567890/googleAds:search');
  // Its required fields are checked in every call mode, with its own refusal text.
  assert.throws(
    () =>
      compiler.compile(
        'google_ads_native_action',
        {action: 'google_ads_v23_google_ads_search', account_id: '1'},
        strict,
      ),
    refusal('MISSING_PARAMETER', /^google_ads_v23_google_ads_search requires request field 'query'\./),
  );
});

test('LinkedIn’s version and Rest.li headers and method tunnelling are its own', () => {
  const action = 'linkedin_rest_account_intelligence_get';
  const plain = compiler.compile('linkedin_native_action', {action}, strict);
  assert.equal(plain.headers['LinkedIn-Version'], linkedinVersion(undefined));
  assert.equal(plain.headers['X-Restli-Protocol-Version'], '2.0.0');
  assert.equal(plain.readOnly, true);
  const tunnelled = compiler.compile('linkedin_native_action', {action, http_method_override: 'DELETE'}, strict);
  assert.equal(tunnelled.method, 'POST');
  assert.equal(tunnelled.headers['X-HTTP-Method-Override'], 'DELETE');
  assert.equal(tunnelled.readOnly, false);
  assert.equal(tunnelled.destructive, true);
  assert.throws(
    () => compiler.compile('linkedin_native_action', {action, restli_method: 'BOGUS'}, strict),
    refusal('INVALID_METHOD_OVERRIDE', /REST\.li/),
  );
  // No other gateway's request carries LinkedIn's headers.
  const tiktok = compiler.compile('tiktok_native_action', {action: 'tiktok_campaign_get', advertiser_id: '9'}, strict);
  assert.equal(tiktok.headers['LinkedIn-Version'], undefined);
  assert.equal(tiktok.headers['X-Restli-Protocol-Version'], undefined);
});

test('TikTok’s advertiser, lead region and comment scope are its own', () => {
  const read = compiler.compile(
    'tiktok_native_action',
    {action: 'tiktok_campaign_get', advertiser_id: '9', lead_region: 'EU'},
    strict,
  );
  assert.equal(read.query.advertiser_id, '9');
  assert.equal(read.headers['X-Lead-Region'], 'EU');
  assert.throws(
    () =>
      compiler.compile(
        'tiktok_native_action',
        {action: 'tiktok_campaign_get', advertiser_id: '9', comment_scope: {}},
        strict,
      ),
    refusal('UNSUPPORTED_PARAMETER', /comment_scope/),
  );
});

test('DV360 names a route by resource and RPC; Microsoft compiles from its own contracts', () => {
  const route = registry.data.supplemental.find(
    a => a.gateway === 'dv360_native_action' && a.raw.resource === 'customLists' && a.raw.rpc === 'get',
  );
  assert.ok(route, 'the DV360 custom list read is catalogued');
  const dv360 = compiler.compile(
    'dv360_native_action',
    {resource: 'customLists', method: 'get', path_params: {customListId: '1'}},
    strict,
  );
  assert.equal(dv360.action, route.canonical_name || route.name);
  assert.equal(dv360.path, '/v4/customLists/1');
  // Another gateway does not look a route up by resource and RPC.
  assert.throws(
    () => compiler.compile('meta_native_action', {resource: 'customLists', method: 'get'}, strict),
    refusal('UNKNOWN_ACTION', /captured catalog/),
  );
  assert.throws(
    () => compiler.compile('microsoft_ads_native_action', {action: 'NoSuchAction'}, strict),
    refusal('UNKNOWN_ACTION', /^Unknown Microsoft action\. Use LIST_ACTIONS\.$/),
  );
});

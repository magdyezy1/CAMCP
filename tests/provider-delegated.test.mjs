import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DelegatedNativeCompiler, delegatedParameterMatches} from '../dist/src/delegated-native.js';
import {registeredProviderHooks} from '../dist/src/provider-hooks.js';
import {redditAudienceRoutes, redditReadRoutes} from '../dist/src/reddit-extensions.js';
import {isProviderModule, providerRegistries} from '../tools/architecture-map.mjs';

// ARC-01 phase B, the delegated compiler (wave 4c): src/delegated-native.ts keeps the route lookup, the version, path,
// query and body rules, the vendor schema checks and the order of every step; what only a provider says about its
// delegated requests is its adapter's delegated hooks (src/<provider>-adapter.ts), consulted only for its own gateway.
// The first three tests fail on the build before the move (the compiler named Reddit, GA4, Search Console, Business
// Profile, Criteo and Google Ads, and no adapter declared delegated hooks); the others pin each provider's rule to its
// own requests and pass on both builds.
const compiler = new DelegatedNativeCompiler();
const compile = (gateway, operation, args) => compiler.compile(gateway, {operation, arguments: args});
const refusal = (code, message) => error => {
  assert.equal(error.code, code, error.message);
  if (message) assert.match(error.message, message);
  return true;
};
const route = (gateway, action) => compiler.data.routes.find(r => r.gateway === gateway && r.action === action);

test('the delegated compiler names no provider: it consults the providers’ delegated hooks', () => {
  const source = fs.readFileSync(new URL('../src/delegated-native.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /['"][a-z0-9_]+_native_action['"]/, 'no gateway literal in src/delegated-native.ts');
  for (const [, module] of source.matchAll(/from '\.\/([^']+)\.js'/g))
    assert.ok(
      !isProviderModule('src/' + module + '.ts') || providerRegistries.includes('src/' + module + '.ts'),
      'src/delegated-native.ts imports no provider module (' + module + ')',
    );
});

test('the providers that take part in delegated compilation, each with frozen hooks of the contract', () => {
  const known = new Set([
    'direct',
    'routes',
    'aliases',
    'bodyArgument',
    'queryBody',
    'bodyFields',
    'missingPathStep',
    'requiredQuery',
    'joinedArrays',
    'bodySchema',
    'scope',
  ]);
  const declared = registeredProviderHooks.filter(h => h.delegated).map(h => h.gateway);
  assert.deepEqual(declared.sort(), [
    'criteo_native_action',
    'ga4_native_action',
    'google_ads_native_action',
    'google_business_native_action',
    'google_search_console_native_action',
    'reddit_native_action',
  ]);
  for (const hooks of registeredProviderHooks.filter(h => h.delegated)) {
    assert.ok(Object.isFrozen(hooks.delegated), hooks.gateway + ' delegated hooks are frozen');
    for (const key of Object.keys(hooks.delegated)) assert.ok(known.has(key), hooks.gateway + ' declares ' + key);
    for (const part of ['scope', 'bodySchema', 'routes'])
      if (hooks.delegated[part]) assert.ok(Object.isFrozen(hooks.delegated[part]), hooks.gateway + ' ' + part);
  }
});

test('the vendor snapshot’s report and inspection actions are the providers’ whose rules name them', () => {
  // The compiler applied the report window check to every schema-checked GET_INSIGHTS and kept the top-level body of
  // every INSPECT_URL; the hooks scope them to Reddit and Search Console, which equals the shared rule only while the
  // pinned snapshot holds these actions for those providers alone. A snapshot that adds one elsewhere fails here, so
  // that provider's own rule is decided rather than inherited.
  const owners = action => [
    ...new Set(
      [...compiler.data.routes, ...redditAudienceRoutes, ...redditReadRoutes()]
        .filter(r => r.action === action)
        .map(r => r.gateway),
    ),
  ];
  assert.deepEqual(owners('GET_INSIGHTS'), ['reddit_native_action']);
  assert.deepEqual(owners('INSPECT_URL'), ['google_search_console_native_action']);
});

test('Google Ads’ vendor routes are never delegated; Reddit’s own routes join the snapshot’s', () => {
  assert.equal(compiler.data.routes.filter(r => r.gateway === 'google_ads_native_action').length, 0);
  for (const r of [...redditAudienceRoutes, ...redditReadRoutes()])
    assert.equal(
      compiler.canCompile(r.gateway, {operation: r.operation, arguments: {action: r.action}}),
      true,
      r.action,
    );
  // Without the Reddit v3 schemas the snapshot cannot check their bodies, so they are not added.
  const bare = new DelegatedNativeCompiler({
    ...compiler.data,
    routes: compiler.data.routes.filter(r => r.gateway !== 'reddit_native_action'),
    schemaComponents: {},
  });
  for (const r of redditAudienceRoutes)
    assert.equal(bare.canCompile(r.gateway, {operation: r.operation, arguments: {action: r.action}}), false, r.action);
});

test('Reddit’s argument aliases and comma-joined arrays are its own', () => {
  assert.equal(delegatedParameterMatches('reddit_native_action', 'adset_id', 'ad_group_id'), true);
  assert.equal(delegatedParameterMatches('reddit_native_action', 'cursor', 'page.token'), true);
  for (const gateway of ['criteo_native_action', 'ga4_native_action', 'gtm_native_action'])
    assert.equal(delegatedParameterMatches(gateway, 'adset_id', 'ad_group_id'), false, gateway);
  // The shared aliases hold for every gateway.
  assert.equal(delegatedParameterMatches('gtm_native_action', 'site_url', 'siteUrl'), true);
  const list = compiler.data.routes.find(
    r =>
      r.gateway === 'reddit_native_action' &&
      Object.values(r.parameters).some(s => s.location === 'query' && s.explode === false),
  );
  assert.ok(list, 'a Reddit read takes an unexploded list');
  const [key] = Object.entries(list.parameters).find(([, s]) => s.location === 'query' && s.explode === false);
  const path = Object.fromEntries(
    Object.entries(list.parameters)
      .filter(([, s]) => s.location === 'path')
      .map(([k]) => [k, 't2_123']),
  );
  const plan = compile('reddit_native_action', list.operation, {
    action: list.action,
    path_params: path,
    params: {[key]: ['a', 'b']},
  });
  assert.equal(plan.query[key], 'a,b');
  assert.throws(
    () =>
      compile('reddit_native_action', list.operation, {
        action: list.action,
        path_params: path,
        params: {[key]: ['a,b']},
      }),
    refusal('INVALID_PARAMETER', /Comma-separated/),
  );
});

test('GA4’s request argument and property scope are its own', () => {
  const operation = 'ga4_run_report';
  assert.ok(
    compiler.data.routes.some(r => r.gateway === 'ga4_native_action' && r.operation === operation),
    'the GA4 report route is in the snapshot',
  );
  const plan = compile('ga4_native_action', operation, {property: '123', request: {dimensions: [{name: 'date'}]}});
  assert.equal(plan.path, '/v1beta/properties/123:runReport');
  assert.equal(plan.accountId, '123');
  assert.deepEqual(plan.body, {dimensions: [{name: 'date'}]});
  assert.throws(
    () => compile('ga4_native_action', operation, {property: '123', request: {nested: {property: 'properties/9'}}}),
    refusal('ACCOUNT_SCOPE_MISMATCH', /^Nested report property differs/),
  );
  assert.throws(
    () => compile('ga4_native_action', operation, {}),
    error => error.code === 'MISSING_PARAMETER' && /audience_export_name/.test(error.details.next_step),
  );
  // Another gateway's missing path parameter suggests friendly IDs, and its body argument is payload.
  const gtm = compiler.data.routes.find(
    r => r.gateway === 'gtm_native_action' && Object.values(r.parameters).some(s => s.location === 'path'),
  );
  assert.throws(
    () => compile('gtm_native_action', gtm.operation, {action: gtm.action}),
    error => error.code === 'MISSING_PARAMETER' && /friendly resource IDs/.test(error.details.next_step),
  );
});

test('Search Console’s inspection fields and site scope are its own', () => {
  const inspect = route('google_search_console_native_action', 'INSPECT_URL');
  const plan = compile('google_search_console_native_action', inspect.operation, {
    action: 'INSPECT_URL',
    site_url: 'https://example.com/',
    inspection_url: 'https://example.com/a',
    language_code: 'en',
  });
  assert.deepEqual(plan.body, {
    siteUrl: 'https://example.com/',
    inspectionUrl: 'https://example.com/a',
    languageCode: 'en',
  });
  assert.equal(plan.accountId, 'https://example.com/');
});

test('Business Profile’s read mask and location scope are its own', () => {
  const location = route('google_business_native_action', 'GET_LOCATION');
  assert.throws(
    () =>
      compile('google_business_native_action', location.operation, {
        action: 'GET_LOCATION',
        params: {name: 'locations/4'},
        query: {readMask: ' '},
      }),
    refusal('INVALID_PARAMETER', /^Choose an explicit nonempty readMask/),
  );
  const plan = compile('google_business_native_action', location.operation, {
    action: 'GET_LOCATION',
    params: {name: 'locations/4'},
    query: {readMask: 'name'},
  });
  assert.equal(plan.accountId, 'locations/4');
  const metadata = route('google_business_native_action', 'LIST_PLACE_ACTION_TYPE_METADATA');
  assert.throws(
    () =>
      compile('google_business_native_action', metadata.operation, {
        action: 'LIST_PLACE_ACTION_TYPE_METADATA',
        account_id: '5',
        location_id: '4',
      }),
    refusal('ACCOUNT_SCOPE_MISMATCH', /^Choose an account or a location context, not both\.$/),
  );
  const filtered = compile('google_business_native_action', metadata.operation, {
    action: 'LIST_PLACE_ACTION_TYPE_METADATA',
    location_id: '4',
  });
  assert.equal(filtered.query.filter, 'location=locations/4');
  assert.equal(filtered.accountId, 'locations/4');
});

test('Criteo’s and Reddit’s body schemas apply to their own routes, each with its own refusal', () => {
  const criteo = compiler.data.routes.find(
    r => r.gateway === 'criteo_native_action' && r.requestSchema && r.responseSchemas,
  );
  assert.ok(criteo, 'a documented Criteo route takes a body');
  const path = Object.fromEntries(
    Object.entries(criteo.parameters)
      .filter(([, s]) => s.location === 'path')
      .map(([k]) => [k, '123']),
  );
  assert.throws(
    () =>
      compile('criteo_native_action', criteo.operation, {action: criteo.action, path_params: path, payload: {data: 7}}),
    refusal('INVALID_VENDOR_BODY', /^Request body does not satisfy the pinned Criteo campaign schema\.$/),
  );
  const reddit = compiler.data.routes.find(r => r.gateway === 'reddit_native_action' && r.requestSchema);
  const redditPath = Object.fromEntries(
    Object.entries(reddit.parameters)
      .filter(([, s]) => s.location === 'path')
      .map(([k]) => [k, 't2_123']),
  );
  assert.throws(
    () =>
      compile('reddit_native_action', reddit.operation, {
        action: reddit.action,
        path_params: redditPath,
        payload: {data: 7},
      }),
    refusal('INVALID_VENDOR_BODY', /^Request body does not satisfy the published Reddit API schema\.$/),
  );
  // A gateway whose bodies are not schema-checked takes any object body its route allows.
  const gtm = compiler.data.routes.find(r => r.gateway === 'gtm_native_action' && r.requestSchema);
  const gtmPath = Object.fromEntries(
    Object.entries(gtm.parameters)
      .filter(([, s]) => s.location === 'path')
      .map(([k, s]) => [k, s.pattern ? s.pattern.replace(/^\^|\$$/g, '').replaceAll('[^/]+', '123') : '123']),
  );
  assert.deepEqual(
    compile('gtm_native_action', gtm.operation, {action: gtm.action, path_params: gtmPath, payload: {data: 7}}).body,
    {data: 7},
  );
});

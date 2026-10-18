import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {ScopeGuard, claimingAuthorizer} from '../dist/src/scope.js';
import {providerHooks, registeredProviderHooks} from '../dist/src/provider-hooks.js';
import {providerOf} from '../dist/src/provider-adapters.js';
import {isProviderModule, providerRegistries} from '../tools/architecture-map.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';

// ARC-01 phase B, the read authorizers: ScopeGuard (src/scope.ts) ran nine provider authorizers before the reviewed
// families' own and three after them, first true wins. Each is now its provider's (src/<provider>-adapter.ts) and
// claims the requests it decides; ScopeGuard consults the one claiming authorizer at the stage the chain ran it, and
// refuses a request two claim (READ_AUTHORIZER_CONFLICT). First-true-wins and exclusive claims decide alike exactly
// when no two authorizers claim one request: this holds that over every catalogued route.

const authorizers = registeredProviderHooks.flatMap(hooks =>
  (hooks.scope?.authorizers ?? []).map(authorizer => ({gateway: hooks.gateway, authorizer})),
);
const plan = (gateway, method, path, fields = {}) => ({
  gateway,
  action: 'native',
  method,
  path,
  query: {},
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  accountId: '123',
  evidence: 'TEST',
  warnings: [],
  ...fields,
});
const claimants = p => authorizers.filter(({authorizer}) => authorizer.claims(p));

test('the read authorizers are the chain’s, each its provider’s, at the stage the chain ran it', () => {
  assert.deepEqual(
    authorizers.map(({gateway, authorizer}) => [gateway, authorizer.name, authorizer.stage]),
    [
      ['google_ads_native_action', 'google_ads_global_planning_read', 'after_families'],
      ['google_business_native_action', 'google_business_place_action_discovery', 'before_families'],
      ['meta_native_action', 'meta_dataset_read', 'before_families'],
      ['tiktok_native_action', 'tiktok_qualified_read', 'before_families'],
      ['snapchat_native_action', 'snapchat_catalog_comparison_read', 'before_families'],
      ['linkedin_native_action', 'linkedin_share_authorization_read', 'before_families'],
      ['linkedin_native_action', 'linkedin_conversion_evidence_read', 'before_families'],
      ['linkedin_native_action', 'linkedin_ad_preview', 'after_families'],
      ['linkedin_native_action', 'linkedin_dsc_media_and_post_reads', 'after_families'],
      ['x_ads_native_action', 'x_audience_estimate', 'before_families'],
      ['reddit_native_action', 'reddit_planning_read', 'before_families'],
      ['dv360_native_action', 'dv360_targeting_search', 'before_families'],
      ['dv360_native_action', 'dv360_audience_read', 'before_families'],
    ],
  );
  for (const {authorizer} of authorizers) assert.ok(Object.isFrozen(authorizer), authorizer.name);
  // The shared guard names no provider and imports no provider module but Snapchat's path leaf it re-exports.
  const source = fs.readFileSync(new URL('../src/scope.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /['"][a-z0-9_]+_native_action['"]/, 'no gateway literal in src/scope.ts');
  const providerImports = [...source.matchAll(/from '\.\/([^']+)\.js'/g)]
    .map(m => 'src/' + m[1] + '.ts')
    .filter(file => isProviderModule(file) && !providerRegistries.includes(file));
  assert.deepEqual(providerImports, ['src/snapchat-scope.ts']);
});

test('each authorizer claims its own documented requests, and none of another provider’s', () => {
  const examples = {
    google_ads_global_planning_read: plan('google_ads_native_action', 'POST', '/v23:listPlannableLocations'),
    google_business_place_action_discovery: plan(
      'google_business_native_action',
      'GET',
      '/v1/placeActionTypeMetadata',
      {
        action: 'gmb_engagement_ops/LIST_PLACE_ACTION_TYPE_METADATA',
      },
    ),
    meta_dataset_read: plan('meta_native_action', 'GET', '/v26.0/123456/stats', {query: {aggregation: 'event'}}),
    tiktok_qualified_read: plan('tiktok_native_action', 'GET', '/v1.3/catalog/set/get/'),
    snapchat_catalog_comparison_read: plan('snapchat_native_action', 'GET', '/v1/adaccounts/123', {
      action: 'AMCP_SNAPCHAT_CATALOG_COMPARISON_READ',
    }),
    linkedin_share_authorization_read: plan(
      'linkedin_native_action',
      'GET',
      '/rest/organizationalEntityCreateShareAuthorizations/owner=urn:li:organization:1&loggedInMember=urn:li:person:a&agent=urn:li:sponsoredAccount:123',
    ),
    linkedin_conversion_evidence_read: plan('linkedin_native_action', 'GET', '/rest/conversions', {
      query: {q: 'account', account: 'urn:li:sponsoredAccount:123'},
    }),
    linkedin_ad_preview: plan('linkedin_native_action', 'GET', '/rest/adPreviews', {
      query: {q: 'creative', creative: 'urn:li:sponsoredCreative:1'},
    }),
    linkedin_dsc_media_and_post_reads: plan('linkedin_native_action', 'GET', '/rest/posts/urn:li:share:1'),
    x_audience_estimate: plan('x_ads_native_action', 'POST', '/12/accounts/abc/audience_estimate'),
    reddit_planning_read: plan('reddit_native_action', 'POST', '/api/v3/forecasting/bid_suggestions'),
    dv360_targeting_search: plan(
      'dv360_native_action',
      'POST',
      '/v4/targetingTypes/TARGETING_TYPE_POI/targetingOptions:search',
    ),
    dv360_audience_read: plan('dv360_native_action', 'GET', '/v4/googleAudiences', {query: {advertiserId: '123'}}),
  };
  assert.deepEqual(Object.keys(examples).sort(), authorizers.map(({authorizer}) => authorizer.name).sort());
  for (const [name, p] of Object.entries(examples)) {
    assert.deepEqual(
      claimants(p).map(({authorizer}) => authorizer.name),
      [name],
      name + ' claims its request alone',
    );
    assert.equal(claimingAuthorizer(p)?.name, name);
    // The same request on any other gateway is claimed by none of these authorizers.
    for (const other of ['meta_native_action', 'gtm_native_action', 'adjust_native_action'])
      if (other !== p.gateway)
        assert.deepEqual(
          claimants({...p, gateway: other}).filter(({authorizer}) => authorizer.name === name),
          [],
          name + ' on ' + other,
        );
  }
  // The rest of LinkedIn's special reads: a DSC creation and a media read.
  for (const p of [
    plan('linkedin_native_action', 'POST', '/rest/posts', {readOnly: false, body: {}}),
    plan('linkedin_native_action', 'GET', '/rest/images/urn:li:image:abc'),
    plan('linkedin_native_action', 'GET', '/rest/videos/urn:li:video:abc'),
  ])
    assert.deepEqual(
      claimants(p).map(({authorizer}) => authorizer.name),
      ['linkedin_dsc_media_and_post_reads'],
    );
  // Nothing claims a request no authorizer decided before: an account path read, a write, a malformed path.
  for (const p of [
    plan('meta_native_action', 'GET', '/v26.0/act_123/campaigns'),
    plan('linkedin_native_action', 'GET', '/rest/adAccounts/123'),
    plan('dv360_native_action', 'POST', '/v4/advertisers/123/campaigns', {readOnly: false}),
    plan('google_ads_native_action', 'POST', '/v23:listPlannableLocations', {readOnly: false}),
    plan('google_ads_native_action', 'POST', '/v23%E0:listPlannableLocations'),
    plan('linkedin_native_action', 'GET', '/rest/posts/%E0'),
  ])
    assert.deepEqual(claimants(p), [], p.gateway + ' ' + p.path);
});

test('no two authorizers claim one catalogued route, whatever its method, body or read classification', () => {
  const registry = new Registry();
  // Every catalogued route, and every route the registry resolves besides (Meta rules, the Data Manager, Apple,
  // Microsoft), each once with the gateway it is registered under.
  const registered = new Map();
  for (const [gateway, catalog] of registry.catalogs)
    for (const action of catalog.actions) registered.set(gateway + ' ' + action.name, [gateway, action]);
  for (const [key, action] of registry.routes) {
    const gateway = key.split('/')[0];
    if (!registered.has(gateway + ' ' + action.name)) registered.set(gateway + ' ' + action.name, [gateway, action]);
  }
  let routes = 0;
  const conflicts = [],
    foreign = [];
  for (const [gateway, action] of registered.values()) {
    if (!action.method || !action.path) continue;
    routes++;
    const path = action.path.replace(/\{[^}]+\}/g, '123');
    for (const fields of [{}, {readOnly: false}, {body: {}}, {readOnly: false, body: {}}]) {
      const p = plan(gateway, action.method.toUpperCase(), path, {action: action.name, ...fields}),
        claiming = claimants(p);
      if (claiming.length > 1) conflicts.push([gateway, action.name, claiming.map(c => c.authorizer.name)]);
      for (const c of claiming) if (c.gateway !== gateway) foreign.push([gateway, action.name, c.authorizer.name]);
    }
  }
  assert.ok(routes > 2200, 'every catalogued and supplemental route is checked (' + routes + ')');
  assert.deepEqual(conflicts, []);
  assert.deepEqual(foreign, [], 'an authorizer claims only its own provider’s routes');
  // Every authorizer's provider has an adapter, so ScopeGuard consults it for that provider's requests only.
  for (const {gateway} of authorizers) assert.ok(providerOf(gateway), gateway);
});

test('two authorizers claiming one request are refused before anything is sent', () => {
  const claimsAll = name => Object.freeze({name, stage: 'before_families', claims: () => true, authorize: () => true});
  const p = plan('linkedin_native_action', 'GET', '/rest/conversions');
  assert.throws(
    () => claimingAuthorizer(p, [claimsAll('first'), claimsAll('second')]),
    error =>
      error.code === 'READ_AUTHORIZER_CONFLICT' &&
      error.status === 500 &&
      JSON.stringify(error.details.authorizers) === '["first","second"]',
  );
  assert.equal(claimingAuthorizer(p, [claimsAll('only')]).name, 'only');
  assert.equal(claimingAuthorizer(p, []), undefined);
});

test('ScopeGuard refuses a request two authorizers claim before the families, the store or any later check', () => {
  const registry = new Registry(),
    touched = [];
  // A store that records every use. The refusal comes before anything that could read or remember a resource.
  const watched = new Proxy(
    {},
    {
      get: (_target, key) => {
        touched.push('store.' + String(key));
        return () => touched.push('store call');
      },
    },
  );
  // A LinkedIn saved-audience dependency read: no registered authorizer claims it, and its reviewed family (the
  // audience templates) authorizes it on its own, so a guard that consulted the families first would allow it.
  const p = plan('linkedin_native_action', 'GET', '/rest/adSegments/1', {action: 'AMCP_LINKEDIN_TEMPLATE_READ'}),
    connection = {
      id: 'c-linkedin',
      tenantId: 'read-authorizers',
      gateway: 'linkedin_native_action',
      accounts: ['123'],
      label: 'Synthetic',
      enabled: true,
      scopes: ['r_ads'],
    };
  assert.deepEqual(claimants(p), []);
  const plain = new ScopeGuard(registry, new Store(':memory:', Buffer.alloc(32, 9).toString('base64')));
  assert.equal(plain.authorize(p, connection), '123');
  // Two of its provider's authorizers claim it, at the stage after the families.
  const claimsAll = name =>
    Object.freeze({
      name,
      stage: 'after_families',
      claims: () => true,
      authorize: () => {
        touched.push(name);
        return true;
      },
    });
  const linkedin = providerHooks('linkedin_native_action'),
    hooks = gateway =>
      gateway === 'linkedin_native_action'
        ? {...linkedin, scope: {...linkedin.scope, authorizers: [claimsAll('first'), claimsAll('second')]}}
        : providerHooks(gateway);
  const guard = new ScopeGuard(registry, watched, hooks);
  assert.throws(
    () => guard.authorize(p, connection),
    error =>
      assertRefused(error, 'READ_AUTHORIZER_CONFLICT', {status: 500}) &&
      JSON.stringify(error.details.authorizers) === '["first","second"]' &&
      /nothing was sent/.test(error.message),
  );
  // Observing the response refuses the same way: nothing is learned from a read two authorizers claim.
  assert.throws(
    () => guard.observe(p, connection, {elements: [{id: 1}]}),
    error => assertRefused(error, 'READ_AUTHORIZER_CONFLICT', {status: 500}),
  );
  assert.deepEqual(touched, [], 'neither authorizer ran and the store was never touched');
  // The injected hooks are that guard's alone: the registry's guard still lets the family allow the request.
  assert.equal(plain.authorize(p, connection), '123');
});

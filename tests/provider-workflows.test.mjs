import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../dist/src/catalog.js';
import {auditInputRedactors} from '../dist/src/service.js';
import {
  assetUsageReader,
  nativeReadSteps,
  providerInputRedactors,
  providerWorkflow,
  providerWorkflows,
} from '../dist/src/provider-workflows.js';
import {registeredProviderHooks} from '../dist/src/provider-hooks.js';
import {redactMetaPostInput} from '../dist/src/meta-existing-posts.js';
import {redactPlaceActionInput, placeActionSafeError} from '../dist/src/google-place-action-links.js';
import {redactConnectionInput} from '../dist/src/connection-diagnostics.js';
import {snapchatScopedResource} from '../dist/src/snapchat-scope.js';
import {metaPrefix} from '../dist/src/meta-version.js';
import {ownershipReads} from '../dist/src/scope.js';
import {MirrorError} from '../dist/src/errors.js';
import {isProviderModule, providerRegistries} from '../tools/architecture-map.mjs';

// ARC-01 phase B, the service (wave 4c): MirrorService keeps every check and step of a call and a native read, and
// their order; the providers' workflows and steps are the provider workflows registry's (src/provider-workflows.ts) and
// a lapsed Snapchat observation is Snapchat's scope hook. The first test fails on the build before the move (the
// service named Snapchat, WooCommerce, Adjust and Tag Manager and imported 24 provider modules); the others pin each
// provider's step to its own requests and pass on both builds where the old build had the same functions.
const registry = new Registry();
const refusal = (code, message) => error => {
  assert.equal(error.code, code, error.message);
  if (message) assert.match(error.message, message);
  return true;
};

test('the service names no provider and imports no provider module: it consults the registries', () => {
  const source = fs.readFileSync(new URL('../src/service.ts', import.meta.url), 'utf8');
  const named = [...source.matchAll(/['"]([a-z0-9_]+)_native_action['"]/g)].map(m => m[1]);
  assert.deepEqual([...new Set(named)], ['amcp'], 'only AMCP’s own native workflow tool is named');
  for (const [, module] of source.matchAll(/from '\.\/([^']+)\.js'/g))
    assert.ok(
      !isProviderModule('src/' + module + '.ts') || providerRegistries.includes('src/' + module + '.ts'),
      'src/service.ts imports no provider module (' + module + ')',
    );
});

test('the workflows the service dispatches: their stages, and at most one per tool operation at each stage', () => {
  const dispatching = providerWorkflows.filter(w => w.dispatch).map(w => w.provider + ' ' + w.dispatch.stage);
  assert.deepEqual(dispatching, [
    'commerce_native_action before_connection',
    'gtm_native_action after_media',
    // Package r25-field2-access, B3: Tag Manager's account listing and container lookup, beside its diagnostics (disjoint claims).
    'gtm_native_action after_media',
    'ga4_native_action before_connection',
    'google_search_console_native_action before_connection',
    'google_business_native_action before_connection',
    'adjust_native_action before_connection',
    'meta_native_action after_connection',
    'meta_native_action after_connection',
  ]);
  for (const workflow of providerWorkflows.filter(w => w.dispatch)) assert.ok(Object.isFrozen(workflow.dispatch));
  for (const tool of [...registry.tools.values()].filter(t => t.mode === 'delegated'))
    for (const op of tool.operations ?? [])
      for (const action of [...(op.argumentsSchema.properties?.action?.enum ?? []), undefined])
        for (const stage of ['before_connection', 'after_connection', 'after_media'])
          assert.ok(
            providerWorkflows.filter(
              w => w.tool === tool.name && w.dispatch?.stage === stage && w.dispatch.claims(op.operation, action),
            ).length <= 1,
            tool.name + ' ' + op.operation + ' ' + action,
          );
  // Each answers its own tool only.
  assert.ok(providerWorkflow('before_connection', 'commerce_native_action', 'woocommerce_list_stores'));
  assert.equal(providerWorkflow('before_connection', 'gtm_native_action', 'woocommerce_list_stores'), undefined);
  assert.ok(providerWorkflow('after_media', 'gtm_native_action', 'gtm_audit_ops'));
  assert.equal(providerWorkflow('before_connection', 'gtm_native_action', 'gtm_audit_ops'), undefined);
  // The two account-free Tag Manager reads are the second workflow of that tool and stage, and no other action of gtm_ops is (B3).
  for (const action of ['LIST_ACCOUNTS', 'LOOKUP_CONTAINER'])
    assert.ok(providerWorkflow('after_media', 'gtm_native_action', 'gtm_ops', action), action);
  for (const action of ['LIST_CONTAINERS', 'GET_ACCOUNT', 'GET_CONTAINER', undefined, 'list_accounts'])
    assert.equal(providerWorkflow('after_media', 'gtm_native_action', 'gtm_ops', action), undefined, String(action));
  assert.equal(providerWorkflow('after_media', 'ga4_native_action', 'gtm_ops', 'LIST_ACCOUNTS'), undefined);
  assert.equal(providerWorkflow('before_connection', 'gtm_native_action', 'gtm_ops', 'LIST_ACCOUNTS'), undefined);
  assert.ok(providerWorkflow('after_connection', 'amcp_native_action', 'search_ads_library'));
  assert.equal(providerWorkflow('after_connection', 'meta_native_action', 'search_ads_library'), undefined);
});

test('the audit redactors keep their order, the providers’ between the people and the connection diagnostics', () => {
  assert.deepEqual(providerInputRedactors, [redactMetaPostInput, redactPlaceActionInput]);
  assert.equal(auditInputRedactors.length, 5);
  assert.equal(auditInputRedactors[1], redactMetaPostInput);
  assert.equal(auditInputRedactors[2], redactPlaceActionInput);
  assert.equal(auditInputRedactors[3], redactConnectionInput);
});

test('the asset usage readers are the providers’, by usage kind; an inherited name is no reader', () => {
  for (const kind of ['google_image_links', 'snapchat_top_snap', 'meta_scalar_references'])
    assert.equal(typeof assetUsageReader(kind), 'function', kind);
  for (const kind of ['constructor', 'toString', 'google_video', undefined, 7])
    assert.equal(assetUsageReader(kind), undefined, String(kind));
});

test('a native read’s provider steps act on their own provider’s requests, Snapchat’s result_ids refuses the rest', () => {
  const plan = (gateway, path, method = 'GET', extra = {}) => ({
    gateway,
    action: 'x',
    method,
    path,
    query: {},
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    accountId: '1',
    evidence: 'test',
    warnings: [],
    ...extra,
  });
  assert.deepEqual(
    nativeReadSteps.wanted(plan('snapchat_native_action', '/v1/adaccounts/1/creatives'), {result_ids: ['a', 'a']}),
    {kind: 'creatives', ids: ['a']},
  );
  assert.throws(
    () => nativeReadSteps.wanted(plan('meta_native_action', '/v26.0/act_1/ads'), {result_ids: ['a']}),
    refusal('INVALID_PARAMETER', /^result_ids filters a Snapchat account list/),
  );
  assert.equal(nativeReadSteps.wanted(plan('meta_native_action', '/v26.0/act_1/ads'), {}), undefined);
  // X's audience estimate is one complete read with its deadline; another gateway's plan passes unchanged.
  const estimate = plan('x_ads_native_action', '/12/accounts/abc/audience_estimate', 'POST', {
    accountId: 'abc',
    body: {targeting_criteria: [{targeting_type: 'LOCATION', targeting_value: 'x'}]},
  });
  assert.throws(
    () => nativeReadSteps.prepare(estimate, {aggregate_pages: true}),
    error =>
      ['INVALID_X_AUDIENCE_ESTIMATE', 'INVALID_X_AUDIENCE_ESTIMATE_REQUEST', 'INVALID_ARGUMENT'].includes(error.code),
  );
  const meta = plan('meta_native_action', '/v26.0/act_1/campaigns');
  assert.equal(nativeReadSteps.prepare(meta, {aggregate_pages: true}), meta);
  nativeReadSteps.admitted(meta, {aggregate_pages: true});
  assert.equal(nativeReadSteps.scoped(meta, 'other'), meta);
  assert.equal(
    nativeReadSteps.first(meta, async () => ({})),
    undefined,
  );
  assert.equal(
    nativeReadSteps.own(meta, async () => ({}), {}, 'c'),
    undefined,
  );
  // Only X's estimate reads must answer 200.
  nativeReadSteps.received(meta, {}, 201, '1');
  assert.throws(
    () =>
      nativeReadSteps.received(
        plan('x_ads_native_action', '/12/accounts/abc/audience_estimate', 'POST'),
        {},
        201,
        'abc',
      ),
    refusal('X_AUDIENCE_RESPONSE_INVALID'),
  );
  assert.equal(nativeReadSteps.page(meta, {status: 200, data: {data: []}, headers: {}}), undefined);
  const error = new MirrorError('CODE', 'Message.');
  assert.equal(nativeReadSteps.safeError(meta, error), error);
  const place = plan('google_business_native_action', '/v1/placeActionTypeMetadata', 'GET', {
    action: 'gmb_engagement_ops/LIST_PLACE_ACTION_TYPE_METADATA',
    accountId: undefined,
  });
  assert.equal(nativeReadSteps.scoped(place, 'locations/4').accountId, 'locations/4');
  assert.deepEqual(nativeReadSteps.safeError(place, error), placeActionSafeError(error));
});

// r25-fr-window (the lead, 2026-11-27: re-measure this pin with its reason, do not loosen it). A provider declares `scope.lapsedResource` for two uses. MirrorService renews
// through it, from the account's list narrowed to one ID, and only Snapchat's refusals name such a list (`result_ids`). A verification counts through it what its own review wrote as
// owned for the rest of its call, and writes nothing (src/write-verification.ts); Meta declares it for that alone: its refusals name no list narrowed to one ID, so only its own
// lists and creates renew a Meta row. Every other provider declares none, as before.
test('Snapchat renews a lapsed observation of its scoped entities, a Meta verification renews its own target, and no other provider declares one', () => {
  const declared = registeredProviderHooks.filter(h => h.scope?.lapsedResource).map(h => h.gateway);
  assert.deepEqual(declared, ['meta_native_action', 'snapchat_native_action']);
  const snapchat = registeredProviderHooks.find(h => h.gateway === 'snapchat_native_action');
  for (const path of ['/v1/campaigns/1', '/v1/adsquads/2', '/v1/media/3', '/v1/adaccounts/1/campaigns'])
    assert.equal(snapchat.scope.lapsedResource(path), snapchatScopedResource(path), path);
  // Meta's hook names the node of a path and nothing else: an account's own path is no resource a verification renews.
  const meta = registeredProviderHooks.find(h => h.gateway === 'meta_native_action');
  for (const [path, resource] of [
    [metaPrefix + '555', '555'],
    [metaPrefix + '555/ads', '555'],
    [metaPrefix + 'act_1/ads', undefined],
    [metaPrefix + 'me', undefined],
    ['/v1/campaigns/1', undefined],
  ])
    assert.equal(meta.scope.lapsedResource(path), resource, path);
  // No ownership refusal of Meta names a call narrowed to one ID, so MirrorService's renewal stays Snapchat's alone.
  for (const [path, template] of [
    [metaPrefix + '555', metaPrefix + '{ad_set_id}'],
    [metaPrefix + '555/ads', undefined],
    [metaPrefix + '555', metaPrefix + '{pixel_id}'],
  ])
    assert.ok(
      ownershipReads('meta_native_action', path, '1', 'c', template).every(r => r.arguments.result_ids === undefined),
      path,
    );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {MirrorError} from '../dist/src/errors.js';
import {providerHooks, registeredProviderHooks} from '../dist/src/provider-hooks.js';
import {providerAdapters, providerOf, reviewedWriteGateways} from '../dist/src/provider-adapters.js';
import {assertWriteShape, writeContractGateways} from '../dist/src/write-shape.js';
import {validateState} from '../dist/src/write-state.js';
import {isProviderModule, providerRegistries} from '../tools/architecture-map.mjs';

// ARC-01 phase B, the gateway checks: the write-shape stage (src/write-shape.ts) and the state stage
// (src/write-state.ts) named each provider where its own rules ran. Those rules are now its adapter's
// (`checks`, src/<provider>-adapter.ts); the stages keep every generic rule, their order and their refusals, and ask
// the provider at the points they named it. Reddit's write contract and state check stay in the stages (their module
// reads pages through src/pagination.ts, which consults the hooks), and so do Meta's first write checks
// (tests/meta-version.test.mjs reads every string literal of a Meta module as a name AMCP may send).

const plan = (gateway, method, path, fields = {}) => ({
  gateway,
  action: 'native',
  method,
  path,
  query: {},
  headers: {},
  body: {},
  readOnly: false,
  destructive: false,
  requiresConfirmation: true,
  accountId: '123',
  evidence: 'TEST',
  warnings: [],
  ...fields,
});
const read = (gateway, path, fields = {}) => plan(gateway, 'GET', path, {readOnly: true, body: undefined, ...fields});
const refusal = (run, code, message) => {
  try {
    run();
  } catch (error) {
    if (!(error instanceof MirrorError)) throw error;
    assert.equal(error.code, code, error.message);
    if (message) assert.match(error.message, message);
    return;
  }
  assert.fail('expected ' + code + ', but the check accepted the request');
};
const declared = hooks => {
  const checks = hooks?.checks ?? {};
  return [
    ...['request', 'contract', 'routeWrite'].filter(k => checks[k]),
    ...Object.keys(checks.shape ?? {}).map(k => 'shape.' + k),
    ...Object.keys(checks.state ?? {}).map(k => 'state.' + k),
  ];
};

test('the write stages name only their documented remainders and import no other provider module', () => {
  const facts = file => {
    const source = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    return {
      literals: [...new Set([...source.matchAll(/['"]([a-z0-9_]+_native_action)['"]/g)].map(m => m[1]))].sort(),
      imports: [...source.matchAll(/from '\.\/([^']+)\.js'/g)]
        .map(m => 'src/' + m[1] + '.ts')
        .filter(f => isProviderModule(f) && !providerRegistries.includes(f)),
    };
  };
  assert.deepEqual(facts('src/write-shape.ts'), {
    literals: ['meta_native_action', 'reddit_native_action'],
    imports: ['src/reddit-writes.ts'],
  });
  assert.deepEqual(facts('src/write-state.ts'), {
    literals: ['reddit_native_action'],
    imports: ['src/reddit-writes.ts'],
  });
});

test('the reviewed write gateways are the registry’s, in the review’s order, and each declares its own checks', () => {
  assert.deepEqual([...writeContractGateways], [...reviewedWriteGateways]);
  assert.equal(new Set(reviewedWriteGateways).size, reviewedWriteGateways.length);
  for (const gateway of reviewedWriteGateways) assert.ok(providerOf(gateway), gateway + ' has an adapter');
  assert.deepEqual(Object.fromEntries(reviewedWriteGateways.map(g => [g, declared(providerHooks(g))])), {
    meta_native_action: ['request', 'shape.after', 'state.target'],
    tiktok_native_action: ['shape.after', 'state.complete', 'state.target'],
    snapchat_native_action: ['shape.before', 'shape.after', 'state.target'],
    google_ads_native_action: ['request', 'shape.after', 'state.envelope', 'state.target'],
    google_business_native_action: [],
    linkedin_native_action: ['shape.afterQuery', 'shape.after', 'state.target'],
    x_ads_native_action: ['shape.after', 'state.target'],
    dv360_native_action: ['shape.queryParameter', 'shape.after', 'state.target'],
    // Its write contract and state check stay in the stages (see above).
    reddit_native_action: [],
    criteo_native_action: [],
    microsoft_ads_native_action: ['contract', 'state.contract', 'state.ownTarget', 'state.target'],
    ga4_native_action: ['routeWrite', 'state.settled', 'state.envelope', 'state.ownTarget', 'state.target'],
    gtm_native_action: ['routeWrite', 'shape.queryParameter', 'state.settled', 'state.ownTarget', 'state.target'],
    google_search_console_native_action: [
      'routeWrite',
      'state.settled',
      'state.envelope',
      'state.ownTarget',
      'state.target',
    ],
    apple_ads_native_action: ['routeWrite', 'state.settled', 'state.ownTarget', 'state.target'],
  });
  // A provider without reviewed writes has no checks, and every declared check is frozen.
  for (const hooks of registeredProviderHooks) {
    if (!writeContractGateways.has(hooks.gateway)) assert.equal(hooks.checks, undefined, hooks.gateway);
    for (const part of [hooks.checks, hooks.checks?.shape, hooks.checks?.state])
      if (part) assert.ok(Object.isFrozen(part), hooks.gateway);
  }
  // A state check that owns its targets has a target check.
  for (const hooks of registeredProviderHooks)
    if (hooks.checks?.state?.ownTarget) assert.equal(typeof hooks.checks.state.target, 'function', hooks.gateway);
  // Only Meta's writes take execution_options, whose validate-only values a reviewed write refuses.
  assert.deepEqual(
    providerAdapters.filter(a => a.executionOptions).map(a => a.gateway),
    ['meta_native_action'],
  );
  refusal(
    () =>
      assertWriteShape(
        plan('meta_native_action', 'POST', '/v26.0/987', {
          body: {status: 'PAUSED', execution_options: ['validate_only']},
        }),
      ),
    'WRITE_CONTRACT_UNAVAILABLE',
    /Remove validate_only from execution_options/,
  );
  refusal(
    () => assertWriteShape(plan('commerce_native_action', 'POST', '/v1/anything')),
    'WRITE_CONTRACT_UNAVAILABLE',
    /no reviewed mutation contract/,
  );
});

test('each provider applies the stage’s paused-creation rule to its own new serving entities', () => {
  const asked = (gateway, method, path, body) => {
    const calls = [];
    providerHooks(gateway).checks.shape.after(plan(gateway, method, path, {body}), body, (record, key, values) =>
      calls.push([key, values]),
    );
    return calls;
  };
  assert.deepEqual(asked('meta_native_action', 'POST', '/v26.0/act_123/campaigns', {}), [['status', ['PAUSED']]]);
  assert.deepEqual(asked('meta_native_action', 'POST', '/v26.0/987', {}), []);
  assert.deepEqual(asked('tiktok_native_action', 'POST', '/v1.3/campaign/create/', {}), [
    ['operation_status', ['DISABLE']],
  ]);
  assert.deepEqual(asked('snapchat_native_action', 'POST', '/v1/adaccounts/123/campaigns', {campaigns: [{}, {}]}), [
    ['status', ['PAUSED']],
    ['status', ['PAUSED']],
  ]);
  assert.deepEqual(asked('x_ads_native_action', 'POST', '/12/accounts/123/line_items', {}), [
    ['entity_status', ['PAUSED']],
  ]);
  assert.deepEqual(asked('linkedin_native_action', 'POST', '/rest/adAccounts/123/adCampaigns', {}), [
    ['status', ['PAUSED', 'DRAFT']],
  ]);
  assert.deepEqual(asked('linkedin_native_action', 'POST', '/rest/adAccounts/123/creatives', {}), [
    ['intendedStatus', ['PAUSED', 'DRAFT']],
  ]);
  assert.deepEqual(asked('dv360_native_action', 'POST', '/v4/advertisers/123/lineItems', {}), [
    ['entityStatus', ['ENTITY_STATUS_PAUSED', 'ENTITY_STATUS_DRAFT']],
  ]);
  assert.deepEqual(
    asked('google_ads_native_action', 'POST', '/v23/customers/123/campaigns:mutate', {operations: [{create: {}}]}),
    [['status', ['PAUSED']]],
  );
  assert.deepEqual(
    asked('google_ads_native_action', 'POST', '/v23/customers/123/adGroups:mutate', {operations: [{create: {}}]}),
    [['status', ['PAUSED', 'ENABLED']]],
  );
  // The rule itself is the stage's: through it, an active creation is refused.
  const snapchat = (body, fields = {}) =>
    plan('snapchat_native_action', 'POST', '/v1/adaccounts/123/campaigns', {body, ...fields});
  assert.doesNotThrow(() => assertWriteShape(snapchat({campaigns: [{name: 'Launch', status: 'PAUSED'}]})));
  refusal(
    () => assertWriteShape(snapchat({campaigns: [{name: 'Launch', status: 'ACTIVE'}]})),
    'PAUSED_CREATION_REQUIRED',
  );
});

test('the generic write checks stay the stage’s, before the provider’s own checks after them', () => {
  assert.equal(providerHooks('dv360_native_action').checks.shape.queryParameter, 'updateMask');
  assert.equal(providerHooks('gtm_native_action').checks.shape.queryParameter, 'fingerprint');
  const snapchat = fields =>
    plan('snapchat_native_action', 'POST', '/v1/adaccounts/123/campaigns', {
      body: {campaigns: [{name: 'Launch', status: 'ACTIVE'}]},
      ...fields,
    });
  // Another provider's concurrency parameter is no Snapchat parameter; the query check precedes the paused rule.
  refusal(
    () => assertWriteShape(snapchat({query: {updateMask: 'name'}})),
    'WRITE_CONTRACT_UNAVAILABLE',
    /body fields and qualified concurrency parameters only/,
  );
  refusal(
    () => assertWriteShape(snapchat({body: {campaigns: [{name: 'Launch', status: 'ACTIVE'}], adbatch: []}})),
    'WRITE_CONTRACT_UNAVAILABLE',
    /Batch and method-tunneled writes/,
  );
  // LinkedIn's patch rule runs after the query check, Google's operations rule after the method checks.
  refusal(
    () =>
      assertWriteShape(
        plan('linkedin_native_action', 'POST', '/rest/adAccounts/123/adCampaigns/456', {query: {fields: 'id'}}),
      ),
    'WRITE_CONTRACT_UNAVAILABLE',
    /body fields and qualified concurrency parameters only/,
  );
  refusal(
    () =>
      providerHooks('linkedin_native_action').checks.shape.afterQuery(
        plan('linkedin_native_action', 'POST', '/rest/adAccounts/123/adCampaigns/456'),
        {},
      ),
    'WRITE_CONTRACT_UNAVAILABLE',
    /PARTIAL_UPDATE/,
  );
  refusal(
    () =>
      providerHooks('google_ads_native_action').checks.shape.after(
        plan('google_ads_native_action', 'POST', '/v23/customers/123/campaigns:mutate'),
        {operations: [{create: {status: 'PAUSED'}}], partial_failure: true},
        () => undefined,
      ),
    'WRITE_CONTRACT_UNAVAILABLE',
    /partial_failure must be false/,
  );
});

test('the state stage asks each provider for its envelope, completeness and exact targets', () => {
  const ok = data => ({status: 200, headers: {}, data});
  // Meta: the node read's ID, and a status asked for.
  const meta = read('meta_native_action', '/v26.0/987', {query: {fields: 'id,status'}});
  assert.doesNotThrow(() => validateState(meta, ok({id: '987', status: 'PAUSED'})));
  refusal(() => validateState(meta, ok({id: '988', status: 'PAUSED'})), 'STATE_TARGET_MISMATCH');
  refusal(() => validateState(meta, ok({id: '987'})), 'STATE_READ_FAILED', /requested target status/);
  // X and DV360 name their target under their own fields.
  assert.doesNotThrow(() =>
    validateState(read('x_ads_native_action', '/12/accounts/123/campaigns/c1'), ok({data: {id: 'c1'}})),
  );
  refusal(
    () => validateState(read('x_ads_native_action', '/12/accounts/123/campaigns/c1'), ok({data: {id: 'c2'}})),
    'STATE_TARGET_MISMATCH',
  );
  const dv360 = read('dv360_native_action', '/v4/advertisers/123/campaigns/77');
  assert.doesNotThrow(() => validateState(dv360, ok({campaignId: '77'})));
  refusal(() => validateState(dv360, ok({campaignId: '78'})), 'STATE_TARGET_MISMATCH');
  // The generic checks still come first: a read that says it has more is incomplete whatever the provider.
  refusal(() => validateState(meta, ok({id: '987', status: 'PAUSED', has_more: true})), 'INCOMPLETE_STATE');
  // A read no provider check covers has no response contract.
  refusal(
    () => validateState(read('criteo_native_action', '/2025-01/unmodelled/1'), ok({data: {id: '1'}})),
    'STATE_READ_FAILED',
    /No response contract/,
  );

  // The envelopes: documented values set aside for the success check, the result itself otherwise.
  const sitemap = read('google_search_console_native_action', '/webmasters/v3/sites/x/sitemaps/y'),
    envelope = gateway => providerHooks(gateway).checks.state.envelope;
  assert.equal(
    envelope('google_search_console_native_action')(sitemap, ok({errors: '3'}), {errors: '3'}).data.errors,
    0,
  );
  refusal(
    () => envelope('google_search_console_native_action')(sitemap, ok({errors: -1}), {errors: -1}),
    'STATE_READ_FAILED',
    /nonnegative integers/,
  );
  const site = read('google_search_console_native_action', '/webmasters/v3/sites/x'),
    plain = ok({siteUrl: 'x'});
  assert.equal(envelope('google_search_console_native_action')(site, plain, plain.data), plain);
  const job = read('ga4_native_action', '/v1alpha/properties/123/audienceExports/9'),
    failed = {state: 'FAILED', errorMessage: 'quota'};
  assert.deepEqual(envelope('ga4_native_action')(job, ok(failed), failed).data, {state: 'FAILED'});
  assert.equal(envelope('ga4_native_action')(job, plain, plain.data), plain);
  const optional = plan('google_ads_native_action', 'POST', '/v23/customers/123/googleAds:search', {
    readOnly: true,
    googleState: {allowMissing: true, resource: 'campaign_asset', names: []},
  });
  assert.deepEqual(envelope('google_ads_native_action')(optional, ok({}), {}).data, {results: []});
  const required = {...optional, googleState: undefined};
  assert.equal(envelope('google_ads_native_action')(required, ok({}), {}).status, 200);
  assert.equal(envelope('google_ads_native_action')(required, plain, plain.data), plain);

  // A documented result settles the read: a measurement resource's 404, Tag Manager's status read.
  const settled = gateway => providerHooks(gateway).checks.state.settled;
  for (const gateway of ['ga4_native_action', 'gtm_native_action', 'google_search_console_native_action'])
    assert.equal(settled(gateway)(read(gateway, '/x'), ok({})), false, gateway);
  assert.equal(settled('apple_ads_native_action')(read('apple_ads_native_action', '/x'), ok({})), false);
});

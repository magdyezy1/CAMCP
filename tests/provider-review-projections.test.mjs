import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../dist/src/catalog.js';
import {providerHooks, registeredProviderHooks} from '../dist/src/provider-hooks.js';
import {normalizeSnapshot} from '../dist/src/review-state.js';
import {
  entity,
  googleValueVerificationVersion,
  verificationContractVersion,
  verificationReads,
} from '../dist/src/verification-reads.js';
import {isProviderModule, providerRegistries} from '../tools/architecture-map.mjs';

// ARC-01 phase B, the review's projections: the state stage (src/review-state.ts) and the verification plan
// (src/verification-reads.ts) named each provider where they projected its reads: the state a review keeps of a read
// no family projects, the reads that show a write no family verifies took effect, and what each such read shows.
// Those projections are now each provider adapter's (`review`, src/<provider>-adapter.ts); the stages keep the
// families first, the normalization, the empty verification of a DELETE and every comparison.

const registry = new Registry();
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
const read = (gateway, path, fields = {}) =>
  plan(gateway, 'GET', path, {readOnly: true, body: undefined, requiresConfirmation: false, ...fields});
const declared = hooks => Object.keys(hooks?.review ?? {});

test('the review stages name no provider and import no provider module', () => {
  for (const file of ['src/review-state.ts', 'src/verification-reads.ts']) {
    const source = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /['"][a-z0-9_]+_native_action['"]/, file);
    const providerImports = [...source.matchAll(/from '\.\/([^']+)\.js'/g)]
      .map(m => 'src/' + m[1] + '.ts')
      .filter(f => isProviderModule(f) && !providerRegistries.includes(f));
    assert.deepEqual(providerImports, [], file);
  }
});

test('each provider declares its own projections, frozen', () => {
  assert.deepEqual(
    Object.fromEntries(registeredProviderHooks.filter(h => h.review).map(h => [h.gateway, declared(h)])),
    {
      google_ads_native_action: ['snapshot', 'verification', 'observed', 'verificationVersion'],
      meta_native_action: ['verification'],
      tiktok_native_action: ['snapshot', 'verification', 'observed'],
      snapchat_native_action: ['snapshot', 'verification', 'observed'],
      linkedin_native_action: ['verificationHeaders', 'verification'],
      x_ads_native_action: ['snapshot', 'verification', 'observed'],
      microsoft_ads_native_action: ['snapshot', 'observed'],
      apple_ads_native_action: ['snapshot', 'observed'],
      reddit_native_action: ['snapshot', 'verification', 'observed'],
      dv360_native_action: ['verification'],
      gtm_native_action: ['snapshot'],
      google_search_console_native_action: ['snapshot'],
    },
  );
  for (const hooks of registeredProviderHooks)
    if (hooks.review) assert.ok(Object.isFrozen(hooks.review), hooks.gateway);
});

test('a review keeps the state each provider projects, and a read without a projection whole', () => {
  // X and Reddit keep a response's records, not its request echo.
  for (const gateway of ['x_ads_native_action', 'reddit_native_action'])
    assert.deepEqual(normalizeSnapshot(read(gateway, '/x/1'), {data: {id: '1', name: 'A'}, request: {params: {}}}), {
      data: {id: '1', name: 'A'},
    });
  // Meta has no projection: the read is kept whole, before the shared normalization.
  assert.deepEqual(normalizeSnapshot(read('meta_native_action', '/v26.0/987'), {id: '987', name: 'A'}), {
    id: '987',
    name: 'A',
  });
  // Apple's status observations are not advertiser edits; a shared budget's accounts are kept in one order.
  assert.deepEqual(
    normalizeSnapshot(read('apple_ads_native_action', '/v1/shared-budgets/5'), {
      result: {id: 5, displayStatus: 'RUNNING', adAccountIds: ['9', '10', '2']},
    }),
    {result: {id: 5, adAccountIds: ['10', '2', '9']}},
  );
  // A sitemap's crawl and processing fields are not a submission change; a site read is kept whole.
  assert.deepEqual(
    normalizeSnapshot(read('google_search_console_native_action', '/webmasters/v3/sites/s/sitemaps/m'), {
      path: 'm',
      lastSubmitted: 'then',
      isPending: true,
      errors: '2',
    }),
    {path: 'm', lastSubmitted: 'then'},
  );
  // Snapchat keeps each row's record, an ad account only the fields a write under it depends on.
  assert.deepEqual(
    normalizeSnapshot(read('snapchat_native_action', '/v1/adaccounts/123'), {
      request_status: 'SUCCESS',
      adaccounts: [{sub_request_status: 'SUCCESS', adaccount: {id: '123', currency: 'USD', funding_source_ids: ['f']}}],
    }),
    {adaccounts: [{adaccount: {id: '123', currency: 'USD'}}]},
  );
  // Google keeps each requested resource once, sorted; a missing or duplicate identity, or another resource, refuses.
  const google = names =>
    read('google_ads_native_action', '/v23/customers/123/googleAds:search', {
      method: 'POST',
      body: {
        query:
          "SELECT campaign.resource_name, campaign.status FROM campaign WHERE campaign.resource_name IN ('customers/123/campaigns/1', 'customers/123/campaigns/2')",
      },
      ...names,
    });
  const row = id => ({campaign: {resourceName: 'customers/123/campaigns/' + id, status: 'PAUSED'}});
  assert.deepEqual(normalizeSnapshot(google(), {results: [row(2), row(1)], fieldMask: 'campaign.status'}), {
    results: [row(1), row(2)],
  });
  assert.throws(() => normalizeSnapshot(google(), {results: [row(1), row(1)]}), {code: 'STATE_RESOURCE_INVALID'});
  assert.throws(() => normalizeSnapshot(google(), {results: [row(1), row(3)]}), {code: 'STATE_RESOURCE_MISMATCH'});
});

test('verification reads are each provider’s, built the stage’s way; DELETE and providers without them read nothing', () => {
  const linkedin = plan('linkedin_native_action', 'POST', '/rest/adAccounts/123/adCampaigns', {
    headers: {'LinkedIn-Version': '202609', 'X-Restli-Protocol-Version': '2.0.0', 'X-RestLi-Method': 'CREATE'},
    body: {name: 'Launch', status: 'PAUSED'},
  });
  const [created] = verificationReads(linkedin, {status: 201, created_id: '456', data: {}}, registry);
  assert.equal(created.read.path, '/rest/adAccounts/123/adCampaigns/456');
  assert.equal(created.read.action, 'AMCP_VERIFY_READ');
  assert.equal(created.read.readOnly, true);
  // Only the versioning headers travel; the method header of the write does not.
  assert.deepEqual(created.read.headers, {'LinkedIn-Version': '202609', 'X-Restli-Protocol-Version': '2.0.0'});
  assert.deepEqual(created.expected, {name: 'Launch', status: 'PAUSED'});
  // Another provider's verification read carries no headers.
  const [node] = verificationReads(
    plan('meta_native_action', 'POST', '/v26.0/987', {
      headers: {'X-Custom': 'x'},
      body: {status: 'PAUSED', execution_options: ['include_recommendations']},
    }),
    {status: 200, data: {success: true}},
    registry,
  );
  assert.deepEqual(node.read.headers, {});
  assert.deepEqual(node.expected, {status: 'PAUSED'});
  assert.equal(node.read.query.fields, 'id,status');
  const [reddit] = verificationReads(
    plan('reddit_native_action', 'POST', '/api/v3/ad_accounts/123/campaigns', {body: {data: {name: 'Launch'}}}),
    {status: 200, data: {data: {id: 'c9'}}},
    registry,
  );
  assert.equal(reddit.read.path, '/api/v3/campaigns/c9');
  assert.deepEqual(reddit.expected, {name: 'Launch'});
  assert.deepEqual(
    verificationReads(plan('linkedin_native_action', 'DELETE', '/rest/adAccounts/123/adCampaigns/456'), {}, registry),
    [],
  );
  assert.deepEqual(
    verificationReads(plan('criteo_native_action', 'POST', '/2025-01/unmodelled'), {data: {id: '1'}}, registry),
    [],
  );
});

test('a verification read shows what its provider unwraps; an absent resource and an unprojected read as they are', () => {
  assert.deepEqual(entity(read('x_ads_native_action', '/12/accounts/123/campaigns/c1'), {data: {id: 'c1'}}), {
    id: 'c1',
  });
  const absent = {amcp_absent: true, path: '/x'};
  assert.equal(entity(read('x_ads_native_action', '/12/accounts/123/campaigns/c1'), absent), absent);
  const meta = {id: '987', status: 'PAUSED'};
  assert.equal(entity(read('meta_native_action', '/v26.0/987'), meta), meta);
  // A Google removal reads as REMOVED once its state read finds nothing.
  assert.deepEqual(
    entity(
      read('google_ads_native_action', '/v23/customers/123/googleAds:search', {
        googleState: {
          resource: 'campaign',
          names: ['customers/123/campaigns/1'],
          allowMissing: true,
          removedAsAbsent: true,
        },
      }),
      {results: []},
    ),
    {status: 'REMOVED'},
  );
  assert.deepEqual(
    entity(read('apple_ads_native_action', '/v1/campaigns/5', {action: 'AMCP_STATE_OPTIONAL'}), {
      result: {deleted: true},
    }),
    {amcp_absent: true, path: '/v1/campaigns/5'},
  );
});

test('the verification cache version is the provider’s: Google’s value-bidding campaigns only', () => {
  const value = gateway =>
    plan(gateway, 'POST', '/v23/customers/123/campaigns:mutate', {
      body: {operations: [{create: {maximizeConversionValue: {targetRoas: 2}}}]},
    });
  assert.equal(googleValueVerificationVersion(value('google_ads_native_action')), 'google-campaign-value-roas-v1');
  assert.equal(verificationContractVersion(value('google_ads_native_action')), 'google-campaign-value-roas-v1');
  assert.equal(googleValueVerificationVersion(value('meta_native_action')), undefined);
  assert.equal(
    googleValueVerificationVersion(
      plan('google_ads_native_action', 'POST', '/v23/customers/123/campaigns:mutate', {
        body: {operations: [{create: {manualCpc: {}}}]},
      }),
    ),
    undefined,
  );
});

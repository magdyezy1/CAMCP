import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {ScopeGuard} from '../dist/src/scope.js';
import {accountKind} from '../dist/src/account-metadata.js';
import {providerAdapters, providerOf} from '../dist/src/provider-adapters.js';
import {assertRefused} from './helpers/assert-refused.mjs';

// ARC-01 phase B, the account model: where a request names an account is a fact of each provider's adapter
// (src/provider-adapters.ts); ScopeGuard (src/scope.ts) still walks every request and compares each place against the
// bound account before any authorizer runs. These facts held as tables inside scope.ts and account-metadata.ts before.

const registry = new Registry(),
  store = new Store(':memory:', Buffer.alloc(32, 7).toString('base64'));
const guard = new ScopeGuard(registry, store);

/** The account facts as data: field lists sorted, patterns as their source text. */
const facts = adapter => {
  const m = adapter.account;
  if (!m) return undefined;
  return Object.fromEntries(
    Object.entries({
      normalizes: m.normalize ? true : undefined,
      fields: m.fields ? [...m.fields].sort() : undefined,
      references: m.references ? String(m.references) : undefined,
      patchFields: m.patchFields,
      path: m.path ? String(m.path) : undefined,
      kind: m.kind,
    }).filter(([, v]) => v !== undefined),
  );
};

test('the account model holds exactly the account fields, references, paths and kinds scope.ts and account-metadata.ts held', () => {
  // A change here changes what ScopeGuard compares: it must be deliberate and reviewed with scope.ts.
  assert.deepEqual(Object.fromEntries(providerAdapters.filter(a => a.account).map(a => [a.gateway, facts(a)])), {
    google_ads_native_action: {
      normalizes: true,
      fields: ['customerId', 'customer_id'],
      references: String(/\bcustomers\/([^/:\s'"),]+)/g),
      path: String(/\/customers\/([^/:]+)/),
    },
    google_business_native_action: {kind: 'business_profile'},
    meta_native_action: {
      normalizes: true,
      fields: ['account_id', 'ad_account_id'],
      path: String(/^\/v[^/]+\/act_([^/]+)/),
    },
    tiktok_native_action: {fields: ['advertiser_id', 'advertiser_ids']},
    snapchat_native_action: {
      fields: ['ad_account_id', 'ad_account_ids'],
      patchFields: true,
      path: String(/^\/v1\/adaccounts\/([^/]+)/),
    },
    linkedin_native_action: {
      fields: ['account_id', 'ad_account_id'],
      references: String(/urn:li:sponsoredAccount:(\d+)/g),
      path: String(/^\/rest\/(?:adAccounts|adAccountTrustPreferences)\/([^/]+)/),
    },
    x_ads_native_action: {fields: ['account_id'], path: String(/\/accounts\/([^/]+)/)},
    microsoft_ads_native_action: {fields: ['AccountId', 'AccountIds', 'CustomerAccountId']},
    apple_ads_native_action: {fields: ['account_id', 'adAccountId', 'ad_account_id']},
    reddit_native_action: {fields: ['account_id', 'ad_account_id'], path: String(/^\/api\/v3\/ad_accounts\/([^/]+)/)},
    dv360_native_action: {fields: ['advertiserId', 'advertiser_id'], path: String(/\/advertisers\/([^/:]+)/)},
    ga4_native_action: {path: String(/\/properties\/([^/:]+)/), kind: 'analytics_property'},
    // Package r25-field2-access, B4: a Tag Manager account is a number, so the route /accounts/containers:lookup names none
    // (src/provider-adapters.ts; the delegated compiler's rule is the same pattern, tests/gtm-account-path.test.mjs). Lead review
    // S3-4: anchored to the API prefix every Tag Manager route starts with, so a later /accounts/{number} inside a path whose first
    // account segment is no number is not read as the account.
    gtm_native_action: {path: String(/^\/tagmanager\/v2\/accounts\/(\d+)(?=[/:]|$)/), kind: 'tag_account'},
    google_search_console_native_action: {kind: 'search_property'},
    google_drive_native_action: {kind: 'destination'},
    google_sheets_native_action: {kind: 'destination'},
    criteo_native_action: {path: String(/\/accounts\/([^/:]+)/)},
  });
  for (const gateway of ['adjust_native_action', 'commerce_native_action', 'amazon_native_action'])
    assert.equal(providerOf(gateway).account, undefined, gateway);
  // What a bound resource is comes from the same model; an advertising account unless the provider says otherwise.
  assert.equal(accountKind('ga4_native_action'), 'analytics_property');
  assert.equal(accountKind('google_drive_native_action'), 'destination');
  assert.equal(accountKind('meta_native_action'), 'ad_account');
  assert.equal(accountKind('amcp_workspace'), 'ad_account');
  assert.equal(accountKind('constructor'), 'ad_account', 'an inherited name is no provider');
});

test('no module can change the account facts after load', () => {
  for (const adapter of providerAdapters.filter(a => a.account)) {
    const m = adapter.account;
    assert.ok(Object.isFrozen(m), adapter.id);
    if (m.fields) {
      assert.equal(typeof m.fields.add, 'undefined', adapter.id + ': the field set has no add');
      assert.equal(typeof m.fields.delete, 'undefined', adapter.id + ': the field set has no delete');
      assert.ok(Object.isFrozen(m.fields));
      assert.equal(m.fields.size, [...m.fields].length);
      for (const field of m.fields) assert.ok(m.fields.has(field));
    }
    // A reference pattern finds every reference (global); a path pattern keeps no position between requests.
    if (m.references) assert.ok(m.references.global && Object.isFrozen(m.references), adapter.id);
    if (m.path) assert.ok(!m.path.global && !m.path.sticky && Object.isFrozen(m.path), adapter.id);
  }
  assert.throws(() => {
    'use strict';
    providerOf('meta_native_action').account.fields = new Set();
  }, TypeError);
});

/** A read on a connection bound to one account. */
const plan = (gateway, fields) => ({
  gateway,
  action: 'list',
  method: 'GET',
  path: '/',
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
const connection = gateway => ({
  id: 'c-' + gateway,
  tenantId: 'account-model',
  gateway,
  accounts: ['123'],
  label: 'Synthetic',
  enabled: true,
  scopes: [],
});
const authorize = (gateway, fields) => guard.authorize(plan(gateway, fields), connection(gateway));
const mismatch = (gateway, fields, field) =>
  assert.throws(
    () => authorize(gateway, fields),
    e =>
      assertRefused(e, 'ACCOUNT_SCOPE_MISMATCH', {status: 403}) && (field === undefined || e.details.field === field),
    gateway + ' ' + JSON.stringify(fields),
  );

test('ScopeGuard compares every place the account model names with the bound account', () => {
  // Account fields at any depth of the query or body, arrays and JSON array texts included.
  mismatch('meta_native_action', {path: '/v26.0/act_123/campaigns', query: {account_id: '999'}}, 'account_id');
  mismatch('meta_native_action', {path: '/v26.0/act_123/campaigns', query: {filter: {ad_account_id: 'act_999'}}});
  mismatch('tiktok_native_action', {path: '/v1.3/campaign/get/', query: {advertiser_ids: '["123","999"]'}});
  mismatch('microsoft_ads_native_action', {path: '/x', body: {AccountIds: ['123', '999']}}, 'AccountIds');
  mismatch('apple_ads_native_action', {path: '/x', body: {nested: [{adAccountId: '999'}]}}, 'adAccountId');
  mismatch('dv360_native_action', {path: '/v4/advertisers/123/campaigns', query: {advertiserId: '999'}});
  mismatch('reddit_native_action', {path: '/api/v3/ad_accounts/123/campaigns', body: {data: {ad_account_id: '9'}}});
  // References inside any string: Google resource names and RPC paths, LinkedIn sponsored account URNs.
  mismatch('google_ads_native_action', {
    method: 'POST',
    path: '/v23/customers/123/googleAds:search',
    body: {query: "SELECT campaign.id FROM campaign WHERE campaign.resource_name = 'customers/999/campaigns/1'"},
  });
  mismatch('google_ads_native_action', {path: '/v23/customers/999:listAccessibleCustomers'}, 'path');
  mismatch('linkedin_native_action', {
    path: '/rest/adAccounts/123/adCampaigns',
    query: {search: 'urn:li:sponsoredAccount:999'},
  });
  // Snapchat JSON Patch operations that name an account field must set the bound account.
  for (const op of [
    {op: 'replace', path: '/campaign/ad_account_id', value: '999'},
    {op: 'remove', path: '/campaign/ad_account_id'},
  ])
    mismatch(
      'snapchat_native_action',
      {method: 'PATCH', readOnly: false, path: '/v1/adaccounts/123/campaigns', body: [op]},
      'account patch',
    );
  // The bound account in each of those places is in scope; a path naming it authorizes the request.
  assert.equal(
    authorize('meta_native_action', {path: '/v26.0/act_123/campaigns', query: {account_id: 'act_123'}}),
    '123',
  );
  assert.equal(authorize('snapchat_native_action', {path: '/v1/adaccounts/123/campaigns'}), '123');
  assert.equal(authorize('ga4_native_action', {path: '/v1beta/properties/123/dataStreams'}), '123');
  assert.equal(
    authorize('google_ads_native_action', {
      method: 'POST',
      path: '/v23/customers/123/googleAds:search',
      body: {query: "SELECT campaign.id FROM campaign WHERE campaign.resource_name = 'customers/123/campaigns/1'"},
    }),
    '123',
  );
  assert.equal(authorize('linkedin_native_action', {path: '/rest/adAccounts/123/adCampaigns'}), '123');
  // A path naming another account is refused where the path pattern finds it.
  mismatch('snapchat_native_action', {path: '/v1/adaccounts/999/campaigns'}, 'path');
  mismatch('x_ads_native_action', {path: '/12/accounts/999/campaigns'}, 'path');
});

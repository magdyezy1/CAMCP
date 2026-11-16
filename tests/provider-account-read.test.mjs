import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {accountCurrency, accountMetadata, accountPlan, accountTimezone} from '../dist/src/account-metadata.js';
import {readinessPlan} from '../dist/src/workspace.js';
import {registeredProviderHooks} from '../dist/src/provider-hooks.js';
import {googleAdsCustomers} from '../dist/src/google-version.js';
import {metaPrefix} from '../dist/src/meta-version.js';
import {linkedinVersion} from '../dist/src/linkedin-version.js';
import {isProviderModule, providerRegistries} from '../tools/architecture-map.mjs';

// ARC-01 phase B, the account read: src/account-metadata.ts and src/workspace.ts keep what every exact account read is
// (AMCP_READINESS, read-only, never confirmed) and every check of its result; each provider's route, its readiness read
// of a measurement resource and where its response holds the account are its adapter's (src/<provider>-adapter.ts).
// The requests below are the ones the shared switch built before the move.

const route = p => ({
  method: p.method,
  path: p.path,
  ...(p.origin ? {origin: p.origin} : {}),
  query: p.query,
  ...(p.body ? {body: p.body} : {}),
  headers: p.headers,
});
const shared = (p, gateway, id) => {
  assert.equal(p.gateway, gateway);
  assert.equal(p.accountId, id);
  assert.equal(p.action, 'AMCP_READINESS');
  assert.equal(p.readOnly, true);
  assert.equal(p.destructive, false);
  assert.equal(p.requiresConfirmation, false);
  assert.equal(p.evidence, 'AMCP exact account readiness read');
  assert.deepEqual(p.warnings, []);
};
const refusal = code => error => {
  assert.equal(error.code, code, error.message);
  return true;
};

test('the shared account read stage names no provider: it consults the adapters', () => {
  const source = fs.readFileSync(new URL('../src/account-metadata.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /['"][a-z0-9_]+_native_action['"]/, 'no gateway literal in src/account-metadata.ts');
  for (const [, module] of source.matchAll(/from '\.\/([^']+)\.js'/g))
    assert.ok(
      !isProviderModule('src/' + module + '.ts') || providerRegistries.includes('src/' + module + '.ts'),
      'src/account-metadata.ts imports no provider module (' + module + ')',
    );
  const workspace = fs.readFileSync(new URL('../src/workspace.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(workspace, /measurementReadiness/, 'readiness has no gateway list of its own');
});

test('each advertising provider’s exact account read is the route the shared switch built', () => {
  const expected = {
    meta_native_action: {
      method: 'GET',
      path: metaPrefix + 'act_123',
      query: {fields: 'id,name,account_status,currency,timezone_name'},
      headers: {},
    },
    snapchat_native_action: {method: 'GET', path: '/v1/adaccounts/123', query: {}, headers: {}},
    tiktok_native_action: {
      method: 'GET',
      path: '/v1.3/advertiser/info/',
      // r25-m1-hash (M0's "Found, not fixed" 3, L1-02): the seven fields of Q15, as every other advertiser read asks for them.
      query: {
        advertiser_ids: ['123'],
        fields: ['advertiser_id', 'name', 'status', 'role', 'currency', 'timezone', 'country'],
      },
      headers: {},
    },
    google_ads_native_action: {
      method: 'POST',
      path: googleAdsCustomers + '123/googleAds:search',
      query: {},
      body: {query: 'SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 1'},
      headers: {},
    },
    linkedin_native_action: {
      method: 'GET',
      path: '/rest/adAccounts/123',
      query: {},
      headers: {'LinkedIn-Version': linkedinVersion(), 'X-Restli-Protocol-Version': '2.0.0'},
    },
    x_ads_native_action: {method: 'GET', path: '/12/accounts/123', query: {}, headers: {}},
    dv360_native_action: {method: 'GET', path: '/v4/advertisers/123', query: {}, headers: {}},
    reddit_native_action: {method: 'GET', path: '/api/v3/ad_accounts/123', query: {}, headers: {}},
  };
  for (const [gateway, want] of Object.entries(expected)) {
    const p = accountPlan(gateway, '123');
    shared(p, gateway, '123');
    assert.deepEqual(route(p), want, gateway);
    // The keys keep the order the shared read had (a body comes last).
    assert.deepEqual(Object.keys(p).slice(0, 6), ['gateway', 'accountId', 'action', 'method', 'path', 'query']);
  }
  // Microsoft's account read is its own compiled GetAccount contract.
  const microsoft = accountPlan('microsoft_ads_native_action', '123');
  assert.equal(microsoft.action, 'GetAccount');
  assert.equal(microsoft.readOnly, true);
  assert.equal(microsoft.body.AccountId, '123');
  // A provider without one refuses, as before: readiness has resource-specific checks there.
  for (const gateway of [
    'ga4_native_action',
    'gtm_native_action',
    'google_search_console_native_action',
    'apple_ads_native_action',
    'google_business_native_action',
    'adjust_native_action',
    'google_sheets_native_action',
    'unknown_native_action',
  ])
    assert.throws(() => accountPlan(gateway, '123'), refusal('READINESS_CONTRACT_UNAVAILABLE'), gateway);
});

test('measurement and Apple resources have their own readiness reads; every other provider reads its account', () => {
  const cases = [
    ['ga4_native_action', '123', 'https://analyticsadmin.googleapis.com', '/v1beta/properties/123', {}],
    ['gtm_native_action', '123', 'https://tagmanager.googleapis.com', '/tagmanager/v2/accounts/123', {}],
    [
      'google_search_console_native_action',
      'https://example.com/',
      'https://www.googleapis.com',
      '/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F',
      {},
    ],
    ['apple_ads_native_action', '123', 'https://api.ads.apple.com', '/v1/ad-accounts/123', {}],
    [
      'google_business_native_action',
      'locations/42',
      'https://mybusinessbusinessinformation.googleapis.com',
      '/v1/locations/42',
      {readMask: 'name,title,storeCode'},
    ],
    [
      'google_business_native_action',
      '42',
      'https://mybusinessaccountmanagement.googleapis.com',
      '/v1/accounts/42',
      {},
    ],
  ];
  for (const [gateway, id, origin, path, query] of cases) {
    const p = readinessPlan(gateway, id);
    shared(p, gateway, id);
    assert.deepEqual(route(p), {method: 'GET', path, origin, query, headers: {}}, gateway + ' ' + id);
  }
  assert.throws(() => readinessPlan('google_business_native_action', 'accounts/42'), refusal('ASSET_ID_INVALID'));
  // The others read their account exactly as plan preflight and reports do.
  for (const gateway of ['meta_native_action', 'google_ads_native_action', 'linkedin_native_action'])
    assert.deepEqual(readinessPlan(gateway, '123'), accountPlan(gateway, '123'), gateway);
  // A readiness read of a provider's own comes with the check that its response names exactly the selected resource.
  for (const hooks of registeredProviderHooks)
    assert.equal(!!hooks.accountRead?.readiness, !!hooks.accountRead?.names, hooks.gateway);
  const owned = registeredProviderHooks.filter(h => h.accountRead?.readiness).map(h => h.gateway);
  assert.deepEqual(owned.sort(), [
    'apple_ads_native_action',
    'ga4_native_action',
    'google_business_native_action',
    'google_search_console_native_action',
    'gtm_native_action',
  ]);
  const names = gateway => registeredProviderHooks.find(h => h.gateway === gateway).accountRead.names;
  assert.equal(names('ga4_native_action')('123', {name: 'properties/123'}), true);
  assert.equal(names('ga4_native_action')('123', {name: 'properties/1234'}), false);
  assert.equal(names('gtm_native_action')('123', {accountId: 123}), true);
  assert.equal(
    names('google_search_console_native_action')('https://a.example/', {
      siteUrl: 'https://a.example/',
      permissionLevel: 'siteRestrictedUser',
    }),
    true,
  );
  assert.equal(
    names('google_search_console_native_action')('https://a.example/', {
      siteUrl: 'https://a.example/',
      permissionLevel: 'siteUnverifiedUser',
    }),
    false,
    'an unverified user does not read the site',
  );
  assert.equal(names('google_business_native_action')('locations/42', {name: 'locations/42'}), true);
  assert.equal(names('google_business_native_action')('42', {name: 'accounts/42'}), true);
  assert.equal(names('google_business_native_action')('42', {name: 'locations/42'}), false);
  assert.equal(names('apple_ads_native_action')('7', {result: {id: 7}}), true);
  assert.equal(names('apple_ads_native_action')('7', {id: 8}), false);
});

test('each provider’s account read response holds the account where its adapter says', () => {
  const account = {name: 'Account', currency: 'EGP', timezone: 'Africa/Cairo'};
  const responses = {
    meta_native_action: [{...account, timezone_name: 'Africa/Cairo'}, 'Africa/Cairo'],
    google_ads_native_action: [
      {results: [{customer: {currencyCode: 'EGP', timeZone: 'Africa/Cairo'}}]},
      'Africa/Cairo',
    ],
    tiktok_native_action: [{data: {list: [account]}}, 'Africa/Cairo'],
    snapchat_native_action: [{adaccounts: [{adaccount: account}]}, 'Africa/Cairo'],
    microsoft_ads_native_action: [{Account: {CurrencyCode: 'EGP', TimeZone: 'Cairo'}}, 'Cairo'],
    apple_ads_native_action: [{result: account}, 'Africa/Cairo'],
    linkedin_native_action: [account, 'Africa/Cairo'],
    reddit_native_action: [{data: account}, 'Africa/Cairo'],
  };
  for (const [gateway, [data, zone]] of Object.entries(responses)) {
    assert.equal(accountCurrency(gateway, data), 'EGP', gateway);
    assert.equal(accountTimezone(gateway, data), zone, gateway);
  }
  // The same nesting on another provider is not its account.
  assert.deepEqual(accountMetadata('reddit_native_action', {adaccounts: [{adaccount: account}]}), {
    adaccounts: [{adaccount: account}],
  });
  assert.deepEqual(accountMetadata('linkedin_native_action', {results: [{customer: account}]}), {
    results: [{customer: account}],
  });
  // A Business Profile location is named by its title, an account by accountName; nothing else is taken.
  assert.deepEqual(accountMetadata('google_business_native_action', {name: 'locations/1', title: 'Shop'}), {
    name: 'Shop',
  });
  assert.deepEqual(accountMetadata('google_business_native_action', {name: 'accounts/1', accountName: 'Biz'}), {
    name: 'Biz',
  });
  assert.deepEqual(accountMetadata('google_business_native_action', {name: 'accounts/1'}), {});
  // Arrays and non-objects hold no account.
  assert.deepEqual(accountMetadata('meta_native_action', [account]), {});
  assert.deepEqual(accountMetadata('snapchat_native_action', {adaccounts: []}), {});
  assert.deepEqual(accountMetadata('tiktok_native_action', null), {});
});

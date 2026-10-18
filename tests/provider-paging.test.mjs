import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {continuationArguments, nextPage, paginate} from '../dist/src/pagination.js';
import {providerAdapters, providerOf} from '../dist/src/provider-adapters.js';
import {providerHooks, registeredProviderHooks} from '../dist/src/provider-hooks.js';

// ARC-01 phase B, paging: src/pagination.ts keeps the loop, the merge, the page and size limits, the loop and shape
// checks and the continuation call; each provider's cursor rules are its adapter's paging hook
// (src/<provider>-adapter.ts), consulted only for that provider's requests, and its paging names are facts of the
// leaf registry. The behaviour itself is pinned by tests/pagination.test.ts, tests/native-pagination-continuation.test.ts
// and tests/tiktok-report-completion.test.mjs; these cases pin the seam.

const plan = (gateway, path, fields = {}) => ({
  gateway,
  action: 'native',
  method: 'GET',
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
const refusal = code => error => {
  assert.equal(error.code, code, error.message);
  return true;
};

test('the shared paging stage names no provider: it consults the adapters', () => {
  const source = fs.readFileSync(new URL('../src/pagination.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /['"][a-z0-9_]+_native_action['"]/, 'no gateway literal in src/pagination.ts');
  const imports = [...source.matchAll(/from '\.\/([^']+)\.js'/g)].map(m => m[1]).sort();
  assert.deepEqual(imports, ['errors', 'provider-adapters', 'provider-hooks', 'security', 'types']);
});

test('the providers with their own cursor rules, and the facts of the others', () => {
  const paged = registeredProviderHooks.filter(h => h.paging?.nextPage).map(h => h.gateway);
  assert.deepEqual(paged.sort(), [
    'apple_ads_native_action',
    'linkedin_native_action',
    'meta_native_action',
    'reddit_native_action',
    'snapchat_native_action',
    'tiktok_native_action',
    'x_ads_native_action',
  ]);
  // Only TikTok's integrated reports are collected whole.
  assert.deepEqual(
    registeredProviderHooks.filter(h => h.paging?.whole).map(h => h.gateway),
    ['tiktok_native_action'],
  );
  for (const hooks of registeredProviderHooks)
    if (hooks.paging) assert.ok(Object.isFrozen(hooks.paging), hooks.gateway + ' paging hooks are frozen');
  // Paging names are facts: Google Ads takes generic tokens as page_token, GA4 tools carry the body as `request`.
  const facts = Object.fromEntries(providerAdapters.filter(a => a.paging).map(a => [a.gateway, a.paging]));
  assert.deepEqual(facts, {
    google_ads_native_action: {tokenParameter: 'page_token'},
    ga4_native_action: {bodyArgument: 'request'},
  });
  for (const value of Object.values(facts)) assert.ok(Object.isFrozen(value));
  assert.throws(() => {
    'use strict';
    providerOf('google_ads_native_action').paging.tokenParameter = 'pageToken';
  }, TypeError);
});

test('a provider’s cursor rules apply to its own requests only; others page by the generic tokens', () => {
  // A Graph-shaped page: followed by Meta's cursor rule, not by any other provider's.
  const graph = {data: [{id: '1'}], paging: {next: 'https://graph.facebook.com/next', cursors: {after: 'a'}}};
  assert.equal(nextPage(plan('meta_native_action', '/v26.0/act_123/campaigns'), graph).query.after, 'a');
  for (const gateway of ['gtm_native_action', 'ga4_native_action', 'adjust_native_action', 'unknown_native_action'])
    assert.equal(nextPage(plan(gateway, '/v1/things'), graph), null, gateway);
  // A Snapchat next link and a Reddit next URL are followed only for their providers.
  const snap = {paging: {next_link: 'https://adsapi.snapchat.com/v1/adaccounts/123/campaigns?cursor=c2'}};
  assert.equal(nextPage(plan('snapchat_native_action', '/v1/adaccounts/123/campaigns'), snap).query.cursor, 'c2');
  assert.equal(nextPage(plan('meta_native_action', '/v1/adaccounts/123/campaigns'), snap), null);
  const reddit = {pagination: {next_url: 'https://ads-api.reddit.com/api/v3/ad_accounts/123/ads?page.token=t'}};
  assert.equal(nextPage(plan('reddit_native_action', '/api/v3/ad_accounts/123/ads'), reddit).query['page.token'], 't');
  assert.equal(nextPage(plan('x_ads_native_action', '/api/v3/ad_accounts/123/ads'), reddit), null);
  // Generic tokens take each provider's parameter name.
  const token = {nextPageToken: 't2'};
  assert.equal(nextPage(plan('google_ads_native_action', '/v23/customers/1/x'), token).query.page_token, 't2');
  assert.equal(nextPage(plan('ga4_native_action', '/v1beta/properties/1/x'), token).query.pageToken, 't2');
  assert.equal(
    nextPage(plan('google_ads_native_action', '/v23/customers/1/googleAds:search', {method: 'POST', body: {}}), token)
      .body.page_token,
    't2',
  );
  // Apple pages by offset only on its query selectors; another Apple read pages generically.
  assert.equal(nextPage(plan('apple_ads_native_action', '/api/v5/campaigns'), token).query.pageToken, 't2');
  // The request the provider is asked about is never changed: the next page is a copy.
  const original = plan('meta_native_action', '/v26.0/act_123/campaigns', {query: {fields: 'id'}});
  nextPage(original, graph);
  assert.deepEqual(original.query, {fields: 'id'});
});

test('each provider’s paging refuses a cursor that changes the request or cannot continue it', () => {
  assert.throws(
    () => nextPage(plan('meta_native_action', '/v26.0/act_123/ads'), {data: [], paging: {next: 'x'}}),
    refusal('UNKNOWN_PAGINATION'),
  );
  const campaigns = plan('snapchat_native_action', '/v1/adaccounts/123/campaigns', {query: {limit: 50}});
  assert.throws(
    () => nextPage(campaigns, {paging: {next_link: 'https://attacker.example/v1/adaccounts/123/campaigns'}}),
    refusal('UNSAFE_PAGINATION_LINK'),
  );
  assert.throws(
    () => nextPage(campaigns, {paging: {next_link: '/v1/adaccounts/123/campaigns?limit=50&ad_account_id=9'}}),
    error => error.code === 'UNSAFE_PAGINATION_LINK' && error.details.parameter === 'ad_account_id',
  );
  const ads = plan('reddit_native_action', '/api/v3/ad_accounts/123/ads', {query: {'page.size': '10'}});
  assert.throws(() => nextPage(ads, {pagination: {next_url: 'not a url'}}), refusal('UNSAFE_PAGINATION_LINK'));
  assert.throws(
    () =>
      nextPage(ads, {
        pagination: {next_url: 'https://ads-api.reddit.com/api/v3/ad_accounts/123/ads?page.size=10&page.size=10'},
      }),
    refusal('UNSAFE_PAGINATION_LINK'),
  );
  assert.throws(
    () => nextPage(ads, {pagination: {next_url: 'https://ads-api.reddit.com/api/v3/ad_accounts/123/ads?page.size=10'}}),
    refusal('UNKNOWN_PAGINATION'),
  );
  assert.throws(
    () => nextPage(plan('tiktok_native_action', '/v1.3/bc/get/'), {data: {has_more: true}}),
    refusal('UNKNOWN_PAGINATION'),
  );
  const query = plan('apple_ads_native_action', '/api/v5/campaigns/find/query', {
    method: 'POST',
    origin: 'https://api.ads.apple.com',
    body: {pagination: {offset: 0, limit: 2}},
  });
  assert.throws(() => nextPage(query, {pagination: {}}), refusal('UNKNOWN_PAGINATION'));
  const finder = plan('linkedin_native_action', '/rest/adAccounts/123/creatives', {query: {q: 'criteria'}});
  assert.throws(() => nextPage(finder, {metadata: {nextPageToken: ''}}), refusal('UNKNOWN_PAGINATION'));
  assert.throws(
    () => nextPage({...finder, query: {q: 'criteria', start: 0}}, {metadata: {nextPageToken: 'b'}}),
    refusal('UNKNOWN_PAGINATION'),
  );
  // X's cursor '0' is the end of a collection.
  assert.equal(nextPage(plan('x_ads_native_action', '/12/accounts/abc/campaigns'), {next_cursor: '0'}), null);
});

test('only a TikTok integrated report is a whole collection: started at page one and checked across pages', async () => {
  const whole = providerHooks('tiktok_native_action').paging.whole;
  const report = plan('tiktok_native_action', '/v1.3/report/integrated/get/', {
    query: {advertiser_id: '123', report_type: 'BASIC', data_level: 'AUCTION_CAMPAIGN', dimensions: ['campaign_id']},
  });
  assert.equal(whole.claims(report), true);
  assert.equal(whole.claims({...report, gateway: 'meta_native_action'}), false);
  assert.equal(whole.claims({...report, method: 'POST'}), false);
  await assert.rejects(
    paginate({...report, query: {...report.query, page: 2}}, async () => assert.fail('nothing is read'), 5),
    refusal('REPORT_INCOMPLETE'),
  );
  // The same request on another provider is no whole collection: it pages by the generic tokens.
  const generic = await paginate(
    {...report, gateway: 'gtm_native_action', query: {page: 2}},
    async () => ({rows: []}),
    5,
  );
  assert.equal(generic.pages, 1);
  // A GA4 continuation carries the native body in the tool's `request` argument; other tools in payload or body.
  const ga4 = plan('ga4_native_action', '/v1beta/properties/1:runReport', {method: 'POST', body: {limit: 10}});
  assert.deepEqual(
    continuationArguments(ga4, {...ga4, body: {limit: 10, offset: 10}}, {action: 'run', request: {limit: 10}}, false),
    {action: 'run', request: {limit: 10, offset: 10}},
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  NativeTransport,
  approvedOrigins,
  buildUrl,
  losslessReportNumbers,
  providerRetryDelay,
} from '../dist/src/transport.js';
import {classifyProviderError, providerErrorCode, providerRequestId} from '../dist/src/provider-error-taxonomy.js';
import {registeredProviderHooks} from '../dist/src/provider-hooks.js';
import {microsoftCustomerOrigin, microsoftOrigin, microsoftReportOrigin} from '../dist/src/microsoft-native.js';
import {isProviderModule, providerRegistries} from '../tools/architecture-map.mjs';
import {offerParkedProviders} from './helpers/parked-providers.mjs';

// ARC-01 phase B, the wire profile: src/transport.ts keeps the origin allowlist, the single send, attempts, deadlines,
// rate limits, cooldowns, circuits, size limits and every refusal; each provider's URL shape, headers, body encoding,
// rate keys, documented empty responses and error envelope are its adapter's wire profile (src/<provider>-adapter.ts),
// consulted only for its own requests. src/provider-error-taxonomy.ts keeps the generic error shapes. Synthetic
// fetchers only: nothing is sent anywhere.
offerParkedProviders('amazon', 'criteo');

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
const connection = (gateway, fields = {}) => ({
  id: 'c',
  tenantId: 't',
  gateway,
  accounts: ['123'],
  label: 'test',
  enabled: true,
  scopes: [],
  ...fields,
});
const refusal = code => error => {
  assert.equal(error.code, code, error.message);
  return true;
};
/** Sends one request through a transport whose fetcher records it and answers `answer`. */
async function send(p, fields = {}, credentials = {accessToken: 'synthetic-token'}, answer = {data: []}) {
  const sent = [];
  const transport = new NativeTransport(
    async (url, init) => {
      sent.push({url: new URL(String(url)), init});
      return answer instanceof Response ? answer : Response.json(answer);
    },
    async () => {},
  );
  await transport.request(p, connection(p.gateway, fields), credentials);
  return sent[0];
}

test('the transport and the error taxonomy name no provider: they consult the wire profiles', () => {
  for (const file of ['src/transport.ts', 'src/provider-error-taxonomy.ts']) {
    const source = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /['"][a-z0-9_]+_native_action['"]/, 'no gateway literal in ' + file);
    for (const [, module] of source.matchAll(/from '\.\/([^']+)\.js'/g))
      assert.ok(
        !isProviderModule('src/' + module + '.ts') || providerRegistries.includes('src/' + module + '.ts'),
        file + ' imports no provider module (' + module + ')',
      );
  }
});

test('the origin allowlist is unchanged, stays in the transport and is the only way to an origin', () => {
  // Every approved origin, per gateway, as the transport allowed them before the wire profiles.
  assert.deepEqual(
    Object.fromEntries(
      [
        'google_sheets_native_action',
        'google_drive_native_action',
        'meta_native_action',
        'tiktok_native_action',
        'snapchat_native_action',
        'google_ads_native_action',
        'linkedin_native_action',
        'x_ads_native_action',
        'dv360_native_action',
        'amazon_native_action',
        'apple_ads_native_action',
        'reddit_native_action',
        'criteo_native_action',
        'ga4_native_action',
        'gtm_native_action',
        'google_business_native_action',
        'google_search_console_native_action',
        'adjust_native_action',
        'microsoft_ads_native_action',
        'commerce_native_action',
        'constructor',
      ].map(g => [g, [...approvedOrigins(g)].sort()]),
    ),
    {
      google_sheets_native_action: ['https://sheets.googleapis.com', 'https://www.googleapis.com'],
      google_drive_native_action: ['https://www.googleapis.com'],
      meta_native_action: ['https://graph.facebook.com'],
      tiktok_native_action: ['https://business-api.tiktok.com'],
      snapchat_native_action: ['https://adsapi.snapchat.com'],
      google_ads_native_action: ['https://datamanager.googleapis.com', 'https://googleads.googleapis.com'],
      linkedin_native_action: ['https://api.linkedin.com'],
      x_ads_native_action: [
        'https://ads-api.x.com',
        'https://api.x.com',
        'https://upload.twitter.com',
        'https://upload.x.com',
      ],
      dv360_native_action: ['https://displayvideo.googleapis.com'],
      amazon_native_action: [
        'https://advertising-api-eu.amazon.com',
        'https://advertising-api-fe.amazon.com',
        'https://advertising-api.amazon.com',
      ],
      apple_ads_native_action: ['https://api.ads.apple.com', 'https://api.searchads.apple.com'],
      reddit_native_action: ['https://ads-api.reddit.com'],
      criteo_native_action: ['https://api.criteo.com'],
      ga4_native_action: ['https://analyticsadmin.googleapis.com', 'https://analyticsdata.googleapis.com'],
      gtm_native_action: ['https://tagmanager.googleapis.com'],
      google_business_native_action: [
        'https://businessprofileperformance.googleapis.com',
        'https://mybusiness.googleapis.com',
        'https://mybusinessaccountmanagement.googleapis.com',
        'https://mybusinessbusinessinformation.googleapis.com',
        'https://mybusinesslodging.googleapis.com',
        'https://mybusinessnotifications.googleapis.com',
        'https://mybusinessplaceactions.googleapis.com',
        'https://mybusinessverifications.googleapis.com',
      ],
      google_search_console_native_action: ['https://searchconsole.googleapis.com', 'https://www.googleapis.com'],
      adjust_native_action: ['https://api.adjust.com', 'https://automate.adjust.com', 'https://dash.adjust.com'],
      microsoft_ads_native_action: [
        'https://campaign.api.bingads.microsoft.com',
        'https://clientcenter.api.bingads.microsoft.com',
        'https://reporting.api.bingads.microsoft.com',
      ],
      commerce_native_action: [],
      constructor: [],
    },
  );
  // Microsoft's are the origins its contracts are compiled for.
  assert.deepEqual(
    [...approvedOrigins('microsoft_ads_native_action')].sort(),
    [microsoftOrigin, microsoftCustomerOrigin, microsoftReportOrigin].sort(),
  );
  // No wire profile names an origin: an origin of another gateway, or of none, is refused.
  for (const hooks of registeredProviderHooks)
    for (const key of Object.keys(hooks.wire ?? {}))
      assert.doesNotMatch(key, /origin/i, hooks.gateway + ' declares no origin');
  const c = connection('meta_native_action');
  assert.throws(
    () => buildUrl({...plan('meta_native_action', '/v26.0/me'), origin: 'https://api.linkedin.com'}, c),
    refusal('UNAPPROVED_UPSTREAM'),
  );
  assert.throws(
    () => buildUrl(plan('commerce_native_action', '/wp-json/wc/v3/products'), connection('commerce_native_action')),
    refusal('CONNECTOR_CONFIGURATION_REQUIRED'),
  );
  assert.throws(
    () => buildUrl(plan('constructor', '/x'), connection('constructor')),
    refusal('CONNECTOR_CONFIGURATION_REQUIRED'),
  );
  // Sandboxes: X's ads API and Microsoft's three services, nothing else.
  assert.equal(
    buildUrl(plan('x_ads_native_action', '/12/accounts/abc'), c, 'sandbox').origin,
    'https://ads-api-sandbox.x.com',
  );
  assert.equal(
    buildUrl(plan('microsoft_ads_native_action', '/Reporting/v13/x'), c, 'sandbox').origin,
    'https://campaign.api.sandbox.bingads.microsoft.com',
  );
  assert.equal(
    buildUrl({...plan('microsoft_ads_native_action', '/x'), origin: microsoftReportOrigin}, c, 'sandbox').origin,
    'https://reporting.api.sandbox.bingads.microsoft.com',
  );
  assert.throws(
    () => buildUrl(plan('meta_native_action', '/v26.0/me'), c, 'sandbox'),
    refusal('SANDBOX_ROUTE_UNQUALIFIED'),
  );
  assert.throws(
    () => buildUrl({...plan('x_ads_native_action', '/1.1/media'), origin: 'https://upload.x.com'}, c, 'sandbox'),
    refusal('SANDBOX_ROUTE_UNQUALIFIED'),
  );
});

test('each provider shapes its own URLs only: TikTok’s /open_api path, LinkedIn’s Rest.li query', () => {
  const c = connection('tiktok_native_action');
  assert.equal(
    buildUrl(plan('tiktok_native_action', '/v1.3/campaign/get/'), c).pathname,
    '/open_api/v1.3/campaign/get/',
  );
  assert.equal(
    buildUrl(plan('tiktok_native_action', '/open_api/v1.3/campaign/get/'), c).pathname,
    '/open_api/v1.3/campaign/get/',
  );
  assert.equal(buildUrl(plan('snapchat_native_action', '/v1.3/campaign/get/'), c).pathname, '/v1.3/campaign/get/');
  const query = {q: 'criteria', campaigns: ['urn:li:sponsoredCampaign:1']};
  assert.equal(
    buildUrl(plan('linkedin_native_action', '/rest/adAccounts/123/creatives', {query}), c).search,
    '?q=criteria&campaigns=List(urn%3Ali%3AsponsoredCampaign%3A1)',
  );
  assert.equal(
    buildUrl(plan('meta_native_action', '/v26.0/act_123/ads', {query}), c).search,
    '?q=criteria&campaigns=%5B%22urn%3Ali%3AsponsoredCampaign%3A1%22%5D',
  );
});

test('each provider’s headers and body encoding apply to its own requests', async () => {
  // TikTok: the access token in Access-Token; everyone else a bearer token.
  const tiktok = await send(plan('tiktok_native_action', '/v1.3/campaign/get/'));
  assert.equal(tiktok.init.headers['Access-Token'], 'synthetic-token');
  assert.equal(tiktok.init.headers.Authorization, undefined);
  const meta = await send(plan('meta_native_action', '/v26.0/act_123/campaigns'));
  assert.equal(meta.init.headers.Authorization, 'Bearer synthetic-token');
  assert.equal(meta.init.headers['Access-Token'], undefined);
  // Meta form-encodes a body; LinkedIn and Reddit send JSON; Snapchat's PATCH is a JSON Patch.
  const write = (gateway, path, body, method = 'POST') => ({...plan(gateway, path), method, readOnly: false, body});
  const form = await send(write('meta_native_action', '/v26.0/act_123/campaigns', {name: 'n', special: ['A']}));
  assert.equal(form.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(form.init.body, 'name=n&special=%5B%22A%22%5D');
  const json = await send(write('linkedin_native_action', '/rest/adAccounts/123/adCampaigns', {name: 'n'}));
  assert.equal(json.init.headers['Content-Type'], 'application/json');
  assert.equal(json.init.body, '{"name":"n"}');
  const patch = await send(
    write('snapchat_native_action', '/v1/campaigns/1', [{op: 'test', path: '/a', value: 1}], 'PATCH'),
  );
  assert.equal(patch.init.headers['Content-Type'], 'application/json-patch+json');
  const notPatch = await send(write('linkedin_native_action', '/rest/x', [{op: 'test'}], 'PATCH'));
  assert.equal(notPatch.init.headers['Content-Type'], 'application/json');
  // Google Ads sends ProtoJSON names and the manager route of the selected account.
  const google = await send(
    write('google_ads_native_action', '/v23/customers/123/campaigns:mutate', {operations: [{update_mask: 'a_b'}]}),
    {accountLoginCustomers: {123: '999-000-1111'}},
  );
  assert.equal(google.init.body, '{"operations":[{"updateMask":"aB"}]}');
  assert.equal(google.init.headers['login-customer-id'], '9990001111');
  // Reddit requires a descriptive User-Agent from the connection.
  const reddit = await send(plan('reddit_native_action', '/api/v3/me'), {userAgent: 'server:amcp:1 (test)'});
  assert.equal(reddit.init.headers['User-Agent'], 'server:amcp:1 (test)');
  const noAgent = await send(plan('meta_native_action', '/v26.0/me'), {userAgent: 'server:amcp:1 (test)'});
  assert.equal(noAgent.init.headers['User-Agent'], undefined);
  // Apple's selected account context, and X's OAuth 1.0a signature in place of the bearer token.
  const apple = await send({...plan('apple_ads_native_action', '/v1/campaigns'), origin: 'https://api.ads.apple.com'});
  assert.equal(apple.init.headers['X-AP-Context'], 'adAccountId=123;');
  const x = await send(
    plan('x_ads_native_action', '/12/accounts/abc/campaigns'),
    {},
    {
      accessToken: 'synthetic-token',
      tokenSecret: 'synthetic-secret',
      consumerKey: 'synthetic-consumer',
      consumerSecret: 'synthetic-consumer-secret',
    },
  );
  assert.match(x.init.headers.Authorization, /^OAuth oauth_consumer_key="synthetic-consumer"/);
  // Microsoft's developer token and customer headers; Amazon's client and scope (a parked provider, offered here).
  const microsoft = await send(
    plan('microsoft_ads_native_action', '/CampaignManagement/v13/Campaigns/QueryByAccountId'),
    {accountCustomers: {123: '456'}},
    {accessToken: 'synthetic-token', developerToken: 'synthetic-developer'},
  );
  assert.equal(microsoft.init.headers.DeveloperToken, 'synthetic-developer');
  assert.equal(microsoft.init.headers.CustomerAccountId, '123');
  assert.equal(microsoft.init.headers.CustomerId, '456');
  const amazon = await send(plan('amazon_native_action', '/v2/profiles'), {}, {accessToken: 't', clientId: 'client'});
  assert.equal(amazon.init.headers['Amazon-Advertising-API-ClientId'], 'client');
  assert.equal(amazon.init.headers['Amazon-Advertising-API-Scope'], '123');
});

test('each provider’s wire refusals hold, and only for its own requests', async () => {
  await assert.rejects(send(plan('reddit_native_action', '/api/v3/me')), refusal('USER_AGENT_REQUIRED'));
  await assert.rejects(
    send(plan('microsoft_ads_native_action', '/CampaignManagement/v13/x'), {accountCustomers: {123: '456'}}),
    refusal('DEVELOPER_TOKEN_REQUIRED'),
  );
  await assert.rejects(
    send(
      {...plan('microsoft_ads_native_action', '/CampaignManagement/v13/x'), accountId: undefined},
      {},
      {accessToken: 't', developerToken: 'd'},
    ),
    refusal('ACCOUNT_REQUIRED'),
  );
  await assert.rejects(send(plan('amazon_native_action', '/v2/profiles')), refusal('CLIENT_ID_REQUIRED'));
  await assert.rejects(
    send(plan('google_ads_native_action', '/v23/customers/123/campaigns'), {accountLoginCustomers: {}}),
    refusal('GOOGLE_LOGIN_CUSTOMER_UNMAPPED'),
  );
  // The same connection settings on another provider's request refuse nothing.
  await send(plan('meta_native_action', '/v26.0/me'), {accountLoginCustomers: {}});
  // Multipart uploads stay each provider's contracts.
  const upload = (format, p) =>
    new NativeTransport(
      async () => Response.json({}),
      async () => {},
    ).request(
      {...p, readOnly: false, method: 'POST', body: {}},
      connection(p.gateway),
      {accessToken: 't'},
      {field: 'file', bytes: Buffer.from('x'), filename: 'x', mime: 'image/png', format},
    );
  await assert.rejects(
    upload('related', plan('meta_native_action', '/upload/v4/advertisers/1/assets')),
    refusal('INVALID_UPLOAD'),
  );
  await assert.rejects(
    upload('fields', plan('meta_native_action', '/v1/media/abc/multipart-upload-v2', {query: {action: 'INIT'}})),
    refusal('INVALID_UPLOAD'),
  );
  await upload(
    'related',
    plan('dv360_native_action', '/upload/v4/advertisers/1/assets', {query: {uploadType: 'multipart'}}),
  );
  await upload(
    'fields',
    plan('snapchat_native_action', '/v1/media/abc/multipart-upload-v2', {query: {action: 'INIT'}}),
  );
});

test('each provider’s response shapes and rate keys are its own', async () => {
  // An unsuccessful result in a 2xx body: TikTok's non-zero code and X's errors list, the generic envelopes for all.
  const failed = (gateway, answer, credentials) =>
    send(
      plan(gateway, gateway === 'x_ads_native_action' ? '/12/accounts/abc' : '/v1.3/campaign/get/'),
      {},
      credentials,
      answer,
    );
  const xCredentials = {accessToken: 'a', tokenSecret: 'b', consumerKey: 'c', consumerSecret: 'd'};
  await assert.rejects(failed('tiktok_native_action', {code: 40001, data: {}}), refusal('PLATFORM_ERROR'));
  await failed('snapchat_native_action', {code: 40001, data: {}});
  await assert.rejects(failed('x_ads_native_action', {errors: [{code: 'X'}]}, xCredentials), refusal('PLATFORM_ERROR'));
  await failed('snapchat_native_action', {errors: [{code: 'X'}]});
  await assert.rejects(failed('snapchat_native_action', {request_status: 'ERROR'}), refusal('PLATFORM_ERROR'));
  // Documented empty writes: a LinkedIn creation named by x-restli-id, a Tag Manager delete; not another provider's.
  const empty = (gateway, method, status, headers = {}) =>
    send(
      {...plan(gateway, '/rest/adCampaigns'), method, readOnly: false, body: method === 'DELETE' ? undefined : {}},
      {},
      {accessToken: 't'},
      new Response('', {status, headers}),
    );
  await empty('linkedin_native_action', 'POST', 201, {'x-restli-id': '1'});
  await empty('gtm_native_action', 'DELETE', 200);
  await assert.rejects(empty('meta_native_action', 'DELETE', 200), refusal('UPSTREAM_RESPONSE_INVALID'));
  await assert.rejects(
    empty('snapchat_native_action', 'POST', 201, {'x-restli-id': '1'}),
    refusal('UPSTREAM_RESPONSE_INVALID'),
  );
  // Report data routes (lossless numbers, when the deployment turns them on) are each provider's.
  const on = {AMCP_REPORT_LOSSLESS_NUMBERS: 'true'};
  assert.equal(losslessReportNumbers(plan('meta_native_action', '/v26.0/act_1/insights'), on), true);
  assert.equal(losslessReportNumbers(plan('snapchat_native_action', '/v26.0/act_1/insights'), on), false);
  assert.equal(losslessReportNumbers(plan('linkedin_native_action', '/rest/adAnalytics'), on), true);
  assert.equal(losslessReportNumbers(plan('linkedin_native_action', '/rest/adAnalytics'), {}), false);
  // X's reset headers extend a 429 wait; another provider's 429 keeps Retry-After or the default.
  const reset = new Response('', {
    status: 429,
    headers: {'x-rate-limit-reset': '1000', date: new Date(900000).toUTCString()},
  });
  assert.equal(providerRetryDelay(reset, 'x_ads_native_action', 0), 100000);
  assert.equal(providerRetryDelay(reset, 'meta_native_action', 0), 30000);
  // Every wire profile is frozen, like the rest of the hooks.
  for (const hooks of registeredProviderHooks)
    if (hooks.wire) {
      assert.ok(Object.isFrozen(hooks.wire), hooks.gateway);
      if (hooks.wire.errors) assert.ok(Object.isFrozen(hooks.wire.errors), hooks.gateway);
    }
});

test('each provider’s documented error shapes are read for its own refusals only', () => {
  const headers = values => new Headers(values);
  // Request references: LinkedIn's own headers first, Meta's trace ID in its body last.
  assert.equal(
    providerRequestId('linkedin_native_action', headers({'x-li-uuid': 'li-1', 'x-request-id': 'r'}), {}),
    'li-1',
  );
  assert.equal(providerRequestId('meta_native_action', headers({'x-li-uuid': 'li-1', 'x-request-id': 'r'}), {}), 'r');
  const trace = {error: {fbtrace_id: 'AbC123'}};
  assert.equal(providerRequestId('meta_native_action', headers({}), trace), 'AbC123');
  assert.equal(providerRequestId('linkedin_native_action', headers({}), trace), undefined);
  // Provider codes: each provider's documented shape, the generic shapes otherwise.
  assert.equal(providerErrorCode('tiktok_native_action', {code: 40100}), 40100);
  assert.equal(providerErrorCode('snapchat_native_action', {error_code: 'E3002', code: 7}), 'E3002');
  assert.equal(providerErrorCode('x_ads_native_action', {errors: [{code: 'NOT_FOUND'}]}), 'NOT_FOUND');
  assert.equal(providerErrorCode('linkedin_native_action', {serviceErrorCode: 100}), 100);
  assert.equal(providerErrorCode('meta_native_action', {error: {code: 190, status: 'X'}}), 190);
  assert.equal(
    providerErrorCode('google_ads_native_action', {
      error: {
        status: 'PERMISSION_DENIED',
        details: [{errors: [{errorCode: {authorizationError: 'USER_PERMISSION_DENIED'}}]}],
      },
    }),
    'USER_PERMISSION_DENIED',
  );
  assert.equal(providerErrorCode('gtm_native_action', {error: {status: 'NOT_FOUND'}}), 'NOT_FOUND');
  assert.equal(providerErrorCode('reddit_native_action', {error_code: 'E1'}), 'E1');
  // Documented classifications: Meta's credential code, LinkedIn's 426, Business Profile's unapproved project.
  const classify = (gateway, status, body) =>
    classifyProviderError({gateway, status, headers: headers({}), body, readOnly: true});
  assert.equal(classify('meta_native_action', 400, {error: {code: 190}}).code, 'REAUTHORIZATION_REQUIRED');
  assert.equal(classify('reddit_native_action', 400, {error: {code: 190}}).documented, false);
  assert.equal(classify('linkedin_native_action', 426, {}).code, 'PROVIDER_VERSION_UNSUPPORTED');
  assert.equal(classify('meta_native_action', 426, {}).layer, 'unknown');
  const unapproved = {error: {details: [{metadata: {quota_limit_value: '0'}}]}};
  assert.equal(classify('google_business_native_action', 429, unapproved).code, 'BUSINESS_PROFILE_API_NOT_APPROVED');
  assert.equal(classify('google_ads_native_action', 429, unapproved).code, 'PLATFORM_RATE_LIMIT');
  assert.equal(classify('google_ads_native_action', 429, unapproved).documented, false);
});

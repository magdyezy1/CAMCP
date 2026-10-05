import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {googleAdsVersion} from '../../dist/src/google-version.js';
export const portfolioRefusalMessages = {
  google: 'Google returned an invalid account currency.',
  meta: 'Meta returned an invalid account currency.',
  linkedin: 'LinkedIn returned an invalid account currency.',
  snapchat: 'Snapchat returned an invalid account currency.',
  tiktok: 'TikTok returned an invalid account currency.',
  x: 'X returned a malformed inventory text field.',
};
const definitions = {
  google: {
    gateway: 'google_ads_native_action',
    account: '123',
    origin: 'https://googleads.googleapis.com',
    path: '/' + googleAdsVersion + '/customers/123/googleAds:search',
    method: 'POST',
    scopes: ['https://www.googleapis.com/auth/adwords'],
  },
  meta: {
    gateway: 'meta_native_action',
    account: '100',
    origin: 'https://graph.facebook.com',
    path: '/v26.0/act_100',
    method: 'GET',
    scopes: ['ads_read'],
  },
  linkedin: {
    gateway: 'linkedin_native_action',
    account: '100',
    origin: 'https://api.linkedin.com',
    path: '/rest/adAccounts/100',
    method: 'GET',
    scopes: ['r_ads'],
  },
  snapchat: {
    gateway: 'snapchat_native_action',
    account: '10000000-0000-4000-8000-000000000000',
    origin: 'https://adsapi.snapchat.com',
    path: '/v1/adaccounts/10000000-0000-4000-8000-000000000000',
    method: 'GET',
    scopes: ['snapchat-marketing-api'],
  },
  tiktok: {
    gateway: 'tiktok_native_action',
    account: '100',
    origin: 'https://business-api.tiktok.com',
    path: '/open_api/v1.3/advertiser/info/',
    method: 'GET',
    scopes: [],
  },
  x: {
    gateway: 'x_ads_native_action',
    account: 'acct1',
    origin: 'https://ads-api.x.com',
    path: '/12/accounts/acct1',
    method: 'GET',
    scopes: [],
  },
};
export function portfolioRefusalFixture(provider) {
  assert.ok(Object.hasOwn(definitions, provider), 'Select a fixed portfolio fixture provider');
  const d = definitions[provider],
    keyByte = 181 + Object.keys(definitions).indexOf(provider),
    actor = {tenantId: 'synthetic-portfolio-refusal-' + provider, userId: 'fixture', role: 'reader'},
    store = new Store(':memory:', Buffer.alloc(32, keyByte).toString('base64')),
    connection = {
      id: '44444444-5555-4555-8555-555555555555',
      tenantId: actor.tenantId,
      gateway: d.gateway,
      accounts: [d.account],
      writeAccounts: [],
      enabled: true,
      label: 'Synthetic portfolio ' + provider,
      scopes: d.scopes,
    },
    credentials = {
      accessToken: 'synthetic-portfolio-refusal',
      ...(provider === 'google' ? {developerToken: 'synthetic-portfolio-developer'} : {}),
      ...(provider === 'x'
        ? {consumerKey: 'synthetic-key', consumerSecret: 'synthetic-secret', tokenSecret: 'synthetic-token-secret'}
        : {}),
    },
    requests = [];
  store.putConnection({...actor, role: 'admin'}, connection, credentials);
  const body = (url, init) => {
    if (provider === 'google') {
      const query = JSON.parse(String(init.body)).query;
      assert.equal(typeof query, 'string');
      assert.ok(query.startsWith('SELECT customer.id, customer.currency_code, customer.time_zone, '));
      assert.ok(query.includes(' FROM campaign WHERE '));
      assert.ok(query.endsWith(' ORDER BY campaign.id LIMIT 51'));
      return {
        results: [
          {
            customer: {id: d.account, resourceName: 'customers/' + d.account, currencyCode: 'usd', timeZone: 'UTC'},
            campaign: {
              id: '9007199254740993',
              resourceName: 'customers/' + d.account + '/campaigns/9007199254740993',
              name: 'Native campaign',
              status: 'PAUSED',
            },
          },
        ],
      };
    }
    if (provider === 'meta')
      return {id: 'act_' + d.account, account_id: d.account, currency: 'usd', timezone_name: 'UTC'};
    if (provider === 'linkedin') return {id: d.account, currency: 'usd'};
    if (provider === 'snapchat')
      return {
        request_status: 'SUCCESS',
        paging: {},
        adaccounts: [{sub_request_status: 'success', adaccount: {id: d.account, currency: 'usd', timezone: 'UTC'}}],
      };
    if (provider === 'tiktok') {
      assert.deepEqual(JSON.parse(url.searchParams.get('advertiser_ids')), [d.account]);
      return {code: 0, message: 'OK', data: {list: [{advertiser_id: d.account, currency: 'usd', timezone: 'Etc/GMT'}]}};
    }
    return {request: {params: {account_id: d.account}}, data: {id: d.account, deleted: false, timezone: 42}};
  };
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (raw, init) => {
        const url = new URL(String(raw));
        requests.push({origin: url.origin, path: url.pathname, method: init.method});
        assert.equal(url.origin, d.origin);
        assert.equal(url.pathname, d.path);
        assert.equal(init.method, d.method);
        if (provider === 'linkedin')
          assert.equal(init.headers['LinkedIn-Version'] ?? init.headers['linkedin-version'], '202609');
        return Response.json(body(url, init));
      },
      async () => {},
      30000,
      8 * 1024 * 1024,
      1000,
      1,
    ),
    undefined,
    {allowWrites: false},
  );
  return {
    provider,
    keyByte,
    actor,
    store,
    service,
    connection,
    requests,
    input: {
      action: 'portfolio',
      gateway: d.gateway,
      connection_id: connection.id,
      account_id: d.account,
      requirements: {entity: provider === 'linkedin' ? 'campaign_group' : 'campaign'},
      limit: 50,
    },
    message: portfolioRefusalMessages[provider],
    code: 'PORTFOLIO_INVALID_RESPONSE',
    close: () => store.close(),
  };
}

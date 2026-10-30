import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Store} from '../dist/src/store.js';
import {CredentialProvider} from '../dist/src/auth.js';
import {refreshEndpoints} from '../dist/src/connection-health.js';
import {requestAppleAccessToken} from '../dist/src/apple-auth.js';
import {providerHooks, registeredProviderHooks} from '../dist/src/provider-hooks.js';
import {providerAdapters, providerOf} from '../dist/src/provider-adapters.js';
import {isProviderModule, providerRegistries, runtimeGraph} from '../tools/architecture-map.mjs';

// ARC-01 phase B, wave 4c (transport and catalog): the token renewal (src/auth.ts CredentialProvider) named five
// providers: Apple renews with its own client-credentials request, X's login holds a consumer secret, Microsoft asks
// again for its scope, Snapchat sends its registered callback and Reddit its User-Agent with HTTP Basic authentication.
// Each is now its adapter's refresh hooks (src/<provider>-adapter.ts); the renewal keeps the expiry window, the single
// renewal per connection, the refresh gate, the app-change refusal, the grant, the endpoint, the response checks, the
// health records and the order of every step. The seam test fails on the build before; the request table holds what
// the renewal sent before, provider by provider (those pass on both builds).

const root = fileURLToPath(new URL('..', import.meta.url));
const owner = {tenantId: 'refresh-hooks', userId: 'owner', role: 'admin'},
  key = Buffer.alloc(32, 41).toString('base64');

test('the token renewal names no gateway and imports no provider module; five providers declare their parts', () => {
  const source = fs.readFileSync(new URL('../src/auth.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /['"][a-z0-9_]+_native_action['"]/, 'no gateway literal in src/auth.ts');
  const imports = [...runtimeGraph(root).get('src/auth.ts')].filter(
    id => isProviderModule(id) && !providerRegistries.includes(id),
  );
  assert.deepEqual(imports, [], 'src/auth.ts consults the provider hooks registry only');
  assert.deepEqual(
    registeredProviderHooks.filter(h => h.refresh).map(h => [h.gateway, Object.keys(h.refresh).sort()]),
    [
      ['snapchat_native_action', ['request']],
      ['x_ads_native_action', ['appSecret']],
      ['microsoft_ads_native_action', ['request']],
      ['apple_ads_native_action', ['own']],
      ['reddit_native_action', ['request']],
    ],
  );
  for (const hooks of registeredProviderHooks)
    if (hooks.refresh) assert.ok(Object.isFrozen(hooks.refresh), hooks.gateway + ' refresh hooks are frozen');
  // Apple renews with the request src/apple-auth.ts makes; X's app secret is the login's consumer secret.
  assert.equal(providerHooks('apple_ads_native_action').refresh.own, requestAppleAccessToken);
  assert.equal(
    providerHooks('x_ads_native_action').refresh.appSecret({consumerSecret: 'consumer', clientSecret: 'client'}),
    'consumer',
  );
});

const connection = (gateway, extra = {}) => ({
  id: gateway.split('_')[0] + '-login',
  tenantId: owner.tenantId,
  gateway,
  accounts: ['123'],
  enabled: true,
  label: 'Synthetic login',
  scopes: [],
  ...extra,
});
const expired = (extra = {}) => ({
  accessToken: 'old-access',
  refreshToken: 'synthetic-refresh',
  clientId: 'client-a',
  clientSecret: 'secret-a',
  expiresAt: 1,
  ...extra,
});
/** Renews one synthetic login against a recording token endpoint: the request it sent, or the refusal. */
async function renewal(gateway, {credentials = {}, connected = {}} = {}) {
  const store = new Store(':memory:', key),
    requests = [];
  store.appEnvironment = {};
  const fetcher = async (url, init) => {
    requests.push({
      url: String(url),
      method: init?.method,
      redirect: init?.redirect,
      body: [...new URLSearchParams(String(init?.body))],
      headers: {...init?.headers},
    });
    return Response.json({access_token: 'fresh-access', expires_in: 3600, token_type: 'Bearer'});
  };
  const login = connection(gateway, connected);
  try {
    store.putConnection(owner, login, expired(credentials));
    const renewed = await new CredentialProvider(store, fetcher).get(login);
    return {requests, accessToken: renewed.accessToken};
  } catch (error) {
    return {requests, refused: {code: error.code, message: error.message, status: error.status}};
  } finally {
    store.close();
  }
}
const grant = [
  ['grant_type', 'refresh_token'],
  ['refresh_token', 'synthetic-refresh'],
  ['client_id', 'client-a'],
  ['client_secret', 'secret-a'],
];

test('each provider renews with the request the renewal sent before: its body fields, headers and authentication', async () => {
  const sent = request => ({method: 'POST', redirect: 'error', ...request});
  // A provider without refresh hooks: the plain refresh-token grant.
  assert.deepEqual(await renewal('google_ads_native_action'), {
    requests: [sent({url: refreshEndpoints.google_ads_native_action, body: grant, headers: {}})],
    accessToken: 'fresh-access',
  });
  // Microsoft asks again for its API scope and for renewal.
  assert.deepEqual(await renewal('microsoft_ads_native_action'), {
    requests: [
      sent({
        url: refreshEndpoints.microsoft_ads_native_action,
        body: [...grant, ['scope', 'https://ads.microsoft.com/msads.manage offline_access']],
        headers: {},
      }),
    ],
    accessToken: 'fresh-access',
  });
  // Snapchat sends the callback its login recorded.
  assert.deepEqual(
    await renewal('snapchat_native_action', {credentials: {redirectUri: 'https://amcp.example/callback'}}),
    {
      requests: [
        sent({
          url: refreshEndpoints.snapchat_native_action,
          body: [...grant, ['redirect_uri', 'https://amcp.example/callback']],
          headers: {},
        }),
      ],
      accessToken: 'fresh-access',
    },
  );
  // Reddit authenticates the app with HTTP Basic and its descriptive User-Agent; the app's ID and secret leave the body.
  assert.deepEqual(await renewal('reddit_native_action', {connected: {userAgent: 'amcp-test/1.0 by synthetic'}}), {
    requests: [
      sent({
        url: refreshEndpoints.reddit_native_action,
        body: grant.slice(0, 2),
        headers: {
          'User-Agent': 'amcp-test/1.0 by synthetic',
          Authorization: 'Basic ' + Buffer.from('client-a:secret-a').toString('base64'),
        },
      }),
    ],
    accessToken: 'fresh-access',
  });
});

test('a provider refuses a renewal it cannot send before any token request, with the refusal it had', async () => {
  assert.deepEqual(await renewal('snapchat_native_action'), {
    requests: [],
    refused: {
      code: 'REAUTHORIZATION_REQUIRED',
      message: 'Reconnect Snapchat to record the registered callback required for refresh.',
      status: 401,
    },
  });
  for (const userAgent of [undefined, 'amcp-test/1.0\r\nX-Injected: 1'])
    assert.deepEqual(await renewal('reddit_native_action', {connected: userAgent ? {userAgent} : {}}), {
      requests: [],
      refused: {
        code: 'USER_AGENT_REQUIRED',
        message: 'Configure a descriptive Reddit application userAgent on the connection.',
        status: 400,
      },
    });
  // Refused before the provider's step: no refresh token, whatever the provider.
  for (const gateway of ['microsoft_ads_native_action', 'snapchat_native_action', 'reddit_native_action'])
    assert.equal(
      (await renewal(gateway, {credentials: {refreshToken: undefined}})).refused?.code,
      'REAUTHORIZATION_REQUIRED',
      gateway,
    );
});

// The wave 4c merge review: a login's renewal is described twice, by these refresh hooks (which src/auth.ts runs) and
// by the adapters' renewal facts (`renewal`, which src/connection-health.ts reads for refreshEndpoints and
// renewsAutomatically), each half pinned by its own package's tests. They must agree for every gateway: otherwise a
// provider could renew itself while credential health says its logins need consent, or a provider's parts of the
// refresh-token request could go to no token endpoint.
test('the refresh hooks and the adapters’ renewal facts agree for every gateway', () => {
  const gateways = [
    ...new Set([...providerAdapters.map(a => a.gateway), ...registeredProviderHooks.map(h => h.gateway)]),
  ];
  for (const gateway of gateways) {
    const refresh = providerHooks(gateway)?.refresh,
      renewal = providerOf(gateway)?.renewal,
      endpoint = renewal && 'tokenEndpoint' in renewal ? renewal.tokenEndpoint : undefined;
    assert.equal(
      !!refresh?.own,
      !!renewal && 'clientCredentials' in renewal,
      gateway + ': it renews itself exactly where its logins renew with the client’s own credentials',
    );
    if (refresh?.request) assert.ok(endpoint, gateway + ': its parts of the refresh request go to its token endpoint');
    if (refresh?.own) assert.equal(Object.hasOwn(refreshEndpoints, gateway), false, gateway + ': it has no endpoint');
    assert.equal(refreshEndpoints[gateway], endpoint, gateway + ': the renewal sends to its adapter’s token endpoint');
  }
  // The agreement today: Apple renews itself, and the three request hooks belong to providers with endpoints.
  assert.deepEqual(
    gateways.filter(gateway => providerHooks(gateway)?.refresh?.own),
    ['apple_ads_native_action'],
  );
  assert.deepEqual(gateways.filter(gateway => providerHooks(gateway)?.refresh?.request).sort(), [
    'microsoft_ads_native_action',
    'reddit_native_action',
    'snapchat_native_action',
  ]);
});

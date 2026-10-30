import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {isProviderModule, providerRegistries, runtimeGraph} from '../tools/architecture-map.mjs';
import {accountKey, bindingKey} from '../dist/src/access-sets.js';
import {normalizeAccount} from '../dist/src/account-id.js';
import {providerAdapters, providerById, providerOf} from '../dist/src/provider-adapters.js';
import {providerLogin, registeredKeyedLogins, registeredProviderLogins} from '../dist/src/provider-logins.js';
import {googleOAuth} from '../dist/src/google-oauth.js';
import {providerRevocationOffer, revocationTarget} from '../dist/src/provider-revocation.js';
import {Store} from '../dist/src/store.js';
import {platforms} from '../dist/server/platform-oauth.js';

// ARC-01 phase B, the login and connection modules the website and the MCP service share: the provider facts they held
// (how an account ID compares, ...) are the provider adapters' (src/provider-adapters.ts) or their website login steps'
// (src/<provider>-login.ts), so these modules name no gateway. The behaviour of each is pinned by its suites
// (tests/client-access-sets.test.ts, tests/service.test.ts, ...); these cases pin the seams.

const graph = runtimeGraph(process.cwd());
const providerImports = file =>
  [...graph.get(file)].filter(id => isProviderModule(id) && !providerRegistries.includes(id)).sort();
const source = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const gatewayLiteral = /['"][a-z0-9_]+_native_action['"]/;

test('client access sets and connection resolution compare accounts in the adapters’ account form', () => {
  for (const file of ['src/access-sets.ts', 'src/store.ts'])
    assert.deepEqual(providerImports(file), [], file + ' imports no provider module');
  assert.doesNotMatch(source('src/access-sets.ts'), gatewayLiteral);
  // The comparison the access sets made before: Meta without act_, Google Ads without dashes, every other ID as given.
  const before = (gateway, id) => {
    const value = String(id);
    return gateway === 'meta_native_action'
      ? value.replace(/^act_/, '')
      : gateway === 'google_ads_native_action'
        ? value.replaceAll('-', '')
        : value;
  };
  const ids = ['act_123', '123-456-7890', 'act_12-3', 'customers/1-2', 123, '', 'ACT_9', '  7 '];
  for (const {gateway} of providerAdapters)
    for (const id of ids) {
      assert.equal(accountKey(gateway, id), before(gateway, id), gateway + ' ' + id);
      assert.equal(accountKey(gateway, id), normalizeAccount(gateway, id), gateway + ' ' + id);
    }
  for (const id of ids) assert.equal(accountKey('amcp_workspace', id), before('amcp_workspace', id));
  assert.equal(bindingKey('meta_native_action', 'c1', 'act_42'), 'meta_native_action\u0000c1\u000042');
  // Only Google Ads and Meta declare an account form of their own.
  assert.deepEqual(
    providerAdapters.filter(a => a.account?.normalize).map(a => a.gateway),
    ['google_ads_native_action', 'meta_native_action'],
  );
});

test('a connection resolves by an account in its display form, as before', () => {
  const store = new Store(':memory:', Buffer.alloc(32, 53).toString('base64')),
    actor = {tenantId: 'account-forms', userId: 'owner', role: 'admin'};
  try {
    const login = (id, gateway, accounts) =>
      store.putConnection(
        actor,
        {id, tenantId: actor.tenantId, gateway, accounts, enabled: true, label: id, scopes: []},
        {accessToken: 'synthetic-access'},
      );
    login('google', 'google_ads_native_action', ['1234567890']);
    login('meta', 'meta_native_action', ['act_111']);
    login('tiktok', 'tiktok_native_action', ['act_222']);
    assert.equal(store.resolveConnection(actor, 'google_ads_native_action', '123-456-7890').id, 'google');
    assert.equal(store.resolveConnection(actor, 'meta_native_action', '111').id, 'meta');
    assert.equal(store.resolveConnection(actor, 'meta_native_action', 'act_111').id, 'meta');
    // Another provider's ID is compared as given: no act_ is dropped.
    assert.equal(store.resolveConnection(actor, 'tiktok_native_action', 'act_222').id, 'tiktok');
    assert.throws(
      () => store.resolveConnection(actor, 'tiktok_native_action', '222'),
      e => e.code === 'CONNECTION_REQUIRED',
    );
    assert.throws(
      () => store.resolveConnection(actor, 'google_ads_native_action', '1234567891'),
      e => e.code === 'CONNECTION_REQUIRED',
    );
  } finally {
    store.close();
  }
});

test('provider revocation takes its endpoint from Google’s OAuth steps, for every Google login and no other', () => {
  const file = 'src/provider-revocation.ts';
  assert.doesNotMatch(source(file), gatewayLiteral);
  assert.deepEqual(providerImports(file), [], 'it consults the provider login registry instead');
  assert.ok(graph.get(file).has('src/provider-logins.ts'));
  // Google's documented revocation endpoint (RFC 7009), the target every Google login revoked at before the move.
  assert.ok(Object.isFrozen(googleOAuth.revocation));
  assert.deepEqual(googleOAuth.revocation, {
    provider: 'google',
    endpoint: 'https://oauth2.googleapis.com/revoke',
    sharedClient: true,
  });
  const google = {provider: 'google', endpoint: 'https://oauth2.googleapis.com/revoke', shared_client: true};
  const revocable = registeredProviderLogins.filter(l => l.oauth?.revocation).map(l => l.gateway);
  assert.deepEqual(revocable.sort(), [
    'dv360_native_action',
    'ga4_native_action',
    'google_ads_native_action',
    'google_business_native_action',
    'google_drive_native_action',
    'google_search_console_native_action',
    'google_sheets_native_action',
    'gtm_native_action',
  ]);
  for (const gateway of revocable) {
    assert.deepEqual(revocationTarget(gateway), google, gateway);
    // The logins that share Google's OAuth steps share its one target.
    assert.equal(revocationTarget(gateway), revocationTarget(providerById('google').gateway), gateway);
  }
  for (const {gateway} of providerAdapters.filter(a => !revocable.includes(a.gateway))) {
    assert.equal(revocationTarget(gateway), undefined, gateway);
    assert.deepEqual(providerRevocationOffer(gateway, {AMCP_PROVIDER_REVOCATION: 'on'}), {
      available: false,
      reason: 'provider_not_supported',
      provider: null,
      shared_client: false,
    });
  }
  // A name that is no gateway has no target, an inherited one included.
  for (const name of ['amcp_workspace', 'constructor', 'toString', '__proto__'])
    assert.equal(revocationTarget(name), undefined, name);
  assert.deepEqual(providerRevocationOffer('ga4_native_action', {AMCP_PROVIDER_REVOCATION: 'on'}), {
    available: true,
    reason: null,
    provider: 'google',
    shared_client: true,
  });
});

test('how a login’s accounts are reached is its provider’s fact and login step', () => {
  // The asset selection and the sync name neither Microsoft's nor Google Ads' gateway for it, and the store names none.
  for (const file of ['server/connection-routes.ts', 'server/website-connections.ts'])
    assert.doesNotMatch(source(file), /microsoftGateway|accountLoginCustomers =\s+c\.gateway/, file);
  assert.doesNotMatch(source('server/connection-routes.ts'), /googleAdsGateway/);
  assert.doesNotMatch(source('src/store.ts'), gatewayLiteral);
  assert.deepEqual(providerImports('src/store.ts'), []);
  // Only Microsoft (its parent customers) and Google Ads (its manager routes) keep routes, each in its own field.
  assert.deepEqual(
    providerAdapters.filter(a => a.account?.routes).map(a => [a.gateway, a.account.routes]),
    [
      ['google_ads_native_action', 'accountLoginCustomers'],
      ['microsoft_ads_native_action', 'accountCustomers'],
    ],
  );
  for (const login of [...registeredProviderLogins, ...registeredKeyedLogins])
    assert.equal(typeof login.routes === 'function', !!providerOf(login.gateway).account?.routes, login.gateway);
  // The routes the selection and the sync kept before the move: Microsoft's parent customer of every selected account,
  // Google Ads' manager route of each selected account that has one (an object keyed by the decimal account IDs).
  const asset = (id, extra) => ({id, kind: 'ad_accounts', name: 'Account ' + id, source: 'vendor', ...extra});
  const assets = [
    asset('3', {parentId: '7', loginCustomerId: '6'}),
    asset('1', {parentId: '9', loginCustomerId: '7'}),
    asset('2', {parentId: '8'}),
  ];
  const microsoft = providerLogin('microsoft_ads_native_action').routes,
    google = providerLogin('google_ads_native_action').routes;
  assert.deepEqual(Object.entries(microsoft(assets, ['1', '2'])), [
    ['1', '9'],
    ['2', '8'],
  ]);
  assert.deepEqual(Object.entries(google(assets, ['1', '2', '3'])), [
    ['1', '7'],
    ['3', '6'],
  ]);
  assert.deepEqual(google(assets, []), {});
  // An account listed without its parent keeps no value (the saved connection drops it), as before.
  assert.deepEqual(microsoft([asset('4', {})], ['4']), {4: undefined});
});

test('the store keeps manager routes only on a login whose provider keeps them', () => {
  const store = new Store(':memory:', Buffer.alloc(32, 59).toString('base64')),
    actor = {tenantId: 'account-routes', userId: 'owner', role: 'admin'},
    login = (id, gateway, extra) =>
      store.putConnection(
        actor,
        {id, tenantId: actor.tenantId, gateway, accounts: ['123'], enabled: true, label: id, scopes: [], ...extra},
        {accessToken: 'synthetic-access'},
      );
  try {
    login('google', 'google_ads_native_action', {accountLoginCustomers: {123: '456'}});
    login('microsoft', 'microsoft_ads_native_action', {accountCustomers: {123: '456'}});
    for (const gateway of ['microsoft_ads_native_action', 'meta_native_action', 'dv360_native_action'])
      assert.throws(
        () => login('other-' + gateway, gateway, {accountLoginCustomers: {123: '456'}}),
        e =>
          e.code === 'INVALID_ACCOUNT_BINDING' &&
          e.message === 'Google login customers must map selected accounts to decimal identifiers.',
        gateway,
      );
    assert.throws(
      () => login('google-bad', 'google_ads_native_action', {accountLoginCustomers: {999: '456'}}),
      e => e.code === 'INVALID_ACCOUNT_BINDING',
    );
  } finally {
    store.close();
  }
});

test('the website platforms’ OAuth apps are their providers’ facts, which app credentials and the platforms read', () => {
  // SEC-07 S2's use-time secrets name no gateway; tests/app-credential-golden.test.mjs pins what they resolve.
  assert.doesNotMatch(source('src/app-credentials.ts'), gatewayLiteral);
  assert.deepEqual(providerImports('src/app-credentials.ts'), []);
  assert.doesNotMatch(source('server/platform-oauth.ts'), /\benv: '/);
  // Exactly the website platforms' providers declare an app, and each platform takes its adapter's stem.
  assert.deepEqual(
    providerAdapters
      .filter(a => a.app)
      .map(a => a.gateway)
      .sort(),
    platforms.map(p => p.gateway).sort(),
  );
  for (const p of platforms) assert.equal(p.env, providerOf(p.gateway).app.stem, p.id);
  for (const {gateway, app} of providerAdapters.filter(a => a.app)) {
    assert.ok(Object.isFrozen(app), gateway);
    if (app.settings) assert.ok(Object.isFrozen(app.settings), gateway);
    if (app.unsealed) assert.ok(Object.isFrozen(app.unsealed), gateway);
  }
  // What only some apps declare: X's consumer key and secret, Microsoft's developer token, Apple's signing key and
  // Google Ads' developer token, which is never sealed.
  assert.deepEqual(
    providerAdapters.filter(a => a.app && Object.keys(a.app).some(k => k !== 'stem')).map(a => [a.gateway, {...a.app}]),
    [
      ['google_ads_native_action', {stem: 'GOOGLE', unsealed: ['developerToken']}],
      ['x_ads_native_action', {stem: 'X', secretField: 'consumerSecret', clientField: 'consumerKey'}],
      [
        'microsoft_ads_native_action',
        {stem: 'MICROSOFT', settings: {developerToken: 'AMCP_MICROSOFT_DEVELOPER_TOKEN'}},
      ],
      [
        'apple_ads_native_action',
        {
          stem: 'APPLE',
          settings: {
            appleTeamId: 'AMCP_APPLE_TEAM_ID',
            appleKeyId: 'AMCP_APPLE_KEY_ID',
            applePrivateKey: 'AMCP_APPLE_PRIVATE_KEY',
          },
        },
      ],
    ],
  );
});

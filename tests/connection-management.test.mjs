// CON-05: connection management. Logins were indistinguishable "<Platform> login" labels without rename or identity,
// callback refusals rendered raw JSON, a disabled login could become the default, AMBIGUOUS_CONNECTION candidates did
// not say which login selects or may change the account, list_accounts named an account only after a live read while
// recipe context used cached discovery, spreadsheets were listed as ad accounts, readiness took one account per call,
// and Google clients were all shown under the root manager with a deployment-wide login-customer-id fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRefused} from './helpers/assert-refused.mjs';
import fs from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {readOnlyPolicy} from '../dist/src/preflight.js';
import {readinessId} from '../dist/src/readiness.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {WebStore} from '../dist/server/web-store.js';
import {UserAccounts} from '../dist/server/user-accounts.js';
import {PlatformOAuth, googleIdentity, loginLabel, platform, platforms} from '../dist/server/platform-oauth.js';
import {googleAccountDiscovery} from '../dist/server/google-account-discovery.js';
import {AssetDiscovery} from '../dist/server/asset-discovery.js';
import {microsoftGateway, microsoftScope} from '../dist/src/microsoft-native.js';
import {listenForFetch} from '../dist/tests/http-listener.js';

const key = Buffer.alloc(32, 61).toString('base64'),
  origin = 'https://amcp.shop',
  password = 'synthetic-connection-management-owner',
  owner = {tenantId: 'local', userId: 'workspace-admin', role: 'admin'},
  registry = new Registry();

/** A Google ID token as the token endpoint returns it; only issuer, audience and subject are read (CON-05). */
const idToken = claims =>
  [{alg: 'RS256'}, claims, 'signature']
    .map(part => Buffer.from(typeof part === 'string' ? part : JSON.stringify(part)).toString('base64url'))
    .join('.');

/** A three-level Google manager hierarchy: 100 manages 101 and 200; 200 manages 201 and 300; 300 manages 301. */
const hierarchy = [
  {id: '100', level: '0', manager: true, descriptiveName: 'Root manager'},
  {id: '101', level: '1', manager: false, descriptiveName: 'Direct client'},
  {id: '200', level: '1', manager: true, descriptiveName: 'Sub-manager'},
  {id: '201', level: '2', manager: false, descriptiveName: 'Sub-manager client'},
  {id: '300', level: '2', manager: true, descriptiveName: 'Second-level manager'},
  {id: '301', level: '3', manager: false, descriptiveName: 'Deep client'},
];
const direct = {200: ['201', '300'], 300: ['301']};
function googleAdsResponse(url, init, headers) {
  const customer = /\/customers\/(\d+)\//.exec(url.pathname)?.[1],
    query = JSON.parse(String(init?.body ?? '{}')).query ?? '';
  headers.push({customer, login: new Headers(init?.headers).get('login-customer-id'), query});
  if (url.pathname.endsWith(':listAccessibleCustomers')) return Response.json({resourceNames: ['customers/100']});
  if (/FROM customer_client WHERE customer_client\.level = 1/.test(query))
    return Response.json({
      results: (direct[customer] ?? []).map(id => ({customerClient: {id, level: '1'}})),
    });
  if (/FROM customer_client/.test(query))
    return Response.json({
      results: hierarchy.map(h => ({
        customerClient: {...h, clientCustomer: 'customers/' + h.id, status: 'ENABLED', currencyCode: 'USD'},
      })),
    });
  return Response.json({
    results: [{customer: {id: customer, descriptiveName: 'Root manager', manager: true, status: 'ENABLED'}}],
  });
}

async function site({allowWrites = false} = {}) {
  const store = new Store(':memory:', key),
    authEnv = {AMCP_MICROSOFT_DEVELOPER_TOKEN: 'synthetic-developer-token', AMCP_GOOGLE_LOGIN_CUSTOMER_ID: '7777777'},
    control = {googleUser: '1000001', googleName: 'Synthetic Person', metaName: 'Meta Person'},
    calls = [],
    headers = [];
  for (const p of platforms) {
    authEnv['AMCP_' + p.env + '_CLIENT_ID'] = 'synthetic-' + p.id + '-client';
    authEnv['AMCP_' + p.env + '_CLIENT_SECRET'] = 'synthetic-' + p.id + '-secret';
  }
  const fetcher = async (input, init) => {
    const url = new URL(String(input));
    calls.push((init?.method ?? 'GET') + ' ' + url.origin + url.pathname);
    if (url.origin === 'https://oauth2.googleapis.com')
      return Response.json({
        access_token: 'synthetic-google-access',
        refresh_token: 'synthetic-google-refresh',
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/adwords openid profile',
        id_token: idToken({
          iss: 'https://accounts.google.com',
          aud: 'synthetic-google-client',
          sub: control.googleUser,
          name: control.googleName,
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      });
    if (url.origin === 'https://googleads.googleapis.com') return googleAdsResponse(url, init, headers);
    if (url.origin === 'https://graph.facebook.com') {
      assert.equal(init?.method ?? 'GET', 'GET');
      if (url.pathname === '/v26.0/oauth/access_token')
        return Response.json({access_token: 'synthetic-meta-access', expires_in: 5184000});
      if (url.pathname === '/v26.0/me/adaccounts')
        return Response.json({data: [{id: 'act_111', account_id: '111', name: 'Client account', currency: 'USD'}]});
      if (url.pathname === '/v26.0/me') return Response.json({id: '2000002', name: control.metaName});
      if (url.pathname === '/v26.0/me/permissions') return Response.json({data: []});
    }
    throw Error('Unexpected synthetic provider route: ' + url.origin + url.pathname);
  };
  const options = {origin, masterKey: key, adminPassword: password, fetcher, authEnv},
    web = new WebStore(store, options),
    service = new MirrorService(registry, store, undefined, undefined, {...readOnlyPolicy, allowWrites}),
    listener = await listenForFetch(createHttpApp(service, store, {website: options})),
    base = 'http://127.0.0.1:' + listener.address().port;
  const request = async (path, method = 'GET', body, extra = {}) => {
    const r = await fetch(base + path, {
      method,
      redirect: 'manual',
      headers: {Origin: origin, ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...extra},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return new Response([204, 304].includes(r.status) ? null : await r.arrayBuffer(), {
      status: r.status,
      headers: r.headers,
    });
  };
  const login = await request('/api/session', 'POST', {password}),
    session = {Cookie: login.headers.get('set-cookie').split(';')[0], 'X-AMCP-CSRF': (await login.json()).csrf};
  const connect = async (id, route = '/api/auth/' + id + '/start') => {
    const started = await request(route, 'POST', {}, session);
    assert.equal(started.status, 200, await started.clone().text());
    const {url, attemptId} = await started.json(),
      state = new URL(url).searchParams.get('state'),
      back = await request(
        '/api/auth/' + id + '/callback?' + new URLSearchParams({state, code: 'synthetic-code'}),
        'GET',
        undefined,
        session,
      );
    assert.equal(back.status, 303);
    return (await request('/api/oauth/progress/' + attemptId, 'GET', undefined, session)).json();
  };
  const audit = name =>
    store
      .audit('local', 1000)
      .map(r => JSON.parse(r.event))
      .filter(e => e.event === name);
  return {
    store,
    web,
    control,
    calls,
    headers,
    request,
    session,
    connect,
    audit,
    close: async () => {
      const end = new Promise(r => listener.close(() => r()));
      listener.closeAllConnections();
      await end;
      store.close();
    },
  };
}

test('a browser callback refusal opens the localized result page with a fixed code and no echoed parameters', async () => {
  const s = await site();
  try {
    const html = {Accept: 'text/html,application/xhtml+xml'};
    const callback = query => '/api/auth/meta/callback?' + query;
    const expect = async (path, headers, code, platformId = 'meta') => {
      const r = await s.request(path, 'GET', undefined, headers);
      assert.equal(r.status, 303, path);
      const location = r.headers.get('location');
      assert.equal(
        location,
        '/oauth/result?' + new URLSearchParams({error: code, ...(platformId ? {platform: platformId} : {})}),
      );
      assert.doesNotMatch(location, /PRIVATE/);
    };
    // The session ended during consent.
    await expect(callback('state=PRIVATE-STATE&code=PRIVATE-CODE'), html, 'SIGN_IN_REQUIRED');
    // Expired, reused or foreign state.
    await expect(callback('state=PRIVATE-STATE&code=PRIVATE-CODE'), {...html, ...s.session}, 'OAUTH_STATE_INVALID');
    await expect(callback('code=PRIVATE-CODE'), {...html, ...s.session}, 'OAUTH_STATE_INVALID');
    // Malformed (repeated) parameters.
    await expect(callback('state=PRIVATE-A&state=PRIVATE-B'), {...html, ...s.session}, 'OAUTH_CALLBACK_INVALID');
    // A member who is not an administrator.
    const accounts = new UserAccounts(s.web),
      member = s.store.transaction(() => accounts.newUser('Member', 'member@example.test', null, true, false));
    s.store.db.prepare("UPDATE workspace_memberships SET role='viewer' WHERE user_id=?").run(member.id);
    const readerCookie = {Cookie: s.web.cookie(accounts.session(member).id).split(';')[0]};
    await expect(callback('state=PRIVATE-STATE&code=PRIVATE-CODE'), {...html, ...readerCookie}, 'FORBIDDEN');
    // An unknown platform is never named on the page.
    await expect('/api/auth/unknown-platform/callback?state=PRIVATE', html, 'SIGN_IN_REQUIRED', null);
    // API callers keep the JSON refusal; nothing reached a provider.
    const json = await s.request(callback('state=PRIVATE-STATE&code=PRIVATE-CODE'), 'GET', undefined, s.session);
    assert.equal(json.status, 400);
    assert.equal((await json.json()).error.code, 'OAUTH_STATE_INVALID');
    assert.equal(s.calls.length, 0);
    // The result page itself is served.
    assert.equal((await s.request('/oauth/result?error=OAUTH_STATE_INVALID&platform=meta')).status, 200);
  } finally {
    await s.close();
  }
});

test('Google logins record the ID token user, are named after them, and a second login of one user is flagged', async () => {
  const s = await site();
  try {
    const first = await s.connect('google');
    assert.equal(first.state, 'complete', JSON.stringify(first));
    assert.equal(first.duplicateOf, undefined);
    const record = s.store.document('local', 'website_connection', first.connectionId);
    assert.equal(record.providerId, '1000001');
    assert.equal(record.displayName, 'Synthetic Person');
    const saved = s.store.listConnections('local').find(c => c.id === first.connectionId);
    assert.equal(saved.label, 'Google Ads · Synthetic Person');
    // The deployment-wide login customer is no longer copied into a website login.
    assert.equal(s.store.credentials('local', first.connectionId).loginCustomerId, undefined);
    const second = await s.connect('google');
    assert.equal(second.state, 'complete');
    assert.equal(second.duplicateOf, first.connectionId);
    const listed = await (await s.request('/api/platforms', 'GET', undefined, s.session)).json(),
      google = listed.platforms.find(p => p.id === 'google');
    const shown = google.connections.find(c => c.id === second.connectionId);
    assert.equal(shown.duplicateOf, first.connectionId);
    assert.deepEqual(shown.identity, {name: 'Synthetic Person'});
    assert.equal(JSON.stringify(listed).includes('1000001'), false, 'the provider subject is never shown');
    assert.equal(s.audit('website_oauth_connected').at(-1).same_identity_as, first.connectionId);
    // Another Google user is a separate, unflagged login.
    s.control.googleUser = '1000009';
    const other = await s.connect('google');
    assert.equal(other.duplicateOf, undefined);
  } finally {
    await s.close();
  }
});

test('Google reauthorization by a different Google user is refused and keeps the saved login (D19)', async () => {
  const s = await site();
  try {
    const first = await s.connect('google'),
      before = s.store.credentials('local', first.connectionId).accessToken;
    s.control.googleUser = '1000009';
    const started = await s.request('/api/connections/' + first.connectionId + '/reauthorize', 'POST', {}, s.session),
      body = await started.json(),
      state = new URL(body.url).searchParams.get('state');
    await s.request(
      '/api/auth/google/callback?' + new URLSearchParams({state, code: 'synthetic-code'}),
      'GET',
      undefined,
      s.session,
    );
    const progress = await (
      await s.request('/api/oauth/progress/' + body.attemptId, 'GET', undefined, s.session)
    ).json();
    assert.equal(progress.state, 'failed');
    assert.match(progress.message, /different provider user/);
    assert.equal(s.store.credentials('local', first.connectionId).accessToken, before);
    assert.equal(s.store.document('local', 'website_connection', first.connectionId).providerId, '1000001');
  } finally {
    await s.close();
  }
});

test('an administrator renames a login; the rename is audited without the name and survives later syncs', async () => {
  const s = await site();
  try {
    const meta = await s.connect('meta'),
      route = '/api/connections/' + meta.connectionId;
    assert.equal(s.store.listConnections('local')[0].label, 'Meta · Meta Person');
    for (const label of ['', '   ', 'x'.repeat(81), 'Bell\u0007', 42]) {
      const refused = await s.request(route + '/label', 'PATCH', {label}, s.session);
      assert.equal(refused.status, 400, JSON.stringify(label));
    }
    // CSRF and the administrator role are required.
    assert.equal((await s.request(route + '/label', 'PATCH', {label: 'X'}, {Cookie: s.session.Cookie})).status, 403);
    const renamed = await s.request(route + '/label', 'PATCH', {label: '  Client   A  '}, s.session);
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).name, 'Client A');
    const event = s.audit('website_connection_renamed').at(-1);
    assert.equal(event.connection_id, meta.connectionId);
    assert.equal(JSON.stringify(event).includes('Client A'), false);
    s.control.metaName = 'Renamed Upstream';
    assert.equal((await s.request(route + '/sync', 'POST', {}, s.session)).status, 200);
    assert.equal(s.store.listConnections('local')[0].label, 'Client A');
    assert.equal(s.store.document('local', 'website_connection', meta.connectionId).displayName, 'Renamed Upstream');
    // Disconnect removes the stored display name with the login record.
    assert.equal((await s.request(route, 'DELETE', undefined, s.session)).status, 200);
    assert.equal(s.store.documents('local', 'website_connection').length, 0);
  } finally {
    await s.close();
  }
});

test('a disabled login cannot become the default, and a default change records the previous default', async () => {
  const s = await site();
  try {
    const first = await s.connect('meta'),
      second = await s.connect('meta');
    const select = id =>
      s.request('/api/connections/' + id + '/assets', 'PATCH', {selected: ['ad_accounts:111']}, s.session);
    assert.equal((await select(first.connectionId)).status, 200);
    const refused = await s.request('/api/connections/' + second.connectionId + '/default', 'POST', {}, s.session);
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).error.code, 'CONNECTION_DISABLED');
    assert.equal(s.store.listConnections('local').find(c => c.id === second.connectionId).isDefault, false);
    assert.equal((await select(second.connectionId)).status, 200);
    assert.equal(
      (await s.request('/api/connections/' + second.connectionId + '/default', 'POST', {}, s.session)).status,
      200,
    );
    const event = s.audit('website_default_connection').at(-1);
    assert.deepEqual([event.connection_id, event.previous_default], [second.connectionId, first.connectionId]);
  } finally {
    await s.close();
  }
});

test('website sync audits the selected accounts and write grants a complete listing dropped', async () => {
  const s = await site({allowWrites: true});
  try {
    const meta = await s.connect('meta');
    s.store.updateConnection(owner, {
      ...s.store.listConnections('local')[0],
      accounts: ['111', '999'],
      writeAccounts: ['999'],
      enabled: true,
    });
    s.store.putDocument('local', 'website_assets', meta.connectionId, {
      groups: [],
      selected: ['ad_accounts:111', 'ad_accounts:999'],
      lastSync: 1,
    });
    assert.equal(
      (await s.request('/api/connections/' + meta.connectionId + '/sync', 'POST', {}, s.session)).status,
      200,
    );
    const event = s.audit('website_asset_sync').at(-1);
    assert.deepEqual(event.dropped_accounts, ['999']);
    assert.deepEqual(event.dropped_write_accounts, ['999']);
    assert.deepEqual(s.store.listConnections('local')[0].writeAccounts, []);
  } finally {
    await s.close();
  }
});

test('Google discovery places each client under its direct manager through the root login', async () => {
  const headers = [],
    transport = new NativeTransport((input, init) => googleAdsResponse(new URL(String(input)), init, headers));
  const group = await googleAccountDiscovery(
    transport,
    {
      id: 'google-login',
      tenantId: 'local',
      gateway: 'google_ads_native_action',
      accounts: [],
      enabled: false,
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  assert.equal(group.complete, true);
  assert.equal(group.hierarchyComplete, undefined);
  const parent = Object.fromEntries(group.assets.map(a => [a.id, a.parentId ?? null]));
  assert.deepEqual(parent, {100: null, 101: '100', 200: '100', 201: '200', 300: '200', 301: '300'});
  assert.deepEqual(Object.fromEntries(group.assets.map(a => [a.id, a.level ?? null])), {
    100: null,
    101: 1,
    200: 1,
    201: 2,
    300: 2,
    301: 3,
  });
  // Every account is still reached through the root manager.
  assert.ok(group.assets.every(a => a.loginCustomerId === '100'));
  const managerReads = headers.filter(h => /level = 1/.test(h.query));
  assert.deepEqual(
    managerReads.map(h => [h.customer, h.login]),
    [
      ['200', '100'],
      ['300', '100'],
    ],
  );
});

test('a website Google login refuses an account without a recorded manager route and sends nothing', async () => {
  const sent = [],
    transport = new NativeTransport(async (input, init) => {
      sent.push({url: String(input), login: new Headers(init?.headers).get('login-customer-id')});
      return Response.json({results: [{customer: {id: '201'}}]});
    });
  const plan = account => ({
    gateway: 'google_ads_native_action',
    accountId: account,
    action: 'AMCP_READINESS',
    method: 'POST',
    path: '/v23/customers/' + account + '/googleAds:search',
    query: {},
    body: {query: 'SELECT customer.id FROM customer'},
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    evidence: 'test',
    warnings: [],
  });
  const website = {
    id: 'google-login',
    tenantId: 'local',
    gateway: 'google_ads_native_action',
    accounts: ['201', '999'],
    accountLoginCustomers: {201: '100'},
    enabled: true,
    scopes: [],
  };
  // An older login still carries the deployment-wide manager in its credentials; it is never applied to a website login.
  const credentials = {accessToken: 'synthetic', loginCustomerId: '7777777'};
  await assert.rejects(transport.request(plan('999'), website, credentials), {
    code: 'GOOGLE_LOGIN_CUSTOMER_UNMAPPED',
  });
  assert.equal(sent.length, 0);
  await transport.request(plan('201'), website, credentials);
  assert.equal(sent.at(-1).login, '100');
  // An operator-provisioned login without recorded routes keeps its own provisioned login customer.
  const {accountLoginCustomers: _routes, ...operator} = website;
  await transport.request(plan('999'), operator, credentials);
  assert.equal(sent.at(-1).login, '7777777');
});

test('the Google ID token is accepted only for this client and Google issuer', () => {
  const now = Math.floor(Date.now() / 1000) + 600,
    good = {iss: 'https://accounts.google.com', aud: 'client-a', sub: '42', name: '  Person   Name ', exp: now};
  assert.deepEqual(googleIdentity(idToken(good), 'client-a'), {subject: '42', name: 'Person Name'});
  for (const bad of [
    {...good, aud: 'client-b'},
    {...good, iss: 'https://evil.example'},
    {...good, sub: ''},
    {...good, sub: 'a/b'},
    {...good, exp: 1},
  ])
    assert.equal(googleIdentity(idToken(bad), 'client-a'), undefined, JSON.stringify(bad));
  assert.equal(googleIdentity('not-a-token', 'client-a'), undefined);
  assert.equal(googleIdentity(idToken(good), undefined), undefined);
  assert.deepEqual(googleIdentity(idToken({...good, name: 'x'.repeat(81)}), 'client-a'), {subject: '42'});
  assert.equal(loginLabel(platform('meta'), 'Person'), 'Meta · Person');
  assert.equal(loginLabel(platform('meta')), 'Meta login');
});

test('Microsoft discovery names the login after its authenticated user, and only when Microsoft states a name', async () => {
  const store = new Store(':memory:', key),
    connection = {
      id: 'ms',
      tenantId: 'local',
      gateway: microsoftGateway,
      accounts: [],
      scopes: [microsoftScope],
      enabled: false,
    };
  try {
    store.putConnection(owner, connection, {accessToken: 'synthetic', developerToken: 'synthetic-developer'});
    let user = {Id: '789', Name: {FirstName: 'Synthetic', LastName: 'Owner'}};
    const discovery = new AssetDiscovery(store, async url =>
      String(url).endsWith('/User/Query')
        ? Response.json({User: user})
        : Response.json({Accounts: [{Id: '123', ParentCustomerId: '456', Name: 'Account', CurrencyCode: 'USD'}]}),
    );
    const named = await discovery.sync(connection);
    assert.deepEqual([named.identity, named.label], ['789', 'Synthetic Owner']);
    user = {Id: '789'};
    const unnamed = await discovery.sync(connection);
    assert.deepEqual([unnamed.identity, unnamed.label], ['789', undefined]);
  } finally {
    store.close();
  }
});

test('read-only deployments request Reddit adsread only; reviewed writes add adsedit (D19 item 5)', async () => {
  const store = new Store(':memory:', key);
  try {
    const web = new WebStore(store, {origin, masterKey: key, adminPassword: password}),
      env = {AMCP_REDDIT_CLIENT_ID: 'synthetic', AMCP_REDDIT_CLIENT_SECRET: 'synthetic'};
    assert.deepEqual(new PlatformOAuth(web, env, fetch, false).config(platform('reddit')).scopes, ['adsread']);
    assert.deepEqual(new PlatformOAuth(web, env, fetch, true).config(platform('reddit')).scopes, [
      'adsread',
      'adsedit',
    ]);
  } finally {
    store.close();
  }
});

/** A workspace with two Meta logins of one account, a Sheets destination and a fetcher that counts reads in flight. */
function workspace() {
  const store = new Store(':memory:', key),
    requests = [];
  let inFlight = 0,
    peak = 0;
  store.ensureTenant(owner.tenantId);
  const add = (id, gateway, accounts, extra = {}) =>
    store.putConnection(
      owner,
      {id, tenantId: 'local', gateway, accounts, enabled: true, label: 'Login ' + id, scopes: [], ...extra},
      {accessToken: 'synthetic'},
    );
  add('meta-a', 'meta_native_action', ['111', '222', '333', '444', '555', '666'], {writeAccounts: ['111']});
  add('meta-b', 'meta_native_action', ['111']);
  add('sheets', 'google_sheets_native_action', ['sheet-1']);
  store.putDocument('local', 'website_assets', 'meta-a', {
    groups: [
      {
        kind: 'ad_accounts',
        complete: true,
        checkedAt: 1700000000000,
        assets: [{id: '111', kind: 'ad_accounts', name: 'Client account', currency: 'USD', source: 'vendor'}],
      },
    ],
    selected: ['ad_accounts:111'],
    lastSync: 1700000000000,
  });
  const transport = new NativeTransport(async input => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 15));
    inFlight--;
    const id = /act_(\d+)/.exec(url.pathname)?.[1];
    return Response.json({id: 'act_' + id, account_id: id, name: 'Live ' + id, currency: 'EUR', timezone_name: 'UTC'});
  });
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  return {store, service, requests, peak: () => peak, close: () => store.close()};
}

test('AMBIGUOUS_CONNECTION candidates say whether each login selects and may change the account', async () => {
  const f = workspace();
  try {
    const refused = await f.service.call(
      'meta_native_action',
      {action: 'meta_campaign_list', account_id: '111'},
      owner,
    );
    assert.equal(refused.error.code, 'AMBIGUOUS_CONNECTION');
    const candidates = Object.fromEntries(refused.error.details.candidates.map(c => [c.connection_id, c]));
    assert.deepEqual(
      [candidates['meta-a'].account_selected, candidates['meta-a'].write_enabled, candidates['meta-b'].write_enabled],
      [true, true, false],
    );
    assert.equal(f.requests.length, 0);
  } finally {
    f.close();
  }
});

test('one account-metadata resolver gives list_accounts, recipe context and capabilities the same name and source', async () => {
  const f = workspace();
  try {
    const list = async args =>
      (await f.service.call('amcp_platform_workspace', {operation: 'list_accounts', arguments: args}, owner)).data;
    const listed = await list({});
    // Destinations are not advertising accounts: listed only when asked for, with no account read suggested.
    assert.equal(
      listed.some(a => a.platform === 'google_sheets_native_action'),
      false,
    );
    const sheets = await list({platform: 'sheets'});
    assert.deepEqual(
      sheets.map(a => [a.id, a.kind, a.next_call]),
      [['sheet-1', 'destination', undefined]],
    );
    const row = listed.find(a => a.connection_id === 'meta-a' && a.id === '111');
    assert.equal(row.name, 'Client account');
    assert.equal(row.kind, 'ad_account');
    assert.deepEqual(row.metadata, {source: 'cached_discovery', checked_at: new Date(1700000000000).toISOString()});
    assert.equal(row.currency, 'USD');
    assert.ok(row.next_call, 'a cached listing is not a live account read');
    const context = await f.service.call(
      'amcp_campaign',
      {action: 'recipe_context', recipe: 'meta_website_traffic'},
      owner,
    );
    const target = context.data.targets.find(t => t.connection_id === 'meta-a' && t.account_id === '111');
    assert.deepEqual([target.name, target.metadata], [row.name, row.metadata]);
    const capabilities = await f.service.call(
      'amcp_workspace',
      {action: 'capabilities', connection_id: 'meta-a', account_id: '111'},
      owner,
    );
    const account = capabilities.data.workflows.flatMap(w => w.accounts)[0];
    assert.deepEqual([account.name, account.name_source], ['Client account', 'cached_discovery']);
    const graph = await f.service.call(
      'amcp_workspace',
      {action: 'capabilities', view: 'graph', connection_id: 'meta-a', account_id: '111'},
      owner,
    );
    assert.deepEqual(graph.data.workflows.flatMap(w => w.accounts)[0].metadata, row.metadata);
    // After a live read every view shows the live values and source.
    assert.equal(
      (
        await f.service.call(
          'amcp_workspace',
          {action: 'check', connection_id: 'meta-a', account_id: '111', live: true},
          owner,
        )
      ).success,
      true,
    );
    const live = (await list({})).find(a => a.connection_id === 'meta-a' && a.id === '111');
    assert.deepEqual([live.name, live.currency, live.metadata.source], ['Live 111', 'EUR', 'live_account_read']);
    const again = await f.service.call(
      'amcp_campaign',
      {action: 'recipe_context', recipe: 'meta_website_traffic'},
      owner,
    );
    assert.deepEqual(
      again.data.targets.find(t => t.connection_id === 'meta-a' && t.account_id === '111').metadata,
      live.metadata,
    );
    // An account nothing has read yet has no name and no source.
    const unread = (await list({})).find(a => a.connection_id === 'meta-a' && a.id === '222');
    assert.deepEqual([unread.name, unread.metadata], [null, null]);
  } finally {
    f.close();
  }
});

test('check reads up to 20 accounts of one login, four at a time, and keeps a readiness record for each', async () => {
  const f = workspace();
  try {
    const ids = ['111', '222', '333', '444', '555', '666'];
    const r = await f.service.call(
      'amcp_workspace',
      {action: 'check', connection_id: 'meta-a', account_ids: ids, live: true},
      owner,
    );
    assert.equal(r.success, true, JSON.stringify(r.error));
    assert.equal(r.data.record_kind, 'readiness_batch');
    assert.deepEqual(
      r.data.results.map(x => x.account_id),
      ids,
    );
    assert.ok(r.data.results.every(x => x.live_read === true));
    assert.ok(f.peak() <= 4 && f.peak() >= 2, String(f.peak()));
    for (const id of ids)
      assert.equal(f.store.document('local', 'readiness', readinessId('meta-a', id)).account_id, id);
    const refusals = [
      {account_ids: Array.from({length: 21}, (_, i) => String(i + 1))},
      {account_ids: []},
      {account_ids: ['111', '111']},
      {account_ids: ['111'], account_id: '111'},
    ];
    const before = f.requests.length,
      // The website shows these refusals too: each has its Arabic translation (wave 2 review).
      arabic = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8')),
      translated = refusal => assert.ok(Object.hasOwn(arabic, refusal.error.message), refusal.error.message);
    for (const extra of refusals) {
      const refused = await f.service.call(
        'amcp_workspace',
        {action: 'check', connection_id: 'meta-a', live: true, ...extra},
        owner,
      );
      assertRefused(refused, 'INVALID_ARGUMENT');
      translated(refused);
    }
    const foreign = await f.service.call(
      'amcp_workspace',
      {action: 'check', connection_id: 'meta-b', account_ids: ['111', '222'], live: true},
      owner,
    );
    assert.equal(foreign.error.code, 'ACCOUNT_FORBIDDEN');
    translated(foreign);
    const missing = await f.service.call(
      'amcp_workspace',
      {action: 'check', connection_id: 'no-such-login', account_ids: ['111'], live: true},
      owner,
    );
    assertRefused(missing, 'CONNECTION_NOT_FOUND');
    translated(missing);
    const elsewhere = await f.service.call('amcp_workspace', {action: 'dashboard', account_ids: ['111']}, owner);
    assertRefused(elsewhere, 'INVALID_ARGUMENT');
    translated(elsewhere);
    assert.equal(f.requests.length, before, 'refused batches read nothing');
  } finally {
    f.close();
  }
});

// CON-03 through the website: Meta's token exchanges return no scope, so AMCP recorded the permissions it asked for as
// granted. A login that declined ads_management passed the local write gate and was refused by Meta only at execute; a
// Facebook Login for Business configuration that granted catalog_management was refused locally. Connect, sync and
// renewal now read /me/permissions once, record granted and declined permissions, and treat a failed read as unknown.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {readOnlyPolicy} from '../dist/src/preflight.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {platforms} from '../dist/server/platform-oauth.js';
import {assertMetaCatalogScope} from '../dist/src/meta-catalogs.js';
import {listenForFetch} from '../dist/tests/http-listener.js';

const key = Buffer.alloc(32, 58).toString('base64'),
  origin = 'https://amcp.shop',
  password = 'synthetic-permissions-owner',
  owner = {tenantId: 'local', userId: 'workspace-admin', role: 'admin'};
const granted = names => names.map(permission => ({permission, status: 'granted'}));
const basic = ['ads_read', 'business_management', 'pages_read_engagement', 'pages_show_list', 'public_profile'];

async function site(env = {}) {
  const store = new Store(':memory:', key),
    authEnv = {AMCP_MICROSOFT_DEVELOPER_TOKEN: 'synthetic-developer-token', ...env},
    calls = [],
    native = [],
    control = {
      permissions: granted([...basic, 'ads_management']),
      extended: {access_token: 'synthetic-meta-access', expires_in: 5184000},
      inspected: {
        data: {
          is_valid: true,
          app_id: 'synthetic-meta-client',
          type: 'USER',
          expires_at: Math.floor(Date.now() / 1000) + 7200,
        },
      },
    };
  for (const p of platforms) {
    authEnv['AMCP_' + p.env + '_CLIENT_ID'] = 'synthetic-' + p.id + '-client';
    authEnv['AMCP_' + p.env + '_CLIENT_SECRET'] = 'synthetic-' + p.id + '-secret';
  }
  const fetcher = async (input, init) => {
    const url = new URL(String(input));
    calls.push((init?.method ?? 'GET') + ' ' + url.pathname);
    assert.equal(url.origin, 'https://graph.facebook.com');
    assert.equal(init?.method ?? 'GET', 'GET', 'connecting never mutates advertising resources');
    if (url.pathname === '/v26.0/oauth/access_token')
      return Response.json(
        url.searchParams.get('grant_type') === 'fb_exchange_token'
          ? control.extended
          : {access_token: 'synthetic-meta-access', expires_in: 3600},
      );
    if (url.pathname === '/v26.0/debug_token') {
      assert.equal(url.searchParams.get('input_token'), control.extended.access_token);
      assert.equal(
        new Headers(init.headers).get('Authorization'),
        'Bearer synthetic-meta-client|synthetic-meta-secret',
      );
      return Response.json(control.inspected);
    }
    if (url.pathname === '/v26.0/me/adaccounts')
      return Response.json({
        data: [{id: 'act_111', account_id: '111', name: 'Client account', currency: 'USD', timezone_name: 'UTC'}],
      });
    if (url.pathname === '/v26.0/me') return Response.json({id: '1000001', name: 'Meta user'});
    if (url.pathname === '/v26.0/me/permissions')
      return control.permissions === 'fail'
        ? Response.json({error: {message: '(#200) Synthetic permissions error', code: 200}}, {status: 400})
        : Response.json({data: control.permissions});
    throw Error('Unexpected synthetic provider route: ' + url.pathname);
  };
  const transport = new NativeTransport(
    async (input, init) => {
      native.push((init?.method ?? 'GET') + ' ' + new URL(String(input)).pathname);
      return Response.json({id: 'act_111', name: 'Client account', account_status: 1, currency: 'USD'});
    },
    async () => {},
  );
  const service = new MirrorService(new Registry(), store, transport, undefined, {
      ...readOnlyPolicy,
      allowWrites: true,
    }),
    listener = await listenForFetch(
      createHttpApp(service, store, {website: {origin, masterKey: key, adminPassword: password, fetcher, authEnv}}),
    ),
    base = 'http://127.0.0.1:' + listener.address().port;
  const request = async (path, method = 'GET', body, headers = {}) => {
    const r = await fetch(base + path, {
      method,
      redirect: 'manual',
      headers: {Origin: origin, ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...headers},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return new Response(await r.arrayBuffer(), {status: r.status, headers: r.headers});
  };
  const login = await request('/api/session', 'POST', {password}),
    headers = {Cookie: login.headers.get('set-cookie').split(';')[0], 'X-AMCP-CSRF': (await login.json()).csrf};
  const connect = async () => {
    const started = await request('/api/auth/meta/start', 'POST', {}, headers);
    assert.equal(started.status, 200, await started.clone().text());
    const body = await started.json(),
      url = new URL(body.url);
    const returned = await request(
      '/api/auth/meta/callback?' + new URLSearchParams({state: url.searchParams.get('state'), code: 'code'}),
      'GET',
      undefined,
      headers,
    );
    assert.equal(returned.status, 303);
    const progress = await (await request('/api/oauth/progress/' + body.attemptId, 'GET', undefined, headers)).json();
    return {url, progress, connection: store.listConnections('local').find(c => c.id === progress.connectionId)};
  };
  // Selecting the account with reviewed writes, as the Connections dialog does.
  const select = c => {
    store.updateConnection(owner, {...c, accounts: ['111'], writeAccounts: ['111'], enabled: true});
    return store.listConnections('local').find(x => x.id === c.id);
  };
  const call = (tool, input) => service.call(tool, input, owner);
  const writeCheck = async c =>
    (
      await call('amcp_workspace', {
        action: 'check',
        connection_id: c.id,
        account_id: '111',
        requirements: {write: true},
      })
    ).data.checks.find(x => x.key === 'provider_scopes');
  return {
    store,
    calls,
    native,
    control,
    request,
    headers,
    connect,
    select,
    call,
    writeCheck,
    close: async () => {
      const end = new Promise(r => listener.close(() => r()));
      listener.closeAllConnections();
      await end;
      store.close();
    },
  };
}

test('Meta callbacks secure and discover tokens with inspected expiry, including non-expiring user and system tokens', async () => {
  const future = Math.floor(Date.now() / 1000) + 7200;
  for (const [mode, inspected] of [
    ['token-expiry', {type: 'USER', expires_at: future}],
    ['data-access-expiry', {type: 'USER', expires_at: 0, data_access_expires_at: future}],
    ['non-expiring-user', {type: 'USER', expires_at: 0, data_access_expires_at: 0}],
    ['non-expiring-system', {type: 'SYSTEM_USER', expires_at: 0, data_access_expires_at: 0}],
  ]) {
    const nonExpiring = mode.startsWith('non-expiring'),
      s = await site({AMCP_META_CONFIG_ID: 'synthetic-business-config'});
    s.control.extended = {access_token: 'synthetic-meta-access'};
    s.control.inspected.data = {...s.control.inspected.data, ...inspected};
    try {
      const {url, progress, connection} = await s.connect();
      assert.equal(url.searchParams.get('config_id'), 'synthetic-business-config');
      assert.equal(progress.state, 'complete', JSON.stringify(progress));
      assert.equal(progress.authorization, true);
      assert.equal(progress.exchange, true);
      assert.equal(progress.sync, true);
      assert.ok(connection);
      const credentials = s.store.credentials('local', connection.id);
      assert.equal(credentials.accessToken, 'synthetic-meta-access');
      if (nonExpiring) assert.equal(Object.hasOwn(credentials, 'expiresAt'), false);
      else {
        assert.ok(credentials.expiresAt > Date.now());
        assert.ok(credentials.expiresAt <= future * 1000);
      }
      const listed = await (await s.request('/api/platforms', 'GET', undefined, s.headers)).json();
      const shown = listed.platforms.find(p => p.id === 'meta').connections[0];
      assert.equal(shown.credentialHealth.state, nonExpiring ? 'healthy' : 'expiring');
      assert.equal(shown.credentialHealth.access_expires_at, credentials.expiresAt ?? null);
      assert.doesNotMatch(
        JSON.stringify({progress, listed, audit: s.store.audit('local')}),
        /synthetic-meta-access|synthetic-meta-secret/,
      );
      assert.equal(s.calls.filter(c => c.endsWith('/debug_token')).length, 1);
      assert.equal(s.native.length, 0, 'only OAuth and discovery reads, no advertising operations');
    } finally {
      await s.close();
    }
  }
});

test('an unverified Meta token fails before storage and preserves an existing selected login', async () => {
  const s = await site();
  try {
    const first = await s.connect(),
      selected = s.select(first.connection),
      before = s.store.credentials('local', selected.id);
    s.control.extended = {access_token: 'synthetic-unverified-token'};
    s.control.inspected.data.app_id = 'foreign-app';
    const next = await s.connect();
    assert.equal(next.progress.state, 'failed');
    assert.equal(next.progress.authorization, true);
    assert.equal(next.progress.exchange, false);
    assert.equal(next.progress.sync, false);
    assert.equal(next.progress.message, 'Meta did not return a valid long-lived token and lifetime.');
    assert.equal(s.store.listConnections('local').length, 1);
    assert.deepEqual(s.store.credentials('local', selected.id), before);
    assert.deepEqual(s.store.listConnections('local')[0].accounts, ['111']);
    assert.doesNotMatch(JSON.stringify(next.progress), /synthetic-unverified-token|synthetic-meta-secret/);
  } finally {
    await s.close();
  }
});

test('a Meta login that declined ads_management records only granted permissions and refuses a write before Meta', async () => {
  const s = await site();
  s.control.permissions = [...granted(basic), {permission: 'ads_management', status: 'declined'}];
  try {
    const {url, progress, connection} = await s.connect();
    assert.match(url.searchParams.get('scope'), /ads_management/, 'writes are enabled, so ads_management is requested');
    assert.equal(progress.state, 'complete', progress.message);
    assert.deepEqual(connection.scopes, basic, 'the requested ads_management is not recorded as granted');
    assert.equal(s.calls.filter(c => c.endsWith('/me/permissions')).length, 1, 'one permissions read per connect');
    const record = s.store.document('local', 'website_connection', connection.id);
    assert.deepEqual(record.grants.declined, ['ads_management']);
    assert.equal(record.grants.known, true);
    const listed = await (await s.request('/api/platforms', 'GET', undefined, s.headers)).json(),
      shown = listed.platforms.find(p => p.id === 'meta').connections[0];
    assert.deepEqual(shown.grants.declined, ['ads_management']);
    assert.ok(!JSON.stringify(listed).includes('synthetic-meta-access'));
    const c = s.select(connection);
    const scopes = await s.writeCheck(c);
    assert.equal(scopes.status, 'blocked');
    assert.deepEqual(scopes.declined_scopes, ['ads_management']);
    assert.match(scopes.next_step, /^Reauthorize this login from Connections/);
    const capabilities = await s.call('amcp_workspace', {
      action: 'capabilities',
      workflow_id: 'recipe:meta_website_traffic',
    });
    assert.ok(capabilities.data.workflows[0].accounts[0].blockers.includes('provider_scope_declined:ads_management'));
    // A reviewed write that enforces ads_management refuses at prepare, before any provider request.
    const prepared = await s.call('amcp_write', {
      action: 'prepare',
      gateway: 'meta_native_action',
      arguments: {
        action: 'meta_ad_account_id_create',
        account_id: '111',
        params: {ad_account_id: 'act_111'},
        payload: {name: 'Renamed'},
      },
    });
    assert.equal(prepared.error?.code, 'INSUFFICIENT_SCOPE', JSON.stringify(prepared).slice(0, 600));
    assert.deepEqual(s.native, [], 'no provider request at all');
  } finally {
    await s.close();
  }
});

test('Facebook Login for Business: the configuration grant of catalog_management passes the catalog gate', async () => {
  const s = await site({AMCP_META_CONFIG_ID: 'synthetic-configuration'});
  s.control.permissions = granted([...basic, 'ads_management', 'catalog_management']);
  try {
    const {url, progress, connection} = await s.connect();
    assert.equal(url.searchParams.get('config_id'), 'synthetic-configuration');
    assert.equal(progress.state, 'complete', progress.message);
    assert.ok(connection.scopes.includes('catalog_management'));
    assertMetaCatalogScope(connection, true, 'Product sets');
    assert.equal((await s.writeCheck(s.select(connection))).status, 'passed');
  } finally {
    await s.close();
  }
});

test('a failed permissions read still connects, records unknown, and a later sync records the real grant', async () => {
  const s = await site();
  s.control.permissions = 'fail';
  try {
    const {progress, connection} = await s.connect();
    assert.equal(progress.state, 'complete', 'a failed permissions read does not block connecting');
    const record = s.store.document('local', 'website_connection', connection.id);
    assert.equal(record.grants.known, false);
    // Meta code 200 is its documented permission error, classified by the provider-error taxonomy (PRV-01).
    assert.equal(record.grants.reason, 'PROVIDER_PERMISSION_MISSING');
    let c = s.select(connection);
    let scopes = await s.writeCheck(c);
    assert.equal(scopes.status, 'unknown', 'requested permissions are never reported as granted');
    assert.equal(scopes.known, false);
    s.control.permissions = [...granted(basic), {permission: 'ads_management', status: 'declined'}];
    const synced = await s.request('/api/connections/' + c.id + '/sync', 'POST', {}, s.headers);
    assert.equal(synced.status, 200, await synced.clone().text());
    c = s.store.listConnections('local').find(x => x.id === c.id);
    assert.ok(!c.scopes.includes('ads_management'));
    assert.deepEqual(c.accounts, ['111'], 'the sync keeps the selection');
    scopes = await s.writeCheck(c);
    assert.equal(scopes.status, 'blocked');
    assert.equal(s.calls.filter(x => x.endsWith('/me/permissions')).length, 2);
  } finally {
    await s.close();
  }
});

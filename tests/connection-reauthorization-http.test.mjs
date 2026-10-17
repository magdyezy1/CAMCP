// CON-02 through the website: Reauthorize exists for every browser-OAuth login, renews it in place through the
// session-bound OAuth state, and Connections tells the truth about a dead or expiring login. Before this, the route
// refused every platform but Google Ads ("Use Connect another") and a rejected login still read "Connected".
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {readOnlyPolicy} from '../dist/src/preflight.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {platforms} from '../dist/server/platform-oauth.js';
import {recordAuthorized} from '../dist/src/connection-health.js';
import {listenForFetch} from '../dist/tests/http-listener.js';

const key = Buffer.alloc(32, 57).toString('base64'),
  origin = 'https://amcp.shop',
  password = 'synthetic-reauthorization-owner',
  owner = {tenantId: 'local', userId: 'workspace-admin', role: 'admin'},
  day = 86400000;
const metaLogin = {
    id: 'meta-login',
    tenantId: 'local',
    gateway: 'meta_native_action',
    label: 'Saved Meta login',
    enabled: true,
    isDefault: true,
    accounts: ['111'],
    writeAccounts: ['111'],
    defaultWriteAccess: true,
    scopes: ['ads_read', 'pages_show_list', 'pages_read_engagement', 'business_management', 'ads_management'],
  },
  linkedinLogin = {
    id: 'linkedin-login',
    tenantId: 'local',
    gateway: 'linkedin_native_action',
    label: 'Saved LinkedIn login',
    enabled: true,
    isDefault: true,
    accounts: ['559535022'],
    writeAccounts: [],
    scopes: ['r_ads', 'r_ads_reporting'],
  };

async function site(env = {}) {
  const store = new Store(':memory:', key),
    authEnv = {AMCP_MICROSOFT_DEVELOPER_TOKEN: 'synthetic-developer-token', ...env},
    calls = [];
  for (const p of platforms) {
    authEnv['AMCP_' + p.env + '_CLIENT_ID'] = 'synthetic-' + p.id + '-client';
    authEnv['AMCP_' + p.env + '_CLIENT_SECRET'] = 'synthetic-' + p.id + '-secret';
  }
  // Meta's long-lived login expires in five days: it cannot renew itself and must read "expiring".
  store.putConnection(owner, metaLogin, {accessToken: 'old-meta-access', expiresAt: Date.now() + 5 * day});
  store.putConnection(owner, linkedinLogin, {accessToken: 'old-linkedin-access', expiresAt: Date.now() + 30 * day});
  for (const c of [metaLogin, linkedinLogin]) {
    store.putDocument('local', 'website_connection', c.id, {platform: c.gateway.split('_')[0], createdAt: 1});
    store.putDocument('local', 'reporting_query', 'query-' + c.id, {connection_id: c.id, account_id: c.accounts[0]});
    recordAuthorized(
      store,
      store.listConnections('local').find(x => x.id === c.id),
      store.credentials('local', c.id),
    );
  }
  store.putDocument('local', 'website_connection', metaLogin.id, {platform: 'meta', providerId: '1000001'});
  const fetcher = async (input, init) => {
    const url = new URL(String(input));
    calls.push((init?.method ?? 'GET') + ' ' + url.origin + url.pathname);
    if (url.origin === 'https://graph.facebook.com') {
      assert.equal(init?.method ?? 'GET', 'GET', 'renewal never mutates advertising resources');
      if (url.pathname === '/v26.0/oauth/access_token')
        return Response.json({access_token: 'fresh-meta-access', expires_in: 5184000});
      assert.equal(new URL(String(input)).searchParams.get('access_token') ?? 'fresh-meta-access', 'fresh-meta-access');
      if (url.pathname === '/v26.0/me/adaccounts')
        return Response.json({
          data: [{id: 'act_111', account_id: '111', name: 'Client account', currency: 'USD', timezone_name: 'UTC'}],
        });
      if (url.pathname === '/v26.0/me') return Response.json({id: env.metaUser ?? '1000001', name: 'Meta user'});
    }
    if (url.href === 'https://www.linkedin.com/oauth/v2/accessToken')
      return Response.json({
        access_token: 'fresh-linkedin-access',
        expires_in: 5184000,
        scope: 'r_ads,r_ads_reporting',
      });
    if (url.origin === 'https://api.linkedin.com') {
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fresh-linkedin-access');
      if (url.pathname === '/rest/adAccountUsers')
        return Response.json({elements: [{account: 'urn:li:sponsoredAccount:559535022', role: 'VIEWER'}]});
      if (url.pathname === '/rest/adAccounts/559535022')
        return Response.json({id: 559535022, name: 'LinkedIn client', currency: 'USD', status: 'ACTIVE'});
    }
    throw Error('Unexpected synthetic provider route: ' + url.origin + url.pathname);
  };
  const service = new MirrorService(new Registry(), store, undefined, undefined, {
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
  const listed = async () => (await (await request('/api/platforms', 'GET', undefined, headers)).json()).platforms;
  return {
    store,
    calls,
    request,
    headers,
    listed,
    close: async () => {
      const end = new Promise(r => listener.close(() => r()));
      listener.closeAllConnections();
      await end;
      store.close();
    },
  };
}
const renew = async (s, connection, platform) => {
  const started = await s.request('/api/connections/' + connection + '/reauthorize', 'POST', {}, s.headers);
  assert.equal(started.status, 200);
  const body = await started.json(),
    url = new URL(body.url);
  const returned = await s.request(
    '/api/auth/' + platform + '/callback?' + new URLSearchParams({state: url.searchParams.get('state'), code: 'code'}),
    'GET',
    undefined,
    s.headers,
  );
  assert.equal(returned.status, 303);
  return {
    url,
    progress: await (await s.request('/api/oauth/progress/' + body.attemptId, 'GET', undefined, s.headers)).json(),
  };
};

test('Connections offers Reauthorize for every OAuth login and shows truthful expiry and health', async () => {
  const s = await site();
  try {
    const all = await s.listed();
    for (const p of all) {
      const offered = !p.authType;
      if (p.connections.length) for (const c of p.connections) assert.equal(c.reauthorizeAvailable, offered, p.id);
    }
    const meta = all.find(p => p.id === 'meta').connections[0],
      linkedin = all.find(p => p.id === 'linkedin').connections[0];
    assert.equal(meta.status, 'expiring_soon');
    assert.equal(meta.credentialHealth.state, 'expiring');
    assert.equal(meta.credentialHealth.renews_automatically, false);
    assert.ok(meta.expiresAt > Date.now() && meta.expiresAt < Date.now() + 6 * day);
    assert.equal(linkedin.status, 'connected');
    assert.ok(!JSON.stringify(all).includes('old-meta-access'));
    // A login the provider rejected is never shown as Connected.
    const c = s.store.listConnections('local').find(x => x.id === linkedinLogin.id);
    s.store.putDocument('local', 'connection_health', c.id, {
      connection_id: c.id,
      login_revision: c.loginRevision ?? 0,
      login_id: c.loginId,
      state: 'reauthorization_required',
      last_failure: {code: 'invalid_grant', http_status: 400, at: Date.now()},
    });
    const dead = (await s.listed()).find(p => p.id === 'linkedin').connections[0];
    assert.equal(dead.status, 'reauthorization_required');
    assert.equal(dead.credentialHealth.last_failure.code, 'invalid_grant');
    // An administrator's Retry clears the recorded rejection (session, CSRF and admin required) and is audited.
    assert.equal((await s.request('/api/connections/' + c.id + '/credential-retry', 'POST', {})).status, 401);
    const retried = await (
      await s.request('/api/connections/' + c.id + '/credential-retry', 'POST', {}, s.headers)
    ).json();
    assert.equal(retried.retry, true);
    assert.equal(retried.status, 'connected');
    assert.equal(
      s.store.audit('local').filter(r => JSON.parse(r.event).event === 'website_credential_retry').length,
      1,
    );
    assert.equal(s.calls.length, 0, 'listing, health and Retry contact no provider');
  } finally {
    await s.close();
  }
});

test('a saved login this server cannot decrypt reads as an operator problem, not a dead login (regression)', async () => {
  const s = await site();
  try {
    // As after a changed MIRROR_MASTER_KEY: the stored secret no longer opens with this server's key.
    s.store.db
      .prepare(
        "UPDATE connections SET secret='v2:AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA==.AAAA' WHERE tenant_id=? AND id=?",
      )
      .run('local', linkedinLogin.id);
    const unreadable = (await s.listed()).find(p => p.id === 'linkedin').connections[0];
    assert.equal(unreadable.credentialHealth.state, 'credentials_unreadable');
    assert.equal(unreadable.status, 'attention', 'not reauthorization_required: every login would read dead');
    const meta = (await s.listed()).find(p => p.id === 'meta').connections[0];
    assert.equal(meta.status, 'expiring_soon', 'other logins are unaffected');
    assert.equal(s.calls.length, 0);
  } finally {
    await s.close();
  }
});

test('Meta and LinkedIn renew in place: same connection id, selections and saved query; rerequest for Meta', async () => {
  const s = await site();
  try {
    const query = s.store.document('local', 'reporting_query', 'query-' + metaLogin.id);
    const meta = await renew(s, metaLogin.id, 'meta');
    assert.equal(meta.url.searchParams.get('auth_type'), 'rerequest');
    assert.equal(meta.progress.state, 'complete', meta.progress.message);
    assert.equal(meta.progress.connectionId, metaLogin.id);
    assert.equal(s.store.credentials('local', metaLogin.id).accessToken, 'fresh-meta-access');
    const renewed = s.store.listConnections('local').find(c => c.id === metaLogin.id);
    assert.deepEqual(renewed.accounts, ['111']);
    assert.deepEqual(renewed.writeAccounts, ['111']);
    assert.deepEqual(s.store.document('local', 'reporting_query', 'query-' + metaLogin.id), query);
    const linkedin = await renew(s, linkedinLogin.id, 'linkedin');
    assert.equal(linkedin.progress.state, 'complete', linkedin.progress.message);
    assert.equal(s.store.credentials('local', linkedinLogin.id).accessToken, 'fresh-linkedin-access');
    assert.equal(s.store.listConnections('local').length, 2, 'no second connection was created');
    const after = (await s.listed()).find(p => p.id === 'meta').connections[0];
    assert.equal(after.status, 'connected', 'the renewed 60-day login no longer reads expiring');
    const audit = s.store.audit('local').map(r => JSON.parse(r.event));
    assert.deepEqual(
      audit.filter(e => e.event === 'website_oauth_reauthorized').map(e => [e.platform, e.connection_id]),
      [
        ['meta', metaLogin.id],
        ['linkedin', linkedinLogin.id],
      ],
    );
    assert.ok(s.calls.every(c => c.startsWith('GET ') || c.includes('/oauth/v2/accessToken')));
  } finally {
    await s.close();
  }
});

test('a different Meta user is refused and the rollback flag restores Connect another', async () => {
  const s = await site({metaUser: '2000002'});
  try {
    const refused = await renew(s, metaLogin.id, 'meta');
    assert.equal(refused.progress.state, 'failed');
    assert.match(refused.progress.message, /different provider user/);
    assert.equal(s.store.credentials('local', metaLogin.id).accessToken, 'old-meta-access');
  } finally {
    await s.close();
  }
  const off = await site({AMCP_REAUTHORIZATION_DISABLED: 'meta,linkedin'});
  try {
    const r = await off.request('/api/connections/' + metaLogin.id + '/reauthorize', 'POST', {}, off.headers);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error.code, 'REAUTHORIZATION_UNAVAILABLE');
    assert.equal((await off.listed()).find(p => p.id === 'meta').connections[0].reauthorizeAvailable, false);
  } finally {
    await off.close();
  }
});

test('a reauthorization state started for one platform cannot complete on another platform route', async () => {
  const s = await site();
  try {
    const started = await (
      await s.request('/api/connections/' + metaLogin.id + '/reauthorize', 'POST', {}, s.headers)
    ).json();
    const state = new URL(started.url).searchParams.get('state');
    const r = await s.request(
      '/api/auth/linkedin/callback?' + new URLSearchParams({state, code: 'code'}),
      'GET',
      undefined,
      s.headers,
    );
    assert.equal(r.status, 400);
    assert.equal(s.calls.length, 0);
    assert.equal(s.store.credentials('local', metaLogin.id).accessToken, 'old-meta-access');
  } finally {
    await s.close();
  }
});

test('Connections copy: renewal line instead of the first token expiry, Reauthorize as the primary action when dead', () => {
  const app = readFileSync('web/app.js', 'utf8'),
    esc = v =>
      String(v ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    context = createContext({document: {addEventListener() {}}, esc, date: () => 'Synthetic date'});
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  for (const name of ['loginHealthLine', 'renderCredentialHealth']) {
    const start = app.indexOf('function ' + name + '('),
      end = app.indexOf('\n}', start) + 2;
    new Script(app.slice(start, end)).runInContext(context);
  }
  const render = (fn, value) => {
    context.value = value;
    // Markup helpers return escape-by-default html`…` (WEB-07); the page writes it as its markup string.
    return new Script('String(' + fn + '(value))').runInContext(context);
  };
  const healthy = {
    id: 'a',
    reauthorizeAvailable: true,
    credentialHealth: {state: 'healthy', renews_automatically: true},
  };
  assert.equal(render('loginHealthLine', healthy), 'Access renews automatically');
  assert.equal(render('renderCredentialHealth', healthy), '');
  assert.match(
    render('loginHealthLine', {credentialHealth: {state: 'healthy', login_expires_at: 1}}),
    /^Login expires Synthetic date$/,
  );
  const dead = {
    id: 'li"<x>',
    reauthorizeAvailable: true,
    credentialHealth: {
      state: 'reauthorization_required',
      last_failure: {code: 'invalid_grant', http_status: 400, at: 1},
    },
  };
  const html = render('renderCredentialHealth', dead);
  assert.match(html, /Reauthorization required/);
  assert.match(html, /class="button small primary" data-reauthorize="li&quot;&lt;x&gt;"/);
  assert.match(html, /data-credential-retry=/);
  assert.match(html, /HTTP 400 · invalid_grant/);
  assert.ok(!html.includes('<x>'));
  // A login the server cannot open names the operator fix and does not make Reauthorize the primary action.
  const unreadable = render('renderCredentialHealth', {
    id: 'u',
    reauthorizeAvailable: true,
    credentialHealth: {state: 'credentials_unreadable'},
  });
  assert.match(unreadable, /Saved login cannot be read by this server/);
  assert.match(unreadable, /encryption key/);
  assert.doesNotMatch(unreadable, /button small primary/);
  assert.ok(app.includes('encodeURIComponent(el.dataset.credentialRetry)'), 'connection IDs are encoded in paths');
  assert.ok(app.includes('encodeURIComponent(el.dataset.reauthorize)'));
  assert.doesNotMatch(app, /Token expires/);
  assert.doesNotMatch(app, /p\.id === 'google' \? `<button class="button small" data-reauthorize/);
});

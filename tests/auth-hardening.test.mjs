import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {sha256} from '../dist/src/security.js';
import {WebStore} from '../dist/server/web-store.js';
import {UserAccounts, hashUserPassword} from '../dist/server/user-accounts.js';
import {AccountSecurity, totp} from '../dist/server/account-security.js';
import {McpOAuth} from '../dist/server/mcp-oauth.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';

const password = 'a-long-test-passphrase',
  master = Buffer.alloc(32, 84).toString('base64'),
  origin = 'https://amcp.shop';
function fixture(options = {}) {
  const store = new Store(':memory:', master);
  const web = new WebStore(store, {
    origin,
    masterKey: master,
    adminPassword: password,
    authEnv: {},
    fetcher: async () => new Response('{"id":"mail"}', {headers: {'Content-Type': 'application/json'}}),
    ...options,
  });
  const accounts = new UserAccounts(web),
    security = new AccountSecurity(accounts);
  const req = (s, address = '127.0.0.1') => ({
    headers: {origin: web.origin, ...(s ? {cookie: web.cookie(s.id), 'x-amcp-csrf': s.csrf} : {})},
    socket: {remoteAddress: address},
    get: h => (h.toLowerCase() === 'origin' ? web.origin : undefined),
  });
  return {store, web, accounts, security, req};
}

test('switching workspace keeps the original sign-in time, so recent-sign-in checks still apply', async () => {
  const f = fixture();
  try {
    const u = f.accounts.newUser('Person', 'person@example.test', await hashUserPassword(password), true),
      s = f.accounts.session(u);
    // The session is 16 minutes old: account changes need a fresh sign-in.
    const row = f.store.db.prepare('SELECT actor FROM amcp_web_sessions WHERE hash=?').get(sha256(s.id)),
      actor = JSON.parse(row.actor);
    f.store.db
      .prepare('UPDATE amcp_web_sessions SET actor=? WHERE hash=?')
      .run(JSON.stringify({...actor, signedInAt: Date.now() - 16 * 60000}), sha256(s.id));
    assert.throws(() => f.accounts.fresh(s), {code: 'REAUTH_REQUIRED'});
    const switched = f.security.switchWorkspace(f.req(s), {workspaceId: u.tenant_id});
    assert.throws(() => f.accounts.fresh(switched), {code: 'REAUTH_REQUIRED'});
  } finally {
    f.store.close();
  }
});

test('two-step codes are limited per person as well as per address', async () => {
  const f = fixture();
  try {
    const u = f.accounts.newUser('MFA person', 'mfa-limit@example.test', await hashUserPassword(password), true),
      s = f.accounts.session(u),
      setup = f.security.beginMfa(f.req(s));
    f.security.enableMfa(f.req(s), {ticket: setup.ticket, code: totp(setup.secret)});
    const login = await f.accounts.login(f.req(undefined, '198.51.100.1'), {email: u.email, password});
    assert.ok('mfaRequired' in login);
    for (let i = 0; i < 5; i++)
      assert.throws(
        () => f.security.finishMfa(f.req(undefined, '203.0.113.' + (10 + i)), {ticket: login.ticket, code: '000000'}),
        e => e.code !== 'LOGIN_RATE_LIMIT',
      );
    // A sixth guess from yet another address is refused before the code is checked, even with the right code.
    assert.throws(
      () => f.security.finishMfa(f.req(undefined, '203.0.113.99'), {ticket: login.ticket, code: totp(setup.secret)}),
      {code: 'LOGIN_RATE_LIMIT'},
    );
  } finally {
    f.store.close();
  }
});

test('successful sign-ins do not count toward the per-account lockout', async () => {
  const f = fixture();
  try {
    const u = f.accounts.newUser('Frequent', 'frequent@example.test', await hashUserPassword(password), true);
    for (let i = 0; i < 12; i++) {
      const s = await f.accounts.login(f.req(undefined, '192.0.2.' + (i + 1)), {email: u.email, password});
      assert.equal(s.actor.userId, u.id);
    }
    // Failures still count per account.
    for (let i = 0; i < 10; i++)
      await assert.rejects(
        () =>
          f.accounts.login(f.req(undefined, '192.0.2.' + (100 + i)), {email: u.email, password: 'wrong-password-here'}),
        {code: 'INVALID_LOGIN'},
      );
    // SEC-03 liveness pair. This assertion used to encode the defect: after anyone's ten failures the person could not
    // sign in anywhere. A browser without a known-device cookie of the person is still refused...
    await assert.rejects(() => f.accounts.login(f.req(undefined, '192.0.2.200'), {email: u.email, password}), {
      code: 'LOGIN_RATE_LIMIT',
    });
    // ...but the browser the person already signed in with keeps its own budget and signs in.
    const device = f.accounts.deviceCookie(f.accounts.user(u.id)).split(';')[0],
      known = {...f.req(undefined, '192.0.2.201'), headers: {origin: f.web.origin, cookie: device}};
    assert.equal((await f.accounts.login(known, {email: u.email, password})).actor.userId, u.id);
  } finally {
    f.store.close();
  }
});

test('one IPv6 /64 shares one rate-limit key', async () => {
  const f = fixture();
  try {
    const a = f.web.limitAddress(f.req(undefined, '2001:db8:1:2:aaaa::1')),
      b = f.web.limitAddress(f.req(undefined, '2001:db8:1:2:bbbb:cccc:dddd:eeee')),
      c = f.web.limitAddress(f.req(undefined, '2001:db8:1:3::1'));
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.equal(f.web.limitAddress(f.req(undefined, '192.0.2.7')), '192.0.2.7');
  } finally {
    f.store.close();
  }
});

test('abandoned client registrations older than a day are released before the registration cap applies', async () => {
  const f = fixture();
  try {
    const provider = new McpOAuth(f.web, false),
      old = Math.floor(Date.now() / 1000) - 2 * 86400,
      insert = f.store.db.prepare('INSERT INTO amcp_mcp_clients VALUES(?,?)');
    for (let i = 0; i < 1000; i++)
      insert.run(
        'old-' + i,
        JSON.stringify({client_id: 'old-' + i, client_id_issued_at: old, redirect_uris: ['https://client.example/cb']}),
      );
    f.store.db
      .prepare('INSERT INTO amcp_mcp_grants VALUES(?,?,?,?,?,?,0)')
      .run('grant-hash', 'code', 'old-7', f.web.tenantId, '{}', Date.now() + 60000);
    const client = await provider.clientsStore.registerClient({
      redirect_uris: ['https://client.example/cb'],
      token_endpoint_auth_method: 'none',
    });
    assert.ok(client.client_id);
    const kept = f.store.db
      .prepare("SELECT id FROM amcp_mcp_clients WHERE id LIKE 'old-%'")
      .all()
      .map(r => r.id);
    assert.deepEqual(kept, ['old-7']);
  } finally {
    f.store.close();
  }
});

test('OAuth endpoint limits follow the resolved client address and every response carries transport headers', async () => {
  const store = new Store(':memory:', master),
    service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(async () => {
        throw Error('No provider traffic');
      }),
    );
  const listener = await listenForFetch(
    createHttpApp(service, store, {
      publicOrigin: origin,
      website: {origin, masterKey: master, adminPassword: password, trustedProxyCidrs: ['127.0.0.1/32'], authEnv: {}},
    }),
  );
  const base = 'http://127.0.0.1:' + listener.address().port;
  const register = from =>
    fetch(base + '/register', {
      method: 'POST',
      headers: {'content-type': 'application/json', 'x-forwarded-for': from},
      body: JSON.stringify({redirect_uris: ['https://client.example/cb'], token_endpoint_auth_method: 'none'}),
    });
  try {
    let limited = false;
    for (let i = 0; i < 25 && !limited; i++) limited = (await register('198.51.100.20')).status === 429;
    assert.equal(limited, true, 'one client address reaches the registration limit');
    assert.notEqual(
      (await register('198.51.100.21')).status,
      429,
      'another client address is not limited by the first',
    );
    for (const path of ['/mcp', '/missing-page']) {
      const r = await fetch(base + path);
      assert.equal(r.headers.get('strict-transport-security'), 'max-age=31536000', path);
      assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin', path);
      assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin', path);
    }
  } finally {
    await new Promise(r => listener.close(r));
    store.close();
  }
});

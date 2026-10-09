// SEC-01: client addresses behind Cloudflare -> Railway, and /token limits that count failures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {sha256} from '../dist/src/security.js';
import {ownerOperations} from '../dist/src/owner-operations.js';
import {WebStore, clientAddressResolver, clientIpSource, cloudflareAddress} from '../dist/server/web-store.js';
import {UserAccounts, hashUserPassword} from '../dist/server/user-accounts.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';

const password = 'a-long-test-passphrase',
  master = Buffer.alloc(32, 85).toString('base64'),
  origin = 'https://amcp.shop',
  cloudflareEdge = '172.64.10.20',
  cloudflareEdgeV6 = '2606:4700:10::6816:1';
const req = (headers = {}, peer = '10.250.0.5') => ({socket: {remoteAddress: peer}, headers});

test('the railway profile gives each X-Real-IP its own key and falls back to the socket for a bad header', () => {
  const resolve = clientAddressResolver([], 'railway');
  assert.equal(resolve(req({'x-real-ip': '198.51.100.1'})), '198.51.100.1');
  assert.equal(resolve(req({'x-real-ip': '198.51.100.2'})), '198.51.100.2');
  assert.equal(resolve(req({'x-real-ip': ' ::ffff:198.51.100.3 '})), '198.51.100.3');
  for (const malformed of [undefined, '', 'unknown', '198.51.100.1, 203.0.113.9', '198.51.100.1:443', ['198.51.100.1']])
    assert.equal(resolve(req({'x-real-ip': malformed})), '10.250.0.5', String(malformed));
  // X-Forwarded-For is never read by this profile.
  assert.equal(resolve(req({'x-forwarded-for': '203.0.113.50'})), '10.250.0.5');
});

test('railway+cloudflare honors CF-Connecting-IP only from a Cloudflare edge address', () => {
  const resolve = clientAddressResolver([], 'railway+cloudflare');
  assert.equal(cloudflareAddress(cloudflareEdge), true);
  assert.equal(cloudflareAddress(cloudflareEdgeV6), true);
  assert.equal(cloudflareAddress('203.0.113.9'), false);
  assert.equal(resolve(req({'x-real-ip': cloudflareEdge, 'cf-connecting-ip': '198.51.100.7'})), '198.51.100.7');
  assert.equal(resolve(req({'x-real-ip': cloudflareEdgeV6, 'cf-connecting-ip': '2001:db8:5::9'})), '2001:db8:5::9');
  // A request that reached Railway directly cannot choose its address with a forged CF-Connecting-IP.
  assert.equal(resolve(req({'x-real-ip': '203.0.113.9', 'cf-connecting-ip': '198.51.100.7'})), '203.0.113.9');
  // A malformed CF-Connecting-IP keeps the coarse but honest Cloudflare address; no X-Real-IP keeps the socket.
  assert.equal(resolve(req({'x-real-ip': cloudflareEdge, 'cf-connecting-ip': '1.2.3.4, 5.6.7.8'})), cloudflareEdge);
  assert.equal(resolve(req({'cf-connecting-ip': '198.51.100.7'})), '10.250.0.5');
});

test('the socket profile ignores every header, and an unknown profile stops start-up', () => {
  const resolve = clientAddressResolver(['10.0.0.0/8'], 'socket');
  assert.equal(
    resolve(req({'x-forwarded-for': '203.0.113.1', 'x-real-ip': '203.0.113.2', 'cf-connecting-ip': '203.0.113.3'})),
    '10.250.0.5',
  );
  for (const unknown of ['railway-cloudflare', 'cloudflare', 'XFF', ''])
    assert.throws(() => clientIpSource(unknown), /AMCP_CLIENT_IP_SOURCE/);
  const store = new Store(':memory:', master);
  try {
    assert.throws(() => new WebStore(store, {origin, masterKey: master, clientIpSource: 'cloudflare'}));
    // Unset keeps the earlier behavior: X-Forwarded-For through trusted CIDRs, else the socket.
    assert.equal(new WebStore(store, {origin, masterKey: master}).clientIpSource, 'socket');
    assert.equal(
      new WebStore(store, {origin, masterKey: master, trustedProxyCidrs: ['10.0.0.0/8']}).clientIpSource,
      'xff-cidrs',
    );
  } finally {
    store.close();
  }
});

test('the committed Cloudflare range snapshot matches its generated module (offline check)', () => {
  const output = execFileSync(process.execPath, ['tools/cloudflare-ranges.mjs', '--check'], {encoding: 'utf8'});
  assert.match(output, /"checked":"server\/cloudflare-ranges\.ts"/);
});

test('ten failed sign-ins from network A do not block a correct sign-in from network B (railway profile)', async () => {
  // Before SEC-01 every request behind Railway resolved to the proxy's address, so A's failures refused B.
  const store = new Store(':memory:', master);
  try {
    const web = new WebStore(store, {origin, masterKey: master, authEnv: {}, clientIpSource: 'railway'}),
      accounts = new UserAccounts(web),
      user = accounts.newUser('Bystander', 'bystander@example.test', await hashUserPassword(password), true),
      from = address => ({...req({'x-real-ip': address, origin}), get: () => origin});
    for (let i = 0; i < 10; i++)
      await assert.rejects(
        () => accounts.login(from('198.51.100.66'), {email: 'other' + i + '@example.test', password: 'wrong-password'}),
        {code: 'INVALID_LOGIN'},
      );
    await assert.rejects(() => accounts.login(from('198.51.100.66'), {email: user.email, password}), {
      code: 'LOGIN_RATE_LIMIT',
    });
    const session = await accounts.login(from('203.0.113.77'), {email: user.email, password});
    assert.equal(session.actor.userId, user.id);
  } finally {
    store.close();
  }
});

async function tokenSite() {
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
      website: {origin, masterKey: master, adminPassword: password, authEnv: {}},
    }),
  );
  const base = 'http://127.0.0.1:' + listener.address().port,
    issued = Math.floor(Date.now() / 1000);
  const client = () => {
    const id = randomUUID();
    store.db.prepare('INSERT INTO amcp_mcp_clients VALUES(?,?)').run(
      id,
      JSON.stringify({
        client_id: id,
        client_id_issued_at: issued,
        client_name: 'Synthetic connector',
        redirect_uris: ['https://client.example/cb'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'mcp:read',
      }),
    );
    const refreshToken = randomBytes(32).toString('base64url');
    store.db
      .prepare('INSERT INTO amcp_mcp_grants VALUES(?,?,?,?,?,?,0)')
      .run(
        sha256(refreshToken),
        'refresh',
        id,
        'local',
        JSON.stringify({family: randomUUID(), scope: 'mcp:read'}),
        Date.now() + 86400000,
      );
    return {id, refreshToken};
  };
  const token = form =>
    fetch(base + '/token', {
      method: 'POST',
      headers: {'content-type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams(form),
    });
  const refresh = async c => {
    const r = await token({grant_type: 'refresh_token', refresh_token: c.refreshToken, client_id: c.id});
    if (r.status === 200) c.refreshToken = (await r.json()).refresh_token;
    return r;
  };
  return {
    store,
    client,
    token,
    refresh,
    close: async () => {
      const closing = new Promise(r => listener.close(r));
      listener.closeAllConnections();
      await closing;
      store.close();
    },
  };
}

test('200 successful refreshes from 20 clients behind one address all succeed', async () => {
  // Before SEC-01 every /token request counted, so the 51st refresh from one address got 429 for every client.
  const s = await tokenSite();
  try {
    const clients = Array.from({length: 20}, s.client);
    const statuses = [];
    for (let round = 0; round < 10; round++) for (const c of clients) statuses.push((await s.refresh(c)).status);
    assert.equal(statuses.length, 200);
    assert.deepEqual([...new Set(statuses)], [200]);
  } finally {
    await s.close();
  }
});

test('51 failed client authentications from one address get 429 with Retry-After and an OAuth body', async () => {
  const s = await tokenSite();
  try {
    for (let i = 0; i < 50; i++) {
      const r = await s.token({grant_type: 'refresh_token', refresh_token: 'x', client_id: 'unknown-client'});
      assert.equal(r.status, 400);
      assert.equal((await r.json()).error, 'invalid_client');
    }
    const refused = await s.token({grant_type: 'refresh_token', refresh_token: 'x', client_id: 'unknown-client'});
    assert.equal(refused.status, 429);
    const wait = Number(refused.headers.get('retry-after'));
    assert.ok(wait >= 1 && wait <= 900, String(wait));
    assert.equal((await refused.json()).error, 'too_many_requests');
    // Brute-force protection is unchanged: a valid client from the same address waits too.
    assert.equal((await s.refresh(s.client())).status, 429);
  } finally {
    await s.close();
  }
});

test('refused grants count as failures after authentication; successes do not', async () => {
  const s = await tokenSite();
  try {
    const c = s.client();
    for (let i = 0; i < 50; i++) {
      const r = await s.token({grant_type: 'refresh_token', refresh_token: 'not-a-grant-' + i, client_id: c.id});
      assert.equal(r.status, 400);
      assert.equal((await r.json()).error, 'invalid_grant');
    }
    assert.equal((await s.refresh(c)).status, 429);
  } finally {
    await s.close();
  }
});

test('each client has its own budget of 30 successful token responses per 15 minutes', async () => {
  const s = await tokenSite();
  try {
    const busy = s.client(),
      other = s.client();
    for (let i = 0; i < 30; i++) assert.equal((await s.refresh(busy)).status, 200, 'refresh ' + (i + 1));
    const refused = await s.refresh(busy);
    assert.equal(refused.status, 429);
    assert.ok(Number(refused.headers.get('retry-after')) > 0);
    assert.deepEqual(await refused.json(), {
      error: 'too_many_requests',
      error_description: 'Too many token requests for this client. Try again later.',
    });
    assert.equal((await s.refresh(other)).status, 200, 'another client behind the same address is unaffected');
  } finally {
    await s.close();
  }
});

test('the deployment owner sees the key source, header presence and distinct key count, never an address', () => {
  const store = new Store(':memory:', master);
  try {
    const web = new WebStore(store, {origin, masterKey: master, authEnv: {}, clientIpSource: 'railway+cloudflare'});
    for (const client of ['198.51.100.10', '198.51.100.11', '198.51.100.11'])
      web.limitAddress(req({'x-real-ip': cloudflareEdge, 'cf-connecting-ip': client}));
    web.limitAddress(req({'x-real-ip': '203.0.113.12'}));
    const owner = {tenantId: web.tenantId, userId: 'workspace-admin', role: 'admin'},
      health = ownerOperations(store, {action: 'health'}, owner),
      limits = health.rate_limits;
    assert.equal(limits.key_source, 'railway+cloudflare');
    assert.equal(limits.distinct_limit_keys_last_hour, 3);
    assert.deepEqual(limits.headers_seen_last_hour, {x_real_ip: true, cf_connecting_ip: true});
    assert.deepEqual(
      [limits.latest_request.x_real_ip_present, limits.latest_request.cf_connecting_ip_present],
      [true, false],
    );
    assert.equal(limits.proxy_headers_ignored, false);
    const text = JSON.stringify(health);
    for (const address of ['198.51.100.10', '198.51.100.11', '203.0.113.12', cloudflareEdge])
      assert.equal(text.includes(address), false, address);
    // Owners of other workspaces never see deployment-wide traffic counts.
    const other = ownerOperations(store, {action: 'health'}, {...owner, tenantId: 'user-elsewhere'});
    assert.equal(Object.hasOwn(other, 'rate_limits'), false);
  } finally {
    store.close();
  }
});

test('owner health flags X-Real-IP that the configured key source ignores', () => {
  const store = new Store(':memory:', master);
  try {
    const web = new WebStore(store, {origin, masterKey: master, authEnv: {}});
    web.limitAddress(req({'x-real-ip': '198.51.100.10'}));
    const limits = ownerOperations(
      store,
      {action: 'health'},
      {tenantId: web.tenantId, userId: 'workspace-admin', role: 'admin'},
    ).rate_limits;
    assert.equal(limits.key_source, 'socket');
    assert.equal(limits.distinct_limit_keys_last_hour, 1);
    assert.equal(limits.proxy_headers_ignored, true);
  } finally {
    store.close();
  }
});

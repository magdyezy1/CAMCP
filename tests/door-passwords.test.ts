import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes, scryptSync} from 'node:crypto';
import type {Request, Response} from 'express';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {sha256} from '../src/security.js';
import {createHttpApp} from '../server/http-app.js';
import {WebStore, checkPassword, passwordHash, type WebSession} from '../server/web-store.js';
import {listenForFetch} from './http-listener.js';
import {McpOAuth} from '../server/mcp-oauth.js';
import {runAdmin} from './admin-cli.js';

// The two passwords configured on the server (the administrator's and the shared reviewer's) are doors: F-16.
const master = Buffer.alloc(32, 83).toString('base64'),
  origin = 'https://amcp.shop',
  first = 'synthetic-door-password-one',
  second = 'synthetic-door-password-two',
  reviewer = 'synthetic-reviewer-password-one';
const request = (web: WebStore, session: WebSession) =>
  ({headers: {cookie: web.cookie(session.id), origin, 'x-amcp-csrf': session.csrf}}) as unknown as Request;
/** A hash in the form AMCP wrote before the review: Node's scrypt defaults. */
const legacy = (password: string, salt = randomBytes(16).toString('hex')) =>
  'scrypt$' + salt + '$' + scryptSync(password, salt, 32).toString('hex');
/** An MCP client approved from a signed-in session through the provider's own steps. */
async function approveClient(web: WebStore, session: WebSession) {
  const oauth = new McpOAuth(web),
    redirect = 'https://claude.ai/api/mcp/auth_callback',
    client = await oauth.clientsStore.registerClient({
      client_name: 'Door test client',
      redirect_uris: [redirect],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
    verifier = randomBytes(48).toString('base64url');
  let consent = '';
  await oauth.authorize(
    client,
    {
      redirectUri: redirect,
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      scopes: ['mcp:read'],
    },
    {redirect: (_status: number, url: string) => (consent = url)} as unknown as Response,
  );
  const code = new URL(oauth.decide(new URL(consent).searchParams.get('request')!, session, true)).searchParams.get(
    'code',
  )!;
  return {client, tokens: await oauth.exchangeAuthorizationCode(client, code, verifier, redirect)};
}
const audited = (store: Store, event: string) =>
  (store.db.prepare('SELECT event FROM audit').all() as {event: string}[]).some(row => row.event.includes(event));

test('door hashes: new ones use scrypt-v3, the older form still opens a door, and checking runs off the event loop', async () => {
  const hash = passwordHash(first);
  assert.match(hash, /^scrypt-v3\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
  const checking = checkPassword(first, hash);
  assert.ok(checking instanceof Promise);
  assert.equal(await checking, true);
  assert.equal(await checkPassword(second, hash), false);
  assert.equal(await checkPassword(first, legacy(first)), true);
  assert.equal(await checkPassword(second, legacy(first)), false);
  // The user-account form is not a door form.
  assert.equal(await checkPassword(first, 'scrypt-v2$' + hash.slice('scrypt-v3$'.length)), false);
  const modernStore = new Store(':memory:', master),
    legacyStore = new Store(':memory:', master),
    warnings: string[] = [],
    write = process.stderr.write;
  try {
    process.stderr.write = ((chunk: string) => (warnings.push(String(chunk)), true)) as typeof process.stderr.write;
    let modern: WebStore, old: WebStore;
    try {
      modern = new WebStore(modernStore, {origin, masterKey: master, adminPasswordHash: hash});
      assert.deepEqual(warnings, []);
      old = new WebStore(legacyStore, {origin, masterKey: master, adminPasswordHash: legacy(first)});
    } finally {
      process.stderr.write = write;
    }
    assert.match(warnings.join(''), /AMCP_ADMIN_PASSWORD_HASH uses the older scrypt parameters.*password-hash/);
    const signingIn = modern.signIn(first, 'peer');
    assert.ok(signingIn instanceof Promise);
    assert.equal((await signingIn).actor.userId, 'workspace-admin');
    await assert.rejects(modern.signIn(second, 'peer'), /incorrect/);
    assert.equal((await old.signIn(first, 'peer')).actor.userId, 'workspace-admin');
  } finally {
    modernStore.close();
    legacyStore.close();
  }
});

test('a new administrator password ends its sessions and the MCP access approved from them; the same one survives a restart', async () => {
  const store = new Store(':memory:', master);
  try {
    const before = new WebStore(store, {origin, masterKey: master, adminPassword: first}),
      session = await before.signIn(first, 'peer'),
      mcp = await approveClient(before, session);
    // MCP access approved by an owner account belongs to that account, not to the door.
    store.db
      .prepare('INSERT INTO amcp_mcp_grants VALUES(?,?,?,?,?,?,0)')
      .run(
        'owner-grant',
        'refresh',
        mcp.client.client_id,
        'local',
        JSON.stringify({family: 'owner-family', scope: 'mcp:read', ownerUserId: 'owner-user'}),
        Date.now() + 86400000,
      );
    const same = new WebStore(store, {origin, masterKey: master, adminPassword: first});
    assert.equal(same.session(request(same, session))?.actor.userId, 'workspace-admin');
    assert.equal((await new McpOAuth(same).verifyAccessToken(mcp.tokens.access_token)).clientId, mcp.client.client_id);
    assert.equal(audited(store, 'administrator_password_changed'), false);

    const after = new WebStore(store, {origin, masterKey: master, adminPassword: second});
    assert.equal(after.session(request(after, session)), undefined);
    await assert.rejects(new McpOAuth(after).verifyAccessToken(mcp.tokens.access_token), {code: 'UNAUTHORIZED'});
    await assert.rejects(new McpOAuth(after).exchangeRefreshToken(mcp.client, mcp.tokens.refresh_token!), {
      name: 'InvalidGrantError',
    });
    assert.equal(
      (store.db.prepare("SELECT used FROM amcp_mcp_grants WHERE hash='owner-grant'").get() as {used: number}).used,
      0,
    );
    assert.equal(audited(store, 'administrator_password_changed'), true);
    await assert.rejects(after.signIn(first, 'peer'), /incorrect/);
    const current = await after.signIn(second, 'peer');
    assert.equal(after.session(request(after, current))?.actor.userId, 'workspace-admin');

    // A hash from the environment that stays the same keeps its sessions across restarts too.
    const hash = passwordHash(second),
      hashed = new WebStore(store, {origin, masterKey: master, adminPasswordHash: hash}),
      kept = await hashed.signIn(second, 'peer'),
      restarted = new WebStore(store, {origin, masterKey: master, adminPasswordHash: hash});
    assert.equal(restarted.session(request(restarted, kept))?.actor.userId, 'workspace-admin');
  } finally {
    store.close();
  }
});

test('r25-mf-auth: a new administrator password also ends the connector tokens its sessions issued, and no key that is not its own', async () => {
  const store = new Store(':memory:', master),
    options = {origin, masterKey: master, adminPassword: first, testPassword: reviewer},
    revoked = (token: string) =>
      (store.db.prepare('SELECT revoked FROM api_keys WHERE hash=?').get(sha256(token)) as {revoked: number}).revoked;
  try {
    const before = new WebStore(store, options),
      tenant = before.tenantId;
    // As POST /api/connector-tokens makes them: from the administrator door's session no person owns the key.
    const connector = store.createKey({tenantId: tenant, userId: 'connector/synthetic-one', role: 'operator'}),
      oauthKey = store.createKey({tenantId: tenant, userId: 'oauth/synthetic-client', role: 'reader'});
    // Keys the administrator password does not own: one a person's account owns, one made on the server (SEC-06), and
    // one the reviewer door issued.
    const person = store.createKey({tenantId: tenant, userId: 'connector/synthetic-person', role: 'reader'});
    store.db.prepare('INSERT INTO credential_owners VALUES(?,?)').run(sha256(person), 'person-account');
    const service = store.createServiceKey({tenantId: tenant, userId: 'synthetic-service', role: 'reader'}),
      reviewerKey = store.createKey({
        tenantId: before.testTenantId,
        userId: 'connector/synthetic-reviewer',
        role: 'operator',
        ownerUserId: 'workspace-test',
      });
    const state = () => [connector, oauthKey, person, service, reviewerKey].map(revoked);
    assert.deepEqual(state(), [0, 0, 0, 0, 0]);
    // The same password at the next start ends nothing.
    new WebStore(store, options);
    assert.deepEqual(state(), [0, 0, 0, 0, 0]);
    // A new administrator password ends the administrator's tokens, in the same step as its sessions and access.
    new WebStore(store, {...options, adminPassword: second});
    assert.deepEqual(state(), [1, 1, 0, 0, 0]);
    assert.throws(() => store.authenticate(connector), {code: 'UNAUTHORIZED'});
    store.authenticate(service);
    // A new reviewer password ends the reviewer's, as before, and still nothing else.
    new WebStore(store, {...options, adminPassword: second, testPassword: 'synthetic-reviewer-password-two'});
    assert.deepEqual(state(), [1, 1, 0, 0, 1]);
  } finally {
    store.close();
  }
});

test('r25-mf-auth F6: a door password change ends only the door keys of its own workspace, though two deployments share a database', async () => {
  const store = new Store(':memory:', master);
  try {
    const open = (tenantId: string, adminPassword: string, testPassword: string) =>
      new WebStore(store, {origin, masterKey: master, adminPassword, testPassword, tenantId});
    const a = open('dep-a', 'synthetic-admin-password-aaa', 'synthetic-reviewer-password-a'),
      b = open('dep-b', 'synthetic-admin-password-bbb', 'synthetic-reviewer-password-b');
    const reviewerKey = (w: WebStore) =>
        store.createKey({
          tenantId: w.testTenantId,
          userId: 'connector/synthetic-reviewer',
          role: 'operator',
          ownerUserId: 'workspace-test',
        }),
      legacyKey = (w: WebStore) =>
        store.createKey({tenantId: w.tenantId, userId: 'connector/synthetic-legacy', role: 'reader'});
    const keys = [reviewerKey(a), reviewerKey(b), legacyKey(a), legacyKey(b)],
      live = (token: string) => {
        try {
          store.authenticate(token);
          return true;
        } catch {
          return false;
        }
      },
      state = () => keys.map(live);
    assert.deepEqual(state(), [true, true, true, true]);
    // The first deployment's reviewer password changes: its reviewer key ends, the other deployment's does not.
    open('dep-a', 'synthetic-admin-password-aaa', 'synthetic-reviewer-password-a2');
    assert.deepEqual(state(), [false, true, true, true]);
    // The first deployment's administrator password changes: its connector token ends, the other's does not.
    open('dep-a', 'synthetic-admin-password-aaa2', 'synthetic-reviewer-password-a2');
    assert.deepEqual(state(), [false, true, false, true]);
  } finally {
    store.close();
  }
});

test('r25-mf-auth: a connector token made over HTTP from the administrator session is refused at /mcp once the administrator password changes', async () => {
  const store = new Store(':memory:', master),
    site = {origin, masterKey: master, adminPassword: first},
    listener = await listenForFetch(
      createHttpApp(new MirrorService(new Registry(), store), store, {publicOrigin: origin, website: site}),
    ),
    base = 'http://127.0.0.1:' + (listener.address() as {port: number}).port;
  try {
    const call = (path: string, init: RequestInit & {headers?: Record<string, string>} = {}) =>
      fetch(base + path, {...init, headers: {Origin: origin, 'Content-Type': 'application/json', ...init.headers}});
    const login = await call('/api/session', {method: 'POST', body: JSON.stringify({password: first})});
    assert.equal(login.status, 200);
    const admin = {Cookie: login.headers.get('set-cookie')!.split(';')[0]!, 'X-AMCP-CSRF': (await login.json()).csrf};
    const created = await call('/api/connector-tokens', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({name: 'Synthetic connector', role: 'reader'}),
    });
    assert.equal(created.status, 200);
    const mcp = async (token: string) =>
      (
        await call('/mcp', {
          method: 'POST',
          headers: {Authorization: 'Bearer ' + token, Accept: 'application/json, text/event-stream'},
          body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}}),
        })
      ).status;
    const {token} = await created.json();
    assert.equal(await mcp(token), 200);
    new WebStore(store, {...site, adminPassword: second});
    assert.equal(await mcp(token), 401);
  } finally {
    listener.closeAllConnections();
    await new Promise<void>(resolve => listener.close(() => resolve()));
    store.close();
  }
});

test('r25-mf-auth F4: a connector token whose request read its session before a rotation committed is refused, not issued', async () => {
  const store = new Store(':memory:', master),
    site = {origin, masterKey: master, adminPassword: first},
    listener = await listenForFetch(
      createHttpApp(new MirrorService(new Registry(), store), store, {publicOrigin: origin, website: site}),
    ),
    base = 'http://127.0.0.1:' + (listener.address() as {port: number}).port;
  try {
    const call = (path: string, init: RequestInit & {headers?: Record<string, string>} = {}) =>
      fetch(base + path, {...init, headers: {Origin: origin, 'Content-Type': 'application/json', ...init.headers}});
    const login = await call('/api/session', {method: 'POST', body: JSON.stringify({password: first})});
    const admin = {Cookie: login.headers.get('set-cookie')!.split(';')[0]!, 'X-AMCP-CSRF': (await login.json()).csrf};
    // The other process commits its rotation after this request read its session and before this one's first write
    // transaction begins: the window the website cannot see, since only the database is shared.
    const begin = store.transaction.bind(store);
    let rotated = false;
    (store as {transaction: typeof store.transaction}).transaction = (fn => {
      if (!rotated) {
        rotated = true;
        new WebStore(store, {...site, adminPassword: second});
      }
      return begin(fn);
    }) as typeof store.transaction;
    const created = await call('/api/connector-tokens', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({name: 'late', role: 'reader'}),
    });
    (store as {transaction: typeof store.transaction}).transaction = begin;
    assert.equal(rotated, true, 'the rotation ran inside the request');
    assert.equal(
      (
        store.db.prepare("SELECT count(*) AS n FROM api_keys WHERE user_id LIKE 'connector/%' AND revoked=0").get() as {
          n: number;
        }
      ).n,
      0,
      'no live connector key was written after the rotation',
    );
    assert.equal(created.status, 503, await created.clone().text());
    assert.equal((await created.json()).error.code, 'SIGN_IN_CHANGED');
  } finally {
    listener.closeAllConnections();
    await new Promise<void>(resolve => listener.close(() => resolve()));
    store.close();
  }
});

test('r25-mf-auth: when the administrator’s tokens cannot be revoked the rotation fails whole, and the old password keeps all it had', async () => {
  const store = new Store(':memory:', master);
  try {
    const before = new WebStore(store, {origin, masterKey: master, adminPassword: first}),
      session = await before.signIn(first, 'peer'),
      mcp = await approveClient(before, session),
      connector = store.createKey({tenantId: before.tenantId, userId: 'connector/synthetic-two', role: 'operator'});
    store.db.exec(
      "CREATE TRIGGER synthetic_revoke_failure BEFORE UPDATE ON api_keys WHEN NEW.user_id LIKE 'connector/%' BEGIN SELECT RAISE(ABORT, 'synthetic revocation failure'); END",
    );
    assert.throws(
      () => new WebStore(store, {origin, masterKey: master, adminPassword: second}),
      /synthetic revocation/,
    );
    // Nothing of the rotation happened: the door keeps the old password, its session and the access approved from it.
    assert.equal(before.session(request(before, session))?.actor.userId, 'workspace-admin');
    assert.equal(
      (await new McpOAuth(before).verifyAccessToken(mcp.tokens.access_token)).clientId,
      mcp.client.client_id,
    );
    assert.equal(store.authenticate(connector).userId, 'connector/synthetic-two');
    assert.equal(audited(store, 'administrator_password_changed'), false);
    // Once revocation works, the same start-up completes the rotation: everything ends together.
    store.db.exec('DROP TRIGGER synthetic_revoke_failure');
    const after = new WebStore(store, {origin, masterKey: master, adminPassword: second});
    assert.equal(after.session(request(after, session)), undefined);
    await assert.rejects(new McpOAuth(after).verifyAccessToken(mcp.tokens.access_token), {code: 'UNAUTHORIZED'});
    assert.throws(() => store.authenticate(connector), {code: 'UNAUTHORIZED'});
    assert.equal(audited(store, 'administrator_password_changed'), true);
  } finally {
    store.close();
  }
});

test('once a process starts with a new administrator password, one still running the old password issues nothing more', async () => {
  const store = new Store(':memory:', master);
  try {
    const old = new WebStore(store, {origin, masterKey: master, adminPassword: first}),
      early = await old.signIn(first, 'peer'),
      mcp = await approveClient(old, early),
      current = new WebStore(store, {origin, masterKey: master, adminPassword: second});
    await assert.rejects(old.signIn(first, 'peer'), /reconfigured/);
    assert.equal(old.session(request(old, early)), undefined);
    await assert.rejects(approveClient(old, early), /expired/);
    await assert.rejects(new McpOAuth(old).exchangeRefreshToken(mcp.client, mcp.tokens.refresh_token!), {
      name: 'InvalidGrantError',
    });
    await assert.rejects(new McpOAuth(old).verifyAccessToken(mcp.tokens.access_token), {code: 'UNAUTHORIZED'});
    const now = await current.signIn(second, 'peer');
    assert.equal(current.session(request(current, now))?.actor.userId, 'workspace-admin');
  } finally {
    store.close();
  }
});

test('the reviewer door: a new or removed reviewer password ends reviewer sessions; a process without doors changes nothing', async () => {
  const store = new Store(':memory:', master),
    options = {origin, masterKey: master, adminPassword: first};
  try {
    const web = new WebStore(store, {...options, testPassword: reviewer}),
      session = await web.signInTest(reviewer, 'peer'),
      admin = await web.signIn(first, 'peer');
    // The report worker opens no door: it neither ends nor keeps anything.
    new WebStore(store, {origin, masterKey: master});
    const again = new WebStore(store, {...options, testPassword: reviewer});
    assert.equal(again.session(request(again, session))?.actor.userId, 'workspace-test');
    assert.equal(again.session(request(again, admin))?.actor.userId, 'workspace-admin');
    const closed = new WebStore(store, options);
    assert.equal(closed.session(request(closed, session)), undefined);
    assert.equal(closed.session(request(closed, admin))?.actor.userId, 'workspace-admin');
    const changed = new WebStore(store, {...options, testPassword: 'synthetic-reviewer-password-two'});
    assert.equal(changed.session(request(changed, session)), undefined);
    assert.equal(changed.session(request(changed, admin))?.actor.userId, 'workspace-admin');
    assert.equal(audited(store, 'reviewer_password_changed'), true);
  } finally {
    store.close();
  }
});

test('admin password-hash prints a scrypt-v3 hash of a password read from standard input', async () => {
  const run = (input: string) => runAdmin(['password-hash'], {input});
  const printed = run(first + '\n');
  assert.equal(printed.status, 0, printed.stderr);
  const hash = printed.stdout.trim();
  assert.match(hash, /^scrypt-v3\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
  assert.equal(await checkPassword(first, hash), true);
  const short = run('too-short\n');
  assert.notEqual(short.status, 0);
  assert.match(short.stderr, /16 characters/);
  assert.equal(short.stdout, '');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes, scryptSync} from 'node:crypto';
import type {Request, Response} from 'express';
import {Store} from '../src/store.js';
import {WebStore, checkPassword, passwordHash, type WebSession} from '../server/web-store.js';
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

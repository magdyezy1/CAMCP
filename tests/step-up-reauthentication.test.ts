// SEC-06 S1 (review 2026-10-08): "Confirm it's you". Before this change a recent sign-in was required only for account
// security changes, and the only remedy was to sign out and in again; a session that signed in hours earlier could still
// mint a 30-day connector token, approve an AI client (a 30-day refresh family), add write access, invite or promote
// members and grant account access. Each of those now refuses with REAUTH_REQUIRED before any effect, and a password,
// two-step code or door password renews the same session's recent proof without moving its expiry. Synthetic only.
import {listenForFetch} from './http-listener.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import type {Request} from 'express';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {createHttpApp} from '../server/http-app.js';
import {WebStore} from '../server/web-store.js';
import {UserAccounts, hashUserPassword} from '../server/user-accounts.js';
import {AccountSecurity, totp} from '../server/account-security.js';
import type {Connection, JsonObject} from '../src/types.js';

const origin = 'https://amcp.shop',
  master = Buffer.alloc(32, 77).toString('base64'),
  password = 'synthetic-step-up-door-password',
  memberPassword = 'synthetic step-up member passphrase',
  sixteenMinutes = 16 * 60000;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const connection: Connection = {
  id: 'step-up-synthetic',
  tenantId: 'local',
  gateway: 'meta_native_action',
  accounts: ['111', '222'],
  label: 'Synthetic connection',
  enabled: true,
  scopes: ['ads_management'],
};
/** Moves a session's sign-in back, as if the person signed in `ms` ago. */
const age = (store: Store, id: string, ms: number) =>
  store.db
    .prepare("UPDATE amcp_web_sessions SET actor=json_set(actor,'$.signedInAt',?) WHERE hash=?")
    .run(Date.now() - ms, sha(id));
const expiry = (store: Store, id: string) =>
  (store.db.prepare('SELECT expires_at FROM amcp_web_sessions WHERE hash=?').get(sha(id)) as JsonObject).expires_at;

async function site() {
  const store = new Store(':memory:', master),
    service = new MirrorService(new Registry(), store, undefined, undefined, {
      allowWrites: true,
      maxBudgetChange: 0,
      requireBeforeState: true,
    });
  const listener = await listenForFetch(
    createHttpApp(service, store, {
      publicOrigin: origin,
      website: {
        origin,
        masterKey: master,
        adminPassword: password,
        fetcher: async () => {
          throw Error('No provider traffic allowed');
        },
      },
    }),
  );
  const base = 'http://127.0.0.1:' + (listener.address() as {port: number}).port;
  const request = async (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const form = body instanceof URLSearchParams,
      r = await fetch(base + url, {
        method,
        redirect: 'manual',
        headers: {
          Origin: origin,
          ...(body === undefined
            ? {}
            : {'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json'}),
          ...headers,
        },
        body: body === undefined ? undefined : form ? body : JSON.stringify(body),
      });
    const bytes = await r.arrayBuffer();
    return new Response([204, 205, 304].includes(r.status) ? null : bytes, {status: r.status, headers: r.headers});
  };
  const login = await request('/api/session', 'POST', {password});
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!,
    headers = {Cookie: cookie, 'X-AMCP-CSRF': (await login.json()).csrf as string};
  return {
    store,
    request,
    headers,
    sessionId: cookie.slice(cookie.indexOf('=') + 1),
    close: async () => {
      await new Promise<void>(resolve => listener.close(() => resolve()));
      store.close();
    },
  };
}
/** Registers an AI client and starts its authorization; returns the consent request the website decides. */
async function consentRequest(s: Awaited<ReturnType<typeof site>>) {
  const registered = await s.request('/register', 'POST', {
    client_name: 'Synthetic client',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
  assert.equal(registered.status, 201);
  const client = await registered.json(),
    verifier = randomBytes(48).toString('base64url');
  const start = await s.request(
    '/authorize?' +
      new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        response_type: 'code',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        scope: 'mcp:read',
        state: 'step-up-state',
        resource: origin + '/mcp',
      }),
  );
  assert.equal(start.status, 303);
  return new URL(start.headers.get('location')!).searchParams.get('request')!;
}

test('SEC-06: a session signed in 16 minutes ago confirms it is you before minting a token, approving an AI client or adding write access', async () => {
  const s = await site();
  try {
    s.store.putConnection({tenantId: 'local', userId: 'test', role: 'admin'}, connection, {accessToken: 'synthetic'});
    const request = await consentRequest(s);
    age(s.store, s.sessionId, sixteenMinutes);
    const expiresAt = expiry(s.store, s.sessionId);
    const code = async (r: Response) => ((await r.json()) as JsonObject).error?.code;
    // Every refusal happens before any effect.
    const token = await s.request('/api/connector-tokens', 'POST', {name: 'Late token', role: 'reader'}, s.headers);
    assert.equal(token.status, 403);
    assert.equal(await code(token), 'REAUTH_REQUIRED');
    assert.equal(s.store.documents('local', 'website_mcp_token').length, 0);
    const consent = await s.request('/api/mcp/consent', 'POST', {request, approved: true}, s.headers);
    assert.equal(consent.status, 403);
    assert.equal(await code(consent), 'REAUTH_REQUIRED');
    const access = '/api/connections/' + connection.id + '/write-access';
    const grant = await s.request(access, 'PATCH', {accounts: ['111'], confirmed: true}, s.headers);
    assert.equal(grant.status, 403);
    assert.equal(await code(grant), 'REAUTH_REQUIRED');
    assert.deepEqual(s.store.listConnections('local')[0]!.writeAccounts ?? [], []);
    // Removing write access is never held back.
    assert.equal((await s.request(access, 'PATCH', {accounts: []}, s.headers)).status, 200);
    // A wrong password is refused; the right one renews this same session without moving its expiry.
    const wrong = await s.request('/api/account/reauthenticate', 'POST', {password: 'not the password'}, s.headers);
    assert.equal(wrong.status, 401);
    assert.equal(await code(wrong), 'INVALID_LOGIN');
    const confirmed = await s.request('/api/account/reauthenticate', 'POST', {password}, s.headers);
    assert.equal(confirmed.status, 200, await confirmed.clone().text());
    assert.equal(((await confirmed.json()) as JsonObject).reauthenticated, true);
    assert.equal(expiry(s.store, s.sessionId), expiresAt, 'a step-up never extends the session');
    // The same requests now succeed.
    const minted = await s.request('/api/connector-tokens', 'POST', {name: 'Late token', role: 'reader'}, s.headers);
    assert.equal(minted.status, 200);
    assert.equal(s.store.authenticate(((await minted.json()) as JsonObject).token).role, 'reader');
    const approved = await s.request('/api/mcp/consent', 'POST', {request, approved: true}, s.headers);
    assert.equal(approved.status, 200, await approved.clone().text());
    assert.ok(new URL(((await approved.json()) as JsonObject).url).searchParams.get('code'));
    assert.equal((await s.request(access, 'PATCH', {accounts: ['111'], confirmed: true}, s.headers)).status, 200);
    assert.deepEqual(s.store.listConnections('local')[0]!.writeAccounts, ['111']);
    const events = (s.store.db.prepare('SELECT event FROM audit ORDER BY seq').all() as {event: string}[]).map(r =>
      JSON.parse(r.event),
    );
    assert.deepEqual(
      events.filter(e => e.event === 'account_reauthenticated').map(e => e.method),
      ['door_password'],
    );
    // Once 15 minutes pass after the step-up, the proof is stale again.
    s.store.db
      .prepare("UPDATE amcp_web_sessions SET actor=json_set(actor,'$.reauthAt',?) WHERE hash=?")
      .run(Date.now() - sixteenMinutes, sha(s.sessionId));
    const stale = await s.request('/api/connector-tokens', 'POST', {name: 'Stale', role: 'reader'}, s.headers);
    assert.equal(await code(stale), 'REAUTH_REQUIRED');
  } finally {
    await s.close();
  }
});

function accountsFixture() {
  const store = new Store(':memory:', master),
    web = new WebStore(store, {
      origin,
      masterKey: master,
      adminPassword: password,
      authEnv: {AMCP_EMAIL_API_KEY: 'synthetic-email-key', AMCP_EMAIL_FROM: 'AMCP <accounts@example.test>'},
      fetcher: async () => new Response('{"id":"mail"}', {headers: {'Content-Type': 'application/json'}}),
    }),
    accounts = new UserAccounts(web),
    security = new AccountSecurity(accounts);
  const req = (s?: {id: string; csrf: string}, address = '127.0.0.1'): Request =>
    ({
      headers: {origin: web.origin, ...(s ? {cookie: web.cookie(s.id), 'x-amcp-csrf': s.csrf} : {})},
      socket: {remoteAddress: address},
    }) as unknown as Request;
  return {store, web, accounts, security, req};
}

test('SEC-06: invitations, role changes and access grants need recent proof; TOTP and passwords confirm; failures count', async () => {
  const f = accountsFixture();
  try {
    const owner = f.accounts.newUser('Owner', 'owner@example.test', await hashUserPassword(memberPassword), true),
      member = f.accounts.newUser('Member', 'member@example.test', await hashUserPassword(memberPassword), true);
    f.store.db
      .prepare("INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,'viewer',?)")
      .run(owner.tenant_id, member.id, Date.now());
    const first = f.accounts.session(owner),
      setup = f.security.beginMfa(f.req(first));
    f.security.enableMfa(f.req(first), {ticket: setup.ticket, code: totp(setup.secret)});
    // enableMfa ended every session; the owner signs in again with the second factor.
    const s = f.accounts.session(f.accounts.user(owner.id), owner.tenant_id, true);
    age(f.store, s.id, sixteenMinutes);
    const expiresAt = expiry(f.store, s.id);
    await assert.rejects(f.security.invite(f.req(s), {email: 'new@example.test', role: 'admin'}), {
      code: 'REAUTH_REQUIRED',
    });
    assert.equal(f.store.documents(owner.tenant_id, 'workspace_invite').length, 0);
    assert.throws(() => f.security.changeMember(f.req(s), {userId: member.id, role: 'admin'}), {
      code: 'REAUTH_REQUIRED',
    });
    // A two-step code confirms; the code of the step enableMfa used is a replay, the next one is not.
    const step = Math.floor(Date.now() / 30000);
    await assert.rejects(f.security.reauthenticate(f.req(s), {code: totp(setup.secret, step - 5)}), {
      code: 'MFA_INVALID',
    });
    const confirmed = await f.security.reauthenticate(f.req(s), {code: totp(setup.secret, step + 1)});
    assert.equal(confirmed.reauthenticated, true);
    assert.equal(expiry(f.store, s.id), expiresAt);
    assert.match((await f.security.invite(f.req(s), {email: 'new@example.test', role: 'admin'})).message, /invitation/);
    assert.deepEqual(f.security.changeMember(f.req(s), {userId: member.id, role: 'operator'}), {success: true});
    // Removing a member is never held back by the recent-proof rule.
    age(f.store, s.id, sixteenMinutes);
    f.store.db
      .prepare("UPDATE amcp_web_sessions SET actor=json_remove(actor,'$.reauthAt') WHERE hash=?")
      .run(sha(s.id));
    assert.deepEqual(f.security.changeMember(f.req(s), {userId: member.id, role: 'remove'}), {success: true});
    // Wrong passwords are refused and counted against the person: the ninth attempt is refused even when right.
    for (let i = 0; i < 8; i++)
      await assert.rejects(f.security.reauthenticate(f.req(s, '10.9.8.' + (10 + i)), {password: 'wrong ' + i}), {
        code: 'INVALID_LOGIN',
      });
    await assert.rejects(f.security.reauthenticate(f.req(s, '10.9.9.9'), {password: memberPassword}), {
      code: 'LOGIN_RATE_LIMIT',
    });
  } finally {
    f.store.close();
  }
});

test('SEC-06: granting account access needs recent proof, revoking it never does; door sessions confirm with their password', async () => {
  const f = accountsFixture();
  try {
    const pending = f.accounts.newUser('Pending', 'pending@example.test', null, false),
      approved = f.accounts.newUser('Approved', 'approved@example.test', null, true),
      admin = await f.web.signIn(password, '127.0.0.1');
    age(f.store, admin.id, sixteenMinutes);
    assert.throws(() => f.security.setAccess(f.req(admin), {user_id: pending.id, grant: true}), {
      code: 'REAUTH_REQUIRED',
    });
    assert.equal(f.accounts.user(pending.id).approved, 0);
    assert.equal(f.security.setAccess(f.req(admin), {user_id: approved.id, grant: false}).state, 'revoked');
    await assert.rejects(f.security.reauthenticate(f.req(admin), {code: '123456'}), {code: 'INVALID_ARGUMENT'});
    await assert.rejects(f.security.reauthenticate(f.req(admin), {password: 'not the door password'}), {
      code: 'INVALID_LOGIN',
    });
    assert.equal((await f.security.reauthenticate(f.req(admin), {password})).reauthenticated, true);
    assert.equal(f.security.setAccess(f.req(admin), {user_id: pending.id, grant: true}).state, 'approved');
  } finally {
    f.store.close();
  }
});

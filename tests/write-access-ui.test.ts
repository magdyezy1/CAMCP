import {listenForFetch} from './http-listener.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import type {Response as ExpressResponse} from 'express';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {createHttpApp} from '../server/http-app.js';
import {WebStore} from '../server/web-store.js';
import {McpOAuth} from '../server/mcp-oauth.js';
import type {Connection} from '../src/types.js';

const origin = 'https://amcp.shop',
  master = Buffer.alloc(32, 79).toString('base64'),
  password = 'synthetic-write-access-password';
const admin = {tenantId: 'local', userId: 'test', role: 'admin' as const};
const connection: Connection = {
  id: 'write-access-synthetic',
  tenantId: 'local',
  gateway: 'meta_native_action',
  accounts: ['111', '222'],
  label: 'Synthetic connection',
  enabled: true,
  scopes: ['ads_management'],
};
const blocked: typeof fetch = async () => {
  throw Error('No vendor network requests are permitted in access tests.');
};
async function site(allowWrites: boolean) {
  const store = new Store(':memory:', master),
    service = new MirrorService(new Registry(), store, undefined, undefined, {
      allowWrites,
      maxBudgetChange: 0,
      requireBeforeState: true,
    });
  const listener = await listenForFetch(
    createHttpApp(service, store, {website: {origin, masterKey: master, adminPassword: password, fetcher: blocked}}),
  );
  const base = 'http://127.0.0.1:' + (listener.address() as {port: number}).port;
  const request = (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + url, {
      method,
      redirect: 'manual',
      headers: {Origin: origin, ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...headers},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const login = await request('/api/session', 'POST', {password}),
    session = await login.json();
  assert.equal(login.status, 200);
  const headers = {Cookie: login.headers.get('set-cookie')!.split(';')[0]!, 'X-AMCP-CSRF': session.csrf as string};
  return {
    store,
    request,
    headers,
    base,
    close: async () => {
      await new Promise<void>(resolve => listener.close(() => resolve()));
      store.close();
    },
  };
}

test('website operator credentials require explicit confirmation and account grants stay within selected accounts', async () => {
  const s = await site(true);
  try {
    s.store.putConnection(admin, connection, {accessToken: 'synthetic-not-live'});
    const state = await (await s.request('/api/session', 'GET', undefined, s.headers)).json();
    assert.equal(state.writesEnabled, true);
    assert.equal(state.readOnly, false);
    const info = await (await s.request('/api/connections/' + connection.id, 'GET', undefined, s.headers)).json();
    assert.deepEqual(info.writeAccounts, []);
    const reader = await (
      await s.request('/api/connector-tokens', 'POST', {name: 'Explicit reader', role: 'reader'}, s.headers)
    ).json();
    assert.equal(s.store.authenticate(reader.token).role, 'reader');
    assert.equal(
      (await s.request('/api/connector-tokens', 'POST', {role: 'admin', confirmed: true}, s.headers)).status,
      400,
    );
    assert.equal((await s.request('/api/connector-tokens', 'POST', {role: 'operator'}, s.headers)).status, 400);
    assert.equal(
      (
        await s.request(
          '/api/connector-tokens',
          'POST',
          {role: 'operator', confirmed: true},
          {Cookie: s.headers.Cookie},
        )
      ).status,
      403,
    );
    const operator = await (
      await s.request('/api/connector-tokens', 'POST', {role: 'operator', confirmed: true}, s.headers)
    ).json();
    assert.equal(s.store.authenticate(operator.token).role, 'operator');
    const access = '/api/connections/' + connection.id + '/write-access';
    assert.equal((await s.request(access, 'PATCH', {accounts: ['111'], confirmed: true})).status, 401);
    assert.equal((await s.request(access, 'PATCH', {accounts: ['111']}, s.headers)).status, 400);
    assert.equal((await s.request(access, 'PATCH', {accounts: ['999'], confirmed: true}, s.headers)).status, 403);
    assert.equal(
      (await s.request(access, 'PATCH', {accounts: ['111', '111'], confirmed: true}, s.headers)).status,
      400,
    );
    assert.equal(
      (await s.request(access, 'PATCH', {accounts: ['111', '222'], confirmed: true}, s.headers)).status,
      200,
    );
    assert.deepEqual(s.store.listConnections('local')[0]!.writeAccounts, ['111', '222']);
    await s.request(
      '/api/connections/' + connection.id + '/assets',
      'PATCH',
      {selected: ['ad_accounts:222']},
      s.headers,
    );
    assert.deepEqual(s.store.listConnections('local')[0]!.writeAccounts, ['222']);
    await s.request(
      '/api/connections/' + connection.id + '/assets',
      'PATCH',
      {selected: ['ad_accounts:111', 'ad_accounts:222']},
      s.headers,
    );
    assert.deepEqual(s.store.listConnections('local')[0]!.writeAccounts, ['222']);
    assert.equal((await s.request(access, 'PATCH', {accounts: []}, s.headers)).status, 200);
    assert.deepEqual(s.store.listConnections('local')[0]!.writeAccounts, []);
    const tokens = await (await s.request('/api/connector-tokens', 'GET', undefined, s.headers)).json();
    assert.deepEqual(tokens.tokens.map((t: {role: string}) => t.role).sort(), ['operator', 'reader']);
    assert.equal(JSON.stringify(tokens).includes(operator.token), false);
    await s.request('/api/connector-tokens/' + operator.id, 'DELETE', undefined, s.headers);
    assert.throws(() => s.store.authenticate(operator.token));
    assert.equal(s.store.authenticate(reader.token).role, 'reader');
  } finally {
    await s.close();
  }
});

test('disabled deployments reject new write access while existing write grants can be revoked', async () => {
  const s = await site(false);
  try {
    s.store.putConnection(
      admin,
      {...connection, writeAccounts: ['111'], defaultWriteAccess: true},
      {accessToken: 'synthetic-not-live'},
    );
    const assets = '/api/connections/' + connection.id + '/assets';
    assert.equal(
      (await s.request(assets, 'PATCH', {selected: ['ad_accounts:111', 'ad_accounts:222']}, s.headers)).status,
      200,
    );
    assert.deepEqual(s.store.listConnections('local')[0]!.writeAccounts, ['111']);
    assert.equal(
      (await s.request(assets, 'PATCH', {selected: ['ad_accounts:111'], write_access: true}, s.headers)).status,
      403,
    );
    const state = await (await s.request('/api/session')).json();
    assert.equal(state.writesEnabled, false);
    assert.equal(state.readOnly, true);
    assert.equal(
      (await s.request('/api/connector-tokens', 'POST', {role: 'operator', confirmed: true}, s.headers)).status,
      403,
    );
    const access = '/api/connections/' + connection.id + '/write-access';
    assert.equal((await s.request(access, 'PATCH', {accounts: ['222'], confirmed: true}, s.headers)).status, 403);
    assert.equal((await s.request(access, 'PATCH', {accounts: []}, s.headers)).status, 200);
    assert.deepEqual(s.store.listConnections('local')[0]!.writeAccounts, []);
    const metadata = await (await s.request('/.well-known/oauth-authorization-server')).json();
    assert.deepEqual(metadata.scopes_supported, ['mcp:read']);
    assert.equal(
      (
        await s.request('/register', 'POST', {
          redirect_uris: ['http://127.0.0.1:8769/callback'],
          token_endpoint_auth_method: 'none',
          scope: 'mcp:read mcp:write',
        })
      ).status,
      400,
    );
  } finally {
    await s.close();
  }
});

test('operator OAuth consent and scope narrowing work through the HTTP authorization and token endpoints', async () => {
  const s = await site(true);
  try {
    const metadata = await (await s.request('/.well-known/oauth-authorization-server')).json();
    assert.deepEqual(metadata.scopes_supported, ['mcp:read', 'mcp:write']);
    const response = await s.request('/register', 'POST', {
      client_name: 'Synthetic operator MCP',
      redirect_uris: ['http://127.0.0.1:8769/callback'],
      token_endpoint_auth_method: 'none',
    });
    assert.equal(response.status, 201);
    const client = await response.json();
    const verifier = randomBytes(48).toString('base64url'),
      redirect = 'http://127.0.0.1:49222/callback',
      params = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: redirect,
        response_type: 'code',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        resource: origin + '/mcp',
      });
    const start = await s.request('/authorize?' + params);
    assert.equal(start.status, 303);
    const request = new URL(start.headers.get('location')!).searchParams.get('request')!;
    const preview = await (await s.request('/api/mcp/consent?request=' + request, 'GET', undefined, s.headers)).json();
    assert.equal(preview.role, 'operator');
    assert.equal(preview.scope, 'mcp:read mcp:write');
    assert.equal(
      (await s.request('/api/mcp/consent', 'POST', {request, approved: true}, {Cookie: s.headers.Cookie})).status,
      403,
    );
    const approved = await (await s.request('/api/mcp/consent', 'POST', {request, approved: true}, s.headers)).json(),
      code = new URL(approved.url).searchParams.get('code')!;
    const exchange = (body: Record<string, string>) =>
      fetch(s.base + '/token', {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams(body),
      });
    const issued = await exchange({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: redirect,
      resource: origin + '/mcp',
    });
    assert.equal(issued.status, 200);
    const credentials = await issued.json();
    assert.equal(s.store.authenticate(credentials.access_token).role, 'operator');
    const narrowed = await exchange({
      grant_type: 'refresh_token',
      client_id: client.client_id,
      refresh_token: credentials.refresh_token,
      scope: 'mcp:read',
    });
    assert.equal(narrowed.status, 200);
    const reader = await narrowed.json();
    assert.equal(s.store.authenticate(reader.access_token).role, 'reader');
    const increased = await exchange({
      grant_type: 'refresh_token',
      client_id: client.client_id,
      refresh_token: reader.refresh_token,
      scope: 'mcp:read mcp:write',
    });
    assert.equal(increased.status, 400);
    assert.equal((await increased.json()).error, 'invalid_scope');
  } finally {
    await s.close();
  }
});

async function oauthFixture(allowWrites = true) {
  const store = new Store(':memory:', master),
    web = new WebStore(store, {origin, masterKey: master, adminPassword: password}),
    oauth = new McpOAuth(web, allowWrites),
    session = await web.signIn(password, 'test');
  const register = (scope?: string) =>
    oauth.clientsStore.registerClient({
      redirect_uris: ['http://127.0.0.1:8769/callback?client=amcp'],
      token_endpoint_auth_method: 'none',
      ...(scope ? {scope} : {}),
    });
  const begin = async (
    client: Awaited<ReturnType<typeof register>>,
    scopes: string[] = [],
    redirectUri = client.redirect_uris[0]!,
  ) => {
    let location = '';
    const verifier = randomBytes(48).toString('base64url');
    await oauth.authorize(
      client,
      {
        redirectUri,
        scopes,
        codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
        resource: new URL(origin + '/mcp'),
      },
      {
        redirect: (_status: number, url: string) => {
          location = url;
        },
      } as ExpressResponse,
    );
    const request = new URL(location).searchParams.get('request')!,
      preview = oauth.consent(request, session),
      callback = new URL(oauth.decide(request, session, true));
    return {preview, code: callback.searchParams.get('code')!, verifier, redirectUri};
  };
  return {store, oauth, web, session, register, begin};
}

test('OAuth write scope has explicit consent, bound PKCE grants, and refresh cannot upgrade reader access', async () => {
  const f = await oauthFixture();
  try {
    const reader = await f.register('mcp:read'),
      writer = await f.register();
    assert.equal(writer.scope, 'mcp:read mcp:write');
    assert.equal(reader.scope, 'mcp:read');
    const defaultWriter = await f.begin(writer);
    assert.equal(defaultWriter.preview.role, 'operator');
    assert.equal(defaultWriter.preview.scope, 'mcp:read mcp:write');
    await assert.rejects(() => f.begin(reader, ['mcp:read', 'mcp:write']), /exceeds/);
    const defaultRead = await f.begin(writer, ['mcp:read']);
    assert.equal(defaultRead.preview.role, 'reader');
    assert.equal(defaultRead.preview.scope, 'mcp:read');
    const readTokens = await f.oauth.exchangeAuthorizationCode(
      writer,
      defaultRead.code,
      defaultRead.verifier,
      defaultRead.redirectUri,
    );
    assert.equal(f.store.authenticate(readTokens.access_token).role, 'reader');
    await assert.rejects(
      () => f.oauth.exchangeRefreshToken(writer, readTokens.refresh_token!, ['mcp:read', 'mcp:write']),
      /cannot add/,
    );
    const refreshedRead = await f.oauth.exchangeRefreshToken(writer, readTokens.refresh_token!);
    assert.equal(f.store.authenticate(refreshedRead.access_token).role, 'reader');
    const grant = await f.begin(writer, ['mcp:read', 'mcp:write']);
    assert.equal(grant.preview.role, 'operator');
    assert.equal(grant.preview.scope, 'mcp:read mcp:write');
    await assert.rejects(() =>
      f.oauth.exchangeAuthorizationCode(reader, grant.code, grant.verifier, grant.redirectUri),
    );
    await assert.rejects(() =>
      f.oauth.exchangeAuthorizationCode(writer, grant.code, 'wrong'.repeat(16), grant.redirectUri),
    );
    const tokens = await f.oauth.exchangeAuthorizationCode(writer, grant.code, grant.verifier, grant.redirectUri);
    assert.equal(f.store.authenticate(tokens.access_token).role, 'operator');
    assert.deepEqual((await f.oauth.verifyAccessToken(tokens.access_token)).scopes, ['mcp:read', 'mcp:write']);
    await assert.rejects(() =>
      f.oauth.exchangeAuthorizationCode(writer, grant.code, grant.verifier, grant.redirectUri),
    );
    const downgraded = await f.oauth.exchangeRefreshToken(writer, tokens.refresh_token!, ['mcp:read']);
    assert.equal(f.store.authenticate(downgraded.access_token).role, 'reader');
    await assert.rejects(
      () => f.oauth.exchangeRefreshToken(writer, downgraded.refresh_token!, ['mcp:read', 'mcp:write']),
      /cannot add/,
    );
    // MCP-08 (review 2026-10-08): inside the reuse window the rotated token is reissued, within the downgraded scope it
    // was replaced by, and the downgraded pair stops working; after the window the same presentation ends the family.
    const reissued = await f.oauth.exchangeRefreshToken(writer, tokens.refresh_token!);
    assert.equal(reissued.scope, 'mcp:read');
    assert.throws(() => f.store.authenticate(downgraded.access_token));
    f.store.db
      .prepare("UPDATE amcp_mcp_grants SET data=json_set(data,'$.rotated_at',0) WHERE hash=?")
      .run(createHash('sha256').update(tokens.refresh_token!).digest('hex'));
    await assert.rejects(() => f.oauth.exchangeRefreshToken(writer, tokens.refresh_token!));
    assert.throws(() => f.store.authenticate(reissued.access_token));
    assert.throws(() => f.store.authenticate(tokens.access_token));
  } finally {
    f.store.close();
  }
});

test('new connection selections and connector tokens default to read/write, explicit read-only and revocations persist', async () => {
  const s = await site(true);
  try {
    const c = {...connection, defaultWriteAccess: true};
    s.store.putConnection(admin, c, {accessToken: 'synthetic'});
    const assets = '/api/connections/' + c.id + '/assets',
      selection = {selected: ['ad_accounts:111', 'ad_accounts:222']};
    assert.equal((await s.request(assets, 'PATCH', selection, s.headers)).status, 200);
    assert.deepEqual(s.store.listConnections('local')[0]!.writeAccounts, ['111', '222']);
    const token = await (
      await s.request('/api/connector-tokens', 'POST', {name: 'Default connector', confirmed: true}, s.headers)
    ).json();
    assert.equal(s.store.authenticate(token.token).role, 'operator');
    await s.request(assets, 'PATCH', {...selection, write_access: false}, s.headers);
    assert.deepEqual(s.store.listConnections('local')[0]!.writeAccounts, []);
    await s.request(assets, 'PATCH', selection, s.headers);
    assert.deepEqual(s.store.listConnections('local')[0]!.writeAccounts, []);
    await s.request(assets, 'PATCH', {...selection, write_access: true}, s.headers);
    assert.deepEqual(s.store.listConnections('local')[0]!.writeAccounts, ['111', '222']);
    await s.request('/api/connections/' + c.id + '/write-access', 'PATCH', {accounts: []}, s.headers);
    await s.request(assets, 'PATCH', selection, s.headers);
    assert.deepEqual(s.store.listConnections('local')[0]!.writeAccounts, []);
  } finally {
    await s.close();
  }
});

test('legacy OAuth grant data remains read-only and loopback redirects relax only the port', async () => {
  const f = await oauthFixture();
  try {
    const client = await f.register(),
      grant = await f.begin(client, [], 'http://127.0.0.1:49152/callback?client=amcp');
    assert.equal(grant.preview.redirectUri, 'http://127.0.0.1:49152/callback?client=amcp');
    await assert.rejects(() =>
      f.oauth.exchangeAuthorizationCode(client, grant.code, grant.verifier, client.redirect_uris[0]),
    );
    // Simulate a reader code stored before scope-bearing grants were introduced.
    const rows = f.store.db.prepare("SELECT hash,data FROM amcp_mcp_grants WHERE kind='code'").all() as {
      hash: string;
      data: string;
    }[];
    for (const row of rows) {
      const data = JSON.parse(row.data);
      delete data.scope;
      f.store.db.prepare('UPDATE amcp_mcp_grants SET data=? WHERE hash=?').run(JSON.stringify(data), row.hash);
    }
    const tokens = await f.oauth.exchangeAuthorizationCode(client, grant.code, grant.verifier, grant.redirectUri);
    assert.equal(tokens.scope, 'mcp:read');
    assert.equal(f.store.authenticate(tokens.access_token).role, 'reader');
    for (const uri of [
      'http://localhost:49152/callback?client=amcp',
      'http://127.0.0.1:49152/other?client=amcp',
      'http://127.0.0.1:49152/callback?client=other',
      'http://attacker@127.0.0.1:49152/callback?client=amcp',
      'http://127.0.0.1:49152/callback?client=amcp#fragment',
    ])
      await assert.rejects(() => f.begin(client, [], uri), /registered redirect/);
  } finally {
    f.store.close();
  }
});

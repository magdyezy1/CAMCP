import {listenForFetch} from './http-listener.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {createHttpApp} from '../server/http-app.js';
import {McpOAuth} from '../server/mcp-oauth.js';
import {WebStore} from '../server/web-store.js';
import {removeTestDirectory} from './temp.js';

const origin = 'https://amcp.shop',
  redirect = 'https://claude.ai/api/mcp/auth_callback';
const master = Buffer.alloc(32, 81).toString('base64'),
  password = 'synthetic-claude-test-password';
const registration = {
  client_name: 'Claude',
  redirect_uris: [redirect],
  token_endpoint_auth_method: 'client_secret_post',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
};
async function site() {
  const store = new Store(':memory:', master),
    service = new MirrorService(new Registry(), store);
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
    const form = body instanceof URLSearchParams;
    const response = await fetch(base + url, {
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
    const bytes = await response.arrayBuffer();
    return new Response([204, 205, 304].includes(response.status) ? null : bytes, {
      status: response.status,
      headers: response.headers,
    });
  };
  const login = await request('/api/session', 'POST', {password});
  assert.equal(login.status, 200);
  const headers = {
    Cookie: login.headers.get('set-cookie')!.split(';')[0]!,
    'X-AMCP-CSRF': (await login.json()).csrf as string,
  };
  return {
    store,
    base,
    request,
    headers,
    close: async () => {
      const closing = new Promise<void>(r => listener.close(() => r()));
      listener.closeAllConnections();
      await closing;
      store.close();
    },
  };
}

test('Claude confidential DCR, S256 authorization, consent, code exchange, refresh and real MCP access', async () => {
  const s = await site(),
    mcp = new Client({name: 'Claude integration fixture', version: '1'});
  try {
    const metadata = await (await s.request('/.well-known/oauth-authorization-server')).json();
    assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ['client_secret_post', 'none']);
    assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
    const registered = await s.request('/register', 'POST', registration);
    assert.equal(registered.status, 201);
    assert.equal(registered.headers.get('cache-control'), 'no-store');
    const client = await registered.json();
    assert.equal(client.token_endpoint_auth_method, 'client_secret_post');
    assert.match(client.client_secret, /^[\w-]{43}$/);
    assert.equal(client.client_secret_expires_at, 0);
    const persisted = (
      s.store.db.prepare('SELECT data FROM amcp_mcp_clients WHERE id=?').get(client.client_id) as {data: string}
    ).data;
    assert.ok(!persisted.includes(client.client_secret));
    assert.equal(JSON.parse(persisted).client_secret, undefined);
    assert.ok(JSON.parse(persisted).encrypted_client_secret);
    const verifier = randomBytes(48).toString('base64url'),
      params = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: redirect,
        response_type: 'code',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        scope: 'mcp:read',
        state: 'claude-state',
        resource: origin + '/mcp',
      });
    const start = await s.request('/authorize?' + params);
    assert.equal(start.status, 303);
    const request = new URL(start.headers.get('location')!).searchParams.get('request')!;
    assert.equal((await s.request('/api/mcp/consent?request=' + request)).status, 401);
    const preview = await (await s.request('/api/mcp/consent?request=' + request, 'GET', undefined, s.headers)).json();
    assert.equal(preview.name, 'Claude');
    assert.equal(preview.redirectUri, redirect);
    assert.equal(preview.role, 'reader');
    assert.ok(!JSON.stringify(preview).includes(client.client_secret));
    assert.equal(
      (await s.request('/api/mcp/consent', 'POST', {request, approved: true}, {Cookie: s.headers.Cookie})).status,
      403,
    );
    const decision = await s.request('/api/mcp/consent', 'POST', {request, approved: true}, s.headers);
    assert.equal(decision.status, 200);
    const callback = new URL((await decision.json()).url);
    assert.equal(callback.origin + callback.pathname, redirect);
    assert.equal(callback.searchParams.get('state'), 'claude-state');
    const grant = {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      client_secret: client.client_secret,
      redirect_uri: redirect,
      code: callback.searchParams.get('code')!,
      code_verifier: verifier,
      resource: origin + '/mcp',
    };
    const token = (body: Record<string, string>) => s.request('/token', 'POST', new URLSearchParams(body));
    const {client_secret: _, ...missingSecret} = grant;
    for (const invalid of [
      missingSecret,
      {...grant, client_secret: 'incorrect'},
      {...grant, code_verifier: 'x'.repeat(64)},
      {...grant, redirect_uri: redirect + '?changed=1'},
      {...grant, resource: 'https://elsewhere.invalid/mcp'},
    ])
      assert.equal((await token(invalid)).status, 400);
    const exchanged = await token(grant);
    assert.equal(exchanged.status, 200);
    const credentials = await exchanged.json();
    assert.equal(credentials.scope, 'mcp:read');
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(s.base + '/mcp'), {
        requestInit: {headers: {Authorization: 'Bearer ' + credentials.access_token}},
      }),
    );
    assert.ok((await mcp.listTools()).tools.some(t => t.name === 'amcp_tool_help'));
    const help = await mcp.callTool({name: 'amcp_tool_help', arguments: {}});
    assert.equal(help.isError, undefined);
    const refresh = {
      grant_type: 'refresh_token',
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: credentials.refresh_token,
      resource: origin + '/mcp',
    };
    assert.equal((await token({...refresh, client_secret: 'incorrect'})).status, 400);
    assert.equal((await token({...refresh, scope: 'mcp:read mcp:write'})).status, 400);
    const rotatedResponse = await token(refresh);
    assert.equal(rotatedResponse.status, 200);
    const rotated = await rotatedResponse.json();
    assert.notEqual(rotated.refresh_token, credentials.refresh_token);
    const access = await s.request(
      '/mcp',
      'POST',
      {jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}},
      {Authorization: 'Bearer ' + rotated.access_token, Accept: 'application/json, text/event-stream'},
    );
    assert.equal(access.status, 200);
    // MCP-08 (review 2026-10-08): presenting the just-rotated token again inside the reuse window (a lost response, a
    // second tab) reissues within the family instead of ending it, and the pair it replaced stops working.
    const reissuedResponse = await token(refresh);
    assert.equal(reissuedResponse.status, 200);
    const reissued = await reissuedResponse.json();
    assert.throws(() => s.store.authenticate(rotated.access_token), {code: 'UNAUTHORIZED'});
    s.store.authenticate(reissued.access_token);
    // Outside the window the same presentation is a replay, and the connection ends.
    s.store.db
      .prepare("UPDATE amcp_mcp_grants SET data=json_set(data,'$.rotated_at',0) WHERE hash=?")
      .run(createHash('sha256').update(credentials.refresh_token).digest('hex'));
    assert.equal((await token(refresh)).status, 400);
    assert.throws(() => s.store.authenticate(reissued.access_token), {code: 'UNAUTHORIZED'});
  } finally {
    await mcp.close();
    await s.close();
  }
});

test('a replayed authorization code is refused and revokes the tokens its first exchange issued', async () => {
  const s = await site();
  try {
    const client = await (await s.request('/register', 'POST', registration)).json(),
      verifier = randomBytes(48).toString('base64url');
    const start = await s.request(
      '/authorize?' +
        new URLSearchParams({
          client_id: client.client_id,
          redirect_uri: redirect,
          response_type: 'code',
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256',
          scope: 'mcp:read',
          resource: origin + '/mcp',
        }),
    );
    const request = new URL(start.headers.get('location')!).searchParams.get('request')!;
    const code = new URL(
      (await (await s.request('/api/mcp/consent', 'POST', {request, approved: true}, s.headers)).json()).url,
    ).searchParams.get('code')!;
    const grant = {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      client_secret: client.client_secret,
      redirect_uri: redirect,
      code,
      code_verifier: verifier,
      resource: origin + '/mcp',
    };
    const token = (body: Record<string, string>) => s.request('/token', 'POST', new URLSearchParams(body));
    const first = await token(grant);
    assert.equal(first.status, 200);
    const credentials = await first.json();
    s.store.authenticate(credentials.access_token);
    // Whoever replays the code, even without the verifier, ends the access the first exchange granted.
    assert.equal((await token({...grant, code_verifier: 'x'.repeat(64)})).status, 400);
    assert.throws(() => s.store.authenticate(credentials.access_token), {code: 'UNAUTHORIZED'});
    assert.equal(
      (
        await token({
          grant_type: 'refresh_token',
          client_id: client.client_id,
          client_secret: client.client_secret,
          refresh_token: credentials.refresh_token,
          resource: origin + '/mcp',
        })
      ).status,
      400,
    );
    assert.equal((await token(grant)).status, 400);
  } finally {
    await s.close();
  }
});

// MCP-03 (review 2026-10-08): this was "keeps each client's newest refresh grant", which asserted the retention that kept
// old clients counted against the registration cap for good. It is now a liveness pair: the newest refresh grant is kept
// while one of the client's grants is live, and the client is released once nothing is live past the grace period.
test("issuing tokens prunes expired access grants and rotated refresh grants, keeps a live client's newest refresh grant, and registration releases the client once nothing is live past the grace period", async () => {
  const s = await site();
  try {
    const db = s.store.db,
      past = Date.now() - 1000,
      hash = (t: string) => createHash('sha256').update(t).digest('hex');
    const insert = (token: string, kind: string, client: string, used: number, expires: number) =>
      db
        .prepare('INSERT INTO amcp_mcp_grants VALUES(?,?,?,?,?,?,?)')
        .run(hash(token), kind, client, 'local', '{}', expires, used);
    db.prepare('INSERT INTO amcp_mcp_clients VALUES(?,?)').run(
      'idle-client',
      JSON.stringify({client_id: 'idle-client', client_id_issued_at: Math.floor(Date.now() / 1000) - 40 * 86400}),
    );
    const key = s.store.createKey({tenantId: 'local', userId: 'oauth/idle-client', role: 'reader'}, 1);
    insert(key, 'access', 'idle-client', 0, past);
    insert('rotated-refresh', 'refresh', 'idle-client', 1, past - 1000);
    insert('last-refresh', 'refresh', 'idle-client', 1, past);
    insert('live-access', 'access', 'idle-client', 0, Date.now() + 3600000);
    const client = await (await s.request('/register', 'POST', registration)).json(),
      verifier = randomBytes(48).toString('base64url');
    const start = await s.request(
      '/authorize?' +
        new URLSearchParams({
          client_id: client.client_id,
          redirect_uri: redirect,
          response_type: 'code',
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256',
          scope: 'mcp:read',
          resource: origin + '/mcp',
        }),
    );
    const request = new URL(start.headers.get('location')!).searchParams.get('request')!;
    const code = new URL(
      (await (await s.request('/api/mcp/consent', 'POST', {request, approved: true}, s.headers)).json()).url,
    ).searchParams.get('code')!;
    assert.equal(
      (
        await s.request(
          '/token',
          'POST',
          new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: client.client_id,
            client_secret: client.client_secret,
            redirect_uri: redirect,
            code,
            code_verifier: verifier,
            resource: origin + '/mcp',
          }),
        )
      ).status,
      200,
    );
    const left = (
      db.prepare("SELECT hash FROM amcp_mcp_grants WHERE client_id='idle-client'").all() as {hash: string}[]
    )
      .map(r => r.hash)
      .sort();
    assert.deepEqual(left, [hash('last-refresh'), hash('live-access')].sort());
    assert.equal(db.prepare('SELECT hash FROM api_keys WHERE hash=?').get(hash(key)), undefined);
    // While a grant is live, a new registration leaves the client alone.
    assert.equal((await s.request('/register', 'POST', registration)).status, 201);
    assert.ok(db.prepare("SELECT 1 FROM amcp_mcp_clients WHERE id='idle-client'").get());
    // Nothing live, and the newest grant expired more than seven days ago: the next registration releases the client.
    db.prepare("UPDATE amcp_mcp_grants SET used=1,expires_at=? WHERE client_id='idle-client'").run(
      Date.now() - 8 * 86400000,
    );
    assert.equal((await s.request('/register', 'POST', registration)).status, 201);
    assert.equal(db.prepare("SELECT 1 FROM amcp_mcp_clients WHERE id='idle-client'").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM amcp_mcp_grants WHERE client_id='idle-client'").get(), undefined);
  } finally {
    await s.close();
  }
});

test('registration and authorization preserve public clients, redirect, scope, resource and PKCE restrictions', async () => {
  const s = await site();
  try {
    for (const redirect_uris of [
      ['http://claude.ai/api/mcp/auth_callback'],
      [redirect + '#fragment'],
      ['https://user:pass@claude.ai/api/mcp/auth_callback'],
    ])
      assert.equal((await s.request('/register', 'POST', {...registration, redirect_uris})).status, 400);
    for (const method of ['client_secret_basic', 'private_key_jwt'])
      assert.equal(
        (await s.request('/register', 'POST', {...registration, token_endpoint_auth_method: method})).status,
        400,
      );
    assert.equal((await s.request('/register', 'POST', {...registration, scope: 'mcp:write'})).status, 400);
    const client = await (
      await s.request('/register', 'POST', {...registration, token_endpoint_auth_method: 'none'})
    ).json();
    assert.equal(client.client_secret, undefined);
    const params = {
      client_id: client.client_id,
      redirect_uri: redirect,
      response_type: 'code',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
      scope: 'mcp:read',
      resource: origin + '/mcp',
    };
    for (const change of [
      {redirect_uri: redirect + '/other'},
      {code_challenge_method: 'plain'},
      {code_challenge: ''},
      {scope: 'mcp:read mcp:write'},
      {resource: origin + '/other'},
    ]) {
      const response = await s.request('/authorize?' + new URLSearchParams({...params, ...change}));
      if (response.status === 302) {
        const location = new URL(response.headers.get('location')!);
        assert.ok(location.searchParams.get('error'));
        assert.equal(location.searchParams.get('code'), null);
      } else assert.ok(response.status >= 400);
    }
    const before = s.store.db.prepare('SELECT count(*) n FROM amcp_mcp_grants').get() as {n: number};
    assert.equal(before.n, 0);
    assert.equal(
      (
        await s.request(
          '/token',
          'POST',
          new URLSearchParams({
            client_id: client.client_id,
            client_secret: 'injected',
            grant_type: 'refresh_token',
            refresh_token: 'invalid',
          }),
        )
      ).status,
      400,
    );
  } finally {
    await s.close();
  }
});

test('confidential secrets persist encrypted across restart and are bound to client and encryption key', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-client-secret-')),
    file = path.join(directory, 'db.sqlite');
  let store = new Store(file, master);
  try {
    let oauth = new McpOAuth(new WebStore(store, {origin, masterKey: master}));
    const first = await oauth.clientsStore.registerClient(registration),
      second = await oauth.clientsStore.registerClient(registration);
    assert.notEqual(first.client_secret, second.client_secret);
    store.close();
    store = new Store(file, master);
    oauth = new McpOAuth(new WebStore(store, {origin, masterKey: master}));
    await oauth.authenticateClient({client_id: first.client_id, client_secret: first.client_secret});
    await assert.rejects(oauth.authenticateClient({client_id: first.client_id, client_secret: second.client_secret}), {
      name: 'InvalidClientError',
    });
    const wrongKey = new McpOAuth(new WebStore(store, {origin, masterKey: Buffer.alloc(32, 82).toString('base64')}));
    await assert.rejects(wrongKey.clientsStore.getClient(first.client_id), {code: 'SECRET_DECRYPT_FAILED'});
    const row = (
      store.db.prepare('SELECT data FROM amcp_mcp_clients WHERE id=?').get(first.client_id) as {data: string}
    ).data;
    store.db.prepare('UPDATE amcp_mcp_clients SET data=? WHERE id=?').run(row, second.client_id);
    await assert.rejects(oauth.clientsStore.getClient(second.client_id), {code: 'SECRET_DECRYPT_FAILED'});
  } finally {
    store.close();
    removeTestDirectory(directory, 'amcp-client-secret-');
  }
});

test('invalid confidential authentication retains a rate limit and never emits secrets', async () => {
  const s = await site();
  try {
    for (let i = 0; i < 50; i++)
      assert.equal(
        (
          await s.request(
            '/token',
            'POST',
            new URLSearchParams({client_id: 'invalid', client_secret: 'synthetic-secret'}),
          )
        ).status,
        400,
      );
    const blocked = await s.request(
      '/token',
      'POST',
      new URLSearchParams({client_id: 'invalid', client_secret: 'synthetic-secret'}),
    );
    assert.equal(blocked.status, 429);
    assert.ok(!(await blocked.text()).includes('synthetic-secret'));
  } finally {
    await s.close();
  }
});

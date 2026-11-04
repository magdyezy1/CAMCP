import {listenForFetch} from './http-listener.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/client';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService, strictOptions} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {MirrorError, errorResult} from '../src/errors.js';
import {createHttpApp} from '../server/http-app.js';
import {createMcpServer} from '../server/mcp.js';
import {McpOAuth, validateMcpToken} from '../server/mcp-oauth.js';
import {WebStore, type WebsiteOptions} from '../server/web-store.js';
import {UserAccounts} from '../server/user-accounts.js';
import type {Actor, JsonObject} from '../src/types.js';

/**
 * SEC-05 (review 2026-10-08): /mcp validates every bearer token through one function. Before, it read only the
 * api_keys row, so the OAuth grant state, the door-password binding and the resource were never checked there and
 * every revocation path had to remember to revoke the key as well. A revoked in-process session also kept listing
 * tools, and UNAUTHORIZED told the assistant to correct its arguments instead of reconnecting.
 */
const origin = 'https://amcp.shop',
  redirect = 'https://claude.ai/api/mcp/auth_callback',
  master = Buffer.alloc(32, 53).toString('base64'),
  password = 'synthetic-validation-admin-password';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

async function fixture(options: {website?: boolean} = {}) {
  const store = new Store(':memory:', master),
    service = new MirrorService(new Registry(), store, new NativeTransport(), strictOptions, {
      allowWrites: true,
      requireBeforeState: true,
      maxBudgetChange: 0,
    }),
    website: WebsiteOptions = {
      origin,
      masterKey: master,
      adminPassword: password,
      fetcher: async () => {
        throw Error('No provider traffic allowed');
      },
    };
  // A second view of the same database creates members and AI-client grants, as the website routes would.
  const web = new WebStore(store, website),
    accounts = new UserAccounts(web),
    oauth = new McpOAuth(web, true);
  const listener = await listenForFetch(
    createHttpApp(service, store, {publicOrigin: origin, ...(options.website === false ? {} : {website})}),
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
  const session = (user: JsonObject) => {
    const s = accounts.session(user, web.tenantId);
    return {Cookie: web.cookie(s.id), 'X-AMCP-CSRF': s.csrf};
  };
  const member = (role: 'viewer' | 'operator' | 'admin', email = role + '@example.test') => {
    const user = accounts.newUser('Member ' + role, email, null, true);
    store.db
      .prepare('INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,?,?)')
      .run(web.tenantId, user.id, role, Date.now());
    return {user, headers: session(user)};
  };
  let admin: Record<string, string> | undefined;
  /** The administrator door's website session (only where the website runs). */
  const adminHeaders = async () => {
    if (admin) return admin;
    const login = await request('/api/session', 'POST', {password});
    assert.equal(login.status, 200);
    admin = {
      Cookie: login.headers.get('set-cookie')!.split(';')[0]!,
      'X-AMCP-CSRF': (await login.json()).csrf as string,
    };
    return admin;
  };
  const token = (body: Record<string, string>) => request('/token', 'POST', new URLSearchParams(body));
  /** Registers a client, authorizes it from `headers`'s session and exchanges the code over HTTP. */
  const connect = async (headers: Record<string, string>, name = 'Claude') => {
    const registered = await request('/register', 'POST', {
      client_name: name,
      redirect_uris: [redirect],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
    assert.equal(registered.status, 201);
    const client = await registered.json(),
      verifier = randomBytes(48).toString('base64url');
    const start = await request(
      '/authorize?' +
        new URLSearchParams({
          client_id: client.client_id,
          redirect_uri: redirect,
          response_type: 'code',
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256',
          scope: 'mcp:read mcp:write',
          state: 'validation-state',
          resource: origin + '/mcp',
        }),
    );
    assert.equal(start.status, 303);
    const consentRequest = new URL(start.headers.get('location')!).searchParams.get('request')!;
    const decision = await request('/api/mcp/consent', 'POST', {request: consentRequest, approved: true}, headers);
    assert.equal(decision.status, 200, await decision.clone().text());
    const callback = new URL((await decision.json()).url);
    const exchanged = await token({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      redirect_uri: redirect,
      code: callback.searchParams.get('code')!,
      code_verifier: verifier,
      resource: origin + '/mcp',
    });
    assert.equal(exchanged.status, 200);
    return {client, credentials: await exchanged.json()};
  };
  const refresh = (client: JsonObject, refreshToken: string) =>
    token({
      grant_type: 'refresh_token',
      client_id: client.client_id,
      refresh_token: refreshToken,
      resource: origin + '/mcp',
    });
  const mcp = async (access: string) =>
    (
      await request(
        '/mcp',
        'POST',
        {jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}},
        {Authorization: 'Bearer ' + access, Accept: 'application/json, text/event-stream'},
      )
    ).status;
  return {
    store,
    service,
    web,
    accounts,
    oauth,
    request,
    adminHeaders,
    member,
    connect,
    refresh,
    mcp,
    close: async () => {
      const closing = new Promise<void>(r => listener.close(() => r()));
      listener.closeAllConnections();
      await closing;
      store.close();
    },
  };
}

test('SEC-05: every revocation entry point gives 401 at /mcp on the next call', async () => {
  const f = await fixture();
  try {
    const admin = await f.adminHeaders();
    const checked: string[] = [];
    const ended = async (name: string, access: string, revoke: () => Promise<unknown> | unknown) => {
      assert.equal(await f.mcp(access), 200, name + ' works before');
      await revoke();
      assert.equal(await f.mcp(access), 401, name + ' is refused after');
      checked.push(name);
    };
    // The workspace owner or administrator revokes a client from the website.
    const owned = await f.connect(admin, 'Owner revoke');
    await ended('owner revoke', owned.credentials.access_token, async () =>
      assert.equal(
        (await f.request('/api/mcp/authorizations/' + owned.client.client_id, 'DELETE', undefined, admin)).status,
        200,
      ),
    );
    // The client revokes its own refresh token (RFC 7009).
    const own = await f.connect(admin, 'RFC 7009');
    await ended('RFC 7009', own.credentials.access_token, async () =>
      assert.equal(
        (
          await f.request(
            '/revoke',
            'POST',
            new URLSearchParams({client_id: own.client.client_id, token: own.credentials.refresh_token}),
          )
        ).status,
        200,
      ),
    );
    // A rotated refresh token presented again after the reuse window ends the family.
    const family = await f.connect(admin, 'Family');
    const rotated = await (await f.refresh(family.client, family.credentials.refresh_token)).json();
    await ended('family revoke', rotated.access_token, async () => {
      f.store.db
        .prepare(
          "UPDATE amcp_mcp_grants SET data=json_set(data,'$.rotated_at',json_extract(data,'$.rotated_at')-120000) WHERE hash=?",
        )
        .run(sha(family.credentials.refresh_token));
      assert.equal((await f.refresh(family.client, family.credentials.refresh_token)).status, 400);
    });
    // An owner changes a member's role.
    const operator = f.member('operator'),
      demoted = await f.connect(operator.headers, 'Membership');
    await ended('membership change', demoted.credentials.access_token, async () =>
      assert.equal(
        (await f.request('/api/workspaces/member', 'POST', {userId: operator.user.id, role: 'viewer'}, admin)).status,
        200,
      ),
    );
    // A member's password changes (the security revocation every password, email and MFA change runs).
    const person = f.member('admin', 'password@example.test'),
      personal = await f.connect(person.headers, 'Password');
    await ended('password change', personal.credentials.access_token, () =>
      f.accounts.revokeAccess(f.accounts.user(person.user.id), 'password_change'),
    );
    // A member's own connector token is revoked from the website.
    const tool = f.member('operator', 'connector@example.test');
    const created = await (
      await f.request('/api/connector-tokens', 'POST', {name: 'Tool', role: 'operator', confirmed: true}, tool.headers)
    ).json();
    await ended('connector revoke', created.token, async () =>
      assert.equal(
        (await f.request('/api/connector-tokens/' + created.id, 'DELETE', undefined, tool.headers)).status,
        200,
      ),
    );
    // A process starts with a new administrator password: access approved from the door ends.
    const door = await f.connect(admin, 'Door');
    await ended(
      'door rotation',
      door.credentials.access_token,
      () => new WebStore(f.store, {origin, masterKey: master, adminPassword: 'another-synthetic-admin-password'}),
    );
    assert.deepEqual(checked, [
      'owner revoke',
      'RFC 7009',
      'family revoke',
      'membership change',
      'password change',
      'connector revoke',
      'door rotation',
    ]);
  } finally {
    await f.close();
  }
});

test('SEC-05: /mcp refuses an AI-client token whose grant ended without its API key being revoked (regression: only api_keys was read)', async () => {
  const f = await fixture();
  try {
    const {credentials} = await f.connect(await f.adminHeaders());
    assert.equal(await f.mcp(credentials.access_token), 200);
    // A future revocation path that ends the grant but forgets the key.
    f.store.db.prepare('UPDATE amcp_mcp_grants SET used=1 WHERE hash=?').run(sha(credentials.access_token));
    assert.equal(
      (f.store.db.prepare('SELECT revoked FROM api_keys WHERE hash=?').get(sha(credentials.access_token)) as JsonObject)
        .revoked,
      0,
    );
    assert.equal(await f.mcp(credentials.access_token), 401);
  } finally {
    await f.close();
  }
});

test('SEC-05: /mcp refuses door-approved access once the door password changed in another process, and a token for another resource (regression)', async () => {
  const f = await fixture();
  try {
    const admin = await f.adminHeaders();
    const door = await f.connect(admin, 'Door');
    const other = await f.connect(admin, 'Other resource');
    assert.equal(await f.mcp(door.credentials.access_token), 200);
    assert.equal(await f.mcp(other.credentials.access_token), 200);
    // Another process recorded a new administrator password; this one still runs the old one and revoked nothing.
    f.store.db
      .prepare("UPDATE amcp_web_doors SET hash=? WHERE door='workspace-admin:local'")
      .run('scrypt-v3$' + '0'.repeat(32) + '$' + '0'.repeat(64));
    assert.equal(await f.mcp(door.credentials.access_token), 401);
    f.store.db
      .prepare("UPDATE amcp_web_doors SET hash=? WHERE door='workspace-admin:local'")
      .run(f.web.administratorHash!);
    assert.equal(await f.mcp(door.credentials.access_token), 200);
    // The grant names the protected resource it was issued for; one issued for another endpoint is refused here.
    const grant = f.store.db
      .prepare('SELECT data FROM amcp_mcp_grants WHERE hash=?')
      .get(sha(other.credentials.access_token)) as {data: string};
    assert.equal(JSON.parse(grant.data).resource, origin + '/mcp');
    f.store.db
      .prepare("UPDATE amcp_mcp_grants SET data=json_set(data,'$.resource','https://other.example/mcp') WHERE hash=?")
      .run(sha(other.credentials.access_token));
    assert.equal(await f.mcp(other.credentials.access_token), 401);
  } finally {
    await f.close();
  }
});

test('SEC-05: API keys keep working at /mcp, an AI-client key without its grant is refused, and without the website AI-client tokens are refused', async () => {
  const f = await fixture();
  try {
    const key = f.store.createKey({tenantId: 'local', userId: 'cli', role: 'reader'});
    assert.equal(await f.mcp(key), 200);
    const orphan = f.store.createKey({tenantId: 'local', userId: 'oauth/no-grant', role: 'reader'});
    assert.equal(await f.mcp(orphan), 401);
    const {credentials} = await f.connect(await f.adminHeaders());
    assert.equal(await f.mcp(credentials.access_token), 200);
    // The SDK's resource-server hook answers through the same validator.
    const info = await f.oauth.verifyAccessToken(credentials.access_token);
    assert.deepEqual(info.scopes, ['mcp:read', 'mcp:write']);
    assert.equal(info.resource.href, origin + '/mcp');
    f.store.db.prepare('UPDATE amcp_mcp_grants SET used=1 WHERE hash=?').run(sha(credentials.access_token));
    await assert.rejects(f.oauth.verifyAccessToken(credentials.access_token), {code: 'UNAUTHORIZED'});
  } finally {
    await f.close();
  }
  const plain = await fixture({website: false});
  try {
    const key = plain.store.createKey({tenantId: 'local', userId: 'cli', role: 'reader'});
    assert.equal(await plain.mcp(key), 200);
    const client = plain.store.createKey({tenantId: 'local', userId: 'oauth/elsewhere', role: 'reader'});
    assert.throws(() => validateMcpToken(plain.store, client), {code: 'UNAUTHORIZED'});
    assert.equal(await plain.mcp(client), 401);
  } finally {
    await plain.close();
  }
});

/** An in-process MCP session for an actor, as stdio or a long request holds one. */
async function session(service: MirrorService, actor: Actor) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair(),
    server = createMcpServer(service, actor),
    client = new Client({name: 'sec-05', version: '1'});
  await server.connect(serverSide);
  await client.connect(clientSide);
  return {client, close: () => Promise.allSettled([client.close(), server.close()])};
}

test('SEC-05: after a mid-session revocation tools/list rejects and tool errors name the auth category and the reconnect remedy (regression: tools/list still listed)', async () => {
  const f = await fixture();
  try {
    const key = f.store.createKey({tenantId: 'local', userId: 'cli', role: 'reader'}),
      s = await session(f.service, validateMcpToken(f.store, key));
    try {
      assert.ok((await s.client.listTools()).tools.length > 0);
      f.store.revokeKey(key);
      await assert.rejects(s.client.listTools(), /revoked during this request/);
      const call = await s.client.callTool({name: 'amcp_tool_help', arguments: {}});
      assert.equal(call.isError, true);
      const error = (call.structuredContent as JsonObject).error as JsonObject;
      assert.equal(error.code, 'UNAUTHORIZED');
      assert.equal(error.category, 'auth');
      assert.equal(error.remedy.owner, 'user');
      assert.equal(error.remedy.mutation_retry_safe, false);
      assert.match(error.next_action, /^Reconnect the AMCP connector or create a new API key/);
      assert.doesNotMatch(error.next_action, /Correct what the message names/);
    } finally {
      await s.close();
    }
    // An AI-client grant that ends mid-session (its key untouched) is caught at the next check, too.
    const {credentials} = await f.connect(await f.adminHeaders());
    const live = await session(f.service, validateMcpToken(f.store, credentials.access_token, f.oauth));
    try {
      assert.ok((await live.client.listTools()).tools.length > 0);
      f.store.db.prepare('UPDATE amcp_mcp_grants SET used=1 WHERE hash=?').run(sha(credentials.access_token));
      await assert.rejects(live.client.listTools(), /authorization ended, expired or was revoked/);
    } finally {
      await live.close();
    }
  } finally {
    await f.close();
  }
});

test('SEC-05: UNAUTHORIZED maps to category auth, owner user and the reconnect remedy', () => {
  const result = errorResult(
    new MirrorError('UNAUTHORIZED', 'A valid, unexpired API key is required.', {}, 401),
    'r',
    0,
  );
  assert.equal(result.error.category, 'auth');
  assert.deepEqual(
    {owner: result.error.remedy.owner, retry: result.error.remedy.mutation_retry_safe},
    {owner: 'user', retry: false},
  );
  assert.equal(result.error.next_action, result.error.remedy.action);
  assert.match(
    result.error.remedy.action,
    /Reconnect the AMCP connector or create a new API key, then send the call again/,
  );
});

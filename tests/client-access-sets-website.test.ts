// SEC-08 phase 2 on the website: "Limit to client" when creating a connector token, approving an AI client and
// inviting a member. Before, a token, AI client or invited viewer always reached every account of the workspace.
// Synthetic fixtures only: the provider fetcher throws, and email goes to a recording fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import type {Request} from 'express';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {createHttpApp} from '../server/http-app.js';
import {WebStore} from '../server/web-store.js';
import {UserAccounts} from '../server/user-accounts.js';
import {AccountSecurity} from '../server/account-security.js';
import {listAccessSets, saveAccessSet} from '../src/access-sets.js';
import {listenForFetch} from './http-listener.js';
import type {Actor, JsonObject} from '../src/types.js';

const origin = 'https://amcp.shop',
  redirect = 'https://claude.ai/api/mcp/auth_callback',
  master = Buffer.alloc(32, 61).toString('base64'),
  password = 'synthetic-access-set-password',
  A = '3100000001',
  B = '3200000002';

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
  const request = async (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + url, {
      method,
      redirect: 'manual',
      headers: {
        Origin: origin,
        ...(body === undefined
          ? {}
          : {
              'Content-Type':
                body instanceof URLSearchParams ? 'application/x-www-form-urlencoded' : 'application/json',
            }),
        ...headers,
      },
      body: body === undefined ? undefined : body instanceof URLSearchParams ? body : JSON.stringify(body),
    });
  const login = await request('/api/session', 'POST', {password});
  assert.equal(login.status, 200);
  const headers = {
    Cookie: login.headers.get('set-cookie')!.split(';')[0]!,
    'X-AMCP-CSRF': (await login.json()).csrf as string,
  };
  const admin: Actor = {tenantId: 'local', userId: 'workspace-admin', role: 'admin'};
  store.putConnection(
    admin,
    {
      id: 'meta-login',
      tenantId: 'local',
      gateway: 'meta_native_action',
      accounts: [A, B],
      writeAccounts: [A, B],
      enabled: true,
      label: 'Agency Meta',
      scopes: ['ads_read'],
    },
    {accessToken: 'synthetic'},
  );
  store.putDocument('local', 'website_assets', 'meta-login', {
    groups: [
      {
        kind: 'ad_accounts',
        complete: true,
        assets: [
          {id: 'act_' + A, kind: 'ad_accounts', name: 'Client A account', source: 'vendor'},
          {id: 'act_' + B, kind: 'ad_accounts', name: 'Client B account', source: 'vendor'},
        ],
      },
      {kind: 'pages', complete: true, assets: [{id: '77', kind: 'pages', name: 'Client B Page', source: 'vendor'}]},
    ],
    selected: ['ad_accounts:' + A, 'ad_accounts:' + B],
    lastSync: Date.now(),
  });
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
async function listAccounts(base: string, token: string) {
  const client = new Client({name: 'access set fixture', version: '1'});
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
      requestInit: {headers: {Authorization: 'Bearer ' + token}},
    }),
  );
  try {
    const r: any = await client.callTool({
      name: 'amcp_native_action',
      arguments: {operation: 'list_accounts', arguments: {}},
    });
    return JSON.parse(r.content[0].text);
  } finally {
    await client.close();
  }
}

test('a connector token and an AI client limited to a client reach only that client’s accounts', async () => {
  const s = await site();
  try {
    // An administrator names the client's accounts.
    const created = await s.request(
      '/api/access-sets',
      'POST',
      {name: 'Client A', bindings: [{gateway: 'meta_native_action', connection_id: 'meta-login', account_id: A}]},
      s.headers,
    );
    assert.equal(created.status, 200, await created.clone().text());
    const set = (await created.json()) as JsonObject;
    // Connector token, limited.
    const issued = await s.request(
      '/api/connector-tokens',
      'POST',
      {name: 'Client A assistant', role: 'reader', access_set_id: set.id},
      s.headers,
    );
    assert.equal(issued.status, 200, await issued.clone().text());
    const connector = (await issued.json()) as JsonObject;
    assert.equal(connector.access_set_id, set.id);
    assert.equal(s.store.authenticate(connector.token as string).accessSetId, set.id);
    const limited = JSON.stringify(await listAccounts(s.base, connector.token as string));
    assert.ok(limited.includes('Client A account') && !limited.includes(B), limited.slice(0, 500));
    // An unlimited token still lists both, as before.
    const whole = (await (
      await s.request('/api/connector-tokens', 'POST', {name: 'Agency assistant', role: 'reader'}, s.headers)
    ).json()) as JsonObject;
    assert.equal(whole.access_set_id, null);
    assert.ok(JSON.stringify(await listAccounts(s.base, whole.token as string)).includes('Client B account'));
    // A set that does not exist is refused.
    const missing = await s.request(
      '/api/connector-tokens',
      'POST',
      {name: 'x', role: 'reader', access_set_id: 'missing'},
      s.headers,
    );
    assert.equal(missing.status, 400);
    assert.equal(((await missing.json()) as JsonObject).error.code, 'ACCESS_SET_NOT_FOUND');
    // An AI client approved for client A only, through the real OAuth flow.
    const client = (await (
      await s.request('/register', 'POST', {
        client_name: 'Claude',
        redirect_uris: [redirect],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'mcp:read',
      })
    ).json()) as JsonObject;
    const verifier = randomBytes(48).toString('base64url');
    const start = await s.request(
      '/authorize?' +
        new URLSearchParams({
          client_id: client.client_id as string,
          redirect_uri: redirect,
          response_type: 'code',
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256',
          scope: 'mcp:read',
          resource: origin + '/mcp',
        }),
    );
    const request = new URL(start.headers.get('location')!).searchParams.get('request')!;
    const consent = (await (
      await s.request('/api/mcp/consent?request=' + encodeURIComponent(request), 'GET', undefined, s.headers)
    ).json()) as JsonObject;
    assert.deepEqual(consent.access_sets, [{id: set.id, name: 'Client A'}]);
    assert.equal(consent.access_set_required, null);
    const decision = await s.request(
      '/api/mcp/consent',
      'POST',
      {request, approved: true, access_set_id: set.id},
      s.headers,
    );
    assert.equal(decision.status, 200, await decision.clone().text());
    const exchanged = (await (
      await s.request(
        '/token',
        'POST',
        new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: client.client_id as string,
          redirect_uri: redirect,
          code: new URL(((await decision.json()) as JsonObject).url as string).searchParams.get('code')!,
          code_verifier: verifier,
          resource: origin + '/mcp',
        }),
      )
    ).json()) as JsonObject;
    assert.equal(s.store.authenticate(exchanged.access_token as string).accessSetId, set.id);
    const viaOAuth = JSON.stringify(await listAccounts(s.base, exchanged.access_token as string));
    assert.ok(viaOAuth.includes('Client A account') && !viaOAuth.includes(B), viaOAuth.slice(0, 500));
    // A refresh keeps the limit.
    const refreshed = (await (
      await s.request(
        '/token',
        'POST',
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: client.client_id as string,
          refresh_token: exchanged.refresh_token as string,
          resource: origin + '/mcp',
        }),
      )
    ).json()) as JsonObject;
    assert.equal(s.store.authenticate(refreshed.access_token as string).accessSetId, set.id);
    const authorizations = (await (
      await s.request('/api/mcp/authorizations', 'GET', undefined, s.headers)
    ).json()) as JsonObject;
    assert.equal((authorizations.clients as JsonObject[])[0]!.access_set_id, set.id);
    // The administrator's list says how much access each set limits.
    const sets = (await (await s.request('/api/access-sets', 'GET', undefined, s.headers)).json()) as JsonObject;
    assert.equal((sets.sets as JsonObject[])[0]!.name, 'Client A');
    assert.ok(((sets.sets as JsonObject[])[0]!.in_use as JsonObject).credentials >= 2);
  } finally {
    await s.close();
  }
});

test('a member invited for one client sees only that client on the website and hands on only that limit', async () => {
  const s = await site();
  try {
    const set = saveAccessSet(
      s.store,
      {tenantId: 'local', userId: 'workspace-admin', role: 'admin'},
      {
        name: 'Client A',
        bindings: [{gateway: 'meta_native_action', connection_id: 'meta-login', account_id: A}],
      },
    );
    s.store.putDocument('local', 'client_profile', 'profile-a', {
      name: 'Client A',
      bindings: [{gateway: 'meta_native_action', connection_id: 'meta-login', account_id: A}],
    });
    s.store.putDocument('local', 'client_profile', 'profile-b', {
      name: 'Client B',
      bindings: [{gateway: 'meta_native_action', connection_id: 'meta-login', account_id: B}],
    });
    // An invitation for client A, accepted (the account-security flow with a recording email fake).
    const emails: JsonObject[] = [];
    const web = new WebStore(s.store, {
        origin,
        masterKey: master,
        adminPassword: password,
        authEnv: {AMCP_EMAIL_API_KEY: 'synthetic-email-key', AMCP_EMAIL_FROM: 'AMCP <accounts@example.test>'},
        fetcher: async (_url, init) => {
          emails.push(JSON.parse(String(init?.body)));
          return new Response('{"id":"mail"}', {headers: {'Content-Type': 'application/json'}});
        },
      }),
      accounts = new UserAccounts(web),
      security = new AccountSecurity(accounts);
    const req = (session?: ReturnType<WebStore['createSession']>): Request =>
      ({
        headers: {origin, ...(session ? {cookie: web.cookie(session.id), 'x-amcp-csrf': session.csrf} : {})},
        socket: {remoteAddress: '127.0.0.1'},
        get: (h: string) => (h.toLowerCase() === 'origin' ? origin : undefined),
      }) as unknown as Request;
    const door = await web.signIn(password, '127.0.0.1');
    await assert.rejects(
      security.invite(req(door), {email: 'x@example.test', role: 'admin', access_set_id: set.id}),
      {code: 'INVALID_ARGUMENT'},
      'an administrator is never limited',
    );
    await security.invite(req(door), {email: 'viewer@example.test', role: 'viewer', access_set_id: set.id});
    await accounts.deliverEmails();
    const link = Object.fromEntries(
      new URLSearchParams(new URL(emails.at(-1)!.text.match(/https:\/\/\S+/)[0]).hash.slice(1)),
    );
    await security.accept(req(), {...link, password: 'a-long-member-passphrase', name: 'Client A viewer'});
    const user = s.store.db.prepare('SELECT * FROM amcp_users WHERE email=?').get('viewer@example.test') as JsonObject;
    assert.equal(
      (security.members(req(door)).members as JsonObject[]).find(m => m.id === user.id)!.access_set_id,
      set.id,
    );
    const member = accounts.session(accounts.user(user.id as string), 'local'),
      cookie = {Cookie: web.cookie(member.id).split(';')[0]!, 'X-AMCP-CSRF': member.csrf};
    const session = (await (await s.request('/api/session', 'GET', undefined, cookie)).json()) as JsonObject;
    assert.equal((session.accessSet as JsonObject).name, 'Client A');
    // The working client's choices come with the session, within the member's access: client A only.
    assert.deepEqual(
      (session.workingClients as JsonObject[]).map(c => [c.name, (c.accounts as JsonObject[]).map(a => a.account_id)]),
      [['Client A', [A]]],
    );
    // Connections, a connection's own page and the working clients show client A only.
    const platforms = JSON.stringify(await (await s.request('/api/platforms', 'GET', undefined, cookie)).json());
    assert.ok(platforms.includes('Client A account'), platforms.slice(0, 400));
    assert.ok(!platforms.includes(B) && !platforms.includes('Client B'), 'no client B account or Page');
    const one = JSON.stringify(await (await s.request('/api/connections/meta-login', 'GET', undefined, cookie)).json());
    assert.ok(!one.includes(B));
    const clients = (await (await s.request('/api/working-clients', 'GET', undefined, cookie)).json()) as JsonObject;
    assert.deepEqual(
      (clients.clients as JsonObject[]).map(c => c.name),
      ['Client A'],
    );
    // The administrator door sees both clients.
    const adminClients = (await (
      await s.request('/api/working-clients', 'GET', undefined, s.headers)
    ).json()) as JsonObject;
    assert.deepEqual(
      (adminClients.clients as JsonObject[]).map(c => c.name),
      ['Client A', 'Client B'],
    );
    const adminSession = (await (await s.request('/api/session', 'GET', undefined, s.headers)).json()) as JsonObject;
    assert.deepEqual(
      (adminSession.workingClients as JsonObject[]).map(c => c.name),
      ['Client A', 'Client B'],
    );
    // The member's own sets list names only their set.
    assert.deepEqual(
      (listAccessSets(s.store, web.session(req(member))!.actor).sets as JsonObject[]).map(x => x.name),
      ['Client A'],
    );
    // Lifting the limit ends the member's sessions, like a role change.
    security.changeMember(req(door), {userId: user.id, role: 'viewer', access_set_id: null});
    assert.equal(web.session(req(member)), undefined);
    const again = accounts.session(accounts.user(user.id as string), 'local');
    assert.equal(web.session(req(again))!.actor.accessSetId, undefined);
  } finally {
    await s.close();
  }
});

test('removing a client access set needs a recent sign-in, like saving one, and removes nothing before it', async () => {
  // Regression (wave 3a review): POST /api/access-sets asked for a recent proof of identity, but DELETE did not, although
  // removing a set cuts off every member, token and AI client limited to it at once.
  const s = await site();
  try {
    const created = await s.request(
      '/api/access-sets',
      'POST',
      {name: 'Client A', bindings: [{gateway: 'meta_native_action', connection_id: 'meta-login', account_id: A}]},
      s.headers,
    );
    assert.equal(created.status, 200, await created.clone().text());
    const set = (await created.json()) as JsonObject;
    // The door session signed in 16 minutes ago.
    const session = s.headers.Cookie.slice(s.headers.Cookie.indexOf('=') + 1);
    s.store.db
      .prepare("UPDATE amcp_web_sessions SET actor=json_set(actor,'$.signedInAt',?) WHERE hash=?")
      .run(Date.now() - 16 * 60000, createHash('sha256').update(session).digest('hex'));
    const remove = () =>
      s.request(
        '/api/access-sets/' + encodeURIComponent(set.id as string),
        'DELETE',
        {confirmed: true, revision: set.revision},
        s.headers,
      );
    const stale = await remove();
    assert.equal(stale.status, 403);
    assert.equal(((await stale.json()) as JsonObject).error.code, 'REAUTH_REQUIRED');
    assert.equal(s.store.documents('local', 'access_set').length, 1, 'the set is still there');
    const confirmed = await s.request('/api/account/reauthenticate', 'POST', {password}, s.headers);
    assert.equal(confirmed.status, 200, await confirmed.clone().text());
    const removed = await remove();
    assert.equal(removed.status, 200, await removed.clone().text());
    assert.equal(s.store.documents('local', 'access_set').length, 0);
  } finally {
    await s.close();
  }
});

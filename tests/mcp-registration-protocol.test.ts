import {listenForFetch} from './http-listener.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService, strictOptions} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {createHttpApp} from '../server/http-app.js';
import {WebStore, type WebsiteOptions} from '../server/web-store.js';
import {UserAccounts} from '../server/user-accounts.js';
import {readableOAuthDescription} from '../server/mcp-oauth-routes.js';
import {mcpClientCapacity, mcpClientLimit} from '../src/mcp-clients.js';
import type {LinkRequest} from '../src/media-link.js';
import type {JsonObject} from '../src/types.js';

/**
 * MCP-03 (review 2026-10-08): stale registrations are released so the 1,000-client cap cannot fill for good, the
 * authorization response names its issuer (RFC 9207), clients may identify themselves with a metadata document
 * (CIMD) fetched under SSRF guards, the bearer challenge appears only on authentication refusals, registration
 * defaults an omitted method to none and no error description carries raw JSON.
 */
const origin = 'https://amcp.shop',
  issuer = 'https://amcp.shop/',
  redirect = 'https://claude.ai/api/mcp/auth_callback',
  master = Buffer.alloc(32, 85).toString('base64'),
  password = 'synthetic-registration-admin-password',
  documentUrl = 'https://client.example.com/oauth/amcp-client.json';
const day = 86400000;

async function fixture(options: {writes?: boolean; website?: Partial<WebsiteOptions>; allowedOrigins?: string[]} = {}) {
  const store = new Store(':memory:', master),
    service = options.writes
      ? new MirrorService(new Registry(), store, new NativeTransport(), strictOptions, {
          allowWrites: true,
          requireBeforeState: true,
          maxBudgetChange: 0,
        })
      : new MirrorService(new Registry(), store),
    logs: JsonObject[] = [],
    website: WebsiteOptions = {
      origin,
      masterKey: master,
      adminPassword: password,
      fetcher: async () => {
        throw Error('No provider traffic allowed');
      },
      ...options.website,
    };
  const listener = await listenForFetch(
    createHttpApp(service, store, {
      publicOrigin: origin,
      website,
      mcpAllowedOrigins: options.allowedOrigins,
      log: entry => logs.push(entry),
    }),
  );
  const base = 'http://127.0.0.1:' + (listener.address() as {port: number}).port;
  const request = async (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const form = body instanceof URLSearchParams;
    const response = await fetch(base + url, {
      method,
      redirect: 'manual',
      headers: {
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
  const login = await request('/api/session', 'POST', {password}, {Origin: origin});
  assert.equal(login.status, 200);
  const admin = {
    Origin: origin,
    Cookie: login.headers.get('set-cookie')!.split(';')[0]!,
    'X-AMCP-CSRF': (await login.json()).csrf as string,
  };
  /** Starts authorization for `clientId`; returns the consent request, or the response when it was refused. */
  const authorize = async (clientId: string, extra: Record<string, string> = {}) => {
    const verifier = randomBytes(48).toString('base64url');
    const response = await request(
      '/authorize?' +
        new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirect,
          response_type: 'code',
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256',
          scope: 'mcp:read',
          state: 'protocol-state',
          resource: origin + '/mcp',
          ...extra,
        }),
    );
    const location = response.headers.get('location');
    const consentRequest =
      response.status === 303 ? new URL(location!).searchParams.get('request')! : (undefined as string | undefined);
    return {response, verifier, consentRequest, location};
  };
  /** Authorizes and exchanges the code; returns the client's tokens and the callback URL. */
  const connect = async (clientId: string) => {
    const started = await authorize(clientId);
    assert.equal(started.response.status, 303, await started.response.clone().text());
    const decision = await request(
      '/api/mcp/consent',
      'POST',
      {request: started.consentRequest, approved: true},
      admin,
    );
    assert.equal(decision.status, 200);
    const callback = new URL((await decision.json()).url);
    const exchanged = await request(
      '/token',
      'POST',
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        redirect_uri: redirect,
        code: callback.searchParams.get('code')!,
        code_verifier: started.verifier,
        resource: origin + '/mcp',
      }),
    );
    assert.equal(exchanged.status, 200, await exchanged.clone().text());
    return {callback, credentials: await exchanged.json(), consentRequest: started.consentRequest!};
  };
  const register = async (body: JsonObject = {}) =>
    request('/register', 'POST', {
      client_name: 'Claude',
      redirect_uris: [redirect],
      token_endpoint_auth_method: 'none',
      ...body,
    });
  const mcp = (headers: Record<string, string>, method = 'POST') =>
    request('/mcp', method, method === 'POST' ? {jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}} : undefined, {
      Accept: 'application/json, text/event-stream',
      ...headers,
    });
  return {
    store,
    logs,
    request,
    admin,
    authorize,
    connect,
    register,
    mcp,
    close: async () => {
      const closing = new Promise<void>(r => listener.close(() => r()));
      listener.closeAllConnections();
      await closing;
      store.close();
    },
  };
}

/** A registration row and one grant row, as an old deployment would hold them. */
function seedClient(store: Store, id: string, issuedDaysAgo: number, grant?: {used: number; expiresAt: number}) {
  store.db.prepare('INSERT INTO amcp_mcp_clients VALUES(?,?)').run(
    id,
    JSON.stringify({
      client_id: id,
      client_id_issued_at: Math.floor((Date.now() - issuedDaysAgo * day) / 1000),
      client_name: 'Seeded',
      redirect_uris: [redirect],
      token_endpoint_auth_method: 'none',
    }),
  );
  if (grant)
    store.db
      .prepare('INSERT INTO amcp_mcp_grants VALUES(?,?,?,?,?,?,?)')
      .run(randomUUID(), 'refresh', id, 'local', '{"family":"seeded"}', grant.expiresAt, grant.used);
}

test('MCP-03: a full registration table releases clients with nothing live past the grace period, so registration succeeds again (regression: the cap filled for good)', async () => {
  const f = await fixture();
  try {
    const live = await (await f.register({client_name: 'Live client'})).json(),
      connected = await f.connect(live.client_id);
    // 997 clients revoked or abandoned long ago: each kept its newest (used) refresh row, which used to keep it counted.
    f.store.transaction(() => {
      for (let i = 0; i < mcpClientLimit - 3; i++)
        seedClient(f.store, 'stale-' + i, 40, {used: 1, expiresAt: Date.now() - 9 * day});
      // Expired two days ago: inside the grace period, so it stays registered.
      seedClient(f.store, 'recent', 40, {used: 0, expiresAt: Date.now() - 2 * day});
      // Registered an hour ago and not yet used: kept, as before.
      seedClient(f.store, 'fresh', 0);
    });
    const count = () => (f.store.db.prepare('SELECT count(*) AS n FROM amcp_mcp_clients').get() as {n: number}).n;
    assert.equal(count(), mcpClientLimit);
    assert.equal(mcpClientCapacity(f.store).releasable_on_next_registration, mcpClientLimit - 3);
    const next = await f.register({client_name: 'After release'});
    assert.equal(next.status, 201, await next.clone().text());
    assert.equal(count(), 4);
    const left = (f.store.db.prepare('SELECT id FROM amcp_mcp_clients ORDER BY id').all() as {id: string}[]).map(
      r => r.id,
    );
    assert.ok(left.includes(live.client_id) && left.includes('recent') && left.includes('fresh'));
    assert.equal(
      (
        f.store.db.prepare("SELECT count(*) AS n FROM amcp_mcp_grants WHERE client_id LIKE 'stale-%'").get() as {
          n: number;
        }
      ).n,
      0,
    );
    // The live client is untouched: its token still works and it still refreshes.
    assert.equal((await f.mcp({Authorization: 'Bearer ' + connected.credentials.access_token})).status, 200);
    const refreshed = await f.request(
      '/token',
      'POST',
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: live.client_id,
        refresh_token: connected.credentials.refresh_token,
        resource: origin + '/mcp',
      }),
    );
    assert.equal(refreshed.status, 200);
  } finally {
    await f.close();
  }
});

test('MCP-03: the owner health view reports the registered-client count and headroom, for the deployment workspace only', async () => {
  const f = await fixture();
  try {
    await f.register();
    const health = await (
      await f.request(
        '/api/workspace/workspace',
        'POST',
        {action: 'health'},
        {...f.admin, 'Content-Type': 'application/json'},
      )
    ).json();
    assert.equal(health.success, true, JSON.stringify(health.error));
    assert.deepEqual(health.data.mcp_clients, {
      registered: 1,
      limit: mcpClientLimit,
      headroom: mcpClientLimit - 1,
      releasable_on_next_registration: 0,
    });
    // A self-service owner of another workspace does not see the deployment-wide count.
    const web = new WebStore(f.store, {origin, masterKey: master, adminPassword: password}),
      accounts = new UserAccounts(web),
      owner = accounts.newUser('Other owner', 'other@example.test', null, true),
      s = accounts.session(owner);
    const other = await (
      await f.request(
        '/api/workspace/workspace',
        'POST',
        {action: 'health'},
        {Origin: origin, Cookie: web.cookie(s.id), 'X-AMCP-CSRF': s.csrf},
      )
    ).json();
    assert.equal(other.success, true, JSON.stringify(other.error));
    assert.equal(other.data.mcp_clients, undefined);
  } finally {
    await f.close();
  }
});

test('MCP-03: authorization responses carry iss equal to the metadata issuer on success, denial and SDK error redirects', async () => {
  const f = await fixture();
  try {
    const metadata = await (await f.request('/.well-known/oauth-authorization-server')).json();
    assert.equal(metadata.issuer, issuer);
    assert.equal(metadata.authorization_response_iss_parameter_supported, true);
    assert.equal(metadata.client_id_metadata_document_supported, true);
    const client = await (await f.register()).json();
    const approved = await f.connect(client.client_id);
    assert.equal(approved.callback.searchParams.get('iss'), issuer);
    assert.ok(approved.callback.searchParams.get('code'));
    const denied = await f.authorize(client.client_id);
    const denial = new URL(
      (
        await (
          await f.request('/api/mcp/consent', 'POST', {request: denied.consentRequest, approved: false}, f.admin)
        ).json()
      ).url,
    );
    assert.equal(denial.searchParams.get('error'), 'access_denied');
    assert.equal(denial.searchParams.get('iss'), issuer);
    // The SDK reports this request error by redirecting to the client: the redirect names the issuer too.
    const sdkError = await f.authorize(client.client_id, {code_challenge_method: 'plain'});
    assert.equal(sdkError.response.status, 302);
    const location = new URL(sdkError.location!);
    assert.equal(location.origin + location.pathname, redirect);
    assert.equal(location.searchParams.get('iss'), issuer);
    assert.ok(location.searchParams.get('error'));
    assert.doesNotMatch(location.searchParams.get('error_description')!, /^\s*[[{]/);
  } finally {
    await f.close();
  }
});

test('MCP-03: the bearer challenge appears only on authentication refusals, with the scope hint and invalid_token when a token was presented', async () => {
  for (const writes of [false, true]) {
    const f = await fixture({writes});
    try {
      const scope = writes ? 'mcp:read mcp:write' : 'mcp:read';
      const missing = await f.mcp({});
      assert.equal(missing.status, 401);
      const challenge = missing.headers.get('www-authenticate')!;
      assert.match(challenge, new RegExp('scope="' + scope + '"'));
      assert.match(challenge, /resource_metadata="https:\/\/amcp\.shop\/\.well-known\/oauth-protected-resource\/mcp"/);
      assert.doesNotMatch(challenge, /error=/, 'no error code without an authentication attempt (RFC 6750)');
      const invalid = await f.mcp({Authorization: 'Bearer whm_not-a-real-token'});
      assert.equal(invalid.status, 401);
      assert.match(invalid.headers.get('www-authenticate')!, /^Bearer error="invalid_token", scope="/);
      const client = await (await f.register()).json(),
        {credentials} = await f.connect(client.client_id);
      const ok = await f.mcp({Authorization: 'Bearer ' + credentials.access_token});
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get('www-authenticate'), null);
      const wrongMethod = await f.mcp({Authorization: 'Bearer ' + credentials.access_token}, 'GET');
      assert.equal(wrongMethod.status, 405);
      assert.equal(wrongMethod.headers.get('www-authenticate'), null);
    } finally {
      await f.close();
    }
  }
});

test('MCP-03: registration without token_endpoint_auth_method registers a public client and echoes none; errors are readable sentences', async () => {
  const f = await fixture();
  try {
    const registered = await f.request('/register', 'POST', {client_name: 'No method', redirect_uris: [redirect]});
    assert.equal(registered.status, 201);
    const client = await registered.json();
    assert.equal(client.token_endpoint_auth_method, 'none');
    assert.equal(client.client_secret, undefined);
    assert.equal(
      JSON.parse(
        (f.store.db.prepare('SELECT data FROM amcp_mcp_clients WHERE id=?').get(client.client_id) as {data: string})
          .data,
      ).token_endpoint_auth_method,
      'none',
    );
    const descriptions: string[] = [];
    for (const response of [
      await f.request('/register', 'POST', {client_name: 'No redirects'}),
      await f.request('/register', 'POST', {redirect_uris: 'not-a-list'}),
      await f.request('/token', 'POST', new URLSearchParams({client_id: client.client_id})),
      await f.request('/revoke', 'POST', new URLSearchParams({client_id: client.client_id})),
      await f.request('/authorize?' + new URLSearchParams({redirect_uri: redirect})),
    ]) {
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(typeof body.error, 'string');
      descriptions.push(body.error_description);
    }
    for (const description of descriptions) {
      assert.doesNotMatch(description, /^\s*[[{]/, description);
      assert.ok(!description.includes('"code"'), description);
    }
    assert.match(descriptions[0]!, /redirect_uris/);
    assert.equal(readableOAuthDescription('Plain words.'), 'Plain words.');
    assert.equal(
      readableOAuthDescription(JSON.stringify([{path: ['grant_type'], message: 'Required'}])),
      'The request is invalid: grant_type (Required).',
    );
  } finally {
    await f.close();
  }
});

/** A metadata document host, with a record of what AMCP fetched. */
function documentHost(reply: (url: URL) => Response) {
  const fetched: string[] = [];
  const request: LinkRequest = async url => {
    fetched.push(url.href);
    return reply(url);
  };
  return {fetched, request};
}
const documentBody = (overrides: JsonObject = {}) =>
  JSON.stringify({
    client_id: documentUrl,
    client_name: 'Metadata Client',
    redirect_uris: [redirect],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    ...overrides,
  });

test('MCP-03: a client identified by its metadata document authorizes, refreshes and is listed without registering', async () => {
  const host = documentHost(
    () => new Response(documentBody(), {headers: {'content-type': 'application/json', 'cache-control': 'max-age=60'}}),
  );
  const f = await fixture({website: {mcpClientMetadata: {request: host.request}}});
  try {
    const {credentials, consentRequest} = await f.connect(documentUrl);
    assert.equal(host.fetched[0], documentUrl);
    assert.equal(credentials.scope, 'mcp:read');
    assert.equal((await f.mcp({Authorization: 'Bearer ' + credentials.access_token})).status, 200);
    // Nothing was registered; the document is cached (at least five minutes) rather than fetched per request.
    assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM amcp_mcp_clients').get() as {n: number}).n, 0);
    assert.equal(host.fetched.length, 1);
    const refreshed = await f.request(
      '/token',
      'POST',
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: documentUrl,
        refresh_token: credentials.refresh_token,
        resource: origin + '/mcp',
      }),
    );
    assert.equal(refreshed.status, 200);
    // A public client: a secret is refused.
    const withSecret = await f.request(
      '/token',
      'POST',
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: documentUrl,
        client_secret: 'injected',
        refresh_token: (await refreshed.json()).refresh_token,
      }),
    );
    assert.equal(withSecret.status, 400);
    assert.ok(consentRequest);
    const listed = await (await f.request('/api/mcp/authorizations', 'GET', undefined, f.admin)).json();
    assert.deepEqual(
      listed.clients.map((c: JsonObject) => [c.id, c.name]),
      [[documentUrl, 'Metadata Client']],
    );
  } finally {
    await f.close();
  }
});

test('MCP-03: the consent payload names the host that published a client metadata document', async () => {
  const host = documentHost(() => new Response(documentBody(), {headers: {'content-type': 'application/json'}}));
  const f = await fixture({website: {mcpClientMetadata: {request: host.request}}});
  try {
    const started = await f.authorize(documentUrl);
    const preview = await (
      await f.request(
        '/api/mcp/consent?request=' + encodeURIComponent(started.consentRequest!),
        'GET',
        undefined,
        f.admin,
      )
    ).json();
    assert.equal(preview.clientMetadataHost, 'client.example.com');
    assert.equal(preview.name, 'Metadata Client');
  } finally {
    await f.close();
  }
});

test('MCP-03: metadata documents are refused for a mismatched client_id, a redirect, an oversized body, a secret, an unlisted host or a private address', async () => {
  const cases: [string, (url: URL) => Response, RegExp][] = [
    [
      'mismatch',
      () => new Response(documentBody({client_id: 'https://elsewhere.example.com/client.json'})),
      /does not equal/,
    ],
    [
      'redirect',
      () => new Response(null, {status: 302, headers: {location: 'https://client.example.com/other.json'}}),
      /redirects/,
    ],
    ['oversized', () => new Response(documentBody({client_name: 'x'.repeat(11 * 1024)})), /larger than 10 KB/],
    [
      'declared oversized',
      () => new Response(documentBody(), {headers: {'content-length': String(64 * 1024)}}),
      /larger than 10 KB/,
    ],
    ['secret', () => new Response(documentBody({client_secret: 'leaked'})), /client secret/],
    [
      'confidential',
      () => new Response(documentBody({token_endpoint_auth_method: 'private_key_jwt'})),
      /public clients/,
    ],
    ['bad redirect', () => new Response(documentBody({redirect_uris: ['http://claude.ai/callback']})), /redirect_uris/],
    ['not json', () => new Response('<html>'), /JSON object/],
    ['not found', () => new Response('{}', {status: 404}), /HTTP 404/],
  ];
  for (const [name, reply, reason] of cases) {
    const host = documentHost(reply),
      f = await fixture({website: {mcpClientMetadata: {request: host.request}}});
    try {
      const {response} = await f.authorize(documentUrl);
      assert.equal(response.status, 400, name);
      const body = await response.json();
      assert.equal(body.error, 'invalid_client', name);
      assert.match(body.error_description, reason, name);
      assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM amcp_mcp_grants').get() as {n: number}).n, 0);
    } finally {
      await f.close();
    }
  }
  // URLs that are not acceptable document locations are refused before any fetch.
  const host = documentHost(() => new Response(documentBody()));
  const f = await fixture({website: {mcpClientMetadata: {request: host.request, hosts: ['client.example.com']}}});
  try {
    for (const id of [
      'https://other.example.com/client.json',
      'https://client.example.com:8443/client.json',
      'https://client.example.com/a/../client.json?x=1',
      'https://127.0.0.1/client.json',
    ]) {
      const {response} = await f.authorize(id);
      assert.equal(response.status, 400, id);
      assert.equal((await response.json()).error, 'invalid_client', id);
    }
    assert.deepEqual(host.fetched, []);
  } finally {
    await f.close();
  }
  // The real HTTPS transport: a host that resolves to a private address is refused before any connection is made.
  for (const addresses of [
    [{address: '10.0.0.5', family: 4}],
    [{address: '169.254.169.254', family: 4}],
    [
      {address: '93.184.216.34', family: 4},
      {address: '127.0.0.1', family: 4},
    ],
    [{address: 'fd00::1', family: 6}],
  ]) {
    const g = await fixture({website: {mcpClientMetadata: {resolve: async () => addresses}}});
    try {
      const {response} = await g.authorize(documentUrl);
      assert.equal(response.status, 400);
      assert.match((await response.json()).error_description, /public internet address/);
    } finally {
      await g.close();
    }
  }
  // Turned off by the owner: a URL client_id is an unknown client and the metadata no longer advertises CIMD.
  const off = await fixture({website: {mcpClientMetadata: {enabled: false, request: host.request}}});
  try {
    const {response} = await off.authorize(documentUrl);
    assert.equal(response.status, 400);
    const metadata = await (await off.request('/.well-known/oauth-authorization-server')).json();
    assert.equal(metadata.client_id_metadata_document_supported, undefined);
    assert.equal(metadata.authorization_response_iss_parameter_supported, true);
  } finally {
    await off.close();
  }
});

test('MCP-03: an allowed browser origin gets an exact CORS preflight answer and readable responses; other origins stay refused', async () => {
  const f = await fixture({allowedOrigins: ['https://claude.ai']});
  try {
    const preflight = await f.request('/mcp', 'OPTIONS', undefined, {
      Origin: 'https://claude.ai',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization, content-type',
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://claude.ai');
    assert.match(preflight.headers.get('access-control-allow-headers')!, /Authorization/);
    assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST');
    const other = await f.request('/mcp', 'OPTIONS', undefined, {
      Origin: 'https://attacker.example',
      'Access-Control-Request-Method': 'POST',
    });
    assert.equal(other.status, 403);
    assert.equal(other.headers.get('access-control-allow-origin'), null);
    const client = await (await f.register()).json(),
      {credentials} = await f.connect(client.client_id);
    const allowed = await f.mcp({Origin: 'https://claude.ai', Authorization: 'Bearer ' + credentials.access_token});
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://claude.ai');
    const refused = await f.mcp({
      Origin: 'https://attacker.example',
      Authorization: 'Bearer ' + credentials.access_token,
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.headers.get('access-control-allow-origin'), null);
    assert.equal(refused.headers.get('www-authenticate'), null, 'an origin refusal is not an authentication challenge');
  } finally {
    await f.close();
  }
});

test('MCP-03: a probe with a newer protocol revision is logged at info level, other refusals as warnings', async () => {
  const f = await fixture();
  try {
    const client = await (await f.register()).json(),
      {credentials} = await f.connect(client.client_id);
    const modern = await f.mcp({
      Authorization: 'Bearer ' + credentials.access_token,
      'MCP-Protocol-Version': '2026-07-28',
    });
    assert.equal(modern.status, 400);
    await f.mcp({});
    const mcpLogs = f.logs.filter(e => String(e.event).startsWith('mcp_'));
    assert.deepEqual(
      mcpLogs.map(e => [e.level, e.event, e.status]),
      [
        ['info', 'mcp_protocol_unsupported', 400],
        ['warn', 'mcp_refused', 401],
      ],
    );
    assert.equal(mcpLogs[0]!.protocol_version, '2026-07-28');
    assert.ok(!JSON.stringify(f.logs).includes(credentials.access_token));
  } finally {
    await f.close();
  }
});

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
import {
  mcpClientCapacity,
  mcpClientLimit,
  mcpRegistrationLimitDefaults,
  mcpRegistrationLimits,
} from '../src/mcp-clients.js';
import {loadConfig} from '../server/config.js';
import {ClientMetadataDocuments} from '../server/client-metadata.js';
import {InvalidClientError} from '@modelcontextprotocol/server-legacy/auth';
import {MirrorError} from '../src/errors.js';
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
    // Phase 2 added the registrations of the last 24 hours against the daily limits, and the alarms.
    assert.deepEqual(health.data.mcp_clients, {
      registered: 1,
      limit: mcpClientLimit,
      headroom: mcpClientLimit - 1,
      releasable_on_next_registration: 0,
      registered_last_24h: 1,
      daily_limit: mcpRegistrationLimitDefaults.daily,
      per_address_daily_limit: mcpRegistrationLimitDefaults.perAddressDaily,
      alarms: [],
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
    // r25-mf-auth item 2: no saved copy to keep, so an app whose page is down is refused in the same words as before.
    ['unavailable', () => new Response('{}', {status: 503}), /HTTP 503/],
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

/** A metadata document host that answers from a script, with a clock the test moves (r25-mf-auth). */
function scriptedDocuments() {
  let now = 1_700_000_000_000;
  const script: (() => Response | Promise<Response>)[] = [],
    reads: number[] = [];
  const documents = new ClientMetadataDocuments('mcp:read', {
    request: async () => {
      reads.push(now);
      const next = script.shift();
      if (!next) throw Error('a read nobody scripted');
      return next();
    },
    clock: () => now,
  });
  return {
    documents,
    reads,
    pass: (ms: number) => (now += ms),
    answer: (...replies: (() => Response | Promise<Response>)[]) => script.push(...replies),
  };
}
/** The saved copy lives five minutes (the shortest a document may be kept). */
const goodDocument =
  (overrides: JsonObject = {}) =>
  () =>
    new Response(documentBody(overrides), {headers: {'cache-control': 'max-age=300'}});
const refusedFor = (pattern: RegExp) => (e: unknown) => e instanceof InvalidClientError && pattern.test(e.message);

test('r25-mf-auth item 2: a re-read that gets no answer keeps the saved copy, and the host is asked again after a minute', async () => {
  const noAnswer: [string, () => Response | Promise<Response>][] = [
    [
      'DNS failure',
      () => {
        throw new MirrorError('MEDIA_LINK_UNAVAILABLE', 'The link’s host name could not be found.');
      },
    ],
    [
      'timeout',
      () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
    ],
    [
      'connection refused',
      () => {
        throw Object.assign(Error('connect ECONNREFUSED'), {code: 'ECONNREFUSED'});
      },
    ],
    [
      'connection reset',
      () => {
        throw Object.assign(Error('read ECONNRESET'), {code: 'ECONNRESET'});
      },
    ],
    ['HTTP 500', () => new Response('failed', {status: 500})],
    ['HTTP 502', () => new Response('bad gateway', {status: 502})],
    ['HTTP 503', () => new Response('unavailable', {status: 503})],
    ['HTTP 504', () => new Response('gateway timeout', {status: 504})],
    // F8: the server asking AMCP to wait or to come back is not an answer about the document.
    ['HTTP 408', () => new Response('request timeout', {status: 408})],
    ['HTTP 429', () => new Response('too many requests', {status: 429, headers: {'retry-after': '120'}})],
    [
      'connection lost while the body arrives',
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('socket hang up'));
            },
          }),
        ),
    ],
  ];
  for (const [name, outage] of noAnswer) {
    const f = scriptedDocuments();
    f.answer(goodDocument());
    const saved = await f.documents.client(documentUrl);
    f.pass(301_000);
    f.answer(outage);
    assert.deepEqual(await f.documents.client(documentUrl), saved, name);
    assert.equal(f.reads.length, 2, name);
    f.pass(30_000);
    assert.deepEqual(await f.documents.client(documentUrl), saved, name + ' (within the minute)');
    assert.equal(f.reads.length, 2, name + ': the host is not asked on every call');
    f.pass(31_000);
    f.answer(goodDocument({client_name: 'Renamed'}));
    assert.equal((await f.documents.client(documentUrl)).client_name, 'Renamed', name + ' (asked again)');
    assert.equal(f.reads.length, 3, name);
  }
});

test('r25-mf-auth item 2: a real refusal, an answer that cannot be used, still replaces the saved copy for a minute', async () => {
  const refusals: [string, () => Response | Promise<Response>, RegExp][] = [
    ['HTTP 400', () => new Response('{}', {status: 400}), /HTTP 400/],
    ['HTTP 401', () => new Response('{}', {status: 401}), /HTTP 401/],
    ['HTTP 403', () => new Response('{}', {status: 403}), /HTTP 403/],
    ['HTTP 404', () => new Response('{}', {status: 404}), /HTTP 404/],
    ['HTTP 410', () => new Response('{}', {status: 410}), /HTTP 410/],
    ['HTTP 204', () => new Response(null, {status: 204}), /HTTP 204/],
    [
      'redirect',
      () => new Response(null, {status: 302, headers: {location: 'https://client.example.com/other.json'}}),
      /redirects/,
    ],
    ['not JSON', () => new Response('<html>'), /JSON object/],
    [
      'another client_id',
      () => new Response(documentBody({client_id: 'https://elsewhere.example.com/c.json'})),
      /does not equal/,
    ],
    [
      'no longer exact redirect URIs',
      () => new Response(documentBody({redirect_uris: ['http://claude.ai/cb']})),
      /redirect_uris/,
    ],
    [
      'no longer a public client',
      () => new Response(documentBody({token_endpoint_auth_method: 'private_key_jwt'})),
      /public clients/,
    ],
    ['now carries a secret', () => new Response(documentBody({client_secret: 'leaked'})), /client secret/],
    ['now too large', () => new Response(documentBody({client_name: 'x'.repeat(11 * 1024)})), /larger than 10 KB/],
    [
      'now resolves to a private address',
      () => {
        throw new MirrorError('MEDIA_LINK_BLOCKED', 'This link does not lead to a public internet address.');
      },
      /public internet address/,
    ],
  ];
  for (const [name, reply, reason] of refusals) {
    const f = scriptedDocuments();
    f.answer(goodDocument());
    const saved = await f.documents.client(documentUrl);
    f.pass(301_000);
    f.answer(reply);
    await assert.rejects(f.documents.client(documentUrl), refusedFor(reason), name);
    f.pass(30_000);
    await assert.rejects(f.documents.client(documentUrl), refusedFor(reason), name + ' (remembered for the minute)');
    assert.equal(f.reads.length, 2, name);
    f.pass(31_000);
    f.answer(goodDocument());
    assert.deepEqual(await f.documents.client(documentUrl), saved, name + ' (asked again after the minute)');
    assert.equal(f.reads.length, 3, name);
  }
});

test('r25-mf-auth item 2: the saved copy stands in for at most a day after its lifetime, then the app is refused', async () => {
  const f = scriptedDocuments();
  f.answer(goodDocument());
  const saved = await f.documents.client(documentUrl),
    day = 86_400_000;
  // Inside the day (the copy lived 5 minutes) an outage changes nothing.
  f.pass(300_000 + day - 60_000);
  f.answer(() => new Response('unavailable', {status: 503}));
  assert.deepEqual(await f.documents.client(documentUrl), saved);
  // Past it the outage is a refusal like any other, so an app whose page stays down for days cannot stay connected.
  f.pass(120_000);
  f.answer(() => new Response('unavailable', {status: 503}));
  await assert.rejects(f.documents.client(documentUrl), refusedFor(/HTTP 503/));
});

test('r25-mf-auth item 2: an app whose page is briefly down stays signed in; a page that now refuses it does not', async () => {
  let now = Date.now(),
    status = 200;
  const reads: string[] = [];
  const f = await fixture({
    website: {
      mcpClientMetadata: {
        request: async url => {
          reads.push(url.href);
          return status === 200
            ? new Response(documentBody(), {headers: {'cache-control': 'max-age=300'}})
            : new Response('down', {status});
        },
        clock: () => now,
      },
    },
  });
  try {
    const {credentials} = await f.connect(documentUrl),
      refresh = (token: string) =>
        f.request(
          '/token',
          'POST',
          new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: documentUrl,
            refresh_token: token,
            resource: origin + '/mcp',
          }),
        );
    // Past the saved copy's life the page answers 503: the app's person is not signed out.
    now += 301_000;
    status = 503;
    const survived = await refresh(credentials.refresh_token);
    assert.equal(survived.status, 200, await survived.clone().text());
    assert.equal(reads.length, 2);
    // The page is back and then refuses the app (404): a real refusal, in the answer the token endpoint always gave.
    now += 301_000;
    status = 404;
    const refused = await refresh((await survived.json()).refresh_token);
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), {
      error: 'invalid_client',
      error_description: 'Invalid client credentials or authentication method.',
    });
  } finally {
    await f.close();
  }
});

const genericRefusal = {
  error: 'invalid_client',
  error_description: 'Invalid client credentials or authentication method.',
};
/** Resolves once `condition` holds (or the test fails after three seconds). */
async function until(condition: () => boolean) {
  for (let i = 0; i < 300 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(condition(), 'the condition never held');
}
const settle = () => new Promise(resolve => setTimeout(resolve, 150));

/** What a registered client has always been answered for a credential AMCP does not hold (F3). */
const staleGrant = {
  error: 'invalid_grant',
  error_description: 'This authorization has expired or was already used.',
};

test('r25-mf-auth item 1 and F3: /token and /revoke read no document for a client_id that holds no grant, and answer a stale credential as they always did: /token counts it, /revoke does not', async () => {
  const host = documentHost(url => new Response(documentBody({client_id: url.href})));
  const f = await fixture({website: {mcpClientMetadata: {request: host.request}}});
  try {
    const refresh = (id: string) =>
      f.request(
        '/token',
        'POST',
        new URLSearchParams({grant_type: 'refresh_token', client_id: id, refresh_token: 'a-token-nobody-issued'}),
      );
    // Fifty failed requests from one address are answered as ever (and readable by a page: the SDK handler's CORS header);
    // the next waits (SEC-01). None read a document.
    for (let i = 0; i < 50; i++) {
      const refused = await refresh('https://app' + i + '.example.com/client.json');
      assert.equal(refused.status, 400, 'request ' + i);
      assert.equal(refused.headers.get('access-control-allow-origin'), '*', 'request ' + i);
      assert.deepEqual(await refused.json(), staleGrant, 'request ' + i);
    }
    assert.equal((await refresh('https://app50.example.com/client.json')).status, 429);
    assert.deepEqual(host.fetched, []);
  } finally {
    await f.close();
  }
  // A token AMCP does not hold is answered 200 at /revoke (RFC 7009), readable by a page and never counted: sixty of them
  // from one address leave it free to refresh.
  const other = documentHost(url => new Response(documentBody({client_id: url.href})));
  const g = await fixture({website: {mcpClientMetadata: {request: other.request}}});
  try {
    for (let i = 0; i < 60; i++) {
      const revoke = await g.request(
        '/revoke',
        'POST',
        new URLSearchParams({
          client_id: 'https://app' + i + '.example.com/client.json',
          token: 'a-token-nobody-issued',
        }),
      );
      assert.equal(revoke.status, 200, 'revocation ' + i);
      assert.equal(revoke.headers.get('access-control-allow-origin'), '*', 'revocation ' + i);
      assert.deepEqual(await revoke.json(), {}, 'revocation ' + i);
    }
    const next = await g.request(
      '/token',
      'POST',
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: 'https://app.example.com/client.json',
        refresh_token: 'a-token-nobody-issued',
      }),
    );
    assert.equal(next.status, 400, 'the address was not made to wait');
    assert.deepEqual(await next.json(), staleGrant);
    assert.deepEqual(other.fetched, []);
  } finally {
    await g.close();
  }
});

test('r25-mf-auth F3: a stale credential gets a metadata-document client the answer a registered client gets; no credential, a secret or documents turned off stay an unknown client', async () => {
  const host = documentHost(url => new Response(documentBody({client_id: url.href})));
  const f = await fixture({website: {mcpClientMetadata: {request: host.request}}});
  try {
    await f.connect(documentUrl);
    const registered = (await (await f.register()).json()).client_id as string;
    const answers = async (id: string) => {
      const token = await f.request(
          '/token',
          'POST',
          new URLSearchParams({grant_type: 'refresh_token', client_id: id, refresh_token: 'a-pruned-refresh-token'}),
        ),
        revoke = await f.request(
          '/revoke',
          'POST',
          new URLSearchParams({client_id: id, token: 'a-pruned-access-token'}),
        );
      return [
        token.status,
        await token.json(),
        token.headers.get('access-control-allow-origin'),
        revoke.status,
        await revoke.json(),
        revoke.headers.get('access-control-allow-origin'),
      ];
    };
    assert.deepEqual(await answers(documentUrl), await answers(registered));
    assert.deepEqual((await answers(documentUrl)).slice(0, 2), [400, staleGrant]);
    // Nothing presented, or a secret a public client has none of: an unknown client, as before.
    const noCredential = await f.request(
      '/token',
      'POST',
      new URLSearchParams({grant_type: 'client_credentials', client_id: documentUrl}),
    );
    assert.equal(noCredential.status, 400);
    assert.deepEqual(await noCredential.json(), genericRefusal);
    const withSecret = await f.request(
      '/token',
      'POST',
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: documentUrl,
        client_secret: 'a-secret',
        refresh_token: 'a-pruned-refresh-token',
      }),
    );
    assert.equal(withSecret.status, 400);
    assert.deepEqual(await withSecret.json(), genericRefusal);
    assert.equal(host.fetched.length, 1, 'only the connection itself read the page');
  } finally {
    await f.close();
  }
  // Turned off by the owner: a URL client_id is an unknown client whatever it presents.
  const off = await fixture({website: {mcpClientMetadata: {enabled: false, request: host.request}}});
  try {
    const refused = await off.request(
      '/token',
      'POST',
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: documentUrl,
        refresh_token: 'a-pruned-refresh-token',
      }),
    );
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), genericRefusal);
  } finally {
    await off.close();
  }
});

test('r25-mf-auth item 1: a client that holds a grant still authenticates, and a credential that is not its own costs no read', async () => {
  let now = Date.now();
  const second = 'https://other.example.org/oauth/app.json',
    host = documentHost(
      url => new Response(documentBody({client_id: url.href}), {headers: {'cache-control': 'max-age=300'}}),
    );
  const f = await fixture({website: {mcpClientMetadata: {request: host.request, clock: () => now}}});
  try {
    const {credentials} = await f.connect(documentUrl);
    await f.connect(second);
    assert.equal(host.fetched.length, 2);
    now += 301_000;
    const refresh = (token: string, id = documentUrl) =>
      f.request(
        '/token',
        'POST',
        new URLSearchParams({grant_type: 'refresh_token', client_id: id, refresh_token: token}),
      );
    // The saved copies have expired, so a request that needed a document would read it: these need nothing.
    const stranger = await refresh('a-refresh-token-nobody-issued');
    assert.equal(stranger.status, 400);
    assert.deepEqual(await stranger.json(), staleGrant);
    // Another client's refresh token is not a grant of this one, though this one holds grants of its own.
    const crossed = await refresh(credentials.refresh_token, second);
    assert.equal(crossed.status, 400);
    assert.deepEqual(await crossed.json(), staleGrant);
    const revoked = await f.request(
      '/revoke',
      'POST',
      new URLSearchParams({client_id: documentUrl, token: 'a-token-nobody-issued'}),
    );
    assert.equal(revoked.status, 200);
    assert.deepEqual(await revoked.json(), {});
    assert.equal(host.fetched.length, 2);
    // The client's own refresh token reads its page once, and works; so does revoking its own access and refresh tokens.
    const genuine = await refresh(credentials.refresh_token);
    assert.equal(genuine.status, 200, await genuine.clone().text());
    assert.equal(host.fetched.length, 3);
    const renewed = await genuine.json();
    for (const token of [credentials.access_token, renewed.refresh_token]) {
      const ended = await f.request('/revoke', 'POST', new URLSearchParams({client_id: documentUrl, token}));
      assert.equal(ended.status, 200);
    }
    assert.equal(host.fetched.length, 3, 'the page read for the refresh served both revocations');
    // What was revoked is gone: the family ended, so the refresh token no longer opens a read or an answer.
    assert.equal((await refresh(renewed.refresh_token)).status, 400);
  } finally {
    await f.close();
  }
});

test('r25-mf-auth item 1: /authorize reads a client_id once however many requests ask for it, and at most eight documents at once', async () => {
  let running = 0,
    highest = 0,
    opened: () => void = () => {},
    open = new Promise<void>(resolve => (opened = resolve));
  const reads: string[] = [];
  const f = await fixture({
    website: {
      mcpClientMetadata: {
        request: async url => {
          reads.push(url.href);
          running++;
          highest = Math.max(highest, running);
          await open;
          running--;
          return new Response(documentBody({client_id: url.href}));
        },
      },
    },
  });
  try {
    // Twenty requests for one client_id at once share one read.
    const same = Array.from({length: 20}, () => f.authorize(documentUrl));
    await until(() => reads.length > 0);
    await settle();
    assert.equal(reads.length, 1);
    opened();
    for (const {response} of await Promise.all(same)) assert.equal(response.status, 303);
    // Thirty different client_ids at once are read eight at a time; the others are refused as an unreadable document is.
    reads.length = 0;
    open = new Promise<void>(resolve => (opened = resolve));
    const ids = Array.from({length: 30}, (_, i) => 'https://app' + i + '.example.com/client.json');
    let answered = 0;
    const many = ids.map(id => f.authorize(id).then(r => (answered++, r)));
    await until(() => reads.length >= 8);
    await settle();
    assert.equal(running, 8, 'documents being read at once');
    assert.equal(highest, 8);
    assert.equal(reads.length, 8);
    await until(() => answered === 22);
    opened();
    const results = await Promise.all(many);
    assert.equal(results.filter(r => r.response.status === 303).length, 8);
    const refused = results.filter(r => r.response.status === 400);
    assert.equal(refused.length, 22);
    for (const {response} of refused) assert.equal((await response.json()).error, 'invalid_client');
    // A refusal for want of a free place is not remembered: the same client_ids are read as soon as there is room.
    for (const id of ids.filter((_, i) => results[i]!.response.status === 400).slice(0, 3))
      assert.equal((await f.authorize(id)).response.status, 303, id);
  } finally {
    await f.close();
  }
});

test('r25-mf-auth item 1: with every place taken a saved copy still answers, and registration reads no document at all', async () => {
  let now = 1_700_000_000_000,
    taken = false,
    opened: () => void = () => {};
  const open = new Promise<void>(resolve => (opened = resolve)),
    reads: string[] = [];
  const documents = new ClientMetadataDocuments('mcp:read', {
    request: async url => {
      reads.push(url.href);
      if (taken) await open;
      return new Response(documentBody({client_id: url.href}), {headers: {'cache-control': 'max-age=300'}});
    },
    clock: () => now,
  });
  const saved = await documents.client(documentUrl);
  now += 301_000;
  taken = true;
  const busy = Array.from({length: 8}, (_, i) => documents.client('https://busy' + i + '.example.com/client.json'));
  try {
    await until(() => reads.length === 9);
    // The saved copy had expired, and no place is free to read it again: it stands in, and no ninth read starts.
    const standIn = await Promise.race([
      documents.client(documentUrl).then(
        client => client,
        error => error,
      ),
      new Promise(resolve => setTimeout(() => resolve('still waiting for a read'), 1000)),
    ]);
    assert.deepEqual(standIn, saved);
    assert.equal(reads.length, 9);
    // A client_id with no saved copy is refused, in the words an unreadable document always was.
    await assert.rejects(
      documents.client('https://new.example.com/client.json'),
      refusedFor(/it could not be fetched\.$/),
    );
    assert.equal(reads.length, 9);
  } finally {
    opened();
  }
  await Promise.all(busy);
  // Registration stores the addresses a client names and never reads them (nothing to cap there).
  const host = documentHost(() => new Response(documentBody()));
  const f = await fixture({website: {mcpClientMetadata: {request: host.request}}});
  try {
    const registered = await f.register({
      client_uri: 'https://client.example.com/',
      logo_uri: 'https://client.example.com/logo.png',
      jwks_uri: 'https://client.example.com/keys.json',
      policy_uri: 'https://client.example.com/policy',
      tos_uri: 'https://client.example.com/terms',
    });
    assert.equal(registered.status, 201);
    assert.deepEqual(host.fetched, []);
  } finally {
    await f.close();
  }
});

test('r25-mf-auth F2: eight stalled anonymous reads cannot starve a client that presents its own grant, and stay capped for everyone else', async () => {
  let now = Date.now(),
    opened: () => void = () => {};
  const open = new Promise<void>(resolve => (opened = resolve)),
    reads: string[] = [];
  const f = await fixture({
    website: {
      mcpClientMetadata: {
        request: async url => {
          reads.push(url.href);
          if (url.hostname.startsWith('slow')) await open;
          return new Response(documentBody({client_id: url.href}), {headers: {'cache-control': 'max-age=300'}});
        },
        clock: () => now,
      },
    },
  });
  try {
    const {credentials} = await f.connect(documentUrl);
    // As after a restart: nothing saved may stand in for the page of the client that connected.
    now += 25 * 3600000;
    const stalled = Array.from({length: 8}, (_, i) => f.authorize('https://slow' + i + '.example.net/c.json'));
    await until(() => reads.filter(read => read.includes('slow')).length === 8);
    // Every place is taken by reads nobody has shown a grant for; one more of them is still refused.
    assert.equal((await f.authorize('https://slow8.example.net/c.json')).response.status, 400);
    assert.equal(reads.filter(read => read.includes('slow')).length, 8);
    // A refresh that presents the client's own refresh token is read for all the same, and answered.
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
    assert.equal(refreshed.status, 200, await refreshed.clone().text());
    assert.equal(reads.at(-1), documentUrl);
    opened();
    await Promise.all(stalled);
  } finally {
    opened();
    await f.close();
  }
});

test('r25-mf-auth F7: the consent request an anonymous /authorize hands out proves no grant, so it opens no read', async () => {
  let now = Date.now();
  const host = documentHost(
    url => new Response(documentBody({client_id: url.href}), {headers: {'cache-control': 'max-age=300'}}),
  );
  const f = await fixture({website: {mcpClientMetadata: {request: host.request, clock: () => now}}});
  try {
    const started = await f.authorize(documentUrl);
    assert.ok(started.consentRequest);
    assert.equal(host.fetched.length, 1);
    now += 301_000;
    // Presented as a refresh token, as a code, or as a token to revoke: the page is not read for any of them.
    for (const [path, body] of [
      ['/token', {grant_type: 'refresh_token', refresh_token: started.consentRequest!}],
      [
        '/token',
        {
          grant_type: 'authorization_code',
          code: started.consentRequest!,
          code_verifier: started.verifier,
          redirect_uri: redirect,
        },
      ],
      ['/revoke', {token: started.consentRequest!}],
    ] as const) {
      await f.request(path, 'POST', new URLSearchParams({client_id: documentUrl, ...body}));
      assert.equal(host.fetched.length, 1, path + ' ' + Object.keys(body).join(','));
    }
  } finally {
    await f.close();
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

/** A registration from one client address, as Railway's edge reports it (AMCP_CLIENT_IP_SOURCE=railway). */
const registerFrom = (f: Awaited<ReturnType<typeof fixture>>, address: string, body: JsonObject = {}) =>
  f.request(
    '/register',
    'POST',
    {client_name: 'Claude', redirect_uris: [redirect], token_endpoint_auth_method: 'none', ...body},
    {'X-Real-IP': address},
  );

test('MCP-03: registrations are limited per client address in 24 hours; other addresses still register, and a refused registration gives its place back (regression: one caller could fill the global cap for everyone)', async () => {
  const f = await fixture({
    website: {clientIpSource: 'railway', mcpRegistrationLimits: {perAddressDaily: 2, daily: 50}},
  });
  try {
    for (let i = 0; i < 2; i++) assert.equal((await registerFrom(f, '198.51.100.7')).status, 201);
    const refused = await registerFrom(f, '198.51.100.7');
    assert.equal(refused.status, 429);
    const retry = Number(refused.headers.get('retry-after'));
    assert.ok(retry > 86000 && retry <= 86400, String(retry));
    const body = await refused.json();
    assert.equal(body.error, 'too_many_requests');
    assert.match(body.error_description, /from this network in the last 24 hours/);
    // Another address is unaffected; its invalid registration does not use up its place.
    assert.equal((await registerFrom(f, '203.0.113.9')).status, 201);
    assert.equal((await registerFrom(f, '203.0.113.9', {redirect_uris: ['http://client.example/cb']})).status, 400);
    assert.equal((await registerFrom(f, '203.0.113.9')).status, 201);
    assert.equal((await registerFrom(f, '203.0.113.9')).status, 429);
    // IPv6 clients share one place per /64, as every other AMCP limit keys them.
    assert.equal((await registerFrom(f, '2001:db8:5:6::1')).status, 201);
    assert.equal((await registerFrom(f, '2001:db8:5:6:ffff::2')).status, 201);
    assert.equal((await registerFrom(f, '2001:db8:5:6::3')).status, 429);
    assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM amcp_mcp_clients').get() as {n: number}).n, 6);
    // The first refusal of each kind leaves one line, without the address.
    const limited = f.logs.filter(e => e.event === 'mcp_registration_limited');
    assert.deepEqual(
      limited.map(e => [e.level, e.scope, e.limit]),
      [['warn', 'address', 2]],
    );
    assert.ok(!JSON.stringify(f.logs).includes('198.51.100.7'));
    assert.ok(!JSON.stringify(f.logs).includes('2001:db8'));
  } finally {
    await f.close();
  }
});

test('MCP-03: registrations sent together from one address cannot pass the address limit together', async () => {
  const f = await fixture({
    website: {clientIpSource: 'railway', mcpRegistrationLimits: {perAddressDaily: 1, daily: 50}},
  });
  try {
    const statuses = (await Promise.all([0, 1, 2, 3].map(() => registerFrom(f, '198.51.100.20')))).map(r => r.status);
    assert.deepEqual(
      statuses.sort((a, b) => a - b),
      [201, 429, 429, 429],
    );
  } finally {
    await f.close();
  }
});

test('MCP-03: the deployment daily limit refuses new registrations once reached, reopens as they age out of 24 hours, and raises the owner alarm', async () => {
  const f = await fixture({
    website: {clientIpSource: 'railway', mcpRegistrationLimits: {perAddressDaily: 2, daily: 3}},
  });
  try {
    for (const address of ['198.51.100.1', '198.51.100.2', '198.51.100.3'])
      assert.equal((await registerFrom(f, address)).status, 201);
    const refused = await registerFrom(f, '198.51.100.4');
    assert.equal(refused.status, 429);
    assert.match((await refused.json()).error_description, /daily number of new AI-client registrations/);
    const retry = Number(refused.headers.get('retry-after'));
    assert.ok(retry > 86000 && retry <= 86400, String(retry));
    const alarms = f.logs.filter(e => String(e.event).startsWith('mcp_registration_'));
    assert.deepEqual(
      alarms.map(e => [e.level, e.event, e.reason ?? e.scope]),
      [
        ['warn', 'mcp_registration_alarm', 'daily_registrations'],
        ['warn', 'mcp_registration_limited', 'deployment'],
      ],
    );
    assert.equal(alarms[0]!.registered_last_24h, 3);
    assert.equal(alarms[0]!.daily_limit, 3);
    // The owner's health view says so.
    const health = await (
      await f.request(
        '/api/workspace/workspace',
        'POST',
        {action: 'health'},
        {...f.admin, 'Content-Type': 'application/json'},
      )
    ).json();
    assert.equal(health.data.mcp_clients.registered_last_24h, 3);
    assert.equal(health.data.mcp_clients.daily_limit, 3);
    assert.equal(health.data.mcp_clients.per_address_daily_limit, 2);
    assert.deepEqual(health.data.mcp_clients.alarms, ['daily_registrations']);
    // A day later the registrations leave the window (and, never used, are released) and registration reopens.
    f.store.db
      .prepare("UPDATE amcp_mcp_clients SET data=json_set(data,'$.client_id_issued_at',?)")
      .run(Math.floor((Date.now() - 25 * 3600000) / 1000));
    assert.equal((await registerFrom(f, '198.51.100.4')).status, 201);
    assert.deepEqual(mcpClientCapacity(f.store).alarms, []);
  } finally {
    await f.close();
  }
});

test('MCP-03: registration limits are validated, and the environment sets them with a problem listed for a bad value', () => {
  assert.deepEqual(mcpRegistrationLimits(), {perAddressDaily: 30, daily: 300});
  assert.throws(() => mcpRegistrationLimits({daily: 0}), /AMCP_MCP_REGISTRATIONS_DAILY must be a whole number from 1/);
  assert.throws(() => mcpRegistrationLimits({perAddressDaily: 1.5}), /AMCP_MCP_REGISTRATIONS_PER_ADDRESS_DAILY/);
  assert.throws(() => mcpRegistrationLimits({perAddressDaily: 40, daily: 20}), /must not exceed/);
  const set = loadConfig({AMCP_MCP_REGISTRATIONS_PER_ADDRESS_DAILY: '10', AMCP_MCP_REGISTRATIONS_DAILY: '120'}, 'http');
  assert.deepEqual({...set.mcpRegistrationLimits}, {perAddressDaily: 10, daily: 120});
  assert.deepEqual(set.problems, []);
  const bad = loadConfig({AMCP_MCP_REGISTRATIONS_DAILY: 'many'}, 'http');
  assert.deepEqual({...bad.mcpRegistrationLimits}, {...mcpRegistrationLimitDefaults});
  assert.equal(bad.problems.length, 1);
  assert.match(
    bad.problems[0]!,
    /AMCP_MCP_REGISTRATIONS_DAILY must be a whole number\. The registration limit defaults/,
  );
});

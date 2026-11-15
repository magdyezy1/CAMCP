import {listenForFetch} from './http-listener.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import http from 'node:http';
import {Client} from '@modelcontextprotocol/client';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {auth, extractWWWAuthenticateParams, type OAuthClientProvider} from '@modelcontextprotocol/client';
import type {OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens} from '@modelcontextprotocol/client';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService, strictOptions} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {createHttpApp} from '../server/http-app.js';
import {Server} from '@modelcontextprotocol/server';
import {toWebRequest} from '@modelcontextprotocol/node';

import {
  createModernEndpoint,
  dualEraProtocolVersions,
  isModernRequest,
  mirroredHeader,
  modernProtocolModes,
  sendModernResponse,
  type ModernProtocolMode,
} from '../server/mcp-modern.js';
import {loadConfig, modernProtocolModeNames} from '../server/config.js';
import {readOnlyServerInstructions, serverInstructions} from '../src/tool-annotations.js';
import type {LinkRequest} from '../src/media-link.js';
import type {JsonObject} from '../src/types.js';

/**
 * MCP-03 phase 3 (review 2026-10-08) and the automated layer of the client interoperability runs (qualification plan
 * S14, layer 1): the dual-era endpoint serves MCP 2026-07-28 and the initialize-based revisions from one server, and
 * synthetic clients shaped like the must-pass clients of owner decision D14 (Claude.ai and Claude Desktop connectors,
 * Claude Code, ChatGPT, Codex, Cursor and VS Code) connect through protected-resource discovery, registration or a
 * client metadata document, consent with `iss`, token exchange and both protocol eras. Everything runs on loopback
 * with a synthetic store: `https://amcp.shop` is only the configured origin, and the clients' fetch is pointed at the
 * local listener, so nothing leaves the machine. The real clients (ACC-02) remain a manual check.
 */
const origin = 'https://amcp.shop',
  master = Buffer.alloc(32, 91).toString('base64'),
  password = 'synthetic-conformance-admin-password',
  modern = '2026-07-28';

/** Client metadata documents the synthetic clients publish; AMCP "fetches" them through this table, never the network. */
const documents: Record<string, JsonObject> = {
  'https://claude.ai/oauth/claude-code-client-metadata': {
    client_name: 'Claude Code',
    redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
  },
  'https://codex.example.com/oauth/client-metadata.json': {
    client_name: 'Codex',
    redirect_uris: ['http://127.0.0.1/auth/callback'],
  },
};
const documentRequest: LinkRequest = async url => {
  const document = documents[url.href];
  if (!document) return new Response('{}', {status: 404});
  return new Response(
    JSON.stringify({
      client_id: url.href,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...document,
    }),
    {headers: {'content-type': 'application/json'}},
  );
};

async function fixture(mode?: ModernProtocolMode, writes = false) {
  const store = new Store(':memory:', master),
    service = writes
      ? new MirrorService(new Registry(), store, new NativeTransport(), strictOptions, {
          allowWrites: true,
          requireBeforeState: true,
          maxBudgetChange: 0,
        })
      : new MirrorService(new Registry(), store),
    logs: JsonObject[] = [];
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
        mcpClientMetadata: {request: documentRequest},
      },
      ...(mode ? {mcpModernProtocol: mode} : {}),
      log: entry => logs.push(entry),
    }),
  );
  const base = 'http://127.0.0.1:' + (listener.address() as {port: number}).port;
  /** The clients' fetch: the configured origin is this listener; any other destination is refused. */
  const fetchFn = (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (!href.startsWith(origin + '/')) throw Error('No network in conformance tests: ' + href);
    return fetch(base + href.slice(origin.length), {...init, redirect: 'manual'});
  };
  const login = await fetch(base + '/api/session', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Origin: origin},
    body: JSON.stringify({password}),
  });
  assert.equal(login.status, 200);
  const admin = {
    Origin: origin,
    'Content-Type': 'application/json',
    Cookie: login.headers.get('set-cookie')!.split(';')[0]!,
    'X-AMCP-CSRF': ((await login.json()) as JsonObject).csrf as string,
  };
  return {
    store,
    logs,
    base,
    fetchFn,
    admin,
    key: (role: 'reader' | 'operator' = 'reader') =>
      store.createKey({tenantId: 'local', userId: 'conformance-' + role, role}),
    close: async () => {
      const closing = new Promise<void>(r => listener.close(() => r()));
      listener.closeAllConnections();
      await closing;
      store.close();
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** The per-request metadata a 2026-07-28 client sends. */
const modernMeta = (overrides: JsonObject = {}) => ({
  'io.modelcontextprotocol/protocolVersion': modern,
  'io.modelcontextprotocol/clientInfo': {name: 'conformance-client', version: '1.0.0'},
  'io.modelcontextprotocol/clientCapabilities': {},
  ...overrides,
});

/** One MCP 2026-07-28 request: the version in `_meta` and the header, Mcp-Method and Mcp-Name mirroring the body. */
async function modernCall(
  f: Fixture,
  path: string,
  token: string,
  method: string,
  params: JsonObject = {},
  options: {headers?: Record<string, string>; omit?: string[]; meta?: JsonObject; id?: unknown; body?: unknown} = {},
) {
  const name = ['tools/call', 'prompts/get'].includes(method)
    ? params.name
    : method === 'resources/read'
      ? params.uri
      : undefined;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: 'Bearer ' + token,
    'MCP-Protocol-Version': modern,
    'Mcp-Method': method,
    ...(typeof name === 'string' ? {'Mcp-Name': name} : {}),
    ...options.headers,
  };
  for (const header of options.omit ?? []) delete headers[header];
  const response = await fetch(f.base + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(
      options.body ?? {
        jsonrpc: '2.0',
        id: 'id' in options ? options.id : 7,
        method,
        params: {...params, _meta: options.meta ?? modernMeta()},
      },
    ),
  });
  const text = await response.text(),
    json = /json/.test(response.headers.get('content-type') ?? '');
  return {
    status: response.status,
    headers: response.headers,
    body: (text && json ? JSON.parse(text) : undefined) as JsonObject,
  };
}

/** One POST in the legacy framing (no `_meta` version), as a 1.x client sends after initialize (tests/mcp-sdk-v1-exchange.test.mjs replays a recorded one). */
async function legacyCall(f: Fixture, path: string, token: string, message: JsonObject, version = '2025-11-25') {
  const response = await fetch(f.base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer ' + token,
      ...(message.method === 'initialize' ? {} : {'MCP-Protocol-Version': version}),
    },
    body: JSON.stringify({jsonrpc: '2.0', id: 1, ...message}),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: (text ? JSON.parse(text) : undefined) as JsonObject,
  };
}

/** The SDK v2 client over Streamable HTTP, with an API key or an OAuth provider. */
async function sdkClient(f: Fixture, path: string, credential: {token?: string; provider?: OAuthClientProvider}) {
  const client = new Client({name: 'conformance-sdk-client', version: '1.0.0'});
  await client.connect(
    new StreamableHTTPClientTransport(new URL(origin + path), {
      fetch: f.fetchFn,
      ...(credential.provider ? {authProvider: credential.provider} : {}),
      ...(credential.token ? {requestInit: {headers: {Authorization: 'Bearer ' + credential.token}}} : {}),
    }),
  );
  return client;
}

/**
 * A dual-era client as the 2026-07-28 backward-compatibility rules describe it: a modern request first; a 400 with a
 * recognized modern error means a modern server (retry or correct), anything else falls back to initialize.
 */
async function dualEraConnect(f: Fixture, path: string, token: string) {
  const probe = await modernCall(f, path, token, 'server/discover');
  if (probe.status === 200) return {era: 'modern' as const, discover: probe.body.result as JsonObject};
  assert.ok(
    !(probe.status === 400 && [-32020, -32021, -32022].includes(probe.body?.error?.code)),
    'a modern refusal is not a reason to fall back: ' + JSON.stringify(probe.body),
  );
  return {era: 'legacy' as const, client: await sdkClient(f, path, {token}), refusal: probe};
}

test('MCP-03 phase 3: the modern protocol modes are the same in configuration and the handler; a bad value is ignored', () => {
  assert.deepEqual([...modernProtocolModeNames], [...modernProtocolModes]);
  assert.equal(loadConfig({}, 'http').mcpModernProtocol, 'off');
  assert.equal(loadConfig({AMCP_MCP_MODERN_PROTOCOL: 'next'}, 'http').mcpModernProtocol, 'next');
  assert.equal(loadConfig({AMCP_MCP_MODERN_PROTOCOL: 'ON'}, 'http').mcpModernProtocol, 'on');
  const bad = loadConfig({AMCP_MCP_MODERN_PROTOCOL: 'yes'}, 'http');
  assert.equal(bad.mcpModernProtocol, 'off');
  assert.deepEqual(bad.problems, ['AMCP_MCP_MODERN_PROTOCOL must be off, next or on; it was treated as off.']);
  const store = new Store(':memory:', master);
  try {
    assert.throws(
      () =>
        createHttpApp(new MirrorService(new Registry(), store), store, {
          mcpModernProtocol: 'yes' as ModernProtocolMode,
        }),
      /AMCP_MCP_MODERN_PROTOCOL must be off, next or on/,
    );
  } finally {
    store.close();
  }
  // Era selection: initialize is always legacy; a modern version in the header or _meta is modern.
  const body = (method: string, meta?: JsonObject) => ({
    jsonrpc: '2.0',
    id: 1,
    method,
    params: meta ? {_meta: meta} : {},
  });
  assert.equal(isModernRequest({'mcp-protocol-version': modern}, body('initialize')), false);
  assert.equal(isModernRequest({'mcp-protocol-version': '2025-11-25'}, body('tools/list')), false);
  assert.equal(isModernRequest({}, body('tools/list')), false);
  assert.equal(isModernRequest({'mcp-protocol-version': modern}, body('tools/list')), true);
  assert.equal(isModernRequest({}, body('tools/list', modernMeta())), true);
  assert.equal(isModernRequest({'mcp-protocol-version': '1900-01-01'}, body('tools/list')), true);
  assert.equal(isModernRequest({'mcp-protocol-version': modern}, [body('tools/list')]), false);
  // The Base64 sentinel of Mcp-Name, canonical and valid UTF-8 only.
  assert.equal(mirroredHeader('=?base64?' + Buffer.from('Hello, 世界').toString('base64') + '?='), 'Hello, 世界');
  assert.equal(mirroredHeader('plain_name'), 'plain_name');
  assert.equal(mirroredHeader('=?base64?SGVsbG8=?='), 'Hello');
  assert.equal(mirroredHeader('=?base64?SGVsbG9=?='), undefined);
  assert.equal(mirroredHeader('=?base64?/w==?='), undefined);
  assert.equal(mirroredHeader(['a', 'b']), undefined);
});

test('MCP-03 phase 3: with the modern protocol off (the default), /mcp keeps the legacy refusal a dual-era client falls back from, and /mcp/next is not served', async () => {
  const f = await fixture();
  try {
    const token = f.key();
    const connected = await dualEraConnect(f, '/mcp', token);
    assert.equal(connected.era, 'legacy');
    // The refusal is the SDK's: 400 with -32000, not a recognized modern error, so dual-era clients fall back.
    assert.equal(connected.refusal!.status, 400);
    assert.equal(connected.refusal!.body.error.code, -32000);
    const tools = await connected.client!.listTools();
    assert.ok(tools.tools.some(t => t.name === 'amcp_tool_help'));
    await connected.client!.close();
    // A modern-only client fails here (known until the owner turns the modern protocol on after ACC-02).
    const modernOnly = await modernCall(f, '/mcp', token, 'tools/list');
    assert.equal(modernOnly.status, 400);
    assert.equal((await modernCall(f, '/mcp/next', token, 'server/discover')).status, 404);
    // The probes are logged at info level, as before; the SDK client's GET for the optional server stream (405, as
    // before) and the path that is not served are ordinary refusals.
    assert.deepEqual(
      f.logs.filter(e => String(e.event).startsWith('mcp_')).map(e => [e.level, e.event, e.status]),
      [
        ['info', 'mcp_protocol_unsupported', 400],
        ['warn', 'mcp_refused', 405],
        ['info', 'mcp_protocol_unsupported', 400],
        ['warn', 'mcp_refused', 404],
      ],
    );
  } finally {
    await f.close();
  }
});

test('MCP-03 phase 3: legacy initialize on 2025-11-25 and 2025-06-18 is unchanged on a dual-era endpoint', async () => {
  const f = await fixture('on');
  try {
    const token = f.key();
    for (const version of ['2025-11-25', '2025-06-18']) {
      const initialized = await legacyCall(f, '/mcp', token, {
        method: 'initialize',
        params: {protocolVersion: version, capabilities: {}, clientInfo: {name: 'legacy-' + version, version: '1'}},
      });
      assert.equal(initialized.status, 200, JSON.stringify(initialized.body));
      assert.equal(initialized.body.result.protocolVersion, version);
      assert.equal(initialized.body.result.serverInfo.name, 'amcp');
      assert.deepEqual(initialized.body.result.capabilities, {tools: {}, resources: {}, prompts: {}});
      assert.equal(initialized.headers.get('mcp-session-id'), null);
      const listed = await legacyCall(f, '/mcp', token, {method: 'tools/list', params: {}}, version);
      assert.equal(listed.status, 200);
      // Legacy results keep their shape: no modern result type or caching hints.
      assert.equal(listed.body.result.resultType, undefined);
      assert.equal(listed.body.result.ttlMs, undefined);
    }
    // initialize selects legacy semantics even when a dual-era client names the modern revision: it negotiates down.
    const negotiated = await legacyCall(f, '/mcp', token, {
      method: 'initialize',
      params: {protocolVersion: modern, capabilities: {}, clientInfo: {name: 'dual', version: '1'}},
    });
    assert.equal(negotiated.body.result.protocolVersion, '2025-11-25');
    // The SDK v2 client still connects and calls tools.
    const client = await sdkClient(f, '/mcp', {token});
    const help = await client.callTool({name: 'amcp_tool_help', arguments: {}});
    assert.equal((help.structuredContent as JsonObject).success, true);
    await client.close();
  } finally {
    await f.close();
  }
});

test('MCP-03 phase 3: 2026-07-28 server/discover, tools, resources and prompts are served from the same handlers as the legacy revisions', async () => {
  const f = await fixture('on');
  try {
    const token = f.key();
    const initialized = await legacyCall(f, '/mcp', token, {
      method: 'initialize',
      params: {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'legacy', version: '1'}},
    });
    const discover = await modernCall(
      f,
      '/mcp',
      token,
      'server/discover',
      {},
      {headers: {'Mcp-Session-Id': 'ignored'}},
    );
    assert.equal(discover.status, 200, JSON.stringify(discover.body));
    assert.equal(discover.headers.get('mcp-session-id'), null, 'no session is minted or echoed');
    const d = discover.body.result;
    assert.equal(d.resultType, 'complete');
    assert.deepEqual(d.supportedVersions, [...dualEraProtocolVersions]);
    assert.equal(d.supportedVersions[0], modern);
    assert.ok(d.supportedVersions.includes('2025-11-25') && d.supportedVersions.includes('2025-06-18'));
    // The same capabilities, and the tasks extension besides, which only the 2026-07-28 revision is told of (V2-MCP-02).
    assert.deepEqual(d.capabilities, {
      ...initialized.body.result.capabilities,
      extensions: {'io.modelcontextprotocol/tasks': {}},
    });
    assert.equal(d.instructions, initialized.body.result.instructions);
    assert.equal(d.instructions, readOnlyServerInstructions, 'this read-only deployment’s own orientation');
    // The same identity on both revisions; the deployment's own icon is the 2026-07-28 answer's alone (V2-MCP-06, the lead's
    // note of 2026-11-07, tests/mcp-server-icon.test.mjs), so it is set apart and pinned here, and the rest is compared as before.
    const {icons, ...identity} = d._meta['io.modelcontextprotocol/serverInfo'];
    assert.deepEqual(identity, initialized.body.result.serverInfo);
    assert.deepEqual(icons, [
      {src: origin + '/assets/apple-touch-icon.png', mimeType: 'image/png', sizes: ['180x180']},
    ]);
    assert.ok(Number.isInteger(d.ttlMs) && d.ttlMs >= 0);
    assert.equal(d.cacheScope, 'public');
    // tools/list: the same tools in the same order as the legacy list, cacheable for this caller only.
    const tools = await modernCall(f, '/mcp', token, 'tools/list');
    const legacyTools = await legacyCall(f, '/mcp', token, {method: 'tools/list', params: {}});
    assert.equal(tools.body.result.resultType, 'complete');
    assert.equal(tools.body.result.cacheScope, 'private');
    assert.equal(tools.body.result.ttlMs, 300000);
    assert.deepEqual(tools.body.result.tools, legacyTools.body.result.tools);
    assert.deepEqual(
      (await modernCall(f, '/mcp', token, 'tools/list')).body.result.tools.map((t: JsonObject) => t.name),
      tools.body.result.tools.map((t: JsonObject) => t.name),
      'deterministic order',
    );
    // tools/call: the one envelope, as structured content and identical text, with the result type and identity.
    const help = await modernCall(f, '/mcp', token, 'tools/call', {name: 'amcp_tool_help', arguments: {}});
    assert.equal(help.status, 200);
    const result = help.body.result;
    assert.equal(result.resultType, 'complete');
    assert.equal(result.structuredContent.success, true);
    assert.equal(result.content[0].text, JSON.stringify(result.structuredContent));
    assert.equal(result.ttlMs, undefined, 'tool results carry no caching hints');
    assert.equal(result._meta['io.modelcontextprotocol/serverInfo'].name, 'amcp');
    // The Base64 sentinel form of Mcp-Name is decoded before it is compared.
    const encoded = await modernCall(
      f,
      '/mcp',
      token,
      'tools/call',
      {name: 'amcp_tool_help', arguments: {}},
      {headers: {'Mcp-Name': '=?base64?' + Buffer.from('amcp_tool_help').toString('base64') + '?='}},
    );
    assert.equal(encoded.status, 200);
    // Resources and prompts.
    const resources = await modernCall(f, '/mcp', token, 'resources/list');
    assert.equal(resources.body.result.cacheScope, 'private');
    const uri = resources.body.result.resources[0].uri as string;
    const read = await modernCall(f, '/mcp', token, 'resources/read', {uri});
    assert.equal(read.status, 200);
    assert.equal(read.body.result.contents[0].uri, uri);
    assert.equal(read.body.result.cacheScope, 'private');
    // An unknown resource is -32602 in 2026-07-28; the legacy revisions keep -32002.
    const missing = await modernCall(f, '/mcp', token, 'resources/read', {uri: 'amcp://guides/none'});
    assert.equal(missing.body.error.code, -32602);
    const legacyMissing = await legacyCall(f, '/mcp', token, {
      method: 'resources/read',
      params: {uri: 'amcp://guides/none'},
    });
    assert.equal(legacyMissing.body.error.code, -32002);
    assert.deepEqual(
      (await modernCall(f, '/mcp', token, 'resources/templates/list')).body.result.resourceTemplates,
      [],
    );
    const prompts = await modernCall(f, '/mcp', token, 'prompts/list');
    const prompt = prompts.body.result.prompts[0];
    assert.equal(prompts.body.result.cacheScope, 'private');
    const got = await modernCall(f, '/mcp', token, 'prompts/get', {name: prompt.name, arguments: {platform: 'meta'}});
    assert.equal(got.status, 200, JSON.stringify(got.body));
    assert.ok(got.body.result.messages.length > 0);
    // A notification is accepted without a body.
    const notified = await modernCall(
      f,
      '/mcp',
      token,
      'notifications/cancelled',
      {},
      {body: {jsonrpc: '2.0', method: 'notifications/cancelled', params: {_meta: modernMeta()}}},
    );
    assert.equal(notified.status, 202);
    assert.equal(notified.body, undefined);
  } finally {
    await f.close();
  }
});

test('MCP-03 phase 3: 2026-07-28 framing errors use the codes and statuses that revision defines', async () => {
  const f = await fixture('on');
  try {
    const token = f.key();
    const expect = async (
      label: string,
      call: Promise<{status: number; body: JsonObject}>,
      status: number,
      code: number,
      data: JsonObject = {},
    ) => {
      const r = await call;
      assert.equal(r.status, status, label + ': ' + JSON.stringify(r.body));
      assert.equal(r.body.error.code, code, label);
      for (const [k, v] of Object.entries(data)) assert.deepEqual(r.body.error.data[k], v, label + ' ' + k);
      assert.doesNotMatch(r.body.error.message, /^\s*[[{]/, label);
      return r;
    };
    const help = {name: 'amcp_tool_help', arguments: {}};
    await expect(
      'method mismatch',
      modernCall(f, '/mcp', token, 'tools/list', {}, {headers: {'Mcp-Method': 'prompts/list'}}),
      400,
      -32020,
      {header: 'Mcp-Method', code: 'MCP_HEADER_MISMATCH'},
    );
    await expect(
      'name mismatch',
      modernCall(f, '/mcp', token, 'tools/call', help, {headers: {'Mcp-Name': 'amcp_write'}}),
      400,
      -32020,
      {header: 'Mcp-Name'},
    );
    await expect('name missing', modernCall(f, '/mcp', token, 'tools/call', help, {omit: ['Mcp-Name']}), 400, -32020, {
      header: 'Mcp-Name',
    });
    await expect(
      'name not canonical base64',
      modernCall(f, '/mcp', token, 'tools/call', help, {headers: {'Mcp-Name': '=?base64?not base64?='}}),
      400,
      -32020,
    );
    await expect(
      'method missing',
      modernCall(f, '/mcp', token, 'tools/list', {}, {omit: ['Mcp-Method']}),
      400,
      -32020,
      {header: 'Mcp-Method'},
    );
    await expect(
      'version header missing',
      modernCall(f, '/mcp', token, 'tools/list', {}, {omit: ['MCP-Protocol-Version']}),
      400,
      -32020,
      {header: 'MCP-Protocol-Version'},
    );
    await expect(
      'header modern, _meta legacy',
      modernCall(
        f,
        '/mcp',
        token,
        'tools/list',
        {},
        {meta: modernMeta({'io.modelcontextprotocol/protocolVersion': '2025-11-25'})},
      ),
      400,
      -32020,
    );
    await expect(
      'header legacy, _meta modern',
      modernCall(f, '/mcp', token, 'tools/list', {}, {headers: {'MCP-Protocol-Version': '2025-11-25'}}),
      400,
      -32020,
    );
    const unsupported = await expect(
      'unsupported version',
      modernCall(
        f,
        '/mcp',
        token,
        'tools/list',
        {},
        {
          headers: {'MCP-Protocol-Version': '2027-01-01'},
          meta: modernMeta({'io.modelcontextprotocol/protocolVersion': '2027-01-01'}),
        },
      ),
      400,
      -32022,
      {supported: [...dualEraProtocolVersions], requested: '2027-01-01'},
    );
    assert.match(unsupported.body.error.message, /not supported/);
    await expect(
      'client capabilities missing',
      modernCall(f, '/mcp', token, 'tools/list', {}, {meta: {'io.modelcontextprotocol/protocolVersion': modern}}),
      400,
      -32602,
    );
    for (const method of ['ping', 'logging/setLevel', 'resources/subscribe', 'subscriptions/listen'])
      await expect(method, modernCall(f, '/mcp', token, method), 404, -32601, {method});
    await expect('null id', modernCall(f, '/mcp', token, 'tools/list', {}, {id: null}), 400, -32600);
    // Requests stay bounded by SEC-02 and the origin check in both eras.
    await expect(
      'batch',
      modernCall(f, '/mcp', token, 'tools/list', {}, {body: [{jsonrpc: '2.0', id: 1, method: 'tools/list'}]}),
      400,
      -32600,
      {code: 'BATCH_UNSUPPORTED'},
    );
    const foreign = await modernCall(
      f,
      '/mcp',
      token,
      'tools/list',
      {},
      {headers: {Origin: 'https://attacker.example'}},
    );
    assert.equal(foreign.status, 403);
    // A foreign Host (DNS rebinding) is refused before either era is chosen.
    const rebound = await new Promise<number>((resolve, reject) => {
      const body = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {_meta: modernMeta()}});
      const request = http.request(
        f.base + '/mcp',
        {
          method: 'POST',
          headers: {
            Host: 'rebound.example',
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: 'Bearer ' + token,
            'MCP-Protocol-Version': modern,
            'Mcp-Method': 'tools/list',
          },
        },
        response => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      request.on('error', reject);
      request.end(body);
    });
    assert.equal(rebound, 403);
    for (const method of ['GET', 'DELETE']) {
      const r = await fetch(f.base + '/mcp', {method, headers: {Authorization: 'Bearer ' + token}});
      assert.equal(r.status, 405, method);
      assert.equal(r.headers.get('allow'), 'POST');
    }
    // Refusals are logged without the token; only an unsupported version is an expected probe.
    const lines = f.logs.filter(e => String(e.event).startsWith('mcp_'));
    assert.ok(lines.some(e => e.event === 'mcp_refused' && e.code === 'MCP_HEADER_MISMATCH' && e.level === 'warn'));
    assert.deepEqual(
      lines.filter(e => e.level === 'info').map(e => [e.event, e.code, e.protocol_version]),
      [['mcp_protocol_unsupported', 'MCP_PROTOCOL_UNSUPPORTED', '2027-01-01']],
    );
    assert.ok(!JSON.stringify(f.logs).includes(token));
  } finally {
    await f.close();
  }
});

// F-L4-03: a createMcpHandler built for each request wrote the SDK's responseMode warning to the console on every
// modern request (4,148 lines in one audit run), unstructured noise in a log that treats MCP lines as outage evidence.
test('MCP-03 phase 3: serving modern requests writes nothing to the console', async () => {
  const f = await fixture('on'),
    written: string[] = [],
    original = {warn: console.warn, error: console.error, log: console.log};
  for (const level of ['warn', 'error', 'log'] as const)
    console[level] = (...args: unknown[]) => void written.push(level + ': ' + args.join(' '));
  try {
    const token = f.key();
    for (const method of [
      'server/discover',
      'tools/list',
      'resources/list',
      'resources/templates/list',
      'prompts/list',
    ])
      assert.equal((await modernCall(f, '/mcp', token, method)).status, 200, method);
    assert.equal(
      (await modernCall(f, '/mcp', token, 'tools/call', {name: 'amcp_tool_help', arguments: {}})).status,
      200,
    );
    assert.equal((await modernCall(f, '/mcp', token, 'tools/list')).status, 200, 'and again, on a later request');
    assert.deepEqual(written, []);
  } finally {
    Object.assign(console, original);
    await f.close();
  }
});

// F-L4-08: a notification skipped every check on the modern path, so one with a wrong Mcp-Method or an unsupported
// version was accepted (202) where the SDK's own handler refuses it, and a legacy notification with an unsupported
// version became 202 instead of 400 once the modern era was on.
test('MCP-03 phase 3: a modern notification is checked for its version and Mcp-Method before it is accepted', async () => {
  const f = await fixture('on');
  try {
    const token = f.key(),
      notify = (headers: Record<string, string>, omit: string[] = [], body?: JsonObject) =>
        modernCall(
          f,
          '/mcp',
          token,
          'notifications/cancelled',
          {},
          {
            headers,
            omit,
            body: body ?? {jsonrpc: '2.0', method: 'notifications/cancelled', params: {_meta: modernMeta()}},
          },
        );
    const accepted = await notify({});
    assert.equal(accepted.status, 202);
    const wrongMethod = await notify({'Mcp-Method': 'notifications/progress'});
    assert.equal(wrongMethod.status, 400);
    assert.equal(wrongMethod.body.error.code, -32020);
    assert.deepEqual(wrongMethod.body.error.data, {code: 'MCP_HEADER_MISMATCH', header: 'Mcp-Method'});
    const missingMethod = await notify({}, ['Mcp-Method']);
    assert.equal(missingMethod.status, 400);
    assert.equal(missingMethod.body.error.data.header, 'Mcp-Method');
    const unsupported = await notify({'MCP-Protocol-Version': '2027-01-01'});
    assert.equal(unsupported.status, 400);
    assert.equal(unsupported.body.error.code, -32022);
    assert.equal(unsupported.body.error.data.requested, '2027-01-01');
    assert.deepEqual(unsupported.body.error.data.supported, [...dualEraProtocolVersions]);
    const missingVersion = await notify({}, ['MCP-Protocol-Version']);
    assert.equal(missingVersion.status, 400);
    assert.equal(missingVersion.body.error.data.header, 'MCP-Protocol-Version');
    // A legacy-era notification with a version no revision serves is refused as it is with the modern era off.
    const legacyNotice = (version: string) =>
      fetch(f.base + '/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer ' + token,
          'MCP-Protocol-Version': version,
        },
        body: JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}),
      });
    assert.equal((await legacyNotice('2025-11-25')).status, 202);
    assert.equal((await legacyNotice('1900-01-01')).status, 400);
  } finally {
    await f.close();
  }
});

test('MCP-03 phase 3: next mode serves both eras at /mcp/next for the ACC-02 checks and leaves /mcp legacy', async () => {
  const f = await fixture('next');
  try {
    const token = f.key();
    assert.equal((await modernCall(f, '/mcp', token, 'server/discover')).body.error.code, -32000);
    const connected = await dualEraConnect(f, '/mcp/next', token);
    assert.equal(connected.era, 'modern');
    assert.equal(connected.discover!.resultType, 'complete');
    const legacy = await sdkClient(f, '/mcp/next', {token});
    assert.ok((await legacy.listTools()).tools.length > 0);
    await legacy.close();
    // /mcp/next lies inside the /mcp resource: its challenge names /mcp's protected-resource metadata.
    const anonymous = await fetch(f.base + '/mcp/next', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'MCP-Protocol-Version': modern, 'Mcp-Method': 'tools/list'},
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {_meta: modernMeta()}}),
    });
    assert.equal(anonymous.status, 401);
    assert.match(
      anonymous.headers.get('www-authenticate')!,
      /resource_metadata="https:\/\/amcp\.shop\/\.well-known\/oauth-protected-resource\/mcp"/,
    );
    assert.equal((await anonymous.json()).jsonrpc, '2.0');
    for (const method of ['GET', 'DELETE'])
      assert.equal(
        (await fetch(f.base + '/mcp/next', {method, headers: {Authorization: 'Bearer ' + token}})).status,
        405,
      );
  } finally {
    await f.close();
  }
});

test('MCP-03 phase 3: a viewer key gets the same tool refusal in both eras, and a revoked key is refused with 401 in both', async () => {
  const f = await fixture('on', true);
  try {
    const token = f.key('reader');
    const args = {action: 'prepare', gateway: 'meta_native_action', account_id: 'act_1', action_name: 'ADS_CREATE'};
    const modernWrite = await modernCall(f, '/mcp', token, 'tools/call', {name: 'amcp_write', arguments: args});
    const legacyWrite = await legacyCall(f, '/mcp', token, {
      method: 'tools/call',
      params: {name: 'amcp_write', arguments: args},
    });
    assert.equal(modernWrite.body.result.isError, true);
    assert.equal(legacyWrite.body.result.isError, true);
    assert.equal(
      modernWrite.body.result.structuredContent.error.code,
      legacyWrite.body.result.structuredContent.error.code,
    );
    f.store.revokeKey(token);
    const modernRevoked = await modernCall(f, '/mcp', token, 'tools/list');
    assert.equal(modernRevoked.status, 401);
    assert.match(modernRevoked.headers.get('www-authenticate')!, /error="invalid_token"/);
    assert.equal((await legacyCall(f, '/mcp', token, {method: 'tools/list', params: {}})).status, 401);
  } finally {
    await f.close();
  }
});

// Wave 4b review: server/discover took the deployment's instructions from the server createMcpServer made and fell back
// to the writes-mode text for any other server, and only the read-only mode was compared with initialize.
test('MCP-06: server/discover answers in the deployment’s own mode, and only for a server made for a deployment', async () => {
  for (const writes of [false, true]) {
    const f = await fixture('on', writes);
    try {
      const token = f.key(),
        discover = await modernCall(f, '/mcp', token, 'server/discover'),
        initialized = await legacyCall(f, '/mcp', token, {
          method: 'initialize',
          params: {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'legacy', version: '1'}},
        });
      assert.equal(discover.status, 200, JSON.stringify(discover.body));
      assert.equal(discover.body.result.instructions, writes ? serverInstructions : readOnlyServerInstructions);
      assert.equal(discover.body.result.instructions, initialized.body.result.instructions);
    } finally {
      await f.close();
    }
  }
  // The endpoint has no default orientation: one made without its deployment's instructions is refused, so it can never
  // answer discover with another mode's text (which could send a read-only deployment's client to prepare and execute).
  const bare = () => new Server({name: 'amcp', version: 'test'}, {capabilities: {tools: {}}});
  assert.throws(
    () => createModernEndpoint({factory: bare, instructions: ''}),
    /needs the instructions of its deployment/,
  );
  assert.throws(() => createModernEndpoint({factory: bare} as never), /needs the instructions of its deployment/);
});

/** The headers and body of one 2026-07-28 tools/call, as the modern endpoint receives them. */
function modernToolCall(name: string, id: string, meta: JsonObject = {}) {
  const headers = {'mcp-protocol-version': modern, 'mcp-method': 'tools/call', 'mcp-name': name},
    message = {jsonrpc: '2.0', id, method: 'tools/call', params: {name, arguments: {}, _meta: modernMeta(meta)}};
  return {
    headers,
    message,
    request: (signal?: AbortSignal) =>
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers},
        body: JSON.stringify(message),
        ...(signal ? {signal} : {}),
      }),
  };
}
const caller = {token: '', clientId: 'synthetic-caller', scopes: [], extra: {}};

test('MCP-03 phase 3: a 2026-07-28 request whose client goes away mid-call ends, aborts the handler and does not wait for good', async () => {
  let started!: () => void,
    finish!: () => void,
    aborted = false;
  const running = new Promise<void>(r => (started = r)),
    held = new Promise<void>(r => (finish = r));
  const endpoint = createModernEndpoint({
    instructions: 'synthetic deployment',
    factory: () => {
      const server = new Server({name: 'amcp', version: 'test'}, {capabilities: {tools: {}}});
      server.setRequestHandler('tools/call', async (_request, extra) => {
        extra.mcpReq.signal.addEventListener('abort', () => (aborted = true));
        started();
        await held;
        return {content: [{type: 'text', text: 'late'}]};
      });
      return server;
    },
  });
  try {
    const call = modernToolCall('slow_tool', 'call-1'),
      gone = new AbortController(),
      answer = endpoint.handle(call.request(gone.signal), {
        headers: call.headers,
        message: call.message,
        authInfo: caller,
      });
    await running;
    // The HTTP layer aborts the request when the response closes before it finished (the client disconnected).
    gone.abort();
    const timeout = new Promise<'waiting'>(r => setTimeout(() => r('waiting'), 2000).unref());
    const settled = await Promise.race([answer, timeout]);
    assert.notEqual(settled, 'waiting', 'the exchange ended when the client went away');
    assert.ok((settled as Response).status >= 400, 'a closed exchange is not answered as a success');
    assert.equal(aborted, true, 'the SDK aborted the handler');
    // The handler finishing later answers nobody and changes nothing.
    finish();
    await new Promise(r => setImmediate(r));
  } finally {
    await endpoint.close();
  }
});

// The handler no longer runs with responseMode "json", which dropped everything a handler sent before its result:
// V2-MCP-02's progress travels on the request's own stream, which the endpoint returns and the HTTP layer writes as it is.
test('MCP-03 phase 3: progress a handler sends reaches the client on the request’s own stream, written as the SDK framed it', async () => {
  const endpoint = createModernEndpoint({
    instructions: 'synthetic deployment',
    factory: () => {
      const server = new Server({name: 'amcp', version: 'test'}, {capabilities: {tools: {}}});
      server.setRequestHandler('tools/call', async (_request, extra) => {
        await extra.mcpReq.notify({
          method: 'notifications/progress',
          params: {progressToken: extra.mcpReq._meta?.progressToken as string, progress: 1, total: 2, message: 'half'},
        });
        return {content: [{type: 'text', text: 'finished'}]};
      });
      return server;
    },
  });
  // The HTTP layer in miniature: the same web request, endpoint call and response writer that /mcp uses. Reached through
  // fetch, so an OS-chosen port that Fetch forbids is released and asked again (tests/http-listener.ts).
  const listener = await listenForFetch(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    await sendModernResponse(
      res,
      await endpoint.handle(await toWebRequest(req, message), {headers: req.headers, message, authInfo: caller}),
    );
  });
  try {
    const call = modernToolCall('long_task', 'long-1', {progressToken: 'progress-1'}),
      response = await fetch('http://127.0.0.1:' + (listener.address() as {port: number}).port + '/mcp', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...call.headers},
        body: JSON.stringify(call.message),
      });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const messages = (await response.text())
      .split('\n')
      .filter(line => line.startsWith('data:') && line.slice(5).trim())
      .map(line => JSON.parse(line.slice(5)) as JsonObject);
    assert.equal(messages.length, 2, JSON.stringify(messages));
    assert.equal(messages[0]!.method, 'notifications/progress');
    assert.deepEqual(
      [messages[0]!.params.progressToken, messages[0]!.params.progress, messages[0]!.params.total],
      ['progress-1', 1, 2],
    );
    assert.equal(messages[1]!.id, 'long-1');
    assert.equal(messages[1]!.result.content[0].text, 'finished');
    assert.equal(messages[1]!.result.resultType, 'complete');
  } finally {
    await new Promise<void>(resolve => listener.close(() => resolve()));
    await endpoint.close();
  }
});

// F-L4-06: AMCP used to parse every SDK answer and stamp it `complete`, which hid a result that is not complete (a tool
// that needs more input from the client) behind a success.
test('MCP-03 phase 3: an SDK answer that is not complete reaches the client as the SDK framed it', async () => {
  const endpoint = createModernEndpoint({
    instructions: 'synthetic deployment',
    factory: () => {
      const server = new Server({name: 'amcp', version: 'test'}, {capabilities: {tools: {}}});
      server.setRequestHandler('tools/call', async () => ({
        resultType: 'input_required',
        inputRequests: {
          ask: {
            method: 'elicitation/create',
            params: {message: 'Which account?', requestedSchema: {type: 'object', properties: {}}},
          },
        },
        requestState: 'opaque',
      }));
      return server;
    },
  });
  try {
    // The client declares that it can answer an elicitation; without it the SDK refuses the exchange before the handler.
    const call = modernToolCall('ask', 'ask-1', {
        'io.modelcontextprotocol/clientCapabilities': {elicitation: {}},
      }),
      answer = await endpoint.handle(call.request(), {headers: call.headers, message: call.message, authInfo: caller}),
      body = (await answer.json()) as JsonObject;
    assert.equal(answer.status, 200);
    assert.equal(body.result.resultType, 'input_required');
    assert.equal(body.result.requestState, 'opaque');
    assert.equal(body.result.inputRequests.ask.method, 'elicitation/create');
    assert.equal(body.id, 'ask-1');
  } finally {
    await endpoint.close();
  }
});

/** An OAuth client provider kept in memory, as an MCP client stores its registration, verifier and tokens. */
class SyntheticProvider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier?: string;
  authorizationUrl?: URL;
  readonly expectedState = randomBytes(16).toString('base64url');
  constructor(
    readonly redirectUrl: string,
    readonly clientMetadata: OAuthClientMetadata,
    readonly clientMetadataUrl?: string,
  ) {}
  state() {
    return this.expectedState;
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier!;
  }
}

interface ClientProfile {
  name: string;
  /** How the client identifies itself: dynamic registration, or a client metadata document URL. */
  registration: 'dcr' | 'cimd';
  redirect: string;
  redirectUris?: string[];
  documentUrl?: string;
  /** Extra registration metadata the client sends (VS Code: application_type). */
  extra?: JsonObject;
  /** Whether the client speaks 2026-07-28 first (dual-era) or the legacy revisions only. */
  dualEra: boolean;
}
/**
 * The must-pass clients of owner decision D14, as the review's interoperability matrix records their documented
 * registration, redirect and protocol behavior (primary documents, 2026-10-08). Synthetic stand-ins: the real clients
 * are checked by hand in ACC-02.
 */
const profiles: ClientProfile[] = [
  {
    name: 'Claude.ai and Claude Desktop connector',
    registration: 'dcr',
    redirect: 'https://claude.ai/api/mcp/auth_callback',
    dualEra: false,
  },
  {
    name: 'Claude Code',
    registration: 'cimd',
    documentUrl: 'https://claude.ai/oauth/claude-code-client-metadata',
    redirect: 'http://localhost:53682/callback',
    dualEra: true,
  },
  {
    name: 'ChatGPT',
    registration: 'dcr',
    redirect: 'https://chatgpt.com/connector/oauth/conformance-callback',
    dualEra: false,
  },
  {
    name: 'Codex',
    registration: 'cimd',
    documentUrl: 'https://codex.example.com/oauth/client-metadata.json',
    redirect: 'http://127.0.0.1:41234/auth/callback',
    dualEra: true,
  },
  {
    name: 'Cursor',
    registration: 'dcr',
    redirect: 'http://localhost:8787/callback',
    redirectUris: ['http://localhost:8787/callback', 'https://www.cursor.com/agents/mcp/oauth/callback'],
    dualEra: false,
  },
  {
    name: 'VS Code',
    registration: 'dcr',
    redirect: 'http://127.0.0.1:33418',
    redirectUris: ['http://127.0.0.1:33418', 'https://vscode.dev/redirect'],
    extra: {application_type: 'native'},
    dualEra: false,
  },
];

test('MCP-03 conformance: each must-pass client profile (D14) discovers, registers or presents its metadata document, consents with iss, exchanges, refreshes, calls tools in its era, is refused once revoked and reconnects', async () => {
  const f = await fixture('on');
  try {
    const serverUrl = origin + '/mcp',
      prm = await (await f.fetchFn(origin + '/.well-known/oauth-protected-resource/mcp')).json(),
      metadata = await (await f.fetchFn(origin + '/.well-known/oauth-authorization-server')).json();
    // One issuer, byte for byte: the protected resource names it, the metadata states it, every response carries it.
    assert.equal(prm.resource, serverUrl);
    assert.equal(prm.authorization_servers[0], metadata.issuer);
    assert.equal(metadata.authorization_response_iss_parameter_supported, true);
    assert.equal(metadata.client_id_metadata_document_supported, true);
    const registered = () => (f.store.db.prepare('SELECT count(*) AS n FROM amcp_mcp_clients').get() as {n: number}).n;
    /** Steps 1 to 5 of a fresh connection: challenge, registration or document, consent, iss and token exchange. */
    const connect = async (profile: ClientProfile) => {
      const label = profile.name,
        before = registered();
      // 1. Discovery through the 401 challenge.
      const challenge = await f.fetchFn(serverUrl, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream'},
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: label, version: '1'}},
        }),
      });
      assert.equal(challenge.status, 401, label);
      const {resourceMetadataUrl, scope} = extractWWWAuthenticateParams(challenge);
      assert.equal(scope, 'mcp:read', label);
      // 2. Registration or metadata document, and the authorization request through the SDK client.
      const provider = new SyntheticProvider(
        profile.redirect,
        {
          client_name: label,
          redirect_uris: profile.redirectUris ?? [profile.redirect],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          ...(profile.extra ?? {}),
        } as OAuthClientMetadata,
        profile.documentUrl,
      );
      assert.equal(
        await auth(provider, {serverUrl, resourceMetadataUrl, scope, fetchFn: f.fetchFn}),
        'REDIRECT',
        label,
      );
      const request = provider.authorizationUrl!;
      assert.equal(request.searchParams.get('resource'), serverUrl, label);
      assert.equal(request.searchParams.get('code_challenge_method'), 'S256', label);
      if (profile.registration === 'cimd')
        assert.equal(request.searchParams.get('client_id'), profile.documentUrl, label);
      const added = registered() - before;
      // 3. Consent by a workspace administrator.
      const started = await f.fetchFn(request.href);
      assert.equal(started.status, 303, label + ': ' + (await started.clone().text()));
      const consentRequest = new URL(started.headers.get('location')!).searchParams.get('request');
      const decided = await fetch(f.base + '/api/mcp/consent', {
        method: 'POST',
        headers: f.admin,
        body: JSON.stringify({request: consentRequest, approved: true}),
      });
      assert.equal(decided.status, 200, label);
      const callback = new URL(((await decided.json()) as JsonObject).url);
      // 4. The authorization response: the registered redirect (a loopback port kept), state, and iss (RFC 9207),
      // compared with the recorded issuer by simple string comparison as 2026-07-28 requires.
      assert.equal(
        callback.origin + callback.pathname,
        new URL(profile.redirect).origin + new URL(profile.redirect).pathname,
      );
      assert.equal(callback.searchParams.get('state'), provider.expectedState, label);
      assert.equal(callback.searchParams.get('iss'), metadata.issuer, label);
      // 5. Token exchange with the resource indicator.
      assert.equal(
        await auth(provider, {
          serverUrl,
          resourceMetadataUrl,
          authorizationCode: callback.searchParams.get('code')!,
          iss: callback.searchParams.get('iss')!,
          fetchFn: f.fetchFn,
        }),
        'AUTHORIZED',
        label,
      );
      assert.equal(provider.saved!.scope, 'mcp:read', label);
      // The SDK keys stored credentials by the authorization server that discovery named (2026-07-28: credentials
      // keyed by issuer). That stamp is the metadata issuer and the iss above, byte for byte, so a client that checks
      // iss against its stored binding accepts AMCP's responses and presents its stored credentials here again.
      assert.equal(provider.info!.issuer, metadata.issuer, label);
      assert.equal(provider.saved!.issuer, metadata.issuer, label);
      return {provider, resourceMetadataUrl, added};
    };
    const revoke = async (label: string, clientId: string) => {
      const revoked = await fetch(f.base + '/api/mcp/authorizations/' + encodeURIComponent(clientId), {
        method: 'DELETE',
        headers: f.admin,
      });
      assert.equal(revoked.status, 200, label);
    };
    for (const profile of profiles) {
      const label = profile.name,
        {provider, resourceMetadataUrl, added} = await connect(profile);
      assert.equal(added, profile.registration === 'dcr' ? 1 : 0, label + ': registrations added');
      // Refresh with the stored, issuer-bound refresh token: a new pair, the same scope.
      const firstAccess = provider.saved!.access_token;
      assert.equal(await auth(provider, {serverUrl, resourceMetadataUrl, fetchFn: f.fetchFn}), 'AUTHORIZED', label);
      const access = provider.saved!.access_token;
      assert.notEqual(access, firstAccess, label + ': refreshed');
      assert.equal(provider.saved!.scope, 'mcp:read', label);
      assert.equal(provider.saved!.issuer, metadata.issuer, label);
      // 6. Tools in the client's era: a dual-era client stays modern; a legacy client initializes.
      if (profile.dualEra) {
        const connected = await dualEraConnect(f, '/mcp', access);
        assert.equal(connected.era, 'modern', label);
        const tools = await modernCall(f, '/mcp', access, 'tools/list');
        assert.ok(
          tools.body.result.tools.some((t: JsonObject) => t.name === 'amcp_tool_help'),
          label,
        );
      } else {
        const client = await sdkClient(f, '/mcp', {provider});
        const help = await client.callTool({name: 'amcp_tool_help', arguments: {}});
        assert.equal((help.structuredContent as JsonObject).success, true, label);
        await client.close();
      }
      // 7. Revoked in AMCP: the next call is refused with 401 in either era.
      await revoke(label, provider.info!.client_id);
      assert.equal((await modernCall(f, '/mcp', access, 'tools/list')).status, 401, label);
      assert.equal((await legacyCall(f, '/mcp', access, {method: 'tools/list', params: {}})).status, 401, label);
      // 8. Removed and added again (ACC-02's manual check, synthetic here): a metadata-document client reconnects
      // without adding a registration; a registering client adds one, which the per-address and daily limits bound
      // and the release rule frees once nothing of it is live.
      const again = await connect(profile);
      assert.equal(again.added, profile.registration === 'dcr' ? 1 : 0, label + ': registrations added on reconnect');
      if (profile.registration === 'cimd') assert.equal(again.provider.info!.client_id, provider.info!.client_id);
      await revoke(label, again.provider.info!.client_id);
    }
    // Known refusal (AMCP policy, recorded for ACC-02): a custom-scheme redirect, as older Cursor builds registered,
    // is refused as a whole with a readable reason.
    const custom = await f.fetchFn(origin + '/register', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        client_name: 'Cursor (older build)',
        redirect_uris: ['cursor://anysphere.cursor-retrieval/oauth/user-callback'],
        token_endpoint_auth_method: 'none',
      }),
    });
    assert.equal(custom.status, 400);
    const refusal = (await custom.json()) as JsonObject;
    assert.equal(refusal.error, 'invalid_client_metadata');
    assert.match(refusal.error_description, /HTTPS or loopback HTTP redirect URIs/);
  } finally {
    await f.close();
  }
});

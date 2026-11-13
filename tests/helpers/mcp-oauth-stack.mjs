// An AI client's whole path over the real stack, for the tests of the contract profile (V2-MCP-06): the website and its OAuth
// authorization server, the /mcp endpoint in both protocol eras, a client that registers itself (dynamic client
// registration), is authorized by a signed-in administrator and exchanges its code for the tokens it then calls with. Synthetic
// stores only: the provider transport and the website's fetcher refuse every request unless a test supplies one.
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService, strictOptions} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {WebStore} from '../../dist/server/web-store.js';
import {createHttpApp} from '../../dist/server/http-app.js';
import {listenForFetch} from '../../dist/tests/http-listener.js';
import {connectClient} from './mcp-long-run-stacks.mjs';

export const origin = 'https://amcp.shop',
  redirect = 'https://claude.ai/api/mcp/auth_callback',
  adminPassword = 'synthetic-profile-admin-password';
const sha = value => createHash('sha256').update(value).digest('hex');
const protocol = {modern: '2026-07-28', legacy: '2025-11-25'};
/**
 * One raw JSON-RPC request in the framing of an era (`legacy` or `modern`), with a bearer token: what travels, so the code of an
 * error is the wire's own and no SDK client has normalized it or kept an answer in its cache. The legacy framing is stateless
 * (no initialize), as a client that has already initialized sends it; `initialize` itself is sent as it is.
 */
async function rawRequest(url, access, era, method, params = {}) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: 'Bearer ' + access,
  };
  let body = {jsonrpc: '2.0', id: 1, method, params};
  if (era === 'modern') {
    Object.assign(headers, {'mcp-protocol-version': protocol.modern, 'mcp-method': method});
    if (method === 'resources/read') headers['mcp-name'] = params.uri;
    if (method === 'tools/call') headers['mcp-name'] = params.name;
    body = {
      ...body,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': protocol.modern,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    };
  } else if (method !== 'initialize') headers['mcp-protocol-version'] = protocol.legacy;
  const response = await fetch(url, {method: 'POST', headers, body: JSON.stringify(body)});
  return {status: response.status, body: await response.json()};
}
const refused = async () => {
  throw new Error('No provider traffic allowed');
};

/**
 * The stack: `store`, `service` and the HTTP app on a loopback port, with the website that authorizes AI clients. Options:
 * `fetcher` is the provider transport's fetch, `policy` the service's execution policy (writes are on by default),
 * `modern` where the 2026-07-28 revision is served. `connect(name)` runs a client through registration, consent and the
 * code exchange; `client(era, access)` is a real SDK client of one era holding an access token.
 */
export async function oauthStack(t, {fetcher = refused, policy, modern = 'on'} = {}) {
  const master = Buffer.alloc(32, 53).toString('base64'),
    store = new Store(':memory:', master),
    service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(fetcher),
      strictOptions,
      policy ?? {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
    ),
    website = {origin, masterKey: master, adminPassword, fetcher: refused};
  // A second view of the same database, as the website's own routes would hold: it signs people in and grants AI clients.
  const web = new WebStore(store, website);
  const listener = await listenForFetch(
    createHttpApp(service, store, {
      publicOrigin: origin,
      website,
      mcpModernProtocol: modern,
      mcpLimits: {perMinute: 0},
    }),
  );
  t.after(async () => {
    const closing = new Promise(resolve => listener.close(resolve));
    listener.closeAllConnections();
    await closing;
    store.close();
  });
  const base = 'http://127.0.0.1:' + listener.address().port,
    url = new URL(base + '/mcp');
  const request = async (path, method = 'GET', body, headers = {}) => {
    const form = body instanceof URLSearchParams,
      response = await fetch(base + path, {
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
      }),
      bytes = await response.arrayBuffer();
    return new Response([204, 205, 304].includes(response.status) ? null : bytes, {
      status: response.status,
      headers: response.headers,
    });
  };
  let admin;
  const adminHeaders = async () => {
    if (admin) return admin;
    const login = await request('/api/session', 'POST', {password: adminPassword});
    assert.equal(login.status, 200);
    admin = {Cookie: login.headers.get('set-cookie').split(';')[0], 'X-AMCP-CSRF': (await login.json()).csrf};
    return admin;
  };
  const token = body => request('/token', 'POST', new URLSearchParams(body));
  /** Registers a client, has the administrator authorize it, and exchanges its code: its registration and its tokens. */
  const connect = async (name = 'Claude', {registration = {}} = {}) => {
    const registered = await request('/register', 'POST', {
      client_name: name,
      redirect_uris: [redirect],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      ...registration,
    });
    assert.equal(registered.status, 201, await registered.clone().text());
    const client = await registered.json(),
      verifier = randomBytes(48).toString('base64url'),
      start = await request(
        '/authorize?' +
          new URLSearchParams({
            client_id: client.client_id,
            redirect_uri: redirect,
            response_type: 'code',
            code_challenge: createHash('sha256').update(verifier).digest('base64url'),
            code_challenge_method: 'S256',
            scope: 'mcp:read mcp:write',
            state: 'profile-state',
            resource: origin + '/mcp',
          }),
      );
    assert.equal(start.status, 303);
    const consent = new URL(start.headers.get('location')).searchParams.get('request'),
      decision = await request('/api/mcp/consent', 'POST', {request: consent, approved: true}, await adminHeaders());
    assert.equal(decision.status, 200, await decision.clone().text());
    const callback = new URL((await decision.json()).url),
      exchanged = await token({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        redirect_uri: redirect,
        code: callback.searchParams.get('code'),
        code_verifier: verifier,
        resource: origin + '/mcp',
      });
    assert.equal(exchanged.status, 200);
    const credentials = await exchanged.json();
    return {
      client,
      credentials,
      access: credentials.access_token,
      /** The client's next tokens by its refresh token: another credential of the same client. */
      refresh: async () => {
        const refreshed = await token({
          grant_type: 'refresh_token',
          client_id: client.client_id,
          refresh_token: credentials.refresh_token,
          resource: origin + '/mcp',
        });
        assert.equal(refreshed.status, 200, await refreshed.clone().text());
        const next = await refreshed.json();
        credentials.refresh_token = next.refresh_token;
        return next.access_token;
      },
    };
  };
  return {
    store,
    service,
    web,
    base,
    url,
    request,
    adminHeaders,
    connect,
    sha,
    /** A real SDK client of one protocol era (`legacy` or `modern`) calling with an access token or an API key. */
    client: (era, access) => connectClient(t, era, url, access),
    /** One raw request in an era's own framing (rawRequest above): `{status, body}` as the wire carries it. */
    wire: (access, era, method, params) => rawRequest(url, access, era, method, params),
  };
}

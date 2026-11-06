// F-L4-05: what today's clients send. The conformance suite and the SDK tests drive AMCP with the v2 client, which
// normalises errors and handles `iss` differently from the 1.x clients that Claude, ChatGPT and others still run, so
// nothing committed would notice a change that broke them. This replays a real exchange of the SDK 1.32.1 client
// through the HTTP stack: the client's initialize, tool calls, refusals and ping, the unauthenticated challenge,
// discovery, dynamic registration, the person's consent, the code exchange and a refresh, with the requests exactly as
// that client sent them. The fixture was recorded once from the preserved v1 dependency tree, read only; the repository
// has no v1 dependency and loads none (tests/fixtures/mcp-sdk-1.32.1-exchange.json, tests/helpers/sdk-exchange.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {answerShape, captured, fill} from './helpers/sdk-exchange.mjs';

const exchange = JSON.parse(fs.readFileSync('tests/fixtures/mcp-sdk-1.32.1-exchange.json', 'utf8')),
  origin = 'https://amcp.example',
  master = Buffer.alloc(32, 96).toString('base64'),
  password = 'synthetic-replay-admin-password';

/** The app the exchange was recorded against, on loopback, with the values the replay supplies. */
async function deployment(t, mode) {
  const store = new Store(':memory:', master),
    service = new MirrorService(new Registry(), store),
    app = createHttpApp(service, store, {
      publicOrigin: origin,
      website: {
        origin,
        masterKey: master,
        adminPassword: password,
        fetcher: async () => {
          throw Error('No provider traffic allowed');
        },
      },
      ...(mode ? {mcpModernProtocol: mode} : {}),
    }),
    server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const base = 'http://127.0.0.1:' + server.address().port,
    values = {
      api_key: store.createKey({tenantId: 'local', userId: 'exchange-reader', role: 'reader'}),
      admin_password: password,
    };
  /** Sends one recorded request (with `change` applied to it) and returns the shape of the answer. */
  async function run(step, change = request => request) {
    const request = change({
      method: step.request.method,
      path: fill(step.request.path, values),
      headers: Object.fromEntries(
        Object.entries(step.request.headers).map(([name, value]) => [name, fill(value, values)]),
      ),
      body: step.request.body === undefined ? undefined : fill(step.request.body, values),
    });
    const response = await fetch(base + request.path, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: 'manual',
      }),
      text = await response.text();
    for (const [name, spec] of Object.entries(step.capture ?? {}))
      values[name] = captured(spec, {headers: response.headers, text});
    return answerShape({status: response.status, headers: response.headers, text}, values, step.depth ?? 5);
  }
  return {run, values};
}
const named = (index, step) =>
  '#' + index + ' ' + step.label + ' ' + step.request.method + ' ' + step.request.path.split('?')[0];

test('the recording is a real SDK 1.32.1 exchange: its protocol, its OAuth steps and its refusals', () => {
  assert.equal(exchange.sdk_version, '1.32.1');
  const calls = exchange.steps
    .filter(step => step.request.path === '/mcp' && step.request.body)
    .map(step => JSON.parse(step.request.body));
  const methods = new Set(calls.map(call => call.method));
  for (const method of [
    'initialize',
    'notifications/initialized',
    'tools/list',
    'tools/call',
    'resources/list',
    'resources/read',
    'ping',
  ])
    assert.ok(methods.has(method), method + ' is recorded');
  assert.equal(calls.find(call => call.method === 'initialize').params.protocolVersion, '2025-11-25');
  const paths = exchange.steps.map(step => step.request.path.split('?')[0]);
  for (const path of [
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-authorization-server',
    '/register',
    '/authorize',
    '/token',
  ])
    assert.ok(paths.includes(path), path + ' is recorded');
  assert.equal(paths.filter(path => path === '/token').length, 2, 'the code exchange and one refresh');
  // A refusal the tool returns, a refusal of the protocol, and the unauthenticated challenge.
  const answers = exchange.steps.map(step => JSON.stringify(step.response.body));
  assert.ok(
    answers.some(text => text.includes('LIVE_WRITES_DISABLED')) && answers.some(text => text.includes('UNKNOWN_TOOL')),
  );
  assert.ok(answers.some(text => text.includes('-32002')));
  assert.ok(exchange.steps.some(step => step.response.status === 401 && step.response.headers['www-authenticate']));
  // No credential of the recording remains in the fixture.
  assert.doesNotMatch(JSON.stringify(exchange), /whm_[0-9a-f]{16}/);
});

for (const [mode, label] of [
  [undefined, 'the default configuration'],
  ['on', 'a dual-era endpoint (AMCP_MCP_MODERN_PROTOCOL=on)'],
])
  test('a recorded SDK 1.32.1 session is answered as it was recorded by ' + label, {timeout: 60000}, async t => {
    const d = await deployment(t, mode);
    for (const [index, step] of exchange.steps.entries())
      assert.deepEqual(await d.run(step), step.response, named(index, step));
  });

test('the replay can fail: a request that no longer matches what the client sent is answered differently', async t => {
  const d = await deployment(t),
    initialize = exchange.steps[0];
  assert.deepEqual(await d.run(initialize), initialize.response);
  const listed = exchange.steps[3];
  // The client's own protocol version header, changed to one no revision serves.
  assert.notDeepEqual(
    await d.run(listed, request => ({...request, headers: {...request.headers, 'mcp-protocol-version': '1999-01-01'}})),
    listed.response,
  );
  // Without its credential.
  const {authorization: _credential, ...bare} = listed.request.headers;
  assert.notDeepEqual(await d.run({...listed, request: {...listed.request, headers: bare}}), listed.response);
  // A method the revision does not have.
  assert.notDeepEqual(
    await d.run(listed, request => ({...request, body: request.body.replace('tools/list', 'tools/lists')})),
    listed.response,
  );
});

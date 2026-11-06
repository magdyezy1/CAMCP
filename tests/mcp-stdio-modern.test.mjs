// F-L4-04: AMCP_MCP_MODERN_PROTOCOL governs the 2026-07-28 revision on stdio as it does over HTTP (it was served whatever
// the flag said, so the documented rollback, "off", did not roll stdio back), and one revision answers alike on both.
// Real child processes speak raw JSON-RPC lines, so nothing in the client library decides what is asked.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {dualEraProtocolVersions} from '../dist/server/mcp-modern.js';
import {listenForFetch} from '../dist/tests/http-listener.js';

const modern = '2026-07-28',
  meta = {
    'io.modelcontextprotocol/protocolVersion': modern,
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': {name: 'stdio-parity', version: '1'},
  },
  serverInfoKey = 'io.modelcontextprotocol/serverInfo';

/** One stdio process of the standalone server, spoken to in raw JSON-RPC lines. */
function stdioSession(flag) {
  const env = {
    ...process.env,
    MIRROR_DB: ':memory:',
    MIRROR_TENANT_ID: 'stdio-modern',
    MIRROR_MASTER_KEY: '',
    MIRROR_ALLOW_WRITES: 'false',
    MIRROR_MODE: 'strict',
    MIRROR_FLAGS: '{}',
  };
  delete env.AMCP_MCP_MODERN_PROTOCOL;
  if (flag !== undefined) env.AMCP_MCP_MODERN_PROTOCOL = flag;
  const child = spawn(process.execPath, [path.resolve('dist/server/stdio.js')], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
    waiting = new Map();
  let buffered = '',
    nextId = 1;
  child.stdout.on('data', chunk => {
    buffered += chunk;
    for (let end; (end = buffered.indexOf('\n')) >= 0;) {
      const message = JSON.parse(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
      waiting.get(message.id)?.(message);
    }
  });
  return {
    /** The JSON-RPC answer to one request, in full. */
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no answer to ' + method)), 15000);
        waiting.set(id, message => {
          clearTimeout(timer);
          waiting.delete(id);
          resolve(message);
        });
        child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n');
      });
    },
    close: () =>
      new Promise(resolve => {
        child.once('exit', () => resolve());
        child.kill();
      }),
  };
}
// The session's modern call adds the per-request envelope every 2026-07-28 request carries.
const modernParams = params => ({...params, _meta: meta});

for (const flag of [undefined, '', 'off'])
  test(
    'stdio with AMCP_MCP_MODERN_PROTOCOL ' +
      JSON.stringify(flag) +
      ' refuses the 2026-07-28 revision and serves the earlier ones',
    async () => {
      const session = stdioSession(flag);
      try {
        const discover = await session.request('server/discover', modernParams({}));
        assert.equal(discover.error?.code, -32601, JSON.stringify(discover));
        assert.equal(discover.result, undefined);
        // The earlier revisions are untouched: the process still negotiates and lists tools the legacy way.
        const initialized = await session.request('initialize', {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: {name: 'stdio-legacy', version: '1'},
        });
        assert.equal(initialized.result.protocolVersion, '2025-11-25', JSON.stringify(initialized));
        const listed = await session.request('tools/list', {});
        assert.equal(listed.result.tools.length > 0, true);
        assert.equal(listed.result.resultType, undefined, 'a legacy result carries no 2026-07-28 framing');
        assert.equal(listed.result.ttlMs, undefined);
      } finally {
        await session.close();
      }
    },
  );

for (const flag of ['next', 'on'])
  test('stdio with AMCP_MCP_MODERN_PROTOCOL ' + flag + ' also serves the 2026-07-28 revision', async () => {
    const session = stdioSession(flag);
    try {
      const discover = await session.request('server/discover', modernParams({}));
      assert.equal(discover.result?.resultType, 'complete', JSON.stringify(discover));
      assert.deepEqual(discover.result.supportedVersions, [modern]);
      assert.equal((await session.request('tools/list', modernParams({}))).result.resultType, 'complete');
    } finally {
      await session.close();
    }
  });

test('stdio and HTTP answer the 2026-07-28 revision alike: stamps, caching hints, lists, templates and errors', async () => {
  const store = new Store(':memory:'),
    service = new MirrorService(new Registry(), store),
    key = store.createKey({tenantId: 'stdio-modern', userId: 'reader', role: 'reader'}),
    listener = await listenForFetch(createHttpApp(service, store, {mcpModernProtocol: 'on'})),
    url = 'http://127.0.0.1:' + listener.address().port + '/mcp',
    session = stdioSession('on');
  /** The same 2026-07-28 request over HTTP: its version, method and name in headers, its envelope in the body. */
  const http = async (method, params = {}) => {
    const name = ['tools/call', 'prompts/get'].includes(method)
      ? params.name
      : method === 'resources/read'
        ? params.uri
        : undefined;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer ' + key,
        'MCP-Protocol-Version': modern,
        'Mcp-Method': method,
        ...(name === undefined ? {} : {'Mcp-Name': name}),
      },
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params: modernParams(params)}),
    });
    return {status: response.status, body: await response.json()};
  };
  try {
    for (const [method, params] of [
      ['tools/list', {}],
      ['prompts/list', {}],
      ['resources/list', {}],
      ['resources/templates/list', {}],
      ['resources/read', {uri: 'amcp://guides/index'}],
    ]) {
      const over = await http(method, params),
        stdio = await session.request(method, modernParams(params));
      assert.equal(over.status, 200, method);
      // Everything the answer says, down to the stamps and hints, is the same.
      const result = {...over.body.result};
      assert.equal(result.resultType, 'complete', method);
      assert.deepEqual(result.ttlMs, 300000, method + ' ttl');
      assert.equal(result.cacheScope, 'private', method + ' scope');
      assert.equal(result._meta[serverInfoKey].name, 'amcp');
      assert.deepEqual(stdio.result, result, method);
    }
    assert.deepEqual(
      (await session.request('resources/templates/list', modernParams({}))).result.resourceTemplates,
      [],
    );
    // A refusal the handlers raise carries the same code and data.
    const missing = {uri: 'amcp://guides/none'},
      overMissing = await http('resources/read', missing),
      stdioMissing = await session.request('resources/read', modernParams(missing));
    assert.equal(stdioMissing.error.code, -32602);
    assert.equal(overMissing.body.error.code, -32602);
    assert.deepEqual(stdioMissing.error.data, overMissing.body.error.data);
    // server/discover: the same capabilities, instructions, stamps and hints. The versions differ by design: HTTP is
    // stateless and names every revision its endpoint serves; a stdio connection is pinned to one era by its first
    // message, so its SDK-built answer names the modern revision it is serving.
    const overDiscover = (await http('server/discover')).body.result,
      stdioDiscover = (await session.request('server/discover', modernParams({}))).result;
    assert.deepEqual(overDiscover.supportedVersions, [...dualEraProtocolVersions]);
    assert.deepEqual(stdioDiscover.supportedVersions, [modern]);
    delete overDiscover.supportedVersions;
    delete stdioDiscover.supportedVersions;
    assert.equal(overDiscover.ttlMs, 3600000);
    assert.equal(overDiscover.cacheScope, 'public');
    assert.deepEqual(stdioDiscover, overDiscover);
  } finally {
    await session.close();
    await new Promise(resolve => listener.close(resolve));
    store.close();
  }
});

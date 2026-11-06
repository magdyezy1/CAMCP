import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {Server} from '@modelcontextprotocol/server';
import {StdioClientTransport, getDefaultEnvironment} from '@modelcontextprotocol/client/stdio';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {createModernEndpoint} from '../dist/server/mcp-modern.js';
import {listenForFetch} from '../dist/tests/http-listener.js';

const missingGuide = 'amcp://guides/sdk-v2-missing',
  frozenHelpSha256 = '076e72c8e8e6ad452d8e72cd75e0f2c02946ee36064dc7f74929e9a07839465b';
const options = era => (era === 'modern' ? {versionNegotiation: {mode: {pin: '2026-07-28'}}} : {});

async function exercise(client, transport, era) {
  await client.connect(transport);
  const wire = [],
    receive = transport.onmessage;
  transport.onmessage = (message, extra) => {
    wire.push(message);
    receive?.(message, extra);
  };
  const tools = await client.listTools(),
    help = tools.tools.find(tool => tool.name === 'amcp_tool_help');
  assert.ok(help, 'The frozen help tool remains discoverable');
  assert.equal(createHash('sha256').update(JSON.stringify(help.inputSchema)).digest('hex'), frozenHelpSha256);
  const result = await client.callTool({name: 'amcp_tool_help', arguments: {}});
  assert.equal(result.structuredContent.success, true);
  assert.equal(result.content[0].text, JSON.stringify(result.structuredContent));
  const resources = await client.listResources();
  assert.ok(resources.resources.length > 0);
  const guide = await client.readResource({uri: resources.resources[0].uri});
  assert.equal(guide.contents[0].uri, resources.resources[0].uri);
  await assert.rejects(client.readResource({uri: missingGuide}), {message: /Unknown AMCP guide URI/});
  const missing = wire.find(message => message.error?.data?.uri === missingGuide);
  assert.ok(missing, 'The missing-guide response is observable on the actual transport');
  assert.equal(missing.error.code, era === 'legacy' ? -32002 : -32602);
  assert.equal(missing.error.data.index, 'amcp://guides/index');
}

test('SDK v2 uses pinned official packages without retaining the v1 SDK dependency', () => {
  const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8')),
    lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  assert.equal(manifest.dependencies['@modelcontextprotocol/sdk'], undefined);
  for (const [name, version] of Object.entries({
    server: '2.4.0',
    core: '2.4.0',
    client: '2.4.0',
    express: '2.0.2',
    node: '2.1.2',
    'server-legacy': '2.4.0',
  })) {
    assert.equal(manifest.dependencies['@modelcontextprotocol/' + name], version);
    assert.equal(lock.packages['node_modules/@modelcontextprotocol/' + name].version, version);
  }
  assert.equal(
    Object.keys(lock.packages).some(name => name.endsWith('/@modelcontextprotocol/sdk')),
    false,
  );
});

test('SDK v2 modern HTTP dispatch gives handlers the request context required by native protocol features', async () => {
  // One endpoint serves many requests; the factory is asked for a server per request and is told who is calling.
  const callers = [];
  const endpoint = createModernEndpoint({
    instructions: 'synthetic deployment',
    factory: factoryContext => {
      callers.push(factoryContext.authInfo?.extra?.caller);
      const server = new Server({name: 'sdk-context', version: '1'}, {capabilities: {tools: {}}});
      server.setRequestHandler('tools/call', async (_request, context) => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              hasHttpRequest: context.http?.req instanceof Request,
              protocol: context.http?.req?.headers.get('mcp-protocol-version'),
              caller: factoryContext.authInfo?.extra?.caller,
              era: factoryContext.era,
            }),
          },
        ],
      }));
      return server;
    },
  });
  try {
    const headers = {'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'read_context'};
    for (const caller of ['first-caller', 'second-caller']) {
      const message = {
        jsonrpc: '2.0',
        id: 'context',
        method: 'tools/call',
        params: {
          name: 'read_context',
          arguments: {},
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': {name: 'sdk-context-client', version: '1'},
          },
        },
      };
      const answer = await endpoint.handle(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers},
          body: JSON.stringify(message),
        }),
        {headers, message, authInfo: {token: '', clientId: caller, scopes: [], extra: {caller}}},
      );
      assert.equal(answer.status, 200);
      assert.deepEqual(JSON.parse((await answer.json()).result.content[0].text), {
        hasHttpRequest: true,
        protocol: '2026-07-28',
        caller,
        era: 'modern',
      });
    }
    assert.deepEqual(callers, ['first-caller', 'second-caller'], 'each request built its own server for its caller');
  } finally {
    await endpoint.close();
  }
});

for (const era of ['legacy', 'modern']) {
  test(
    `SDK v2 real HTTP client preserves ${era} protocol, frozen help and resource errors`,
    {timeout: 20000},
    async () => {
      const store = new Store(':memory:'),
        service = new MirrorService(new Registry(), store),
        key = store.createKey({tenantId: 'sdk-v2-test', userId: 'reader', role: 'reader'}),
        listener = await listenForFetch(createHttpApp(service, store, {mcpModernProtocol: 'on'})),
        url = new URL('http://127.0.0.1:' + listener.address().port + '/mcp'),
        client = new Client({name: 'sdk-v2-http', version: '1'}, options(era)),
        transport = new StreamableHTTPClientTransport(url, {requestInit: {headers: {Authorization: 'Bearer ' + key}}});
      try {
        await exercise(client, transport, era);
      } finally {
        await client.close();
        await new Promise(resolve => listener.close(resolve));
        store.close();
      }
    },
  );

  test(
    `SDK v2 real stdio client preserves ${era} protocol, frozen help and resource errors`,
    {timeout: 20000},
    async () => {
      const client = new Client({name: 'sdk-v2-stdio', version: '1'}, options(era)),
        transport = new StdioClientTransport({
          command: process.execPath,
          args: [path.resolve('dist/server/stdio.js')],
          cwd: process.cwd(),
          env: {
            ...getDefaultEnvironment(),
            MIRROR_DB: ':memory:',
            MIRROR_TENANT_ID: 'sdk-v2-test',
            MIRROR_MASTER_KEY: '',
            MIRROR_ALLOW_WRITES: 'false',
            MIRROR_MODE: 'strict',
            MIRROR_FLAGS: '{}',
            // Stdio serves the 2026-07-28 revision only when the rollout flag says so (F-L4-04).
            AMCP_MCP_MODERN_PROTOCOL: era === 'modern' ? 'on' : 'off',
          },
          stderr: 'pipe',
        });
      try {
        await exercise(client, transport, era);
      } finally {
        await client.close();
      }
    },
  );
}

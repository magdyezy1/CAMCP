// V2-MCP-06, the lead's note of 2026-11-07 (after the new logo): the 2026-07-28 revision's server/discover answers with the
// deployment's own square icon in its serverInfo, so a client that shows an icon shows the new mark. It is metadata on that one
// answer: no other answer carries it (the identity every modern result is stamped with is unchanged, so no response grows), the
// earlier revisions' initialize answer has none, and a deployment with no public address, whose icon no client could fetch,
// offers none.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';
import * as mcp from '../dist/server/mcp.js';
import {oauthStack, origin} from './helpers/mcp-oauth-stack.mjs';

const serverInfoKey = 'io.modelcontextprotocol/serverInfo';
const initialize = {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'icon-test', version: '1'}};
const icon = {src: origin + '/assets/apple-touch-icon.png', mimeType: 'image/png', sizes: ['180x180']};

test('server/discover offers the deployment’s own square icon, and the rest of the identity is the earlier revisions’', async t => {
  const s = await oauthStack(t),
    {access} = await s.connect('Icon client'),
    legacy = (await s.wire(access, 'legacy', 'initialize', initialize)).body.result.serverInfo,
    discover = (await s.wire(access, 'modern', 'server/discover')).body.result;
  assert.equal(discover.resultType, 'complete');
  assert.deepEqual(discover._meta[serverInfoKey], {...legacy, icons: [icon]});
  // The earlier revisions' answer is as it was: a name and a version.
  assert.deepEqual(Object.keys(legacy).sort(), ['name', 'version']);
  assert.equal(legacy.name, 'amcp');
  // The icon is cached like the rest of the answer, which is the deployment's and not the caller's.
  assert.equal(discover.cacheScope, 'public');
});

test('no other answer carries the icon: every modern result is stamped with the identity it always was', async t => {
  const s = await oauthStack(t),
    {access} = await s.connect('Icon client'),
    identity = (await s.wire(access, 'legacy', 'initialize', initialize)).body.result.serverInfo;
  for (const [method, params] of [
    ['tools/list', {}],
    ['tools/call', {name: 'amcp_tool_help', arguments: {}}],
    ['resources/list', {}],
    ['resources/templates/list', {}],
    ['resources/read', {uri: 'amcp://guides/index'}],
    ['prompts/list', {}],
  ]) {
    const answer = await s.wire(access, 'modern', method, params);
    assert.equal(answer.status, 200, method);
    assert.deepEqual(answer.body.result._meta[serverInfoKey], identity, method);
    // Stated outright, not only as equal to the earlier revisions' answer: a name and a version, so no result grows by an icon.
    assert.deepEqual(Object.keys(answer.body.result._meta[serverInfoKey]).sort(), ['name', 'version'], method);
  }
});

test('the icon is the website’s own: an HTTPS address on the deployment, serving the brand kit’s 180 by 180 app icon', async t => {
  const s = await oauthStack(t),
    {access} = await s.connect('Icon client'),
    [offered] = (await s.wire(access, 'modern', 'server/discover')).body.result._meta[serverInfoKey].icons,
    address = new URL(offered.src);
  assert.equal(address.protocol, 'https:');
  assert.equal(address.origin, origin);
  // The address resolves, on this deployment, to the file the brand kit ships: no redirect, the right type, byte for byte.
  const served = await fetch(s.base + address.pathname, {redirect: 'manual'});
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), offered.mimeType);
  const bytes = Buffer.from(await served.arrayBuffer()),
    file = fs.readFileSync('web/apple-touch-icon.png');
  assert.ok(bytes.equals(file), 'the served bytes are web/apple-touch-icon.png');
  // What the icon says it is, is what it is: a PNG of the declared size (a replaced icon must update the declaration).
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(offered.sizes, [bytes.readUInt32BE(16) + 'x' + bytes.readUInt32BE(20)]);
  assert.equal(bytes.readUInt32BE(16), bytes.readUInt32BE(20), 'square');
});

test('a deployment with no public address offers no icon, and the identity helpers say the same', async t => {
  const store = new Store(':memory:', Buffer.alloc(32, 77).toString('base64')),
    service = new MirrorService(new Registry(), store),
    key = store.createKey({tenantId: 'icon-test', userId: 'reader', role: 'reader'}),
    listener = await listenForFetch(createHttpApp(service, store, {mcpModernProtocol: 'on'}));
  t.after(async () => {
    await new Promise(resolve => listener.close(resolve));
    store.close();
  });
  const response = await fetch('http://127.0.0.1:' + listener.address().port + '/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer ' + key,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'server/discover',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    }),
    info = (await response.json()).result._meta[serverInfoKey];
  assert.deepEqual(Object.keys(info).sort(), ['name', 'version']);
  assert.deepEqual(Object.keys(mcp.mcpServerInfo()).sort(), ['name', 'version']);
  assert.deepEqual(mcp.mcpServerInfo(mcp.mcpServerIcons(origin)).icons, [icon]);
  assert.deepEqual(mcp.mcpServerIcons(origin), [icon]);
});

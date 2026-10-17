import {listenForFetch} from './http-listener.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {createHttpApp} from '../server/http-app.js';
test('real HTTP MCP enforces bearer, origin and body limits and serves SDK tools', async () => {
  const store = new Store(':memory:'),
    service = new MirrorService(new Registry(), store);
  const key = store.createKey({tenantId: 'http-test', userId: 'r', role: 'reader'});
  const listener = await listenForFetch(createHttpApp(service, store, {maxBodyBytes: 8192}));
  const address = listener.address() as {port: number},
    url = new URL('http://127.0.0.1:' + address.port + '/mcp');
  const client = new Client({name: 'http-integration', version: '1'});
  try {
    assert.equal(
      (await fetch(url, {method: 'POST', body: '{}', headers: {'Content-Type': 'application/json'}})).status,
      401,
    );
    assert.equal(
      (
        await fetch(url, {
          method: 'POST',
          body: '{}',
          headers: {Authorization: 'Bearer ' + key, Origin: 'https://evil.invalid', 'Content-Type': 'application/json'},
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(url, {
          method: 'POST',
          body: JSON.stringify({padding: 'x'.repeat(9000)}),
          headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json'},
        })
      ).status,
      413,
    );
    assert.equal(
      (
        await fetch(url, {
          method: 'POST',
          body: '{',
          headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json'},
        })
      ).status,
      400,
    );
    await client.connect(
      new StreamableHTTPClientTransport(url, {requestInit: {headers: {Authorization: 'Bearer ' + key}}}),
    );
    // A read-only deployment lists amcp_write with inspect only (owner decision D15, MCP-09).
    // Parked providers are not offered by default: Amazon Ads (CON-06), Criteo and WooCommerce (ARC-01, P9).
    assert.equal((await client.listTools()).tools.length, 25);
    const result = await client.callTool({name: 'amcp_tool_help', arguments: {}});
    const presented = JSON.parse((result.content as any)[0].text);
    assert.equal(presented.success, true);
    assert.equal(presented.data.surface, 'compact-v1');
    assert.equal((result.content as any)[0].text, JSON.stringify(result.structuredContent));
    store.revokeKey(key);
    assert.equal((await fetch(url, {headers: {Authorization: 'Bearer ' + key}})).status, 401);
  } finally {
    await client.close();
    await new Promise<void>(r => listener.close(() => r()));
    store.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/client';
import {createMcpServer} from '../dist/server/mcp.js';
import {wooSourceFixture} from './fixtures/woocommerce-source-data.mjs';
import {offerParkedProviders} from './helpers/parked-providers.mjs';

// WooCommerce is parked (ARC-01, P9): this suite exercises it, so it offers it like a
// deployment whose AMCP_PROVIDERS names it.
offerParkedProviders('woocommerce');

test('real MCP uses the existing captured store-discovery schema and preserves credential and authority fences', async () => {
  const f = wooSourceFixture({role: 'operator'}),
    key = f.store.createKey(f.actor),
    actor = f.store.authenticate(key);
  const server = createMcpServer(f.service, actor),
    client = new Client({name: 'Synthetic store discovery evaluator', version: '1.0.0'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const tools = (await client.listTools()).tools,
      outer = new Ajv({strict: false}).compile(tools.find(t => t.name === 'commerce_native_action').inputSchema);
    const help = await client.callTool({
      name: 'amcp_tool_help',
      arguments: {gateway: 'commerce_native_action', operation: 'woocommerce_list_stores'},
    });
    const inner = new Ajv({strict: false}).compile(help.structuredContent.data.argumentsSchema);
    for (const arguments_ of [{}, {include_disconnected: true}]) {
      const input = {operation: 'woocommerce_list_stores', arguments: arguments_};
      assert.equal(outer(input), true);
      assert.equal(inner(arguments_), true);
      const result = await client.callTool({name: 'commerce_native_action', arguments: input});
      assert.equal(result.isError === true, false);
      assert.deepEqual(JSON.parse(result.content[0].text), JSON.parse(JSON.stringify(result.structuredContent)));
      assert.equal(result.structuredContent.success, true);
      assert.equal(result.structuredContent.data.stores[0].account_id, 'store-1');
      assert.equal(result.structuredContent.data.coverage.live_access_verified, false);
      assert.doesNotMatch(JSON.stringify(result), /synthetickey|syntheticsecret|consumerSecret/);
    }
    f.store.revokeKey(key);
    const revoked = await client.callTool({
      name: 'commerce_native_action',
      arguments: {operation: 'woocommerce_list_stores', arguments: {}},
    });
    assert.equal(revoked.isError, true);
    assert.equal(revoked.structuredContent.success, false);
    assert.equal(revoked.structuredContent.data, undefined);
    assert.equal(f.calls.length, 0);
    assert.equal(f.store.documents(f.actor.tenantId, 'campaign').length, 0);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
    f.close();
  }
});

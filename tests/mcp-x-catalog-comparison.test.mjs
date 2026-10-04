import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {xCatalogComparisonFixture} from './fixtures/x-catalog-comparison.mjs';

test('real MCP compares supplied X products and retains only the exact eligible unapproved native subset with revoked-access refusal', async t => {
  const f = xCatalogComparisonFixture({writable: true, tenant: 'synthetic-x-comparison-sdk'}),
    key = f.store.createKey(f.actor),
    actor = f.store.authenticate(key),
    server = createMcpServer(f.service, actor),
    client = new Client({name: 'Synthetic X comparison evaluator', version: '1.0.0'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  let calls = 0,
    bytes = 0;
  try {
    delete f.items[9001][2].image_link;
    const tools = (await client.listTools()).tools,
      validate = new Map(
        ['amcp_workspace', 'amcp_campaign'].map(name => [
          name,
          new Ajv({strict: false}).compile(tools.find(t => t.name === name).inputSchema),
        ]),
      );
    const call = async (name, input) => {
      const check = validate.get(name);
      assert.equal(check(input), true, JSON.stringify(check.errors));
      const result = await client.callTool({name, arguments: input});
      calls++;
      bytes += Buffer.byteLength(JSON.stringify(result.structuredContent));
      assert.deepEqual(JSON.parse(result.content[0].text), JSON.parse(JSON.stringify(result.structuredContent)));
      assert.equal(result.isError === true, result.structuredContent.success === false);
      assert.doesNotMatch(
        JSON.stringify(result.structuredContent),
        /synthetic-token|consumerSecret|tokenSecret|accessToken/,
      );
      return result.structuredContent;
    };
    const preview = await call('amcp_workspace', {...f.input, action: 'catalog_preview'});
    assert.equal(preview.success, true);
    const comparison = await call('amcp_workspace', f.input);
    assert.equal(comparison.success, true, JSON.stringify(comparison).slice(0, 1200));
    assert.equal(comparison.data.source_hash, preview.data.source_hash);
    assert.deepEqual(comparison.data.review_retailer_ids, ['sku-4', 'sku-1', 'sku-3']);
    assert.equal(f.calls.length, 8);
    assert.equal(f.writes(), 0);
    const ids = new Set(comparison.data.review_retailer_ids),
      products = f.input.products.filter(p => ids.has(p.retailer_id)),
      saved = await call('amcp_workspace', {...f.input, action: 'catalog_plan', products});
    assert.equal(saved.success, true);
    const full = await call('amcp_campaign', {action: 'get', id: saved.data.id, detail: 'full'});
    assert.equal(full.success, true);
    assert.equal(full.data.state, 'draft');
    assert.equal(full.data.steps.length, 3);
    assert.deepEqual(
      full.data.steps.map(s => s.arguments.payload.products[0].id),
      ['sku-4', 'sku-1', 'sku-3'],
    );
    assert.ok(full.data.steps.every(s => s.status === 'pending' && s.gateway === 'x_ads_native_action'));
    assert.equal(f.store.documents(actor.tenantId, 'write_review').length, 0);
    f.store.revokeKey(key);
    assert.equal((await call('amcp_workspace', f.input)).success, false);
    assert.equal(f.calls.length, 8);
    assert.equal(f.writes(), 0);
    t.diagnostic(
      JSON.stringify({
        tool_calls: calls,
        structured_response_bytes: bytes,
        synthetic_native_gets: f.calls.length,
        provider_mutations: 0,
        local_drafts: 1,
        external_requests: 0,
      }),
    );
  } finally {
    await client.close();
    await server.close();
    f.store.close();
  }
});

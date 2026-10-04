import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {wooSourceFixture, wooSourceInput} from './fixtures/woocommerce-source-data.mjs';

test('real MCP preserves explicit WooCommerce source identity and supplied prices through an unapproved Meta draft with no provider mutation', async t => {
  const f = wooSourceFixture({role: 'operator'}),
    key = f.store.createKey(f.actor),
    actor = f.store.authenticate(key);
  f.store.putConnection(
    {...f.actor, role: 'admin'},
    {
      id: 'meta-login',
      tenantId: f.actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['123'],
      enabled: true,
      label: 'Synthetic Meta',
      scopes: [],
    },
    {accessToken: 'synthetic-meta-token'},
  );
  const server = createMcpServer(f.service, actor),
    client = new Client({name: 'Synthetic WooCommerce source evaluator', version: '1.0.0'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  let calls = 0,
    bytes = 0;
  try {
    const tools = (await client.listTools()).tools,
      validators = new Map(
        ['amcp_workspace', 'amcp_campaign'].map(name => [
          name,
          new Ajv({strict: false}).compile(tools.find(tool => tool.name === name).inputSchema),
        ]),
      );
    const call = async (name, input) => {
      const validate = validators.get(name);
      assert.equal(validate(input), true, JSON.stringify(validate.errors));
      const result = await client.callTool({name, arguments: input});
      calls++;
      bytes += Buffer.byteLength(JSON.stringify(result.structuredContent));
      assert.deepEqual(JSON.parse(result.content[0].text), JSON.parse(JSON.stringify(result.structuredContent)));
      assert.equal(result.isError === true, result.structuredContent.success === false);
      assert.doesNotMatch(
        JSON.stringify(result.structuredContent),
        /UNUSED-PRIVATE-WOO|synthetickey|syntheticsecret|synthetic-meta-token|consumerSecret/,
      );
      return result.structuredContent;
    };
    const sources = await call('amcp_workspace', {action: 'catalog_sources'});
    assert.equal(sources.data.items[0].account_id, 'store-1');
    assert.equal(f.calls.length, 0);
    const source = await call('amcp_workspace', wooSourceInput());
    assert.equal(source.success, true, JSON.stringify(source));
    assert.equal(source.data.items[0].selected_price, '0012.34');
    assert.equal(
      source.meta.workflow.website_path,
      '/commerce?woo_source=1&connection_id=woo-login&account_id=store-1&product_ids=101&price_field=price',
    );
    const input = {
      gateway: 'meta_native_action',
      connection_id: 'meta-login',
      account_id: '123',
      catalog_id: '555',
      allow_upsert: false,
      products: source.data.items.map(item => ({
        retailer_id: item.sku,
        name: item.name,
        price: item.selected_price,
        currency: source.data.native_currency,
        image_url: item.first_image_url,
      })),
    };
    const preview = await call('amcp_workspace', {action: 'catalog_preview', ...input});
    assert.equal(preview.success, true);
    assert.equal(preview.data.items[0].price_minor_units, 1234);
    const saved = await call('amcp_workspace', {action: 'catalog_plan', ...input});
    assert.equal(saved.success, true, JSON.stringify(saved));
    assert.equal(saved.data.state, 'draft');
    assert.equal(saved.data.source_hash, preview.data.source_hash);
    const full = await call('amcp_campaign', {action: 'get', id: saved.data.id, detail: 'full'});
    assert.equal(full.success, true);
    assert.deepEqual(full.data.steps[0].arguments, preview.data.plan.steps[0].arguments);
    assert.equal(full.data.steps[0].status, 'pending');
    assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 0);
    assert.equal(f.calls.length, 4);
    const rejected = await call(
      'amcp_workspace',
      wooSourceInput({requirements: {product_ids: ['101'], price_field: 'price', url: 'https://other.example.test'}}),
    );
    assert.equal(rejected.success, false);
    assert.equal(f.calls.length, 4);
    f.store.revokeKey(key);
    assert.equal((await call('amcp_workspace', wooSourceInput())).success, false);
    assert.equal(f.calls.length, 4);
    t.diagnostic(
      JSON.stringify({
        tool_calls: calls,
        structured_response_bytes: bytes,
        synthetic_native_reads: 4,
        provider_mutations: 0,
        local_drafts: 1,
        external_requests: 0,
      }),
    );
  } finally {
    await client.close();
    await server.close();
    f.close();
  }
});

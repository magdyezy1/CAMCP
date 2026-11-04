import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/client';
import {createMcpServer} from '../dist/server/mcp.js';
import {wooVariationsFixture, wooVariationInput} from './fixtures/woocommerce-variations-data.mjs';
import {offerParkedProviders} from './helpers/parked-providers.mjs';

// WooCommerce is parked (ARC-01, P9): this suite exercises it, so it offers it like a
// deployment whose AMCP_PROVIDERS names it.
offerParkedProviders('woocommerce');

test('real MCP retains selected variation hierarchy and explicit reviewed title in the original unapproved Meta draft', async t => {
  const f = wooVariationsFixture({role: 'operator'}),
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
    client = new Client({name: 'Synthetic selected variation evaluator', version: '1.0.0'}),
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
    assert.equal((await call('amcp_workspace', {action: 'catalog_sources'})).data.items[0].account_id, 'store-1');
    assert.equal(f.calls.length, 0);
    const source = await call('amcp_workspace', wooVariationInput());
    assert.equal(source.success, true, JSON.stringify(source));
    assert.equal(source.data.items[0].name, null);
    assert.deepEqual(source.data.items[0].attributes, [
      {id: '1', name: 'Color', option: 'Red'},
      {id: '2', name: 'Size', option: 'Small'},
    ]);
    assert.equal(
      source.meta.workflow.website_path,
      '/commerce?woo_source=1&connection_id=woo-login&account_id=store-1&product_ids=102&price_field=price&source_kind=variations&parent_product_id=101',
    );
    const child = source.data.items[0],
      input = {
        gateway: 'meta_native_action',
        connection_id: 'meta-login',
        account_id: '123',
        catalog_id: '555',
        allow_upsert: false,
        products: [
          {
            retailer_id: child.sku,
            name: 'Explicitly reviewed shoe — red, small',
            retailer_product_group_id: source.data.parent.sku,
            price: child.selected_price,
            currency: source.data.native_currency,
            image_url: child.first_image_url,
            url: child.product_url,
          },
        ],
      };
    const preview = await call('amcp_workspace', {action: 'catalog_preview', ...input});
    assert.equal(preview.success, true, JSON.stringify(preview));
    const payload = preview.data.plan.steps[0].arguments.payload;
    assert.equal(payload.retailer_id, 'VAR-001');
    assert.equal(payload.retailer_product_group_id, 'GROUP-001');
    assert.equal(payload.name, input.products[0].name);
    assert.equal(payload.price, 1234);
    assert.equal(child.selected_price, '0012.34');
    const saved = await call('amcp_workspace', {action: 'catalog_plan', ...input});
    assert.equal(saved.success, true, JSON.stringify(saved));
    assert.equal(saved.data.state, 'draft');
    assert.equal(saved.data.source_hash, preview.data.source_hash);
    const full = await call('amcp_campaign', {action: 'get', id: saved.data.id, detail: 'full'});
    assert.deepEqual(full.data.steps[0].arguments, preview.data.plan.steps[0].arguments);
    assert.equal(full.data.steps[0].status, 'pending');
    assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 0);
    const rejected = await call('amcp_workspace', wooVariationInput({product_ids: ['101']}));
    assert.equal(rejected.success, false);
    f.store.revokeKey(key);
    assert.equal((await call('amcp_workspace', wooVariationInput())).success, false);
    assert.equal(f.calls.length, 6);
    t.diagnostic(
      JSON.stringify({
        tool_calls: calls,
        structured_response_bytes: bytes,
        synthetic_native_reads: 6,
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

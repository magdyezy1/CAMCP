import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {workflowOutcome} from '../dist/src/workflow-outcomes.js';
import {wooInventoryBrowserFixture, wooInventoryInput} from './fixtures/woocommerce-inventory-data.mjs';
import {fullDescription} from './fixtures/tool-help.mjs';

test('real MCP inventory preserves hierarchy, exact values and no-change evidence through schema-validated calls and a scoped website handoff', async t => {
  const f = wooInventoryBrowserFixture(),
    key = f.store.createKey(f.actor),
    actor = f.store.authenticate(key),
    server = createMcpServer(f.service, actor),
    client = new Client({name: 'Synthetic inventory evaluator', version: '1.0.0'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  let calls = 0,
    bytes = 0;
  const before = {
    drafts: f.store.documents(f.actor.tenantId, 'campaign_run').length,
    reviews: f.store.documents(f.actor.tenantId, 'write_review').length,
  };
  try {
    const tools = (await client.listTools()).tools,
      validate = new Ajv({strict: false}).compile(tools.find(tool => tool.name === 'amcp_workspace').inputSchema);
    assert.ok((await fullDescription(client, 'amcp_workspace')).includes('source_kind:inventory'));
    const call = async input => {
      assert.equal(validate(input), true, JSON.stringify(validate.errors));
      const result = await client.callTool({name: 'amcp_workspace', arguments: input});
      calls++;
      bytes += Buffer.byteLength(JSON.stringify(result.structuredContent));
      assert.deepEqual(JSON.parse(result.content[0].text), JSON.parse(JSON.stringify(result.structuredContent)));
      assert.equal(result.isError === true, result.structuredContent.success === false);
      assert.doesNotMatch(
        JSON.stringify(result.structuredContent),
        /UNUSED-PRIVATE|synthetickey|syntheticsecret|consumerSecret/,
      );
      return result.structuredContent;
    };
    assert.equal((await call({action: 'catalog_sources'})).data.items[0].account_id, 'store-1');
    assert.equal(f.calls.length, 0);
    const out = await call(wooInventoryInput());
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.data.record_kind, 'catalog_source_inventory');
    assert.equal(out.data.item_count, 124);
    assert.equal(out.data.items.find(item => item.product_id === '9223372036854775807').selected_price, null);
    assert.equal(out.data.items.find(item => item.product_id === '5').selected_price, '999999999999.000001');
    assert.equal(out.data.items.find(item => item.product_id === '1001').status, 'private');
    assert.equal(out.data.items.find(item => item.product_id === '1002').name, null);
    assert.deepEqual(out.data.items[0].variation_ids, ['1001', '1002', '9223372036854775807']);
    assert.equal(
      out.meta.workflow.website_path,
      '/commerce?woo_inventory=1&connection_id=woo-login&account_id=store-1&price_field=price',
    );
    assert.equal(out.meta.workflow.next_call, undefined);
    assert.equal(out.data.native_requests, 9);
    assert.equal(out.data.saved_drafts, 0);
    assert.equal(out.data.source_saved, false);
    assert.equal(
      (
        await call(
          wooInventoryInput({requirements: {source_kind: 'inventory', product_ids: ['1'], price_field: 'price'}}),
        )
      ).success,
      false,
    );
    f.store.revokeKey(key);
    assert.equal((await call(wooInventoryInput())).success, false);
    assert.equal(f.calls.length, 9, 'Invalid selectors and withdrawn authority never read the provider');
    assert.deepEqual(
      {
        drafts: f.store.documents(f.actor.tenantId, 'campaign_run').length,
        reviews: f.store.documents(f.actor.tenantId, 'write_review').length,
      },
      before,
    );
    t.diagnostic(
      JSON.stringify({
        tool_calls: calls,
        structured_response_bytes: bytes,
        synthetic_native_reads: 9,
        provider_mutations: 0,
        local_drafts: 0,
        external_requests: 0,
      }),
    );
  } finally {
    await client.close();
    await server.close();
    f.close();
  }
});

test('inventory website handoffs require complete known collection filters and reject malformed scoped IDs', async () => {
  const f = wooInventoryBrowserFixture();
  try {
    const original = (await f.service.call('amcp_workspace', wooInventoryInput(), f.actor)).data;
    for (const mutate of [
      out => (out.state = 'partial'),
      out => (out.complete_collected_inventory = false),
      out => (out.scope.api_version = 'wc/v4'),
      out => (out.scope.product_status = 'any'),
      out => (out.scope.variation_status = 'publish'),
      out => (out.scope.absent_source_policy = 'delete'),
      out => (out.scope.price_field = 'unknown'),
      out => (out.scope.account_id = 'a/b'),
      out => (out.scope.connection_id = 'a&b'),
    ]) {
      const out = structuredClone(original);
      mutate(out);
      assert.equal(workflowOutcome('amcp_workspace', out).website_path, undefined);
    }
    assert.equal(workflowOutcome('amcp_media', original).website_path, undefined);
    assert.equal(f.calls.length, 9);
  } finally {
    f.close();
  }
});

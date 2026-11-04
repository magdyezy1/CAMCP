import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/client';
import {createMcpServer} from '../dist/server/mcp.js';
import {xCatalogInventoryFixture, catalogInventoryReason} from './fixtures/x-catalog-selection-inventory-data.mjs';

async function linked(t, options) {
  const f = xCatalogInventoryFixture(options),
    key = f.store.createKey(f.actor),
    actor = f.store.authenticate(key),
    server = createMcpServer(f.service, actor),
    client = new Client({name: 'Synthetic listed X catalog evaluator', version: '1.0.0'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const schemas = (await client.listTools()).tools,
    validators = new Map(
      ['amcp_workspace', 'amcp_campaign'].map(name => [
        name,
        new Ajv({strict: false}).compile(schemas.find(t => t.name === name).inputSchema),
      ]),
    );
  let calls = 0,
    bytes = 0;
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
      /UNSELECTED-PRIVATE|synthetic-token|consumerSecret|tokenSecret|accessToken/,
    );
    return result.structuredContent;
  };
  t.after(async () => {
    await client.close();
    await server.close();
    f.store.close();
  });
  return {
    ...f,
    key,
    actor,
    call,
    validators,
    diagnostic: () =>
      t.diagnostic(
        JSON.stringify({
          tool_calls: calls,
          structured_response_bytes: bytes,
          synthetic_native_gets: f.calls.length,
          provider_mutations: f.writes(),
          external_requests: 0,
        }),
      ),
  };
}

test('real MCP exposes typed read-only listed inventory and saves only explicitly supplied products in an unapproved original draft', async t => {
  const f = await linked(t, {writable: true}),
    source = {...f.input};
  delete source.inspect_other_listed_products;
  delete source.absent_source_policy;
  const schema = f.validators.get('amcp_workspace');
  assert.equal(schema({...f.input, inspect_other_listed_products: 'true'}), false);
  assert.equal(schema({...f.input, absent_source_policy: 'delete'}), false);
  const preview = await f.call('amcp_workspace', {...source, action: 'catalog_preview'});
  assert.equal(preview.success, true);
  const compared = await f.call('amcp_workspace', f.input);
  assert.equal(compared.success, true);
  assert.equal(compared.data.source_hash, preview.data.source_hash);
  assert.equal(compared.data.items.length, 2);
  assert.equal(compared.data.listed_inventory.items.length, 121);
  assert.equal(
    compared.data.listed_inventory.items.find(p => p.retailer_id === 'sku-5').price,
    '999999999999.000001 SAR',
  );
  assert.equal(compared.data.listed_inventory.source_absence_established, false);
  assert.equal(compared.data.listed_inventory.variant_inventory_complete, false);
  assert.equal(compared.data.listed_inventory.absent_source_policy, 'retain');
  assert.equal(f.calls.length, 10);
  assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
  const saved = await f.call('amcp_workspace', {...source, action: 'catalog_plan'});
  assert.equal(saved.success, true);
  const full = await f.call('amcp_campaign', {action: 'get', id: saved.data.id, detail: 'full'});
  assert.equal(full.success, true);
  assert.equal(full.data.state, 'draft');
  assert.equal(full.data.steps.length, 2);
  assert.deepEqual(
    full.data.steps.map(s => s.arguments.payload.products[0].id),
    ['sku-1', 'sku-2'],
  );
  assert.ok(
    full.data.steps.every(
      s => s.status === 'pending' && s.arguments.action === 'x_product_catalogs_product_catalog_id_products_put',
    ),
  );
  assert.equal(f.calls.length, 10);
  assert.equal(f.writes(), 0);
  assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 0);
  assert.equal(f.store.documents(f.actor.tenantId, 'x_catalog_removal_preview').length, 0);
  f.store.revokeKey(f.key);
  assert.equal((await f.call('amcp_workspace', f.input)).success, false);
  assert.equal(f.calls.length, 10);
  f.diagnostic();
});

test('real MCP retains original changed-inventory refusal and needs an explicit retry before any successful observation', async t => {
  const f = await linked(t, {fault: true});
  const failed = await f.call('amcp_workspace', f.input);
  assert.equal(failed.success, false);
  assert.equal(failed.error.code, 'CATALOG_COMPARISON_CHANGED');
  assert.equal(failed.error.message, catalogInventoryReason);
  assert.equal(failed.data, undefined);
  assert.equal(f.calls.length, 10);
  assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
  f.setFault(false);
  const recovered = await f.call('amcp_workspace', f.input);
  assert.equal(recovered.success, true);
  assert.equal(recovered.data.listed_inventory.items.length, 121);
  assert.equal(f.calls.length, 20);
  assert.equal(f.writes(), 0);
  assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 0);
  assert.equal(f.store.documents(f.actor.tenantId, 'x_catalog_removal_preview').length, 0);
  f.diagnostic();
});

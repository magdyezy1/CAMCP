import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/client';
import {createMcpServer} from '../dist/server/mcp.js';
import {setup} from './x-catalog-fixture.mjs';
import {xImportInput, xImportProduct} from './fixtures/x-catalog-import-data.mjs';

test('real MCP maps explicit supplier fields to an unchanged X draft with exact JSON prices and revoked-access refusal', async t => {
  const f = setup({tenant: 'synthetic-x-import-sdk'}),
    key = f.store.createKey(f.actor),
    actor = f.store.authenticate(key);
  const server = createMcpServer(f.service, actor),
    client = new Client({name: 'Synthetic X destination evaluator', version: '1.0.0'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  let calls = 0,
    bytes = 0;
  try {
    const tools = (await client.listTools()).tools,
      validate = new Map(
        ['amcp_workspace', 'amcp_campaign'].map(name => [
          name,
          new Ajv({strict: false}).compile(tools.find(d => d.name === name).inputSchema),
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
        /UNUSED-PRIVATE-X|synthetic-token|consumerSecret|tokenSecret|accessToken/,
      );
      return result.structuredContent;
    };
    // COM-03: AMCP projects the supplier export with the catalog's saved mapping profile; the MCP client sends the
    // export as it is, and its unmapped private column is never returned.
    const source = xImportProduct({price: '999999999999.000001'}),
      headers = Object.keys(source).concat('Private notes'),
      encode = value => '"' + String(value).replaceAll('"', '""') + '"',
      text =
        headers.map(encode).join(',') +
        '\n' +
        [...Object.values(source), 'UNUSED-PRIVATE-X'].map(encode).join(',') +
        '\n',
      scope = Object.fromEntries(Object.entries(xImportInput()).filter(([k]) => k !== 'products'));
    const mapping = await call('amcp_workspace', {
      action: 'save_catalog_mapping',
      gateway: scope.gateway,
      connection_id: scope.connection_id,
      account_id: scope.account_id,
      catalog_id: scope.catalog_id,
      requirements: {
        columns: Object.fromEntries(
          Object.keys(source)
            .filter(k => k !== 'currency')
            .map(k => [k, k]),
        ),
        fixed_currency: 'SAR',
        image_mode: 'single',
      },
    });
    assert.equal(mapping.success, true, JSON.stringify(mapping));
    const input = {...scope, requirements: {source: {kind: 'csv', text, columns: 'profile', profile_version: 1}}};
    const preview = await call('amcp_workspace', {action: 'catalog_preview', ...input});
    assert.equal(preview.success, true, JSON.stringify(preview));
    assert.deepEqual(preview.data.supplied_products, [source]);
    assert.equal(preview.data.items[0].native_price, '999999999999.000001 SAR');
    assert.equal(preview.data.network_requests, 0);
    const saved = await call('amcp_workspace', {action: 'catalog_plan', ...input});
    assert.equal(saved.success, true, JSON.stringify(saved));
    assert.equal(saved.data.state, 'draft');
    assert.equal(saved.data.source_hash, preview.data.source_hash);
    const full = await call('amcp_campaign', {action: 'get', id: saved.data.id, detail: 'full'});
    assert.equal(full.success, true, JSON.stringify(full));
    assert.deepEqual(full.data.steps[0].arguments, preview.data.plan.steps[0].arguments);
    assert.equal(full.data.steps[0].arguments.payload.products[0].price, '999999999999.000001 SAR');
    assert.equal(full.data.steps[0].status, 'pending');
    assert.equal(f.store.documents(actor.tenantId, 'write_review').length, 0);
    assert.equal(f.calls.length, 0);
    const refused = await call('amcp_workspace', {action: 'catalog_preview', ...input, allow_upsert: false});
    assert.equal(refused.success, false);
    assert.equal(refused.error.code, 'INVALID_X_CATALOG_IMPORT');
    f.store.revokeKey(key);
    assert.equal((await call('amcp_campaign', {action: 'get', id: saved.data.id})).success, false);
    assert.equal(f.calls.length, 0);
    t.diagnostic(
      JSON.stringify({
        tool_calls: calls,
        structured_response_bytes: bytes,
        provider_requests: 0,
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

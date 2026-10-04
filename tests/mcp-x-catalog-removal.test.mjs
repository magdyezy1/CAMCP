import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {xCatalogRemovalFixture} from './fixtures/x-catalog-removal.mjs';

test('real MCP selected removal uses published schemas, an unapproved exact draft and original native review/receipt with revoked-client refusal', async t => {
  const f = xCatalogRemovalFixture(t, {tenant: 'synthetic-x-removal-sdk'}),
    key = f.store.createKey(f.actor),
    actor = f.store.authenticate(key);
  const server = createMcpServer(f.service, actor),
    client = new Client({name: 'Synthetic X removal evaluator', version: '1.0.0'});
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  let calls = 0,
    bytes = 0;
  try {
    const tools = (await client.listTools()).tools;
    const schemas = new Map(
      ['amcp_workspace', 'amcp_campaign'].map(name => [
        name,
        new Ajv({strict: false}).compile(tools.find(t => t.name === name).inputSchema),
      ]),
    );
    const call = async (name, input) => {
      const schema = schemas.get(name);
      assert.equal(schema(input), true, JSON.stringify(schema.errors));
      const reply = await client.callTool({name, arguments: input});
      calls++;
      bytes += Buffer.byteLength(JSON.stringify(reply.structuredContent));
      assert.deepEqual(JSON.parse(reply.content[0].text), JSON.parse(JSON.stringify(reply.structuredContent)));
      assert.equal(reply.isError === true, reply.structuredContent.success === false);
      assert.doesNotMatch(
        JSON.stringify(reply.structuredContent),
        /consumerSecret|tokenSecret|accessToken|authorization_signature|save_nonce/,
      );
      return reply.structuredContent;
    };
    const p = await call('amcp_workspace', {...f.input, retailer_ids: ['sku-1']});
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 1000));
    const save = {
      action: 'create_catalog_removal',
      preview_id: p.data.preview_id,
      preview_hash: p.data.preview_hash,
      confirmed: true,
    };
    const created = await call('amcp_workspace', save);
    assert.equal(created.success, true);
    assert.equal(f.writes(), 0);
    assert.equal(f.store.documents(actor.tenantId, 'write_review').length, 0);
    const reads = f.calls.length,
      repeated = await call('amcp_workspace', save);
    assert.equal(repeated.data.id, created.data.id);
    assert.equal(f.calls.length, reads);
    const full = await call('amcp_campaign', {action: 'get', id: created.data.id, detail: 'full'});
    assert.equal(full.data.state, 'draft');
    assert.equal(full.data.steps.length, 1);
    assert.deepEqual(full.data.steps[0].arguments.payload, {product_keys: ['5000001']});
    const prepared = await call('amcp_campaign', {action: 'prepare_next', id: created.data.id});
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 1000));
    assert.equal(prepared.data.step_id, 'remove-1');
    const executed = await call('amcp_campaign', {...prepared.data.next_call.arguments, spend_change_confirmed: true});
    assert.equal(executed.success, true, JSON.stringify(executed).slice(0, 1000));
    const recovered = await call('amcp_campaign', {action: 'prepare_next', id: created.data.id});
    assert.equal(recovered.success, true);
    assert.equal(f.writes(), 1);
    const stored = f.store.document(actor.tenantId, 'campaign_run', created.data.id);
    assert.equal(stored.steps[0].status, 'verified');
    assert.equal(
      stored.steps[0].review_id,
      prepared.data.review?.review_id ?? prepared.data.next_call.arguments.review_id,
    );
    assert.deepEqual(
      f.items[9001].map(p => p.id),
      ['sku-2', 'sku-3'],
    );
    f.store.revokeKey(key);
    const count = f.calls.length;
    assert.equal((await call('amcp_workspace', save)).success, false);
    assert.equal(f.calls.length, count);
    assert.equal(f.writes(), 1);
    t.diagnostic(
      JSON.stringify({
        tool_calls: calls,
        structured_response_bytes: bytes,
        synthetic_native_gets: f.calls.filter(r => r.method === 'GET').length,
        synthetic_deletes: 1,
        local_drafts: 1,
        external_requests: 0,
      }),
    );
  } finally {
    await client.close();
    await server.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {googleImageUsageFixture} from './fixtures/google-image-usage-data.mjs';

test('real MCP reader discovers complete Google image references with original asset handoff and revoked authority', async t => {
  const f = googleImageUsageFixture(t),
    server = createMcpServer(f.service, f.actor),
    client = new Client({name: 'Synthetic Google image evaluator', version: '1.0.0'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const descriptor = (await client.listTools()).tools.find(x => x.name === 'amcp_media'),
    schema = new Ajv({strict: false}).compile(descriptor.inputSchema);
  assert.match(descriptor.description, /complete Google v25 original-image asset links/);
  assert.equal(schema({action: 'prepare', source_url: 'https://synthetic.invalid/image.png'}), false);
  assert.equal(schema({...f.input, limit: 1000}), true);
  assert.equal(schema({...f.input, limit: 1001}), false);
  let calls = 0,
    bytes = 0;
  const call = async input => {
    assert.equal(schema(input), true, JSON.stringify(schema.errors));
    const out = await client.callTool({name: 'amcp_media', arguments: input});
    calls++;
    bytes += Buffer.byteLength(JSON.stringify(out.structuredContent));
    assert.deepEqual(JSON.parse(out.content[0].text), out.structuredContent);
    assert.equal(out.isError === true, out.structuredContent.success === false);
    assert.doesNotMatch(JSON.stringify(out.structuredContent), /PRIVATE-|accessToken|access_token|source_url/);
    return out.structuredContent;
  };
  const asset = await call({action: 'asset', asset_id: 'asset-143'});
  assert.equal(asset.success, true);
  assert.equal(asset.data.native_usage_kind, 'google_image_links');
  assert.equal(f.requests.length, 0);
  const read = await call({...f.input, limit: 200});
  assert.equal(read.success, true, JSON.stringify(read));
  assert.equal(read.data.rows[0].ad_id, '9007199254740993');
  assert.equal(read.data.selected_limit, 200);
  assert.equal(read.meta.workflow.website_path, '/media?asset_id=asset-143');
  assert.equal(read.meta.workflow.state, 'inspect');
  assert.equal(read.meta.workflow.next_call, undefined);
  assert.equal(read.meta.workflow.automatic_retry_of_mutation, false);
  f.store.revokeKey(f.key);
  assert.equal((await call(f.input)).success, false);
  assert.equal(f.requests.length, 6);
  t.diagnostic(
    JSON.stringify({
      journey: 'google-image-usage',
      tool_calls: calls,
      structured_response_bytes: bytes,
      synthetic_provider_reads: f.requests.length,
      external_provider_requests: 0,
      provider_mutations: 0,
      qualification: 'real SDK; owned in-memory fixture only',
    }),
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/client';
import {createMcpServer} from '../dist/server/mcp.js';
import {metaAssetUsageFixture} from './fixtures/meta-asset-usage-data.mjs';

test('real MCP reader discovers current Meta asset references with schema/text parity and revoked continuation access', async t => {
  const f = metaAssetUsageFixture(t, {allowWrites: false}),
    server = createMcpServer(f.service, f.actor),
    client = new Client({name: 'Synthetic external creative-reference evaluator', version: '1.0.0'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  let calls = 0,
    bytes = 0;
  try {
    const descriptor = (await client.listTools()).tools.find(t => t.name === 'amcp_media'),
      validate = new Ajv({strict: false}).compile(descriptor.inputSchema);
    assert.equal(
      validate({
        action: 'prepare',
        platform: 'meta',
        account_id: '100',
        source_url: 'https://synthetic.invalid/file.png',
      }),
      false,
    );
    const call = async input => {
      assert.equal(validate(input), true, JSON.stringify(validate.errors));
      const out = await client.callTool({name: 'amcp_media', arguments: input});
      calls++;
      bytes += Buffer.byteLength(JSON.stringify(out.structuredContent));
      assert.deepEqual(JSON.parse(out.content[0].text), out.structuredContent);
      assert.equal(out.isError === true, out.structuredContent.success === false);
      assert.doesNotMatch(JSON.stringify(out.structuredContent), /PRIVATE-|accessToken|access_token/);
      return out.structuredContent;
    };
    const first = await call(f.input);
    assert.equal(first.success, true, JSON.stringify(first));
    assert.deepEqual(
      first.data.rows.map(r => r.ad_id),
      ['501'],
    );
    assert.equal(first.meta.workflow.website_path, '/media?asset_id=asset-131');
    assert.equal(first.meta.workflow.state, 'inspect');
    assert.equal(first.meta.workflow.automatic_retry_of_mutation, false);
    assert.equal(first.meta.workflow.next_call.tool, 'amcp_media');
    const second = await call(first.meta.workflow.next_call.arguments);
    assert.equal(second.success, true, JSON.stringify(second));
    assert.equal(second.data.rows[0].ad_id, '9007199254740995');
    assert.equal(second.data.collection.requests, 6);
    assert.equal(second.meta.workflow.next_call, undefined);
    f.store.revokeKey(f.key);
    assert.equal((await call({...f.input, cursor: first.data.next_cursor})).success, false);
    assert.equal(f.requests.length, 6);
    assert.ok(f.requests.every(r => r.method === 'GET'));
    t.diagnostic(
      JSON.stringify({
        tool_calls: calls,
        structured_response_bytes: bytes,
        synthetic_provider_reads: f.requests.length,
        provider_mutations: 0,
      }),
    );
  } finally {
    await client.close();
    await server.close();
  }
});

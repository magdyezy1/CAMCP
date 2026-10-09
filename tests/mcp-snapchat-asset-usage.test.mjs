import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {snapchatAssetUsageFixture, snapUsageIds as ids} from './fixtures/snapchat-asset-usage-data.mjs';
import {fullDescription} from './fixtures/tool-help.mjs';

test('real MCP reader discovers original Snapchat top-snap creative links and exact bounded handoff without write grants', async t => {
  const f = snapchatAssetUsageFixture(t),
    server = createMcpServer(f.service, f.actor),
    client = new Client({name: 'Synthetic original Snapchat creative evaluator', version: '1.0.0'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const descriptor = (await client.listTools()).tools.find(x => x.name === 'amcp_media'),
    schema = new Ajv({strict: false}).compile(descriptor.inputSchema);
  const described = await fullDescription(client, 'amcp_media');
  assert.match(described, /snapchat_top_snap/);
  assert.match(described, /no snapshot or ownership\/write grant/);
  assert.equal(schema({...f.input, reference_view: 'snapchat_top_snap'}), true);
  assert.equal(schema({...f.input, reference_view: 'all'}), false);
  let calls = 0,
    bytes = 0;
  const call = async arguments_ => {
    assert.equal(schema(arguments_), true, JSON.stringify(schema.errors));
    const out = await client.callTool({name: 'amcp_media', arguments: arguments_});
    calls++;
    bytes += Buffer.byteLength(JSON.stringify(out.structuredContent));
    assert.deepEqual(JSON.parse(out.content[0].text), out.structuredContent);
    assert.equal(out.isError === true, out.structuredContent.success === false);
    assert.doesNotMatch(
      JSON.stringify(out.structuredContent),
      /PRIVATE-|accessToken|access_token|source_url|download_link/,
    );
    return out.structuredContent;
  };
  const asset = await call({action: 'asset', asset_id: 'asset-147'});
  assert.equal(asset.success, true);
  assert.deepEqual(asset.data.native_usage_views, ['snapchat_top_snap']);
  assert.equal(f.requests.length, 0);
  const args = {...f.input, limit: 200, reference_view: 'snapchat_top_snap'},
    read = await call(args);
  assert.equal(read.success, true, JSON.stringify(read));
  assert.equal(read.data.rows[0].creative_id, ids.creative);
  assert.equal(read.data.rows[0].ad_id, undefined);
  assert.equal(read.data.rows[0].campaign_id, undefined);
  assert.equal(read.data.provider_mutations, 0);
  assert.equal(read.data.saved_snapshot, false);
  assert.equal(
    read.meta.workflow.website_path,
    '/media?asset_id=asset-147&reference_view=snapchat_top_snap&reference_limit=200',
  );
  assert.equal(read.meta.workflow.next_call, undefined);
  assert.equal(read.meta.workflow.automatic_retry_of_mutation, false);
  const wrongView = await call({...args, reference_view: 'ad_images'});
  assert.equal(wrongView.success, false);
  assert.equal(f.requests.length, 6);
  f.store.revokeKey(f.key);
  assert.equal((await call(args)).success, false);
  assert.equal(f.requests.length, 6);
  t.diagnostic(
    JSON.stringify({
      journey: 'snapchat-top-snap-native-references',
      tool_calls: calls,
      structured_response_bytes: bytes,
      synthetic_provider_reads: f.requests.length,
      external_provider_requests: 0,
      provider_mutations: 0,
      qualification: 'real SDK; owned in-memory fixture only',
    }),
  );
});

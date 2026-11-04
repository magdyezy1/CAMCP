import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/client';
import {createMcpServer} from '../dist/server/mcp.js';
import {googleDeviceInput, googleDeviceFixture} from './fixtures/google-device-evidence-data.mjs';

test('real MCP device discovery, paged capture, retained filtering and revocation preserve scope without effects', async t => {
  const f = googleDeviceFixture(t),
    server = createMcpServer(f.service, f.actor),
    client = new Client({name: 'Synthetic Google device evaluator', version: '1.0.0'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  let calls = 0,
    bytes = 0;
  try {
    const tools = (await client.listTools()).tools,
      validate = new Ajv({strict: false}).compile(tools.find(tool => tool.name === 'amcp_reporting').inputSchema);
    const call = async input => {
      assert.equal(validate(input), true, JSON.stringify(validate.errors));
      const result = await client.callTool({name: 'amcp_reporting', arguments: input});
      calls++;
      bytes += Buffer.byteLength(JSON.stringify(result.structuredContent));
      assert.deepEqual(JSON.parse(result.content[0].text), JSON.parse(JSON.stringify(result.structuredContent)));
      assert.equal(result.isError === true, result.structuredContent.success === false);
      assert.doesNotMatch(JSON.stringify(result.structuredContent), /PRIVATE|synthetic-device-secret/);
      return result.structuredContent;
    };
    const choices = await call({action: 'capture_presets'});
    assert.equal(choices.success, true);
    assert.equal(choices.data.presets.find(p => p.id === googleDeviceInput.preset).grain, 'campaign × device × day');
    const captured = await call(googleDeviceInput);
    assert.equal(captured.success, true, JSON.stringify(captured));
    const original = captured.data;
    assert.equal(original.row_count, 8);
    assert.equal(original.source_pages.length, 2);
    assert.equal(original.collection_usage.requests, 4);
    assert.equal(original.rows[0].spend, '9007199254.740993');
    const filtered = await call({action: 'get', id: original.id, row_query: 'connected_tv', limit: 10});
    assert.equal(filtered.success, true);
    assert.equal(filtered.data.rows.length, 1);
    assert.equal(filtered.data.rows[0].native_device, 'CONNECTED_TV');
    assert.equal(filtered.data.row_count, 8);
    assert.deepEqual(filtered.data.totals, original.totals);
    assert.equal(filtered.data.source_hash, original.source_hash);
    const listed = await call({action: 'list', preset: googleDeviceInput.preset});
    assert.equal(listed.success, true);
    assert.equal(listed.data.reports.length, 1);
    assert.equal(listed.data.reports[0].id, original.id);
    assert.equal(listed.data.reports[0].rows, undefined);
    const complete = await call({action: 'get', id: original.id, limit: 25});
    assert.deepEqual(complete.data.rows, original.rows);
    assert.equal(complete.data.xlsx_path, '/api/reporting-evidence/' + original.id + '.xlsx');
    f.store.revokeKey(f.key);
    assert.equal((await call({action: 'get', id: original.id})).success, false);
    assert.equal(f.requests.length, 4);
    for (const kind of ['write_review', 'campaign_plan'])
      assert.equal(f.store.documents(f.owner.tenantId, kind).length, 0);
    t.diagnostic(
      JSON.stringify({
        tool_calls: calls,
        structured_response_bytes: bytes,
        retained_rows: 8,
        synthetic_native_reads: 4,
        provider_mutations: 0,
        external_requests: 0,
      }),
    );
  } finally {
    await client.close();
    await server.close();
  }
});

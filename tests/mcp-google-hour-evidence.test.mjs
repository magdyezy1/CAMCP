import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {googleHourInput, googleHourFixture} from './fixtures/google-hour-evidence-data.mjs';

test('real MCP hour discovery, paged capture, retained filtering and revocation preserve scope without effects', async t => {
  const f = googleHourFixture(t),
    server = createMcpServer(f.service, f.actor),
    client = new Client({name: 'Synthetic Google hour evaluator', version: '1.0.0'}),
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
      assert.doesNotMatch(JSON.stringify(result.structuredContent), /PRIVATE|synthetic-hour-secret/);
      return result.structuredContent;
    };
    const choices = await call({action: 'capture_presets'});
    assert.equal(choices.success, true);
    assert.equal(choices.data.presets.find(p => p.id === googleHourInput.preset).grain, 'campaign × hour × day');
    const captured = await call(googleHourInput);
    assert.equal(captured.success, true, JSON.stringify(captured));
    const original = captured.data;
    assert.equal(original.row_count, 24);
    assert.equal(original.source_pages.length, 2);
    assert.equal(original.collection_usage.requests, 4);
    assert.equal(original.rows[0].spend, '0');
    const filtered = await call({action: 'get', id: original.id, row_query: '21', limit: 10});
    assert.equal(filtered.success, true);
    assert.equal(filtered.data.rows.length, 1);
    assert.equal(filtered.data.rows[0].native_hour, '21');
    assert.equal(filtered.data.row_count, 24);
    assert.deepEqual(filtered.data.totals, original.totals);
    assert.equal(filtered.data.source_hash, original.source_hash);
    const listed = await call({action: 'list', preset: googleHourInput.preset});
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
        retained_rows: 24,
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

test('real MCP failed hour capture saves nothing and a separate explicit retry retains only complete original evidence', async t => {
  const f = googleHourFixture(t),
    server = createMcpServer(f.service, f.actor),
    client = new Client({name: 'Synthetic Google capture recovery evaluator', version: '1.0.0'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  f.edit((_body, data, count) => {
    if (count !== 2) return data;
    const invalid = structuredClone(data);
    delete invalid.results[0].segments.hour;
    return invalid;
  });
  await Promise.all([server.connect(b), client.connect(a)]);
  let calls = 0,
    bytes = 0;
  const call = async input => {
    const output = await client.callTool({name: 'amcp_reporting', arguments: input});
    calls++;
    bytes += Buffer.byteLength(JSON.stringify(output.structuredContent));
    assert.deepEqual(JSON.parse(output.content[0].text), JSON.parse(JSON.stringify(output.structuredContent)));
    assert.equal(output.isError === true, output.structuredContent.success === false);
    assert.doesNotMatch(JSON.stringify(output.structuredContent), /PRIVATE|synthetic-hour-secret/);
    return output.structuredContent;
  };
  try {
    const failed = await call(googleHourInput);
    assert.equal(failed.success, false);
    assert.equal(failed.error.code, 'REPORT_SHAPE_CHANGED');
    assert.equal(failed.error.message, 'Google did not return the requested native hour/day reporting grain.');
    assert.equal(f.store.documents(f.owner.tenantId, 'decision_report').length, 0);
    assert.equal(f.requests.length, 3);
    const successful = await call(googleHourInput);
    assert.equal(successful.success, true, JSON.stringify(successful));
    assert.equal(f.requests.length, 7);
    assert.equal(f.store.documents(f.owner.tenantId, 'decision_report').length, 1);
    assert.equal(successful.data.row_count, 24);
    assert.equal(successful.data.collection_usage.requests, 4);
    assert.equal(successful.data.rows[0].native_hour, '0');
    assert.equal(successful.data.rows[0].spend, '0');
    const retained = await call({action: 'get', id: successful.data.id, row_query: '21', limit: 10});
    assert.equal(retained.success, true);
    assert.equal(retained.data.rows.length, 1);
    assert.equal(retained.data.rows[0].native_hour, '21');
    assert.deepEqual(retained.data.totals, successful.data.totals);
    assert.equal(f.requests.length, 7);
    assert.equal(f.store.documents(f.owner.tenantId, 'write_review').length, 0);
    assert.equal(f.store.documents(f.owner.tenantId, 'campaign_plan').length, 0);
    t.diagnostic(
      JSON.stringify({
        tool_calls: calls,
        structured_response_bytes: bytes,
        failed_native_reads: 3,
        successful_native_reads: 4,
        retained_rows: 24,
        provider_mutations: 0,
        external_requests: 0,
      }),
    );
  } finally {
    await client.close();
    await server.close();
  }
});

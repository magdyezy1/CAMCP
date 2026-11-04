import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/client';
import {createMcpServer} from '../dist/server/mcp.js';
import {googleCountryInput, googleCountryFixture} from './fixtures/google-country-evidence-data.mjs';

test('actual MCP client discovers, recovers and filters complete country evidence under its original authority', async t => {
  const f = googleCountryFixture(t),
    server = createMcpServer(f.service, f.actor),
    client = new Client({name: 'Synthetic Google country evaluator', version: '1.0.0'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  let calls = 0,
    bytes = 0;
  try {
    const tools = (await client.listTools()).tools,
      validate = new Ajv({strict: false}).compile(tools.find(tool => tool.name === 'amcp_reporting').inputSchema),
      call = async input => {
        assert.equal(validate(input), true, JSON.stringify(validate.errors));
        const result = await client.callTool({name: 'amcp_reporting', arguments: input});
        calls++;
        bytes += Buffer.byteLength(JSON.stringify(result.structuredContent));
        assert.deepEqual(JSON.parse(result.content[0].text), JSON.parse(JSON.stringify(result.structuredContent)));
        assert.equal(result.isError === true, result.structuredContent.success === false);
        assert.doesNotMatch(JSON.stringify(result.structuredContent), /PRIVATE|synthetic-country-secret/);
        return result.structuredContent;
      };
    const choices = await call({action: 'capture_presets'});
    assert.ok(choices.data.presets.some(p => p.id === googleCountryInput.preset));
    f.edit((_body, data, count) => {
      if (count !== 2) return data;
      const changed = structuredClone(data);
      delete changed.results[0].geographicView.locationType;
      return changed;
    });
    const refused = await call(googleCountryInput);
    assert.equal(refused.success, false);
    assert.equal(refused.error.code, 'REPORT_SHAPE_CHANGED');
    assert.equal(f.store.documents(f.owner.tenantId, 'decision_report').length, 0);
    f.edit((_body, data) => data);
    const captured = await call(googleCountryInput);
    assert.equal(captured.success, true, JSON.stringify(captured));
    assert.equal(captured.data.row_count, 8);
    const filtered = await call({action: 'get', id: captured.data.id, row_query: 'AREA_OF_INTEREST'});
    assert.equal(filtered.data.matched_row_count, 2);
    assert.equal(filtered.data.rows[0].native_country_criterion_id, '2222');
    assert.deepEqual(filtered.data.totals, captured.data.totals);
    assert.equal(filtered.data.source_hash, captured.data.source_hash);
    const listed = await call({action: 'list', preset: googleCountryInput.preset});
    assert.equal(listed.data.reports.length, 1);
    assert.equal(listed.data.reports[0].rows, undefined);
    const reads = f.requests.length;
    f.store.revokeKey(f.key);
    assert.equal((await call({action: 'get', id: captured.data.id})).success, false);
    assert.equal(f.requests.length, reads);
    t.diagnostic(
      JSON.stringify({
        tool_calls: calls,
        structured_response_bytes: bytes,
        retained_rows: 8,
        synthetic_native_reads: reads,
        provider_mutations: 0,
        external_requests: 0,
      }),
    );
  } finally {
    await client.close();
    await server.close();
  }
});

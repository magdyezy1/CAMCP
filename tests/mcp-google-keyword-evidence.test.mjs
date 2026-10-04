import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {googleKeywordInput, googleKeywordFixture} from './fixtures/google-keyword-evidence-data.mjs';

test('real MCP failed keyword capture saves nothing and a separate explicit retry retains only complete original evidence', async t => {
  const f = googleKeywordFixture(t),
    server = createMcpServer(f.service, f.actor),
    client = new Client({name: 'Synthetic Google capture recovery evaluator', version: '1.0.0'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  f.edit((_body, data, count) => {
    if (count !== 2) return data;
    const invalid = structuredClone(data);
    invalid.results[0].adGroupCriterion.keyword.matchType = 'UNKNOWN';
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
    assert.doesNotMatch(JSON.stringify(output.structuredContent), /PRIVATE|synthetic-keyword-secret/);
    return output.structuredContent;
  };
  try {
    const failed = await call(googleKeywordInput);
    assert.equal(failed.success, false);
    assert.equal(failed.error.code, 'REPORT_SHAPE_CHANGED');
    assert.equal(
      failed.error.message,
      'Google did not return a bounded positive Search keyword with its native match type.',
    );
    assert.equal(f.store.documents(f.owner.tenantId, 'decision_report').length, 0);
    assert.equal(f.requests.length, 3);
    const successful = await call(googleKeywordInput);
    assert.equal(successful.success, true, JSON.stringify(successful));
    assert.equal(f.requests.length, 7);
    assert.equal(f.store.documents(f.owner.tenantId, 'decision_report').length, 1);
    assert.equal(successful.data.row_count, 4);
    assert.equal(successful.data.collection_usage.requests, 4);
    assert.equal(successful.data.rows[0].keyword_match_type, 'EXACT');
    assert.equal(successful.data.rows[0].spend, '9007199254.740993');
    assert.equal(successful.data.rows[1].conversions, '0');
    assert.equal(successful.data.rows[2].conversions, null);
    const retained = await call({action: 'get', id: successful.data.id, row_query: 'PHRASE', limit: 10});
    assert.equal(retained.success, true);
    assert.equal(retained.data.rows.length, 1);
    assert.equal(retained.data.rows[0].keyword_match_type, 'PHRASE');
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
        retained_rows: 4,
        provider_mutations: 0,
        external_requests: 0,
      }),
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test('real MCP keyword discovery, paged capture, literal retained filters and current revocation preserve native scope without effects', async t => {
  const f = googleKeywordFixture(t),
    server = createMcpServer(f.service, f.actor),
    client = new Client({name: 'Synthetic Google keyword evaluator', version: '1.0.0'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  let calls = 0,
    bytes = 0;
  try {
    const tools = (await client.listTools()).tools,
      validate = new Ajv({strict: false}).compile(tools.find(t => t.name === 'amcp_reporting').inputSchema);
    const call = async input => {
      assert.equal(validate(input), true, JSON.stringify(validate.errors));
      const out = await client.callTool({name: 'amcp_reporting', arguments: input});
      calls++;
      bytes += Buffer.byteLength(JSON.stringify(out.structuredContent));
      assert.deepEqual(JSON.parse(out.content[0].text), JSON.parse(JSON.stringify(out.structuredContent)));
      assert.equal(out.isError === true, out.structuredContent.success === false);
      assert.doesNotMatch(JSON.stringify(out.structuredContent), /PRIVATE|synthetic-keyword-secret/);
      return out.structuredContent;
    };
    const choices = await call({action: 'capture_presets'});
    assert.equal(choices.success, true);
    assert.equal(choices.data.presets.find(p => p.id === 'google_keyword').grain, 'keyword × day');
    const captured = await call(googleKeywordInput);
    assert.equal(captured.success, true, JSON.stringify(captured));
    const original = captured.data;
    assert.equal(original.row_count, 4);
    assert.equal(original.source_pages.length, 2);
    assert.equal(original.collection_usage.requests, 4);
    assert.equal(original.rows[0].spend, '9007199254.740993');
    const filtered = await call({action: 'get', id: original.id, row_query: 'PHRASE', limit: 10});
    assert.equal(filtered.success, true);
    assert.equal(filtered.data.rows.length, 1);
    assert.equal(filtered.data.rows[0].keyword_match_type, 'PHRASE');
    assert.equal(filtered.data.row_count, 4);
    assert.deepEqual(filtered.data.totals, original.totals);
    assert.equal(filtered.data.source_hash, original.source_hash);
    const rows = await call({action: 'get', id: original.id, offset: 0, limit: 25});
    assert.deepEqual(rows.data.rows, original.rows);
    assert.equal(rows.data.xlsx_path, '/api/reporting-evidence/' + original.id + '.xlsx');
    f.store.revokeKey(f.key);
    assert.equal((await call({action: 'get', id: original.id})).success, false);
    assert.equal(f.requests.length, 4);
    assert.equal(f.store.documents(f.owner.tenantId, 'write_review').length, 0);
    assert.equal(f.store.documents(f.owner.tenantId, 'campaign_plan').length, 0);
    t.diagnostic(
      JSON.stringify({
        tool_calls: calls,
        structured_response_bytes: bytes,
        retained_rows: 4,
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

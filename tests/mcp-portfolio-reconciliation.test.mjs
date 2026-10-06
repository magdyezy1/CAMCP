import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {reconciliationFixture, reconciliationInput} from './fixtures/portfolio-reconciliation-data.mjs';

test('a real MCP client receives complete exact inventory comparisons, explicit refusal and a read-only website handoff', async t => {
  const f = reconciliationFixture(t),
    server = createMcpServer(f.service, f.actor),
    client = new Client({name: 'Synthetic inventory comparison evaluator', version: '1.0.0'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  let calls = 0,
    bytes = 0;
  try {
    const descriptor = (await client.listTools()).tools.find(tool => tool.name === 'amcp_workspace'),
      validate = new Ajv({strict: false}).compile(descriptor.inputSchema);
    assert.ok(descriptor.description.includes('portfolio_reconcile'));
    const call = async args => {
      assert.equal(validate(args), true, JSON.stringify(validate.errors));
      const result = await client.callTool({name: 'amcp_workspace', arguments: args}),
        out = result.structuredContent;
      calls++;
      bytes += Buffer.byteLength(JSON.stringify(out));
      assert.deepEqual(JSON.parse(result.content[0].text), JSON.parse(JSON.stringify(out)));
      assert.equal(result.isError === true, out.success === false);
      assert.doesNotMatch(JSON.stringify(result), /UNUSED-PRIVATE|synthetic-reconciliation-secret|synthetic-developer/);
      return out;
    };
    const failed = await call({...reconciliationInput, limit: 2, max_pages: 1});
    assert.equal(failed.success, false);
    assert.equal(failed.error.code, 'PORTFOLIO_RECONCILIATION_INCOMPLETE');
    assert.equal(f.requests.length, 1);
    const success = await call({...reconciliationInput, limit: 2, max_pages: 2, max_entities: 3});
    assert.equal(success.success, true, JSON.stringify(success));
    assert.equal(success.data.observations.length, 2);
    assert.equal(success.data.rows[0].budget_micros, '9007199254740993');
    assert.equal(success.data.coverage.atomic_snapshot, false);
    assert.equal(success.data.coverage.absence_authorizes_delete, false);
    assert.equal(success.meta.workflow.website_path, '/portfolio');
    assert.equal(success.meta.workflow.automatic_retry_of_mutation, false);
    assert.equal(f.requests.length, 5);
    f.store.revokeKey(f.key);
    assert.equal((await call(reconciliationInput)).success, false);
    assert.equal(f.requests.length, 5);
    t.diagnostic(
      JSON.stringify({
        tool_calls: calls,
        structured_response_bytes: bytes,
        synthetic_native_reads: f.requests.length,
        provider_mutations: 0,
        saved_artifacts: 0,
        external_requests: 0,
      }),
    );
  } finally {
    await client.close();
    await server.close();
  }
});

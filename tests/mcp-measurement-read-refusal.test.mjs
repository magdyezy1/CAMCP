import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/client';
import {createMcpServer} from '../dist/server/mcp.js';
import {measurementReadRefusalFixture} from './fixtures/measurement-read-refusal-data.mjs';
for (const kind of ['events', 'identity'])
  test('real MCP ' + kind + ' read preserves the refusal and permits only an explicit bounded recovery', async t => {
    const f = measurementReadRefusalFixture(kind),
      server = createMcpServer(f.service, f.actor),
      client = new Client({name: 'Synthetic measurement read evaluator', version: '1.0.0'}),
      [a, b] = InMemoryTransport.createLinkedPair();
    let calls = 0,
      bytes = 0;
    try {
      await Promise.all([server.connect(b), client.connect(a)]);
      const tools = (await client.listTools()).tools,
        validate = new Ajv({strict: false}).compile(tools.find(x => x.name === 'amcp_workspace').inputSchema);
      assert.equal(f.requests.length, 0, 'Schema discovery performs no provider read');
      const call = async input => {
        assert.equal(validate(input), true, JSON.stringify(validate.errors));
        const result = await client.callTool({name: 'amcp_workspace', arguments: input});
        calls++;
        bytes += Buffer.byteLength(JSON.stringify(result.structuredContent));
        assert.deepEqual(JSON.parse(result.content[0].text), JSON.parse(JSON.stringify(result.structuredContent)));
        assert.equal(result.isError === true, result.structuredContent.success === false);
        assert.doesNotMatch(
          JSON.stringify(result),
          /synthetic-measurement-refusal-secret|PRIVATE-NATIVE|UNUSED-PRIVATE/,
        );
        return result.structuredContent;
      };
      const original = JSON.stringify(f.input),
        failure = await call(f.input);
      assert.equal(failure.success, false);
      assert.equal(failure.error.code, f.code);
      assert.equal(failure.error.message, f.message);
      assert.ok(failure.meta.requestId);
      assert.equal(failure.error.remedy.mutation_retry_safe, false);
      assert.equal(f.requests.length, 1);
      assert.equal(JSON.stringify(f.input), original);
      for (const type of ['decision_report', 'campaign_plan', 'write_review'])
        assert.equal(f.store.documents(f.owner.tenantId, type).length, 0);
      const recovered = await call(f.input);
      assert.equal(recovered.success, true, JSON.stringify(recovered));
      const out = recovered.data;
      assert.equal(out.scope.property_id, '123');
      assert.equal(out.scope.stream_id, '900');
      assert.equal(out.provider_mutations, 0);
      assert.equal(out.retained_snapshot, false);
      for (const check of ['deduplication', 'consent', 'attribution']) assert.equal(out.checks[check], 'unverified');
      if (kind === 'events') {
        assert.equal(f.requests.length, 2);
        assert.equal(out.events[0].reported_count, '9007199254740995');
        assert.equal(out.events[1].reported_count, null);
        assert.deepEqual(
          out.rows.map(row => row.minutes_ago),
          [0, 1],
        );
        assert.equal(out.checks.test_event_identity, 'unverified');
      } else {
        assert.equal(f.requests.length, 4);
        assert.deepEqual(
          f.requests.map(request => request.method),
          ['GET', 'GET', 'POST', 'GET'],
        );
        assert.equal(out.observation.reported_count, '9007199254740993');
        assert.equal(out.observation.declared_expected_count, '1');
        assert.equal(out.observation.comparison, 'above_declared');
        assert.equal(out.period.timezone, 'Asia/Riyadh');
        assert.equal(out.scope.test_id, f.input.requirements.test_id);
        assert.equal(out.checks.test_event_identity, 'matched_in_report');
        assert.equal(out.source_references.length, 3);
      }
      assert.equal(JSON.stringify(f.input), original);
      for (const type of ['decision_report', 'campaign_plan', 'write_review'])
        assert.equal(f.store.documents(f.owner.tenantId, type).length, 0);
      t.diagnostic(
        JSON.stringify({
          kind,
          tool_calls: calls,
          structured_response_bytes: bytes,
          refused_native_reads: 1,
          explicit_recovery_reads: kind === 'identity' ? 3 : 1,
          saved_reports: 0,
          advertising_writes: 0,
          external_provider_requests: 0,
        }),
      );
    } finally {
      await client.close();
      await server.close();
      f.close();
    }
  });

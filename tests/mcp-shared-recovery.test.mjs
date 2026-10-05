import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {measurementReadRefusalFixture} from './fixtures/measurement-read-refusal-data.mjs';
for (const kind of ['events', 'identity'])
  test(
    'real MCP ' + kind + ' 403 preserves provider denial and requires an explicit original-scope reread',
    async t => {
      const f = measurementReadRefusalFixture(kind, {permissionDenied: true}),
        server = createMcpServer(f.service, f.actor),
        client = new Client({name: 'Synthetic native denial evaluator', version: '1.0.0'}),
        [a, b] = InMemoryTransport.createLinkedPair();
      try {
        await Promise.all([server.connect(b), client.connect(a)]);
        const tools = (await client.listTools()).tools,
          validate = new Ajv({strict: false}).compile(tools.find(tool => tool.name === 'amcp_workspace').inputSchema);
        assert.equal(validate(f.input), true, JSON.stringify(validate.errors));
        const original = JSON.stringify(f.input),
          call = async () => {
            const result = await client.callTool({name: 'amcp_workspace', arguments: f.input});
            assert.deepEqual(JSON.parse(result.content[0].text), JSON.parse(JSON.stringify(result.structuredContent)));
            assert.equal(result.isError === true, result.structuredContent.success === false);
            assert.doesNotMatch(
              JSON.stringify(result),
              /synthetic-measurement-refusal-secret|PRIVATE-NATIVE|UNUSED-PRIVATE/,
            );
            return result.structuredContent;
          };
        const denied = await call();
        assert.equal(denied.success, false);
        assert.equal(denied.error.code, 'PROVIDER_ACCESS_DENIED');
        assert.equal(denied.error.message, 'Platform returned HTTP 403');
        assert.equal(denied.error.retryable, false);
        assert.equal(denied.error.category, 'provider');
        assert.equal(denied.error.remedy.owner, 'provider_or_account_admin');
        assert.equal(denied.error.remedy.mutation_retry_safe, false);
        assert.equal(
          denied.error.next_action,
          'The provider denied access. Check its error details and request ID; a 403 alone does not identify a missing OAuth scope.',
        );
        assert.ok(denied.meta.requestId);
        assert.equal(f.requests.length, 1);
        assert.equal(JSON.stringify(f.input), original);
        const recovered = await call();
        assert.equal(recovered.success, true, JSON.stringify(recovered));
        assert.equal(f.requests.length, kind === 'identity' ? 4 : 2);
        assert.equal(recovered.data.scope.property_id, '123');
        assert.equal(recovered.data.scope.stream_id, '900');
        assert.equal(recovered.data.provider_mutations, 0);
        assert.equal(recovered.data.retained_snapshot, false);
        for (const check of ['consent', 'deduplication', 'attribution'])
          assert.equal(recovered.data.checks[check], 'unverified');
        assert.equal(
          kind === 'identity' ? recovered.data.observation.reported_count : recovered.data.events[0].reported_count,
          kind === 'identity' ? '9007199254740993' : '9007199254740995',
        );
        assert.equal(JSON.stringify(f.input), original);
        for (const type of ['decision_report', 'campaign_plan', 'write_review'])
          assert.equal(f.store.documents(f.owner.tenantId, type).length, 0);
        t.diagnostic(
          JSON.stringify({
            kind,
            original_code: denied.error.code,
            refused_native_reads: 1,
            explicit_recovery_reads: kind === 'identity' ? 3 : 1,
            automatic_retries: 0,
            advertising_writes: 0,
            external_provider_requests: 0,
          }),
        );
      } finally {
        await client.close();
        await server.close();
        f.close();
      }
    },
  );

import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/client';
import {createMcpServer} from '../dist/server/mcp.js';
import {workspaceFormRefusalFixture} from './fixtures/workspace-form-refusal-data.mjs';
for (const kind of ['gtm', 'conversions'])
  test('real MCP ' + kind + ' form read retains native denial and requires an explicit scoped recovery', async t => {
    const f = workspaceFormRefusalFixture(kind),
      server = createMcpServer(f.service, f.actor),
      client = new Client({name: 'Synthetic workspace form evaluator', version: '1.0.0'}),
      [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(b), client.connect(a)]);
      const tools = (await client.listTools()).tools,
        validate = new Ajv({strict: false}).compile(tools.find(tool => tool.name === 'amcp_workspace').inputSchema),
        original = JSON.stringify(f.input);
      assert.equal(validate(f.input), true, JSON.stringify(validate.errors));
      const call = async () => {
        const result = await client.callTool({name: 'amcp_workspace', arguments: f.input});
        assert.deepEqual(JSON.parse(result.content[0].text), JSON.parse(JSON.stringify(result.structuredContent)));
        assert.equal(result.isError === true, result.structuredContent.success === false);
        assert.doesNotMatch(JSON.stringify(result), /synthetic-workspace-form-read-secret|PRIVATE-NATIVE-/);
        return result.structuredContent;
      };
      const denied = await call();
      assert.equal(denied.success, false);
      assert.equal(denied.error.code, f.code);
      assert.equal(denied.error.message, f.message);
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
      assert.equal(f.requests.length, kind === 'gtm' ? 3 : 4);
      assert.equal(recovered.data.scope.account_id, f.input.account_id);
      assert.equal(recovered.data.scope.connection_id, f.connectionId);
      assert.equal(recovered.data.advertising_writes, 0);
      if (kind === 'gtm') {
        assert.equal(recovered.data.record_kind, 'measurement_audit');
        assert.equal(recovered.data.configuration.network_requests, 2);
        assert.equal(recovered.data.configuration.containers[1].container_id, '9007199254740993');
        assert.equal(recovered.data.configuration.publish_ready, null);
        assert.equal(recovered.data.event_delivery, 'not_measured');
      } else {
        assert.equal(recovered.data.record_kind, 'conversion_rules');
        assert.equal(recovered.data.retained_snapshot, false);
        const rule = recovered.data.rules[0];
        assert.equal(rule.id, '9007199254740993');
        assert.equal(rule.value.amount, '9007199254740993.123456789');
        assert.equal(rule.value.currency, 'USD');
        assert.equal(rule.post_click_days, 30);
        assert.equal(rule.post_view_days, 7);
        for (const check of ['event_delivery', 'deduplication', 'consent', 'historical_attribution'])
          assert.equal(recovered.data.checks[check], 'unverified');
        assert.equal(recovered.data.checks.campaign_membership, 'not_collected');
      }
      assert.equal(JSON.stringify(f.input), original);
      for (const type of ['decision_report', 'campaign_plan', 'write_review', 'conversion_rules'])
        assert.equal(f.store.documents(f.owner.tenantId, type).length, 0);
      t.diagnostic(
        JSON.stringify({
          kind,
          original_code: denied.error.code,
          failed_native_reads: 1,
          explicit_recovery_reads: kind === 'gtm' ? 2 : 3,
          automatic_retries: 0,
          provider_mutations: 0,
          external_provider_requests: 0,
        }),
      );
    } finally {
      await client.close();
      await server.close();
      f.close();
    }
  });

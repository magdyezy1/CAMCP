import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/client';
import {createMcpServer} from '../dist/server/mcp.js';
import {
  conversionMetadataFixture,
  conversionMetadataRequest,
  conversionMetadataId,
  conversionMetadataAmount,
} from './fixtures/linkedin-conversion-metadata-data.mjs';
for (const scenario of ['owned', 'unknown', 'invalid'])
  test(
    'real MCP ' + scenario + ' conversion metadata retains schema/text parity and exact read-only scope',
    async t => {
      const f = conversionMetadataFixture(scenario),
        server = createMcpServer(f.service, f.actor),
        client = new Client({name: 'Synthetic conversion metadata evaluator', version: '1.0.0'}),
        [a, b] = InMemoryTransport.createLinkedPair(),
        original = JSON.stringify(f.input);
      try {
        await Promise.all([server.connect(b), client.connect(a)]);
        const tool = (await client.listTools()).tools.find(tool => tool.name === 'amcp_workspace'),
          validate = new Ajv({strict: false}).compile(tool.inputSchema);
        assert.equal(validate(f.input), true, JSON.stringify(validate.errors));
        const result = await client.callTool({name: 'amcp_workspace', arguments: f.input}),
          response = result.structuredContent;
        assert.deepEqual(JSON.parse(result.content[0].text), JSON.parse(JSON.stringify(response)));
        assert.equal(result.isError === true, response.success === false);
        assert.equal(JSON.stringify(f.input), original);
        assert.doesNotMatch(JSON.stringify(result), /PRIVATE-NATIVE-METADATA-|synthetic-conversion-metadata-secret/);
        if (scenario === 'invalid') {
          assert.equal(response.success, false);
          assert.equal(response.error.code, 'MEASUREMENT_EVIDENCE_INVALID');
          assert.equal(response.error.message, 'LinkedIn returned an invalid conversion label or setting.');
          assert.equal(response.error.remedy.mutation_retry_safe, false);
          assert.equal(response.data, undefined);
          assert.equal(f.requests.length, 2);
        } else {
          assert.equal(response.success, true, JSON.stringify(response));
          const out = response.data;
          assert.deepEqual(out.collection_request, conversionMetadataRequest);
          assert.equal(out.scope.connection_id, f.connectionId);
          assert.equal(out.scope.account_id, '100');
          assert.equal(out.rules[0].id, conversionMetadataId);
          assert.equal(out.rules[0].value.amount, conversionMetadataAmount);
          assert.equal(out.rules[0].value.currency, 'USD');
          assert.equal(out.retained_snapshot, false);
          assert.equal(out.advertising_writes, 0);
          for (const check of ['event_delivery', 'deduplication', 'consent', 'historical_attribution'])
            assert.equal(out.checks[check], 'unverified');
          assert.equal(out.checks.campaign_membership, 'not_collected');
          assert.equal(out.rules[0].conversion_method, scenario === 'owned' ? 'CONVERSIONS_API' : null);
          assert.equal(out.rules[0].ownership_type, scenario === 'owned' ? 'OWNED' : null);
          if (scenario === 'unknown') {
            assert.equal(out.rules[1].conversion_method, 'FUTURE_METHOD_<img>');
            assert.equal(out.rules[1].ownership_type, 'FUTURE_OWNERSHIP_<img>');
            assert.equal(out.rules[2].ownership_type, 'SHARED');
            assert.equal(out.collection_request.shared_rules_requested, false);
          }
          assert.equal(f.requests.length, 3);
        }
        for (const type of ['decision_report', 'conversion_rules', 'campaign_plan', 'write_review'])
          assert.equal(f.store.documents(f.owner.tenantId, type).length, 0);
        t.diagnostic(
          JSON.stringify({
            scenario,
            native_reads: f.requests.length,
            provider_mutations: 0,
            external_provider_requests: 0,
            shared_rules_requested: false,
          }),
        );
      } finally {
        await client.close();
        await server.close();
        f.close();
      }
    },
  );

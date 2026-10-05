import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {providerCaptureRefusalFixture, providerRefusalMessages} from './fixtures/provider-capture-refusal-data.mjs';
for (const provider of Object.keys(providerRefusalMessages))
  test(
    'real MCP ' +
      provider +
      ' capture refuses the foreign account after one native read without saving evidence or effects',
    async t => {
      const f = providerCaptureRefusalFixture(provider),
        server = createMcpServer(f.service, f.actor),
        client = new Client({name: 'Synthetic provider refusal evaluator', version: '1.0.0'}),
        [a, b] = InMemoryTransport.createLinkedPair();
      let calls = 0,
        bytes = 0;
      try {
        await Promise.all([server.connect(b), client.connect(a)]);
        const tools = (await client.listTools()).tools,
          validate = new Ajv({strict: false}).compile(tools.find(x => x.name === 'amcp_reporting').inputSchema);
        const call = async input => {
          assert.equal(validate(input), true, JSON.stringify(validate.errors));
          const result = await client.callTool({name: 'amcp_reporting', arguments: input});
          calls++;
          bytes += Buffer.byteLength(JSON.stringify(result.structuredContent));
          assert.deepEqual(JSON.parse(result.content[0].text), JSON.parse(JSON.stringify(result.structuredContent)));
          assert.equal(result.isError === true, result.structuredContent.success === false);
          assert.doesNotMatch(JSON.stringify(result), /synthetic-refusal-secret/);
          return result.structuredContent;
        };
        const choices = await call({action: 'capture_presets'});
        assert.equal(choices.success, true);
        assert.ok(choices.data.presets.some(x => x.id === f.input.preset));
        assert.equal(f.requests.length, 0);
        const before = JSON.stringify(f.input),
          failure = await call(f.input);
        assert.equal(failure.success, false);
        assert.equal(failure.error.code, 'REPORT_ACCOUNT_MISMATCH');
        assert.equal(failure.error.message, providerRefusalMessages[provider]);
        assert.equal(typeof failure.meta.requestId, 'string');
        assert.ok(failure.meta.requestId.length);
        assert.equal(failure.error.remedy.mutation_retry_safe, false);
        assert.equal(f.requests.length, 1);
        assert.equal(f.requests[0].method, 'GET');
        assert.equal(JSON.stringify(f.input), before);
        const listed = await call({action: 'list'});
        assert.equal(listed.success, true);
        assert.equal(listed.data.reports.length, 0);
        assert.equal(f.requests.length, 1);
        for (const kind of ['decision_report', 'campaign_plan', 'write_review'])
          assert.equal(f.store.documents(f.owner.tenantId, kind).length, 0);
        t.diagnostic(
          JSON.stringify({
            provider,
            tool_calls: calls,
            structured_response_bytes: bytes,
            synthetic_native_reads: 1,
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
    },
  );

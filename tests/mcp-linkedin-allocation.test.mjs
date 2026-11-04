import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/client';
import {createMcpServer} from '../dist/server/mcp.js';
import {linkedinAllocationFixture, linkedinAllocationIds} from './fixtures/linkedin-allocation-data.mjs';
test('real MCP client captures LinkedIn campaign evidence, models and saves source-bound decimal budgets without provider mutations', async t => {
  const f = linkedinAllocationFixture(t),
    server = createMcpServer(f.service, f.actor),
    client = new Client({name: 'Synthetic LinkedIn allocation evaluator', version: '1.0.0'});
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  let calls = 0,
    bytes = 0;
  try {
    const tools = (await client.listTools()).tools,
      ajv = new Ajv({strict: false}),
      schemas = new Map(tools.filter(t => t.name.startsWith('amcp_')).map(t => [t.name, ajv.compile(t.inputSchema)]));
    const call = async (name, args) => {
      const valid = schemas.get(name);
      assert.equal(valid(args), true, JSON.stringify(valid.errors));
      const out = await client.callTool({name, arguments: args});
      calls++;
      bytes += Buffer.byteLength(JSON.stringify(out.structuredContent));
      assert.deepEqual(JSON.parse(out.content[0].text), out.structuredContent);
      assert.equal(out.isError === true, out.structuredContent.success === false);
      return out.structuredContent;
    };
    const ok = out => {
        assert.equal(out.success, true, JSON.stringify(out));
        return out.data;
      },
      report = ok(await call('amcp_reporting', f.capture)),
      candidates = ok(
        await call('amcp_reporting', {action: 'allocation_candidates', id: report.id, offset: 0, limit: 10}),
      );
    assert.deepEqual(
      candidates.candidates.map(c => c.entity_id),
      linkedinAllocationIds.map(id => 'urn:li:sponsoredCampaign:' + id),
    );
    const model = ok(await call('amcp_reporting', {action: 'allocation', id: report.id, options: f.options})),
      args = {action: 'preview_allocation_plan', id: report.id, options: f.options, conversion: 'equal_daily'},
      p = ok(await call('amcp_reporting', args));
    assert.equal(p.model_fingerprint, model.model_fingerprint);
    assert.deepEqual(
      p.targets.map(t => t.daily_budget),
      ['90', '30'],
    );
    const saved = ok(
        await call('amcp_reporting', {
          action: 'create_allocation_plan',
          id: report.id,
          preview_id: p.preview_id,
          preview_hash: p.preview_hash,
          confirmed: true,
        }),
      ),
      detail = ok(await call('amcp_campaign', {action: 'get', id: saved.id}));
    assert.equal(detail.state, 'draft');
    assert.equal(detail.allocation.report_id, report.id);
    assert.doesNotMatch(JSON.stringify(p), /accessToken|authorization_signature/);
    f.store.revokeKey(f.key);
    assert.equal((await call('amcp_reporting', args)).success, false);
    assert.equal(f.requests.length, 19);
    assert.ok(f.requests.every(r => r.method === 'GET'));
    t.diagnostic(
      JSON.stringify({
        tool_calls: calls,
        structured_response_bytes: bytes,
        synthetic_provider_reads: f.requests.length,
        provider_mutations: 0,
      }),
    );
  } finally {
    await client.close();
    await server.close();
  }
});

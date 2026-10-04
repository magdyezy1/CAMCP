import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {allocationCalibrationFixture, calibrationNow, calibrationIds} from './fixtures/allocation-calibration-data.mjs';

test('real MCP reader diagnoses historical assumptions and models an explicit proposal with schema/text parity and no automatic mutation', async t => {
  t.mock.method(Date, 'now', () => calibrationNow);
  const f = allocationCalibrationFixture(t),
    server = createMcpServer(f.service, f.actor),
    client = new Client({name: 'Synthetic historical allocation evaluator', version: '1.0.0'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  let calls = 0,
    bytes = 0;
  try {
    const descriptor = (await client.listTools()).tools.find(tool => tool.name === 'amcp_reporting'),
      validate = new Ajv({strict: false}).compile(descriptor.inputSchema);
    const call = async input => {
      assert.equal(validate(input), true, JSON.stringify(validate.errors));
      const out = await client.callTool({name: 'amcp_reporting', arguments: input});
      calls++;
      bytes += Buffer.byteLength(JSON.stringify(out.structuredContent));
      assert.deepEqual(JSON.parse(out.content[0].text), out.structuredContent);
      assert.equal(out.isError === true, out.structuredContent.success === false);
      assert.doesNotMatch(JSON.stringify(out.structuredContent), /PRIVATE-CALIBRATION|"source_request"|accessToken/);
      return out.structuredContent;
    };
    const calibrated = await call(f.input);
    assert.equal(calibrated.success, true, JSON.stringify(calibrated));
    assert.equal(calibrated.meta.workflow.website_path, '/reports?id=calibration-report');
    assert.equal(calibrated.meta.workflow.state, 'inspect');
    assert.equal(calibrated.meta.workflow.automatic_retry_of_mutation, false);
    assert.equal(calibrated.meta.workflow.next_call, undefined, 'Applying factors is an explicit separate choice');
    const factors = calibrated.data.factor_envelope;
    const model = await call({
      action: 'allocation',
      id: f.input.id,
      options: {
        budget: '300',
        allocations: calibrationIds.map(entity_id => ({entity_id, minimum: '0', maximum: '220'})),
        efficiency_low: Number(factors.efficiency_low),
        efficiency_high: Number(factors.efficiency_high),
        minimum_conversions: 10,
        maximum_age_days: 7,
      },
    });
    assert.equal(model.success, true, JSON.stringify(model));
    assert.equal(model.data.proposal_type, 'illustrative_allocation');
    assert.match(model.data.limitations.join(' '), /not a forecast/);
    assert.equal(f.store.documents(f.actor.tenantId, 'campaign_plan').length, 0);
    f.store.revokeKey(f.key);
    assert.equal((await call(f.input)).success, false);
    assert.equal(f.nativeCalls(), 0);
    t.diagnostic(
      JSON.stringify({
        tool_calls: calls,
        structured_response_bytes: bytes,
        synthetic_provider_reads: 0,
        provider_mutations: 0,
      }),
    );
  } finally {
    await client.close();
    await server.close();
  }
});

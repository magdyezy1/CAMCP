import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {conditionalProgramFixture} from './fixtures/conditional-program-data.mjs';

test('real MCP clients discover and inspect conditional programs with schema/text parity and preserved account links', async t => {
  const f = conditionalProgramFixture(),
    clients = [],
    servers = [];
  const otherKey = f.store.createKey({tenantId: 'other-program-tenant', userId: 'other', role: 'reader'});
  let calls = 0,
    bytes = 0;
  try {
    for (const actor of [f.actor, f.store.authenticate(otherKey)]) {
      const client = new Client({name: 'Synthetic conditional-program evaluator', version: '1.0.0'}),
        server = createMcpServer(f.service, actor),
        [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(b), client.connect(a)]);
      clients.push(client);
      servers.push(server);
    }
    const listed = (await clients[0].listTools()).tools,
      tool = listed.find(t => t.name === 'amcp_workspace'),
      ajv = new Ajv({strict: false}),
      validate = addFormats(ajv).compile(tool.inputSchema);
    assert.ok(tool.inputSchema.properties.action.enum.includes('program_check'));
    for (const target of ['linkedin_rest_media_planning_post', 'linkedin_rest_targeting_audience_insights_post']) {
      const native = listed.find(t => t.name === 'linkedin_native_action'),
        validateDescription = ajv.compile(native.inputSchema),
        args = {action: 'DESCRIBE_ACTION', target_action: target};
      assert.equal(validateDescription(args), true, JSON.stringify(validateDescription.errors));
      const described = await clients[0].callTool({name: native.name, arguments: args}),
        out = described.structuredContent;
      assert.deepEqual(JSON.parse(described.content[0].text), out);
      assert.equal(out.success, true);
      assert.equal(out.data.read_only, false, 'Captured method flags remain unchanged');
      assert.equal(out.data.amcp_conditional_program.native_contract_status, 'native_read');
      assert.equal(out.data.amcp_conditional_program.entitlement, 'unverified');
      assert.equal(out.data.amcp_conditional_program.next_call.arguments.action, 'capabilities');
      const help = await clients[0].callTool({
        name: 'amcp_tool_help',
        arguments: {gateway: native.name, operation: target},
      });
      // Since PRV-02 the LinkedIn operation help is the versioned catalog record of that operation (as for Google and
      // Meta), not the generic tool help, so the program description sits beside the record.
      // Since MCP-05 every help result has one {success, data, meta} envelope, with the record under data.
      assert.equal(help.structuredContent.success, true);
      assert.equal(help.structuredContent.data.name, target);
      assert.match(help.structuredContent.data.api_version, /^\d{6}$/);
      assert.deepEqual(help.structuredContent.data.amcp_conditional_program, out.data.amcp_conditional_program);
      assert.deepEqual(JSON.parse(help.content[0].text), help.structuredContent);
      calls++;
      bytes += Buffer.byteLength(JSON.stringify(out));
      calls++;
      bytes += Buffer.byteLength(JSON.stringify(help.structuredContent));
    }
    assert.equal(f.calls.length, 0);
    const call = async (client, args) => {
      assert.equal(validate(args), true, JSON.stringify(validate.errors));
      const r = await client.callTool({name: 'amcp_workspace', arguments: args});
      calls++;
      bytes += Buffer.byteLength(JSON.stringify(r.structuredContent));
      assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
      assert.equal(r.isError === true, r.structuredContent.success === false);
      return r.structuredContent;
    };
    const graph = await call(clients[0], {action: 'capabilities', workflow_id: 'program:linkedin_forecast'});
    assert.equal(graph.success, true);
    const next = graph.data.workflows[0].accounts[0].next_call;
    const local = await call(clients[0], next.arguments);
    assert.equal(local.data.state, 'unverified');
    assert.equal(f.calls.length, 0);
    const foreign = await call(clients[1], f.input());
    assert.equal(foreign.success, false);
    assert.equal(f.calls.length, 0);
    const observed = await call(clients[0], f.input());
    assert.equal(observed.success, true);
    assert.equal(observed.data.state, 'observed');
    assert.equal(observed.meta.workflow.entitlement, 'unverified');
    assert.equal(observed.meta.workflow.automatic_retry_of_mutation, false);
    assert.equal(observed.meta.workflow.website_path, observed.data.website_path);
    assert.equal(f.calls.length, 1);
    f.store.revokeKey(f.key);
    assert.equal((await call(clients[0], f.input())).success, false);
    assert.equal(f.calls.length, 1);
    t.diagnostic(
      JSON.stringify({
        tool_calls: calls,
        structured_response_bytes: bytes,
        synthetic_native_reads: f.calls.length,
        provider_mutations: 0,
      }),
    );
  } finally {
    for (const c of clients) await c.close();
    for (const s of servers) await s.close();
    f.close();
  }
});

/**
 * What a new assistant does with only the live:false answer (CON-04): start from its next_call, fill every required
 * path from requirements_template (a const, the first enum value, the documented example, the minimum, and dates the
 * description asks for) and send it. Before CON-04 the answer had a flat input list and no shape, and a valid request
 * had to be copied from AMCP's own test fixtures.
 */
function fill(schema, today) {
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.examples) return structuredClone(schema.examples[0]);
  if (schema.type === 'integer') return schema.minimum ?? 1;
  if (schema.type === 'boolean') return false;
  if (schema.type === 'object' && schema.properties?.year) {
    const offset = /on or after startDateOn/.test(schema.description ?? '') ? 20 : 2,
      d = new Date(today + offset * 86400000);
    return {year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate()};
  }
  return Object.fromEntries((schema.required ?? []).map(key => [key, fill(schema.properties[key], today)]));
}
test('a new MCP assistant builds a valid live program_check from the live:false answer alone', async () => {
  const f = conditionalProgramFixture(),
    client = new Client({name: 'Synthetic new assistant', version: '1.0.0'}),
    server = createMcpServer(f.service, f.actor),
    [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(b), client.connect(a)]);
    const tool = (await client.listTools()).tools.find(t => t.name === 'amcp_workspace'),
      ajv = new Ajv({strict: false}),
      validateCall = addFormats(ajv).compile(tool.inputSchema);
    const call = async args => {
      assert.equal(validateCall(args), true, JSON.stringify(validateCall.errors));
      return (await client.callTool({name: 'amcp_workspace', arguments: args})).structuredContent;
    };
    for (const workflow of [
      'program:linkedin_forecast',
      'program:linkedin_audience_insights',
      'program:dv360_advertiser',
    ]) {
      const graph = await call({action: 'capabilities', workflow_id: workflow}),
        local = await call(graph.data.workflows[0].accounts[0].next_call.arguments);
      assert.equal(local.data.state, 'unverified');
      const args = structuredClone(local.data.next_call.arguments);
      args.requirements ??= fill(local.data.requirements_template, Date.now());
      for (const path of local.data.required_inputs)
        assert.notEqual(
          path.split('.').reduce((v, k) => v?.[k], args),
          undefined,
          workflow + ' fills ' + path,
        );
      assert.equal(ajv.compile(local.data.requirements_template)(args.requirements), true, workflow);
      const live = await call(args);
      assert.equal(live.success, true, JSON.stringify(live));
      assert.equal(live.data.state, 'observed', workflow);
      assert.equal(live.data.entitlement, 'unverified');
    }
    assert.equal(f.calls.length, 3);
  } finally {
    await client.close();
    await server.close();
    f.close();
  }
});

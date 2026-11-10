// V2-MCP-02 (decision 8, Probe 19): a client that works today keeps working. The recording of the SDK 1.32.1 client
// (tests/fixtures/mcp-sdk-1.32.1-exchange.json, replayed over HTTP by tests/mcp-sdk-v1-exchange.test.mjs) is replayed here
// through the schemas the tools list now, which the typed reporting contract changed: every tool call that client sent
// must validate against the input schema its tool lists today, and every result it was given must validate against the
// output schema. The 1.x clients validate results when the tool declares an output schema, so a result the schema refuses
// is a result they would throw away.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Ajv from 'ajv';
import {Client, InMemoryTransport} from '@modelcontextprotocol/client';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {createMcpServer, toolOutputSchema} from '../dist/server/mcp.js';

const exchange = JSON.parse(fs.readFileSync('tests/fixtures/mcp-sdk-1.32.1-exchange.json', 'utf8'));
/** The tool calls of the recording, with the answers they were given. */
const calls = exchange.steps
  .filter(step => step.request.path === '/mcp' && step.request.body)
  .map(step => ({label: step.label, request: JSON.parse(step.request.body), response: step.response.body}))
  .filter(({request}) => request.method === 'tools/call');

/**
 * The tools a deployment lists to its caller. The exchange was recorded against a read-only deployment, the default
 * configuration, with a reader's key; writes lists the same server with reviewed writes enabled, for an operator.
 */
async function listing(t, {writes = false} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 96).toString('base64')),
    service = writes
      ? new MirrorService(new Registry(), store, undefined, undefined, {
          allowWrites: true,
          requireBeforeState: true,
          maxBudgetChange: 0,
        })
      : new MirrorService(new Registry(), store),
    actor = {tenantId: 'local', userId: 'exchange-reader', role: writes ? 'operator' : 'reader'},
    server = createMcpServer(service, actor),
    client = new Client({name: 'Synthetic replay client', version: '1'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  t.after(async () => {
    await client.close();
    await server.close();
    store.close();
  });
  return new Map((await client.listTools()).tools.map(tool => [tool.name, tool]));
}

test('the recording holds the tool calls the replay stands on: a read, a refused write, an unknown tool', () => {
  assert.deepEqual([...new Set(calls.map(({request}) => request.params.name))].sort(), [
    'amcp_tool_help',
    'amcp_write',
    'no_such_tool',
  ]);
  assert.ok(calls.length >= 5);
  assert.ok(calls.every(({response}) => response.result.structuredContent !== undefined));
});

test('every tool call the SDK 1.32.1 client sent validates against the input schema its tool lists today', async t => {
  const ajv = new Ajv({strict: false}),
    refused = [],
    check = (tools, label, request) => {
      const valid = ajv.compile(tools.get(request.params.name).inputSchema);
      return {ok: valid(request.params.arguments ?? {}), errors: JSON.stringify(valid.errors), label};
    };
  // The deployment it was recorded against: every call of a listed tool validates but one. The read-only listing offers
  // amcp_write inspect only, so the write the client tried is not in its schema, and the tool refused it by name when it
  // was recorded, as it still does; the schema was this narrow when it was recorded.
  const readOnly = await listing(t);
  let validated = 0;
  for (const {label, request, response} of calls) {
    if (!readOnly.has(request.params.name)) continue;
    const {ok, errors} = check(readOnly, label, request);
    if (ok) validated++;
    else
      refused.push([
        request.params.name,
        request.params.arguments.action,
        response.result.structuredContent.error.code,
        errors,
      ]);
  }
  assert.ok(validated >= 3, 'the calls of the tool the recording reads validate');
  assert.equal(refused.length, 1, JSON.stringify(refused));
  assert.deepEqual(refused[0].slice(0, 3), ['amcp_write', 'prepare', 'LIVE_WRITES_DISABLED']);
  // The same server with reviewed writes enabled lists the tool with the action, and every call of the recording validates.
  const writes = await listing(t, {writes: true});
  let all = 0;
  for (const {label, request} of calls) {
    if (!writes.has(request.params.name)) continue;
    const {ok, errors} = check(writes, label, request);
    assert.equal(ok, true, label + ' ' + request.params.name + ': ' + errors);
    all++;
  }
  assert.equal(all, validated + 1);
  // The check is not vacuous: an argument the schema does not allow is refused.
  const help = ajv.compile(readOnly.get('amcp_tool_help').inputSchema);
  assert.equal(help({topic: 7}), false);
});

test('every result the SDK 1.32.1 client was given validates against the output schema its tool lists today', async t => {
  const tools = await listing(t),
    ajv = new Ajv({strict: false});
  let validated = 0;
  for (const {label, request, response} of calls) {
    // A tool the server does not have is answered by the envelope every tool shares.
    const schema = tools.get(request.params.name)?.outputSchema ?? toolOutputSchema(request.params.name),
      valid = ajv.compile(schema),
      result = response.result;
    assert.equal(
      valid(result.structuredContent),
      true,
      label + ' ' + request.params.name + ': ' + JSON.stringify(valid.errors),
    );
    // The text content is the same envelope, as the 1.x clients of this era read it.
    assert.equal(result.content[0].type, 'text');
    validated++;
  }
  assert.equal(validated, calls.length);
  const refusal = calls.find(({response}) => response.result.isError === true);
  assert.ok(refusal, 'a refusal is among them');
  assert.equal(refusal.response.result.structuredContent.success, false);
  assert.equal(typeof refusal.response.result.structuredContent.error.code, 'string');
});

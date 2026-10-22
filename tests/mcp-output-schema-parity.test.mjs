import test from 'node:test';
import assert from 'node:assert/strict';
import {Ajv} from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

// MCP-07 (wave 4b MCP quality pass; mcp-builder guidance: define outputSchema and return structuredContent with the
// equivalent text; report tool errors inside results with actionable next steps). The outcome schema was checked for
// the AMCP tools only. Here a real MCP SDK client, which validates structuredContent against each listed outputSchema
// and throws on a mismatch, calls every tool of both deployment modes with a successful call and a refused one: the
// text block is the same JSON, isError is set exactly when success is false, and every refusal names its code,
// category, remedy, next action and request ID.
const key = Buffer.alloc(32, 89).toString('base64'),
  actor = {tenantId: 'output-parity', userId: 'operator', role: 'operator'};
async function connected(t, allowWrites) {
  const store = new Store(':memory:', key);
  store.ensureTenant(actor.tenantId);
  const requests = [],
    service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(async url => {
        requests.push(String(url));
        throw Error('No provider request is expected');
      }),
      undefined,
      allowWrites ? {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true} : undefined,
    ),
    server = createMcpServer(service, actor),
    client = new Client({name: 'Synthetic output-schema parity client', version: '1'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  t.after(async () => {
    await client.close();
    await server.close();
    store.close();
  });
  return {client, requests};
}
/** A call that succeeds without a provider, and one that is refused, for each tool. */
function calls(tool) {
  const selector = tool.inputSchema.properties?.action
    ? 'action'
    : tool.inputSchema.properties?.operation
      ? 'operation'
      : null;
  const success = {
    amcp_tool_help: {gateway: tool.name === 'amcp_tool_help' ? 'amcp_workspace' : tool.name},
    amcp_platform_workspace: {operation: 'list_accounts'},
    amcp_workspace: {action: 'contracts', limit: 1},
    amcp_campaign: {action: 'recipes'},
    amcp_reporting: {action: 'capture_presets'},
    amcp_reporting_overview: {action: 'list', limit: 1},
    amcp_media: {action: 'list', limit: 1},
    amcp_write: {
      action: 'inspect',
      gateway: 'meta_native_action',
      arguments: {action: 'meta_campaign_create', account_id: '123', payload: {name: 'Synthetic'}},
    },
    amcp_native_action: {operation: 'list_reporting_templates', arguments: {}},
  }[tool.name];
  const out = [];
  if (success) out.push(['success', success]);
  else if (tool.inputSchema.properties?.action?.type === 'string' && !tool.inputSchema.properties.action.enum)
    out.push(['success', {action: 'LIST_ACTIONS', limit: 1}]);
  out.push([
    'refused',
    selector === null
      ? tool.name === 'amcp_tool_help'
        ? {gateway: 'no_such_gateway'}
        : {platform: 'no_such_platform', account_id: '1'}
      : {[selector]: 'no_such_' + selector},
  ]);
  return out;
}

test('every tool’s structuredContent validates against its outputSchema, with the same text and isError on refusals', async t => {
  let successes = 0,
    refusals = 0;
  for (const allowWrites of [true, false]) {
    const c = await connected(t, allowWrites),
      {tools} = await c.client.listTools(),
      ajv = new Ajv({strict: false});
    assert.ok(tools.length >= 25);
    for (const tool of tools) {
      assert.ok(tool.outputSchema, tool.name + ' declares an outputSchema');
      const validate = ajv.compile(tool.outputSchema);
      for (const [kind, args] of calls(tool)) {
        const label =
          tool.name + ' ' + kind + ' ' + JSON.stringify(args).slice(0, 120) + (allowWrites ? '' : ' (read-only)');
        // The SDK validates structuredContent against the cached outputSchema and throws on a mismatch. The in-memory
        // transport hands the object over unserialized; a client on a real transport receives its JSON.
        const result = await c.client.callTool({name: tool.name, arguments: args});
        assert.ok(result.structuredContent && typeof result.structuredContent === 'object', label);
        const content = JSON.parse(JSON.stringify(result.structuredContent));
        assert.ok(validate(content), label + ': ' + JSON.stringify(validate.errors));
        assert.equal(result.content.length, 1, label);
        assert.equal(result.content[0].type, 'text', label);
        assert.deepEqual(JSON.parse(result.content[0].text), content, label + ': the text is the structured result');
        assert.equal(result.isError === true, content.success === false, label + ': isError exactly on refusal');
        assert.equal(typeof content.meta?.requestId, 'string', label + ': request ID');
        if (content.success === false) {
          refusals++;
          const e = content.error;
          assert.equal(typeof e.code, 'string', label);
          assert.ok(e.message.length > 0, label);
          assert.equal(typeof e.category, 'string', label);
          assert.equal(typeof e.retryable, 'boolean', label);
          assert.equal(typeof e.next_action, 'string', label + ': an actionable next step');
          assert.ok(e.next_action.length > 10, label);
          assert.deepEqual(
            [typeof e.remedy?.owner, typeof e.remedy?.action, e.remedy?.mutation_retry_safe],
            ['string', 'string', false],
            label + ': remedy',
          );
          if (kind === 'refused') assert.notEqual(e.code, 'INTERNAL_ERROR', label + ': a refusal, not a crash');
        } else {
          successes++;
          assert.equal(kind, 'success', label + ' was not refused');
        }
      }
    }
    assert.deepEqual(c.requests, [], 'nothing reached a provider');
  }
  assert.ok(successes >= 20, 'successes ' + successes);
  assert.ok(refusals >= 50, 'refusals ' + refusals);
});

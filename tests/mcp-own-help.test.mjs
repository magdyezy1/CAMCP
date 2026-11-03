// V2-MCP-01: first-party help is a listed, read-only call in every deployment mode.
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
import {actionArgumentCheck, firstPartyContract, toolActions} from '../dist/src/first-party-contracts.js';
import {guidanceDiscovery} from '../dist/src/guidance.js';
import {serverInstructionsFor} from '../dist/src/tool-annotations.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {assertNamesNoProvider} from './helpers/shared-module-seams.mjs';

const registry = new Registry(),
  policies = [{allowWrites: true}, {allowWrites: false}, {allowWrites: false, providerJobs: true}];
function fixture(t, policy = policies[0], flags = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 73).toString('base64')),
    actor = {tenantId: 'synthetic-own-help', userId: 'reader', role: 'reader'};
  t.after(() => store.close());
  let requests = 0;
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(async () => {
      requests++;
      throw Error('Provider egress is forbidden in help tests');
    }),
    {mode: 'strict', flags},
    policy,
  );
  return {service, actor, call: (tool, args) => service.call(tool, args, actor), requests: () => requests};
}
const expectedExample = (tool, action) => {
  const contract = firstPartyContract(tool, action),
    args = action === null ? {} : {action};
  for (const name of contract.argumentsSchema.required)
    if (name !== 'action') args[name] = name === 'confirmed' ? true : '<' + name + '>';
  return {tool: tool.name, arguments: args};
};
const bytes = value => Buffer.byteLength(JSON.stringify(value));

test('every first-party tool answers help with full text, action contracts and examples in every mode', async t => {
  for (const policy of policies)
    for (const compactDescriptions of [true, false]) {
      const f = fixture(t, policy, {compactDescriptions});
      for (const tool of f.service.firstPartyTools()) {
        assert.ok(tool.inputSchema.properties.action.enum.includes('help'), tool.name);
        assert.deepEqual(tool.inputSchema.properties.topic, {type: 'string', maxLength: 300});
        const root = await f.call(tool.name, {action: 'help'});
        assert.equal(root.success, true, tool.name + ' ' + JSON.stringify(root.error));
        assert.equal(root.data.description, tool.description);
        assert.deepEqual(root.data.inputSchema, tool.inputSchema);
        assert.deepEqual(
          root.data.examples,
          toolActions(tool).map(action => expectedExample(tool, action)),
        );
        assert.ok(bytes(root) <= 40000, tool.name + ' root help bytes: ' + bytes(root));
        for (const action of toolActions(tool).filter(a => a !== null)) {
          const help = await f.call(tool.name, {action: 'help', topic: action});
          assert.equal(help.success, true, tool.name + ' ' + action + ' ' + JSON.stringify(help.error));
          assert.deepEqual(help.data.contract.arguments_schema, firstPartyContract(tool, action).argumentsSchema);
          assert.deepEqual(help.data.examples, [expectedExample(tool, action)]);
          assert.ok(bytes(help) <= 40000, tool.name + ' ' + action);
          assert.equal(help.meta.argument_warnings, undefined);
          if (action === 'help')
            assert.deepEqual(help.data.contract.annotations, {
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
            });
        }
      }
      assert.equal(f.requests(), 0);
    }
});

test('workspace help serves guides one section at a time within the response budget', async t => {
  const f = fixture(t, policies[1]),
    list = await f.call('amcp_workspace', {action: 'help', topic: 'guides'});
  assert.equal(list.success, true, JSON.stringify(list.error));
  assert.equal(list.data.guides.length, 13);
  for (const guide of list.data.guides) {
    assert.equal(guide.index.tool, 'amcp_workspace');
    const index = await f.call(guide.index.tool, guide.index.arguments);
    assert.equal(index.success, true, JSON.stringify(index.error));
    assert.ok(bytes(index) <= 8192, guide.name);
    const section = await f.call('amcp_workspace', {
      action: 'help',
      topic: 'guides/' + guide.name + '/' + index.data.sections[0].id,
    });
    assert.equal(section.success, true, JSON.stringify(section.error));
    assert.ok(section.data.text.length > 0 && bytes(section) <= 40000, guide.name);
  }
  assertRefused(await f.call('amcp_workspace', {action: 'help', topic: 'guides/../../.env'}), 'GUIDE_NOT_FOUND');
  assert.equal(f.requests(), 0);
});

function assertSnippetsFit(text, tools) {
  const names = tools.map(tool => tool.name).join('|'),
    snippets = [...text.matchAll(new RegExp('\\b(' + names + ')\\s+(\\{[^{}]*\\})', 'g'))];
  for (const [, name, snippet] of snippets) {
    const properties = tools.find(tool => tool.name === name).inputSchema.properties;
    for (const [, key] of snippet.matchAll(/(?:[{,])\s*([A-Za-z_]\w*)\s*(?=:|[,}])/g))
      assert.ok(Object.hasOwn(properties, key), name + ' lacks ' + key + ' in ' + snippet);
    for (const [, key, value] of snippet.matchAll(/(?:[{,])\s*([A-Za-z_]\w*)\s*:\s*"([^"]*)"/g))
      if (properties[key]?.enum) assert.ok(properties[key].enum.includes(value), name + ' ' + snippet);
  }
  return snippets.length;
}
test('descriptions, instructions and handed-out discovery calls fit their listed schemas', async t => {
  const ajv = new Ajv({strict: false, validateFormats: false});
  for (const policy of policies)
    for (const compactDescriptions of [true, false]) {
      const f = fixture(t, policy, {compactDescriptions}),
        tools = f.service.listTools(),
        validators = new Map(tools.map(tool => [tool.name, ajv.compile(tool.inputSchema)])),
        validateCall = call => {
          const validate = validators.get(call.tool);
          assert.ok(validate, JSON.stringify(call));
          assert.equal(validate(call.arguments), true, JSON.stringify({call, errors: validate.errors}));
        };
      assert.ok(
        assertSnippetsFit([...tools.map(tool => tool.description), serverInstructionsFor(policy)].join('\n'), tools) >
          0,
      );
      assert.doesNotMatch(JSON.stringify(tools), /Canonical v23/);
      validateCall(guidanceDiscovery.tool_call);
      for (const tool of f.service.firstPartyTools()) {
        const unknown = await f.call(tool.name, {action: 'help', topic: 'not-a-real-action'});
        assertRefused(unknown, 'UNKNOWN_OPERATION');
        validateCall(unknown.error.details.list_call);
        const root = await f.call(tool.name, {action: 'help'});
        validateCall(root.data.operation_help);
        const help = await f.call(tool.name, {action: 'help', topic: 'help'});
        validateCall(help.data.see);
        const action = toolActions(tool).find(a => a !== 'help'),
          warnings = actionArgumentCheck(tool, {...(action ? {action} : {}), topic: 'foreign'}, 'report');
        assert.ok(warnings.some(w => w.code === 'ARGUMENT_NOT_USED_BY_ACTION' && w.field === 'topic'));
        for (const warning of warnings) validateCall(warning.help_call);
      }
      const guides = await f.call('amcp_workspace', {action: 'help', topic: 'guides'});
      for (const guide of guides.data.guides) {
        validateCall(guide.index);
        const index = await f.call(guide.index.tool, guide.index.arguments);
        validateCall(index.data.read_section);
      }
      const google = await f.call('amcp_tool_help', {gateway: 'google_ads_native_action'});
      assert.equal(google.success, true, JSON.stringify(google.error));
      // Captured google_ads_v23_* action IDs and historical version notes remain compatible; active claims are current.
      assert.doesNotMatch(
        google.data.description.replaceAll('google_ads_v23_', ''),
        /Canonical v23|API v23|sent at v23/,
      );
      assert.equal(f.requests(), 0);
    }
});

test('an MCP SDK client can call every listed own-help endpoint in all policy modes', async t => {
  for (const policy of policies) {
    const f = fixture(t, policy),
      server = createMcpServer(f.service, f.actor),
      client = new Client({name: 'synthetic-own-help', version: '1'}),
      [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    try {
      const listed = (await client.listTools()).tools;
      for (const tool of f.service.firstPartyTools()) {
        assert.ok(listed.some(item => item.name === tool.name));
        const help = await client.callTool({name: tool.name, arguments: {action: 'help', topic: 'help'}});
        assert.equal(help.structuredContent.success, true, tool.name + ' ' + JSON.stringify(help.structuredContent));
        assert.equal(help.structuredContent.data.operation, 'help');
      }
      assert.equal(f.requests(), 0);
    } finally {
      await client.close();
      await server.close();
    }
  }
});

test('preview default calls stay distinct from help and read-only inspect keeps its required arguments', async t => {
  const f = fixture(t, policies[1], {actionArguments: 'enforce'}),
    preview = f.service.firstPartyTools().find(tool => tool.name === 'amcp_ad_previews'),
    write = f.service.firstPartyTools().find(tool => tool.name === 'amcp_write'),
    ajv = new Ajv({strict: false}),
    validatePreview = ajv.compile(preview.inputSchema),
    validateWrite = ajv.compile(write.inputSchema);
  assert.deepEqual(toolActions(preview), [null, 'help']);
  assert.equal(validatePreview({action: 'help', topic: 'help'}), true);
  assert.equal(validatePreview({platform: 'meta', account_id: 'synthetic-account'}), true);
  assert.equal(validatePreview({}), false);
  assert.ok(validatePreview.errors.some(e => e.keyword === 'required'));
  assert.equal(validateWrite({action: 'help'}), true);
  assert.equal(validateWrite({action: 'inspect'}), false);
  assert.ok(validateWrite.errors.some(e => e.keyword === 'required'));
  const root = await f.call(preview.name, {action: 'help'});
  assert.equal(root.success, true, JSON.stringify(root.error));
  assert.deepEqual(root.data.contract.arguments_schema.required, ['platform', 'account_id']);
  assertRefused(
    await f.call(preview.name, {action: 'unknown', platform: 'meta', account_id: 'synthetic-account'}),
    'INVALID_ARGUMENT',
  );
  assertRefused(await f.call(preview.name, {action: 'help', topic: 42}), 'INVALID_ARGUMENT');
  assertRefused(await f.call(write.name, {action: 'help', topic: 'x'.repeat(301)}), 'INVALID_ARGUMENT');
  assertRefused(await f.call(preview.name, {topic: 'help'}), 'INVALID_ARGUMENT');
  assert.equal(f.requests(), 0);
});

test('legacy tool help still answers first-party gateways and keeps the captured input schema', async t => {
  const f = fixture(t),
    listed = f.service.listTools().find(tool => tool.name === 'amcp_tool_help'),
    captured = registry.data.tools.find(tool => tool.name === listed.name);
  assert.deepEqual(listed.inputSchema, captured.inputSchema);
  for (const tool of f.service.firstPartyTools()) {
    const legacy = await f.call('amcp_tool_help', {gateway: tool.name});
    assert.equal(legacy.success, true, JSON.stringify(legacy.error));
    assert.equal(legacy.data.description, tool.description);
    const action = await f.call('amcp_tool_help', {gateway: tool.name, operation: 'help'});
    assert.equal(action.success, true, JSON.stringify(action.error));
  }
  assert.equal(f.requests(), 0);
});

test('own help keeps shared modules free of provider imports and gateway names', () => {
  for (const file of ['src/tool-help.ts', 'src/tool-summaries.ts', 'src/guidance.ts', 'src/first-party-contracts.ts'])
    assertNamesNoProvider(file);
});

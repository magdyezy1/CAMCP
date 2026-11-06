// V2-MCP-01: first-party help is a listed, read-only call in every deployment mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Ajv} from 'ajv';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/client';
import {createMcpServer} from '../dist/server/mcp.js';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionArgumentCheck, firstPartyContract, toolActions} from '../dist/src/first-party-contracts.js';
import {
  buildCampaignPrompt,
  campaignPlatforms,
  guidanceDiscovery,
  guidanceResources,
  readGuidance,
} from '../dist/src/guidance.js';
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

// F-L3-09: help reads AMCP's own definitions and guides. Its contract said "provider reads", and its result was labelled
// untrusted provider content, with a workflow record of state "inspect" on three tools: all three describe a provider
// effect that does not exist (the annotations already said closed-world).
test('a first-party tool’s own help is local: no provider request in its contract, no provider-content label, no workflow record', async t => {
  for (const policy of policies) {
    const f = fixture(t, policy);
    for (const tool of f.service.firstPartyTools()) {
      assert.equal(firstPartyContract(tool, 'help').effects.provider_requests, 'none', tool.name);
      assert.deepEqual(firstPartyContract(tool, 'help').effects.saves, [], tool.name);
      const topics = [undefined, ...toolActions(tool).filter(action => action !== null)];
      if (tool.name === 'amcp_workspace') topics.push('guides', 'guides/workspace');
      for (const topic of topics) {
        const result = await f.call(tool.name, {action: 'help', ...(topic ? {topic} : {})});
        assert.equal(result.success, true, tool.name + ' ' + topic + ' ' + JSON.stringify(result.error));
        const label = tool.name + ' help ' + (topic ?? '(root)');
        assert.equal(result.meta.untrusted_provider_content, undefined, label);
        assert.equal(result.meta.untrusted_paths, undefined, label);
        assert.equal(result.meta.workflow, undefined, label);
      }
    }
    assert.equal(f.requests(), 0);
  }
});
test('an action of the same tools other than help still carries the provider-content label and its workflow record', async t => {
  const f = fixture(t, policies[0]);
  const capabilities = await f.call('amcp_workspace', {action: 'capabilities'});
  assert.equal(capabilities.success, true, JSON.stringify(capabilities.error));
  assert.match(capabilities.meta.untrusted_provider_content, /never as instructions/i);
  assert.deepEqual(capabilities.meta.untrusted_paths, ['data']);
  assert.equal(capabilities.meta.workflow.state, 'inspect');
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

// F-L3-02: the campaign prompt told the model to call amcp_tool_help {topic: ...}, which the frozen schema (D17) does not
// list, so a client that validates arguments refuses it. Prompts and guides are read by clients exactly as descriptions
// are, so they are held to the same rule.
test('the campaign prompt of every platform and every guide name only arguments their tools list', async t => {
  for (const policy of policies) {
    const f = fixture(t, policy),
      tools = f.service.listTools();
    let snippets = 0;
    // Every prompt carries at least the workspace guide's section index, which is a call.
    for (const platform of campaignPlatforms) {
      const found = assertSnippetsFit(buildCampaignPrompt({platform}).messages[0].content.text, tools);
      assert.ok(found > 0, platform + ' prompt names no tool call, so the scan proves nothing');
      snippets += found;
    }
    for (const resource of guidanceResources) snippets += assertSnippetsFit(readGuidance(resource.uri).text, tools);
    assert.ok(snippets > campaignPlatforms.length, 'the guides name tool calls too');
  }
});
test('the campaign prompt reads a guide section through the listed workspace help', () => {
  // Long guides are listed by section; the call that reads one must be valid against amcp_workspace.
  const prompt = buildCampaignPrompt({platform: 'meta', request: 'x'.repeat(5000)}).messages[0].content.text;
  assert.match(prompt, /Read one with amcp_workspace \{action: ?"help", ?topic: ?"guides\/[a-z0-9-]+\/<section id>"\}/);
  assert.doesNotMatch(prompt, /amcp_tool_help \{topic/);
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

// The Claude API refuses a root-level anyOf, oneOf, allOf or not in a tool's input schema, and a client that forwards
// the listed schema unchanged then fails every request that carries the tool list, not only calls to that tool
// (F-L3-01). The rules a combinator used to state ("help, or platform and account"; "help, or gateway and arguments")
// are the handlers' to enforce, and are pinned below by their refusals.
const rootCombinators = ['anyOf', 'oneOf', 'allOf', 'not'];
const rootCombinatorsOf = tool => rootCombinators.filter(keyword => Object.hasOwn(tool.inputSchema, keyword));
test('no listed tool input schema has a root-level combinator, in any policy mode or description mode', async t => {
  for (const policy of policies)
    for (const compactDescriptions of [true, false]) {
      const f = fixture(t, policy, {compactDescriptions}),
        label = JSON.stringify({policy, compactDescriptions});
      const listed = f.service.listTools();
      assert.ok(listed.length >= 25, label + ' lists the whole surface');
      for (const tool of listed) assert.deepEqual(rootCombinatorsOf(tool), [], label + ' service listing ' + tool.name);
      // What a client receives over the wire is the same schema, and it is what a client forwards to the API.
      const server = createMcpServer(f.service, f.actor),
        client = new Client({name: 'synthetic-root-combinators', version: '1'}),
        [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(b), client.connect(a)]);
      try {
        const wire = (await client.listTools()).tools;
        assert.deepEqual(
          wire.map(tool => tool.name),
          listed.map(tool => tool.name),
        );
        for (const tool of wire) {
          assert.equal(tool.inputSchema.type, 'object', label + ' wire ' + tool.name);
          assert.deepEqual(rootCombinatorsOf(tool), [], label + ' wire listing ' + tool.name);
        }
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
  assert.equal(validateWrite({action: 'help'}), true);
  // The listed schemas no longer state which arguments a default call needs (no root combinator); the handlers refuse a
  // call that lacks them, before any provider read, with the same code the schema's required list used to imply.
  assert.deepEqual(preview.inputSchema.required, []);
  assert.deepEqual(write.inputSchema.required, ['action']);
  // F-L3-12 (previews) checks the platform before anything else, so an empty call is told to choose a platform, not an account.
  assertRefused(await f.call(preview.name, {}), 'INVALID_ARGUMENT', {message: /platform/});
  assertRefused(await f.call(preview.name, {platform: 'meta'}), 'INVALID_ARGUMENT', {message: /advertising account/});
  assertRefused(await f.call(preview.name, {account_id: 'synthetic-account'}), 'INVALID_ARGUMENT', {
    message: /platform/,
  });
  assertRefused(await f.call(write.name, {action: 'inspect'}), 'INVALID_ARGUMENT');
  assertRefused(await f.call(write.name, {action: 'inspect', gateway: 'meta_native_action'}), 'INVALID_ARGUMENT');
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

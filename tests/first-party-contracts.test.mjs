import test from 'node:test';
import assert from 'node:assert/strict';
import {Ajv} from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {
  authoredArguments,
  authoredContractActions,
  firstPartyContract,
  firstPartyContractTools,
  toolActions,
} from '../dist/src/first-party-contracts.js';
import {outcomeSchema, outcomeStates} from '../dist/src/workflow-outcomes.js';
import {repositoryFixtures} from '../tools/first-party-fixtures.mjs';

/**
 * MCP-07: every action of AMCP's own tools has a typed contract row, served by help; an argument of another action is
 * reported (and, under the enforce flag, refused) instead of accepted silently; and every AMCP tool publishes the
 * meta.workflow outcome schema, which a real MCP SDK client validates, including amcp_write's states.
 */
const registry = new Registry(),
  writes = {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
  gateway = 'meta_native_action',
  action = 'meta_ad_account_id_create';
const actor = {tenantId: 'first-party-contracts', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
/** A synthetic Meta account whose rename can succeed, fail, or be lost in transport after it was sent. */
function fixture({mode = '', flags = {}, allowWrites = true} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 77).toString('base64')),
    calls = [];
  store.putConnection(
    owner,
    {
      id: 'm',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Meta',
      scopes: ['ads_management'],
    },
    {accessToken: 'synthetic'},
  );
  const account = {name: 'Brand'};
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        method = init.method;
      calls.push({path: u.pathname, method});
      if (method === 'GET' && u.pathname === '/v26.0/act_123') return Response.json({id: 'act_123', ...account});
      if (method === 'POST' && u.pathname === '/v26.0/act_123') {
        if (mode === 'lost') throw new TypeError('fetch failed');
        // The provider answered and reported that the change did not apply.
        if (mode === 'error') return Response.json({success: false});
        Object.assign(account, Object.fromEntries(new URLSearchParams(String(init.body ?? ''))));
        return Response.json({success: true});
      }
      throw new Error('Unexpected ' + method + ' ' + u.pathname);
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    100,
  );
  const service = new MirrorService(
    registry,
    store,
    transport,
    {mode: 'strict', flags},
    allowWrites ? writes : undefined,
  );
  const call = (tool, args) => service.call(tool, args, actor);
  const prepare = () =>
    call('amcp_write', {
      action: 'prepare',
      gateway,
      arguments: {action, account_id: '123', params: {ad_account_id: 'act_123'}, payload: {name: 'Renamed'}},
    });
  const execute = p => call('amcp_write', {action: 'execute', review_id: p.data.review_id, confirmed: true});
  return {store, service, calls, call, prepare, execute, close: () => store.close()};
}
async function sdkClient(service) {
  const server = createMcpServer(service, actor),
    client = new Client({name: 'first-party-contracts', version: '1'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

test('every action of every AMCP tool has a contract row, and every row names arguments of its tool', () => {
  const f = fixture(),
    r = fixture({allowWrites: false});
  try {
    for (const tools of [f.service.firstPartyTools(), r.service.firstPartyTools()])
      for (const tool of tools) {
        assert.ok(firstPartyContractTools.includes(tool.name), tool.name);
        for (const name of toolActions(tool)) {
          const c = firstPartyContract(tool, name);
          assert.ok(c, tool.name + ' ' + name + ' has no contract row');
          assert.ok(c.summary.length > 10 && c.summary.length <= 200, tool.name + ' ' + name);
          assert.equal(c.argumentsSchema.additionalProperties, false);
          assert.ok(['reader', 'operator', 'admin', 'owner'].includes(c.requires_role));
          assert.ok(['none', 'read_only', 'reviewed_write'].includes(c.effects.provider_requests));
          // Each argument keeps the schema tools/list advertises for it.
          for (const [key, schema] of Object.entries(c.argumentsSchema.properties))
            if (key !== 'action') {
              const {description: _note, ...listed} = tool.inputSchema.properties[key];
              const {description: _own, ...own} = schema;
              assert.deepEqual(own, listed, tool.name + ' ' + name + ' ' + key);
            }
          for (const next of c.next) assert.ok(firstPartyContractTools.includes(next.tool), JSON.stringify(next));
          new Ajv({strict: false}).compile(c.argumentsSchema);
        }
      }
    // No authored row names an action its tool does not have, nor an argument the full listing lacks.
    for (const tool of f.service.firstPartyTools()) {
      const actions = toolActions(tool);
      for (const name of authoredContractActions(tool.name)) {
        assert.ok(actions.includes(name), tool.name + ' row ' + name + ' names no action');
        for (const key of authoredArguments(tool.name, name))
          assert.ok(Object.hasOwn(tool.inputSchema.properties, key), tool.name + ' ' + name + ' names ' + key);
      }
    }
  } finally {
    f.close();
    r.close();
  }
});

// Deliberately wrong literal calls in tests that assert the refusal; each names the argument it adds.
const negativeFixtures = [
  // execute takes the frozen review; arguments sent with it are refused.
  {file: 'tests/google-recommendation-dismissal.test.ts', tool: 'amcp_write', action: 'execute', field: 'arguments'},
  // account_ids applies to check only (CON-05); the dashboard call asserts that refusal.
  {file: 'tests/connection-management.test.mjs', tool: 'amcp_workspace', action: 'dashboard', field: 'account_ids'},
  // This file's own report-only and enforce cases.
  ...[
    ['amcp_workspace', 'contracts', 'live'],
    ['amcp_write', 'inspect', 'review_id'],
    ['amcp_media', 'list', 'asset_id'],
    ['amcp_workspace', 'check', 'max_pages'],
  ].map(([tool, action, field]) => ({file: 'tests/first-party-contracts.test.mjs', tool, action, field})),
];
test('every literal call of the AMCP tools in the tests, the website and the guides fits its action contract', () => {
  const f = fixture();
  try {
    const tools = new Map(f.service.firstPartyTools().map(t => [t.name, t])),
      calls = repositoryFixtures(),
      misfits = [];
    assert.ok(calls.length > 1000, 'the fixture scan found ' + calls.length + ' calls');
    for (const c of calls) {
      const tool = tools.get(c.tool),
        actions = toolActions(tool),
        name = actions[0] === null ? null : c.action;
      if (actions[0] !== null && (typeof name !== 'string' || !actions.includes(name))) continue;
      const accepted = Object.keys(firstPartyContract(tool, name).argumentsSchema.properties);
      for (const field of c.keys.filter(k => !accepted.includes(k)))
        if (
          !negativeFixtures.some(n => n.file === c.file && n.tool === c.tool && n.action === name && n.field === field)
        )
          misfits.push(c.tool + ' ' + name + ' ' + field + ' (' + c.file + ':' + c.line + ')');
    }
    assert.deepEqual(misfits, []);
  } finally {
    f.close();
  }
});

test('an argument of another action draws a report-only warning; it was accepted silently before', async () => {
  const f = fixture();
  try {
    const plain = await f.call('amcp_workspace', {action: 'contracts', gateway, limit: 1}),
      extra = await f.call('amcp_workspace', {action: 'contracts', gateway, limit: 1, live: true});
    assert.equal(plain.success, true);
    assert.equal(plain.meta.argument_warnings, undefined);
    assert.equal(extra.success, true, 'report-only: the call still runs');
    assert.deepEqual(extra.data, plain.data);
    assert.equal(extra.meta.argument_warnings.length, 1);
    assert.equal(extra.meta.argument_warnings[0].code, 'ARGUMENT_NOT_USED_BY_ACTION');
    assert.equal(extra.meta.argument_warnings[0].field, 'live');
    assert.deepEqual(extra.meta.argument_warnings[0].help_call, {
      tool: 'amcp_tool_help',
      arguments: {gateway: 'amcp_workspace', operation: 'contracts'},
    });
    // amcp_write and amcp_media are checked the same way.
    const inspect = await f.call('amcp_write', {
      action: 'inspect',
      gateway,
      arguments: {action, account_id: '123', params: {ad_account_id: 'act_123'}, payload: {name: 'x'}},
      review_id: 'not-read-by-inspect',
    });
    assert.equal(inspect.meta.argument_warnings?.[0]?.field, 'review_id');
    const media = await f.call('amcp_media', {action: 'list', asset_id: 'x'});
    assert.equal(media.meta.argument_warnings?.[0]?.field, 'asset_id');
    assert.equal(f.calls.length, 0);
  } finally {
    f.close();
  }
});

test('under MIRROR_FLAGS actionArguments:"enforce" the argument is refused with INVALID_ARGUMENT naming it, before the action runs', async () => {
  const f = fixture({flags: {actionArguments: 'enforce'}});
  try {
    const refused = await f.call('amcp_workspace', {
      action: 'check',
      connection_id: 'm',
      account_id: '123',
      live: true,
      max_pages: 2,
    });
    assert.equal(refused.success, false);
    assert.equal(refused.error.code, 'INVALID_ARGUMENT');
    assert.equal(refused.error.details.field, 'max_pages');
    assert.equal(refused.error.details.action, 'check');
    assert.ok(refused.error.details.accepted.includes('live'));
    assert.match(refused.error.message, /max_pages is not an argument of amcp_workspace check/);
    assert.equal(f.calls.length, 0, 'the live read never started');
    // A call within its contract runs as before.
    assert.equal((await f.call('amcp_workspace', {action: 'contracts', gateway, limit: 1})).success, true);
  } finally {
    f.close();
  }
});

test('amcp_tool_help serves the contract of an AMCP action: arguments as JSON Schema, effects, role and next calls', async () => {
  const f = fixture();
  try {
    const help = await f.call('amcp_tool_help', {gateway: 'amcp_workspace', operation: 'program_check'}),
      contract = help.data.contract;
    assert.equal(help.success, true);
    assert.match(help.data.summary, /conditional program/);
    assert.deepEqual(contract.arguments_schema.required, ['action', 'workflow_id', 'connection_id', 'account_id']);
    assert.ok(contract.arguments_schema.properties.requirements);
    assert.ok(contract.arguments_schema.properties.live);
    assert.equal(contract.arguments_schema.additionalProperties, false);
    assert.equal(contract.effects.provider_requests, 'read_only');
    assert.deepEqual(contract.effects.saves, ['conditional_program_observation']);
    assert.equal(contract.effects.advertising_writes, false);
    assert.equal(contract.requires_role, 'reader');
    assert.ok(help.data.arguments.requirements.description, 'the moved argument note rides along');
    const write = await f.call('amcp_tool_help', {gateway: 'amcp_write', operation: 'execute'});
    assert.equal(write.data.contract.effects.advertising_writes, true);
    assert.equal(write.data.contract.requires_role, 'operator');
    assert.match(write.data.arguments.cap_override_confirmed.description, /spending cap/);
    const tool = await f.call('amcp_tool_help', {gateway: 'amcp_campaign'});
    assert.equal(Object.keys(tool.data.action_summaries).length, tool.data.actions.length);
    const previews = await f.call('amcp_tool_help', {gateway: 'amcp_ad_previews'});
    assert.deepEqual(previews.data.contract.arguments_schema.required, ['platform', 'account_id']);
  } finally {
    f.close();
  }
});

test('the outcome schema is published for the AMCP tools and a real SDK client validates their results', async () => {
  const f = fixture();
  const c = await sdkClient(f.service);
  try {
    const {tools} = await c.client.listTools(),
      byName = new Map(tools.map(t => [t.name, t]));
    for (const name of [...firstPartyContractTools.filter(n => n !== 'amcp_ad_previews')])
      assert.deepEqual(byName.get(name).outputSchema.properties.meta.properties.workflow, outcomeSchema, name);
    assert.equal(byName.get('meta_native_action').outputSchema.properties.meta.properties, undefined);
    assert.deepEqual(outcomeSchema.properties.state.enum, [...outcomeStates]);
    // The SDK client validates structuredContent against the listed outputSchema; a mismatch throws.
    const call = async (name, args) => (await c.client.callTool({name, arguments: args})).structuredContent;
    const results = [
      await call('amcp_workspace', {action: 'operations'}),
      await call('amcp_workspace', {action: 'capabilities', limit: 1}),
      await call('amcp_workspace', {action: 'check', connection_id: 'm', account_id: '123'}),
      await call('amcp_campaign', {action: 'list'}),
      await call('amcp_campaign', {action: 'get', id: 'missing'}),
      await call('amcp_reporting', {action: 'capture_presets'}),
      await call('amcp_reporting', {action: 'list'}),
      await call('amcp_reporting_overview', {action: 'list'}),
      await call('amcp_media', {action: 'list'}),
      await call('amcp_ad_previews', {platform: 'criteo', account_id: '123'}),
      await call('amcp_write', {action: 'inspect', gateway, arguments: {action, account_id: '123', payload: {}}}),
    ];
    const prepared = await call('amcp_write', {
      action: 'prepare',
      gateway,
      arguments: {action, account_id: '123', params: {ad_account_id: 'act_123'}, payload: {name: 'Renamed'}},
    });
    results.push(prepared);
    results.push(await call('amcp_write', {action: 'execute', review_id: prepared.data.review_id, confirmed: true}));
    results.push(await call('amcp_write', {action: 'execute', review_id: 'no-such-review', confirmed: true}));
    const validate = new Ajv({strict: false}).compile(outcomeSchema);
    for (const r of results) {
      assert.equal(typeof r.success, 'boolean');
      if (r.meta?.workflow) {
        assert.ok(validate(r.meta.workflow), JSON.stringify(r.meta.workflow));
        assert.equal(r.meta.workflow.automatic_retry_of_mutation, false);
      }
    }
  } finally {
    await c.close();
    f.close();
  }
});

test('tools/list of a writes deployment (strict) stays within 95 KB with every output schema', async () => {
  // MCP-07 acceptance: the outcome schemas are published without growing the listing past 95 KB (it was 143,745 bytes
  // before MCP-01; MCP-10's AMCP-owned descriptions keep it under the line).
  const store = new Store(':memory:');
  const service = new MirrorService(new Registry(), store, undefined, undefined, writes);
  const c = await sdkClient(service);
  try {
    const listed = await c.client.listTools(),
      bytes = Buffer.byteLength(JSON.stringify(listed));
    assert.ok(
      listed.tools.some(t => t.name === 'amcp_write' && t.outputSchema),
      'writes mode lists amcp_write',
    );
    assert.ok(bytes <= 95 * 1024, String(bytes));
  } finally {
    await c.close();
    store.close();
  }
});

test('amcp_write outcomes: inspect, review_required, running then complete, attention_required when uncertain, blocked when not sent', async () => {
  const f = fixture();
  try {
    const inspected = await f.call('amcp_write', {
      action: 'inspect',
      gateway,
      arguments: {action, account_id: '123', params: {ad_account_id: 'act_123'}, payload: {name: 'Renamed'}},
    });
    assert.equal(inspected.meta.workflow.state, 'inspect');
    const prepared = await f.prepare();
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 400));
    assert.equal(prepared.meta.workflow.state, 'review_required');
    assert.ok(Array.isArray(prepared.meta.workflow.required_acknowledgements));
    assert.equal(prepared.meta.workflow.next_call, undefined, 'a review never suggests its own execute');
    // Refused before anything was sent: blocked, nothing claimed.
    const unconfirmed = await f.call('amcp_write', {action: 'execute', review_id: prepared.data.review_id});
    assert.equal(unconfirmed.success, false);
    assert.equal(unconfirmed.meta.workflow.state, 'blocked');
    assert.equal(unconfirmed.meta.workflow.source_state, 'not_sent');
    const executed = await f.execute(prepared);
    assert.equal(executed.success, true, JSON.stringify(executed).slice(0, 400));
    assert.equal(executed.meta.workflow.state, 'running');
    assert.deepEqual(executed.meta.workflow.next_call, {
      tool: 'amcp_campaign',
      arguments: {action: 'verify', review_id: prepared.data.review_id},
    });
    const verified = await f.call('amcp_campaign', {action: 'verify', review_id: prepared.data.review_id});
    assert.equal(verified.data.status, 'verified');
    assert.equal(verified.meta.workflow.state, 'complete');
  } finally {
    f.close();
  }
  const failed = fixture({mode: 'error'});
  try {
    const out = await failed.execute(await failed.prepare());
    assert.equal(out.success, false);
    assert.equal(out.meta.workflow.state, 'attention_required');
    assert.equal(out.meta.workflow.source_state, 'failed');
    assert.equal(out.meta.workflow.next_call.tool, 'amcp_workspace');
  } finally {
    failed.close();
  }
  const lost = fixture({mode: 'lost'});
  try {
    const prepared = await lost.prepare(),
      out = await lost.execute(prepared);
    assert.equal(out.success, false);
    assert.equal(out.meta.workflow.state, 'attention_required');
    assert.equal(out.meta.workflow.source_state, 'uncertain');
    assert.equal(out.meta.workflow.automatic_retry_of_mutation, false);
    assert.deepEqual(out.meta.workflow.next_call, {
      tool: 'amcp_workspace',
      arguments: {action: 'history', search: prepared.data.review_id},
    });
    // The same review is never sent again, and its outcome stays uncertain.
    const posts = lost.calls.filter(c => c.method === 'POST').length,
      again = await lost.execute(prepared);
    assert.equal(again.error.code, 'WRITE_OUTCOME_UNCERTAIN');
    assert.equal(again.meta.workflow.state, 'attention_required');
    assert.equal(lost.calls.filter(c => c.method === 'POST').length, posts);
    const history = await lost.call('amcp_workspace', again.meta.workflow.next_call.arguments);
    assert.equal(history.success, true);
  } finally {
    lost.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {leadFixture, leadBusiness, actor} from './fixtures/snapchat-leads-data.mjs';
import {fullDescription} from './fixtures/tool-help.mjs';

test('real MCP SDK inspects and saves a paused lead draft without advertising or submitted-lead access', async t => {
  const f = leadFixture(),
    key = f.store.createKey(actor),
    authenticated = f.store.authenticate(key),
    server = createMcpServer(f.service, authenticated),
    client = new Client({name: 'Synthetic lead workflow evaluation', version: '1.0.0'}),
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
    f.close();
  });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const tools = (await client.listTools()).tools,
    tool = tools.find(x => x.name === 'amcp_campaign'),
    schema = new Ajv({strict: false}).compile(tool.inputSchema);
  assert.match(await fullDescription(client, 'amcp_campaign'), /Snapchat lead-generation recipe/);
  let calls = 0,
    bytes = 0;
  const call = async arguments_ => {
    assert.equal(schema(arguments_), true, JSON.stringify(schema.errors));
    const out = await client.callTool({name: 'amcp_campaign', arguments: arguments_});
    calls++;
    bytes += Buffer.byteLength(JSON.stringify(out.structuredContent));
    assert.deepEqual(JSON.parse(out.content[0].text), out.structuredContent);
    assert.equal(out.isError === true, out.structuredContent.success === false);
    return out.structuredContent;
  };
  const recipe = 'snapchat_lead_generation',
    business = leadBusiness;
  assert.ok((await call({action: 'recipes'})).data.recipes.some(x => x.id === recipe));
  const context = await call({action: 'recipe_context', recipe});
  assert.equal(context.data.targets[0].connection_id, business.connection_id);
  const preview = await call({action: 'preview_recipe', recipe, business});
  assert.equal(preview.data.recipe.optimization_goal, 'LEAD_FORM_SUBMISSIONS');
  assert.equal(f.requests.length, 0);
  const evidence = await call({action: 'recipe_eligibility', recipe, business, live: true});
  assert.equal(evidence.success, true, JSON.stringify(evidence.error));
  assert.equal(evidence.data.dependencies.find(x => x.id === 'existing_lead_form').evidence.asset_id, 'form1');
  for (const id of ['provider_objective_acceptance', 'lead_form_policy_acceptance'])
    assert.equal(evidence.data.dependencies.find(x => x.id === id).status, 'unknown');
  const saved = await call({action: 'create_from_recipe', recipe, business});
  assert.equal(saved.data.state, 'draft');
  const full = await call({action: 'get', id: saved.data.id, detail: 'full'});
  assert.deepEqual(
    full.data.steps.map(x => Object.values(x.arguments.payload)[0][0].status),
    ['PAUSED', 'PAUSED', 'PAUSED'],
  );
  assert.equal(f.store.documents(actor.tenantId, 'write_review').length, 0);
  f.store.revokeKey(key);
  const before = f.requests.length;
  assert.equal((await call({action: 'recipe_eligibility', recipe, business, live: true})).success, false);
  assert.equal(f.requests.length, before);
  assert.equal(f.writes.length + f.adWrites.length, 0);
  assert.ok(f.requests.every(x => !x.includes('/leads') && !x.includes('webhook')));
  assert.ok(bytes < 48000, 'Keep the complete guided handoff bounded');
  t.diagnostic(
    JSON.stringify({
      journey: 'snapchat-lead-generation',
      tool_calls: calls,
      structured_response_bytes: bytes,
      synthetic_provider_requests: f.requests.length,
      external_provider_requests: 0,
      provider_mutations: 0,
      qualification: 'real SDK with in-memory native definitions only',
    }),
  );
});

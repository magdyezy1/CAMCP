import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/client';
import {createMcpServer} from '../dist/server/mcp.js';
import {trafficFixture, trafficBusiness, actor} from './fixtures/snapchat-traffic-data.mjs';
import {fullDescription} from './fixtures/tool-help.mjs';

test('the real MCP SDK discovers and inspects Snapchat traffic, preserves unknown acceptance and saves only a paused draft', async t => {
  const f = trafficFixture(),
    key = f.store.createKey(actor),
    authenticated = f.store.authenticate(key),
    server = createMcpServer(f.service, authenticated),
    client = new Client({name: 'Synthetic Snapchat workflow evaluation', version: '1.0.0'}),
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
    f.close();
  });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const tools = (await client.listTools()).tools,
    schema = new Ajv({strict: false}).compile(tools.find(t => t.name === 'amcp_campaign').inputSchema);
  assert.match(await fullDescription(client, 'amcp_campaign'), /Snapchat website traffic recipe/);
  let calls = 0,
    bytes = 0;
  const call = async args => {
    assert.equal(schema(args), true, JSON.stringify(schema.errors));
    const response = await client.callTool({name: 'amcp_campaign', arguments: args});
    calls++;
    bytes += Buffer.byteLength(JSON.stringify(response.structuredContent));
    assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
    assert.equal(response.isError === true, response.structuredContent.success === false);
    return response.structuredContent;
  };
  const recipe = 'snapchat_website_traffic',
    business = trafficBusiness,
    discovery = await call({action: 'recipes'});
  assert.ok(discovery.data.recipes.some(r => r.id === recipe));
  const context = await call({action: 'recipe_context', recipe});
  assert.equal(context.data.targets[0].account_id, 'acct1');
  const preview = await call({action: 'preview_recipe', recipe, business});
  assert.equal(preview.data.recipe.daily_budget_micro, '20000001');
  assert.equal(f.requests.length, 0, 'Discovery and local compilation require no native reads');
  const inspection = await call({action: 'recipe_eligibility', recipe, business, live: true});
  assert.equal(inspection.success, true, JSON.stringify(inspection.error));
  assert.equal(inspection.data.status, 'unknown');
  const creative = inspection.data.dependencies.find(d => d.id === 'existing_website_creative');
  assert.equal(creative.status, 'ready');
  assert.equal(creative.evidence.original_destination, 'https://example.com/synthetic-snapchat');
  assert.equal(inspection.data.dependencies.find(d => d.id === 'provider_objective_acceptance').status, 'unknown');
  assert.equal(inspection.data.dependencies.find(d => d.id === 'landing_page').status, 'unknown');
  const saved = await call({action: 'create_from_recipe', recipe, business});
  assert.equal(saved.data.state, 'draft');
  const full = await call({action: 'get', id: saved.data.id, detail: 'full'});
  assert.equal(full.data.recipe.id, recipe);
  assert.deepEqual(
    full.data.steps.map(s => Object.values(s.arguments.payload)[0][0].status),
    ['PAUSED', 'PAUSED', 'PAUSED'],
  );
  assert.equal(f.store.documents(actor.tenantId, 'write_review').length, 0);
  f.store.revokeKey(key);
  const before = f.requests.length,
    revoked = await call({action: 'recipe_eligibility', recipe, business, live: true});
  assert.equal(revoked.success, false);
  assert.equal(f.requests.length, before);
  assert.equal(f.writes.length + f.adWrites.length, 0);
  assert.ok(bytes < 40000, 'Keep the guided inspection compact');
  t.diagnostic(
    JSON.stringify({
      journey: 'snapchat-traffic',
      tool_calls: calls,
      structured_response_bytes: bytes,
      synthetic_provider_requests: f.requests.length,
      external_provider_requests: 0,
      provider_mutations: 0,
      qualification: 'real SDK; in-memory native fixture only',
    }),
  );
});

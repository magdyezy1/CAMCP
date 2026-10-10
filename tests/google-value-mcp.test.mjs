import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {googleSearchFixture} from './fixtures/google-search-recipe-data.mjs';
import {valueInspectionFixture} from './fixtures/google-value-inspection-data.mjs';
import {conversionActivityFixture} from './fixtures/google-conversion-activity-data.mjs';
import {fullDescription} from './fixtures/tool-help.mjs';

test('the real MCP SDK exposes qualified aggregate activity with unchanged source handoffs and revoked-client boundaries', async t => {
  const f = conversionActivityFixture(t),
    key = f.store.createKey(f.actor),
    server = createMcpServer(f.service, f.store.authenticate(key)),
    client = new Client({name: 'Synthetic aggregate activity evaluation', version: '1.0.0'}),
    [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const descriptor = (await client.listTools()).tools.find(x => x.name === 'amcp_campaign'),
    schema = new Ajv({strict: false}).compile(descriptor.inputSchema);
  assert.match(await fullDescription(client, 'amcp_campaign'), /last reported conversion date/);
  let calls = 0,
    bytes = 0;
  const call = async args => {
    assert.equal(schema(args), true, JSON.stringify(schema.errors));
    const out = await client.callTool({name: 'amcp_campaign', arguments: args});
    calls++;
    bytes += Buffer.byteLength(JSON.stringify(out.structuredContent));
    assert.deepEqual(JSON.parse(out.content[0].text), JSON.parse(JSON.stringify(out.structuredContent)));
    assert.equal(out.isError === true, out.structuredContent.success === false);
    return out.structuredContent;
  };
  const recipe = 'google_search_target_roas',
    business = f.business,
    local = await call({action: 'recipe_eligibility', recipe, business});
  assert.equal(local.success, true);
  assert.equal(f.data.requests.length, 0);
  assert.equal(local.data.dependencies.find(d => d.id === 'reported_conversion_activity').status, 'unknown');
  const out = await call({action: 'recipe_eligibility', recipe, business, live: true});
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.data.dependencies.find(d => d.id === 'reported_conversion_activity').status, 'ready');
  assert.equal(out.data.status, 'unknown');
  assert.equal(out.data.conversion_goal_inspection.primary_actions[0].activity.last_conversion_date, '2026-10-01');
  for (const id of ['conversion_value_delivery', 'conversion_history_eligibility', 'provider_objective_acceptance'])
    assert.equal(out.data.dependencies.find(d => d.id === id).status, 'unknown');
  const requests = f.data.requests.length,
    saved = await call({action: 'create_from_recipe', recipe, business});
  assert.equal(saved.success, true);
  assert.equal(saved.data.state, 'draft');
  assert.equal(f.data.requests.length, requests);
  assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 0);
  const original = await call({action: 'get', id: saved.data.id, detail: 'full'});
  assert.equal(original.success, true);
  assert.equal(original.data.recipe.provenance.fields.target_roas.source, 'user');
  f.store.revokeKey(key);
  assert.equal((await call({action: 'recipe_eligibility', recipe, business, live: true})).success, false);
  assert.equal(f.data.requests.length, requests);
  assert.ok(bytes < 80000);
  t.diagnostic(
    JSON.stringify({
      journey: 'google-conversion-activity',
      tool_calls: calls,
      structured_response_bytes: bytes,
      synthetic_configuration_requests: requests,
      external_provider_requests: 0,
      provider_mutations: 0,
      qualification: 'real SDK; in-memory aggregate read fixture only',
    }),
  );
});

test('the real MCP SDK distinguishes current primary values from delivered value evidence without provider mutations', async t => {
  const f = valueInspectionFixture(t),
    key = f.store.createKey(f.actor),
    actor = f.store.authenticate(key),
    server = createMcpServer(f.service, actor),
    client = new Client({name: 'Synthetic value configuration evaluation', version: '1.0.0'}),
    [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const descriptor = (await client.listTools()).tools.find(x => x.name === 'amcp_campaign'),
    schema = new Ajv({strict: false}).compile(descriptor.inputSchema);
  let calls = 0,
    bytes = 0;
  const call = async args => {
    assert.equal(schema(args), true, JSON.stringify(schema.errors));
    const r = await client.callTool({name: 'amcp_campaign', arguments: args});
    calls++;
    bytes += Buffer.byteLength(JSON.stringify(r.structuredContent));
    assert.deepEqual(JSON.parse(r.content[0].text), JSON.parse(JSON.stringify(r.structuredContent)));
    assert.equal(r.isError === true, r.structuredContent.success === false);
    return r.structuredContent;
  };
  const recipe = 'google_search_target_roas',
    business = f.business;
  const discovery = await call({action: 'recipes'});
  assert.ok(discovery.data.recipes.some(r => r.id === recipe));
  const local = await call({action: 'recipe_eligibility', recipe, business});
  assert.equal(local.success, true);
  assert.equal(local.data.dependencies.find(d => d.id === 'conversion_value_configuration').status, 'unknown');
  assert.equal(f.data.requests.length, 0);
  const read = await call({action: 'recipe_eligibility', recipe, business, live: true});
  assert.equal(read.success, true, JSON.stringify(read));
  assert.equal(read.data.dependencies.find(d => d.id === 'conversion_value_configuration').status, 'ready');
  assert.deepEqual(read.data.conversion_goal_inspection.primary_actions[0].value_settings, {
    default_value: 7.25,
    default_currency_code: 'SAR',
    always_use_default_value: false,
  });
  for (const id of ['conversion_value_delivery', 'conversion_history_eligibility', 'provider_objective_acceptance'])
    assert.equal(read.data.dependencies.find(d => d.id === id).status, 'unknown');
  const before = f.data.requests.length,
    saved = await call({action: 'create_from_recipe', recipe, business});
  assert.equal(saved.success, true);
  assert.equal(saved.data.state, 'draft');
  assert.equal(f.data.requests.length, before);
  assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 0);
  f.store.revokeKey(key);
  assert.equal((await call({action: 'recipe_eligibility', recipe, business, live: true})).success, false);
  assert.equal(f.data.requests.length, before);
  assert.ok(bytes < 80000);
  t.diagnostic(
    JSON.stringify({
      journey: 'google-value-configuration',
      tool_calls: calls,
      structured_response_bytes: bytes,
      synthetic_configuration_requests: before,
      external_provider_requests: 0,
      provider_mutations: 0,
      qualification: 'real SDK; in-memory native read fixture only',
    }),
  );
});

test('the real MCP SDK discovers, explains and independently reviews both paused native value-bidding journeys', async t => {
  const {cpc_bid, ...search} = JSON.parse(
    readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'),
  ).recipe_business;
  for (const recipe of ['google_search_conversion_value', 'google_search_target_roas']) {
    const business = {
      ...search,
      conversion_goal_policy: 'ACCOUNT_DEFAULT',
      conversion_value_policy: 'ACCOUNT_RECORDED_VALUES',
      ...(recipe.endsWith('target_roas') ? {target_roas: '3.5'} : {}),
    };
    const f = googleSearchFixture(t, business, {native: true}),
      key = f.store.createKey(f.actor),
      server = createMcpServer(f.service, f.store.authenticate(key)),
      client = new Client({name: 'Synthetic Google value workflow evaluation', version: '1.0.0'}),
      [ct, st] = InMemoryTransport.createLinkedPair();
    t.after(async () => {
      await client.close();
      await server.close();
    });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const descriptor = (await client.listTools()).tools.find(x => x.name === 'amcp_campaign'),
      schema = new Ajv({strict: false}).compile(descriptor.inputSchema);
    const described = await fullDescription(client, 'amcp_campaign');
    assert.match(described, /Maximize Conversion Value/);
    assert.match(described, /3\.5 means 350%/);
    let calls = 0,
      bytes = 0;
    const call = async args => {
      assert.equal(schema(args), true, JSON.stringify(schema.errors));
      const out = await client.callTool({name: 'amcp_campaign', arguments: args});
      calls++;
      bytes += Buffer.byteLength(JSON.stringify(out.structuredContent));
      assert.deepEqual(JSON.parse(out.content[0].text), JSON.parse(JSON.stringify(out.structuredContent)));
      assert.equal(out.isError === true, out.structuredContent.success === false);
      return out.structuredContent;
    };
    const discovery = await call({action: 'recipes'});
    assert.equal(discovery.success, true);
    assert.ok(discovery.data.recipes.some(r => r.id === recipe));
    const context = await call({action: 'recipe_context', recipe});
    assert.equal(context.success, true);
    assert.ok(context.data.limitations.some(x => /delivered values, conversion history/.test(x)));
    const preview = await call({action: 'preview_recipe', recipe, business});
    assert.equal(preview.success, true, JSON.stringify(preview));
    assert.equal(preview.data.provider_mutations, 0);
    assert.equal(f.requests.length, 0);
    const inspection = await call({action: 'recipe_eligibility', recipe, business, live: true});
    assert.equal(inspection.success, true, JSON.stringify(inspection));
    assert.equal(inspection.data.status, 'unknown');
    for (const id of ['conversion_value_delivery', 'conversion_history_eligibility', 'provider_objective_acceptance'])
      assert.equal(inspection.data.dependencies.find(d => d.id === id).status, 'unknown');
    const saved = await call({action: 'create_from_recipe', recipe, business});
    assert.equal(saved.success, true, JSON.stringify(saved));
    assert.equal(saved.data.state, 'draft');
    assert.equal(f.mutations.length, 0);
    const full = await call({action: 'get', id: saved.data.id, detail: 'full'});
    assert.equal(full.data.recipe.provenance.fields.conversion_value_policy.source, 'user');
    for (let i = 0; i < 6; i++) {
      const p = await call({action: 'prepare_next', id: saved.data.id});
      assert.equal(p.success, true, JSON.stringify(p));
      assert.ok(p.data.review?.review_id);
      const r = await call({
        action: 'execute_next',
        id: saved.data.id,
        review_id: p.data.review.review_id,
        idempotency_key: p.data.review.review_id,
        confirmed: true,
        spend_change_confirmed: true,
      });
      assert.equal(r.success, true, JSON.stringify(r));
      assert.equal(r.data.current.status, 'verified');
    }
    const run = f.store.document(f.actor.tenantId, 'campaign_run', saved.data.id),
      native = [...f.resources.values()].find(r => r.kind === 'campaign').value;
    assert.equal(run.state, 'complete');
    assert.equal(native.status, 'PAUSED');
    assert.deepEqual(native.maximizeConversionValue, recipe.endsWith('target_roas') ? {targetRoas: 3.5} : {});
    assert.equal(f.mutations.length, 6);
    assert.doesNotMatch(
      JSON.stringify(f.mutations),
      /amcp_conversion_value|amcpConversionValue|conversionGoals|valueRules/,
    );
    const replay = await call({
      action: 'execute_next',
      id: run.id,
      review_id: run.steps.at(-1).review_id,
      confirmed: true,
      spend_change_confirmed: true,
    });
    assert.equal(replay.success, true, JSON.stringify(replay));
    assert.equal(f.mutations.length, 6);
    f.store.revokeKey(key);
    const before = f.requests.length,
      revoked = await call({action: 'recipe_eligibility', recipe, business, live: true});
    assert.equal(revoked.success, false);
    assert.equal(f.requests.length, before);
    assert.equal(f.mutations.length, 6);
    assert.ok(bytes < 256000, 'Keep one complete SDK journey bounded');
    t.diagnostic(
      JSON.stringify({
        journey: recipe,
        tool_calls: calls,
        structured_response_bytes: bytes,
        synthetic_provider_requests: f.requests.length,
        synthetic_native_mutations: f.mutations.length,
        external_provider_requests: 0,
        qualification: 'real SDK; in-memory native fixture only',
      }),
    );
  }
});

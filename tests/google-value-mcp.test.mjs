import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {googleSearchFixture} from './fixtures/google-search-recipe-data.mjs';

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
    assert.match(descriptor.description, /Maximize Conversion Value/);
    assert.match(descriptor.description, /3\.5 means 350%/);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {campaignRecipes, campaignRecipe} from '../dist/src/campaign-recipes.js';
import {campaignTool} from '../dist/src/campaign-runner.js';
import {mediaTool} from '../dist/src/media-upload.js';
import {recipeDependencies} from '../dist/src/capability-eligibility.js';
import {trafficBusiness} from './fixtures/snapchat-traffic-data.mjs';
import {leadBusiness} from './fixtures/snapchat-leads-data.mjs';
import fs from 'node:fs';
const actor = {tenantId: 'eligibility', userId: 'owner', role: 'admin'};
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 62).toString('base64'));
  const connection = {
    id: 'meta',
    tenantId: actor.tenantId,
    gateway: 'meta_native_action',
    accounts: ['100'],
    writeAccounts: ['100'],
    enabled: true,
    label: 'Synthetic Meta',
    scopes: ['ads_management'],
  };
  store.putConnection(actor, connection, {accessToken: 'synthetic'});
  let requests = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      requests++;
      return Response.json({id: 'act_100', currency: 'USD', timezone_name: 'UTC'});
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const call = input => service.call('amcp_workspace', input, actor);
  return {store, connection, call, requests: () => requests};
}
test('workflow detail resolves executable contract dependencies and an exact account without egress', async () => {
  const f = fixture();
  try {
    const r = await f.call({
      action: 'capabilities',
      view: 'graph',
      workflow_id: 'recipe:meta_website_traffic',
      account_id: '100',
      connection_id: 'meta',
    });
    assert.equal(r.success, true, JSON.stringify(r));
    // Graph version 3 resolves dependencies instead of the uniform requires_evidence placeholder (CON-03).
    assert.equal(r.data.version, 3);
    assert.equal(r.data.workflows.length, 1);
    const w = r.data.workflows[0];
    assert.equal(w.objective, 'website_traffic');
    assert.equal(w.contracts.length, 4);
    assert.ok(w.contracts.every(c => c.status === 'reviewed_write_family' && c.family && c.tests.length));
    assert.ok(
      w.dependencies.some(
        d =>
          d.id === 'media_receipt' &&
          d.status === 'needs_user_input' &&
          d.resolution === 'user_input' &&
          d.resolver_call.arguments.action === 'recipe_eligibility',
      ),
    );
    assert.deepEqual(
      w.lifecycle.map(s => s.stage),
      // CMP-03 adds the separate, gated activation stage after a launch is verified.
      ['eligibility', 'draft', 'preflight', 'review', 'execute', 'verify', 'recover', 'activate'],
    );
    assert.equal(w.accounts[0].provider_evidence.status, 'missing');
    assert.equal(w.accounts[0].next_call.arguments.connection_id, 'meta');
    assert.equal(w.live_qualification, 'unverified');
    assert.equal(f.requests(), 0);
    for (const edge of r.data.edges) {
      assert.ok(r.data.nodes.some(n => n.id === edge.from));
      assert.ok(r.data.nodes.some(n => n.id === edge.to));
    }
  } finally {
    f.store.close();
  }
});
test('graph dependencies follow compiled recipes and lifecycle actions remain executable', async () => {
  const f = fixture();
  try {
    const b = JSON.parse(
      fs.readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'),
    ).recipe_business;
    const briefs = {
      snapchat_website_traffic: trafficBusiness,
      snapchat_lead_generation: leadBusiness,
      google_search: b,
      google_search_clicks: {...b, cpc_bid: undefined, cpc_bid_ceiling: '1.250001'},
      google_search_conversions: {...b, cpc_bid: undefined, conversion_goal_policy: 'ACCOUNT_DEFAULT'},
      google_search_target_cpa: {
        ...b,
        cpc_bid: undefined,
        conversion_goal_policy: 'ACCOUNT_DEFAULT',
        target_cpa: '15.250001',
      },
      google_search_conversion_value: {
        ...b,
        cpc_bid: undefined,
        conversion_goal_policy: 'ACCOUNT_DEFAULT',
        conversion_value_policy: 'ACCOUNT_RECORDED_VALUES',
      },
      google_search_target_roas: {
        ...b,
        cpc_bid: undefined,
        conversion_goal_policy: 'ACCOUNT_DEFAULT',
        conversion_value_policy: 'ACCOUNT_RECORDED_VALUES',
        target_roas: '3.5',
      },
      microsoft_search: {...b, language: 'English'},
      meta_website_traffic: {
        name: 'Synthetic',
        account_id: '100',
        connection_id: 'meta',
        currency: 'USD',
        daily_budget: '50',
        country_codes: ['US'],
        page_id: '123',
        destination_url: 'https://example.com',
        message: 'Synthetic text',
        headline: 'Synthetic headline',
        drive_url: 'https://drive.google.com/file/d/syntheticFile123/view',
        special_ad_categories: [],
      },
    };
    for (const recipe of campaignRecipes) {
      assert.ok(recipeDependencies[recipe.id], 'Declare dependencies for ' + recipe.id);
      const brief = briefs[recipe.id] ?? {
        ...briefs.meta_website_traffic,
        pixel_id: '456',
        click_attribution_days: '7',
        view_attribution_days: '1',
      };
      // CMP-04: a Google recipe compiles to one build by default and to one step per resource with atomic: false;
      // the declared actions cover both.
      const compiled = (recipe.platform === 'google' ? [{atomic: true}, {atomic: false}] : [{}]).flatMap(
        variant => campaignRecipe(recipe.id, {...brief, ...variant}).steps,
      );
      assert.deepEqual(
        [...new Set(compiled.filter(s => s.kind === 'write').map(s => s.arguments.action))].sort(),
        [...recipeDependencies[recipe.id].actions].sort(),
      );
    }
    const graph = (await f.call({action: 'capabilities', view: 'graph'})).data;
    for (const w of graph.workflows)
      for (const step of w.lifecycle) {
        const tool = step.tool === 'amcp_campaign' ? campaignTool : step.tool === 'amcp_media' ? mediaTool : null;
        if (tool) assert.ok(tool.inputSchema.properties.action.enum.includes(step.action), JSON.stringify(step));
      }
  } finally {
    f.store.close();
  }
});
test('recorded scope, paused writes, filters and current revocation have concrete blockers', async () => {
  const f = fixture();
  try {
    f.store.putConnection(actor, {...f.connection, scopes: ['ads_read']}, {accessToken: 'synthetic'});
    let r = await f.call({action: 'capabilities', workflow_id: 'recipe:meta_website_traffic'});
    assert.ok(r.data.workflows[0].accounts[0].blockers.includes('provider_scope:ads_management'));
    await f.call({action: 'pause_writes', confirmed: true, reason: 'Synthetic maintenance'});
    r = await f.call({action: 'capabilities', workflow_id: 'recipe:meta_website_traffic'});
    assert.ok(r.data.workflows[0].accounts[0].blockers.includes('workspace_writes_paused'));
    for (const input of [
      {workflow_id: 'missing'},
      {workflow_id: 'recipe:meta_website_traffic', account_id: 'other'},
      {workflow_id: 'recipe:meta_website_traffic', account_id: '100', connection_id: 'other'},
    ]) {
      r = await f.call({action: 'capabilities', ...input});
      assert.equal(r.success, false, JSON.stringify(r));
    }
    assert.equal(f.requests(), 0);
  } finally {
    f.store.close();
  }
});
test('dated provider-read evidence expires and is invalidated on credential replacement', async t => {
  t.mock.timers.enable({apis: ['Date'], now: 1800000000000});
  const f = fixture();
  try {
    const checked = await f.call({
      action: 'check',
      connection_id: 'meta',
      account_id: '100',
      requirements: {write: true},
      live: true,
    });
    assert.equal(checked.success, true, JSON.stringify(checked));
    const input = {
      action: 'capabilities',
      view: 'graph',
      workflow_id: 'recipe:meta_website_traffic',
      connection_id: 'meta',
      account_id: '100',
    };
    let r = await f.call(input);
    assert.equal(r.data.workflows[0].accounts[0].provider_evidence.status, 'recent_account_read');
    assert.equal(r.data.workflows[0].live_qualification, 'unverified');
    t.mock.timers.tick(16 * 60000);
    r = await f.call(input);
    assert.equal(r.data.workflows[0].accounts[0].provider_evidence.status, 'stale');
    await f.call({action: 'check', connection_id: 'meta', account_id: '100', live: true});
    f.store.replaceCredentials(actor.tenantId, 'meta', {accessToken: 'replacement-synthetic'});
    r = await f.call(input);
    assert.equal(r.data.workflows[0].accounts[0].provider_evidence.status, 'missing');
    assert.equal(f.requests(), 2);
  } finally {
    f.store.close();
  }
});

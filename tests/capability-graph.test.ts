import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {capabilityGraph} from '../src/capability-graph.js';
import {campaignRecipes} from '../src/campaign-recipes.js';
import {mediaTool} from '../src/media-upload.js';
import {mediaPlatforms} from '../src/media-routing.js';
import {reportPresets} from '../src/report-presets.js';
import type {Actor} from '../src/types.js';

test('capabilities derive executable recipes, retain blockers and never grant execution from discovery', () => {
  const actor: Actor = {tenantId: 'capabilities', userId: 'viewer', role: 'reader'};
  const store = new Store(':memory:', Buffer.alloc(32, 92).toString('base64'));
  try {
    store.putConnection(
      {...actor, role: 'admin'},
      {
        id: 'meta',
        tenantId: actor.tenantId,
        gateway: 'meta_native_action',
        accounts: ['100'],
        writeAccounts: [],
        enabled: true,
        label: 'Synthetic',
        scopes: ['ads_read'],
      },
      {accessToken: 'synthetic'},
    );
    const graph = capabilityGraph(store, new Registry(), actor, true);
    assert.equal(graph.workflows.filter(w => w.kind === 'campaign_recipe').length, campaignRecipes.length);
    assert.equal(graph.workflows.filter(w => w.kind === 'media_upload').length, mediaPlatforms.length);
    assert.equal(graph.workflows.filter(w => w.kind === 'report_capture').length, reportPresets.length);
    for (const workflow of graph.workflows.filter(w => w.kind === 'media_upload'))
      assert.ok(mediaTool.inputSchema.properties.action.enum.includes(workflow.next_call.arguments.action));
    const recipe = graph.workflows.find(w => w.id === 'recipe:meta_website_traffic')!;
    assert.deepEqual(recipe.accounts[0]!.blockers, [
      'operator_required',
      'account_write_grant_required',
      'provider_scope:ads_management',
    ]);
    assert.equal(recipe.accounts[0]!.local_state, 'blocked');
    assert.equal(graph.network_requests, 0);
    assert.equal(recipe.live_qualification, 'unverified');
    assert.equal(graph.workflows.find(w => w.id === 'report:meta')!.accounts[0]!.local_state, 'ready_for_preflight');
    assert.equal(
      capabilityGraph(store, new Registry(), {...actor, tenantId: 'other'}, true).workflows.flatMap(w => w.accounts)
        .length,
      0,
    );
  } finally {
    store.close();
  }
});
test('dashboard respects the campaign engine’s actor ownership boundary', async () => {
  const actor: Actor = {tenantId: 'dashboard-scope', userId: 'operator', role: 'operator'};
  const store = new Store(':memory:', Buffer.alloc(32, 93).toString('base64'));
  try {
    store.ensureTenant(actor.tenantId);
    for (const id of ['own', 'other'])
      store.putDocument(actor.tenantId, 'campaign_run', id, {
        user_id: id === 'own' ? actor.userId : 'different',
        name: id,
        state: 'draft',
        steps: [],
      });
    const service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(async () => {
        throw Error('No egress');
      }),
    );
    // The whole record (the website Overview), the bounded section and the default summary all keep the boundary.
    const out = await service.call('amcp_workspace', {action: 'dashboard', view: 'full'}, actor);
    assert.equal(out.success, true);
    assert.deepEqual(
      out.data.campaigns.map((c: {id: string}) => c.id),
      ['own'],
    );
    const section = await service.call('amcp_workspace', {action: 'dashboard', sections: ['campaigns']}, actor);
    assert.deepEqual(
      section.data.sections.campaigns.items.map((c: {id: string}) => c.id),
      ['own'],
    );
    const summary = await service.call('amcp_workspace', {action: 'dashboard'}, actor);
    assert.deepEqual(summary.data.campaigns, {total: 1, by_state: {draft: 1}});
  } finally {
    store.close();
  }
});

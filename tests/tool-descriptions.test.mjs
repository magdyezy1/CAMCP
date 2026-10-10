import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';

test('every AMCP extension tool says when to use it rather than its neighbour', () => {
  const store = new Store(':memory:');
  try {
    const service = new MirrorService(new Registry(), store, undefined, undefined, {
      allowWrites: true,
      maxBudgetChange: 0,
      requireBeforeState: true,
    });
    const tools = Object.fromEntries(service.listTools().map(t => [t.name, t.description]));
    const neighbours = {
      amcp_write: /amcp_campaign/,
      amcp_campaign: /amcp_write/,
      amcp_reporting: /amcp_reporting_overview/,
      amcp_reporting_overview: /amcp_reporting\b/,
      amcp_workspace: /write contracts/,
      amcp_media: /Google Drive/,
      amcp_ad_previews: /amcp_media/,
    };
    for (const [name, neighbour] of Object.entries(neighbours)) {
      assert.match(tools[name], /^Use this /, name);
      assert.match(tools[name].split('. ')[0] + '. ' + tools[name].split('. ')[1], neighbour, name);
    }
    // The key defaults to the review id (batch 2); the description must not ask for it.
    assert.doesNotMatch(tools.amcp_write, /requires its review_id, idempotency_key/);
    assert.match(tools.amcp_write, /idempotency_key defaults to the review_id/);
    assert.match(tools.amcp_write, /execute_requirements/);
  } finally {
    store.close();
  }
});

test('native tool descriptions say what AMCP does where the captured text names tools or behaviour it does not have', async () => {
  const store = new Store(':memory:');
  try {
    const registry = new Registry(),
      service = new MirrorService(registry, store, undefined, undefined, {
        allowWrites: true,
        maxBudgetChange: 0,
        requireBeforeState: true,
      });
    // Amazon Ads is listed only where the deployment offers it (CON-06, AMCP_PROVIDERS=amazon); its description is
    // checked as such a deployment lists it.
    const previous = process.env.AMCP_PROVIDERS;
    process.env.AMCP_PROVIDERS = 'amazon';
    let listed;
    try {
      listed = service.listTools();
    } finally {
      if (previous === undefined) delete process.env.AMCP_PROVIDERS;
      else process.env.AMCP_PROVIDERS = previous;
    }
    const tools = Object.fromEntries(listed.map(t => [t.name, t]));
    const captured = Object.fromEntries(registry.data.tools.map(t => [t.name, t]));
    for (const name of ['meta_native_action', 'tiktok_native_action', 'snapchat_native_action']) {
      // The captured text stays first and verbatim; the note follows it.
      assert.ok(tools[name].description.startsWith(captured[name].description), name);
      assert.match(
        tools[name].description,
        /AMCP note: Its named tools are amcp_campaign .*amcp_write .*amcp_media .*amcp_reporting/,
        name,
      );
    }
    assert.match(tools.dv360_native_action.description, /There is no dv360_reporting_ops tool/);
    assert.match(tools.google_ads_native_action.description, /Requests go to Google Ads API v25/);
    for (const t of registry.data.tools.filter(t => t.mode === 'direct' && t.inputSchema.properties.dry_run))
      // The note said "whatever dry_run says", which was untrue for dry_run:false (it is refused, MCP-09).
      assert.match(
        tools[t.name].description,
        /Nothing is written from this tool: .*dry_run:false, a refusal whose next_call is amcp_write inspect/,
        t.name,
      );
    assert.match(
      tools.meta_native_action.description,
      /campaign, adset, creative, ad, assets, context, skip_preflight and override_preflight are refused unless false/,
    );
    assert.match(tools.snapchat_native_action.description, /skip_preflight is refused unless false/);
    assert.match(tools.dv360_native_action.description, /allowUnsupportedLineItemTypes is refused unless false/);
    assert.match(
      tools.amazon_native_action.description,
      /region, skip_preflight and override_preflight are refused unless false/,
    );
    // Help shows the same description; the listed schema is still the captured one.
    const help = registry.help({gateway: 'meta_native_action'}, {mode: 'strict', flags: {}});
    assert.equal(
      help.description,
      registry.listTools({mode: 'strict', flags: {}}).find(t => t.name === 'meta_native_action').description,
    );
    assert.ok(tools.meta_native_action.description.startsWith(help.description));
    assert.deepEqual(
      tools.meta_native_action.inputSchema.properties.skip_preflight,
      captured.meta_native_action.inputSchema.properties.skip_preflight,
    );
    // What the notes say is what AMCP does: a refused parameter is refused, and a write with dry_run false is not sent.
    const actor = {tenantId: 't', userId: 'u', role: 'admin'};
    const refused = await service.call(
      'meta_native_action',
      {action: 'meta_ad_account_id_campaigns_get', account_id: '123', skip_preflight: true},
      actor,
    );
    assert.equal(refused.error?.code, 'UNSUPPORTED_PARAMETER');
    const write = await service.call(
      'meta_native_action',
      {
        action: 'meta_ad_account_id_campaigns_post',
        account_id: '123',
        payload: {name: 'x', status: 'PAUSED'},
        dry_run: false,
        confirmed: true,
      },
      actor,
    );
    assert.equal(write.success, false, JSON.stringify(write).slice(0, 400));
    assert.notEqual(write.executed, true);
  } finally {
    store.close();
  }
});

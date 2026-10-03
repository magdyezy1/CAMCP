import test from 'node:test';
import assert from 'node:assert/strict';
import {campaignRecipe, campaignRecipes} from '../dist/src/campaign-recipes.js';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {readFileSync} from 'node:fs';
const business = {
  name: 'Synthetic conversion campaign',
  account_id: '100',
  connection_id: 'meta',
  currency: 'USD',
  daily_budget: '25.05',
  country_codes: ['US'],
  page_id: '123',
  pixel_id: '456',
  destination_url: 'https://example.com/offer',
  message: 'An explicit message',
  headline: 'An explicit headline',
  drive_url: 'https://drive.google.com/file/d/syntheticFile123/view',
  special_ad_categories: [],
  click_attribution_days: '7',
  view_attribution_days: '1',
  start_time: '2026-12-01T09:00:00+02:00',
};
test('guided conversion fields and enums remain in the pinned official v26 SDK contract', () => {
  const evidence = JSON.parse(readFileSync('tests/fixtures/meta-website-recipe-sdk-v26.json', 'utf8'));
  assert.equal(evidence.sdk_tag, '26.0.2');
  for (const recipe of ['meta_website_sales', 'meta_website_leads']) {
    const plan = campaignRecipe(recipe, business);
    const campaign = plan.steps.find(s => s.id === 'campaign').arguments.payload;
    const adset = plan.steps.find(s => s.id === 'adset').arguments.payload;
    for (const key of Object.keys(campaign)) assert.ok(key in evidence.campaign_create.params, key);
    for (const key of Object.keys(adset)) assert.ok(key in evidence.adset_create.params, key);
    assert.ok(evidence.objectives.includes(campaign.objective));
    assert.ok(evidence.optimization_goals.includes(adset.optimization_goal));
    assert.ok(evidence.billing_events.includes(adset.billing_event));
    assert.ok(evidence.destinations.includes(adset.destination_type));
    for (const key of Object.keys(adset.promoted_object)) assert.ok(evidence.promoted_fields.includes(key));
    assert.ok(evidence.conversion_events.includes(adset.promoted_object.custom_event_type));
  }
});
test('Meta purchase and website-lead recipes preserve explicit measurement, money and paused-parent dependencies', () => {
  for (const [id, objective, event] of [
    ['meta_website_sales', 'OUTCOME_SALES', 'PURCHASE'],
    ['meta_website_leads', 'OUTCOME_LEADS', 'LEAD'],
  ]) {
    assert.ok(campaignRecipes.some(r => r.id === id));
    const plan = campaignRecipe(id, business),
      byId = Object.fromEntries(plan.steps.map(s => [s.id, s]));
    assert.equal(byId.campaign.arguments.payload.objective, objective);
    assert.equal(byId.campaign.arguments.payload.status, 'PAUSED');
    assert.equal(byId.adset.arguments.payload.daily_budget, '2505');
    assert.equal(byId.adset.arguments.payload.optimization_goal, 'OFFSITE_CONVERSIONS');
    assert.equal(byId.adset.arguments.payload.destination_type, 'WEBSITE');
    assert.deepEqual(byId.adset.arguments.payload.promoted_object, {
      pixel_id: '456',
      custom_event_type: event,
      ...(event === 'LEAD' ? {page_id: '123'} : {}),
    });
    assert.deepEqual(byId.adset.arguments.payload.attribution_spec, [
      {event_type: 'CLICK_THROUGH', window_days: 7},
      {event_type: 'VIEW_THROUGH', window_days: 1},
    ]);
    assert.equal(byId.adset.arguments.payload.start_time, business.start_time);
    assert.deepEqual(byId.adset.arguments.payload.campaign_id, {$ref: 'campaign#/data/id'});
    assert.deepEqual(byId.ad.arguments.payload.creative, {creative_id: {$ref: 'creative#/data/id'}});
    assert.equal(plan.recipe.conversion_event, event);
    assert.equal(plan.steps.length, 5);
    assert.ok(plan.steps.every(s => s.expected_currency === 'USD'));
  }
});
test('conversion recipes refuse guessed pixels, attribution, regulated categories and invalid precision', () => {
  for (const overrides of [
    {pixel_id: undefined},
    {pixel_id: '0'},
    {pixel_id: 456},
    {pixel_id: '456/other'},
    {click_attribution_days: undefined},
    {click_attribution_days: '28'},
    {view_attribution_days: '7'},
    {special_ad_categories: ['HOUSING']},
    {daily_budget: '25.055'},
  ])
    assert.throws(() => campaignRecipe('meta_website_sales', {...business, ...overrides}));
  const plan = campaignRecipe('meta_website_sales', {...business, click_attribution_days: 1, view_attribution_days: 0});
  assert.deepEqual(plan.steps.find(s => s.id === 'adset').arguments.payload.attribution_spec, [
    {event_type: 'CLICK_THROUGH', window_days: 1},
  ]);
  assert.throws(() => campaignRecipe('meta_website_leads', {...business, end_time: '2026-11-01T00:00:00Z'}));
});
test('real campaign preflight and eligibility check the selected pixel and Page without any advertising mutation', async () => {
  const actor = {tenantId: 'conversion-recipes', userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 71).toString('base64'));
  const connection = {
    id: 'meta',
    tenantId: actor.tenantId,
    gateway: 'meta_native_action',
    accounts: ['100'],
    writeAccounts: ['100'],
    enabled: true,
    label: 'Synthetic',
    scopes: ['ads_management'],
  };
  store.putConnection(actor, connection, {accessToken: 'synthetic'});
  const requests = [];
  let pixelVisible = false;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      requests.push({url: String(url), method: init.method});
      assert.equal(init.method, 'GET');
      const p = new URL(url).pathname;
      if (p.endsWith('/adspixels')) return Response.json({data: pixelVisible ? [{id: '456'}] : []});
      if (p.endsWith('/promote_pages')) return Response.json({data: [{id: '123'}]});
      return Response.json({id: 'act_100', account_id: '100', currency: 'USD', timezone_name: 'UTC'});
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const realCall = service.call.bind(service);
  service.call = (tool, input, as) =>
    tool === 'amcp_media'
      ? Promise.resolve({success: true, data: {sha256: 'synthetic', size_bytes: 100}})
      : realCall(tool, input, as);
  try {
    for (const recipe of ['meta_website_sales', 'meta_website_leads']) {
      const local = await realCall('amcp_campaign', {action: 'recipe_eligibility', recipe, business}, actor);
      assert.equal(local.success, true, JSON.stringify(local));
      assert.equal(local.data.dependencies.find(d => d.id === 'account_owned_pixel').status, 'unknown');
      assert.deepEqual(local.data.dependencies.find(d => d.id === 'attribution_window').evidence.windows, [
        {event_type: 'CLICK_THROUGH', window_days: 7},
        {event_type: 'VIEW_THROUGH', window_days: 1},
      ]);
      const created = await realCall('amcp_campaign', {action: 'create_from_recipe', recipe, business}, actor);
      assert.equal(created.success, true, JSON.stringify(created));
      pixelVisible = false;
      const blocked = await realCall('amcp_campaign', {action: 'preflight', id: created.data.id}, actor);
      assert.equal(blocked.data.blocked, true, JSON.stringify(blocked));
      assert.ok(blocked.data.missing_requirements.some(r => r.error.code === 'CAMPAIGN_PREREQUISITE_REQUIRED'));
      pixelVisible = true;
      const eligibility = await realCall(
        'amcp_campaign',
        {action: 'recipe_eligibility', recipe, business, live: true},
        actor,
      );
      assert.equal(eligibility.success, true, JSON.stringify(eligibility));
      assert.equal(eligibility.data.status, 'unknown');
      assert.equal(eligibility.data.dependencies.find(d => d.id === 'account_owned_pixel').evidence.asset_id, '456');
      assert.equal(eligibility.data.dependencies.find(d => d.id === 'page_identity').evidence.asset_id, '123');
      assert.equal(eligibility.data.dependencies.find(d => d.id === 'conversion_event_delivery').status, 'unknown');
      assert.equal(eligibility.data.dependencies.find(d => d.id === 'media_receipt').status, 'unknown');
      assert.equal(eligibility.data.provider_mutations, 0);
      const checked = await realCall('amcp_campaign', {action: 'preflight', id: created.data.id}, actor);
      assert.equal(checked.data.blocked, false, JSON.stringify(checked));
    }
    assert.ok(requests.some(r => r.url.includes('/adspixels')));
    assert.ok(requests.some(r => r.url.includes('/promote_pages')));
    store.putConnection(actor, {...connection, enabled: false}, {accessToken: 'synthetic'});
    const before = requests.length;
    const denied = await realCall(
      'amcp_campaign',
      {action: 'create_from_recipe', recipe: 'meta_website_sales', business},
      actor,
    );
    assert.equal(denied.success, false);
    assert.equal(requests.length, before);
  } finally {
    store.close();
  }
});

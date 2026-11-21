import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {errorResult} from '../dist/src/errors.js';
import {Registry} from '../dist/src/catalog.js';
import {Compiler} from '../dist/src/compiler.js';
import {applyExecutionRisk} from '../dist/src/execution-risk.js';
import {assertWriteShape} from '../dist/src/write-shape.js';
import {campaignRecipe} from '../dist/src/campaign-recipes.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {
  assertDeprecationRegistry,
  deprecationClock,
  deprecationEffective,
  deprecationNow,
  deprecationStatus,
  providerDeprecation,
  setDeprecationClock,
} from '../dist/src/provider-deprecations.js';
import {pinBeforeTiktokCutoff} from './helpers/tiktok-cutoff-clock.mjs';
import {
  tiktokCutoffObjectives,
  tiktokCutoffVirtualObjectives,
  tiktokManualCutoffClone,
  tiktokManualCutoffPrerequisites,
} from '../dist/src/tiktok-manual-cutoff.js';
import {tiktokConversionContext, tiktokTrafficContext} from '../dist/src/tiktok-launch-recipes.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {advertiserWorld} from './helpers/tiktok-advertiser-noise.mjs';
import {standardBodies, standardCreates} from './helpers/tiktok-standard-creates.mjs';
import smartPlusCampaigns from './family-descriptors/tiktok-smart-plus-campaigns.mjs';
import smartPlusAdgroups from './family-descriptors/tiktok-smart-plus-adgroups.mjs';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';

/**
 * Package r25-m4-classic (Round 2.5, M4; the lead's decision L2, 2026-11-20): from 2027-01-01 TikTok's classic create routes stop creating
 * non-Search Legacy Manual Flow campaigns, or ad groups or ads under them, for the Sales, App Promotion and Lead Generation objectives
 * (the banner of "Create ads", https://business-api.tiktok.com/portal/docs/create-ads/v1.3, read 2026-11-19). AMCP refuses what TikTok
 * will refuse from that day, before any request, on the dated provider deprecation registry (PRV-04): a classic campaign create (at
 * inspect, prepare and execute), an ad group create under such a classic campaign (from the parent read), the website purchases pack's
 * compile and a clone of such a source. An ad create is left to TikTok's own refusal. Traffic and every Search campaign survive.
 *
 * The lead's documentation session (2026-11-20, impl/r25-m4-DOCS-EVIDENCE.md section 1) settled the objectives: Sales is WEB_CONVERSIONS or
 * PRODUCT_SALES (named with or without virtual_objective_type SALES; both forms are refused), plus APP_PROMOTION and LEAD_GENERATION; the banner
 * names five endpoints, the campaign copy task among them, and says "non-Search Legacy Manual Flow", so a Search campaign and a campaign whose row
 * reads UPGRADED_SMART_PLUS are not refused. It states no time zone: the entry refuses from 00:00 UTC, at most hours early. O1 (owner,
 * 2026-11-20): yes. Every test sets its own clock, and the clock is restored after each.
 */
const ID = 'tiktok_manual_sales_app_lead_creates';
const lastSecond = '2026-12-31T23:59:59Z',
  firstSecond = '2027-01-01T00:00:00Z';
const clock = iso => setDeprecationClock(() => Date.parse(iso));
// The clock found at the start is the one given back, not the real one: under the clock probe of the M4a merge (every file on the day after the cut-off)
// a test that sets none of its own then still runs on the clock it was run on (the lead's review S4-3).
const clockFound = deprecationClock();
afterEach(() => setDeprecationClock(clockFound));

// ---- Part one: the stateless refusal of a campaign create, as every stage that checks the shape sees it -----------------------------
const registry = new Registry(),
  compiler = new Compiler(registry),
  options = {mode: 'strict', flags: {}};
const gateway = 'tiktok_native_action';
const compile = (action, payload) =>
  applyExecutionRisk(compiler.compile(gateway, {action, account_id: '123', payload, dry_run: true}, options));
const campaign = fields => {
  const {action, payload} = standardBodies('123').campaign;
  return compile(action, {...structuredClone(payload), ...fields});
};
const shapeRefusal = plan => {
  try {
    assertWriteShape(plan);
    return undefined;
  } catch (e) {
    return e;
  }
};
/**
 * What replaces a refused create, by objective (the lead's review S3-1; AMCP's Upgraded Smart+ campaign create takes WEB_CONVERSIONS with
 * sales_destination WEBSITE and LEAD_GENERATION, src/tiktok-smart-plus-campaigns.ts): only a route AMCP has is named. A website Sales campaign
 * (WEB_CONVERSIONS, or the virtual Sales type with sales_destination WEBSITE or none) is sent to the Smart+ create and the website purchases pack;
 * Lead Generation to the Smart+ create; App Promotion, Product Sales and a Sales campaign with another destination are told that there is no such
 * route yet, with no use_action.
 */
const smartPlusCreate = 'tiktok_smart_plus_campaign_create',
  smartPlusPack = 'tiktok_smart_plus_website_conversions',
  noRoute = 'AMCP has no Upgraded Smart+ route for this objective yet; create it in TikTok Ads Manager';
const replacementOf = {
  website: {use_action: smartPlusCreate, use_recipe: smartPlusPack},
  lead: {use_action: smartPlusCreate},
  none: {},
};
function assertReplacement(e, route, what) {
  const expected = replacementOf[route];
  assert.equal(e.details.use_action, expected.use_action, what + ': use_action');
  assert.equal(e.details.use_recipe, expected.use_recipe, what + ': use_recipe');
  assert.equal(
    e.message.includes(smartPlusCreate),
    expected.use_action !== undefined,
    what + ': the message names the route only if AMCP has it',
  );
  assert.equal(
    e.message.includes(smartPlusPack),
    expected.use_recipe !== undefined,
    what + ': the message names the pack only if it fits',
  );
  assert.equal(e.message.includes(noRoute), route === 'none', what + ': the message says there is no route');
}
const salesCampaigns = [
  ['WEB_CONVERSIONS', {objective_type: 'WEB_CONVERSIONS'}, 'website'],
  ['PRODUCT_SALES', {objective_type: 'PRODUCT_SALES'}, 'none'],
  [
    'PRODUCT_SALES named with the virtual Sales type',
    {objective_type: 'PRODUCT_SALES', virtual_objective_type: 'SALES', sales_destination: 'TIKTOK_SHOP'},
    'none',
  ],
  ['APP_PROMOTION', {objective_type: 'APP_PROMOTION', app_promotion_type: 'APP_INSTALL'}, 'none'],
  ['LEAD_GENERATION', {objective_type: 'LEAD_GENERATION'}, 'lead'],
  [
    'the Sales objective named by its virtual type',
    {objective_type: 'WEB_CONVERSIONS', virtual_objective_type: 'SALES', sales_destination: 'WEBSITE'},
    'website',
  ],
  ['the virtual Sales type alone', {objective_type: 'TRAFFIC', virtual_objective_type: 'SALES'}, 'website'],
  [
    'the virtual Sales type with an app destination',
    {objective_type: 'TRAFFIC', virtual_objective_type: 'SALES', sales_destination: 'APP'},
    'none',
  ],
  // The Smart+ create takes a website destination only, so a Sales body that names another is not sent to it.
  ['WEB_CONVERSIONS with an app destination', {objective_type: 'WEB_CONVERSIONS', sales_destination: 'APP'}, 'none'],
];
for (const [what, fields, route] of salesCampaigns)
  test(
    'a classic ' + what + ' campaign create is accepted until the last second of 2026 UTC and refused from 2027-01-01',
    () => {
      const plan = campaign(fields);
      clock(lastSecond);
      assert.equal(shapeRefusal(plan), undefined, 'the day before, nothing refuses it early');
      clock(firstSecond);
      const e = shapeRefusal(plan);
      assertRefused(e, 'PROVIDER_DEPRECATED');
      assert.equal(e.details.deprecation, ID);
      assert.equal(e.details.provider, 'tiktok');
      assert.equal(e.details.effective_date, '2027-01-01');
      assert.match(e.details.source, /^https:\/\/business-api\.tiktok\.com\/portal\/docs\//);
      // The replacement named is one AMCP has, for this objective (S3-1).
      assertReplacement(e, route, what);
    },
  );

test('what the cut-off leaves alone: Traffic, a Search campaign of any objective, every Smart+ route and an objective it does not list', () => {
  clock(firstSecond);
  for (const [what, fields] of [
    ['a Traffic campaign', {objective_type: 'TRAFFIC'}],
    ['a Search campaign with the Sales objective', {objective_type: 'WEB_CONVERSIONS', is_search_campaign: true}],
    [
      'a Search campaign with the Lead Generation objective',
      {objective_type: 'LEAD_GENERATION', is_search_campaign: true},
    ],
    [
      'a Search campaign that names the virtual Sales type',
      {objective_type: 'TRAFFIC', virtual_objective_type: 'SALES', is_search_campaign: true},
    ],
    ['a Reach campaign', {objective_type: 'REACH'}],
  ])
    assert.equal(shapeRefusal(campaign(fields)), undefined, what);
  // A search flag that is not the boolean true is not a Search campaign: the request is read as TikTok documents it.
  assertRefused(
    shapeRefusal(campaign({objective_type: 'WEB_CONVERSIONS', is_search_campaign: 'true'})),
    'PROVIDER_DEPRECATED',
  );
  assertRefused(
    shapeRefusal(campaign({objective_type: 'WEB_CONVERSIONS', is_search_campaign: false})),
    'PROVIDER_DEPRECATED',
  );
  // The Upgraded Smart+ routes are not the banner's routes, whatever objective they carry.
  for (const d of [smartPlusCampaigns, smartPlusAdgroups])
    assert.equal(
      shapeRefusal(compile(d.request.action, {advertiser_id: '123', ...structuredClone(d.request.payload)})),
      undefined,
      d.request.action,
    );
  assert.equal(
    smartPlusCampaigns.request.payload.objective_type,
    'WEB_CONVERSIONS',
    'the Smart+ create carries the objective the classic one is refused for',
  );
});

test('the refusal comes before any request, at inspect and prepare, and is made again at execute for a review prepared the day before', async () => {
  clock(firstSecond);
  const refused = standardCreates(advertiserWorld({rotating: false}), {tenant: 'cutoff-inspect'});
  try {
    const bodies = standardBodies(refused.world.id);
    const sales = {...bodies.campaign.payload, objective_type: 'WEB_CONVERSIONS'};
    const inspected = await refused.write({
      action: 'inspect',
      arguments: {action: 'tiktok_campaign_create', account_id: refused.world.id, payload: sales},
    });
    assert.equal(inspected.data.review_contract_supported, false);
    assert.equal(inspected.data.error.code, 'PROVIDER_DEPRECATED');
    assertRefused(
      await refused.prepare('campaign', p => ({...p, objective_type: 'WEB_CONVERSIONS'})),
      'PROVIDER_DEPRECATED',
      {
        writes: () => refused.sent.length,
      },
    );
    assert.deepEqual(refused.requests, [], 'not one request was made');
    // Traffic is prepared on the same day.
    assert.equal((await refused.prepare('campaign')).success, true);
  } finally {
    refused.close();
  }
  const f = standardCreates(advertiserWorld({rotating: false}), {tenant: 'cutoff-execute'});
  try {
    clock(lastSecond);
    const p = await f.prepare('campaign', body => ({...body, objective_type: 'WEB_CONVERSIONS'}));
    assert.equal(p.success, true, JSON.stringify(p.error ?? p.data).slice(0, 400));
    clock(firstSecond);
    assertRefused(await f.execute(p.data), 'PROVIDER_DEPRECATED', {writes: () => f.sent.length});
    clock(lastSecond);
    assert.equal((await f.execute(p.data)).success, true, 'the same review is sent while the day has not come');
    assert.equal(f.sent.length, 1);
  } finally {
    f.close();
  }
});

// ---- Part two: an ad group create under a classic campaign, from the parent read ---------------------------------------------------
async function groupUnder(campaignRow, {on = firstSecond, tenant = 'cutoff-group'} = {}) {
  let row = campaignRow;
  const f = standardCreates(advertiserWorld({rotating: false}), {
    tenant,
    parentExtra: kind => (kind === 'campaign' ? row : {}),
  });
  clock(on);
  return {f, set: next => (row = next)};
}
test('an ad group create under a classic Sales, App Promotion or Lead Generation campaign is refused from 2027-01-01, after its campaign read', async () => {
  for (const [objective, route] of [
    ['WEB_CONVERSIONS', 'website'],
    ['PRODUCT_SALES', 'none'],
    ['APP_PROMOTION', 'none'],
    ['LEAD_GENERATION', 'lead'],
  ]) {
    const {f} = await groupUnder({objective_type: objective});
    try {
      clock(lastSecond);
      assert.equal((await f.prepare('adgroup')).success, true, objective + ' the day before');
      clock(firstSecond);
      const r = await f.prepare('adgroup');
      assertRefused(r, 'PROVIDER_DEPRECATED', {writes: () => f.sent.length});
      assert.equal(r.error.details.deprecation, ID, objective);
      assert.equal(r.error.details.campaign_id, '300', objective);
      assert.equal(r.error.details.objective_type, objective, objective);
      // The replacement named is one AMCP has, for this objective (S3-1).
      assertReplacement(r.error, route, objective);
      assert.ok(
        f.requests.some(q => q === 'GET /v1.3/campaign/get/'),
        'the campaign was read: ' + f.requests.join(', '),
      );
    } finally {
      f.close();
    }
  }
  // The virtual Sales type is a website Sales campaign unless its row names another destination (S3-1).
  for (const [what, row, route] of [
    ['the virtual Sales type alone', {virtual_objective_type: 'SALES'}, 'website'],
    [
      'the virtual Sales type with a website destination',
      {virtual_objective_type: 'SALES', sales_destination: 'WEBSITE'},
      'website',
    ],
    [
      'the virtual Sales type with an app destination',
      {virtual_objective_type: 'SALES', sales_destination: 'APP'},
      'none',
    ],
  ]) {
    const {f} = await groupUnder(row);
    try {
      const r = await f.prepare('adgroup');
      assertRefused(r, 'PROVIDER_DEPRECATED', {writes: () => f.sent.length});
      assertReplacement(r.error, route, what);
    } finally {
      f.close();
    }
  }
});

test('the ad group of a Traffic or Search campaign, a legacy Smart+ campaign or a row that names no objective is not refused', async () => {
  for (const [what, row] of [
    ['a Traffic campaign', {objective_type: 'TRAFFIC'}],
    ['a Search campaign with the Sales objective', {objective_type: 'WEB_CONVERSIONS', is_search_campaign: true}],
    ['a legacy Smart+ campaign', {objective_type: 'WEB_CONVERSIONS', campaign_automation_type: 'SMART_PLUS'}],
    ['a row that names no objective', {}],
    ['a row that names an objective the cut-off does not list', {objective_type: 'REACH'}],
  ]) {
    const {f} = await groupUnder(row, {tenant: 'cutoff-group-survivors'});
    try {
      const p = await f.prepare('adgroup');
      assert.equal(p.success, true, what + ': ' + JSON.stringify(p.error ?? p.data).slice(0, 300));
    } finally {
      f.close();
    }
  }
  // The classic route's own refusal of a campaign of Upgraded Smart+ comes first and is not the deprecation (the twin of #2).
  const {f} = await groupUnder({objective_type: 'WEB_CONVERSIONS', campaign_automation_type: 'UPGRADED_SMART_PLUS'});
  try {
    assertRefused(await f.prepare('adgroup'), 'TIKTOK_SMART_PLUS_ROUTE_REQUIRED', {writes: () => f.sent.length});
  } finally {
    f.close();
  }
  // A campaign that says MANUAL is a manual campaign: refused like one that says nothing.
  const manual = await groupUnder({objective_type: 'WEB_CONVERSIONS', campaign_automation_type: 'MANUAL'});
  try {
    assertRefused(await manual.f.prepare('adgroup'), 'PROVIDER_DEPRECATED', {writes: () => manual.f.sent.length});
  } finally {
    manual.f.close();
  }
});

test('an ad group review prepared the day before is refused when it is executed from 2027-01-01', async () => {
  const {f} = await groupUnder({objective_type: 'WEB_CONVERSIONS'}, {on: lastSecond, tenant: 'cutoff-group-execute'});
  try {
    const p = await f.prepare('adgroup');
    assert.equal(p.success, true, JSON.stringify(p.error ?? p.data).slice(0, 300));
    clock(firstSecond);
    assertRefused(await f.execute(p.data), 'PROVIDER_DEPRECATED', {writes: () => f.sent.length});
  } finally {
    f.close();
  }
});

test('an ad create is never refused by the cut-off, and a classic child under a serving parent asks for the spend flag (merge 6: it was PARENT_SERVING)', async () => {
  const world = advertiserWorld({rotating: false});
  const f = standardCreates(world, {
    tenant: 'cutoff-ad',
    parentExtra: () => ({objective_type: 'WEB_CONVERSIONS'}),
  });
  try {
    clock(firstSecond);
    // Its campaign and its ad group name the Sales objective: TikTok's own refusal of the ad create applies nothing, and M2 records it.
    const p = await f.prepare('ad');
    assert.equal(p.success, true, JSON.stringify(p.error ?? p.data).slice(0, 300));
    f.parents.campaign = 'ENABLE';
    f.parents.adgroup = 'ENABLE';
    // Merge r25-m4a-merge, merge 6 (r25-m4-smartops, Q1, owner 2026-11-15): under parents it reads serving an enabled ad prepares and asks for
    // spend_change_confirmed (it was PARENT_SERVING); the cut-off never refuses an ad create, serving parent or not.
    const serving = await f.prepare('ad', body => ({
      ...body,
      creatives: [{...body.creatives[0], operation_status: 'ENABLE'}],
    }));
    assert.equal(serving.success, true, JSON.stringify(serving.error ?? serving.data).slice(0, 300));
    assert.equal(serving.data.execute_requirements.spend_change_confirmed, true);
    assert.equal(f.sent.length, 0);
  } finally {
    f.close();
  }
  const traffic = standardCreates(world, {tenant: 'cutoff-serving', parentExtra: () => ({objective_type: 'TRAFFIC'})});
  try {
    clock(firstSecond);
    traffic.parents.campaign = 'ENABLE';
    const servingGroup = await traffic.prepare('adgroup', body => ({...body, operation_status: 'ENABLE'}));
    assert.equal(servingGroup.success, true, JSON.stringify(servingGroup.error ?? servingGroup.data).slice(0, 300));
    assert.equal(
      servingGroup.data.execute_requirements.spend_change_confirmed,
      true,
      'a Traffic ad group under a serving campaign asks for the flag',
    );
    assert.equal(traffic.sent.length, 0);
  } finally {
    traffic.close();
  }
});

// ---- Part three: the website purchases pack --------------------------------------------------------------------------------------------
const trafficBusiness = {
  name: 'Synthetic TikTok launch',
  account_id: '7001',
  connection_id: '17171717-1717-4171-8171-171717171717',
  currency: 'USD',
  daily_budget: '25.50',
  location_ids: ['6252001', '102358'],
  tiktok_item_id: '7300000000000000001',
  identity_type: 'TT_USER',
  identity_id: 'tt-identity-1',
  destination_url: 'https://example.com/tiktok-landing',
  call_to_action: 'LEARN_MORE',
  start_time: '2027-01-15T10:00:00+03:00',
};
const conversionBusiness = {...trafficBusiness, pixel_id: '8800', optimization_event: 'SHOPPING'};

test('the website purchases pack compiles until the last second of 2026 UTC and is refused from 2027-01-01, naming the Smart+ pack; the traffic pack still compiles', () => {
  clock(lastSecond);
  const plan = campaignRecipe('tiktok_website_conversions', conversionBusiness);
  assert.equal(plan.steps[0].arguments.payload.objective_type, 'WEB_CONVERSIONS');
  clock(firstSecond);
  let e;
  try {
    campaignRecipe('tiktok_website_conversions', conversionBusiness);
  } catch (error) {
    e = error;
  }
  assertRefused(e, 'PROVIDER_DEPRECATED');
  assert.equal(e.details.deprecation, ID);
  assert.equal(e.details.use_recipe, 'tiktok_smart_plus_website_conversions');
  assert.equal(e.details.recipe, 'tiktok_website_conversions');
  assert.match(e.message, /tiktok_smart_plus_website_conversions/);
  // The refusal comes before any input is read: a brief that is also wrong is told about the pack first.
  assertRefused(
    (() => {
      try {
        campaignRecipe('tiktok_website_conversions', {...conversionBusiness, name: ' '});
      } catch (error) {
        return error;
      }
    })(),
    'PROVIDER_DEPRECATED',
  );
  const traffic = campaignRecipe('tiktok_website_traffic', trafficBusiness);
  assert.equal(traffic.steps[0].arguments.payload.objective_type, 'TRAFFIC');
});

test('through amcp_campaign, preview_recipe, create_from_recipe and recipe_eligibility refuse the purchases pack from 2027-01-01 with no request, and the traffic pack is previewed', async () => {
  const actor = {tenantId: 'cutoff-recipes', userId: 'owner', role: 'admin'};
  const store = new Store(':memory:', Buffer.alloc(32, 77).toString('base64'));
  store.putConnection(
    actor,
    {
      id: trafficBusiness.connection_id,
      tenantId: actor.tenantId,
      gateway,
      accounts: ['7001'],
      writeAccounts: ['7001'],
      enabled: true,
      label: 'TikTok login',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const requests = [];
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (raw, init = {}) => {
      requests.push((init.method ?? 'GET') + ' ' + new URL(String(raw)).pathname);
      throw new Error('No request is expected');
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  try {
    const call = input => service.call('amcp_campaign', input, actor);
    clock(lastSecond);
    const open = await call({
      action: 'preview_recipe',
      recipe: 'tiktok_website_conversions',
      business: conversionBusiness,
    });
    assert.equal(open.success, true, JSON.stringify(open).slice(0, 500));
    clock(firstSecond);
    for (const action of ['preview_recipe', 'create_from_recipe', 'recipe_eligibility']) {
      const r = await call({action, recipe: 'tiktok_website_conversions', business: conversionBusiness});
      assertRefused(r, 'PROVIDER_DEPRECATED', {writes: () => requests.length});
      assert.equal(r.error.details.use_recipe, 'tiktok_smart_plus_website_conversions', action);
    }
    assert.equal(store.documents(actor.tenantId, 'campaign_run').length, 0, 'no plan was saved');
    const traffic = await call({action: 'preview_recipe', recipe: 'tiktok_website_traffic', business: trafficBusiness});
    assert.equal(traffic.success, true, JSON.stringify(traffic).slice(0, 500));
    assert.deepEqual(requests, []);
  } finally {
    store.close();
  }
});
test('the pack’s context says, without a clock, that TikTok stops manual website purchase campaigns on 2027-01-01 and which pack to use', () => {
  const sentence =
    'TikTok stops manual website purchase campaigns on 2027-01-01; use tiktok_smart_plus_website_conversions.';
  for (const iso of [lastSecond, firstSecond, '2026-11-20T00:00:00Z']) {
    clock(iso);
    assert.ok(tiktokConversionContext.limitations.includes(sentence), iso);
  }
  // The traffic pack is not affected by the banner, and was said to have nothing about 2027 in its context here. It now carries a notice of what
  // TikTok's migration guide says, which is wider (the lead's added item, 2026-11-21): the notice is pinned by its own test below, and the pack is
  // still not refused.
});

// ---- The banner says "non-Search Legacy Manual Flow" (the documentation session, 2026-11-20): what is not that flow is not refused -------------
/** The reference campaign the lead read live: a Smart+ Search campaign, which "Get campaigns" lists with its automation type (synthetic IDs). */
const smartPlusSearchRow = {
  campaign_automation_type: 'UPGRADED_SMART_PLUS',
  is_search_campaign: true,
  objective_type: 'TRAFFIC',
  operation_status: 'DISABLE',
  budget_mode: 'BUDGET_MODE_INFINITE',
};
const refusal = fn => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e;
  }
};

test('a Search campaign is never refused by the cut-off, whatever its objective: not at a campaign create, an ad group create or a clone', async () => {
  clock(firstSecond);
  // A campaign create: Search with each covered objective, and with the virtual Sales type.
  for (const objective of tiktokCutoffObjectives)
    assert.equal(shapeRefusal(campaign({objective_type: objective, is_search_campaign: true})), undefined, objective);
  assert.equal(
    shapeRefusal(
      campaign({objective_type: 'WEB_CONVERSIONS', virtual_objective_type: 'SALES', is_search_campaign: true}),
    ),
    undefined,
  );
  // An ad group create under a Search campaign whose row says MANUAL, and under the reference row.
  for (const row of [
    {objective_type: 'WEB_CONVERSIONS', is_search_campaign: true, campaign_automation_type: 'MANUAL'},
    {objective_type: 'LEAD_GENERATION', is_search_campaign: true, campaign_automation_type: 'MANUAL'},
  ]) {
    const {f} = await groupUnder(row, {tenant: 'cutoff-search'});
    try {
      const p = await f.prepare('adgroup');
      assert.equal(p.success, true, JSON.stringify(row) + ': ' + JSON.stringify(p.error ?? p.data).slice(0, 300));
    } finally {
      f.close();
    }
  }
  // The functions themselves, for a campaign row of any objective that is a Search campaign.
  const plan = {gateway, method: 'POST', path: '/v1.3/adgroup/create/', body: {campaign_id: '300'}, accountId: '123'};
  for (const objective of tiktokCutoffObjectives) {
    const row = {
      campaign_id: '300',
      objective_type: objective,
      is_search_campaign: true,
      campaign_automation_type: 'MANUAL',
    };
    assert.equal(
      refusal(() => tiktokManualCutoffPrerequisites(plan, [{data: {list: [row]}}])),
      undefined,
      objective,
    );
    assert.equal(
      refusal(() => tiktokManualCutoffClone(row)),
      undefined,
      objective,
    );
  }
});

test('a campaign whose row reads UPGRADED_SMART_PLUS or SMART_PLUS is never refused by the cut-off: its own route and clone refusals stand', async () => {
  clock(firstSecond);
  const plan = {gateway, method: 'POST', path: '/v1.3/adgroup/create/', body: {campaign_id: '300'}, accountId: '123'};
  // The functions: not for any covered objective under another flow, and not for the Smart+ Search reference campaign the lead read.
  for (const type of ['UPGRADED_SMART_PLUS', 'SMART_PLUS'])
    for (const objective of tiktokCutoffObjectives) {
      const row = {campaign_id: '300', objective_type: objective, campaign_automation_type: type};
      assert.equal(
        refusal(() => tiktokManualCutoffPrerequisites(plan, [{data: {list: [row]}}])),
        undefined,
        type + ' ' + objective,
      );
      assert.equal(
        refusal(() => tiktokManualCutoffClone(row)),
        undefined,
        type + ' ' + objective,
      );
    }
  const reference = {campaign_id: '300', ...smartPlusSearchRow};
  assert.equal(
    refusal(() => tiktokManualCutoffPrerequisites(plan, [{data: {list: [reference]}}])),
    undefined,
  );
  assert.equal(
    refusal(() => tiktokManualCutoffClone(reference)),
    undefined,
  );
  // The same rows are refused as manual ones are: MANUAL, and a row that names no type.
  for (const type of ['MANUAL', undefined]) {
    const row = {
      campaign_id: '300',
      objective_type: 'WEB_CONVERSIONS',
      ...(type ? {campaign_automation_type: type} : {}),
    };
    assertRefused(
      refusal(() => tiktokManualCutoffPrerequisites(plan, [{data: {list: [row]}}])),
      'PROVIDER_DEPRECATED',
    );
    assertRefused(
      refusal(() => tiktokManualCutoffClone(row)),
      'PROVIDER_DEPRECATED',
    );
  }
  // Through the review: an ad group create under the Upgraded Smart+ reference campaign meets the route refusal, not the deprecation,
  // and under a legacy Smart+ campaign it prepares.
  const upgraded = await groupUnder(smartPlusSearchRow, {tenant: 'cutoff-upgraded'});
  try {
    const r = await upgraded.f.prepare('adgroup');
    assertRefused(r, 'TIKTOK_SMART_PLUS_ROUTE_REQUIRED', {writes: () => upgraded.f.sent.length});
    assert.equal(r.error.details.deprecation, undefined, 'the deprecation is not what refused it');
  } finally {
    upgraded.f.close();
  }
  const legacy = await groupUnder(
    {objective_type: 'LEAD_GENERATION', campaign_automation_type: 'SMART_PLUS'},
    {tenant: 'cutoff-legacy-smart-plus'},
  );
  try {
    const p = await legacy.f.prepare('adgroup');
    assert.equal(p.success, true, JSON.stringify(p.error ?? p.data).slice(0, 300));
  } finally {
    legacy.f.close();
  }
});

// ---- Part four: the registry entry -------------------------------------------------------------------------------------------------------
test('the entry is cited, dated, well formed and lists what it refuses and what survives, equal to what the code reads', () => {
  assertDeprecationRegistry();
  const entry = providerDeprecation(ID);
  assert.deepEqual(
    [entry.provider, entry.scope, entry.effective_date, entry.source_url],
    ['tiktok', 'route', '2027-01-01', 'https://business-api.tiktok.com/portal/docs/create-ads/v1.3'],
  );
  assert.match(entry.accessed, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(entry.enforcement, /^src\/tiktok-manual-cutoff\.ts/);
  // The banner names five endpoints, the campaign copy task among them (withheld today: its family inherits the entry when it is qualified).
  assert.match(
    entry.target,
    /campaign\/create.*campaign\/copy\/task\/create.*adgroup\/create.*ad\/create.*ad\/aco\/create/s,
  );
  assert.match(entry.enforcement, /campaign copy task/);
  assert.equal(entry.accessed, '2026-11-20', 'the day the lead read the banner again');
  // The enforcement module and the registry read one list: an objective added to the code but not to the entry is a drift.
  assert.deepEqual(entry.values, [
    ...tiktokCutoffObjectives,
    ...tiktokCutoffVirtualObjectives.map(v => 'virtual_objective_type: ' + v),
  ]);
  assert.deepEqual(entry.surviving, ['TRAFFIC', 'is_search_campaign: true']);
  assert.deepEqual(tiktokCutoffObjectives, ['WEB_CONVERSIONS', 'PRODUCT_SALES', 'APP_PROMOTION', 'LEAD_GENERATION']);
  assert.deepEqual(tiktokCutoffVirtualObjectives, ['SALES']);
});

test('the alarm opens 90 days ahead of 2027-01-01 and the entry is effective from that day, in UTC', () => {
  const at = iso => deprecationStatus(Date.parse(iso)).find(d => d.id === ID);
  assert.deepEqual([at('2026-10-02T00:00:00Z').days_until_effective, at('2026-10-02T00:00:00Z').alarm], [91, false]);
  assert.deepEqual([at('2026-10-03T00:00:00Z').days_until_effective, at('2026-10-03T00:00:00Z').alarm], [90, true]);
  assert.deepEqual([at(lastSecond).effective, at(lastSecond).alarm], [false, true]);
  assert.deepEqual([at(firstSecond).effective, at(firstSecond).alarm], [true, false]);
});

// ---- Part five: Arabic (the lead's review S3-1, "with Arabic") ---------------------------------------------------------------------------
// The website shows a message in its language by one of two layers, and the cut-off's refusals are made for both. A plan's step shows its error through
// the error's own template and values (message_localization, web/localization.js uiOwnedError), which the composed sentences of the other dated
// deprecations do not have: the refusals of a campaign create, an ad group create and a clone are such templates, three in all, one for each advice
// a create is given (the Smart+ create and the pack, the Smart+ create alone, no route), with what names the request in a {subject} slot. The recipe
// composer shows an error through the generic layer, which looks the message up in the catalogue as it is (web/app.js errorParts): the purchases pack's
// refusal is a fixed sentence, and the catalogue has its whole text as a key. The generic locale check reads only the literals of an error's
// constructor, so this test is what keeps their Arabic: a sentence reworded without its entry fails here.
const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
const slotsOf = text =>
  [...String(text).matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)]
    .map(m => m[1])
    .sort()
    .join(',');
const citation = ' (tiktok, from 2027-01-01; https://business-api.tiktok.com/portal/docs/create-ads/v1.3).';
test('the refusals of a campaign create, an ad group create and a clone are three templates with an Arabic entry, which a plan’s step shows with no English sentence', () => {
  clock(firstSecond);
  const plan = {gateway, method: 'POST', path: '/v1.3/adgroup/create/', body: {campaign_id: '300'}, accountId: '123'};
  const refusals = [];
  for (const [what, fields] of salesCampaigns)
    refusals.push([what + ', a campaign create', shapeRefusal(campaign(fields))]);
  for (const [what, fields] of salesCampaigns) {
    const row = {campaign_id: '300', ...fields};
    refusals.push([
      what + ', an ad group create',
      refusal(() => tiktokManualCutoffPrerequisites(plan, [{data: {list: [row]}}])),
    ]);
    refusals.push([what + ', a clone', refusal(() => tiktokManualCutoffClone(row))]);
  }
  const keys = new Set();
  for (const [what, e] of refusals) {
    assertRefused(e, 'PROVIDER_DEPRECATED');
    assert.ok(e.localization, what + ' is a template: ' + e.message);
    keys.add(e.localization.key);
    // The English message is the template filled in, with no slot left open, and the entry's own facts are its citation.
    assert.doesNotMatch(e.message, /\{[a-zA-Z_]+\}/, what);
    assert.ok(e.message.endsWith(citation), what + ': ' + e.message);
  }
  // Three templates in all: the advice of the three routes, shared by the three places that refuse.
  assert.equal(keys.size, 3, [...keys].join('\n'));
  for (const key of keys) {
    assert.ok(Object.hasOwn(catalog, key), 'Arabic for: ' + key);
    assert.equal(slotsOf(catalog[key]), slotsOf(key), 'the same slots: ' + key);
    assert.match(catalog[key], /[؀-ۿ]/, key);
  }
  assert.equal(
    [...keys].filter(k => k.includes(noRoute)).length,
    1,
    'the no-route sentence is in one template, and only there',
  );
  // A plan's step in Arabic shows one refusal of each template as the catalogue says it, with the English sentence nowhere in it.
  const shownKeys = new Set();
  for (const [what, e] of refusals) {
    if (shownKeys.has(e.localization.key)) continue;
    shownKeys.add(e.localization.key);
    const f = accountWorkflowFixture('ar');
    f.context.stepError = errorResult(e, 'synthetic-reference-0002', 0).error;
    const shown = f.run('uiOwnedError(stepError)').message,
      expected = catalog[e.localization.key].replace(/\{([a-zA-Z_]+)\}/g, (_, k) => String(e.localization.values[k]));
    assert.equal(shown, expected, what);
    assert.match(shown, /[؀-ۿ]/, what);
    assert.equal(/no longer|has no Upgraded|Create an Upgraded/.test(shown), false, what + ': ' + shown);
  }
  assert.equal(shownKeys.size, 3);
});

test('the purchases pack’s refusal is a fixed sentence whose whole text has an Arabic entry, which the recipe composer’s error layer looks up as it is', () => {
  clock(firstSecond);
  const pack = refusal(() => campaignRecipe('tiktok_website_conversions', conversionBusiness));
  assertRefused(pack, 'PROVIDER_DEPRECATED');
  assert.equal(pack.localization, undefined, 'a composed sentence, with nothing of the request in it');
  assert.ok(pack.message.endsWith(citation), pack.message);
  assert.ok(Object.hasOwn(catalog, pack.message), 'Arabic for: ' + pack.message);
  assert.match(catalog[pack.message], /[؀-ۿ]/);
  const f = accountWorkflowFixture('ar');
  f.context.response = errorResult(pack, 'synthetic-reference-0003', 0);
  f.context.error = f.run('requestError(response)');
  const shown = f.run('errorParts(error)').message;
  assert.equal(shown, catalog[pack.message]);
  assert.equal(/no longer creates|Use the Upgraded/.test(shown), false, shown);
});

// ---- The migration guide is wider than the banner (the lead's added item, 2026-11-21) -------------------------------------------------------------
// TikTok's Upgraded Smart+ migration guide (https://business-api.tiktok.com/portal/docs/upgraded-smart-campaign/v1.3, read 2026-11-21) says that after
// December 31, 2026 Manual campaigns can no longer be created with /campaign/create/, and that /campaign/update/ and /campaign/status/update/ keep
// working. That is wider than the banner of "Create ads" the cut-off follows, which names the Sales, App Promotion and Lead Generation objectives, and
// the two pages conflict. AMCP does not widen the refusal: a create TikTok stops makes nothing, so its own refusal is safe. The classic website traffic
// pack carries a static notice instead (the purchases pack is refused anyway), and the registry's note records the conflict.
const trafficNotice =
  'TikTok’s Upgraded Smart+ migration guide (https://business-api.tiktok.com/portal/docs/upgraded-smart-campaign/v1.3, read 2026-11-21) says that after 2026-12-31 Manual campaigns can no longer be created with /campaign/create/, while /campaign/update/ and /campaign/status/update/ keep working. TikTok’s Create ads page names only the Sales, App Promotion and Lead Generation objectives, so the two pages differ, and AMCP does not refuse this Traffic pack: a create TikTok stops makes nothing. For a route that lasts, use tiktok_smart_plus_website_traffic, the Upgraded Smart+ website traffic pack (the CLICK goal).';
test('the traffic pack’s context carries, with no clock, a notice of TikTok’s migration guide naming its date and the Smart+ traffic pack, with its Arabic, and the pack is not refused', () => {
  for (const iso of [lastSecond, firstSecond, '2026-11-20T00:00:00Z']) {
    clock(iso);
    assert.ok(tiktokTrafficContext.limitations.includes(trafficNotice), iso);
  }
  // The notice names the guide, the date and the durable route (the CLICK goal), says that the pages differ and that nothing is refused.
  for (const part of [
    /upgraded-smart-campaign\/v1\.3/,
    /after 2026-12-31 Manual campaigns can no longer be created with \/campaign\/create\//,
    /keep working/,
    /the two pages differ/,
    /does not refuse this Traffic pack/,
    /tiktok_smart_plus_website_traffic/,
    /\(the CLICK goal\)/,
  ])
    assert.match(trafficNotice, part);
  // Its Arabic entry holds the whole sentence, and it is the only one of the pack's limitations that mentions the guide.
  assert.ok(Object.hasOwn(catalog, trafficNotice), 'Arabic for the notice');
  assert.match(catalog[trafficNotice], /[؀-ۿ]/);
  assert.equal(slotsOf(catalog[trafficNotice]), slotsOf(trafficNotice));
  assert.equal(tiktokTrafficContext.limitations.filter(l => /migration guide/.test(l)).length, 1);
  assert.equal(
    tiktokConversionContext.limitations.some(l => /migration guide/.test(l)),
    false,
    'the purchases pack is refused from the day: its own sentence says so',
  );
  // The refusal is not widened: on 2027-01-01 the traffic pack compiles and a classic Traffic campaign create is accepted, and the registry's
  // note records that the two pages conflict.
  clock(firstSecond);
  assert.equal(
    campaignRecipe('tiktok_website_traffic', trafficBusiness).steps[0].arguments.payload.objective_type,
    'TRAFFIC',
  );
  assert.equal(shapeRefusal(campaign({objective_type: 'TRAFFIC'})), undefined);
  const note = providerDeprecation(ID).note;
  assert.match(note, /upgraded-smart-campaign\/v1\.3/);
  assert.match(note, /read 2026-11-21/);
  assert.match(note, /The two pages conflict/);
  assert.match(note, /AMCP follows the banner and refuses only what it names/);
});

// ---- The pin the other test files use (the lead's review S4-3) ---------------------------------------------------------------------------------
// Six test files pin the deprecation clock before 2027-01-01 so that a classic Sales create they drive for another reason does not turn red on it
// (tests/helpers/tiktok-cutoff-clock.mjs). The pin used to be the last second of 2026 whatever the date was, which also brought every other entry's
// date forward: Reddit's refusal of 2026-12-08 was in effect in those files weeks before its day. It is now the real time until that last second and
// the last second after it, so no other entry is moved and the pin still holds on and after the day.
test('the clock pin of the other test files is today until the last second before the cut-off, and that second after it: no other date is brought forward', () => {
  const realNow = Date.now,
    reddit = 'reddit_report_breakdowns_2026_12',
    last = Date.parse(lastSecond);
  try {
    for (const [what, at] of [
      ['a day well before it', Date.parse('2026-11-21T10:00:00Z')],
      ['the day before Reddit’s', Date.parse('2026-12-07T23:59:59Z')],
      ['the day of Reddit’s', Date.parse('2026-12-08T00:00:00Z')],
      ['the last second before the cut-off', last],
      ['the day of the cut-off', Date.parse(firstSecond)],
      ['a month after it', Date.parse('2027-02-01T00:00:00Z')],
    ]) {
      Date.now = () => at;
      pinBeforeTiktokCutoff();
      assert.equal(
        deprecationNow(),
        Math.min(at, last),
        what + ': the pin is the time, up to the last second before the cut-off',
      );
      assert.equal(deprecationEffective(ID), false, what + ': the cut-off is not in effect');
      assert.equal(
        deprecationEffective(reddit),
        at >= Date.parse('2026-12-08T00:00:00Z'),
        what + ': another entry keeps its own date',
      );
    }
  } finally {
    Date.now = realNow;
    setDeprecationClock();
  }
});

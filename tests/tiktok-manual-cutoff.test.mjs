import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
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
  deprecationStatus,
  providerDeprecation,
  setDeprecationClock,
} from '../dist/src/provider-deprecations.js';
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
afterEach(() => setDeprecationClock());

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
const salesCampaigns = [
  ['WEB_CONVERSIONS', {objective_type: 'WEB_CONVERSIONS'}],
  ['PRODUCT_SALES', {objective_type: 'PRODUCT_SALES'}],
  [
    'PRODUCT_SALES named with the virtual Sales type',
    {objective_type: 'PRODUCT_SALES', virtual_objective_type: 'SALES', sales_destination: 'TIKTOK_SHOP'},
  ],
  ['APP_PROMOTION', {objective_type: 'APP_PROMOTION', app_promotion_type: 'APP_INSTALL'}],
  ['LEAD_GENERATION', {objective_type: 'LEAD_GENERATION'}],
  [
    'the Sales objective named by its virtual type',
    {objective_type: 'WEB_CONVERSIONS', virtual_objective_type: 'SALES', sales_destination: 'WEBSITE'},
  ],
  ['the virtual Sales type alone', {objective_type: 'TRAFFIC', virtual_objective_type: 'SALES'}],
];
for (const [what, fields] of salesCampaigns)
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
      // The replacement is named, as a route and, for a Sales objective, as the guided pack too.
      assert.equal(e.details.use_action, 'tiktok_smart_plus_campaign_create');
      assert.match(e.message, /tiktok_smart_plus_campaign_create/);
      if (/WEB_CONVERSIONS|PRODUCT_SALES|SALES/.test(JSON.stringify(fields))) {
        assert.equal(e.details.use_recipe, 'tiktok_smart_plus_website_conversions');
        assert.match(e.message, /tiktok_smart_plus_website_conversions/);
      }
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
  for (const objective of ['WEB_CONVERSIONS', 'PRODUCT_SALES', 'APP_PROMOTION', 'LEAD_GENERATION']) {
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
      assert.equal(r.error.details.use_action, 'tiktok_smart_plus_campaign_create', objective);
      assert.ok(
        f.requests.some(q => q === 'GET /v1.3/campaign/get/'),
        'the campaign was read: ' + f.requests.join(', '),
      );
    } finally {
      f.close();
    }
  }
  const {f} = await groupUnder({virtual_objective_type: 'SALES'});
  try {
    assertRefused(await f.prepare('adgroup'), 'PROVIDER_DEPRECATED', {writes: () => f.sent.length});
  } finally {
    f.close();
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

test('an ad create is never refused by the cut-off, and a classic child under a serving parent is still PARENT_SERVING', async () => {
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
    assertRefused(
      await f.prepare('ad', body => ({...body, creatives: [{...body.creatives[0], operation_status: 'ENABLE'}]})),
      'PARENT_SERVING',
      {
        writes: () => f.sent.length,
      },
    );
  } finally {
    f.close();
  }
  const traffic = standardCreates(world, {tenant: 'cutoff-serving', parentExtra: () => ({objective_type: 'TRAFFIC'})});
  try {
    clock(firstSecond);
    traffic.parents.campaign = 'ENABLE';
    assertRefused(await traffic.prepare('adgroup', body => ({...body, operation_status: 'ENABLE'})), 'PARENT_SERVING', {
      writes: () => traffic.sent.length,
    });
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
  assert.equal(
    tiktokTrafficContext.limitations.some(l => /2027/.test(l)),
    false,
    'the traffic pack is not affected',
  );
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

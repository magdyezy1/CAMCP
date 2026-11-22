import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {campaignRecipe, campaignRecipes} from '../dist/src/campaign-recipes.js';
import {recipeDependencies} from '../dist/src/capability-eligibility.js';
import {recipeContext, recipeObjective} from '../dist/src/recipe-context.js';
import {activationSteps} from '../dist/src/campaign-activation.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {setDeprecationClock} from '../dist/src/provider-deprecations.js';
import {setPlanReadLagWaits} from '../dist/src/campaign-runner.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {pinBeforeTiktokCutoff} from './helpers/tiktok-cutoff-clock.mjs';
import {recipeComposerFixture} from './fixtures/recipe-composer-ui.mjs';
import {smartPlusWebAccount, smartPlusWebAdvertiser, smartPlusWebBriefs} from './fixtures/tiktok-smart-plus-web.mjs';

/**
 * R2.5 M4, package r25-m4-smartweb: the two guided Upgraded Smart+ website packs, which replace the manual purchases pack before TikTok
 * stops creating classic Sales campaigns on 2027-01-01. Each builds a paused Smart+ campaign (one daily budget on the campaign), a website
 * ad group and a Spark Ad that start ENABLE under it (L1-05), so enabling the campaign is the one reviewed activation. A synthetic
 * advertiser answers the reads and the creates of the Smart+ routes; nothing reaches TikTok.
 *
 * The request_id TikTok requires on a Smart+ campaign and ad group create is the plan's own (the lead's decision L3, 2026-11-20): derived
 * from the plan ID and the step ID and frozen in the step when create_from_recipe saves the plan, so no two plans share one. The Smart+
 * ad create has no request_id (the field list of the route in .mirror/CATALOG/tiktok_native_action.json), so a plan holds two keys.
 */
const gateway = 'tiktok_native_action',
  CONNECTION = '18181818-1818-4181-8181-181818181818',
  actor = {tenantId: 'tiktok-smart-plus-recipe', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'};
const traffic = 'tiktok_smart_plus_website_traffic',
  conversions = 'tiktok_smart_plus_website_conversions';
const placeholder = 'assigned when the plan is saved';
// The two briefs, and the advertiser they are run against, are the fixture of journey J15 (tests/fixtures/tiktok-smart-plus-web.mjs).
const {traffic: trafficBrief, conversions: conversionBrief} = smartPlusWebBriefs(CONNECTION);
const keyShape = /^[1-9][0-9]{0,18}$/,
  maxKey = 9223372036854775807n;

/**
 * A synthetic TikTok advertiser for the Smart+ routes, behind a service with its own store (tests/fixtures/tiktok-smart-plus-web.mjs).
 * `identity`, `post`, `pixel` and `portfolios` override what the reads answer.
 */
function setup(options = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 72).toString('base64'));
  store.putConnection(
    admin,
    {
      id: CONNECTION,
      tenantId: actor.tenantId,
      gateway,
      accounts: [smartPlusWebAccount],
      writeAccounts: [smartPlusWebAccount],
      enabled: true,
      label: 'TikTok login',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const advertiser = smartPlusWebAdvertiser(options),
    mcpCalls = [];
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(advertiser.fetch, undefined, undefined, undefined, 10000),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const call = (input, tool = 'amcp_campaign') => {
    mcpCalls.push(input.action);
    return service.call(tool, input, actor);
  };
  return {store, service, ...advertiser, mcpCalls, call, close: () => store.close()};
}
/** create_from_recipe, approve (preview), approve (confirmed) and run: the four calls of a launch. */
async function launch(f, recipe, business, extra = {}) {
  const created = await f.call({action: 'create_from_recipe', recipe, business, ...extra});
  assert.equal(created.success, true, JSON.stringify(created).slice(0, 1500));
  const id = created.data.id,
    preview = await f.call({action: 'approve', id});
  assert.equal(preview.success, true, JSON.stringify(preview).slice(0, 1500));
  const approved = await f.call({
    action: 'approve',
    id,
    confirmed: true,
    plan_hash: preview.data.plan_hash,
    summary_hash: preview.data.summary_hash,
  });
  assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 1500));
  const result = await f.call({action: 'run', id});
  return {id, result, preview};
}
const planOf = async (f, id) => (await f.call({action: 'get', id, detail: 'full'})).data;
const keysOf = plan => ({
  campaign: plan.steps.find(s => s.id === 'smart_plus_campaign').arguments.payload.request_id,
  adgroup: plan.steps.find(s => s.id === 'smart_plus_adgroup').arguments.payload.request_id,
});

test('both Smart+ packs are guided recipes with their declared dependencies and the three Smart+ create actions', () => {
  for (const id of [traffic, conversions]) {
    const definition = campaignRecipes.find(r => r.id === id);
    assert.ok(definition, id + ' is a guided recipe');
    assert.equal(definition.platform, 'tiktok');
    for (const key of [
      'tiktok_item_id',
      'identity_type',
      'identity_id',
      'location_ids',
      'start_time',
      'call_to_action_id',
    ])
      assert.ok(definition.required.includes(key), id + ' requires ' + key);
    assert.ok(!definition.required.includes('call_to_action'), 'the classic CTA name is not an input of a Smart+ pack');
    assert.deepEqual(recipeDependencies[id].actions, [
      'tiktok_smart_plus_campaign_create',
      'tiktok_smart_plus_adgroup_create',
      'tiktok_smart_plus_ad_create',
    ]);
    for (const object of ['tiktok_spark_identity', 'existing_tiktok_post', 'dynamic_cta_portfolio'])
      assert.ok(recipeDependencies[id].objects.includes(object), id + ' depends on ' + object);
  }
  // The pixel objects are the purchases pack's alone: a click ad group has no pixel.
  assert.ok(definitionOf(conversions).required.includes('pixel_id'));
  assert.ok(definitionOf(conversions).required.includes('optimization_event'));
  assert.ok(recipeDependencies[conversions].objects.includes('account_owned_pixel'));
  assert.ok(recipeDependencies[conversions].objects.includes('conversion_event_delivery'));
  assert.ok(!definitionOf(traffic).required.includes('pixel_id'));
  assert.ok(!recipeDependencies[traffic].objects.includes('account_owned_pixel'));
  assert.ok(!recipeDependencies[traffic].objects.includes('conversion_event_delivery'));
  assert.ok(definitionOf(traffic).optional.includes('optimization_goal'));
  // The classic packs are listed beside them, in catalog order: classic first.
  const ids = campaignRecipes.map(r => r.id);
  assert.ok(ids.indexOf('tiktok_website_conversions') < ids.indexOf(traffic));
  assert.ok(ids.indexOf(traffic) < ids.indexOf(conversions));
});
const definitionOf = id => campaignRecipes.find(r => r.id === id);

test('a Smart+ traffic brief compiles to the three Smart+ creates: a DISABLE campaign with the budget, an ENABLE click ad group and an ENABLE Spark Ad', () => {
  const before = JSON.stringify(trafficBrief),
    plan = campaignRecipe(traffic, trafficBrief);
  assert.equal(JSON.stringify(trafficBrief), before, 'the brief is not mutated');
  assert.deepEqual(
    plan.steps.map(s => [s.id, s.arguments.action, s.depends_on]),
    [
      ['smart_plus_campaign', 'tiktok_smart_plus_campaign_create', []],
      ['smart_plus_adgroup', 'tiktok_smart_plus_adgroup_create', ['smart_plus_campaign']],
      ['smart_plus_ad', 'tiktok_smart_plus_ad_create', ['smart_plus_adgroup']],
    ],
  );
  assert.ok(plan.steps.every(s => s.gateway === gateway && s.expected_currency === 'USD' && s.account_id === '7001'));
  const [c, g, a] = plan.steps.map(s => s.arguments.payload);
  assert.deepEqual(c, {
    advertiser_id: '7001',
    request_id: placeholder,
    operation_status: 'DISABLE',
    objective_type: 'WEB_CONVERSIONS',
    sales_destination: 'WEBSITE',
    campaign_name: 'Synthetic Smart+ traffic',
    budget_optimize_on: true,
    budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
    budget: 25.5,
  });
  assert.deepEqual(g.campaign_id, {$ref: 'smart_plus_campaign#/data/data/campaign_id'});
  assert.equal(g.request_id, placeholder);
  assert.equal(g.operation_status, 'ENABLE', 'the ad group starts enabled under the disabled campaign (L1-05)');
  assert.equal(g.promotion_type, 'WEBSITE');
  assert.equal(g.optimization_goal, 'CLICK');
  assert.equal(g.billing_event, 'CPC');
  assert.equal(g.bid_type, 'BID_TYPE_NO_BID');
  assert.deepEqual(g.targeting_spec, {location_ids: ['6252001', '102358']});
  assert.equal(
    g.budget,
    undefined,
    'the budget is the campaign’s: an ad group under campaign budget optimization sends none',
  );
  assert.equal(g.budget_mode, undefined);
  assert.equal(g.pixel_id, undefined);
  assert.equal(g.optimization_event, undefined);
  assert.equal(g.schedule_type, 'SCHEDULE_FROM_NOW');
  assert.equal(g.schedule_start_time, '2026-12-01 07:00:00', 'the +03:00 start is sent in UTC');
  assert.equal(g.placement_type, 'PLACEMENT_TYPE_NORMAL');
  assert.deepEqual(g.placements, ['PLACEMENT_TIKTOK']);
  assert.deepEqual(a.adgroup_id, {$ref: 'smart_plus_adgroup#/data/data/adgroup_id'});
  assert.equal(a.request_id, undefined, 'the Smart+ ad create has no request_id');
  assert.equal(a.operation_status, 'ENABLE');
  assert.deepEqual(a.creative_list, [
    {
      creative_info: {
        ad_format: 'SINGLE_VIDEO',
        tiktok_item_id: '7300000000000000001',
        identity_type: 'TT_USER',
        identity_id: 'tt-identity-1',
      },
    },
  ]);
  assert.deepEqual(a.landing_page_url_list, [{landing_page_url: 'https://example.com/tiktok-landing'}]);
  assert.deepEqual(a.ad_configuration, {
    call_to_action_id: '700',
    creative_auto_add_toggle: false,
    creative_auto_enhancement_strategy_list: [],
  });
  assert.equal(plan.steps[0].prerequisites, undefined);
  assert.equal(plan.steps[1].prerequisites, undefined, 'a click ad group has no pixel to check');
  assert.deepEqual(plan.steps[2].prerequisites, ['tiktok_spark_post', 'tiktok_cta_portfolio']);
  assert.equal(plan.recipe.id, traffic);
  assert.equal(plan.recipe.daily_budget, '25.5');
  assert.equal(plan.recipe.optimization_goal, 'CLICK');
});

test('a Smart+ purchases brief optimizes the chosen purchase event of the pixel, with a Business Center identity', () => {
  const plan = campaignRecipe(conversions, {
    ...conversionBrief,
    identity_type: 'BC_AUTH_TT',
    identity_authorized_bc_id: '5550001',
  });
  const [c, g, a] = plan.steps.map(s => s.arguments.payload);
  assert.equal(c.objective_type, 'WEB_CONVERSIONS');
  assert.equal(c.operation_status, 'DISABLE');
  assert.equal(g.optimization_goal, 'CONVERT');
  assert.equal(g.billing_event, 'OCPM');
  assert.equal(g.pixel_id, '8800');
  assert.equal(g.optimization_event, 'SHOPPING');
  // A pack runs from its start under the campaign's daily budget: the schedule has no end (S2-1, the lead's review of eb0c133f).
  assert.equal(g.schedule_type, 'SCHEDULE_FROM_NOW');
  assert.equal(g.schedule_end_time, undefined);
  assert.deepEqual(plan.steps[1].prerequisites, ['tiktok_pixel']);
  assert.deepEqual(a.creative_list[0].creative_info.identity_authorized_bc_id, '5550001');
  assert.equal(plan.recipe.optimization_event, 'SHOPPING');
  assert.equal(plan.recipe.optimization_goal, 'CONVERT');
  // The click goal is explicit and the default for the traffic pack.
  assert.equal(
    campaignRecipe(traffic, {...trafficBrief, optimization_goal: 'CLICK'}).steps[1].arguments.payload.optimization_goal,
    'CLICK',
  );
});

test('a Smart+ traffic brief that names the landing page view goal compiles an OCPM ad group with no pixel and the same three steps', () => {
  // TikTok (impl/r25-m4-DOCS-EVIDENCE.md, row 2): every goal but CLICK bills with OCPM, and a pixel is not supported for the landing page
  // view goal, any more than for the click goal.
  const plan = campaignRecipe(traffic, {...trafficBrief, optimization_goal: 'TRAFFIC_LANDING_PAGE_VIEW'});
  assert.deepEqual(
    plan.steps.map(s => s.arguments.action),
    ['tiktok_smart_plus_campaign_create', 'tiktok_smart_plus_adgroup_create', 'tiktok_smart_plus_ad_create'],
  );
  const g = plan.steps[1].arguments.payload;
  assert.equal(g.optimization_goal, 'TRAFFIC_LANDING_PAGE_VIEW');
  assert.equal(g.billing_event, 'OCPM');
  assert.equal(g.bid_type, 'BID_TYPE_NO_BID');
  assert.equal(g.pixel_id, undefined);
  assert.equal(g.optimization_event, undefined);
  assert.equal(g.bid_price, undefined);
  assert.equal(g.conversion_bid_price, undefined);
  assert.equal(plan.steps[1].prerequisites, undefined, 'no pixel to check');
  assert.equal(plan.recipe.optimization_goal, 'TRAFFIC_LANDING_PAGE_VIEW');
  assert.match(plan.recipe.bidding_effect, /landing page views/);
  // The click goal is still the default, and the two goals differ in the goal and the billing event alone.
  const click = campaignRecipe(traffic, trafficBrief).steps[1].arguments.payload;
  assert.equal(click.optimization_goal, 'CLICK');
  assert.equal(click.billing_event, 'CPC');
  const {optimization_goal: a, billing_event: b, ...rest} = g,
    {optimization_goal: c, billing_event: d, ...clickRest} = click;
  assert.deepEqual(rest, clickRest);
});

test('briefs TikTok would refuse, or that AMCP cannot express exactly, are refused before anything is saved', () => {
  const refusals = [
    [traffic, {identity_type: 'CUSTOMIZED_USER'}, 'RECIPE_INPUT_INVALID', 'identity_type'],
    [traffic, {identity_type: 'BC_AUTH_TT'}, 'RECIPE_INPUT_INVALID', 'identity_authorized_bc_id'],
    [traffic, {identity_authorized_bc_id: '5550001'}, 'RECIPE_INPUT_INVALID', 'identity_authorized_bc_id'],
    [traffic, {tiktok_item_id: 'post-1'}, 'RECIPE_INPUT_INVALID', 'tiktok_item_id'],
    [traffic, {account_id: 'acct'}, 'RECIPE_INPUT_INVALID', 'account_id'],
    [traffic, {location_ids: []}, 'RECIPE_INPUT_INVALID', 'location_ids'],
    [traffic, {location_ids: ['6252001', '6252001']}, 'RECIPE_INPUT_INVALID', 'location_ids'],
    [traffic, {location_ids: ['SA']}, 'RECIPE_INPUT_INVALID', 'location_ids'],
    [
      traffic,
      {location_ids: Array.from({length: 21}, (_, i) => String(6252001 + i))},
      'RECIPE_INPUT_INVALID',
      'location_ids',
    ],
    [traffic, {daily_budget: '20.125'}, 'INVALID_RECIPE_MONEY', 'daily_budget'],
    [traffic, {daily_budget: '0'}, 'INVALID_RECIPE_MONEY', 'daily_budget'],
    [traffic, {currency: 'JPY', daily_budget: '3000.5'}, 'INVALID_RECIPE_MONEY', 'daily_budget'],
    [traffic, {start_time: '2026-12-01T10:00:00'}, 'RECIPE_DATE_INVALID', 'start_time'],
    // No end time at all (S2-1): the ad group would be SCHEDULE_START_END under the campaign's daily budget, which TikTok allows only under a
    // total budget; whether the end is before or after the start, or malformed, the pack refuses the input itself.
    [traffic, {end_time: '2026-12-01T06:00:00Z'}, 'RECIPE_INPUT_INVALID', 'end_time'],
    [traffic, {end_time: '2026-12-30T23:00:00Z'}, 'RECIPE_INPUT_INVALID', 'end_time'],
    [traffic, {end_time: 'not a time'}, 'RECIPE_INPUT_INVALID', 'end_time'],
    [conversions, {end_time: '2026-12-30T23:00:00Z'}, 'RECIPE_INPUT_INVALID', 'end_time'],
    [traffic, {destination_url: 'http://example.com/'}, 'DESTINATION_REQUIRED'],
    [traffic, {name: 'Launch 🚀'}, 'RECIPE_INPUT_INVALID', 'name'],
    // The classic pack's CTA name is no input here: a Smart+ Spark Ad takes a CTA portfolio.
    [traffic, {call_to_action: 'LEARN_MORE'}, 'RECIPE_INPUT_INVALID', 'call_to_action'],
    [traffic, {call_to_action_id: 'LEARN_MORE'}, 'RECIPE_INPUT_INVALID', 'call_to_action_id'],
    [traffic, {call_to_action_id: '0'}, 'RECIPE_INPUT_INVALID', 'call_to_action_id'],
    // A traffic pack optimizes clicks: a pixel or an event is the purchases pack's.
    [traffic, {pixel_id: '8800'}, 'RECIPE_INPUT_INVALID', 'pixel_id'],
    [traffic, {optimization_event: 'SHOPPING'}, 'RECIPE_INPUT_INVALID', 'optimization_event'],
    // A goal that is neither of the traffic pack's (the click goal and the landing page view goal): VALUE and CONVERT are documented
    // goals of a regular Smart+ web campaign that the pack does not build, and a spelling is no goal.
    [traffic, {optimization_goal: 'VALUE'}, 'RECIPE_INPUT_INVALID', 'optimization_goal'],
    [traffic, {optimization_goal: 'CONVERT'}, 'RECIPE_INPUT_INVALID', 'optimization_goal'],
    [traffic, {optimization_goal: 'click'}, 'RECIPE_INPUT_INVALID', 'optimization_goal'],
    [traffic, {optimization_goal: 7}, 'RECIPE_INPUT_INVALID', 'optimization_goal'],
    [conversions, {optimization_event: 'PAGE_VIEW'}, 'RECIPE_INPUT_INVALID', 'optimization_event'],
    [conversions, {pixel_id: 'pixel'}, 'RECIPE_INPUT_INVALID', 'pixel_id'],
    [conversions, {optimization_goal: 'CLICK'}, 'RECIPE_INPUT_INVALID', 'optimization_goal'],
    [conversions, {call_to_action: 'SHOP_NOW'}, 'RECIPE_INPUT_INVALID', 'call_to_action'],
  ];
  for (const [recipe, patch, code, field] of refusals) {
    const business = recipe === conversions ? conversionBrief : trafficBrief;
    assert.throws(
      () => campaignRecipe(recipe, {...business, ...patch}),
      e => assertRefused(e, code) && (field === undefined || e.details.field === field),
      recipe + ' ' + JSON.stringify(patch),
    );
  }
  // The refusal of a pixel or an event on the traffic pack names both of its goals, whichever goal the brief asks for.
  for (const patch of [
    {pixel_id: '8800'},
    {optimization_event: 'SHOPPING'},
    {optimization_goal: 'TRAFFIC_LANDING_PAGE_VIEW', pixel_id: '8800'},
  ])
    assert.throws(
      () => campaignRecipe(traffic, {...trafficBrief, ...patch}),
      e =>
        assertRefused(e, 'RECIPE_INPUT_INVALID') &&
        e.message ===
          'The traffic workflow optimizes clicks or landing page views; choose the purchases workflow to optimize a pixel event.',
      JSON.stringify(patch),
    );
  // A required input that is missing is named, whichever pack it is.
  for (const key of ['tiktok_item_id', 'identity_id', 'location_ids', 'start_time', 'call_to_action_id']) {
    const b = {...trafficBrief};
    delete b[key];
    assert.throws(
      () => campaignRecipe(traffic, b),
      e => e.code === 'RECIPE_INPUT_REQUIRED' && e.details.missing_fields.includes(key),
    );
  }
  for (const key of ['pixel_id', 'optimization_event']) {
    const b = {...conversionBrief};
    delete b[key];
    assert.throws(
      () => campaignRecipe(conversions, b),
      e => e.code === 'RECIPE_INPUT_REQUIRED' && e.details.missing_fields.includes(key),
      'conversions without ' + key,
    );
  }
});

test('a Smart+ pack takes no end time, and says so before anything is compiled, read or sent; the briefs without one compile as before', async t => {
  // S2-1 (the lead's review of eb0c133f): with an end time the ad group would be SCHEDULE_START_END under the campaign's daily budget, which
  // TikTok documents as allowed only under a total budget (the update page; the create page is unread), so it would refuse the ad group
  // after the paused campaign exists, which AMCP cannot delete yet. The pack fails closed.
  const sentence = 'A Smart+ pack runs from its start under one daily budget; end it with a reviewed status change.';
  for (const [recipe, business] of [
    [traffic, trafficBrief],
    [conversions, conversionBrief],
  ])
    for (const end_time of ['2026-12-30T23:00:00Z', '2027-01-30T10:00:00+03:00'])
      assert.throws(
        () => campaignRecipe(recipe, {...business, end_time}),
        e => assertRefused(e, 'RECIPE_INPUT_INVALID') && e.details.field === 'end_time' && e.message === sentence,
        recipe + ' ' + end_time,
      );
  // No definition offers it, so no form or listing shows an input that is always refused.
  for (const id of [traffic, conversions]) {
    assert.ok(!definitionOf(id).optional.includes('end_time'), id + ' lists no optional end_time');
    assert.ok(!definitionOf(id).required.includes('end_time'), id + ' requires no end_time');
  }
  // Through the plan engine: refused as a typed refusal, with nothing saved, read or sent.
  const f = setup();
  t.after(f.close);
  for (const [recipe, business] of [
    [traffic, trafficBrief],
    [conversions, conversionBrief],
  ])
    assertRefused(
      await f.call({
        action: 'create_from_recipe',
        recipe,
        business: {...business, end_time: '2026-12-30T23:00:00Z'},
      }),
      'RECIPE_INPUT_INVALID',
      {writes: () => f.writes.length, message: /runs from its start under one daily budget/},
    );
  assert.equal(f.requests.length, 0, 'nothing was read or sent');
  // The negative: a blank end_time is no input (a form sends one for a field left empty), and without one the packs compile as they did
  // before this fix, byte for byte in their steps (sha256 of the JSON of the steps, taken of eb0c133f's build).
  const sha = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
  assert.equal(
    sha(campaignRecipe(traffic, {...trafficBrief, end_time: ''}).steps),
    '81a38188be46645d4c3438148e33d37782b241097290531366dd953ad31f8528',
  );
  assert.equal(
    sha(campaignRecipe(conversions, conversionBrief).steps),
    'd4dfad30a103445f14dd606d2e96a11a9c62d9f0513e48d467db503f0c55f2e2',
  );
  assert.equal(
    sha(campaignRecipe(traffic, {...trafficBrief, optimization_goal: 'TRAFFIC_LANDING_PAGE_VIEW'}).steps),
    '4d39e6bbfcffd938926ea79cb8b987f4387f20aa9a82f993d7e6b6c9fec42f1d',
  );
  assert.equal(
    sha(
      campaignRecipe(conversions, {
        ...conversionBrief,
        identity_type: 'BC_AUTH_TT',
        identity_authorized_bc_id: '5550001',
      }).steps,
    ),
    'fc9c78213244e3f140c63b2a034243bc44d77c75fc55a2ec687cbbc0b64b80c4',
  );
});

test('the classic packs compile byte for byte as before', t => {
  // The fingerprints were taken of the classic compile output before this package touched src/tiktok-launch-recipes.ts (it exports two
  // helpers and changes nothing else), with the briefs of tests/tiktok-launch-recipes.test.mjs.
  // Merge r25-m4a-merge, join 4 (a) (the lead's review of eb0c133f, S3-4): r25-m4-classic refuses the classic purchases compile from 2027-01-01
  // 00:00 UTC (tiktokManualCutoffPurchases). This test compiles it on the real clock, so it turned red under the clock probe at 2027-01-02 and
  // would on that day. It pins the clock to the last second before the date, as every suite that compiles the pack does
  // (pinBeforeTiktokCutoff, tests/helpers/tiktok-cutoff-clock.mjs), and gives the clock back after, as it found it (the lead's review S4-3: not
  // the real one, which took the tests after this one off the clock probe); the last assertion shows the pin is needed.
  pinBeforeTiktokCutoff(t);
  const classicTraffic = {
    name: 'Synthetic TikTok traffic',
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
    start_time: '2026-11-01T10:00:00+03:00',
  };
  const classicConversions = {...classicTraffic, pixel_id: '8800', optimization_event: 'SHOPPING'};
  const sha = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
  assert.equal(
    sha(campaignRecipe('tiktok_website_traffic', classicTraffic)),
    '4a6e99c2f337d5b752df4a8f95ccae2ecb240cd68cedf6e083cc55608f9bea23',
  );
  assert.equal(
    sha(campaignRecipe('tiktok_website_conversions', classicConversions)),
    'ca2539d2cecdad6af57da094166ad77d0f9a37f7f740deeb3ea715fda5d697dd',
  );
  assert.equal(
    sha(
      campaignRecipe('tiktok_website_conversions', {
        ...classicConversions,
        identity_type: 'BC_AUTH_TT',
        identity_authorized_bc_id: '5550001',
        end_time: '2026-11-30T23:00:00Z',
      }),
    ),
    '04d1f0f7ad2eafc58cdb60c9bb829524db05f2e530ed722aa87b31957a5703b1',
  );
  // From the date the same purchases compile is refused, and the refusal names the Smart+ pack that replaces it; the traffic pack still compiles.
  setDeprecationClock(() => Date.parse('2027-01-02T00:00:00Z'));
  assert.throws(
    () => campaignRecipe('tiktok_website_conversions', classicConversions),
    e => {
      assertRefused(e, 'PROVIDER_DEPRECATED');
      assert.equal(e.details.deprecation, 'tiktok_manual_sales_app_lead_creates');
      assert.equal(e.details.use_recipe, conversions);
      assert.match(e.message, /tiktok_smart_plus_website_conversions/);
      return true;
    },
  );
  assert.equal(
    sha(campaignRecipe('tiktok_website_traffic', classicTraffic)),
    '4a6e99c2f337d5b752df4a8f95ccae2ecb240cd68cedf6e083cc55608f9bea23',
  );
});

test('objective grouping: the purchases pack is sales and the traffic pack is traffic, on the server and on the page', async () => {
  assert.equal(recipeObjective(conversions), 'sales');
  assert.equal(recipeObjective(traffic), 'traffic');
  assert.equal(recipeObjective('tiktok_website_conversions'), 'sales');
  for (const locale of ['en', 'ar']) {
    const f = recipeComposerFixture(locale, definitionOf(conversions), conversionBrief);
    assert.equal(f.run("recipeObjectiveOf('" + conversions + "')"), 'sales', locale);
    assert.equal(f.run("recipeObjectiveOf('" + traffic + "')"), 'traffic', locale);
    // The brief's new input and the two new dependencies are labelled, in the language of the page: English as written, Arabic from the
    // catalogue (the page looks a label up with uiText, which leaves a label with no Arabic in English).
    for (const [code, english] of [
      ["recipeFieldLabel('call_to_action_id', '" + conversions + "')", 'TikTok dynamic call-to-action portfolio ID'],
      ['recipeDependencyLabels.dynamic_cta_portfolio', 'TikTok dynamic call-to-action portfolio'],
      ['recipeDependencyLabels.automatic_traffic_bidding', 'Automatic bidding for the chosen traffic goal'],
    ]) {
      assert.equal(f.run(code), english, locale + ' ' + code);
      const shown = f.run('uiText(' + code + ')');
      if (locale === 'en') assert.equal(shown, english);
      else {
        assert.notEqual(shown, english, 'Arabic for: ' + english);
        assert.match(shown, /[؀-ۿ]/);
      }
    }
  }
});

test('recipe context names the pack’s own prerequisite and limitations without a provider request', t => {
  const f = setup();
  t.after(f.close);
  for (const id of [traffic, conversions]) {
    const context = recipeContext(f.store, actor, id);
    assert.deepEqual(
      context.targets.map(x => [x.connection_id, x.account_id, x.write_granted]),
      [[CONNECTION, '7001', true]],
    );
    assert.match(context.limitations[0], /Smart\+/);
    assert.match(context.limitations[0], /CTA portfolio/);
    assert.ok(
      context.prerequisites.some(p => /CTA portfolio/.test(p)),
      'the prerequisite names the CTA portfolio',
    );
  }
  assert.match(recipeContext(f.store, actor, conversions).limitations[0], /pixel/);
  assert.equal(f.requests.length, 0);
});

test('preview_recipe shows the request_id as assigned when the plan is saved and sends nothing', async t => {
  const f = setup();
  t.after(f.close);
  const out = await f.call({action: 'preview_recipe', recipe: traffic, business: trafficBrief});
  assert.equal(out.success, true, JSON.stringify(out).slice(0, 800));
  assert.equal(out.data.provider_mutations, 0);
  const steps = out.data.plan.steps;
  assert.equal(steps[0].arguments.payload.request_id, placeholder);
  assert.equal(steps[1].arguments.payload.request_id, placeholder);
  assert.equal(steps[2].arguments.payload.request_id, undefined);
  assert.equal(f.writes.length, 0);
  assert.equal(f.requests.length, 0, 'a preview reads nothing');
});

test('a saved plan assigns each Smart+ create its own request_id from the plan and the step; two plans of one brief never share one', async t => {
  const f = setup();
  t.after(f.close);
  const seen = new Set();
  for (const recipe of [traffic, conversions]) {
    const business = recipe === conversions ? conversionBrief : trafficBrief;
    const first = await f.call({action: 'create_from_recipe', recipe, business}),
      second = await f.call({action: 'create_from_recipe', recipe, business});
    assert.equal(first.success, true, JSON.stringify(first).slice(0, 600));
    assert.equal(second.success, true, JSON.stringify(second).slice(0, 600));
    assert.notEqual(first.data.id, second.data.id, 'two plans, not one');
    const a = keysOf(await planOf(f, first.data.id)),
      b = keysOf(await planOf(f, second.data.id));
    for (const key of [a.campaign, a.adgroup, b.campaign, b.adgroup]) {
      assert.match(key, keyShape, key);
      assert.ok(BigInt(key) <= maxKey && BigInt(key) > 0n, key);
      assert.ok(!seen.has(key), 'every key of every plan is its own: ' + key);
      seen.add(key);
    }
    assert.notEqual(a.campaign, a.adgroup, 'the two steps of a plan have two keys');
    // Nothing sends a placeholder: no step of a saved plan holds one.
    const saved = await planOf(f, first.data.id);
    assert.ok(!JSON.stringify(saved.steps).includes(placeholder), 'no placeholder is left in a saved plan');
    assert.equal(saved.steps.find(s => s.id === 'smart_plus_ad').arguments.payload.request_id, undefined);
  }
  assert.equal(seen.size, 8, 'two plans of two packs, two keys each');
  assert.equal(f.writes.length, 0, 'saving a plan sends nothing');
});

test('a plan saved under a creation key is returned as it was, with its keys; a get and a re-saved request change none', async t => {
  const f = setup();
  t.after(f.close);
  const request = {
    action: 'create_from_recipe',
    recipe: traffic,
    business: trafficBrief,
    idempotency_key: 'smart-plus-key-001',
  };
  const first = await f.call(request),
    again = await f.call(request);
  assert.equal(first.success, true, JSON.stringify(first).slice(0, 600));
  assert.equal(again.data.id, first.data.id, 'the same request is the same plan');
  const a = keysOf(await planOf(f, first.data.id)),
    b = keysOf(await planOf(f, again.data.id));
  assert.deepEqual(b, a, 'a repeated request leaves the keys as they were');
  // Another creation key is another plan, with other keys.
  const other = await f.call({...request, idempotency_key: 'smart-plus-key-002'});
  assert.notEqual(other.data.id, first.data.id);
  const c = keysOf(await planOf(f, other.data.id));
  assert.notEqual(c.campaign, a.campaign);
  assert.notEqual(c.adgroup, a.adgroup);
  // The key of the same brief under another creation key is no conflict (the key names the request), and the first plan is intact.
  assert.deepEqual(keysOf(await planOf(f, first.data.id)), a);
});

test('a plan sends the keys it was saved with, and keeps them once it has run', async t => {
  const f = setup();
  t.after(f.close);
  const {id, result} = await launch(f, traffic, trafficBrief);
  assert.equal(result.success, true, JSON.stringify(result).slice(0, 1500));
  const plan = await planOf(f, id);
  assert.equal(
    plan.state,
    'complete',
    JSON.stringify(plan.steps.map(s => ({id: s.id, status: s.status, error: s.error}))),
  );
  const saved = keysOf(plan),
    sent = f.writes.map(w => w.body.request_id);
  assert.deepEqual(sent, [saved.campaign, saved.adgroup, undefined], 'the POSTs carry the saved keys, the ad none');
  assert.deepEqual(keysOf(await planOf(f, id)), saved, 'a later get shows the same keys');
});

test('a step prepared again after its state changed sends the key it was saved with: both reviews and the one POST carry the key a get showed', async t => {
  // S3-2 (the lead's review of eb0c133f): the brief asks that a saved plan keeps its keys across a re-prepare, and nothing prepared a step twice.
  // The advertiser changes between the first prepare and its execute, so that review is stale (STATE_CHANGED, nothing sent); the step is
  // prepared again over the state as it is now, and sent.
  let drift = false;
  const f = setup({
    routes: (method, path) =>
      drift && method === 'GET' && path === '/v1.3/advertiser/info/'
        ? Response.json({
            code: 0,
            message: 'OK',
            request_id: 'r',
            data: {
              list: [
                {advertiser_id: smartPlusWebAccount, currency: 'USD', timezone: 'Asia/Riyadh', status: 'STATUS_ENABLE'},
              ],
              page_info: {page: 1, page_size: 100, total_number: 1, total_page: 1},
            },
          })
        : undefined,
  });
  t.after(f.close);
  const created = await f.call({action: 'create_from_recipe', recipe: traffic, business: trafficBrief});
  assert.equal(created.success, true, JSON.stringify(created).slice(0, 800));
  const id = created.data.id,
    saved = keysOf(await planOf(f, id)).campaign;
  const preview = await f.call({action: 'approve', id}),
    approved = await f.call({
      action: 'approve',
      id,
      confirmed: true,
      plan_hash: preview.data.plan_hash,
      summary_hash: preview.data.summary_hash,
    });
  assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 800));
  const execute = review =>
    f.call({
      action: 'execute_next',
      id,
      review_id: review.review_id,
      idempotency_key: review.review_id,
      confirmed: true,
    });
  const first = await f.call({action: 'prepare_next', id, detail: 'full'});
  assert.equal(first.success, true, JSON.stringify(first).slice(0, 800));
  assert.equal(first.data.review.request.body.request_id, saved, 'the first review carries the saved key');
  drift = true;
  const stale = await execute(first.data.review);
  assert.equal(stale.data.current.error.code, 'STATE_CHANGED', JSON.stringify(stale.data).slice(0, 600));
  assert.equal(f.writes.length, 0, 'the stale review sent nothing');
  const second = await f.call({action: 'prepare_next', id, detail: 'full'});
  assert.equal(second.success, true, JSON.stringify(second).slice(0, 800));
  assert.notEqual(second.data.review.review_id, first.data.review.review_id, 'a new review');
  assert.equal(second.data.review.request.body.request_id, saved, 'the second review carries the same key');
  const sent = await execute(second.data.review);
  assert.equal(sent.success, true, JSON.stringify(sent).slice(0, 800));
  assert.equal(f.writes.length, 1, 'one POST');
  assert.equal(f.writes[0].body.request_id, saved, 'the POST carries the key a get showed at save');
  assert.equal(keysOf(await planOf(f, id)).campaign, saved, 'and a get still shows it');
});

test('no request can leave with the placeholder: a hand-made plan of the preview’s steps is blocked at its preflight, before anything is created', async t => {
  const f = setup();
  t.after(f.close);
  // The compiled steps are no sendable request: the contract of the create refuses the placeholder.
  const direct = await f.call(
    {
      action: 'prepare',
      gateway,
      connection_id: CONNECTION,
      arguments: {
        action: 'tiktok_smart_plus_campaign_create',
        account_id: '7001',
        payload: campaignRecipe(traffic, trafficBrief).steps[0].arguments.payload,
      },
    },
    'amcp_write',
  );
  assertRefused(direct, 'INVALID_TIKTOK_SMART_PLUS_CAMPAIGN', {writes: () => f.writes.length});
  assert.equal(direct.error.details.field, 'request_id');
  // A plan a caller makes of the steps a preview showed carries the placeholder as typed, and its step is refused when it is prepared.
  const preview = await f.call({action: 'preview_recipe', recipe: traffic, business: trafficBrief});
  const created = await f.call({
    action: 'create',
    name: 'Hand made from a preview',
    steps: preview.data.plan.steps,
  });
  assert.equal(created.success, true, JSON.stringify(created).slice(0, 800));
  const saved = await planOf(f, created.data.id);
  assert.equal(saved.steps[0].arguments.payload.request_id, placeholder, 'a plain create assigns nothing');
  // S4-1 (the lead's review of eb0c133f): the read-only preflight binds no probe to the steps of a saved plan, so the placeholder is blocked there,
  // by the contract's own refusal, before anything is created. It used to report ready: the plan was approved and only its run refused it.
  const checked = await f.call({action: 'preflight', id: created.data.id});
  assert.equal(checked.success, true, JSON.stringify(checked).slice(0, 800));
  const preflight = (await planOf(f, created.data.id)).preflight,
    blocked = preflight.checks.filter(c => c.status === 'blocked');
  assert.equal(preflight.status, 'blocked', JSON.stringify(preflight.checks).slice(0, 600));
  assert.deepEqual(
    blocked.map(c => [c.step, c.error.code, c.error.details.field]),
    [
      ['smart_plus_campaign', 'INVALID_TIKTOK_SMART_PLUS_CAMPAIGN', 'request_id'],
      ['smart_plus_adgroup', 'INVALID_TIKTOK_SMART_PLUS_ADGROUP', 'request_id'],
    ],
  );
  const preflighted = await f.call({action: 'approve', id: created.data.id});
  if (preflighted.success) {
    const approved = await f.call({
      action: 'approve',
      id: created.data.id,
      confirmed: true,
      plan_hash: preflighted.data.plan_hash,
      summary_hash: preflighted.data.summary_hash,
    });
    if (approved.success) await f.call({action: 'run', id: created.data.id});
  }
  assert.equal(f.writes.length, 0, 'nothing was sent: ' + f.requests.join(' | '));
  const after = await planOf(f, created.data.id);
  assert.notEqual(after.state, 'complete');
  const failed = after.steps.find(s => s.id === 'smart_plus_campaign');
  assert.ok(
    ['pending', 'failed', 'blocked'].includes(failed.status) &&
      (failed.error === undefined || failed.error.code === 'INVALID_TIKTOK_SMART_PLUS_CAMPAIGN'),
    JSON.stringify({status: failed.status, error: failed.error}),
  );
});

test('a Smart+ traffic plan reaches a verified paused launch in four MCP calls with exactly three creates, then drafts its one activation', async t => {
  const f = setup();
  t.after(f.close);
  const {id, result} = await launch(f, traffic, trafficBrief);
  assert.equal(result.success, true, JSON.stringify(result).slice(0, 1500));
  assert.equal(
    result.data.run?.stopped,
    'complete',
    'no stop for a spend acknowledgement: a paused create names no spend (Q14)',
  );
  assert.deepEqual(f.mcpCalls, ['create_from_recipe', 'approve', 'approve', 'run'], 'four MCP calls');
  const plan = await planOf(f, id);
  assert.equal(
    plan.state,
    'complete',
    JSON.stringify(plan.steps.map(s => ({id: s.id, status: s.status, error: s.error}))),
  );
  assert.deepEqual(
    plan.steps.map(s => s.status),
    ['verified', 'verified', 'verified'],
  );
  assert.deepEqual(
    f.writes.map(w => w.path),
    ['/v1.3/smart_plus/campaign/create/', '/v1.3/smart_plus/adgroup/create/', '/v1.3/smart_plus/ad/create/'],
  );
  // Preflight read the Spark identity, the post and the CTA portfolio before the first create; a click ad group reads no pixel.
  const firstCreate = f.requests.indexOf('POST /v1.3/smart_plus/campaign/create/');
  for (const read of [
    'GET /v1.3/identity/info/',
    'GET /v1.3/identity/video/info/',
    'GET /v1.3/creative/portfolio/get/',
  ]) {
    const at = f.requests.indexOf(read);
    assert.ok(at >= 0 && at < firstCreate, read + ' before the first create: ' + f.requests.join(' | '));
  }
  assert.ok(!f.requests.includes('GET /v1.3/pixel/list/'), 'a traffic pack reads no pixel');
  // The campaign is paused; the ad group and the ad start enabled under it, and joined the campaign and ad group just created.
  assert.equal(f.campaigns.get('900').operation_status, 'DISABLE');
  assert.equal(f.groups.get('901').operation_status, 'ENABLE');
  assert.equal(f.groups.get('901').campaign_id, '900');
  assert.equal(f.ads.get('902').operation_status, 'ENABLE');
  assert.equal(f.ads.get('902').adgroup_id, '901');
  const repeated = await f.call({action: 'run', id, confirmed: true, spend_change_confirmed: true});
  assert.equal(repeated.success, true);
  assert.equal(f.writes.length, 3, 'a completed plan never submits duplicate entities');
  const activation = await f.call({action: 'activation_plan', id});
  assert.equal(activation.success, true, JSON.stringify(activation).slice(0, 1200));
  const draft = (await f.call({action: 'get', id: activation.data.id, detail: 'full'})).data;
  assert.deepEqual(
    draft.steps.map(s => [s.id, s.arguments.action, s.arguments.payload]),
    [
      [
        'activate_campaign',
        'tiktok_smart_plus_campaign_status_update',
        {advertiser_id: '7001', campaign_ids: ['900'], operation_status: 'ENABLE'},
      ],
    ],
  );
  assert.equal(f.writes.length, 3, 'drafting the activation sends nothing');
});

test('the activation of a launch follows how its plan was built, not the constant of the day: a plan whose recipe says its children started DISABLE is turned on in three steps', async t => {
  // S4-2 (the lead's review of eb0c133f): the shape came from tiktokSmartPlusChildStatus at activation time, so flipping that constant after the live
  // check (LV-18) would have given every plan built before the flip the wrong number of steps. The plan's own recipe facts (children_start) decide.
  const f = setup();
  t.after(f.close);
  const {id, result} = await launch(f, traffic, trafficBrief);
  assert.equal(result.success, true, JSON.stringify(result).slice(0, 1500));
  const stored = f.store.document(actor.tenantId, 'campaign_run', id);
  assert.equal(stored.recipe.children_start, 'ENABLE', 'built with the constant of today');
  const {id: _id, revision: _revision, ...data} = stored;
  // The plan as a build after the flip would have saved it: its recipe facts say the children started DISABLE.
  f.store.putDocument(actor.tenantId, 'campaign_run', id, {
    ...data,
    recipe: {...data.recipe, children_start: 'DISABLE'},
  });
  const activation = await f.call({action: 'activation_plan', id});
  assert.equal(activation.success, true, JSON.stringify(activation).slice(0, 1200));
  const draft = (await f.call({action: 'get', id: activation.data.id, detail: 'full'})).data;
  assert.deepEqual(
    draft.steps.map(s => [s.id, s.arguments.action, s.depends_on]),
    [
      ['activate_ad', 'tiktok_smart_plus_ad_status_update', []],
      ['activate_adgroup', 'tiktok_smart_plus_adgroup_status_update', ['activate_ad']],
      ['activate_campaign', 'tiktok_smart_plus_campaign_status_update', ['activate_adgroup']],
    ],
  );
  assert.deepEqual(draft.steps[0].arguments.payload.smart_plus_ad_ids, ['902']);
  assert.deepEqual(draft.steps[1].arguments.payload.adgroup_ids, ['901']);
  assert.deepEqual(draft.steps[2].arguments.payload.campaign_ids, ['900']);
  assert.equal(f.writes.length, 3, 'drafting the activation sends nothing');
});

test('a Smart+ traffic plan for landing page views runs to a verified paused launch with no pixel read, its ad group billed with OCPM', async t => {
  const f = setup();
  t.after(f.close);
  const {id, result} = await launch(f, traffic, {...trafficBrief, optimization_goal: 'TRAFFIC_LANDING_PAGE_VIEW'});
  assert.equal(result.success, true, JSON.stringify(result).slice(0, 1500));
  const plan = await planOf(f, id);
  assert.equal(
    plan.state,
    'complete',
    JSON.stringify(plan.steps.map(s => ({id: s.id, status: s.status, error: s.error}))),
  );
  assert.deepEqual(
    plan.steps.map(s => s.status),
    ['verified', 'verified', 'verified'],
  );
  assert.ok(!f.requests.includes('GET /v1.3/pixel/list/'), 'a landing page view pack reads no pixel');
  assert.equal(f.groups.get('901').optimization_goal, 'TRAFFIC_LANDING_PAGE_VIEW');
  assert.equal(f.groups.get('901').billing_event, 'OCPM');
  assert.equal(f.groups.get('901').operation_status, 'ENABLE');
  assert.equal(f.campaigns.get('900').operation_status, 'DISABLE');
});

// ACC-01: every guided recipe has a run-to-read-back fixture (tests/recipe-run-to-readback.test.mjs names this one).
test('a Smart+ purchases plan runs every create to a verified paused launch, its pixel read first, and one reviewed change turns it all on', async t => {
  const f = setup();
  t.after(f.close);
  const {id, result} = await launch(f, conversions, conversionBrief);
  assert.equal(result.success, true, JSON.stringify(result).slice(0, 1500));
  const plan = await planOf(f, id);
  assert.equal(
    plan.state,
    'complete',
    JSON.stringify(plan.steps.map(s => ({id: s.id, status: s.status, error: s.error}))),
  );
  assert.deepEqual(
    plan.steps.map(s => s.status),
    ['verified', 'verified', 'verified'],
  );
  const pixelRead = f.requests.indexOf('GET /v1.3/pixel/list/'),
    firstCreate = f.requests.indexOf('POST /v1.3/smart_plus/campaign/create/');
  assert.ok(pixelRead >= 0 && pixelRead < firstCreate, f.requests.join(' | '));
  assert.equal(String(f.groups.get('901').pixel_id), '8800');
  assert.equal(f.groups.get('901').optimization_event, 'SHOPPING');
  assert.equal(f.groups.get('901').billing_event, 'OCPM');
  // The go-live is one review: the campaign's status change. Without the spend acknowledgement it stops, and sends nothing.
  const activation = await f.call({action: 'activation_plan', id});
  assert.equal(activation.success, true, JSON.stringify(activation).slice(0, 1200));
  const before = f.writes.length;
  const preview = await f.call({action: 'approve', id: activation.data.id});
  assert.equal(preview.success, true, JSON.stringify(preview).slice(0, 1200));
  const approved = await f.call({
    action: 'approve',
    id: activation.data.id,
    confirmed: true,
    plan_hash: preview.data.plan_hash,
    summary_hash: preview.data.summary_hash,
  });
  assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 1200));
  const stopped = await f.call({action: 'run', id: activation.data.id});
  assert.equal(stopped.data?.run?.stopped, 'needs_spend_change_confirmed', JSON.stringify(stopped).slice(0, 1200));
  assert.equal(f.writes.length, before, 'the status change is not sent without spend_change_confirmed');
  assert.equal(f.campaigns.get('900').operation_status, 'DISABLE');
  const confirmed = await f.call({
    action: 'approve',
    id: activation.data.id,
    confirmed: true,
    plan_hash: preview.data.plan_hash,
    summary_hash: preview.data.summary_hash,
    spend_change_confirmed: true,
  });
  assert.equal(confirmed.success, true, JSON.stringify(confirmed).slice(0, 1200));
  const live = await f.call({action: 'run', id: activation.data.id});
  assert.equal(live.success, true, JSON.stringify(live).slice(0, 1500));
  assert.equal(f.writes.length, before + 1, 'exactly one status change');
  assert.equal(f.writes.at(-1).path, '/v1.3/smart_plus/campaign/status/update/');
  assert.equal(f.campaigns.get('900').operation_status, 'ENABLE');
  assert.equal(f.groups.get('901').operation_status, 'ENABLE', 'the ad group was enabled all along');
  assert.equal(f.ads.get('902').operation_status, 'ENABLE', 'so was the ad: the launch is live after one review');
});

test('the activation of a Smart+ launch names only the verified campaign receipt, and is one step when the children start enabled and three when they start disabled', async () => {
  const {tiktokSmartPlusActivationSteps} = await import('../dist/src/tiktok-recipe-activation.js');
  const {buildTiktokSmartPlusRecipe} = await import('../dist/src/tiktok-smart-plus-recipe.js');
  const results = new Map([
    ['smart_plus_campaign', {data: {code: 0, data: {campaign_id: '900'}}}],
    ['smart_plus_adgroup', {data: {code: 0, data: {adgroup_id: '901'}}}],
    ['smart_plus_ad', {data: {code: 0, data: {smart_plus_ad_id: '902'}}}],
  ]);
  const scope = {connection_id: CONNECTION, account_id: '7001'};
  const steps = activationSteps('tiktok', results, scope);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].gateway, gateway);
  assert.equal(steps[0].arguments.action, 'tiktok_smart_plus_campaign_status_update');
  assert.deepEqual(steps[0].arguments.payload, {
    advertiser_id: '7001',
    campaign_ids: ['900'],
    operation_status: 'ENABLE',
  });
  assert.throws(
    () =>
      activationSteps('tiktok', new Map([['smart_plus_campaign', {data: {data: {}}}]]), {
        connection_id: CONNECTION,
        account_id: '7001',
      }),
    e => e.code === 'ACTIVATION_UNAVAILABLE',
  );
  // If TikTok were to refuse a child created enabled under a disabled campaign, the children start DISABLE (one constant) and the
  // activation is three steps, each after the one before it is verified: ad, ad group, then campaign. Both are tested here.
  const step = (id, description, args, depends_on = []) => ({id, description, arguments: args, depends_on});
  const one = tiktokSmartPlusActivationSteps(results, scope, step, 'ENABLE');
  assert.deepEqual(
    one.map(s => s.id),
    ['activate_campaign'],
  );
  const three = tiktokSmartPlusActivationSteps(results, scope, step, 'DISABLE');
  assert.deepEqual(
    three.map(s => [s.id, s.arguments.action, s.depends_on]),
    [
      ['activate_ad', 'tiktok_smart_plus_ad_status_update', []],
      ['activate_adgroup', 'tiktok_smart_plus_adgroup_status_update', ['activate_ad']],
      ['activate_campaign', 'tiktok_smart_plus_campaign_status_update', ['activate_adgroup']],
    ],
  );
  assert.deepEqual(three[0].arguments.payload, {
    advertiser_id: '7001',
    smart_plus_ad_ids: ['902'],
    operation_status: 'ENABLE',
  });
  assert.deepEqual(three[1].arguments.payload, {
    advertiser_id: '7001',
    adgroup_ids: ['901'],
    operation_status: 'ENABLE',
  });
  assert.deepEqual(three[2].arguments.payload, {
    advertiser_id: '7001',
    campaign_ids: ['900'],
    operation_status: 'ENABLE',
  });
  // The three-step variant reads each ID from its own verified receipt; a gap is refused, never guessed.
  assert.throws(
    () =>
      tiktokSmartPlusActivationSteps(
        new Map([['smart_plus_campaign', results.get('smart_plus_campaign')]]),
        scope,
        step,
        'DISABLE',
      ),
    e => e.code === 'ACTIVATION_UNAVAILABLE',
  );
  // And the builder starts the children as the constant says: ENABLE today; DISABLE builds them paused.
  const enabled = buildTiktokSmartPlusRecipe({...trafficBrief}, false, 'ENABLE'),
    paused = buildTiktokSmartPlusRecipe({...trafficBrief}, false, 'DISABLE');
  assert.deepEqual(
    enabled.steps.map(s => s.arguments.payload.operation_status),
    ['DISABLE', 'ENABLE', 'ENABLE'],
  );
  assert.deepEqual(
    paused.steps.map(s => s.arguments.payload.operation_status),
    ['DISABLE', 'DISABLE', 'DISABLE'],
  );
});

test('the request_id of a step is a positive 63-bit decimal that depends on the plan and the step, and never on the brief', async () => {
  const {tiktokSmartPlusRequestId} = await import('../dist/src/tiktok-smart-plus-recipe.js');
  const seen = new Set();
  for (let plan = 0; plan < 400; plan++)
    for (const step of ['smart_plus_campaign', 'smart_plus_adgroup', 'smart_plus_ad']) {
      const key = tiktokSmartPlusRequestId('plan-' + plan, step);
      assert.match(key, keyShape, key);
      assert.ok(BigInt(key) <= maxKey, key);
      assert.equal(tiktokSmartPlusRequestId('plan-' + plan, step), key, 'the same plan and step give the same key');
      seen.add(key);
    }
  assert.equal(seen.size, 1200, 'no two of 1,200 plan and step pairs share a key');
});

test('a Smart+ plan is held by the guard against creating twice: an identical brief run as a second plan sends no second campaign', async t => {
  const f = setup();
  t.after(f.close);
  const first = await launch(f, traffic, trafficBrief);
  assert.equal(first.result.success, true, JSON.stringify(first.result).slice(0, 800));
  assert.equal(f.writes.length, 3);
  const second = await launch(f, traffic, trafficBrief);
  // The second plan carries other keys (its own plan ID), and the guard still sees an identical create, which its request identity does
  // not tell apart by request_id: nothing is created twice.
  assert.equal(f.writes.length, 3, 'no second campaign: ' + f.writes.map(w => w.path).join(' | '));
  const held = await planOf(f, second.id);
  assert.notEqual(
    held.state,
    'complete',
    JSON.stringify(held.steps.map(s => ({id: s.id, status: s.status, error: s.error?.code}))),
  );
  assert.notDeepEqual(keysOf(held), keysOf(await planOf(f, first.id)), 'the two plans have different keys');
});

test('when the owner forbids activation the preflight of a Smart+ pack blocks the plan before it creates anything, and with activation allowed it is ready', async t => {
  // S3-3 (the lead's review of eb0c133f). The children are compiled ENABLE, which the owner's switch refuses at their prepare, so the plan used to
  // pass its preflight, create the paused campaign, stop at the ad group and leave a Smart+ campaign AMCP cannot delete yet. The preflight
  // now runs the request-only activation scan of the owner policy, and blocks the step that names ENABLE, before the first create.
  const f = setup();
  t.after(f.close);
  saveSpendPolicy(f.store, admin, {scope: 'workspace', confirmed: true, policy: {allow_activation: false}});
  const created = await f.call({action: 'create_from_recipe', recipe: traffic, business: trafficBrief});
  assert.equal(created.success, true, JSON.stringify(created).slice(0, 800));
  const checked = await f.call({action: 'preflight', id: created.data.id});
  assert.equal(checked.success, true, JSON.stringify(checked).slice(0, 800));
  const preflight = (await planOf(f, created.data.id)).preflight,
    blocked = preflight.checks.filter(c => c.status === 'blocked');
  assert.equal(preflight.status, 'blocked');
  // The campaign is created paused, so what is blocked is each child that starts ENABLE, by its own step.
  assert.deepEqual(
    blocked.map(c => c.step),
    ['smart_plus_adgroup', 'smart_plus_ad'],
  );
  for (const c of blocked) {
    assert.equal(c.error.code, 'POLICY_ACTIVATION_FORBIDDEN', JSON.stringify(c.error).slice(0, 300));
    assert.equal(c.error.details.field, 'operation_status');
  }
  const run = await f.call({action: 'run', id: created.data.id});
  assert.notEqual(run.data?.state, 'complete');
  assert.equal(f.writes.length, 0, 'nothing was created: no paused campaign is left behind');
  // The negative: the same pack under a policy that allows activation preflights ready (its other gates are the ones the launch tests prove).
  const g = setup();
  t.after(g.close);
  saveSpendPolicy(g.store, admin, {scope: 'workspace', confirmed: true, policy: {allow_activation: true}});
  const made = await g.call({action: 'create_from_recipe', recipe: traffic, business: trafficBrief});
  assert.equal((await g.call({action: 'preflight', id: made.data.id})).success, true);
  assert.equal((await planOf(g, made.data.id)).preflight.status, 'ready');
});

test('an unavailable identity, a political account, a post the identity does not own, a missing or non-CTA portfolio and an unbound pixel each stop the plan before any create', async t => {
  // [what is wrong, what the advertiser answers, the pack, the step that is blocked, the brief field the block names]. Every one is a
  // CAMPAIGN_PREREQUISITE_REQUIRED that names its field (S3-1, the lead's review of eb0c133f: a portfolio TikTok refuses to return was a retry-shaped
  // PLATFORM_ERROR that named no field).
  const scenarios = [
    [
      'an unavailable identity',
      {identity: {available_status: 'NOT_AVAILABLE'}},
      traffic,
      'smart_plus_ad',
      'identity_id',
    ],
    [
      'an identity that cannot pull its posts',
      {identity: {can_pull_video: false}},
      traffic,
      'smart_plus_ad',
      'identity_id',
    ],
    ['a political account', {identity: {is_gpppa: true}}, traffic, 'smart_plus_ad', 'identity_id'],
    ['a carousel post for a video ad', {post: {item_type: 'CAROUSEL'}}, traffic, 'smart_plus_ad', 'tiktok_item_id'],
    [
      'a post the identity does not own',
      {business: {tiktok_item_id: '7300000000000000999'}},
      traffic,
      'smart_plus_ad',
      'tiktok_item_id',
    ],
    [
      'a CTA portfolio that does not exist',
      {business: {call_to_action_id: '799'}},
      traffic,
      'smart_plus_ad',
      'call_to_action_id',
    ],
    [
      'a card portfolio instead of a CTA portfolio',
      {business: {call_to_action_id: '701'}},
      traffic,
      'smart_plus_ad',
      'call_to_action_id',
    ],
    [
      'an empty CTA portfolio',
      {portfolios: {702: {portfolio_content: []}}, business: {call_to_action_id: '702'}},
      traffic,
      'smart_plus_ad',
      'call_to_action_id',
    ],
    [
      'an unbound pixel',
      {pixel: {asset_ownership: {ownership_status: false, asset_relation_status: 'UNBOUND'}}},
      conversions,
      'smart_plus_adgroup',
      'pixel_id',
    ],
    ['a pixel TikTok does not return', {pixel: {pixel_id: '9999'}}, conversions, 'smart_plus_adgroup', 'pixel_id'],
    // R2.5 field3, package r25-field3-livefix, item 5 (the live check LV-19 CONVERT): the pixel had `events: []`, TikTok refused the ad group with 40002
    // "This pixel event type does not exist" after the campaign was created, and a campaign was left. The preflight reads the pixel's events.
    [
      'a pixel whose list of events is empty',
      {pixel: {events: []}},
      conversions,
      'smart_plus_adgroup',
      'optimization_event',
    ],
    [
      'a pixel that holds another event',
      {pixel: {events: [{event_type: 'ON_WEB_CART', optimization_event: 'ON_WEB_CART', name: 'Add to Cart'}]}},
      conversions,
      'smart_plus_adgroup',
      'optimization_event',
    ],
  ];
  for (const [name, options, recipe, step, field] of scenarios) {
    const f = setup(options);
    t.after(f.close);
    const base = recipe === conversions ? conversionBrief : trafficBrief;
    const created = await f.call({
      action: 'create_from_recipe',
      recipe,
      business: {...base, ...(options.business ?? {})},
    });
    assert.equal(created.success, true, name + ' ' + JSON.stringify(created).slice(0, 600));
    const checked = await f.call({action: 'preflight', id: created.data.id});
    assert.equal(checked.success, true, name + ' ' + JSON.stringify(checked).slice(0, 600));
    const preflight = (await planOf(f, created.data.id)).preflight,
      blocked = preflight.checks.find(c => c.status === 'blocked');
    assert.equal(preflight.status, 'blocked', name);
    assert.equal(blocked.step, step, name + ' ' + JSON.stringify(blocked));
    assert.equal(
      blocked.error.code,
      'CAMPAIGN_PREREQUISITE_REQUIRED',
      name + ' ' + JSON.stringify(blocked.error).slice(0, 300),
    );
    assert.equal(blocked.error.details.field, field, name);
    const run = await f.call({action: 'run', id: created.data.id});
    assert.notEqual(run.data?.state, 'complete', name);
    assert.equal(f.writes.length, 0, 'nothing was created: ' + name);
  }
});

test('the eligibility of a Smart+ pack reads its identity, post, CTA portfolio and pixel, and its plan reuses the check', async t => {
  const f = setup();
  t.after(f.close);
  const out = await f.call({action: 'recipe_eligibility', recipe: conversions, business: conversionBrief, live: true});
  assert.equal(out.success, true, JSON.stringify(out).slice(0, 800));
  assert.equal(out.data.status, 'unknown', JSON.stringify(out.data.blockers));
  const row = id => out.data.dependencies.find(d => d.id === id);
  assert.equal(row('tiktok_spark_identity').status, 'ready');
  assert.equal(row('existing_tiktok_post').status, 'ready');
  assert.equal(row('dynamic_cta_portfolio').status, 'ready');
  assert.equal(row('dynamic_cta_portfolio').evidence.asset_type, 'TikTok CTA portfolio');
  assert.equal(row('dynamic_cta_portfolio').evidence.asset_id, '700');
  assert.equal(row('account_owned_pixel').status, 'ready');
  assert.equal(row('conversion_event_delivery').status, 'unknown', 'pixel access never proves event delivery');
  assert.equal(row('provider_objective_acceptance').status, 'unknown');
  // The evidence keeps the hash of what was read and no body or link.
  assert.ok(JSON.stringify(row('dynamic_cta_portfolio').evidence.source_reference).includes('response_hash'));
  assert.ok(!JSON.stringify(row('dynamic_cta_portfolio').evidence).includes('201781'), 'no portfolio content is kept');
  assert.equal(f.writes.length, 0, 'eligibility never writes');
  // The plan made from this exact brief reuses the check: the keys it was saved with do not change what was checked.
  const created = await f.call({
    action: 'create_from_recipe',
    recipe: conversions,
    business: conversionBrief,
    eligibility_ref: out.data.eligibility_ref,
  });
  assert.equal(created.success, true, JSON.stringify(created).slice(0, 800));
  assert.equal(created.data.eligibility_reuse?.applied, true, JSON.stringify(created.data.eligibility_reuse));
  const traffic_ = await f.call({action: 'recipe_eligibility', recipe: traffic, business: trafficBrief, live: true});
  assert.equal(traffic_.success, true, JSON.stringify(traffic_).slice(0, 800));
  assert.equal(
    traffic_.data.dependencies.find(d => d.id === 'dynamic_cta_portfolio').status,
    'ready',
    'the traffic pack checks its portfolio too',
  );
  assert.equal(
    traffic_.data.dependencies.find(d => d.id === 'account_owned_pixel'),
    undefined,
    'and no pixel',
  );
});

/**
 * R2.5 field3, package r25-field3-livefix, item 6 and its fix round (the lead's review, S2-1). The plan engine prepares a step again, after a short wait, only when the
 * refusal says that a read did not find an object that a verified earlier step of the same plan created. These are the two refusals the first version of that rule
 * wrongly retried and relabeled as a read delay, each on a step that references a verified create: a post that TikTok no longer returns (the reviewer's scratch case), and
 * item 8's refusal of a Smart+ campaign that is deleted. Each is prepared once and keeps its own remedy and its amendment call; the live shape (the ad group the plan
 * just created is not returned yet) is retried in tests/tiktok-launch-recipes.test.mjs.
 */
test('a post that is gone when the ad step is prepared is refused once, with its own remedy and amendment call: it is no read delay and the step is not prepared again', async t => {
  const was = setPlanReadLagWaits([0, 0]);
  t.after(() => setPlanReadLagWaits(was));
  let armed = false,
    postReads = 0;
  const f = setup({
    routes: (method, path) => {
      if (method === 'POST' && path === '/v1.3/smart_plus/adgroup/create/') armed = true;
      if (armed && method === 'GET' && path === '/v1.3/identity/video/info/') {
        postReads++;
        return Response.json({code: 0, message: 'OK', request_id: 'r', data: {video_details: []}});
      }
    },
  });
  t.after(f.close);
  const {id, result} = await launch(f, traffic, trafficBrief);
  const ad = (await planOf(f, id)).steps.find(s => s.id === 'smart_plus_ad');
  assert.equal(ad.status, 'failed', JSON.stringify(ad).slice(0, 600));
  assert.equal(ad.submission, 'not_submitted');
  assert.equal(ad.error.code, 'STATE_TARGET_MISMATCH');
  assert.equal(postReads, 1, 'the ad step was prepared once, so the post was read once');
  assert.equal(ad.error.details?.read_delay, undefined, 'no note of a read delay');
  assert.deepEqual(
    ad.error.details?.requested_ids,
    ['7300000000000000001'],
    'the refusal names the post it could not find',
  );
  assert.doesNotMatch(ad.error.next_action, /read delay/);
  assert.match(ad.error.remedy.action, /different object/, 'its own remedy stays');
  // Its next call is the step's amendment call (a correction of its arguments), not a recover_step with no change.
  const next = result.data.next_call;
  assert.equal(next.arguments.action, 'recover_step');
  assert.ok(
    next.correct ?? next.choose,
    'the amendment call names what to correct: ' + JSON.stringify(next).slice(0, 400),
  );
  assert.equal(next.meaning, undefined, 'it is not the read-delay call');
  assert.deepEqual(
    f.writes.map(w => w.path),
    ['/v1.3/smart_plus/campaign/create/', '/v1.3/smart_plus/adgroup/create/'],
    'nothing was sent for the ad',
  );
});

test('item 8’s refusal of a deleted Smart+ campaign inside a plan keeps its own remedy and amendment call: it is no read delay and the step is not prepared again', async t => {
  const was = setPlanReadLagWaits([0, 0]);
  t.after(() => setPlanReadLagWaits(was));
  let f,
    armed = false,
    statusReads = 0;
  f = setup({
    routes: (method, path, url) => {
      if (method === 'POST' && path === '/v1.3/smart_plus/campaign/create/') armed = true;
      if (armed && method === 'GET' && path === '/v1.3/smart_plus/campaign/get/') {
        const filtering = JSON.parse(url.searchParams.get('filtering') ?? '{}');
        // The review of a Smart+ status change reads with every status; the campaign the plan created has been deleted since.
        if (filtering.primary_status === 'STATUS_ALL') {
          statusReads++;
          const list = (filtering.campaign_ids ?? [])
            .filter(i => f.campaigns.has(i))
            .map(i => ({...f.campaigns.get(i), secondary_status: 'CAMPAIGN_STATUS_DELETE'}));
          return Response.json({
            code: 0,
            message: 'OK',
            request_id: 'r',
            data: {list, page_info: {page: 1, page_size: 100, total_number: list.length, total_page: 1}},
          });
        }
      }
    },
  });
  t.after(f.close);
  const [campaignStep] = campaignRecipe(traffic, trafficBrief).steps,
    created = await f.call({
      action: 'create',
      name: 'Synthetic create and pause',
      steps: [
        {
          ...campaignStep,
          arguments: {
            ...campaignStep.arguments,
            payload: {...campaignStep.arguments.payload, request_id: '9100000000000000001'},
          },
        },
        {
          id: 'pause',
          kind: 'write',
          gateway,
          connection_id: CONNECTION,
          account_id: smartPlusWebAccount,
          arguments: {
            action: 'tiktok_smart_plus_campaign_status_update',
            account_id: smartPlusWebAccount,
            payload: {
              campaign_ids: [{$ref: 'smart_plus_campaign#/data/data/campaign_id'}],
              operation_status: 'DISABLE',
            },
          },
          depends_on: ['smart_plus_campaign'],
        },
      ],
    });
  assert.equal(created.success, true, JSON.stringify(created).slice(0, 800));
  const id = created.data.id,
    preview = await f.call({action: 'approve', id}),
    approved = await f.call({
      action: 'approve',
      id,
      confirmed: true,
      plan_hash: preview.data.plan_hash,
      summary_hash: preview.data.summary_hash,
    });
  assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 800));
  const result = await f.call({action: 'run', id});
  const step = (await planOf(f, id)).steps.find(s => s.id === 'pause');
  assert.equal(step.status, 'failed', JSON.stringify([result, step]).slice(0, 800));
  assert.equal(step.error.code, 'STATE_TARGET_MISMATCH');
  assert.equal(step.error.details.blocked_by, 'deleted_target');
  assert.equal(statusReads, 1, 'the status step was prepared once, so its target was read once');
  assert.equal(step.error.details.read_delay, undefined, 'no note of a read delay');
  assert.match(
    step.error.remedy.action,
    /no longer lets a deleted object/,
    'the remedy of the refusal, not the read delay’s',
  );
  assert.doesNotMatch(step.error.next_action, /read delay/);
  assert.equal(result.data.next_call.meaning, undefined, 'its next call is not the read-delay call');
  assert.deepEqual(
    f.writes.map(w => w.path),
    ['/v1.3/smart_plus/campaign/create/'],
    'nothing was sent for the status change',
  );
});

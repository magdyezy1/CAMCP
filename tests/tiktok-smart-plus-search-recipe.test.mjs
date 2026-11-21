import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {campaignRecipe, campaignRecipes} from '../dist/src/campaign-recipes.js';
import {dependencyResolution, recipeDependencies} from '../dist/src/capability-eligibility.js';
import {recipeContext, recipeObjective} from '../dist/src/recipe-context.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {recipeComposerFixture} from './fixtures/recipe-composer-ui.mjs';
import {
  smartPlusSearchAccount,
  smartPlusSearchAdvertiser,
  smartPlusSearchBriefs,
} from './fixtures/tiktok-smart-plus-search.mjs';
import {smartPlusWebBriefs} from './fixtures/tiktok-smart-plus-web.mjs';

/**
 * R2.5 M4, package r25-m4-search2, item 5: the guided Upgraded Smart+ Search pack for Sales with a website destination. It builds a paused
 * Smart+ Search campaign (is_search_campaign, campaign budget optimization off and no campaign limit: TikTok allows Search only with it off,
 * S2-1), a website ad group that carries the advertiser's one daily budget, its keywords (custom targeting and the TikTok search placement only,
 * S2-2) and optimizes clicks or a purchase event, and a Spark Ad from an existing post, the last two starting ENABLE under the disabled campaign
 * (Q14, L1-05) so that enabling the campaign is the one reviewed activation. It is the Smart+ route to Search that stays when TikTok's
 * migration guide ends manual creates after 2026-12-31 (the lead's note, SPLIT row 8). A synthetic advertiser answers the reads and the
 * writes (tests/fixtures/tiktok-smart-plus-search.mjs, the fixture of journey J24); nothing reaches TikTok.
 *
 * Smart+ Search campaigns are allowlist-only for each objective: an advertiser that is not on the list is refused at the campaign create
 * with code 40118, recorded as rejected with nothing created. No read shows the list, so preflight cannot check it, and the pack, its
 * step and its context say so. The request_id of the two creates that need one is the plan's own (the lead's decision L3), as in the
 * other Smart+ packs.
 */
const gateway = 'tiktok_native_action',
  CONNECTION = '25252525-2525-4252-8252-252525252525',
  actor = {tenantId: 'tiktok-smart-plus-search-recipe', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'},
  account = smartPlusSearchAccount;
const search = 'tiktok_smart_plus_search_website';
const placeholder = 'assigned when the plan is saved';
const keyShape = /^[1-9][0-9]{0,18}$/;
const {clicks: clicksBrief, conversions: conversionsBrief} = smartPlusSearchBriefs(CONNECTION);
const records = [
  {keyword: 'running shoes', match_type: 'PHRASE_WORD'},
  {keyword: 'trail shoes', match_type: 'PRECISE_WORD'},
  {keyword: 'shoe sale', match_type: 'BROAD_WORD'},
];
const definitionOf = id => campaignRecipes.find(r => r.id === id);

/** A synthetic advertiser behind a service with its own store; `options` are the fixture's (allowlisted, keywordOrder, identity, pixel, ...). */
function setup(options = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 73).toString('base64'));
  store.putConnection(
    admin,
    {
      id: CONNECTION,
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'TikTok login',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const advertiser = smartPlusSearchAdvertiser(options),
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

test('the Search pack is a guided recipe with its declared dependencies and the three Smart+ create actions; it groups as search on the server and on the page', () => {
  const definition = definitionOf(search);
  assert.ok(definition, 'a guided recipe');
  assert.equal(definition.platform, 'tiktok');
  for (const key of [
    'name',
    'account_id',
    'connection_id',
    'currency',
    'daily_budget',
    'location_ids',
    'tiktok_item_id',
    'identity_type',
    'identity_id',
    'destination_url',
    'call_to_action_id',
    'start_time',
    'keywords',
  ])
    assert.ok(definition.required.includes(key), 'requires ' + key);
  assert.ok(!definition.required.includes('call_to_action'), 'the classic CTA name is no input of a Smart+ pack');
  assert.ok(!definition.required.includes('end_time') && !definition.optional.includes('end_time'), 'no end time');
  // The goal and its pixel are the brief's choice: CLICK needs no pixel, so none is required of every brief.
  for (const key of ['optimization_goal', 'pixel_id', 'optimization_event', 'identity_authorized_bc_id'])
    assert.ok(definition.optional.includes(key), 'optional ' + key);
  assert.ok(!definition.required.includes('pixel_id'));
  assert.deepEqual(recipeDependencies[search].actions, [
    'tiktok_smart_plus_campaign_create',
    'tiktok_smart_plus_adgroup_create',
    'tiktok_smart_plus_ad_create',
  ]);
  for (const object of [
    'tiktok_spark_identity',
    'existing_tiktok_post',
    'dynamic_cta_portfolio',
    'search_keywords',
    'smart_plus_search_allowlist',
  ])
    assert.ok(recipeDependencies[search].objects.includes(object), 'depends on ' + object);
  // What it creates, in the words of the dependency list and of the catalogue entry: the campaign has no budget, the ad group has the one.
  assert.match(recipeDependencies[search].effects, /campaign with no budget of its own/);
  assert.match(recipeDependencies[search].effects, /ad group with one daily budget/);
  assert.match(definition.description, /ad group with one daily budget/);
  assert.doesNotMatch(definition.description, /campaign with one daily budget/);
  // Only TikTok decides its allowlist: it is never ready in advance.
  assert.equal(dependencyResolution('smart_plus_search_allowlist'), 'native_review_only');
  // The catalog lists it after the other two Smart+ packs.
  const ids = campaignRecipes.map(r => r.id);
  assert.ok(ids.indexOf('tiktok_smart_plus_website_conversions') < ids.indexOf(search));
  // A Search pack is search acquisition (the ID holds neither lead nor _traffic, and is no sales pack).
  assert.equal(recipeObjective(search), 'search');
  assert.equal(recipeObjective('tiktok_smart_plus_website_traffic'), 'traffic');
  assert.equal(recipeObjective('tiktok_smart_plus_website_conversions'), 'sales');
});

test('the page groups the Search pack as search and labels its three dependencies, in English and in Arabic', () => {
  for (const locale of ['en', 'ar']) {
    const f = recipeComposerFixture(locale, definitionOf(search), clicksBrief);
    assert.equal(f.run("recipeObjectiveOf('" + search + "')"), 'search', locale);
    for (const [code, english] of [
      ['recipeDependencyLabels.search_keywords', 'Search keywords and match types'],
      ['recipeDependencyLabels.smart_plus_search_allowlist', 'TikTok Smart+ Search allowlist for this objective'],
      ['recipeDependencyLabels.automatic_search_bidding', 'Automatic bidding for the chosen Search goal'],
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

test('a Search brief for clicks compiles to the three Smart+ creates: a DISABLE Search campaign with budget optimization off, an ENABLE CLICK keyword ad group with the daily budget and an ENABLE Spark Ad', () => {
  const before = JSON.stringify(clicksBrief),
    plan = campaignRecipe(search, clicksBrief);
  assert.equal(JSON.stringify(clicksBrief), before, 'the brief is not mutated');
  assert.deepEqual(
    plan.steps.map(s => [s.id, s.arguments.action, s.depends_on]),
    [
      ['smart_plus_campaign', 'tiktok_smart_plus_campaign_create', []],
      ['smart_plus_adgroup', 'tiktok_smart_plus_adgroup_create', ['smart_plus_campaign']],
      ['smart_plus_ad', 'tiktok_smart_plus_ad_create', ['smart_plus_adgroup']],
    ],
  );
  assert.ok(plan.steps.every(s => s.gateway === gateway && s.expected_currency === 'USD' && s.account_id === account));
  const [c, g, a] = plan.steps.map(s => s.arguments.payload);
  assert.deepEqual(c, {
    advertiser_id: account,
    request_id: placeholder,
    operation_status: 'DISABLE',
    objective_type: 'WEB_CONVERSIONS',
    sales_destination: 'WEBSITE',
    campaign_name: 'Synthetic Smart+ Search clicks',
    // TikTok allows Search only with campaign budget optimization off, which must be sent (its default is on): the campaign carries no limit,
    // and the one daily budget is the ad group's (S2-1; the choice of no limit over a daily hard cap is the lead's to reverse).
    budget_optimize_on: false,
    budget_mode: 'BUDGET_MODE_INFINITE',
    is_search_campaign: true,
  });
  assert.deepEqual(g.campaign_id, {$ref: 'smart_plus_campaign#/data/data/campaign_id'});
  assert.equal(g.request_id, placeholder);
  assert.equal(g.operation_status, 'ENABLE', 'the ad group starts enabled under the disabled campaign (L1-05)');
  assert.equal(g.adgroup_name, 'Synthetic Smart+ Search clicks · Search');
  assert.equal(g.promotion_type, 'WEBSITE');
  assert.equal(g.optimization_goal, 'CLICK');
  assert.equal(g.billing_event, 'CPC');
  assert.equal(g.bid_type, 'BID_TYPE_NO_BID');
  assert.deepEqual(g.search_keywords, records, 'the keywords are sent as the brief gave them, in its order');
  assert.equal(g.pixel_id, undefined);
  assert.equal(g.optimization_event, undefined);
  // The one daily budget is the ad group's: the dynamic daily mode, which is what SCHEDULE_FROM_NOW below needs.
  assert.equal(g.budget_mode, 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET');
  assert.equal(g.budget, 25.5);
  assert.equal(c.budget, undefined, 'the campaign carries no budget');
  assert.equal(g.schedule_type, 'SCHEDULE_FROM_NOW');
  assert.equal(g.schedule_end_time, undefined);
  assert.equal(g.placement_type, 'PLACEMENT_TYPE_NORMAL');
  assert.deepEqual(g.placements, ['PLACEMENT_TIKTOK']);
  // Custom targeting is sent, not defaulted: TikTok's create defaults to AUTOMATIC and its Search pages ask for MANUAL (S2-2).
  assert.equal(g.targeting_optimization_mode, 'MANUAL');
  assert.deepEqual(g.targeting_spec, {location_ids: ['6252001', '102358']});
  // What TikTok's pages leave open is not sent: no keyword bid, no pacing, no search_result_enabled, no automated keywords.
  for (const key of [
    'search_result_enabled',
    'pacing',
    'keyword_bid_type',
    'keyword_bid',
    'automated_keywords_enabled',
  ])
    assert.equal(g[key], undefined, key);
  assert.equal(a.request_id, undefined, 'the Smart+ ad create has no request_id');
  assert.equal(a.operation_status, 'ENABLE');
  assert.deepEqual(a.ad_configuration, {
    call_to_action_id: '700',
    creative_auto_add_toggle: false,
    creative_auto_enhancement_strategy_list: [],
  });
  assert.equal(plan.steps[0].prerequisites, undefined);
  assert.equal(plan.steps[1].prerequisites, undefined, 'a click ad group has no pixel to check');
  assert.deepEqual(plan.steps[2].prerequisites, ['tiktok_spark_post', 'tiktok_cta_portfolio']);
  // The campaign step names the list that decides it, before it is run and after TikTok refuses it.
  assert.match(plan.steps[0].description, /allowlist/);
  assert.match(plan.steps[0].description, /40118/);
  assert.equal(plan.recipe.id, search);
  assert.equal(plan.recipe.optimization_goal, 'CLICK');
  assert.equal(plan.recipe.budget_level, 'adgroup', 'the budget the facts name is the ad group’s');
  assert.equal(plan.recipe.daily_budget, '25.5');
  assert.match(plan.recipe.bidding_effect, /ad group’s daily budget/);
  assert.doesNotMatch(plan.recipe.bidding_effect, /campaign’s daily budget/);
  assert.equal(plan.recipe.children_start, 'ENABLE');
  assert.deepEqual(plan.recipe.keywords, {
    count: 3,
    by_match_type: {PRECISE_WORD: 1, PHRASE_WORD: 1, BROAD_WORD: 1},
  });
  assert.match(plan.recipe.allowlist_acceptance, /40118/);
});

test('a Search brief for purchases adds the pixel and its event, bills with OCPM, and has its pixel read before any create; a Business Center identity is carried', () => {
  const plan = campaignRecipe(search, {
    ...conversionsBrief,
    identity_type: 'BC_AUTH_TT',
    identity_authorized_bc_id: '5550001',
  });
  const [c, g, a] = plan.steps.map(s => s.arguments.payload);
  assert.equal(c.is_search_campaign, true);
  assert.equal(g.optimization_goal, 'CONVERT');
  assert.equal(g.billing_event, 'OCPM');
  assert.equal(g.pixel_id, '8800');
  assert.equal(g.optimization_event, 'SHOPPING');
  assert.deepEqual(g.search_keywords, records);
  assert.deepEqual(plan.steps[1].prerequisites, ['tiktok_pixel']);
  assert.deepEqual(a.creative_list[0].creative_info.identity_authorized_bc_id, '5550001');
  assert.equal(plan.recipe.optimization_goal, 'CONVERT');
  assert.equal(plan.recipe.optimization_event, 'SHOPPING');
});

test('keywords are accepted as records and as lines written MATCH_TYPE: keyword, and compile to the same list, trimmed', () => {
  const lines = ['PHRASE_WORD: running shoes', ' PRECISE_WORD :trail shoes ', 'BROAD_WORD: shoe sale'];
  const fromLines = campaignRecipe(search, {...clicksBrief, keywords: lines});
  assert.deepEqual(fromLines.steps[1].arguments.payload.search_keywords, records);
  const mixed = campaignRecipe(search, {
    ...clicksBrief,
    keywords: [lines[0], {keyword: ' trail shoes ', match_type: 'PRECISE_WORD'}, lines[2]],
  });
  assert.deepEqual(mixed.steps[1].arguments.payload.search_keywords, records);
  // The match type is what comes before the first colon: a keyword that holds another is split there, and TikTok excludes the colon in a keyword,
  // so what follows is refused as a keyword (S3-1), not as a match type, which shows where the line was cut.
  assert.throws(
    () => campaignRecipe(search, {...clicksBrief, keywords: ['BROAD_WORD: sale: now']}),
    e => assertRefused(e, 'RECIPE_INPUT_INVALID') && e.details.field === 'keywords/0/keyword',
  );
  // The same brief in either form is one plan, up to nothing at all.
  assert.deepEqual(fromLines.steps, campaignRecipe(search, clicksBrief).steps);
});

test('Search briefs TikTok would refuse, or that AMCP cannot express exactly, are refused before anything is saved', () => {
  const many = n => Array.from({length: n}, (_, i) => ({keyword: 'term ' + i, match_type: 'BROAD_WORD'}));
  const refusals = [
    [clicksBrief, {keywords: []}, 'RECIPE_INPUT_INVALID', 'keywords'],
    [clicksBrief, {keywords: many(1001)}, 'RECIPE_INPUT_INVALID', 'keywords'],
    [clicksBrief, {keywords: 'running shoes'}, 'RECIPE_INPUT_INVALID', 'keywords'],
    [clicksBrief, {keywords: ['running shoes']}, 'RECIPE_INPUT_INVALID', 'keywords/0'],
    [clicksBrief, {keywords: ['BROAD_WORD:   ']}, 'RECIPE_INPUT_INVALID', 'keywords/0/keyword'],
    [clicksBrief, {keywords: ['EXACT: shoes']}, 'RECIPE_INPUT_INVALID', 'keywords/0/match_type'],
    [
      clicksBrief,
      {keywords: [{keyword: 'shoes', match_type: 'EXACT'}]},
      'RECIPE_INPUT_INVALID',
      'keywords/0/match_type',
    ],
    [clicksBrief, {keywords: [{keyword: 'shoes'}]}, 'RECIPE_INPUT_INVALID', 'keywords/0/match_type'],
    // The rules of one keyword (S3-1): at most 80 characters, no emoji, none of ! # $ % & ( ) * - / : ; < > ? @ \ ^ _ ¥ …, no control character.
    [clicksBrief, {keywords: ['BROAD_WORD: ' + 'a'.repeat(81)]}, 'RECIPE_INPUT_INVALID', 'keywords/0/keyword'],
    [clicksBrief, {keywords: [{keyword: 'running-shoes', match_type: 'BROAD_WORD'}]}, 'RECIPE_INPUT_INVALID', 'keywords/0/keyword'],
    [clicksBrief, {keywords: ['PHRASE_WORD: shoes 😀']}, 'RECIPE_INPUT_INVALID', 'keywords/0/keyword'],
    [clicksBrief, {keywords: ['BROAD_WORD: shoes_sale']}, 'RECIPE_INPUT_INVALID', 'keywords/0/keyword'],
    [clicksBrief, {keywords: ['BROAD_WORD: ok', 'BROAD_WORD: sale\u0000']}, 'RECIPE_INPUT_INVALID', 'keywords/1/keyword'],
    [
      clicksBrief,
      {keywords: [{keyword: 'shoes', match_type: 'BROAD_WORD', keyword_bid: 1}]},
      'RECIPE_INPUT_INVALID',
      'keywords/0',
    ],
    [
      clicksBrief,
      {keywords: ['BROAD_WORD: shoes', {keyword: 'shoes', match_type: 'BROAD_WORD'}]},
      'RECIPE_INPUT_INVALID',
      'keywords/1',
    ],
    // A click brief takes no pixel; a purchases brief needs both.
    [clicksBrief, {pixel_id: '8800'}, 'RECIPE_INPUT_INVALID', 'pixel_id'],
    [clicksBrief, {optimization_event: 'SHOPPING'}, 'RECIPE_INPUT_INVALID', 'optimization_event'],
    [{...conversionsBrief, pixel_id: undefined}, {}, 'RECIPE_INPUT_INVALID', 'pixel_id'],
    [{...conversionsBrief, optimization_event: undefined}, {}, 'RECIPE_INPUT_INVALID', 'optimization_event'],
    [conversionsBrief, {optimization_event: 'PAGE_VIEW'}, 'RECIPE_INPUT_INVALID', 'optimization_event'],
    // The goals of a Smart+ Search ad group are CLICK and CONVERT, and nothing else.
    [clicksBrief, {optimization_goal: 'TRAFFIC_LANDING_PAGE_VIEW'}, 'RECIPE_INPUT_INVALID', 'optimization_goal'],
    [clicksBrief, {optimization_goal: 'VALUE'}, 'RECIPE_INPUT_INVALID', 'optimization_goal'],
    [clicksBrief, {optimization_goal: 'click'}, 'RECIPE_INPUT_INVALID', 'optimization_goal'],
    [clicksBrief, {optimization_goal: 7}, 'RECIPE_INPUT_INVALID', 'optimization_goal'],
    // What every Smart+ pack refuses: an end time, the classic CTA name, a landing page that is not HTTPS.
    [clicksBrief, {end_time: '2026-12-30T23:00:00Z'}, 'RECIPE_INPUT_INVALID', 'end_time'],
    [clicksBrief, {call_to_action: 'LEARN_MORE'}, 'RECIPE_INPUT_INVALID', 'call_to_action'],
    [clicksBrief, {destination_url: 'http://example.com/'}, 'DESTINATION_REQUIRED'],
    [clicksBrief, {identity_type: 'CUSTOMIZED_USER'}, 'RECIPE_INPUT_INVALID', 'identity_type'],
  ];
  for (const [business, patch, code, field] of refusals)
    assert.throws(
      () => campaignRecipe(search, {...business, ...patch}),
      e => assertRefused(e, code) && (field === undefined || e.details.field === field),
      JSON.stringify(patch).slice(0, 120),
    );
  // A required input that is missing is named, and so are the keywords.
  for (const key of ['keywords', 'call_to_action_id', 'start_time']) {
    const b = {...clicksBrief};
    delete b[key];
    assert.throws(
      () => campaignRecipe(search, b),
      e => e.code === 'RECIPE_INPUT_REQUIRED' && e.details.missing_fields.includes(key),
      key,
    );
  }
});

test('the other Smart+ packs send no Search field: their compile is what it was', () => {
  const {traffic, conversions} = smartPlusWebBriefs(CONNECTION);
  for (const [id, business] of [
    ['tiktok_smart_plus_website_traffic', traffic],
    ['tiktok_smart_plus_website_conversions', conversions],
  ]) {
    const text = JSON.stringify(campaignRecipe(id, business).steps);
    for (const word of ['is_search_campaign', 'search_keywords', 'automated_keywords_enabled'])
      assert.ok(!text.includes(word), id + ' names ' + word);
  }
});

test('recipe context names the allowlist, the keywords and the CTA portfolio without a provider request', t => {
  const f = setup();
  t.after(f.close);
  const context = recipeContext(f.store, actor, search);
  assert.deepEqual(
    context.targets.map(x => [x.connection_id, x.account_id, x.write_granted]),
    [[CONNECTION, account, true]],
  );
  assert.match(context.limitations[0], /Smart\+ Search/);
  assert.match(context.limitations[0], /allowlist/);
  assert.match(context.limitations[0], /40118/);
  assert.ok(
    context.prerequisites.some(p => /allowlist/.test(p) && /CTA portfolio/.test(p) && /keywords/.test(p)),
    'the prerequisite names the allowlist, the CTA portfolio and the keywords: ' +
      JSON.stringify(context.prerequisites),
  );
  assert.equal(f.requests.length, 0);
});

test('preview_recipe shows the Search steps with the request_id as assigned when the plan is saved and sends nothing', async t => {
  const f = setup();
  t.after(f.close);
  const out = await f.call({action: 'preview_recipe', recipe: search, business: clicksBrief});
  assert.equal(out.success, true, JSON.stringify(out).slice(0, 800));
  assert.equal(out.data.provider_mutations, 0);
  const steps = out.data.plan.steps;
  assert.equal(steps[0].arguments.payload.request_id, placeholder);
  assert.equal(steps[0].arguments.payload.is_search_campaign, true);
  assert.equal(steps[1].arguments.payload.request_id, placeholder);
  assert.equal(steps[1].arguments.payload.search_keywords.length, 3);
  assert.equal(steps[2].arguments.payload.request_id, undefined);
  assert.equal(f.writes.length + f.requests.length, 0, 'a preview reads and sends nothing');
});

test('a saved Search plan assigns each create its own request_id; two plans of one brief never share one', async t => {
  const f = setup();
  t.after(f.close);
  const seen = new Set();
  const first = await f.call({action: 'create_from_recipe', recipe: search, business: clicksBrief}),
    second = await f.call({action: 'create_from_recipe', recipe: search, business: clicksBrief});
  assert.equal(first.success, true, JSON.stringify(first).slice(0, 600));
  assert.equal(second.success, true, JSON.stringify(second).slice(0, 600));
  assert.notEqual(first.data.id, second.data.id, 'two plans, not one');
  const a = keysOf(await planOf(f, first.data.id)),
    b = keysOf(await planOf(f, second.data.id));
  for (const key of [a.campaign, a.adgroup, b.campaign, b.adgroup]) {
    assert.match(key, keyShape, key);
    assert.ok(!seen.has(key), 'every key of every plan is its own: ' + key);
    seen.add(key);
  }
  assert.ok(
    !JSON.stringify((await planOf(f, first.data.id)).steps).includes(placeholder),
    'no placeholder is left in a saved plan',
  );
  assert.equal(f.writes.length, 0, 'saving a plan sends nothing');
});

test('a Search plan for clicks reaches a verified paused launch in four MCP calls with exactly three creates, the keywords read back as a set, and drafts its one activation', async t => {
  // The fixture lists the keywords in another order at every read, with a review status that moves: neither is a difference, for the ad
  // group's verification or for the review of the ad created under it.
  const f = setup({keywordOrder: 'rotating'});
  t.after(f.close);
  const {id, result} = await launch(f, search, clicksBrief);
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
  assert.ok(!f.requests.includes('GET /v1.3/pixel/list/'), 'a click pack reads no pixel');
  // The campaign is a Search campaign and paused; the ad group carries the keywords and, with the ad, starts enabled under it.
  assert.equal(f.campaigns.get('900').is_search_campaign, true);
  assert.equal(f.campaigns.get('900').operation_status, 'DISABLE');
  assert.deepEqual(f.groups.get('901').search_keywords, records);
  assert.equal(f.groups.get('901').operation_status, 'ENABLE');
  // The campaign has budget optimization off and no limit; the ad group's daily budget is what TikTok holds (S2-1).
  assert.equal(f.campaigns.get('900').budget_optimize_on, false);
  assert.equal(f.campaigns.get('900').budget_mode, 'BUDGET_MODE_INFINITE');
  assert.equal(f.groups.get('901').budget_mode, 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET');
  assert.equal(f.groups.get('901').budget, 25.5);
  assert.equal(f.ads.get('902').operation_status, 'ENABLE');
  assert.equal(f.writes[0].body.request_id, keysOf(plan).campaign);
  assert.equal(f.writes[1].body.request_id, keysOf(plan).adgroup);
  assert.equal(f.writes.length, 3);
  const activation = await f.call({action: 'activation_plan', id});
  assert.equal(activation.success, true, JSON.stringify(activation).slice(0, 1200));
  const draft = (await f.call({action: 'get', id: activation.data.id, detail: 'full'})).data;
  assert.deepEqual(
    draft.steps.map(s => [s.id, s.arguments.action, s.arguments.payload]),
    [
      [
        'activate_campaign',
        'tiktok_smart_plus_campaign_status_update',
        {advertiser_id: account, campaign_ids: ['900'], operation_status: 'ENABLE'},
      ],
    ],
  );
  // The go-live names what starts spending: the campaign carries no budget, the ad group's daily budget does (S2-1).
  assert.match(draft.steps[0].description, /no budget of its own/);
  assert.match(draft.steps[0].description, /ad group’s daily budget of 25\.5 USD/);
  assert.equal(f.writes.length, 3, 'drafting the activation sends nothing');
});

test('the owner’s budget cap reads the Search pack’s ad group budget: its campaign step, which carries none, is not stopped, and the ad group step is; a cap that fits lets the plan through', async t => {
  // The budget is the ad group's now (S2-1), so the cap is first met at the ad group's review, after the paused campaign exists. The preflight
  // judges no budget cap (only the activation switch, smartweb S3-3), so this cannot be known earlier: recorded as a limit of the structure.
  const f = setup();
  t.after(f.close);
  saveSpendPolicy(f.store, admin, {scope: 'workspace', confirmed: true, policy: {enforcement: 'block', max_budget_native: 20}});
  const {id} = await launch(f, search, clicksBrief);
  const plan = await planOf(f, id);
  assert.notEqual(plan.state, 'complete');
  assert.equal(plan.steps[0].status, 'verified', 'the campaign carries no budget: no cap applies to it');
  assert.equal(plan.steps[1].status, 'failed', JSON.stringify(plan.steps.map(s => [s.id, s.status, s.error?.code])));
  assert.equal(plan.steps[1].error.code, 'POLICY_BUDGET_LIMIT', JSON.stringify(plan.steps[1].error).slice(0, 300));
  assert.equal(plan.steps[2].status, 'pending');
  assert.deepEqual(
    f.writes.map(w => w.path),
    ['/v1.3/smart_plus/campaign/create/'],
    'only the campaign was created, paused; the ad group and the ad were never sent',
  );
  const g = setup();
  t.after(g.close);
  saveSpendPolicy(g.store, admin, {scope: 'workspace', confirmed: true, policy: {enforcement: 'block', max_budget_native: 30}});
  const {result} = await launch(g, search, clicksBrief);
  assert.equal(result.success, true, JSON.stringify(result).slice(0, 800));
  assert.equal(g.writes.length, 3);
});

test('a Search plan for purchases reads its pixel first, runs every create to verified, and one reviewed change turns it on, which needs the spend flag', async t => {
  const f = setup();
  t.after(f.close);
  const {id, result} = await launch(f, search, conversionsBrief);
  assert.equal(result.success, true, JSON.stringify(result).slice(0, 1500));
  const plan = await planOf(f, id);
  assert.equal(
    plan.state,
    'complete',
    JSON.stringify(plan.steps.map(s => ({id: s.id, status: s.status, error: s.error}))),
  );
  const pixelRead = f.requests.indexOf('GET /v1.3/pixel/list/'),
    firstCreate = f.requests.indexOf('POST /v1.3/smart_plus/campaign/create/');
  assert.ok(pixelRead >= 0 && pixelRead < firstCreate, f.requests.join(' | '));
  assert.equal(String(f.groups.get('901').pixel_id), '8800');
  assert.equal(f.groups.get('901').optimization_event, 'SHOPPING');
  assert.equal(f.groups.get('901').billing_event, 'OCPM');
  assert.deepEqual(f.groups.get('901').search_keywords, records);
  // The go-live is one review: the campaign's status change. Without the spend acknowledgement it stops, and sends nothing.
  const activation = await f.call({action: 'activation_plan', id});
  assert.equal(activation.success, true, JSON.stringify(activation).slice(0, 1200));
  const before = f.writes.length;
  const preview = await f.call({action: 'approve', id: activation.data.id});
  assert.equal(preview.success, true, JSON.stringify(preview).slice(0, 1200));
  const approve = extra =>
    f.call({
      action: 'approve',
      id: activation.data.id,
      confirmed: true,
      plan_hash: preview.data.plan_hash,
      summary_hash: preview.data.summary_hash,
      ...extra,
    });
  assert.equal((await approve({})).success, true);
  const stopped = await f.call({action: 'run', id: activation.data.id});
  assert.equal(stopped.data?.run?.stopped, 'needs_spend_change_confirmed', JSON.stringify(stopped).slice(0, 1200));
  assert.equal(f.writes.length, before, 'the status change is not sent without spend_change_confirmed');
  assert.equal(f.campaigns.get('900').operation_status, 'DISABLE');
  assert.equal((await approve({spend_change_confirmed: true})).success, true);
  const live = await f.call({action: 'run', id: activation.data.id});
  assert.equal(live.success, true, JSON.stringify(live).slice(0, 1500));
  assert.equal(f.writes.length, before + 1, 'exactly one status change');
  assert.equal(f.writes.at(-1).path, '/v1.3/smart_plus/campaign/status/update/');
  assert.equal(f.campaigns.get('900').operation_status, 'ENABLE');
  assert.equal(f.groups.get('901').operation_status, 'ENABLE', 'the ad group was enabled all along');
  assert.equal(f.ads.get('902').operation_status, 'ENABLE', 'so was the ad: the launch is live after one review');
});

test('an advertiser without the Smart+ Search allowlist is refused at the campaign create: recorded rejected, nothing else is sent, and the step names the list', async t => {
  const f = setup({allowlisted: false});
  t.after(f.close);
  const {id} = await launch(f, search, clicksBrief);
  const plan = await planOf(f, id);
  const [campaign, ...rest] = plan.steps;
  assert.equal(campaign.status, 'failed', JSON.stringify(campaign).slice(0, 800));
  assert.equal(campaign.submission, 'rejected', 'TikTok declared that it applied nothing');
  assert.equal(campaign.error.details.provider_code, 40118);
  assert.equal(campaign.error.details.layer, 'app_eligibility');
  assert.equal(campaign.error.details.submission, 'rejected');
  assert.ok(
    rest.every(s => s.status === 'pending'),
    'no later step ran: ' + JSON.stringify(rest.map(s => s.status)),
  );
  assert.deepEqual(
    f.writes.map(w => w.path),
    ['/v1.3/smart_plus/campaign/create/'],
    'one request left AMCP, and it created nothing',
  );
  assert.equal(f.campaigns.size, 0);
  // The step names the allowlist, so that the person who reads the failure learns what to ask TikTok for.
  assert.match(campaign.description, /allowlist/);
  assert.match(campaign.description, /40118/);
  // The same advertiser can still launch a Smart+ pack that is not Search: the refusal is the allowlist's, not a blanket one.
  const {traffic} = smartPlusWebBriefs(CONNECTION);
  const plain = await launch(f, 'tiktok_smart_plus_website_traffic', traffic);
  assert.equal(plain.result.success, true, JSON.stringify(plain.result).slice(0, 500));
  assert.equal(f.campaigns.size, 1);
});

test('eligibility says that preflight cannot check the allowlist, and the ready dependencies are the identity, the post, the CTA portfolio and, for purchases, the pixel', async t => {
  const f = setup();
  t.after(f.close);
  const out = await f.call({action: 'recipe_eligibility', recipe: search, business: conversionsBrief, live: true});
  assert.equal(out.success, true, JSON.stringify(out).slice(0, 800));
  const row = id => out.data.dependencies.find(d => d.id === id);
  assert.equal(row('tiktok_spark_identity').status, 'ready');
  assert.equal(row('existing_tiktok_post').status, 'ready');
  assert.equal(row('dynamic_cta_portfolio').status, 'ready');
  assert.equal(row('account_owned_pixel').status, 'ready');
  assert.equal(row('smart_plus_search_allowlist').status, 'unknown');
  assert.match(row('smart_plus_search_allowlist').meaning, /no read/);
  assert.match(row('smart_plus_search_allowlist').meaning, /40118/);
  assert.equal(row('provider_objective_acceptance').status, 'unknown');
  assert.equal(out.data.status, 'unknown', JSON.stringify(out.data.blockers));
  assert.equal(f.writes.length, 0, 'eligibility never writes');
  // The plan made from this exact brief reuses the check.
  const created = await f.call({
    action: 'create_from_recipe',
    recipe: search,
    business: conversionsBrief,
    eligibility_ref: out.data.eligibility_ref,
  });
  assert.equal(created.success, true, JSON.stringify(created).slice(0, 800));
  assert.equal(created.data.eligibility_reuse?.applied, true, JSON.stringify(created.data.eligibility_reuse));
});

test('an unavailable identity, a post the identity does not own, a missing CTA portfolio and an unbound pixel each stop the Search plan before any create', async t => {
  const scenarios = [
    [
      'an unavailable identity',
      {identity: {available_status: 'NOT_AVAILABLE'}},
      'clicks',
      'smart_plus_ad',
      'identity_id',
    ],
    [
      'a post the identity does not own',
      {business: {tiktok_item_id: '7300000000000000999'}},
      'clicks',
      'smart_plus_ad',
      'tiktok_item_id',
    ],
    [
      'a CTA portfolio that does not exist',
      {business: {call_to_action_id: '799'}},
      'clicks',
      'smart_plus_ad',
      'call_to_action_id',
    ],
    [
      'an unbound pixel',
      {pixel: {asset_ownership: {ownership_status: false, asset_relation_status: 'UNBOUND'}}},
      'conversions',
      'smart_plus_adgroup',
      'pixel_id',
    ],
  ];
  for (const [name, options, kind, step, field] of scenarios) {
    const f = setup(options);
    t.after(f.close);
    const business = {...(kind === 'clicks' ? clicksBrief : conversionsBrief), ...(options.business ?? {})};
    const created = await f.call({action: 'create_from_recipe', recipe: search, business});
    assert.equal(created.success, true, name + ' ' + JSON.stringify(created).slice(0, 600));
    assert.equal((await f.call({action: 'preflight', id: created.data.id})).success, true, name);
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

test('the gates the Search pack passes through stay shut: an owner who forbids activation blocks the plan before any create, and a second identical plan creates nothing twice', async t => {
  const f = setup();
  t.after(f.close);
  saveSpendPolicy(f.store, admin, {scope: 'workspace', confirmed: true, policy: {allow_activation: false}});
  const created = await f.call({action: 'create_from_recipe', recipe: search, business: clicksBrief});
  assert.equal(created.success, true, JSON.stringify(created).slice(0, 800));
  assert.equal((await f.call({action: 'preflight', id: created.data.id})).success, true);
  const preflight = (await planOf(f, created.data.id)).preflight,
    blocked = preflight.checks.filter(c => c.status === 'blocked');
  assert.equal(preflight.status, 'blocked');
  assert.deepEqual(
    blocked.map(c => c.step),
    ['smart_plus_adgroup', 'smart_plus_ad'],
    'the campaign is created paused, so what is blocked is each child that starts ENABLE',
  );
  for (const c of blocked)
    assert.equal(c.error.code, 'POLICY_ACTIVATION_FORBIDDEN', JSON.stringify(c.error).slice(0, 300));
  assert.notEqual((await f.call({action: 'run', id: created.data.id})).data?.state, 'complete');
  assert.equal(f.writes.length, 0, 'nothing was created: no paused campaign is left behind');
  // The duplicate guard (M2): the same brief launched twice sends one set of creates.
  const g = setup();
  t.after(g.close);
  const first = await launch(g, search, clicksBrief);
  assert.equal(first.result.success, true, JSON.stringify(first.result).slice(0, 800));
  assert.equal(g.writes.length, 3);
  const second = await launch(g, search, clicksBrief);
  // S4-2 (the lead's review of 27528f0e): the second run is stopped by the guard itself, once, with its warning and before anything is sent: a
  // different failure of that run cannot pass this, as a count of writes alone let it.
  const stop = second.result.data?.run;
  assert.equal(stop?.stopped, 'needs_attention', JSON.stringify(second.result).slice(0, 600));
  assert.match(
    stop.reason,
    /an identical create completed in the last ten minutes, so executing it makes a second object\. Nothing was sent\./,
  );
  assert.equal(stop.executed.length, 0);
  assert.deepEqual(
    (await planOf(g, second.id)).steps.map(s => s.status),
    ['review_ready', 'pending', 'pending'],
    'the campaign review waits for a person who has seen the warning; nothing after it ran',
  );
  assert.equal(g.writes.length, 3, 'no second campaign: ' + g.writes.map(w => w.path).join(' | '));
});

test('a launch of 1,000 keywords verifies, written as lines or as records, in whatever order TikTok lists them back', async t => {
  for (const [form, make] of [
    ['lines', i => 'BROAD_WORD: term ' + i],
    ['records', i => ({keyword: 'term ' + i, match_type: 'BROAD_WORD'})],
  ]) {
    const f = setup({keywordOrder: 'reversed'});
    t.after(f.close);
    const {id, result} = await launch(f, search, {
      ...clicksBrief,
      keywords: Array.from({length: 1000}, (_, i) => make(i)),
    });
    assert.equal(result.success, true, form + ' ' + JSON.stringify(result).slice(0, 800));
    const plan = await planOf(f, id);
    assert.equal(plan.state, 'complete', form + ' ' + JSON.stringify(plan.steps.map(s => [s.id, s.status])));
    assert.equal(f.writes[1].body.search_keywords.length, 1000, form);
    assert.equal(f.groups.get('901').search_keywords.length, 1000, form);
    assert.deepEqual(
      plan.steps.map(s => s.status),
      ['verified', 'verified', 'verified'],
      form,
    );
  }
});

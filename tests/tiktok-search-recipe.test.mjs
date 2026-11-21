import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {campaignRecipe, campaignRecipes} from '../dist/src/campaign-recipes.js';
import {recipeDependencies} from '../dist/src/capability-eligibility.js';
import {recipeContext, recipeObjective} from '../dist/src/recipe-context.js';
import {stable} from '../dist/src/security.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {tiktokSearchAdvertiser, tiktokSearchBrief} from './fixtures/tiktok-search-build.mjs';

/**
 * R2.5 M4, package r25-m4-search, stage 1 (Q6, owner): a paused manual TikTok Search Ads campaign, ad group and Spark Ad,
 * on the standard path. A synthetic TikTok advertiser (tests/fixtures/tiktok-search-build.mjs) answers the reads and creates
 * the reviewed tiktok_entities family makes; nothing reaches TikTok. The pack compiles to the same reviewed creates a native
 * plan uses, the campaign starts DISABLE, preflight reads the Spark identity and post before anything is created, and the
 * Search shape follows "Create Manual Search Ads Campaigns" (read 2026-11-20): is_search_campaign on a Traffic campaign, a
 * CLICK/CPC ad group on the TikTok placement with its search_keywords, and none of the audience, interest or keyword-bid
 * fields the page says must not be passed.
 */
const gateway = 'tiktok_native_action',
  CONNECTION = '18181818-1818-4181-8181-181818181818',
  actor = {tenantId: 'tiktok-search', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'};
const brief = tiktokSearchBrief(CONNECTION);

function setup(options = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 73).toString('base64'));
  store.putConnection(
    admin,
    {
      id: CONNECTION,
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
  const advertiser = tiktokSearchAdvertiser(options);
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(advertiser.fetch, undefined, undefined, undefined, 10000),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const counter = {calls: 0};
  const call = (input, tool = 'amcp_campaign') => {
    counter.calls++;
    return service.call(tool, input, actor);
  };
  const prepare = (action, payload) =>
    call(
      {action: 'prepare', gateway, connection_id: CONNECTION, arguments: {action, account_id: '7001', payload}},
      'amcp_write',
    );
  const execute = review =>
    call(
      {
        action: 'execute',
        review_id: review.data.review_id,
        idempotency_key: review.data.idempotency_key,
        confirmed: true,
      },
      'amcp_write',
    );
  return {store, service, advertiser, call, prepare, execute, counter, close: () => store.close()};
}
/** The four calls of a launch: create_from_recipe, approve (preview), approve (confirmed) and run (tests/tiktok-launch-recipes.test.mjs). */
async function launch(f, recipe, business) {
  const created = await f.call({action: 'create_from_recipe', recipe, business});
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
  let result = await f.call({action: 'run', id});
  // The reviews of the pack ask for no spending acknowledgement; were one asked, run would stop for it once (r25-field-plan) and the
  // stop's next call approves the same plan again with the flag, which run then covers for every step.
  let passes = 0;
  for (let n = 0; n < 4 && result.success && result.data.run?.stopped === 'needs_spend_change_confirmed'; n++) {
    passes++;
    const executed = await f.call({...result.data.next_call.arguments, confirmed: true, spend_change_confirmed: true});
    if (!executed.success) {
      result = executed;
      break;
    }
    result = await f.call({action: 'run', id});
  }
  assert.ok(passes <= 1, 'one re-approval covers the plan: ' + passes + ' passes');
  return {id, result};
}
const full = async (f, id) => (await f.call({action: 'get', id, detail: 'full'})).data;

test('the pack is listed with its dependencies, its allowlist precondition and its keywords, and groups as search', () => {
  const definition = campaignRecipes.find(r => r.id === 'tiktok_search_traffic');
  assert.ok(definition, 'tiktok_search_traffic is a guided recipe');
  assert.equal(definition.platform, 'tiktok');
  for (const key of ['tiktok_item_id', 'identity_type', 'identity_id', 'location_ids', 'start_time', 'keywords'])
    assert.ok(definition.required.includes(key), 'requires ' + key);
  // A Search pack has no pixel and no optimization event: neither is an input.
  for (const key of ['pixel_id', 'optimization_event']) assert.equal(definition.required.includes(key), false, key);
  assert.deepEqual(definition.optional, ['end_time', 'identity_authorized_bc_id']);
  assert.match(definition.description, /allowlist/);
  const declared = recipeDependencies.tiktok_search_traffic;
  assert.deepEqual(declared.actions, ['tiktok_campaign_create', 'tiktok_adgroup_create', 'tiktok_ad_create']);
  for (const object of ['tiktok_spark_identity', 'existing_tiktok_post', 'search_keywords', 'search_ads_allowlist'])
    assert.ok(declared.objects.includes(object), 'depends on ' + object);
  assert.equal(declared.objects.includes('account_owned_pixel'), false);
  assert.equal(recipeObjective('tiktok_search_traffic'), 'search');
});

test('the objective of every recipe is as it was, and the Search pack, whose ID ends in _traffic, is the one new search', () => {
  const groups = Object.fromEntries(campaignRecipes.map(r => [r.id, recipeObjective(r.id)]));
  assert.deepEqual(groups, {
    meta_website_traffic: 'traffic',
    meta_website_sales: 'sales',
    meta_website_leads: 'leads',
    google_search: 'search',
    google_search_clicks: 'search',
    google_search_conversions: 'search',
    google_search_target_cpa: 'search',
    google_search_conversion_value: 'search',
    google_search_target_roas: 'search',
    google_performance_max: 'sales',
    microsoft_search: 'search',
    snapchat_website_traffic: 'traffic',
    snapchat_lead_generation: 'leads',
    tiktok_website_traffic: 'traffic',
    tiktok_website_conversions: 'sales',
    tiktok_search_traffic: 'search',
    linkedin_lead_generation: 'leads',
  });
});

test('a brief compiles to three reviewed creates: a DISABLE Search campaign, an ENABLE ad group with the keywords and a Spark Ad under it', () => {
  const before = JSON.stringify(brief),
    plan = campaignRecipe('tiktok_search_traffic', brief);
  assert.equal(JSON.stringify(brief), before, 'the brief is not mutated');
  assert.deepEqual(
    plan.steps.map(s => [s.id, s.arguments.action, s.depends_on]),
    [
      ['campaign', 'tiktok_campaign_create', []],
      ['adgroup', 'tiktok_adgroup_create', ['campaign']],
      ['ad', 'tiktok_ad_create', ['adgroup']],
    ],
  );
  assert.ok(plan.steps.every(s => s.gateway === gateway && s.expected_currency === 'USD' && s.account_id === '7001'));
  const [campaign, group, ad] = plan.steps.map(s => s.arguments.payload);
  // Exactly these fields: anything else the page does not name for a Search Ads campaign is a field the pack must not send.
  assert.deepEqual(campaign, {
    advertiser_id: '7001',
    campaign_name: 'Synthetic TikTok Search',
    objective_type: 'TRAFFIC',
    is_search_campaign: true,
    budget_mode: 'BUDGET_MODE_INFINITE',
    operation_status: 'DISABLE',
  });
  assert.deepEqual(group, {
    advertiser_id: '7001',
    campaign_id: {$ref: 'campaign#/data/data/campaign_id'},
    adgroup_name: 'Synthetic TikTok Search · Search',
    promotion_type: 'WEBSITE',
    placement_type: 'PLACEMENT_TYPE_NORMAL',
    placements: ['PLACEMENT_TIKTOK'],
    location_ids: ['6252001', '102358'],
    budget_mode: 'BUDGET_MODE_DAY',
    budget: 25.5,
    schedule_type: 'SCHEDULE_FROM_NOW',
    schedule_start_time: '2026-12-01 07:00:00',
    optimization_goal: 'CLICK',
    billing_event: 'CPC',
    bid_type: 'BID_TYPE_NO_BID',
    pacing: 'PACING_MODE_SMOOTH',
    search_keywords: [
      {keyword: 'running shoes', match_type: 'PHRASE_WORD'},
      {keyword: 'trail running shoes', match_type: 'PRECISE_WORD'},
      {keyword: 'shoes', match_type: 'BROAD_WORD'},
    ],
    operation_status: 'ENABLE',
  });
  assert.deepEqual(ad, {
    advertiser_id: '7001',
    adgroup_id: {$ref: 'adgroup#/data/data/adgroup_id'},
    creatives: [
      {
        ad_name: 'Synthetic TikTok Search · ad',
        ad_format: 'SINGLE_VIDEO',
        tiktok_item_id: '7300000000000000001',
        identity_type: 'TT_USER',
        identity_id: 'tt-identity-1',
        landing_page_url: 'https://example.com/tiktok-landing',
        call_to_action: 'LEARN_MORE',
        operation_status: 'ENABLE',
      },
    ],
  });
  assert.deepEqual(plan.steps[2].prerequisites, ['tiktok_spark_post']);
  assert.equal(plan.steps[1].prerequisites, undefined, 'a Search ad group reads no pixel');
  assert.equal(plan.recipe.id, 'tiktok_search_traffic');
  assert.equal(plan.recipe.daily_budget, '25.5');
  assert.equal(plan.recipe.optimization_goal, 'CLICK');
  assert.match(plan.recipe.allowlist_acceptance, /allowlist/);
  assert.match(plan.recipe.creative_acceptance, /unverified/);
});

test('the compiled ad group carries none of the fields the page says a Search Ads ad group must not be given, and no request_id anywhere', () => {
  const plan = campaignRecipe('tiktok_search_traffic', brief),
    [campaign, group] = plan.steps.map(s => s.arguments.payload);
  // "Create Manual Search Ads Campaigns" (read 2026-11-20): not passed, and what is allowlisted or ignored besides.
  const forbidden = [
    'saved_audience_id',
    'auto_targeting_enabled',
    'audience_ids',
    'excluded_audience_ids',
    'smart_audience_enabled',
    'interest_category_ids',
    'interest_keyword_ids',
    'purchase_intention_keyword_ids',
    'actions',
    'smart_interest_behavior_enabled',
    'targeting_expansion',
    'contextual_tag_ids',
    'blocked_pangle_app_ids',
    'brand_safety_partner',
    'vertical_sensitivity_id',
    'brand_safety_type',
    'category_exclusion_ids',
    'search_result_enabled',
    'automated_keywords_enabled',
    'creative_material_mode',
    'keyword_bid_type',
    'keyword_bid',
    'bid_price',
    'pixel_id',
    'optimization_event',
  ];
  for (const field of forbidden) assert.equal(Object.hasOwn(group, field), false, 'the ad group names ' + field);
  assert.equal(
    Object.hasOwn(campaign, 'budget_optimize_on'),
    false,
    'campaign budget optimization stays off, as the page says',
  );
  for (const item of group.search_keywords)
    assert.deepEqual(Object.keys(item).sort(), ['keyword', 'match_type'], 'a keyword names no bid');
  assert.equal(
    JSON.stringify(plan).includes('request_id'),
    false,
    'AMCP adds no request_id of its own (Q16, owner 2026-11-15)',
  );
});

test('keywords are sent trimmed and in the order given, up to the 1,000 the page allows', () => {
  const plan = campaignRecipe('tiktok_search_traffic', {
    ...brief,
    keywords: [
      {keyword: '  padded phrase  ', match_type: 'BROAD_WORD'},
      {keyword: 'padded phrase', match_type: 'PRECISE_WORD'},
      {keyword: 'ملابس رياضية', match_type: 'PHRASE_WORD'},
    ],
  });
  assert.deepEqual(plan.steps[1].arguments.payload.search_keywords, [
    {keyword: 'padded phrase', match_type: 'BROAD_WORD'},
    {keyword: 'padded phrase', match_type: 'PRECISE_WORD'},
    {keyword: 'ملابس رياضية', match_type: 'PHRASE_WORD'},
  ]);
  const many = Array.from({length: 1000}, (_, i) => ({keyword: 'keyword ' + i, match_type: 'BROAD_WORD'}));
  assert.equal(
    campaignRecipe('tiktok_search_traffic', {...brief, keywords: many}).steps[1].arguments.payload.search_keywords
      .length,
    1000,
  );
});

test('keywords written as lines, as the website form and a playbook write them, compile to the same records', () => {
  const plan = campaignRecipe('tiktok_search_traffic', {
    ...brief,
    keywords: [
      'PHRASE_WORD: running shoes',
      '  PRECISE_WORD :  trail running shoes  ',
      'BROAD_WORD: shoes: size 10',
      {keyword: 'sandals', match_type: 'BROAD_WORD'},
    ],
  });
  assert.deepEqual(plan.steps[1].arguments.payload.search_keywords, [
    {keyword: 'running shoes', match_type: 'PHRASE_WORD'},
    {keyword: 'trail running shoes', match_type: 'PRECISE_WORD'},
    {keyword: 'shoes: size 10', match_type: 'BROAD_WORD'},
    {keyword: 'sandals', match_type: 'BROAD_WORD'},
  ]);
  assert.deepEqual(plan.recipe.keywords, {count: 4, by_match_type: {PRECISE_WORD: 1, PHRASE_WORD: 1, BROAD_WORD: 2}});
});
test('a brief TikTok would refuse, or that AMCP cannot express exactly, is refused before anything is saved, naming its field', () => {
  const word = (keyword, match_type = 'BROAD_WORD') => ({keyword, match_type});
  for (const [what, patch, code, field] of [
    ['no keyword', {keywords: []}, 'RECIPE_INPUT_INVALID', 'keywords'],
    ['keywords that are no list', {keywords: 'running shoes'}, 'RECIPE_INPUT_INVALID', 'keywords'],
    [
      '1,001 keywords',
      {keywords: Array.from({length: 1001}, (_, i) => word('keyword ' + i))},
      'RECIPE_INPUT_INVALID',
      'keywords',
    ],
    ['the same pair twice', {keywords: [word('shoes'), word('shoes')]}, 'RECIPE_INPUT_INVALID', 'keywords[1]'],
    [
      'the same pair twice, padded',
      {keywords: [word('shoes'), word(' shoes ')]},
      'RECIPE_INPUT_INVALID',
      'keywords[1]',
    ],
    ['an empty keyword', {keywords: [word('shoes'), word('')]}, 'RECIPE_INPUT_INVALID', 'keywords[1].keyword'],
    ['a blank keyword', {keywords: [word('   ')]}, 'RECIPE_INPUT_INVALID', 'keywords[0].keyword'],
    ['a keyword that is no text', {keywords: [word(42)]}, 'RECIPE_INPUT_INVALID', 'keywords[0].keyword'],
    [
      'a match type outside the three',
      {keywords: [word('shoes', 'EXACT')]},
      'RECIPE_INPUT_INVALID',
      'keywords[0].match_type',
    ],
    ['no match type', {keywords: [{keyword: 'shoes'}]}, 'RECIPE_INPUT_INVALID', 'keywords[0].match_type'],
    ['a keyword bid', {keywords: [{...word('shoes'), keyword_bid: 1}]}, 'RECIPE_INPUT_INVALID', 'keywords[0]'],
    ['an item that is no record', {keywords: ['shoes']}, 'RECIPE_INPUT_INVALID', 'keywords[0]'],
    ['a line without a match type', {keywords: ['running shoes: size 10']}, 'RECIPE_INPUT_INVALID', 'keywords[0]'],
    ['a line with a lower case match type', {keywords: ['phrase_word: shoes']}, 'RECIPE_INPUT_INVALID', 'keywords[0]'],
    [
      'a line with a match type outside the three',
      {keywords: ['EXACT: shoes']},
      'RECIPE_INPUT_INVALID',
      'keywords[0].match_type',
    ],
    ['a line without text', {keywords: ['PHRASE_WORD:   ']}, 'RECIPE_INPUT_INVALID', 'keywords[0].keyword'],
    [
      'a line and a record of the same pair',
      {keywords: ['BROAD_WORD: shoes', {keyword: 'shoes', match_type: 'BROAD_WORD'}]},
      'RECIPE_INPUT_INVALID',
      'keywords[1]',
    ],
    ['a pixel', {pixel_id: '8800'}, 'RECIPE_INPUT_INVALID', 'pixel_id'],
    ['an optimization event', {optimization_event: 'SHOPPING'}, 'RECIPE_INPUT_INVALID', 'optimization_event'],
    ['a budget with three decimals', {daily_budget: '20.125'}, 'INVALID_RECIPE_MONEY', 'daily_budget'],
    ['a landing page that is not HTTPS', {destination_url: 'http://example.com/'}, 'DESTINATION_REQUIRED', undefined],
    ['a custom identity', {identity_type: 'CUSTOMIZED_USER'}, 'RECIPE_INPUT_INVALID', 'identity_type'],
    [
      'an identity of a Business Center without its ID',
      {identity_type: 'BC_AUTH_TT'},
      'RECIPE_INPUT_INVALID',
      'identity_authorized_bc_id',
    ],
    ['a call to action outside the list', {call_to_action: 'CLICK_HERE'}, 'RECIPE_INPUT_INVALID', 'call_to_action'],
    [
      '21 locations',
      {location_ids: Array.from({length: 21}, (_, i) => String(1000 + i))},
      'RECIPE_INPUT_INVALID',
      'location_ids',
    ],
    ['an end before the start', {end_time: '2026-11-01T06:00:00Z'}, 'RECIPE_DATE_INVALID', 'end_time'],
    ['an emoji in the name', {name: 'Launch 🚀'}, 'RECIPE_INPUT_INVALID', 'name'],
  ])
    assert.throws(
      () => campaignRecipe('tiktok_search_traffic', {...brief, ...patch}),
      e => assertRefused(e, code) && (field === undefined || e.details.field === field),
      what,
    );
  const missing = {...brief};
  delete missing.keywords;
  assert.throws(
    () => campaignRecipe('tiktok_search_traffic', missing),
    e => assertRefused(e, 'RECIPE_INPUT_REQUIRED') && e.details.missing_fields.includes('keywords'),
  );
});

test('the traffic and purchases packs compile byte for byte as before the Search pack', () => {
  const traffic = {
      name: 'Synthetic TikTok traffic',
      account_id: '7001',
      connection_id: CONNECTION,
      currency: 'USD',
      daily_budget: '25.50',
      location_ids: ['6252001', '102358'],
      tiktok_item_id: '7300000000000000001',
      identity_type: 'TT_USER',
      identity_id: 'tt-identity-1',
      destination_url: 'https://example.com/tiktok-landing',
      call_to_action: 'LEARN_MORE',
      start_time: '2026-11-01T10:00:00+03:00',
    },
    hash = v => createHash('sha256').update(stable(v)).digest('hex');
  // Measured on the code before this package changed anything (37ec65ba, the head M3 was pushed from).
  assert.equal(
    hash(campaignRecipe('tiktok_website_traffic', {...traffic, connection_id: '17171717-1717-4171-8171-171717171717'})),
    '4151e73759b43495502968bd6fadf1330739975611f957c4debeec176cd19e03',
  );
  assert.equal(
    hash(
      campaignRecipe('tiktok_website_conversions', {
        ...traffic,
        connection_id: '17171717-1717-4171-8171-171717171717',
        pixel_id: '8800',
        optimization_event: 'SHOPPING',
      }),
    ),
    'edaba2c36b1010c50d5501d0a5f70a8d34e5ca321d2dbadf584450c5de2eb3b4',
  );
});

test('recipe context names the allowlist precondition, the login and the pack’s limitations without a provider request', t => {
  const f = setup();
  t.after(f.close);
  const context = recipeContext(f.store, actor, 'tiktok_search_traffic');
  assert.deepEqual(
    context.targets.map(x => [x.connection_id, x.account_id, x.write_granted]),
    [[CONNECTION, '7001', true]],
  );
  assert.match(context.limitations[0], /allowlist-only for each objective/);
  assert.match(context.limitations[0], /40118/);
  assert.match(context.prerequisites[2], /Search Ads allowlist/);
  assert.equal(f.advertiser.requests.length, 0);
});

test('the context carries the static notice of TikTok’s migration guide, with its Arabic, and the pack refuses nothing on the date it names', async t => {
  const f = setup();
  t.after(f.close);
  const notice = recipeContext(f.store, actor, 'tiktok_search_traffic').limitations[1];
  // The lead's decision (2026-11-21): the guide's statement and its date, that it is not confirmed for Search, that nothing is refused on
  // the date and that a Smart+ Search route is planned. Pinned whole, so that a change of its words is deliberate.
  assert.equal(
    notice,
    'TikTok’s migration guide to Upgraded Smart+ (read 2026-11-21) says that after December 31, 2026 Manual Campaigns can no longer be created with /campaign/create/, the endpoint this pack uses, while the notice on TikTok’s create pages (read 2026-11-20) names only Sales, App Promotion and Lead Generation campaigns that are not Search campaigns. Which reading holds for a Search campaign is not confirmed, so this pack may stop working after 2026-12-31. AMCP refuses nothing on that date; a Smart+ Search route is planned.',
  );
  const arabic = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'))[notice];
  assert.match(arabic, /[\u0600-\u06ff]/u, 'the notice has Arabic');
  assert.ok(
    arabic.includes('2026-12-31') && arabic.includes('/campaign/create/') && arabic.includes('Smart+ Search'),
    arabic,
  );
  // Nothing is refused on that date: with the clock after December 31, 2026 the same brief compiles to the same plan.
  const before = JSON.stringify(campaignRecipe('tiktok_search_traffic', brief));
  t.mock.timers.enable({apis: ['Date'], now: Date.parse('2027-01-02T00:00:00Z')});
  assert.equal(new Date().getUTCFullYear(), 2027, 'the clock is after the date');
  assert.equal(JSON.stringify(campaignRecipe('tiktok_search_traffic', brief)), before);
});
test('a Search plan runs every reviewed create to a verified paused launch in four calls, then drafts its one activation', async t => {
  const f = setup();
  t.after(f.close);
  const preview = await f.call({action: 'preview_recipe', recipe: 'tiktok_search_traffic', business: brief});
  assert.equal(preview.success, true, JSON.stringify(preview).slice(0, 800));
  assert.equal(f.advertiser.writes.length, 0, 'a preview sends nothing');
  const calls = f.counter.calls,
    {id, result} = await launch(f, 'tiktok_search_traffic', brief);
  assert.equal(result.success, true, JSON.stringify(result).slice(0, 1500));
  assert.equal(
    f.counter.calls - calls,
    4,
    'create_from_recipe, two approvals and run: no stop for a spending acknowledgement',
  );
  const plan = await full(f, id);
  assert.equal(
    plan.state,
    'complete',
    JSON.stringify(plan.steps.map(s => ({id: s.id, status: s.status, error: s.error}))).slice(0, 1500),
  );
  assert.deepEqual(
    plan.steps.map(s => s.status),
    ['verified', 'verified', 'verified'],
  );
  assert.deepEqual(
    f.advertiser.writes.map(w => w.path),
    ['/v1.3/campaign/create/', '/v1.3/adgroup/create/', '/v1.3/ad/create/'],
  );
  assert.ok(
    f.advertiser.requests.includes('GET /v1.3/identity/info/') &&
      f.advertiser.requests.includes('GET /v1.3/identity/video/info/'),
    'preflight read the Spark identity and post',
  );
  assert.equal(f.advertiser.requests.includes('GET /v1.3/pixel/list/'), false, 'a Search pack reads no pixel');
  const firstCreate = f.advertiser.requests.indexOf('POST /v1.3/campaign/create/');
  assert.ok(f.advertiser.requests.indexOf('GET /v1.3/identity/video/info/') < firstCreate, 'the post was read first');
  const campaign = f.advertiser.campaigns.get('900'),
    group = f.advertiser.groups.get('901');
  assert.equal(campaign.operation_status, 'DISABLE');
  assert.equal(campaign.is_search_campaign, true);
  assert.equal(group.campaign_id, '900', 'the ad group joined the verified campaign');
  assert.equal(group.operation_status, 'ENABLE');
  assert.deepEqual(
    group.search_keywords.map(k => [k.keyword, k.match_type]),
    brief.keywords.map(k => [k.keyword, k.match_type]),
  );
  assert.equal(f.advertiser.ads.get('902').adgroup_id, '901');
  const repeated = await f.call({action: 'run', id, confirmed: true, spend_change_confirmed: true});
  assert.equal(repeated.success, true);
  assert.equal(f.advertiser.writes.length, 3, 'a completed plan never submits duplicate entities');
  const activation = await f.call({action: 'activation_plan', id});
  assert.equal(activation.success, true, JSON.stringify(activation).slice(0, 1200));
  const draft = await full(f, activation.data.id);
  assert.deepEqual(
    draft.steps.map(s => [s.id, s.arguments.action, s.arguments.payload]),
    [
      [
        'activate_campaign',
        'tiktok_campaign_status_update',
        {advertiser_id: '7001', campaign_ids: ['900'], operation_status: 'ENABLE'},
      ],
    ],
  );
  assert.equal(f.advertiser.writes.length, 3, 'drafting the activation sends nothing');
  // The go-live is one reviewed change of the campaign, and it needs the spending acknowledgement: without it nothing is sent.
  const aid = activation.data.id,
    shown = await f.call({action: 'approve', id: aid});
  assert.equal(shown.success, true, JSON.stringify(shown).slice(0, 500));
  const accepted = await f.call({
    action: 'approve',
    id: aid,
    confirmed: true,
    plan_hash: shown.data.plan_hash,
    summary_hash: shown.data.summary_hash,
  });
  assert.equal(accepted.success, true, JSON.stringify(accepted).slice(0, 500));
  const stopped = await f.call({action: 'run', id: aid});
  assert.equal(stopped.data.run.stopped, 'needs_spend_change_confirmed', JSON.stringify(stopped).slice(0, 600));
  assert.deepEqual(stopped.data.run.spend_steps, ['activate_campaign']);
  assert.equal(f.advertiser.writes.length, 3, 'nothing was sent without the acknowledgement');
  assert.equal(f.advertiser.campaigns.get('900').operation_status, 'DISABLE');
  // With it, the one status change goes out and reads back ENABLE (the synthetic campaign; no live campaign is ever enabled by a check).
  assert.equal(
    (await f.call({...stopped.data.next_call.arguments, confirmed: true, spend_change_confirmed: true})).success,
    true,
  );
  const live = await f.call({action: 'run', id: aid});
  assert.deepEqual(live.data.run.executed, ['activate_campaign'], JSON.stringify(live).slice(0, 600));
  assert.deepEqual(f.advertiser.writes.at(-1), {
    path: '/v1.3/campaign/status/update/',
    body: {advertiser_id: '7001', campaign_ids: ['900'], operation_status: 'ENABLE'},
  });
  assert.equal(f.advertiser.campaigns.get('900').operation_status, 'ENABLE');
});

test('the read-back of the ad group verifies whatever review status and order TikTok gives the keywords, and still sees a keyword that differs', async t => {
  for (const options of [{audit: false}, {audit: true, keywordOrder: 'reversed'}]) {
    const f = setup(options);
    t.after(f.close);
    const {id, result} = await launch(f, 'tiktok_search_traffic', brief);
    assert.equal(result.success, true, JSON.stringify(result).slice(0, 800));
    const plan = await full(f, id);
    assert.deepEqual(
      plan.steps.map(s => s.status),
      ['verified', 'verified', 'verified'],
      JSON.stringify(options) + JSON.stringify(plan.steps.map(s => s.verification?.checks)).slice(0, 800),
    );
  }
  // A keyword TikTok stores differently (another match type) is not verified: the comparison ignores the status and the order, nothing else.
  const f = setup({stores: words => words.map((w, i) => (i === 0 ? {...w, match_type: 'PRECISE_WORD'} : w))});
  t.after(f.close);
  const {id} = await launch(f, 'tiktok_search_traffic', brief),
    plan = await full(f, id),
    group = plan.steps.find(s => s.id === 'adgroup');
  assert.notEqual(group.status, 'verified', JSON.stringify(group.verification).slice(0, 600));
  assert.deepEqual(group.verification.checks[0].changed_fields, ['/search_keywords']);
  assert.equal(
    f.advertiser.writes.some(w => w.path === '/v1.3/ad/create/'),
    false,
    'the ad waits for a verified ad group',
  );
});

test('a launch with the 1,000 keywords the page allows verifies end to end, whatever order TikTok reads them back in', async t => {
  const f = setup({keywordOrder: 'reversed'});
  t.after(f.close);
  const keywords = Array.from({length: 1000}, (_, i) => ({
    keyword: 'keyword number ' + i,
    match_type: ['PRECISE_WORD', 'PHRASE_WORD', 'BROAD_WORD'][i % 3],
  }));
  const {id, result} = await launch(f, 'tiktok_search_traffic', {...brief, keywords});
  assert.equal(result.success, true, JSON.stringify(result).slice(0, 800));
  assert.deepEqual(
    (await full(f, id)).steps.map(s => s.status),
    ['verified', 'verified', 'verified'],
  );
  assert.equal(f.advertiser.writes.find(w => w.path === '/v1.3/adgroup/create/').body.search_keywords.length, 1000);
});

test('a negative keyword added to the ad group the pack built passes the widened gate and verifies, while TikTok reviews the keywords', async t => {
  const f = setup();
  t.after(f.close);
  const {result} = await launch(f, 'tiktok_search_traffic', brief);
  assert.equal(result.success, true, JSON.stringify(result).slice(0, 500));
  const campaignReads = () => f.advertiser.requests.filter(r => r === 'GET /v1.3/campaign/get/').length,
    add = object =>
      f.prepare('tiktok_search_ad_negative_keyword_add', {
        advertiser_id: '7001',
        object_type: 'ADGROUP',
        object_ids: ['901'],
        keywords: [{name: 'free', match_type: 'BROAD_WORD'}],
        ...object,
      });
  // The built ad group holds search_result_enabled false, so its campaign (is_search_campaign true, MANUAL) is read, once.
  const before = campaignReads(),
    prepared = await add();
  assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 700));
  assert.equal(campaignReads() - before, 1, 'one read of the campaign');
  // TikTok reviews the keywords between this prepare and its execute: no change of the ad group.
  f.advertiser.review.status = 'SYNTHETIC_OTHER_STATE';
  const executed = await f.execute(prepared);
  assert.equal(executed.success, true, JSON.stringify(executed).slice(0, 700));
  assert.deepEqual(f.advertiser.writes.at(-1), {
    path: '/v1.3/search_ad/negative_keyword/add/',
    body: {
      advertiser_id: '7001',
      object_type: 'ADGROUP',
      object_ids: ['901'],
      keywords: [{name: 'free', match_type: 'BROAD_WORD'}],
    },
  });
  assert.deepEqual(
    f.advertiser.negatives.get('ADGROUP:901').map(k => k.name),
    ['free'],
  );
  assert.equal((await f.call({action: 'verify', review_id: prepared.data.review_id})).data.status, 'verified');
  // The campaign takes them too: it reads is_search_campaign.
  const campaign = await add({object_type: 'CAMPAIGN', object_ids: ['900']});
  assert.equal(campaign.success, true, JSON.stringify(campaign).slice(0, 700));
  assert.equal((await f.execute(campaign)).success, true);
  assert.equal((await f.call({action: 'verify', review_id: campaign.data.review_id})).data.status, 'verified');
});
test('an advertiser without the Search Ads allowlist is refused at the campaign create: recorded rejected, nothing else is sent', async t => {
  const f = setup({allowlisted: false});
  t.after(f.close);
  const {id} = await launch(f, 'tiktok_search_traffic', brief);
  const plan = await full(f, id);
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
    f.advertiser.writes.map(w => w.path),
    ['/v1.3/campaign/create/'],
    'one request left AMCP, and it created nothing',
  );
  assert.equal(f.advertiser.campaigns.size, 0);
  // The step names the allowlist, before it is run and after TikTok refused it, so that the person who reads the failure learns what to ask for.
  assert.match(campaign.description, /allowlist for this objective/);
  assert.match(campaign.description, /40118/);
  // The same advertiser can still create a campaign that is not a Search campaign: the refusal is the allowlist's, not a blanket one.
  const traffic = await launch(f, 'tiktok_website_traffic', {...brief, keywords: undefined});
  assert.equal(traffic.result.success, true, JSON.stringify(traffic.result).slice(0, 500));
});

test('eligibility says that preflight cannot check the allowlist, and ready dependencies are only the identity and the post', async t => {
  const f = setup();
  t.after(f.close);
  const out = await f.call({
    action: 'recipe_eligibility',
    recipe: 'tiktok_search_traffic',
    business: brief,
    live: true,
  });
  assert.equal(out.success, true, JSON.stringify(out).slice(0, 800));
  const row = id => out.data.dependencies.find(d => d.id === id);
  assert.equal(row('tiktok_spark_identity').status, 'ready');
  assert.equal(row('existing_tiktok_post').status, 'ready');
  assert.equal(row('search_ads_allowlist').status, 'unknown');
  assert.match(row('search_ads_allowlist').meaning, /no read/);
  assert.match(row('search_ads_allowlist').meaning, /40118/);
  assert.equal(row('provider_objective_acceptance').status, 'unknown');
  assert.equal(out.data.status, 'unknown', JSON.stringify(out.data.blockers));
  assert.equal(f.advertiser.writes.length, 0, 'eligibility never writes');
});

test('an unavailable identity, a political account or a post the identity does not own stop the plan before any create', async t => {
  for (const options of [
    {identity: {available_status: 'NOT_AVAILABLE'}},
    {identity: {can_pull_video: false}},
    {identity: {is_gpppa: true}},
    {post: {item_type: 'CAROUSEL'}},
    {business: {tiktok_item_id: '7300000000000000999'}},
  ]) {
    const f = setup(options);
    t.after(f.close);
    const created = await f.call({
      action: 'create_from_recipe',
      recipe: 'tiktok_search_traffic',
      business: {...brief, ...(options.business ?? {})},
    });
    assert.equal(created.success, true, JSON.stringify(created).slice(0, 800));
    const checked = await f.call({action: 'preflight', id: created.data.id});
    assert.equal(checked.success, true, JSON.stringify(checked).slice(0, 800));
    const preflight = (await full(f, created.data.id)).preflight,
      blocked = preflight.checks.find(c => c.status === 'blocked');
    assert.equal(preflight.status, 'blocked', JSON.stringify(options));
    assert.equal(blocked.step, 'ad', JSON.stringify(blocked));
    assert.equal(blocked.error.code, 'CAMPAIGN_PREREQUISITE_REQUIRED', JSON.stringify(blocked));
    const run = await f.call({action: 'run', id: created.data.id});
    assert.notEqual(run.data?.state, 'complete');
    assert.equal(f.advertiser.writes.length, 0, 'nothing was created: ' + JSON.stringify(options));
  }
});

test('the gates the pack passes through stay shut: a serving parent, a custom identity on the TikTok placement, two creatives, an enabled campaign and a second identical create', async t => {
  const f = setup();
  t.after(f.close);
  // An identical campaign create prepared before the plan sends its own (R2.5 M2: the guard against creating twice runs at execute).
  const early = await f.prepare(
    'tiktok_campaign_create',
    campaignRecipe('tiktok_search_traffic', brief).steps[0].arguments.payload,
  );
  assert.equal(early.success, true, JSON.stringify(early).slice(0, 500));
  const {id, result} = await launch(f, 'tiktok_search_traffic', brief);
  assert.equal(result.success, true, JSON.stringify(result).slice(0, 500));
  const [campaignStep, groupStep, adStep] = (await full(f, id)).steps.map(s => s.arguments.payload);
  const before = f.advertiser.writes.length,
    sent = () => f.advertiser.writes.length - before;
  // The ad group goes ENABLE only under a campaign the review reads DISABLE; a serving campaign is PARENT_SERVING, flag or no flag.
  f.advertiser.campaigns.get('900').operation_status = 'ENABLE';
  assertRefused(
    await f.prepare('tiktok_adgroup_create', {
      ...groupStep,
      campaign_id: '900',
      search_keywords: [{keyword: 'other', match_type: 'BROAD_WORD'}],
    }),
    'PARENT_SERVING',
    {writes: sent},
  );
  f.advertiser.campaigns.get('900').operation_status = 'DISABLE';
  // A custom identity cannot run a new non-Spark ad in an ad group that delivers on TikTok; one creative per ad create.
  const creative = adStep.creatives[0];
  assertRefused(
    await f.prepare('tiktok_ad_create', {
      ...adStep,
      adgroup_id: '901',
      creatives: [
        {
          ...creative,
          identity_type: 'CUSTOMIZED_USER',
          tiktok_item_id: undefined,
          video_id: 'v1',
          image_ids: undefined,
        },
      ],
    }),
    'TIKTOK_CUSTOM_IDENTITY_PLACEMENT',
    {writes: sent},
  );
  assertRefused(
    await f.prepare('tiktok_ad_create', {
      ...adStep,
      adgroup_id: '901',
      creatives: [creative, {...creative, ad_name: 'second'}],
    }),
    'WRITE_CONTRACT_UNAVAILABLE',
    {writes: sent},
  );
  // The Search campaign is created DISABLE, as every TikTok campaign is.
  assertRefused(
    await f.prepare('tiktok_campaign_create', {
      ...campaignStep,
      campaign_name: 'Another Search',
      operation_status: 'ENABLE',
    }),
    'PAUSED_CREATION_REQUIRED',
    {writes: sent},
  );
  // The create that was made is not made twice (R2.5 M2): the identical review prepared before it is refused at execute, nothing sent.
  const refused = await f.execute(early);
  assertRefused(refused, 'DUPLICATE_OF_COMPLETED_WRITE', {writes: sent});
  assert.equal(refused.error.details.submission, 'not_sent');
  assert.equal(sent(), 0, 'no gate let a request through');
});

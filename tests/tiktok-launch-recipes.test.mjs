import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {campaignRecipe, campaignRecipes} from '../dist/src/campaign-recipes.js';
import {recipeDependencies} from '../dist/src/capability-eligibility.js';
import {recipeContext, recipeObjective} from '../dist/src/recipe-context.js';
import {activationSteps} from '../dist/src/campaign-activation.js';
import {tiktokBudget} from '../dist/src/tiktok-launch-recipes.js';
import {pinBeforeTiktokCutoff} from './helpers/tiktok-cutoff-clock.mjs';
import {setPlanReadLagWaits} from '../dist/src/campaign-runner.js';

// Package r25-m4-classic: TikTok stops classic Sales, App Promotion and Lead Generation creates on 2027-01-01 and AMCP refuses them from
// that day (src/tiktok-manual-cutoff.ts); it tests the website purchases pack (a classic Sales campaign) from its brief to its verified launch, so the clock is pinned before it.
pinBeforeTiktokCutoff();

/**
 * CMP-07 (implementer default pending P7): guided paused TikTok launch packs. A synthetic TikTok advertiser answers the
 * reads and creates the reviewed tiktok_entities family makes; nothing reaches TikTok. The packs compile to the same
 * reviewed creates a native plan uses, the campaign starts DISABLE, and preflight reads the Spark identity, post and
 * pixel before any predecessor is created.
 */
const gateway = 'tiktok_native_action',
  CONNECTION = '17171717-1717-4171-8171-171717171717',
  actor = {tenantId: 'tiktok-launch', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'};
export const trafficBusiness = {
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
};
const conversionBusiness = {...trafficBusiness, pixel_id: '8800', optimization_event: 'SHOPPING'};

function setup({identity = {}, post = {}, pixel = {}, routes} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 71).toString('base64'));
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
  const campaigns = new Map(),
    adgroups = new Map(),
    ads = new Map(),
    writes = [],
    requests = [];
  let next = 900;
  const ok = data => Response.json({code: 0, message: 'OK', request_id: 'r', data});
  const page = list => ok({list, page_info: {page: 1, page_size: 100, total_number: list.length, total_page: 1}});
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (raw, init = {}) => {
        const url = new URL(String(raw)),
          path = url.pathname.replace('/open_api', ''),
          method = init.method ?? 'GET',
          json = name => {
            const v = url.searchParams.get(name);
            try {
              return v === null ? undefined : JSON.parse(v);
            } catch {
              return v;
            }
          },
          filtering = json('filtering') ?? {};
        requests.push(method + ' ' + path);
        const extra = routes?.(method, path, url, init.body);
        if (extra) return extra;
        const match = row =>
          Object.entries(filtering).every(([k, v]) =>
            (Array.isArray(v) ? v : [v]).map(String).includes(String(row[k.replace(/s$/, '')])),
          );
        if (method === 'GET' && path === '/v1.3/advertiser/info/')
          return page([{advertiser_id: '7001', currency: 'USD', timezone: 'Etc/GMT', status: 'STATUS_ENABLE'}]);
        if (method === 'GET' && path === '/v1.3/campaign/get/') return page([...campaigns.values()].filter(match));
        if (method === 'GET' && path === '/v1.3/adgroup/get/') return page([...adgroups.values()].filter(match));
        if (method === 'GET' && path === '/v1.3/ad/get/') return page([...ads.values()].filter(match));
        if (method === 'GET' && path === '/v1.3/identity/info/')
          return ok({
            identity_info: {
              identity_id: json('identity_id'),
              identity_type: json('identity_type'),
              display_name: 'Synthetic creator',
              available_status: 'AVAILABLE',
              can_pull_video: true,
              is_gpppa: false,
              ...identity,
            },
          });
        if (method === 'GET' && path === '/v1.3/identity/video/info/') {
          const wanted = [].concat(json('item_ids') ?? []).map(String);
          return ok({
            video_details: wanted
              .filter(id => id === trafficBusiness.tiktok_item_id)
              .map(item_id => ({item_id, item_type: 'VIDEO', status: 'PUBLIC', ...post})),
          });
        }
        if (method === 'GET' && path === '/v1.3/pixel/list/')
          return ok({
            pixels: [
              {
                pixel_id: '8800',
                pixel_name: 'Synthetic pixel',
                asset_ownership: {ownership_status: true, asset_relation_status: 'OWNER'},
                ...pixel,
              },
            ].filter(p => !json('pixel_id') || String(p.pixel_id) === String(json('pixel_id'))),
            page_info: {page: 1, page_size: 20, total_number: 1, total_page: 1},
          });
        if (method === 'POST') {
          const body = JSON.parse(String(init.body)),
            id = String(next++);
          writes.push({path, body});
          if (path === '/v1.3/campaign/create/') {
            campaigns.set(id, {...body, campaign_id: id});
            return ok({campaign_id: id});
          }
          if (path === '/v1.3/adgroup/create/') {
            adgroups.set(id, {...body, adgroup_id: id});
            return ok({adgroup_id: id});
          }
          if (path === '/v1.3/ad/create/') {
            const group = adgroups.get(String(body.adgroup_id));
            ads.set(id, {
              ...body.creatives[0],
              ad_id: id,
              adgroup_id: body.adgroup_id,
              campaign_id: group.campaign_id,
              advertiser_id: '7001',
            });
            return ok({ad_ids: [id]});
          }
        }
        throw new Error('Unexpected TikTok request ' + method + ' ' + path);
      },
      undefined,
      undefined,
      undefined,
      10000,
    ),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const call = (input, tool = 'amcp_campaign') => service.call(tool, input, actor);
  return {store, service, writes, requests, campaigns, adgroups, ads, call, close: () => store.close()};
}
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
  // The plan was approved without the flag. The reviews of these packs ask for no spending acknowledgement on this synthetic account, so run
  // completes without a stop; were one asked, run would stop for it once (r25-field-plan): the stop's next call approves the same plan and
  // summary again with the flag, which a synthetic operator would give here, and run then covers every step the approval showed.
  let passes = 0;
  for (let n = 0; n < 4 && result.success && result.data.run?.stopped === 'needs_spend_change_confirmed'; n++) {
    passes++;
    assert.equal(result.data.next_call.arguments.action, 'approve', 'the stop offers the plan approval again');
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

test('the TikTok packs are discoverable with their declared dependencies and reviewed actions', () => {
  for (const id of ['tiktok_website_traffic', 'tiktok_website_conversions']) {
    const definition = campaignRecipes.find(r => r.id === id);
    assert.ok(definition, id + ' is a guided recipe');
    assert.equal(definition.platform, 'tiktok');
    for (const key of ['tiktok_item_id', 'identity_type', 'identity_id', 'location_ids', 'start_time'])
      assert.ok(definition.required.includes(key), id + ' requires ' + key);
    assert.deepEqual(recipeDependencies[id].actions, [
      'tiktok_campaign_create',
      'tiktok_adgroup_create',
      'tiktok_ad_create',
    ]);
    assert.ok(recipeDependencies[id].objects.includes('tiktok_spark_identity'));
  }
  assert.ok(campaignRecipes.find(r => r.id === 'tiktok_website_conversions').required.includes('pixel_id'));
  assert.ok(recipeDependencies.tiktok_website_conversions.objects.includes('account_owned_pixel'));
  assert.equal(recipeObjective('tiktok_website_traffic'), 'traffic');
  assert.equal(recipeObjective('tiktok_website_conversions'), 'sales');
});

test('a traffic brief compiles to three reviewed creates: a DISABLE campaign, an ENABLE ad group and Spark Ad under it', () => {
  const before = JSON.stringify(trafficBusiness),
    plan = campaignRecipe('tiktok_website_traffic', trafficBusiness);
  assert.equal(JSON.stringify(trafficBusiness), before, 'the brief is not mutated');
  assert.deepEqual(
    plan.steps.map(s => [s.id, s.arguments.action, s.depends_on]),
    [
      ['campaign', 'tiktok_campaign_create', []],
      ['adgroup', 'tiktok_adgroup_create', ['campaign']],
      ['ad', 'tiktok_ad_create', ['adgroup']],
    ],
  );
  assert.ok(plan.steps.every(s => s.gateway === gateway && s.expected_currency === 'USD' && s.account_id === '7001'));
  const [c, g, a] = plan.steps.map(s => s.arguments.payload);
  assert.deepEqual(c, {
    advertiser_id: '7001',
    campaign_name: 'Synthetic TikTok traffic',
    objective_type: 'TRAFFIC',
    budget_mode: 'BUDGET_MODE_INFINITE',
    operation_status: 'DISABLE',
  });
  assert.deepEqual(g.campaign_id, {$ref: 'campaign#/data/data/campaign_id'});
  assert.equal(g.operation_status, 'ENABLE');
  assert.equal(g.budget, 25.5, 'TikTok reads the budget as a decimal number in account currency');
  assert.equal(g.budget_mode, 'BUDGET_MODE_DAY');
  assert.equal(g.optimization_goal, 'CLICK');
  assert.equal(g.billing_event, 'CPC');
  assert.equal(g.bid_type, 'BID_TYPE_NO_BID');
  assert.deepEqual(g.placements, ['PLACEMENT_TIKTOK']);
  assert.equal(g.schedule_type, 'SCHEDULE_FROM_NOW');
  assert.equal(g.schedule_start_time, '2026-11-01 07:00:00', 'the +03:00 start is sent in UTC');
  assert.equal(g.pixel_id, undefined);
  assert.deepEqual(a.adgroup_id, {$ref: 'adgroup#/data/data/adgroup_id'});
  assert.equal(a.creatives.length, 1);
  assert.deepEqual(a.creatives[0], {
    ad_name: 'Synthetic TikTok traffic · ad',
    ad_format: 'SINGLE_VIDEO',
    tiktok_item_id: '7300000000000000001',
    identity_type: 'TT_USER',
    identity_id: 'tt-identity-1',
    landing_page_url: 'https://example.com/tiktok-landing',
    call_to_action: 'LEARN_MORE',
    operation_status: 'ENABLE',
  });
  assert.deepEqual(plan.steps[2].prerequisites, ['tiktok_spark_post']);
  assert.equal(plan.recipe.daily_budget, '25.5');
  assert.equal(plan.recipe.schedule.start_utc, '2026-11-01 07:00:00');
  assert.match(plan.recipe.creative_acceptance, /unverified/);
});

test('a purchases brief optimizes the chosen purchase event of the pixel, with an end time and a Business Center identity', () => {
  const plan = campaignRecipe('tiktok_website_conversions', {
    ...conversionBusiness,
    identity_type: 'BC_AUTH_TT',
    identity_authorized_bc_id: '5550001',
    end_time: '2026-11-30T23:00:00Z',
  });
  const [c, g, a] = plan.steps.map(s => s.arguments.payload);
  assert.equal(c.objective_type, 'WEB_CONVERSIONS');
  assert.equal(g.optimization_goal, 'CONVERT');
  assert.equal(g.billing_event, 'OCPM');
  assert.equal(g.pixel_id, '8800');
  assert.equal(g.optimization_event, 'SHOPPING');
  assert.equal(g.schedule_type, 'SCHEDULE_START_END');
  assert.equal(g.schedule_end_time, '2026-11-30 23:00:00');
  assert.deepEqual(plan.steps[1].prerequisites, ['tiktok_pixel']);
  assert.equal(a.creatives[0].identity_authorized_bc_id, '5550001');
  assert.equal(plan.recipe.optimization_event, 'SHOPPING');
});

test('briefs TikTok would refuse, or that AMCP cannot express exactly, are refused before anything is saved', () => {
  for (const [recipe, patch, code] of [
    ['tiktok_website_traffic', {identity_type: 'CUSTOMIZED_USER'}, 'RECIPE_INPUT_INVALID'],
    ['tiktok_website_traffic', {identity_type: 'BC_AUTH_TT'}, 'RECIPE_INPUT_INVALID'],
    ['tiktok_website_traffic', {identity_authorized_bc_id: '5550001'}, 'RECIPE_INPUT_INVALID'],
    ['tiktok_website_traffic', {tiktok_item_id: 'post-1'}, 'RECIPE_INPUT_INVALID'],
    ['tiktok_website_traffic', {account_id: 'acct'}, 'RECIPE_INPUT_INVALID'],
    ['tiktok_website_traffic', {location_ids: []}, 'RECIPE_INPUT_INVALID'],
    ['tiktok_website_traffic', {location_ids: ['6252001', '6252001']}, 'RECIPE_INPUT_INVALID'],
    ['tiktok_website_traffic', {location_ids: ['SA']}, 'RECIPE_INPUT_INVALID'],
    ['tiktok_website_traffic', {call_to_action: 'CLICK_HERE'}, 'RECIPE_INPUT_INVALID'],
    ['tiktok_website_traffic', {daily_budget: '20.125'}, 'INVALID_RECIPE_MONEY'],
    ['tiktok_website_traffic', {daily_budget: '0'}, 'INVALID_RECIPE_MONEY'],
    ['tiktok_website_traffic', {currency: 'JPY', daily_budget: '3000.5'}, 'INVALID_RECIPE_MONEY'],
    ['tiktok_website_traffic', {start_time: '2026-11-01T10:00:00'}, 'RECIPE_DATE_INVALID'],
    ['tiktok_website_traffic', {start_time: '2026-02-30T10:00:00Z'}, 'RECIPE_DATE_INVALID'],
    ['tiktok_website_traffic', {end_time: '2026-11-01T06:00:00Z'}, 'RECIPE_DATE_INVALID'],
    ['tiktok_website_traffic', {destination_url: 'http://example.com/'}, 'DESTINATION_REQUIRED'],
    ['tiktok_website_traffic', {pixel_id: '8800'}, 'RECIPE_INPUT_INVALID'],
    ['tiktok_website_traffic', {name: 'Launch 🚀'}, 'RECIPE_INPUT_INVALID'],
    ['tiktok_website_conversions', {optimization_event: 'PAGE_VIEW'}, 'RECIPE_INPUT_INVALID'],
    ['tiktok_website_conversions', {pixel_id: 'pixel'}, 'RECIPE_INPUT_INVALID'],
  ]) {
    const business = recipe === 'tiktok_website_conversions' ? conversionBusiness : trafficBusiness;
    assert.throws(
      () => campaignRecipe(recipe, {...business, ...patch}),
      e => e.code === code,
      recipe + ' ' + JSON.stringify(patch),
    );
  }
  for (const key of ['tiktok_item_id', 'identity_id', 'location_ids', 'start_time']) {
    const b = {...trafficBusiness};
    delete b[key];
    assert.throws(
      () => campaignRecipe('tiktok_website_traffic', b),
      e => e.code === 'RECIPE_INPUT_REQUIRED' && e.details.missing_fields.includes(key),
    );
  }
  assert.deepEqual(tiktokBudget('3000', 'JPY'), {text: '3000', native: 3000});
  assert.deepEqual(tiktokBudget('20.10', 'USD'), {text: '20.1', native: 20.1});
});

test('recipe context resolves the TikTok login and the pack’s limitations without a provider request', t => {
  const f = setup();
  t.after(f.close);
  const context = recipeContext(f.store, actor, 'tiktok_website_conversions');
  assert.deepEqual(
    context.targets.map(x => [x.connection_id, x.account_id, x.write_granted]),
    [[CONNECTION, '7001', true]],
  );
  assert.match(context.limitations[0], /pixel/);
  assert.equal(f.requests.length, 0);
});

test('a TikTok traffic plan runs every reviewed create to a verified paused launch, then drafts its one activation', async t => {
  const f = setup();
  t.after(f.close);
  const preview = await f.call({action: 'preview_recipe', recipe: 'tiktok_website_traffic', business: trafficBusiness});
  assert.equal(preview.success, true, JSON.stringify(preview).slice(0, 800));
  assert.equal(f.writes.length, 0, 'a preview sends nothing');
  const {id, result} = await launch(f, 'tiktok_website_traffic', trafficBusiness);
  assert.equal(result.success, true, JSON.stringify(result).slice(0, 1500));
  const full = (await f.call({action: 'get', id, detail: 'full'})).data;
  assert.equal(
    full.state,
    'complete',
    JSON.stringify(full.steps.map(s => ({id: s.id, status: s.status, error: s.error}))),
  );
  assert.deepEqual(
    full.steps.map(s => s.status),
    ['verified', 'verified', 'verified'],
  );
  assert.ok(
    f.requests.includes('GET /v1.3/identity/info/') && f.requests.includes('GET /v1.3/identity/video/info/'),
    'preflight read the Spark identity and post',
  );
  assert.deepEqual(
    f.writes.map(w => w.path),
    ['/v1.3/campaign/create/', '/v1.3/adgroup/create/', '/v1.3/ad/create/'],
  );
  assert.equal(f.campaigns.get('900').operation_status, 'DISABLE');
  assert.equal(f.adgroups.get('901').campaign_id, '900', 'the ad group joined the verified campaign');
  assert.equal(f.ads.get('902').adgroup_id, '901');
  assert.equal(f.ads.get('902').tiktok_item_id, trafficBusiness.tiktok_item_id);
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
        'tiktok_campaign_status_update',
        {advertiser_id: '7001', campaign_ids: ['900'], operation_status: 'ENABLE'},
      ],
    ],
  );
  assert.equal(f.writes.length, 3, 'drafting the activation sends nothing');
});

// ACC-01: every guided recipe has a run-to-read-back fixture (tests/recipe-run-to-readback.test.mjs names this one).
test('a TikTok purchases plan runs every reviewed create to a verified paused launch, its pixel read first', async t => {
  const f = setup();
  t.after(f.close);
  const {id, result} = await launch(f, 'tiktok_website_conversions', conversionBusiness);
  assert.equal(result.success, true, JSON.stringify(result).slice(0, 1500));
  const full = (await f.call({action: 'get', id, detail: 'full'})).data;
  assert.equal(
    full.state,
    'complete',
    JSON.stringify(full.steps.map(s => ({id: s.id, status: s.status, error: s.error}))),
  );
  assert.deepEqual(
    full.steps.map(s => s.status),
    ['verified', 'verified', 'verified'],
  );
  // The pixel was read before the first create, and the ad group optimizes for its event.
  const pixelRead = f.requests.indexOf('GET /v1.3/pixel/list/'),
    firstCreate = f.requests.indexOf('POST /v1.3/campaign/create/');
  assert.ok(pixelRead >= 0 && pixelRead < firstCreate, f.requests.join(' | '));
  assert.deepEqual(
    f.writes.map(w => w.path),
    ['/v1.3/campaign/create/', '/v1.3/adgroup/create/', '/v1.3/ad/create/'],
  );
  assert.equal(f.campaigns.get('900').operation_status, 'DISABLE');
  assert.equal(String(f.adgroups.get('901').pixel_id), '8800');
  assert.equal(f.adgroups.get('901').campaign_id, '900');
  const repeated = await f.call({action: 'run', id, confirmed: true, spend_change_confirmed: true});
  assert.equal(repeated.success, true);
  assert.equal(f.writes.length, 3, 'a completed plan never submits duplicate entities');
});

test('a purchases plan reads the pixel before creating anything; an unbound pixel blocks the whole plan', async t => {
  for (const scenario of ['owned', 'unbound', 'missing']) {
    const f = setup({
      pixel:
        scenario === 'unbound'
          ? {asset_ownership: {ownership_status: false, asset_relation_status: 'UNBOUND'}}
          : scenario === 'missing'
            ? {pixel_id: '9999'}
            : {},
    });
    t.after(f.close);
    const out = await f.call({
      action: 'recipe_eligibility',
      recipe: 'tiktok_website_conversions',
      business: conversionBusiness,
      live: true,
    });
    assert.equal(out.success, true, JSON.stringify(out).slice(0, 800));
    const row = id => out.data.dependencies.find(d => d.id === id);
    if (scenario === 'owned') {
      assert.equal(out.data.status, 'unknown', JSON.stringify(out.data.blockers));
      assert.equal(row('account_owned_pixel').status, 'ready');
      assert.equal(row('account_owned_pixel').evidence.asset_type, 'TikTok pixel');
      assert.equal(row('tiktok_spark_identity').status, 'ready');
      assert.equal(row('existing_tiktok_post').status, 'ready');
      assert.equal(row('conversion_event_delivery').status, 'unknown', 'pixel access never proves event delivery');
      assert.equal(row('provider_objective_acceptance').status, 'unknown');
    } else {
      assert.equal(out.data.status, 'blocked');
      assert.ok(
        out.data.blockers.some(b => b.code === 'CAMPAIGN_PREREQUISITE_REQUIRED'),
        JSON.stringify(out.data.blockers),
      );
      assert.notEqual(row('account_owned_pixel').status, 'ready');
    }
    assert.equal(f.writes.length, 0, 'eligibility never writes');
  }
});

// R2.5 field3, package r25-field3-livefix, item 5 (the live check LV-19 CONVERT of 2026-11-21, rebuilt with synthetic IDs): the purchases plan created its
// campaign, then TikTok refused the ad group with 40002 "This pixel event type does not exist", because the pixel's list of events was empty
// (`events: []`), and a campaign was left. "Get pixels" (read 2026-11-21) documents `events` as the pixel's events, each with `event_type` (a standard
// event), `optimization_event` (what an ad group is created with) or `custom_event_type`, refreshed every 2 to 4 hours, and an empty list as a possible
// answer. The preflight reads the list the pixel read already returns and stops a plan whose event the pixel does not hold, before any create.
test('a purchases plan whose pixel does not hold the event stops at preflight before the campaign is created, and names the events the pixel holds', async t => {
  for (const [label, events, held] of [
    ['an empty list of events', [], []],
    [
      'another event',
      [{event_type: 'ON_WEB_CART', optimization_event: 'ON_WEB_CART', name: 'Add to Cart'}],
      ['ON_WEB_CART'],
    ],
    [
      'a page view and a custom event',
      [
        {event_type: 'PAGE_VIEW', optimization_event: null, name: 'Page View'},
        {custom_event_type: 'MY_EVENT', name: 'Mine'},
      ],
      ['MY_EVENT', 'PAGE_VIEW'],
    ],
  ]) {
    const f = setup({pixel: {events}});
    t.after(f.close);
    const created = await f.call({
      action: 'create_from_recipe',
      recipe: 'tiktok_website_conversions',
      business: conversionBusiness,
    });
    assert.equal(created.success, true, label + ' ' + JSON.stringify(created).slice(0, 800));
    assert.equal((await f.call({action: 'preflight', id: created.data.id})).success, true, label);
    const preflight = (await f.call({action: 'get', id: created.data.id, detail: 'full'})).data.preflight,
      blocked = preflight.checks.find(c => c.status === 'blocked');
    assert.equal(preflight.status, 'blocked', label);
    assert.equal(blocked.step, 'adgroup', label + ' ' + JSON.stringify(blocked));
    assert.equal(blocked.error.code, 'CAMPAIGN_PREREQUISITE_REQUIRED', label);
    assert.equal(blocked.error.details.field, 'optimization_event', label);
    assert.equal(blocked.error.details.optimization_event, 'SHOPPING', label);
    assert.deepEqual(blocked.error.details.pixel_events, held, label);
    assert.match(blocked.error.message, /SHOPPING/, label);
    assert.match(blocked.error.message, held.length ? new RegExp(held.join(', ')) : /holds none/, label);
    const run = await f.call({action: 'run', id: created.data.id});
    assert.notEqual(run.data?.state, 'complete', label);
    assert.equal(f.writes.length, 0, 'no campaign was created: ' + label);
  }
});

test('a purchases plan whose pixel holds the event, or whose list of events TikTok does not return, is not stopped, and creates its campaign, ad group and ad once', async t => {
  for (const [label, pixel] of [
    [
      'the event as an optimization event',
      {events: [{event_type: 'SHOPPING', optimization_event: 'SHOPPING', name: 'Purchase'}]},
    ],
    ['the event as a standard event type', {events: [{event_type: 'SHOPPING', name: 'Purchase'}]}],
    [
      'the event among others',
      {events: [{event_type: 'PAGE_VIEW', optimization_event: null}, {optimization_event: 'SHOPPING'}]},
    ],
    ['no list of events at all', {}],
  ]) {
    const f = setup({pixel});
    t.after(f.close);
    const {id, result} = await launch(f, 'tiktok_website_conversions', conversionBusiness);
    assert.equal(result.success, true, label + ' ' + JSON.stringify(result).slice(0, 800));
    const full = (await f.call({action: 'get', id, detail: 'full'})).data;
    assert.equal(
      full.state,
      'complete',
      label + ' ' + JSON.stringify(full.steps.map(s => ({id: s.id, status: s.status, error: s.error}))),
    );
    assert.deepEqual(
      f.writes.map(w => w.path),
      ['/v1.3/campaign/create/', '/v1.3/adgroup/create/', '/v1.3/ad/create/'],
      label,
    );
  }
});
// R2.5 field3, package r25-field3-livefix, item 6 (the live check LV-19 LPV of 2026-11-21): right after a plan created and verified an ad group, the ad
// step's prepare was refused STATE_TARGET_MISMATCH (one read, no write) because TikTok's read had not caught up, and the ad group read back moments
// later. A prepare only reads, so the engine waits briefly and reads again, at most three prepares in all, before it refuses. Here the provider "misses"
// the ad group for the first `lag` reads the ad step's prepare makes (after the advertiser read that starts it).
function lagging(lag) {
  const state = {lag, created: false, armed: false, missed: 0};
  const empty = () =>
    Response.json({
      code: 0,
      message: 'OK',
      request_id: 'r',
      data: {list: [], page_info: {page: 1, page_size: 100, total_number: 0, total_page: 1}},
    });
  return {
    state,
    routes(method, path) {
      if (method === 'POST' && path === '/v1.3/adgroup/create/') state.created = true;
      if (state.created && method === 'GET' && path === '/v1.3/advertiser/info/') state.armed = true;
      if (state.armed && state.lag > 0 && method === 'GET' && path === '/v1.3/adgroup/get/') {
        state.lag--;
        state.missed++;
        return empty();
      }
    },
  };
}
const adgroupReads = f => f.requests.filter(r => r === 'GET /v1.3/adgroup/get/').length;

test('a prepare that cannot find the ad group its own plan just created reads again after a short wait, and the plan goes on without a second write', async t => {
  const was = setPlanReadLagWaits([0, 0]);
  t.after(() => setPlanReadLagWaits(was));
  for (const lag of [1, 2]) {
    const world = lagging(lag),
      f = setup({routes: world.routes});
    t.after(f.close);
    const {id, result} = await launch(f, 'tiktok_website_traffic', trafficBusiness);
    assert.equal(result.success, true, 'lag ' + lag + ' ' + JSON.stringify(result).slice(0, 800));
    const full = (await f.call({action: 'get', id, detail: 'full'})).data;
    assert.equal(
      full.state,
      'complete',
      'lag ' + lag + ' ' + JSON.stringify(full.steps.map(s => ({id: s.id, status: s.status, error: s.error}))),
    );
    assert.equal(world.state.missed, lag, 'the provider missed the ad group ' + lag + ' time(s)');
    // The retry is a read: each create was sent once, and the ad exists once.
    assert.deepEqual(
      f.writes.map(w => w.path),
      ['/v1.3/campaign/create/', '/v1.3/adgroup/create/', '/v1.3/ad/create/'],
      'lag ' + lag,
    );
    assert.equal(f.ads.size, 1);
  }
});

test('a read lag that outlasts the bound is refused as it was, with the note that it may be the provider’s read delay and that preparing again is safe, and nothing is sent', async t => {
  const was = setPlanReadLagWaits([0, 0]);
  t.after(() => setPlanReadLagWaits(was));
  const world = lagging(3),
    f = setup({routes: world.routes});
  t.after(f.close);
  const {id} = await launch(f, 'tiktok_website_traffic', trafficBusiness);
  const full = (await f.call({action: 'get', id, detail: 'full'})).data,
    ad = full.steps.find(s => s.id === 'ad');
  assert.equal(world.state.missed, 3, 'three prepares, so three reads of the ad group');
  assert.equal(ad.status, 'failed', JSON.stringify(ad).slice(0, 600));
  assert.equal(ad.submission, 'not_submitted');
  assert.equal(ad.error.code, 'STATE_TARGET_MISMATCH');
  assert.deepEqual(ad.error.details.read_delay, {attempts: 3, waited_ms: 0, nothing_sent: true});
  assert.match(ad.error.next_action, /read delay/);
  assert.match(ad.error.next_action, /Nothing was sent, so preparing the step again is safe/);
  assert.equal(ad.error.remedy.action, ad.error.next_action);
  assert.deepEqual(
    f.writes.map(w => w.path),
    ['/v1.3/campaign/create/', '/v1.3/adgroup/create/'],
    'no write for the ad was ever sent',
  );
  // The call the refusal names prepares the same step again, with no change to its arguments, and the plan then completes: the ad is created once.
  const recovered = await f.call({action: 'recover_step', id, step_id: 'ad', confirmed: true});
  assert.equal(recovered.success, true, JSON.stringify(recovered).slice(0, 600));
  const again = await f.call({action: 'run', id, confirmed: true, spend_change_confirmed: true});
  assert.equal(again.success, true, JSON.stringify(again).slice(0, 600));
  assert.equal((await f.call({action: 'get', id, detail: 'full'})).data.state, 'complete');
  assert.deepEqual(
    f.writes.map(w => w.path),
    ['/v1.3/campaign/create/', '/v1.3/adgroup/create/', '/v1.3/ad/create/'],
  );
});

test('a step that names no earlier create is not prepared again when its target is missing: the target is read once, never again', async t => {
  const was = setPlanReadLagWaits([0, 0]);
  t.after(() => setPlanReadLagWaits(was));
  const f = setup();
  t.after(f.close);
  // A status change of a campaign this plan did not create: the campaign is not there, and a second read would only say the same.
  const created = await f.call({
    action: 'create',
    name: 'Synthetic status change',
    steps: [
      {
        id: 'status',
        kind: 'write',
        gateway,
        connection_id: CONNECTION,
        account_id: '7001',
        arguments: {
          action: 'tiktok_campaign_status_update',
          account_id: '7001',
          payload: {campaign_ids: ['999'], operation_status: 'DISABLE'},
        },
      },
    ],
  });
  assert.equal(created.success, true, JSON.stringify(created).slice(0, 600));
  const next = await f.call({action: 'prepare_next', id: created.data.id});
  const step = (await f.call({action: 'get', id: created.data.id, detail: 'full'})).data.steps[0];
  assert.equal(step.status, 'failed', JSON.stringify(next).slice(0, 600));
  assert.equal(step.error.code, 'STATE_TARGET_MISMATCH');
  assert.equal(step.error.details?.read_delay, undefined, 'no note of a read delay');
  assert.equal(f.requests.filter(r => r === 'GET /v1.3/campaign/get/').length, 1, 'read once, never again');
  assert.equal(f.writes.length, 0);
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
      recipe: 'tiktok_website_traffic',
      business: {...trafficBusiness, ...(options.business ?? {})},
    });
    assert.equal(created.success, true, JSON.stringify(created).slice(0, 800));
    const checked = await f.call({action: 'preflight', id: created.data.id});
    assert.equal(checked.success, true, JSON.stringify(checked).slice(0, 800));
    const preflight = (await f.call({action: 'get', id: created.data.id, detail: 'full'})).data.preflight,
      blocked = preflight.checks.find(c => c.status === 'blocked');
    assert.equal(preflight.status, 'blocked', JSON.stringify(options));
    assert.equal(blocked.step, 'ad', JSON.stringify(blocked));
    assert.equal(blocked.error.code, 'CAMPAIGN_PREREQUISITE_REQUIRED', JSON.stringify(blocked));
    const run = await f.call({action: 'run', id: created.data.id});
    assert.notEqual(run.data?.state, 'complete');
    assert.equal(f.writes.length, 0, 'nothing was created: ' + JSON.stringify(options));
  }
});

test('activation of a TikTok launch names only the verified campaign receipt', () => {
  const steps = activationSteps('tiktok', new Map([['campaign', {data: {code: 0, data: {campaign_id: '900'}}}]]), {
    connection_id: CONNECTION,
    account_id: '7001',
  });
  assert.equal(steps.length, 1);
  assert.equal(steps[0].gateway, gateway);
  assert.deepEqual(steps[0].arguments.payload.campaign_ids, ['900']);
  assert.throws(
    () =>
      activationSteps('tiktok', new Map([['campaign', {data: {data: {}}}]]), {
        connection_id: CONNECTION,
        account_id: '7001',
      }),
    e => e.code === 'ACTIVATION_UNAVAILABLE',
  );
});

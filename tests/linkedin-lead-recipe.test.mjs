import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {campaignRecipe, campaignRecipes} from '../dist/src/campaign-recipes.js';
import {recipeDependencies} from '../dist/src/capability-eligibility.js';
import {recipeContext, recipeObjective} from '../dist/src/recipe-context.js';

/**
 * CMP-07 (owner direction P7): the guided paused LinkedIn lead generation pack. A synthetic LinkedIn ad account answers
 * the reads and creates of the reviewed linkedin_entities writes; nothing reaches LinkedIn. The pack compiles to the
 * creates the LinkedIn clone uses (campaign group, campaign, creative, all PAUSED), preflight reads the account's lead
 * forms before any create, and the separate activation plan activates the three in order only once the form is
 * published.
 */
const gateway = 'linkedin_native_action',
  CONNECTION = '33333333-3333-4333-8333-333333333333',
  actor = {tenantId: 'linkedin-launch', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'},
  account = 'urn:li:sponsoredAccount:123';
const examples = JSON.parse(readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'));
export const leadBusiness = {...examples.linkedin_lead_business, connection_id: CONNECTION};

function setup({forms} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 73).toString('base64'));
  store.putConnection(
    admin,
    {
      id: CONNECTION,
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'LinkedIn login',
      scopes: ['r_ads', 'rw_ads'],
    },
    {accessToken: 'synthetic'},
  );
  const state = {
    forms: forms ?? [{id: 4242, owner: {sponsoredAccount: account}, name: 'Synthetic form', state: 'PUBLISHED'}],
  };
  const groups = new Map(),
    campaigns = new Map(),
    creatives = new Map(),
    writes = [],
    requests = [];
  let next = 900;
  const listed = rows =>
    Response.json({elements: rows, paging: {start: 0, count: 100, total: rows.length, links: []}, metadata: {}});
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (raw, init = {}) => {
        const url = new URL(String(raw)),
          path = url.pathname,
          method = init.method ?? 'GET';
        requests.push(method + ' ' + path + (url.searchParams.get('q') ? '?q=' + url.searchParams.get('q') : ''));
        assert.equal(url.origin, 'https://api.linkedin.com');
        const base = '/rest/adAccounts/123';
        if (method === 'GET') {
          if (path === base) return Response.json({id: 123, currency: 'USD', status: 'ACTIVE', type: 'BUSINESS'});
          if (path === '/rest/leadForms' && url.searchParams.get('q') === 'owner') {
            assert.match(decodeURIComponent(url.search), /sponsoredAccount:urn:li:sponsoredAccount:123/);
            return listed(structuredClone(state.forms));
          }
          const one = (map, key) =>
            map.has(key)
              ? Response.json(structuredClone(map.get(key)))
              : Response.json({status: 404, message: 'Not found'}, {status: 404});
          let m = /^\/rest\/adAccounts\/123\/adCampaignGroups\/(\d+)$/.exec(path);
          if (m) return one(groups, m[1]);
          m = /^\/rest\/adAccounts\/123\/adCampaigns\/(\d+)$/.exec(path);
          if (m) return one(campaigns, m[1]);
          m = /^\/rest\/adAccounts\/123\/creatives\/(.+)$/.exec(path);
          if (m) return one(creatives, decodeURIComponent(m[1]));
          if (path === base + '/adCampaignGroups') return listed([...groups.values()]);
          if (path === base + '/adCampaigns') return listed([...campaigns.values()]);
          if (path === base + '/creatives') return listed([...creatives.values()]);
        }
        if (method === 'POST') {
          const body = JSON.parse(String(init.body)),
            restli = new Headers(init.headers).get('X-RestLi-Method');
          writes.push({path, body, restli});
          // A REST.li PARTIAL_UPDATE of an existing entity (the activation plan) answers 204.
          const update = (map, key) => {
            const row = map.get(key);
            if (!row || restli?.toUpperCase() !== 'PARTIAL_UPDATE')
              return Response.json({status: 400, message: 'Bad update'}, {status: 400});
            Object.assign(row, body.patch.$set);
            return new Response(null, {status: 204});
          };
          let m = /^\/rest\/adAccounts\/123\/adCampaignGroups\/(\d+)$/.exec(path);
          if (m) return update(groups, m[1]);
          m = /^\/rest\/adAccounts\/123\/adCampaigns\/(\d+)$/.exec(path);
          if (m) return update(campaigns, m[1]);
          m = /^\/rest\/adAccounts\/123\/creatives\/(.+)$/.exec(path);
          if (m) return update(creatives, decodeURIComponent(m[1]));
          const id = String(next++),
            created = key => new Response(null, {status: 201, headers: {'x-restli-id': key, 'x-linkedin-id': key}});
          if (path === base + '/adCampaignGroups') {
            groups.set(id, {...body, id: Number(id)});
            return created(id);
          }
          if (path === base + '/adCampaigns') {
            campaigns.set(id, {...body, id: Number(id)});
            return created(id);
          }
          if (path === base + '/creatives') {
            const urn = 'urn:li:sponsoredCreative:' + id;
            creatives.set(urn, {...body, id: urn, account});
            return created(urn);
          }
        }
        throw new Error('Unexpected LinkedIn request ' + method + ' ' + path + url.search);
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
  return {store, state, writes, requests, groups, campaigns, creatives, call, close: () => store.close()};
}
/** Approves a plan and runs it, confirming each exact native review's spending effect as an operator would. */
async function approveAndRun(f, id) {
  const preview = await f.call({action: 'approve', id});
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
  for (let n = 0; n < 6 && result.success && result.data.run?.stopped === 'needs_spend_change_confirmed'; n++) {
    // Plan approval never supplies this flag; each native review is confirmed on its own.
    const executed = await f.call({...result.data.next_call.arguments, confirmed: true, spend_change_confirmed: true});
    if (!executed.success) return executed;
    result = await f.call({action: 'run', id});
  }
  return result;
}

test('the LinkedIn lead pack is discoverable with its declared dependencies and reviewed creates', () => {
  const definition = campaignRecipes.find(r => r.id === 'linkedin_lead_generation');
  assert.equal(definition.platform, 'linkedin');
  for (const key of ['location_urns', 'locale', 'post_urn', 'lead_form_id', 'call_to_action', 'political_intent'])
    assert.ok(definition.required.includes(key), key);
  assert.deepEqual(recipeDependencies.linkedin_lead_generation.actions, [
    'linkedin_rest_ad_accounts_ad_account_id_ad_campaign_groups_post',
    'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_post',
    'linkedin_rest_ad_accounts_ad_account_id_creatives_post',
  ]);
  assert.ok(recipeDependencies.linkedin_lead_generation.objects.includes('linkedin_lead_form'));
  assert.equal(recipeObjective('linkedin_lead_generation'), 'leads');
});

test('a brief compiles to a PAUSED group, a PAUSED lead campaign with maximum delivery and a PAUSED creative', () => {
  const before = JSON.stringify(leadBusiness),
    plan = campaignRecipe('linkedin_lead_generation', {...leadBusiness, end_time: '2026-11-30T23:00:00Z'});
  assert.equal(JSON.stringify(leadBusiness), before, 'the brief is not mutated');
  assert.deepEqual(
    plan.steps.map(s => [s.id, s.arguments.action, s.depends_on, s.prerequisites ?? []]),
    [
      ['group', 'linkedin_rest_ad_accounts_ad_account_id_ad_campaign_groups_post', [], []],
      ['campaign', 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_post', ['group'], []],
      ['creative', 'linkedin_rest_ad_accounts_ad_account_id_creatives_post', ['campaign'], ['linkedin_lead_form']],
    ],
  );
  assert.ok(plan.steps.every(s => s.gateway === gateway && s.expected_currency === 'USD' && s.account_id === '123'));
  const [group, campaign, creative] = plan.steps.map(s => s.arguments.payload),
    start = Date.parse('2026-11-01T07:00:00Z'),
    end = Date.parse('2026-11-30T23:00:00Z');
  assert.deepEqual(group, {account, name: 'Synthetic LinkedIn leads', status: 'PAUSED', runSchedule: {start, end}});
  assert.deepEqual(campaign.campaignGroup, {$ref: 'group#/created_id', prefix: 'urn:li:sponsoredCampaignGroup:'});
  assert.equal(campaign.status, 'PAUSED');
  assert.equal(campaign.objectiveType, 'LEAD_GENERATION');
  assert.equal(campaign.optimizationTargetType, 'MAX_LEAD');
  assert.equal(campaign.costType, 'CPM');
  assert.equal(campaign.unitCost, undefined, 'maximum delivery sets no bid');
  assert.deepEqual(campaign.dailyBudget, {amount: '50', currencyCode: 'USD'});
  assert.deepEqual(campaign.locale, {country: 'US', language: 'en'});
  assert.equal(campaign.politicalIntent, 'NOT_POLITICAL');
  assert.deepEqual(campaign.runSchedule, {start, end});
  assert.deepEqual(campaign.targetingCriteria.include.and, [
    {or: {'urn:li:adTargetingFacet:locations': ['urn:li:geo:103644278']}},
    {or: {'urn:li:adTargetingFacet:interfaceLocales': ['urn:li:locale:en_US']}},
  ]);
  assert.deepEqual(creative, {
    campaign: {$ref: 'campaign#/created_id', prefix: 'urn:li:sponsoredCampaign:'},
    name: 'Synthetic LinkedIn leads · creative',
    content: {reference: 'urn:li:share:9001'},
    leadgenCallToAction: {destination: 'urn:li:adForm:4242', label: 'SIGN_UP'},
    intendedStatus: 'PAUSED',
  });
  assert.equal(plan.recipe.daily_budget, '50');
  assert.equal(plan.recipe.lead_form_id, '4242');
  assert.match(plan.recipe.creative_acceptance, /unverified/);
});

test('briefs LinkedIn would refuse, or that this pack cannot express exactly, are refused before anything is saved', () => {
  for (const [patch, code] of [
    [{account_id: 'urn:li:sponsoredAccount:123'}, 'RECIPE_INPUT_INVALID'],
    [{name: 'Leads 🚀'}, 'RECIPE_INPUT_INVALID'],
    [{location_urns: []}, 'RECIPE_INPUT_INVALID'],
    [{location_urns: ['urn:li:geo:1', 'urn:li:geo:1']}, 'RECIPE_INPUT_INVALID'],
    [{location_urns: ['urn:li:country:sa']}, 'RECIPE_INPUT_INVALID'],
    [{locale: 'en-US'}, 'RECIPE_INPUT_INVALID'],
    [{post_urn: 'https://www.linkedin.com/feed/update/9001'}, 'RECIPE_INPUT_INVALID'],
    [{lead_form_id: 'urn:li:adForm:4242'}, 'RECIPE_INPUT_INVALID'],
    [{call_to_action: 'SHOP_NOW'}, 'RECIPE_INPUT_INVALID'],
    [{political_intent: 'POLITICAL'}, 'RECIPE_INPUT_INVALID'],
    [{daily_budget: '50.001'}, 'INVALID_RECIPE_MONEY'],
    [{daily_budget: '0'}, 'INVALID_RECIPE_MONEY'],
    [{currency: 'JPY', daily_budget: '5000.5'}, 'INVALID_RECIPE_MONEY'],
    [{start_time: '2026-11-01T10:00:00'}, 'RECIPE_DATE_INVALID'],
    [{start_time: '2026-11-01T24:30:00Z'}, 'RECIPE_DATE_INVALID'],
    [{start_time: '2026-02-30T10:00:00Z'}, 'RECIPE_DATE_INVALID'],
    [{end_time: '2026-11-01T06:00:00Z'}, 'RECIPE_DATE_INVALID'],
  ])
    assert.throws(
      () => campaignRecipe('linkedin_lead_generation', {...leadBusiness, ...patch}),
      e => e.code === code,
      JSON.stringify(patch),
    );
  for (const key of ['location_urns', 'post_urn', 'lead_form_id', 'political_intent', 'start_time']) {
    const b = {...leadBusiness};
    delete b[key];
    assert.throws(
      () => campaignRecipe('linkedin_lead_generation', b),
      e => e.code === 'RECIPE_INPUT_REQUIRED' && e.details.missing_fields.includes(key),
    );
  }
});

test('recipe context resolves the LinkedIn login and the pack’s limitations without a provider request', t => {
  const f = setup();
  t.after(f.close);
  const context = recipeContext(f.store, actor, 'linkedin_lead_generation');
  assert.deepEqual(
    context.targets.map(x => [x.connection_id, x.account_id, x.write_granted]),
    [[CONNECTION, '123', true]],
  );
  assert.match(context.limitations[0], /lead form/);
  assert.equal(f.requests.length, 0);
});

test('a LinkedIn lead plan runs every reviewed create to a verified paused launch; its activation waits for a published form', async t => {
  const f = setup({
    forms: [{id: 4242, owner: {sponsoredAccount: account}, name: 'Synthetic form', state: 'DRAFT'}],
  });
  t.after(f.close);
  const preview = await f.call({action: 'preview_recipe', recipe: 'linkedin_lead_generation', business: leadBusiness});
  assert.equal(preview.success, true, JSON.stringify(preview).slice(0, 800));
  assert.equal(f.writes.length, 0, 'a preview sends nothing');
  const created = await f.call({
    action: 'create_from_recipe',
    recipe: 'linkedin_lead_generation',
    business: leadBusiness,
  });
  assert.equal(created.success, true, JSON.stringify(created).slice(0, 1500));
  const id = created.data.id,
    result = await approveAndRun(f, id);
  assert.equal(result.success, true, JSON.stringify(result).slice(0, 1500));
  const full = (await f.call({action: 'get', id, detail: 'full'})).data;
  assert.equal(
    full.state,
    'complete',
    JSON.stringify(full.steps.map(s => ({id: s.id, status: s.status, error: s.error}))),
  );
  assert.ok(f.requests.includes('GET /rest/leadForms?q=owner'), 'preflight read the account’s lead forms');
  assert.deepEqual(
    f.writes.map(w => w.path),
    ['/rest/adAccounts/123/adCampaignGroups', '/rest/adAccounts/123/adCampaigns', '/rest/adAccounts/123/creatives'],
  );
  assert.equal(f.groups.get('900').status, 'PAUSED');
  assert.equal(f.campaigns.get('901').campaignGroup, 'urn:li:sponsoredCampaignGroup:900');
  assert.equal(f.campaigns.get('901').status, 'PAUSED');
  const made = f.creatives.get('urn:li:sponsoredCreative:902');
  assert.equal(made.campaign, 'urn:li:sponsoredCampaign:901');
  assert.equal(made.intendedStatus, 'PAUSED');
  assert.deepEqual(made.leadgenCallToAction, {destination: 'urn:li:adForm:4242', label: 'SIGN_UP'});
  // The activation is a separate draft: group, then campaign, then creative.
  const activation = await f.call({action: 'activation_plan', id});
  assert.equal(activation.success, true, JSON.stringify(activation).slice(0, 1200));
  const draft = (await f.call({action: 'get', id: activation.data.id, detail: 'full'})).data;
  assert.deepEqual(
    draft.steps.map(s => [s.id, s.arguments.path_params, s.arguments.payload]),
    [
      ['activate_group', {campaign_group_id: '900'}, {patch: {$set: {status: 'ACTIVE'}}}],
      ['activate_campaign', {campaign_id: '901'}, {patch: {$set: {status: 'ACTIVE'}}}],
      ['activate_creative', {creative_id: 'urn:li:sponsoredCreative:902'}, {patch: {$set: {intendedStatus: 'ACTIVE'}}}],
    ],
  );
  assert.equal(draft.activation_of.linkedin_lead_form_id, '4242');
  assert.equal(f.writes.length, 3, 'drafting the activation sends nothing');
  // A DRAFT form blocks activation at preflight, with nothing sent; the gate reads the form again each time.
  const blocked = await f.call({action: 'preflight', id: activation.data.id});
  assert.equal(blocked.data.blocked, true, JSON.stringify(blocked.data).slice(0, 1200));
  const gate = blocked.data.missing_requirements.find(m => m.gate === 'linkedin_lead_form');
  assert.equal(gate.step, 'activate_creative');
  assert.equal(gate.error.code, 'ACTIVATION_GATE_BLOCKED');
  assert.equal(gate.error.details.state, 'DRAFT');
  assert.equal((await f.call({action: 'prepare_next', id: activation.data.id})).data.blocked, true);
  assert.equal(f.writes.length, 3, 'a blocked activation sends nothing');
  // Once LinkedIn shows the form published, the gate passes and each status change runs under its own review.
  f.state.forms[0].state = 'PUBLISHED';
  const ready = await f.call({action: 'preflight', id: activation.data.id, detail: 'full'});
  assert.equal(ready.data.preflight.status, 'ready', JSON.stringify(ready.data.preflight).slice(0, 1200));
  assert.deepEqual(ready.data.preflight.activation_gates, [
    {gate: 'linkedin_lead_form', step: 'activate_creative', status: 'gate_passed'},
  ]);
  const activated = await approveAndRun(f, activation.data.id);
  assert.equal(activated.success, true, JSON.stringify(activated).slice(0, 1500));
  const after = (await f.call({action: 'get', id: activation.data.id, detail: 'full'})).data;
  assert.equal(
    after.state,
    'complete',
    JSON.stringify(after.steps.map(s => ({id: s.id, status: s.status, error: s.error}))),
  );
  assert.deepEqual(
    f.writes.slice(3).map(w => [w.path, w.restli, w.body]),
    [
      ['/rest/adAccounts/123/adCampaignGroups/900', 'PARTIAL_UPDATE', {patch: {$set: {status: 'ACTIVE'}}}],
      ['/rest/adAccounts/123/adCampaigns/901', 'PARTIAL_UPDATE', {patch: {$set: {status: 'ACTIVE'}}}],
      [
        '/rest/adAccounts/123/creatives/urn%3Ali%3AsponsoredCreative%3A902',
        'PARTIAL_UPDATE',
        {patch: {$set: {intendedStatus: 'ACTIVE'}}},
      ],
    ],
  );
  assert.equal(f.creatives.get('urn:li:sponsoredCreative:902').intendedStatus, 'ACTIVE');
});

test('a lead form LinkedIn does not return for the account, or an archived one, stops the plan before any create', async t => {
  for (const forms of [
    [],
    [{id: 4242, owner: {sponsoredAccount: 'urn:li:sponsoredAccount:999'}, state: 'PUBLISHED'}],
    [{id: 4242, owner: {sponsoredAccount: account}, state: 'ARCHIVED'}],
  ]) {
    const f = setup({forms});
    t.after(f.close);
    const out = await f.call({
      action: 'recipe_eligibility',
      recipe: 'linkedin_lead_generation',
      business: leadBusiness,
      live: true,
    });
    assert.equal(out.success, true, JSON.stringify(out).slice(0, 800));
    assert.equal(out.data.status, 'blocked', JSON.stringify(forms));
    assert.ok(
      out.data.blockers.some(b => b.code === 'CAMPAIGN_PREREQUISITE_REQUIRED' && b.step_id === 'creative'),
      JSON.stringify(out.data.blockers),
    );
    assert.notEqual(out.data.dependencies.find(d => d.id === 'linkedin_lead_form').status, 'ready');
    const created = await f.call({
      action: 'create_from_recipe',
      recipe: 'linkedin_lead_generation',
      business: leadBusiness,
    });
    assert.equal(created.success, true, JSON.stringify(created).slice(0, 800));
    const run = await f.call({action: 'run', id: created.data.id});
    assert.notEqual(run.data?.state, 'complete');
    assert.equal(f.writes.length, 0, 'nothing was created: ' + JSON.stringify(forms));
  }
});

test('live eligibility marks the account-owned form ready, and the post and LinkedIn’s acceptance stay unknown', async t => {
  const f = setup();
  t.after(f.close);
  const out = await f.call({
    action: 'recipe_eligibility',
    recipe: 'linkedin_lead_generation',
    business: leadBusiness,
    live: true,
  });
  assert.equal(out.success, true, JSON.stringify(out).slice(0, 800));
  const row = id => out.data.dependencies.find(d => d.id === id);
  assert.equal(out.data.status, 'unknown', JSON.stringify(out.data.blockers));
  assert.equal(row('linkedin_lead_form').status, 'ready');
  assert.equal(row('linkedin_lead_form').evidence.asset_id, '4242');
  assert.equal(row('linkedin_lead_form').evidence.state, 'PUBLISHED');
  assert.equal(row('account_currency').status, 'ready');
  assert.equal(row('existing_linkedin_post').status, 'unknown', 'the post is not read');
  assert.equal(row('provider_objective_acceptance').status, 'unknown');
  assert.equal(f.writes.length, 0, 'eligibility never writes');
});

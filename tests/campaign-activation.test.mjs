// CMP-03: launch completion. A completed recipe plan offers a separate, linked activation plan built from its verified
// IDs (Meta and Google: the campaign; Snapchat: campaign, then ad squad, then ad; Microsoft: four steps), with its own
// approval and read-only gates at preflight. Microsoft activation is refused without a positive location criterion
// (owner decision P7): the activation gate and the campaign step's own review read the campaign's location criteria,
// and the Microsoft Search pack sets them from the brief's location IDs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {Store} from '../dist/src/store.js';
import {CampaignRunner} from '../dist/src/campaign-runner.js';
import {savePlanPolicy} from '../dist/src/campaign-inventory.js';
import {campaignRecipe, campaignRecipes} from '../dist/src/campaign-recipes.js';
import {activationGates, activationSteps} from '../dist/src/campaign-activation.js';
import {compileMicrosoft, assertMicrosoftWrite} from '../dist/src/microsoft-native.js';
import {campaignPreflight} from '../dist/src/campaign-preflight.js';
import {MirrorService} from '../dist/src/service.js';
import {Registry} from '../dist/src/catalog.js';
import {NativeTransport} from '../dist/src/transport.js';
import {MirrorError, errorRemedy} from '../dist/src/errors.js';
import {pinBeforeTiktokCutoff} from './helpers/tiktok-cutoff-clock.mjs';

// Package r25-m4-classic: TikTok stops classic Sales, App Promotion and Lead Generation creates on 2027-01-01 and AMCP refuses them from
// that day (src/tiktok-manual-cutoff.ts); its activation steps are those of every recipe’s completed plan, the website purchases pack’s (a classic Sales campaign) among them, so the clock is pinned before it.
pinBeforeTiktokCutoff();

const examples = JSON.parse(readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'));
const uuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const scope = {connection_id: 'login', account_id: '123'};

/** The verified results a completed launch of each platform holds, keyed by its recipe's step IDs. */
const verifiedResults = {
  meta: () =>
    new Map([
      ['image', {image_hash: 'hash'}],
      ['campaign', {data: {id: '701'}}],
      ['adset', {data: {id: '702'}}],
      ['creative', {data: {id: '703'}}],
      ['ad', {data: {id: '704'}}],
    ]),
  google: () =>
    new Map([
      [
        'build',
        {
          data: {
            mutateOperationResponses: [
              {campaignBudgetResult: {resourceName: 'customers/123/campaignBudgets/8'}},
              {campaignResult: {resourceName: 'customers/123/campaigns/9'}},
              {adGroupResult: {resourceName: 'customers/123/adGroups/10'}},
            ],
          },
        },
      ],
    ]),
  snapchat: () =>
    new Map([
      ['campaign', {data: {campaigns: [{campaign: {id: uuid(1)}}]}}],
      ['squad', {data: {adsquads: [{adsquad: {id: uuid(2)}}]}}],
      ['ad', {data: {ads: [{ad: {id: uuid(3)}}]}}],
    ]),
  microsoft: () =>
    new Map([
      ['campaign', {data: {CampaignIds: ['501']}}],
      ['adgroup', {data: {AdGroupIds: ['502']}}],
      ['keywords', {data: {KeywordIds: ['503', '504']}}],
      ['ad', {data: {AdIds: ['505']}}],
    ]),
  // CMP-07: a TikTok pack's DISABLE campaign holds ENABLE children, so the campaign is the one activation.
  tiktok: () =>
    new Map([
      ['campaign', {data: {code: 0, data: {campaign_id: '601'}}}],
      ['adgroup', {data: {code: 0, data: {adgroup_id: '602'}}}],
      ['ad', {data: {code: 0, data: {ad_ids: ['603']}}}],
    ]),
  // CMP-07: LinkedIn returns each new ID in x-restli-id (the receipt's created_id); a creative's is its URN.
  linkedin: () =>
    new Map([
      ['group', {status: 201, created_id: '801'}],
      ['campaign', {status: 201, created_id: '802'}],
      ['creative', {status: 201, created_id: 'urn:li:sponsoredCreative:803'}],
    ]),
};
// R2.5 M4 (r25-m4-smartweb): an Upgraded Smart+ pack's DISABLE campaign holds ENABLE children as well, so its campaign is the one
// activation, through the Smart+ status family; its steps carry their own IDs (smart_plus_*).
const smartPlusResults = () =>
  new Map([
    ['smart_plus_campaign', {data: {code: 0, data: {campaign_id: '611'}}}],
    ['smart_plus_adgroup', {data: {code: 0, data: {adgroup_id: '612'}}}],
    ['smart_plus_ad', {data: {code: 0, data: {smart_plus_ad_id: '613'}}}],
  ]);
const expected = {
  meta: ['activate_campaign'],
  google: ['activate_campaign'],
  snapchat: ['activate_campaign', 'activate_squad', 'activate_ad'],
  microsoft: ['activate_campaign', 'activate_adgroup', 'activate_keywords', 'activate_ad'],
  tiktok: ['activate_campaign'],
  linkedin: ['activate_group', 'activate_campaign', 'activate_creative'],
};
function business(recipe) {
  return {
    ...examples.recipe_business,
    ...(recipe.id === 'tiktok_website_traffic' ? examples.tiktok_traffic_business : {}),
    ...(recipe.id === 'tiktok_website_conversions' ? examples.tiktok_conversion_business : {}),
    ...(recipe.id === 'tiktok_smart_plus_website_traffic' ? examples.tiktok_smart_plus_traffic_business : {}),
    ...(recipe.id === 'tiktok_smart_plus_website_conversions' ? examples.tiktok_smart_plus_conversion_business : {}),
    ...(recipe.id === 'tiktok_search_traffic' ? examples.tiktok_search_business : {}),
    // R2.5 M4 (r25-m4-search2): the Smart+ Search pack activates as the other Smart+ packs do (its steps carry the same smart_plus_* IDs).
    ...(recipe.id === 'tiktok_smart_plus_search_website' ? examples.tiktok_smart_plus_search_business : {}),
    ...(recipe.id === 'linkedin_lead_generation' ? examples.linkedin_lead_business : {}),
    ...(recipe.id === 'google_performance_max' ? {...examples.google_pmax_business, cpc_bid: undefined} : {}),
    ...(recipe.platform === 'snapchat'
      ? recipe.id === 'snapchat_lead_generation'
        ? examples.snapchat_lead_business
        : examples.snapchat_traffic_business
      : {}),
    ...(['meta_website_sales', 'meta_website_leads'].includes(recipe.id)
      ? {pixel_id: '456', click_attribution_days: 7, view_attribution_days: 1}
      : {}),
    ...(recipe.id === 'google_search_clicks' ? {cpc_bid: undefined, cpc_bid_ceiling: '1.25'} : {}),
    ...([
      'google_search_conversions',
      'google_search_target_cpa',
      'google_search_conversion_value',
      'google_search_target_roas',
    ].includes(recipe.id)
      ? {
          cpc_bid: undefined,
          conversion_goal_policy: 'ACCOUNT_DEFAULT',
          ...(recipe.id === 'google_search_target_cpa' ? {target_cpa: '15.25'} : {}),
          ...(['google_search_conversion_value', 'google_search_target_roas'].includes(recipe.id)
            ? {conversion_value_policy: 'ACCOUNT_RECORDED_VALUES'}
            : {}),
          ...(recipe.id === 'google_search_target_roas' ? {target_roas: '3.5'} : {}),
        }
      : {}),
  };
}

test('each recipe’s completed plan yields exactly its activation steps, from its own verified step IDs', () => {
  for (const recipe of campaignRecipes) {
    const smart = recipe.id.startsWith('tiktok_smart_plus_'),
      plan = campaignRecipe(recipe.id, business(recipe)),
      results = smart ? smartPlusResults() : verifiedResults[recipe.platform](),
      ids = plan.steps.map(s => s.id);
    // The fixture results are keyed by the steps the recipe really compiles.
    for (const id of results.keys()) assert.ok(ids.includes(id), recipe.id + ' compiles step ' + id);
    const steps = activationSteps(recipe.platform, results, scope);
    assert.deepEqual(
      steps.map(s => s.id),
      expected[recipe.platform],
      recipe.id,
    );
    // A Smart+ launch is turned on through the Smart+ status family, with the campaign's own verified ID, and never through the classic one.
    if (smart) {
      assert.equal(steps[0].arguments.action, 'tiktok_smart_plus_campaign_status_update', recipe.id);
      assert.deepEqual(steps[0].arguments.payload, {
        advertiser_id: '123',
        campaign_ids: ['611'],
        operation_status: 'ENABLE',
      });
    }
    for (const s of steps) {
      assert.equal(s.kind, 'write');
      assert.equal(s.connection_id, 'login');
      assert.equal(s.account_id, '123');
      assert.equal(JSON.stringify(s.arguments).includes('$ref'), false, 'every ID is a verified literal');
    }
  }
});

test('the activation steps set only the status, in dependency order, with the verified IDs', () => {
  const [meta] = activationSteps('meta', verifiedResults.meta(), scope);
  assert.deepEqual(meta.arguments, {
    action: 'meta_campaign_update',
    path_params: {campaign_id: '701'},
    payload: {status: 'ACTIVE'},
  });
  const [google] = activationSteps('google', verifiedResults.google(), scope);
  assert.deepEqual(google.arguments.payload, {
    operations: [{update: {resource_name: 'customers/123/campaigns/9', status: 'ENABLED'}, update_mask: 'status'}],
    partial_failure: false,
  });
  // A per-step Google launch (atomic: false) names its campaign in the campaign step's receipt.
  const perStep = new Map([['campaign', {data: {results: [{resourceName: 'customers/123/campaigns/11'}]}}]]);
  assert.equal(
    activationSteps('google', perStep, scope)[0].arguments.payload.operations[0].update.resource_name,
    'customers/123/campaigns/11',
  );
  // Snapchat: campaign, then ad squad, then ad; enabling the campaign alone delivers nothing.
  const snap = activationSteps('snapchat', verifiedResults.snapchat(), scope);
  assert.deepEqual(
    snap.map(s => [s.id, s.depends_on]),
    [
      ['activate_campaign', []],
      ['activate_squad', ['activate_campaign']],
      ['activate_ad', ['activate_squad']],
    ],
  );
  assert.deepEqual(snap[1].arguments.path_params, {campaign_id: uuid(1), ad_squad_id: uuid(2)});
  assert.deepEqual(snap[2].arguments.path_params, {ad_squad_id: uuid(2), ad_id: uuid(3)});
  for (const s of snap) assert.deepEqual(s.arguments.payload, [{op: 'replace', path: '/status', value: 'ACTIVE'}]);
  const microsoft = activationSteps('microsoft', verifiedResults.microsoft(), scope);
  assert.deepEqual(microsoft[2].arguments.payload.Keywords, [
    {Id: '503', Status: 'Active'},
    {Id: '504', Status: 'Active'},
  ]);
  assert.equal(microsoft[3].arguments.campaign_id, '501');
  // A launch without a verified ID, or with a malformed one, names what is missing instead of guessing.
  for (const [platform, results] of [
    ['meta', new Map()],
    ['google', new Map([['build', {data: {mutateOperationResponses: []}}]])],
    ['snapchat', new Map([['campaign', {data: {campaigns: [{campaign: {id: 'not-a-uuid'}}]}}]])],
    ['microsoft', new Map([...verifiedResults.microsoft()].filter(([k]) => k !== 'keywords'))],
    ['tiktok', new Map()],
    ['linkedin', new Map([...verifiedResults.linkedin()].filter(([k]) => k !== 'creative'))],
    // A receipt naming another entity type is not this launch's creative.
    ['linkedin', new Map([...verifiedResults.linkedin(), ['creative', {created_id: 'urn:li:sponsoredCampaign:803'}]])],
  ])
    assert.throws(() => activationSteps(platform, results, scope), {code: 'ACTIVATION_UNAVAILABLE'});
  // LinkedIn: group, then campaign, then creative, each a REST.li PARTIAL_UPDATE of its status alone (CMP-07).
  const linkedin = activationSteps('linkedin', verifiedResults.linkedin(), scope);
  assert.deepEqual(
    linkedin.map(s => [s.id, s.depends_on, s.arguments.action, s.arguments.path_params, s.arguments.payload]),
    [
      [
        'activate_group',
        [],
        'linkedin_rest_ad_accounts_ad_account_id_ad_campaign_groups_campaign_group_id_post',
        {campaign_group_id: '801'},
        {patch: {$set: {status: 'ACTIVE'}}},
      ],
      [
        'activate_campaign',
        ['activate_group'],
        'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_campaign_id_post',
        {campaign_id: '802'},
        {patch: {$set: {status: 'ACTIVE'}}},
      ],
      [
        'activate_creative',
        ['activate_campaign'],
        'linkedin_rest_ad_accounts_ad_account_id_creatives_creative_id_post',
        {creative_id: 'urn:li:sponsoredCreative:803'},
        {patch: {$set: {intendedStatus: 'ACTIVE'}}},
      ],
    ],
  );
  assert.ok(linkedin.every(s => s.arguments.restli_method === 'PARTIAL_UPDATE'));
  // An encoded creative URN receipt names the same creative.
  assert.equal(
    activationSteps(
      'linkedin',
      new Map([...verifiedResults.linkedin(), ['creative', {created_id: 'urn%3Ali%3AsponsoredCreative%3A803'}]]),
      scope,
    )[2].arguments.path_params.creative_id,
    'urn:li:sponsoredCreative:803',
  );
});

// The interim guard refused every Microsoft campaign activation before any read, because AMCP could not read location
// criteria, and the pack was draft only. These expectations change with the location-criterion family: the pack sets
// geography and an activation is checked against the campaign's criteria (tests/microsoft-campaign-criteria.test.ts).
test('the Microsoft Search pack targets the brief’s location IDs on the paused campaign and is no longer draft only', () => {
  const pack = campaignRecipes.find(r => r.id === 'microsoft_search');
  assert.equal(pack.availability, undefined);
  assert.ok(pack.required.includes('location_ids'));
  const plan = campaignRecipe('microsoft_search', examples.recipe_business);
  assert.deepEqual(
    plan.steps.map(s => [s.id, s.arguments.action, s.depends_on]),
    [
      ['campaign', 'AddCampaigns', []],
      ['targets', 'AddCampaignCriterions', ['campaign']],
      ['adgroup', 'AddAdGroups', ['campaign']],
      ['keywords', 'AddKeywords', ['adgroup', 'campaign']],
      ['ad', 'AddAds', ['adgroup', 'campaign']],
    ],
  );
  assert.deepEqual(plan.steps[1].arguments.payload, {
    CriterionType: 'Targets',
    CampaignCriterions: [
      {
        Type: 'BiddableCampaignCriterion',
        CampaignId: {$ref: 'campaign#/data/CampaignIds/0'},
        Criterion: {Type: 'LocationCriterion', LocationId: '190'},
      },
    ],
  });
  assert.equal(plan.recipe.geo_warning, null);
  assert.deepEqual(plan.recipe.location_ids, ['190']);
  assert.equal(plan.recipe.availability, undefined);
  // An existing draft brief without location IDs is refused with the missing input named; malformed IDs are refused.
  const {location_ids: _ids, ...withoutLocations} = examples.recipe_business;
  assert.throws(
    () => campaignRecipe('microsoft_search', withoutLocations),
    e => e.code === 'RECIPE_INPUT_REQUIRED' && e.details.missing_fields.includes('location_ids'),
  );
  for (const location_ids of [['US'], ['190', '190'], ['0']])
    assert.throws(
      () => campaignRecipe('microsoft_search', {...examples.recipe_business, location_ids}),
      e => e.code === 'RECIPE_INPUT_INVALID',
    );
  // Activation is no longer refused by the contract check alone: the review reads the campaign's criteria.
  const compile = payload => compileMicrosoft({action: 'UpdateCampaigns', account_id: '123', payload});
  assertMicrosoftWrite(compile({Campaigns: [{Id: '501', Status: 'Active'}]}));
  assertMicrosoftWrite(compile({Campaigns: [{Id: '501', Status: 'Paused'}]}));
  assertMicrosoftWrite(compile({Campaigns: [{Id: '501', DailyBudget: 30}]}));
  assert.match(errorRemedy(new MirrorError('LOCATION_CRITERIA_REQUIRED', 'x')).action, /AddCampaignCriterions/);
});

test('amcp_write reads the campaign’s location criteria before a Microsoft activation and refuses without one', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 31).toString('base64')),
    actor = {tenantId: 'ms-activation', userId: 'owner', role: 'admin'};
  const requests = [];
  try {
    store.putConnection(
      actor,
      {
        id: 'ms',
        tenantId: actor.tenantId,
        gateway: 'microsoft_ads_native_action',
        accounts: ['123'],
        writeAccounts: ['123'],
        accountCustomers: {123: '900'},
        enabled: true,
        label: 'Microsoft',
        scopes: ['https://ads.microsoft.com/msads.manage'],
      },
      {accessToken: 'synthetic', developerToken: 'synthetic'},
    );
    const service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(async (url, init) => {
        const path = new URL(String(url)).pathname;
        requests.push((init?.method ?? 'GET') + ' ' + path);
        if (path.endsWith('/Account/Query')) return Response.json({Account: {Id: '123'}});
        if (path.endsWith('/Campaigns/QueryByIds'))
          return Response.json({Campaigns: [{Id: '501', Status: 'Paused', CampaignType: 'Search'}]});
        if (path.endsWith('/CampaignCriterions/QueryByIds'))
          return Response.json({CampaignCriterions: [], PartialErrors: null});
        throw Error('Unexpected provider call ' + path);
      }),
      undefined,
      {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
    );
    const out = await service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway: 'microsoft_ads_native_action',
        connection_id: 'ms',
        arguments: {
          action: 'UpdateCampaigns',
          account_id: '123',
          payload: {Campaigns: [{Id: '501', Status: 'Active'}]},
        },
      },
      actor,
    );
    assert.equal(out.success, false);
    assert.equal(out.error.code, 'LOCATION_CRITERIA_REQUIRED', JSON.stringify(out.error));
    assert.ok(requests.includes('POST /CampaignManagement/v13/CampaignCriterions/QueryByIds'), requests.join());
    assert.ok(
      requests.every(r => r.startsWith('POST ') && /\/(Query|QueryByIds)$/.test(r)),
      'only reads: ' + requests.join(),
    );
  } finally {
    store.close();
  }
});

test('a Microsoft activation plan’s location gate blocks preflight with a remedy and passes with Microsoft’s names', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 32).toString('base64')),
    actor = {tenantId: 'ms-preflight', userId: 'owner', role: 'admin'};
  try {
    store.putConnection(
      actor,
      {
        id: 'login',
        tenantId: actor.tenantId,
        gateway: 'microsoft_ads_native_action',
        accounts: ['123'],
        writeAccounts: ['123'],
        accountCustomers: {123: '900'},
        enabled: true,
        label: 'Microsoft',
        scopes: ['https://ads.microsoft.com/msads.manage'],
      },
      {accessToken: 'synthetic', developerToken: 'synthetic'},
    );
    const service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(async () => {
        throw Error('Unexpected provider call');
      }),
      undefined,
      {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
    );
    service.runPlan = async () => ({data: {Account: {Id: 123, CurrencyCode: 'USD'}}});
    const steps = activationSteps('microsoft', verifiedResults.microsoft(), scope).map(s => ({
      ...s,
      status: 'pending',
    }));
    // Every step's contract checks locally; the location rule is the gate's (and each review's) to decide.
    const preflight = await campaignPreflight(service, actor, steps);
    assert.deepEqual(
      preflight.checks.map(c => c.status),
      ['contract_checked', 'contract_checked', 'contract_checked', 'contract_checked'],
    );
    assert.equal(preflight.provider_mutations, 0);
    const reads = [];
    let answer;
    const call = async (gateway, input) => (reads.push([gateway, input.action, input.payload]), answer());
    const gate = async () => (await activationGates(call, actor, {platform: 'microsoft'}, steps))[0];
    answer = () => ({success: true, data: {data: {CampaignCriterions: []}}});
    const none = await gate();
    assert.equal(none.status, 'blocked');
    assert.equal(none.gate, 'microsoft_location_criteria');
    assert.equal(none.step, 'activate_campaign');
    assert.equal(none.error.code, 'ACTIVATION_GATE_BLOCKED');
    assert.match(none.error.message, /no positive location criterion/);
    assert.deepEqual(reads[0], [
      'microsoft_ads_native_action',
      'GetCampaignCriterionsByIds',
      {CampaignId: '501', CriterionType: 'Location', CampaignCriterionIds: null},
    ]);
    // An exclusion alone is not geography; an unreadable answer is not shown to be safe.
    answer = () => ({
      success: true,
      data: {
        data: {
          CampaignCriterions: [
            {
              Id: '9',
              Type: 'NegativeCampaignCriterion',
              CampaignId: '501',
              Criterion: {Type: 'LocationCriterion', LocationId: '32'},
            },
          ],
        },
      },
    });
    assert.equal((await gate()).status, 'blocked');
    answer = () => ({success: false, error: {code: 'PROVIDER_ERROR', message: 'Refused.'}});
    const unreadable = await gate();
    assert.equal(unreadable.status, 'blocked');
    assert.equal(unreadable.error.details.read_error, 'PROVIDER_ERROR');
    answer = () => ({
      success: true,
      data: {
        data: {
          CampaignCriterions: [
            {
              Id: '8',
              Type: 'BiddableCampaignCriterion',
              CampaignId: '501',
              Status: 'Active',
              Criterion: {Type: 'LocationCriterion', LocationId: '190', DisplayName: 'Synthetic location 190'},
            },
          ],
        },
      },
    });
    const passed = await gate();
    assert.equal(passed.status, 'gate_passed', JSON.stringify(passed));
    assert.deepEqual(passed.locations, [{location_id: '190', name: 'Synthetic location 190'}]);
  } finally {
    store.close();
  }
});

// A runner whose provider is a script: a Snapchat recipe launch runs to completion, then its activation plan's gate
// reads the ad's creative review status from `state.review`.
function snapchatFixture() {
  const actor = {tenantId: 'activation', userId: 'operator', role: 'operator'},
    store = new Store(':memory:', Buffer.alloc(32, 33).toString('base64'));
  store.putConnection(
    {...actor, role: 'admin'},
    {
      id: 'snap',
      tenantId: actor.tenantId,
      gateway: 'snapchat_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Snapchat',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const state = {review: 'APPROVED', reads: [], prepares: [], executes: 0, count: 0, readFails: false};
  const created = {
    snapchat_campaign_create: {campaigns: [{campaign: {id: uuid(1)}}]},
    snapchat_adsquad_create: {adsquads: [{adsquad: {id: uuid(2)}}]},
    snapchat_ad_create: {ads: [{ad: {id: uuid(3)}}]},
  };
  const runner = new CampaignRunner(
    store,
    async (name, input) => {
      if (name === 'snapchat_native_action') {
        state.reads.push(input);
        if (state.readFails) return {success: false, error: {code: 'PROVIDER_ERROR', message: 'Refused.'}};
        return {
          success: true,
          data: {
            data: {ads: [{ad: {id: input.path_params.ad_id, review_status: state.review, status: 'PAUSED'}}]},
          },
        };
      }
      if (input.action === 'prepare') {
        state.prepares.push(input.arguments);
        const id = 'review-' + ++state.count;
        return {
          success: true,
          data: {
            review_id: id,
            idempotency_key: id,
            expires_at: new Date(Date.now() + 300000).toISOString(),
            request: input.arguments,
          },
        };
      }
      state.executes++;
      store.claim(actor.tenantId, input.review_id, 'request');
      const step = state.prepares.at(-1),
        result = {data: created[step.action] ?? {}};
      store.complete(actor.tenantId, input.review_id, result);
      return {success: true, data: result};
    },
    async () => ({status: 'verified'}),
    async () => ({}),
    async () => ({status: 'ready', checks: []}),
  );
  const call = input => runner.handle(input, actor);
  return {actor, store, state, call, runner};
}
async function completedLaunch(f) {
  const plan = campaignRecipe('snapchat_website_traffic', {
    ...examples.snapchat_traffic_business,
    connection_id: 'snap',
  });
  const run = await f.call({action: 'create', name: 'Snapchat launch', brief: 'Synthetic.', steps: plan.steps});
  const saved = f.store.document(f.actor.tenantId, 'campaign_run', run.id);
  f.store.putDocument(f.actor.tenantId, 'campaign_run', run.id, {...saved, recipe: plan.recipe}, saved.revision);
  // Not before every step of the launch is verified.
  await assert.rejects(() => f.call({action: 'activation_plan', id: run.id}), {code: 'ACTIVATION_NOT_READY'});
  let last;
  for (let i = 0; i < 3; i++) {
    const p = await f.call({action: 'prepare_next', id: run.id});
    last = await f.call({
      action: 'execute_next',
      id: run.id,
      review_id: p.review.review_id,
      idempotency_key: p.review.idempotency_key,
      confirmed: true,
    });
  }
  return {id: run.id, last};
}

test('a completed recipe launch offers activation outside next_call, and drafts one linked activation plan', async () => {
  const f = snapchatFixture();
  try {
    const {id, last} = await completedLaunch(f);
    assert.equal(last.state, 'complete');
    // The launch never moves into activation by itself: next_call ends, and the offer is a separate call.
    assert.equal(last.next_call, null);
    assert.deepEqual(last.activation_call.arguments, {action: 'activation_plan', id});
    assert.deepEqual((await f.call({action: 'get', id})).activation_call.arguments, {action: 'activation_plan', id});
    const drafted = await f.call({action: 'activation_plan', id, detail: 'full'});
    assert.notEqual(drafted.id, id);
    assert.equal(drafted.state, 'draft');
    assert.deepEqual(
      drafted.steps.map(s => s.id),
      ['activate_campaign', 'activate_squad', 'activate_ad'],
    );
    assert.equal(drafted.activation_of.id, id);
    assert.equal(drafted.activation_of.platform, 'snapchat');
    assert.equal(drafted.approval === undefined || typeof drafted.approval === 'string', true, 'not approved');
    assert.deepEqual(drafted.next_call.arguments, {action: 'preflight', id: drafted.id});
    const launch = f.store.document(f.actor.tenantId, 'campaign_run', id);
    assert.equal(launch.activation_plan.id, drafted.id);
    assert.equal((await f.call({action: 'get', id})).activation_call, undefined, 'offered once');
    // A repeat returns the same draft; the activation plan has no activation of its own.
    assert.equal((await f.call({action: 'activation_plan', id})).id, drafted.id);
    assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 2);
    await assert.rejects(() => f.call({action: 'activation_plan', id: drafted.id}), {code: 'ACTIVATION_UNAVAILABLE'});
    const events = f.store.db
      .prepare('SELECT event FROM audit WHERE tenant_id=?')
      .all(f.actor.tenantId)
      .map(r => JSON.parse(r.event));
    assert.ok(events.some(e => e.event === 'campaign_activation_planned' && e.activation_of === id));
    assert.equal(f.state.executes, 3, 'drafting sent nothing');
  } finally {
    f.store.close();
  }
});

test('activation_plan creates the draft with its gates in the one save that creates it: a failure after it leaves a draft that carries them, and the repeat links it (r25-planmodel, M9)', async () => {
  const f = snapchatFixture();
  try {
    const {id} = await completedLaunch(f),
      put = f.store.putDocument.bind(f.store);
    let created = false;
    // The save that follows the creation of the draft fails: with two saves it was the one that bound the draft to its launch.
    f.store.putDocument = (tenant, kind, doc, data, revision) => {
      if (kind === 'campaign_run' && doc !== id && revision === undefined) {
        created = true;
        return put(tenant, kind, doc, data, revision);
      }
      if (kind === 'campaign_run' && created) {
        created = false;
        throw new Error('synthetic failure of the save that follows the draft');
      }
      return put(tenant, kind, doc, data, revision);
    };
    await assert.rejects(() => f.call({action: 'activation_plan', id}), /synthetic failure/);
    f.store.putDocument = put;
    const drafts = f.store.documents(f.actor.tenantId, 'campaign_run').filter(p => p.id !== id);
    assert.equal(drafts.length, 1, 'the draft exists');
    assert.equal(
      drafts[0].activation_of?.id,
      id,
      'and it carries its gates and its second approver: it is not a plan that runs ungated',
    );
    assert.equal(
      f.store.document(f.actor.tenantId, 'campaign_run', id).activation_plan,
      undefined,
      'the launch does not name it yet',
    );
    // The repeat finds the same draft, and links it.
    const again = await f.call({action: 'activation_plan', id});
    assert.equal(again.id, drafts[0].id);
    assert.equal(f.store.document(f.actor.tenantId, 'campaign_run', id).activation_plan.id, drafts[0].id);
    assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 2);
    const events = f.store.db
      .prepare('SELECT event FROM audit WHERE tenant_id=?')
      .all(f.actor.tenantId)
      .map(r => JSON.parse(r.event));
    assert.equal(
      events.filter(e => e.event === 'campaign_activation_planned').length,
      1,
      'recorded once, when the launch names it',
    );
    assert.equal(f.state.executes, 3, 'nothing was sent');
  } finally {
    f.store.close();
  }
});

test('a failed or unreadable activation gate blocks preflight with a remedy before any status write', async () => {
  const f = snapchatFixture();
  try {
    const {id} = await completedLaunch(f),
      activation = await f.call({action: 'activation_plan', id}),
      prepares = f.state.prepares.length;
    f.state.review = 'PENDING_REVIEW';
    const blocked = await f.call({action: 'preflight', id: activation.id});
    assert.equal(blocked.blocked, true);
    const gate = blocked.missing_requirements[0];
    assert.equal(gate.step, 'activate_ad');
    assert.equal(gate.error.code, 'ACTIVATION_GATE_BLOCKED');
    assert.equal(gate.error.details.review_status, 'PENDING_REVIEW');
    assert.match(gate.error.remedy.action, /Nothing was activated/);
    // The gate is settled at the provider and checked again by preflight, never by amending the step.
    assert.deepEqual(blocked.next_call.arguments, {action: 'preflight', id: activation.id});
    assert.deepEqual(f.state.reads.at(-1).path_params, {ad_id: uuid(3)});
    // Every later call stops at the blocked preflight: nothing is prepared or sent.
    assert.equal((await f.call({action: 'prepare_next', id: activation.id})).blocked, true);
    assert.equal(f.state.prepares.length, prepares);
    f.state.readFails = true;
    const unreadable = await f.call({action: 'preflight', id: activation.id});
    assert.equal(unreadable.missing_requirements[0].error.code, 'ACTIVATION_GATE_BLOCKED');
    assert.equal(unreadable.missing_requirements[0].error.details.read_error, 'PROVIDER_ERROR');
    // Approved: the gate passes, and Snapchat's order holds: the campaign first, and nothing after it until it is done.
    f.state.readFails = false;
    f.state.review = 'APPROVED';
    const ready = await f.call({action: 'preflight', id: activation.id, detail: 'full'});
    assert.equal(ready.preflight.status, 'ready');
    assert.deepEqual(ready.preflight.activation_gates, [
      {gate: 'snapchat_creative_review', step: 'activate_ad', status: 'gate_passed'},
    ]);
    const first = await f.call({action: 'prepare_next', id: activation.id});
    assert.equal(first.step_id, 'activate_campaign');
    assert.deepEqual(f.state.prepares.at(-1).payload, [{op: 'replace', path: '/status', value: 'ACTIVE'}]);
    assert.equal((await f.call({action: 'prepare_next', id: activation.id})).step_id, 'activate_campaign');
  } finally {
    f.store.close();
  }
});

test('a plan that is not a guided recipe launch has no activation', async () => {
  const f = snapchatFixture();
  try {
    const plan = campaignRecipe('snapchat_website_traffic', {
      ...examples.snapchat_traffic_business,
      connection_id: 'snap',
    });
    const run = await f.call({action: 'create', name: 'Native plan', brief: 'Synthetic.', steps: plan.steps});
    await assert.rejects(() => f.call({action: 'activation_plan', id: run.id}), {code: 'ACTIVATION_UNAVAILABLE'});
  } finally {
    f.store.close();
  }
});

test('a Meta activation gate refuses a disapproved or unreadable ad and passes a paused one', async () => {
  const actor = {tenantId: 'meta-activation', userId: 'operator', role: 'operator'},
    store = new Store(':memory:', Buffer.alloc(32, 34).toString('base64'));
  store.putConnection(
    {...actor, role: 'admin'},
    {
      id: 'meta',
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Meta',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const ad = {id: '704', status: 'ACTIVE', effective_status: 'DISAPPROVED', ad_review_feedback: {global: {X: 'y'}}};
  let reads = 0,
    fail = false;
  const runner = new CampaignRunner(
    store,
    async (name, input) => {
      if (name === 'meta_native_action') {
        reads++;
        assert.equal(input.action, 'meta_ad_get');
        assert.deepEqual(input.path_params, {ad_id: '704'});
        return fail ? {success: false, error: {code: 'AUTH_EXPIRED'}} : {success: true, data: {data: ad}};
      }
      throw Error('No write is expected');
    },
    async () => ({status: 'verified'}),
    async () => ({}),
    async () => ({status: 'ready', checks: []}),
  );
  const call = input => runner.handle(input, actor);
  try {
    const steps = activationSteps('meta', verifiedResults.meta(), {connection_id: 'meta', account_id: '123'});
    const run = await call({action: 'create', name: 'Meta activation', brief: 'Synthetic.', steps});
    const saved = store.document(actor.tenantId, 'campaign_run', run.id);
    store.putDocument(
      actor.tenantId,
      'campaign_run',
      run.id,
      {...saved, activation_of: {id: 'launch', platform: 'meta', meta_ad_id: '704'}},
      saved.revision,
    );
    const disapproved = await call({action: 'preflight', id: run.id});
    assert.equal(disapproved.missing_requirements[0].error.details.effective_status, 'DISAPPROVED');
    fail = true;
    const unreadable = await call({action: 'preflight', id: run.id});
    assert.equal(unreadable.missing_requirements[0].error.details.read_error, 'AUTH_EXPIRED');
    fail = false;
    Object.assign(ad, {effective_status: 'CAMPAIGN_PAUSED', ad_review_feedback: undefined});
    const ready = await call({action: 'preflight', id: run.id, detail: 'full'});
    assert.equal(ready.preflight.status, 'ready');
    assert.equal(reads, 3);
  } finally {
    store.close();
  }
});

// A completed Google or Meta conversion launch, saved directly as verified, so its activation can be drafted.
async function completedConversionLaunch(call, store, actor, platform, recipeId, connection) {
  const plan = campaignRecipe(recipeId, {...business({id: recipeId, platform}), connection_id: connection});
  const run = await call({action: 'create', name: 'Conversion launch', brief: 'Synthetic.', steps: plan.steps});
  const saved = store.document(actor.tenantId, 'campaign_run', run.id),
    results = verifiedResults[platform]();
  store.putDocument(
    actor.tenantId,
    'campaign_run',
    run.id,
    {
      ...saved,
      state: 'complete',
      recipe: plan.recipe,
      steps: saved.steps.map(s => ({...s, status: 'verified', result: results.get(s.id) ?? {data: {}}})),
    },
    saved.revision,
  );
  return run.id;
}

test('a Google conversion activation is gated on the account-default goals recipe_eligibility reads', async () => {
  const actor = {tenantId: 'google-activation', userId: 'operator', role: 'operator'},
    store = new Store(':memory:', Buffer.alloc(32, 35).toString('base64'));
  store.putConnection(
    {...actor, role: 'admin'},
    {
      id: 'google',
      tenantId: actor.tenantId,
      gateway: 'google_ads_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Google',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const inspections = [];
  let inspection = {complete: true, provider_mutations: 0, dependency_statuses: {}};
  const runner = new CampaignRunner(
    store,
    async () => {
      throw Error('No provider call is expected');
    },
    async () => ({status: 'verified'}),
    async () => ({}),
    async () => ({status: 'ready', checks: []}),
    () => true,
    async (_actor, scope, current) => {
      current();
      inspections.push(scope);
      return inspection;
    },
  );
  const call = input => runner.handle(input, actor);
  try {
    const launch = await completedConversionLaunch(
      call,
      store,
      actor,
      'google',
      'google_search_conversion_value',
      'google',
    );
    const activation = await call({action: 'activation_plan', id: launch, detail: 'full'});
    // The gate reads what the recipe declares: goals and primary actions, value settings and reported activity.
    assert.deepEqual(activation.activation_of.conversion_goals, {
      currency: examples.recipe_business.currency,
      include_value_settings: true,
      include_activity: true,
    });
    inspection = {
      complete: true,
      provider_mutations: 0,
      dependency_statuses: {account_default_conversion_goals: 'ready', primary_conversion_actions: 'blocked'},
    };
    const blocked = await call({action: 'preflight', id: activation.id});
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.missing_requirements[0].gate, 'google_conversion_goals');
    assert.equal(blocked.missing_requirements[0].error.code, 'ACTIVATION_GATE_BLOCKED');
    assert.deepEqual(inspections.at(-1), {
      gateway: 'google_ads_native_action',
      account_id: activation.steps[0].account_id,
      connection_id: 'google',
      currency: examples.recipe_business.currency,
      include_value_settings: true,
      include_activity: true,
    });
    // An incomplete read blocks too: readiness must be shown.
    inspection = {complete: false, provider_mutations: 0, dependency_statuses: {}, error: {code: 'STATE_READ_FAILED'}};
    const unreadable = await call({action: 'preflight', id: activation.id});
    assert.equal(unreadable.missing_requirements[0].error.details.read_error, 'STATE_READ_FAILED');
    inspection = {
      complete: true,
      provider_mutations: 0,
      dependency_statuses: {account_default_conversion_goals: 'ready', primary_conversion_actions: 'ready'},
    };
    const ready = await call({action: 'preflight', id: activation.id, detail: 'full'});
    assert.equal(ready.preflight.status, 'ready');
    assert.deepEqual(ready.preflight.activation_gates, [
      {gate: 'google_conversion_goals', step: 'activate_campaign', status: 'gate_passed'},
    ]);
    const events = store.db
      .prepare('SELECT event FROM audit WHERE tenant_id=?')
      .all(actor.tenantId)
      .map(r => JSON.parse(r.event))
      .filter(e => e.event === 'campaign_activation_preflight');
    assert.deepEqual(
      events.map(e => [e.status, e.blocked_gates]),
      [
        ['blocked', ['google_conversion_goals']],
        ['blocked', ['google_conversion_goals']],
        ['ready', []],
      ],
    );
  } finally {
    store.close();
  }
});

test('a Meta conversion activation also gates its pixel, read-only, before the status write', async () => {
  const actor = {tenantId: 'meta-pixel-activation', userId: 'operator', role: 'operator'},
    store = new Store(':memory:', Buffer.alloc(32, 36).toString('base64'));
  store.putConnection(
    {...actor, role: 'admin'},
    {
      id: 'meta',
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Meta',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const pixel = {id: '456', is_unavailable: true},
    reads = [];
  const runner = new CampaignRunner(
    store,
    async (name, input) => {
      assert.equal(name, 'meta_native_action');
      reads.push(input.action);
      assert.equal(input.action, 'meta_ad_get');
      return {success: true, data: {data: {id: '704', effective_status: 'CAMPAIGN_PAUSED'}}};
    },
    async () => ({status: 'verified'}),
    async () => ({}),
    async () => ({status: 'ready', checks: []}),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    // Package r25-field2-access, B2: the pixel gate reads the ad account's pixel list through the service's runPlan, not the pixel node
    // through `call` (the node was refused for want of ownership in production; tests/meta-activation-pixel-gate.test.mjs runs the gate
    // through the real service). Its path, fields, paging options and account are pinned here.
    async (_actor, plan, input) => {
      reads.push('pixel_list');
      assert.equal(plan.method, 'GET');
      assert.match(plan.path, /\/act_123\/adspixels$/);
      assert.deepEqual(plan.query, {fields: 'id,is_unavailable', limit: 100});
      assert.deepEqual(input, {connection_id: 'meta', aggregate_pages: true, max_pages: 25});
      return {data: {data: [pixel]}, truncated: false};
    },
  );
  const call = input => runner.handle(input, actor);
  try {
    const launch = await completedConversionLaunch(call, store, actor, 'meta', 'meta_website_sales', 'meta');
    const activation = await call({action: 'activation_plan', id: launch, detail: 'full'});
    assert.equal(activation.activation_of.meta_pixel_id, '456');
    assert.equal(activation.activation_of.meta_ad_id, '704');
    const blocked = await call({action: 'preflight', id: activation.id});
    assert.equal(blocked.missing_requirements[0].gate, 'meta_pixel');
    assert.equal(blocked.missing_requirements[0].error.details.is_unavailable, true);
    pixel.is_unavailable = false;
    const ready = await call({action: 'preflight', id: activation.id, detail: 'full'});
    assert.equal(ready.preflight.status, 'ready');
    assert.deepEqual(
      ready.preflight.activation_gates.map(g => [g.gate, g.status]),
      [
        ['meta_ad_review', 'gate_passed'],
        ['meta_pixel', 'gate_passed'],
      ],
    );
    assert.deepEqual(reads, ['meta_ad_get', 'pixel_list', 'meta_ad_get', 'pixel_list']);
  } finally {
    store.close();
  }
});

test('the activation gate error and the location refusal carry remedies', () => {
  for (const code of ['ACTIVATION_GATE_BLOCKED', 'LOCATION_CRITERIA_REQUIRED']) {
    const remedy = errorRemedy(new MirrorError(code, 'Synthetic.'));
    assert.equal(remedy.mutation_retry_safe, false);
    assert.ok(remedy.action.length > 20);
  }
});

test('the website lists the locations a Microsoft activation gate read, literal and escaped, in English and Arabic', () => {
  const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
  for (const locale of ['en', 'ar']) {
    const node = () => ({
      innerHTML: '',
      dataset: {},
      addEventListener() {},
      querySelector: node,
      querySelectorAll: () => [],
      append() {},
      remove() {},
    });
    const context = createContext({
      catalog,
      Intl,
      Date,
      URLSearchParams,
      location: {search: ''},
      history: {replaceState() {}},
      document: {addEventListener() {}, querySelector: node, querySelectorAll: () => [], createElement: node},
      $: node,
      esc: value =>
        String(value ?? '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;'),
      date: String,
      toast() {},
      confirmAction: async () => true,
      session: {id: 'owner'},
      navigationGeneration: 1,
      identityGeneration: 1,
    });
    const run = source => new Script(source).runInContext(context);
    run(readFileSync('web/localization.js', 'utf8'));
    run(
      `uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`,
    );
    run(readFileSync('web/workspace.js', 'utf8'));
    run(readFileSync('web/campaign-workflows.js', 'utf8'));
    const html = context.activationLocationsView({
      preflight: {
        activation_gates: [
          {
            gate: 'microsoft_location_criteria',
            step: 'activate_campaign',
            status: 'gate_passed',
            locations: [
              {location_id: '190', name: '<b>Synthetic location</b>'},
              {location_id: '32', name: null},
            ],
          },
        ],
      },
    });
    assert.match(html, /&lt;b&gt;Synthetic location&lt;\/b&gt;/);
    assert.match(html, /<code dir="ltr">190<\/code>/);
    assert.match(html, /<code dir="ltr">32<\/code>/);
    assert.match(html, locale === 'ar' ? /المواقع التي تستهدفها Microsoft/ : /Locations Microsoft targets/);
    assert.equal(
      context.activationLocationsView({preflight: {activation_gates: [{gate: 'snapchat_creative_review'}]}}),
      '',
    );
  }
});

// ---- r25-planmodel, item 4 of the audit of 2026-11-25: a continuation is not given an activation plan's gates or its second approver ----------------------------------------
// An activation plan is gated by what it is: `activation_of` makes its preflight run the platform's read-only gates and, under the owner's distinct-approver policy, requires another
// person to approve it whatever its steps set. continue_as_new made a new plan without it: the owner continued a plan whose gate refused (the creative still in review), approved
// the new plan alone, and sent the status changes. The continuation of an activation plan is refused now, with the way that does work, and every action of the plan itself keeps its gates.
const approverActor = {tenantId: 'activation', userId: 'approver', role: 'admin'};
const policyOwner = {tenantId: 'activation', userId: 'owner', role: 'admin'};

test('continue_as_new refuses an activation plan and changes nothing: its gates and its second approver stay with the plan, and the plan still runs by its own path', async () => {
  const f = snapchatFixture();
  try {
    const {id} = await completedLaunch(f);
    savePlanPolicy(f.store, policyOwner, {require_distinct_approver: true, confirmed: true});
    const activation = await f.call({action: 'activation_plan', id}),
      sent = f.state.executes;
    f.state.review = 'PENDING_REVIEW';
    const blocked = await f.call({action: 'preflight', id: activation.id});
    assert.equal(blocked.blocked, true, 'the gate refuses: the creative is not approved');
    const prepares = f.state.prepares.length,
      plans = f.store.documents(f.actor.tenantId, 'campaign_run').length;
    // The continuation is refused before anything is held, retired or made, and names where the plan's steps are settled.
    await assert.rejects(
      () => f.call({action: 'continue_as_new', id: activation.id, confirmed: true}),
      error => {
        assert.equal(error.code, 'RECOVERY_NOT_SAFE');
        assert.equal(error.details.activation_of, id);
        assert.deepEqual(error.details.next_call.arguments, {action: 'get', id: activation.id});
        return true;
      },
    );
    assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, plans, 'no second plan was made');
    const kept = f.store.document(f.actor.tenantId, 'campaign_run', activation.id);
    assert.equal(kept.state, 'draft');
    assert.equal(kept.superseded_by, undefined);
    assert.equal(kept.activation_of.id, id);
    // The plan keeps its gate: nothing is prepared or sent while the creative is in review.
    assert.equal((await f.call({action: 'prepare_next', id: activation.id})).blocked, true);
    assert.equal(f.state.prepares.length, prepares);
    assert.equal(f.state.executes, sent);
    // The creative is approved: the gate passes, and the owner cannot approve the plan alone, nor send its first step.
    f.state.review = 'APPROVED';
    const ready = await f.call({action: 'preflight', id: activation.id});
    assert.equal(ready.blocked, false);
    const preview = await f.call({action: 'approve', id: activation.id});
    assert.equal(preview.approver_required, true, 'the owner is told another person approves it');
    const approval = {
      action: 'approve',
      id: activation.id,
      plan_hash: preview.plan_hash,
      summary_hash: preview.summary_hash,
      confirmed: true,
    };
    await assert.rejects(() => f.call(approval), {code: 'DISTINCT_APPROVER_REQUIRED'});
    const first = await f.call({action: 'prepare_next', id: activation.id});
    const ownRun = {
      action: 'execute_next',
      id: activation.id,
      review_id: first.review.review_id,
      idempotency_key: first.review.idempotency_key,
      confirmed: true,
      spend_change_confirmed: true,
    };
    await assert.rejects(() => f.call(ownRun), {code: 'DISTINCT_APPROVER_REQUIRED'});
    assert.equal(f.state.executes, sent, 'nothing was sent without another person’s approval');
    // The path that does work: another person approves the plan as it is, and its step is then sent through it.
    await f.runner.handle(approval, approverActor);
    const done = await f.call(ownRun);
    assert.equal(done.state, 'in_progress');
    assert.equal(f.state.executes, sent + 1, 'the campaign was activated once');
    assert.deepEqual(f.state.prepares.at(-1).payload, [{op: 'replace', path: '/status', value: 'ACTIVE'}]);
  } finally {
    f.store.close();
  }
});

test('recover_step on an activation plan amends it in place: the gate is read again and the second approver is still required', async () => {
  const f = snapchatFixture();
  try {
    const {id} = await completedLaunch(f);
    savePlanPolicy(f.store, policyOwner, {require_distinct_approver: true, confirmed: true});
    const activation = await f.call({action: 'activation_plan', id});
    f.state.review = 'PENDING_REVIEW';
    assert.equal((await f.call({action: 'preflight', id: activation.id})).blocked, true);
    // The step the gate blocked is amended (its ad is another one): the plan is a draft again, still the activation plan, and its preflight is gone.
    const amended = await f.call({
      action: 'recover_step',
      id: activation.id,
      step_id: 'activate_ad',
      confirmed: true,
      patch: [{path: '/path_params/ad_id', value: uuid(9)}],
    });
    assert.equal(amended.state, 'draft');
    const plan = f.store.document(f.actor.tenantId, 'campaign_run', activation.id);
    assert.equal(plan.activation_of.id, id);
    assert.equal(plan.preflight, undefined);
    const prepares = f.state.prepares.length,
      reads = f.state.reads.length;
    // The next call reads the gate again, for the amended ad, and is blocked while that creative is in review: nothing is prepared.
    assert.equal((await f.call({action: 'prepare_next', id: activation.id})).blocked, true);
    assert.equal(f.state.reads.length, reads + 1, 'the gate read the amended ad');
    assert.deepEqual(f.state.reads.at(-1).path_params, {ad_id: uuid(9)});
    assert.equal(f.state.prepares.length, prepares);
    // Approved, it is ready, and its owner still cannot approve it alone.
    f.state.review = 'APPROVED';
    assert.equal((await f.call({action: 'preflight', id: activation.id})).blocked, false);
    const preview = await f.call({action: 'approve', id: activation.id});
    assert.equal(preview.approver_required, true);
    await assert.rejects(
      () =>
        f.call({
          action: 'approve',
          id: activation.id,
          plan_hash: preview.plan_hash,
          summary_hash: preview.summary_hash,
          confirmed: true,
        }),
      {code: 'DISTINCT_APPROVER_REQUIRED'},
    );
  } finally {
    f.store.close();
  }
});

// CMP-03: launch completion. A completed recipe plan offers a separate, linked activation plan built from its verified
// IDs (Meta and Google: the campaign; Snapchat: campaign, then ad squad, then ad; Microsoft: four steps), with its own
// approval and read-only gates at preflight. Microsoft activation is refused without a positive location criterion,
// which AMCP cannot read yet (owner decision P7), and the Microsoft Search pack is labelled draft only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {CampaignRunner} from '../dist/src/campaign-runner.js';
import {campaignRecipe, campaignRecipes} from '../dist/src/campaign-recipes.js';
import {activationSteps} from '../dist/src/campaign-activation.js';
import {compileMicrosoft, assertMicrosoftWrite} from '../dist/src/microsoft-native.js';
import {campaignPreflight} from '../dist/src/campaign-preflight.js';
import {MirrorService} from '../dist/src/service.js';
import {Registry} from '../dist/src/catalog.js';
import {NativeTransport} from '../dist/src/transport.js';
import {MirrorError, errorRemedy} from '../dist/src/errors.js';

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
};
const expected = {
  meta: ['activate_campaign'],
  google: ['activate_campaign'],
  snapchat: ['activate_campaign', 'activate_squad', 'activate_ad'],
  microsoft: ['activate_campaign', 'activate_adgroup', 'activate_keywords', 'activate_ad'],
};
function business(recipe) {
  return {
    ...examples.recipe_business,
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
    const plan = campaignRecipe(recipe.id, business(recipe)),
      results = verifiedResults[recipe.platform](),
      ids = plan.steps.map(s => s.id);
    // The fixture results are keyed by the steps the recipe really compiles.
    for (const id of results.keys()) assert.ok(ids.includes(id), recipe.id + ' compiles step ' + id);
    const steps = activationSteps(recipe.platform, results, scope);
    assert.deepEqual(
      steps.map(s => s.id),
      expected[recipe.platform],
      recipe.id,
    );
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
  ])
    assert.throws(() => activationSteps(platform, results, scope), {code: 'ACTIVATION_UNAVAILABLE'});
});

test('Microsoft campaign activation is refused without a readable positive location criterion (owner decision P7)', () => {
  const compile = payload => compileMicrosoft({action: 'UpdateCampaigns', account_id: '123', payload});
  const refused = compile({Campaigns: [{Id: '501', Status: 'Active'}]});
  assert.throws(
    () => assertMicrosoftWrite(refused),
    e => {
      assert.equal(e.code, 'LOCATION_CRITERIA_REQUIRED');
      assert.deepEqual(e.details.campaign_ids, ['501']);
      assert.match(errorRemedy(e).action, /Microsoft Advertising/);
      return true;
    },
  );
  // Pausing, budgets and the children's status stay available.
  assertMicrosoftWrite(compile({Campaigns: [{Id: '501', Status: 'Paused'}]}));
  assertMicrosoftWrite(compile({Campaigns: [{Id: '501', DailyBudget: 30}]}));
  assertMicrosoftWrite(
    compileMicrosoft({
      action: 'UpdateAdGroups',
      account_id: '123',
      payload: {CampaignId: '501', AdGroups: [{Id: '502', Status: 'Active'}]},
    }),
  );
  // The Microsoft pack says it is draft only.
  const pack = campaignRecipes.find(r => r.id === 'microsoft_search');
  assert.equal(pack.availability, 'draft_only');
  assert.equal(pack.availability_label, 'Draft only: set locations in Microsoft before activation');
  assert.equal(campaignRecipe('microsoft_search', examples.recipe_business).recipe.availability, 'draft_only');
});

test('amcp_write refuses a Microsoft campaign activation before any provider request', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 31).toString('base64')),
    actor = {tenantId: 'ms-activation', userId: 'owner', role: 'admin'};
  let requests = 0;
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
      new NativeTransport(async () => {
        requests++;
        throw Error('Unexpected provider call');
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
    assert.equal(requests, 0);
  } finally {
    store.close();
  }
});

test('a Microsoft activation plan is blocked at preflight by the location rule, with a remedy and no amendment', async () => {
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
    const preflight = await campaignPreflight(service, actor, steps);
    assert.equal(preflight.status, 'blocked');
    const campaign = preflight.checks.find(c => c.step === 'activate_campaign');
    assert.equal(campaign.error.code, 'LOCATION_CRITERIA_REQUIRED');
    assert.deepEqual(
      preflight.checks.filter(c => c.step !== 'activate_campaign').map(c => c.status),
      ['contract_checked', 'contract_checked', 'contract_checked'],
    );
    assert.equal(preflight.provider_mutations, 0);
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
  return {actor, store, state, call};
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
      if (input.action === 'meta_ad_get')
        return {success: true, data: {data: {id: '704', effective_status: 'CAMPAIGN_PAUSED'}}};
      assert.equal(input.action, 'meta_pixel_id_get');
      assert.deepEqual(input.path_params, {pixel_id: '456'});
      return {success: true, data: {data: pixel}};
    },
    async () => ({status: 'verified'}),
    async () => ({}),
    async () => ({status: 'ready', checks: []}),
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
    assert.deepEqual(reads, ['meta_ad_get', 'meta_pixel_id_get', 'meta_ad_get', 'meta_pixel_id_get']);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {MirrorError} from '../dist/src/errors.js';
import {providerHooks, registeredProviderHooks} from '../dist/src/provider-hooks.js';
import {isProviderModule, providerRegistries} from '../tools/architecture-map.mjs';
import {assertCloneGateway, clonePlan} from '../dist/src/campaign-clone.js';
import {snapchatClone} from '../dist/src/snapchat-campaign-clone.js';
import {googleClone} from '../dist/src/google-campaign-clone.js';
import {tiktokClone} from '../dist/src/tiktok-campaign-clone.js';
import {linkedinClone} from '../dist/src/linkedin-campaign-clone.js';
import {composeGoogleBuild} from '../dist/src/google-atomic-builds.js';
import {activationGates, activationPlatforms, activationSteps} from '../dist/src/campaign-activation.js';
import {metaActivationGates, metaActivationRecord, metaActivationSteps} from '../dist/src/meta-recipe-activation.js';
import {
  googleActivationGates,
  googleActivationRecord,
  googleActivationSteps,
} from '../dist/src/google-recipe-activation.js';
import {snapchatActivationGates, snapchatActivationSteps} from '../dist/src/snapchat-recipe-activation.js';
import {microsoftActivationGates, microsoftActivationSteps} from '../dist/src/microsoft-recipe-activation.js';
import {tiktokActivationSteps} from '../dist/src/tiktok-recipe-activation.js';
import {
  linkedinActivationGates,
  linkedinActivationRecord,
  linkedinActivationSteps,
} from '../dist/src/linkedin-recipe-activation.js';

// ARC-01 phase B (wave 4c), the campaign modules: src/campaign-clone.ts named Snapchat, Google Ads, TikTok and LinkedIn
// where it read and rebuilt each one's campaign, and src/campaign-runner.ts named Google Ads where a clone becomes one
// all-or-nothing build. Each provider's part is now its adapter's `campaign` hooks; the stages keep every check and
// its order, and ask the provider where they named it. The call-replay proof of each move is in
// docs/review/ARCHITECTURE.md (section 9).

const gatewayLiterals = source => [...source.matchAll(/['"]([a-z0-9_]+_native_action)['"]/g)].map(m => m[1]);
const providerImports = source =>
  [...source.matchAll(/from '\.\/([^']+)\.js'/g)]
    .map(m => 'src/' + m[1] + '.ts')
    .filter(f => isProviderModule(f) && !providerRegistries.includes(f));
const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const refusal = async (run, code) => {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof MirrorError)) throw error;
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail('expected ' + code + ', but the check accepted the request');
};

test('the campaign clone names no provider and imports no provider module', () => {
  const source = read('src/campaign-clone.ts');
  assert.deepEqual(gatewayLiterals(source), []);
  assert.deepEqual(providerImports(source), []);
  // The runner asks the provider for a clone's all-or-nothing build instead of naming Google Ads.
  assert.doesNotMatch(read('src/campaign-runner.ts'), /composeGoogleBuild|google-atomic-builds/);
});

test('exactly Snapchat, Google Ads, TikTok and LinkedIn declare a clone, each its own module function', () => {
  const declared = Object.fromEntries(
    registeredProviderHooks.filter(h => h.campaign?.clone).map(h => [h.gateway, h.campaign.clone]),
  );
  assert.deepEqual(Object.keys(declared).sort(), [
    'google_ads_native_action',
    'linkedin_native_action',
    'snapchat_native_action',
    'tiktok_native_action',
  ]);
  assert.equal(declared.snapchat_native_action.build, snapchatClone);
  assert.equal(declared.google_ads_native_action.build, googleClone);
  assert.equal(declared.tiktok_native_action.build, tiktokClone);
  assert.equal(declared.linkedin_native_action.build, linkedinClone);
  for (const clone of Object.values(declared)) assert.ok(Object.isFrozen(clone));
  // Only Google's clone is one all-or-nothing build, of the customer without its display dashes.
  assert.deepEqual(
    Object.entries(declared)
      .filter(([, clone]) => clone.allOrNothing)
      .map(([gateway]) => gateway),
    ['google_ads_native_action'],
  );
  const steps = [
    {
      id: 'budget',
      kind: 'write',
      gateway: 'google_ads_native_action',
      arguments: {
        action: 'google_ads_v23_campaign_budget_mutate_campaign_budgets',
        payload: {operations: [{create: {name: 'B', amount_micros: '1000000'}}]},
      },
      depends_on: [],
    },
  ];
  assert.deepEqual(
    declared.google_ads_native_action.allOrNothing(structuredClone(steps), '123-456-7890'),
    composeGoogleBuild(structuredClone(steps), '1234567890'),
  );
});

test('a gateway without a clone is refused before any read, naming the clone gateways in their order', async () => {
  const supported = [
    'snapchat_native_action',
    'google_ads_native_action',
    'tiktok_native_action',
    'linkedin_native_action',
  ];
  for (const gateway of ['meta_native_action', 'x_ads_native_action', 'amcp_campaign', '__proto__', undefined]) {
    const error = await refusal(() => assertCloneGateway(gateway), 'CLONE_UNSUPPORTED');
    assert.deepEqual(error.details, {field: 'gateway', supported});
    let reads = 0;
    const call = async () => {
      reads++;
      return {success: true, data: {data: {}}};
    };
    await refusal(
      () => clonePlan(call, {tenantId: 't', userId: 'u'}, {gateway, source: {campaign_id: '1'}, name: 'Copy'}),
      'CLONE_UNSUPPORTED',
    );
    assert.equal(reads, 0, String(gateway));
  }
  // The source and name checks come first, for every gateway.
  await refusal(
    () => clonePlan(async () => assert.fail('no read'), {}, {gateway: 'snapchat_native_action', name: 'Copy'}),
    'INVALID_ARGUMENT',
  );
  assert.equal(providerHooks('meta_native_action')?.campaign?.clone, undefined);
});

test('a clone reads its source through the provider and groups what it did not copy', async () => {
  const calls = [];
  const call = async (gateway, input) => {
    calls.push([gateway, input.action]);
    if (input.action === 'snapchat_campaign_list')
      return {
        success: true,
        data: {data: {campaigns: [{campaign: {id: 'c1', name: 'Old', status: 'ACTIVE', extra: 1}}]}},
      };
    return {success: true, data: {data: {adsquads: [], ads: []}}};
  };
  const out = await clonePlan(
    call,
    {tenantId: 't', userId: 'u'},
    {gateway: 'snapchat_native_action', connection_id: 'k', account_id: 'a', source: {campaign_id: 'c1'}, name: 'N'},
  );
  assert.deepEqual(calls, [
    ['snapchat_native_action', 'snapchat_campaign_list'],
    ['snapchat_native_action', 'snapchat_adsquad_list'],
    ['snapchat_native_action', 'snapchat_ad_list'],
  ]);
  assert.deepEqual(
    out.steps.map(s => [s.id, s.gateway, s.arguments.action]),
    [['campaign', 'snapchat_native_action', 'snapchat_campaign_create']],
  );
  assert.deepEqual(out.notCopied, [{fields: ['extra'], steps: ['campaign']}]);
  assert.deepEqual(out.source, {campaign_id: 'c1', ad_squads: 0, ads: 0});
});

test('the guided activation names no provider and imports no provider module; the runner names no platform', () => {
  const source = read('src/campaign-activation.ts');
  assert.deepEqual(gatewayLiterals(source), []);
  assert.deepEqual(providerImports(source), []);
  assert.doesNotMatch(read('src/campaign-runner.ts'), /platform === '|meta_ad_id|linkedin_lead_form_id|meta_pixel_id/);
});

test('every activation platform declares its provider activation: steps, the record its gates read, its gates', () => {
  const declared = Object.fromEntries(
    registeredProviderHooks.filter(h => h.campaign?.activation).map(h => [h.gateway, h.campaign.activation]),
  );
  assert.deepEqual(Object.keys(declared).sort(), [
    'google_ads_native_action',
    'linkedin_native_action',
    'meta_native_action',
    'microsoft_ads_native_action',
    'snapchat_native_action',
    'tiktok_native_action',
  ]);
  assert.deepEqual(activationPlatforms, ['meta', 'google', 'snapchat', 'microsoft', 'tiktok', 'linkedin']);
  assert.deepEqual(declared.meta_native_action, {
    steps: metaActivationSteps,
    record: metaActivationRecord,
    gates: metaActivationGates,
  });
  assert.deepEqual(declared.google_ads_native_action, {
    steps: googleActivationSteps,
    record: googleActivationRecord,
    gates: googleActivationGates,
  });
  assert.deepEqual(declared.snapchat_native_action, {steps: snapchatActivationSteps, gates: snapchatActivationGates});
  assert.deepEqual(declared.microsoft_ads_native_action, {
    steps: microsoftActivationSteps,
    gates: microsoftActivationGates,
  });
  assert.deepEqual(declared.tiktok_native_action, {steps: tiktokActivationSteps});
  assert.deepEqual(declared.linkedin_native_action, {
    steps: linkedinActivationSteps,
    record: linkedinActivationRecord,
    gates: linkedinActivationGates,
  });
  for (const activation of Object.values(declared)) assert.ok(Object.isFrozen(activation));
});

test('activation steps carry the platform gateway, and a platform without an activation is refused', async () => {
  const scope = {connection_id: 'k', account_id: '123'};
  const tiktok = activationSteps('tiktok', new Map([['campaign', {data: {data: {campaign_id: '77'}}}]]), scope);
  assert.deepEqual(
    tiktok.map(s => [s.id, s.gateway, s.connection_id, s.account_id, s.arguments.action]),
    [['activate_campaign', 'tiktok_native_action', 'k', '123', 'tiktok_campaign_status_update']],
  );
  const meta = activationSteps('meta', new Map([['campaign', {data: {id: '42'}}]]), scope);
  assert.deepEqual(meta[0].gateway, 'meta_native_action');
  assert.deepEqual(meta[0].arguments, {
    action: 'meta_campaign_update',
    path_params: {campaign_id: '42'},
    payload: {status: 'ACTIVE'},
  });
  // A gap in the verified results is refused by the provider's steps, naming what is missing.
  const gap = await refusal(() => activationSteps('meta', new Map(), scope), 'ACTIVATION_UNAVAILABLE');
  assert.deepEqual(gap.details, {missing: 'Meta campaign'});
  // A platform without a guided activation, an inherited name included, is refused before any step is built.
  for (const platform of ['x', 'reddit', 'constructor', '__proto__', 'toString'])
    await refusal(() => activationSteps(platform, new Map(), scope), 'ACTIVATION_UNAVAILABLE');
});

test('the activation record keeps what the provider gates read, and a gate reads only its own platform', async () => {
  const run = {recipe: {pixel_id: 'px', lead_form_id: 'lf', currency: 'USD'}};
  const results = new Map([['ad', {data: {id: 'ad1'}}]]);
  assert.deepEqual(metaActivationRecord(run, results), {meta_ad_id: 'ad1', meta_pixel_id: 'px'});
  assert.deepEqual(linkedinActivationRecord(run, results), {linkedin_lead_form_id: 'lf'});
  assert.deepEqual(
    googleActivationRecord(run, results, [
      'account_default_conversion_goals',
      'conversion_value_configuration',
      'reported_conversion_activity',
    ]),
    {conversion_goals: {currency: 'USD', include_value_settings: true, include_activity: true}},
  );
  assert.deepEqual(googleActivationRecord(run, results, []), {});
  const calls = [];
  const call = async (gateway, input) => {
    calls.push([gateway, input.action]);
    return {success: false, error: {code: 'UPSTREAM_ERROR'}};
  };
  const steps = [{id: 'activate_campaign', account_id: '123', connection_id: 'k', arguments: {}}];
  // TikTok has no gate, and a platform without an activation reads nothing.
  for (const platform of ['tiktok', 'x', 'constructor'])
    assert.deepEqual(await activationGates(call, {}, {platform, meta_ad_id: '1'}, steps), []);
  assert.deepEqual(calls, []);
  // Meta's gates read the ad and then the pixel, through the plan's account and login; a failed read blocks.
  const checks = await activationGates(call, {}, {platform: 'meta', meta_ad_id: 'ad1', meta_pixel_id: 'px'}, steps);
  assert.deepEqual(calls, [
    ['meta_native_action', 'meta_ad_get'],
    ['meta_native_action', 'meta_pixel_id_get'],
  ]);
  assert.deepEqual(
    checks.map(c => [c.gate, c.status, c.error.code]),
    [
      ['meta_ad_review', 'blocked', 'ACTIVATION_GATE_BLOCKED'],
      ['meta_pixel', 'blocked', 'ACTIVATION_GATE_BLOCKED'],
    ],
  );
});

test('the plan preflight names no provider and imports no provider module', () => {
  const source = read('src/campaign-preflight.ts');
  assert.deepEqual(gatewayLiterals(source), []);
  assert.deepEqual(providerImports(source), []);
  // Snapchat's ad prerequisites take the preflight's state check instead of importing a lifecycle module.
  assert.doesNotMatch(read('src/snapchat-ad-prerequisites.ts'), /from '\.\/write-state\.js'/);
});

test('each provider declares the preflight parts the stage named it for, frozen', () => {
  const declared = Object.fromEntries(
    registeredProviderHooks
      .filter(h => h.campaign?.preflight)
      .map(h => [h.gateway, Object.keys(h.campaign.preflight).sort()]),
  );
  assert.deepEqual(declared, {
    google_ads_native_action: ['reference'],
    meta_native_action: ['contract', 'prerequisites'],
    tiktok_native_action: ['prerequisites'],
    snapchat_native_action: ['contract', 'prerequisites', 'reference'],
    linkedin_native_action: ['prerequisites'],
    x_ads_native_action: ['reference'],
  });
  for (const hooks of registeredProviderHooks)
    if (hooks.campaign?.preflight) assert.ok(Object.isFrozen(hooks.campaign.preflight), hooks.gateway);
});

test("a predecessor's placeholder is its provider's: X by field, Snapchat's symbolic ID, Google's resource name", () => {
  const reference = (gateway, context) => providerHooks(gateway)?.campaign?.preflight?.reference?.(context);
  const none = () => assert.fail('no compile');
  assert.equal(reference('x_ads_native_action', {path: '/payload/media_key', compile: none}), '13_1');
  assert.equal(reference('x_ads_native_action', {path: '/payload/card_uri', compile: none}), 'card://1');
  assert.equal(reference('x_ads_native_action', {path: '/payload/line_item_id', compile: none}), undefined);
  assert.equal(
    reference('snapchat_native_action', {path: '/payload/x', compile: none}),
    '00000000-0000-4000-8000-000000000001',
  );
  assert.equal(reference('meta_native_action', {path: '/payload/x', compile: none}), undefined);
  // Google: the predecessor's compiled mutation names the resource; a media predecessor is an account asset.
  assert.equal(
    reference('google_ads_native_action', {
      path: '/payload/x',
      ref: 'm#/data/results/0/resourceName',
      parent: {kind: 'media', account_id: '123-456-7890', arguments: {platform: 'google_ads'}},
      compile: none,
    }),
    'customers/1234567890/assets/1',
  );
  const compiled = [];
  assert.equal(
    reference('google_ads_native_action', {
      path: '/payload/x',
      ref: 'c#/data/results/0/resourceName',
      parent: {gateway: 'google_ads_native_action', account_id: '123', arguments: {action: 'a'}},
      compile: (gateway, args) => {
        compiled.push([gateway, args]);
        return {path: '/v23/customers/123/campaigns:mutate', body: {operations: [{create: {name: 'C'}}]}};
      },
    }),
    'customers/123/campaigns/1',
  );
  assert.deepEqual(compiled, [['google_ads_native_action', {action: 'a', account_id: '123'}]]);
});

test('the recipe context names no provider and imports no provider module; each recipe declares its own', async () => {
  for (const file of ['src/recipe-context.ts', 'src/campaign-recipes.ts']) {
    const source = read(file);
    assert.deepEqual(gatewayLiterals(source), [], file);
    assert.deepEqual(providerImports(source), [], file);
  }
  const {campaignRecipes, campaignRecipeOf, recipeGateway} = await import('../dist/src/campaign-recipes.js');
  const {recipeContext} = await import('../dist/src/recipe-context.js');
  const {microsoftLocationLookupStatus} = await import('../dist/src/microsoft-locations.js');
  const pin = await import('../dist/src/microsoft-location-pin.js');
  // The lookup status keeps its import path.
  assert.equal(microsoftLocationLookupStatus, pin.microsoftLocationLookupStatus);
  // A recipe's gateway is its platform's provider's: the table recipe_context kept.
  const platformGateways = {
    google: 'google_ads_native_action',
    meta: 'meta_native_action',
    microsoft: 'microsoft_ads_native_action',
    snapchat: 'snapchat_native_action',
    tiktok: 'tiktok_native_action',
    linkedin: 'linkedin_native_action',
  };
  for (const recipe of campaignRecipes)
    assert.equal(recipeGateway(recipe.id), platformGateways[recipe.platform], recipe.id);
  assert.equal(recipeGateway('no_such_recipe'), undefined);
  // What each recipe declares beyond its definition: its own prerequisite, and only Microsoft's provider facts.
  const own = Object.fromEntries(
    campaignRecipes.map(r => [
      r.id,
      campaignRecipeOf(r.id).context?.prerequisite ?? 'required Page/media or search inputs',
    ]),
  );
  assert.deepEqual(
    Object.entries(own)
      .filter(([, p]) => p !== 'required Page/media or search inputs')
      .map(([id]) => id),
    [
      'google_performance_max',
      'snapchat_website_traffic',
      'snapchat_lead_generation',
      'tiktok_website_traffic',
      'tiktok_website_conversions',
      // R2.5 M4 (r25-m4-smartweb): the two Upgraded Smart+ packs, each with its own prerequisite (a post, an identity and a dynamic CTA portfolio).
      'tiktok_smart_plus_website_traffic',
      'tiktok_smart_plus_website_conversions',
      // R2.5 M4 (r25-m4-search2): the Upgraded Smart+ Search pack, with its own prerequisite (the Search allowlist, a post, an identity, a CTA portfolio and keywords).
      'tiktok_smart_plus_search_website',
      'linkedin_lead_generation',
    ],
  );
  assert.deepEqual(
    campaignRecipes.filter(r => campaignRecipeOf(r.id).context?.extra).map(r => r.id),
    ['microsoft_search'],
  );
  assert.deepEqual(
    campaignRecipes.filter(r => !campaignRecipeOf(r.id).context?.limitations?.length).map(r => r.id),
    ['meta_website_traffic', 'google_search', 'google_search_clicks'],
  );
  // The context reads the recipe's facts: a Meta conversion recipe names its pixel event; Microsoft's adds its lookup.
  const store = {
    assertActorActive() {},
    documents: () => [],
    connectionsFor: () => [
      {id: 'd', gateway: 'google_drive_native_action', label: 'Drive', enabled: true, accounts: ['f']},
    ],
  };
  const actor = {tenantId: 't', userId: 'u', role: 'admin'};
  const sales = recipeContext(store, actor, 'meta_website_sales');
  assert.match(sales.limitations[0], /^Uses the selected website pixel with PURCHASE\. /);
  assert.deepEqual(sales.drive_connections, [{id: 'd', label: 'Drive', files: ['f']}]);
  assert.equal(Object.hasOwn(sales, 'location_lookup'), false);
  const microsoft = recipeContext(store, actor, 'microsoft_search');
  assert.deepEqual(microsoft.location_lookup, microsoftLocationLookupStatus());
  assert.deepEqual(Object.keys(microsoft).slice(-4), [
    'drive_connections',
    'location_lookup',
    'limitations',
    'prerequisites',
  ]);
  assert.deepEqual(microsoft.prerequisites, [
    'current account grant',
    'verified account currency',
    'required Page/media or search inputs',
    'whole-plan preflight',
    'review each resolved mutation',
    'provider read-back',
  ]);
  // The limitations are the response's own copy, never the declared list.
  assert.equal(Object.isFrozen(microsoft.limitations), false);
});

test('the runner asks the provider for a refused build and its recipe lookups, naming no gateway but an example', async () => {
  // ARC-01 phase B (wave 4c): src/campaign-runner.ts named Google Ads where a refused build created nothing and where
  // recipe_lookup read Google's country and language constants, and imported Microsoft's unpinned-lookup refusal.
  // They are the adapters' `campaign` hooks; the runner keeps its checks and their order. The one literal left is the
  // example in a malformed step's refusal ("a write step needs gateway, e.g. ..."), whose text does not change.
  const source = read('src/campaign-runner.ts');
  assert.deepEqual(gatewayLiterals(source), ['snapchat_native_action']);
  assert.match(source, /'a write step needs gateway, e\.g\. "snapchat_native_action"'/);
  // Its plan bindings are the providers' too (the test below), so it imports no provider module.
  assert.deepEqual(providerImports(source), []);
  const {googleRecipeLookup} = await import('../dist/src/google-search-recipes.js');
  const {microsoftLocationsUnpinned} = await import('../dist/src/microsoft-locations.js');
  const {CampaignRunner} = await import('../dist/src/campaign-runner.js');
  // Only Google declares a refused build; Google and Microsoft the lookups, frozen.
  assert.deepEqual(
    registeredProviderHooks.filter(h => h.campaign?.refusedBuild).map(h => h.gateway),
    ['google_ads_native_action'],
  );
  const lookups = Object.fromEntries(
    registeredProviderHooks.flatMap(h =>
      Object.entries(h.campaign?.lookups ?? {}).map(([k, v]) => [k, [h.gateway, v]]),
    ),
  );
  assert.deepEqual(Object.keys(lookups).sort(), ['country', 'language', 'microsoft_location']);
  assert.equal(lookups.country[1].search, googleRecipeLookup);
  assert.equal(lookups.language[1].search, googleRecipeLookup);
  assert.equal(lookups.microsoft_location[0], 'microsoft_ads_native_action');
  assert.equal(lookups.microsoft_location[1].unavailable, microsoftLocationsUnpinned);
  for (const [, lookup] of Object.values(lookups)) assert.ok(Object.isFrozen(lookup));
  // Google's refused build: a googleAds:mutate build without partial failure, refused with a definitive 4xx.
  const refused = providerHooks('google_ads_native_action').campaign.refusedBuild,
    step = (status, payload = {}, action = 'google_ads_v23_google_ads_mutate') => ({
      kind: 'write',
      status: 'failed',
      gateway: 'google_ads_native_action',
      arguments: {action, payload},
      error: {details: {http_status: status}},
    });
  for (const status of [400, 401, 403, 404, 409, 412, 422]) assert.equal(refused(step(status)), true, String(status));
  for (const status of [408, 429, 500, 503, undefined]) assert.equal(refused(step(status)), false, String(status));
  assert.equal(refused(step(400, {partial_failure: true})), false);
  assert.equal(refused(step(400, {partialFailure: true})), false);
  assert.equal(refused(step(400, {}, 'google_ads_v23_campaign_mutate_campaigns')), false);
  // Through the runner: a lookup's query is checked before its kind, a searched lookup only with a valid query, and
  // the Microsoft lookup without the service's own lookup is Microsoft's refusal, before any query check.
  const store = {assertActorActive() {}, resolveConnection: () => assert.fail('no connection is resolved')},
    runner = new CampaignRunner(
      store,
      async () => assert.fail('nothing is called'),
      async () => ({}),
      async () => ({}),
    );
  const actor = {tenantId: 't', userId: 'u', role: 'admin'},
    lookup = input => runner.handle({action: 'recipe_lookup', ...input}, actor);
  for (const input of [
    {lookup_kind: 'country', query: 'x'},
    {lookup_kind: 'language', query: 'French1'},
    {lookup_kind: 'city', query: 'Paris'},
    {lookup_kind: 'constructor', query: 'Paris'},
    {query: 'Paris'},
  ])
    await refusal(() => lookup(input), 'INVALID_LOOKUP');
  await refusal(() => lookup({lookup_kind: 'microsoft_location', query: 'x'}), 'MICROSOFT_LOCATIONS_UNPINNED');
});

test("a recipe's dependency evidence is its provider's, and the pixel is the recipe provider's own", async () => {
  // ARC-01 phase B (wave 4c): src/recipe-eligibility.ts named TikTok to tell its pixel from Meta's and held each
  // provider's dependency evidence in one chain. Each recipe provider declares it (`campaign.dependencyEvidence`); the
  // eligibility keeps the account currency, the Google conversion settings and every other rule, in their order.
  const source = read('src/recipe-eligibility.ts');
  assert.deepEqual(gatewayLiterals(source), []);
  assert.deepEqual(providerImports(source), []);
  const {snapchatDependencyEvidence} = await import('../dist/src/snapchat-traffic-recipe.js');
  const {tiktokDependencyEvidence} = await import('../dist/src/tiktok-launch-recipes.js');
  const {linkedinDependencyEvidence} = await import('../dist/src/linkedin-lead-recipe.js');
  const {metaDependencyEvidence} = await import('../dist/src/meta-website-recipes.js');
  const {recipeDependencies} = await import('../dist/src/capability-eligibility.js');
  const {campaignRecipes, recipeGateway} = await import('../dist/src/campaign-recipes.js');
  const evidence = gateway => providerHooks(gateway)?.campaign?.dependencyEvidence;
  assert.deepEqual(
    registeredProviderHooks.filter(h => h.campaign?.dependencyEvidence).map(h => h.gateway),
    [
      'google_ads_native_action',
      'meta_native_action',
      'tiktok_native_action',
      'snapchat_native_action',
      'linkedin_native_action',
    ],
  );
  assert.equal(evidence('snapchat_native_action'), snapchatDependencyEvidence);
  // R2.5 M4 (r25-m4-smartweb): TikTok's evidence asks the classic packs' function first and the Smart+ packs' for the dependency they add
  // (the dynamic CTA portfolio), so the adapter's own composition is no longer the classic function itself (checked below).
  assert.notEqual(evidence('tiktok_native_action'), tiktokDependencyEvidence);
  assert.equal(evidence('linkedin_native_action'), linkedinDependencyEvidence);
  assert.equal(evidence('meta_native_action'), metaDependencyEvidence);
  // Each recipe's provider is the one whose recipes declare its dependencies: no other provider answers them.
  const empty = {assets: [], scope: {}, business: {}, recipe: {}, steps: []};
  for (const {id} of campaignRecipes)
    for (const dependency of recipeDependencies[id]?.objects ?? [])
      for (const hooks of registeredProviderHooks)
        if (hooks.gateway !== recipeGateway(id) && hooks.campaign?.dependencyEvidence)
          assert.equal(
            hooks.campaign.dependencyEvidence(dependency, empty),
            undefined,
            id + ' ' + dependency + ' ' + hooks.gateway,
          );
  const scope = {gateway: 'x', connection_id: 'c', account_id: '1'},
    asset = (asset_type, extra = {}) => ({
      asset_type,
      account_id: '1',
      connection_id: 'c',
      status: 'provider_read_checked',
      meaning: 'Read.',
      ...extra,
    }),
    context = (assets, extra = {}) => ({assets, scope, business: {}, recipe: {}, steps: [], ...extra});
  // The account-owned pixel is TikTok's for a TikTok recipe and Meta's for a Meta recipe, as the chain told them apart.
  const tiktokPixel = asset('TikTok pixel'),
    metaPixel = asset('Meta pixel');
  assert.deepEqual(tiktokDependencyEvidence('account_owned_pixel', context([metaPixel, tiktokPixel])), {
    status: 'ready',
    evidence: tiktokPixel,
    meaning: 'Read.',
  });
  assert.equal(tiktokDependencyEvidence('account_owned_pixel', context([metaPixel])), undefined);
  assert.deepEqual(metaDependencyEvidence('account_owned_pixel', context([tiktokPixel, metaPixel])), {
    status: 'ready',
    evidence: metaPixel,
    meaning: 'The account-scoped native collection confirmed access to this exact resource.',
  });
  // TikTok's proof is this exact advertiser's and login's, read and checked.
  for (const other of [{account_id: '2'}, {connection_id: 'd'}, {status: 'unknown'}])
    assert.equal(
      tiktokDependencyEvidence('tiktok_spark_identity', context([asset('TikTok identity', other)])),
      undefined,
    );
  // The adapter answers every classic dependency as the classic function does, and the Smart+ packs' one more (the CTA portfolio) as
  // theirs does, from the same kind of proof: this advertiser's and login's, read and checked.
  const {tiktokSmartPlusDependencyEvidence} = await import('../dist/src/tiktok-smart-plus-recipe.js');
  const tiktokEvidence = evidence('tiktok_native_action'),
    portfolio = asset('TikTok CTA portfolio', {asset_id: '700'});
  for (const id of ['tiktok_spark_identity', 'existing_tiktok_post', 'account_owned_pixel'])
    assert.deepEqual(
      tiktokEvidence(id, context([tiktokPixel, asset('TikTok identity'), asset('TikTok post')])),
      tiktokDependencyEvidence(id, context([tiktokPixel, asset('TikTok identity'), asset('TikTok post')])),
      id,
    );
  assert.deepEqual(tiktokEvidence('dynamic_cta_portfolio', context([portfolio])), {
    status: 'ready',
    evidence: portfolio,
    meaning: 'Read.',
  });
  assert.equal(tiktokEvidence('dynamic_cta_portfolio', context([tiktokPixel])), undefined);
  assert.equal(tiktokDependencyEvidence('dynamic_cta_portfolio', context([portfolio])), undefined);
  assert.equal(tiktokSmartPlusDependencyEvidence('account_owned_pixel', context([tiktokPixel])), undefined);
  for (const other of [{account_id: '2'}, {connection_id: 'd'}, {status: 'unknown'}])
    assert.equal(tiktokEvidence('dynamic_cta_portfolio', context([asset('TikTok CTA portfolio', other)])), undefined);
  // Snapchat's lead form is the reused creative's own form; LinkedIn's is the brief's form.
  const creative = asset('Snapchat creative', {asset_id: 'cr', lead_generation_form_id: 'lf'}),
    form = asset('Snapchat lead form', {asset_id: 'lf'});
  assert.equal(
    snapchatDependencyEvidence('existing_lead_form', context([creative, form], {business: {creative_id: 'cr'}}))
      ?.evidence,
    form,
  );
  assert.equal(
    snapchatDependencyEvidence('existing_lead_form', context([creative, form], {business: {creative_id: 'other'}})),
    undefined,
  );
  const leadForm = asset('LinkedIn lead form', {asset_id: 'f1'});
  assert.equal(
    linkedinDependencyEvidence('linkedin_lead_form', context([leadForm], {business: {lead_form_id: 'f1'}}))?.evidence,
    leadForm,
  );
  assert.equal(
    linkedinDependencyEvidence('linkedin_lead_form', context([leadForm], {business: {lead_form_id: 'f2'}})),
    undefined,
  );
  // Meta's attribution windows and Google's explicit settings come from the compiled brief.
  const windows = [{event_type: 'CLICK_THROUGH', window_days: 7}];
  assert.deepEqual(
    metaDependencyEvidence(
      'attribution_window',
      context([], {steps: [{id: 'adset', arguments: {payload: {attribution_spec: windows}}}]}),
    ).evidence,
    {kind: 'compiled_explicit_settings', windows},
  );
  const google = evidence('google_ads_native_action');
  assert.deepEqual(google('campaign_target_roas', context([], {recipe: {target_roas: '3.5'}})).evidence, {
    kind: 'compiled_explicit_setting',
    ratio: '3.5',
  });
  assert.deepEqual(google('pmax_asset_minimums', context([], {recipe: {asset_counts: {headlines: 3}}})).evidence, {
    kind: 'compiled_explicit_setting',
    asset_counts: {headlines: 3},
  });
  assert.equal(google('landing_page', context([])), undefined);
});

test("the plan bindings are their providers': Tag Manager's consent preview and X's selected catalog removal", async () => {
  // ARC-01 phase B (wave 4c): src/campaign-runner.ts imported Tag Manager's consent-plan and X's catalog-removal
  // modules to make and check their plan bindings. They are the providers' `campaign.planBinding`; the runner keeps
  // where each binding is made (after the allocation and search-exclusion bindings), saved and checked, in its order.
  const {assertConsentStep, consentCreationBinding} = await import('../dist/src/gtm-consent-plans.js');
  const {assertCatalogRemovalStep, catalogRemovalChanged, catalogRemovalCreationBinding} =
    await import('../dist/src/x-catalog-removal.js');
  const {withXCatalogRemovalExpectation} = await import('../dist/src/x-catalog-products.js');
  const bindings = registeredProviderHooks
    .filter(h => h.campaign?.planBinding)
    .map(h => [h.gateway, h.campaign.planBinding]);
  assert.deepEqual(
    bindings.map(([gateway, binding]) => [gateway, binding.key]),
    [
      ['x_ads_native_action', 'catalog_removal'],
      ['gtm_native_action', 'gtm_consent'],
    ],
  );
  const [[, removal], [, consent]] = bindings;
  assert.ok(Object.isFrozen(removal) && Object.isFrozen(consent));
  assert.equal(consent.create, consentCreationBinding);
  assert.equal(consent.check, assertConsentStep);
  assert.equal(removal.create, catalogRemovalCreationBinding);
  assert.equal(removal.expectation, assertCatalogRemovalStep);
  assert.equal(removal.under, withXCatalogRemovalExpectation);
  assert.equal(removal.changed, catalogRemovalChanged);
  // An input without a preview makes no binding, and a plan without one checks nothing, before any read.
  const store = {document: () => assert.fail('no preview is read')},
    actor = {tenantId: 't', userId: 'u', role: 'admin'};
  assert.equal(consent.create(store, actor, {}, []), undefined);
  assert.equal(removal.create(store, actor, {}, []), undefined);
  assert.equal(removal.create(store, actor, {catalog_binding: {kind: 'lineage'}}, []), undefined);
  assert.equal(removal.expectation({steps: [{id: 's'}]}, {id: 's'}), undefined);
  await consent.check(store, async () => assert.fail('nothing is read'), actor, {steps: [{id: 's'}]}, {id: 's'});
  // The removal's refusal is its own; its expectation holds only while its step runs under it.
  await refusal(() => removal.changed(), 'CATALOG_REMOVAL_CHANGED');
  assert.equal(await removal.under({catalog: {}, target: {}}, async () => 'ran'), 'ran');
});

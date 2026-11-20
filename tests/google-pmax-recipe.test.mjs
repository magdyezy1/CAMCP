// CMP-07 (implementer default pending P7): the guided Performance Max pack. The brief compiles to the one reviewed
// all-or-nothing build Google requires for an asset group and its minimum assets; a synthetic customer runs it to a
// verified paused launch, and its activation is the campaign's own reviewed status change. Nothing reaches Google.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {campaignRecipe, campaignRecipes} from '../dist/src/campaign-recipes.js';
import {recipeDependencies} from '../dist/src/capability-eligibility.js';
import {recipeObjective} from '../dist/src/recipe-context.js';
import {pmaxCustomer} from './fixtures/google-pmax-data.mjs';

const examples = JSON.parse(readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'));
const business = {...examples.google_pmax_business, connection_id: 'g'};

test('the Performance Max pack is discoverable as one build with explicit goal and asset dependencies', () => {
  const definition = campaignRecipes.find(r => r.id === 'google_performance_max');
  assert.equal(definition.platform, 'google');
  for (const key of ['headlines', 'long_headlines', 'descriptions', 'business_name', 'logo_asset_ids'])
    assert.ok(definition.required.includes(key), key);
  assert.deepEqual(recipeDependencies.google_performance_max.actions, ['google_ads_v23_google_ads_mutate']);
  assert.ok(recipeDependencies.google_performance_max.objects.includes('account_default_conversion_goals'));
  assert.equal(recipeObjective('google_performance_max'), 'sales');
});

test('a brief compiles to one paused build: PMax campaign, criteria, text assets, an asset group and its links', () => {
  const before = JSON.stringify(business),
    plan = campaignRecipe('google_performance_max', business);
  assert.equal(JSON.stringify(business), before, 'the brief is not mutated');
  assert.deepEqual(
    plan.steps.map(s => [s.id, s.arguments.action]),
    [['build', 'google_ads_v23_google_ads_mutate']],
  );
  const ops = plan.steps[0].arguments.payload.mutate_operations,
    of = key => ops.filter(o => o[key]).map(o => o[key].create);
  const [campaign] = of('campaign_operation');
  assert.equal(campaign.status, 'PAUSED');
  assert.equal(campaign.advertising_channel_type, 'PERFORMANCE_MAX');
  assert.equal(campaign.brand_guidelines_enabled, false);
  assert.deepEqual(campaign.maximize_conversions, {});
  assert.equal(of('campaign_budget_operation')[0].amount_micros, '50000000');
  assert.equal(of('campaign_criterion_operation').length, 2);
  assert.equal(of('asset_operation').length, 3 + 1 + 2 + 1);
  const [group] = of('asset_group_operation');
  assert.equal(group.status, 'ENABLED', 'the asset group starts enabled under the paused campaign');
  assert.deepEqual(group.final_urls, ['https://example.test/']);
  const types = of('asset_group_asset_operation').map(l => l.field_type);
  for (const [type, n] of Object.entries({
    HEADLINE: 3,
    LONG_HEADLINE: 1,
    DESCRIPTION: 2,
    BUSINESS_NAME: 1,
    MARKETING_IMAGE: 1,
    SQUARE_MARKETING_IMAGE: 1,
    LOGO: 1,
  }))
    assert.equal(types.filter(t => t === type).length, n, type);
  assert.ok(of('asset_group_asset_operation').some(l => l.asset === 'customers/123/assets/503'));
  assert.equal(plan.recipe.conversion_goal_policy, 'ACCOUNT_DEFAULT');
  assert.equal(plan.recipe.build.all_or_nothing, true);
});

test('briefs Performance Max or this pack cannot take are refused before anything is saved', () => {
  for (const [patch, code] of [
    [{headlines: ['One', 'Two']}, 'RECIPE_INPUT_REQUIRED'],
    [{headlines: ['One', 'Two', 'A headline far longer than thirty characters']}, 'AD_TEXT_LIMIT'],
    [{long_headlines: ['x'.repeat(91)]}, 'AD_TEXT_LIMIT'],
    [{descriptions: Array.from({length: 6}, (_, i) => 'Description ' + i)}, 'RECIPE_INPUT_REQUIRED'],
    // No short description: every description is longer than 60 characters (Google's SHORT_DESCRIPTION_REQUIRED).
    [{descriptions: ['x'.repeat(61), 'y'.repeat(90)]}, 'AD_TEXT_LIMIT'],
    [{business_name: 'A business name over twenty-five characters'}, 'RECIPE_INPUT_INVALID'],
    [{logo_asset_ids: []}, 'RECIPE_INPUT_REQUIRED'],
    [{marketing_image_asset_ids: ['img-1']}, 'RECIPE_INPUT_INVALID'],
    [{square_image_asset_ids: ['502', '502']}, 'RECIPE_INPUT_INVALID'],
    [{conversion_goal_policy: 'CAMPAIGN_SPECIFIC'}, 'RECIPE_INPUT_INVALID'],
    [{target_cpa: '10'}, 'RECIPE_INPUT_INVALID'],
    [{atomic: false}, 'RECIPE_INPUT_INVALID'],
    [{destination_url: 'http://example.test/'}, 'DESTINATION_REQUIRED'],
    [{contains_eu_political_advertising: 'MAYBE'}, 'RECIPE_INPUT_REQUIRED'],
  ])
    assert.throws(
      () => campaignRecipe('google_performance_max', {...business, ...patch}),
      e => e.code === code,
      JSON.stringify(patch),
    );
});

test('a Performance Max plan runs its one build to a verified paused launch, then drafts the campaign activation', async t => {
  const x = pmaxCustomer();
  t.after(() => x.store.close());
  const created = await x.call('amcp_campaign', {
    action: 'create_from_recipe',
    recipe: 'google_performance_max',
    business,
  });
  assert.equal(created.success, true, JSON.stringify(created).slice(0, 1500));
  const id = created.data.id,
    preview = await x.call('amcp_campaign', {action: 'approve', id});
  assert.equal(preview.success, true, JSON.stringify(preview).slice(0, 1500));
  const approved = await x.call('amcp_campaign', {
    action: 'approve',
    id,
    confirmed: true,
    plan_hash: preview.data.plan_hash,
    summary_hash: preview.data.summary_hash,
  });
  assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 1500));
  let result = await x.call('amcp_campaign', {action: 'run', id});
  // This plan was approved without the flag, so run stops for it once (r25-field-plan): the stop's next call approves the same plan and
  // summary again with the flag, which the synthetic operator gives, and run then covers every step the approval showed. Never a stop a step.
  let passes = 0;
  for (let n = 0; n < 3 && result.success && result.data.run?.stopped === 'needs_spend_change_confirmed'; n++) {
    passes++;
    assert.equal(result.data.next_call.arguments.action, 'approve', 'the stop offers the plan approval again');
    const executed = await x.call(result.data.next_call.tool, {
      ...result.data.next_call.arguments,
      confirmed: true,
      spend_change_confirmed: true,
    });
    assert.equal(executed.success, true, JSON.stringify(executed).slice(0, 1500));
    result = await x.call('amcp_campaign', {action: 'run', id});
  }
  assert.ok(passes <= 1, 'one re-approval covers the plan: ' + passes + ' passes');
  assert.equal(result.success, true, JSON.stringify(result).slice(0, 1500));
  const full = (await x.call('amcp_campaign', {action: 'get', id, detail: 'full'})).data;
  assert.equal(
    full.state,
    'complete',
    JSON.stringify(full.steps.map(s => ({id: s.id, status: s.status, error: s.error}))),
  );
  assert.equal(x.mutates.length, 1, 'one request created everything');
  assert.ok(
    x.queries.some(q => q.startsWith('SELECT asset.resource_name, asset.type FROM asset WHERE')),
    'the linked images and logo were read before sending',
  );
  const campaign = [...x.created.values()].find(r => r.advertising_channel_type === 'PERFORMANCE_MAX');
  assert.equal(campaign.status, 'PAUSED');
  const activation = await x.call('amcp_campaign', {action: 'activation_plan', id});
  assert.equal(activation.success, true, JSON.stringify(activation).slice(0, 1200));
  const draft = (await x.call('amcp_campaign', {action: 'get', id: activation.data.id, detail: 'full'})).data;
  assert.deepEqual(
    draft.steps.map(s => [s.id, s.arguments.payload.operations[0].update]),
    [['activate_campaign', {resource_name: campaign.resourceName, status: 'ENABLED'}]],
  );
  assert.equal(x.mutates.length, 1, 'drafting the activation sends nothing');
});

test('a Performance Max brief needs one description of at most 60 characters, and one is enough', () => {
  let refused;
  try {
    campaignRecipe('google_performance_max', {...business, descriptions: ['x'.repeat(61), 'y'.repeat(90)]});
  } catch (e) {
    refused = e;
  }
  assert.equal(refused?.code, 'AD_TEXT_LIMIT');
  assert.match(refused.message, /at least one description of at most 60 characters/);
  assert.deepEqual(refused.details, {field: 'descriptions', short_max_length: 60});
  const plan = campaignRecipe('google_performance_max', {...business, descriptions: ['x'.repeat(60), 'y'.repeat(90)]});
  assert.ok(plan.steps.length, 'a brief with one 60-character description compiles');
});

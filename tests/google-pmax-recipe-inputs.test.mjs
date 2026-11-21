// R2.5 field3, package r25-field3-recipes, AMCP-08 F8-3: the Performance Max recipe names its asset group, sets presence-only location targeting
// and adds portrait and tall portrait images. The owner's session abandoned the recipe for hand-written build steps because it could do none of
// these. Everything is synthetic (customer 123) and nothing reaches Google.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {campaignRecipe, campaignRecipes} from '../dist/src/campaign-recipes.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {existing, pmaxCustomer} from './fixtures/google-pmax-data.mjs';
import {recipeComposerFixture as fixture} from './fixtures/recipe-composer-ui.mjs';

const examples = JSON.parse(readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'));
const business = {...examples.google_pmax_business, connection_id: 'g'};
const pmax = patch => campaignRecipe('google_performance_max', {...business, ...patch});
const operations = plan => plan.steps[0].arguments.payload.mutate_operations;
const creates = (plan, key) =>
  operations(plan)
    .filter(o => o[key])
    .map(o => o[key].create);
const links = (plan, type) => creates(plan, 'asset_group_asset_operation').filter(l => l.field_type === type);
const refused = (patch, code, check = () => true) =>
  assert.throws(
    () => pmax(patch),
    e => assertRefused(e, code) && check(e),
  );
const ids = (from, n) => Array.from({length: n}, (_, i) => String(from + i));

test('the definition declares the new optional inputs, each with the values or bounds it takes', () => {
  const definition = campaignRecipes.find(r => r.id === 'google_performance_max');
  for (const key of [
    'asset_group_name',
    'positive_geo_target_type',
    'portrait_image_asset_ids',
    'tall_portrait_image_asset_ids',
  ])
    assert.ok(definition.optional.includes(key), key + ' is optional');
  assert.deepEqual(definition.inputs.asset_group_name, {type: 'text', min: 1, max: 128});
  assert.deepEqual(definition.inputs.positive_geo_target_type.values, ['PRESENCE_OR_INTEREST', 'PRESENCE']);
  assert.deepEqual(definition.inputs.portrait_image_asset_ids, {type: 'list', min: 0, max: 20});
  assert.equal(definition.inputs.tall_portrait_image_asset_ids.type, 'list');
  // SEARCH_INTEREST is not offered: v25 says it can only be used with Search and standard Shopping campaigns.
  assert.ok(!definition.inputs.positive_geo_target_type.values.includes('SEARCH_INTEREST'));
});

test('R4: asset_group_name names the asset group, a blank one is none, and 129 characters is invalid', () => {
  const group = patch => creates(pmax(patch), 'asset_group_operation')[0].name;
  assert.equal(group({}), business.name + ' · asset group', 'left out, the name it always had');
  assert.equal(group({asset_group_name: ''}), business.name + ' · asset group', 'blank is no input');
  assert.equal(group({asset_group_name: 'Winter shoes · أحذية'}), 'Winter shoes · أحذية');
  assert.equal(group({asset_group_name: 'x'.repeat(128)}), 'x'.repeat(128));
  // Google counts characters: 128 characters outside the Basic Multilingual Plane are 128.
  assert.equal(group({asset_group_name: '😀'.repeat(128)}), '😀'.repeat(128));
  for (const [value, type] of [
    ['x'.repeat(129), 'string'],
    ['😀'.repeat(129), 'string'],
    ['   ', 'string'],
    ['two\nlines', 'string'],
    [5, 'number'],
    [null, 'null'],
    [['a'], 'array'],
    [true, 'boolean'],
  ])
    refused(
      {asset_group_name: value},
      'RECIPE_INPUT_INVALID',
      e =>
        e.details.field === 'asset_group_name' &&
        e.details.received_type === type &&
        e.details.min === 1 &&
        e.details.max === 128,
    );
});

test('R5: positive_geo_target_type puts the setting in the campaign create; SEARCH_INTEREST and other values are invalid', () => {
  const campaign = patch => creates(pmax(patch), 'campaign_operation')[0];
  assert.deepEqual(campaign({positive_geo_target_type: 'PRESENCE'}).geo_target_type_setting, {
    positive_geo_target_type: 'PRESENCE',
  });
  assert.deepEqual(campaign({positive_geo_target_type: 'presence_or_interest'}).geo_target_type_setting, {
    positive_geo_target_type: 'PRESENCE_OR_INTEREST',
  });
  // Left out or blank, Google's default applies, as it always did: the create carries no setting.
  assert.equal(campaign({}).geo_target_type_setting, undefined);
  assert.equal(campaign({positive_geo_target_type: ''}).geo_target_type_setting, undefined);
  for (const value of ['SEARCH_INTEREST', 'search_interest', 'PRESENCE ', 'ANYWHERE', 7, true, null, {}])
    refused(
      {positive_geo_target_type: value},
      'RECIPE_INPUT_INVALID',
      e =>
        e.details.field === 'positive_geo_target_type' &&
        JSON.stringify(e.details.allowed) === JSON.stringify(['PRESENCE_OR_INTEREST', 'PRESENCE']),
    );
});

test('R6: portrait and tall portrait images link as their own field types, and the 20-image cap counts the portraits', () => {
  const plan = pmax({portrait_image_asset_ids: ['505', '506'], tall_portrait_image_asset_ids: ['507']});
  assert.deepEqual(
    links(plan, 'PORTRAIT_MARKETING_IMAGE').map(l => l.asset),
    ['customers/123/assets/505', 'customers/123/assets/506'],
  );
  assert.deepEqual(
    links(plan, 'TALL_PORTRAIT_MARKETING_IMAGE').map(l => l.asset),
    ['customers/123/assets/507'],
  );
  // The counts the plan shows are the counts of the links (the website's preview checks them), and a count of none is not shown.
  assert.equal(plan.recipe.asset_counts.PORTRAIT_MARKETING_IMAGE, 2);
  assert.equal(plan.recipe.asset_counts.TALL_PORTRAIT_MARKETING_IMAGE, 1);
  assert.equal(
    creates(plan, 'asset_group_asset_operation').length,
    Object.values(plan.recipe.asset_counts).reduce((sum, n) => sum + n, 0),
  );
  const plain = pmax({});
  assert.equal(
    links(plain, 'PORTRAIT_MARKETING_IMAGE').length + links(plain, 'TALL_PORTRAIT_MARKETING_IMAGE').length,
    0,
  );
  assert.deepEqual(Object.keys(plain.recipe.asset_counts), [
    'HEADLINE',
    'LONG_HEADLINE',
    'DESCRIPTION',
    'BUSINESS_NAME',
    'MARKETING_IMAGE',
    'SQUARE_MARKETING_IMAGE',
    'LOGO',
  ]);
  // 10 landscape, 5 square and 5 portrait images are 20; one more is 21, and Google takes at most 20 in all.
  const full = {marketing_image_asset_ids: ids(600, 10), square_image_asset_ids: ids(700, 5)};
  assert.equal(links(pmax({...full, portrait_image_asset_ids: ids(800, 5)}), 'PORTRAIT_MARKETING_IMAGE').length, 5);
  refused({...full, portrait_image_asset_ids: ids(800, 6)}, 'RECIPE_INPUT_INVALID', e =>
    /at most 20 images/.test(e.message),
  );
  // A tall portrait image is counted nowhere (google-pmax-build.ts pmaxUncountedFieldTypes), so it never makes a brief over the cap.
  assert.equal(
    links(
      pmax({...full, portrait_image_asset_ids: ids(800, 5), tall_portrait_image_asset_ids: ids(900, 5)}),
      'TALL_PORTRAIT_MARKETING_IMAGE',
    ).length,
    5,
  );
});

test('the new image lists are judged like the others: numeric IDs, each once, and a list, never "missing"', () => {
  for (const key of ['portrait_image_asset_ids', 'tall_portrait_image_asset_ids']) {
    for (const [value, type] of [
      ['505', 'string'],
      [505, 'number'],
      [null, 'null'],
      [{}, 'object'],
      [[505], 'array'],
      [['img-1'], 'array'],
      [['505', '505'], 'array'],
      [[''], 'array'],
      [ids(900, 21), 'array'],
    ])
      refused(
        {[key]: value},
        'RECIPE_INPUT_INVALID',
        e => e.details.field === key && e.details.received_type === type && e.details.min === 0 && e.details.max === 20,
      );
    // Left out, blank or empty: no link of that type.
    for (const none of [undefined, '', []]) {
      const plan = pmax({[key]: none});
      assert.equal(
        links(plan, key.startsWith('tall') ? 'TALL_PORTRAIT_MARKETING_IMAGE' : 'PORTRAIT_MARKETING_IMAGE').length,
        0,
      );
    }
  }
});

test('the website previews a plan with the new inputs as the paused pack, counts included, and never one whose counts do not match its links', async () => {
  const f = fixture(
    'en',
    JSON.parse(JSON.stringify(campaignRecipes.find(r => r.id === 'google_performance_max'))),
    business,
  );
  await f.mount();
  const {recipe, ...plan} = pmax({
    asset_group_name: 'Named group',
    positive_geo_target_type: 'PRESENCE',
    portrait_image_asset_ids: ['505', '506'],
    tall_portrait_image_asset_ids: ['507'],
  });
  const show = (r, p) => {
    f.context.preview = {ready: true, provider_mutations: 0, recipe: r, plan: p};
    return f.run('conversionRecipePreview(preview)');
  };
  const html = show(recipe, plan);
  assert.match(html, /<h3>Paused Performance Max preview<\/h3>/);
  assert.match(
    html,
    /SQUARE_MARKETING_IMAGE 1 · PORTRAIT_MARKETING_IMAGE 2 · TALL_PORTRAIT_MARKETING_IMAGE 1 · LOGO 1/,
  );
  // The preview's own check: a link the counts do not name, or a count the links do not match, is not the pack.
  const fewer = structuredClone(recipe);
  fewer.asset_counts.PORTRAIT_MARKETING_IMAGE = 1;
  assert.doesNotMatch(show(fewer, plan), /<h3>/);
  const unnamed = structuredClone(recipe);
  delete unnamed.asset_counts.TALL_PORTRAIT_MARKETING_IMAGE;
  assert.doesNotMatch(show(unnamed, plan), /<h3>/);
});

test('N1: the recipe still creates the campaign PAUSED, and the build still needs spend_change_confirmed', () => {
  const plan = pmax({
    asset_group_name: 'Named group',
    positive_geo_target_type: 'PRESENCE',
    portrait_image_asset_ids: ['505'],
    tall_portrait_image_asset_ids: ['506'],
  });
  const [campaign] = creates(plan, 'campaign_operation');
  assert.equal(campaign.status, 'PAUSED');
  assert.equal(campaign.advertising_channel_type, 'PERFORMANCE_MAX');
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.recipe.build.all_or_nothing, true);
  assert.equal(plan.recipe.atomic, true);
  // Nothing else in the create changed: the keys a brief without the new inputs sends are still there, and in the same order.
  assert.deepEqual(Object.keys(creates(pmax({}), 'campaign_operation')[0]), [
    'resource_name',
    'name',
    'status',
    'advertising_channel_type',
    'campaign_budget',
    'maximize_conversions',
    'brand_guidelines_enabled',
    'contains_eu_political_advertising',
  ]);
});

test('N1 (pipeline): the plan with the new inputs creates a paused campaign, its named asset group and its links, and stops for the spend confirmation first', async t => {
  Object.assign(existing, {'customers/123/assets/505': 'IMAGE', 'customers/123/assets/506': 'IMAGE'});
  const x = pmaxCustomer();
  t.after(() => x.store.close());
  const created = await x.call('amcp_campaign', {
    action: 'create_from_recipe',
    recipe: 'google_performance_max',
    business: {
      ...business,
      asset_group_name: 'Named group',
      positive_geo_target_type: 'presence',
      portrait_image_asset_ids: ['505'],
      tall_portrait_image_asset_ids: ['506'],
    },
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
  // Approved without spend_change_confirmed: the run stops for it, and nothing has been sent.
  let result = await x.call('amcp_campaign', {action: 'run', id});
  assert.equal(result.success, true, JSON.stringify(result).slice(0, 1500));
  assert.equal(result.data.run?.stopped, 'needs_spend_change_confirmed');
  assert.equal(x.mutates.length, 0, 'nothing is sent before the spend is confirmed');
  const again = await x.call(result.data.next_call.tool, {
    ...result.data.next_call.arguments,
    confirmed: true,
    spend_change_confirmed: true,
  });
  assert.equal(again.success, true, JSON.stringify(again).slice(0, 1500));
  result = await x.call('amcp_campaign', {action: 'run', id});
  assert.equal(result.success, true, JSON.stringify(result).slice(0, 1500));
  const full = (await x.call('amcp_campaign', {action: 'get', id, detail: 'full'})).data;
  assert.equal(
    full.state,
    'complete',
    JSON.stringify(full.steps.map(s => ({id: s.id, status: s.status, error: s.error}))),
  );
  assert.equal(x.mutates.length, 1, 'one request created everything');
  const made = [...x.created.values()];
  const campaign = made.find(r => r.advertising_channel_type === 'PERFORMANCE_MAX');
  assert.equal(campaign.status, 'PAUSED');
  assert.deepEqual(campaign.geo_target_type_setting, {positive_geo_target_type: 'PRESENCE'});
  assert.equal(made.find(r => r.final_urls)?.name, 'Named group');
  const types = made.filter(r => r.field_type).map(r => r.field_type);
  assert.equal(types.filter(f => f === 'PORTRAIT_MARKETING_IMAGE').length, 1);
  assert.equal(types.filter(f => f === 'TALL_PORTRAIT_MARKETING_IMAGE').length, 1);
});

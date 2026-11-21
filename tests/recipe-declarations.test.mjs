// R2.5 field3 fix round, package r25-field3-recipes (the lead's review of 2026-11-22): the declarations of the recipes. A declaration is the person's own
// statement of a fact (the EU political advertising declaration, LinkedIn's political intent, Snapchat's regulated content, Meta's special ad
// categories, the goal and value policies): it is never defaulted, never taken from a playbook, and never answered with the one value a recipe
// takes. Synthetic briefs only; nothing reaches a provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {campaignRecipe, campaignRecipes} from '../dist/src/campaign-recipes.js';
import {recipeContext, recipeInputs} from '../dist/src/recipe-context.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {admin, operator, platforms, recipeScopeWorld, tenant} from './fixtures/recipe-context-world.mjs';
import {recipeBriefs} from './fixtures/recipe-briefs.mjs';

const examples = JSON.parse(readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'));
const definition = id => campaignRecipes.find(r => r.id === id);
const snapchat = {
  snapchat_website_traffic: examples.snapchat_traffic_business,
  snapchat_lead_generation: examples.snapchat_lead_business,
};

test('S4-5: both Snapchat recipes declare regulated_content as a yes/no declaration of which only false is taken', () => {
  for (const id of Object.keys(snapchat)) {
    const spec = definition(id).inputs.regulated_content;
    assert.deepEqual({...spec}, {type: 'boolean', values: [false], declaration: true}, id);
    assert.ok(Object.isFrozen(spec) && Object.isFrozen(spec.values), id + ' cannot be changed by a caller');
    assert.ok(definition(id).required.includes('regulated_content'), id);
  }
  // The schedule is declared beside them (the lead's review S3-4).
  assert.deepEqual(Object.keys(definition('snapchat_lead_generation').inputs).sort(), [
    'end_time',
    'optimization_goal',
    'regulated_content',
    'start_time',
  ]);
});

test('S4-5: regulated_content false compiles; true is a prerequisite that names no value to swap it for; another type is invalid and names its type', () => {
  for (const [id, brief] of Object.entries(snapchat)) {
    assert.ok(campaignRecipe(id, {...brief, regulated_content: false}).steps.length, id);
    assert.throws(
      () => campaignRecipe(id, {...brief, regulated_content: true}),
      e => assertRefused(e, 'RECIPE_PREREQUISITES_REQUIRED') && e.details?.allowed === undefined,
      id,
    );
    for (const [wrong, type] of [
      ['false', 'string'],
      ['true', 'string'],
      ['no', 'string'],
      [0, 'number'],
      [1, 'number'],
      [null, 'null'],
      [[], 'array'],
      [{}, 'object'],
    ])
      assert.throws(
        () => campaignRecipe(id, {...brief, regulated_content: wrong}),
        e =>
          assertRefused(e, 'RECIPE_INPUT_INVALID') &&
          e.details.field === 'regulated_content' &&
          e.details.received_type === type &&
          e.details.allowed === undefined,
        id + ' ' + JSON.stringify(wrong),
      );
    // Left out, it is still required, as every declaration is: nothing defaults it to false.
    const {regulated_content: _left, ...without} = brief;
    assert.throws(
      () => campaignRecipe(id, without),
      e => assertRefused(e, 'RECIPE_INPUT_REQUIRED') && e.details.missing_fields.includes('regulated_content'),
      id,
    );
  }
});

// The names of the declarations: the person's own statements of a fact, in every recipe that takes one.
const declarationNames = [
  'contains_eu_political_advertising',
  'conversion_goal_policy',
  'conversion_value_policy',
  'political_intent',
  'regulated_content',
  'special_ad_categories',
];
// A recipe of each platform that takes declarations, and the value a playbook could default each to, in the forms the reviewer used.
const defaultable = [
  ['google_search', {contains_eu_political_advertising: false}],
  ['google_search', {contains_eu_political_advertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING'}],
  [
    'google_search_conversion_value',
    {conversion_goal_policy: 'ACCOUNT_DEFAULT', conversion_value_policy: 'ACCOUNT_RECORDED_VALUES'},
  ],
  ['google_performance_max', {conversion_goal_policy: 'ACCOUNT_DEFAULT', contains_eu_political_advertising: false}],
  ['linkedin_lead_generation', {political_intent: 'NOT_POLITICAL'}],
  ['snapchat_website_traffic', {regulated_content: false}],
  ['meta_website_traffic', {special_ad_categories: []}],
];
const withPlaybook = (t, defaults) => {
  const w = recipeScopeWorld({profile: true});
  t.after(() => w.store.close());
  w.store.putDocument(tenant, 'client_profile', 'playbook', {
    ...w.store.document(tenant, 'client_profile', 'playbook'),
    defaults,
  });
  return w;
};

test('S2-2: every declaration of every recipe is marked as one in its inputs, and nothing else is', () => {
  for (const r of campaignRecipes)
    for (const [key, spec] of Object.entries(r.inputs))
      assert.equal(spec.declaration === true, declarationNames.includes(key), r.id + '.' + key);
  for (const name of declarationNames)
    assert.ok(
      campaignRecipes.some(r => r.inputs[name]?.declaration === true),
      name + ' is declared by a recipe',
    );
});

test('S2-2: a playbook’s defaults never supply a declaration: not a recipe’s own, not the shared ones, in any form', t => {
  for (const [recipe, declarations] of defaultable)
    for (const where of ['recipes', 'common']) {
      const defaults = {...declarations, daily_budget: '30'},
        w = withPlaybook(t, where === 'recipes' ? {recipes: {[recipe]: defaults}} : {common: defaults}),
        context = recipeContext(w.store, operator, recipe, 'playbook');
      for (const key of Object.keys(declarations))
        assert.equal(Object.hasOwn(context.defaults, key), false, recipe + ' ' + where + ' ' + key);
      assert.equal(context.defaults.daily_budget, '30', 'a business default still applies: ' + recipe + ' ' + where);
    }
});

test('S2-2 (the reviewer’s probe): a brief that leaves the EU declaration out is still incomplete, naming it, whatever the playbook defaults it to', async t => {
  for (const value of [
    false,
    'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
    'does_not_contain_eu_political_advertising',
  ]) {
    const w = withPlaybook(t, {recipes: {google_search: {contains_eu_political_advertising: value}}}),
      {contains_eu_political_advertising: given, ...left} = recipeBriefs.google_search,
      input = business => ({
        recipe: 'google_search',
        profile_id: 'playbook',
        business: {...business, connection_id: 'c1', account_id: '123', atomic: false},
      });
    // The preview says what is missing, and nothing of the playbook is taken for it; the plan itself is refused as required.
    const preview = await w.call({action: 'preview_recipe', ...input(left)});
    assert.equal(preview.success, true, JSON.stringify(preview).slice(0, 600));
    assert.equal(preview.data.ready, false, String(value));
    assert.deepEqual(preview.data.missing_fields, ['contains_eu_political_advertising'], String(value));
    const created = await w.call({action: 'create_from_recipe', ...input(left)});
    assertRefused(created, 'RECIPE_INPUT_REQUIRED');
    assert.deepEqual(created.error.details.missing_fields, ['contains_eu_political_advertising'], String(value));
    // The brief that states it is the one that plans.
    const stated = await w.call({
      action: 'preview_recipe',
      ...input({...left, contains_eu_political_advertising: given}),
    });
    assert.equal(stated.success, true, JSON.stringify(stated).slice(0, 600));
    assert.equal(stated.data.ready, true, JSON.stringify(stated).slice(0, 600));
  }
  // The same through the context and the inputs a recipe is built from: nothing of the playbook's is merged in.
  const w = withPlaybook(t, {recipes: {google_search: {contains_eu_political_advertising: false}}}),
    context = recipeContext(w.store, operator, 'google_search', 'playbook');
  assert.equal(Object.hasOwn(recipeInputs(context, {name: 'x'}).business, 'contains_eu_political_advertising'), false);
});
test('S2-2: a playbook that names a declaration under its defaults is refused when it is saved or previewed as a draft, and the refusal says which', async t => {
  const w = recipeScopeWorld();
  t.after(() => w.store.close());
  const workspace = input => w.service.call('amcp_workspace', input, admin);
  for (const [defaults, field] of [
    [
      {recipes: {google_search: {contains_eu_political_advertising: false}}},
      'defaults.recipes.google_search.contains_eu_political_advertising',
    ],
    [
      {recipes: {linkedin_lead_generation: {political_intent: 'NOT_POLITICAL'}}},
      'defaults.recipes.linkedin_lead_generation.political_intent',
    ],
    [
      {recipes: {snapchat_website_traffic: {regulated_content: false}}},
      'defaults.recipes.snapchat_website_traffic.regulated_content',
    ],
    [
      {recipes: {meta_website_traffic: {special_ad_categories: []}}},
      'defaults.recipes.meta_website_traffic.special_ad_categories',
    ],
    [
      {recipes: {google_performance_max: {conversion_goal_policy: 'ACCOUNT_DEFAULT'}}},
      'defaults.recipes.google_performance_max.conversion_goal_policy',
    ],
    [{common: {contains_eu_political_advertising: false}}, 'defaults.common.contains_eu_political_advertising'],
  ]) {
    for (const call of [
      profile => workspace({action: 'save_profile', confirmed: true, profile}),
      profile => workspace({action: 'preview_profile', profile}),
    ]) {
      const refused = await call({name: 'Bad', defaults});
      assertRefused(refused, 'INVALID_PROFILE');
      assert.deepEqual(refused.error.details?.fields, [field], JSON.stringify(refused.error));
    }
  }
  // A playbook of business defaults saves, and a stored one that already names a declaration still previews: the context drops the key.
  const good = await workspace({
    action: 'save_profile',
    confirmed: true,
    profile: {name: 'Good', defaults: {common: {daily_budget: '30'}, recipes: {google_search: {daily_budget: '40'}}}},
  });
  assert.equal(good.success, true, JSON.stringify(good).slice(0, 600));
  w.store.putDocument(tenant, 'client_profile', 'legacy', {
    name: 'Legacy',
    approved_by: admin.userId,
    defaults: {recipes: {google_search: {contains_eu_political_advertising: false}}},
  });
  const preview = await workspace({action: 'preview_profile', id: 'legacy'});
  assert.equal(preview.success, true, JSON.stringify(preview).slice(0, 600));
});

test('S3-2: a declared POLITICAL is refused as a prerequisite, in any letter case, and is never answered with the one value the recipe takes', () => {
  const brief = examples.linkedin_lead_business,
    compile = political_intent => campaignRecipe('linkedin_lead_generation', {...brief, political_intent});
  for (const given of ['POLITICAL', 'political', 'Political', 'pOLITICAL'])
    assert.throws(
      () => compile(given),
      e =>
        assertRefused(e, 'RECIPE_PREREQUISITES_REQUIRED') &&
        e.message === 'Political advertising needs a tailored native plan.' &&
        e.details?.allowed === undefined &&
        !JSON.stringify(e.details ?? {}).includes('NOT_POLITICAL'),
      given,
    );
  // What the recipe takes compiles, folded or not; anything else it does not take is still the generic refusal, which lists the one value, and a
  // value of another type names its type.
  for (const given of ['NOT_POLITICAL', 'not_political']) assert.ok(compile(given).steps.length, given);
  assert.throws(
    () => compile('NOT_DECLARED'),
    e =>
      assertRefused(e, 'RECIPE_INPUT_INVALID') &&
      e.details.field === 'political_intent' &&
      JSON.stringify(e.details.allowed) === '["NOT_POLITICAL"]',
  );
  for (const [wrong, type] of [
    [true, 'boolean'],
    [7, 'number'],
    [null, 'null'],
    [[], 'array'],
  ])
    assert.throws(
      () => compile(wrong),
      e => assertRefused(e, 'RECIPE_INPUT_INVALID') && e.details.received_type === type,
      String(wrong),
    );
});

test('S3-2: the other single-value declarations refuse the other statement as a prerequisite too, and offer no value to swap it for', () => {
  const refusal = fn =>
    assert.throws(fn, e => assertRefused(e, 'RECIPE_PREREQUISITES_REQUIRED') && e.details?.allowed === undefined);
  // Snapchat: regulated content that applies.
  for (const [id, brief] of Object.entries(snapchat))
    refusal(() => campaignRecipe(id, {...brief, regulated_content: true}));
  // Meta: a special ad category that applies (the declaration of none is the empty list).
  for (const category of ['HOUSING', 'EMPLOYMENT', 'CREDIT', 'ISSUES_ELECTIONS_POLITICS'])
    refusal(() =>
      campaignRecipe('meta_website_traffic', {...recipeBriefs.meta_website_traffic, special_ad_categories: [category]}),
    );
});

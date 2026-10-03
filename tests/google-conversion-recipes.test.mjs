import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {campaignRecipe, campaignRecipes} from '../dist/src/campaign-recipes.js';
import {recipeDependencies} from '../dist/src/capability-eligibility.js';
import {googleSearchFixture} from './fixtures/google-search-recipe-data.mjs';

const {cpc_bid, ...base} = JSON.parse(
  readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'),
).recipe_business;
const conversionBusiness = {...base, conversion_goal_policy: 'ACCOUNT_DEFAULT'};
const recipes = ['google_search_conversions', 'google_search_target_cpa'];
const brief = recipe => ({...conversionBusiness, ...(recipe.endsWith('target_cpa') ? {target_cpa: '15.250001'} : {})});
const created = (plan, id) => plan.steps.find(s => s.id === id).arguments.payload.operations[0].create;

test('Search conversion recipes expose exact goal-policy and bidding dependencies', () => {
  for (const id of recipes) {
    const definition = campaignRecipes.find(r => r.id === id);
    assert.ok(definition, id);
    assert.ok(definition.required.includes('conversion_goal_policy'));
    assert.equal(definition.required.includes('target_cpa'), id.endsWith('target_cpa'));
    assert.ok(!definition.required.includes('cpc_bid'));
    assert.ok(!definition.required.includes('cpc_bid_ceiling'));
    assert.deepEqual(recipeDependencies[id].actions, recipeDependencies.google_search.actions);
    assert.ok(recipeDependencies[id].objects.includes('account_default_conversion_goals'));
    assert.ok(recipeDependencies[id].objects.includes('conversion_event_delivery'));
  }
});

test('Maximize Conversions compiles paused Search without a target, manual bid, portfolio or goal mutation', () => {
  const plan = campaignRecipe(recipes[0], brief(recipes[0]));
  assert.deepEqual(created(plan, 'campaign').maximize_conversions, {});
  assert.equal(created(plan, 'campaign').status, 'PAUSED');
  assert.equal(created(plan, 'campaign').manual_cpc, undefined);
  assert.equal(created(plan, 'campaign').target_spend, undefined);
  assert.equal(created(plan, 'adgroup').cpc_bid_micros, undefined);
  assert.equal(plan.steps.length, 6);
  assert.equal(plan.recipe.bidding_strategy, 'MAXIMIZE_CONVERSIONS');
  assert.equal(plan.recipe.conversion_goal_policy, 'ACCOUNT_DEFAULT');
  assert.equal(plan.recipe.target_cpa_micros, undefined);
  assert.match(plan.recipe.measurement_acceptance, /unverified/);
  assert.match(plan.brief, /account.default/i);
  assert.ok(plan.steps.every(s => !/conversion_goal/.test(s.arguments.action)));
});

test('Search target CPA preserves exact decimal text as native Maximize Conversions micros', () => {
  for (const [value, micros] of [
    ['00015.250001', '15250001'],
    ['0.000001', '1'],
    ['9007199254.740991', '9007199254740991'],
  ]) {
    const plan = campaignRecipe(recipes[1], {...brief(recipes[1]), target_cpa: value});
    assert.deepEqual(created(plan, 'campaign').maximize_conversions, {target_cpa_micros: micros});
    assert.equal(plan.recipe.target_cpa_micros, micros);
    assert.equal(created(plan, 'campaign').target_cpa, undefined);
    assert.equal(created(plan, 'campaign').bidding_strategy, undefined);
  }
});

test('conversion drafts require explicit supported goal policy and refuse contradictory bidding or goal inputs', () => {
  for (const recipe of recipes) {
    for (const value of [undefined, null, true, false, '', 'CUSTOM', 'CAMPAIGN', ['ACCOUNT_DEFAULT']])
      assert.throws(() => campaignRecipe(recipe, {...brief(recipe), conversion_goal_policy: value}));
    for (const field of [
      'cpc_bid',
      'cpc_bid_ceiling',
      'target_roas',
      'bidding_strategy',
      'manual_cpc',
      'target_spend',
      'maximize_conversions',
      'maximize_conversion_value',
      'conversion_actions',
      'custom_conversion_goal',
      'campaign_conversion_goals',
    ])
      assert.throws(
        () => campaignRecipe(recipe, {...brief(recipe), [field]: 'unexpected'}),
        e => e.code === 'RECIPE_INPUT_INVALID',
        field,
      );
  }
  assert.throws(
    () => campaignRecipe(recipes[0], {...brief(recipes[0]), target_cpa: '15'}),
    e => e.code === 'RECIPE_INPUT_INVALID',
  );
  for (const value of [undefined, null, 0, 15.25, true, '', '0', '-1', '1e3', '0.0000001', '9007199254.740992'])
    assert.throws(
      () => campaignRecipe(recipes[1], {...brief(recipes[1]), target_cpa: value}),
      e => ['RECIPE_INPUT_REQUIRED', 'INVALID_RECIPE_MONEY'].includes(e.code),
      String(value),
    );
});

test('conversion Search retains split targeting, copy, political declaration and account dates', () => {
  const plan = campaignRecipe(recipes[1], {
    ...brief(recipes[1]),
    country_criterion_ids: Array.from({length: 20}, (_, i) => String(2000 + i)),
    language_criterion_ids: Array.from({length: 10}, (_, i) => String(1000 + i)),
    start_date: '2026-11-01',
    end_date: '2026-11-30',
  });
  assert.deepEqual(
    plan.steps.filter(s => s.id.startsWith('targeting')).map(s => s.arguments.payload.operations.length),
    [25, 5],
  );
  assert.equal(created(plan, 'campaign').start_date_time, '2026-11-01 00:00:00');
  assert.equal(created(plan, 'campaign').end_date_time, '2026-11-30 23:59:59');
  assert.deepEqual(
    created(plan, 'ad').ad.responsive_search_ad.headlines,
    base.headlines.map(text => ({text})),
  );
  assert.throws(() => campaignRecipe(recipes[0], {...brief(recipes[0]), contains_eu_political_advertising: 'UNKNOWN'}));
});

test('conversion context, profile provenance and saved unapproved plan need no native calls', async t => {
  const recipe = recipes[1],
    business = brief(recipe),
    f = googleSearchFixture(t, business);
  f.store.putDocument(f.actor.tenantId, 'client_profile', 'profile', {
    name: 'Client',
    approved_by: 'admin',
    defaults: {recipes: {[recipe]: {target_cpa: '20.000001'}}},
  });
  const context = await f.call({action: 'recipe_context', recipe, profile_id: 'profile'});
  assert.equal(context.success, true, JSON.stringify(context));
  assert.match(context.data.limitations.join(' '), /account.default/i);
  const preview = await f.call({action: 'preview_recipe', recipe, business});
  assert.equal(preview.success, true, JSON.stringify(preview));
  const {target_cpa, ...rest} = business;
  const saved = await f.call({action: 'create_from_recipe', recipe, profile_id: 'profile', business: rest});
  assert.equal(saved.success, true, JSON.stringify(saved));
  const full = await f.call({action: 'get', id: saved.data.id, detail: 'full'});
  assert.equal(created(full.data, 'campaign').maximize_conversions.target_cpa_micros, '20000001');
  assert.equal(full.data.recipe.provenance.fields.target_cpa.source, 'approved_profile');
  assert.equal(full.data.state, 'draft');
  assert.equal(f.requests.length, 0);
});

test('current conversion goal and event dependencies remain unknown after account prerequisites', async t => {
  const recipe = recipes[0],
    business = brief(recipe),
    f = googleSearchFixture(t, business);
  const result = await f.call({action: 'recipe_eligibility', recipe, business, live: true});
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.data.status, 'unknown');
  for (const id of ['account_default_conversion_goals', 'conversion_event_delivery', 'provider_objective_acceptance'])
    assert.equal(result.data.dependencies.find(row => row.id === id).status, 'unknown');
  assert.equal(result.data.dependencies.find(row => row.id === 'account_currency').status, 'ready');
  assert.equal(result.data.provider_mutations, 0);
  assert.equal(f.mutations.length, 0);
  assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
});

test('both conversion recipes complete per-step native review, execution and exact read-back while paused', async t => {
  for (const recipe of recipes) {
    const business = brief(recipe),
      f = googleSearchFixture(t, business, {native: true}),
      saved = await f.call({action: 'create_from_recipe', recipe, business});
    assert.equal(saved.success, true, JSON.stringify(saved));
    for (let i = 0; i < 6; i++) {
      const prepared = await f.call({action: 'prepare_next', id: saved.data.id});
      assert.equal(prepared.success, true, JSON.stringify(prepared));
      assert.ok(prepared.data.review?.review_id);
      const executed = await f.call({
        action: 'execute_next',
        id: saved.data.id,
        review_id: prepared.data.review.review_id,
        idempotency_key: prepared.data.review.review_id,
        confirmed: true,
        spend_change_confirmed: true,
      });
      assert.equal(executed.success, true, JSON.stringify(executed));
      assert.equal(executed.data.current.status, 'verified', JSON.stringify(executed));
    }
    const run = f.store.document(f.actor.tenantId, 'campaign_run', saved.data.id),
      campaign = [...f.resources.values()].find(r => r.kind === 'campaign').value;
    assert.equal(run.state, 'complete');
    assert.equal(campaign.status, 'PAUSED');
    assert.deepEqual(campaign.maximizeConversions, recipe.endsWith('target_cpa') ? {targetCpaMicros: '15250001'} : {});
    assert.equal(f.mutations.length, 6);
    assert.ok(f.requests.some(r => /campaign.bidding_strategy_type/.test(r.body.query ?? '')));
    assert.ok(f.requests.some(r => /campaign.maximize_conversions.target_cpa_micros/.test(r.body.query ?? '')));
    const replay = await f.call({
      action: 'execute_next',
      id: run.id,
      review_id: run.steps.at(-1).review_id,
      confirmed: true,
      spend_change_confirmed: true,
    });
    assert.equal(replay.success, true, JSON.stringify(replay));
    assert.equal(f.mutations.length, 6);
  }
});

test('a different native target CPA blocks verification and all dependent work without resubmitting', async t => {
  const recipe = recipes[1],
    business = brief(recipe),
    f = googleSearchFixture(t, business, {native: true, wrongTarget: true}),
    saved = await f.call({action: 'create_from_recipe', recipe, business});
  assert.equal(saved.success, true, JSON.stringify(saved));
  for (let i = 0; i < 2; i++) {
    const prepared = await f.call({action: 'prepare_next', id: saved.data.id});
    assert.equal(prepared.success, true, JSON.stringify(prepared));
    const executed = await f.call({
      action: 'execute_next',
      id: saved.data.id,
      review_id: prepared.data.review.review_id,
      confirmed: true,
      spend_change_confirmed: true,
    });
    assert.equal(executed.success, true, JSON.stringify(executed));
    assert.equal(executed.data.current.status, i === 0 ? 'verified' : 'verifying', JSON.stringify(executed));
  }
  const continued = await f.call({action: 'prepare_next', id: saved.data.id});
  assert.equal(continued.success, true, JSON.stringify(continued));
  assert.equal(continued.data.current.status, 'mismatch');
  assert.equal(continued.data.review, undefined);
  assert.equal(f.mutations.length, 2);
  assert.ok(![...f.resources.values()].some(r => r.kind === 'adGroup'));
});

test('existing empty manual-CPC and conversion bidding objects require the exact native strategy', async t => {
  for (const [recipe, business] of [
    ['google_search', {...base, cpc_bid}],
    [recipes[0], brief(recipes[0])],
  ]) {
    const f = googleSearchFixture(t, business, {native: true, wrongStrategy: true}),
      saved = await f.call({action: 'create_from_recipe', recipe, business});
    assert.equal(saved.success, true, JSON.stringify(saved));
    for (let i = 0; i < 2; i++) {
      const prepared = await f.call({action: 'prepare_next', id: saved.data.id});
      assert.equal(prepared.success, true, JSON.stringify(prepared));
      const executed = await f.call({
        action: 'execute_next',
        id: saved.data.id,
        review_id: prepared.data.review.review_id,
        confirmed: true,
        spend_change_confirmed: true,
      });
      assert.equal(executed.success, true, JSON.stringify(executed));
      assert.equal(
        executed.data.current.status,
        i === 0 ? 'verified' : 'verifying',
        recipe + ': ' + JSON.stringify(executed),
      );
    }
    const continued = await f.call({action: 'prepare_next', id: saved.data.id});
    assert.equal(continued.success, true, JSON.stringify(continued));
    assert.equal(continued.data.current.status, 'mismatch');
    assert.equal(continued.data.review, undefined);
    assert.equal(f.mutations.length, 2);
  }
});

test('missing native bidding type and an unexpected conversion target cannot establish the requested strategy', async t => {
  for (const options of [{omitStrategy: true}, {unexpectedTarget: true}]) {
    const recipe = recipes[0],
      business = brief(recipe),
      f = googleSearchFixture(t, business, {native: true, ...options}),
      saved = await f.call({action: 'create_from_recipe', recipe, business});
    assert.equal(saved.success, true, JSON.stringify(saved));
    for (let i = 0; i < 2; i++) {
      const prepared = await f.call({action: 'prepare_next', id: saved.data.id});
      assert.equal(prepared.success, true, JSON.stringify(prepared));
      const executed = await f.call({
        action: 'execute_next',
        id: saved.data.id,
        review_id: prepared.data.review.review_id,
        confirmed: true,
        spend_change_confirmed: true,
      });
      assert.equal(executed.success, true, JSON.stringify(executed));
      assert.equal(
        executed.data.current.status,
        i === 0 ? 'verified' : 'verifying',
        JSON.stringify(options) + ': ' + JSON.stringify(executed),
      );
    }
    assert.equal(f.mutations.length, 2);
  }
});

test('conversion drafts preserve read-only role, revoked login and explicit review-confirmation boundaries', async t => {
  const recipe = recipes[1],
    business = brief(recipe),
    f = googleSearchFixture(t, business, {native: true});
  assert.equal(
    (await f.call({action: 'create_from_recipe', recipe, business}, {...f.actor, role: 'reader'})).success,
    false,
  );
  const saved = await f.call({action: 'create_from_recipe', recipe, business});
  assert.equal(saved.success, true, JSON.stringify(saved));
  const prepared = await f.call({action: 'prepare_next', id: saved.data.id});
  assert.equal(prepared.success, true, JSON.stringify(prepared));
  const refused = await f.call({action: 'execute_next', id: saved.data.id, review_id: prepared.data.review.review_id});
  assert.equal(refused.success, false);
  assert.equal(f.mutations.length, 0);
  f.store.putConnection(
    f.admin,
    {...f.connection, enabled: false},
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const before = f.requests.length;
  assert.equal((await f.call({action: 'create_from_recipe', recipe, business})).success, false);
  assert.equal(f.requests.length, before);
});

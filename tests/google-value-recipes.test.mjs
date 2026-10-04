import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {campaignRecipe, campaignRecipes} from '../dist/src/campaign-recipes.js';
import {recipeDependencies} from '../dist/src/capability-eligibility.js';
import {recipeRoas} from '../dist/src/recipe-values.js';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {googleSearchFixture} from './fixtures/google-search-recipe-data.mjs';
import {googleRecipeGoalsData} from './fixtures/google-recipe-goals-data.mjs';

const {cpc_bid, ...search} = JSON.parse(
  readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'),
).recipe_business;
const ids = ['google_search_conversion_value', 'google_search_target_roas'];
const brief = id => ({
  ...search,
  conversion_goal_policy: 'ACCOUNT_DEFAULT',
  conversion_value_policy: 'ACCOUNT_RECORDED_VALUES',
  ...(id === ids[1] ? {target_roas: '3.5'} : {}),
});
const record = (p, id) => p.steps.find(s => s.id === id).arguments.payload.operations[0].create;
async function next(f, id) {
  const prepared = await f.call({action: 'prepare_next', id});
  assert.equal(prepared.success, true, JSON.stringify(prepared));
  assert.ok(prepared.data.review?.review_id, JSON.stringify(prepared));
  const out = await f.call({
    action: 'execute_next',
    id,
    review_id: prepared.data.review.review_id,
    idempotency_key: prepared.data.review.review_id,
    confirmed: true,
    spend_change_confirmed: true,
  });
  assert.equal(out.success, true, JSON.stringify(out));
  return out;
}

test('value recipes declare explicit values, goals and ratio dependencies through the existing native families', () => {
  for (const id of ids) {
    const d = campaignRecipes.find(r => r.id === id);
    assert.ok(d);
    assert.ok(d.required.includes('conversion_value_policy'));
    assert.ok(d.required.includes('conversion_goal_policy'));
    assert.equal(d.required.includes('target_roas'), id === ids[1]);
    assert.ok(!d.required.some(k => ['cpc_bid', 'cpc_bid_ceiling', 'target_cpa'].includes(k)));
    assert.deepEqual(recipeDependencies[id].actions, recipeDependencies.google_search.actions);
    for (const name of [
      'account_default_conversion_goals',
      'primary_conversion_actions',
      'conversion_value_delivery',
      'conversion_history_eligibility',
    ])
      assert.ok(recipeDependencies[id].objects.includes(name));
  }
});

test('value drafts compile paused Search, dedicated exact budget and native ratio without editing conversion goals or values', () => {
  for (const id of ids) {
    const p = campaignRecipe(id, brief(id)),
      c = record(p, 'campaign');
    assert.equal(c.status, 'PAUSED');
    assert.equal(c.advertising_channel_type, 'SEARCH');
    assert.deepEqual(c.maximize_conversion_value, id === ids[1] ? {target_roas: 3.5} : {});
    assert.equal(record(p, 'budget').amount_micros, '25000000');
    assert.equal(record(p, 'budget').explicitly_shared, false);
    assert.equal(c.manual_cpc, undefined);
    assert.equal(c.maximize_conversions, undefined);
    assert.equal(c.target_roas, undefined);
    assert.equal(record(p, 'adgroup').cpc_bid_micros, undefined);
    assert.equal(p.steps.length, 6);
    assert.equal(p.recipe.bidding_strategy, 'MAXIMIZE_CONVERSION_VALUE');
    assert.equal(p.recipe.conversion_value_policy, 'ACCOUNT_RECORDED_VALUES');
    assert.equal(p.recipe.target_roas, id === ids[1] ? '3.5' : undefined);
    assert.ok(p.steps.every(s => s.gateway === 'google_ads_native_action' && s.expected_currency === 'USD'));
    assert.ok(p.steps.every(s => !/(conversion_goal|conversion_action|value_rule)/.test(s.arguments.action)));
    assert.match(p.brief, /Recorded conversion values/);
    assert.match(p.recipe.measurement_acceptance, /separate verification/);
  }
});

test('target ROAS canonicalizes bounded decimal ratios without percentages, currency or implicit coercion', () => {
  for (const [text, canonical, native] of [
    ['00003.500000', '3.5', 3.5],
    ['0.01', '0.01', 0.01],
    ['1000.000000', '1000', 1000],
    ['1.234567', '1.234567', 1.234567],
  ]) {
    assert.deepEqual(recipeRoas(text), {text: canonical, native});
    const p = campaignRecipe(ids[1], {...brief(ids[1]), target_roas: text});
    assert.equal(p.recipe.target_roas, canonical);
    assert.deepEqual(record(p, 'campaign').maximize_conversion_value, {target_roas: native});
  }
  for (const target_roas of [
    undefined,
    null,
    3.5,
    true,
    '',
    '0',
    '-1',
    '0.009999',
    '1000.000001',
    '3.5000000',
    '1e2',
    '350%',
    '3,5',
    ' 3.5',
    'Infinity',
    {},
    ['3.5'],
    '123456789',
  ])
    assert.throws(
      () => campaignRecipe(ids[1], {...brief(ids[1]), target_roas}),
      e => ['RECIPE_INPUT_REQUIRED', 'INVALID_RECIPE_ROAS'].includes(e.code),
      String(target_roas),
    );
});

test('value recipes refuse implicit value choices and contradictory strategies, units, tolerances or goals', () => {
  for (const id of ids) {
    for (const conversion_value_policy of [undefined, null, false, '', 'DEFAULT', 'PER_TRANSACTION', [], {}])
      assert.throws(() => campaignRecipe(id, {...brief(id), conversion_value_policy}));
    for (const key of [
      'cpc_bid',
      'cpc_bid_ceiling',
      'cpc_bid_floor',
      'cpc_bid_floor_micros',
      'cpc_bid_ceiling_micros',
      'target_cpa',
      'target_roas_tolerance_percent_millis',
      'bidding_strategy',
      'manual_cpc',
      'target_spend',
      'maximize_conversions',
      'maximize_conversion_value',
      'conversion_actions',
      'custom_conversion_goal',
      'targetRoas',
      'conversionValuePolicy',
    ])
      assert.throws(
        () => campaignRecipe(id, {...brief(id), [key]: 'unexpected'}),
        e => e.code === 'RECIPE_INPUT_INVALID',
        key,
      );
    assert.throws(() => campaignRecipe(id, {...brief(id), conversion_goal_policy: 'CAMPAIGN'}));
  }
  assert.throws(() => campaignRecipe(ids[0], {...brief(ids[0]), target_roas: '3.5'}));
  assert.throws(() =>
    campaignRecipe('google_search_conversions', {
      ...search,
      conversion_goal_policy: 'ACCOUNT_DEFAULT',
      conversion_value_policy: 'ACCOUNT_RECORDED_VALUES',
    }),
  );
});

test('profile value targets retain declared provenance while local preview and save make no provider requests', async t => {
  const b = brief(ids[1]),
    f = googleSearchFixture(t, b);
  f.store.putDocument(f.actor.tenantId, 'client_profile', 'profile', {
    name: 'Synthetic',
    approved_by: 'admin',
    defaults: {recipes: {[ids[1]]: {target_roas: '4.250001'}}},
  });
  const {target_roas, ...rest} = b;
  const preview = await f.call({action: 'preview_recipe', recipe: ids[1], profile_id: 'profile', business: rest});
  assert.equal(preview.success, true, JSON.stringify(preview));
  assert.equal(preview.data.recipe.target_roas, '4.250001');
  const saved = await f.call({action: 'create_from_recipe', recipe: ids[1], profile_id: 'profile', business: rest});
  assert.equal(saved.success, true, JSON.stringify(saved));
  const full = await f.call({action: 'get', id: saved.data.id, detail: 'full'});
  assert.equal(full.data.recipe.provenance.fields.target_roas.source, 'approved_profile');
  assert.equal(full.data.recipe.provenance.fields.conversion_value_policy.source, 'user');
  assert.equal(full.data.state, 'draft');
  assert.equal(f.requests.length, 0);
  assert.equal(f.mutations.length, 0);
  assert.deepEqual(record(full.data, 'campaign').maximize_conversion_value, {target_roas: 4.250001});
});

test('current complete primary-goal settings do not establish delivered values, conversion history or objective acceptance', async t => {
  const b = brief(ids[1]),
    data = googleRecipeGoalsData(),
    store = new Store(':memory:', Buffer.alloc(32, 119).toString('base64'));
  t.after(() => store.close());
  const actor = {tenantId: 'value-goal-inspection', userId: 'operator', role: 'operator'},
    admin = {...actor, role: 'admin'};
  store.putConnection(
    admin,
    {
      id: b.connection_id,
      tenantId: actor.tenantId,
      gateway: 'google_ads_native_action',
      accounts: [b.account_id],
      writeAccounts: [b.account_id],
      enabled: true,
      label: 'Synthetic',
      scopes: ['https://www.googleapis.com/auth/adwords'],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => Response.json(data.response(url, init))),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const out = await service.call(
    'amcp_campaign',
    {action: 'recipe_eligibility', recipe: ids[1], business: b, live: true},
    actor,
  );
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.data.status, 'unknown');
  const dep = id => out.data.dependencies.find(d => d.id === id);
  assert.equal(dep('account_default_conversion_goals').status, 'ready');
  assert.equal(dep('primary_conversion_actions').status, 'ready');
  assert.equal(dep('conversion_value_policy').status, 'ready');
  assert.equal(dep('campaign_target_roas').evidence.ratio, '3.5');
  for (const id of ['conversion_value_delivery', 'conversion_history_eligibility', 'provider_objective_acceptance'])
    assert.equal(dep(id).status, 'unknown');
  assert.equal(out.data.provider_mutations, 0);
  assert.equal(store.documents(actor.tenantId, 'campaign_run').length, 0);
  assert.ok(data.requests.every(r => r.path.endsWith('/googleAds:search')));
});

test('both value modes complete independent native reviews and exact read-back under a paused parent and replay no mutation', async t => {
  for (const id of ids) {
    const b = brief(id),
      f = googleSearchFixture(t, b, {native: true}),
      saved = await f.call({action: 'create_from_recipe', recipe: id, business: b});
    assert.equal(saved.success, true, JSON.stringify(saved));
    for (let i = 0; i < 6; i++) assert.equal((await next(f, saved.data.id)).data.current.status, 'verified');
    const run = f.store.document(f.actor.tenantId, 'campaign_run', saved.data.id),
      c = [...f.resources.values()].find(r => r.kind === 'campaign').value;
    assert.equal(run.state, 'complete');
    assert.equal(c.status, 'PAUSED');
    assert.deepEqual(c.maximizeConversionValue, id === ids[1] ? {targetRoas: 3.5} : {});
    assert.equal(f.mutations.length, 6);
    assert.ok(f.requests.some(r => /campaign.maximize_conversion_value.target_roas/.test(r.body.query ?? '')));
    assert.doesNotMatch(
      JSON.stringify(f.mutations),
      /amcpConversionValue|amcp_conversion_value|conversionGoals|valueRules/,
    );
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

test('wrong native ROAS, scalar type, strategy or missing target stops dependent work without resubmission', async t => {
  for (const [id, options] of [
    [ids[0], {wrongValueTarget: true}],
    [ids[1], {wrongValueTarget: true}],
    [ids[1], {valueTarget: '3.5'}],
    [ids[0], {valueTarget: null}],
    [ids[0], {valueTarget: false}],
    [ids[1], {omitValueTarget: true}],
    [ids[0], {wrongStrategy: true}],
    [ids[1], {omitStrategy: true}],
  ]) {
    const b = brief(id),
      f = googleSearchFixture(t, b, {native: true, ...options}),
      saved = await f.call({action: 'create_from_recipe', recipe: id, business: b});
    assert.equal(saved.success, true, JSON.stringify(saved));
    assert.equal((await next(f, saved.data.id)).data.current.status, 'verified');
    const accepted = await next(f, saved.data.id);
    assert.notEqual(accepted.data.current.status, 'verified', JSON.stringify(options));
    const continued = await f.call({action: 'prepare_next', id: saved.data.id});
    assert.equal(continued.success, true, JSON.stringify(continued));
    assert.equal(continued.data.review, undefined);
    assert.equal(f.mutations.length, 2);
    assert.ok(![...f.resources.values()].some(r => r.kind === 'adGroup'));
  }
});

test('untargeted implicit native zero and omitted message verify only through the exact selected strategy and target field', async t => {
  for (const options of [{valueTarget: 0}, {omitValueMessage: true}]) {
    const b = brief(ids[0]),
      f = googleSearchFixture(t, b, {native: true, ...options}),
      saved = await f.call({action: 'create_from_recipe', recipe: ids[0], business: b});
    assert.equal(saved.success, true, JSON.stringify(saved));
    await next(f, saved.data.id);
    assert.equal((await next(f, saved.data.id)).data.current.status, 'verified');
    assert.equal(f.mutations.length, 2);
  }
});

test('legacy value verification cache is reread with its original receipt; current proof cache and authority remain bounded', async t => {
  const b = brief(ids[0]),
    f = googleSearchFixture(t, b, {native: true}),
    saved = await f.call({action: 'create_from_recipe', recipe: ids[0], business: b});
  assert.equal(saved.success, true, JSON.stringify(saved));
  await next(f, saved.data.id);
  await next(f, saved.data.id);
  const run = f.store.document(f.actor.tenantId, 'campaign_run', saved.data.id),
    reviewId = run.steps[1].review_id;
  const original = f.store.db
    .prepare('SELECT state,result FROM idempotency WHERE tenant_id=? AND key=?')
    .get(f.actor.tenantId, reviewId);
  let proof = f.store.document(f.actor.tenantId, 'write_verification', reviewId);
  assert.equal(proof.verification_cache_version, 'google-campaign-value-roas-v1');
  const before = f.requests.length;
  const cached = await f.call({action: 'verify', review_id: reviewId});
  assert.equal(cached.success, true, JSON.stringify(cached));
  assert.equal(cached.data.cached, true);
  assert.equal(f.requests.length, before);
  delete proof.verification_cache_version;
  f.store.putDocument(f.actor.tenantId, 'write_verification', reviewId, proof);
  const c = [...f.resources.values()].find(r => r.kind === 'campaign').value;
  c.maximizeConversionValue.targetRoas = 2.5;
  const reread = await f.call({action: 'verify', review_id: reviewId});
  assert.equal(reread.success, true, JSON.stringify(reread));
  assert.equal(reread.data.status, 'inconclusive');
  assert.notEqual(reread.data.cached, true);
  assert.equal(reread.data.verification_cache_version, 'google-campaign-value-roas-v1');
  assert.ok(f.requests.length > before);
  assert.equal(f.mutations.length, 2);
  const settled = await f.call({action: 'verify', review_id: reviewId});
  assert.equal(settled.success, true, JSON.stringify(settled));
  assert.equal(settled.data.status, 'mismatch');
  assert.equal(f.mutations.length, 2);
  assert.deepEqual(
    f.store.db
      .prepare('SELECT state,result FROM idempotency WHERE tenant_id=? AND key=?')
      .get(f.actor.tenantId, reviewId),
    original,
  );
  f.store.putConnection(
    f.admin,
    {...f.connection, enabled: false},
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const count = f.requests.length;
  assert.equal((await f.call({action: 'verify', review_id: reviewId})).success, false);
  assert.equal(f.requests.length, count);
  assert.equal(f.mutations.length, 2);
});

test('pending value plans refresh legacy proof before using accepted predecessor outputs', async t => {
  for (const changed of [true, false]) {
    const b = brief(ids[0]),
      f = googleSearchFixture(t, b, {native: true}),
      saved = await f.call({action: 'create_from_recipe', recipe: ids[0], business: b});
    assert.equal(saved.success, true, JSON.stringify(saved));
    await next(f, saved.data.id);
    await next(f, saved.data.id);
    const run = f.store.document(f.actor.tenantId, 'campaign_run', saved.data.id),
      step = run.steps[1],
      reviewId = step.review_id;
    delete step.verification.verification_cache_version;
    f.store.putDocument(f.actor.tenantId, 'campaign_run', run.id, run);
    const proof = f.store.document(f.actor.tenantId, 'write_verification', reviewId);
    delete proof.verification_cache_version;
    f.store.putDocument(f.actor.tenantId, 'write_verification', reviewId, proof);
    const receipt = f.store.db
      .prepare('SELECT state,result FROM idempotency WHERE tenant_id=? AND key=?')
      .get(f.actor.tenantId, reviewId);
    if (changed)
      [...f.resources.values()].find(r => r.kind === 'campaign').value.maximizeConversionValue.targetRoas = 2.5;
    const resumed = await f.call({action: 'prepare_next', id: run.id});
    assert.equal(resumed.success, true, JSON.stringify(resumed));
    const current = f.store.document(f.actor.tenantId, 'campaign_run', run.id).steps[1];
    assert.equal(current.verification.verification_cache_version, 'google-campaign-value-roas-v1');
    if (changed) {
      assert.equal(resumed.data.review, undefined);
      assert.equal(current.status, 'verifying');
      const settled = await f.call({action: 'prepare_next', id: run.id});
      assert.equal(settled.success, true, JSON.stringify(settled));
      assert.equal(settled.data.review, undefined);
      assert.equal(f.store.document(f.actor.tenantId, 'campaign_run', run.id).steps[1].status, 'mismatch');
      assert.ok(![...f.resources.values()].some(r => r.kind === 'adGroup'));
    } else {
      assert.equal(current.status, 'verified');
      assert.ok(resumed.data.review?.review_id);
      assert.equal(resumed.data.step_id, 'targeting');
    }
    assert.equal(f.mutations.length, 2);
    assert.deepEqual(
      f.store.db
        .prepare('SELECT state,result FROM idempotency WHERE tenant_id=? AND key=?')
        .get(f.actor.tenantId, reviewId),
      receipt,
    );
  }
});

test('value drafts preserve reader, unconfirmed execution and current-login boundaries', async t => {
  const b = brief(ids[1]),
    f = googleSearchFixture(t, b, {native: true});
  assert.equal(
    (await f.call({action: 'create_from_recipe', recipe: ids[1], business: b}, {...f.actor, role: 'reader'})).success,
    false,
  );
  const saved = await f.call({action: 'create_from_recipe', recipe: ids[1], business: b});
  assert.equal(saved.success, true, JSON.stringify(saved));
  const p = await f.call({action: 'prepare_next', id: saved.data.id});
  assert.equal(p.success, true, JSON.stringify(p));
  assert.equal(
    (await f.call({action: 'execute_next', id: saved.data.id, review_id: p.data.review.review_id})).success,
    false,
  );
  assert.equal(f.mutations.length, 0);
  f.store.putConnection(
    f.admin,
    {...f.connection, enabled: false},
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const before = f.requests.length;
  assert.equal((await f.call({action: 'create_from_recipe', recipe: ids[1], business: b})).success, false);
  assert.equal(f.requests.length, before);
});

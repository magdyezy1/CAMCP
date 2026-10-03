import test from 'node:test';
import assert from 'node:assert/strict';
import {campaignRecipe, campaignRecipes} from '../dist/src/campaign-recipes.js';
import {recipeDependencies} from '../dist/src/capability-eligibility.js';
import {recipeContext} from '../dist/src/recipe-context.js';
import {fixture, actor, SNAP} from '../dist/tests/snapchat-plan-fixture.js';
import {trafficBusiness, trafficFixture} from './fixtures/snapchat-traffic-data.mjs';
const recipe = 'snapchat_website_traffic';

test('Snapchat website traffic discovery declares the reused creative, current grant and review dependencies', () => {
  const definition = campaignRecipes.find(r => r.id === recipe);
  assert.ok(definition, 'The guided Snapchat workflow is discoverable');
  assert.equal(definition.platform, 'snapchat');
  assert.ok(definition.required.includes('creative_id'));
  assert.ok(definition.required.includes('regulated_content'));
  assert.ok(definition.required.includes('start_time'));
  assert.deepEqual(recipeDependencies[recipe].actions, [
    'snapchat_campaign_create',
    'snapchat_adsquad_create',
    'snapchat_ad_create',
  ]);
  assert.ok(recipeDependencies[recipe].objects.includes('existing_website_creative'));
});

test('the Snapchat traffic brief compiles exact daily micros and verified predecessor references with every entity paused', () => {
  const before = JSON.stringify(trafficBusiness),
    plan = campaignRecipe(recipe, trafficBusiness);
  assert.equal(plan.steps.length, 3);
  assert.ok(plan.steps.every(s => s.gateway === 'snapchat_native_action' && s.expected_currency === 'USD'));
  const [c, s, a] = plan.steps;
  assert.equal(c.arguments.payload.campaigns[0].status, 'PAUSED');
  assert.deepEqual(c.arguments.payload.campaigns[0].objective_v2_properties, {objective_v2_type: 'TRAFFIC'});
  assert.equal(s.arguments.payload.adsquads[0].status, 'PAUSED');
  assert.equal(s.arguments.payload.adsquads[0].daily_budget_micro, '20000001');
  assert.equal(s.arguments.payload.adsquads[0].delivery_constraint, 'DAILY_BUDGET');
  assert.equal(s.arguments.payload.adsquads[0].optimization_goal, 'SWIPES');
  assert.equal(s.arguments.payload.adsquads[0].bid_strategy, 'AUTO_BID');
  assert.equal(s.arguments.payload.adsquads[0].bid_micro, undefined);
  assert.deepEqual(s.arguments.payload.adsquads[0].targeting.geos, [{country_code: 'sa', operation: 'INCLUDE'}]);
  assert.deepEqual(s.arguments.path_params.campaign_id, {$ref: 'campaign#/data/campaigns/0/campaign/id'});
  assert.deepEqual(a.arguments.path_params.ad_squad_id, {$ref: 'squad#/data/adsquads/0/adsquad/id'});
  assert.equal(a.arguments.payload.ads[0].type, 'REMOTE_WEBPAGE');
  assert.equal(a.arguments.payload.ads[0].status, 'PAUSED');
  assert.equal(a.arguments.payload.ads[0].creative_id, trafficBusiness.creative_id);
  assert.deepEqual(s.depends_on, ['campaign']);
  assert.deepEqual(a.depends_on, ['squad']);
  assert.equal(JSON.stringify(trafficBusiness), before);
  assert.match(plan.recipe.creative_acceptance, /unverified/i);
});

test('Snapchat traffic rejects missing or regulated inputs, invalid schedules, duplicate countries and unrepresentable budgets', () => {
  for (const [patch, code] of [
    [{regulated_content: true}, 'RECIPE_PREREQUISITES_REQUIRED'],
    [{regulated_content: 'false'}, 'RECIPE_INPUT_INVALID'],
    [{creative_id: '../other'}, 'RECIPE_INPUT_INVALID'],
    [{country_codes: ['SA', 'SA']}, 'RECIPE_INPUT_INVALID'],
    [{country_codes: ['USA']}, 'RECIPE_INPUT_INVALID'],
    [{daily_budget: '4.999999'}, 'INVALID_RECIPE_MONEY'],
    [{daily_budget: '20.0000001'}, 'INVALID_RECIPE_MONEY'],
    [{start_time: '2026-02-30T10:00:00+03:00'}, 'RECIPE_DATE_INVALID'],
    [{start_time: '2026-11-01T10:00:00'}, 'RECIPE_DATE_INVALID'],
    [{end_time: '2026-11-01T09:00:00+03:00'}, 'RECIPE_DATE_INVALID'],
  ])
    assert.throws(
      () => campaignRecipe(recipe, {...trafficBusiness, ...patch}),
      e => e.code === code,
      JSON.stringify(patch),
    );
  for (const key of ['creative_id', 'start_time', 'regulated_content']) {
    const b = {...trafficBusiness};
    delete b[key];
    assert.throws(
      () => campaignRecipe(recipe, b),
      e => e.code === 'RECIPE_INPUT_REQUIRED' && e.details.missing_fields.includes(key),
    );
  }
});

test('Snapchat recipe context resolves its own exact login and preserves current profile-bound target selection', t => {
  const f = fixture();
  t.after(() => f.close());
  const context = recipeContext(f.store, actor, recipe);
  assert.deepEqual(
    context.targets.map(t => ({connection_id: t.connection_id, account_id: t.account_id})),
    [{connection_id: SNAP, account_id: 'acct1'}],
  );
  assert.equal(f.requests.length, 0);
});

test('traffic prerequisites require current WEB_VIEW ownership and HTTPS syntax while approval remains unknown', async t => {
  for (const scenario of ['type', 'destination', 'missing_owner', 'partial', 'revoked', 'valid']) {
    const f = trafficFixture({
      endlessCreativePages: scenario === 'partial',
      beforeCreativeRead:
        scenario === 'revoked'
          ? f => {
              const c = f.store.resolveConnection(actor, 'snapchat_native_action', 'acct1', SNAP);
              f.store.putConnection({...actor, role: 'admin'}, {...c, enabled: false}, {accessToken: 'synthetic'});
            }
          : undefined,
    });
    t.after(() => f.close());
    if (scenario === 'type') f.creative.type = 'SNAP_AD';
    if (scenario === 'destination') f.creative.web_view_properties.url = 'http://example.test';
    if (scenario === 'missing_owner') delete f.creative.ad_account_id;
    const out = await f.call({action: 'recipe_eligibility', recipe, business: trafficBusiness, live: true});
    if (scenario === 'valid') {
      assert.equal(out.success, true, JSON.stringify(out.error));
      assert.equal(out.data.dependencies.find(d => d.id === 'existing_website_creative').status, 'ready');
      assert.equal(out.data.dependencies.find(d => d.id === 'provider_objective_acceptance').status, 'unknown');
      assert.equal(out.data.dependencies.find(d => d.id === 'landing_page').status, 'unknown');
    } else
      assert.ok(
        !out.success || out.data.status === 'blocked',
        scenario + ': ' + JSON.stringify(out.error ?? out.data.blockers),
      );
    assert.equal(f.writes.length + f.adWrites.length, 0);
    if (scenario === 'partial')
      assert.ok(f.requests.length <= 26, 'Bound the collection to 25 pages and one account read');
  }
});

async function launch(f, business = trafficBusiness) {
  const created = await f.call({action: 'create_from_recipe', recipe, business});
  assert.equal(created.success, true, JSON.stringify(created));
  const id = created.data.id,
    preview = await f.call({action: 'approve', id});
  assert.equal(preview.success, true, JSON.stringify(preview));
  const approved = await f.call({action: 'approve', id, confirmed: true, plan_hash: preview.data.plan_hash});
  assert.equal(approved.success, true, JSON.stringify(approved));
  let result = await f.call({action: 'run', id});
  for (let n = 0; n < 4 && result.success && result.data.run?.stopped === 'needs_spend_change_confirmed'; n++) {
    // A synthetic operator approves the exact native review separately. Whole-plan approval never supplies this flag.
    const next = result.data.next_call.arguments;
    const executed = await f.call({...next, confirmed: true, spend_change_confirmed: true});
    if (!executed.success) {
      result = executed;
      break;
    }
    result = await f.call({action: 'run', id});
  }
  return {id, result};
}

test('the guided Snapchat campaign uses existing native reviews and verified receipts before resolving later IDs', async t => {
  const f = trafficFixture();
  t.after(() => f.close());
  const read = await f.readCreative();
  assert.equal(read.success, true, JSON.stringify(read));
  const preview = await f.call({action: 'preview_recipe', recipe, business: trafficBusiness});
  assert.equal(preview.success, true, JSON.stringify(preview));
  assert.equal(f.writes.length + f.adWrites.length, 0);
  const {id, result} = await launch(f);
  assert.equal(result.success, true, JSON.stringify(result));
  const full = await f.call({action: 'get', id, detail: 'full'});
  assert.equal(
    full.data.state,
    'complete',
    JSON.stringify({
      state: full.data.state,
      steps: full.data.steps.map(s => ({id: s.id, status: s.status, error: s.error?.code})),
    }),
  );
  assert.deepEqual(
    full.data.steps.map(s => s.status),
    ['verified', 'verified', 'verified'],
  );
  assert.equal(f.writes.length, 2);
  assert.equal(f.adWrites.length, 1);
  assert.equal(f.adWrites[0].body.ads[0].ad_squad_id, 'squad1');
  assert.equal(f.adWrites[0].body.ads[0].creative_id, trafficBusiness.creative_id);
  assert.equal(f.ads[0].status, 'PAUSED');
  const repeated = await f.call({action: 'run', id, confirmed: true, spend_change_confirmed: true});
  assert.equal(repeated.success, true, JSON.stringify(repeated));
  assert.equal(f.writes.length + f.adWrites.length, 3, 'A completed plan cannot submit duplicate entities');
});

test('a foreign creative or mismatched native ad read-back cannot be used as a verified traffic launch', async t => {
  for (const scenario of ['foreign', 'drift']) {
    const f = trafficFixture({driftAd: scenario === 'drift'});
    t.after(() => f.close());
    const read = await f.readCreative();
    assert.equal(read.success, true, JSON.stringify(read));
    const business = {
      ...trafficBusiness,
      ...(scenario === 'foreign' ? {creative_id: '99999999-9999-4999-8999-999999999999'} : {}),
    };
    const {id} = await launch(f, business),
      full = await f.call({action: 'get', id, detail: 'full'});
    assert.notEqual(
      full.data.state,
      'complete',
      JSON.stringify({
        state: full.data.state,
        steps: full.data.steps.map(s => ({id: s.id, status: s.status, error: s.error?.code})),
      }),
    );
    assert.notEqual(full.data.steps[2].status, 'verified');
    if (scenario === 'foreign') {
      assert.equal(
        f.writes.length + f.adWrites.length,
        0,
        'A foreign creative must fail preflight before creating predecessors',
      );
      assert.equal(full.data.preflight.status, 'blocked');
    } else {
      assert.equal(f.writes.length, 2, 'Both paused predecessors reached their native reviews');
      assert.equal(f.adWrites.length, 1, 'The read-back mismatch followed one accepted ad');
    }
  }
});

test('an accepted ad with a lost receipt stays uncertain and cannot be automatically submitted again', async t => {
  const f = trafficFixture({lostAdReceipt: true});
  t.after(() => f.close());
  const read = await f.readCreative();
  assert.equal(read.success, true, JSON.stringify(read));
  const {id} = await launch(f),
    full = await f.call({action: 'get', id, detail: 'full'});
  assert.equal(
    full.data.steps[2].status,
    'uncertain',
    JSON.stringify({status: full.data.steps[2].status, error: full.data.steps[2].error?.code}),
  );
  assert.equal(f.adWrites.length, 1);
  await f.call({action: 'run', id, confirmed: true, spend_change_confirmed: true});
  assert.equal(f.adWrites.length, 1, 'Never replay an ambiguous accepted ad');
});

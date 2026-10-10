import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {campaignRecipe, campaignRecipes} from '../dist/src/campaign-recipes.js';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {recipeDependencies} from '../dist/src/capability-eligibility.js';
const {cpc_bid, ...shared} = JSON.parse(
  fs.readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'),
).recipe_business;
// CMP-04: a Google recipe is one all-or-nothing build by default; these tests cover its per-resource steps.
const base = {...shared, atomic: false};
const business = {...base, cpc_bid_ceiling: '1.250001'},
  recipe = 'google_search_clicks';
const created = (plan, id) => plan.steps.find(s => s.id === id).arguments.payload.operations[0].create;
test('Maximize Clicks discovery requires an explicit campaign ceiling and qualified native dependencies', () => {
  const definition = campaignRecipes.find(r => r.id === recipe);
  assert.ok(definition);
  assert.ok(definition.required.includes('cpc_bid_ceiling'));
  assert.ok(!definition.required.includes('cpc_bid'));
  assert.equal(recipeDependencies[recipe].objective, 'search_clicks');
  assert.deepEqual(recipeDependencies[recipe].actions, recipeDependencies.google_search.actions);
});
test('a paused Search click plan uses exact native ceiling micros and never a manual or deprecated spend target', () => {
  const plan = campaignRecipe(recipe, business),
    campaign = created(plan, 'campaign'),
    group = created(plan, 'adgroup');
  assert.deepEqual(campaign.target_spend, {cpc_bid_ceiling_micros: '1250001'});
  assert.equal(campaign.status, 'PAUSED');
  assert.equal(campaign.manual_cpc, undefined);
  assert.equal(campaign.bidding_strategy, undefined);
  assert.equal(group.cpc_bid_micros, undefined);
  assert.equal(group.status, 'ENABLED');
  assert.deepEqual(campaign.network_settings, {
    target_google_search: true,
    target_search_network: false,
    target_content_network: false,
    target_partner_search_network: false,
  });
  assert.equal(plan.recipe.bidding_strategy, 'TARGET_SPEND');
  assert.equal(plan.recipe.cpc_bid_ceiling_micros, '1250001');
  assert.equal(plan.steps.length, 6);
  assert.equal(plan.recipe.geo_warning, null);
});
test('click plans refuse absent, rounded, invalid or contradictory bidding inputs', () => {
  for (const value of [undefined, null, 0, 1.25, true, '', '0', '-1', '1e3', '0.0000001', '9007199254.740992']) {
    assert.throws(
      () => campaignRecipe(recipe, {...business, cpc_bid_ceiling: value}),
      e => ['RECIPE_INPUT_REQUIRED', 'INVALID_RECIPE_MONEY'].includes(e.code),
      String(value),
    );
  }
  for (const field of [
    'cpc_bid',
    'target_cpa',
    'target_roas',
    'bidding_strategy',
    'manual_cpc',
    'target_spend',
    'maximize_conversions',
    'maximize_conversion_value',
  ]) {
    assert.throws(
      () => campaignRecipe(recipe, {...business, [field]: 'unexpected'}),
      e => e.code === 'RECIPE_INPUT_INVALID',
      field,
    );
  }
  const p = campaignRecipe(recipe, {...business, cpc_bid_ceiling: '0001.000001'});
  assert.equal(created(p, 'campaign').target_spend.cpc_bid_ceiling_micros, '1000001');
});
test('click plans preserve complete split targeting, original copy and account-timezone dates', () => {
  const p = campaignRecipe(recipe, {
    ...business,
    country_criterion_ids: Array.from({length: 20}, (_, i) => String(2000 + i)),
    language_criterion_ids: Array.from({length: 10}, (_, i) => String(1000 + i)),
    start_date: '2026-11-01',
    end_date: '2026-11-30',
  });
  const targets = p.steps.filter(s => s.id.startsWith('targeting'));
  assert.deepEqual(
    targets.map(s => s.arguments.payload.operations.length),
    [25, 5],
  );
  assert.equal(created(p, 'campaign').start_date_time, '2026-11-01 00:00:00');
  assert.equal(created(p, 'campaign').end_date_time, '2026-11-30 23:59:59');
  assert.deepEqual(
    created(p, 'ad').ad.responsive_search_ad.headlines,
    business.headlines.map(text => ({text})),
  );
  assert.equal(created(p, 'ad').status, 'ENABLED');
  assert.throws(() => campaignRecipe(recipe, {...business, start_date: '2026-02-30'}));
  assert.throws(() => campaignRecipe(recipe, {...business, contains_eu_political_advertising: 'UNKNOWN'}));
});
function fixture(t, native = false, options = {}) {
  const actor = {tenantId: 'click-recipe', userId: 'operator', role: 'operator'},
    admin = {...actor, role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 108).toString('base64')),
    requests = [],
    resources = new Map(),
    mutations = [];
  t.after(() => store.close());
  const connection = {
    id: business.connection_id,
    tenantId: actor.tenantId,
    gateway: 'google_ads_native_action',
    accounts: [business.account_id],
    writeAccounts: [business.account_id],
    enabled: true,
    label: 'Synthetic',
    scopes: ['https://www.googleapis.com/auth/adwords'],
  };
  store.putConnection(admin, connection, {accessToken: 'synthetic', developerToken: 'synthetic'});
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      const body = JSON.parse(init.body),
        path = new URL(url).pathname;
      requests.push({url: String(url), body});
      if (!native || / FROM customer(?: |$)/.test(body.query ?? '')) {
        assert.match(String(url), /googleAds:search$/);
        return Response.json({results: [{customer: {id: business.account_id, currencyCode: 'USD', timeZone: 'UTC'}}]});
      }
      const kinds = {
        campaignBudgets: 'campaignBudget',
        campaigns: 'campaign',
        campaignCriteria: 'campaignCriterion',
        adGroups: 'adGroup',
        adGroupCriteria: 'adGroupCriterion',
        adGroupAds: 'adGroupAd',
      };
      if (path.endsWith('googleAds:search')) {
        const from = / FROM ([a-z_]+)/.exec(body.query)?.[1],
          kind = from?.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
        if (from === 'geo_target_constant' || from === 'language_constant')
          return Response.json({
            results: (from === 'geo_target_constant'
              ? business.country_criterion_ids
              : business.language_criterion_ids
            ).map(id => ({
              [kind]: {
                id,
                name: 'Synthetic',
                resourceName: (from === 'geo_target_constant' ? 'geoTargetConstants/' : 'languageConstants/') + id,
                countryCode: 'US',
                code: 'en',
                status: 'ENABLED',
              },
            })),
          });
        const names = [...body.query.matchAll(/'(customers\/[^']+)'/g)].map(m => m[1]);
        return Response.json({
          results: [...resources.values()]
            .filter(r => r.kind === kind && (!names.length || names.includes(r.value.resourceName)))
            .map(r => ({
              [kind]: r.value,
              ...(kind === 'adGroup' && /\bcampaign\./.test(body.query)
                ? {campaign: resources.get(r.value.campaign)?.value}
                : {}),
            })),
        });
      }
      assert.ok(native);
      const collection = /\/([A-Za-z]+):mutate$/.exec(path)?.[1];
      assert.ok(kinds[collection], path);
      mutations.push({path, body});
      return Response.json({
        results: body.operations.map(op => {
          assert.ok(op.create);
          const id = String(resources.size + 1),
            value = structuredClone(op.create),
            parent = (value.campaign ?? value.adGroup ?? '').split('/').at(-1);
          const resourceName = `customers/${business.account_id}/${collection}/${['campaignCriteria', 'adGroupCriteria', 'adGroupAds'].includes(collection) ? parent + '~' : ''}${id}`;
          Object.assign(value, {resourceName, id});
          if (collection === 'campaigns') {
            value.biddingStrategyType = 'TARGET_SPEND';
            if (options.wrongCeiling) value.targetSpend.cpcBidCeilingMicros = '9999999';
          }
          resources.set(resourceName, {kind: kinds[collection], value});
          return {resourceName};
        }),
      });
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  return {
    actor,
    admin,
    store,
    service,
    requests,
    connection,
    resources,
    mutations,
    call: (input, as = actor) => service.call('amcp_campaign', input, as),
  };
}
test('context, preview and saved provenance preserve the new recipe with no native calls', async t => {
  const f = fixture(t);
  f.store.putDocument(f.actor.tenantId, 'client_profile', 'profile', {
    name: 'Client',
    approved_by: 'admin',
    defaults: {recipes: {[recipe]: {currency: 'USD', cpc_bid_ceiling: '2.000001'}}},
  });
  const context = await f.call({action: 'recipe_context', recipe, profile_id: 'profile'});
  assert.equal(context.success, true, JSON.stringify(context));
  const preview = await f.call({action: 'preview_recipe', recipe, business});
  assert.equal(preview.success, true, JSON.stringify(preview));
  assert.equal(preview.data.ready, true);
  assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
  const {cpc_bid_ceiling, ...rest} = business;
  const saved = await f.call({action: 'create_from_recipe', recipe, profile_id: 'profile', business: rest});
  assert.equal(saved.success, true, JSON.stringify(saved));
  assert.equal(saved.data.recipe.provenance.fields.cpc_bid_ceiling.source, 'approved_profile');
  const full = await f.call({action: 'get', id: saved.data.id, detail: 'full'});
  assert.equal(created(full.data, 'campaign').target_spend.cpc_bid_ceiling_micros, '2000001');
  assert.equal(full.data.state, 'draft');
  assert.equal(f.requests.length, 0);
  assert.equal(
    (await f.call({action: 'create_from_recipe', recipe, business}, {...f.actor, role: 'reader'})).success,
    false,
  );
  f.store.putConnection(
    f.admin,
    {...f.connection, enabled: false},
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  assert.equal((await f.call({action: 'create_from_recipe', recipe, business})).success, false);
  assert.equal(f.requests.length, 0);
});
test('the existing manual-CPC Search recipe retains its original bid semantics', () => {
  const p = campaignRecipe('google_search', {...base, cpc_bid});
  assert.deepEqual(created(p, 'campaign').manual_cpc, {});
  assert.equal(created(p, 'campaign').target_spend, undefined);
  assert.ok(created(p, 'adgroup').cpc_bid_micros);
});

test('every generated click step compiles through the pinned native gateway without submitting', async t => {
  const f = fixture(t),
    plan = campaignRecipe(recipe, business);
  const refs = {
    budget: `customers/${business.account_id}/campaignBudgets/1`,
    campaign: `customers/${business.account_id}/campaigns/2`,
    adgroup: `customers/${business.account_id}/adGroups/3`,
  };
  const resolve = value =>
    Array.isArray(value)
      ? value.map(resolve)
      : value && typeof value === 'object'
        ? value.$ref
          ? refs[value.$ref.split('#')[0]]
          : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)]))
        : value;
  for (const step of plan.steps) {
    const out = await f.service.call(
      'google_ads_native_action',
      {
        ...resolve(step.arguments),
        account_id: business.account_id,
        connection_id: business.connection_id,
        dry_run: true,
      },
      f.actor,
    );
    assert.equal(out.success, true, step.id + ': ' + JSON.stringify(out));
    if (step.id === 'campaign') {
      assert.match(JSON.stringify(out), /1250001/);
      assert.doesNotMatch(JSON.stringify(out), /targetSpendMicros|target_spend_micros|manualCpc|manual_cpc/);
    }
  }
  assert.equal(f.requests.length, 0);
});

test('a Maximize Clicks draft completes native review, exact execution and read-back without activating its campaign', async t => {
  const f = fixture(t, true),
    saved = await f.call({action: 'create_from_recipe', recipe, business});
  assert.equal(saved.success, true, JSON.stringify(saved));
  assert.equal(f.mutations.length, 0);
  for (let i = 0; i < 6; i++) {
    const prepared = await f.call({action: 'prepare_next', id: saved.data.id});
    assert.equal(prepared.success, true, JSON.stringify(prepared));
    assert.ok(prepared.data.review?.review_id, JSON.stringify(prepared));
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
  const run = f.store.document(f.actor.tenantId, 'campaign_run', saved.data.id);
  assert.equal(run.state, 'complete');
  const campaign = [...f.resources.values()].find(r => r.kind === 'campaign').value;
  assert.equal(campaign.status, 'PAUSED');
  assert.deepEqual(campaign.targetSpend, {cpcBidCeilingMicros: '1250001'});
  assert.equal(f.mutations.length, 6);
  const replay = await f.call({
    action: 'execute_next',
    id: run.id,
    review_id: run.steps.at(-1).review_id,
    confirmed: true,
    spend_change_confirmed: true,
  });
  assert.equal(replay.success, true, JSON.stringify(replay));
  assert.equal(f.mutations.length, 6);
});

test('an accepted campaign with a different native CPC ceiling never verifies or advances dependent work', async t => {
  const f = fixture(t, true, {wrongCeiling: true}),
    saved = await f.call({action: 'create_from_recipe', recipe, business});
  assert.equal(saved.success, true, JSON.stringify(saved));
  for (let i = 0; i < 2; i++) {
    const prepared = await f.call({action: 'prepare_next', id: saved.data.id});
    assert.equal(prepared.success, true, JSON.stringify(prepared));
    assert.ok(prepared.data.review?.review_id, JSON.stringify(prepared));
    const executed = await f.call({
      action: 'execute_next',
      id: saved.data.id,
      review_id: prepared.data.review.review_id,
      confirmed: true,
      spend_change_confirmed: true,
    });
    assert.equal(executed.success, true, JSON.stringify(executed));
    assert.equal(executed.data.current.status, i === 0 ? 'verified' : 'verifying', JSON.stringify(executed));
    if (i === 1) {
      assert.equal(executed.data.current.verification.status, 'inconclusive');
      assert.deepEqual(executed.data.current.verification.checks[0].changed_fields, [
        '/target_spend/cpc_bid_ceiling_micros',
      ]);
    }
  }
  assert.equal(f.mutations.length, 2);
  const retry = await f.call({action: 'prepare_next', id: saved.data.id});
  assert.equal(retry.success, true, JSON.stringify(retry));
  assert.equal(retry.data.current.status, 'mismatch', JSON.stringify(retry));
  assert.equal(retry.data.review, undefined);
  assert.equal(f.mutations.length, 2);
  assert.equal(
    [...f.resources.values()].some(r => r.kind === 'adGroup'),
    false,
  );
});

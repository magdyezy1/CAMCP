// R2.5 field3, package r25-field3-recipes, AMCP-08 (F8-1, F8-2): every recipe says the values its inputs accept, and one reader judges them.
// The owner's session abandoned the Performance Max recipe because `account_default` was refused, `false` for the EU declaration read as
// "missing", and no recipe on any platform listed its accepted values. Everything here is synthetic and nothing reaches a provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {campaignRecipe, campaignRecipes} from '../dist/src/campaign-recipes.js';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {pinBeforeTiktokCutoff} from './helpers/tiktok-cutoff-clock.mjs';

const examples = JSON.parse(readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'));
const {cpc_bid: _cpcBid, ...googleShared} = examples.recipe_business;
const EU = ['CONTAINS_EU_POLITICAL_ADVERTISING', 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING'];
// A valid brief for every recipe of the catalog, from the guide's own synthetic examples.
const goals = {conversion_goal_policy: 'ACCOUNT_DEFAULT'},
  values = {...goals, conversion_value_policy: 'ACCOUNT_RECORDED_VALUES'},
  metaConversion = {pixel_id: '456', click_attribution_days: '7', view_attribution_days: '1'};
const briefs = {
  google_search: {...googleShared, cpc_bid: '1.25'},
  google_search_clicks: {...googleShared, cpc_bid_ceiling: '1.25'},
  google_search_conversions: {...googleShared, ...goals},
  google_search_target_cpa: {...googleShared, ...goals, target_cpa: '15'},
  google_search_conversion_value: {...googleShared, ...values},
  google_search_target_roas: {...googleShared, ...values, target_roas: '3.5'},
  google_performance_max: examples.google_pmax_business,
  meta_website_traffic: examples.recipe_business,
  meta_website_sales: {...examples.recipe_business, ...metaConversion},
  meta_website_leads: {...examples.recipe_business, ...metaConversion},
  microsoft_search: examples.recipe_business,
  snapchat_website_traffic: examples.snapchat_traffic_business,
  snapchat_lead_generation: examples.snapchat_lead_business,
  tiktok_website_traffic: examples.tiktok_traffic_business,
  tiktok_website_conversions: examples.tiktok_conversion_business,
  tiktok_search_traffic: examples.tiktok_search_business,
  tiktok_smart_plus_website_traffic: examples.tiktok_smart_plus_traffic_business,
  tiktok_smart_plus_website_conversions: examples.tiktok_smart_plus_conversion_business,
  tiktok_smart_plus_search_website: examples.tiktok_smart_plus_search_business,
  linkedin_lead_generation: examples.linkedin_lead_business,
};
// The one-resource-per-step form of a Google Search recipe, so a test can read its campaign create.
const compile = (id, patch = {}) =>
  campaignRecipe(id, {...briefs[id], ...(id.startsWith('google_search') ? {atomic: false} : {}), ...patch});
const campaignCreate = plan => plan.steps.find(s => s.id === 'campaign').arguments.payload.operations[0].create;
const pmaxCampaign = plan =>
  plan.steps[0].arguments.payload.mutate_operations.find(o => o.campaign_operation).campaign_operation.create;
const refusedAs = (fn, code, check = () => true) => assert.throws(fn, e => assertRefused(e, code) && check(e));

test('every recipe of the catalog has a brief here, and every brief compiles', t => {
  pinBeforeTiktokCutoff(t);
  assert.deepEqual(Object.keys(briefs).sort(), campaignRecipes.map(r => r.id).sort());
  for (const id of Object.keys(briefs)) assert.ok(compile(id).steps.length, id);
});

test('R3: every recipe declares its inputs, and each closed set is a plain list of values with no prose', () => {
  for (const definition of campaignRecipes) {
    assert.equal(typeof definition.inputs, 'object', definition.id + ' declares inputs');
    assert.ok(definition.inputs !== null && !Array.isArray(definition.inputs), definition.id);
    for (const [key, spec] of Object.entries(definition.inputs)) {
      const where = definition.id + '.' + key;
      assert.ok(
        [...definition.required, ...(definition.optional ?? [])].includes(key),
        where + ' is an input the recipe names in required or optional',
      );
      assert.ok(['enum', 'integer', 'boolean', 'text', 'list'].includes(spec.type), where + ' has a type');
      assert.deepEqual(
        Object.keys(spec).filter(
          k => !['type', 'values', 'case_insensitive', 'accepts_boolean', 'min', 'max'].includes(k),
        ),
        [],
        where + ' says nothing but its type, values, case folding, boolean form and bounds',
      );
      if (spec.type === 'enum' || spec.type === 'integer' || spec.type === 'boolean') {
        assert.ok(Array.isArray(spec.values) && spec.values.length > 0, where + ' lists its values');
        assert.equal(new Set(spec.values).size, spec.values.length, where + ' lists each value once');
      }
      if (spec.accepts_boolean) {
        assert.deepEqual(Object.keys(spec.accepts_boolean).sort(), ['false', 'true'], where);
        for (const v of Object.values(spec.accepts_boolean))
          assert.ok(spec.values.includes(v), where + ' maps to a listed value');
      }
    }
  }
});

test('R3 (meta-test): the values each recipe declares are exactly the ones its builder accepts, in every platform', t => {
  pinBeforeTiktokCutoff(t);
  // An input that a brief can only give together with another one is given with it (TikTok Smart+ Search: a purchase event needs the
  // CONVERT goal, and the CONVERT goal needs a pixel and an event).
  // The BC_AUTH_TT identity is tied to its Business Center ID, and only it is.
  const together = {
    'tiktok_smart_plus_search_website.optimization_event': () => ({optimization_goal: 'CONVERT', pixel_id: '456'}),
    'tiktok_smart_plus_search_website.optimization_goal': value =>
      String(value).toUpperCase() === 'CONVERT' ? {pixel_id: '456', optimization_event: 'SHOPPING'} : {},
    ...Object.fromEntries(
      campaignRecipes
        .filter(r => r.platform === 'tiktok')
        .map(r => [
          r.id + '.identity_type',
          value => (String(value).toUpperCase() === 'BC_AUTH_TT' ? {identity_authorized_bc_id: '77'} : {}),
        ]),
    ),
  };
  const inputsChecked = [];
  for (const definition of campaignRecipes)
    for (const [key, spec] of Object.entries(definition.inputs)) {
      if (spec.type !== 'enum' && spec.type !== 'integer') continue;
      inputsChecked.push(definition.id + '.' + key);
      const extra = value => together[definition.id + '.' + key]?.(value) ?? {},
        id = definition.id,
        base = value => ({[key]: value, ...extra(value)}),
        plan = value => compile(id, base(value));
      for (const value of spec.values) {
        const canonical = JSON.stringify(plan(value));
        // The canonical value, and a number or text form of a whole number, compile to one plan.
        if (spec.type === 'integer')
          assert.equal(JSON.stringify(plan(String(value))), canonical, id + ' ' + key + ' ' + value);
        if (spec.case_insensitive && typeof value === 'string') {
          assert.equal(JSON.stringify(plan(value.toLowerCase())), canonical, id + ' ' + key + ' folded ' + value);
          // Only letters are folded: a space around the value, or a lookalike letter, is a different value.
          refusedAs(
            () => plan(' ' + value),
            'RECIPE_INPUT_INVALID',
            e => e.details.field === key,
          );
          refusedAs(
            () => plan(value + ' '),
            'RECIPE_INPUT_INVALID',
            e => e.details.field === key,
          );
        }
      }
      // A value outside the set says the set, and the input it is about; a wrong type says the type it received.
      const outside = spec.type === 'integer' ? 99 : 'NOT_A_DECLARED_VALUE';
      refusedAs(
        () => plan(outside),
        'RECIPE_INPUT_INVALID',
        e => e.details.field === key && JSON.stringify(e.details.allowed) === JSON.stringify(spec.values),
      );
      for (const [wrong, type] of [
        [{}, 'object'],
        [['x'], 'array'],
        [null, 'null'],
        ...(spec.accepts_boolean ? [] : [[true, 'boolean']]),
        ...(spec.type === 'integer' ? [] : [[7, 'number']]),
      ])
        refusedAs(
          () => plan(wrong),
          'RECIPE_INPUT_INVALID',
          e => e.details.field === key && e.details.received_type === type && Array.isArray(e.details.allowed),
        );
    }
  // The table of closed sets the analysis lists for AMCP-08: nothing in it is left without a declaration.
  for (const expected of [
    'google_search.contains_eu_political_advertising',
    'google_search_clicks.contains_eu_political_advertising',
    'google_search_conversions.conversion_goal_policy',
    'google_search_target_cpa.conversion_goal_policy',
    'google_search_conversion_value.conversion_goal_policy',
    'google_search_conversion_value.conversion_value_policy',
    'google_search_target_roas.conversion_value_policy',
    'google_performance_max.conversion_goal_policy',
    'google_performance_max.contains_eu_political_advertising',
    'linkedin_lead_generation.political_intent',
    'linkedin_lead_generation.call_to_action',
    'snapchat_lead_generation.optimization_goal',
    'tiktok_website_traffic.identity_type',
    'tiktok_website_traffic.call_to_action',
    'tiktok_website_conversions.identity_type',
    'tiktok_website_conversions.optimization_event',
    'tiktok_search_traffic.identity_type',
    'tiktok_smart_plus_website_traffic.identity_type',
    'tiktok_smart_plus_website_traffic.optimization_goal',
    'tiktok_smart_plus_website_conversions.optimization_event',
    'tiktok_smart_plus_search_website.optimization_goal',
    'tiktok_smart_plus_search_website.optimization_event',
    'meta_website_sales.click_attribution_days',
    'meta_website_sales.view_attribution_days',
    'meta_website_leads.click_attribution_days',
  ])
    assert.ok(inputsChecked.includes(expected), expected + ' is declared');
});

test('R1: account_default is ACCOUNT_DEFAULT, in every Google recipe that takes a conversion goal policy', () => {
  for (const id of [
    'google_search_conversions',
    'google_search_target_cpa',
    'google_search_conversion_value',
    'google_search_target_roas',
    'google_performance_max',
  ])
    for (const given of ['account_default', 'Account_Default', 'ACCOUNT_DEFAULT']) {
      const plan = compile(id, {conversion_goal_policy: given});
      assert.equal(plan.recipe.conversion_goal_policy, 'ACCOUNT_DEFAULT', id + ' ' + given);
    }
  for (const id of ['google_search_conversion_value', 'google_search_target_roas'])
    assert.equal(
      compile(id, {conversion_value_policy: 'account_recorded_values'}).recipe.conversion_value_policy,
      'ACCOUNT_RECORDED_VALUES',
      id,
    );
});

test('R2: the EU declaration takes true and false as the two exact values, and calls anything else invalid, never missing', () => {
  const ids = [
    'google_search',
    'google_search_clicks',
    'google_search_conversions',
    'google_search_target_cpa',
    'google_search_conversion_value',
    'google_search_target_roas',
    'google_performance_max',
  ];
  const declared = plan =>
    (plan.steps[0].id === 'build' ? pmaxCampaign(plan) : campaignCreate(plan)).contains_eu_political_advertising;
  for (const id of ids) {
    assert.equal(declared(compile(id, {contains_eu_political_advertising: false})), EU[1], id + ' false');
    assert.equal(declared(compile(id, {contains_eu_political_advertising: true})), EU[0], id + ' true');
    assert.equal(
      declared(compile(id, {contains_eu_political_advertising: 'does_not_contain_eu_political_advertising'})),
      EU[1],
      id,
    );
    assert.equal(declared(compile(id, {contains_eu_political_advertising: EU[0]})), EU[0], id);
    for (const [wrong, type] of [
      ['no', 'string'],
      ['yes', 'string'],
      [' ' + EU[1], 'string'],
      [0, 'number'],
      [1, 'number'],
      [null, 'null'],
      [[], 'array'],
      [{}, 'object'],
    ])
      refusedAs(
        () => compile(id, {contains_eu_political_advertising: wrong}),
        'RECIPE_INPUT_INVALID',
        e =>
          e.details.field === 'contains_eu_political_advertising' &&
          e.details.received_type === type &&
          JSON.stringify(e.details.allowed) === JSON.stringify(EU),
      );
  }
});

test('N2: a declaration is never defaulted: left out or blank, it is still required, and says which field', () => {
  for (const id of [
    'google_search',
    'google_search_clicks',
    'google_search_conversions',
    'google_search_target_cpa',
    'google_search_conversion_value',
    'google_search_target_roas',
    'google_performance_max',
  ])
    for (const left of [undefined, '']) {
      const brief = {...briefs[id], ...(id.startsWith('google_search') ? {atomic: false} : {})};
      if (left === undefined) delete brief.contains_eu_political_advertising;
      else brief.contains_eu_political_advertising = left;
      refusedAs(
        () => campaignRecipe(id, brief),
        'RECIPE_INPUT_REQUIRED',
        e => e.details.missing_fields.includes('contains_eu_political_advertising'),
      );
    }
  for (const id of ['google_search_conversions', 'google_performance_max']) {
    const brief = {...briefs[id], ...(id === 'google_performance_max' ? {} : {atomic: false})};
    delete brief.conversion_goal_policy;
    refusedAs(
      () => campaignRecipe(id, brief),
      'RECIPE_INPUT_REQUIRED',
      e => e.details.missing_fields.includes('conversion_goal_policy'),
    );
  }
});

test('N3: a conversion goal policy outside the set is still invalid, and the refusal lists what is accepted', () => {
  for (const id of ['google_search_conversions', 'google_search_target_cpa', 'google_performance_max'])
    for (const custom of ['custom', 'CUSTOM', 'CAMPAIGN_SPECIFIC', 'account default', 'ACCOUNT_DEFAULT ']) {
      refusedAs(
        () => compile(id, {conversion_goal_policy: custom}),
        'RECIPE_INPUT_INVALID',
        e =>
          e.details.field === 'conversion_goal_policy' &&
          JSON.stringify(e.details.allowed) === JSON.stringify(['ACCOUNT_DEFAULT']),
      );
    }
});

test('R7: Snapchat swipes, TikTok tt_user and LinkedIn not_political are accepted case-folded and give the canonical value', t => {
  pinBeforeTiktokCutoff(t);
  const snapchat = compile('snapchat_lead_generation', {optimization_goal: 'swipes'});
  assert.equal(snapchat.recipe.optimization_goal, 'SWIPES');
  assert.equal(snapchat.steps[1].arguments.payload.adsquads[0].optimization_goal, 'SWIPES');
  for (const id of ['tiktok_website_traffic', 'tiktok_search_traffic', 'tiktok_smart_plus_website_traffic']) {
    const plan = compile(id, {identity_type: 'tt_user'});
    assert.equal(plan.recipe.creative.identity_type, 'TT_USER', id);
    assert.ok(JSON.stringify(plan.steps).includes('"identity_type":"TT_USER"'), id);
    assert.ok(!JSON.stringify(plan).includes('tt_user'), id + ' carries the canonical value only');
  }
  const linkedin = compile('linkedin_lead_generation', {political_intent: 'not_political', call_to_action: 'sign_up'});
  assert.equal(linkedin.recipe.political_intent, 'NOT_POLITICAL');
  assert.equal(linkedin.recipe.call_to_action, 'SIGN_UP');
  assert.equal(linkedin.steps[1].arguments.payload.politicalIntent, 'NOT_POLITICAL');
  assert.equal(linkedin.steps[2].arguments.payload.leadgenCallToAction.label, 'SIGN_UP');
  // BC_AUTH_TT stays tied to its Business Center, whatever the case it was given in.
  refusedAs(
    () => compile('tiktok_website_traffic', {identity_type: 'bc_auth_tt'}),
    'RECIPE_INPUT_INVALID',
    e => e.details.field === 'identity_authorized_bc_id',
  );
  const bc = compile('tiktok_website_traffic', {identity_type: 'bc_auth_tt', identity_authorized_bc_id: '77'});
  assert.ok(JSON.stringify(bc.steps).includes('"identity_type":"BC_AUTH_TT"'));
});

test('a wrong type in a Meta website brief is invalid, and says what the field takes; the accepted forms still work', () => {
  for (const id of ['meta_website_sales', 'meta_website_leads']) {
    for (const [patch, field] of [
      [{click_attribution_days: '28'}, 'click_attribution_days'],
      [{click_attribution_days: 28}, 'click_attribution_days'],
      [{view_attribution_days: '7'}, 'view_attribution_days'],
      [{view_attribution_days: true}, 'view_attribution_days'],
    ])
      refusedAs(
        () => compile(id, patch),
        'RECIPE_INPUT_INVALID',
        e => e.details.field === field && Array.isArray(e.details.allowed),
      );
    const numbers = compile(id, {click_attribution_days: 1, view_attribution_days: 0});
    assert.deepEqual(numbers.steps.find(s => s.id === 'adset').arguments.payload.attribution_spec, [
      {event_type: 'CLICK_THROUGH', window_days: 1},
    ]);
  }
  for (const wrong of ['none', null, 'HOUSING', [1], {}])
    refusedAs(
      () => compile('meta_website_traffic', {special_ad_categories: wrong}),
      'RECIPE_INPUT_INVALID',
      e => e.details.field === 'special_ad_categories',
    );
  // A regulated category is still not a recipe's to send.
  refusedAs(
    () => compile('meta_website_traffic', {special_ad_categories: ['HOUSING']}),
    'RECIPE_PREREQUISITES_REQUIRED',
  );
  assert.deepEqual(
    compile('meta_website_traffic', {special_ad_categories: []}).steps.find(s => s.id === 'campaign').arguments.payload
      .special_ad_categories,
    [],
  );
});

// The default answers of `recipes` and `recipe_context`, measured on the built tree (D14: a default view stays under the 10k-token warning,
// about 40,000 characters; the lead records the bytes before and after in the report).
function service() {
  const store = new Store(':memory:', Buffer.alloc(32, 83).toString('base64'));
  const svc = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      throw Error('No provider call while reading a recipe');
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const actor = {tenantId: 'recipe-inputs', userId: 'operator', role: 'operator'};
  return {store, call: input => svc.call('amcp_campaign', input, actor)};
}
test('R3: recipes and recipe_context return the inputs, compactly, and stay far under the D14 bound', async t => {
  const f = service();
  t.after(() => f.store.close());
  const listing = await f.call({action: 'recipes'});
  assert.equal(listing.success, true, JSON.stringify(listing).slice(0, 500));
  assert.equal(listing.data.recipes.length, campaignRecipes.length);
  for (const row of listing.data.recipes) {
    assert.equal(typeof row.inputs, 'object', row.id + ' lists its inputs');
    assert.deepEqual(row.inputs, campaignRecipes.find(r => r.id === row.id).inputs, row.id);
  }
  const listed = Buffer.byteLength(JSON.stringify(listing.data), 'utf8');
  assert.ok(listed < 40000, 'the recipes answer is ' + listed + ' bytes');
  for (const definition of campaignRecipes) {
    const context = await f.call({action: 'recipe_context', recipe: definition.id});
    assert.equal(context.success, true, definition.id);
    assert.equal(typeof context.data.recipe.inputs, 'object', definition.id + ' context lists its inputs');
    assert.deepEqual(context.data.recipe.inputs, definition.inputs, definition.id);
    const bytes = Buffer.byteLength(JSON.stringify(context.data), 'utf8');
    assert.ok(bytes < 12000, definition.id + ' recipe_context is ' + bytes + ' bytes');
  }
});

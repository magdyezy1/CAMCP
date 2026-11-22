import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {campaignRecipe, campaignRecipes} from '../dist/src/campaign-recipes.js';
import {recipeComposerFixture} from './fixtures/recipe-composer-ui.mjs';
import {smartPlusWebAccount, smartPlusWebAdvertiser, smartPlusWebBriefs} from './fixtures/tiktok-smart-plus-web.mjs';
import {
  smartPlusSearchAccount,
  smartPlusSearchAdvertiser,
  smartPlusSearchBriefs,
} from './fixtures/tiktok-smart-plus-search.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * An optional end card input in the three Upgraded Smart+ packs (package r25-m4b-endcards, item 5). `end_card_ids` is a list of 1 to 10
 * IDs of end cards of the advertiser (the `creative_portfolio_id` of a portfolio of type END_CARD, which "Get portfolios or end cards
 * within an ad account" lists, read 2026-11-22); when given it is passed to the pack's ad step as `end_card_list` of `{end_card_id}`, and
 * preflight reads the end cards before any campaign is created, as it reads the identity, the post and the CTA portfolio. A brief without
 * it compiles as it did. The packs' ad groups deliver on TikTok alone, which the page documents no end cards for: the review of the ad
 * step says so (src/tiktok-smart-plus-end-cards.ts) and TikTok decides. The synthetic advertisers are the fixtures of journeys J15 and J24.
 */
const gateway = 'tiktok_native_action',
  WEB_CONNECTION = '19191919-1919-4191-8191-191919191919',
  SEARCH_CONNECTION = '20202020-2020-4202-8202-202020202020',
  webActor = {tenantId: 'tiktok-end-card-packs-web', userId: 'operator', role: 'operator'},
  searchActor = {tenantId: 'tiktok-end-card-packs-search', userId: 'operator', role: 'operator'};
const traffic = 'tiktok_smart_plus_website_traffic',
  conversions = 'tiktok_smart_plus_website_conversions',
  search = 'tiktok_smart_plus_search_website';
const {traffic: trafficBrief, conversions: conversionsBrief} = smartPlusWebBriefs(WEB_CONNECTION);
const {clicks: searchBrief} = smartPlusSearchBriefs(SEARCH_CONNECTION);
const briefOf = id => (id === search ? searchBrief : id === conversions ? conversionsBrief : trafficBrief);
const definitionOf = id => campaignRecipes.find(r => r.id === id);
const adStep = plan => plan.steps.find(s => s.id === 'smart_plus_ad');
const label = 'TikTok end card IDs of this advertiser, optional (1–10) — one per line';

function setup(kind, options = {}) {
  const web = kind === 'web',
    actor = web ? webActor : searchActor,
    connection = web ? WEB_CONNECTION : SEARCH_CONNECTION,
    account = web ? smartPlusWebAccount : smartPlusSearchAccount,
    store = new Store(':memory:', Buffer.alloc(32, web ? 74 : 75).toString('base64'));
  store.putConnection(
    {...actor, role: 'admin'},
    {
      id: connection,
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'TikTok login',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const advertiser = web ? smartPlusWebAdvertiser(options) : smartPlusSearchAdvertiser(options),
    service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(advertiser.fetch, undefined, undefined, undefined, 10000),
      undefined,
      {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
    );
  const call = input => service.call('amcp_campaign', input, actor);
  return {store, service, ...advertiser, call, close: () => store.close()};
}
async function launch(f, recipe, business) {
  const created = await f.call({action: 'create_from_recipe', recipe, business});
  assert.equal(created.success, true, JSON.stringify(created).slice(0, 1500));
  const id = created.data.id,
    preview = await f.call({action: 'approve', id});
  assert.equal(preview.success, true, JSON.stringify(preview).slice(0, 1500));
  const approved = await f.call({
    action: 'approve',
    id,
    confirmed: true,
    plan_hash: preview.data.plan_hash,
    summary_hash: preview.data.summary_hash,
  });
  assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 1500));
  return {id, result: await f.call({action: 'run', id})};
}
const planOf = async (f, id) => (await f.call({action: 'get', id, detail: 'full'})).data;

test('the three Smart+ packs take end_card_ids as an optional input, and a brief without it compiles with no end card and the prerequisites it had', () => {
  for (const id of [traffic, conversions, search]) {
    assert.ok(definitionOf(id).optional.includes('end_card_ids'), id + ' lists end_card_ids as optional');
    assert.ok(!definitionOf(id).required.includes('end_card_ids'), id + ' does not require it');
    const plan = campaignRecipe(id, briefOf(id)),
      ad = adStep(plan);
    assert.equal(ad.arguments.payload.end_card_list, undefined, id);
    assert.deepEqual(ad.prerequisites, ['tiktok_spark_post', 'tiktok_cta_portfolio'], id);
    assert.equal(plan.recipe.creative.end_card_ids, undefined, id);
    // A blank value is no input, as everywhere in a brief.
    assert.deepEqual(campaignRecipe(id, {...briefOf(id), end_card_ids: ''}), plan, id + ' with a blank input');
  }
});

test('with end_card_ids the ad step carries end_card_list and has end cards read in preflight; the campaign and the ad group are the same steps', () => {
  for (const id of [traffic, conversions, search]) {
    const plain = campaignRecipe(id, briefOf(id)),
      plan = campaignRecipe(id, {...briefOf(id), end_card_ids: ['8802', '8801']}),
      ad = adStep(plan);
    assert.deepEqual(ad.arguments.payload.end_card_list, [{end_card_id: '8802'}, {end_card_id: '8801'}], id);
    assert.deepEqual(ad.prerequisites, ['tiktok_spark_post', 'tiktok_cta_portfolio', 'tiktok_end_card'], id);
    assert.deepEqual(plan.recipe.creative.end_card_ids, ['8802', '8801'], id);
    // Nothing else of the plan moved: the other two steps, and the rest of the ad step, are byte for byte what they were.
    const {end_card_list, ...rest} = ad.arguments.payload;
    assert.deepEqual(rest, adStep(plain).arguments.payload, id);
    assert.deepEqual(plan.steps.slice(0, 2), plain.steps.slice(0, 2), id);
    void end_card_list;
  }
});

test('end_card_ids that TikTok would refuse are refused before anything is saved, naming the input', () => {
  const eleven = Array.from({length: 11}, (_, i) => String(8801 + i));
  const cases = {
    'a text': 'end-card',
    'an empty list': [],
    'eleven end cards (the page: "Size range: 1–10")': eleven,
    'an ID that is no number': ['card'],
    'an ID of zero': ['0'],
    'an ID that is a number and no string': [8801],
    'a blank ID': [''],
    'the same end card twice (the page: "Duplicate end cards are not allowed")': ['8801', '8802', '8801'],
    'an object where an ID is': [{end_card_id: '8801'}],
  };
  for (const id of [traffic, conversions, search])
    for (const [name, value] of Object.entries(cases))
      assert.throws(
        () => campaignRecipe(id, {...briefOf(id), end_card_ids: value}),
        e => assertRefused(e, 'RECIPE_INPUT_INVALID') && e.details.field === 'end_card_ids',
        id + ': ' + name,
      );
});

test('preflight reads the end cards before any create, keeps their hash and never their link, and a traffic launch with end cards is verified', async t => {
  const f = setup('web');
  t.after(f.close);
  const {id, result} = await launch(f, traffic, {...trafficBrief, end_card_ids: ['8801', '8802']});
  assert.equal(result.success, true, JSON.stringify(result).slice(0, 1500));
  const plan = await planOf(f, id);
  assert.equal(plan.state, 'complete', JSON.stringify(plan.steps.map(s => [s.id, s.status, s.error])));
  assert.deepEqual(
    plan.steps.map(s => s.status),
    ['verified', 'verified', 'verified'],
  );
  const firstCreate = f.requests.indexOf('POST /v1.3/smart_plus/campaign/create/'),
    read = f.requests.indexOf('GET /v1.3/creative/portfolio/list/');
  assert.ok(
    read >= 0 && read < firstCreate,
    'the end cards are read before the first create: ' + f.requests.join(' | '),
  );
  const checked = plan.preflight.checks.find(c => c.step === 'smart_plus_ad' && c.status === 'prerequisites_checked'),
    asset = checked.assets.find(a => a.asset_type === 'TikTok end cards');
  assert.ok(asset, JSON.stringify(checked.assets).slice(0, 600));
  assert.equal(asset.asset_id, '8801,8802');
  assert.equal(asset.status, 'provider_read_checked');
  assert.match(JSON.stringify(asset.source_reference), /response_hash/);
  assert.doesNotMatch(JSON.stringify(plan.preflight), /x-signature|p16\.example\.test/);
  // The ad TikTok holds has the end cards the brief named, and nothing else of the three creates changed.
  assert.deepEqual(f.ads.get('902').end_card_list, [{end_card_id: '8801'}, {end_card_id: '8802'}]);
  assert.deepEqual(
    f.writes.map(w => w.path),
    ['/v1.3/smart_plus/campaign/create/', '/v1.3/smart_plus/adgroup/create/', '/v1.3/smart_plus/ad/create/'],
  );
});

test('an end card TikTok does not return, or that is no end card, stops the plan before any create, naming end_card_ids', async t => {
  for (const [name, ids] of [
    ['an end card of another advertiser', ['8801', '8899']],
    ['a Display Card where an end card is wanted', ['8890']],
  ]) {
    const f = setup('web');
    t.after(f.close);
    const created = await f.call({
      action: 'create_from_recipe',
      recipe: traffic,
      business: {...trafficBrief, end_card_ids: ids},
    });
    assert.equal(created.success, true, name + ' ' + JSON.stringify(created).slice(0, 600));
    const checked = await f.call({action: 'preflight', id: created.data.id});
    assert.equal(checked.success, true, name + ' ' + JSON.stringify(checked).slice(0, 600));
    const preflight = (await planOf(f, created.data.id)).preflight,
      blocked = preflight.checks.find(c => c.status === 'blocked');
    assert.equal(preflight.status, 'blocked', name);
    assert.equal(blocked.step, 'smart_plus_ad', name);
    assert.equal(
      blocked.error.code,
      'CAMPAIGN_PREREQUISITE_REQUIRED',
      name + ' ' + JSON.stringify(blocked.error).slice(0, 300),
    );
    assert.equal(blocked.error.details.field, 'end_card_ids', name);
    const run = await f.call({action: 'run', id: created.data.id});
    assert.notEqual(run.data?.state, 'complete', name);
    assert.equal(f.writes.length, 0, 'nothing was created: ' + name);
  }
});

test('the Search pack passes end cards to its ad step too, and its plan is created and verified with them', async t => {
  const f = setup('search');
  t.after(f.close);
  const {id, result} = await launch(f, search, {...searchBrief, end_card_ids: ['8801']});
  assert.equal(result.success, true, JSON.stringify(result).slice(0, 1500));
  const plan = await planOf(f, id);
  assert.equal(plan.state, 'complete', JSON.stringify(plan.steps.map(s => [s.id, s.status, s.error])));
  assert.ok(f.requests.includes('GET /v1.3/creative/portfolio/list/'));
  assert.deepEqual(f.ads.get('902').end_card_list, [{end_card_id: '8801'}]);
});

test('the website labels the input and takes it one ID per line, in English and in Arabic', () => {
  for (const locale of ['en', 'ar']) {
    const f = recipeComposerFixture(locale, definitionOf(traffic), trafficBrief);
    const code = "recipeFieldLabel('end_card_ids', '" + traffic + "')";
    assert.equal(f.run(code), label, locale);
    assert.equal(f.run("recipeArrays.has('end_card_ids')"), true, 'a list, one ID per line');
    const shown = f.run('uiText(' + code + ')');
    if (locale === 'en') assert.equal(shown, label);
    else {
      assert.notEqual(shown, label, 'Arabic for: ' + label);
      assert.match(shown, /[؀-ۿ]/);
    }
  }
});

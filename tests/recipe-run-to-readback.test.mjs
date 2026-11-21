// ACC-01 (R23 B17-recipe-verified-outcome): run-to-read-back fixtures existed for the Google value, clicks and
// conversion recipes and the Snapchat traffic and lead recipes, but the three Meta website recipes ended at compile,
// refusal and preflight, and no recipe proved that an uncertain step is never sent again. These fixtures drive the real
// campaign runner (preflight, prepare_next, execute_next, read-back) through synthetic provider APIs: PAUSED parents,
// one receipt per step, verified read-back, no second write when a review is executed again, and an uncertain write
// that is never replayed. The last test keeps a run-to-read-back fixture on record for each guided recipe.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {campaignRecipes} from '../dist/src/campaign-recipes.js';
import {metaGraphFake, microsoftFake, recipeWorkspace} from './fixtures/recipe-run-fakes.mjs';

const metaBusiness = recipe => ({
  name: 'Synthetic website campaign',
  account_id: '100',
  connection_id: 'login',
  currency: 'USD',
  daily_budget: '25.05',
  country_codes: ['US'],
  page_id: '123',
  pixel_id: '456',
  destination_url: 'https://example.com/offer',
  message: 'An explicit message',
  headline: 'An explicit headline',
  image_hash: 'abcdef123456',
  special_ad_categories: [],
  ...(recipe === 'meta_website_traffic'
    ? {}
    : {click_attribution_days: '7', view_attribution_days: '1', start_time: '2026-12-01T09:00:00+02:00'}),
});
const microsoftBusiness = {
  name: 'Synthetic Microsoft demand',
  account_id: '123',
  connection_id: 'login',
  currency: 'USD',
  daily_budget: '25.00',
  cpc_bid: '1.25',
  language: 'English',
  keywords: ['running shoes'],
  headlines: ['Explore the collection', 'Find your next pair', 'Built for every day'],
  descriptions: ['Discover our latest collection online today.', 'Explore styles and find a pair today.'],
  destination_url: 'https://example.test/',
  // CMP-03: the pack targets these locations on the paused campaign before its ad group.
  location_ids: ['190'],
};
const microsoftLogin = {
  account_id: '123',
  scopes: ['https://ads.microsoft.com/msads.manage'],
  connection: {accountCustomers: {123: '456'}},
  credentials: {accessToken: 'synthetic', developerToken: 'synthetic-developer'},
};

/** prepare_next then execute_next of the step it reviews, with every confirmation the review asks for. */
async function step(w, id) {
  const prepared = await w.call({action: 'prepare_next', id});
  assert.equal(prepared.success, true, JSON.stringify(prepared));
  assert.ok(prepared.data.review?.review_id, JSON.stringify(prepared).slice(0, 2000));
  const executed = await w.call({
    action: 'execute_next',
    id,
    review_id: prepared.data.review.review_id,
    idempotency_key: prepared.data.review.review_id,
    confirmed: true,
    spend_change_confirmed: true,
  });
  return {prepared, executed};
}
/** Runs a saved plan to its end and returns the stored run. */
async function runToEnd(w, id, steps) {
  const preflight = await w.call({action: 'preflight', id});
  assert.equal(preflight.success, true, JSON.stringify(preflight));
  assert.equal(preflight.data.blocked, false, JSON.stringify(preflight.data).slice(0, 2000));
  for (let i = 0; i < steps; i++) {
    const {executed} = await step(w, id);
    assert.equal(executed.success, true, JSON.stringify(executed).slice(0, 2000));
    assert.equal(executed.data.current.status, 'verified', JSON.stringify(executed.data.current).slice(0, 2000));
  }
  return w.store.document(w.actor.tenantId, 'campaign_run', id);
}

for (const recipe of ['meta_website_traffic', 'meta_website_sales', 'meta_website_leads'])
  test(recipe + ' runs to verified read-back under a PAUSED campaign, one receipt per step', async t => {
    const meta = metaGraphFake(),
      w = recipeWorkspace(t, 'meta_native_action', meta.transport, {scopes: ['ads_management']}),
      saved = await w.call({action: 'create_from_recipe', recipe, business: metaBusiness(recipe)});
    assert.equal(saved.success, true, JSON.stringify(saved));
    const run = await runToEnd(w, saved.data.id, 4);
    assert.equal(run.state, 'complete');
    assert.deepEqual(
      meta.writes.map(x => x.collection),
      ['campaigns', 'adsets', 'adcreatives', 'ads'],
    );
    const [campaign, adset] = meta.writes.map(x => x.body);
    // The parent is PAUSED, so nothing serves; its children inherit the pause (activation is a separate plan).
    assert.equal(campaign.status, 'PAUSED');
    assert.equal(campaign.is_adset_budget_sharing_enabled, false);
    assert.equal(adset.daily_budget, '2505');
    assert.equal(adset.campaign_id, run.steps.find(s => s.id === 'campaign').result.data.id);
    for (const s of run.steps) {
      assert.equal(s.status, 'verified', s.id);
      assert.equal(s.result?.executed, true, s.id);
      assert.equal(s.result.review_id, s.review_id, s.id);
      assert.ok(s.verification.checks.length && s.verification.checks.every(c => c.status === 'verified'), s.id);
    }
    // Executing the last review again is a duplicate: no second write reaches the provider.
    const last = run.steps.at(-1),
      replay = await w.call({
        action: 'execute_next',
        id: run.id,
        review_id: last.review_id,
        idempotency_key: last.review_id,
        confirmed: true,
        spend_change_confirmed: true,
      });
    assert.equal(meta.writes.length, 4, JSON.stringify(replay).slice(0, 500));
  });

test('a Meta recipe step whose response was lost stays uncertain and is never sent again', async t => {
  const meta = metaGraphFake({lose: 'adsets'}),
    w = recipeWorkspace(t, 'meta_native_action', meta.transport, {scopes: ['ads_management']}),
    saved = await w.call({action: 'create_from_recipe', recipe: 'meta_website_traffic', business: metaBusiness('')});
  assert.equal(saved.success, true, JSON.stringify(saved));
  assert.equal((await step(w, saved.data.id)).executed.data.current.status, 'verified');
  const {prepared, executed} = await step(w, saved.data.id);
  assert.equal(meta.writes.filter(x => x.collection === 'adsets').length, 1);
  const adset = () =>
    w.store.document(w.actor.tenantId, 'campaign_run', saved.data.id).steps.find(s => s.id === 'adset');
  assert.equal(executed.data.current.status, 'uncertain', JSON.stringify(executed).slice(0, 1500));
  assert.equal(adset().status, 'uncertain');
  // The same review again, and the next prepare: neither sends the ad set a second time.
  await w.call({
    action: 'execute_next',
    id: saved.data.id,
    review_id: prepared.data.review.review_id,
    idempotency_key: prepared.data.review.review_id,
    confirmed: true,
    spend_change_confirmed: true,
  });
  const again = await w.call({action: 'prepare_next', id: saved.data.id});
  assert.equal(again.data.blocked, true);
  assert.match(again.data.recovery, /never sends it again/);
  assert.ok(
    !again.data?.review || again.data.review.review_id === prepared.data.review.review_id,
    JSON.stringify(again).slice(0, 1500),
  );
  assert.equal(meta.writes.filter(x => x.collection === 'adsets').length, 1);
  assert.equal(meta.writes.filter(x => x.collection === 'ads').length, 0, 'no dependent step ran');
});

test('microsoft_search runs to verified read-back, paused, and a re-executed review writes nothing', async t => {
  const ms = microsoftFake(),
    w = recipeWorkspace(t, 'microsoft_ads_native_action', ms.transport, microsoftLogin),
    saved = await w.call({action: 'create_from_recipe', recipe: 'microsoft_search', business: microsoftBusiness});
  assert.equal(saved.success, true, JSON.stringify(saved));
  const run = await runToEnd(w, saved.data.id, 5);
  assert.equal(run.state, 'complete');
  assert.deepEqual(
    ms.writes.map(x => x.kind),
    ['Campaigns', 'CampaignCriterions', 'AdGroups', 'Keywords', 'Ads'],
  );
  // Every serving entity stays paused; the location criterion targets the paused campaign.
  const entries = [...ms.records.entries()];
  assert.ok(entries.filter(([k]) => !k.startsWith('CampaignCriterions:')).every(([, r]) => r.Status === 'Paused'));
  assert.deepEqual(
    entries.filter(([k]) => k.startsWith('CampaignCriterions:')).map(([, r]) => r.Criterion.LocationId),
    ['190'],
  );
  for (const s of run.steps) assert.equal(s.result?.executed, true, s.id);
  const last = run.steps.at(-1);
  await w.call({
    action: 'execute_next',
    id: run.id,
    review_id: last.review_id,
    idempotency_key: last.review_id,
    confirmed: true,
    spend_change_confirmed: true,
  });
  assert.equal(ms.writes.length, 5);
});

test('a microsoft_search step whose response was lost is refused a second send (PRV-03 lets its ad step verify)', async t => {
  const ms = microsoftFake({lose: 'AdGroups'}),
    w = recipeWorkspace(t, 'microsoft_ads_native_action', ms.transport, microsoftLogin),
    saved = await w.call({action: 'create_from_recipe', recipe: 'microsoft_search', business: microsoftBusiness});
  assert.equal(saved.success, true, JSON.stringify(saved));
  assert.equal((await step(w, saved.data.id)).executed.data.current.status, 'verified');
  // The campaign's locations (CMP-03), then the ad group whose response is lost.
  assert.equal((await step(w, saved.data.id)).executed.data.current.status, 'verified');
  const {prepared} = await step(w, saved.data.id);
  const adgroup = () =>
    w.store.document(w.actor.tenantId, 'campaign_run', saved.data.id).steps.find(s => s.id === 'adgroup');
  assert.equal(adgroup().status, 'uncertain');
  await w.call({
    action: 'execute_next',
    id: saved.data.id,
    review_id: prepared.data.review.review_id,
    idempotency_key: prepared.data.review.review_id,
    confirmed: true,
    spend_change_confirmed: true,
  });
  await w.call({action: 'prepare_next', id: saved.data.id});
  assert.equal(ms.writes.filter(x => x.kind === 'AdGroups').length, 1);
  assert.equal(ms.writes.filter(x => x.kind === 'Keywords').length, 0, 'no dependent step ran');
});

test('every guided recipe has a run-to-read-back fixture on record', () => {
  // Each recipe names the test that runs it through execute_next to a verified read-back. A recipe added to the
  // registry without one fails here (CMP-07 added Performance Max, the two TikTok packs and LinkedIn lead generation).
  const fixtures = {
    meta_website_traffic: 'tests/recipe-run-to-readback.test.mjs',
    meta_website_sales: 'tests/recipe-run-to-readback.test.mjs',
    meta_website_leads: 'tests/recipe-run-to-readback.test.mjs',
    microsoft_search: 'tests/recipe-run-to-readback.test.mjs',
    google_search: 'tests/campaign-plan-recovery.test.mjs',
    google_search_clicks: 'tests/google-clicks-recipe.test.mjs',
    google_search_conversions: 'tests/google-conversion-recipes.test.mjs',
    google_search_target_cpa: 'tests/google-conversion-recipes.test.mjs',
    google_search_conversion_value: 'tests/google-value-recipes.test.mjs',
    google_search_target_roas: 'tests/google-value-recipes.test.mjs',
    snapchat_website_traffic: 'tests/snapchat-traffic-recipe.test.mjs',
    snapchat_lead_generation: 'tests/snapchat-lead-recipe.test.mjs',
    google_performance_max: 'tests/google-pmax-recipe.test.mjs',
    tiktok_website_traffic: 'tests/tiktok-launch-recipes.test.mjs',
    tiktok_website_conversions: 'tests/tiktok-launch-recipes.test.mjs',
    tiktok_search_traffic: 'tests/tiktok-search-recipe.test.mjs',
    linkedin_lead_generation: 'tests/linkedin-lead-recipe.test.mjs',
  };
  assert.deepEqual(Object.keys(fixtures).sort(), campaignRecipes.map(r => r.id).sort());
  for (const [recipe, file] of Object.entries(fixtures)) {
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /execute_next|spend_change_confirmed: true|step\(w, /, file);
    // An assertion of a verified step or a complete plan, not merely the word (which "unverified" also contains).
    assert.match(text, /assert\.\w+\([^;]{0,400}?['"](?:verified|complete)['"]/, file);
    // The file names the recipe, or (the Google value pair, Snapchat) the recipe set it runs.
    assert.ok(
      text.includes(recipe) ||
        (/value/.test(recipe) && text.includes("'google_search_conversion_value', 'google_search_target_roas'")) ||
        (/target_cpa|conversions/.test(recipe) && /google_search_(conversions|target_cpa)/.test(text)) ||
        (/snapchat/.test(recipe) && /trafficFixture|leadFixture|snapchat/i.test(text)),
      recipe + ' in ' + file,
    );
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {Compiler} from '../dist/src/compiler.js';
import {applyExecutionRisk} from '../dist/src/execution-risk.js';
import {assertWriteShape} from '../dist/src/write-shape.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {campaignRecipe, campaignRecipes} from '../dist/src/campaign-recipes.js';
import {providerDeprecation, setDeprecationClock} from '../dist/src/provider-deprecations.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {arabicCatalog, recipeComposerFixture} from './fixtures/recipe-composer-ui.mjs';
import {advertiserWorld} from './helpers/tiktok-advertiser-noise.mjs';
import {standardCreates} from './helpers/tiktok-standard-creates.mjs';
import {smartPlusWebAccount, smartPlusWebAdvertiser, smartPlusWebBriefs} from './fixtures/tiktok-smart-plus-web.mjs';

/**
 * R2.5 M4a merge (package r25-m4a-merge): the joins of the M4 packages, each one test over the merged tree. Each test names the joint of the brief
 * (impl/r25-m4a-merge.md, "The joins") and the packages it joins. A package's own suite proves the package; this file proves what only the merge
 * can: two packages that each pass alone and must still say the same thing together. Nothing here reaches TikTok: the advertisers are the packages'
 * synthetic fixtures behind the real service.
 */
const lastSecond = '2026-12-31T23:59:59Z',
  afterDate = '2027-01-02T00:00:00Z';
const clock = iso => setDeprecationClock(() => Date.parse(iso));

// ---- J-1 (join 4 c): classic x smartweb ------------------------------------------------------------------------------------------------------
// From 2027-01-01 00:00 UTC the raw classic WEB_CONVERSIONS create and the purchases pack are refused (classic's dated deprecation) and name the
// replacement smartweb brings: the Smart+ campaign create and the Smart+ pack. That replacement, and every Smart+ route, must not notice the date.
const gateway = 'tiktok_native_action',
  CONNECTION = '18181818-1818-4181-8181-181818181818',
  actor = {tenantId: 'm4a-merge-joins', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'};
const smartPlusBriefs = smartPlusWebBriefs(CONNECTION);

/** A launch service over smartweb's synthetic advertiser (its fixture is journey J15's). */
function setup() {
  const store = new Store(':memory:', Buffer.alloc(32, 91).toString('base64'));
  store.putConnection(
    admin,
    {
      id: CONNECTION,
      tenantId: actor.tenantId,
      gateway,
      accounts: [smartPlusWebAccount],
      writeAccounts: [smartPlusWebAccount],
      enabled: true,
      label: 'TikTok login',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const advertiser = smartPlusWebAdvertiser();
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(advertiser.fetch, undefined, undefined, undefined, 10000),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const mcpCalls = [];
  const call = input => {
    mcpCalls.push(input.action);
    return service.call('amcp_campaign', input, actor);
  };
  return {...advertiser, mcpCalls, call, close: () => store.close()};
}
/** create_from_recipe, approve (preview), approve (confirmed) and run: the four calls of a launch. */
async function launch(f, recipe, business) {
  const created = await f.call({action: 'create_from_recipe', recipe, business});
  assert.equal(created.success, true, JSON.stringify(created).slice(0, 1000));
  const id = created.data.id,
    preview = await f.call({action: 'approve', id});
  assert.equal(preview.success, true, JSON.stringify(preview).slice(0, 1000));
  const approved = await f.call({
    action: 'approve',
    id,
    confirmed: true,
    plan_hash: preview.data.plan_hash,
    summary_hash: preview.data.summary_hash,
  });
  assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 1000));
  return {id, result: await f.call({action: 'run', id})};
}
// The request_id of a Smart+ create is derived from the plan's own ID (the lead's decision L3), so two plans never share one: it is the one
// value that may differ between two launches of the same brief.
const withoutKeys = value =>
  JSON.parse(JSON.stringify(value).replace(/"request_id":"\d+"/g, '"request_id":"<derived from the plan>"'));
const registry = new Registry(),
  compiler = new Compiler(registry),
  options = {mode: 'strict', flags: {}};
const compile = (action, payload) =>
  applyExecutionRisk(compiler.compile(gateway, {action, account_id: '123', payload, dry_run: true}, options));
const outcomeOf = fn => {
  try {
    fn();
    return 'accepted';
  } catch (e) {
    return e.code + ': ' + e.message;
  }
};

test('J-1: from 2027-01-01 a raw classic Sales campaign create and the purchases pack are refused and name the Smart+ route and pack; the day before both are accepted', async t => {
  t.after(() => setDeprecationClock());
  const f = standardCreates(advertiserWorld({rotating: false}), {tenant: 'm4a-join-1-raw'});
  t.after(() => f.close());
  const sales = body => ({...body, objective_type: 'WEB_CONVERSIONS'});
  clock(lastSecond);
  const early = await f.prepare('campaign', sales);
  assert.equal(
    early.success,
    true,
    'the day before the raw create prepares: ' + JSON.stringify(early.error ?? '').slice(0, 300),
  );
  clock(afterDate);
  const raw = await f.prepare('campaign', sales);
  assertRefused(raw, 'PROVIDER_DEPRECATED', {writes: () => f.sent.length});
  assert.equal(raw.error.details.deprecation, 'tiktok_manual_sales_app_lead_creates');
  assert.equal(raw.error.details.use_action, 'tiktok_smart_plus_campaign_create', 'the Smart+ route smartweb brings');
  assert.equal(
    raw.error.details.use_recipe,
    'tiktok_smart_plus_website_conversions',
    'the Smart+ pack smartweb brings',
  );
  assert.ok(
    campaignRecipes.some(r => r.id === raw.error.details.use_recipe && r.platform === 'tiktok'),
    'the pack the refusal names is a recipe the server lists',
  );
  // The purchases pack: the brief a classic pack takes is the Smart+ brief with a call to action in place of a CTA portfolio.
  const {call_to_action_id: _portfolio, ...shared} = smartPlusBriefs.conversions;
  const classicPurchases = {...shared, call_to_action: 'LEARN_MORE'};
  clock(lastSecond);
  assert.equal(
    campaignRecipe('tiktok_website_conversions', classicPurchases).steps[0].arguments.payload.objective_type,
    'WEB_CONVERSIONS',
  );
  clock(afterDate);
  assert.throws(
    () => campaignRecipe('tiktok_website_conversions', classicPurchases),
    e => {
      assertRefused(e, 'PROVIDER_DEPRECATED');
      assert.equal(e.details.use_recipe, 'tiktok_smart_plus_website_conversions');
      return true;
    },
  );
  // The traffic pack survives the date, as TikTok's banner leaves Traffic alone.
  const {pixel_id: _pixel, optimization_event: _event, ...classicTraffic} = classicPurchases;
  assert.equal(campaignRecipe('tiktok_website_traffic', classicTraffic).steps.length, 3);
});

test('J-1: every Smart+ pack compiles and launches to a verified paused launch byte for byte as on 2026-12-31 when the clock is at 2027-01-02, and every Smart+ route is untouched by the date', async t => {
  t.after(() => setDeprecationClock());
  const briefs = {
    tiktok_smart_plus_website_traffic: smartPlusBriefs.traffic,
    tiktok_smart_plus_website_conversions: smartPlusBriefs.conversions,
  };
  // A pack that merges later (the Smart+ Search pack of r25-m4-search2) is a new id here and fails this line until its brief is added.
  assert.deepEqual(
    campaignRecipes
      .filter(r => r.id.startsWith('tiktok_smart_plus_'))
      .map(r => r.id)
      .sort(),
    Object.keys(briefs).sort(),
    'every Smart+ pack has a brief in this join',
  );
  async function runOn(iso, id) {
    clock(iso);
    const f = setup();
    try {
      const compiled = withoutKeys(campaignRecipe(id, briefs[id]));
      const {id: planId, result} = await launch(f, id, briefs[id]);
      assert.equal(result.success, true, id + ' ' + iso + ': ' + JSON.stringify(result).slice(0, 800));
      assert.equal(result.data.run?.stopped, 'complete', id + ' ' + iso);
      const plan = (await f.call({action: 'get', id: planId, detail: 'full'})).data;
      return {
        compiled,
        state: plan.state,
        steps: withoutKeys(plan.steps.map(s => ({id: s.id, status: s.status, arguments: s.arguments}))),
        writes: withoutKeys(f.writes),
        requests: f.requests,
        mcpCalls: f.mcpCalls,
      };
    } finally {
      f.close();
    }
  }
  for (const id of Object.keys(briefs)) {
    const before = await runOn(lastSecond, id),
      after = await runOn(afterDate, id);
    assert.equal(before.state, 'complete', id);
    assert.deepEqual(
      before.steps.map(s => s.status),
      ['verified', 'verified', 'verified'],
      id,
    );
    assert.deepEqual(
      after,
      before,
      id + ': the same compile, the same prepared and sent requests, on both sides of the date',
    );
  }
  // Every Smart+ route a family descriptor holds gives the same answer on both days.
  const descriptors = fs
    .readdirSync('tests/family-descriptors')
    .filter(name => /^tiktok-smart-plus-.*\.mjs$/.test(name));
  assert.ok(descriptors.length >= 9, 'the Smart+ descriptors are found: ' + descriptors.length);
  for (const name of descriptors) {
    const {default: d} = await import('./family-descriptors/' + name);
    const answer = iso => {
      clock(iso);
      return outcomeOf(() =>
        assertWriteShape(compile(d.request.action, {advertiser_id: '123', ...structuredClone(d.request.payload)})),
      );
    };
    assert.equal(
      answer(afterDate),
      answer(lastSecond),
      d.request.action + ' answers the same on both sides of the date',
    );
    assert.doesNotMatch(answer(afterDate), /PROVIDER_DEPRECATED/, d.request.action);
  }
});

// ---- J-7 (join 7): classic Q2 --------------------------------------------------------------------------------------------------------------
// The web composer lists the packs the server lists (workspaceCall('campaign', {action: 'recipes'})). From 2027-01-01 00:00 UTC the purchases pack
// is retired (classic's dated deprecation) and must not be offered, while its Smart+ replacement (smartweb) is. The server's row says so, on the
// registry entry's own date (so the test clock and a corrected date move it); the composer leaves a row marked retired out before it chooses
// where to start, so a link or a stored draft naming it falls back as for any unknown recipe.
const retiredPack = 'tiktok_website_conversions',
  replacement = 'tiktok_smart_plus_website_conversions',
  cutoff = 'tiktok_manual_sales_app_lead_creates';
async function serverRecipes(f, iso) {
  clock(iso);
  const answer = await f.call({action: 'recipes'});
  assert.equal(answer.success, true, JSON.stringify(answer).slice(0, 400));
  return answer.data.recipes;
}

test('J-7: the server lists the purchases pack as retired from the last instant the date allows, on the registry entry’s own date, and no other row moves', async t => {
  t.after(() => setDeprecationClock());
  const f = setup();
  t.after(f.close);
  const before = await serverRecipes(f, lastSecond),
    after = await serverRecipes(f, '2027-01-01T00:00:00Z');
  const row = (rows, id) => rows.find(r => r.id === id);
  assert.equal(row(before, retiredPack)?.retired, undefined, 'the day before, the pack is listed as it always was');
  assert.deepEqual(row(after, retiredPack)?.retired, {deprecation: cutoff, effective_date: '2027-01-01'});
  const {retired: _retired, ...definition} = row(after, retiredPack);
  assert.deepEqual(definition, row(before, retiredPack), 'the row is the definition, marked');
  assert.deepEqual(
    after.filter(r => r.id !== retiredPack),
    before.filter(r => r.id !== retiredPack),
    'no other row moves: the replacement is listed, unmarked, on both sides of the date',
  );
  assert.ok(row(after, replacement) && row(after, replacement).retired === undefined);
  assert.deepEqual(
    after.map(r => r.id),
    before.map(r => r.id),
    'the list keeps its order and its rows',
  );
  // The date is the registry entry's: a corrected date moves the marking with no change to a recipe.
  const entry = providerDeprecation(cutoff),
    date = entry.effective_date;
  t.after(() => (entry.effective_date = date));
  entry.effective_date = '2027-02-01';
  assert.equal(row(await serverRecipes(f, '2027-01-15T00:00:00Z'), retiredPack).retired, undefined);
  assert.deepEqual(row(await serverRecipes(f, '2027-02-01T00:00:00Z'), retiredPack).retired, {
    deprecation: cutoff,
    effective_date: '2027-02-01',
  });
});

for (const locale of ['en', 'ar'])
  test(
    'J-7: the web composer (' +
      locale +
      ') offers the purchases pack until the last second of 2026 and not from 2027-01-01, and the Smart+ pack stays',
    async t => {
      t.after(() => setDeprecationClock());
      const f = setup();
      t.after(f.close);
      const mounted = async (iso, link) => {
        const rows = (await serverRecipes(f, iso)).filter(r => r.platform === 'tiktok'),
          start = link.slice('?recipe='.length),
          definition = rows.find(r => r.id === start) ?? rows[0];
        const page = recipeComposerFixture(locale, definition, smartPlusBriefs.conversions, {}, {recipes: rows, link});
        await page.mount();
        return page.node('section').innerHTML;
      };
      const offers = (html, id) => new RegExp('<option value="' + id + '"').test(html);
      const english = 'The linked workflow is not available. Choose a workflow.',
        unavailable = locale === 'ar' ? arabicCatalog[english] : english;
      assert.ok(unavailable, 'the notice has its text');
      if (locale === 'ar') assert.notEqual(unavailable, english, 'the notice has its Arabic');
      // The day before: both purchases packs are offered, and a link to the retired one opens it.
      const early = await mounted(lastSecond, '?recipe=' + replacement);
      assert.ok(offers(early, retiredPack) && offers(early, replacement), 'both packs are offered the day before');
      assert.ok(!early.includes(unavailable), 'no notice the day before');
      const earlyLinked = await mounted(lastSecond, '?recipe=' + retiredPack);
      assert.ok(
        offers(earlyLinked, retiredPack) && !earlyLinked.includes(unavailable),
        'a link to the pack opens it the day before',
      );
      // From the date: the purchases pack is not offered, its replacement is, and the replacement's own link is no problem.
      const late = await mounted('2027-01-01T00:00:00Z', '?recipe=' + replacement);
      assert.ok(!offers(late, retiredPack), 'the retired pack is not offered');
      assert.ok(offers(late, replacement), 'the Smart+ pack is offered');
      assert.ok(!late.includes(unavailable));
      // A link to the retired pack falls back as for any unknown recipe: the notice, and no way to choose it.
      const lateLinked = await mounted('2027-01-01T00:00:00Z', '?recipe=' + retiredPack);
      assert.ok(lateLinked.includes(unavailable), 'the link is named as not available');
      assert.ok(!offers(lateLinked, retiredPack), 'the retired pack is not offered after a link to it');
    },
  );

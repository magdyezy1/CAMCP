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
import {bindRecipeStep, campaignRecipe, campaignRecipes, unbindRecipeStep} from '../dist/src/campaign-recipes.js';
import {providerHooks} from '../dist/src/provider-hooks.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {recipeDependencies} from '../dist/src/capability-eligibility.js';
import {providerDeprecation, refuseDeprecated, setDeprecationClock} from '../dist/src/provider-deprecations.js';
import {activationSteps} from '../dist/src/campaign-activation.js';
import {MirrorError, errorResult} from '../dist/src/errors.js';
import {metaPrefix} from '../dist/src/meta-version.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {restoreClockAfter} from './helpers/tiktok-cutoff-clock.mjs';
import {arabicCatalog, recipeComposerFixture} from './fixtures/recipe-composer-ui.mjs';
import {advertiserWorld} from './helpers/tiktok-advertiser-noise.mjs';
import {standardCreates} from './helpers/tiktok-standard-creates.mjs';
import {smartPlusWebAccount, smartPlusWebAdvertiser, smartPlusWebBriefs} from './fixtures/tiktok-smart-plus-web.mjs';
import {editsFixture} from './fixtures/tiktok-smart-plus-edits.mjs';
import {
  smartPlusSearchAccount,
  smartPlusSearchAdvertiser,
  smartPlusSearchBriefs,
} from './fixtures/tiktok-smart-plus-search.mjs';

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

/**
 * How TikTok shows a deleted Upgraded Smart+ row, as the pages smartdelete read on 2026-11-21 say: the default read leaves a deleted row out,
 * `filtering.primary_status: STATUS_ALL` lists it with its own secondary status (CAMPAIGN_STATUS_DELETE) and its operation_status stays ENABLE or
 * DISABLE; its ad groups and ads are not deleted, they stay as rows with a parent-deleted secondary status. smartweb's fixture records a campaign
 * DELETE by setting its operation_status to DELETE: this reads that as the deletion and answers the way TikTok does (J-8). The Smart+ ad get also
 * takes `campaign_ids` (smartdelete reads a campaign's ads that way); smartweb's fixture filters ads by ad group and by ID only, so that read is
 * answered here from the ads it holds.
 */
function withDeletedRows(world) {
  const deleted = row => row.operation_status === 'DELETE',
    parentDeleted = row =>
      row.campaign_id !== undefined && world.campaigns.get(String(row.campaign_id))?.operation_status === 'DELETE';
  return async (raw, init = {}) => {
    const url = new URL(String(raw)),
      kind = /^\/v1\.3\/smart_plus\/(campaign|adgroup|ad)\/get\/$/.exec(url.pathname.replace('/open_api', ''))?.[1],
      filtering = JSON.parse(url.searchParams.get('filtering') ?? '{}'),
      read = (init.method ?? 'GET') === 'GET' && kind !== undefined;
    let response;
    if (read && kind === 'ad' && filtering.campaign_ids && !filtering.adgroup_ids && !filtering.smart_plus_ad_ids) {
      world.requests.push('GET ' + url.pathname.replace('/open_api', ''));
      const list = [...world.ads.values()].filter(ad =>
        filtering.campaign_ids.map(String).includes(String(ad.campaign_id)),
      );
      response = Response.json({
        code: 0,
        message: 'OK',
        request_id: 'r',
        data: {list, page_info: {page: 1, page_size: 100, total_number: list.length, total_page: 1}},
      });
    } else response = await world.fetch(raw, init);
    if (!read) return response;
    const answer = await response.json();
    if (answer.code !== 0) return Response.json(answer);
    const all = filtering.primary_status === 'STATUS_ALL';
    answer.data.list = answer.data.list
      .filter(row => all || !deleted(row))
      .map(row =>
        deleted(row)
          ? {...row, operation_status: 'DISABLE', secondary_status: 'CAMPAIGN_STATUS_DELETE'}
          : parentDeleted(row)
            ? {...row, secondary_status: kind === 'ad' ? 'AD_STATUS_CAMPAIGN_DELETE' : 'ADGROUP_STATUS_CAMPAIGN_DELETE'}
            : row,
      );
    answer.data.page_info.total_number = answer.data.list.length;
    return Response.json(answer);
  };
}
/**
 * A lost answer, as smartops' fixture makes one (tests/helpers/tiktok-smart-plus-reconcile-fixture.mjs): the next Smart+ campaign create is applied (when
 * `state.applied`) or not, and its answer is lost (a thrown transport failure). The Smart+ campaign list answers the creation window the lookup sends
 * (`creation_filter_start_time`, `creation_filter_end_time`, UTC, YYYY-MM-DD HH:MM:SS) from the campaigns the world holds, each dated by `create_time`.
 * smartweb's fixture lists campaigns by ID only, so that read is answered here (J-4).
 */
function withLostCreate(world, state) {
  const stamp = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' '),
    dated = () => {
      for (const row of world.campaigns.values()) row.create_time ??= stamp(Date.now());
    };
  return async (raw, init = {}) => {
    const url = new URL(String(raw)),
      path = url.pathname.replace('/open_api', ''),
      method = init.method ?? 'GET';
    if (method === 'POST' && path === '/v1.3/smart_plus/campaign/create/' && state.lose) {
      state.lose = false;
      if (state.applied) {
        await world.fetch(raw, init);
        dated();
      }
      throw new TypeError('synthetic lost response');
    }
    const filtering = JSON.parse(url.searchParams.get('filtering') ?? '{}');
    if (method === 'GET' && path === '/v1.3/smart_plus/campaign/get/' && filtering.creation_filter_start_time) {
      world.requests.push('GET ' + path);
      const list = [...world.campaigns.values()].filter(
        row =>
          row.create_time >= filtering.creation_filter_start_time &&
          row.create_time <= filtering.creation_filter_end_time,
      );
      return Response.json({
        code: 0,
        message: 'OK',
        request_id: 'r',
        data: {list, page_info: {page: 1, page_size: 100, total_number: list.length, total_page: 1}},
      });
    }
    const response = await world.fetch(raw, init);
    dated();
    return response;
  };
}
/**
 * A launch service over smartweb's synthetic advertiser (its fixture is journey J15's) or, with `world` and `account`, over another package's (search2's
 * Smart+ Search advertiser, J24); `deletions` shows deleted rows as TikTok does (J-8), `lost` loses the answer of a Smart+ campaign create (J-4).
 */
function setup({
  deletions = false,
  lost,
  world = smartPlusWebAdvertiser(),
  account = smartPlusWebAccount,
  meta = false,
} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 91).toString('base64'));
  // meta adds a Meta login and a synthetic Graph API to the same service (join 8), which answers by host: Meta's ad account, and its pixel list.
  const graph = [];
  if (meta)
    store.putConnection(
      admin,
      {
        id: META_LOGIN,
        tenantId: actor.tenantId,
        gateway: 'meta_native_action',
        accounts: ['123'],
        writeAccounts: ['123'],
        enabled: true,
        label: 'Synthetic Meta',
        scopes: ['ads_management'],
      },
      {accessToken: 'synthetic'},
    );
  store.putConnection(
    admin,
    {
      id: CONNECTION,
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
  const advertiser = world;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      withMetaGraph(
        lost ? withLostCreate(advertiser, lost) : deletions ? withDeletedRows(advertiser) : advertiser.fetch,
        meta && graph,
      ),
      undefined,
      undefined,
      undefined,
      10000,
    ),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const mcpCalls = [];
  const call = input => {
    mcpCalls.push(input.action);
    return service.call('amcp_campaign', input, actor);
  };
  /** One reviewed write of the launch's connection: `prepare` or `execute`, as amcp_write takes it. */
  const write = (input, as = actor) => service.call('amcp_write', {gateway, connection_id: CONNECTION, ...input}, as);
  return {...advertiser, mcpCalls, call, write, service, store, graph, close: () => store.close()};
}
const META_LOGIN = '19191919-1919-4191-8191-191919191919',
  metaAccountPath = metaPrefix + 'act_123',
  metaPixelListPath = metaAccountPath + '/adspixels';
/** Answers Meta's host with a synthetic ad account and a pixel list of one usable pixel (456), and every other host with the advertiser (join 8). */
const withMetaGraph = (tiktok, graph) => async (raw, init) => {
  const url = new URL(String(raw));
  if (!graph || !/facebook/.test(url.hostname)) return tiktok(raw, init);
  graph.push({method: init?.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams)});
  if (url.pathname === metaAccountPath)
    return Response.json({
      id: 'act_123',
      account_id: '123',
      name: 'Synthetic account',
      account_status: 1,
      currency: 'USD',
      timezone_name: 'UTC',
    });
  if (url.pathname === metaPixelListPath)
    return Response.json({data: [{id: '456', is_unavailable: false}, {id: '457'}]});
  throw Error('Unexpected synthetic Meta route ' + url.pathname);
};
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
  restoreClockAfter(t);
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
  restoreClockAfter(t);
  const briefs = {
    tiktok_smart_plus_website_traffic: smartPlusBriefs.traffic,
    tiktok_smart_plus_website_conversions: smartPlusBriefs.conversions,
    // The third pack (merge 7, r25-m4-search2) runs on its own package's advertiser, J24's, whose account is 7001.
    tiktok_smart_plus_search_website: smartPlusSearchBriefs(CONNECTION).clicks,
  };
  const worlds = {
    tiktok_smart_plus_search_website: () => ({world: smartPlusSearchAdvertiser(), account: smartPlusSearchAccount}),
  };
  // A pack that merges later is a new id here and fails this line until its brief is added.
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
    const f = setup(worlds[id]?.());
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
  restoreClockAfter(t);
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
      restoreClockAfter(t);
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

// ---- J-8: smartdelete x smartweb ---------------------------------------------------------------------------------------------------------------
// A Smart+ launch smartweb builds is a paused campaign with an enabled ad group and ad under it (Q14). smartdelete's family deletes a paused
// Smart+ campaign, says what that does to its children (TikTok's pages: they are not deleted, they stop delivering and can no longer change status),
// refuses an enabled target pause-first, and leaves an ENABLE status change to the status family: the recipe's one-step activation is that.
test('J-8: a recipe-built paused Smart+ campaign deletes with its enabled ad group and ad listed as children that stop and are not deleted; the enabled ad group alone is refused pause-first; the activation still goes to the status family', async t => {
  const f = setup({deletions: true});
  t.after(f.close);
  const {id, result} = await launch(f, 'tiktok_smart_plus_website_traffic', smartPlusBriefs.traffic);
  assert.equal(result.success, true, JSON.stringify(result).slice(0, 800));
  // What the recipe built: a paused campaign, its ad group and its ad enabled under it.
  assert.equal(f.campaigns.get('900').operation_status, 'DISABLE');
  assert.equal(f.groups.get('901').operation_status, 'ENABLE');
  assert.equal(f.ads.get('902').operation_status, 'ENABLE');
  const created = f.writes.length;
  assert.equal(created, 3);
  const status = (kind, ids, operation_status) => ({
    action: 'prepare',
    arguments: {
      action: 'tiktok_smart_plus_' + kind + '_status_update',
      account_id: smartPlusWebAccount,
      payload: {[kind === 'ad' ? 'smart_plus_ad_ids' : kind + '_ids']: ids, operation_status},
    },
  });

  // The recipe's activation is one ENABLE of the campaign, and it is the status family's: a spend change, never a deletion.
  const activation = await f.call({action: 'activation_plan', id});
  assert.equal(activation.success, true, JSON.stringify(activation).slice(0, 800));
  const [step, ...more] = (await f.call({action: 'get', id: activation.data.id, detail: 'full'})).data.steps;
  assert.equal(more.length, 0, 'one step');
  assert.deepEqual(step.arguments.payload, {
    advertiser_id: smartPlusWebAccount,
    campaign_ids: ['900'],
    operation_status: 'ENABLE',
  });
  const enable = await f.write({action: 'prepare', arguments: step.arguments});
  assert.equal(enable.success, true, JSON.stringify(enable).slice(0, 600));
  assert.equal(enable.data.creative_impact.scope, 'smart_plus_campaign_status');
  assert.notEqual(enable.data.effect, 'destructive');

  // The enabled ad group alone cannot be deleted: pause first, with the status family's DISABLE prepare as the next call.
  const refused = await f.write(status('adgroup', ['901'], 'DELETE'));
  assertRefused(refused, 'TIKTOK_SMART_PLUS_DELETE_REQUIRES_PAUSE', {writes: () => f.writes.length - created});
  assert.deepEqual(refused.error.details.adgroup_ids, ['901']);
  assert.deepEqual(refused.error.details.next_call, {
    tool: 'amcp_write',
    arguments: {...status('adgroup', ['901'], 'DISABLE'), gateway},
    meaning: refused.error.details.next_call.meaning,
  });
  const pause = await f.write(refused.error.details.next_call.arguments);
  assert.equal(pause.success, true, JSON.stringify(pause).slice(0, 600));
  assert.equal(pause.data.creative_impact.scope, 'smart_plus_adgroup_status', 'the pause is the status family’s');

  // The paused campaign deletes, and says what happens to what is under it.
  const deletion = await f.write(status('campaign', ['900'], 'DELETE'));
  assert.equal(deletion.success, true, JSON.stringify(deletion).slice(0, 800));
  assert.equal(deletion.data.effect, 'destructive');
  const impact = deletion.data.creative_impact;
  assert.equal(impact.scope, 'smart_plus_campaign_deletion');
  assert.equal(impact.operation, 'delete');
  assert.deepEqual(
    impact.children.map(c => [c.kind, c.count, c.all, c.enabled.map(e => e.name)]),
    [
      ['adgroup', 1, ['901'], [f.groups.get('901').adgroup_name]],
      ['ad', 1, ['902'], [f.ads.get('902').ad_name]],
    ],
    'the enabled ad group and ad are listed as children',
  );
  assert.equal(impact.enabled_children, 2);
  for (const words of [
    'are not deleted themselves',
    'can no longer change status',
    'ADGROUP_STATUS_CAMPAIGN_DELETE',
    'AD_STATUS_CAMPAIGN_DELETE',
  ])
    assert.ok(impact.effect.includes(words), words + ' in ' + impact.effect);
  assert.doesNotMatch(impact.effect, /are deleted or stop/);
  assert.equal(f.writes.length, created, 'nothing was sent by the prepares');
  // Executed: one DELETE of the campaign and nothing else; its children are still there, enabled, and the deletion reads back as deleted.
  const executed = await f.write({
    action: 'execute',
    review_id: deletion.data.review_id,
    idempotency_key: deletion.data.review_id,
    confirmed: true,
  });
  assert.equal(executed.success, true, JSON.stringify(executed).slice(0, 800));
  assert.deepEqual(f.writes.slice(created), [
    {
      path: '/v1.3/smart_plus/campaign/status/update/',
      body: {advertiser_id: smartPlusWebAccount, campaign_ids: ['900'], operation_status: 'DELETE'},
    },
  ]);
  assert.ok(f.groups.has('901') && f.ads.has('902'), 'the children are not deleted');
  assert.equal(f.groups.get('901').operation_status, 'ENABLE');
  const verified = await f.call({action: 'verify', review_id: deletion.data.review_id});
  assert.equal(verified.data.status, 'verified', JSON.stringify(verified).slice(0, 800));
});

// ---- J-3: smartedits x smartweb ----------------------------------------------------------------------------------------------------------------
// TikTok documents an ad-level pixel only for app promotion and Instant Form ads: a website campaign's pixel is its CONVERT ad group's (`pixel_id`). So
// the purchases pack sets the pixel on its ad group, and no pack passes an ad-level pixel when it creates the ad. An ad-level pixel edit of a
// recipe-built website ad is smartedits' probe: it prepares with a note that TikTok decides, and counts as done only when the read-back shows the pixel.
test('J-3: the purchases pack puts the pixel on its CONVERT ad group and no pack passes an ad-level pixel at create; a recipe-built CLICK ad’s pixel edit is the probe: noted, and verified only when the read-back shows the pixel', async t => {
  const launched = async (recipe, brief) => {
    const f = setup();
    t.after(f.close);
    const {result} = await launch(f, recipe, brief);
    assert.equal(result.success, true, JSON.stringify(result).slice(0, 800));
    return f;
  };
  const bodyAt = (f, suffix) => f.writes.find(w => w.path.endsWith(suffix)).body;
  // What the packs send: the pixel is the purchases ad group's own, and neither ad names one.
  const purchases = await launched('tiktok_smart_plus_website_conversions', smartPlusBriefs.conversions);
  assert.equal(bodyAt(purchases, '/adgroup/create/').optimization_goal, 'CONVERT');
  assert.equal(bodyAt(purchases, '/adgroup/create/').pixel_id, '8800');
  assert.equal(purchases.groups.get('901').pixel_id, '8800');
  const traffic = await launched('tiktok_smart_plus_website_traffic', smartPlusBriefs.traffic);
  assert.equal(bodyAt(traffic, '/adgroup/create/').optimization_goal, 'CLICK');
  assert.equal(bodyAt(traffic, '/adgroup/create/').pixel_id, undefined, 'a click ad group has no pixel');
  for (const f of [purchases, traffic]) {
    const ad = bodyAt(f, '/ad/create/');
    assert.equal(ad.ad_configuration.tracking_info, undefined, 'the pack passes no ad-level pixel');
    assert.doesNotMatch(JSON.stringify(ad), /tracking_pixel_id/);
  }
  // The edit: smartedits' world (its reads, its probe) holding the ad group and the ad the recipe built, the ad's configuration restated as read.
  const edited = () => {
    const e = editsFixture();
    t.after(() => e.store.close());
    e.groups[901] = structuredClone(traffic.groups.get('901'));
    e.ads[902] = structuredClone(traffic.ads.get('902'));
    return e;
  };
  const pixelEdit = ad => ({
    smart_plus_ad_id: '902',
    ad_configuration: {...ad.ad_configuration, tracking_info: {tracking_pixel_id: '7001'}},
  });
  const shown = edited();
  const p = await shown.prepared(pixelEdit(shown.ads[902]));
  assert.match(p.data.creative_impact.note, /TikTok decides/, 'a website ad’s pixel edit says that TikTok decides');
  assert.match(p.data.creative_impact.note, /the read-back does not show the pixel, the edit is not verified/);
  assert.deepEqual(p.data.creative_impact.tracking_pixel, {pixel_id: '7001', name: 'Site pixel', owned: true});
  assert.equal(shown.writes.length, 0, 'the prepare sent nothing');
  assert.equal((await shown.execute(p.data.review_id)).success, true);
  const verified = await shown.verify(p.data.review_id);
  assert.equal(verified.data.status, 'verified', JSON.stringify(verified).slice(0, 600));
  assert.equal(shown.ads[902].ad_configuration.tracking_info.tracking_pixel_id, '7001');
  // TikTok accepts the write and keeps no pixel: done is never claimed.
  const dropped = edited();
  dropped.behaviour.pixel = 'dropped';
  const q = await dropped.prepared(pixelEdit(dropped.ads[902]));
  assert.equal((await dropped.execute(q.data.review_id)).success, true, 'the write itself was accepted');
  assert.notEqual((await dropped.verify(q.data.review_id)).data.status, 'verified');
  const again = await dropped.verify(q.data.review_id);
  assert.equal(again.data.status, 'mismatch', JSON.stringify(again).slice(0, 600));
  assert.equal(dropped.writes.length, 1, 'verification never repeats the write');
});

// ---- Join 2: the dependency-evidence chain (classic x smartweb x search) --------------------------------------------------------------------------
// TikTok's `campaign.dependencyEvidence` is one chain over the functions of the three packages that declare a dependency: the classic packs' (identity, post,
// pixel), the Smart+ packs' (the CTA portfolio) and the Search pack's (the allowlist, which no read shows), written classic ?? Smart+ ?? Search at merge 5.
// `??` lets the first function that answers hide every later one, so the chain is only right while no two functions answer one dependency ID: each
// dependency of each TikTok recipe is answered by exactly one function or by none, and the chain returns that function's answer.
test('join 2: every dependency of every TikTok recipe is answered by at most one evidence function, the chain returns that answer, and the Search allowlist is answered', async () => {
  const {tiktokDependencyEvidence} = await import('../dist/src/tiktok-launch-recipes.js');
  const {tiktokSmartPlusDependencyEvidence} = await import('../dist/src/tiktok-smart-plus-recipe.js');
  const {tiktokSearchDependencyEvidence} = await import('../dist/src/tiktok-search-recipe.js');
  const functions = {
    classic: tiktokDependencyEvidence,
    smartPlus: tiktokSmartPlusDependencyEvidence,
    search: tiktokSearchDependencyEvidence,
  };
  const chained = providerHooks(gateway)?.campaign?.dependencyEvidence;
  assert.equal(typeof chained, 'function');
  // A context in which every function that owns a dependency can answer it: one read, checked asset of each kind, of this advertiser and login.
  const scope = {gateway, connection_id: 'c', account_id: '1'},
    asset = (asset_type, extra = {}) => ({
      asset_type,
      account_id: '1',
      connection_id: 'c',
      status: 'provider_read_checked',
      meaning: 'Read.',
      ...extra,
    }),
    context = {
      assets: [
        asset('TikTok pixel'),
        asset('TikTok identity'),
        asset('TikTok post'),
        asset('TikTok CTA portfolio', {asset_id: '700'}),
      ],
      scope,
      business: {},
      recipe: {},
      steps: [],
    };
  const dependencies = [
    ...new Set(
      campaignRecipes
        .filter(r => r.platform === 'tiktok')
        .flatMap(r => {
          assert.ok(recipeDependencies[r.id], r.id + ' declares its dependencies');
          return recipeDependencies[r.id].objects;
        }),
    ),
  ];
  const owners = {};
  for (const dependency of dependencies) {
    const answering = Object.entries(functions).filter(([, fn]) => fn(dependency, context) !== undefined);
    assert.ok(
      answering.length <= 1,
      dependency + ' is answered by ' + answering.map(([name]) => name).join(' and ') + ': the chain would hide one',
    );
    if (answering.length) owners[dependency] = answering[0][0];
    assert.deepEqual(
      chained(dependency, context),
      answering.length ? answering[0][1](dependency, context) : undefined,
      dependency,
    );
  }
  // Who answers what, today: a recipe that adds a dependency a function answers (search2's Smart+ Search allowlist) changes this map on purpose.
  assert.deepEqual(owners, {
    tiktok_spark_identity: 'classic',
    existing_tiktok_post: 'classic',
    account_owned_pixel: 'classic',
    dynamic_cta_portfolio: 'smartPlus',
    // Merge 7 (r25-m4-search2): the Smart+ Search allowlist is answered inside the Smart+ function (src/tiktok-smart-plus-recipe.ts), not by a fourth one.
    smart_plus_search_allowlist: 'smartPlus',
    search_ads_allowlist: 'search',
  });
  for (const id of ['search_ads_allowlist', 'smart_plus_search_allowlist'])
    assert.equal(chained(id, context).status, 'unknown', id + ' is answered: unknown, with the reason');
  // The chain still asks nobody about another provider's dependency: a TikTok answer for a Meta pixel, say, is no TikTok answer.
  assert.equal(chained('account_owned_pixel', {...context, assets: [asset('Meta pixel')]}), undefined);
});

// ---- smartweb x search: the plan seam leaves a classic plan alone ------------------------------------------------------------------------------
// smartweb gives a plan's Smart+ steps their own request_id when the plan is saved (bindToPlan, unbindFromPlan; the compile leaves a placeholder) and
// runs its preflight over every TikTok plan. A classic plan (the Search pack, the traffic pack, the purchases pack before its date) carries no such
// placeholder, so binding must give back each step as it is, and unbinding too; a Smart+ step is the control that does change.
test('the plan seam of smartweb leaves every classic TikTok step as it is, and binds a Smart+ step', t => {
  restoreClockAfter(t);
  const examples = JSON.parse(fs.readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'));
  clock(lastSecond);
  const plans = {
    tiktok_search_traffic: examples.tiktok_search_business,
    tiktok_website_traffic: examples.tiktok_traffic_business,
    tiktok_website_conversions: examples.tiktok_conversion_business,
  };
  for (const [recipe, brief] of Object.entries(plans)) {
    const {steps} = campaignRecipe(recipe, brief);
    assert.ok(steps.length >= 3, recipe);
    for (const step of steps) {
      assert.deepEqual(bindRecipeStep(step, 'plan-1'), step, recipe + ' ' + step.id + ' is not bound');
      assert.deepEqual(unbindRecipeStep(step), step, recipe + ' ' + step.id + ' is not unbound');
    }
  }
  const smartPlus = campaignRecipe('tiktok_smart_plus_website_traffic', smartPlusBriefs.traffic).steps;
  const bound = smartPlus.map(step => bindRecipeStep(step, 'plan-1'));
  assert.notDeepEqual(bound[0], smartPlus[0], 'the Smart+ campaign step gets its request_id');
  assert.match(String(bound[0].arguments.payload.request_id), /^[1-9][0-9]{0,18}$/);
  assert.deepEqual(unbindRecipeStep(bound[0]), smartPlus[0], 'and unbinding gives the compiled step back');
  assert.deepEqual(bound[2], smartPlus[2], 'the Smart+ ad create has no request_id and is left as it is');
});

// ---- Join 1: the two TikTok `impact` hooks (classic x smartops) ---------------------------------------------------------------------------------
// classic lists what an earlier-shape ad update leaves out (`omitted_fields`, route /v1.3/ad/update/); smartops discloses that a standard ad group or ad created
// ENABLE under parents the review reads serving serves at once (`may_affect_serving`, routes /v1.3/adgroup/create/ and /v1.3/ad/create/). tsc refuses two
// `impact` keys in one table (TS1117), so the merge composes them, classic's first; their routes are disjoint, so at most one answers.
test('join 1: the composed impact hook gives classic’s listing for an earlier-shape ad update and smartops’ disclosure for a serving standard child, and no route gets both', async () => {
  const {tiktokAdUpdateImpact} = await import('../dist/src/tiktok-state-reads.js');
  const {tiktokServingChildImpact} = await import('../dist/src/tiktok-serving-children.js');
  const impact = providerHooks(gateway)?.writes?.impact;
  assert.equal(typeof impact, 'function');
  const plan = (path, body) => ({gateway, method: 'POST', path, accountId: '1', body: {advertiser_id: '1', ...body}});
  const update = plan('/v1.3/ad/update/', {ad_ids: ['10'], creatives: [{ad_id: '10', ad_name: 'renamed'}]}),
    group = plan('/v1.3/adgroup/create/', {campaign_id: '300', operation_status: 'ENABLE', adgroup_name: 'g'}),
    ad = plan('/v1.3/ad/create/', {adgroup_id: '200', creatives: [{operation_status: 'ENABLE', ad_name: 'a'}]});
  const row = rows => [{data: {list: rows}}];
  const adRow = row([{ad_id: '10', ad_name: 'old', landing_page_url: 'https://x.test', call_to_action: 'LEARN_MORE'}]),
    campaignRow = row([{campaign_id: '300', operation_status: 'ENABLE'}]),
    adgroupRows = [...campaignRow, ...row([{adgroup_id: '200', campaign_id: '300', operation_status: 'ENABLE'}])];
  // (1) an earlier-shape ad update lists the fields its creative leaves out, and says nothing of serving.
  const listed = impact(update, adRow);
  assert.ok(
    Array.isArray(listed?.omitted_fields) && listed.omitted_fields.length > 0,
    JSON.stringify(listed).slice(0, 300),
  );
  assert.equal(listed.may_affect_serving, undefined);
  assert.deepEqual(listed, tiktokAdUpdateImpact(update, adRow));
  // (2) an ENABLE standard ad group, and an ENABLE ad, under parents read ENABLE disclose that they serve at once.
  for (const [what, p, state] of [
    ['ad group', group, campaignRow],
    ['ad', ad, adgroupRows],
  ]) {
    const disclosed = impact(p, state);
    assert.equal(disclosed?.may_affect_serving, true, what + ': ' + JSON.stringify(disclosed));
    assert.equal(disclosed.omitted_fields, undefined);
    assert.deepEqual(disclosed, tiktokServingChildImpact(p, state));
  }
  // (3) a standard create under a parent read DISABLE discloses nothing, and an update nothing of serving.
  assert.equal(impact(group, row([{campaign_id: '300', operation_status: 'DISABLE'}])), undefined);
  assert.equal(tiktokServingChildImpact(update, adRow), undefined);
  assert.equal(tiktokAdUpdateImpact(group, campaignRow), undefined);
  // (4) every TikTok write route a family descriptor or a standard create declares, given the state and body that let either function answer: at most one
  // of the two answers, and the routes that are answered are exactly the three above.
  const compiler = new Compiler(new Registry());
  const everyRoute = new Set([
    '/v1.3/ad/update/',
    '/v1.3/adgroup/create/',
    '/v1.3/ad/create/',
    '/v1.3/campaign/create/',
  ]);
  for (const name of fs.readdirSync('tests/family-descriptors').filter(n => /^tiktok-.*\.mjs$/.test(n))) {
    const {default: d} = await import('./family-descriptors/' + name);
    const compiled = applyExecutionRisk(
      compiler.compile(
        gateway,
        {
          action: d.request.action,
          account_id: '123',
          payload: {advertiser_id: '123', ...structuredClone(d.request.payload)},
          dry_run: true,
        },
        {mode: 'strict', flags: {}},
      ),
    );
    everyRoute.add(compiled.path);
  }
  const answered = {};
  for (const path of everyRoute) {
    const p = plan(path, {
      ...update.body,
      ...group.body,
      ...ad.body,
      creatives: [{ad_id: '10', ad_name: 'x', operation_status: 'ENABLE'}],
    });
    const state = [...adRow, ...adgroupRows];
    const both = [tiktokAdUpdateImpact(p, state), tiktokServingChildImpact(p, state)].filter(a => a !== undefined);
    assert.ok(both.length <= 1, path + ' is answered by both hooks');
    if (both.length) answered[path] = both[0].omitted_fields ? 'classic' : 'smartops';
  }
  assert.deepEqual(answered, {
    '/v1.3/ad/update/': 'classic',
    '/v1.3/adgroup/create/': 'smartops',
    '/v1.3/ad/create/': 'smartops',
  });
  // (5) the review-hooks seam test names the TikTok `impact` hook once (a second key is a duplicate key, which tsc refuses).
  const seam = fs.readFileSync('tests/provider-review-hooks.test.mjs', 'utf8');
  const tiktokList = seam.slice(
    seam.indexOf('tiktok_native_action: ['),
    seam.indexOf('],', seam.indexOf('tiktok_native_action: [')),
  );
  assert.equal(tiktokList.split('\n').filter(line => line.trim() === "'impact',").length, 1);
});

// ---- J-4: smartops x smartweb ------------------------------------------------------------------------------------------------------------------
// Until smartops, a lost answer to a Smart+ create held a plan step for good: `reconcile` had no lookup for the Smart+ routes. A Smart+ pack is a plan whose first
// step creates the campaign, so a lost answer there must settle as a standard create does: one match is `appears_applied` and the plan goes on once the person
// accepts it; a complete list with no match is `appears_not_applied`, and nothing was created.
test('J-4: a recipe step whose Smart+ create lost its answer reconciles appears_applied (one match) and appears_not_applied (a complete empty list)', async t => {
  process.env.AMCP_WRITE_RECONCILE_DELAY_MS = '0';
  process.env.AMCP_WRITE_RECONCILE_ROUND_MS = '0';
  t.after(() => {
    delete process.env.AMCP_WRITE_RECONCILE_DELAY_MS;
    delete process.env.AMCP_WRITE_RECONCILE_ROUND_MS;
  });
  const lostLaunch = async applied => {
    const state = {lose: false, applied};
    const f = setup({lost: state});
    t.after(f.close);
    const created = await f.call({
      action: 'create_from_recipe',
      recipe: 'tiktok_smart_plus_website_traffic',
      business: smartPlusBriefs.traffic,
    });
    assert.equal(created.success, true, JSON.stringify(created).slice(0, 600));
    const id = created.data.id,
      preview = await f.call({action: 'approve', id});
    await f.call({
      action: 'approve',
      id,
      confirmed: true,
      plan_hash: preview.data.plan_hash,
      summary_hash: preview.data.summary_hash,
    });
    state.lose = true;
    const run = await f.call({action: 'run', id});
    const step = run.data.steps.find(s => s.id === 'smart_plus_campaign');
    assert.equal(step.status, 'uncertain', JSON.stringify(run.data).slice(0, 800));
    assert.equal(
      run.data.steps.find(s => s.id === 'smart_plus_adgroup').status,
      'pending',
      'the plan stops: nothing under the lost campaign is sent',
    );
    return {f, id, review: run.data.current.review_id};
  };
  const reconcile = (f, input) => f.service.call('amcp_write', {action: 'reconcile', ...input}, actor);
  // Applied and lost: one match, found by reads only; accepted, the step settles from the lookup's receipt and the plan goes on once.
  const applied = await lostLaunch(true);
  assert.equal(applied.f.writes.length, 1, 'TikTok made the campaign');
  const found = await reconcile(applied.f, {review_id: applied.review});
  assert.equal(found.data?.classification, 'appears_applied', JSON.stringify(found).slice(0, 800));
  assert.equal(applied.f.writes.length, 1, 'reconcile sent nothing');
  const accepted = await reconcile(applied.f, {
    review_id: applied.review,
    accept_applied: true,
    reconciliation_id: found.data.reconciliation_id,
  });
  assert.equal(accepted.success, true, JSON.stringify(accepted).slice(0, 600));
  const settled = await applied.f.call({action: 'reconcile_step', id: applied.id, step_id: 'smart_plus_campaign'});
  assert.equal(
    settled.data.steps.find(s => s.id === 'smart_plus_campaign').status,
    'verified',
    JSON.stringify(settled.data).slice(0, 800),
  );
  const done = await applied.f.call({action: 'run', id: applied.id});
  assert.equal(done.success, true, JSON.stringify(done).slice(0, 800));
  assert.deepEqual(
    applied.f.writes.map(w => w.path),
    ['/v1.3/smart_plus/campaign/create/', '/v1.3/smart_plus/adgroup/create/', '/v1.3/smart_plus/ad/create/'],
    'the campaign was made once and the ad group and ad went on under it',
  );
  assert.equal(applied.f.campaigns.size, 1);
  assert.equal(applied.f.groups.get('901').campaign_id, '900', 'the ad group is under the campaign reconcile found');
  // Lost and not applied: the list is complete and holds no match.
  const absent = await lostLaunch(false);
  assert.equal(absent.f.writes.length, 0, 'TikTok made nothing');
  const empty = await reconcile(absent.f, {review_id: absent.review});
  assert.equal(empty.data?.classification, 'appears_not_applied', JSON.stringify(empty).slice(0, 800));
  assert.equal(absent.f.campaigns.size, 0);
});

// ---- J-5: smartops x smartweb x search2 --------------------------------------------------------------------------------------------------------------
// The recipe's ENABLE children under its own DISABLE campaign ask for nothing (smartweb, Q14); smartops' Q1 adds the other half: a Smart+ ad group created
// ENABLE under a campaign the review reads ENABLE serves at once, so it asks for spend_change_confirmed, and a campaign it cannot read still refuses
// (PARENT_SERVING, parent_unread), as does `allow_activation: false`. smartops' own property test (tests/tiktok-serving-parent-children.test.mjs) runs in the
// merge's selection; this joins its rule to a recipe-built campaign, of smartweb's traffic pack and (merge 7) of search2's Smart+ Search pack, whose ad group
// is the keyword ad group.
for (const [pack, recipe, brief, options, account] of [
  [
    'Smart+ website traffic',
    'tiktok_smart_plus_website_traffic',
    smartPlusBriefs.traffic,
    () => ({}),
    smartPlusWebAccount,
  ],
  [
    'Smart+ Search',
    'tiktok_smart_plus_search_website',
    smartPlusSearchBriefs(CONNECTION).clicks,
    () => ({world: smartPlusSearchAdvertiser(), account: smartPlusSearchAccount}),
    smartPlusSearchAccount,
  ],
])
  test(
    'J-5 (' +
      pack +
      '): a recipe-built campaign: its ENABLE children ask nothing while it is paused, an ENABLE ad group under it asks for the flag once it serves, an unread campaign refuses, allow_activation false refuses',
    async t => {
      const f = setup(options());
      t.after(f.close);
      const {id, result} = await launch(f, recipe, brief);
      assert.equal(result.success, true, JSON.stringify(result).slice(0, 600));
      assert.equal(
        result.data.run?.stopped,
        'complete',
        'the build asks for no spend flag: its children start under its own paused campaign',
      );
      assert.deepEqual(f.mcpCalls, ['create_from_recipe', 'approve', 'approve', 'run'], 'four calls');
      const created = f.writes.length;
      const {request_id: _key, ...groupBody} = campaignRecipe(recipe, brief).steps[1].arguments.payload;
      const prepare = () =>
        f.write({
          action: 'prepare',
          arguments: {
            action: 'tiktok_smart_plus_adgroup_create',
            account_id: account,
            payload: {
              ...groupBody,
              request_id: '123456789012345',
              campaign_id: '900',
              adgroup_name: 'Second ad group',
              operation_status: 'ENABLE',
            },
          },
        });
      const campaign = f.campaigns.get('900');
      // Read DISABLE: nothing is asked.
      const paused = await prepare();
      assert.equal(paused.success, true, JSON.stringify(paused.error ?? paused.data).slice(0, 500));
      assert.equal(paused.data.execute_requirements.spend_change_confirmed, false);
      // Read ENABLE: the flag is asked at prepare, refused at execute without it, and nothing is sent.
      campaign.operation_status = 'ENABLE';
      const serving = await prepare();
      assert.equal(serving.success, true, JSON.stringify(serving.error ?? serving.data).slice(0, 500));
      assert.equal(serving.data.execute_requirements.spend_change_confirmed, true);
      assert.equal(serving.data.creative_impact.may_affect_serving, true);
      assertRefused(
        await f.write({
          action: 'execute',
          review_id: serving.data.review_id,
          idempotency_key: serving.data.review_id,
          confirmed: true,
        }),
        'SPEND_CONFIRMATION_REQUIRED',
        {
          writes: () => f.writes.length - created,
        },
      );
      // A campaign the review cannot read (neither ENABLE nor DISABLE) is PARENT_SERVING, with parent_unread.
      campaign.operation_status = 'DELETE';
      const unread = await prepare();
      assertRefused(unread, 'PARENT_SERVING', {writes: () => f.writes.length - created});
      assert.equal(unread.error.details.parent_unread, true);
      // The owner's switch: allow_activation false refuses the ENABLE child under a serving campaign.
      campaign.operation_status = 'ENABLE';
      saveSpendPolicy(f.store, admin, {
        gateway,
        account_id: account,
        connection_id: CONNECTION,
        confirmed: true,
        policy: {allow_activation: false},
      });
      assertRefused(await prepare(), 'POLICY_ACTIVATION_FORBIDDEN', {writes: () => f.writes.length - created});
      assert.ok(id);
    },
  );

// ---- Join 9 (c): smartweb x smartedits x smartops (the Smart+ ad files) -----------------------------------------------------------------------------
// A Smart+ Spark ad created ENABLE under an ad group and campaign the review reads serving serves at once: smartops' disclosure (`may_affect_serving`) and the flag
// are asked for each website goal smartweb builds (CLICK, landing page views, CONVERT), and smartedits' patch and pixel rules on the same ad still hold.
test('join 9 (c): a Smart+ Spark ad of each website goal under a serving ad group discloses may_affect_serving and asks the flag; smartedits’ patch and pixel rules still hold', async t => {
  const goals = [
    ['CLICK', 'tiktok_smart_plus_website_traffic', smartPlusBriefs.traffic],
    [
      'TRAFFIC_LANDING_PAGE_VIEW',
      'tiktok_smart_plus_website_traffic',
      {...smartPlusBriefs.traffic, optimization_goal: 'TRAFFIC_LANDING_PAGE_VIEW'},
    ],
    ['CONVERT', 'tiktok_smart_plus_website_conversions', smartPlusBriefs.conversions],
  ];
  for (const [goal, recipe, brief] of goals) {
    const f = setup();
    t.after(f.close);
    const {result} = await launch(f, recipe, brief);
    assert.equal(result.success, true, goal + ' ' + JSON.stringify(result).slice(0, 400));
    assert.equal(f.groups.get('901').optimization_goal, goal);
    const created = f.writes.length;
    f.campaigns.get('900').operation_status = 'ENABLE';
    f.groups.get('901').operation_status = 'ENABLE';
    const {request_id: _unused, ...adBody} = campaignRecipe(recipe, brief).steps[2].arguments.payload;
    const prepared = await f.write({
      action: 'prepare',
      arguments: {
        action: 'tiktok_smart_plus_ad_create',
        account_id: smartPlusWebAccount,
        payload: {...adBody, adgroup_id: '901', ad_name: 'Second ad', operation_status: 'ENABLE'},
      },
    });
    assert.equal(prepared.success, true, goal + ' ' + JSON.stringify(prepared.error ?? prepared.data).slice(0, 500));
    assert.equal(prepared.data.creative_impact.may_affect_serving, true, goal + ': the ad serves at once');
    assert.equal(prepared.data.execute_requirements.spend_change_confirmed, true, goal);
    assert.equal(f.writes.length, created, 'the prepare sent nothing');
    if (goal !== 'CLICK') continue;
    // smartedits' patch rule on the recipe-built ad: a patch is merged by AMCP and handed back whole, nothing is sent.
    const patch = await f.write({
      action: 'prepare',
      arguments: {
        action: 'tiktok_smart_plus_ad_update',
        account_id: smartPlusWebAccount,
        payload: {smart_plus_ad_id: '902', ad_configuration_patch: {creative_auto_add_toggle: true}},
      },
    });
    assertRefused(patch, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length - created});
    assert.ok(
      patch.error.details.fix && patch.error.details.next_call,
      'the merged configuration and the call that prepares it are handed back',
    );
    // smartedits' pixel rule: an ad-level pixel at create is refused for a website ad (its pixel is its ad group's).
    const pixel = await f.write({
      action: 'prepare',
      arguments: {
        action: 'tiktok_smart_plus_ad_create',
        account_id: smartPlusWebAccount,
        payload: {
          ...adBody,
          adgroup_id: '901',
          ad_name: 'Pixel ad',
          operation_status: 'DISABLE',
          ad_configuration: {...adBody.ad_configuration, tracking_info: {tracking_pixel_id: '8800'}},
        },
      },
    });
    assertRefused(pixel, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length - created});
  }
});

// ---- Join 3 (search x search2): the Search keyword helpers ---------------------------------------------------------------------------------------------
// Both packages need the same things for the keywords of a Search ad group: the match types, the 1,000 bound, the set a keyword list is compared as
// for the read-back, the state a review keeps and what a rejected keyword looks like. search2 brought them as src/tiktok-search-keywords.ts; search had
// its own three copies in src/tiktok-search-recipe.ts, which the merge deletes. One module, each name exported once under src/, and the one pair helper
// is the one both packs verify with (it was checked identical to search's on 20,000 generated lists before the copy was deleted).
const searchKeywordNames = [
  'tiktokSearchMatchTypes',
  'tiktokSearchKeywordLimit',
  'tiktokSearchKeywordSet',
  'tiktokSearchKeywordReviewSet',
  'tiktokSearchKeywordRejected',
];
const sourcesUnder = dir =>
  fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const path = dir + '/' + entry.name;
    return entry.isDirectory() ? sourcesUnder(path) : path.endsWith('.ts') ? [path] : [];
  });

test('join 3: each Search keyword helper is exported once under src/, from src/tiktok-search-keywords.ts', () => {
  const sources = sourcesUnder('src').map(file => [file, fs.readFileSync(file, 'utf8')]);
  for (const name of searchKeywordNames) {
    const exporters = sources
      .filter(([, text]) => new RegExp('export (?:const|function) ' + name + '\\b').test(text))
      .map(([file]) => file);
    assert.deepEqual(exporters, ['src/tiktok-search-keywords.ts'], name);
  }
});

test('join 3: the pair set of a read-back is the keyword and its match type alone, whatever TikTok adds, in any order; the review set drops only the status and keeps the rejection', async () => {
  const keywords = await import('../dist/src/tiktok-search-keywords.js');
  const read = [
    {keyword: 'trail shoes', match_type: 'PRECISE_WORD', audit_status: 'PASS', keyword_bid_type: 'FOLLOW_ADGROUP'},
    {
      keyword: 'running shoes',
      match_type: 'BROAD_WORD',
      audit_status: 'REJECTED',
      reject_info: [{reason: 'synthetic'}],
    },
  ];
  // Search's case: a read keyword carries keyword_bid_type, which TikTok returns and which defaults to FOLLOW_ADGROUP: it is no difference.
  assert.deepEqual(keywords.tiktokSearchKeywordSet(read), [
    {keyword: 'running shoes', match_type: 'BROAD_WORD'},
    {keyword: 'trail shoes', match_type: 'PRECISE_WORD'},
  ]);
  assert.deepEqual(keywords.tiktokSearchKeywordSet([...read].reverse()), keywords.tiktokSearchKeywordSet(read));
  // search2's case: the state a review keeps loses audit_status (it moves by itself) and keeps every other key, reject_info included, so a rejection
  // between a prepare and its execute is a changed state.
  assert.deepEqual(keywords.tiktokSearchKeywordReviewSet(read), [
    {keyword: 'running shoes', match_type: 'BROAD_WORD', reject_info: [{reason: 'synthetic'}]},
    {keyword: 'trail shoes', match_type: 'PRECISE_WORD', keyword_bid_type: 'FOLLOW_ADGROUP'},
  ]);
  assert.deepEqual(read.map(keywords.tiktokSearchKeywordRejected), [false, true]);
  assert.equal(keywords.tiktokSearchKeywordRejected({keyword: 'a', match_type: 'BROAD_WORD', reject_info: []}), false);
  assert.deepEqual(keywords.tiktokSearchMatchTypes, ['PRECISE_WORD', 'PHRASE_WORD', 'BROAD_WORD']);
  assert.equal(keywords.tiktokSearchKeywordLimit, 1000);
});

// ---- Join 9 (a): smartedits x search2 (src/tiktok-smart-plus-adgroup-updates.ts) -----------------------------------------------------------------------
// Both packages extend the Smart+ ad group edit, and both extensions are spend edits: smartedits makes the schedule type and start editable (T6),
// search2 the keywords of a Search ad group (E6). search2 says what a keyword edit does in one sentence, and knew every other spend edit to be a bid,
// an end time or dayparting; after the merge a keyword edit together with a schedule start edit has to say both, and ask for the flag once.
test('join 9 (a): a keyword edit together with a schedule start edit of a Search ad group shows both effects and asks for the flag once; either alone shows its own', async t => {
  t.mock.timers.enable({apis: ['Date'], now: Date.UTC(2026, 10, 21, 12, 0, 0)});
  const f = setup({world: smartPlusSearchAdvertiser(), account: smartPlusSearchAccount});
  t.after(f.close);
  const brief = {...smartPlusSearchBriefs(CONNECTION).clicks, start_time: '2026-12-01T10:00:00+03:00'};
  const {result} = await launch(f, 'tiktok_smart_plus_search_website', brief);
  assert.equal(result.success, true, JSON.stringify(result).slice(0, 600));
  const group = f.groups.get('901'),
    created = f.writes.length;
  const kept = group.search_keywords.map(({keyword, match_type}) => ({keyword, match_type}));
  const keywords = {search_keywords: [...kept, {keyword: 'shoe deals', match_type: 'BROAD_WORD'}]},
    start = {schedule_start_time: '2026-12-15 07:00:00'};
  const prepare = body =>
    f.write({
      action: 'prepare',
      arguments: {
        action: 'tiktok_smart_plus_adgroup_update',
        account_id: smartPlusSearchAccount,
        payload: {adgroup_id: '901', ...body},
      },
    });
  const keywordSentence = /Changes the keywords this Search ad group can serve on/,
    scheduleSentence = /Changes when or at what price the ad group can spend/;
  const both = await prepare({...keywords, ...start});
  assert.equal(both.success, true, JSON.stringify(both.error ?? both.data).slice(0, 800));
  assert.match(both.data.creative_impact.effect, keywordSentence, 'the keywords');
  assert.match(both.data.creative_impact.effect, scheduleSentence, 'the schedule start');
  assert.deepEqual(Object.keys(both.data.creative_impact.changes).sort(), ['schedule_start_time', 'search_keywords']);
  assert.equal(both.data.execute_requirements.spend_change_confirmed, true);
  const alone = await prepare(keywords);
  assert.match(alone.data.creative_impact.effect, keywordSentence);
  assert.doesNotMatch(
    alone.data.creative_impact.effect,
    scheduleSentence,
    'a keyword edit alone says nothing of the schedule',
  );
  const later = await prepare(start);
  assert.match(later.data.creative_impact.effect, scheduleSentence);
  assert.doesNotMatch(
    later.data.creative_impact.effect,
    keywordSentence,
    'a schedule edit alone says nothing of the keywords',
  );
  // The flag is asked once, for the one edit: refused at execute without it with nothing sent, sent once with it.
  const key = both.data.review_id;
  assertRefused(
    await f.write({action: 'execute', review_id: key, idempotency_key: key, confirmed: true}),
    'SPEND_CONFIRMATION_REQUIRED',
    {writes: () => f.writes.length - created},
  );
  const done = await f.write({
    action: 'execute',
    review_id: key,
    idempotency_key: key,
    confirmed: true,
    spend_change_confirmed: true,
  });
  assert.equal(done.success, true, JSON.stringify(done.error ?? done.data).slice(0, 800));
  assert.equal(f.writes.length - created, 1, 'one update was sent');
  assert.equal(group.schedule_start_time, '2026-12-15 07:00:00');
  assert.equal(group.search_keywords.length, kept.length + 1);
});

// ---- Item 4 (search x search2): the account-level negative keywords are a module of search's family --------------------------------------------------------
// search2 adds the ADVERTISER level of the negative keyword routes as a wrapper (withTiktokAccountNegativeKeywords) that search's rewritten family is
// registered through. The wrapper answers for a plan whose body names object_type ADVERTISER and defers to the family for every other plan, so every hook
// of the family that reads the request's object type has to be one the wrapper names: a hook it left out would run the campaign and ad group logic on an
// account plan. Stage 1's family reads object_type in tiktokNegativeKeywordEdit, which its assert, reads, follow-up reads, prerequisites, impact and
// verification all call; the rest of its hooks read the route, the marker of a read or `replace`, and are the family's own on purpose.
test('item 4: the wrapper of the account-level negative keywords names every hook of the family that reads object_type, and one family claims every body', async () => {
  const {reviewedFamilies, familyOf} = await import('../dist/src/reviewed-families.js');
  const {tiktokNegativeKeywordFamily: base} = await import('../dist/src/tiktok-negative-keywords.js');
  const registered = reviewedFamilies().filter(f => f.name === 'tiktok_negative_keywords');
  assert.equal(registered.length, 1, 'one family of that name');
  const [wrapped] = registered;
  assert.notEqual(wrapped, base, 'the registry holds the family with the account level added');
  const named = ['assert', 'snapshots', 'followUps', 'prerequisites', 'impact', 'verification'];
  // The route (method and path), the marker a read carries, the kind (an update names new_keyword_id at every level) and `replace` (the account level
  // refuses it, so an add never widens and an update or a delete always does, as at the other two levels): none of these reads object_type.
  const own = [
    'kind',
    'isRead',
    'reader',
    'validateState',
    'snapshotState',
    'outcome',
    'observed',
    'spendConfirmation',
    'activates',
    'destructive',
  ];
  const hooks = Object.keys(base).filter(key => key !== 'name' && key !== 'files');
  assert.deepEqual(
    [...hooks].sort(),
    [...named, ...own].sort(),
    'every hook of the family is classified: one added to it later is named by the wrapper or listed here with its reason',
  );
  for (const key of named) assert.notEqual(wrapped[key], base[key], key + ' is named by the wrapper');
  for (const key of own) assert.equal(wrapped[key], base[key], key + ' is the family’s own');
  // One family claims the account body and the bodies of the other two levels; the family's own gate alone would refuse the account one.
  const body = {
    advertiser_id: '123',
    object_type: 'ADVERTISER',
    object_ids: ['123'],
    keywords: [{name: 'free shipping', match_type: 'BROAD_WORD'}],
  };
  const account = compile('tiktok_search_ad_negative_keyword_add', body);
  assert.equal(familyOf(account), wrapped);
  assert.doesNotThrow(() => assertWriteShape(account), 'the wrapper accepts the account body');
  assert.throws(
    () => base.assert(account),
    /object_type must be CAMPAIGN or ADGROUP/,
    'search’s gate alone refuses it',
  );
  for (const level of ['CAMPAIGN', 'ADGROUP'])
    assert.equal(
      familyOf(compile('tiktok_search_ad_negative_keyword_add', {...body, object_type: level, object_ids: ['456']})),
      wrapped,
      level,
    );
});

// ---- Join 8 (field2-access x smartweb x smartops x classic): the shared core ---------------------------------------------------------------------------
// Four packages edit the same shared files: field2-access adds a trailing `runPlan` callback to the CampaignRunner (src/service.ts passes it after
// spendEffects, and a mis-ordered positional slot would fail silently, handing one callback's work to another), smartweb binds a Smart+ plan's request IDs
// when the plan is saved, smartops asks the spend flag of a child created under a serving parent, and classic makes the deprecation refusal a template with
// values. Each test runs the real service (src/service.ts builds its runner), with a Meta login beside the TikTok advertiser on one transport.
test('join 8 (a): the runner slots hold the right callbacks: a Meta activation reads the account pixel list through runPlan, and a status-only plan names its spend_steps', async t => {
  const f = setup({meta: true});
  t.after(f.close);
  const steps = activationSteps('meta', new Map([['campaign', {data: {id: '42'}}]]), {
    connection_id: META_LOGIN,
    account_id: '123',
  });
  const created = await f.call({action: 'create', name: 'Meta activation', brief: 'Synthetic.', steps});
  assert.equal(created.success, true, JSON.stringify(created.error ?? created.data).slice(0, 500));
  const saved = f.store.document(actor.tenantId, 'campaign_run', created.data.id);
  f.store.putDocument(
    actor.tenantId,
    'campaign_run',
    created.data.id,
    {...saved, activation_of: {id: 'launch', platform: 'meta', meta_pixel_id: '456'}},
    saved.revision,
  );
  // runPlan: the gate reads the ad account's pixel list (one page, the two fields) and never the pixel node, and sends nothing.
  f.graph.length = 0;
  const checked = await f.call({action: 'preflight', id: created.data.id, detail: 'full'});
  assert.equal(checked.success, true, JSON.stringify(checked.error ?? checked.data).slice(0, 500));
  assert.equal(checked.data.preflight.status, 'ready', JSON.stringify(checked.data.preflight));
  assert.deepEqual(checked.data.preflight.activation_gates, [
    {gate: 'meta_pixel', step: 'activate_campaign', status: 'gate_passed'},
  ]);
  assert.deepEqual(
    f.graph.filter(r => r.path === metaPixelListPath).map(r => r.query),
    [{fields: 'id,is_unavailable', limit: '100'}],
  );
  assert.ok(!f.graph.some(r => r.path === metaPrefix + '456'), 'the pixel node is never read');
  assert.ok(
    f.graph.every(r => r.method === 'GET'),
    'the gate reads and writes nothing',
  );
  // spendEffects: the same plan is status-only, and its approval names the step whose spend it shows (M3 join 15 (c)).
  const preview = await f.call({action: 'approve', id: created.data.id});
  assert.equal(preview.success, true, JSON.stringify(preview.error ?? preview.data).slice(0, 500));
  assert.deepEqual(preview.data.approval.spend_steps, ['activate_campaign']);
});

test('join 8 (b): on the same service a Smart+ recipe plan binds its two request IDs when it is saved, an ENABLE ad group under a serving campaign is asked the flag naming its parent, and Meta and Snapchat have no such hook', async t => {
  const f = setup({meta: true});
  t.after(f.close);
  // createPlan (smartweb's bindToPlan): the campaign and the ad group each carry a key of their own, derived when the plan is saved.
  const created = await f.call({
    action: 'create_from_recipe',
    recipe: 'tiktok_smart_plus_website_traffic',
    business: smartPlusBriefs.traffic,
  });
  assert.equal(created.success, true, JSON.stringify(created.error ?? created.data).slice(0, 500));
  const plan = (await f.call({action: 'get', id: created.data.id, detail: 'full'})).data,
    keys = plan.steps.map(s => s.arguments?.payload?.request_id).filter(key => key !== undefined);
  assert.equal(keys.length, 2, 'two creates need a key');
  for (const key of keys) assert.match(key, /^[1-9][0-9]{0,18}$/, 'a number, not the placeholder');
  assert.notEqual(keys[0], keys[1]);
  // smartops' Q1 through the preflight of src/preflight.ts: a child created ENABLE under a campaign the review reads serving asks the flag and names it.
  const {result} = await launch(f, 'tiktok_smart_plus_website_traffic', smartPlusBriefs.traffic);
  assert.equal(result.success, true, JSON.stringify(result).slice(0, 500));
  const sent = f.writes.length;
  f.campaigns.get('900').operation_status = 'ENABLE';
  const {request_id: _key, ...groupBody} = campaignRecipe('tiktok_smart_plus_website_traffic', smartPlusBriefs.traffic)
    .steps[1].arguments.payload;
  const prepared = await f.write({
    action: 'prepare',
    arguments: {
      action: 'tiktok_smart_plus_adgroup_create',
      account_id: smartPlusWebAccount,
      payload: {
        ...groupBody,
        request_id: '123456789012345',
        campaign_id: '900',
        adgroup_name: 'Second ad group',
        operation_status: 'ENABLE',
      },
    },
  });
  assert.equal(prepared.success, true, JSON.stringify(prepared.error ?? prepared.data).slice(0, 500));
  const refused = await f.write({
    action: 'execute',
    review_id: prepared.data.review_id,
    idempotency_key: prepared.data.review_id,
    confirmed: true,
  });
  assertRefused(refused, 'SPEND_CONFIRMATION_REQUIRED', {writes: () => f.writes.length - sent});
  assert.deepEqual(
    refused.error.details,
    {parent: 'Smart+ campaign', parent_status: 'ENABLE'},
    'the refusal names the parent it read, by kind and status',
  );
  // The hook is TikTok's own: the other two providers that pause their parents keep none, so their children are asked as before.
  for (const other of ['meta_native_action', 'snapchat_native_action'])
    assert.equal(providerHooks(other)?.writes?.activatesUnderServingParent, undefined, other);
  assert.equal(typeof providerHooks(gateway).writes.activatesUnderServingParent, 'function');
});

test('join 8 (c): the shared refusal text: an ownership refusal of another provider names no call that does not exist, classic’s deprecation carries its template values with Arabic, and DV360’s and Reddit’s are composed as before', async t => {
  restoreClockAfter(t);
  const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
  // field2-access (S2-1): a RESOURCE_SCOPE_REQUIRED that names neither next_call nor ownership_reads sends the reader to its own message, for any provider.
  const neutral =
    'This refusal names no ownership read: do what its message says (list the resource through its account collection, or use the review that created it), or have an administrator provision an exact resource binding.';
  for (const gatewayName of [gateway, 'meta_native_action', 'snapchat_native_action', 'dv360_native_action']) {
    const shown = errorResult(
      new MirrorError(
        'RESOURCE_SCOPE_REQUIRED',
        'Resource ownership is not established.',
        {gateway: gatewayName, path: '/v1.3/synthetic', account_id: '123'},
        403,
      ),
      'request-1',
      0,
    ).error;
    assert.equal(shown.next_action, neutral, gatewayName);
    assert.match(catalog[neutral], /[\u0600-\u06ff]/u, 'the neutral step has Arabic');
  }
  // classic: after the cut-off the raw classic Sales create is a PROVIDER_DEPRECATED whose message and details carry the replacement, and its template has
  // Arabic that keeps the slots and the two action names.
  clock(afterDate);
  let raised;
  try {
    assertWriteShape(
      compile('tiktok_campaign_create', {
        advertiser_id: '123',
        campaign_name: 'Synthetic',
        objective_type: 'WEB_CONVERSIONS',
        budget_mode: 'BUDGET_MODE_INFINITE',
        operation_status: 'DISABLE',
      }),
    );
  } catch (e) {
    raised = e;
  }
  assert.equal(raised?.code, 'PROVIDER_DEPRECATED', String(raised));
  const shown = errorResult(raised, 'request-2', 0).error;
  assert.equal(shown.details.deprecation, 'tiktok_manual_sales_app_lead_creates');
  assert.equal(shown.details.use_action, 'tiktok_smart_plus_campaign_create');
  assert.equal(shown.details.use_recipe, 'tiktok_smart_plus_website_conversions');
  assert.match(shown.message, /tiktok_smart_plus_website_conversions/);
  const templates = Object.keys(catalog).filter(
    key =>
      key.startsWith('TikTok no longer creates manual campaigns') &&
      key.includes('{subject}') &&
      key.includes('{provider}, from {effective_date}; {source}') &&
      key.includes('tiktok_smart_plus_website_conversions'),
  );
  assert.equal(templates.length, 1, 'the one template of the purchases pack’s refusal is catalogued');
  for (const slot of ['{subject}', '{provider}', '{effective_date}', '{source}', 'tiktok_smart_plus_campaign_create'])
    assert.ok(catalog[templates[0]].includes(slot), 'the Arabic keeps ' + slot);
  assert.match(catalog[templates[0]], /[\u0600-\u06ff]/u);
  // DV360's and Reddit's dated refusals are composed in the registry as they always were: the message, then their provider, date and source.
  for (const id of ['dv360_line_item_content_rating_exclusions', 'reddit_report_breakdowns_2026_12']) {
    const entry = providerDeprecation(id);
    let thrown;
    try {
      refuseDeprecated(id, 'Synthetic refusal.');
    } catch (e) {
      thrown = e;
    }
    const out = errorResult(thrown, 'request-3', 0).error;
    assert.equal(out.code, 'PROVIDER_DEPRECATED', id);
    assert.equal(
      out.message,
      'Synthetic refusal. (' + entry.provider + ', from ' + entry.effective_date + '; ' + entry.source_url + ').',
      id,
    );
    assert.equal(out.details.deprecation, id);
    assert.equal(out.next_action, shown.next_action, id + ': the same next step as classic’s, unchanged');
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {smartPlusSearchAccount, smartPlusSearchAdvertiser} from './fixtures/tiktok-smart-plus-search.mjs';

/**
 * R2.5 M4, package r25-m4-search2: Upgraded Smart+ Search for Sales with a website destination (WEB_CONVERSIONS, sales_destination
 * WEBSITE, goals CLICK or CONVERT) and for Lead Generation with an Instant Form. TikTok's hub "Create Upgraded Smart+ Search Ads
 * Campaigns" (https://business-api.tiktok.com/portal/docs/create-upgraded-smart-search-ads-campaigns/v1.3) and its Sales/Web non-catalog
 * page, as the lead's documentation session read them on 2026-11-20 (impl/r25-m4-DOCS-EVIDENCE.md, section 6): the campaign create takes
 * `is_search_campaign: true` (fixed once set), the ad group create takes `search_keywords` (1 to 1,000 items of keyword and match_type)
 * and `automated_keywords_enabled` (allowlisted), and Smart+ Search campaigns are allowlist-only: an advertiser that is not on the list
 * is refused with code 40118 and nothing is created. TikTok's pages, read again on 2026-11-21 (impl/r25-m4-search2-DOCS.md), add what round 2
 * builds in: Search needs campaign budget optimization off and the budget on the ad group, an ad group is custom (MANUAL) targeting on the TikTok
 * placement only, a keyword has rules of its text and a review status (a rejected one carries reject_info), and the account-level negative keywords
 * are object_type ADVERTISER. What they still leave open (the update's replace or merge, which a list that leaves out a rejected keyword relies on
 * and a verification catches, and the other two levels of negative keywords on a Smart+ Search campaign) stays UNVERIFIED, fail closed.
 *
 * A synthetic advertiser answers the reads and the writes (tests/fixtures/tiktok-smart-plus-search.mjs, the fixture of journey J24).
 * Nothing reaches TikTok.
 */
const gateway = 'tiktok_native_action',
  CONNECTION = '24242424-2424-4242-8242-242424242424',
  actor = {tenantId: 'tiktok-smart-plus-search', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'},
  account = smartPlusSearchAccount;

/** A synthetic advertiser behind a service with its own store. `options` are the fixture's (allowlisted, keywordOrder, ...). */
function setup(options = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 91).toString('base64'));
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
  const advertiser = smartPlusSearchAdvertiser(options);
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(advertiser.fetch, undefined, undefined, undefined, 10000),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const call = (tool, input) => service.call(tool, input, actor);
  const prepare = (action, payload) =>
    call('amcp_write', {
      action: 'prepare',
      gateway,
      connection_id: CONNECTION,
      arguments: {action, account_id: account, payload},
    });
  const execute = (id, extra = {}) =>
    call('amcp_write', {action: 'execute', review_id: id, idempotency_key: id, confirmed: true, ...extra});
  const verify = id => call('amcp_campaign', {action: 'verify', review_id: id});
  return {store, service, ...advertiser, call, prepare, execute, verify, close: () => store.close()};
}
const without = (body, ...drop) => {
  const out = {...body};
  for (const k of drop) delete out[k];
  return out;
};

/**
 * A Smart+ website Search campaign as TikTok's Sales/Web pages describe it: WEB_CONVERSIONS, WEBSITE, is_search_campaign, and campaign budget
 * optimization OFF ("When is_search_campaign is true, you can only set budget_optimize_on to false", "Create an Upgraded Smart+ Campaign"), so
 * the budget is the ad groups' own and the campaign carries no limit (BUDGET_MODE_INFINITE).
 */
const campaign = (extra = {}) => ({
  request_id: '810200300501',
  operation_status: 'DISABLE',
  objective_type: 'WEB_CONVERSIONS',
  sales_destination: 'WEBSITE',
  campaign_name: 'Synthetic Smart+ Search web',
  budget_optimize_on: false,
  budget_mode: 'BUDGET_MODE_INFINITE',
  is_search_campaign: true,
  ...extra,
});
/** A Smart+ lead generation Search campaign: LEAD_GENERATION with no destination, and the budget mode left to its default (no limit). */
const leadCampaign = (extra = {}) => ({
  ...without(campaign(), 'sales_destination', 'budget_mode'),
  request_id: '810200300502',
  objective_type: 'LEAD_GENERATION',
  campaign_name: 'Synthetic Smart+ Search leads',
  ...extra,
});
/** A campaign that is no Search campaign: it may keep campaign budget optimization, TikTok's default, and its one daily budget. */
const plainCampaign = (extra = {}) =>
  campaign({
    is_search_campaign: false,
    budget_optimize_on: true,
    budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
    budget: 250,
    ...extra,
  });

test('a paused Smart+ website Search campaign is prepared with no spend flag, created once, and verified with is_search_campaign', async t => {
  const f = setup();
  t.after(f.close);
  const prepared = await f.prepare('tiktok_smart_plus_campaign_create', campaign());
  assert.equal(prepared.success, true, JSON.stringify(prepared.error ?? prepared).slice(0, 800));
  const impact = prepared.data.creative_impact;
  assert.equal(impact.scope, 'smart_plus_campaigns');
  assert.equal(impact.may_affect_serving, false);
  assert.equal(impact.campaign.is_search_campaign, true, 'the review shows that this is a Search campaign');
  assert.match(impact.effect, /Search campaign/);
  // The allowlist is named in the review, so that the person who approves it knows what TikTok decides at the create.
  assert.match(impact.allowlist, /allowlist/);
  assert.match(impact.allowlist, /40118/);
  // Q14 (owner, 2026-11-15): a campaign created DISABLE names no spend.
  assert.equal(prepared.data.execute_requirements.spend_change_confirmed, false);
  const done = await f.execute(prepared.data.review_id);
  assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 800));
  assert.equal(f.writes.length, 1);
  const {advertiser_id, ...sent} = f.writes[0].body;
  assert.deepEqual(sent, campaign(), 'the body is sent as it was reviewed, is_search_campaign included');
  const row = [...f.campaigns.values()][0];
  assert.equal(row.is_search_campaign, true);
  assert.equal(row.operation_status, 'DISABLE');
  const verified = await f.verify(prepared.data.review_id);
  assert.equal(verified.data.status, 'verified', JSON.stringify(verified.data).slice(0, 800));
  assert.ok(
    verified.data.checks[0].checked_fields.includes('is_search_campaign'),
    'the read-back compares is_search_campaign: ' + JSON.stringify(verified.data.checks[0].checked_fields),
  );
  assert.equal((await f.execute(prepared.data.review_id)).data.replayed, true);
  assert.equal(f.writes.length, 1, 'a replay sends nothing');
});

test('a Smart+ lead generation Search campaign is accepted the same way', async t => {
  const f = setup();
  t.after(f.close);
  const prepared = await f.prepare('tiktok_smart_plus_campaign_create', leadCampaign());
  assert.equal(prepared.success, true, JSON.stringify(prepared.error ?? prepared).slice(0, 800));
  assert.equal(prepared.data.creative_impact.campaign.is_search_campaign, true);
  assert.match(prepared.data.creative_impact.effect, /lead generation Search campaign/);
  assert.equal((await f.execute(prepared.data.review_id)).success, true);
  assert.equal([...f.campaigns.values()][0].is_search_campaign, true);
  assert.equal((await f.verify(prepared.data.review_id)).data.status, 'verified');
});

test('is_search_campaign false is a plain campaign: sent as given and verified, with no allowlist in its review, though TikTok reads no such key back', async t => {
  const f = setup();
  t.after(f.close);
  const prepared = await f.prepare('tiktok_smart_plus_campaign_create', plainCampaign());
  assert.equal(prepared.success, true, JSON.stringify(prepared.error ?? prepared).slice(0, 800));
  assert.equal(prepared.data.creative_impact.campaign.is_search_campaign, false);
  assert.equal(prepared.data.creative_impact.allowlist, undefined, 'a plain campaign needs no Search allowlist');
  assert.doesNotMatch(prepared.data.creative_impact.effect, /Search/);
  assert.equal((await f.execute(prepared.data.review_id)).success, true);
  // TikTok's get examples carry no is_search_campaign on a campaign that is not a Search one (the fixture answers so): a missing key is "not
  // Search" (the pages' own reading), so the false that was sent is verified against it (S4-4, the lead's review).
  assert.ok(![...f.campaigns.values()][0].is_search_campaign, 'the row carries no Search flag');
  assert.ok(!Object.hasOwn([...f.campaigns.values()][0], 'is_search_campaign'), 'the key is absent, not false');
  const verified = await f.verify(prepared.data.review_id);
  assert.equal(verified.data.status, 'verified', JSON.stringify(verified.data).slice(0, 800));
  assert.ok(verified.data.checks[0].checked_fields.includes('is_search_campaign'), 'false is still compared');
});

test('a Smart+ campaign create that does not name Search is unchanged: its review carries no Search field', async t => {
  const f = setup();
  t.after(f.close);
  const prepared = await f.prepare('tiktok_smart_plus_campaign_create', without(plainCampaign(), 'is_search_campaign'));
  assert.equal(prepared.success, true, JSON.stringify(prepared.error ?? prepared).slice(0, 800));
  assert.equal(prepared.data.creative_impact.campaign.is_search_campaign, false);
  assert.equal(prepared.data.creative_impact.allowlist, undefined);
  assert.equal((await f.execute(prepared.data.review_id)).success, true);
  const {advertiser_id, ...sent} = f.writes[0].body;
  assert.deepEqual(
    sent,
    without(plainCampaign(), 'is_search_campaign'),
    'no key is added to a body that did not carry it',
  );
  assert.equal((await f.verify(prepared.data.review_id)).data.status, 'verified');
});

// ---- S2-1 (the lead's review of 27528f0e, TikTok's pages read 2026-11-21): Search needs campaign budget optimization OFF. ----
// "When is_search_campaign is true, you can only set budget_optimize_on to false" ("Create an Upgraded Smart+ Campaign"), and TikTok's default
// is true, so a body that leaves the key out is refused too. The budget is the ad groups' own; the campaign carries a limit or none.
test('a Search campaign needs budget_optimize_on false, sent: on, left out and not a boolean are each refused before any request', async t => {
  const f = setup();
  t.after(f.close);
  for (const [name, payload, field] of [
    ['campaign budget optimization on', campaign({budget_optimize_on: true}), 'budget_optimize_on'],
    [
      'on with the budget the pack used to send',
      campaign({budget_optimize_on: true, budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET', budget: 250}),
      'budget_optimize_on',
    ],
    ['the key left out (TikTok defaults it to on)', without(campaign(), 'budget_optimize_on'), 'budget_optimize_on'],
    ['text in place of a boolean', campaign({budget_optimize_on: 'false'}), 'budget_optimize_on'],
    [
      'a lead Search campaign with it on',
      leadCampaign({budget_optimize_on: true, budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET', budget: 250}),
      'budget_optimize_on',
    ],
    // With it off, the campaign's own budget mode is one of the three that need no optimization.
    [
      'a dynamic daily budget on the campaign with it off',
      campaign({budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET', budget: 250}),
      'budget_mode',
    ],
  ]) {
    const r = await f.prepare('tiktok_smart_plus_campaign_create', payload);
    assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_CAMPAIGN', {writes: () => f.writes.length});
    assert.equal(r.error.details.field, field, name + ': ' + r.error.message);
  }
  assert.equal(f.requests.length, 0, 'every one is refused before any request: ' + f.requests.join(' | '));
  // A campaign that is not a Search one keeps TikTok's default, campaign budget optimization: the rule is Search's.
  const plain = await f.prepare('tiktok_smart_plus_campaign_create', without(plainCampaign(), 'budget_optimize_on'));
  assert.equal(plain.success, true, JSON.stringify(plain.error ?? plain).slice(0, 800));
});

test('a Search campaign may carry a daily limit or a total one with CBO off, and verifies with it', async t => {
  const f = setup();
  t.after(f.close);
  for (const [i, extra] of [
    [1, {budget_mode: 'BUDGET_MODE_DAY', budget: 250}],
    [2, {budget_mode: 'BUDGET_MODE_TOTAL', budget: 900}],
    [3, {}],
  ]) {
    const prepared = await f.prepare(
      'tiktok_smart_plus_campaign_create',
      campaign({request_id: '8102003007' + i, ...extra}),
    );
    assert.equal(
      prepared.success,
      true,
      JSON.stringify(extra) + ' ' + JSON.stringify(prepared.error ?? prepared).slice(0, 800),
    );
    assert.equal(prepared.data.creative_impact.campaign.campaign_budget_optimization, false);
    assert.equal((await f.execute(prepared.data.review_id)).success, true);
    assert.equal((await f.verify(prepared.data.review_id)).data.status, 'verified', JSON.stringify(extra));
  }
  assert.deepEqual(
    [...f.campaigns.values()].map(c => [c.budget_optimize_on, c.budget_mode, c.budget ?? null]),
    [
      [false, 'BUDGET_MODE_DAY', 250],
      [false, 'BUDGET_MODE_TOTAL', 900],
      [false, 'BUDGET_MODE_INFINITE', null],
    ],
  );
});

test('the fixture answers a Search campaign with campaign budget optimization on, or left out, as TikTok does: a parameter error, recorded rejected, nothing created', async t => {
  // AMCP's contract refuses it first, so a body that reaches the fixture is one sent around the contract: this is the model the pack's tests run on.
  const f = setup();
  t.after(f.close);
  for (const extra of [{budget_optimize_on: true}, {budget_optimize_on: undefined}]) {
    const response = await f.fetch('https://business-api.tiktok.com/open_api/v1.3/smart_plus/campaign/create/', {
      method: 'POST',
      body: JSON.stringify({advertiser_id: account, ...campaign(extra)}),
    });
    const answer = await response.json();
    assert.equal(answer.code, 40002, JSON.stringify(extra));
    assert.deepEqual(answer.data, {});
  }
  assert.equal(f.campaigns.size, 0, 'nothing was created');
});

test('Search opens no other shape: every other rule of the campaign contract still refuses, before any request', async t => {
  const f = setup();
  t.after(f.close);
  for (const [name, payload, field] of [
    ['text', campaign({is_search_campaign: 'true'}), 'is_search_campaign'],
    ['a number', campaign({is_search_campaign: 1}), 'is_search_campaign'],
    ['null', campaign({is_search_campaign: null}), 'is_search_campaign'],
    ['an app objective', campaign({objective_type: 'APP_PROMOTION'}), 'objective_type'],
    ['an app destination', campaign({sales_destination: 'APP'}), 'sales_destination'],
    ['a website campaign with no destination', without(campaign(), 'sales_destination'), 'sales_destination'],
    ['a lead campaign with a destination', leadCampaign({sales_destination: 'WEBSITE'}), 'sales_destination'],
    ['a catalog campaign', campaign({catalog_enabled: true}), 'catalog_enabled'],
    ['an enabled campaign', campaign({operation_status: 'ENABLE'}), 'operation_status'],
    ['no operation status', without(campaign(), 'operation_status'), 'operation_status'],
    ['no request_id', without(campaign(), 'request_id'), 'request_id'],
    [
      'goal-based budget increase',
      campaign({budget_auto_adjust_strategy: 'AUTO_BUDGET_INCREASE'}),
      'budget_auto_adjust_strategy',
    ],
    ['an iOS dedicated campaign', campaign({campaign_type: 'IOS14_CAMPAIGN'}), 'campaign_type'],
  ]) {
    const r = await f.prepare('tiktok_smart_plus_campaign_create', payload);
    assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_CAMPAIGN', {writes: () => f.writes.length});
    assert.equal(r.error.details.field, field, name + ': ' + r.error.message);
  }
  assert.equal(f.requests.length, 0, 'every one is refused before any request: ' + f.requests.join(' | '));
});

test('the campaign edit family still refuses is_search_campaign: TikTok fixes it once the campaign exists', async t => {
  const f = setup();
  t.after(f.close);
  for (const value of [true, false]) {
    const r = await f.prepare('tiktok_smart_plus_campaign_update', {
      campaign_id: '1800000000000001',
      is_search_campaign: value,
    });
    assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_CAMPAIGN_UPDATE', {writes: () => f.writes.length});
    assert.equal(r.error.details.field, 'is_search_campaign');
  }
  assert.equal(f.requests.length, 0);
});

test('an advertiser without the Smart+ Search allowlist is refused at the campaign create: recorded rejected, nothing is created', async t => {
  const f = setup({allowlisted: false});
  t.after(f.close);
  const prepared = await f.prepare('tiktok_smart_plus_campaign_create', campaign());
  assert.equal(prepared.success, true, JSON.stringify(prepared.error ?? prepared).slice(0, 800));
  assert.match(prepared.data.creative_impact.allowlist, /40118/, 'the review names what TikTok will decide');
  const refused = await f.execute(prepared.data.review_id);
  assert.equal(refused.success, false, JSON.stringify(refused).slice(0, 800));
  assert.equal(refused.error.code, 'PROVIDER_ACCESS_DENIED');
  assert.equal(refused.error.details.provider_code, 40118);
  assert.equal(refused.error.details.layer, 'app_eligibility');
  assert.equal(refused.error.details.submission, 'rejected', 'TikTok declared that it applied nothing');
  assert.equal(f.campaigns.size, 0, 'nothing was created');
  assert.equal(f.writes.length, 1, 'one request left AMCP');
  // The same advertiser can still create a campaign that is not a Search campaign: the refusal is the allowlist's, not a blanket one.
  const plain = await f.prepare('tiktok_smart_plus_campaign_create', plainCampaign({request_id: '810200300599'}));
  assert.equal(plain.success, true, JSON.stringify(plain.error ?? plain).slice(0, 800));
  assert.equal((await f.execute(plain.data.review_id)).success, true);
  assert.equal(f.campaigns.size, 1);
});

// ---- Item 2: the ad group takes search_keywords and automated_keywords_enabled under a Search campaign. ----

/** The keywords of an ad group: {keyword, match_type} items, the match types TikTok's manual Search pages name (PRECISE_WORD, PHRASE_WORD, BROAD_WORD). */
const keywords = [
  {keyword: 'running shoes', match_type: 'PHRASE_WORD'},
  {keyword: 'trail shoes', match_type: 'PRECISE_WORD'},
  {keyword: 'shoe sale', match_type: 'BROAD_WORD'},
];
/**
 * A website CLICK ad group under a Search campaign: custom targeting (MANUAL) and the TikTok search placement only (S2-2, TikTok's Search pages),
 * campaign budget optimization off, so its own dynamic daily budget (with SCHEDULE_FROM_NOW as that mode allows): CPC billing, maximum
 * delivery, no pixel, keywords.
 */
const adgroup = (campaign_id, extra = {}) => ({
  request_id: '810200300601',
  campaign_id,
  operation_status: 'DISABLE',
  adgroup_name: 'Synthetic Smart+ Search ad group',
  promotion_type: 'WEBSITE',
  optimization_goal: 'CLICK',
  bid_type: 'BID_TYPE_NO_BID',
  billing_event: 'CPC',
  targeting_optimization_mode: 'MANUAL',
  targeting_spec: {location_ids: ['102358']},
  budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
  budget: 50,
  schedule_type: 'SCHEDULE_FROM_NOW',
  schedule_start_time: '2026-12-01 00:00:00',
  placement_type: 'PLACEMENT_TYPE_NORMAL',
  placements: ['PLACEMENT_TIKTOK'],
  search_keywords: keywords,
  ...extra,
});
/** A conversion ad group: a pixel and a purchase event, OCPM billing. */
const convertGroup = (campaign_id, extra = {}) =>
  adgroup(campaign_id, {
    request_id: '810200300602',
    optimization_goal: 'CONVERT',
    pixel_id: '8800',
    optimization_event: 'SHOPPING',
    billing_event: 'OCPM',
    ...extra,
  });
/** An Instant Form lead ad group under a lead Search campaign: its own dynamic daily budget, as every Search ad group has. */
const leadGroup = (campaign_id, extra = {}) => ({
  ...without(adgroup(campaign_id), 'bid_type', 'optimization_goal', 'billing_event'),
  request_id: '810200300603',
  promotion_type: 'LEAD_GENERATION',
  promotion_target_type: 'INSTANT_PAGE',
  optimization_goal: 'LEAD_GENERATION',
  bid_type: 'BID_TYPE_NO_BID',
  billing_event: 'OCPM',
  ...extra,
});
/** A Smart+ Spark Ad from an existing post, as the guided pack builds it. */
const ad = (adgroup_id, extra = {}) => ({
  adgroup_id,
  ad_name: 'Synthetic Smart+ Search ad',
  operation_status: 'ENABLE',
  creative_list: [
    {
      creative_info: {
        ad_format: 'SINGLE_VIDEO',
        tiktok_item_id: '7300000000000000001',
        identity_type: 'TT_USER',
        identity_id: 'tt-identity-1',
      },
    },
  ],
  landing_page_url_list: [{landing_page_url: 'https://example.com/tiktok-landing'}],
  ad_configuration: {
    call_to_action_id: '700',
    creative_auto_add_toggle: false,
    creative_auto_enhancement_strategy_list: [],
  },
  ...extra,
});
/** Prepares, executes and verifies one create; returns the ID of the entity it made (what its verification read). */
async function build(f, action, payload) {
  const prepared = await f.prepare(action, payload);
  assert.equal(prepared.success, true, action + ': ' + JSON.stringify(prepared.error ?? prepared).slice(0, 1200));
  const done = await f.execute(prepared.data.review_id);
  assert.equal(done.success, true, action + ': ' + JSON.stringify(done.error ?? done).slice(0, 1200));
  const verified = await f.verify(prepared.data.review_id);
  assert.equal(verified.data.status, 'verified', action + ': ' + JSON.stringify(verified.data).slice(0, 1200));
  return {prepared, id: String(verified.data.checks[0].resource_id), review: prepared.data.review_id};
}
const searchCampaign = async (f, extra) => (await build(f, 'tiktok_smart_plus_campaign_create', campaign(extra))).id;
/** A campaign row TikTok would hold for a shape the contract does not create (a TRAFFIC Search campaign made in the UI, a catalog one, one that serves). */
const seed = (f, id, extra) =>
  f.campaigns.set(id, {
    campaign_id: id,
    campaign_name: 'Synthetic seeded campaign',
    objective_type: 'WEB_CONVERSIONS',
    sales_destination: 'WEBSITE',
    budget_optimize_on: false,
    budget_mode: 'BUDGET_MODE_INFINITE',
    operation_status: 'DISABLE',
    catalog_enabled: false,
    is_search_campaign: true,
    ...extra,
  });

test('a CLICK keyword ad group under a Search campaign is prepared with no spend flag, created once, and verified with its keywords as a set', async t => {
  // The fixture reads the keywords back reversed and with a review status that moves by itself: neither is a difference.
  const f = setup({keywordOrder: 'reversed'});
  t.after(f.close);
  const campaignId = await searchCampaign(f);
  // ENABLE under the campaign the review reads DISABLE (Q14, L1-05): a paused creation.
  const payload = adgroup(campaignId, {operation_status: 'ENABLE'});
  const prepared = await f.prepare('tiktok_smart_plus_adgroup_create', payload);
  assert.equal(prepared.success, true, JSON.stringify(prepared.error ?? prepared).slice(0, 1200));
  const impact = prepared.data.creative_impact;
  assert.equal(impact.scope, 'smart_plus_adgroups');
  assert.equal(impact.may_affect_serving, false);
  assert.match(impact.effect, /website click Search ad group/);
  assert.equal(impact.adgroup.search.keywords, 3);
  assert.deepEqual(impact.adgroup.search.by_match_type, {PRECISE_WORD: 1, PHRASE_WORD: 1, BROAD_WORD: 1});
  assert.equal(impact.adgroup.search.automated_keywords_enabled, false);
  assert.equal(
    prepared.data.execute_requirements.spend_change_confirmed,
    false,
    'Q14: a paused creation names no spend',
  );
  assert.ok(!f.requests.some(r => r.includes('/pixel/')), 'a click ad group reads no pixel');
  const before = f.writes.length;
  const done = await f.execute(prepared.data.review_id);
  assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 1200));
  assert.equal(f.writes.length, before + 1);
  const {advertiser_id, ...sent} = f.writes.at(-1).body;
  assert.deepEqual(sent, payload, 'the body is sent as it was reviewed, the keywords in their order');
  const verified = await f.verify(prepared.data.review_id);
  assert.equal(verified.data.status, 'verified', JSON.stringify(verified.data).slice(0, 1200));
  assert.ok(verified.data.checks[0].checked_fields.includes('search_keywords'));
  assert.equal((await f.execute(prepared.data.review_id)).data.replayed, true);
  assert.equal(f.writes.length, before + 1, 'a replay sends nothing');
  const stored = [...f.groups.values()][0];
  assert.deepEqual(stored.search_keywords, keywords);
});

test('a keyword ad group may switch automated keywords on; the review says what the pages say of an allowlist and that TikTok’s answer decides, and the read-back carries it', async t => {
  const f = setup();
  t.after(f.close);
  const campaignId = await searchCampaign(f);
  const payload = adgroup(campaignId, {automated_keywords_enabled: true});
  const prepared = await f.prepare('tiktok_smart_plus_adgroup_create', payload);
  assert.equal(prepared.success, true, JSON.stringify(prepared.error ?? prepared).slice(0, 1200));
  assert.equal(prepared.data.creative_impact.adgroup.search.automated_keywords_enabled, true);
  // S4-1: the manual Search pages list an allowlist for automated keywords; the Smart+ pages say none, and call the option recommended (default off).
  assert.match(
    prepared.data.creative_impact.automated_keywords,
    /manual Search pages list automated keywords as allowlisted/,
  );
  assert.match(prepared.data.creative_impact.automated_keywords, /Smart\+ pages do not say so/);
  assert.match(prepared.data.creative_impact.automated_keywords, /answer decides/);
  assert.match(prepared.data.creative_impact.automated_keywords, /40118/);
  assert.equal((await f.execute(prepared.data.review_id)).success, true);
  assert.equal([...f.groups.values()][0].automated_keywords_enabled, true);
  assert.equal((await f.verify(prepared.data.review_id)).data.status, 'verified');
});

test('a CONVERT keyword ad group reads its pixel and verifies, and an Instant Form lead ad group takes keywords under a lead Search campaign', async t => {
  const f = setup();
  t.after(f.close);
  const campaignId = await searchCampaign(f);
  const converted = await f.prepare('tiktok_smart_plus_adgroup_create', convertGroup(campaignId));
  assert.equal(converted.success, true, JSON.stringify(converted.error ?? converted).slice(0, 1200));
  assert.ok(
    converted.data.state_reads.some(r => r.path === '/v1.3/pixel/list/'),
    'a conversion ad group reads its pixel',
  );
  assert.match(converted.data.creative_impact.effect, /website conversion Search ad group/);
  assert.equal((await f.execute(converted.data.review_id)).success, true);
  assert.equal((await f.verify(converted.data.review_id)).data.status, 'verified');

  const lead = await build(f, 'tiktok_smart_plus_campaign_create', leadCampaign());
  const group = await f.prepare('tiktok_smart_plus_adgroup_create', leadGroup(lead.id));
  assert.equal(group.success, true, JSON.stringify(group.error ?? group).slice(0, 1200));
  assert.match(group.data.creative_impact.effect, /Instant Form lead generation Search ad group/);
  assert.equal((await f.execute(group.data.review_id)).success, true);
  assert.equal((await f.verify(group.data.review_id)).data.status, 'verified');
});

test('a keyword ad group is refused at prepare when its keywords are malformed, before any request', async t => {
  const f = setup();
  t.after(f.close);
  const many = n => Array.from({length: n}, (_, i) => ({keyword: 'term ' + i, match_type: 'BROAD_WORD'}));
  for (const [name, value, field] of [
    ['no keywords', [], 'search_keywords'],
    ['1,001 keywords', many(1001), 'search_keywords'],
    ['text in place of a list', 'running shoes', 'search_keywords'],
    ['an item that is no record', ['running shoes'], 'search_keywords/0'],
    [
      'a pair twice',
      [
        {keyword: 'shoes', match_type: 'BROAD_WORD'},
        {keyword: 'shoes', match_type: 'BROAD_WORD'},
      ],
      'search_keywords/1',
    ],
    ['an unknown match type', [{keyword: 'shoes', match_type: 'EXACT'}], 'search_keywords/0/match_type'],
    ['a match type in lower case', [{keyword: 'shoes', match_type: 'broad_word'}], 'search_keywords/0/match_type'],
    ['no match type', [{keyword: 'shoes'}], 'search_keywords/0/match_type'],
    ['a keyword with a bid', [{keyword: 'shoes', match_type: 'BROAD_WORD', keyword_bid: 1}], 'search_keywords/0'],
    [
      'a keyword with a review status',
      [{keyword: 'shoes', match_type: 'BROAD_WORD', audit_status: 'X'}],
      'search_keywords/0',
    ],
    ['an empty keyword', [{keyword: '', match_type: 'BROAD_WORD'}], 'search_keywords/0/keyword'],
    ['a keyword with surrounding spaces', [{keyword: ' shoes', match_type: 'BROAD_WORD'}], 'search_keywords/0/keyword'],
    ['a keyword that is no text', [{keyword: 7, match_type: 'BROAD_WORD'}], 'search_keywords/0/keyword'],
  ]) {
    const r = await f.prepare('tiktok_smart_plus_adgroup_create', adgroup('90', {search_keywords: value}));
    assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_ADGROUP', {writes: () => f.writes.length});
    assert.equal(r.error.details.field, field, name + ': ' + r.error.message);
  }
  const flag = await f.prepare('tiktok_smart_plus_adgroup_create', adgroup('90', {automated_keywords_enabled: 'yes'}));
  assertRefused(flag, 'INVALID_TIKTOK_SMART_PLUS_ADGROUP', {writes: () => f.writes.length});
  assert.equal(flag.error.details.field, 'automated_keywords_enabled');
  // What the pages leave open stays out of the contract: no search_result_enabled, no pacing, no keyword bid field.
  for (const key of ['search_result_enabled', 'pacing', 'keyword_bid_type', 'keyword_bid']) {
    const r = await f.prepare('tiktok_smart_plus_adgroup_create', adgroup('90', {[key]: 'PACING_MODE_SMOOTH'}));
    assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_ADGROUP', {writes: () => f.writes.length});
    assert.equal(r.error.details.field, key);
  }
  assert.equal(f.requests.length, 0, 'every one is refused before any request: ' + f.requests.join(' | '));
});

// ---- S3-1: TikTok documents the rules of one keyword (P14, P15): at most 80 characters, no emoji, and none of ! # $ % & ( ) * - / : ; < > ? @ \ ^ _ ¥ …. ----
const textRule = /^A keyword is at most 80 characters and has no emoji, no control character and none of /;
const excluded = [...'!#$%&()*-/:;<>?@\\^_¥…'];
test('a keyword is refused locally when it is over 80 characters, holds an emoji, a control character or a character TikTok excludes: in the create, the edit and the pack', async t => {
  const f = setup();
  t.after(f.close);
  const campaignId = await searchCampaign(f);
  const {groupId} = await searchGroup(f);
  const at = (text, extra = {}) => [{keyword: text, match_type: 'BROAD_WORD', ...extra}];
  const bad = [
    ['81 characters', 'a'.repeat(81)],
    ['81 characters of another script', '鞋'.repeat(81)],
    ['an emoji', 'shoes 😀'],
    ['an emoji before the text', '🙂 shoes'],
    ['a hyphen, the commonest one', 'running-shoes'],
    ['an underscore', 'running_shoes'],
    ['a line break', 'running\nshoes'],
    ['a tab', 'running\tshoes'],
    ['a null character', 'running\u0000shoes'],
    ['a delete character', 'running\u007fshoes'],
    ['a next line character', 'running\u0085shoes'],
    ['a line separator', 'running shoes'],
    ...excluded.map(ch => ['the character ' + ch, 'running' + ch + 'shoes']),
  ];
  const writes = f.writes.length;
  for (const [name, text] of bad) {
    const create = await f.prepare(
      'tiktok_smart_plus_adgroup_create',
      adgroup(campaignId, {search_keywords: at(text)}),
    );
    assertRefused(create, 'INVALID_TIKTOK_SMART_PLUS_ADGROUP', {writes: () => f.writes.length - writes});
    assert.equal(create.error.details.field, 'search_keywords/0/keyword', 'create, ' + name);
    assert.match(create.error.message, textRule, 'create, ' + name);
    const update = await f.prepare(
      'tiktok_smart_plus_adgroup_update',
      edit(groupId, {search_keywords: [...keywords, ...at(text)]}),
    );
    assertRefused(update, 'INVALID_TIKTOK_SMART_PLUS_ADGROUP_UPDATE', {writes: () => f.writes.length - writes});
    assert.equal(update.error.details.field, 'search_keywords/3/keyword', 'edit, ' + name);
    assert.match(update.error.message, textRule, 'edit, ' + name);
  }
  // The rule is one sentence for the part it names; the other refusals keep the sentence of the whole list.
  const empty = await f.prepare('tiktok_smart_plus_adgroup_create', adgroup(campaignId, {search_keywords: at('')}));
  assert.doesNotMatch(empty.error.message, textRule);
  // Exactly 80 characters, spaces inside, other scripts, digits and the characters TikTok allows are accepted, and so are 1,000 keywords.
  const fine = [
    ['80 characters', 'a'.repeat(80)],
    ['80 characters of another script', '鞋'.repeat(80)],
    ['spaces and digits', 'running shoes 2026 size 42'],
    ['the characters the page does not exclude', 'men\'s shoes + socks, 2026. [new] {x} "y" ~ | ='],
  ];
  for (const [name, text] of fine) {
    const prepared = await f.prepare(
      'tiktok_smart_plus_adgroup_create',
      adgroup(campaignId, {search_keywords: at(text)}),
    );
    assert.equal(prepared.success, true, name + ': ' + JSON.stringify(prepared.error ?? prepared).slice(0, 600));
  }
  const many = Array.from({length: 1000}, (_, i) => ({keyword: 'term ' + i, match_type: 'BROAD_WORD'}));
  const thousand = await f.prepare('tiktok_smart_plus_adgroup_create', adgroup(campaignId, {search_keywords: many}));
  assert.equal(thousand.success, true, JSON.stringify(thousand.error ?? thousand).slice(0, 600));
  assert.equal(f.writes.length, writes, 'nothing was sent: every refusal is at prepare');
});

test('what the campaign is decides the keywords: a Search campaign needs them, any other refuses them, and only the qualified shapes are Search', async t => {
  const f = setup();
  t.after(f.close);
  const search = await searchCampaign(f),
    plain = (await build(f, 'tiktok_smart_plus_campaign_create', plainCampaign({request_id: '810200300510'}))).id;
  seed(f, '50', {objective_type: 'TRAFFIC', sales_destination: undefined});
  seed(f, '51', {catalog_enabled: true});
  seed(f, '52', {objective_type: 'LEAD_GENERATION', sales_destination: undefined});
  for (const [name, payload, field] of [
    ['a Search campaign without keywords', without(adgroup(search), 'search_keywords'), 'search_keywords'],
    [
      'automated keywords alone under a Search campaign',
      without(adgroup(search, {automated_keywords_enabled: true}), 'search_keywords'),
      'search_keywords',
    ],
    ['keywords under a plain campaign', adgroup(plain), 'search_keywords'],
    [
      'automated keywords under a plain campaign',
      without(adgroup(plain, {automated_keywords_enabled: false}), 'search_keywords'),
      'automated_keywords_enabled',
    ],
    [
      'landing page views under a Search campaign',
      adgroup(search, {optimization_goal: 'TRAFFIC_LANDING_PAGE_VIEW', billing_event: 'OCPM'}),
      'optimization_goal',
    ],
    ['a TRAFFIC Search campaign, which TikTok documents no API shape for', adgroup('50'), 'campaign_id'],
    ['a catalog Search campaign', adgroup('51'), 'campaign_id'],
    ['a website ad group under a lead Search campaign', adgroup('52'), 'campaign_id'],
  ]) {
    const writes = f.writes.length,
      r = await f.prepare('tiktok_smart_plus_adgroup_create', payload);
    assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_ADGROUP', {writes: () => f.writes.length - writes});
    assert.equal(r.error.details.field, field, name + ': ' + r.error.message);
  }
});

// ---- S2-2: a Search ad group uses custom targeting and the TikTok search placement only. ----
// "Audience targeting optimization mode / Custom targeting / targeting_optimization_mode MANUAL" and "Placement / TikTok search result /
// PLACEMENT_TYPE_NORMAL, ["PLACEMENT_TIKTOK"]" (the two Search pages), and the create page's default targeting mode is AUTOMATIC.
test('a Search ad group must send MANUAL targeting and the TikTok search placement alone: each rule is refused at prepare for a website and a lead group, before anything is sent', async t => {
  const f = setup();
  t.after(f.close);
  const web = await searchCampaign(f),
    lead = (await build(f, 'tiktok_smart_plus_campaign_create', leadCampaign())).id;
  const writes = f.writes.length;
  const refusals = [
    // The mode is sent, not defaulted: the create's default is AUTOMATIC.
    [
      'no targeting mode (AUTOMATIC by default)',
      e => without(e, 'targeting_optimization_mode'),
      'targeting_optimization_mode',
    ],
    ['AUTOMATIC targeting', e => ({...e, targeting_optimization_mode: 'AUTOMATIC'}), 'targeting_optimization_mode'],
    ['no placement type (automatic by default)', e => without(e, 'placement_type', 'placements'), 'placement_type'],
    [
      'automatic placement',
      e => ({...without(e, 'placements'), placement_type: 'PLACEMENT_TYPE_AUTOMATIC'}),
      'placement_type',
    ],
    ['the Pangle placement alone', e => ({...e, placements: ['PLACEMENT_PANGLE']}), 'placements'],
    ['TikTok and Pangle', e => ({...e, placements: ['PLACEMENT_TIKTOK', 'PLACEMENT_PANGLE']}), 'placements'],
  ];
  for (const [kind, base] of [
    ['website', adgroup(web)],
    ['lead', leadGroup(lead)],
  ])
    for (const [name, change, field] of refusals) {
      const r = await f.prepare('tiktok_smart_plus_adgroup_create', change(base));
      assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_ADGROUP', {writes: () => f.writes.length - writes});
      assert.equal(r.error.details.field, field, kind + ' ' + name + ': ' + r.error.message);
    }
  // A lead group may place on the app bundle elsewhere: under Search it may not.
  const bundle = await f.prepare(
    'tiktok_smart_plus_adgroup_create',
    leadGroup(lead, {placements: ['PLACEMENT_TIKTOK', 'PLACEMENT_GLOBAL_APP_BUNDLE']}),
  );
  assertRefused(bundle, 'INVALID_TIKTOK_SMART_PLUS_ADGROUP', {writes: () => f.writes.length - writes});
  assert.equal(bundle.error.details.field, 'placements');
  // The documented shape is accepted for both, and MANUAL takes the manual targeting keys the contract already has.
  for (const payload of [
    adgroup(web, {targeting_spec: {location_ids: ['102358'], age_groups: ['AGE_25_34']}}),
    leadGroup(lead),
  ]) {
    const prepared = await f.prepare('tiktok_smart_plus_adgroup_create', payload);
    assert.equal(prepared.success, true, JSON.stringify(prepared.error ?? prepared).slice(0, 800));
    assert.equal(prepared.data.creative_impact.adgroup.targeting.mode, 'MANUAL');
  }
});

test('the TikTok search placement and custom targeting are a Search rule: an ad group of a campaign that is not Search keeps automatic targeting and placement', async t => {
  const f = setup();
  t.after(f.close);
  const plain = (await build(f, 'tiktok_smart_plus_campaign_create', plainCampaign({request_id: '810200300540'}))).id;
  const loose = without(
    adgroup(plain),
    'search_keywords',
    'budget_mode',
    'budget',
    'targeting_optimization_mode',
    'placement_type',
    'placements',
  );
  const prepared = await f.prepare('tiktok_smart_plus_adgroup_create', loose);
  assert.equal(prepared.success, true, JSON.stringify(prepared.error ?? prepared).slice(0, 800));
  assert.equal(prepared.data.creative_impact.adgroup.targeting.mode, 'AUTOMATIC');
  assert.equal((await f.execute(prepared.data.review_id)).success, true);
});

test('the gates a keyword ad group passes through stay shut: a serving or unread parent is PARENT_SERVING, with or without the flag', async t => {
  const f = setup();
  t.after(f.close);
  seed(f, '60', {operation_status: 'ENABLE'});
  const base = f.writes.length;
  // The refusal is at prepare, where no flag exists to give: nothing a caller sends at execute can reach it.
  assertRefused(
    await f.prepare('tiktok_smart_plus_adgroup_create', adgroup('60', {operation_status: 'ENABLE'})),
    'PARENT_SERVING',
    {writes: () => f.writes.length - base},
  );
  // A campaign TikTok does not return is no parent at all.
  assertRefused(await f.prepare('tiktok_smart_plus_adgroup_create', adgroup('61')), 'STATE_TARGET_MISMATCH', {
    writes: () => f.writes.length - base,
  });
});

test('a Spark Ad under a Search ad group is reviewed against an ad group row whose keywords move by themselves, and verifies', async t => {
  // At every read of the ad group the fixture lists its keywords in another order and with another review status: neither is a change of the
  // configuration, so the ad's review is not refused as STATE_CHANGED between its prepare and its execute.
  const f = setup({keywordOrder: 'rotating'});
  t.after(f.close);
  const campaignId = await searchCampaign(f);
  const group = await build(f, 'tiktok_smart_plus_adgroup_create', adgroup(campaignId, {operation_status: 'ENABLE'}));
  const prepared = await f.prepare('tiktok_smart_plus_ad_create', ad(group.id));
  assert.equal(prepared.success, true, JSON.stringify(prepared.error ?? prepared).slice(0, 1200));
  const reads = f.requests.filter(r => r === 'GET /v1.3/smart_plus/adgroup/get/').length;
  const done = await f.execute(prepared.data.review_id);
  assert.ok(
    f.requests.filter(r => r === 'GET /v1.3/smart_plus/adgroup/get/').length > reads,
    'the execute read the ad group again',
  );
  assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 1200));
  assert.equal((await f.verify(prepared.data.review_id)).data.status, 'verified');
  assert.equal(f.ads.size, 1);
});

// ---- S2-1 continued: where the budget of a Search campaign is, and what the go-live says of it. ----
test('a Search ad group carries its own daily budget, the owner’s budget cap reads it there, and the review of the go-live says that these budgets start spending', async t => {
  const f = setup();
  t.after(f.close);
  const campaignId = await searchCampaign(f);
  // The campaign carries no budget, so an ad group without one is refused at prepare, before anything is sent (TikTok: "Required when ... CBO is disabled").
  const base = f.writes.length;
  const none = await f.prepare(
    'tiktok_smart_plus_adgroup_create',
    without(adgroup(campaignId), 'budget_mode', 'budget'),
  );
  assertRefused(none, 'INVALID_TIKTOK_SMART_PLUS_ADGROUP', {writes: () => f.writes.length - base});
  assert.equal(none.error.details.field, 'budget');
  // A lifetime budget needs a schedule with an end, which a pack never has; SCHEDULE_FROM_NOW needs the dynamic daily one.
  const total = await f.prepare(
    'tiktok_smart_plus_adgroup_create',
    adgroup(campaignId, {budget_mode: 'BUDGET_MODE_TOTAL'}),
  );
  assertRefused(total, 'INVALID_TIKTOK_SMART_PLUS_ADGROUP', {writes: () => f.writes.length - base});
  assert.equal(total.error.details.field, 'schedule_type');
  // The owner's cap: the budget it holds an ad group to is the one the ad group create carries (budget 50 here).
  saveSpendPolicy(f.store, admin, {
    scope: 'workspace',
    confirmed: true,
    policy: {enforcement: 'block', max_budget_native: 40},
  });
  // A numeric policy reads amounts. budget_optimize_on names a budget but is a boolean choice (campaign budget optimization), not a cap that is
  // being cleared: the campaign create of the Search pack, which carries no amount, is not refused as one (POLICY_AMOUNT_UNSUPPORTED).
  const underCap = await f.prepare('tiktok_smart_plus_campaign_create', campaign({request_id: '810200300531'}));
  assert.equal(underCap.success, true, JSON.stringify(underCap.error ?? underCap).slice(0, 800));
  assertRefused(await f.prepare('tiktok_smart_plus_adgroup_create', adgroup(campaignId)), 'POLICY_BUDGET_LIMIT', {
    writes: () => f.writes.length - base,
  });
  const within = await f.prepare('tiktok_smart_plus_adgroup_create', adgroup(campaignId, {budget: 30}));
  assert.equal(within.success, true, JSON.stringify(within.error ?? within).slice(0, 1200));
  assert.equal((await f.execute(within.data.review_id)).success, true);
  assert.equal((await f.verify(within.data.review_id)).data.status, 'verified');
  // The go-live: the campaign's own row has no budget that decides spending, and the review says whose budgets do.
  const live = await f.prepare('tiktok_smart_plus_campaign_status_update', {
    campaign_ids: [campaignId],
    operation_status: 'ENABLE',
  });
  assert.equal(live.success, true, JSON.stringify(live.error ?? live).slice(0, 1200));
  const impact = live.data.creative_impact;
  assert.deepEqual(impact.changes[0].budget, {
    campaign_budget_optimization: false,
    campaign_budget_mode: 'BUDGET_MODE_INFINITE',
    campaign_budget: null,
  });
  assert.match(impact.budget_meaning, /no budget of its own/);
  assert.match(impact.budget_meaning, /budget of each of its ad groups/);
  assert.equal(live.data.execute_requirements.spend_change_confirmed, true, 'a go-live needs the flag');
  // A campaign that keeps campaign budget optimization has no such statement: its budget is its own.
  const plainId = (
    await build(f, 'tiktok_smart_plus_campaign_create', plainCampaign({request_id: '810200300530', budget: 30}))
  ).id;
  const plainLive = await f.prepare('tiktok_smart_plus_campaign_status_update', {
    campaign_ids: [plainId],
    operation_status: 'ENABLE',
  });
  assert.equal(plainLive.success, true, JSON.stringify(plainLive.error ?? plainLive).slice(0, 1200));
  assert.equal(plainLive.data.creative_impact.budget_meaning, undefined);
  assert.equal(plainLive.data.creative_impact.changes[0].budget, undefined);
});

// ---- Item 3: keyword edits (E6). ----
// TikTok's "Update an Upgraded Smart+ Ad Group" page (read 2026-11-20, DOCS-EVIDENCE section 4) says the endpoint "supports incremental
// updates" and records no rule for search_keywords: whether a list replaces the ad group's or is merged into it is UNVERIFIED. So AMCP sends
// only the complete list (every keyword the ad group has, and the new ones), which is right in both readings, never part of one.

/** An ad group edit, as the edit family takes it. */
const edit = (adgroup_id, extra = {}) => ({adgroup_id, ...extra});
const more = [{keyword: 'new term', match_type: 'BROAD_WORD'}];
/** The keywords an ad group has, as a review keeps them: a set, in one order (src/tiktok-search-keywords.ts). */
const heldSorted = [
  {keyword: 'running shoes', match_type: 'PHRASE_WORD'},
  {keyword: 'shoe sale', match_type: 'BROAD_WORD'},
  {keyword: 'trail shoes', match_type: 'PRECISE_WORD'},
];
/** A Search campaign with one CLICK keyword ad group, built through the reviewed writes; returns both IDs. */
async function searchGroup(f, extra = {}) {
  const campaignId = await searchCampaign(f);
  const group = await build(f, 'tiktok_smart_plus_adgroup_create', adgroup(campaignId, extra));
  return {campaignId, groupId: group.id};
}

for (const world of ['replace', 'merge']) {
  test(
    'adding keywords to a Search ad group sends the complete list, needs the spend flag and verifies, whether TikTok replaces or merges (' +
      world +
      ')',
    async t => {
      // The fixture lists the keywords in another order at every read and with a review status that moves: the review of the edit is not refused for it.
      const f = setup({keywordOrder: 'rotating', keywordUpdate: world});
      t.after(f.close);
      const {groupId} = await searchGroup(f);
      const payload = edit(groupId, {search_keywords: [...keywords, ...more]});
      const prepared = await f.prepare('tiktok_smart_plus_adgroup_update', payload);
      assert.equal(prepared.success, true, JSON.stringify(prepared.error ?? prepared).slice(0, 1200));
      const impact = prepared.data.creative_impact;
      assert.equal(impact.scope, 'smart_plus_adgroup_edits');
      assert.deepEqual(impact.changes.search_keywords.added, more);
      assert.deepEqual(impact.changes.search_keywords.removed, []);
      assert.equal(impact.changes.search_keywords.before_count, 3);
      assert.equal(impact.changes.search_keywords.after_count, 4);
      assert.match(impact.effect, /keywords/);
      // Keywords change where the ad group can show, so the flag is asked, as for a bid.
      assert.equal(prepared.data.execute_requirements.spend_change_confirmed, true);
      const writes = f.writes.length;
      assertRefused(await f.execute(prepared.data.review_id), 'SPEND_CONFIRMATION_REQUIRED', {
        writes: () => f.writes.length - writes,
      });
      const done = await f.execute(prepared.data.review_id, {spend_change_confirmed: true});
      assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 1200));
      assert.equal(f.writes.length, writes + 1);
      const {advertiser_id, ...sent} = f.writes.at(-1).body;
      assert.deepEqual(sent, payload, 'the complete list is sent as it was reviewed');
      const verified = await f.verify(prepared.data.review_id);
      assert.equal(verified.data.status, 'verified', JSON.stringify(verified.data).slice(0, 1200));
      assert.ok(verified.data.checks[0].checked_fields.includes('search_keywords'));
      assert.equal([...f.groups.values()][0].search_keywords.length, 4);
    },
  );
}

test('a keyword list that leaves out keywords the ad group has is refused with the complete list as the fix, and nothing is sent', async t => {
  const f = setup();
  t.after(f.close);
  const {groupId} = await searchGroup(f);
  const writes = f.writes.length;
  const refused = await f.prepare('tiktok_smart_plus_adgroup_update', edit(groupId, {search_keywords: more}));
  assertRefused(refused, 'INVALID_TIKTOK_SMART_PLUS_ADGROUP_UPDATE', {writes: () => f.writes.length - writes});
  const d = refused.error.details;
  assert.equal(d.field, 'search_keywords');
  assert.match(refused.error.message, /never sends part of one/);
  assert.equal(d.fix_base, 'payload');
  assert.deepEqual(d.fix, [{path: '/search_keywords', value: [...heldSorted, ...more]}]);
  assert.equal(d.next_call.tool, 'amcp_write');
  assert.deepEqual(d.next_call.arguments.arguments.payload, edit(groupId, {search_keywords: [...heldSorted, ...more]}));
  // The fix is the call that works: prepared as handed back, it is an ordinary edit.
  const again = await f.call(d.next_call.tool, {...d.next_call.arguments, connection_id: CONNECTION});
  assert.equal(again.success, true, JSON.stringify(again.error ?? again).slice(0, 800));
  assert.deepEqual(again.data.creative_impact.changes.search_keywords.added, more);
  // A list that restates some of them and leaves out the others is a partial list too, and the fix holds what it left out.
  const partial = await f.prepare(
    'tiktok_smart_plus_adgroup_update',
    edit(groupId, {search_keywords: [keywords[0], ...more]}),
  );
  assertRefused(partial, 'INVALID_TIKTOK_SMART_PLUS_ADGROUP_UPDATE', {writes: () => f.writes.length - writes});
  assert.deepEqual(partial.error.details.fix[0].value, [...heldSorted, ...more]);
  // Nothing is ever removed through an edit of the list: the complete list always holds what the ad group has.
  assert.equal(f.writes.length, writes);
});

test('a merged list over 1,000 keywords has no fix: the refusal says so', async t => {
  const f = setup();
  t.after(f.close);
  const {groupId} = await searchGroup(f);
  const many = Array.from({length: 998}, (_, i) => ({keyword: 'term ' + i, match_type: 'BROAD_WORD'}));
  const writes = f.writes.length;
  const refused = await f.prepare('tiktok_smart_plus_adgroup_update', edit(groupId, {search_keywords: many}));
  assertRefused(refused, 'INVALID_TIKTOK_SMART_PLUS_ADGROUP_UPDATE', {writes: () => f.writes.length - writes});
  assert.equal(refused.error.details.field, 'search_keywords');
  assert.equal(refused.error.details.fix, undefined);
  assert.match(refused.error.message, /1,000/);
});

// ---- S3-2 (E6, the lead's review of 27528f0e): a list that leaves out only keywords TikTok rejected is allowed. ----
// TikTok's own remedy for a rejected keyword is to "remove the violative keywords or replace them" through this update, and there is no keyword
// delete route (P15), which only a list that replaces the stored one can do (the page implies it, and does not say it). So a list may leave out the
// keywords that read REJECTED, and the impact lists them as removed; any other keyword it leaves out is still handed back until a live check shows
// that a list replaces. The read-back stays an exact set, so a TikTok that merges would show it as a mismatch, never silently.
test('a list that leaves out only a rejected keyword is the remedy TikTok names: prepared, the keyword listed as removed by its pair, spend-confirmed, sent as written and verified exactly', async t => {
  const f = setup({rejectedKeywords: ['shoe sale'], keywordOrder: 'rotating'});
  t.after(f.close);
  const {groupId} = await searchGroup(f);
  const payload = edit(groupId, {search_keywords: [keywords[0], keywords[1]]});
  const prepared = await f.prepare('tiktok_smart_plus_adgroup_update', payload);
  assert.equal(prepared.success, true, JSON.stringify(prepared.error ?? prepared).slice(0, 1200));
  const changes = prepared.data.creative_impact.changes.search_keywords;
  assert.deepEqual(changes.removed, [{keyword: 'shoe sale', match_type: 'BROAD_WORD'}]);
  assert.deepEqual(changes.rejected, [{keyword: 'shoe sale', match_type: 'BROAD_WORD'}]);
  assert.deepEqual(changes.added, []);
  assert.equal(changes.before_count, 3);
  assert.equal(changes.after_count, 2);
  assert.match(prepared.data.creative_impact.effect, /every keyword of the ad group back to review/);
  assert.equal(
    prepared.data.execute_requirements.spend_change_confirmed,
    true,
    'a keyword edit is spend-confirmed, removals included',
  );
  const writes = f.writes.length;
  assertRefused(await f.execute(prepared.data.review_id), 'SPEND_CONFIRMATION_REQUIRED', {
    writes: () => f.writes.length - writes,
  });
  const done = await f.execute(prepared.data.review_id, {spend_change_confirmed: true});
  assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 1200));
  const {advertiser_id, ...sent} = f.writes.at(-1).body;
  assert.deepEqual(sent, payload, 'the list is sent as it was reviewed: the rejected keyword is not in it');
  const verified = await f.verify(prepared.data.review_id);
  assert.equal(verified.data.status, 'verified', JSON.stringify(verified.data).slice(0, 1200));
  assert.deepEqual(f.groups.get(groupId).search_keywords, [keywords[0], keywords[1]]);
});

test('a list that leaves out a rejected keyword and one that is not rejected is handed back with the one that is not restored, and the rejected one still out', async t => {
  const f = setup({rejectedKeywords: ['shoe sale']});
  t.after(f.close);
  const {groupId} = await searchGroup(f);
  const writes = f.writes.length;
  // Leaves out 'trail shoes' (it passes or is under review) as well as 'shoe sale' (rejected): AMCP never drops a keyword that may be serving.
  const refused = await f.prepare('tiktok_smart_plus_adgroup_update', edit(groupId, {search_keywords: [keywords[0]]}));
  assertRefused(refused, 'INVALID_TIKTOK_SMART_PLUS_ADGROUP_UPDATE', {writes: () => f.writes.length - writes});
  assert.equal(refused.error.details.field, 'search_keywords');
  assert.match(
    refused.error.message,
    /1 keyword\(s\) this list leaves out/,
    'it counts what it hands back, not the rejected keyword',
  );
  assert.deepEqual(refused.error.details.fix, [{path: '/search_keywords', value: [heldSorted[0], heldSorted[2]]}]);
  // The fix is the call that works.
  const again = await f.call(refused.error.details.next_call.tool, {
    ...refused.error.details.next_call.arguments,
    connection_id: CONNECTION,
  });
  assert.equal(again.success, true, JSON.stringify(again.error ?? again).slice(0, 800));
  assert.deepEqual(again.data.creative_impact.changes.search_keywords.removed, [
    {keyword: 'shoe sale', match_type: 'BROAD_WORD'},
  ]);
  // A list that restates the rejected keyword keeps it: nothing is removed that the caller kept.
  const kept = await f.prepare(
    'tiktok_smart_plus_adgroup_update',
    edit(groupId, {search_keywords: [...keywords, ...more]}),
  );
  assert.equal(kept.success, true, JSON.stringify(kept.error ?? kept).slice(0, 800));
  assert.deepEqual(kept.data.creative_impact.changes.search_keywords.removed, []);
  // Without a rejected keyword nothing may be left out, as before: the hand-back guard stays until a live check shows that a list replaces.
  const g = setup();
  t.after(g.close);
  const group = await searchGroup(g),
    made = g.writes.length;
  const none = await g.prepare(
    'tiktok_smart_plus_adgroup_update',
    edit(group.groupId, {search_keywords: [keywords[0], keywords[1]]}),
  );
  assertRefused(none, 'INVALID_TIKTOK_SMART_PLUS_ADGROUP_UPDATE', {writes: () => g.writes.length - made});
  assert.deepEqual(none.error.details.fix[0].value, heldSorted);
});

test('a TikTok that merges a list instead of replacing it shows the removal of a rejected keyword as a mismatch, never as a success', async t => {
  const f = setup({rejectedKeywords: ['shoe sale'], keywordUpdate: 'merge'});
  t.after(f.close);
  const {groupId} = await searchGroup(f);
  const prepared = await f.prepare(
    'tiktok_smart_plus_adgroup_update',
    edit(groupId, {search_keywords: [keywords[0], keywords[1]]}),
  );
  assert.equal(prepared.success, true, JSON.stringify(prepared.error ?? prepared).slice(0, 800));
  assert.equal((await f.execute(prepared.data.review_id, {spend_change_confirmed: true})).success, true);
  assert.equal(f.groups.get(groupId).search_keywords.length, 3, 'this TikTok kept the keyword');
  const verified = await f.verify(prepared.data.review_id);
  assert.equal(verified.data.status, 'inconclusive', JSON.stringify(verified.data).slice(0, 800));
  assert.ok(
    verified.data.checks[0].changed_fields.includes('/search_keywords'),
    JSON.stringify(verified.data.checks[0].changed_fields),
  );
});

// S4-3: the usual real case is a campaign that already serves. The campaign read the edit makes is its parent's, and the edit is prepared and asks
// for the flag: it is not refused as PARENT_SERVING, which is a rule of the creates.
test('a keyword edit under a campaign that serves is prepared and asks for the spend flag, and is not refused as PARENT_SERVING', async t => {
  const f = setup({keywordOrder: 'rotating'});
  t.after(f.close);
  const campaignId = await searchCampaign(f);
  const group = await build(f, 'tiktok_smart_plus_adgroup_create', adgroup(campaignId, {operation_status: 'ENABLE'}));
  f.campaigns.get(campaignId).operation_status = 'ENABLE';
  const prepared = await f.prepare(
    'tiktok_smart_plus_adgroup_update',
    edit(group.id, {search_keywords: [...keywords, ...more]}),
  );
  assert.equal(prepared.success, true, JSON.stringify(prepared.error ?? prepared).slice(0, 1200));
  assert.equal(
    prepared.data.creative_impact.may_affect_serving,
    true,
    'it changes where an ad group that serves can show',
  );
  assert.equal(prepared.data.execute_requirements.spend_change_confirmed, true);
  const writes = f.writes.length;
  assertRefused(await f.execute(prepared.data.review_id), 'SPEND_CONFIRMATION_REQUIRED', {
    writes: () => f.writes.length - writes,
  });
  const done = await f.execute(prepared.data.review_id, {spend_change_confirmed: true});
  assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 1200));
  assert.equal((await f.verify(prepared.data.review_id)).data.status, 'verified');
});

test('only an ad group of a qualified Search campaign has its keywords edited: a plain campaign, a TRAFFIC Search one and a catalog one are refused', async t => {
  const f = setup();
  t.after(f.close);
  const plain = (await build(f, 'tiktok_smart_plus_campaign_create', plainCampaign({request_id: '810200300520'}))).id;
  const plainGroup = await build(
    f,
    'tiktok_smart_plus_adgroup_create',
    // A plain campaign that keeps campaign budget optimization takes no ad group budget.
    without(adgroup(plain), 'search_keywords', 'budget_mode', 'budget'),
  );
  // An ad group of a campaign the contract does not create: the rows TikTok would hold for them.
  seed(f, '70', {objective_type: 'TRAFFIC', sales_destination: undefined});
  seed(f, '71', {catalog_enabled: true});
  const row = id => ({
    adgroup_id: id,
    campaign_id: id === '7001' ? '70' : '71',
    operation_status: 'DISABLE',
    adgroup_name: 'Seeded',
    promotion_type: 'WEBSITE',
    optimization_goal: 'CLICK',
    search_keywords: keywords,
  });
  f.groups.set('7001', row('7001'));
  f.groups.set('7002', row('7002'));
  const writes = f.writes.length;
  for (const [name, id, extra, field] of [
    ['keywords of a plain campaign', plainGroup.id, {search_keywords: keywords}, 'search_keywords'],
    [
      'automated keywords of a plain campaign',
      plainGroup.id,
      {automated_keywords_enabled: true},
      'automated_keywords_enabled',
    ],
    ['keywords of a TRAFFIC Search campaign', '7001', {search_keywords: keywords}, 'search_keywords'],
    ['keywords of a catalog Search campaign', '7002', {search_keywords: keywords}, 'search_keywords'],
  ]) {
    const r = await f.prepare('tiktok_smart_plus_adgroup_update', edit(id, extra));
    assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_ADGROUP_UPDATE', {writes: () => f.writes.length - writes});
    assert.equal(r.error.details.field, field, name + ': ' + r.error.message);
  }
});

test('automated keywords are switched through an edit that needs the spend flag, and the review says what the pages say of an allowlist', async t => {
  const f = setup();
  t.after(f.close);
  const {groupId} = await searchGroup(f);
  const prepared = await f.prepare(
    'tiktok_smart_plus_adgroup_update',
    edit(groupId, {automated_keywords_enabled: true}),
  );
  assert.equal(prepared.success, true, JSON.stringify(prepared.error ?? prepared).slice(0, 1200));
  assert.match(prepared.data.creative_impact.automated_keywords, /Smart\+ pages do not say so/);
  assert.match(prepared.data.creative_impact.automated_keywords, /40118/);
  assert.equal(prepared.data.execute_requirements.spend_change_confirmed, true);
  assert.equal((await f.execute(prepared.data.review_id, {spend_change_confirmed: true})).success, true);
  assert.equal([...f.groups.values()][0].automated_keywords_enabled, true);
  assert.equal((await f.verify(prepared.data.review_id)).data.status, 'verified');
  const off = await f.prepare('tiktok_smart_plus_adgroup_update', edit(groupId, {automated_keywords_enabled: false}));
  assert.equal(off.success, true, JSON.stringify(off.error ?? off).slice(0, 1200));
  assert.equal(off.data.creative_impact.automated_keywords, undefined, 'switching them off names no allowlist');
});

test('a malformed keyword edit is refused before any request, and a name edit of a Search ad group still reads no campaign and needs no flag', async t => {
  const f = setup();
  t.after(f.close);
  const {groupId} = await searchGroup(f);
  const writes = f.writes.length,
    before = f.requests.length;
  for (const [name, extra, field] of [
    ['no keywords', {search_keywords: []}, 'search_keywords'],
    ['text in place of a list', {search_keywords: 'shoes'}, 'search_keywords'],
    [
      'an unknown match type',
      {search_keywords: [{keyword: 'shoes', match_type: 'EXACT'}]},
      'search_keywords/0/match_type',
    ],
    ['a pair twice', {search_keywords: [keywords[0], keywords[0]]}, 'search_keywords/1'],
    ['an automated flag that is no boolean', {automated_keywords_enabled: 'yes'}, 'automated_keywords_enabled'],
    ['a keyword bid field', {keyword_bid: 1}, 'keyword_bid'],
    ['search_result_enabled', {search_result_enabled: true}, 'search_result_enabled'],
  ]) {
    const r = await f.prepare('tiktok_smart_plus_adgroup_update', edit(groupId, extra));
    assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_ADGROUP_UPDATE', {writes: () => f.writes.length - writes});
    assert.equal(r.error.details.field, field, name + ': ' + r.error.message);
  }
  assert.equal(f.requests.length, before, 'every one is refused before any request');
  const named = await f.prepare(
    'tiktok_smart_plus_adgroup_update',
    edit(groupId, {adgroup_name: 'Renamed Search ad group'}),
  );
  assert.equal(named.success, true, JSON.stringify(named.error ?? named).slice(0, 800));
  assert.equal(named.data.execute_requirements.spend_change_confirmed, false);
  assert.ok(
    !f.requests.slice(before).some(r => r.includes('/smart_plus/campaign/get/')),
    'a name edit reads no campaign: ' + f.requests.slice(before).join(' | '),
  );
  assert.equal((await f.execute(named.data.review_id)).success, true);
});

test('a list cannot restate a keyword that carries a field this edit does not know, so the edit of such a list is refused rather than dropping it', async t => {
  const f = setup();
  t.after(f.close);
  const campaignId = await searchCampaign(f);
  // An ad group whose keyword carries a field that a list of keywords and match types cannot say. TikTok documents none for a Smart+ keyword
  // besides its review status (audit_status, and reject_info on a REJECTED one: P14, P15, P17), so this is the fail-closed case: an unknown key.
  f.groups.set('7100', {
    adgroup_id: '7100',
    campaign_id: campaignId,
    operation_status: 'DISABLE',
    adgroup_name: 'Made in Ads Manager',
    promotion_type: 'WEBSITE',
    optimization_goal: 'CLICK',
    search_keywords: [{...keywords[0], keyword_bid: 0.5}, keywords[1]],
  });
  const writes = f.writes.length;
  for (const search_keywords of [[...keywords.slice(0, 2), ...more], keywords.slice(0, 2)]) {
    const r = await f.prepare('tiktok_smart_plus_adgroup_update', edit('7100', {search_keywords}));
    assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_ADGROUP_UPDATE', {writes: () => f.writes.length - writes});
    assert.equal(r.error.details.field, 'search_keywords');
    assert.match(r.error.message, /a setting this edit does not know/);
    assert.equal(r.error.details.fix, undefined, 'there is no list to hand back that keeps it');
  }
  // Its name and its automated switch are not the list: they are edited as for any ad group.
  const named = await f.prepare('tiktok_smart_plus_adgroup_update', edit('7100', {adgroup_name: 'Renamed'}));
  assert.equal(named.success, true, JSON.stringify(named.error ?? named).slice(0, 800));
});

// ---- S2-3: TikTok's own record of a keyword (audit_status, and reject_info on a REJECTED one) is no setting of the keyword. ----
// The Smart+ keyword item is `keyword`, `match_type`, `audit_status` and, "returned only when audit_status is REJECTED", `reject_info`
// (P14, P15, P17), and TikTok's remedy for a rejected keyword is this very edit. The review state keeps `reject_info`, so a rejection between
// prepare and execute is a change; `audit_status` moves by itself (AUDITING to PASS) and is not one.
test('a keyword TikTok rejected does not stop the edit of the list: the guard reads reject_info as TikTok’s own, the impact names the keyword by its pair without any reason, and the read-back verifies by pairs', async t => {
  const f = setup({rejectedKeywords: ['shoe sale'], keywordOrder: 'rotating'});
  t.after(f.close);
  // The create verified although one keyword reads back REJECTED with a reject_info and the others with a status that moves: the comparison is of
  // {keyword, match_type} pairs, and nothing else of an item.
  const {groupId} = await searchGroup(f);
  const stored = [...f.groups.values()][0];
  assert.ok(
    stored.search_keywords.every(k => Object.keys(k).sort().join() === 'keyword,match_type'),
    'AMCP stored the pairs it sent',
  );
  const payload = edit(groupId, {search_keywords: [...keywords, ...more]});
  const prepared = await f.prepare('tiktok_smart_plus_adgroup_update', payload);
  assert.equal(prepared.success, true, JSON.stringify(prepared.error ?? prepared).slice(0, 1200));
  const changes = prepared.data.creative_impact.changes.search_keywords;
  assert.deepEqual(
    changes.rejected,
    [{keyword: 'shoe sale', match_type: 'BROAD_WORD'}],
    'the rejected keyword, by its pair',
  );
  assert.deepEqual(changes.added, more);
  assert.deepEqual(changes.removed, []);
  // What TikTok wrote of a rejection is its own text: it is in no message and not in the impact. The state the review keeps does hold the record
  // (reject_info, as the lead's review asks), because that is what lets a rejection between prepare and execute be seen as a change.
  assert.deepEqual(
    Object.entries(prepared.data)
      .filter(([, v]) => JSON.stringify(v).includes('Synthetic reason'))
      .map(([k]) => k),
    ['before_state'],
  );
  assert.equal(prepared.data.execute_requirements.spend_change_confirmed, true);
  const done = await f.execute(prepared.data.review_id, {spend_change_confirmed: true});
  assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 1200));
  const verified = await f.verify(prepared.data.review_id);
  assert.equal(verified.data.status, 'verified', JSON.stringify(verified.data).slice(0, 1200));
  assert.equal(f.groups.get(groupId).search_keywords.length, 4);
});

test('a read-back whose keywords carry a field TikTok adds still verifies: the comparison is of keyword and match type alone', async t => {
  const f = setup();
  t.after(f.close);
  const campaignId = await searchCampaign(f);
  const prepared = await f.prepare('tiktok_smart_plus_adgroup_create', adgroup(campaignId));
  assert.equal(prepared.success, true, JSON.stringify(prepared.error ?? prepared).slice(0, 800));
  assert.equal((await f.execute(prepared.data.review_id)).success, true);
  // The manual Search page names a keyword field beyond the status (keyword_bid_type); another may come. None is the write's.
  for (const k of [...f.groups.values()][0].search_keywords) k.keyword_bid_type = 'FOLLOW_ADGROUP';
  const verified = await f.verify(prepared.data.review_id);
  assert.equal(verified.data.status, 'verified', JSON.stringify(verified.data).slice(0, 1200));
});

test('a keyword that TikTok rejects between the prepare and the execute of an edit is a change of the reviewed state; the status moving from AUDITING to PASS is not', async t => {
  const f = setup({keywordOrder: 'rotating'});
  t.after(f.close);
  const {groupId} = await searchGroup(f);
  const prepared = await f.prepare(
    'tiktok_smart_plus_adgroup_update',
    edit(groupId, {search_keywords: [...keywords, ...more]}),
  );
  assert.equal(prepared.success, true, JSON.stringify(prepared.error ?? prepared).slice(0, 1200));
  // Reads between the two moved every status already (the fixture flips them at each read); now one keyword is rejected.
  f.groups.get(groupId).search_keywords[0].reject_info = [
    {forbidden_location: 'KEYWORD', reject_reasons: [{reason: 'Synthetic reason'}]},
  ];
  const writes = f.writes.length;
  assertRefused(await f.execute(prepared.data.review_id, {spend_change_confirmed: true}), 'STATE_CHANGED', {
    writes: () => f.writes.length - writes,
  });
});

// ---- Item 4: the negative keywords of a Smart+ Search campaign. ----
// TikTok's Sales/Web Smart+ Search pages say "Account-level negative keywords will be applied": they are the account's. That level, object_type
// ADVERTISER, is built in round 2 (src/tiktok-account-negative-keywords.ts, tests/tiktok-account-negative-keywords.test.mjs). What this test keeps
// is the refusal of the other two levels for a Smart+ Search campaign, which stands (the pages direct a campaign or ad group ID to the Smart+
// get routes, and no page says that a Smart+ Search campaign takes them: live check M4b LV-31), so that nothing this package adds opens them.
test('a Smart+ Search campaign takes no negative keywords at the levels of its ad group or itself: both are refused, nothing is sent', async t => {
  let held;
  const reply = list =>
    Response.json({
      code: 0,
      message: 'OK',
      request_id: 'r',
      data: {list, page_info: {page: 1, page_size: 100, total_number: list.length, total_page: 1}},
    });
  const f = setup({
    // The classic reads the negative keyword family makes, answered from the objects the Smart+ routes created.
    routes(method, path, url) {
      if (method !== 'GET') return undefined;
      const filtering = JSON.parse(url.searchParams.get('filtering') ?? '{}');
      if (path === '/v1.3/adgroup/get/')
        return reply(
          [...held.groups.values()]
            .filter(
              g =>
                (filtering.adgroup_ids ?? []).includes(g.adgroup_id) ||
                (filtering.campaign_ids ?? []).includes(g.campaign_id),
            )
            .map(g => ({...g, advertiser_id: account})),
        );
      if (path === '/v1.3/campaign/get/')
        return reply(
          [...held.campaigns.values()]
            .filter(c => (filtering.campaign_ids ?? []).includes(c.campaign_id))
            .map(c => ({...c, advertiser_id: account})),
        );
      if (path === '/v1.3/search_ad/negative_keyword/get/')
        return Response.json({
          code: 0,
          message: 'OK',
          request_id: 'r',
          data: {keywords: [], page_info: {page: 1, page_size: 50, total_number: 0, total_page: 1}},
        });
      return undefined;
    },
  });
  held = f;
  t.after(f.close);
  const {campaignId, groupId} = await searchGroup(f);
  const writes = f.writes.length;
  for (const [object_type, id] of [
    ['ADGROUP', groupId],
    ['CAMPAIGN', campaignId],
  ]) {
    const r = await f.prepare('tiktok_search_ad_negative_keyword_add', {
      object_type,
      object_ids: [id],
      keywords: [{name: 'free', match_type: 'BROAD_WORD'}],
    });
    assertRefused(r, 'INVALID_TIKTOK_NEGATIVE_KEYWORD', {writes: () => f.writes.length - writes});
  }
});

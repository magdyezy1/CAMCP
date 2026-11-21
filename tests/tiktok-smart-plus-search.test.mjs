import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {smartPlusSearchAccount, smartPlusSearchAdvertiser} from './fixtures/tiktok-smart-plus-search.mjs';

/**
 * R2.5 M4, package r25-m4-search2: Upgraded Smart+ Search for Sales with a website destination (WEB_CONVERSIONS, sales_destination
 * WEBSITE, goals CLICK or CONVERT) and for Lead Generation with an Instant Form. TikTok's hub "Create Upgraded Smart+ Search Ads
 * Campaigns" (https://business-api.tiktok.com/portal/docs/create-upgraded-smart-search-ads-campaigns/v1.3) and its Sales/Web non-catalog
 * page, as the lead's documentation session read them on 2026-11-20 (impl/r25-m4-DOCS-EVIDENCE.md, section 6): the campaign create takes
 * `is_search_campaign: true` (fixed once set), the ad group create takes `search_keywords` (1 to 1,000 items of keyword and match_type)
 * and `automated_keywords_enabled` (allowlisted), and Smart+ Search campaigns are allowlist-only: an advertiser that is not on the list
 * is refused with code 40118 and nothing is created. Everything the pages leave open (the update's replace or merge, the account-level
 * negative keyword object type, keyword bids, pacing) stays out of the contract: UNVERIFIED, fail closed.
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

/** A Smart+ website Search campaign as TikTok's Sales/Web page describes it: WEB_CONVERSIONS, WEBSITE, is_search_campaign. */
const campaign = (extra = {}) => ({
  request_id: '810200300501',
  operation_status: 'DISABLE',
  objective_type: 'WEB_CONVERSIONS',
  sales_destination: 'WEBSITE',
  campaign_name: 'Synthetic Smart+ Search web',
  budget_optimize_on: true,
  budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
  budget: 250,
  is_search_campaign: true,
  ...extra,
});
/** A Smart+ lead generation Search campaign: LEAD_GENERATION with no destination, and no campaign budget. */
const leadCampaign = (extra = {}) => ({
  ...without(campaign(), 'sales_destination', 'budget', 'budget_mode'),
  request_id: '810200300502',
  objective_type: 'LEAD_GENERATION',
  campaign_name: 'Synthetic Smart+ Search leads',
  budget_optimize_on: false,
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

test('is_search_campaign false is a plain campaign: sent as given and verified, with no allowlist in its review', async t => {
  const f = setup();
  t.after(f.close);
  const prepared = await f.prepare('tiktok_smart_plus_campaign_create', campaign({is_search_campaign: false}));
  assert.equal(prepared.success, true, JSON.stringify(prepared.error ?? prepared).slice(0, 800));
  assert.equal(prepared.data.creative_impact.campaign.is_search_campaign, false);
  assert.equal(prepared.data.creative_impact.allowlist, undefined, 'a plain campaign needs no Search allowlist');
  assert.doesNotMatch(prepared.data.creative_impact.effect, /Search/);
  assert.equal((await f.execute(prepared.data.review_id)).success, true);
  assert.equal((await f.verify(prepared.data.review_id)).data.status, 'verified');
});

test('a Smart+ campaign create that does not name Search is unchanged: its review carries no Search field', async t => {
  const f = setup();
  t.after(f.close);
  const prepared = await f.prepare('tiktok_smart_plus_campaign_create', without(campaign(), 'is_search_campaign'));
  assert.equal(prepared.success, true, JSON.stringify(prepared.error ?? prepared).slice(0, 800));
  assert.equal(prepared.data.creative_impact.campaign.is_search_campaign, false);
  assert.equal(prepared.data.creative_impact.allowlist, undefined);
  assert.equal((await f.execute(prepared.data.review_id)).success, true);
  const {advertiser_id, ...sent} = f.writes[0].body;
  assert.deepEqual(sent, without(campaign(), 'is_search_campaign'), 'no key is added to a body that did not carry it');
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
  const plain = await f.prepare(
    'tiktok_smart_plus_campaign_create',
    campaign({is_search_campaign: false, request_id: '810200300599'}),
  );
  assert.equal(plain.success, true, JSON.stringify(plain.error ?? plain).slice(0, 800));
  assert.equal((await f.execute(plain.data.review_id)).success, true);
  assert.equal(f.campaigns.size, 1);
});

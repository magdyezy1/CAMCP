import test from 'node:test';
import assert from 'node:assert/strict';
import {assertWriteShape} from '../dist/src/write-shape.js';
import {writeImpact} from '../dist/src/write-impact.js';
import {snapshotPlans} from '../dist/src/write-snapshots.js';
import {metaAdSetAudienceChoice, metaPollEndAllVersions, validateMetaV26} from '../dist/src/meta-contracts.js';
import {Registry} from '../dist/src/catalog.js';

/**
 * Meta's v26.0 changelog (Graph API and Marketing API, read 2026-09-29) refuses the Instagram Explore Feed placement
 * and poll components, requires an explicit Advantage+ Audience choice for Housing, Employment and Financial ad sets
 * with constrained targeting, and defaults Shops Ads creatives to WEBSITE_AND_SHOP. AMCP refuses the first three
 * before any request and says the fourth in the review.
 */
const registry = new Registry();
const plan = (action, path, body) => ({
  gateway: 'meta_native_action',
  accountId: '123',
  action,
  method: 'POST',
  path,
  query: {},
  headers: {},
  body,
  readOnly: false,
  destructive: false,
  requiresConfirmation: true,
  evidence: 'synthetic',
  warnings: [],
});
const adSet = (targeting, extra = {}) =>
  plan('meta_ad_account_id_adsets_create', '/v26.0/act_123/adsets', {
    name: 'Set',
    campaign_id: '111',
    status: 'PAUSED',
    daily_budget: '1000',
    billing_event: 'IMPRESSIONS',
    optimization_goal: 'LINK_CLICKS',
    targeting,
    ...extra,
  });
const creative = spec =>
  plan('meta_ad_account_id_adcreatives_create', '/v26.0/act_123/adcreatives', {
    name: 'Creative',
    object_story_spec: {page_id: '500', link_data: {link: 'https://example.com', message: 'Hello'}},
    ...spec,
  });
const refused = (p, code) =>
  assert.throws(
    () => assertWriteShape(p),
    e => e.code === code,
    p.path,
  );

test('the Instagram Explore Feed placement is refused in ad set creation and updates', () => {
  const explore = {geo_locations: {countries: ['US']}, instagram_positions: ['stream', 'explore']};
  refused(adSet(explore), 'META_PLACEMENT_UNAVAILABLE');
  refused(plan('meta_ad_set_id_update', '/v26.0/222', {targeting: explore}), 'META_PLACEMENT_UNAVAILABLE');
  assertWriteShape(adSet({geo_locations: {countries: ['US']}, instagram_positions: ['stream', 'explore_home']}));
});

test('poll components are refused in creatives and ads', () => {
  refused(creative({interactive_components_spec: {components: [{type: 'poll'}]}}), 'META_POLL_UNAVAILABLE');
  refused(creative({interactive_components_spec: {components: [{type: 'POLL'}]}}), 'META_POLL_UNAVAILABLE');
  refused(
    creative({object_story_spec: {page_id: '500', video_data: {poll_spec: {question: 'Q'}}}}),
    'META_POLL_UNAVAILABLE',
  );
  refused(
    plan('meta_ad_account_id_ads_create', '/v26.0/act_123/ads', {
      name: 'Ad',
      adset_id: '222',
      status: 'PAUSED',
      creative: {object_story_spec: {page_id: '500', video_data: {poll_spec: {question: 'Q'}}}},
    }),
    'META_POLL_UNAVAILABLE',
  );
  refused(
    plan('meta_ad_id_update', '/v26.0/333', {creative: {interactive_components_spec: {components: [{type: 'poll'}]}}}),
    'META_POLL_UNAVAILABLE',
  );
  // Other interactive components are not refused as polls (the creative contract qualifies them separately).
  assert.throws(
    () => assertWriteShape(creative({interactive_components_spec: {components: [{type: 'link_sticker'}]}})),
    e => e.code === 'WRITE_CONTRACT_UNAVAILABLE',
  );
  // An ad names an existing creative (an inline one would skip the creative contract), so a non-poll component in an
  // inline creative is refused for that reason, not as a poll.
  assert.throws(
    () =>
      assertWriteShape(
        plan('meta_ad_account_id_ads_create', '/v26.0/act_123/ads', {
          name: 'Ad',
          adset_id: '222',
          status: 'PAUSED',
          creative: {interactive_components_spec: {components: [{type: 'link_sticker'}]}},
        }),
      ),
    e => e.code === 'WRITE_CONTRACT_UNAVAILABLE' && /creative_id/.test(e.message),
  );
  // An ad update that leaves the creative alone continues.
  assertWriteShape(plan('meta_ad_id_update', '/v26.0/333', {status: 'PAUSED'}));
});

test('Housing, Employment and Financial ad sets with constrained targeting need an explicit Advantage+ Audience choice', () => {
  const campaign = categories => [
    {id: '123'},
    {id: '111', name: 'C', status: 'PAUSED', special_ad_categories: categories},
  ];
  const custom = {geo_locations: {countries: ['US']}, custom_audiences: [{id: '9'}]};
  const detailed = {geo_locations: {countries: ['US']}, flexible_spec: [{interests: [{id: '6003', name: 'x'}]}]};
  for (const category of ['HOUSING', 'EMPLOYMENT', 'FINANCIAL_PRODUCTS_SERVICES', 'CREDIT'])
    for (const targeting of [custom, detailed])
      assert.throws(
        () => metaAdSetAudienceChoice(adSet(targeting), campaign([category])),
        e =>
          e.code === 'META_ADVANTAGE_AUDIENCE_REQUIRED' &&
          e.details.field === 'targeting.targeting_automation.advantage_audience',
        category,
      );
  for (const choice of [0, 1])
    metaAdSetAudienceChoice(
      adSet({...custom, targeting_automation: {advantage_audience: choice}}),
      campaign(['HOUSING']),
    );
  metaAdSetAudienceChoice(adSet({geo_locations: {countries: ['US']}}), campaign(['HOUSING'])); // broad
  metaAdSetAudienceChoice(adSet(custom), campaign([])); // no special category
  metaAdSetAudienceChoice(adSet(custom), campaign(['ISSUES_ELECTIONS_POLITICS']));
  assert.throws(
    () =>
      metaAdSetAudienceChoice(adSet({...custom, targeting_automation: {advantage_audience: 2}}), campaign(['HOUSING'])),
    e => e.code === 'META_ADVANTAGE_AUDIENCE_REQUIRED',
  );
});

test('an ad set review reads its campaign special ad categories', () => {
  const reads = snapshotPlans(adSet({geo_locations: {countries: ['US']}}), registry);
  const campaignRead = reads.find(r => r.path === '/v26.0/111');
  assert.ok(campaignRead, JSON.stringify(reads.map(r => r.path)));
  assert.ok(String(campaignRead.query.fields).split(',').includes('special_ad_categories'), campaignRead.query.fields);
});

test('a creative without a chosen destination says in the review that shops default to WEBSITE_AND_SHOP', () => {
  const impact = writeImpact(creative({}), [], false, 'c1');
  assert.equal(impact?.provider, 'meta');
  assert.match(impact.warning, /WEBSITE_AND_SHOP_OPT_OUT/);
  const optOut = creative({destination_spec: {destination_type: 'WEBSITE_AND_SHOP_OPT_OUT'}});
  // The opt-out is said in plain words (tests/meta-shop-opt-out.test.mjs covers the owner's conditions).
  assert.match(writeImpact(optOut, [], false, 'c1').effect, /website only, not your Meta shop/);
  // The creative contract accepts that opt-out and nothing else in destination_spec.
  assertWriteShape(optOut);
  refused(creative({destination_spec: {destination_type: 'WEBSITE_AND_SHOP'}}), 'WRITE_CONTRACT_UNAVAILABLE');
  refused(
    creative({destination_spec: {destination_type: 'WEBSITE_AND_SHOP_OPT_OUT', url: 'https://example.com'}}),
    'WRITE_CONTRACT_UNAVAILABLE',
  );
  // An ad names an existing creative, which keeps that creative's destination.
  assert.equal(
    writeImpact(
      plan('meta_ad_account_id_ads_create', '/v26.0/act_123/ads', {
        name: 'Ad',
        adset_id: '222',
        status: 'PAUSED',
        creative: {creative_id: '77'},
      }),
      [],
      false,
      'c1',
    ),
    undefined,
  );
});

test('at v25.0 only the poll rule applies, and only from 2026-10-27', () => {
  const at25 = p => ({...p, path: p.path.replace('/v26.0/', '/v25.0/')});
  const explore = at25(adSet({geo_locations: {countries: ['US']}, instagram_positions: ['explore']}));
  validateMetaV26(explore, metaPollEndAllVersions + 1);
  const poll = at25(creative({interactive_components_spec: {components: [{type: 'poll'}]}}));
  validateMetaV26(poll, metaPollEndAllVersions - 1);
  assert.throws(
    () => validateMetaV26(poll, metaPollEndAllVersions),
    e => e.code === 'META_POLL_UNAVAILABLE',
  );
  const hef = at25(adSet({geo_locations: {countries: ['US']}, custom_audiences: [{id: '9'}]}));
  metaAdSetAudienceChoice(hef, [{id: '111', special_ad_categories: ['HOUSING']}]);
  assert.equal(writeImpact(at25(creative({})), [], false, 'c1'), undefined);
});

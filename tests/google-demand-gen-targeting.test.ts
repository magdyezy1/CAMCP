import test from 'node:test';
import assert from 'node:assert/strict';
import type {JsonObject} from '../src/types.js';
import {assertRefused} from './helpers/assert-refused.js';
import {adGroup, campaign, googleWorld, type World} from './helpers/google-write-fake.js';

/**
 * R2.5 M3, G6 (owner 2026-11-15): a Demand Gen campaign takes its location and language at the AD-GROUP level. Before, AMCP
 * refused them there as "unqualified" and passed the campaign-level form, which Google answers with `requestError: UNKNOWN`
 * at execute; the White Friday campaign shipped with no geography. Google's Demand Gen pages
 * (developers.google.com/google-ads/api/docs/demand-gen/create-campaign and .../overview) list `location`, `language` and
 * `listing_group` under AdGroupCriterion. That Google refuses the campaign-level form is not documented: it is the owner's live
 * execute (UNVERIFIED), so AMCP refuses it locally and names the ad-group route. VIDEO is not added (QUESTIONS Q5, lead 2026-11-17):
 * nothing confirms it. Synthetic customer 123 throughout.
 */
const campaignRoute = 'google_ads_v23_campaign_criterion_mutate_campaign_criteria',
  adGroupRoute = 'google_ads_v23_ad_group_criterion_mutate_ad_group_criteria',
  criteriaAction = 'ad_group_criterion_mutate_ad_group_criteria',
  campaignCriteriaAction = 'campaign_criterion_mutate_campaign_criteria';
/** Campaigns of each channel, paused (so that G8's rule is not in play), and the ad group under each. */
const world: Partial<World> = {
  campaigns: {
    [campaign(9)]: {status: 'PAUSED', channel: 'DEMAND_GEN'},
    [campaign(10)]: {status: 'PAUSED', channel: 'SEARCH'},
    [campaign(11)]: {status: 'PAUSED', channel: 'VIDEO'},
    // The channel is not returned for this one: a read that did not see it.
    [campaign(12)]: {status: 'PAUSED'},
    // R2.5 M3 round 2, S2-1: Demand Gen campaigns whose upgraded targeting is set. Campaign 9 has no such value in its row, which is
    // Google's default (v25: "defaults to true").
    [campaign(13)]: {status: 'PAUSED', channel: 'DEMAND_GEN', upgradedTargeting: false},
    [campaign(14)]: {status: 'PAUSED', channel: 'DEMAND_GEN', upgradedTargeting: true},
    // A value the review cannot read as true or false.
    [campaign(15)]: {status: 'PAUSED', channel: 'DEMAND_GEN', upgradedTargeting: null},
  },
  adGroups: {
    [adGroup(100)]: {status: 'PAUSED', campaign: campaign(9)},
    [adGroup(101)]: {status: 'PAUSED', campaign: campaign(10)},
    [adGroup(102)]: {status: 'PAUSED', campaign: campaign(11)},
    [adGroup(103)]: {status: 'PAUSED', campaign: campaign(12)},
    [adGroup(104)]: {status: 'PAUSED', campaign: campaign(13)},
    [adGroup(105)]: {status: 'PAUSED', campaign: campaign(14)},
    [adGroup(106)]: {status: 'PAUSED', campaign: campaign(15)},
  },
};
const location = {geoTargetConstant: 'geoTargetConstants/2818'},
  language = {languageConstant: 'languageConstants/1000'};
const inGroup = (group: number, extra: JsonObject): JsonObject => ({create: {adGroup: adGroup(group), ...extra}});
const inCampaign = (id: number, extra: JsonObject): JsonObject => ({create: {campaign: campaign(id), ...extra}});

test('location and language on a Demand Gen ad group are accepted, asked for, sent, and read from its campaign’s channel', async () => {
  const x = googleWorld({world});
  try {
    const review = await x.prepare(criteriaAction, [inGroup(100, {location}), inGroup(100, {language})]);
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 800));
    // The ad group's read asks for its campaign's channel: that is where the rule gets it from.
    assert.ok(
      x.queries().some(q => / FROM ad_group /.test(q) && q.includes('campaign.advertising_channel_type')),
      x.queries().join('\n'),
    );
    // A positive criterion widens delivery, so the spend acknowledgement is still asked for.
    assert.equal(review.data.execute_requirements.spend_change_confirmed, true);
    assertRefused(await x.execute(review, {}), 'SPEND_CONFIRMATION_REQUIRED', {writes: x.writes});
    const done = await x.execute(review);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 800));
    assert.equal(x.writes(), 1);
    const sent = x.log.find(r => r.kind === 'write')!.body.operations;
    assert.deepEqual(
      sent.map((o: any) => Object.keys(o.create).sort()),
      [
        ['ad_group', 'location'],
        ['ad_group', 'language'],
      ].map(keys => keys.sort()),
    );
  } finally {
    x.store.close();
  }
});

test('location and language on an ad group of another channel are refused, naming the channel and the campaign route', async () => {
  const x = googleWorld({world});
  try {
    for (const [group, channel] of [
      [101, 'SEARCH'],
      // Q5: VIDEO stays refused until a document or a live check shows otherwise.
      [102, 'VIDEO'],
    ] as const) {
      const refused = await x.prepare(criteriaAction, [inGroup(group, {language}), inGroup(group, {location})]);
      assertRefused(refused, 'INVALID_TARGETING_MUTATION', {writes: x.writes});
      assert.deepEqual(refused.error.details, {
        operation: 0,
        field: 'operations[0].create.language',
        channel,
        allowed_channels: ['DEMAND_GEN'],
      });
      assert.ok(refused.error.message.includes(campaignRoute), refused.error.message);
    }
    // The second operation is the one named when the first is fine.
    const second = await x.prepare(criteriaAction, [inGroup(100, {language}), inGroup(101, {location})]);
    assertRefused(second, 'INVALID_TARGETING_MUTATION');
    assert.equal(second.error.details.operation, 1);
    assert.equal(second.error.details.field, 'operations[1].create.location');
  } finally {
    x.store.close();
  }
});

test('an ad group whose campaign’s channel was not read is refused, never assumed to be Demand Gen', async () => {
  const x = googleWorld({world});
  try {
    const refused = await x.prepare(criteriaAction, [inGroup(103, {location})]);
    assertRefused(refused, 'INVALID_TARGETING_MUTATION', {writes: x.writes});
    assert.equal(refused.error.details.channel, null);
    assert.deepEqual(refused.error.details.allowed_channels, ['DEMAND_GEN']);
    assert.match(refused.error.message, /could not be read/);
  } finally {
    x.store.close();
  }
});

test('an exclusion on an ad group’s location or language is refused: AMCP has not seen Google accept one', async () => {
  const x = googleWorld({world});
  try {
    for (const key of ['location', 'language'] as const) {
      const record = inGroup(100, {negative: true, [key]: key === 'location' ? location : language});
      // Before any read: the contract refuses it, naming the field, so a free `inspect` shows it too.
      const answer = (await x.inspect(criteriaAction, [record])).data;
      assert.equal(answer.review_contract_supported, false);
      assertRefused({success: false, error: answer.error}, 'INVALID_TARGETING_MUTATION');
      assert.equal(answer.error.details.field, 'operations[0].create.negative');
      assertRefused(await x.prepare(criteriaAction, [record]), 'INVALID_TARGETING_MUTATION', {writes: x.writes});
    }
    // The negative keyword of an ad group is as it was.
    const keyword = await x.prepare(criteriaAction, [
      inGroup(101, {negative: true, keyword: {text: 'free', matchType: 'BROAD'}}),
    ]);
    assert.equal(keyword.success, true, JSON.stringify(keyword).slice(0, 600));
  } finally {
    x.store.close();
  }
});

test('the campaign-level form on a Demand Gen campaign is refused, naming the ad-group route; on a Search campaign it is accepted', async () => {
  const x = googleWorld({world});
  try {
    for (const [key, value] of [
      ['location', location],
      ['language', language],
    ] as const) {
      const refused = await x.prepare(campaignCriteriaAction, [inCampaign(9, {[key]: value})]);
      assertRefused(refused, 'INVALID_TARGETING_MUTATION', {writes: x.writes});
      assert.deepEqual(refused.error.details, {
        operation: 0,
        field: 'operations[0].create.' + key,
        channel: 'DEMAND_GEN',
      });
      assert.ok(refused.error.message.includes(adGroupRoute), refused.error.message);
      // The same criteria on a Search campaign are what they always were: accepted.
      const search = await x.prepare(campaignCriteriaAction, [inCampaign(10, {[key]: value})]);
      assert.equal(search.success, true, JSON.stringify(search).slice(0, 600));
    }
    // A campaign-level exclusion of a Demand Gen campaign other than location and language is not this rule's.
    const keyword = await x.prepare(campaignCriteriaAction, [
      inCampaign(9, {negative: true, keyword: {text: 'free', matchType: 'BROAD'}}),
    ]);
    assert.equal(keyword.success, true, JSON.stringify(keyword).slice(0, 600));
  } finally {
    x.store.close();
  }
});

/**
 * R2.5 M3 round 2, S2-1 (lead review 2026-11-18): which level a Demand Gen campaign takes location and language at is its own
 * `demand_gen_campaign_settings.upgraded_targeting` (immutable, set at create; the pinned v25 Discovery text: "when this field is set to
 * `true`, you can use location and language targeting at the ad group level as opposed to the standard campaign-level targeting. This
 * field defaults to `true`"). A campaign created with upgraded targeting takes them on its ad groups, and one created without it takes
 * them on the campaign, like any other channel: the rule must not refuse the one route Google accepts on an older campaign.
 */
test('a Demand Gen campaign without upgraded targeting takes location and language on the campaign, and refuses the ad-group form naming that route', async () => {
  const x = googleWorld({world});
  try {
    for (const [key, value] of [
      ['location', location],
      ['language', language],
    ] as const) {
      // The campaign-level form, which the upgraded campaign refuses, is accepted here and sent.
      const review = await x.prepare(campaignCriteriaAction, [inCampaign(13, {[key]: value})]);
      assert.equal(review.success, true, key + ' ' + JSON.stringify(review).slice(0, 600));
      assert.equal((await x.execute(review)).success, true);
      // The ad-group form is the one Google would refuse: refused here, naming the campaign route.
      const sent = x.writes(),
        refused = await x.prepare(criteriaAction, [inGroup(104, {[key]: value})]);
      assertRefused(refused, 'INVALID_TARGETING_MUTATION', {writes: () => x.writes() - sent});
      assert.deepEqual(refused.error.details, {
        operation: 0,
        field: 'operations[0].create.' + key,
        channel: 'DEMAND_GEN',
        upgraded_targeting: false,
      });
      assert.ok(refused.error.message.includes(campaignRoute), refused.error.message);
      assert.match(refused.error.message, /without upgraded targeting/);
    }
    assert.equal(x.writes(), 2, 'the two campaign-level creates, and nothing else');
  } finally {
    x.store.close();
  }
});

test('a Demand Gen campaign with upgraded targeting takes them on its ad groups: the ad-group form is accepted and the campaign-level one refused', async () => {
  const x = googleWorld({world});
  try {
    for (const [campaignId, group] of [
      [14, 105],
      // No value in the row is Google's default, true: the campaign 9 and its ad group 100 of the tests above.
      [9, 100],
    ] as const) {
      for (const [key, value] of [
        ['location', location],
        ['language', language],
      ] as const) {
        const review = await x.prepare(criteriaAction, [inGroup(group, {[key]: value})]);
        assert.equal(review.success, true, campaignId + ' ' + key + ' ' + JSON.stringify(review).slice(0, 600));
        const refused = await x.prepare(campaignCriteriaAction, [inCampaign(campaignId, {[key]: value})]);
        assertRefused(refused, 'INVALID_TARGETING_MUTATION', {writes: x.writes});
        assert.deepEqual(refused.error.details, {
          operation: 0,
          field: 'operations[0].create.' + key,
          channel: 'DEMAND_GEN',
        });
        assert.ok(refused.error.message.includes(adGroupRoute), refused.error.message);
      }
    }
    // The value is read from the campaign: by the campaign search of a campaign-level create, and by the ad group's own read
    // (its campaign's fields) for an ad-group-level one.
    assert.ok(
      x
        .queries()
        .some(q => / FROM campaign /.test(q) && q.includes('campaign.demand_gen_campaign_settings.upgraded_targeting')),
      x.queries().join('\n'),
    );
    assert.ok(
      x
        .queries()
        .some(q => / FROM ad_group /.test(q) && q.includes('campaign.demand_gen_campaign_settings.upgraded_targeting')),
      x.queries().join('\n'),
    );
  } finally {
    x.store.close();
  }
});

test('a value of upgraded targeting the review cannot read refuses neither form: the default validate-only decides, and nothing spends', async () => {
  const x = googleWorld({world});
  try {
    for (const [key, value] of [
      ['location', location],
      ['language', language],
    ] as const) {
      const adGroupForm = await x.prepare(criteriaAction, [inGroup(106, {[key]: value})]);
      assert.equal(adGroupForm.success, true, key + ' ' + JSON.stringify(adGroupForm).slice(0, 600));
      const campaignForm = await x.prepare(campaignCriteriaAction, [inCampaign(15, {[key]: value})]);
      assert.equal(campaignForm.success, true, key + ' ' + JSON.stringify(campaignForm).slice(0, 600));
    }
    // Nothing was sent to apply: a positive criterion still asks for the spend acknowledgement at execute, as it did.
    assert.equal(x.writes(), 0);
  } finally {
    x.store.close();
  }
});

test('removing or editing an existing campaign-level criterion of a Demand Gen campaign stays allowed, for cleanup', async () => {
  const x = googleWorld({world});
  try {
    const name = 'customers/123/campaignCriteria/9~77';
    const removal = await x.prepare(campaignCriteriaAction, [{remove: name}]);
    assert.equal(removal.success, true, JSON.stringify(removal).slice(0, 600));
    const edit = await x.prepare(campaignCriteriaAction, [
      {update: {resourceName: name, bidModifier: 1.2}, updateMask: 'bid_modifier'},
    ]);
    assert.equal(edit.success, true, JSON.stringify(edit).slice(0, 600));
    assert.equal((await x.execute(removal)).success, true);
  } finally {
    x.store.close();
  }
});

test('age range and gender on an ad group are as they were, whatever the channel, and still ask for the spend acknowledgement', async () => {
  const x = googleWorld({world});
  try {
    for (const group of [100, 101, 102]) {
      for (const record of [
        inGroup(group, {ageRange: {type: 'AGE_RANGE_18_24'}}),
        inGroup(group, {gender: {type: 'FEMALE'}}),
      ]) {
        const review = await x.prepare(criteriaAction, [record]);
        assert.equal(review.success, true, JSON.stringify(review).slice(0, 600));
        assert.equal(review.data.execute_requirements.spend_change_confirmed, true);
      }
    }
  } finally {
    x.store.close();
  }
});

/** A Demand Gen build: a budget, a campaign of the given channel, a temporary ad group and its criteria. */
const budget = {
  campaign_budget_operation: {
    create: {
      resource_name: 'customers/123/campaignBudgets/-1',
      name: 'DNU budget',
      amount_micros: '40000000',
      delivery_method: 'STANDARD',
      explicitly_shared: false,
    },
  },
};
const newCampaign = (channel: string) => ({
  campaign_operation: {
    create: {
      resource_name: 'customers/123/campaigns/-2',
      name: 'DNU campaign',
      status: 'PAUSED',
      advertising_channel_type: channel,
      campaign_budget: 'customers/123/campaignBudgets/-1',
      maximize_conversions: {},
      contains_eu_political_advertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
    },
  },
});
const newGroup = (parent = 'customers/123/campaigns/-2') => ({
  ad_group_operation: {
    create: {resource_name: 'customers/123/adGroups/-3', name: 'DNU group', campaign: parent, status: 'PAUSED'},
  },
});
const groupCriterion = (key: string, value: JsonObject, group = 'customers/123/adGroups/-3') => ({
  ad_group_criterion_operation: {create: {ad_group: group, [key]: value}},
});
const snakeLocation = {geo_target_constant: 'geoTargetConstants/2818'},
  snakeLanguage = {language_constant: 'languageConstants/1000'};

test('a build checks the criteria under its temporary ad group against its temporary campaign’s channel', async () => {
  const x = googleWorld({world});
  try {
    const demandGen = [
      budget,
      newCampaign('DEMAND_GEN'),
      newGroup(),
      groupCriterion('location', snakeLocation),
      groupCriterion('language', snakeLanguage),
    ];
    const review = await x.prepareBuild(demandGen);
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 900));
    const done = await x.execute(review);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 900));
    assert.equal(x.writes(), 1, 'one request for the whole build');
    // The same build with a Search campaign is refused at the criterion that cannot be, naming it by its index in the build.
    const search = await x.prepareBuild([
      budget,
      newCampaign('SEARCH'),
      newGroup(),
      groupCriterion('language', snakeLanguage),
    ]);
    assertRefused(search, 'INVALID_TARGETING_MUTATION', {writes: () => x.writes() - 1});
    assert.match(search.error.message, /^mutate_operations\[3\]: /);
    assert.equal(search.error.details.operation, 3);
    assert.equal(search.error.details.channel, 'SEARCH');
    assert.deepEqual(search.error.details.allowed_channels, ['DEMAND_GEN']);
  } finally {
    x.store.close();
  }
});

test('a build’s campaign-level location on its Demand Gen campaign is refused, and its ad groups under an existing campaign read its channel', async () => {
  const x = googleWorld({world});
  try {
    const refused = await x.prepareBuild([
      budget,
      newCampaign('DEMAND_GEN'),
      {campaign_criterion_operation: {create: {campaign: 'customers/123/campaigns/-2', location: snakeLocation}}},
    ]);
    assertRefused(refused, 'INVALID_TARGETING_MUTATION');
    assert.match(refused.error.message, /^mutate_operations\[2\]: /);
    assert.equal(refused.error.details.channel, 'DEMAND_GEN');
    assert.ok(refused.error.message.includes(adGroupRoute), refused.error.message);
    // The same on a Search campaign is accepted.
    const search = await x.prepareBuild([
      budget,
      newCampaign('SEARCH'),
      {campaign_criterion_operation: {create: {campaign: 'customers/123/campaigns/-2', location: snakeLocation}}},
    ]);
    assert.equal(search.success, true, JSON.stringify(search).slice(0, 800));
    // A temporary ad group under an EXISTING campaign: the channel is the one the build read, Demand Gen or not.
    const existing = await x.prepareBuild([newGroup(campaign(9)), groupCriterion('location', snakeLocation)]);
    assert.equal(existing.success, true, JSON.stringify(existing).slice(0, 800));
    assert.ok(
      x.queries().some(q => / FROM campaign /.test(q) && q.includes('campaign.advertising_channel_type')),
      'the existing campaign is read with its channel',
    );
    const other = await x.prepareBuild([newGroup(campaign(10)), groupCriterion('location', snakeLocation)]);
    assertRefused(other, 'INVALID_TARGETING_MUTATION');
    assert.equal(other.error.details.channel, 'SEARCH');
    assert.equal(other.error.details.operation, 1);
  } finally {
    x.store.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {adGroup, campaign, googleWorld} from '../dist/tests/helpers/google-write-fake.js';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * R2.5 field fix r25-field-pausedspend (the owner's "yes", 2026-11-19): nothing that cannot serve asks for spend_change_confirmed. A
 * Google child created under a parent the review reads PAUSED can start no spend, so its review asks for no flag at prepare and its
 * execute asks for none either; the same child under a serving parent still asks (Q1), and a parent that is enabled between prepare
 * and execute stops the write (STATE_CHANGED). The rule itself is in tests/google-paused-spend-rule.test.mjs. Synthetic customer 123.
 */
const GROUPS = 'ad_group_mutate_ad_groups';
const worldOf = status => ({
  campaigns: {[campaign(9)]: {status, channel: 'SEARCH'}, [campaign(10)]: {status: 'ENABLED', channel: 'SEARCH'}},
  adGroups: {[adGroup(100)]: {status: 'PAUSED', campaign: campaign(9)}},
  assetGroups: {},
});
const group = (status = 'ENABLED', parent = campaign(9), name = 'DNU group') => ({
  create: {name, campaign: parent, type: 'SEARCH_STANDARD', status},
});
const reasons = review => review.data.execute_requirements.reasons.map(r => r.flag);
const written = x => x.log.find(r => r.kind === 'write')?.body.operations;

test('an ENABLED ad group under a campaign the review reads PAUSED asks for no spend flag at prepare or at execute', async () => {
  const x = googleWorld({world: worldOf('PAUSED')});
  try {
    const review = await x.prepare(GROUPS, [group()]);
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 600));
    const required = review.data.execute_requirements;
    assert.equal(required.spend_change_confirmed, false);
    assert.deepEqual(reasons(review), []);
    assert.equal(review.data.effect, 'config_write');
    assert.equal(x.writes(), 0, 'nothing is sent while preparing');
    const done = await x.execute(review, {});
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 600));
    assert.equal(x.writes(), 1);
    assert.equal(
      written(x)[0].create.status,
      'ENABLED',
      'it is created as reviewed, ENABLED under its paused campaign',
    );
  } finally {
    x.store.close();
  }
});

test('the same ad group under a serving campaign still asks for the flag, and is sent only with it (Q1)', async () => {
  const x = googleWorld({world: worldOf('ENABLED')});
  try {
    const review = await x.prepare(GROUPS, [group()]);
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 600));
    assert.equal(review.data.execute_requirements.spend_change_confirmed, true);
    assert.deepEqual(reasons(review), ['spend_change_confirmed']);
    assert.equal(review.data.effect, 'spend_affecting');
    assertRefused(await x.execute(review, {}), 'SPEND_CONFIRMATION_REQUIRED', {writes: x.writes});
    assert.equal((await x.execute(review)).success, true);
    assert.equal(x.writes(), 1);
  } finally {
    x.store.close();
  }
});

test('inspect reads no state, so it still reports an ENABLED ad group as spend_affecting, under a paused campaign too', async () => {
  const x = googleWorld({world: worldOf('PAUSED')});
  try {
    const inspected = await x.inspect(GROUPS, [group()]);
    assert.equal(inspected.success, true, JSON.stringify(inspected).slice(0, 600));
    assert.equal(inspected.data.effect, 'spend_affecting');
    assert.equal(inspected.data.network_requests, 0);
    assert.equal(x.reads(), 0, 'inspect sends nothing');
  } finally {
    x.store.close();
  }
});

test('a campaign enabled between prepare and execute stops the ad group with STATE_CHANGED, flag or none, and nothing is sent', async () => {
  for (const flags of [{}, {spend_change_confirmed: true}]) {
    const x = googleWorld({world: worldOf('PAUSED')});
    try {
      const review = await x.prepare(GROUPS, [group()]);
      assert.equal(review.data.execute_requirements.spend_change_confirmed, false);
      x.world.campaigns[campaign(9)] = {status: 'ENABLED', channel: 'SEARCH'};
      assertRefused(await x.execute(review, flags), 'STATE_CHANGED', {writes: x.writes});
    } finally {
      x.store.close();
    }
  }
});

test('creates under two campaigns, one PAUSED and one serving, ask for the flag as a request', async () => {
  const x = googleWorld({world: worldOf('PAUSED')});
  try {
    const review = await x.prepare(GROUPS, [
      group('ENABLED', campaign(9), 'DNU one'),
      group('ENABLED', campaign(10), 'DNU two'),
    ]);
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 600));
    assert.equal(review.data.execute_requirements.spend_change_confirmed, true);
    assertRefused(await x.execute(review, {}), 'SPEND_CONFIRMATION_REQUIRED', {writes: x.writes});
  } finally {
    x.store.close();
  }
});

test('a request of 30 ad groups under a paused campaign is two parts that need no flag, and the group executes without one', async () => {
  const x = googleWorld({world: worldOf('PAUSED')});
  try {
    const review = await x.prepare(
      GROUPS,
      Array.from({length: 30}, (_, i) => group('ENABLED', campaign(9), 'DNU group ' + i)),
    );
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 600));
    assert.equal(review.data.group, true);
    assert.equal(review.data.parts.length, 2);
    // A group names a flag, and its reasons, in its requirements only when a part needs one.
    assert.equal(review.data.execute_requirements.spend_change_confirmed, undefined);
    assert.equal(review.data.execute_requirements.reasons, undefined);
    // The group's own pre-check of every part (admit) reads the state each part froze: it asks for nothing the parts did not.
    const done = await x.execute(review, {});
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 600));
    assert.equal(x.writes(), 2);
  } finally {
    x.store.close();
  }
});

test('the same 30 ad groups under a serving campaign ask for the flag once, as a group, and are refused before the first part is sent without it', async () => {
  const x = googleWorld({world: worldOf('ENABLED')});
  try {
    const review = await x.prepare(
      GROUPS,
      Array.from({length: 30}, (_, i) => group('ENABLED', campaign(9), 'DNU group ' + i)),
    );
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 600));
    assert.equal(review.data.execute_requirements.spend_change_confirmed, true);
    assertRefused(await x.execute(review, {}), 'SPEND_CONFIRMATION_REQUIRED', {writes: x.writes});
    assert.equal((await x.execute(review)).success, true);
    assert.equal(x.writes(), 2);
  } finally {
    x.store.close();
  }
});

/**
 * Item 2: a campaign create is pinned PAUSED by the write shape, so it asks for no flag; everything that can start or widen delivery of a
 * campaign still does. The synthetic customer has one existing budget, which the new campaign names.
 */
const CAMPAIGNS = 'campaign_mutate_campaigns';
const BUDGETS = 'campaign_budget_mutate_campaign_budgets';
const budget = 'customers/123/campaignBudgets/1';
const withBudget = status => ({...worldOf(status), campaignBudgets: {[budget]: {amountMicros: '40000000'}}});
const newCampaign = (status = 'PAUSED', extra = {}) => ({
  create: {
    name: 'DNU campaign',
    ...(status === null ? {} : {status}),
    advertising_channel_type: 'SEARCH',
    campaign_budget: budget,
    manual_cpc: {},
    contains_eu_political_advertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
    ...extra,
  },
});

test('a PAUSED campaign create has no spend_change_confirmed in execute_requirements, and is sent without it', async () => {
  const x = googleWorld({world: withBudget('PAUSED')});
  try {
    const review = await x.prepare(CAMPAIGNS, [newCampaign()]);
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 600));
    assert.equal(review.data.execute_requirements.spend_change_confirmed, false);
    assert.deepEqual(reasons(review), []);
    assert.equal(review.data.effect, 'config_write');
    assert.equal(x.writes(), 0, 'nothing is sent while preparing');
    const done = await x.execute(review, {});
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 600));
    assert.equal(x.writes(), 1);
    assert.equal(written(x)[0].create.status, 'PAUSED');
    assert.equal(written(x)[0].create.campaign_budget, budget, 'it is sent as reviewed, budget and all');
  } finally {
    x.store.close();
  }
});

test('inspect says the same of a PAUSED campaign create (the shape needs no state), and still asks for an ENABLED ad group', async () => {
  const x = googleWorld({world: withBudget('PAUSED')});
  try {
    assert.equal((await x.inspect(CAMPAIGNS, [newCampaign()])).data.effect, 'config_write');
    assert.equal((await x.inspect(GROUPS, [group()])).data.effect, 'spend_affecting');
  } finally {
    x.store.close();
  }
});

test('a campaign create that is not PAUSED is refused by the shape, with no flag to ask for and nothing sent', async () => {
  const x = googleWorld({world: withBudget('PAUSED')});
  try {
    for (const status of ['ENABLED', null])
      assertRefused(await x.prepare(CAMPAIGNS, [newCampaign(status)]), 'PAUSED_CREATION_REQUIRED', {writes: x.writes});
    assertRefused(await x.prepare(CAMPAIGNS, [newCampaign(), newCampaign('ENABLED')]), 'PAUSED_CREATION_REQUIRED', {
      writes: x.writes,
    });
  } finally {
    x.store.close();
  }
});

test('enabling an existing campaign and raising a budget still ask for the flag, and are sent only with it', async () => {
  const x = googleWorld({world: withBudget('PAUSED')});
  try {
    const enable = await x.prepare(CAMPAIGNS, [
      {update: {resource_name: campaign(9), status: 'ENABLED'}, update_mask: 'status'},
    ]);
    assert.equal(enable.success, true, JSON.stringify(enable).slice(0, 600));
    assert.equal(enable.data.execute_requirements.spend_change_confirmed, true);
    assert.equal(enable.data.effect, 'spend_affecting');
    assertRefused(await x.execute(enable, {}), 'SPEND_CONFIRMATION_REQUIRED', {writes: x.writes});
    const raise = await x.prepare(BUDGETS, [
      {update: {resource_name: budget, amount_micros: '90000000'}, update_mask: 'amount_micros'},
    ]);
    assert.equal(raise.success, true, JSON.stringify(raise).slice(0, 600));
    assert.equal(raise.data.execute_requirements.spend_change_confirmed, true);
    assertRefused(await x.execute(raise, {}), 'SPEND_CONFIRMATION_REQUIRED', {writes: x.writes});
    assert.equal((await x.execute(enable)).success, true);
    assert.equal((await x.execute(raise)).success, true);
    assert.equal(x.writes(), 2);
  } finally {
    x.store.close();
  }
});

/**
 * Item 3: the other children, each under a parent the review reads PAUSED, serving, or cannot read. An asset group and a campaign criterion
 * are read under their campaign; an ad and a keyword under their ad group and its campaign (either one PAUSED covers them).
 */
const AD_GROUP = adGroup(100);
const adBody = status => ({
  create: {
    ad_group: AD_GROUP,
    status,
    ad: {
      final_urls: ['https://example.test/'],
      responsive_search_ad: {
        headlines: [{text: 'Running shoes'}, {text: 'Free returns'}, {text: 'New season'}],
        descriptions: [{text: 'Shoes for every run.'}, {text: 'Order today.'}],
      },
    },
  },
});
const children = [
  {
    label: 'an asset group',
    action: 'asset_group_mutate_asset_groups',
    parents: 'campaign',
    refusal: 'PARENT_SERVING',
    reads: ['customer', 'campaign', 'asset_group'],
    record: () => ({create: {name: 'DNU asset group', campaign: campaign(9), status: 'ENABLED'}}),
  },
  {
    label: 'a location criterion of a campaign',
    action: 'campaign_criterion_mutate_campaign_criteria',
    parents: 'campaign',
    refusal: undefined,
    reads: ['customer', 'campaign'],
    record: () => ({create: {campaign: campaign(9), location: {geo_target_constant: 'geoTargetConstants/2840'}}}),
  },
  {
    label: 'an ad',
    action: 'ad_group_ad_mutate_ad_group_ads',
    parents: 'ad group',
    refusal: 'PARENT_SERVING',
    reads: ['customer', 'ad_group'],
    record: () => adBody('ENABLED'),
  },
  {
    label: 'a keyword',
    action: 'ad_group_criterion_mutate_ad_group_criteria',
    parents: 'ad group',
    refusal: 'TARGETING_PARENT_SERVING',
    reads: ['customer', 'ad_group'],
    record: () => ({
      create: {ad_group: AD_GROUP, keyword: {text: 'dnu shoes', match_type: 'PHRASE'}, status: 'ENABLED'},
    }),
  },
];
/** A world whose campaign 9 and ad group 100 read as given (undefined: the search does not return the status). */
const parentsOf = (groupStatus, campaignStatus) => ({
  campaigns: {[campaign(9)]: {status: campaignStatus, channel: 'SEARCH'}},
  adGroups: {[AD_GROUP]: {status: groupStatus, campaign: campaign(9)}},
  assetGroups: {},
});
/** The readings of the parents that cover a child of this kind, and the ones that do not. */
const covering = kind =>
  kind.parents === 'campaign'
    ? [['ENABLED', 'PAUSED']]
    : [
        ['PAUSED', 'ENABLED'],
        ['ENABLED', 'PAUSED'],
        ['PAUSED', 'PAUSED'],
        ['PAUSED', undefined],
      ];
const serving = kind => (kind.parents === 'campaign' ? [['ENABLED', 'ENABLED']] : [['ENABLED', 'ENABLED']]);
for (const kind of children) {
  test(
    kind.label +
      ' under a parent the review reads PAUSED asks for no flag at prepare or at execute, and is sent as reviewed',
    async () => {
      for (const [groupStatus, campaignStatus] of covering(kind)) {
        const x = googleWorld({world: parentsOf(groupStatus, campaignStatus)});
        const where = groupStatus + '/' + campaignStatus;
        try {
          const review = await x.prepare(kind.action, [kind.record()]);
          assert.equal(review.success, true, where + ' ' + JSON.stringify(review).slice(0, 600));
          assert.equal(review.data.execute_requirements.spend_change_confirmed, false, where);
          assert.deepEqual(reasons(review), [], where);
          assert.equal(review.data.effect, 'config_write', where);
          assert.equal(x.writes(), 0, 'nothing is sent while preparing');
          const done = await x.execute(review, {});
          assert.equal(done.success, true, where + ' ' + JSON.stringify(done).slice(0, 600));
          assert.equal(x.writes(), 1, where);
          assert.deepEqual(written(x)[0], kind.record(), where + ': sent exactly as reviewed');
        } finally {
          x.store.close();
        }
      }
    },
  );
  test(kind.label + ' under a serving parent still asks for the flag (Q1), and is sent only with it', async () => {
    for (const [groupStatus, campaignStatus] of serving(kind)) {
      const x = googleWorld({world: parentsOf(groupStatus, campaignStatus)});
      try {
        const review = await x.prepare(kind.action, [kind.record()]);
        assert.equal(review.success, true, JSON.stringify(review).slice(0, 600));
        assert.equal(review.data.execute_requirements.spend_change_confirmed, true);
        assert.deepEqual(reasons(review), ['spend_change_confirmed']);
        assert.equal(review.data.effect, 'spend_affecting');
        assertRefused(await x.execute(review, {}), 'SPEND_CONFIRMATION_REQUIRED', {writes: x.writes});
        assert.equal((await x.execute(review)).success, true);
        assert.equal(x.writes(), 1);
      } finally {
        x.store.close();
      }
    }
  });
  test(
    kind.label +
      ' prepared under a PAUSED parent that is enabled before execute is stopped with STATE_CHANGED, flag or none, and nothing is sent',
    async () => {
      for (const flags of [{}, {spend_change_confirmed: true}]) {
        const x = googleWorld({world: parentsOf('PAUSED', 'PAUSED')});
        try {
          const review = await x.prepare(kind.action, [kind.record()]);
          assert.equal(review.data.execute_requirements.spend_change_confirmed, false);
          x.world.campaigns[campaign(9)] = {status: 'ENABLED', channel: 'SEARCH'};
          x.world.adGroups[AD_GROUP] = {status: 'ENABLED', campaign: campaign(9)};
          assertRefused(await x.execute(review, flags), 'STATE_CHANGED', {writes: x.writes});
        } finally {
          x.store.close();
        }
      }
    },
  );
  test(
    kind.label +
      ' prepares with the reads it always made: its parents are read once, and nothing else is asked of Google',
    async () => {
      const x = googleWorld({world: parentsOf('PAUSED', 'PAUSED')});
      try {
        const review = await x.prepare(kind.action, [kind.record()]);
        assert.equal(review.success, true, JSON.stringify(review).slice(0, 600));
        // The customer, the parent (the campaign, or the ad group with its campaign's status beside it) and, for an asset group, the lookup of what
        // already carries the name of the create: the reads a prepare of this kind made before the spend rule read any state, measured on the
        // build before this package (r25-field-pausedspend). The rule reads the rows these return and asks Google for nothing more.
        assert.deepEqual(
          x.queries().map(q => /FROM ([a-z_]+)/.exec(q)?.[1]),
          kind.reads,
        );
        assert.equal(x.writes(), 0);
      } finally {
        x.store.close();
      }
    },
  );
}

/**
 * Round 2 (the lead's safety review, S3-1): the owner's rollback switch AMCP_GOOGLE_NARROWING_EXEMPT=false restores the flag on a keyword and
 * a location created under PAUSED parents, in the review's own answers: prepare names the flag and execute refuses without it. It does not
 * touch an ad group or a campaign create, which are no targeting writes. A review prepared before the switch was turned off is held to it
 * at execute too, so the rollback bites the reviews still waiting.
 */
const SWITCH = 'AMCP_GOOGLE_NARROWING_EXEMPT';
async function withSwitch(value, run) {
  const before = process.env[SWITCH];
  if (value === undefined) delete process.env[SWITCH];
  else process.env[SWITCH] = value;
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env[SWITCH];
    else process.env[SWITCH] = before;
  }
}
const kindLabelled = label => children.find(kind => kind.label === label);
const negativeKeyword = {
  label: 'a negative keyword',
  action: 'ad_group_criterion_mutate_ad_group_criteria',
  record: () => ({create: {ad_group: AD_GROUP, keyword: {text: 'dnu free', match_type: 'BROAD'}, negative: true}}),
};
const targetingKinds = [kindLabelled('a keyword'), negativeKeyword, kindLabelled('a location criterion of a campaign')];
for (const kind of targetingKinds) {
  test(
    kind.label + ' under PAUSED parents asks for the flag again with the rollback switch off, and is sent only with it',
    async () => {
      await withSwitch('false', async () => {
        const x = googleWorld({world: parentsOf('PAUSED', 'PAUSED')});
        try {
          const review = await x.prepare(kind.action, [kind.record()]);
          assert.equal(review.success, true, JSON.stringify(review).slice(0, 600));
          assert.equal(review.data.execute_requirements.spend_change_confirmed, true);
          assert.deepEqual(reasons(review), ['spend_change_confirmed']);
          assert.equal(review.data.effect, 'spend_affecting');
          assertRefused(await x.execute(review, {}), 'SPEND_CONFIRMATION_REQUIRED', {writes: x.writes});
          assert.equal((await x.execute(review)).success, true);
          assert.equal(x.writes(), 1);
        } finally {
          x.store.close();
        }
      });
    },
  );
  test(kind.label + ' under PAUSED parents asks for no flag with the rollback switch on, the default', async () => {
    for (const value of [undefined, 'true'])
      await withSwitch(value, async () => {
        const x = googleWorld({world: parentsOf('PAUSED', 'PAUSED')});
        try {
          const review = await x.prepare(kind.action, [kind.record()]);
          assert.equal(review.success, true, JSON.stringify(review).slice(0, 600));
          assert.equal(review.data.execute_requirements.spend_change_confirmed, false);
          assert.deepEqual(reasons(review), []);
          assert.equal(review.data.effect, 'config_write');
          const done = await x.execute(review, {});
          assert.equal(done.success, true, JSON.stringify(done).slice(0, 600));
          assert.equal(x.writes(), 1);
        } finally {
          x.store.close();
        }
      });
  });
}
test('a keyword prepared under PAUSED parents with the switch on is refused at execute once the switch is off', async () => {
  const kind = kindLabelled('a keyword');
  const x = googleWorld({world: parentsOf('PAUSED', 'PAUSED')});
  try {
    const review = await x.prepare(kind.action, [kind.record()]);
    assert.equal(review.data.execute_requirements.spend_change_confirmed, false);
    await withSwitch('false', async () => {
      assertRefused(await x.execute(review, {}), 'SPEND_CONFIRMATION_REQUIRED', {writes: x.writes});
      assert.equal((await x.execute(review)).success, true, 'with the flag it is sent');
    });
    assert.equal(x.writes(), 1);
  } finally {
    x.store.close();
  }
});
test('an ad group and a campaign create ask for no flag with the rollback switch off: they are no targeting writes', async () => {
  await withSwitch('false', async () => {
    const x = googleWorld({world: withBudget('PAUSED')});
    try {
      const adGroupReview = await x.prepare(GROUPS, [group()]);
      assert.equal(adGroupReview.success, true, JSON.stringify(adGroupReview).slice(0, 600));
      assert.equal(adGroupReview.data.execute_requirements.spend_change_confirmed, false);
      assert.equal(adGroupReview.data.effect, 'config_write');
      const campaignReview = await x.prepare(CAMPAIGNS, [newCampaign()]);
      assert.equal(campaignReview.success, true, JSON.stringify(campaignReview).slice(0, 600));
      assert.equal(campaignReview.data.execute_requirements.spend_change_confirmed, false);
      assert.equal((await x.execute(adGroupReview, {})).success, true);
      assert.equal((await x.execute(campaignReview, {})).success, true);
      assert.equal(x.writes(), 2);
    } finally {
      x.store.close();
    }
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {saveSpendPolicy} from '../src/spend-policy.js';
import type {JsonObject} from '../src/types.js';
import {assertRefused} from './helpers/assert-refused.js';
import {admin, adGroup, assetGroup, campaign, google, googleWorld} from './helpers/google-write-fake.js';

/**
 * R2.5 M3, G8 under Q1 (owner 2026-11-15): a child (an ad group, an asset group, an ad, an ad-group criterion) may be created
 * ENABLED under a parent the review reads as already serving. Before, `PARENT_SERVING` refused it even when the user confirmed the
 * spend, and the agent created it paused and enabled it in a second review. Now only a parent the review could not read refuses.
 * What stays: the ENABLED status asks for spend_change_confirmed at execute (the review says so), the owner's allow_activation
 * switch refuses it, a parent that changes between prepare and execute stops the write (STATE_CHANGED), and a campaign is always
 * created PAUSED. Synthetic customer 123 throughout.
 */
type Status = 'ENABLED' | 'PAUSED' | undefined;
const sold = (status: string | undefined) => ({status});
interface Kind {
  label: string;
  action: string;
  /** The code a parent the review could not read is refused with. */
  refusal: string;
  /** The parents the child's rule reads: the campaign alone, or the ad group and its campaign. */
  parents: 'campaign' | 'ad group and campaign';
  /** Whether the contract lets the child leave its status out (only an ad-group criterion does). */
  optionalStatus: boolean;
  record: (status: Status) => JsonObject;
}
const ad = {
  adGroup: adGroup(100),
  ad: {
    finalUrls: ['https://example.test/'],
    responsiveSearchAd: {
      headlines: [{text: 'Running shoes'}, {text: 'Free returns'}, {text: 'New season'}],
      descriptions: [{text: 'Shoes for every run.'}, {text: 'Order today.'}],
    },
  },
};
const kinds: Kind[] = [
  {
    label: 'ad group',
    action: 'ad_group_mutate_ad_groups',
    refusal: 'PARENT_SERVING',
    parents: 'campaign',
    optionalStatus: false,
    record: status => ({create: {name: 'DNU group', campaign: campaign(9), type: 'SEARCH_STANDARD', ...sold(status)}}),
  },
  {
    label: 'asset group',
    action: 'asset_group_mutate_asset_groups',
    refusal: 'PARENT_SERVING',
    parents: 'campaign',
    optionalStatus: false,
    record: status => ({create: {name: 'DNU asset group', campaign: campaign(9), ...sold(status)}}),
  },
  {
    label: 'ad',
    action: 'ad_group_ad_mutate_ad_group_ads',
    refusal: 'PARENT_SERVING',
    parents: 'ad group and campaign',
    optionalStatus: false,
    record: status => ({create: {...ad, ...sold(status)}}),
  },
  {
    label: 'keyword',
    action: 'ad_group_criterion_mutate_ad_group_criteria',
    refusal: 'TARGETING_PARENT_SERVING',
    parents: 'ad group and campaign',
    optionalStatus: true,
    record: status => ({
      create: {adGroup: adGroup(100), keyword: {text: 'dnu shoes', matchType: 'PHRASE'}, ...sold(status)},
    }),
  },
];
/** A world whose campaign 9 and its ad group 100 read as given ('UNREAD': the status is not returned by the search). */
const unread = 'UNREAD';
const reading = (status: string) => (status === unread ? undefined : status);
const worldOf = (campaignStatus: string, groupStatus = 'ENABLED') => ({
  campaigns: {[campaign(9)]: {status: reading(campaignStatus), channel: 'SEARCH'}},
  adGroups: {[adGroup(100)]: {status: reading(groupStatus), campaign: campaign(9)}},
  assetGroups: {[assetGroup(7)]: {status: 'ENABLED', campaign: campaign(9)}},
});
const forbidActivation = (x: ReturnType<typeof googleWorld>) =>
  saveSpendPolicy(x.store, admin, {
    confirmed: true,
    gateway: google,
    account_id: '123',
    policy: {enforcement: 'block', allow_activation: false, allow_deletion: false},
  });

const article = (label: string) => (/^[aeiou]/i.test(label) ? 'an ' : 'a ');
for (const kind of kinds) {
  test(
    article(kind.label) +
      kind.label +
      ' may be created ENABLED under a serving parent: the spend flag asks for it and executes it (Q1)',
    async () => {
      const x = googleWorld({world: worldOf('ENABLED')});
      try {
        const review = await x.prepare(kind.action, [kind.record('ENABLED')]);
        assert.equal(review.success, true, JSON.stringify(review).slice(0, 700));
        // Disclosure: the review lists the spend flag with its reason before anything is approved.
        const required = review.data.execute_requirements;
        assert.equal(required.spend_change_confirmed, true);
        assert.ok(
          required.reasons.some((r: JsonObject) => r.flag === 'spend_change_confirmed' && String(r.reason).length > 20),
          JSON.stringify(required.reasons),
        );
        assertRefused(await x.execute(review, {}), 'SPEND_CONFIRMATION_REQUIRED', {writes: x.writes});
        const done = await x.execute(review);
        assert.equal(done.success, true, JSON.stringify(done).slice(0, 700));
        assert.equal(x.writes(), 1);
        assert.equal(x.log.find(r => r.kind === 'write')!.body.operations[0].create.status, 'ENABLED');
      } finally {
        x.store.close();
      }
    },
  );
  test(
    article(kind.label) +
      kind.label +
      ' created ENABLED under a serving parent is refused by the owner’s allow_activation switch',
    async () => {
      const x = googleWorld({world: worldOf('ENABLED')});
      try {
        forbidActivation(x);
        assertRefused(await x.prepare(kind.action, [kind.record('ENABLED')]), 'POLICY_ACTIVATION_FORBIDDEN', {
          writes: x.writes,
        });
        // PAUSED is no activation, whatever the parents are.
        assert.equal((await x.prepare(kind.action, [kind.record('PAUSED')])).success, true);
      } finally {
        x.store.close();
      }
    },
  );
  test(
    article(kind.label) +
      kind.label +
      ' under a parent the review could not read is still refused, naming the unread parent',
    async () => {
      const x = googleWorld({world: kind.parents === 'campaign' ? worldOf(unread) : worldOf('ENABLED', unread)});
      try {
        const refused = await x.prepare(kind.action, [kind.record('ENABLED')]);
        assertRefused(refused, kind.refusal, {writes: x.writes});
        assert.equal(refused.error.details.parent_unread, true);
        assert.match(refused.error.message, /could not be read|cannot be read/);
        // PAUSED is allowed as before: nothing starts serving.
        assert.equal((await x.prepare(kind.action, [kind.record('PAUSED')])).success, true);
      } finally {
        x.store.close();
      }
    },
  );
  test(
    article(kind.label) +
      kind.label +
      ' prepared ENABLED under a paused parent that is enabled before execute is stopped with STATE_CHANGED',
    async () => {
      const x = googleWorld({world: worldOf('PAUSED', 'PAUSED')});
      try {
        const review = await x.prepare(kind.action, [kind.record('ENABLED')]);
        assert.equal(review.success, true, JSON.stringify(review).slice(0, 700));
        x.world.campaigns[campaign(9)] = {status: 'ENABLED', channel: 'SEARCH'};
        x.world.adGroups[adGroup(100)] = {status: 'ENABLED', campaign: campaign(9)};
        assertRefused(await x.execute(review), 'STATE_CHANGED', {writes: x.writes});
      } finally {
        x.store.close();
      }
    },
  );
}

test('a keyword with no status under a serving parent asks for the spend flag, and the owner’s switch refuses it (Q1: the omitted status counts as ENABLED)', async () => {
  const keyword = kinds.find(k => k.optionalStatus)!;
  const x = googleWorld({world: worldOf('ENABLED')});
  try {
    const review = await x.prepare(keyword.action, [keyword.record(undefined)]);
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 700));
    assert.equal(review.data.execute_requirements.spend_change_confirmed, true);
    assertRefused(await x.execute(review, {}), 'SPEND_CONFIRMATION_REQUIRED', {writes: x.writes});
    assert.equal((await x.execute(review)).success, true);
    // Google's default for a status left out at create is ENABLED, so the switch reads it as the activation it is.
    forbidActivation(x);
    assertRefused(await x.prepare(keyword.action, [keyword.record(undefined)]), 'POLICY_ACTIVATION_FORBIDDEN');
    // Under a paused parent, or created PAUSED, nothing newly counts.
    x.world.campaigns[campaign(9)] = {status: 'PAUSED', channel: 'SEARCH'};
    assert.equal((await x.prepare(keyword.action, [keyword.record(undefined)])).success, true);
    x.world.campaigns[campaign(9)] = {status: 'ENABLED', channel: 'SEARCH'};
    assert.equal((await x.prepare(keyword.action, [keyword.record('PAUSED')])).success, true);
  } finally {
    x.store.close();
  }
});

test('an ad group, an asset group and an ad with no status are refused by the contract, so Q1 opens no gap for them', async () => {
  // The lead’s review of 2026-11-17 asked that the omitted-status gap be closed for these three too. It does not exist: the Google
  // write shape pins an explicit PAUSED or ENABLED on each create (googleWriteShape), before any state is read. This pins that: the
  // refusal holds under a serving parent, a paused one and an unread one, with and without the owner’s switch, at prepare and inspect.
  const x = googleWorld({world: worldOf('ENABLED')});
  try {
    for (const kind of kinds.filter(k => !k.optionalStatus)) {
      for (const [campaignStatus, groupStatus] of [
        ['ENABLED', 'ENABLED'],
        ['PAUSED', 'PAUSED'],
        [undefined, undefined],
      ] as const) {
        x.world.campaigns[campaign(9)] = {status: campaignStatus, channel: 'SEARCH'};
        x.world.adGroups[adGroup(100)] = {status: groupStatus, campaign: campaign(9)};
        const refused = await x.prepare(kind.action, [kind.record(undefined)]);
        assertRefused(refused, 'PAUSED_CREATION_REQUIRED', {writes: x.writes});
        const inspected = (await x.inspect(kind.action, [kind.record(undefined)])).data;
        assert.equal(inspected.error.code, 'PAUSED_CREATION_REQUIRED', kind.label);
      }
    }
    forbidActivation(x);
    for (const kind of kinds.filter(k => !k.optionalStatus))
      assertRefused(await x.prepare(kind.action, [kind.record(undefined)]), 'PAUSED_CREATION_REQUIRED');
  } finally {
    x.store.close();
  }
});

/**
 * A Performance Max build whose asset group names no status and meets the build-level minimums (the headlines, descriptions, business name
 * and images it must link), which a build checks before the per-operation contract: only then is the omitted status what refuses it. The
 * existing images are named, never read: the build is refused before any read.
 */
function pmaxBuild(): JsonObject[] {
  const texts: [string, string][] = [
    ...['Acme', 'Acme widgets', 'Buy Acme'].map(t => ['HEADLINE', t] as [string, string]),
    ['LONG_HEADLINE', 'Widgets for every workshop'],
    ['DESCRIPTION', 'Widgets for all.'],
    ['DESCRIPTION', 'Fast delivery.'],
    ['BUSINESS_NAME', 'Acme'],
  ];
  const group = 'customers/123/assetGroups/-20',
    link = (asset: string, field_type: string) => ({
      asset_group_asset_operation: {create: {asset_group: group, asset, field_type}},
    });
  return [
    {
      campaign_budget_operation: {
        create: {
          resource_name: 'customers/123/campaignBudgets/-1',
          name: 'DNU budget',
          amount_micros: '50000000',
          delivery_method: 'STANDARD',
          explicitly_shared: false,
        },
      },
    },
    {
      campaign_operation: {
        create: {
          resource_name: 'customers/123/campaigns/-2',
          name: 'DNU PMax',
          status: 'PAUSED',
          advertising_channel_type: 'PERFORMANCE_MAX',
          campaign_budget: 'customers/123/campaignBudgets/-1',
          maximize_conversions: {},
          brand_guidelines_enabled: false,
          contains_eu_political_advertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
        },
      },
    },
    ...texts.map(([, value], i) => ({
      asset_operation: {create: {resource_name: 'customers/123/assets/-' + (100 + i), text_asset: {text: value}}},
    })),
    // The asset group of this build: no status.
    {
      asset_group_operation: {
        create: {
          resource_name: group,
          name: 'DNU asset group',
          campaign: 'customers/123/campaigns/-2',
          final_urls: ['https://example.test/'],
        },
      },
    },
    ...texts.map(([type], i) => link('customers/123/assets/-' + (100 + i), type)),
    link('customers/123/assets/501', 'MARKETING_IMAGE'),
    link('customers/123/assets/502', 'SQUARE_MARKETING_IMAGE'),
    link('customers/123/assets/503', 'LOGO'),
  ];
}

test('in a build, an ad group, an asset group and an ad operation with no status are refused too, naming the operation (round 2, S4-8)', async () => {
  // The same contract, reached through `shape(single(plan, op))` for each operation of a build: nothing is read, validated or sent.
  const x = googleWorld({world: worldOf('PAUSED')});
  try {
    const head = (): JsonObject[] => [
      {
        campaign_budget_operation: {
          create: {
            resource_name: 'customers/123/campaignBudgets/-1',
            name: 'DNU budget',
            amount_micros: '40000000',
            delivery_method: 'STANDARD',
            explicitly_shared: false,
          },
        },
      },
      {
        campaign_operation: {
          create: {
            resource_name: 'customers/123/campaigns/-2',
            name: 'DNU campaign',
            status: 'PAUSED',
            advertising_channel_type: 'SEARCH',
            campaign_budget: 'customers/123/campaignBudgets/-1',
            manual_cpc: {},
            contains_eu_political_advertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
          },
        },
      },
    ];
    const group = (status?: string) => ({
      ad_group_operation: {
        create: {
          resource_name: 'customers/123/adGroups/-3',
          name: 'DNU group',
          campaign: 'customers/123/campaigns/-2',
          ...(status ? {status} : {}),
        },
      },
    });
    const builds: [string, JsonObject[], number][] = [
      ['an ad group', [...head(), group()], 2],
      [
        'an ad',
        [
          ...head(),
          group('PAUSED'),
          {
            ad_group_ad_operation: {
              create: {
                ad_group: 'customers/123/adGroups/-3',
                ad: {name: 'DNU ad', final_urls: ['https://example.test/']},
              },
            },
          },
        ],
        3,
      ],
      ['an asset group', pmaxBuild(), 9],
    ];
    for (const [label, build, index] of builds) {
      const refused = await x.prepareBuild(build);
      assertRefused(refused, 'PAUSED_CREATION_REQUIRED', {writes: x.writes});
      assert.match(refused.error.message, new RegExp('^mutate_operations\\[' + index + '\\]: '), label);
      assert.equal(refused.error.details.operation, index, label);
      assert.equal(x.reads(), 0, label + ': refused before anything was read');
      assert.equal(x.validations(), 0, label);
    }
    // With an explicit status the same builds are accepted: it is the omitted status that is refused, nothing else of them.
    const withStatus = await x.prepareBuild([...head(), group('PAUSED')]);
    assert.equal(withStatus.success, true, JSON.stringify(withStatus).slice(0, 600));
  } finally {
    x.store.close();
  }
});

test('a campaign is still created PAUSED only: ENABLED is refused with PAUSED_CREATION_REQUIRED, alone or in a build', async () => {
  const x = googleWorld({world: worldOf('ENABLED')});
  try {
    const record = {create: {name: 'DNU campaign', status: 'ENABLED', advertisingChannelType: 'SEARCH'}};
    assertRefused(await x.prepare('campaign_mutate_campaigns', [record]), 'PAUSED_CREATION_REQUIRED', {
      writes: x.writes,
    });
    assertRefused(
      await x.prepareBuild([
        {
          campaign_budget_operation: {
            create: {
              resource_name: 'customers/123/campaignBudgets/-1',
              name: 'DNU budget',
              amount_micros: '40000000',
              delivery_method: 'STANDARD',
              explicitly_shared: false,
            },
          },
        },
        {
          campaign_operation: {
            create: {
              resource_name: 'customers/123/campaigns/-2',
              name: 'DNU campaign',
              status: 'ENABLED',
              advertising_channel_type: 'SEARCH',
              campaign_budget: 'customers/123/campaignBudgets/-1',
              manual_cpc: {},
              contains_eu_political_advertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
            },
          },
        },
      ]),
      'PAUSED_CREATION_REQUIRED',
      {writes: x.writes},
    );
  } finally {
    x.store.close();
  }
});

/**
 * The rule as a whole, over every status of the child and every reading of its parents (the plan's property test d): the
 * state space is small enough to walk instead of sample. For each child and parents:
 * - a refusal happens iff the child is not PAUSED, no parent reads PAUSED and some parent is unread;
 * - otherwise it prepares, and execute needs the spend flag iff the child is ENABLED (a criterion: always, it widens), unless a parent reads
 *   PAUSED (r25-field-pausedspend, the owner's decision of 2026-11-19: then nothing it creates can serve);
 * - and the owner's allow_activation switch refuses iff the child names ENABLED, or is a criterion with no status under a parent
 *   that does not read PAUSED, and no refusal of the parent comes first.
 */
test('across every status and every reading of the parents, a refusal is for an unread parent only and the flag and the switch follow what serves', async () => {
  const readings: (string | undefined)[] = ['ENABLED', 'PAUSED', undefined];
  for (const policy of [false, true]) {
    const x = googleWorld();
    try {
      if (policy) forbidActivation(x);
      for (const kind of kinds)
        for (const campaignStatus of readings)
          for (const groupStatus of kind.parents === 'campaign' ? ['ENABLED'] : readings)
            for (const status of ['ENABLED', 'PAUSED', ...(kind.optionalStatus ? [undefined] : [])] as Status[]) {
              x.world.campaigns[campaign(9)] = {status: campaignStatus, channel: 'SEARCH'};
              x.world.adGroups[adGroup(100)] = {status: groupStatus, campaign: campaign(9)};
              const parents = kind.parents === 'campaign' ? [campaignStatus] : [groupStatus, campaignStatus],
                paused = parents.includes('PAUSED'),
                unread = parents.some(p => p === undefined),
                label = [kind.label, 'status ' + status, 'parents ' + parents.join('/'), 'policy ' + policy].join(', ');
              const review = await x.prepare(kind.action, [kind.record(status)]);
              if (status !== 'PAUSED' && !paused && unread) {
                assertRefused(review, kind.refusal);
                assert.equal(review.error.details.parent_unread, true, label);
                continue;
              }
              const switchRefuses = status === 'ENABLED' || (kind.optionalStatus && status === undefined && !paused);
              if (policy && switchRefuses) {
                assertRefused(review, 'POLICY_ACTIVATION_FORBIDDEN');
                continue;
              }
              assert.equal(review.success, true, label + ' ' + JSON.stringify(review).slice(0, 400));
              // Package r25-field-pausedspend (the owner's decision of 2026-11-19) changed this oracle, which was `status === 'ENABLED' ||
              // kind.optionalStatus`: a create under a parent that reads PAUSED can serve nothing, so it asks for no flag, whatever its status.
              // Under a parent that does not read PAUSED the oracle is what it was.
              assert.equal(
                review.data.execute_requirements.spend_change_confirmed,
                (status === 'ENABLED' || kind.optionalStatus) && !paused,
                label,
              );
            }
      assert.equal(x.writes(), 0, 'nothing was sent while preparing');
    } finally {
      x.store.close();
    }
  }
});

/** Builds: a criterion with no status in a build counts as an activation only under an existing parent that does not read PAUSED. */
const criterionOf = (group: string) => ({
  ad_group_criterion_operation: {create: {ad_group: group, keyword: {text: 'dnu shoes', match_type: 'EXACT'}}},
});
test('a build’s criterion with no status counts as an activation under an existing serving or unread ad group, not under a paused one', async () => {
  const x = googleWorld({world: worldOf('ENABLED')});
  try {
    forbidActivation(x);
    // A serving ad group of a serving campaign: Q1 lets the criterion in, with the spend flag every build asks for; the switch refuses it.
    assertRefused(await x.prepareBuild([criterionOf(adGroup(100))]), 'POLICY_ACTIVATION_FORBIDDEN', {writes: x.writes});
    // A paused campaign covers it, as it covers a paused ad group: nothing newly counts.
    x.world.campaigns[campaign(9)] = {status: 'PAUSED', channel: 'SEARCH'};
    const paused = await x.prepareBuild([criterionOf(adGroup(100))]);
    assert.equal(paused.success, true, JSON.stringify(paused).slice(0, 700));
    x.world.campaigns[campaign(9)] = {status: 'ENABLED', channel: 'SEARCH'};
    x.world.adGroups[adGroup(100)] = {status: 'PAUSED', campaign: campaign(9)};
    assert.equal((await x.prepareBuild([criterionOf(adGroup(100))])).success, true);
    // A parent the build could not read still refuses, as the one-service form does.
    x.world.adGroups[adGroup(100)] = {status: undefined, campaign: campaign(9)};
    assertRefused(await x.prepareBuild([criterionOf(adGroup(100))]), 'TARGETING_PARENT_SERVING', {writes: x.writes});
  } finally {
    x.store.close();
  }
});

test('a build whose own campaign is PAUSED adds children and criteria with no status without the switch refusing it', async () => {
  const x = googleWorld({world: worldOf('ENABLED')});
  try {
    forbidActivation(x);
    const operations = [
      {
        campaign_budget_operation: {
          create: {
            resource_name: 'customers/123/campaignBudgets/-1',
            name: 'DNU budget',
            amount_micros: '40000000',
            delivery_method: 'STANDARD',
            explicitly_shared: false,
          },
        },
      },
      {
        campaign_operation: {
          create: {
            resource_name: 'customers/123/campaigns/-2',
            name: 'DNU campaign',
            status: 'PAUSED',
            advertising_channel_type: 'SEARCH',
            campaign_budget: 'customers/123/campaignBudgets/-1',
            manual_cpc: {},
            contains_eu_political_advertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
          },
        },
      },
      {
        ad_group_operation: {
          create: {
            resource_name: 'customers/123/adGroups/-3',
            name: 'DNU group',
            campaign: 'customers/123/campaigns/-2',
            status: 'PAUSED',
            type: 'SEARCH_STANDARD',
          },
        },
      },
      criterionOf('customers/123/adGroups/-3'),
    ];
    const review = await x.prepareBuild(operations);
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 900));
    // The same build with the ad group ENABLED under its own paused campaign is the activation it always was.
    const enabled = structuredClone(operations) as any[];
    enabled[2].ad_group_operation.create.status = 'ENABLED';
    assertRefused(await x.prepareBuild(enabled), 'POLICY_ACTIVATION_FORBIDDEN');
  } finally {
    x.store.close();
  }
});

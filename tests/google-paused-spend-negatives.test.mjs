import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../dist/src/catalog.js';
import {Compiler} from '../dist/src/compiler.js';
import {applyExecutionRisk} from '../dist/src/execution-risk.js';
import {spendConfirmationError} from '../dist/src/preflight.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {admin, adGroup, assetGroup, campaign, google, googleWorld} from '../dist/tests/helpers/google-write-fake.js';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * R2.5 field fix r25-field-pausedspend (the owner's "yes", 2026-11-19): what the exemption must not reach. Each gate below still asks, or
 * still refuses, exactly as it did before the package: a create under a serving or an unread parent, every ENABLE and every budget, bid,
 * schedule or targeting widening of an existing object, every atomic build, the owner's caps and allow_activation, a parent enabled between
 * prepare and execute, and every caller that has no state. Every parent reads PAUSED unless a test says otherwise, so that each refusal
 * is the rule's and not the state's. The exemption itself is proven in the other files of the package.
 */
const budget = 'customers/123/campaignBudgets/1';
const AD_GROUP = adGroup(100);
const ASSET_GROUP = assetGroup(7);
const AD = 'customers/123/adGroupAds/100~7';
const KEYWORD = 'customers/123/adGroupCriteria/100~200';
const CAMPAIGN_CRITERION = 'customers/123/campaignCriteria/9~300';
const pausedWorld = (extra = {}) => ({
  campaigns: {[campaign(9)]: {status: 'PAUSED', channel: 'SEARCH'}},
  adGroups: {[AD_GROUP]: {status: 'PAUSED', campaign: campaign(9)}},
  assetGroups: {[ASSET_GROUP]: {status: 'PAUSED', campaign: campaign(9)}},
  adGroupAds: {[AD]: {status: 'PAUSED', adGroup: AD_GROUP}},
  campaignBudgets: {[budget]: {}},
  ...extra,
});
const policyOf = (x, policy) =>
  saveSpendPolicy(x.store, admin, {confirmed: true, gateway: google, account_id: '123', policy});

// ---- Every ENABLE and every delivery edit of an existing object asks, under a PAUSED parent too.
const updates = [
  ['enabling a campaign', 'campaign_mutate_campaigns', campaign(9), {status: 'ENABLED'}, 'status'],
  ['enabling an ad group', 'ad_group_mutate_ad_groups', AD_GROUP, {status: 'ENABLED'}, 'status'],
  ['enabling an asset group', 'asset_group_mutate_asset_groups', ASSET_GROUP, {status: 'ENABLED'}, 'status'],
  ['enabling an ad', 'ad_group_ad_mutate_ad_group_ads', AD, {status: 'ENABLED'}, 'status'],
  ['enabling a keyword', 'ad_group_criterion_mutate_ad_group_criteria', KEYWORD, {status: 'ENABLED'}, 'status'],
  [
    'enabling a campaign criterion',
    'campaign_criterion_mutate_campaign_criteria',
    CAMPAIGN_CRITERION,
    {status: 'ENABLED'},
    'status',
  ],
  [
    'raising a campaign budget',
    'campaign_budget_mutate_campaign_budgets',
    budget,
    {amount_micros: '90000000'},
    'amount_micros',
  ],
  ['raising an ad group bid', 'ad_group_mutate_ad_groups', AD_GROUP, {cpc_bid_micros: '9000000'}, 'cpc_bid_micros'],
  [
    'changing a campaign target CPA',
    'campaign_mutate_campaigns',
    campaign(9),
    {maximize_conversions: {target_cpa_micros: '90000000'}},
    'maximize_conversions.target_cpa_micros',
  ],
  [
    'moving a campaign end date',
    'campaign_mutate_campaigns',
    campaign(9),
    {end_date_time: '2027-12-31 23:59:59'},
    'end_date_time',
  ],
  [
    'raising a keyword bid',
    'ad_group_criterion_mutate_ad_group_criteria',
    KEYWORD,
    {cpc_bid_micros: '9000000'},
    'cpc_bid_micros',
  ],
];
for (const [what, action, target, fields, mask] of updates)
  test(what + ' under PAUSED parents still asks for the flag, and is sent only with it', async () => {
    const x = googleWorld({world: pausedWorld()});
    try {
      const review = await x.prepare(action, [{update: {resource_name: target, ...fields}, update_mask: mask}]);
      assert.equal(review.success, true, JSON.stringify(review).slice(0, 700));
      assert.equal(review.data.execute_requirements.spend_change_confirmed, true);
      assert.equal(review.data.effect, 'spend_affecting');
      assertRefused(await x.execute(review, {}), 'SPEND_CONFIRMATION_REQUIRED', {writes: x.writes});
      assert.equal((await x.execute(review)).success, true);
      assert.equal(x.writes(), 1);
    } finally {
      x.store.close();
    }
  });
for (const [what, action, target] of [
  [
    'removing a negative keyword of a campaign (it widens delivery)',
    'campaign_criterion_mutate_campaign_criteria',
    CAMPAIGN_CRITERION,
  ],
  ['removing a keyword', 'ad_group_criterion_mutate_ad_group_criteria', KEYWORD],
])
  test(what + ' under PAUSED parents still asks for the flag', async () => {
    const x = googleWorld({world: pausedWorld()});
    try {
      const review = await x.prepare(action, [{remove: target}]);
      assert.equal(review.success, true, JSON.stringify(review).slice(0, 700));
      assert.equal(review.data.execute_requirements.spend_change_confirmed, true);
      assertRefused(await x.execute(review, {}), 'SPEND_CONFIRMATION_REQUIRED', {writes: x.writes});
    } finally {
      x.store.close();
    }
  });
test('a request that creates a child and also enables an existing one asks for the flag, as one request', async () => {
  const x = googleWorld({world: pausedWorld()});
  try {
    const review = await x.prepare('ad_group_mutate_ad_groups', [
      {create: {name: 'DNU group', campaign: campaign(9), status: 'ENABLED', type: 'SEARCH_STANDARD'}},
      {update: {resource_name: AD_GROUP, status: 'ENABLED'}, update_mask: 'status'},
    ]);
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 700));
    assert.equal(review.data.execute_requirements.spend_change_confirmed, true);
    assertRefused(await x.execute(review, {}), 'SPEND_CONFIRMATION_REQUIRED', {writes: x.writes});
  } finally {
    x.store.close();
  }
});

// ---- A parent the review could not read is refused before any flag is asked, and a child under one that serves asks (Q1).
const children = [
  {
    label: 'an ad group',
    action: 'ad_group_mutate_ad_groups',
    refusal: 'PARENT_SERVING',
    parents: 'campaign',
    record: status => ({create: {name: 'DNU group', campaign: campaign(9), type: 'SEARCH_STANDARD', status}}),
  },
  {
    label: 'an asset group',
    action: 'asset_group_mutate_asset_groups',
    refusal: 'PARENT_SERVING',
    parents: 'campaign',
    record: status => ({create: {name: 'DNU asset group', campaign: campaign(9), status}}),
  },
  {
    label: 'an ad',
    action: 'ad_group_ad_mutate_ad_group_ads',
    refusal: 'PARENT_SERVING',
    parents: 'ad group',
    record: status => ({
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
    }),
  },
  {
    label: 'a keyword',
    action: 'ad_group_criterion_mutate_ad_group_criteria',
    refusal: 'TARGETING_PARENT_SERVING',
    parents: 'ad group',
    record: status => ({create: {ad_group: AD_GROUP, keyword: {text: 'dnu shoes', match_type: 'PHRASE'}, status}}),
  },
];
const worldOf = (groupStatus, campaignStatus) => ({
  campaigns: {[campaign(9)]: {status: campaignStatus, channel: 'SEARCH'}},
  adGroups: {[AD_GROUP]: {status: groupStatus, campaign: campaign(9)}},
  assetGroups: {},
});
for (const kind of children) {
  const unreadWorlds =
    kind.parents === 'campaign'
      ? [[undefined, undefined]]
      : [
          [undefined, 'ENABLED'],
          ['ENABLED', undefined],
          [undefined, undefined],
        ];
  test(
    kind.label + ' under a parent the review could not read is still refused, ENABLED, naming the unread parent',
    async () => {
      for (const [groupStatus, campaignStatus] of unreadWorlds) {
        const x = googleWorld({world: worldOf(groupStatus, campaignStatus)});
        try {
          const refused = await x.prepare(kind.action, [kind.record('ENABLED')]);
          assertRefused(refused, kind.refusal, {writes: x.writes});
          assert.equal(refused.error.details.parent_unread, true);
          // Created PAUSED, nothing starts serving: allowed, as before, and it asks for no flag.
          const paused = await x.prepare(kind.action, [kind.record('PAUSED')]);
          assert.equal(paused.success, true, JSON.stringify(paused).slice(0, 600));
          assert.equal(x.writes(), 0);
        } finally {
          x.store.close();
        }
      }
    },
  );
  test(kind.label + ' under serving parents asks for the flag (Q1), in every spelling of the request', async () => {
    const x = googleWorld({world: worldOf('ENABLED', 'ENABLED')});
    try {
      const review = await x.prepare(kind.action, [kind.record('ENABLED')]);
      assert.equal(review.success, true, JSON.stringify(review).slice(0, 600));
      assert.equal(review.data.execute_requirements.spend_change_confirmed, true);
      assertRefused(await x.execute(review, {}), 'SPEND_CONFIRMATION_REQUIRED', {writes: x.writes});
    } finally {
      x.store.close();
    }
  });
}
test('a campaign criterion under a campaign the review could not read prepares and asks for the flag: nothing covers it', async () => {
  const x = googleWorld({world: worldOf('ENABLED', undefined)});
  try {
    const review = await x.prepare('campaign_criterion_mutate_campaign_criteria', [
      {create: {campaign: campaign(9), location: {geo_target_constant: 'geoTargetConstants/2840'}}},
    ]);
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 600));
    assert.equal(review.data.execute_requirements.spend_change_confirmed, true);
    assertRefused(await x.execute(review, {}), 'SPEND_CONFIRMATION_REQUIRED', {writes: x.writes});
  } finally {
    x.store.close();
  }
});

// ---- The owner's allow_activation switch still refuses an ENABLED child, whatever the parent reads.
for (const kind of children)
  test(
    kind.label +
      ' created ENABLED under PAUSED parents is still refused by allow_activation: false; a PAUSED one is not',
    async () => {
      const x = googleWorld({world: worldOf('PAUSED', 'PAUSED')});
      try {
        policyOf(x, {enforcement: 'block', allow_activation: false, allow_deletion: false});
        assertRefused(await x.prepare(kind.action, [kind.record('ENABLED')]), 'POLICY_ACTIVATION_FORBIDDEN', {
          writes: x.writes,
        });
        const paused = await x.prepare(kind.action, [kind.record('PAUSED')]);
        assert.equal(paused.success, true, JSON.stringify(paused).slice(0, 600));
        assert.equal(paused.data.execute_requirements.spend_change_confirmed, false);
      } finally {
        x.store.close();
      }
    },
  );

// ---- The owner's caps are not touched: a bid above the cap is still a cap, whether or not the flag is asked.
test('the owner’s bid cap still refuses an ad group under a PAUSED campaign, and under confirm still asks to override it', async () => {
  for (const enforcement of ['block', 'confirm']) {
    const x = googleWorld({world: worldOf('PAUSED', 'PAUSED')});
    try {
      policyOf(x, {enforcement, max_bid_native: 1000000});
      const over = {
        create: {
          name: 'DNU group',
          campaign: campaign(9),
          status: 'ENABLED',
          type: 'SEARCH_STANDARD',
          cpc_bid_micros: '1500000',
        },
      };
      const within = {
        create: {
          name: 'DNU group',
          campaign: campaign(9),
          status: 'ENABLED',
          type: 'SEARCH_STANDARD',
          cpc_bid_micros: '900000',
        },
      };
      const ok = await x.prepare('ad_group_mutate_ad_groups', [within]);
      assert.equal(ok.success, true, JSON.stringify(ok).slice(0, 600));
      assert.equal(
        ok.data.execute_requirements.spend_change_confirmed,
        false,
        'within the cap, under a paused campaign: no flag',
      );
      assert.equal(ok.data.execute_requirements.cap_override_confirmed, false);
      const refused = await x.prepare('ad_group_mutate_ad_groups', [over]);
      if (enforcement === 'block') assertRefused(refused, 'POLICY_BID_LIMIT', {writes: x.writes});
      else {
        assert.equal(refused.success, true, JSON.stringify(refused).slice(0, 600));
        assert.equal(refused.data.execute_requirements.cap_override_confirmed, true);
        assert.equal(refused.data.execute_requirements.spend_change_confirmed, false);
        assertRefused(await x.execute(refused, {}), 'CAP_CONFIRMATION_REQUIRED', {writes: x.writes});
      }
    } finally {
      x.store.close();
    }
  }
});

// ---- Every atomic build asks once for the flag, though everything it creates is PAUSED or under a PAUSED parent.
const budgetOp = {
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
const campaignOp = {
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
};
const groupOp = parent => ({
  ad_group_operation: {
    create: {
      resource_name: 'customers/123/adGroups/-3',
      name: 'DNU group',
      campaign: parent,
      status: 'PAUSED',
      type: 'SEARCH_STANDARD',
    },
  },
});
const keywordOp = parent => ({
  ad_group_criterion_operation: {
    create: {ad_group: parent, status: 'PAUSED', keyword: {text: 'dnu shoes', match_type: 'EXACT'}},
  },
});
test('a build of a PAUSED campaign, its ad group and keyword asks for the flag, once, as it always did', async () => {
  const x = googleWorld({world: pausedWorld()});
  try {
    const review = await x.prepareBuild([
      budgetOp,
      campaignOp,
      groupOp('customers/123/campaigns/-2'),
      keywordOp('customers/123/adGroups/-3'),
    ]);
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 700));
    assert.equal(review.data.execute_requirements.spend_change_confirmed, true);
    assertRefused(await x.execute(review, {}), 'SPEND_CONFIRMATION_REQUIRED', {writes: x.writes});
    assert.equal((await x.execute(review)).success, true);
    assert.equal(x.writes(), 1);
  } finally {
    x.store.close();
  }
});
test('a build of children under an existing PAUSED campaign asks for the flag too: the exemption is for the one-service creates', async () => {
  const x = googleWorld({world: pausedWorld()});
  try {
    const review = await x.prepareBuild([groupOp(campaign(9)), keywordOp('customers/123/adGroups/-3')]);
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 700));
    assert.equal(review.data.execute_requirements.spend_change_confirmed, true);
    assertRefused(await x.execute(review, {}), 'SPEND_CONFIRMATION_REQUIRED', {writes: x.writes});
  } finally {
    x.store.close();
  }
});

// ---- A group is read part by part: one part whose parent serves makes the group ask, and nothing of it is sent without the flag.
test('a group of 30 ad groups whose last five serve asks for the flag, and is refused whole, before its first part is sent, without it', async () => {
  const x = googleWorld({
    world: {
      campaigns: {
        [campaign(9)]: {status: 'PAUSED', channel: 'SEARCH'},
        [campaign(10)]: {status: 'ENABLED', channel: 'SEARCH'},
      },
      adGroups: {},
      assetGroups: {},
    },
  });
  try {
    const group = (i, parent) => ({
      create: {name: 'DNU group ' + i, campaign: parent, status: 'ENABLED', type: 'SEARCH_STANDARD'},
    });
    const review = await x.prepare('ad_group_mutate_ad_groups', [
      ...Array.from({length: 25}, (_, i) => group(i, campaign(9))),
      ...Array.from({length: 5}, (_, i) => group(25 + i, campaign(10))),
    ]);
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 700));
    assert.equal(review.data.group, true);
    assert.equal(review.data.parts.length, 2);
    assert.equal(review.data.execute_requirements.spend_change_confirmed, true);
    assertRefused(await x.execute(review, {}), 'SPEND_CONFIRMATION_REQUIRED', {writes: x.writes});
    assert.equal((await x.execute(review)).success, true);
    assert.equal(x.writes(), 2);
  } finally {
    x.store.close();
  }
});
// ---- A review is stopped when the parent it read PAUSED serves by the time it is executed, flag or none.
for (const kind of children)
  test(
    kind.label + ': the parent enabled after prepare stops the ENABLED child with STATE_CHANGED, and nothing is sent',
    async () => {
      for (const flags of [{}, {spend_change_confirmed: true}]) {
        const x = googleWorld({world: worldOf('PAUSED', 'PAUSED')});
        try {
          const review = await x.prepare(kind.action, [kind.record('ENABLED')]);
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

// ---- The owner's approval mode follows the flag: a review that asks for none is no spend-affecting write to approve (as TikTok's, Q14).
test('under website approval, a child under a PAUSED parent needs no approval for spend, and one under a serving parent still does', async () => {
  for (const [parents, approval] of [
    ['PAUSED', false],
    ['ENABLED', true],
  ]) {
    const x = googleWorld({world: worldOf(parents, parents)});
    try {
      policyOf(x, {approval_mode: 'website_approval'});
      const review = await x.prepare('ad_group_mutate_ad_groups', [children[0].record('ENABLED')]);
      assert.equal(review.success, true, JSON.stringify(review).slice(0, 600));
      assert.equal(review.data.approval?.required ?? false, approval, parents);
      if (approval) assert.deepEqual(review.data.approval.classes, ['spend_affecting']);
    } finally {
      x.store.close();
    }
  }
});

// ---- The state-aware rule is the state-free rule less the creates under a PAUSED parent, and nothing else: walked over every kind,
// every status of the child, every reading of the parents. It never adds a flag; it removes one only for a covered create under a parent
// that reads PAUSED.
const compiler = new Compiler(new Registry()),
  options = {mode: 'strict', flags: {}};
const compile = (action, operations) =>
  applyExecutionRisk(
    compiler.compile(
      google,
      {action: 'google_ads_v23_' + action, account_id: '123', payload: {operations}, dry_run: true},
      options,
    ),
  );
const readings = ['ENABLED', 'PAUSED', 'REMOVED', 'UNSPECIFIED', 'UNKNOWN', undefined];
const stateOfCampaign = status => [{results: [{campaign: {resourceName: campaign(9), ...(status ? {status} : {})}}]}];
const stateOfGroup = (groupStatus, campaignStatus) => [
  {
    results: [
      {
        adGroup: {resourceName: AD_GROUP, ...(groupStatus ? {status: groupStatus} : {})},
        campaign: {...(campaignStatus ? {status: campaignStatus} : {})},
      },
    ],
  },
];
const walked = [
  ...['ENABLED', 'PAUSED'].flatMap(status =>
    [{}, {cpc_bid_micros: '1000000'}].map(extra => ({
      kind: 'ad group',
      parents: 'campaign',
      plan: compile('ad_group_mutate_ad_groups', [
        {create: {name: 'DNU group', campaign: campaign(9), type: 'SEARCH_STANDARD', status, ...extra}},
      ]),
    })),
  ),
  ...['ENABLED', 'PAUSED'].map(status => ({
    kind: 'asset group',
    parents: 'campaign',
    plan: compile('asset_group_mutate_asset_groups', [
      {create: {name: 'DNU asset group', campaign: campaign(9), status}},
    ]),
  })),
  ...[{}, {negative: true}].map(extra => ({
    kind: 'campaign criterion',
    parents: 'campaign',
    plan: compile('campaign_criterion_mutate_campaign_criteria', [
      {create: {campaign: campaign(9), location: {geo_target_constant: 'geoTargetConstants/2840'}, ...extra}},
    ]),
  })),
  ...['ENABLED', 'PAUSED'].map(status => ({
    kind: 'ad',
    parents: 'ad group',
    plan: compile('ad_group_ad_mutate_ad_group_ads', [children[2].record(status)]),
  })),
  ...[{}, {status: 'ENABLED'}, {status: 'PAUSED'}, {negative: true}, {cpc_bid_micros: '1000000'}].map(extra => ({
    kind: 'keyword',
    parents: 'ad group',
    plan: compile('ad_group_criterion_mutate_ad_group_criteria', [
      {create: {ad_group: AD_GROUP, keyword: {text: 'dnu shoes', match_type: 'PHRASE'}, ...extra}},
    ]),
  })),
];
test('the state-aware rule is the state-free rule less the creates under a PAUSED parent: it never adds a flag and never removes another', () => {
  let removed = 0,
    kept = 0;
  for (const {kind, parents, plan} of walked) {
    const base = spendConfirmationError(plan) !== undefined;
    for (const groupStatus of parents === 'campaign' ? [undefined] : readings)
      for (const campaignStatus of readings) {
        const state =
            parents === 'campaign' ? stateOfCampaign(campaignStatus) : stateOfGroup(groupStatus, campaignStatus),
          covered =
            parents === 'campaign'
              ? campaignStatus === 'PAUSED'
              : groupStatus === 'PAUSED' || campaignStatus === 'PAUSED',
          now = spendConfirmationError(plan, state) !== undefined,
          label = [kind, JSON.stringify(plan.body.operations[0].create).slice(0, 90), groupStatus, campaignStatus].join(
            ' | ',
          );
        assert.equal(now, base && !covered, label);
        if (base && covered) removed++;
        else kept++;
      }
  }
  assert.ok(removed > 50 && kept > 50, 'the walk covers both outcomes: ' + removed + ' removed, ' + kept + ' kept');
});

// ---- Every caller without a state keeps the state-free form, and the callers that hold one pass it. A new caller of the rule, of the effect
// class that asks it, or of the execute requirements that ask it must be named here, so that it is decided, not forgotten, whether it holds a state.
function callsOf(source, name) {
  const found = [];
  for (const match of source.matchAll(new RegExp('(?<![A-Za-z_.])' + name + '\\(', 'g'))) {
    // Skip a declaration: `function name(` and `export function name(`.
    if (/function\s+$/.test(source.slice(Math.max(0, match.index - 20), match.index))) continue;
    let depth = 0,
      end = match.index + match[0].length - 1;
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++;
      else if (source[end] === ')' && --depth === 0) break;
    }
    found.push(source.slice(match.index, end + 1).replace(/\s+/g, ' '));
  }
  return found;
}
test('the callers of the spend rule, of the effect class and of the execute requirements are the known ones, and each passes the state it holds or none', () => {
  const sources = Object.fromEntries(
    fs
      .readdirSync('src')
      .filter(name => name.endsWith('.ts'))
      .map(name => ['src/' + name, fs.readFileSync('src/' + name, 'utf8')]),
  );
  const sites = {};
  for (const [file, source] of Object.entries(sources))
    for (const name of ['spendConfirmationError', 'authorizeExecution', 'effectClass', 'executeRequirements'])
      for (const call of callsOf(source, name)) (sites[file + ' ' + name] ??= []).push(call);
  assert.deepEqual(sites, {
    // The effect class: given the reviewed state where there is one (the answer of prepare), none for a bare plan (inspect).
    'src/effect-class.ts spendConfirmationError': ['spendConfirmationError(risk, before)'],
    // Its two callers (round 2, S4-2 of the lead's review): inspect gives a bare plan, which fails closed, and prepare's answer gives the
    // state it read, so that `effect` agrees with execute_requirements.
    'src/write-review.ts effectClass': ['effectClass(plan)', 'effectClass(plan, state)'],
    // What prepare tells the client execute will ask: decided from the state it read, the state the rule reads.
    'src/write-review.ts executeRequirements': [
      'executeRequirements( actor, plan, this.policy, reviewId, input.creative_edit_confirmed === true, exceededCaps(spendPolicy), destructiveTier, state, )',
    ],
    // The rule's own caller.
    'src/preflight.ts spendConfirmationError': ['spendConfirmationError(plan, state)'],
    // A read-only plan: authorizeExecution returns at once for one, so there is no state to pass and no spend to ask.
    'src/service.ts authorizeExecution': ['authorizeExecution(actor, plan, input, this.policy)'],
    'src/write-review.ts authorizeExecution': [
      // What prepare tells the client execute will ask, from the state it read.
      'authorizeExecution(actor, plan, {dry_run: false, confirmed: true, idempotency_key: reviewId}, policy, true, state)',
      // A group's check of each part before its first part is sent, from the state each part froze.
      'authorizeExecution( actor, plan, {...flags, confirmed: true, idempotency_key: reviewId, dry_run: false}, this.policy, true, review.state, )',
      // Execute's first check, from the state the review froze.
      'authorizeExecution(actor, plan, {...input, dry_run: false}, this.policy, true, review.state)',
      // The check just before dispatch, from the state read again after the state check.
      'authorizeExecution(actor, plan, {...input, dry_run: false}, this.policy, true, current)',
    ],
  });
});

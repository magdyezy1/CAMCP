import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {saveSpendPolicy, checkSpendPolicy, exceededCaps} from '../dist/src/spend-policy.js';

/*
 * r25-mf-caps (the audit of f6f5490d, 2026-11-25): a field a write removes is a clear, and a clear is judged. The owner
 * policy already refused a cap set to null, zero or a removed budget. Three removals were skipped: a field an update mask
 * names that the update leaves out (Google Ads' updateMask beside `update`, DV360's updateMask in the query), and a bid
 * removed by a JSON Patch `remove`, a REST.li `$delete` or a null (only budgets were read for those). Each case below
 * passed the policy on f6f5490d.
 */
const key = Buffer.alloc(32, 84).toString('base64'),
  actor = {tenantId: 'cleared-money', userId: 'owner', role: 'admin'};
const withPolicy = (policy, run) => {
  const s = new Store(':memory:', key);
  try {
    saveSpendPolicy(s, actor, {scope: 'workspace', confirmed: true, policy});
    return run(s);
  } finally {
    s.close();
  }
};
const base = {
  accountId: '123',
  headers: {},
  query: {},
  readOnly: false,
  destructive: false,
  requiresConfirmation: true,
  evidence: 'synthetic cleared money',
  warnings: [],
};
const google = (service, operations) => ({
  ...base,
  gateway: 'google_ads_native_action',
  action: 'google_ads_v23_campaign_mutate_campaigns',
  method: 'POST',
  path: '/v25/customers/123/' + service + ':mutate',
  body: {operations},
});
const dv360 = (kind, updateMask, body) => ({
  ...base,
  gateway: 'dv360_native_action',
  action: 'DV360_ADVERTISERS_' + kind.toUpperCase() + '_PATCH',
  method: 'PATCH',
  path: '/v4/advertisers/123/' + kind + '/1',
  query: {updateMask},
  body,
});
const snapchat = patch => ({
  ...base,
  gateway: 'snapchat_native_action',
  action: 'snapchat_adaccounts_ad_account_id_adsquads_ad_squad_id_patch',
  method: 'PATCH',
  path: '/v1/adaccounts/123/adsquads/9',
  body: patch,
});
const linkedin = body => ({
  ...base,
  gateway: 'linkedin_native_action',
  action: 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_campaign_id_post',
  method: 'POST',
  path: '/rest/adAccounts/123/adCampaigns/111',
  headers: {'X-RestLi-Method': 'PARTIAL_UPDATE'},
  body,
});
const x = body => ({
  ...base,
  gateway: 'x_ads_native_action',
  action: 'x_accounts_account_id_line_items_line_item_id_put',
  method: 'PUT',
  path: '/12/accounts/123/line_items/abc',
  body,
});
const bidCap = {enforcement: 'block', max_bid_native: 5000000},
  budgetCap = {enforcement: 'block', max_budget_native: 200000000};
const campaignUpdate = (update, mask, spelling = 'updateMask') => [
  {update: {resourceName: 'customers/123/campaigns/1', ...update}, [spelling]: mask},
];

// [what it clears, the policy that judges it, the plan, the field the finding names]
const clears = [
  [
    'Google Ads: the target CPA a mask names and the update leaves out',
    bidCap,
    google('campaigns', campaignUpdate({}, 'maximize_conversions.target_cpa_micros')),
    '/body/operations/0/update/maximize_conversions/target_cpa_micros',
  ],
  [
    'Google Ads: the same in camelCase, under the key update_mask',
    bidCap,
    google('campaigns', campaignUpdate({}, 'maximizeConversions.targetCpaMicros', 'update_mask')),
    '/body/operations/0/update/maximize_conversions/target_cpa_micros',
  ],
  [
    'Google Ads: an ad group CPC bid, beside a name the update does carry',
    bidCap,
    google('adGroups', [
      {update: {resourceName: 'customers/123/adGroups/1', name: 'Renamed'}, updateMask: 'name,cpc_bid_micros'},
    ]),
    '/body/operations/0/update/cpc_bid_micros',
  ],
  [
    'Google Ads: a bid the mask names and the update sets to null',
    bidCap,
    google('adGroups', [
      {update: {resourceName: 'customers/123/adGroups/1', cpcBidMicros: null}, updateMask: 'cpc_bid_micros'},
    ]),
    '/body/operations/0/update/cpc_bid_micros',
  ],
  [
    'Google Ads: a campaign budget amount',
    budgetCap,
    google('campaignBudgets', [
      {update: {resourceName: 'customers/123/campaignBudgets/1'}, updateMask: 'amount_micros'},
    ]),
    '/budget/body/operations/0/update/amount_micros',
  ],
  [
    'DV360: the insertion order budget segments a mask names over an empty body',
    budgetCap,
    dv360('insertionOrders', 'budget.budgetSegments', {}),
    '/body/budget/budget_segments',
  ],
  [
    'Snapchat: a bid removed by a JSON Patch remove',
    bidCap,
    snapchat([{op: 'remove', path: '/bid_micro'}]),
    '/body/0/bid_micro',
  ],
  [
    'Snapchat: a bid replaced with null',
    bidCap,
    snapchat([{op: 'replace', path: '/bid_micro', value: null}]),
    '/body/0/bid_micro/bid_micro',
  ],
  [
    'LinkedIn: the bid object a REST.li $delete names',
    bidCap,
    linkedin({patch: {$delete: ['unitCost']}}),
    '/body/patch/unit_cost',
  ],
  [
    'LinkedIn: the amount of the bid, deleted inside a nested patch',
    bidCap,
    linkedin({patch: {unitCost: {$delete: ['amount']}}}),
    '/body/patch/unit_cost/amount',
  ],
  ['X: a bid set to null', bidCap, x({bid_amount_local_micro: null}), '/body/bid_amount_local_micro'],
];
for (const [label, policy, plan, field] of clears)
  test('a clear is judged: ' + label, () => {
    withPolicy(policy, s =>
      assert.throws(
        () => checkSpendPolicy(s, actor, plan, []),
        e => {
          assert.equal(e.code, 'POLICY_AMOUNT_UNSUPPORTED');
          assert.equal(e.details.field, field);
          return true;
        },
      ),
    );
  });

test('under confirm a clear asks the user, and the execute stops until they approve it', () => {
  const plan = google('campaigns', campaignUpdate({}, 'maximize_conversions.target_cpa_micros'));
  withPolicy({enforcement: 'confirm', max_bid_native: 5000000}, s => {
    const result = checkSpendPolicy(s, actor, plan, []);
    assert.deepEqual(
      exceededCaps(result).map(c => [c.rule, c.field]),
      [['POLICY_AMOUNT_UNSUPPORTED', '/body/operations/0/update/maximize_conversions/target_cpa_micros']],
    );
    assert.throws(() => checkSpendPolicy(s, actor, plan, [], 'review-1'), {code: 'CAP_CONFIRMATION_REQUIRED'});
    assert.equal(checkSpendPolicy(s, actor, plan, [], 'review-1', true).requested_increase_decimal, '0');
  });
});

// The same removals, judged by a policy that caps nothing they touch, or that name something else, pass.
test('a removal the policy does not cap, and an edit that removes no money, still pass', () => {
  const targetCpa = google('campaigns', campaignUpdate({}, 'maximize_conversions.target_cpa_micros'));
  for (const policy of [
    {enforcement: 'block', allow_activation: false},
    {enforcement: 'block', max_budget_native: 1},
  ])
    withPolicy(policy, s => assert.equal(checkSpendPolicy(s, actor, targetCpa, []).exceeded, undefined));
  withPolicy({...bidCap, max_budget_native: 200000000}, s => {
    for (const plan of [
      google('campaigns', campaignUpdate({name: 'Renamed'}, 'name')),
      google('adGroups', [
        {update: {resourceName: 'customers/123/adGroups/1', cpcBidMicros: '5000000'}, updateMask: 'cpc_bid_micros'},
      ]),
      dv360('insertionOrders', 'displayName', {displayName: 'Renamed'}),
      snapchat([{op: 'remove', path: '/name'}]),
      linkedin({patch: {$delete: ['name']}}),
      linkedin({patch: {$set: {name: 'Renamed'}}}),
      x({name: 'Renamed'}),
    ])
      assert.equal(checkSpendPolicy(s, actor, plan, []).requested_increase_decimal, '0');
    // A bid the update carries is compared, not cleared: over the cap it is refused as a bid.
    assert.throws(
      () =>
        checkSpendPolicy(
          s,
          actor,
          google('adGroups', [
            {update: {resourceName: 'customers/123/adGroups/1', cpcBidMicros: '9000000'}, updateMask: 'cpc_bid_micros'},
          ]),
          [],
        ),
      {code: 'POLICY_BID_LIMIT'},
    );
  });
});

// An update mask replaces the message it names whole: money the reviewed state holds under it and the update does not carry is cleared too.
test('a masked message replaced by an update that leaves out the money the state holds clears it (Google Ads)', () => {
  const held = [
      {
        results: [
          {
            campaign: {
              resourceName: 'customers/123/campaigns/1',
              maximizeConversions: {targetCpaMicros: '2000000', cpcBidCeilingMicros: '1500000'},
            },
          },
        ],
      },
    ],
    target = '/body/operations/0/update/maximize_conversions/target_cpa_micros',
    ceiling = '/body/operations/0/update/maximize_conversions/cpc_bid_ceiling_micros';
  withPolicy({enforcement: 'confirm', max_bid_native: 5000000}, s => {
    const fields = update =>
      exceededCaps(
        checkSpendPolicy(s, actor, google('campaigns', campaignUpdate(update, 'maximize_conversions')), held),
      ).map(c => [c.rule, c.field]);
    for (const update of [{}, {maximizeConversions: {}}])
      assert.deepEqual(fields(update), [
        ['POLICY_AMOUNT_UNSUPPORTED', target],
        ['POLICY_AMOUNT_UNSUPPORTED', ceiling],
      ]);
    assert.deepEqual(fields({maximizeConversions: {cpcBidCeilingMicros: '1500000'}}), [
      ['POLICY_AMOUNT_UNSUPPORTED', target],
    ]);
    // What the update carries is compared, not cleared; carried in full it clears nothing.
    assert.deepEqual(fields({maximizeConversions: {targetCpaMicros: '2000000', cpcBidCeilingMicros: '1500000'}}), []);
    assert.deepEqual(fields({maximizeConversions: {targetCpaMicros: '9000000', cpcBidCeilingMicros: '1500000'}}), [
      ['POLICY_BID_LIMIT', '/body/operations/0/update/maximize_conversions/target_cpa_micros'],
    ]);
    // A message the mask does not name is left as it is, and a state that shows none gives nothing to clear.
    const rename = google('campaigns', campaignUpdate({name: 'Renamed'}, 'name'));
    assert.equal(checkSpendPolicy(s, actor, rename, held).exceeded, undefined);
    assert.equal(
      checkSpendPolicy(s, actor, google('campaigns', campaignUpdate({}, 'maximize_conversions')), []).exceeded,
      undefined,
    );
  });
  // Under block the first one refuses; with no bid cap there is no bid to lose.
  withPolicy(bidCap, s =>
    assert.throws(
      () => checkSpendPolicy(s, actor, google('campaigns', campaignUpdate({}, 'maximize_conversions')), held),
      e => e.code === 'POLICY_AMOUNT_UNSUPPORTED' && e.details.field === target,
    ),
  );
  withPolicy({enforcement: 'block', max_budget_native: 200000000}, s =>
    assert.equal(
      checkSpendPolicy(s, actor, google('campaigns', campaignUpdate({}, 'maximize_conversions')), held).exceeded,
      undefined,
    ),
  );
});

test('a masked pacing or budget replaced by an update that names no limit clears the one the state holds (DV360)', () => {
  const pacing = (extra = {}) => ({
      pacing: {pacingPeriod: 'PACING_PERIOD_DAILY', pacingType: 'PACING_TYPE_EVEN', ...extra},
    }),
    held = [
      {
        ...pacing({dailyMaxMicros: '100000000'}),
        budget: {
          budgetUnit: 'BUDGET_UNIT_CURRENCY',
          budgetSegments: [{budgetAmountMicros: '100000000', dateRange: {startDate: {year: 2027, month: 1, day: 1}}}],
        },
      },
    ];
  withPolicy({...budgetCap, enforcement: 'confirm'}, s => {
    const fields = plan => exceededCaps(checkSpendPolicy(s, actor, plan, held)).map(c => [c.rule, c.field]);
    const lost = [['POLICY_AMOUNT_UNSUPPORTED', '/body/pacing/daily_max_micros']];
    assert.deepEqual(fields(dv360('insertionOrders', 'pacing', pacing())), lost);
    assert.deepEqual(fields(dv360('insertionOrders', 'pacing', {})), lost);
    assert.deepEqual(fields(dv360('insertionOrders', 'pacing', pacing({dailyMaxMicros: '100000000'}))), []);
    assert.deepEqual(fields(dv360('insertionOrders', 'budget', {budget: {budgetUnit: 'BUDGET_UNIT_CURRENCY'}})), [
      ['POLICY_AMOUNT_UNSUPPORTED', '/body/budget/budget_segments/budget_amount_micros'],
    ]);
    // A leaf mask over an empty body is judged once, by the null it amounts to.
    assert.deepEqual(fields(dv360('insertionOrders', 'budget.budgetSegments', {})), [
      ['POLICY_AMOUNT_UNSUPPORTED', '/body/budget/budget_segments'],
    ]);
    // Another field masked leaves both alone.
    assert.deepEqual(fields(dv360('insertionOrders', 'displayName', {displayName: 'Renamed'})), []);
    assert.deepEqual(fields(dv360('insertionOrders', 'entityStatus', {entityStatus: 'ENTITY_STATUS_PAUSED'})), []);
  });
});

// A budget the provider calls unlimited lifts the cap it replaces: TikTok's BUDGET_MODE_INFINITE is the same class as DV360's unlimited line
// item budget (tests/spend-policy-dv360-money.test.mjs). It is the norm of a new campaign, so only a campaign that held a finite budget lifts one.
test('a TikTok campaign moved from a finite budget to unlimited lifts its cap; created, restated or already unlimited, it lifts nothing', () => {
  const tiktok = (action, path, body) => ({
      ...base,
      gateway: 'tiktok_native_action',
      action,
      method: 'POST',
      path,
      body,
    }),
    update = mode => tiktok('tiktok_campaign_update', '/v1.3/campaign/update/', {campaign_id: '1', budget_mode: mode}),
    held = (mode, budget) => [{data: {list: [{campaign_id: '1', budget_mode: mode, budget}]}}],
    infinite = 'BUDGET_MODE_INFINITE',
    day = 'BUDGET_MODE_DAY';
  const caps = {max_budget_native: 200, max_budget_increase_percent: 10, max_daily_increase_native: 50};
  withPolicy({enforcement: 'block', ...caps}, s => {
    assert.throws(() => checkSpendPolicy(s, actor, update(infinite), held(day, 100)), {code: 'POLICY_BUDGET_LIMIT'});
    assert.equal(checkSpendPolicy(s, actor, update(infinite), held(infinite, 0)).exceeded, undefined);
    assert.equal(checkSpendPolicy(s, actor, update(infinite), []).exceeded, undefined);
    assert.equal(
      checkSpendPolicy(
        s,
        actor,
        tiktok('tiktok_campaign_create', '/v1.3/campaign/create/', {campaign_name: 'x', budget_mode: infinite}),
        [],
      ).exceeded,
      undefined,
    );
    const raise = amount =>
      tiktok('tiktok_campaign_update', '/v1.3/campaign/update/', {campaign_id: '1', budget_mode: day, budget: amount});
    assert.equal(checkSpendPolicy(s, actor, raise(105), held(day, 100)).requested_increase_decimal, '5');
  });
  withPolicy({enforcement: 'confirm', ...caps}, s =>
    assert.deepEqual(
      exceededCaps(checkSpendPolicy(s, actor, update(infinite), held(day, 100)))
        .map(c => c.rule)
        .sort(),
      ['POLICY_BUDGET_LIMIT', 'POLICY_DAILY_INCREASE_LIMIT', 'POLICY_INCREASE_LIMIT'],
    ),
  );
  withPolicy({enforcement: 'block', max_bid_native: 5}, s =>
    assert.equal(checkSpendPolicy(s, actor, update(infinite), held(day, 100)).exceeded, undefined),
  );
});

test('the request the policy reads is not changed by judging it', () => {
  const plan = google('campaigns', campaignUpdate({}, 'maximize_conversions.target_cpa_micros')),
    before = JSON.stringify(plan);
  withPolicy({enforcement: 'confirm', max_bid_native: 5000000}, s => checkSpendPolicy(s, actor, plan, []));
  assert.equal(JSON.stringify(plan), before);
});

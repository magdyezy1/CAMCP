import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {saveSpendPolicy, checkSpendPolicy, exceededCaps} from '../dist/src/spend-policy.js';
import {lifetimeAmount} from '../dist/src/budget-units.js';

/*
 * r25-mf-caps (the audit of f6f5490d, 2026-11-25): a money object is {amount, currencyCode}, so the leaf says nothing
 * about which amount it is. The policy paired an amount with the prior value of the same leaf, and a LinkedIn campaign
 * holds up to three of them (dailyBudget, totalBudget, unitCost). A new daily budget was compared with the campaign's
 * total, lowering a total was refused, and the nested REST.li patch ({patch: {totalBudget: {$set: {amount}}}}) hid the
 * total from the total cap and the bid from the bid cap. Each test below fails on f6f5490d for the reason it names.
 */
const key = Buffer.alloc(32, 83).toString('base64'),
  actor = {tenantId: 'money-objects', userId: 'owner', role: 'admin'};
const withPolicy = (policy, run) => {
  const s = new Store(':memory:', key);
  try {
    saveSpendPolicy(s, actor, {scope: 'workspace', confirmed: true, policy});
    return run(s);
  } finally {
    s.close();
  }
};
const usd = amount => ({amount: String(amount), currencyCode: 'USD'});
const linkedin = (body, method = 'PARTIAL_UPDATE', path = '/rest/adAccounts/123/adCampaigns/111') => ({
  gateway: 'linkedin_native_action',
  accountId: '123',
  action: 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_campaign_id_post',
  method: 'POST',
  path,
  headers: {'X-RestLi-Method': method},
  query: {},
  body,
  readOnly: false,
  destructive: false,
  requiresConfirmation: true,
  evidence: 'synthetic money objects',
  warnings: [],
});
const create = body => ({
  ...linkedin(body, 'CREATE', '/rest/adAccounts/123/adCampaigns'),
  action: 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_post',
});
/** The campaign as a review read it: only the money objects the case gives it. */
const campaign = ({daily, total, unit} = {}) => [
  {
    id: 111,
    status: 'ACTIVE',
    ...(daily === undefined ? {} : {dailyBudget: usd(daily)}),
    ...(total === undefined ? {} : {totalBudget: usd(total)}),
    ...(unit === undefined ? {} : {unitCost: usd(unit)}),
  },
];
const rules = result => exceededCaps(result).map(x => x.rule);

test('a new daily budget is compared with the daily budget, not with the total (the audit: 4,000 a day passed a 50 cap)', () => {
  const state = campaign({total: 5000, unit: 5}),
    set = linkedin({patch: {$set: {dailyBudget: usd(4000)}}});
  withPolicy({enforcement: 'block', max_budget_increase_percent: 10, max_daily_increase_native: 50}, s =>
    assert.throws(() => checkSpendPolicy(s, actor, set, state), {code: 'POLICY_BASELINE_REQUIRED'}),
  );
  // Under confirm the user is asked about both: no daily budget to measure the rise from, and 4,000 a day over a 50 cap.
  withPolicy({enforcement: 'confirm', max_budget_increase_percent: 10, max_daily_increase_native: 50}, s =>
    assert.deepEqual(rules(checkSpendPolicy(s, actor, set, state)).sort(), [
      'POLICY_BASELINE_REQUIRED',
      'POLICY_DAILY_INCREASE_LIMIT',
    ]),
  );
});

test('a rise of the daily budget next to a total budget is judged against the daily budget alone', () => {
  const state = campaign({daily: 100, total: 5000}),
    policy = {enforcement: 'block', max_budget_increase_percent: 10, max_daily_increase_native: 50};
  withPolicy(policy, s => {
    const ok = checkSpendPolicy(s, actor, linkedin({patch: {$set: {dailyBudget: usd(105)}}}), state);
    assert.equal(ok.requested_increase_decimal, '5');
    assert.throws(() => checkSpendPolicy(s, actor, linkedin({patch: {$set: {dailyBudget: usd(112)}}}), state), {
      code: 'POLICY_INCREASE_LIMIT',
    });
  });
});

test('lowering a total budget is always allowed, even above the total cap; raising it is held to that cap (D7)', () => {
  const state = campaign({daily: 100, total: 5000});
  withPolicy({enforcement: 'block', max_total_budget_native: 3000}, s => {
    const lower = checkSpendPolicy(s, actor, linkedin({patch: {$set: {totalBudget: usd(4000)}}}), state);
    assert.equal(lower.requested_increase_decimal, '0');
    assert.equal(lower.exceeded, undefined);
    assert.throws(
      () => checkSpendPolicy(s, actor, linkedin({patch: {$set: {totalBudget: usd(6000)}}}), state),
      e => {
        assert.equal(e.code, 'POLICY_BUDGET_LIMIT');
        assert.equal(e.details.limit_key, 'max_total_budget_native');
        assert.equal(e.details.limit, 3000);
        return true;
      },
    );
    // A new total on a campaign that has none has nothing to be lowered from.
    assert.throws(
      () => checkSpendPolicy(s, actor, linkedin({patch: {$set: {totalBudget: usd(4000)}}}), campaign({daily: 5000})),
      {code: 'POLICY_BUDGET_LIMIT'},
    );
  });
});

// The owner's decision of 2026-11-25 ("a cut can never increase spend"): a genuine decrease is always allowed, for every money field, even above the
// cap. It was held to the ceiling before; now only a strictly lower amount of the same field is a decrease: a restatement, a raise, a new record and a
// create are still held to the ceiling.
test('a daily budget strictly below its current value is allowed above the ceiling (owner decision 2026-11-25); a restatement, a raise, a new record and a create are not', () => {
  withPolicy({enforcement: 'block', max_budget_native: 80}, s => {
    const state = campaign({daily: 100}),
      daily = amount => linkedin({patch: {$set: {dailyBudget: usd(amount)}}});
    for (const amount of [75, 90])
      assert.equal(checkSpendPolicy(s, actor, daily(amount), state).exceeded, undefined, String(amount));
    for (const amount of [100, 110])
      assert.throws(
        () => checkSpendPolicy(s, actor, daily(amount), state),
        {code: 'POLICY_BUDGET_LIMIT'},
        String(amount),
      );
    assert.throws(() => checkSpendPolicy(s, actor, daily(90), campaign()), {code: 'POLICY_BUDGET_LIMIT'});
    assert.throws(() => checkSpendPolicy(s, actor, create({dailyBudget: usd(90)}), []), {code: 'POLICY_BUDGET_LIMIT'});
  });
});
// Unchanged (WRT-07, tests/currency-money-checks.test.mjs): two different current values are no single baseline, so a batch whose records
// the policy cannot tell apart is refused under a percentage or daily cap even when each is lowered. A named negative test, not a wish.
test('several different current values still make no single baseline for a batch, lowered or not', () => {
  const batch = (a, b) =>
      linkedin(
        {entities: {111: {patch: {$set: {dailyBudget: usd(a)}}}, 112: {patch: {$set: {dailyBudget: usd(b)}}}}},
        'BATCH_PARTIAL_UPDATE',
        '/rest/adAccounts/123/adCampaigns',
      ),
    state = [
      {id: 111, dailyBudget: usd(100)},
      {id: 112, dailyBudget: usd(50)},
    ];
  withPolicy({enforcement: 'block', max_budget_increase_percent: 10, max_daily_increase_native: 50}, s => {
    for (const [a, b] of [
      [40, 45],
      [40, 60],
      [105, 55],
    ])
      assert.throws(
        () => checkSpendPolicy(s, actor, batch(a, b), state),
        {code: 'POLICY_BASELINE_REQUIRED'},
        a + ',' + b,
      );
    // One current value, or the same value for both, is a baseline.
    const same = [
      {id: 111, dailyBudget: usd(100)},
      {id: 112, dailyBudget: usd(100)},
    ];
    assert.equal(checkSpendPolicy(s, actor, batch(40, 45), same).requested_increase_decimal, '0');
  });
});

// The decrease rule for a total (D7): it is a decrease from its record's own current value, so a record that holds no total of its own (or that the
// state does not show) must not borrow another record's to be called one. Where the policy cannot tell the records apart by identity (a LinkedIn
// batch), the state has to show a current value for every total of the request. With the amounts paired by their money object (this branch) one
// prior value is common, which is when borrowing becomes possible; before, a daily budget beside it made the baseline ambiguous and refused.
test('a campaign with no total of its own does not borrow the total of another to be called a decrease', () => {
  const batch = (a, b) =>
      linkedin(
        {entities: {111: {patch: {$set: {totalBudget: usd(a)}}}, 112: {patch: {$set: {totalBudget: usd(b)}}}}},
        'BATCH_PARTIAL_UPDATE',
        '/rest/adAccounts/123/adCampaigns',
      ),
    holds = (...values) => values.map((v, i) => ({id: 111 + i, ...(v === undefined ? {} : {totalBudget: usd(v)})}));
  withPolicy({enforcement: 'confirm', max_total_budget_native: 3000}, s => {
    const over = state => exceededCaps(checkSpendPolicy(s, actor, batch(4000, 4500), state)).map(x => x.field);
    // 112 holds no total, or is not in the state: its 4,500 is a new amount over the cap.
    for (const state of [holds(5000, undefined), holds(5000)])
      assert.ok(over(state).includes('/body/entities/112/patch/$set/total_budget/amount'), JSON.stringify(state));
    // Each shows its own total and the two agree: two decreases, and the cap is not asked of either.
    assert.deepEqual(over(holds(5000, 5000)), []);
    // They disagree: no single baseline (WRT-07), so the cap holds for both.
    assert.equal(over(holds(5000, 4800)).length, 2);
  });
});

test('Google Ads totals name their record: a decrease on one and a new amount on another are each judged by their own', () => {
  const plan = (...updates) => ({
      gateway: 'google_ads_native_action',
      accountId: '123',
      action: 'google_ads_v23_campaign_budget_mutate_campaign_budgets',
      method: 'POST',
      path: '/v23/customers/123/campaignBudgets:mutate',
      headers: {},
      query: {},
      body: {
        operations: updates.map(([id, micros]) => ({
          update: {resourceName: 'customers/123/campaignBudgets/' + id, totalAmountMicros: String(micros)},
          updateMask: 'totalAmountMicros',
        })),
      },
      readOnly: false,
      destructive: false,
      requiresConfirmation: true,
      evidence: 'synthetic money objects',
      warnings: [],
    }),
    held = (...rows) => [
      {
        results: rows.map(([id, micros]) => ({
          campaignBudget: {resourceName: 'customers/123/campaignBudgets/' + id, totalAmountMicros: String(micros)},
        })),
      },
    ];
  withPolicy({enforcement: 'confirm', max_total_budget_native: 80000000}, s => {
    const over = (p, state) => exceededCaps(checkSpendPolicy(s, actor, p, state)).map(x => x.field);
    // Total 1 is lowered from 100M to 90M (a decrease above the cap), total 2 is raised above it, total 3 is not in the state.
    const second = '/budget/body/operations/1/update/total_amount_micros';
    assert.deepEqual(over(plan([1, 90000000], [2, 95000000]), held([1, 100000000], [2, 50000000])), [second]);
    assert.deepEqual(over(plan([1, 90000000], [3, 95000000]), held([1, 100000000])), [second]);
    assert.deepEqual(over(plan([1, 90000000], [2, 70000000]), held([1, 100000000], [2, 50000000])), []);
  });
});
// Every shape a LinkedIn write can give a total budget: REST.li partial update ($set), the nested patch of one field,
// the batch of partial updates, and the full replacement (UPDATE), which restates the daily budget unchanged.
const totalShapes = amount => [
  ['$set', linkedin({patch: {$set: {totalBudget: usd(amount)}}})],
  ['nested $set', linkedin({patch: {totalBudget: {$set: {amount: String(amount)}}}})],
  [
    'batch partial update',
    linkedin(
      {entities: {111: {patch: {$set: {totalBudget: usd(amount)}}}}},
      'BATCH_PARTIAL_UPDATE',
      '/rest/adAccounts/123/adCampaigns',
    ),
  ],
  ['full replacement', linkedin({dailyBudget: usd(100), totalBudget: usd(amount)}, 'UPDATE')],
];
test('the total cap answers to a total in every shape a write can take, and a decrease passes in each', () => {
  const state = campaign({daily: 100, total: 5000});
  withPolicy({enforcement: 'block', max_budget_native: 100, max_total_budget_native: 3000}, s => {
    for (const [shape, plan] of totalShapes(4000))
      assert.equal(checkSpendPolicy(s, actor, plan, state).exceeded, undefined, shape + ' lowers the total');
    for (const [shape, plan] of totalShapes(6000))
      assert.throws(
        () => checkSpendPolicy(s, actor, plan, state),
        e =>
          e.code === 'POLICY_BUDGET_LIMIT' &&
          e.details.limit === 3000 &&
          e.details.limit_key === 'max_total_budget_native',
        shape + ' raises the total',
      );
  });
});

test('a rise of the daily budget is measured against the daily budget in every shape, beside an unchanged total', () => {
  const state = campaign({daily: 100, total: 5000}),
    policy = {enforcement: 'block', max_budget_increase_percent: 10, max_daily_increase_native: 50};
  const shapes = amount => [
    ['$set', linkedin({patch: {$set: {dailyBudget: usd(amount), totalBudget: usd(5000)}}})],
    ['nested $set', linkedin({patch: {dailyBudget: {$set: {amount: String(amount)}}}})],
    [
      'batch partial update',
      linkedin(
        {entities: {111: {patch: {$set: {dailyBudget: usd(amount)}}}}},
        'BATCH_PARTIAL_UPDATE',
        '/rest/adAccounts/123/adCampaigns',
      ),
    ],
    ['full replacement', linkedin({dailyBudget: usd(amount), totalBudget: usd(5000)}, 'UPDATE')],
  ];
  withPolicy(policy, s => {
    for (const [shape, plan] of shapes(105))
      assert.equal(checkSpendPolicy(s, actor, plan, state).requested_increase_decimal, '5', shape);
    for (const [shape, plan] of shapes(112))
      assert.throws(() => checkSpendPolicy(s, actor, plan, state), {code: 'POLICY_INCREASE_LIMIT'}, shape);
  });
});

test('the bid cap reads a bid in the nested patch as it reads one in $set', () => {
  withPolicy({enforcement: 'block', max_bid_native: 5}, s => {
    for (const body of [{patch: {$set: {unitCost: usd(500)}}}, {patch: {unitCost: {$set: {amount: '500'}}}}])
      assert.throws(() => checkSpendPolicy(s, actor, linkedin(body), campaign({unit: 4})), {code: 'POLICY_BID_LIMIT'});
    for (const body of [{patch: {$set: {unitCost: usd(5)}}}, {patch: {unitCost: {$set: {amount: '5'}}}}])
      assert.equal(checkSpendPolicy(s, actor, linkedin(body), campaign({unit: 4})).exceeded, undefined);
  });
});

// The owner's decision of 2026-11-25: a bid strictly below the one the review read is a decrease, allowed above the bid cap; a restated bid, a raise,
// a new bid and a create are held to it.
test('a bid strictly below its current value is allowed above the bid cap (owner decision 2026-11-25); a restatement, a raise, a new bid and a create are not', () => {
  withPolicy({enforcement: 'block', max_bid_native: 5}, s => {
    const bid = amount => linkedin({patch: {$set: {unitCost: usd(amount)}}}),
      state = campaign({unit: 10});
    for (const amount of [4, 8])
      assert.equal(checkSpendPolicy(s, actor, bid(amount), state).exceeded, undefined, String(amount));
    for (const amount of [10, 12])
      assert.throws(() => checkSpendPolicy(s, actor, bid(amount), state), {code: 'POLICY_BID_LIMIT'}, String(amount));
    assert.throws(() => checkSpendPolicy(s, actor, create({unitCost: usd(8)}), []), {code: 'POLICY_BID_LIMIT'});
    // Google Ads: an ad group's CPC bid.
    const adGroup = micros => ({
      gateway: 'google_ads_native_action',
      accountId: '123',
      action: 'google_ads_v23_campaign_mutate_campaigns',
      method: 'POST',
      path: '/v25/customers/123/adGroups:mutate',
      headers: {},
      query: {},
      body: {
        operations: [
          {
            update: {resourceName: 'customers/123/adGroups/1', cpcBidMicros: String(micros)},
            updateMask: 'cpc_bid_micros',
          },
        ],
      },
      readOnly: false,
      destructive: false,
      requiresConfirmation: true,
      evidence: 'synthetic money objects',
      warnings: [],
    });
    withPolicy({enforcement: 'block', max_bid_native: 5000000}, g => {
      const held = [{results: [{adGroup: {resourceName: 'customers/123/adGroups/1', cpcBidMicros: '9000000'}}]}];
      for (const micros of [4000000, 8000000])
        assert.equal(checkSpendPolicy(g, actor, adGroup(micros), held).exceeded, undefined, String(micros));
      for (const micros of [9000000, 9500000])
        assert.throws(
          () => checkSpendPolicy(g, actor, adGroup(micros), held),
          {code: 'POLICY_BID_LIMIT'},
          String(micros),
        );
    });
  });
});

test('creates keep their ceilings: a new daily budget and a new total each meet their own cap', () => {
  withPolicy({enforcement: 'block', max_budget_native: 50, max_total_budget_native: 6000}, s => {
    assert.equal(
      checkSpendPolicy(s, actor, create({dailyBudget: usd(40), totalBudget: usd(5000)}), []).exceeded,
      undefined,
    );
    assert.throws(() => checkSpendPolicy(s, actor, create({dailyBudget: usd(60), totalBudget: usd(5000)}), []), {
      code: 'POLICY_BUDGET_LIMIT',
    });
    assert.throws(
      () => checkSpendPolicy(s, actor, create({dailyBudget: usd(40), totalBudget: usd(7000)}), []),
      e => {
        assert.equal(e.code, 'POLICY_BUDGET_LIMIT');
        assert.equal(e.details.limit_key, 'max_total_budget_native');
        return true;
      },
    );
  });
});

// A total restated above its cap is a decrease (D7); a daily budget restated within its ceiling and a bid within its cap pass.
test('an edit that names no money, or restates an amount unchanged, still passes under every cap', () => {
  withPolicy(
    {
      enforcement: 'block',
      max_budget_native: 120,
      max_total_budget_native: 3000,
      max_budget_increase_percent: 10,
      max_daily_increase_native: 50,
      max_bid_native: 5,
    },
    s => {
      const state = campaign({daily: 100, total: 5000, unit: 4});
      for (const body of [
        {patch: {$set: {name: 'Renamed'}}},
        {patch: {$set: {dailyBudget: usd(100), totalBudget: usd(5000), unitCost: usd(4)}}},
      ])
        assert.equal(checkSpendPolicy(s, actor, linkedin(body), state).requested_increase_decimal, '0');
    },
  );
});

test('Apple names a CPA cost cap as a money object under the ad group: the bid cap reads it as a bid', () => {
  const adGroup = body => ({
    gateway: 'apple_ads_native_action',
    accountId: '123',
    action: 'apple_ads_v1_adgroup_update',
    method: 'PUT',
    path: '/v1/adgroups/9',
    origin: 'https://api.ads.apple.com',
    headers: {},
    query: {},
    body,
    readOnly: false,
    destructive: false,
    requiresConfirmation: true,
    evidence: 'synthetic money objects',
    warnings: [],
  });
  withPolicy({enforcement: 'block', max_bid_native: 5}, s => {
    for (const body of [
      {cpaCap: {value: {amount: '500', currency: 'USD'}}},
      {bidStrategy: {bid: {amount: '500', currency: 'USD'}}},
    ])
      assert.throws(() => checkSpendPolicy(s, actor, adGroup(body), []), {code: 'POLICY_BID_LIMIT'});
    for (const body of [{cpaCap: {value: {amount: '5', currency: 'USD'}}}, {name: 'Renamed'}])
      assert.equal(checkSpendPolicy(s, actor, adGroup(body), []).exceeded, undefined);
  });
});

test('a total is recognised by its money object whatever sits between it and the amount', () => {
  const total = 'linkedin_native_action';
  for (const path of [
    '/body/total_budget/amount',
    '/body/patch/$set/total_budget/amount',
    '/body/patch/total_budget/$set/amount',
    '/body/entities/111/patch/total_budget/$set/amount',
    '/body/entities/0/total_budget/amount',
  ])
    assert.equal(lifetimeAmount(total, path, 'amount'), true, path);
  for (const path of ['/body/daily_budget/amount', '/body/patch/daily_budget/$set/amount', '/body/amount'])
    assert.equal(lifetimeAmount(total, path, 'amount'), false, path);
});

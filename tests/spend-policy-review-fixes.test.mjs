import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Store} from '../dist/src/store.js';
import {saveSpendPolicy, checkSpendPolicy, exceededCaps} from '../dist/src/spend-policy.js';

/*
 * r25-mf-caps, the fix round after the Opus review of 43b52ce8 (findings F1 to F9, 2026-11-25). Each test below failed on
 * 43b52ce8 for the reason it names, then passed with its fix.
 */
const key = Buffer.alloc(32, 91).toString('base64'),
  actor = {tenantId: 'review-fixes', userId: 'owner', role: 'admin'};
const withPolicy = (policy, run) => {
  const s = new Store(':memory:', key);
  try {
    saveSpendPolicy(s, actor, {scope: 'workspace', confirmed: true, policy});
    return run(s);
  } finally {
    s.close();
  }
};
const rules = result =>
  exceededCaps(result)
    .map(x => x.rule)
    .sort();
const fieldsOf = result => exceededCaps(result).map(x => x.field);
const plan = (gateway, over) => ({
  gateway,
  accountId: '123',
  action: 'review_fix_update',
  method: 'POST',
  path: '/',
  headers: {},
  query: {},
  body: {},
  readOnly: false,
  destructive: false,
  requiresConfirmation: true,
  evidence: 'synthetic review fixes',
  warnings: [],
  ...over,
});

// F1: an added budget object (an array that grows) has no baseline of its own. The one current value of the field used to be every
// added object's baseline, so the increase read 0 under a percentage and a daily cap. DV360 insertion order segments and campaign
// budgets, and the arrays of budgets of Microsoft, Snapchat, LinkedIn batches and Meta.
const caps = {enforcement: 'confirm', max_budget_increase_percent: 10, max_daily_increase_native: 10000000};
const day = {startDate: {year: 2026, month: 1, day: 1}, endDate: {year: 2026, month: 12, day: 31}};
const dv360 = (kind, updateMask, body) =>
  plan('dv360_native_action', {
    action:
      'DV360_ADVERTISERS_' +
      {insertionOrders: 'INSERTION_ORDERS', campaigns: 'CAMPAIGNS', lineItems: 'LINE_ITEMS'}[kind] +
      '_PATCH',
    method: 'PATCH',
    path: '/v4/advertisers/123/' + kind + '/456',
    query: {updateMask},
    body,
  });
const times = (n, make) => Array.from({length: n}, (_, i) => make(i));
const grows = [
  [
    'DV360 insertion order from 1 to 5 segments',
    dv360('insertionOrders', 'budget', {
      budget: {
        budgetUnit: 'BUDGET_UNIT_CURRENCY',
        budgetSegments: times(5, () => ({budgetAmountMicros: '100000000', dateRange: day})),
      },
    }),
    [
      {
        budget: {
          budgetUnit: 'BUDGET_UNIT_CURRENCY',
          budgetSegments: [{budgetAmountMicros: '100000000', dateRange: day}],
        },
      },
    ],
    '/body/budget/budget_segments/1/budget_amount_micros',
  ],
  [
    'DV360 campaign from 1 to 4 campaignBudgets',
    dv360('campaigns', 'campaignBudgets', {
      campaignBudgets: times(4, i => ({budgetId: String(i + 1), budgetAmountMicros: '100000000'})),
    }),
    [{campaignBudgets: [{budgetId: '1', budgetAmountMicros: '100000000'}]}],
    '/body/campaign_budgets/1/budget_amount_micros',
  ],
  [
    'LinkedIn batch whose second campaign holds no daily budget',
    plan('linkedin_native_action', {
      path: '/rest/adAccounts/123/adCampaigns',
      headers: {'X-RestLi-Method': 'BATCH_PARTIAL_UPDATE'},
      body: {
        entities: {
          111: {patch: {$set: {dailyBudget: {amount: '100', currencyCode: 'USD'}}}},
          112: {patch: {$set: {dailyBudget: {amount: '100', currencyCode: 'USD'}}}},
        },
      },
    }),
    [{id: 111, dailyBudget: {amount: '100', currencyCode: 'USD'}}, {id: 112}],
    '/body/entities/112/patch/$set/daily_budget/amount',
  ],
  [
    'Microsoft budgets with a second one that names no Id',
    plan('microsoft_ads_native_action', {
      action: 'microsoft_ads_update_budgets',
      body: {
        Budgets: [
          {Id: 11, Amount: 50},
          {Name: 'Added', Amount: 50},
        ],
      },
    }),
    [{Budgets: [{Id: 11, Amount: 50}]}],
    '/body/budgets/1/amount',
  ],
  [
    'Snapchat campaigns with a second row that names no id',
    plan('snapchat_native_action', {
      method: 'PUT',
      path: '/v1/adaccounts/123/campaigns',
      body: {
        campaigns: [
          {id: 'c1', name: 'One', daily_budget_micro: 100000000},
          {name: 'Added', daily_budget_micro: 100000000},
        ],
      },
    }),
    [{campaigns: [{campaign: {id: 'c1', name: 'One', daily_budget_micro: 100000000}}]}],
    '/body/campaigns/1/daily_budget_micro',
  ],
  [
    'Meta campaign naming the budgets of two ad sets, one of them unseen',
    plan('meta_native_action', {
      path: '/v25.0/9001',
      body: {
        adset_budgets: [
          {adset_id: '1', daily_budget: 10000},
          {adset_id: '2', daily_budget: 10000},
        ],
      },
    }),
    [{adset_budgets: [{adset_id: '1', daily_budget: 10000}]}],
    '/body/adset_budgets/1/daily_budget',
  ],
];
for (const [label, p, state, added] of grows)
  test('F1: ' + label + ' has no baseline for the object it adds, so it is no increase of 0', () => {
    withPolicy({...caps, enforcement: 'block'}, s =>
      assert.throws(() => checkSpendPolicy(s, actor, p, state), {code: 'POLICY_BASELINE_REQUIRED'}),
    );
    withPolicy(caps, s => {
      const result = checkSpendPolicy(s, actor, p, state);
      assert.ok(rules(result).includes('POLICY_BASELINE_REQUIRED'), String(rules(result)));
      assert.ok(fieldsOf(result).includes(added), String(fieldsOf(result)));
    });
  });
test('F1, kept: a request that restates every budget object it holds, and a rename, still pass the percentage and daily caps', () => {
  const restated = [
    [
      'DV360 insertion order, 5 segments of one amount restated',
      dv360('insertionOrders', 'budget', {
        budget: {
          budgetUnit: 'BUDGET_UNIT_CURRENCY',
          budgetSegments: times(5, () => ({budgetAmountMicros: '100000000', dateRange: day})),
        },
      }),
      [
        {
          budget: {
            budgetUnit: 'BUDGET_UNIT_CURRENCY',
            budgetSegments: times(5, () => ({budgetAmountMicros: '100000000', dateRange: day})),
          },
        },
      ],
    ],
    [
      'LinkedIn batch of two campaigns that hold one amount each',
      grows[2][1],
      [
        {id: 111, dailyBudget: {amount: '100', currencyCode: 'USD'}},
        {id: 112, dailyBudget: {amount: '100', currencyCode: 'USD'}},
      ],
    ],
    [
      'Microsoft budgets, both named by their Id',
      plan('microsoft_ads_native_action', {
        action: 'microsoft_ads_update_budgets',
        body: {
          Budgets: [
            {Id: 11, Amount: 50},
            {Id: 12, Amount: 50},
          ],
        },
      }),
      [
        {
          Budgets: [
            {Id: 11, Amount: 50},
            {Id: 12, Amount: 50},
          ],
        },
      ],
    ],
  ];
  withPolicy({...caps, enforcement: 'block'}, s => {
    for (const [label, p, state] of restated)
      assert.equal(checkSpendPolicy(s, actor, p, state).requested_increase_decimal, '0', label);
    assert.equal(
      checkSpendPolicy(s, actor, dv360('insertionOrders', 'displayName', {displayName: 'Renamed'}), grows[0][2])
        .requested_increase_decimal,
      '0',
    );
  });
});

// F2: a leaf mask over a parent the body sets to null still clears the leaf (the null parent was read as a message that is not there).
const cleared = (s, p, field) =>
  assert.throws(
    () => checkSpendPolicy(s, actor, p, []),
    e => e.code === 'POLICY_AMOUNT_UNSUPPORTED' && e.details.field === field,
  );
test('F2: DV360 updateMask pacing.dailyMaxMicros over {"pacing": null} clears the daily limit', () => {
  withPolicy({enforcement: 'block', max_budget_native: 200000000}, s =>
    cleared(s, dv360('insertionOrders', 'pacing.dailyMaxMicros', {pacing: null}), '/body/pacing/daily_max_micros'),
  );
});
test('F2: Google Ads maximizeConversions set to null under the leaf mask of its target CPA clears the bid', () => {
  withPolicy({enforcement: 'block', max_bid_native: 5000000}, s =>
    cleared(
      s,
      plan('google_ads_native_action', {
        action: 'google_ads_v23_campaign_mutate_campaigns',
        path: '/v25/customers/123/campaigns:mutate',
        body: {
          operations: [
            {
              update: {resourceName: 'customers/123/campaigns/1', maximizeConversions: null},
              updateMask: 'maximize_conversions.target_cpa_micros',
            },
          ],
        },
      }),
      '/body/operations/0/update/maximize_conversions/target_cpa_micros',
    ),
  );
});
test('F2, kept: a null parent under a mask that names no money, and a parent that holds the leaf, are not cleared', () => {
  withPolicy({enforcement: 'block', max_budget_native: 200000000}, s => {
    assert.equal(
      checkSpendPolicy(s, actor, dv360('insertionOrders', 'frequencyCap.maxViews', {frequencyCap: null}), []).exceeded,
      undefined,
    );
    assert.equal(
      checkSpendPolicy(
        s,
        actor,
        dv360('insertionOrders', 'pacing.dailyMaxMicros', {
          pacing: {pacingPeriod: 'PACING_PERIOD_DAILY', pacingType: 'PACING_TYPE_EVEN', dailyMaxMicros: '100000000'},
        }),
        [],
      ).exceeded,
      undefined,
    );
  });
});

// F3: DV360 Required fields that are money by name (a line item's partnerRevenueModel.markupAmount, a campaign's performance goal and
// planned spend, an insertion order's kpi) made every create refuse under a numeric cap. A create carries them and is judged by its budgets
// and bids; on an existing record they are reported only when the write sets one above what the review read (or where it read none), or clears it.
const dv360Schemas = JSON.parse(fs.readFileSync('.mirror/VENDOR/dv360-v4.json', 'utf8')).document.schemas;
const chosen = {budgetAllocationType: 'LINE_ITEM_BUDGET_ALLOCATION_TYPE_FIXED', entityStatus: 'ENTITY_STATUS_DRAFT'};
const example = (property, field, depth) => {
  if (property.$ref) return requiredBody(property.$ref, depth + 1);
  if (property.type === 'array') return [property.items?.$ref ? requiredBody(property.items.$ref, depth + 1) : 'x'];
  if (property.type === 'boolean') return false;
  if (property.format === 'int64') return '1000000';
  if (property.type === 'integer') return 2026;
  if (chosen[field]) return chosen[field];
  if (property.enum) return property.enum.find(v => !/UNSPECIFIED$/.test(v));
  return 'x';
};
/** The body of a create as the document requires it: every field its description marks Required, nested. */
const requiredBody = (name, depth = 0) => {
  assert.ok(depth < 8, 'the walk of ' + name + ' went too deep');
  const out = {};
  for (const [field, property] of Object.entries(dv360Schemas[name].properties))
    if (/^\s*Required\./.test(property.description ?? '') && property.readOnly !== true)
      out[field] = example(property, field, depth);
  return out;
};
const dv360Create = (kind, body) =>
  plan('dv360_native_action', {
    action:
      'DV360_ADVERTISERS_' +
      {lineItems: 'LINE_ITEMS', campaigns: 'CAMPAIGNS', insertionOrders: 'INSERTION_ORDERS'}[kind] +
      '_CREATE',
    path: '/v4/advertisers/123/' + kind,
    body,
  });
const every = {
  enforcement: 'block',
  max_budget_native: 200000000,
  max_budget_increase_percent: 10,
  max_daily_increase_native: 10000000,
  max_bid_native: 5000000,
};
const moneyNames = [
  'markupAmount',
  'performanceGoalAmountMicros',
  'kpiAmountMicros',
  'plannedSpendAmountMicros',
  'feeAmount',
];
const names = body => {
  const found = [];
  JSON.stringify(body, (k, v) => (found.push(k), v));
  return found;
};
const creates = () => {
  const lineItem = requiredBody('LineItem'),
    autoBid = {
      ...requiredBody('LineItem'),
      bidStrategy: {performanceGoalAutoBid: requiredBody('PerformanceGoalBidStrategy')},
    },
    campaign = requiredBody('Campaign'),
    order = requiredBody('InsertionOrder');
  // The money a type applies to is Required with it: a CPA goal and its amount, a planned spend, a CPA KPI and its amount, a partner cost fee.
  campaign.campaignGoal.performanceGoal.performanceGoalAmountMicros = '1000000';
  campaign.campaignFlight.plannedSpendAmountMicros = '1000000';
  order.kpi.kpiAmountMicros = '1000000';
  order.partnerCosts = [
    {costType: 'PARTNER_COST_TYPE_ADLOOX', feeType: 'PARTNER_COST_FEE_TYPE_CPM_FEE', feeAmount: '1000000'},
  ];
  return [
    ['line item', dv360Create('lineItems', lineItem), ['markupAmount']],
    [
      'line item with a performance goal bid strategy',
      dv360Create('lineItems', autoBid),
      ['markupAmount', 'performanceGoalAmountMicros'],
    ],
    ['campaign', dv360Create('campaigns', campaign), ['performanceGoalAmountMicros', 'plannedSpendAmountMicros']],
    ['insertion order', dv360Create('insertionOrders', order), ['kpiAmountMicros', 'feeAmount']],
  ];
};
for (const [label, p, carried] of creates())
  test('F3: a DV360 ' + label + ' create carrying every Required field is not refused under numeric caps', () => {
    for (const name of carried) assert.ok(names(p.body).includes(name), name + ' is in the body');
    assert.ok(carried.every(name => moneyNames.includes(name)));
    withPolicy(every, s => assert.equal(checkSpendPolicy(s, actor, p, []).exceeded, undefined));
    withPolicy({...every, enforcement: 'confirm'}, s =>
      assert.equal(checkSpendPolicy(s, actor, p, []).exceeded, undefined),
    );
  });

// The same fields on an existing record: lowered or restated they pass (nothing is raised), raised or set where the review read none they are
// reported by name, and a clear is reported where a value was held. (F9: the null branch of the by-name scan is the clear.)
const named = [
  [
    'markupAmount',
    'lineItems',
    'partnerRevenueModel',
    v => ({partnerRevenueModel: {markupAmount: v}}),
    '/body/partner_revenue_model/markup_amount',
  ],
  ['kpiAmountMicros', 'insertionOrders', 'kpi', v => ({kpi: {kpiAmountMicros: v}}), '/body/kpi/kpi_amount_micros'],
  [
    'plannedSpendAmountMicros',
    'campaigns',
    'campaignFlight',
    v => ({campaignFlight: {plannedSpendAmountMicros: v}}),
    '/body/campaign_flight/planned_spend_amount_micros',
  ],
  [
    'performanceGoalAmountMicros',
    'lineItems',
    'bidStrategy',
    v => ({bidStrategy: {performanceGoalAutoBid: {performanceGoalAmountMicros: v}}}),
    '/body/bid_strategy/performance_goal_auto_bid/performance_goal_amount_micros',
  ],
  [
    'feeAmount',
    'insertionOrders',
    'partnerCosts',
    v => ({partnerCosts: [{feeAmount: v}]}),
    '/body/partner_costs/0/fee_amount',
  ],
];
for (const [name, kind, mask, body, field] of named)
  test('F3: ' + name + ' on an existing DV360 record is reported only when raised, set anew or cleared', () => {
    withPolicy({...every, enforcement: 'confirm'}, s => {
      const judge = (value, state) => rules(checkSpendPolicy(s, actor, dv360(kind, mask, body(value)), state));
      const held = [body('10000000')];
      assert.deepEqual(judge('5000000', held), [], 'lowered');
      assert.deepEqual(judge('10000000', held), [], 'restated');
      assert.deepEqual(judge('10000001', held), ['POLICY_AMOUNT_UNSUPPORTED'], 'raised');
      assert.deepEqual(judge('5000000', [{}]), ['POLICY_AMOUNT_UNSUPPORTED'], 'set where the review read none');
      assert.deepEqual(judge('5000000', []), ['POLICY_AMOUNT_UNSUPPORTED'], 'no state');
      const cleared = checkSpendPolicy(s, actor, dv360(kind, mask, body(null)), held);
      assert.deepEqual(rules(cleared), ['POLICY_AMOUNT_UNSUPPORTED'], 'cleared where a value was held');
      assert.deepEqual(fieldsOf(cleared), [field]);
      assert.deepEqual(judge(null, [{}]), [], 'cleared where none was held');
    });
  });

// F9: the by-name scan counts a null as the clear it is (Google target_spend_micros, a deprecated spend target the policy cannot measure).
test('F9: a Google target_spend_micros set to null is reported by name', () => {
  withPolicy({enforcement: 'block', max_bid_native: 5000000}, s =>
    cleared(
      s,
      plan('google_ads_native_action', {
        action: 'google_ads_v23_campaign_mutate_campaigns',
        path: '/v25/customers/123/campaigns:mutate',
        body: {
          operations: [
            {
              update: {resourceName: 'customers/123/campaigns/1', targetSpend: {targetSpendMicros: null}},
              updateMask: 'target_spend',
            },
          ],
        },
      }),
      '/body/operations/0/update/target_spend/target_spend_micros',
    ),
  );
});

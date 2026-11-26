import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Store} from '../dist/src/store.js';
import {saveSpendPolicy, checkSpendPolicy, exceededCaps} from '../dist/src/spend-policy.js';
import {providerHooks} from '../dist/src/provider-hooks.js';

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

// F5: a prior value the policy cannot read (a bid or budget beyond the supported range, a state nested deeper than the policy walks) must
// not block a write that changes none of them, such as a pause; it is no baseline for a write that does.
const googleCampaign = (update, mask) =>
  plan('google_ads_native_action', {
    action: 'google_ads_v23_campaign_mutate_campaigns',
    path: '/v25/customers/123/campaigns:mutate',
    body: {operations: [{update: {resourceName: 'customers/123/campaigns/1', ...update}, updateMask: mask}]},
  });
const deep = depth => (depth ? {next: deep(depth - 1)} : {cpcBidMicros: '1', dailyBudget: '1'});
const unreadable = [
  ['a bid beyond the supported range', [{results: [{adGroup: {cpcBidMicros: 1e999}}]}]],
  ['a budget beyond the supported range', [{results: [{campaignBudget: {amountMicros: '99999999999999999999999'}}]}]],
  ['a state nested deeper than the policy walks', [deep(80)]],
];
for (const [label, state] of unreadable)
  test('F5: ' + label + ' in the reviewed state does not block a pause', () => {
    const pause = googleCampaign({status: 'PAUSED'}, 'status');
    withPolicy({...every, enforcement: 'block'}, s =>
      assert.equal(checkSpendPolicy(s, actor, pause, state).exceeded, undefined),
    );
    withPolicy({...every, enforcement: 'confirm'}, s =>
      assert.equal(checkSpendPolicy(s, actor, pause, state).exceeded, undefined),
    );
  });

// F4: a campaign moved to another shared budget changes one amount, the budget it spends from: the amount of the budget it is moved to,
// against the amount of the one it leaves (the review reads both). It used to read the new budget's amount, which the state holds under a key
// named like the masked reference, as money cleared by the mask.
const budgetOf = (id, micros) => ({
  campaignBudget: {resourceName: 'customers/123/campaignBudgets/' + id, amountMicros: String(micros)},
});
const moveState = (from, to) => [
  {
    results: [
      {
        campaign: {resourceName: 'customers/123/campaigns/1', campaignBudget: 'customers/123/campaignBudgets/1'},
        ...budgetOf(1, from),
      },
    ],
  },
  {results: [budgetOf(9, to)]},
];
const move = googleCampaign({campaignBudget: 'customers/123/campaignBudgets/9'}, 'campaign_budget');
const sharedCaps = {
  enforcement: 'block',
  max_budget_native: 500000000,
  max_budget_increase_percent: 10,
  max_daily_increase_native: 50000000,
};
test('F4: a campaign moved to a smaller or an equal shared budget is not a cleared cap, and reserves nothing', () => {
  withPolicy(sharedCaps, s => {
    for (const to of [90000000, 100000000])
      assert.equal(
        checkSpendPolicy(s, actor, move, moveState(100000000, to)).requested_increase_decimal,
        '0',
        String(to),
      );
  });
});
test('F4: a campaign moved to a bigger shared budget is an increase, judged by every cap', () => {
  withPolicy(sharedCaps, s => {
    assert.equal(
      checkSpendPolicy(s, actor, move, moveState(100000000, 105000000)).requested_increase_decimal,
      '5000000',
    );
    assert.throws(() => checkSpendPolicy(s, actor, move, moveState(100000000, 120000000)), {
      code: 'POLICY_INCREASE_LIMIT',
    });
    assert.throws(() => checkSpendPolicy(s, actor, move, moveState(100000000, 600000000)), {
      code: 'POLICY_BUDGET_LIMIT',
    });
  });
  withPolicy({...sharedCaps, enforcement: 'confirm'}, s =>
    assert.deepEqual(rules(checkSpendPolicy(s, actor, move, moveState(100000000, 120000000))), [
      'POLICY_INCREASE_LIMIT',
    ]),
  );
});
test('F4: a move whose target budget the review did not read cannot be judged, so it is refused by name', () => {
  withPolicy(sharedCaps, s =>
    assert.throws(
      () => checkSpendPolicy(s, actor, move, moveState(100000000, 90000000).slice(0, 1)),
      e => e.code === 'POLICY_AMOUNT_UNSUPPORTED' && e.details.field === '/body/operations/0/update/campaign_budget',
    ),
  );
});
test('F4, kept: a pause and a rename of that campaign, and a budget cleared by a mask over a message, are judged as before', () => {
  withPolicy(sharedCaps, s => {
    for (const [update, mask] of [
      [{status: 'PAUSED'}, 'status'],
      [{name: 'Renamed'}, 'name'],
    ])
      assert.equal(
        checkSpendPolicy(s, actor, googleCampaign(update, mask), moveState(100000000, 90000000))
          .requested_increase_decimal,
        '0',
      );
  });
});
test('F4: the review reads the budget a campaign leaves when the update names campaign_budget, and only then', () => {
  const read = (path, query, body, method) => ({path, query, body, method}),
    queryOf = p =>
      providerHooks('google_ads_native_action')
        .writes.snapshots(p, read)
        .map(r => r.body.query);
  const [campaignRead] = queryOf(move);
  assert.match(campaignRead, /campaign_budget\.amount_micros/);
  assert.match(campaignRead, /campaign\.campaign_budget/);
  assert.doesNotMatch(queryOf(googleCampaign({status: 'PAUSED'}, 'status'))[0], /campaign_budget/);
});

// F6: false refusals under a bid cap. A bid the owner's cap compares is replaced by another bid it compares; a held bid of 0 is no cap; a
// target ROAS `value` is a ratio; a Microsoft ad group CpcBid set to null inherits the bid.
const bidCap = {enforcement: 'block', max_bid_native: 5000000};
const maximizeSpend = [
  {
    bidStrategy: {
      maximizeSpendAutoBid: {
        performanceGoalType: 'BIDDING_STRATEGY_PERFORMANCE_GOAL_TYPE_CPA',
        maxAverageCpmBidAmountMicros: '4000000',
      },
    },
  },
];
const strategy = body => dv360('lineItems', 'bidStrategy', {bidStrategy: body});
test('F6: a maximize spend cap replaced by a fixed bid is no cleared cap; the fixed bid meets the bid cap itself', () => {
  withPolicy(bidCap, s => {
    for (const micros of ['3000000', '4500000'])
      assert.equal(
        checkSpendPolicy(s, actor, strategy({fixedBid: {bidAmountMicros: micros}}), maximizeSpend).exceeded,
        undefined,
        micros,
      );
    assert.throws(() => checkSpendPolicy(s, actor, strategy({fixedBid: {bidAmountMicros: '6000000'}}), maximizeSpend), {
      code: 'POLICY_BID_LIMIT',
    });
  });
});
test('F6, kept: a maximize spend cap replaced by a strategy that carries no bid is still a cleared cap', () => {
  withPolicy(bidCap, s =>
    assert.throws(
      () =>
        checkSpendPolicy(
          s,
          actor,
          strategy({
            maximizeSpendAutoBid: {performanceGoalType: 'BIDDING_STRATEGY_PERFORMANCE_GOAL_TYPE_CPC'},
          }),
          maximizeSpend,
        ),
      e =>
        e.code === 'POLICY_AMOUNT_UNSUPPORTED' &&
        e.details.field === '/body/bid_strategy/maximize_spend_auto_bid/max_average_cpm_bid_amount_micros',
    ),
  );
});
test('F6: a held bid of 0 (an insertion order fixes it at 0) is no cap, so leaving it out clears nothing', () => {
  withPolicy(bidCap, s =>
    assert.equal(
      checkSpendPolicy(
        s,
        actor,
        dv360('insertionOrders', 'bidStrategy', {
          bidStrategy: {
            maximizeSpendAutoBid: {performanceGoalType: 'BIDDING_STRATEGY_PERFORMANCE_GOAL_TYPE_CPC'},
          },
        }),
        [{bidStrategy: {fixedBid: {bidAmountMicros: '0'}}}],
      ).exceeded,
      undefined,
    ),
  );
});
test('F6: the value of a DV360 bidding strategy is a bid, except a target ROAS, which is a ratio', () => {
  withPolicy({enforcement: 'block', max_bid_native: 2000000}, s => {
    for (const [holder, prefix] of [
      ['youtubeAndPartnersBid', 'YOUTUBE_AND_PARTNERS_BIDDING_STRATEGY_TYPE_'],
      ['demandGenBid', 'DEMAND_GEN_BIDDING_STRATEGY_TYPE_'],
    ]) {
      const set = (type, value) => strategy({[holder]: {type: prefix + type, value}});
      assert.equal(checkSpendPolicy(s, actor, set('TARGET_ROAS', '3000000'), []).exceeded, undefined, holder + ' ROAS');
      assert.throws(
        () => checkSpendPolicy(s, actor, set('TARGET_CPA', '3000000'), []),
        {code: 'POLICY_BID_LIMIT'},
        holder,
      );
    }
  });
});
test('F6: a Microsoft ad group CpcBid set to null inherits the bid and clears no cap; an amount is still a bid', () => {
  withPolicy({enforcement: 'block', max_bid_native: 5}, s => {
    const adGroup = bid =>
      plan('microsoft_ads_native_action', {
        action: 'microsoft_ads_update_ad_groups',
        body: {AdGroups: [{Id: 5, CpcBid: bid}]},
      });
    assert.equal(checkSpendPolicy(s, actor, adGroup(null), []).exceeded, undefined);
    assert.equal(checkSpendPolicy(s, actor, adGroup({Amount: 4}), []).exceeded, undefined);
    assert.throws(() => checkSpendPolicy(s, actor, adGroup({Amount: 9}), []), {code: 'POLICY_BID_LIMIT'});
  });
});

// F8: old bypasses, the cheap and certain ones. A mask of `*` replaces the whole record; a budget moved from a fixed maximum to automatic allocation
// lifts the maximum; 0 means no limit for a Google target CPA and an X total budget; a LinkedIn bid written as 5e2 or 500. cannot be read; Microsoft's
// TargetCpa and MaxCpc are bids.
const fixedBudget = max => ({budgetAllocationType: 'LINE_ITEM_BUDGET_ALLOCATION_TYPE_FIXED', maxAmount: String(max)});
const dailyPacing = max => ({
  pacingPeriod: 'PACING_PERIOD_DAILY',
  pacingType: 'PACING_TYPE_ASAP',
  dailyMaxMicros: String(max),
});
test('F8: updateMask=* replaces the whole record: the money the review read that the body leaves out is cleared', () => {
  withPolicy({enforcement: 'block', max_budget_native: 200000000}, s => {
    const held = [{budget: fixedBudget(100000000), pacing: dailyPacing(10000000)}],
      star = body => dv360('lineItems', '*', body);
    assert.throws(
      () => checkSpendPolicy(s, actor, star({displayName: 'Renamed'}), held),
      e => e.code === 'POLICY_AMOUNT_UNSUPPORTED' && e.details.field === '/body/budget/max_amount',
    );
    assert.equal(
      checkSpendPolicy(
        s,
        actor,
        star({displayName: 'Renamed', budget: fixedBudget(100000000), pacing: dailyPacing(10000000)}),
        held,
      ).exceeded,
      undefined,
    );
  });
  withPolicy({enforcement: 'block', max_bid_native: 5000000}, s => {
    const held = [
      {
        results: [
          {campaign: {resourceName: 'customers/123/campaigns/1', maximizeConversions: {targetCpaMicros: '2000000'}}},
        ],
      },
    ];
    assert.throws(
      () => checkSpendPolicy(s, actor, googleCampaign({status: 'PAUSED'}, '*'), held),
      e => e.code === 'POLICY_AMOUNT_UNSUPPORTED',
    );
    assert.equal(
      checkSpendPolicy(s, actor, googleCampaign({maximizeConversions: {targetCpaMicros: '2000000'}}, '*'), held)
        .exceeded,
      undefined,
    );
  });
});
test('F8: a line item moved from a fixed budget to automatic allocation by a leaf mask lifts its maximum', () => {
  const automatic = 'LINE_ITEM_BUDGET_ALLOCATION_TYPE_AUTOMATIC',
    to = allocation => dv360('lineItems', 'budget.budgetAllocationType', {budget: {budgetAllocationType: allocation}});
  withPolicy({enforcement: 'block', max_budget_native: 200000000}, s => {
    assert.throws(() => checkSpendPolicy(s, actor, to(automatic), [{budget: fixedBudget(100000000)}]), {
      code: 'POLICY_BUDGET_LIMIT',
    });
    // Kept: already automatic, still fixed, and a create that is automatic lift nothing.
    assert.equal(
      checkSpendPolicy(s, actor, to(automatic), [{budget: {budgetAllocationType: automatic}}]).exceeded,
      undefined,
    );
    assert.equal(
      checkSpendPolicy(s, actor, to('LINE_ITEM_BUDGET_ALLOCATION_TYPE_FIXED'), [{budget: fixedBudget(100000000)}])
        .exceeded,
      undefined,
    );
    assert.equal(
      checkSpendPolicy(
        s,
        actor,
        dv360Create('lineItems', {displayName: 'x', budget: {budgetAllocationType: automatic}}),
        [],
      ).exceeded,
      undefined,
    );
  });
});
test('F8: a Google target CPA and an X total budget set to 0 are cleared limits', () => {
  withPolicy({enforcement: 'block', max_bid_native: 5000000}, s =>
    cleared(
      s,
      googleCampaign({maximizeConversions: {targetCpaMicros: '0'}}, 'maximize_conversions'),
      '/body/operations/0/update/maximize_conversions/target_cpa_micros',
    ),
  );
  withPolicy({enforcement: 'block', max_budget_native: 200000000}, s => {
    const x = total =>
      plan('x_ads_native_action', {
        action: 'x_accounts_account_id_line_items_line_item_id_put',
        method: 'PUT',
        path: '/12/accounts/123/line_items/abc',
        body: {total_budget_amount_local_micro: total},
      });
    cleared(s, x(0), '/body/total_budget_amount_local_micro');
    assert.equal(checkSpendPolicy(s, actor, x(100000000), []).exceeded, undefined);
  });
});
test('F8: a LinkedIn bid written as 5e2 or 500. cannot be compared, so it is refused', () => {
  withPolicy({enforcement: 'block', max_bid_native: 5}, s => {
    const bid = amount =>
      plan('linkedin_native_action', {
        path: '/rest/adAccounts/123/adCampaigns/111',
        headers: {'X-RestLi-Method': 'PARTIAL_UPDATE'},
        body: {patch: {$set: {unitCost: {amount, currencyCode: 'USD'}}}},
      });
    for (const amount of ['5e2', '500.'])
      assert.throws(() => checkSpendPolicy(s, actor, bid(amount), []), {code: 'POLICY_AMOUNT_INVALID'}, amount);
    assert.equal(checkSpendPolicy(s, actor, bid('4'), []).exceeded, undefined);
  });
});
test('F8: a Microsoft TargetCpa and a MaxCpc amount are bids', () => {
  withPolicy({enforcement: 'block', max_bid_native: 5}, s => {
    const scheme = body =>
      plan('microsoft_ads_native_action', {
        action: 'microsoft_ads_update_campaigns',
        body: {Campaigns: [{Id: 1, BiddingScheme: {Type: 'TargetCpa', ...body}}]},
      });
    for (const body of [{TargetCpa: 9}, {MaxCpc: {Amount: 9}}])
      assert.throws(
        () => checkSpendPolicy(s, actor, scheme(body), []),
        {code: 'POLICY_BID_LIMIT'},
        JSON.stringify(body),
      );
    for (const body of [{TargetCpa: 4}, {MaxCpc: {Amount: 4}}])
      assert.equal(checkSpendPolicy(s, actor, scheme(body), []).exceeded, undefined, JSON.stringify(body));
  });
});

// The owner's decision of 2026-11-25 ("allow it, since a cut can never increase spend"): a genuine decrease is always allowed, for every money field,
// even when the new amount is still above the cap. A decrease is the same object, field, kind of budget and currency, strictly lower than the value the
// review read; it excuses nothing else in the write. F7: a finite amount under an unlimited or infinite prior is a decrease.
const dollars = (amount, currencyCode = 'USD') => ({amount: String(amount), currencyCode});
const linkedinEdit = (set, extra = {}) =>
  plan('linkedin_native_action', {
    path: '/rest/adAccounts/123/adCampaigns/111',
    headers: {'X-RestLi-Method': 'PARTIAL_UPDATE'},
    body: {patch: {$set: set}},
    ...extra,
  });
const campaignState = fields => [{id: 111, ...fields}];
const googleBudgets = (field, ...updates) =>
  plan('google_ads_native_action', {
    action: 'google_ads_v23_campaign_budget_mutate_campaign_budgets',
    path: '/v23/customers/123/campaignBudgets:mutate',
    body: {
      operations: updates.map(([id, micros]) => ({
        update: {resourceName: 'customers/123/campaignBudgets/' + id, [field]: String(micros)},
        updateMask: field,
      })),
    },
  });
const googleBudgetState = (field, ...rows) => [
  {
    results: rows.map(([id, micros]) => ({
      campaignBudget: {resourceName: 'customers/123/campaignBudgets/' + id, [field]: String(micros)},
    })),
  },
];
const tiktokAdGroup = body =>
  plan('tiktok_native_action', {
    action: 'tiktok_adgroup_update',
    path: '/open_api/v1.3/adgroup/update/',
    body: {advertiser_id: '123', adgroup_id: 'a1', ...body},
  });
const tiktokState = (...rows) => [{data: {list: rows.map(r => ({adgroup_id: 'a1', ...r}))}}];

const cuts = [
  [
    'a LinkedIn daily budget 200 to 150 under a ceiling of 100',
    {max_budget_native: 100},
    linkedinEdit({dailyBudget: dollars(150)}),
    campaignState({dailyBudget: dollars(200)}),
  ],
  [
    'a LinkedIn total 5,000 to 4,000 under a total cap of 3,000',
    {max_total_budget_native: 3000},
    linkedinEdit({totalBudget: dollars(4000)}),
    campaignState({totalBudget: dollars(5000)}),
  ],
  [
    'a LinkedIn bid 10 to 8 under a bid cap of 5',
    {max_bid_native: 5},
    linkedinEdit({unitCost: dollars(8)}),
    campaignState({unitCost: dollars(10)}),
  ],
  [
    'a Google Ads ad group CPC bid 9M to 8M under a bid cap of 5M',
    {max_bid_native: 5000000},
    plan('google_ads_native_action', {
      action: 'google_ads_v23_campaign_mutate_campaigns',
      path: '/v25/customers/123/adGroups:mutate',
      body: {
        operations: [
          {update: {resourceName: 'customers/123/adGroups/1', cpcBidMicros: '8000000'}, updateMask: 'cpc_bid_micros'},
        ],
      },
    }),
    [{results: [{adGroup: {resourceName: 'customers/123/adGroups/1', cpcBidMicros: '9000000'}}]}],
  ],
  [
    'a Google Ads budget 300M to 250M under a ceiling of 200M',
    {max_budget_native: 200000000},
    googleBudgets('amountMicros', [1, 250000000]),
    googleBudgetState('amountMicros', [1, 300000000]),
  ],
  [
    'a DV360 daily limit 900M to 500M under a ceiling of 200M',
    {max_budget_native: 200000000},
    dv360('lineItems', 'pacing', {pacing: dailyPacing(500000000)}),
    [{pacing: dailyPacing(900000000)}],
  ],
  [
    'a Meta daily budget 10,000 to 6,250 under a ceiling of 6,000',
    {max_budget_native: 6000},
    plan('meta_native_action', {path: '/v25.0/9001', body: {daily_budget: 6250}}),
    [{daily_budget: '10000'}],
  ],
  [
    'a TikTok ad group budget 100 to 90 under a ceiling of 80',
    {max_budget_native: 80},
    tiktokAdGroup({budget: 90}),
    tiktokState({budget_mode: 'BUDGET_MODE_DAY', budget: 100}),
  ],
];
for (const [label, caps, p, state] of cuts)
  test('owner decision 2026-11-25: ' + label + ' is a decrease, allowed above the cap and reserving nothing', () => {
    for (const enforcement of ['block', 'confirm'])
      withPolicy({enforcement, max_budget_increase_percent: 10, max_daily_increase_native: 10, ...caps}, s => {
        const result = checkSpendPolicy(s, actor, p, state);
        assert.equal(result.exceeded, undefined, enforcement);
        assert.equal(result.requested_increase_decimal, '0', enforcement);
      });
  });

// The lead's ruling under the owner's rule that only an increase is judged (second review N2): an amount at most the value read passes above the cap, a
// restated one included (it was refused until then); a raise is refused. A restated total always passed.
test('owner decision 2026-11-25: an amount not raised is allowed above the cap, restated or lowered; a raise above the ceiling is refused', () => {
  withPolicy({enforcement: 'block', max_budget_native: 100, max_total_budget_native: 3000}, s => {
    const state = campaignState({dailyBudget: dollars(200), totalBudget: dollars(5000)});
    for (const amount of [199, 200])
      assert.equal(
        checkSpendPolicy(s, actor, linkedinEdit({dailyBudget: dollars(amount)}), state).exceeded,
        undefined,
        String(amount),
      );
    assert.throws(() => checkSpendPolicy(s, actor, linkedinEdit({dailyBudget: dollars(210)}), state), {
      code: 'POLICY_BUDGET_LIMIT',
    });
    assert.equal(checkSpendPolicy(s, actor, linkedinEdit({totalBudget: dollars(5000)}), state).exceeded, undefined);
  });
});
test('owner decision 2026-11-25: the same field, kind and currency: a daily cut does not borrow a total, another currency is no cut, an unreadable prior is no cut', () => {
  withPolicy({enforcement: 'block', max_budget_native: 80}, s => {
    // No daily budget was read for this object, only a total of 5,000: the daily 90 has no before-state.
    assert.throws(
      () =>
        checkSpendPolicy(
          s,
          actor,
          linkedinEdit({dailyBudget: dollars(90)}),
          campaignState({totalBudget: dollars(5000)}),
        ),
      {
        code: 'POLICY_BUDGET_LIMIT',
      },
    );
    const held = campaignState({dailyBudget: dollars(200)});
    assert.equal(checkSpendPolicy(s, actor, linkedinEdit({dailyBudget: dollars(90)}), held).exceeded, undefined);
    assert.throws(() => checkSpendPolicy(s, actor, linkedinEdit({dailyBudget: dollars(90, 'EUR')}), held), {
      code: 'POLICY_BUDGET_LIMIT',
    });
    // A prior the policy cannot read is no value to be below.
    assert.throws(
      () =>
        checkSpendPolicy(
          s,
          actor,
          linkedinEdit({dailyBudget: dollars(90)}),
          campaignState({dailyBudget: dollars('about 200')}),
        ),
      {code: 'POLICY_BUDGET_LIMIT'},
    );
    assert.throws(() => checkSpendPolicy(s, actor, linkedinEdit({dailyBudget: dollars(90)}), []), {
      code: 'POLICY_BUDGET_LIMIT',
    });
  });
});
test('owner decision 2026-11-25: a cut excuses nothing else in the write: an increase beside it is refused, and only increases are counted', () => {
  const both = (a, b) => googleBudgets('amountMicros', [1, a], [2, b]);
  withPolicy({enforcement: 'confirm', max_budget_native: 150000000}, s => {
    // Budget 1 is cut from 300M to 280M, still above the ceiling; budget 2 is raised from 50M to 200M, above it.
    const result = checkSpendPolicy(
      s,
      actor,
      both(280000000, 200000000),
      googleBudgetState('amountMicros', [1, 300000000], [2, 50000000]),
    );
    assert.deepEqual(fieldsOf(result), ['/budget/body/operations/1/update/amount_micros']);
  });
  withPolicy({enforcement: 'block', max_daily_increase_native: 50000000}, s => {
    // A cut of 10M does not offset a raise of 60M: the day is asked for 60M, over the 50M cap.
    assert.throws(
      () =>
        checkSpendPolicy(
          s,
          actor,
          both(90000000, 110000000),
          googleBudgetState('amountMicros', [1, 100000000], [2, 50000000]),
        ),
      e => e.code === 'POLICY_DAILY_INCREASE_LIMIT' && e.details.requested_increase_decimal === '60000000',
    );
  });
  // An object the write adds is judged on its own, beside a cut.
  withPolicy({enforcement: 'confirm', max_budget_native: 100}, s => {
    const batch = linkedinEdit(undefined, {
      headers: {'X-RestLi-Method': 'BATCH_PARTIAL_UPDATE'},
      path: '/rest/adAccounts/123/adCampaigns',
      body: {
        entities: {
          111: {patch: {$set: {dailyBudget: dollars(150)}}},
          112: {patch: {$set: {dailyBudget: dollars(150)}}},
        },
      },
    });
    const result = checkSpendPolicy(s, actor, batch, [{id: 111, dailyBudget: dollars(200)}, {id: 112}]);
    assert.ok(fieldsOf(result).includes('/body/entities/112/patch/$set/daily_budget/amount'), String(fieldsOf(result)));
  });
});
test('owner decision 2026-11-25: a change of type or mode is no decrease: a cut under another budget mode is refused', () => {
  withPolicy({enforcement: 'block', max_budget_native: 80}, s => {
    const held = tiktokState({budget_mode: 'BUDGET_MODE_DAY', budget: 100});
    assert.equal(
      checkSpendPolicy(s, actor, tiktokAdGroup({budget_mode: 'BUDGET_MODE_DAY', budget: 90}), held).exceeded,
      undefined,
    );
    assert.throws(
      () => checkSpendPolicy(s, actor, tiktokAdGroup({budget_mode: 'BUDGET_MODE_TOTAL', budget: 90}), held),
      {
        code: 'POLICY_BUDGET_LIMIT',
      },
    );
  });
  withPolicy({enforcement: 'block', max_bid_native: 5}, s => {
    const held = campaignState({unitCost: dollars(10), costType: 'CPM'});
    assert.equal(
      checkSpendPolicy(s, actor, linkedinEdit({unitCost: dollars(8), costType: 'CPM'}), held).exceeded,
      undefined,
    );
    assert.throws(() => checkSpendPolicy(s, actor, linkedinEdit({unitCost: dollars(8), costType: 'CPC'}), held), {
      code: 'POLICY_BID_LIMIT',
    });
  });
});
test('F7: a finite amount under an unlimited or infinite prior is a decrease, allowed above the cap and needing no baseline', () => {
  withPolicy(
    {
      enforcement: 'block',
      max_budget_native: 200000000,
      max_budget_increase_percent: 10,
      max_daily_increase_native: 10000000,
    },
    s => {
      const unlimited = [{budget: {budgetAllocationType: 'LINE_ITEM_BUDGET_ALLOCATION_TYPE_UNLIMITED'}}];
      for (const max of [100000000, 500000000]) {
        const result = checkSpendPolicy(s, actor, dv360('lineItems', 'budget', {budget: fixedBudget(max)}), unlimited);
        assert.equal(result.exceeded, undefined, String(max));
        assert.equal(result.requested_increase_decimal, '0', String(max));
      }
    },
  );
  withPolicy({enforcement: 'block', max_budget_native: 80, max_budget_increase_percent: 10}, s => {
    const infinite = tiktokState({budget_mode: 'BUDGET_MODE_INFINITE'});
    assert.equal(
      checkSpendPolicy(s, actor, tiktokAdGroup({budget_mode: 'BUDGET_MODE_DAY', budget: 500}), infinite)
        .requested_increase_decimal,
      '0',
    );
    // Kept: unlimited to unlimited changes nothing, and a finite amount that was never unlimited is judged as before.
    assert.equal(
      checkSpendPolicy(s, actor, tiktokAdGroup({budget_mode: 'BUDGET_MODE_INFINITE'}), infinite).exceeded,
      undefined,
    );
    assert.throws(
      () =>
        checkSpendPolicy(
          s,
          actor,
          tiktokAdGroup({budget: 500}),
          tiktokState({budget_mode: 'BUDGET_MODE_DAY', budget: 100}),
        ),
      {
        code: 'POLICY_BUDGET_LIMIT',
      },
    );
  });
});

// N1 (second review): a change of budget mode or type is judged on its own under a percentage and a daily cap too: the amount of one mode is no
// baseline for the other (a TikTok total of 3,000 become a daily budget of 2,900 read as an increase of 0).
test('N1: a change of budget mode has no baseline under a percentage and a daily cap (TikTok total 3,000 to daily 2,900)', () => {
  const held = tiktokState({budget_mode: 'BUDGET_MODE_TOTAL', budget: 3000}),
    toDaily = tiktokAdGroup({budget_mode: 'BUDGET_MODE_DAY', budget: 2900});
  withPolicy({enforcement: 'block', max_budget_increase_percent: 10, max_daily_increase_native: 100}, s => {
    assert.throws(() => checkSpendPolicy(s, actor, toDaily, held), {code: 'POLICY_BASELINE_REQUIRED'});
    // Kept: the same mode lowered is no increase, and an unlimited prior needs no baseline (F7).
    assert.equal(
      checkSpendPolicy(s, actor, tiktokAdGroup({budget_mode: 'BUDGET_MODE_TOTAL', budget: 2900}), held)
        .requested_increase_decimal,
      '0',
    );
    assert.equal(
      checkSpendPolicy(s, actor, toDaily, tiktokState({budget_mode: 'BUDGET_MODE_INFINITE'}))
        .requested_increase_decimal,
      '0',
    );
  });
  withPolicy({enforcement: 'confirm', max_budget_increase_percent: 10, max_daily_increase_native: 100}, s => {
    const result = checkSpendPolicy(s, actor, toDaily, held);
    assert.deepEqual(rules(result), ['POLICY_BASELINE_REQUIRED', 'POLICY_DAILY_INCREASE_LIMIT']);
    assert.equal(result.requested_increase_decimal, '2900');
  });
});

// N6 (second review): a bid written in any form that is not a plain decimal (0x1F4, Infinity, 1,000, a padded string) is refused, not ignored.
test('N6: a bid that is no plain decimal (0x1F4, Infinity, 1,000, 5e2, 500., a padded one) is refused', () => {
  withPolicy({enforcement: 'block', max_bid_native: 5}, s => {
    for (const amount of ['0x1F4', 'Infinity', '1,000', '5e2', '500.', ' 5', '5 ', '-5'])
      assert.throws(
        () => checkSpendPolicy(s, actor, linkedinEdit({unitCost: dollars(amount)}), []),
        {code: 'POLICY_AMOUNT_INVALID'},
        JSON.stringify(amount),
      );
  });
  withPolicy({enforcement: 'block', max_bid_native: 5000000}, s => {
    const adGroup = bid =>
      plan('google_ads_native_action', {
        action: 'google_ads_v23_campaign_mutate_campaigns',
        path: '/v25/customers/123/adGroups:mutate',
        body: {
          operations: [
            {update: {resourceName: 'customers/123/adGroups/1', cpcBidMicros: bid}, updateMask: 'cpc_bid_micros'},
          ],
        },
      });
    for (const bid of ['Infinity', '0x1F4'])
      assert.throws(() => checkSpendPolicy(s, actor, adGroup(bid), []), {code: 'POLICY_AMOUNT_INVALID'}, bid);
    assert.equal(checkSpendPolicy(s, actor, adGroup('4000000'), []).exceeded, undefined);
  });
});

// N4 (second review): a decrease needs the currency of the amount and of the one the review read to be known and equal where a money object states
// one: a held amount that states none is no decrease (it may be in another currency). A patch of the amount alone keeps the object's currency.
test('N4: a money object amount is a decrease only when both currencies are known and equal', () => {
  withPolicy({enforcement: 'block', max_budget_native: 80}, s => {
    const cut = linkedinEdit({dailyBudget: dollars(90)});
    assert.throws(() => checkSpendPolicy(s, actor, cut, campaignState({dailyBudget: {amount: '200'}})), {
      code: 'POLICY_BUDGET_LIMIT',
    });
    assert.throws(() => checkSpendPolicy(s, actor, cut, campaignState({dailyBudget: dollars(200, 'EUR')})), {
      code: 'POLICY_BUDGET_LIMIT',
    });
    assert.equal(checkSpendPolicy(s, actor, cut, campaignState({dailyBudget: dollars(200)})).exceeded, undefined);
    // Kept: the amount patched alone keeps the object's own currency, and a field with no currency at all (Meta, Google) has none to compare.
    const nested = plan('linkedin_native_action', {
      path: '/rest/adAccounts/123/adCampaigns/111',
      headers: {'X-RestLi-Method': 'PARTIAL_UPDATE'},
      body: {patch: {dailyBudget: {$set: {amount: '90'}}}},
    });
    assert.equal(checkSpendPolicy(s, actor, nested, campaignState({dailyBudget: dollars(200)})).exceeded, undefined);
    assert.equal(
      checkSpendPolicy(s, actor, plan('meta_native_action', {path: '/v25.0/9001', body: {daily_budget: 60}}), [
        {daily_budget: '100'},
      ]).exceeded,
      undefined,
    );
  });
  // A bid too.
  withPolicy({enforcement: 'block', max_bid_native: 5}, s => {
    const bid = linkedinEdit({unitCost: dollars(8)});
    assert.throws(() => checkSpendPolicy(s, actor, bid, campaignState({unitCost: {amount: '10'}})), {
      code: 'POLICY_BID_LIMIT',
    });
    assert.equal(checkSpendPolicy(s, actor, bid, campaignState({unitCost: dollars(10)})).exceeded, undefined);
  });
});

// N2 (the lead's ruling under the owner's rule that only an increase is judged): an amount restated unchanged above the cap is not an increase, so it
// refuses nothing. A Snapchat campaign PUT that pauses, or lowers the lifetime cap, while restating a daily budget above the cap passes; a raise of it does not.
const snapRow = fields => ({
  id: 'c1',
  name: 'A',
  status: 'ACTIVE',
  daily_budget_micro: 200000000,
  lifetime_spend_cap_micro: 500000000,
  ...fields,
});
const snapPut = row =>
  plan('snapchat_native_action', {
    action: 'snapchat_adaccounts_ad_account_id_campaigns_update',
    method: 'PUT',
    path: '/v1/adaccounts/123/campaigns',
    body: {campaigns: [row]},
  });
const snapHeld = [{campaigns: [{campaign: {ad_account_id: '123', ...snapRow({})}}]}];
test('N2: a Snapchat campaign PUT that pauses or lowers the lifetime cap passes while it restates a daily budget above the cap', () => {
  withPolicy(
    {
      enforcement: 'block',
      max_budget_native: 100000000,
      max_total_budget_native: 400000000,
      max_budget_increase_percent: 10,
    },
    s => {
      for (const fields of [{status: 'PAUSED'}, {lifetime_spend_cap_micro: 450000000}])
        assert.equal(
          checkSpendPolicy(s, actor, snapPut(snapRow(fields)), snapHeld).requested_increase_decimal,
          '0',
          JSON.stringify(fields),
        );
      assert.throws(() => checkSpendPolicy(s, actor, snapPut(snapRow({daily_budget_micro: 210000000})), snapHeld), {
        code: 'POLICY_BUDGET_LIMIT',
      });
      // A campaign the review did not read has no before-state to restate.
      assert.throws(() => checkSpendPolicy(s, actor, snapPut(snapRow({})), []), {code: 'POLICY_BUDGET_LIMIT'});
    },
  );
});
test('N2: a daily budget, a total and a bid restated unchanged above their caps refuse nothing; a raise, a new record and another mode do', () => {
  withPolicy({enforcement: 'block', max_budget_native: 100, max_total_budget_native: 3000, max_bid_native: 5}, s => {
    const same = linkedinEdit({dailyBudget: dollars(200), totalBudget: dollars(5000), unitCost: dollars(10)}),
      held = campaignState({dailyBudget: dollars(200), totalBudget: dollars(5000), unitCost: dollars(10)});
    assert.equal(checkSpendPolicy(s, actor, same, held).exceeded, undefined);
    assert.throws(() => checkSpendPolicy(s, actor, linkedinEdit({dailyBudget: dollars(210)}), held), {
      code: 'POLICY_BUDGET_LIMIT',
    });
    assert.throws(() => checkSpendPolicy(s, actor, linkedinEdit({unitCost: dollars(11)}), held), {
      code: 'POLICY_BID_LIMIT',
    });
    assert.throws(() => checkSpendPolicy(s, actor, same, campaignState({})), {code: 'POLICY_BUDGET_LIMIT'});
  });
  withPolicy({enforcement: 'block', max_budget_native: 80}, s => {
    const held = tiktokState({budget_mode: 'BUDGET_MODE_DAY', budget: 100});
    assert.equal(
      checkSpendPolicy(s, actor, tiktokAdGroup({budget_mode: 'BUDGET_MODE_DAY', budget: 100}), held).exceeded,
      undefined,
    );
    assert.throws(
      () => checkSpendPolicy(s, actor, tiktokAdGroup({budget_mode: 'BUDGET_MODE_TOTAL', budget: 100}), held),
      {
        code: 'POLICY_BUDGET_LIMIT',
      },
    );
  });
});

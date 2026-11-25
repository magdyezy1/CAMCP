import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {Compiler} from '../dist/src/compiler.js';
import {applyExecutionRisk} from '../dist/src/execution-risk.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {saveSpendPolicy, checkSpendPolicy, exceededCaps} from '../dist/src/spend-policy.js';

/*
 * r25-mf-caps (the audit of f6f5490d, 2026-11-25): Display & Video 360 money passed the owner policy unchecked. A daily
 * limit (pacing.dailyMaxMicros) raised 9,000 times, a line item budget set to unlimited
 * (LINE_ITEM_BUDGET_ALLOCATION_TYPE_UNLIMITED), and a budget or daily limit removed by an update mask were never compared;
 * a line item's budget.maxAmount was refused as an unmapped field even when it was a decrease, and every create was
 * refused for a missing baseline under a percentage or daily cap (its action is spelled in capitals). The last test walks
 * the pinned v4 Discovery document so that no writable money field can be added without a decision.
 */
const key = Buffer.alloc(32, 85).toString('base64'),
  actor = {tenantId: 'dv360-money', userId: 'owner', role: 'admin'};
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
  gateway: 'dv360_native_action',
  accountId: '123',
  headers: {},
  readOnly: false,
  destructive: false,
  requiresConfirmation: true,
  evidence: 'synthetic dv360 money',
  warnings: [],
};
const patch = (kind, updateMask, body) => ({
  ...base,
  action:
    'DV360_ADVERTISERS_' +
    {lineItems: 'LINE_ITEMS', insertionOrders: 'INSERTION_ORDERS', campaigns: 'CAMPAIGNS'}[kind] +
    '_PATCH',
  method: 'PATCH',
  path: '/v4/advertisers/123/' + kind + '/456',
  query: {updateMask},
  body,
});
const create = (kind, body) => ({
  ...base,
  action:
    'DV360_ADVERTISERS_' +
    {lineItems: 'LINE_ITEMS', insertionOrders: 'INSERTION_ORDERS', campaigns: 'CAMPAIGNS'}[kind] +
    '_CREATE',
  method: 'POST',
  path: '/v4/advertisers/123/' + kind,
  query: {},
  body,
});
const fixed = max => ({budgetAllocationType: 'LINE_ITEM_BUDGET_ALLOCATION_TYPE_FIXED', maxAmount: String(max)});
const daily = max => ({
  pacingPeriod: 'PACING_PERIOD_DAILY',
  pacingType: 'PACING_TYPE_ASAP',
  dailyMaxMicros: String(max),
});
const unlimited = {budgetAllocationType: 'LINE_ITEM_BUDGET_ALLOCATION_TYPE_UNLIMITED'};
const flight = {pacingPeriod: 'PACING_PERIOD_FLIGHT', pacingType: 'PACING_TYPE_EVEN'};
const rules = result =>
  exceededCaps(result)
    .map(x => x.rule)
    .sort();
const all = {
  enforcement: 'block',
  max_budget_native: 200000000,
  max_budget_increase_percent: 10,
  max_daily_increase_native: 10000000,
  max_bid_native: 5000000,
};

test('the compiled DV360 plans carry the action, route and mask these tests build by hand', () => {
  const compiler = new Compiler(new Registry()),
    compile = args =>
      applyExecutionRisk(
        compiler.compile('dv360_native_action', {...args, dry_run: true}, {mode: 'strict', flags: {}}),
      );
  const patched = compile({
    action: 'DV360_ADVERTISERS_LINE_ITEMS_PATCH',
    params: {advertiserId: '123', lineItemId: '456', updateMask: 'pacing'},
    body: {pacing: daily(1)},
  });
  const built = patch('lineItems', 'pacing', {pacing: daily(1)});
  for (const field of ['gateway', 'action', 'method', 'path', 'query', 'body', 'accountId'])
    assert.deepEqual(patched[field], built[field], field);
  const created = compile({
    action: 'DV360_ADVERTISERS_LINE_ITEMS_CREATE',
    params: {advertiserId: '123'},
    body: {displayName: 'x', entityStatus: 'ENTITY_STATUS_DRAFT'},
  });
  const made = create('lineItems', {displayName: 'x', entityStatus: 'ENTITY_STATUS_DRAFT'});
  for (const field of ['gateway', 'action', 'method', 'path', 'query', 'body', 'accountId'])
    assert.deepEqual(created[field], made[field], field);
});

test('a daily limit raised 9,000 times is above the budget cap, and a raise is held to the percentage and daily caps', () => {
  const state = [{pacing: daily(100000000)}],
    pacing = max => patch('insertionOrders', 'pacing', {pacing: daily(max)});
  withPolicy(all, s => {
    assert.throws(
      () => checkSpendPolicy(s, actor, pacing(900000000000), state),
      e => {
        assert.equal(e.code, 'POLICY_BUDGET_LIMIT');
        assert.equal(e.details.field, '/body/pacing/daily_max_micros');
        return true;
      },
    );
    assert.equal(checkSpendPolicy(s, actor, pacing(110000000), state).requested_increase_decimal, '10000000');
    assert.throws(() => checkSpendPolicy(s, actor, pacing(111000000), state), {code: 'POLICY_INCREASE_LIMIT'});
  });
  // Lowering it, or restating it, passes whatever the ceiling: here the limit is above the ceiling already.
  withPolicy(all, s => {
    const high = [{pacing: daily(900000000)}];
    for (const max of [500000000, 900000000])
      assert.equal(checkSpendPolicy(s, actor, pacing(max), high).requested_increase_decimal, '0');
    assert.throws(() => checkSpendPolicy(s, actor, pacing(950000000), high), {code: 'POLICY_BUDGET_LIMIT'});
  });
});

test('a line item budget amount is a total: held to the total cap, lowered always, and no longer unmapped', () => {
  const state = [{budget: fixed(100000000), pacing: daily(1000000)}],
    budget = max => patch('lineItems', 'budget.maxAmount', {budget: {maxAmount: String(max)}});
  withPolicy({enforcement: 'block', max_budget_native: 200000000, max_total_budget_native: 2000000000}, s => {
    assert.equal(checkSpendPolicy(s, actor, budget(1500000000), state).exceeded, undefined);
    assert.throws(
      () => checkSpendPolicy(s, actor, budget(900000000000), state),
      e => {
        assert.equal(e.code, 'POLICY_BUDGET_LIMIT');
        assert.equal(e.details.limit_key, 'max_total_budget_native');
        assert.equal(e.details.amount_kind, 'lifetime_or_total');
        return true;
      },
    );
    // Down from a total above the cap, and restated unchanged, are decreases.
    const high = [{budget: fixed(5000000000)}];
    for (const max of [3000000000, 5000000000])
      assert.equal(checkSpendPolicy(s, actor, budget(max), high).exceeded, undefined);
    assert.throws(() => checkSpendPolicy(s, actor, budget(5000000001), high), {code: 'POLICY_BUDGET_LIMIT'});
  });
});

test('a budget set to unlimited is above every cap the owner set, and nothing finite is reserved', () => {
  const state = [{budget: fixed(100000000)}],
    set = patch('lineItems', 'budget.budgetAllocationType', {budget: unlimited});
  withPolicy(all, s =>
    assert.throws(
      () => checkSpendPolicy(s, actor, set, state),
      e => {
        assert.equal(e.code, 'POLICY_BUDGET_LIMIT');
        assert.equal(e.details.requested_decimal, 'unlimited');
        assert.equal(e.details.field, '/body/budget/budget_allocation_type');
        return true;
      },
    ),
  );
  // Under confirm each cap that is set is a finding, and the sentence the user reads says unlimited.
  withPolicy({...all, enforcement: 'confirm'}, s => {
    const result = checkSpendPolicy(s, actor, set, state);
    assert.deepEqual(rules(result), ['POLICY_BUDGET_LIMIT', 'POLICY_DAILY_INCREASE_LIMIT', 'POLICY_INCREASE_LIMIT']);
    assert.match(result.exceeded_summary, /unlimited is above the cap of 200000000/);
    assert.match(result.exceeded_summary, /to unlimited is more than the 10% increase cap/);
    assert.match(result.exceeded_summary, /reach unlimited, above the daily cap of 10000000/);
    assert.throws(() => checkSpendPolicy(s, actor, set, state, 'review-1'), {code: 'CAP_CONFIRMATION_REQUIRED'});
    const confirmed = checkSpendPolicy(s, actor, set, state, 'review-1', true);
    assert.equal(confirmed.requested_increase_decimal, '0');
    assert.equal(s.document(actor.tenantId, 'spend_reservation', 'review-1').increase_decimal, '0');
  });
  // Only the caps that are set are exceeded: one cap, one finding; no budget cap, nothing to exceed.
  for (const [policy, expected] of [
    [{max_budget_increase_percent: 10}, ['POLICY_INCREASE_LIMIT']],
    [{max_daily_increase_native: 10000000}, ['POLICY_DAILY_INCREASE_LIMIT']],
    [{max_budget_native: 200000000}, ['POLICY_BUDGET_LIMIT']],
    [{max_total_budget_native: 2000000000}, ['POLICY_BUDGET_LIMIT']],
    [{max_bid_native: 5000000}, []],
    [{allow_activation: false}, []],
  ])
    withPolicy({enforcement: 'confirm', ...policy}, s =>
      assert.deepEqual(rules(checkSpendPolicy(s, actor, set, state)), expected, JSON.stringify(policy)),
    );
  withPolicy({enforcement: 'confirm', max_total_budget_native: 2000000000}, s =>
    assert.equal(exceededCaps(checkSpendPolicy(s, actor, set, state))[0].limit_key, 'max_total_budget_native'),
  );
});

test('a line item created with an unlimited budget meets the ceilings, and a finite or automatic one does not', () => {
  const li = budget => create('lineItems', {displayName: 'x', entityStatus: 'ENTITY_STATUS_DRAFT', budget});
  withPolicy({...all, enforcement: 'confirm'}, s => {
    // A create has no current budget to rise from, so no percentage finding.
    assert.deepEqual(rules(checkSpendPolicy(s, actor, li(unlimited), [])), [
      'POLICY_BUDGET_LIMIT',
      'POLICY_DAILY_INCREASE_LIMIT',
    ]);
    assert.equal(checkSpendPolicy(s, actor, li(fixed(5000000)), []).exceeded, undefined);
    assert.equal(
      checkSpendPolicy(s, actor, li({budgetAllocationType: 'LINE_ITEM_BUDGET_ALLOCATION_TYPE_AUTOMATIC'}), []).exceeded,
      undefined,
    );
  });
});

test('moving a line item from a daily limit to the whole flight lifts the limit; where none was set it lifts nothing', () => {
  const set = patch('insertionOrders', 'pacing', {pacing: flight});
  withPolicy({...all, enforcement: 'confirm'}, s => {
    assert.deepEqual(rules(checkSpendPolicy(s, actor, set, [{pacing: daily(100000000)}])), [
      'POLICY_BUDGET_LIMIT',
      'POLICY_DAILY_INCREASE_LIMIT',
      'POLICY_INCREASE_LIMIT',
    ]);
    // Already paced over the flight, a limit that was never set, and a create: nothing is lifted.
    assert.equal(checkSpendPolicy(s, actor, set, [{pacing: flight}]).exceeded, undefined);
    assert.equal(
      checkSpendPolicy(s, actor, create('insertionOrders', {displayName: 'x', pacing: flight}), []).exceeded,
      undefined,
    );
  });
  // Moving it the other way sets a daily limit: compared like any other, with no earlier limit to be a decrease from.
  const limit = max => patch('insertionOrders', 'pacing', {pacing: daily(max)});
  withPolicy(all, s => {
    assert.throws(() => checkSpendPolicy(s, actor, limit(900000000000), [{pacing: flight}]), {
      code: 'POLICY_BUDGET_LIMIT',
    });
    assert.throws(() => checkSpendPolicy(s, actor, limit(100000000), [{pacing: flight}]), {
      code: 'POLICY_BASELINE_REQUIRED',
    });
  });
});

test('a budget or daily limit removed by an update mask, or emptied, is a cleared cap', () => {
  withPolicy(all, s => {
    for (const [label, plan, field] of [
      ['daily limit by mask', patch('lineItems', 'pacing.dailyMaxMicros', {}), '/body/pacing/daily_max_micros'],
      ['line item budget amount by mask', patch('lineItems', 'budget.maxAmount', {}), '/body/budget/max_amount'],
      [
        'campaign budgets by mask: the campaign is then unlimited',
        patch('campaigns', 'campaignBudgets', {}),
        '/body/campaign_budgets',
      ],
      [
        'campaign budgets emptied',
        patch('campaigns', 'campaignBudgets', {campaignBudgets: []}),
        '/body/campaign_budgets',
      ],
      [
        'daily limit set to null',
        patch('lineItems', 'pacing', {pacing: {...daily(1), dailyMaxMicros: null}}),
        '/body/pacing/daily_max_micros',
      ],
    ])
      assert.throws(
        () => checkSpendPolicy(s, actor, plan, []),
        e => e.code === 'POLICY_AMOUNT_UNSUPPORTED' && e.details.field === field,
        label,
      );
  });
});

test('a create under every cap is allowed, and over a cap is refused, whatever the percentage and daily caps', () => {
  withPolicy({enforcement: 'block', max_budget_native: 200000000, max_budget_increase_percent: 10}, s => {
    const lineItem = (max, dailyMax) =>
      create('lineItems', {
        displayName: 'x',
        entityStatus: 'ENTITY_STATUS_DRAFT',
        budget: fixed(max),
        pacing: daily(dailyMax),
      });
    assert.equal(checkSpendPolicy(s, actor, lineItem(100000000, 10000000), []).requested_increase_decimal, '110000000');
    assert.throws(() => checkSpendPolicy(s, actor, lineItem(900000000, 10000000), []), {code: 'POLICY_BUDGET_LIMIT'});
    assert.throws(() => checkSpendPolicy(s, actor, lineItem(100000000, 900000000), []), {code: 'POLICY_BUDGET_LIMIT'});
    const order = segment =>
      create('insertionOrders', {
        displayName: 'x',
        entityStatus: 'ENTITY_STATUS_DRAFT',
        budget: {budgetUnit: 'BUDGET_UNIT_CURRENCY', budgetSegments: [{budgetAmountMicros: String(segment)}]},
      });
    assert.equal(checkSpendPolicy(s, actor, order(100000000), []).requested_increase_decimal, '100000000');
    assert.throws(() => checkSpendPolicy(s, actor, order(900000000), []), {code: 'POLICY_BUDGET_LIMIT'});
  });
});

test('a Demand Gen bid value is a bid; a goal, a plan and a fee are reported by name; ratios and counts are not money', () => {
  withPolicy({...all, enforcement: 'confirm'}, s => {
    const bid = plan => rules(checkSpendPolicy(s, actor, plan, []));
    assert.deepEqual(
      bid(
        patch('lineItems', 'bidStrategy', {
          bidStrategy: {demandGenBid: {type: 'DEMAND_GEN_BID_TYPE_MANUAL', value: '900000000'}},
        }),
      ),
      ['POLICY_BID_LIMIT'],
    );
    assert.deepEqual(
      bid(patch('lineItems', 'bidStrategy', {bidStrategy: {fixedBid: {bidAmountMicros: '900000000'}}})),
      ['POLICY_BID_LIMIT'],
    );
    for (const [mask, body, field] of [
      [
        'bidStrategy',
        {bidStrategy: {performanceGoalAutoBid: {performanceGoalAmountMicros: '5'}}},
        'performance_goal_amount_micros',
      ],
      ['kpi', {kpi: {kpiAmountMicros: '5'}}, 'kpi_amount_micros'],
      ['partnerCosts', {partnerCosts: [{feeAmount: '5'}]}, 'fee_amount'],
      ['partnerRevenueModel', {partnerRevenueModel: {markupAmount: '5'}}, 'markup_amount'],
    ]) {
      const result = checkSpendPolicy(s, actor, patch('insertionOrders', mask, body), []);
      assert.deepEqual(rules(result), ['POLICY_AMOUNT_UNSUPPORTED'], field);
      assert.match(exceededCaps(result)[0].field, new RegExp('/' + field + '$'));
    }
    assert.deepEqual(bid(patch('campaigns', 'campaignFlight', {campaignFlight: {plannedSpendAmountMicros: '5'}})), [
      'POLICY_AMOUNT_UNSUPPORTED',
    ]);
    for (const [mask, body] of [
      ['partnerCosts', {partnerCosts: [{feePercentageMillis: '5000'}]}],
      ['kpi', {kpi: {kpiPercentageMicros: '5000000'}}],
      [
        'pacing',
        {
          pacing: {
            pacingPeriod: 'PACING_PERIOD_DAILY',
            pacingType: 'PACING_TYPE_EVEN',
            dailyMaxImpressions: '99999999999',
          },
        },
      ],
      ['frequencyCap', {frequencyCap: {maxImpressions: 5, timeUnit: 'TIME_UNIT_DAYS', timeUnitCount: 1}}],
      ['displayName', {displayName: 'Renamed'}],
      ['entityStatus', {entityStatus: 'ENTITY_STATUS_PAUSED'}],
    ])
      assert.deepEqual(bid(patch('insertionOrders', mask, body)), [], mask);
  });
});

// How the owner policy treats each writable integer leaf of the pinned v4 document (a leaf name means one thing in it). A field
// the document gains that is not listed here fails the walk below until someone decides: that is the guard against a silent pass.
const budgetLeaves = ['budgetAmountMicros', 'dailyMaxMicros', 'maxAmount'],
  bidLeaves = ['bidAmountMicros', 'maxAverageCpmBidAmountMicros', 'value'],
  namedLeaves = [
    'performanceGoalAmountMicros',
    'kpiAmountMicros',
    'plannedSpendAmountMicros',
    'feeAmount',
    'markupAmount',
  ],
  notMoney = {
    budgetId: 'an identifier',
    campaignBudgetId: 'an identifier',
    campaignId: 'an identifier',
    customBiddingAlgorithmId: 'an identifier',
    floodlightActivityId: 'an identifier',
    insertionOrderId: 'an identifier',
    kpiAlgorithmId: 'an identifier',
    lineItemId: 'an identifier',
    linkedMerchantId: 'an identifier',
    primaryAttributionModelId: 'an identifier',
    dailyMaxImpressions: 'an impression count',
    maxImpressions: 'an impression count',
    maxViews: 'a view count',
    timeUnitCount: 'a count of time units',
    day: 'a date part',
    month: 'a date part',
    year: 'a date part',
    postClickLookbackWindowDays: 'a number of days',
    postViewLookbackWindowDays: 'a number of days',
    feePercentageMillis: 'a percentage in millis',
    kpiPercentageMicros: 'a percentage in micros',
    performanceGoalPercentageMicros: 'a percentage in micros',
    postViewCountPercentageMillis: 'a percentage in millis',
  };
test('every writable integer field of the pinned DV360 v4 document is compared, reported by name, or not money', () => {
  const document = JSON.parse(fs.readFileSync('.mirror/VENDOR/dv360-v4.json', 'utf8')).document,
    schemas = document.schemas,
    outputOnly = p => p.readOnly === true || /^\s*Output only\./.test(p.description ?? ''),
    found = [];
  assert.ok(schemas.LineItem && schemas.InsertionOrder, 'the pinned document is the DV360 v4 Discovery document');
  const walk = (name, trail, owners, root) => {
    for (const [field, property] of Object.entries(schemas[name]?.properties ?? {})) {
      if (outputOnly(property)) continue;
      const ref = property.$ref ?? property.items?.$ref,
        step = {field, array: property.type === 'array'};
      if (ref) {
        if (!owners.includes(ref)) walk(ref, [...trail, step], [...owners, ref], root);
      } else if (
        (property.type === 'string' && property.format === 'int64') ||
        property.type === 'integer' ||
        property.type === 'number'
      )
        found.push({root, trail: [...trail, step]});
    }
  };
  for (const root of ['LineItem', 'InsertionOrder', 'Campaign', 'AdGroup']) walk(root, [], [root], root);
  assert.ok(found.length > 60, 'the walk reached the nested fields: ' + found.length);
  const leaves = [...new Set(found.map(f => f.trail.at(-1).field))],
    classified = [...budgetLeaves, ...bidLeaves, ...namedLeaves, ...Object.keys(notMoney)];
  assert.deepEqual(
    leaves.filter(leaf => !classified.includes(leaf)).sort(),
    [],
    'a writable integer field of the pinned document has no class: decide how the owner policy treats it',
  );
  assert.deepEqual(
    classified.filter(leaf => !leaves.includes(leaf)).sort(),
    [],
    'a classified field is not in the document',
  );
  // `value` is a bid only in a bidding strategy that names it (Demand Gen, YouTube & Partners): the policy reads it by that parent.
  for (const f of found.filter(f => f.trail.at(-1).field === 'value'))
    assert.ok(
      ['demandGenBid', 'youtubeAndPartnersBid'].includes(f.trail.at(-2).field),
      f.root + '.' + f.trail.map(t => t.field).join('.'),
    );

  const kind = {LineItem: 'lineItems', InsertionOrder: 'insertionOrders', Campaign: 'campaigns', AdGroup: 'lineItems'};
  // Each field set far beyond every cap: money is found, and what is not money is left alone.
  withPolicy({enforcement: 'confirm', max_budget_native: 100, max_bid_native: 100}, s => {
    for (const {root, trail} of found) {
      const leaf = trail.at(-1).field,
        where = root + '.' + trail.map(t => t.field).join('.');
      let record = {[leaf]: '900000000000000'};
      for (const step of trail.slice(0, -1).reverse()) record = {[step.field]: step.array ? [record] : record};
      const got = rules(checkSpendPolicy(s, actor, patch(kind[root], trail[0].field, record), []));
      if (budgetLeaves.includes(leaf)) assert.deepEqual(got, ['POLICY_BUDGET_LIMIT'], where);
      else if (bidLeaves.includes(leaf)) assert.deepEqual(got, ['POLICY_BID_LIMIT'], where);
      else if (namedLeaves.includes(leaf)) assert.deepEqual(got, ['POLICY_AMOUNT_UNSUPPORTED'], where);
      else assert.deepEqual(got, [], where + ' is ' + notMoney[leaf]);
    }
  });
});

// End to end: a line item edit through amcp_write prepare, so the state a review reads (a GET of the line item) is the shape the policy reads.
function reviewedLineItem(policy, held) {
  const store = new Store(':memory:', key),
    connection = {
      id: 'login',
      tenantId: actor.tenantId,
      gateway: 'dv360_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    };
  store.putConnection(actor, connection, {accessToken: 'fixture'});
  store.rememberResource(connection, '123', '456');
  saveSpendPolicy(store, actor, {scope: 'workspace', confirmed: true, policy});
  let writes = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (input, init) => {
      if (init.method !== 'GET') {
        writes++;
        return Response.json({lineItemId: '456'});
      }
      return Response.json(
        new URL(String(input)).pathname.endsWith('/123') ? {advertiserId: '123', displayName: 'Account'} : held,
      );
    }),
    undefined,
    {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
  );
  return {
    store,
    writes: () => writes,
    prepare: (updateMask, body) =>
      service.call(
        'amcp_write',
        {
          action: 'prepare',
          gateway: 'dv360_native_action',
          arguments: {
            action: 'DV360_ADVERTISERS_LINE_ITEMS_PATCH',
            params: {advertiserId: '123', lineItemId: '456', updateMask},
            body,
          },
        },
        actor,
      ),
  };
}
test('through amcp_write: a line item edit is judged against the state its review reads', async () => {
  const held = {
      lineItemId: '456',
      displayName: 'Line item',
      entityStatus: 'ENTITY_STATUS_PAUSED',
      budget: fixed(100000000),
      pacing: daily(10000000),
    },
    f = reviewedLineItem(
      {
        enforcement: 'block',
        max_budget_native: 200000000,
        max_budget_increase_percent: 10,
        max_daily_increase_native: 10000000,
      },
      held,
    );
  try {
    for (const [mask, body, code] of [
      ['pacing', {pacing: daily(90000000000)}, 'POLICY_BUDGET_LIMIT'],
      [
        'pacing',
        {pacing: {pacingPeriod: 'PACING_PERIOD_DAILY', pacingType: 'PACING_TYPE_EVEN'}},
        'POLICY_AMOUNT_UNSUPPORTED',
      ],
      ['pacing.dailyMaxMicros', {}, 'POLICY_AMOUNT_UNSUPPORTED'],
      ['budget', {budget: unlimited}, 'POLICY_BUDGET_LIMIT'],
    ])
      assertRefused(await f.prepare(mask, body), code, {writes: f.writes});
    // What it lowers, raises within every cap or leaves alone is prepared, with the increase it will reserve.
    for (const [mask, body, increase] of [
      ['pacing', {pacing: daily(5000000)}, '0'],
      ['budget.maxAmount', {budget: {maxAmount: '105000000'}}, '5000000'],
      ['displayName', {displayName: 'Renamed'}, '0'],
    ]) {
      const review = await f.prepare(mask, body);
      assert.equal(review.success, true, JSON.stringify(review));
      assert.equal(review.data.spend_policy.requested_increase_decimal, increase, mask);
    }
  } finally {
    f.store.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {
  currencyMinorDigits,
  currencyText,
  minimumUnitMicros,
  setMetaCurrencyOffsetsForTest,
} from '../dist/src/budget-units.js';
import {roundedDaily} from '../dist/src/allocation-plan.js';
import {recipeCurrencyMicros} from '../dist/src/recipe-values.js';
import {campaignRecipe} from '../dist/src/campaign-recipes.js';
import {checkSpendPolicy, policyWarnings, saveSpendPolicy} from '../dist/src/spend-policy.js';
import {googleTargetingWidens} from '../dist/src/google-targeting-writes.js';
import {reviewSummary} from '../dist/src/review-summary.js';
import {rememberAccountMetadata} from '../dist/src/account-metadata.js';
import {allocationReport} from './fixtures/allocation-data.mjs';
import {linkedinAllocationFixture} from './fixtures/linkedin-allocation-data.mjs';
import fs from 'node:fs';

/**
 * WRT-07: money checks that know the account currency. Before, allocation drafts divided period micros by days with no
 * minimum unit (Google refuses NON_MULTIPLE_OF_MINIMUM_CURRENCY_UNIT), recipes accepted six decimals in every currency,
 * a multi-budget edit lost its per-resource baselines (two cuts read as a 110,000,000-micro increase), caps compared a
 * KWD and a JPY account with the same number, and every Google targeting write asked for a spend acknowledgement.
 */
const key = Buffer.alloc(32, 77).toString('base64'),
  owner = {tenantId: 'currency-checks', userId: 'owner', role: 'admin'},
  actor = {...owner, userId: 'operator', role: 'operator'},
  google = 'google_ads_native_action',
  customer = '1234567890';
const micros = text => {
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
};

test('minimum currency units and equal daily rounding for USD, JPY, KWD and CLP', () => {
  assert.deepEqual(
    ['USD', 'JPY', 'KWD', 'CLP', 'BHD', 'EUR'].map(c => [currencyMinorDigits(c), minimumUnitMicros(c)]),
    [
      [2, 10000n],
      [0, 1000000n],
      [3, 1000n],
      [0, 1000000n],
      [3, 1000n],
      [2, 10000n],
    ],
  );
  assert.equal(minimumUnitMicros('usd'), undefined);
  assert.equal(minimumUnitMicros(undefined), undefined);
  // One third of a period total per day, rounded down to what the currency can be charged; the rest is the residual.
  for (const [currency, total, days, daily, residual] of [
    ['USD', '100', 3, '33.33', '0.01'],
    ['JPY', '1000', 3, '333', '1'],
    ['KWD', '10', 3, '3.333', '0.001'],
    ['CLP', '10000', 7, '1428', '4'],
  ]) {
    const unit = minimumUnitMicros(currency),
      d = roundedDaily(micros(total), days, unit);
    assert.equal(currencyText(d, currency), daily, currency);
    assert.equal(d % unit, 0n, currency);
    assert.equal(currencyText(micros(total) - d * BigInt(days), currency), residual, currency);
  }
  assert.equal(currencyText(500000000n, 'JPY'), '500');
  assert.equal(currencyText(500500000n, 'JPY'), '500.5');
  assert.equal(currencyText(1234500n, 'KWD'), '1.2345');
});

/** A Google allocation source in `currency`; the fixture answers budget reads only and refuses every mutation. */
function googleAllocation(currency) {
  const store = new Store(':memory:', key),
    identity = {tenantId: 'currency-allocation', userId: 'operator', role: 'operator'},
    session = store.authenticate(store.createKey(identity)),
    connection = {
      id: '11111111-1111-4111-8111-111111111111',
      tenantId: session.tenantId,
      gateway: google,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['https://www.googleapis.com/auth/adwords'],
    };
  store.putConnection({...session, role: 'admin'}, connection, {accessToken: 'synthetic', developerToken: 'synthetic'});
  const report = allocationReport();
  store.putDocument(session.tenantId, 'decision_report', 'source', {
    ...report,
    semantics: {...report.semantics, currency},
    gateway: google,
    preset: 'google_campaign',
    connection_id: connection.id,
    account_id: '123',
  });
  const account = {id: '123', currencyCode: currency, timeZone: 'UTC'},
    rows = ['10', '20'].map(id => ({
      customer: account,
      campaign: {
        id,
        resourceName: 'customers/123/campaigns/' + id,
        name: 'Campaign ' + id,
        status: 'ENABLED',
        campaignBudget: 'customers/123/campaignBudgets/1' + id,
      },
      campaignBudget: {
        resourceName: 'customers/123/campaignBudgets/1' + id,
        amountMicros: '7000000000',
        explicitlyShared: false,
        referenceCount: '1',
        period: 'DAILY',
        status: 'ENABLED',
      },
    }));
  let writes = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      if (String(url).endsWith('/googleAds:search')) {
        const q = JSON.parse(init.body).query;
        if (q.includes(' FROM campaign_budget'))
          return Response.json({
            results: rows
              .filter(r => q.includes(r.campaignBudget.resourceName))
              .map(r => ({campaignBudget: r.campaignBudget})),
          });
        if (q.includes(' FROM customer')) return Response.json({results: [{customer: account}]});
        const match = q.match(/campaign.id IN \(([^)]+)\)/);
        return Response.json({results: match ? rows.filter(r => match[1].split(',').includes(r.campaign.id)) : rows});
      }
      writes++;
      throw Error('Unexpected provider mutation');
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const preview = (budget, fixed) =>
    service.call(
      'amcp_reporting',
      {
        action: 'preview_allocation_plan',
        id: 'source',
        conversion: 'equal_daily',
        options: {
          budget,
          efficiency_low: 0.8,
          efficiency_high: 1.2,
          maximum_age_days: 7,
          minimum_conversions: 5,
          allocations: [
            {entity_id: '10', minimum: '25', maximum: '400'},
            {entity_id: '20', minimum: fixed, maximum: fixed},
          ],
        },
      },
      session,
    );
  return {store, preview, writes: () => writes};
}

test('allocation drafts round each daily budget down to the currency unit and recheck floors after rounding', async () => {
  // Campaign 20 is fixed at 100 for the two-day period; campaign 10 receives the rest, which does not divide evenly.
  for (const [currency, budget, daily, residual] of [
    ['USD', '301', '100.5', '0'],
    ['JPY', '301', '100', '1'],
    ['CLP', '301', '100', '1'],
    ['KWD', '300.003', '100.001', '0.001'],
  ]) {
    const f = googleAllocation(currency);
    try {
      const out = await f.preview(budget, '100');
      assert.equal(out.success, true, currency + ' ' + JSON.stringify(out.error));
      const [ten, twenty] = out.data.targets;
      assert.equal(ten.daily_budget, daily, currency);
      assert.equal(ten.rounding_residual, residual, currency);
      assert.equal(ten.minimum_unit_micros, String(minimumUnitMicros(currency)), currency);
      assert.equal(BigInt(ten.daily_budget_micros) % minimumUnitMicros(currency), 0n, currency);
      assert.equal(twenty.daily_budget, '50', currency);
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
  // A floor of 100.5 over two days is 50.25 a day: cents represent it, yen do not (50 JPY a day falls below it).
  for (const [currency, success] of [
    ['USD', true],
    ['JPY', false],
  ]) {
    const f = googleAllocation(currency);
    try {
      const out = await f.preview('201', '100.5');
      assert.equal(out.success, success, currency + ' ' + JSON.stringify(out.error ?? out.data?.targets));
      if (!success) assert.equal(out.error.code, 'ALLOCATION_PRECISION');
    } finally {
      f.store.close();
    }
  }
});

test('LinkedIn allocation drafts refuse a daily budget outside the limits LinkedIn states for the account', async t => {
  for (const [max, refused] of [
    ['50', true],
    ['100', false],
  ]) {
    const f = linkedinAllocationFixture(t);
    for (const c of f.campaigns.values())
      Object.assign(c, {
        costType: 'CPM',
        targetingCriteria: {include: {and: [{or: {'urn:li:adTargetingFacet:locations': ['urn:li:geo:103644278']}}]}},
      });
    const pricing = [];
    f.hook(u => {
      if (u.pathname !== '/rest/adBudgetPricing') return undefined;
      pricing.push(u.search);
      return Response.json({
        elements: [
          {
            dailyBudgetLimits: {
              min: {amount: '10', currencyCode: 'USD'},
              max: {amount: max, currencyCode: 'USD'},
              default: {amount: '25', currencyCode: 'USD'},
            },
          },
        ],
        paging: {start: 0, count: 10, links: []},
      });
    });
    assert.equal((await f.captureReport()).success, true);
    // The model gives 180 and 60 for two days: 90 and 30 a day.
    const out = await f.preview();
    assert.equal(pricing.length, 1, 'one pricing read per draft');
    assert.match(decodeURIComponent(pricing[0]), /q=criteriaV2/);
    if (refused) {
      assert.equal(out.error.code, 'ALLOCATION_BUDGET_LIMIT', JSON.stringify(out));
      assert.equal(out.error.details.daily_budget, '90.00');
      assert.equal(out.error.details.maximum, '50');
    } else {
      assert.equal(out.success, true, JSON.stringify(out.error));
      assert.equal(out.data.daily_budget_limits.status, 'checked');
      assert.equal(out.data.daily_budget_limits.max, '100');
    }
  }
  // A pricing read that fails leaves the limits unknown; LinkedIn still checks the amount at execution.
  const f = linkedinAllocationFixture(t);
  for (const c of f.campaigns.values()) Object.assign(c, {costType: 'CPM', targetingCriteria: {include: {and: []}}});
  f.hook(u =>
    u.pathname === '/rest/adBudgetPricing' ? Response.json({message: 'Synthetic refusal'}, {status: 400}) : undefined,
  );
  assert.equal((await f.captureReport()).success, true);
  const out = await f.preview();
  assert.equal(out.success, true, JSON.stringify(out.error));
  assert.equal(out.data.daily_budget_limits.status, 'unavailable');
});

test('Google amounts are refused at prepare when the currency cannot be charged that precisely (JPY 500.5)', () => {
  assert.throws(
    () => recipeCurrencyMicros('500.5', 'JPY', 'daily budget'),
    e =>
      e.code === 'INVALID_RECIPE_MONEY' &&
      /more decimal places than the account currency/.test(e.message) &&
      e.details.currency === 'JPY' &&
      e.details.decimal_places === 0 &&
      e.details.value === '500.5',
  );
  assert.equal(recipeCurrencyMicros('500', 'JPY', 'daily budget'), '500000000');
  assert.equal(recipeCurrencyMicros('1.234', 'KWD', 'daily budget'), '1234000');
  assert.throws(() => recipeCurrencyMicros('1.2345', 'KWD', 'daily budget'), {code: 'INVALID_RECIPE_MONEY'});
  assert.equal(recipeCurrencyMicros('25.50', 'USD', 'daily budget'), '25500000');
  assert.throws(() => recipeCurrencyMicros('25.505', 'USD', 'daily budget'), {code: 'INVALID_RECIPE_MONEY'});
  // The guided Google Search recipe refuses it before building any step.
  const business = JSON.parse(
    fs.readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'),
  ).recipe_business;
  assert.throws(
    () => campaignRecipe('google_search', {...business, currency: 'JPY', daily_budget: '500.5', cpc_bid: '100'}),
    e => e.code === 'INVALID_RECIPE_MONEY' && e.details.field === 'daily budget',
  );
  // Per-resource steps (atomic: false) and the default all-or-nothing build (CMP-04) carry the same exact micros.
  const plan = campaignRecipe('google_search', {
    ...business,
    atomic: false,
    currency: 'JPY',
    daily_budget: '500',
    cpc_bid: '100',
  });
  assert.equal(
    plan.steps.find(s => s.id === 'budget').arguments.payload.operations[0].create.amount_micros,
    '500000000',
  );
  const build = campaignRecipe('google_search', {...business, currency: 'JPY', daily_budget: '500', cpc_bid: '100'});
  assert.match(JSON.stringify(build.steps), /"amount_micros":"500000000"/);
});

test('review summaries show an amount with the account currency’s own places: 500 JPY (500000000 micros)', () => {
  const summary = reviewSummary(
    {
      gateway: google,
      action: 'google_ads_v23_campaign_budget_mutate_campaign_budgets',
      method: 'POST',
      path: '/v23/customers/' + customer + '/campaignBudgets:mutate',
      query: {},
      headers: {},
      body: {operations: [{update: {resourceName: 'customers/1/campaignBudgets/2', amountMicros: '500000000'}}]},
      accountId: customer,
    },
    [{results: [{customer: {descriptiveName: 'Tokyo', currencyCode: 'JPY'}}]}],
  );
  assert.match(summary.text, /amountMicros 500 JPY \(500000000 micros\)/);
  assert.equal(summary.money[0].amount, '500');
});

function policyStore() {
  const store = new Store(':memory:', key);
  for (const [id, gateway, account] of [
    ['google', google, customer],
    ['meta', 'meta_native_action', 'act_42'],
  ])
    store.putConnection(
      owner,
      {
        id,
        tenantId: owner.tenantId,
        gateway,
        accounts: [account],
        writeAccounts: [account],
        enabled: true,
        label: id,
        scopes: [],
      },
      {accessToken: 'synthetic'},
    );
  return store;
}
const budgetPlan = updates => ({
  gateway: google,
  action: 'google_ads_v23_campaign_budget_mutate_campaign_budgets',
  method: 'POST',
  path: '/v23/customers/' + customer + '/campaignBudgets:mutate',
  query: {},
  headers: {},
  body: {
    operations: updates.map(([id, amount]) => ({
      update: {resourceName: 'customers/' + customer + '/campaignBudgets/' + id, amountMicros: amount},
      updateMask: 'amountMicros',
    })),
  },
  accountId: customer,
  readOnly: false,
  destructive: false,
  requiresConfirmation: true,
  evidence: 'fixture',
  warnings: [],
});
const budgetState = (rows, currency) => [
  {
    results: rows.map(([id, amount]) => ({
      campaignBudget: {resourceName: 'customers/' + customer + '/campaignBudgets/' + id, amountMicros: amount},
    })),
  },
  ...(currency ? [{results: [{customer: {id: customer, currencyCode: currency}}]}] : []),
];
const savePolicy = (store, policy, gateway = google, account = customer) =>
  saveSpendPolicy(store, owner, {gateway, account_id: account, confirmed: true, policy});

test('a multi-budget edit compares each budget with its own current amount (per-resource baselines)', () => {
  for (const enforcement of ['confirm', 'block']) {
    const store = policyStore();
    try {
      savePolicy(store, {enforcement, max_budget_increase_percent: 20, max_daily_increase_native: 10000000});
      // Cutting 90 to 60 and 80 to 50 used to lose both baselines and reserve the whole 110,000,000 micros.
      const cut = checkSpendPolicy(
        store,
        actor,
        budgetPlan([
          ['1', '60000000'],
          ['2', '50000000'],
        ]),
        budgetState([
          ['1', '90000000'],
          ['2', '80000000'],
        ]),
      );
      assert.equal(cut.requested_increase_decimal, '0', enforcement);
      assert.equal(cut.exceeded, undefined, enforcement);
      // One down and one up: only the raise counts, against its own budget (80 to 88 is 10%).
      const mixed = checkSpendPolicy(
        store,
        actor,
        budgetPlan([
          ['1', '60000000'],
          ['2', '88000000'],
        ]),
        budgetState([
          ['1', '90000000'],
          ['2', '80000000'],
        ]),
      );
      assert.equal(mixed.requested_increase_decimal, '8000000', enforcement);
      assert.equal(mixed.exceeded, undefined, enforcement);
      // A raise beyond 20% of its own budget is still found (80 to 100 is 25%), whatever the other budget does.
      const over = () =>
        checkSpendPolicy(
          store,
          actor,
          budgetPlan([
            ['1', '60000000'],
            ['2', '100000000'],
          ]),
          budgetState([
            ['1', '90000000'],
            ['2', '80000000'],
          ]),
        );
      if (enforcement === 'block') assert.throws(over, {code: 'POLICY_INCREASE_LIMIT'});
      else
        assert.deepEqual(
          over().exceeded.map(x => [x.rule, x.before_decimal]),
          [
            ['POLICY_INCREASE_LIMIT', '80000000'],
            ['POLICY_DAILY_INCREASE_LIMIT', undefined],
          ],
        );
      // Without identities in the state (a family or provider that names none) the earlier rule holds: two distinct
      // priors are no single baseline.
      const anonymous = () =>
        checkSpendPolicy(
          store,
          actor,
          budgetPlan([
            ['1', '60000000'],
            ['2', '50000000'],
          ]),
          [{results: [{campaignBudget: {amountMicros: '90000000'}}, {campaignBudget: {amountMicros: '80000000'}}]}],
        );
      if (enforcement === 'block') assert.throws(anonymous, {code: 'POLICY_BASELINE_REQUIRED'});
      else assert.equal(anonymous().exceeded[0].rule, 'POLICY_BASELINE_REQUIRED');
      // The rollback switch restores the field-name pairing everywhere.
      process.env.AMCP_SPEND_POLICY_RESOURCE_BASELINES = 'false';
      try {
        const legacy = () =>
          checkSpendPolicy(
            store,
            actor,
            budgetPlan([
              ['1', '60000000'],
              ['2', '50000000'],
            ]),
            budgetState([
              ['1', '90000000'],
              ['2', '80000000'],
            ]),
          );
        if (enforcement === 'block') assert.throws(legacy, {code: 'POLICY_BASELINE_REQUIRED'});
        else assert.equal(legacy().requested_increase_decimal, '110000000');
      } finally {
        delete process.env.AMCP_SPEND_POLICY_RESOURCE_BASELINES;
      }
    } finally {
      store.close();
    }
  }
});

test('caps bound to a currency compare only an account that spends in it; never converted', () => {
  for (const enforcement of ['confirm', 'block']) {
    const store = policyStore();
    try {
      const saved = savePolicy(store, {enforcement, max_budget_currency: 100, currency: 'USD'});
      assert.equal(saved.currency, 'USD');
      assert.equal(saved.max_budget_native, 100000000);
      const plan = budgetPlan([['1', '50000000']]),
        state = currency => budgetState([['1', '40000000']], currency);
      // Match: the cap applies as before.
      assert.equal(checkSpendPolicy(store, actor, plan, state('USD')).exceeded, undefined, enforcement);
      // Mismatch: 50 KWD is not 50 USD.
      const mismatch = () => checkSpendPolicy(store, actor, plan, state('KWD'));
      if (enforcement === 'block') assert.throws(mismatch, {code: 'POLICY_CURRENCY_MISMATCH'});
      else {
        const x = mismatch().exceeded;
        assert.deepEqual(
          x.map(e => [e.rule, e.policy_currency, e.account_currency]),
          [['POLICY_CURRENCY_MISMATCH', 'USD', 'KWD']],
        );
      }
      // Unknown: neither the review's state nor a live account check names it; the finding says how to learn it.
      const unknown = () => checkSpendPolicy(store, actor, plan, state());
      if (enforcement === 'block')
        assert.throws(
          unknown,
          e =>
            e.code === 'POLICY_CURRENCY_UNKNOWN' &&
            e.details.next_call.tool === 'amcp_workspace' &&
            e.details.next_call.arguments.connection_id === 'google' &&
            e.details.next_call.arguments.live === true,
        );
      else assert.equal(unknown().exceeded[0].rule, 'POLICY_CURRENCY_UNKNOWN');
      // A live account check recorded the currency: it is used when the state names none.
      rememberAccountMetadata(store, owner.tenantId, 'google', customer, {
        name: 'Synthetic',
        currency: 'USD',
        timezone: 'UTC',
      });
      assert.equal(checkSpendPolicy(store, actor, plan, state()).exceeded, undefined, enforcement);
    } finally {
      store.close();
    }
  }
});

test('caps saved without a currency keep working and are listed; a live-read currency binds new ones', () => {
  const store = policyStore();
  try {
    // A legacy cap: stated in currency, no currency known. It still compares, and owner health names it.
    const legacy = savePolicy(store, {enforcement: 'block', max_budget_currency: 100});
    assert.equal(legacy.currency, undefined);
    assert.throws(
      () => checkSpendPolicy(store, actor, budgetPlan([['1', '150000000']]), budgetState([['1', '40000000']], 'KWD')),
      {code: 'POLICY_BUDGET_LIMIT'},
    );
    assert.equal(
      checkSpendPolicy(store, actor, budgetPlan([['1', '50000000']]), budgetState([['1', '40000000']], 'KWD')).exceeded,
      undefined,
    );
    assert.deepEqual(
      policyWarnings(store, owner.tenantId).map(w => [w.code, w.policy_id]),
      [['POLICY_CURRENCY_UNSET', legacy.id]],
    );
    // After a live account check, a save without a currency binds the account's own.
    rememberAccountMetadata(store, owner.tenantId, 'google', customer, {
      name: 'Kuwait',
      currency: 'KWD',
      timezone: 'UTC',
    });
    const bound = saveSpendPolicy(store, owner, {
      gateway: google,
      account_id: customer,
      confirmed: true,
      expected_revision: legacy.revision,
      policy: {max_budget_currency: 100},
    });
    assert.equal(bound.currency, 'KWD');
    assert.deepEqual(policyWarnings(store, owner.tenantId), []);
    // Malformed currencies, and a workspace-wide currency, are refused.
    for (const currency of ['usd', 'US', 7, 'US DOLLAR'])
      assert.throws(() => savePolicy(store, {max_budget_currency: 1, currency}), {code: 'INVALID_POLICY'});
    assert.throws(
      () =>
        saveSpendPolicy(store, owner, {
          scope: 'workspace',
          confirmed: true,
          policy: {currency: 'USD', per_gateway: {[google]: {max_budget_currency: 1}}},
        }),
      {code: 'INVALID_POLICY'},
    );
    const workspace = saveSpendPolicy(store, owner, {
      scope: 'workspace',
      confirmed: true,
      policy: {per_gateway: {[google]: {max_budget_currency: 5, currency: 'JPY'}}},
    });
    assert.equal(workspace.per_gateway[google].currency, 'JPY');
    assert.equal(workspace.per_gateway[google].max_budget_native, 5000000);
  } finally {
    store.close();
  }
});

test('Meta caps in account currency convert through the pinned offsets: 100 USD is 10000, 100 JPY is 100', () => {
  const store = policyStore();
  try {
    setMetaCurrencyOffsetsForTest({USD: 100, JPY: 1, KWD: 1000});
    const usd = savePolicy(store, {max_budget_currency: 100, currency: 'USD'}, 'meta_native_action', 'act_42');
    assert.equal(usd.max_budget_native, 10000);
    const jpy = savePolicy(store, {max_budget_currency: 100, currency: 'JPY'}, 'meta_native_action', 'act_42');
    assert.equal(jpy.max_budget_native, 100);
    // A currency the capture does not list, or no currency at all, stays native: a guessed offset would be 100x off.
    for (const policy of [{max_budget_currency: 100, currency: 'EUR'}, {max_budget_currency: 100}])
      assert.throws(
        () => savePolicy(store, policy, 'meta_native_action', 'act_42'),
        e => e.code === 'INVALID_POLICY' && /pinned capture/.test(e.message),
      );
    // Without a pinned capture, Meta caps in currency are refused as before.
    setMetaCurrencyOffsetsForTest(null);
    assert.throws(
      () => savePolicy(store, {max_budget_currency: 100, currency: 'USD'}, 'meta_native_action', 'act_42'),
      {code: 'INVALID_POLICY'},
    );
  } finally {
    setMetaCurrencyOffsetsForTest(undefined);
    store.close();
  }
});

const targeting = (kind, operations) => ({
  gateway: google,
  action: 'fixture',
  method: 'POST',
  path: '/v23/customers/' + customer + '/' + kind + ':mutate',
  query: {},
  headers: {},
  body: {operations},
  accountId: customer,
  readOnly: false,
  destructive: false,
  requiresConfirmation: true,
  evidence: 'fixture',
  warnings: [],
});
const campaign = 'customers/' + customer + '/campaigns/7',
  negativeKeyword = {campaign, negative: true, keyword: {text: 'free', match_type: 'BROAD'}};

test('only negative-only Google targeting creates skip the spend acknowledgement', () => {
  assert.equal(googleTargetingWidens(targeting('campaignCriteria', [{create: negativeKeyword}])), false);
  assert.equal(
    googleTargetingWidens(
      targeting('adGroupCriteria', [
        {create: {ad_group: 'customers/' + customer + '/adGroups/8', negative: true, keyword: {text: 'x'}}},
      ]),
    ),
    false,
  );
  assert.equal(
    googleTargetingWidens(
      targeting('sharedCriteria', [
        {create: {shared_set: 'customers/' + customer + '/sharedSets/9', keyword: {text: 'x', match_type: 'EXACT'}}},
      ]),
    ),
    false,
  );
  for (const [kind, operations] of [
    ['campaignCriteria', [{create: {...negativeKeyword, negative: false}}]],
    ['campaignCriteria', [{create: {campaign, location: {geo_target_constant: 'geoTargetConstants/2840'}}}]],
    ['campaignCriteria', [{create: negativeKeyword}, {remove: 'customers/' + customer + '/campaignCriteria/7~1'}]],
    ['campaignCriteria', [{remove: 'customers/' + customer + '/campaignCriteria/7~1'}]],
    [
      'adGroupCriteria',
      [{update: {resource_name: 'customers/' + customer + '/adGroupCriteria/8~1', status: 'ENABLED'}}],
    ],
    ['sharedSets', [{create: {name: 'List', type: 'NEGATIVE_KEYWORDS'}}]],
    ['campaignSharedSets', [{create: {campaign, shared_set: 'customers/' + customer + '/sharedSets/9'}}]],
    ['campaignCriteria', []],
  ])
    assert.equal(googleTargetingWidens(targeting(kind, operations)), true, kind + ' ' + JSON.stringify(operations));
  // Rollback: every targeting write asks again.
  process.env.AMCP_GOOGLE_NARROWING_EXEMPT = 'false';
  try {
    assert.equal(googleTargetingWidens(targeting('campaignCriteria', [{create: negativeKeyword}])), true);
  } finally {
    delete process.env.AMCP_GOOGLE_NARROWING_EXEMPT;
  }
});

test('allow_activation false refuses removing an exclusion, which widens delivery, and allows removing a positive one', () => {
  const store = policyStore();
  try {
    savePolicy(store, {allow_activation: false});
    const name = 'customers/' + customer + '/campaignCriteria/7~1',
      remove = targeting('campaignCriteria', [{remove: name}]),
      state = negative => [{results: [{campaignCriterion: {resourceName: name, negative}}]}];
    assert.throws(() => checkSpendPolicy(store, actor, remove, state(true)), {code: 'POLICY_ACTIVATION_FORBIDDEN'});
    // A criterion the review could not read counts as an exclusion (fail closed).
    assert.throws(() => checkSpendPolicy(store, actor, remove, []), {code: 'POLICY_ACTIVATION_FORBIDDEN'});
    assert.doesNotThrow(() => checkSpendPolicy(store, actor, remove, state(false)));
    // Detaching a negative list from a campaign widens delivery too; adding exclusions never activates anything.
    assert.throws(
      () =>
        checkSpendPolicy(
          store,
          actor,
          targeting('campaignSharedSets', [{remove: 'customers/' + customer + '/campaignSharedSets/7~9'}]),
          [],
        ),
      {code: 'POLICY_ACTIVATION_FORBIDDEN'},
    );
    assert.doesNotThrow(() =>
      checkSpendPolicy(store, actor, targeting('campaignCriteria', [{create: negativeKeyword}]), []),
    );
  } finally {
    store.close();
  }
});

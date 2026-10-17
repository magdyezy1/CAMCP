import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Store} from '../dist/src/store.js';
import {saveSpendPolicy, checkSpendPolicy, exceededCaps, describeExceeded} from '../dist/src/spend-policy.js';
import {campaignRecipe} from '../dist/src/campaign-recipes.js';
import {rememberAccountMetadata} from '../dist/src/account-metadata.js';
import {
  classifyGoogleBidFields,
  googleBidFieldsArtifact,
  output,
  pinnedGoogleAdsVersion,
} from '../tools/google-bid-fields.mjs';

/*
 * WRT-01: every money amount AMCP sends for a capped account is compared with a cap or listed as unsupported, and a
 * measurable amount is never dropped. Each test below failed on the evaluator before WRT-01: the Google bid ceilings,
 * floors and targets were outside the bid cap, and a spend_cap (or any unmapped field) discarded every other amount.
 */
const key = Buffer.alloc(32, 91).toString('base64'),
  actor = {tenantId: 'money-coverage', userId: 'owner', role: 'admin'},
  google = 'google_ads_native_action',
  meta = 'meta_native_action',
  reddit = 'reddit_native_action';
/**
 * A workspace default with these per-platform limits. Caps stated in account currency name it (USD), and each
 * platform's account 123 is known to spend in USD from a live check: owner decision P5 refuses every money change under
 * a currency cap that names no currency (tests/currency-money-checks.test.mjs), and these tests are about which amounts
 * the caps compare.
 */
const workspace = (perGateway, shared = {}) => {
  const s = new Store(':memory:', key),
    limits = {};
  for (const [gateway, entry] of Object.entries(perGateway)) {
    const inCurrency = Object.keys(entry).some(k => k.endsWith('_currency'));
    limits[gateway] = inCurrency && entry.currency === undefined ? {...entry, currency: 'USD'} : entry;
    if (!inCurrency) continue;
    s.putConnection(
      actor,
      {
        id: gateway,
        tenantId: actor.tenantId,
        gateway,
        accounts: ['123'],
        writeAccounts: ['123'],
        enabled: true,
        label: gateway,
        scopes: [],
      },
      {accessToken: 'synthetic'},
    );
    rememberAccountMetadata(s, actor.tenantId, gateway, '123', {name: 'Synthetic', currency: 'USD', timezone: 'UTC'});
  }
  saveSpendPolicy(s, actor, {scope: 'workspace', confirmed: true, policy: {...shared, per_gateway: limits}});
  return s;
};
const plan = (gateway, path, body, extra = {}) => ({
  gateway,
  accountId: '123',
  action: extra.action ?? 'synthetic_money_coverage',
  method: extra.method ?? 'POST',
  path,
  headers: {},
  query: {},
  body,
  readOnly: false,
  destructive: false,
  requiresConfirmation: true,
  evidence: 'synthetic WRT-01 money coverage',
  warnings: [],
});
const googleCampaign = create => plan(google, '/v25/customers/123/campaigns:mutate', {operations: [{create}]});
const googleGroup = create => plan(google, '/v25/customers/123/adGroups:mutate', {operations: [{create}]});
const rules = result => exceededCaps(result).map(x => x.rule);

// The five bypasses the review probed, the floors next to them, and a portfolio strategy in REST camelCase.
const bypasses = [
  ['Maximize Clicks CPC ceiling', googleCampaign({target_spend: {cpc_bid_ceiling_micros: '5000000'}})],
  ['Target Impression Share CPC ceiling', googleCampaign({target_impression_share: {cpc_bid_ceiling_micros: 5000000}})],
  ['ad group target CPC', googleGroup({target_cpc_micros: '5000000'})],
  ['ad group target CPV', googleGroup({target_cpv_micros: '5000000'})],
  ['ad group fixed CPM', googleGroup({fixed_cpm_micros: '5000000'})],
  [
    'Maximize Conversion Value CPC floor',
    googleCampaign({maximize_conversion_value: {cpc_bid_floor_micros: '5000000'}}),
  ],
  [
    'portfolio Target CPA ceiling (camelCase)',
    plan(google, '/v25/customers/123/biddingStrategies:mutate', {
      operations: [{create: {name: 'P', targetCpa: {targetCpaMicros: '500000', cpcBidCeilingMicros: '5000000'}}}],
    }),
  ],
];

test('the owner bid cap refuses every Google CPC ceiling, floor and target bid above it under block', () => {
  const s = workspace({[google]: {max_bid_native: 1000000}}, {enforcement: 'block'});
  try {
    for (const [label, p] of bypasses)
      assert.throws(() => checkSpendPolicy(s, actor, p, []), {code: 'POLICY_BID_LIMIT'}, label);
    // Controls the old cap already covered keep their refusal.
    assert.throws(() => checkSpendPolicy(s, actor, googleGroup({cpc_bid_micros: '5000000'}), []), {
      code: 'POLICY_BID_LIMIT',
    });
    assert.throws(
      () => checkSpendPolicy(s, actor, googleCampaign({maximize_conversions: {target_cpa_micros: '5000000'}}), []),
      {code: 'POLICY_BID_LIMIT'},
    );
    // At or under the cap nothing is refused.
    assert.equal(
      checkSpendPolicy(s, actor, googleCampaign({target_spend: {cpc_bid_ceiling_micros: '1000000'}}), []).exceeded,
      undefined,
    );
  } finally {
    s.close();
  }
});

test('under confirm each Google bid bypass is an exceeded POLICY_BID_LIMIT naming the field', () => {
  const s = workspace({[google]: {max_bid_native: 1000000}});
  try {
    for (const [label, p] of bypasses) {
      const result = checkSpendPolicy(s, actor, p, []);
      assert.deepEqual(rules(result), ['POLICY_BID_LIMIT'], label);
      assert.match(result.exceeded_summary, /is above the bid cap of 1000000 \(native units, \/body\/operations\/0\//);
      assert.throws(() => checkSpendPolicy(s, actor, p, [], 'review-' + label), {code: 'CAP_CONFIRMATION_REQUIRED'});
    }
  } finally {
    s.close();
  }
});

test('the guided Search clicks recipe above the bid cap is refused (block) or asks for cap confirmation (confirm)', () => {
  const {cpc_bid, ...business} = JSON.parse(
    fs.readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'),
  ).recipe_business;
  // One step per resource type (atomic: false), so the campaign step is checked as its own service request.
  const recipe = campaignRecipe('google_search_clicks', {...business, cpc_bid_ceiling: '5.00', atomic: false}),
    step = recipe.steps.find(s => s.id === 'campaign'),
    p = googleCampaign(step.arguments.payload.operations[0].create);
  for (const enforcement of ['block', 'confirm']) {
    const s = workspace({[google]: {max_bid_currency: 1}}, {enforcement});
    try {
      if (enforcement === 'block') assert.throws(() => checkSpendPolicy(s, actor, p, []), {code: 'POLICY_BID_LIMIT'});
      else {
        assert.deepEqual(rules(checkSpendPolicy(s, actor, p, [])), ['POLICY_BID_LIMIT']);
        assert.throws(() => checkSpendPolicy(s, actor, p, [], 'recipe-review'), {code: 'CAP_CONFIRMATION_REQUIRED'});
      }
    } finally {
      s.close();
    }
  }
});

// CMP-04: Google Search recipes are one all-or-nothing googleAds:mutate by default. The caps read the whole build:
// its CPC ceiling against the bid cap and its budget against the budget cap, as the separate steps were.
test('the default all-or-nothing Search recipe build keeps the bid and budget caps', () => {
  const {cpc_bid, ...business} = JSON.parse(
    fs.readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'),
  ).recipe_business;
  const build = campaignRecipe('google_search_clicks', {...business, cpc_bid_ceiling: '5.00'}).steps[0],
    p = plan(google, '/v25/customers/123/googleAds:mutate', build.arguments.payload, {
      action: 'google_ads_v25_google_ads_mutate',
    });
  assert.equal(build.id, 'build');
  const s = workspace({[google]: {max_bid_currency: 1, max_budget_currency: 1}}, {enforcement: 'confirm'});
  try {
    assert.deepEqual(rules(checkSpendPolicy(s, actor, p, [])).sort(), ['POLICY_BID_LIMIT', 'POLICY_BUDGET_LIMIT']);
  } finally {
    s.close();
  }
});

test('ratios expressed in micros and ROAS targets are never compared with the money caps', () => {
  const s = workspace({[google]: {max_bid_native: 1, max_budget_native: 1}}, {enforcement: 'block'});
  try {
    for (const create of [
      {target_impression_share: {location_fraction_micros: '500000', location: 'ANYWHERE_ON_PAGE'}},
      {commission: {commission_rate_micros: '106000'}},
      {target_roas: {target_roas: 5.5}},
      {maximize_conversion_value: {target_roas: 3}},
    ])
      assert.equal(checkSpendPolicy(s, actor, googleCampaign(create), []).exceeded, undefined, JSON.stringify(create));
  } finally {
    s.close();
  }
});

test('Google money that is neither a bid nor a budget (a deprecated spend target) is unsupported, not ignored', () => {
  const s = workspace({[google]: {max_bid_native: 1000000}});
  try {
    const result = checkSpendPolicy(s, actor, googleCampaign({target_spend: {target_spend_micros: '1'}}), []);
    assert.deepEqual(rules(result), ['POLICY_AMOUNT_UNSUPPORTED']);
    assert.equal(exceededCaps(result)[0].field, '/body/operations/0/create/target_spend/target_spend_micros');
  } finally {
    s.close();
  }
});

test('the generated Google money fields are current and every classified bid field reaches the bid cap', () => {
  assert.equal(fs.readFileSync(output, 'utf8'), googleBidFieldsArtifact(), 'run node tools/google-bid-fields.mjs');
  const generated = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(generated.api_version, pinnedGoogleAdsVersion());
  const s = workspace({[google]: {max_bid_native: 1}}, {enforcement: 'block'});
  try {
    for (const field of generated.fields.bid)
      assert.throws(
        () => checkSpendPolicy(s, actor, googleGroup({[field]: '2'}), []),
        {code: 'POLICY_BID_LIMIT'},
        field,
      );
    for (const field of generated.fields.ratio)
      assert.equal(checkSpendPolicy(s, actor, googleGroup({[field]: '2'}), []).exceeded, undefined, field);
  } finally {
    s.close();
  }
});

test('a newly pinned Google version with an unclassified writable money field fails generation', () => {
  const version = pinnedGoogleAdsVersion(),
    pinned = JSON.parse(fs.readFileSync('.mirror/VENDOR/google-ads-' + version + '.json', 'utf8')).document,
    schema = 'GoogleAdsGoogleads' + version.toUpperCase() + 'Common__TargetSpend';
  assert.ok(classifyGoogleBidFields(pinned, version).fields.bid.includes('cpc_bid_ceiling_micros'));
  const injected = structuredClone(pinned);
  injected.schemas[schema].properties.cpcBidStepMicros = {type: 'string', format: 'int64'};
  assert.throws(
    () => classifyGoogleBidFields(injected, version),
    e => Array.isArray(e.unclassified) && e.unclassified.includes('Common__TargetSpend.cpcBidStepMicros'),
  );
  // An output-only field is never written, so it needs no class.
  const outputOnly = structuredClone(pinned);
  outputOnly.schemas[schema].properties.effectiveCeilingMicros = {
    type: 'string',
    readOnly: true,
    description: 'Output only. Effective ceiling.',
  };
  assert.doesNotThrow(() => classifyGoogleBidFields(outputOnly, version));
});

/** A Reddit CBO campaign create (goal_value is the campaign budget) with an optional lifetime spend cap. */
const redditCampaign = data =>
  plan(reddit, '/api/v3/ad_accounts/a2_123/campaigns', {
    data: {name: 'C', configured_status: 'PAUSED', objective: 'CLICKS', goal_type: 'DAILY_SPEND', ...data},
  });
const metaCampaign = body =>
  plan(
    meta,
    '/v25.0/act_123/campaigns',
    {name: 'C', status: 'PAUSED', ...body},
    {action: 'meta_ad_account_id_campaigns_create'},
  );

test('a Reddit CBO budget above the cap is reported beside a cleared spend cap, and still refused under block', () => {
  const s = workspace({[reddit]: {max_budget_currency: 100}});
  try {
    // Before WRT-01 the spend_cap refusal replaced the goal's POLICY_BUDGET_LIMIT and reserved nothing.
    const over = redditCampaign({goal_value: 5000000000, spend_cap: null}),
      result = checkSpendPolicy(s, actor, over, []);
    assert.deepEqual(rules(result).sort(), ['POLICY_AMOUNT_UNSUPPORTED', 'POLICY_BUDGET_LIMIT']);
    assert.equal(exceededCaps(result).find(x => x.rule === 'POLICY_BUDGET_LIMIT').field, '/body/data/goal_value');
    assert.equal(exceededCaps(result).find(x => x.rule === 'POLICY_AMOUNT_UNSUPPORTED').field, '/body/data/spend_cap');
    assert.match(describeExceeded(exceededCaps(result)), /5000000000 is above the cap of 100000000/);
    assert.match(describeExceeded(exceededCaps(result)), /\(\/body\/data\/spend_cap\)/);
    // Confirmed at execute: the goal's increase is reserved against the daily window.
    const confirmed = checkSpendPolicy(s, actor, over, [], 'reddit-review', true);
    assert.equal(confirmed.requested_increase_decimal, '5000000000');
    assert.equal(s.document(actor.tenantId, 'spend_reservation', 'reddit-review').increase_decimal, '5000000000');
  } finally {
    s.close();
  }
  const blocked = workspace({[reddit]: {max_budget_currency: 100}}, {enforcement: 'block'});
  try {
    assert.throws(
      () => checkSpendPolicy(blocked, actor, redditCampaign({goal_value: 5000000000, spend_cap: null}), []),
      {
        code: 'POLICY_BUDGET_LIMIT',
      },
    );
    assert.throws(() => checkSpendPolicy(blocked, actor, redditCampaign({goal_value: 50000000, spend_cap: null}), []), {
      code: 'POLICY_AMOUNT_UNSUPPORTED',
    });
  } finally {
    blocked.close();
  }
});

test('a Reddit spend cap is compared numerically as a lifetime amount next to the goal (D7)', () => {
  const s = workspace({[reddit]: {max_budget_currency: 100, max_total_budget_currency: 1000}});
  try {
    const both = checkSpendPolicy(s, actor, redditCampaign({goal_value: 5000000000, spend_cap: 50000000}), []);
    assert.deepEqual(rules(both), ['POLICY_BUDGET_LIMIT'], 'the goal is over the budget cap, the spend cap is under');
    const cap = checkSpendPolicy(s, actor, redditCampaign({goal_value: 50000000, spend_cap: 2000000000}), []);
    assert.deepEqual(rules(cap), ['POLICY_BUDGET_LIMIT']);
    assert.equal(exceededCaps(cap)[0].field, '/body/data/spend_cap');
    assert.equal(exceededCaps(cap)[0].limit_key, 'max_total_budget_native');
    assert.match(cap.exceeded_summary, /lifetime or total amount 2000000000 is above the total cap of 1000000000/);
    assert.equal(
      checkSpendPolicy(s, actor, redditCampaign({goal_value: 50000000, spend_cap: 900000000}), []).exceeded,
      undefined,
    );
    assert.deepEqual(rules(checkSpendPolicy(s, actor, redditCampaign({goal_value: 50000000, spend_cap: 0}), [])), [
      'POLICY_AMOUNT_UNSUPPORTED',
    ]);
  } finally {
    s.close();
  }
});

test('lowering a lifetime spend cap is always allowed, even above the cap; raising it is held to the cap (D7)', () => {
  const s = workspace({[reddit]: {max_budget_currency: 100}});
  try {
    const update = spend_cap =>
        plan(reddit, '/api/v3/campaigns/100', {data: {spend_cap}}, {method: 'PATCH', action: 'reddit_campaign_update'}),
      before = [{data: {id: '100', ad_account_id: 'a2_123', spend_cap: 900000000}}];
    assert.equal(checkSpendPolicy(s, actor, update(800000000), before).exceeded, undefined);
    assert.equal(checkSpendPolicy(s, actor, update(900000000), before).exceeded, undefined);
    assert.deepEqual(rules(checkSpendPolicy(s, actor, update(950000000), before)), ['POLICY_BUDGET_LIMIT']);
  } finally {
    s.close();
  }
});

test('a Meta daily budget above the cap is reported beside an unmapped field, with the increase reserved', () => {
  const s = workspace({[meta]: {max_budget_native: 10000}});
  try {
    const over = metaCampaign({daily_budget: '999999', budget_rebalance_threshold: '5000'}),
      result = checkSpendPolicy(s, actor, over, []);
    assert.deepEqual(rules(result).sort(), ['POLICY_AMOUNT_UNSUPPORTED', 'POLICY_BUDGET_LIMIT']);
    checkSpendPolicy(s, actor, over, [], 'meta-review', true);
    assert.equal(s.document(actor.tenantId, 'spend_reservation', 'meta-review').increase_decimal, '999999');
    // A Meta campaign spend cap is a lifetime amount compared numerically, no longer an unmapped field.
    const capped = checkSpendPolicy(s, actor, metaCampaign({daily_budget: '999999', spend_cap: '5000'}), []);
    assert.deepEqual(rules(capped), ['POLICY_BUDGET_LIMIT']);
    assert.equal(exceededCaps(capped)[0].field, '/body/daily_budget');
    assert.deepEqual(rules(checkSpendPolicy(s, actor, metaCampaign({daily_budget: '5000', spend_cap: '0'}), [])), [
      'POLICY_AMOUNT_UNSUPPORTED',
    ]);
  } finally {
    s.close();
  }
  const blocked = workspace({[meta]: {max_budget_native: 10000}}, {enforcement: 'block'});
  try {
    assert.throws(
      () => checkSpendPolicy(blocked, actor, metaCampaign({daily_budget: '999999', spend_cap: '5000'}), []),
      {
        code: 'POLICY_BUDGET_LIMIT',
      },
    );
  } finally {
    blocked.close();
  }
});

test('a Google custom-period total budget is compared numerically against the total cap (D7)', () => {
  const total = micros =>
    plan(google, '/v25/customers/123/campaignBudgets:mutate', {
      operations: [{create: {name: 'B', period: 'CUSTOM_PERIOD', total_amount_micros: micros}}],
    });
  const daily = workspace({[google]: {max_budget_currency: 100}});
  try {
    // Without a total cap the per-budget cap applies; before D7 every total failed closed as unsupported.
    const result = checkSpendPolicy(daily, actor, total('500000000'), []);
    assert.deepEqual(rules(result), ['POLICY_BUDGET_LIMIT']);
    assert.equal(exceededCaps(result)[0].amount_kind, 'lifetime_or_total');
    assert.equal(checkSpendPolicy(daily, actor, total('50000000'), []).exceeded, undefined);
  } finally {
    daily.close();
  }
  const capped = workspace({[google]: {max_budget_currency: 100, max_total_budget_currency: 1000}});
  try {
    assert.equal(checkSpendPolicy(capped, actor, total('500000000'), []).exceeded, undefined);
    assert.deepEqual(rules(checkSpendPolicy(capped, actor, total('2000000000'), [])), ['POLICY_BUDGET_LIMIT']);
    // The total cap governs totals only: a daily amount stays under the budget cap.
    const dailyOver = plan(google, '/v25/customers/123/campaignBudgets:mutate', {
      operations: [{create: {name: 'B', amount_micros: '500000000'}}],
    });
    assert.deepEqual(rules(checkSpendPolicy(capped, actor, dailyOver, [])), ['POLICY_BUDGET_LIMIT']);
  } finally {
    capped.close();
  }
});

test('max_total_budget is a validated policy limit, converted from currency where the unit is documented', () => {
  const s = new Store(':memory:', key);
  try {
    const saved = saveSpendPolicy(s, actor, {
      scope: 'workspace',
      confirmed: true,
      policy: {per_gateway: {[google]: {max_total_budget_currency: 2.5}, [meta]: {max_total_budget_native: 25000}}},
    });
    assert.equal(saved.per_gateway[google].max_total_budget_native, 2500000);
    assert.equal(saved.per_gateway[meta].max_total_budget_native, 25000);
    assert.throws(
      () =>
        saveSpendPolicy(s, actor, {
          scope: 'workspace',
          confirmed: true,
          policy: {per_gateway: {[meta]: {max_total_budget_currency: 25}}},
        }),
      {code: 'INVALID_POLICY'},
    );
    assert.throws(
      () =>
        saveSpendPolicy(s, actor, {
          scope: 'workspace',
          confirmed: true,
          policy: {per_gateway: {[google]: {max_total_budget_native: -1}}},
        }),
      {code: 'INVALID_POLICY'},
    );
  } finally {
    s.close();
  }
});

test('a Snapchat lifetime spend cap answers to the total cap once the owner sets one (D7)', () => {
  const snapchat = 'snapchat_native_action',
    s = workspace(
      {[snapchat]: {max_budget_native: 200000000, max_total_budget_native: 2000000000}},
      {enforcement: 'block'},
    ),
    change = value =>
      plan(snapchat, '/v1/adaccounts/123/campaigns/111', [{op: 'replace', path: '/lifetime_spend_cap_micro', value}], {
        method: 'PATCH',
        action: 'snapchat_campaign_update',
      }),
    before = [{lifetime_spend_cap_micro: '100000000'}];
  try {
    assert.equal(checkSpendPolicy(s, actor, change('999000000'), before).exceeded, undefined);
    assert.throws(() => checkSpendPolicy(s, actor, change('2999000000'), before), {code: 'POLICY_BUDGET_LIMIT'});
  } finally {
    s.close();
  }
});

test('AMCP_SPEND_POLICY_UNSUPPORTED=abort restores the earlier evaluator for rollback only', () => {
  const s = workspace({[reddit]: {max_budget_currency: 100}}),
    over = redditCampaign({goal_value: 5000000000, spend_cap: null}),
    previous = process.env.AMCP_SPEND_POLICY_UNSUPPORTED;
  try {
    process.env.AMCP_SPEND_POLICY_UNSUPPORTED = 'abort';
    const legacy = checkSpendPolicy(s, actor, over, []);
    assert.deepEqual(rules(legacy), ['POLICY_AMOUNT_UNSUPPORTED']);
    assert.equal(legacy.requested_increase_decimal, '0');
    // Any other value keeps every measured amount.
    process.env.AMCP_SPEND_POLICY_UNSUPPORTED = 'report';
    assert.deepEqual(rules(checkSpendPolicy(s, actor, over, [])).sort(), [
      'POLICY_AMOUNT_UNSUPPORTED',
      'POLICY_BUDGET_LIMIT',
    ]);
  } finally {
    if (previous === undefined) delete process.env.AMCP_SPEND_POLICY_UNSUPPORTED;
    else process.env.AMCP_SPEND_POLICY_UNSUPPORTED = previous;
    s.close();
  }
});

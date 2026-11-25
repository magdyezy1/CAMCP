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

test('the request the policy reads is not changed by judging it', () => {
  const plan = google('campaigns', campaignUpdate({}, 'maximize_conversions.target_cpa_micros')),
    before = JSON.stringify(plan);
  withPolicy({enforcement: 'confirm', max_bid_native: 5000000}, s => checkSpendPolicy(s, actor, plan, []));
  assert.equal(JSON.stringify(plan), before);
});

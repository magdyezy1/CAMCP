import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizeExecution} from '../dist/src/preflight.js';

// Owner decision (review 2026-09-28): the generic spend confirmation reads field names, never content.
const actor = {tenantId: 't', userId: 'operator', role: 'operator'},
  policy = {allowWrites: true, requireBeforeState: true},
  input = {confirmed: true, dry_run: false, idempotency_key: 'review-1'};
const plan = (fields = {}) => ({
  gateway: 'meta_native_action',
  action: 'meta_ad_account_id_adlabels_create',
  method: 'POST',
  path: '/v25.0/act_123/adlabels',
  query: {},
  headers: {},
  body: {name: 'Label'},
  accountId: '123',
  readOnly: false,
  destructive: false,
  requiresConfirmation: true,
  evidence: 'fixture',
  warnings: [],
  ...fields,
});
const needsConfirmation = p => {
  try {
    authorizeExecution(actor, p, input, policy, true);
    return false;
  } catch (e) {
    if (e.code === 'SPEND_CONFIRMATION_REQUIRED') return true;
    throw e;
  }
};

test('content that merely contains budget, bid or spend no longer asks for a spend confirmation', () => {
  for (const name of ['Budget review', 'Bidding test ideas', 'Q3 spend report', 'Status: ACTIVE campaigns'])
    assert.equal(needsConfirmation(plan({body: {name}})), false, name);
});

test('field names, field paths in values and Google resource types still ask for it', () => {
  const cases = {
    'a budget field': plan({body: {name: 'Label', daily_budget: 100}}),
    'a bid field': plan({body: {name: 'Label', bid_amount: 5}}),
    'an active status': plan({body: {name: 'Label', status: 'active'}}),
    'a JSON Patch path': plan({method: 'PATCH', body: [{op: 'replace', path: '/daily_budget', value: 100}]}),
    'a REST.li delete': plan({body: {patch: {$delete: ['dailyBudget']}}}),
    'an update mask in the query': plan({method: 'PATCH', query: {updateMask: 'budget.budgetAmountMicros'}, body: {}}),
    'a Google bid modifier removal': {
      ...plan(),
      gateway: 'google_ads_native_action',
      action: 'google_ads_v23_ad_group_bid_modifier_mutate_ad_group_bid_modifiers',
      path: '/v23/customers/123/adGroupBidModifiers:mutate',
      body: {operations: [{remove: 'customers/123/adGroupBidModifiers/456~30001'}]},
    },
  };
  for (const [what, p] of Object.entries(cases)) assert.equal(needsConfirmation(p), true, what);
  // Confirming still lets each of them through this rule.
  for (const p of Object.values(cases))
    assert.doesNotThrow(() => authorizeExecution(actor, p, {...input, spend_change_confirmed: true}, policy, true));
});

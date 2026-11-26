import test from 'node:test';
import assert from 'node:assert/strict';
import {googleReconcileFixture} from './helpers/google-reconcile-fixture.mjs';
import {applyExecutionRisk} from '../dist/src/execution-risk.js';
import {normalizeAccount} from '../dist/src/scope.js';
import {snapshotPlans} from '../dist/src/write-snapshots.js';

/**
 * R2.5 package r25-approval-fields (the owner's friction report of 2026-11-25, B6): a Google Ads update's review read the fields it changes and
 * nothing that names the object, so its summary line could only say the id. The read it already makes now selects the name of an object that has
 * one, beside its resource name (no new read, and no provider contacted: the read is only built here).
 */
let tenants = 0;
function stateReadOf(t, action, operation) {
  const f = googleReconcileFixture({tenant: 'google-names-' + ++tenants});
  t.after(() => f.store.close());
  const svc = f.service,
    input = {
      action,
      payload: {operations: [operation]},
      account_id: normalizeAccount('google_ads_native_action', '123'),
    };
  svc.registry.validate('google_ads_native_action', input, svc.options);
  const plan = applyExecutionRisk(svc.compiler.compile('google_ads_native_action', input, svc.options));
  return snapshotPlans(plan, svc.registry).map(read => read.body?.query);
}

test('the state read of an update selects the name of what has one, right after its resource name', t => {
  for (const [resource, action, name, field, value] of [
    ['campaign', 'UPDATE_CAMPAIGN', 'customers/123/campaigns/5', 'status', 'PAUSED'],
    ['ad_group', 'UPDATE_AD_GROUP', 'customers/123/adGroups/8', 'status', 'PAUSED'],
    ['asset_group', 'UPDATE_ASSET_GROUP', 'customers/123/assetGroups/7', 'status', 'PAUSED'],
    ['campaign_budget', 'UPDATE_CAMPAIGN_BUDGET', 'customers/123/campaignBudgets/9', 'amountMicros', '203040000'],
  ]) {
    const [query] = stateReadOf(t, action, {
      update: {resource_name: name, [field]: value},
      update_mask: field,
    });
    assert.match(
      query,
      new RegExp(
        '^SELECT ' +
          resource +
          '\\.resource_name, ' +
          resource +
          '\\.name, ' +
          resource +
          '\\.\\w+ FROM ' +
          resource +
          ' WHERE ',
      ),
      resource + ': ' + query,
    );
  }
});

test('a removal reads the name once, and a resource with no name of its own is read as it was', t => {
  const [removal] = stateReadOf(t, 'REMOVE_CAMPAIGN', {remove: 'customers/123/campaigns/5'});
  assert.equal(removal.match(/campaign\.name/g).length, 1, removal);
  const [criterion] = stateReadOf(t, 'UPDATE_CAMPAIGN_CRITERION', {
    update: {resource_name: 'customers/123/campaignCriteria/5~6', bidModifier: 1.2},
    update_mask: 'bidModifier',
  });
  // A criterion has no name: its own family's read of it (which holds what it targets) is what it was.
  assert.match(criterion, /^SELECT campaign_criterion\.resource_name, /);
  assert.ok(!/\.name\b/.test(criterion), criterion);
});

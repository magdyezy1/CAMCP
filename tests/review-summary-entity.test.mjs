import test from 'node:test';
import assert from 'node:assert/strict';
import {googleReconcileFixture} from './helpers/google-reconcile-fixture.mjs';
import {applyExecutionRisk} from '../dist/src/execution-risk.js';
import {normalizeAccount} from '../dist/src/scope.js';
import {operationOf, reviewSummary} from '../dist/src/review-summary.js';

/**
 * R2.5 package r25-approval-fields (the owner's friction report of 2026-11-25, B6): the review of a Meta ad set update read "Update 1 456 in
 * account 111": the entity was the id the route ends with. A route that ends in the id of the object it edits says what the object is by the
 * collection before it (LinkedIn's `adCampaigns`) or, where there is none (Meta's `/v26.0/456`), by the name of its action. Everything is
 * synthetic and local: nothing is sent.
 */
let tenants = 0;
function compiler(t) {
  const f = googleReconcileFixture({tenant: 'review-entity-' + ++tenants});
  t.after(() => f.store.close());
  const svc = f.service;
  return (gateway, args, account = '123') => {
    const delegated = svc.registry.tools.get(gateway)?.mode === 'delegated',
      input = structuredClone(args);
    if (svc.registry.acceptsArgument(gateway, 'account_id', delegated ? input.operation : undefined)) {
      const id = normalizeAccount(gateway, account);
      if (delegated) input.arguments = {...input.arguments, account_id: id};
      else input.account_id = id;
    }
    svc.registry.validate(gateway, input, svc.options);
    return applyExecutionRisk(
      delegated ? svc.delegatedCompiler.compile(gateway, input) : svc.compiler.compile(gateway, input, svc.options),
    );
  };
}

test('the entity of an edit is what the object is, never the id its route ends with', t => {
  const compile = compiler(t),
    meta = (action, id, field) =>
      compile('meta_native_action', {action, path_params: {[field]: id}, payload: {name: 'Renamed'}}, 'act_111');
  assert.equal(operationOf(meta('meta_ad_set_id_update', '456', 'ad_set_id')).entity, 'ad set');
  assert.equal(operationOf(meta('meta_campaign_id_update', '456', 'campaign_id')).entity, 'campaign');
  assert.equal(operationOf(meta('meta_ad_id_update', '456', 'ad_id')).entity, 'ad');
  assert.equal(
    reviewSummary(meta('meta_ad_set_id_update', '456', 'ad_set_id'), []).text.startsWith(
      'Update 1 ad set in account 111',
    ),
    true,
  );
  assert.equal(
    operationOf(
      compile('linkedin_native_action', {
        action: 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_campaign_id_post',
        path_params: {ad_account_id: '123', campaign_id: '1'},
        restli_method: 'PARTIAL_UPDATE',
        payload: {patch: {$set: {status: 'PAUSED'}}},
      }),
    ).entity,
    'ad campaign',
  );
  // A list of records under a capitalized key (Microsoft) counts its records and names the entity in the singular.
  const two = operationOf(
    compile('microsoft_ads_native_action', {
      action: 'UpdateCampaigns',
      payload: {
        Campaigns: [
          {Id: '1', Status: 'Paused'},
          {Id: '2', Status: 'Paused'},
        ],
      },
    }),
  );
  assert.deepEqual([two.entity, two.count], ['campaign', 2]);
});

test('an entity that was right stays what it was', t => {
  const compile = compiler(t),
    entity = (gateway, args, account) => operationOf(compile(gateway, args, account)).entity;
  assert.equal(
    entity('google_ads_native_action', {
      action: 'UPDATE_CAMPAIGN_BUDGET',
      payload: {
        operations: [
          {
            update: {resource_name: 'customers/123/campaignBudgets/9', amount_micros: '1000000'},
            update_mask: 'amount_micros',
          },
        ],
      },
    }),
    'campaign budget',
  );
  assert.equal(
    entity('tiktok_native_action', {
      action: 'tiktok_adgroup_update',
      payload: {advertiser_id: '123', adgroup_id: '77', budget: 50},
    }),
    'ad group',
  );
  assert.equal(
    entity('snapchat_native_action', {
      action: 'snapchat_campaign_update',
      params: {ad_account_id: '123', campaign_id: 'c1'},
      body: [{op: 'replace', path: '/status', value: 'PAUSED'}],
    }),
    'campaign',
  );
  assert.equal(
    entity('x_ads_native_action', {
      action: 'x_accounts_account_id_campaigns_campaign_id_put',
      params: {account_id: '123', campaign_id: 'c1'},
      payload: {entity_status: 'PAUSED'},
    }),
    'campaign',
  );
  assert.equal(
    entity('apple_ads_native_action', {
      action: 'apple_ads_v1_campaign_update',
      path_params: {id: '1'},
      payload: {status: 'PAUSED'},
    }),
    'campaign',
  );
});

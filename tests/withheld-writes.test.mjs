import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Blocked writes with a known reason say it, in the ledger and in the refusal: two F-58 candidates blocked on evidence,
 * and LinkedIn routes that duplicate an account-scoped route AMCP reviews (Microsoft Learn, li-lms-2026-09).
 */
const registry = new Registry(),
  actor = {tenantId: 'withheld', userId: 'owner', role: 'admin'};
const cases = [
  [
    'linkedin_native_action',
    'linkedin_rest_creatives_post',
    {payload: {}},
    /linkedin_rest_ad_accounts_ad_account_id_creatives_post/,
  ],
  [
    'linkedin_native_action',
    'linkedin_rest_ad_campaigns_post',
    {payload: {}},
    /linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_post/,
  ],
  [
    'x_ads_native_action',
    'x_accounts_account_id_targeting_criteria_targeting_criterion_id_put',
    {params: {targeting_criterion_id: 'dpl3a6'}, payload: {}},
    /delete it and create the new one/,
  ],
  [
    'snapchat_native_action',
    'snapchat_adaccounts_ad_account_id_creatives_creative_id_update',
    {
      account_id: '82225ba6-7559-4000-9663-bace8adff5f2',
      params: {
        ad_account_id: '82225ba6-7559-4000-9663-bace8adff5f2',
        creative_id: '7d4ce4d3-db51-4b9c-8841-0992fc589484',
      },
      payload: {creatives: [{id: '7d4ce4d3-db51-4b9c-8841-0992fc589484', name: 'Creative'}]},
    },
    /snapchat_adaccounts_ad_account_id_creatives_update/,
  ],
  [
    'meta_native_action',
    'meta_ad_account_id_campaigns_delete',
    {account_id: '123', params: {ad_account_id: '123', delete_strategy: 'DELETE_ANY', object_count: 5}},
    /meta_campaign_id_delete/,
  ],
  [
    'tiktok_native_action',
    'tiktok_creative_portfolio_delete',
    {payload: {advertiser_id: '1', creative_portfolio_ids: ['2']}},
    /no delete/,
  ],
  [
    'tiktok_native_action',
    'tiktok_catalog_set_create',
    {payload: {advertiser_id: '1', bc_id: '2', catalog_id: '3', product_set_name: 'Shoes'}},
    /Reporting and Authentication pages without signing in/,
  ],
  [
    'google_ads_native_action',
    'CREATE_CAMPAIGN_BID_MODIFIER',
    {
      account_id: '1234567890',
      params: {customer_id: '1234567890'},
      payload: {operations: [{create: {interactionType: {type: 'CALLS'}, bidModifier: 1.5}}]},
    },
    /Output only.*campaignBidModifiers update and remove/,
  ],
  [
    'dv360_native_action',
    'DV360_ADVERTISERS_LINE_ITEMS_YOUTUBE_ASSET_TYPES_YOUTUBE_ASSET_ASSOCIATIONS_CREATE',
    {
      account_id: null,
      params: {advertiserId: '1', lineItemId: '2', youtubeAssetType: 'YOUTUBE_ASSET_TYPE_LOCATION'},
      body: {},
    },
    /informed subset of users/,
  ],
  [
    'dv360_native_action',
    'DV360_FLOODLIGHT_GROUPS_PATCH',
    {account_id: null, params: {floodlightGroupId: '3', partnerId: '4', updateMask: 'lookbackWindow'}, body: {}},
    /partner context/,
  ],
  [
    'tiktok_native_action',
    'tiktok_catalog_product_upload',
    {payload: {advertiser_id: '1', bc_id: '2', catalog_id: '3', products: []}},
    /Catalog Manager/,
  ],
];

test('the refusal of a withheld write carries its reason, before any request', async () => {
  const store = new Store(':memory:'),
    calls = [],
    service = new MirrorService(
      registry,
      store,
      new NativeTransport(async url => {
        calls.push(String(url));
        throw Error('No network');
      }),
    );
  try {
    for (const [gateway, action, args, reason] of cases) {
      // account_id: null leaves it out, for gateways that name the account in params (DV360's advertiserId).
      const call = Object.fromEntries(Object.entries({action, account_id: '1', ...args}).filter(([, v]) => v !== null));
      const r = await service.call('amcp_write', {action: 'inspect', gateway, arguments: call}, actor);
      assert.equal(r.data?.review_contract_supported ?? false, false, action);
      assert.match(JSON.stringify(r), reason, action + ': ' + JSON.stringify(r).slice(0, 500));
    }
    assert.equal(calls.length, 0);
  } finally {
    store.close();
  }
});

test('the ledger records the same reasons', () => {
  const rows = actionContracts(registry);
  // Business Profile names its writes by operation and action.
  assert.match(
    rows.find(r => r.gateway === 'google_business_native_action' && r.action === 'COMPLETE_VERIFICATION')?.reason ?? '',
    /Account setup, which the owner kept blocked/,
  );
  for (const [gateway, action, , reason] of cases) {
    const row = rows.find(r => r.gateway === gateway && r.action === action);
    assert.equal(row?.status, 'blocked_write', action);
    assert.match(row.reason, reason, action);
  }
});

test("Criteo's supply-side writes say so, in the refusal and the ledger", async () => {
  const store = new Store(':memory:'),
    calls = [],
    service = new MirrorService(
      registry,
      store,
      new NativeTransport(async url => {
        calls.push(String(url));
        throw Error('No network');
      }),
    );
  try {
    const r = await service.call(
      'amcp_write',
      {
        action: 'inspect',
        gateway: 'criteo_native_action',
        arguments: {
          operation: 'criteo_catalog_ops',
          arguments: {
            action: 'UPDATE_KEYWORD_REVIEWS',
            account_id: '123',
            params: {'line-item-id': '456'},
            payload: {data: {attributes: {keywords: [{phrase: 'pasta', reviewState: 'Approved'}]}}},
          },
        },
      },
      actor,
    );
    assert.equal(r.data?.review_contract_supported ?? false, false);
    assert.match(JSON.stringify(r), /retailer reviewer approve or reject/);
    assert.equal(calls.length, 0);
  } finally {
    store.close();
  }
  const rows = actionContracts(registry).filter(r => r.gateway === 'criteo_native_action');
  assert.match(rows.find(r => r.action === 'UPDATE_KEYWORD_REVIEWS').reason, /Supply side/);
  for (const action of [
    'GENERATE_ASYNC_FILL_RATE_REPORT',
    'GENERATE_ASYNC_REVENUE_REPORT',
    'GENERATE_ASYNC_UNFILLED_PLACEMENTS_REPORT',
  ])
    assert.match(rows.find(r => r.action === action).reason, /Supply Side Reporting \(SSP\)/, action);
});

test('the remaining X, Meta, TikTok and LinkedIn candidates carry their reason', async () => {
  const rows = actionContracts(registry);
  const reason = (gateway, action) => {
    const row = rows.find(r => r.gateway === gateway && r.action === action);
    assert.equal(row?.status, 'blocked_write', action);
    return row.reason;
  };
  for (const action of [
    'x_accounts_account_id_do_not_reach_lists_post',
    'x_accounts_account_id_do_not_reach_lists_do_not_reach_list_id_delete',
  ])
    assert.match(reason('x_ads_native_action', action), /Personal data, not yet opened on X/, action);
  for (const action of ['tiktok_optimizer_rule_create', 'tiktok_optimizer_rule_update'])
    assert.match(reason('tiktok_native_action', action), /owner unblocked automated rules/, action);
  assert.match(reason('meta_native_action', 'meta_ad_account_id_recommendations_create'), /recommendation_signature/);
  assert.match(reason('meta_native_action', 'meta_ad_account_id_tracking_create'), /no update or deletion/);
  assert.match(reason('meta_native_action', 'meta_business_id_event_source_groups_create'), /whole business/);
  assert.match(reason('meta_native_action', 'meta_ad_account_id_adpreviews_create'), /generatepreviews/);
  assert.match(reason('meta_native_action', 'meta_user_id_ad_studies_create'), /meta_business_id_ad_studies_create/);
  assert.match(reason('tiktok_native_action', 'tiktok_pixel_track'), /Personal data, not yet opened/);
  assert.match(reason('linkedin_native_action', 'linkedin_rest_example_post'), /placeholder/);
  const tiktok = rows.filter(
    r => r.gateway === 'tiktok_native_action' && r.status === 'blocked_write' && /^Blocked on evidence/.test(r.reason),
  );
  assert.equal(tiktok.length, 42, tiktok.map(r => r.action).join(' '));
  // The refusal says it too, before any request.
  const store = new Store(':memory:'),
    calls = [],
    service = new MirrorService(
      registry,
      store,
      new NativeTransport(async url => {
        calls.push(String(url));
        throw Error('No network');
      }),
    );
  try {
    const r = await service.call(
      'amcp_write',
      {
        action: 'inspect',
        gateway: 'tiktok_native_action',
        arguments: {action: 'tiktok_split_test_create', account_id: '1', payload: {advertiser_id: '1'}},
      },
      actor,
    );
    assert.match(JSON.stringify(r), /Reporting and Authentication pages without signing in/);
    assert.equal(calls.length, 0);
  } finally {
    store.close();
  }
});

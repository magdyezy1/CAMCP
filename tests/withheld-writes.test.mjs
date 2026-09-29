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
      const r = await service.call(
        'amcp_write',
        {action: 'inspect', gateway, arguments: {action, account_id: '1', ...args}},
        actor,
      );
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
  for (const [gateway, action, , reason] of cases) {
    const row = rows.find(r => r.gateway === gateway && r.action === action);
    assert.equal(row?.status, 'blocked_write', action);
    assert.match(row.reason, reason, action);
  }
});

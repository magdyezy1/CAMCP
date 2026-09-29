import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {actionContracts} from '../src/action-contracts.js';
import {retiredProviderActions} from '../src/retired-provider-actions.js';
const registry = new Registry(),
  actor = {tenantId: 'retired', userId: 'reader', role: 'reader' as const};
test('withdrawn GTM methods remain inventoried and fail without provider calls or credential access', async () => {
  const store = new Store(':memory:');
  let calls = 0;
  try {
    const service = new MirrorService(
      registry,
      store,
      new NativeTransport(async () => {
        calls++;
        throw Error('No egress');
      }),
    );
    for (const r of retiredProviderActions.filter(r => r.gateway === 'gtm_native_action')) {
      const args = {
        operation: 'gtm_ops',
        arguments: {
          action: r.action,
          account_id: '44',
          ...(r.action === 'LINK_DESTINATION'
            ? {parent: 'accounts/44/containers/55'}
            : {path: 'accounts/44/containers/55' + (r.action === 'GET_DESTINATION' ? '/destinations/66' : '')}),
        },
      };
      const out = await service.call('gtm_native_action', args, actor);
      assert.equal(out.error.code, 'PROVIDER_ACTION_UNSUPPORTED', JSON.stringify(out));
      assert.equal(out.error.details.source, r.source);
      assert.equal(
        actionContracts(registry).find(a => a.gateway === r.gateway && a.action === r.action)?.status,
        'provider_unsupported',
      );
      if (r.method === 'POST') {
        const inspected = await service.call(
          'amcp_write',
          {action: 'inspect', gateway: r.gateway, arguments: args},
          actor,
        );
        assert.equal(inspected.data.review_contract_supported, false);
        assert.equal(inspected.data.error.code, 'PROVIDER_ACTION_UNSUPPORTED');
      }
    }
    assert.equal(calls, 0);
  } finally {
    store.close();
  }
});
test('unversioned LinkedIn Marketing routes are withdrawn and name their versioned replacement, without a request', async () => {
  // Microsoft Learn "Marketing API migrations" (li-lms-2026-05): unversioned Marketing APIs deprecated 2024-12-16;
  // their current pages document only /rest (dmpSegments, organizationAcls, adAccounts/.../adCampaigns), and the
  // Content APIs replace adCreativesV2.
  const legacy = [
    ['linkedin_v2_ad_campaigns_v2_post', {}],
    ['linkedin_v2_ad_campaigns_v2_campaign_id_post', {path_params: {campaign_id: '1'}}],
    ['linkedin_v2_ad_creatives_v2_post', {}],
    ['linkedin_v2_dmp_segments_post', {}],
    ['linkedin_v2_dmp_segments_segment_id_companies_post', {path_params: {segment_id: '1'}}],
    ['linkedin_v2_dmp_segments_segment_id_users_post', {path_params: {segment_id: '1'}}],
    [
      'linkedin_v2_dmp_segments_segment_id_destinations_destination_id_get',
      {path_params: {segment_id: '1', destination_id: '2'}},
    ],
    [
      'linkedin_v2_dmp_segments_dmp_segment_id_list_uploads_list_id_delete',
      {path_params: {dmp_segment_id: '1', list_id: '2'}},
    ],
    ['linkedin_v2_organizational_entity_acls_get', {}],
    ['linkedin_v2_organizational_entity_acls_post', {}],
  ] as const;
  const store = new Store(':memory:');
  let calls = 0;
  try {
    const service = new MirrorService(
      registry,
      store,
      new NativeTransport(async () => {
        calls++;
        throw Error('No egress');
      }),
    );
    const ledger = actionContracts(registry);
    for (const [action, extra] of legacy) {
      const r = retiredProviderActions.find(r => r.gateway === 'linkedin_native_action' && r.action === action);
      assert.ok(r, action);
      const out = await service.call(
        'linkedin_native_action',
        {action, account_id: '123', ...extra, payload: {}},
        actor,
      );
      assert.equal(out.error?.code, 'PROVIDER_ACTION_UNSUPPORTED', action + ' ' + JSON.stringify(out).slice(0, 300));
      assert.match(
        out.error.details.source,
        /learn\.microsoft\.com\/en-us\/linkedin\/marketing\/integrations\/migrations/,
      );
      // The replacement names catalog actions that exist.
      for (const named of r.replacement!.match(/linkedin_rest_[a-z_]+/g) ?? [])
        assert.ok(
          ledger.some(a => a.action === named),
          action + ' → ' + named,
        );
      assert.equal(
        ledger.find(a => a.gateway === 'linkedin_native_action' && a.action === action)?.status,
        'provider_unsupported',
      );
    }
    // Routes the current documentation still lists under /v2 stay as they are.
    for (const action of ['linkedin_v2_me_get', 'linkedin_v2_geo_geo_id_get', 'linkedin_v2_ugc_posts_get'])
      assert.equal(ledger.find(a => a.action === action)?.status, 'native_read', action);
    assert.equal(calls, 0);
  } finally {
    store.close();
  }
});

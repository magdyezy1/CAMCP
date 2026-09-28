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

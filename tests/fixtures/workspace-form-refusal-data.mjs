import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';

/** Fixed scoped GETs. An explicit second attempt can recover; no provider mutation is accepted. */
export function workspaceFormRefusalFixture(kind, {recovery = true} = {}) {
  assert.ok(['gtm', 'conversions'].includes(kind));
  const owner = {tenantId: 'workspace-form-refusal-' + kind, userId: 'fixture-owner', role: 'admin'},
    keyByte = 168,
    store = new Store(':memory:', Buffer.alloc(32, keyByte).toString('base64')),
    connectionId = kind === 'gtm' ? '22222222-2222-4222-8222-222222222222' : '33333333-3333-4333-8333-333333333333',
    gateway = kind === 'gtm' ? 'gtm_native_action' : 'linkedin_native_action',
    account = kind === 'gtm' ? '44' : '100',
    requests = [],
    input =
      kind === 'gtm'
        ? {action: 'measurement_audit', connection_id: connectionId, account_id: account, requirements: {}}
        : {action: 'measurement_conversions', gateway, connection_id: connectionId, account_id: account};
  store.putConnection(
    owner,
    {
      id: connectionId,
      tenantId: owner.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [],
      enabled: true,
      label: kind === 'gtm' ? 'Synthetic GTM reader' : 'Synthetic LinkedIn conversion reader',
      scopes: kind === 'gtm' ? ['https://www.googleapis.com/auth/tagmanager.readonly'] : ['r_ads'],
    },
    {accessToken: 'synthetic-workspace-form-read-secret'},
  );
  const key = store.createKey({...owner, userId: 'fixture-reader', role: 'viewer'}),
    actor = store.authenticate(key),
    service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(async (raw, init) => {
        const url = new URL(String(raw)),
          phase = recovery ? (requests.length % (kind === 'gtm' ? 3 : 4)) + 1 : 1;
        assert.equal(init.method, 'GET', 'This fixture refuses all provider effects');
        assert.equal(init.body, undefined);
        assert.equal(url.origin, kind === 'gtm' ? 'https://tagmanager.googleapis.com' : 'https://api.linkedin.com');
        assert.equal(
          url.pathname,
          kind === 'gtm'
            ? '/tagmanager/v2/accounts/44' + (phase === 3 ? '/containers' : '')
            : phase === 3
              ? '/rest/conversions'
              : '/rest/adAccounts/100',
        );
        requests.push({method: init.method, path: url.pathname, query: Object.fromEntries(url.searchParams)});
        if (phase === 1)
          return Response.json(
            {
              error: {code: 403, status: 'PERMISSION_DENIED', message: 'Synthetic selected account denial'},
            },
            {status: 403, headers: {'request-id': 'synthetic-workspace-form-native-reference'}},
          );
        if (kind === 'gtm') {
          assert.equal(url.search, '');
          return Response.json(
            phase === 2
              ? {path: 'accounts/44', accountId: '44', name: 'Owned tag account'}
              : {
                  container: ['55', '9007199254740993'].map(containerId => ({
                    path: 'accounts/44/containers/' + containerId,
                    accountId: '44',
                    containerId,
                    name: 'Owned tag container ' + containerId,
                  })),
                },
          );
        }
        if (phase !== 3) return Response.json({id: 100, currency: 'USD', billing: 'PRIVATE-NATIVE-BILLING'});
        assert.deepEqual(Object.fromEntries(url.searchParams), {
          q: 'account',
          account: 'urn:li:sponsoredAccount:100',
          start: '0',
          count: '100',
        });
        return Response.json({
          elements: [
            {
              id: '9007199254740993',
              account: 'urn:li:sponsoredAccount:100',
              name: 'Purchase <img>',
              enabled: true,
              type: 'PURCHASE',
              attributionType: 'LAST_TOUCH_BY_CONVERSION',
              postClickAttributionWindowSize: 30,
              viewThroughAttributionWindowSize: 7,
              valueType: 'FIXED',
              value: {amount: '9007199254740993.123456789', currencyCode: 'USD'},
              imagePixelTag: '<img src="PRIVATE-NATIVE-PIXEL">',
              urlRules: [{matchValue: 'PRIVATE-NATIVE-URL'}],
            },
          ],
          paging: {start: 0, count: 100, total: 1, links: []},
        });
      }),
      undefined,
      {allowWrites: false},
    );
  return {
    owner,
    actor,
    store,
    service,
    key,
    keyByte,
    connectionId,
    input,
    requests,
    kind,
    code: 'PROVIDER_ACCESS_DENIED',
    message: 'Platform returned HTTP 403',
    close: () => store.close(),
  };
}

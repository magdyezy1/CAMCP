import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';

export const conversionMetadataId = '9007199254740993',
  conversionMetadataAmount = '9007199254740993.123456789',
  conversionMetadataConnectionId = '44444444-4444-4444-8444-444444444444',
  conversionMetadataRequest = {
    finder: 'account',
    ownership_selection: 'provider_default_owned',
    shared_rules_requested: false,
  };
export const conversionMetadataRule = (index = 0, extra = {}) => ({
  id: String(BigInt(conversionMetadataId) + BigInt(index)),
  account: 'urn:li:sponsoredAccount:100',
  name: 'Metadata rule <img> ' + index,
  type: 'PURCHASE',
  enabled: false,
  attributionType: 'LAST_TOUCH_BY_CONVERSION',
  postClickAttributionWindowSize: 30,
  viewThroughAttributionWindowSize: 7,
  valueType: 'FIXED',
  value: {amount: conversionMetadataAmount, currencyCode: 'USD'},
  imagePixelTag: '<img src="PRIVATE-NATIVE-METADATA-PIXEL">',
  urlRules: [{matchValue: 'PRIVATE-NATIVE-METADATA-URL'}],
  ...extra,
});
export function conversionMetadataRows(scenario) {
  if (scenario === 'owned')
    return Array.from({length: 51}, (_, i) =>
      conversionMetadataRule(i, {
        conversionMethod: i === 50 ? 'INSIGHT_TAG' : 'CONVERSIONS_API',
        ownershipType: 'OWNED',
      }),
    );
  if (scenario === 'unknown')
    return [
      conversionMetadataRule(0),
      conversionMetadataRule(1, {conversionMethod: 'FUTURE_METHOD_<img>', ownershipType: 'FUTURE_OWNERSHIP_<img>'}),
      conversionMetadataRule(2, {conversionMethod: 'INSIGHT_TAG', ownershipType: 'SHARED'}),
    ];
  if (scenario === 'invalid') return [conversionMetadataRule(0, {conversionMethod: [], ownershipType: 'OWNED'})];
  throw Error('Choose a fixed synthetic metadata scenario');
}
/** Current selected-account configuration; every original provider request is a fixed synthetic GET. */
export function conversionMetadataFixture(scenario = 'owned') {
  const keyByte = 170,
    owner = {tenantId: 'conversion-metadata-' + scenario, userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, keyByte).toString('base64')),
    connection = {
      id: conversionMetadataConnectionId,
      tenantId: owner.tenantId,
      gateway: 'linkedin_native_action',
      accounts: ['100'],
      writeAccounts: [],
      enabled: true,
      label: 'Synthetic LinkedIn conversion metadata reader',
      scopes: ['r_ads'],
    },
    requests = [],
    input = {
      action: 'measurement_conversions',
      gateway: connection.gateway,
      account_id: '100',
      connection_id: connection.id,
    };
  let rows = conversionMetadataRows(scenario),
    afterRead = () => {};
  store.putConnection(owner, connection, {accessToken: 'synthetic-conversion-metadata-secret'});
  const key = store.createKey({...owner, userId: 'reader', role: 'viewer'}),
    actor = store.authenticate(key),
    service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(async (raw, init) => {
        const url = new URL(String(raw)),
          collection = url.pathname === '/rest/conversions';
        assert.equal(url.origin, 'https://api.linkedin.com');
        assert.equal(init.method, 'GET', 'Metadata discovery refuses provider mutations');
        assert.equal(init.body, undefined);
        assert.ok(collection || url.pathname === '/rest/adAccounts/100');
        if (collection)
          assert.deepEqual(Object.fromEntries(url.searchParams), {
            q: 'account',
            account: 'urn:li:sponsoredAccount:100',
            start: '0',
            count: '100',
          });
        else assert.equal(url.search, '');
        requests.push({method: init.method, path: url.pathname, query: Object.fromEntries(url.searchParams)});
        const data = collection
          ? {elements: structuredClone(rows), paging: {start: 0, count: 100, total: rows.length, links: []}}
          : {id: 100, currency: 'USD', billing: 'PRIVATE-NATIVE-METADATA-BILLING'};
        afterRead(url);
        return Response.json(data);
      }),
      undefined,
      {allowWrites: false},
    );
  return {
    scenario,
    owner,
    actor,
    store,
    service,
    key,
    keyByte,
    connection,
    connectionId: connection.id,
    input,
    requests,
    call: (extra = {}) => service.call('amcp_workspace', {...input, ...extra}, actor),
    setRows: value => {
      rows = structuredClone(value);
    },
    onRead: callback => {
      afterRead = callback;
    },
    close: () => store.close(),
  };
}

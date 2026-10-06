import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';

export const reconciliationInput = {
  action: 'portfolio_reconcile',
  gateway: 'google_ads_native_action',
  account_id: '123',
  connection_id: 'synthetic-reconciliation-login',
  requirements: {entity: 'campaign'},
};
export function reconciliationRow(id = '9007199254740993') {
  return {
    customer: {id: '123', resourceName: 'customers/123', currencyCode: 'USD', timeZone: 'UTC'},
    campaign: {
      id,
      resourceName: 'customers/123/campaigns/' + id,
      name: 'Original العربية <img>',
      status: 'PAUSED',
      advertisingChannelType: 'SEARCH',
      campaignBudget: 'customers/123/campaignBudgets/20',
    },
    campaignBudget: {resourceName: 'customers/123/campaignBudgets/20', amountMicros: '9007199254740993'},
    private: 'UNUSED-PRIVATE-INVENTORY-STATE',
  };
}
export const reconciliationRows = () => [
  reconciliationRow(),
  reconciliationRow('9007199254740995'),
  reconciliationRow('9007199254740997'),
];
export function reconciliationFixture(t) {
  const owner = {tenantId: 'synthetic-reconciliation', userId: 'fixture', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 187).toString('base64'));
  const connection = {
    id: reconciliationInput.connection_id,
    tenantId: owner.tenantId,
    gateway: reconciliationInput.gateway,
    enabled: true,
    label: 'Synthetic read-only inventory',
    accounts: ['123'],
    writeAccounts: [],
    scopes: ['https://www.googleapis.com/auth/adwords'],
  };
  const credentials = {accessToken: 'synthetic-reconciliation-secret', developerToken: 'synthetic-developer'};
  store.putConnection(owner, connection, credentials);
  const key = store.createKey({...owner, role: 'reader'}),
    actor = store.authenticate(key),
    requests = [];
  let rows = () => reconciliationRows(),
    edit = (_query, data) => data;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (raw, init) => {
        const url = new URL(String(raw)),
          query = JSON.parse(String(init.body)).query;
        assert.equal(url.origin, 'https://googleads.googleapis.com');
        assert.equal(url.pathname, '/v25/customers/123/googleAds:search');
        assert.equal(init.method, 'POST');
        assert.match(query, / FROM campaign WHERE /);
        requests.push({path: url.pathname, method: init.method, query});
        const all = rows(requests.length),
          after = /campaign.id > ([0-9]+)/.exec(query)?.[1],
          limit = Number(/ LIMIT ([0-9]+)$/.exec(query)[1]);
        const selected = all.filter(row => !after || BigInt(row.campaign.id) > BigInt(after)).slice(0, limit);
        return Response.json(
          edit(query, {results: selected, private: 'UNUSED-PRIVATE-INVENTORY-PAGE'}, requests.length),
        );
      },
      async () => {},
    ),
    undefined,
    {allowWrites: false},
  );
  t?.after(() => store.close());
  return {
    owner,
    store,
    connection,
    credentials,
    key,
    actor,
    requests,
    service,
    rows: fn => {
      rows = fn;
    },
    edit: fn => {
      edit = fn;
    },
    call: (input = reconciliationInput) => service.call('amcp_workspace', input, actor),
    close: () => store.close(),
  };
}

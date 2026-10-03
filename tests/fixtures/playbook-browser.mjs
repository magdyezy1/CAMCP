// In-memory synthetic-only playbook UI qualification; every provider request is refused.
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {createHttpApp} from '../../dist/server/http-app.js';
import {listenForFetch} from '../../dist/tests/http-listener.js';
const port = Number(process.argv[2] ?? 43631),
  origin = 'http://127.0.0.1:' + port;
const masterKey = Buffer.alloc(32, 77).toString('base64'),
  store = new Store(':memory:', masterKey);
const actor = {tenantId: 'local', userId: 'fixture', role: 'admin'};
store.putConnection(
  actor,
  {
    id: 'google-login',
    tenantId: 'local',
    gateway: 'google_ads_native_action',
    accounts: ['123'],
    enabled: true,
    label: 'Synthetic Google login',
    scopes: [],
  },
  {accessToken: 'synthetic'},
);
store.putDocument('local', 'client_profile', 'conversion-reference-qa', {
  name: 'Synthetic conversion reference QA',
  naming: '{{campaign_name}}',
  utm: {utm_campaign: '{{campaign_name}}'},
  defaults: {recipes: {google_search_clicks: {daily_budget: '25', cpc_bid_ceiling: '2.000001'}}},
  variables: {market: 'EG'},
  templates: {},
  bindings: [],
  conversion_mappings: {
    purchase: '9007199254740993',
    lead: 'customers/123/conversionActions/9007199254740995',
    legacy: {id: '001', value: '0012.34'},
    multiline: 'original\nreference',
  },
  approved_by: 'fixture',
  approved_at: Date.now(),
});
const fakeFetch = async () => {
  throw Error('Synthetic playbook browser refuses all provider requests');
};
const service = new MirrorService(new Registry(), store, new NativeTransport(fakeFetch));
const app = createHttpApp(service, store, {
  website: {origin, masterKey, adminPassword: 'synthetic-browser-password', fetcher: fakeFetch, authEnv: {}},
});
const server = await listenForFetch(app, {port});
console.log('Synthetic playbook browser: ' + origin + '/profiles');
const close = () => {
  server.close(() => {
    store.close();
    process.exit(0);
  });
  server.closeAllConnections();
};
process.on('SIGINT', close);
process.on('SIGTERM', close);

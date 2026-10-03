// Local synthetic-only UI qualification. No live provider access, credentials or persistent database.
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {createHttpApp} from '../../dist/server/http-app.js';
import {listenForFetch} from '../../dist/tests/http-listener.js';
import {
  measurementIdentityId,
  measurementIdentityMetadata,
  measurementIdentityReport,
  measurementIdentityRow,
} from './measurement-identity-data.mjs';
const port = Number(process.argv[2] ?? 43630),
  origin = 'http://127.0.0.1:' + port,
  store = new Store(':memory:', Buffer.alloc(32, 76).toString('base64'));
const actor = {tenantId: 'local', userId: 'fixture', role: 'admin'};
store.putConnection(
  actor,
  {
    id: 'aaaaaaaa-1111-4111-8111-111111111111',
    tenantId: actor.tenantId,
    gateway: 'ga4_native_action',
    accounts: ['123'],
    enabled: true,
    label: 'Synthetic GA4 identity',
    scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
  },
  {accessToken: 'synthetic'},
);
let requests = 0;
const fakeFetch = async (raw, init) => {
  const u = new URL(String(raw));
  if (u.hostname !== 'analyticsdata.googleapis.com') throw Error('Synthetic browser refuses unexpected native origins');
  requests++;
  console.log(JSON.stringify({fixture: 'ga4-identity-read', request: requests, method: init.method, path: u.pathname}));
  if (u.pathname === '/v1beta/properties/123/metadata' && init.method === 'GET')
    return Response.json(measurementIdentityMetadata());
  if (u.pathname === '/v1beta/properties/123:runReport' && init.method === 'POST') {
    const body = JSON.parse(String(init.body)),
      testId = body.dimensionFilter?.andGroup?.expressions?.[1]?.filter?.stringFilter?.value;
    if (
      body.dimensions?.[1]?.name !== 'customEvent:amcp_test_id' ||
      body.metrics?.[0]?.name !== 'eventCount' ||
      body.limit !== '1000'
    )
      throw Error('Unexpected synthetic report');
    return Response.json(
      measurementIdentityReport(testId === measurementIdentityId ? [measurementIdentityRow('2')] : []),
    );
  }
  throw Error('Synthetic browser refuses native mutations and unqualified reads');
};
const service = new MirrorService(new Registry(), store, new NativeTransport(fakeFetch));
const app = createHttpApp(service, store, {
  website: {
    origin,
    masterKey: Buffer.alloc(32, 76).toString('base64'),
    adminPassword: 'synthetic-browser-password',
    fetcher: fakeFetch,
    authEnv: {},
  },
});
const server = await listenForFetch(app, {port});
console.log('Synthetic measurement browser: ' + origin + '/measurement');
console.log('Synthetic existing test identifier: ' + measurementIdentityId);
const close = () => {
  server.close(() => {
    store.close();
    process.exit(0);
  });
  server.closeAllConnections();
};
process.on('SIGINT', close);
process.on('SIGTERM', close);

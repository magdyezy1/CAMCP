// Local, in-memory browser fixture. No production data or provider network calls.
// npm run build; node tests/fixtures/reporting-browser.mjs
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {ReportingOverview} from '../../dist/src/reporting-overview.js';
import {ReportWorker} from '../../dist/src/worker.js';
import {createHttpApp} from '../../dist/server/http-app.js';
import {listenForFetch} from '../../dist/tests/http-listener.js';

const port = Number(process.argv[2] ?? 43281),
  origin = 'http://127.0.0.1:' + port;
const store = new Store(':memory:', Buffer.alloc(32, 72).toString('base64'));
const actor = {tenantId: 'local', userId: 'fixture', role: 'admin'},
  sheetTabs = new Map();
let bytes = 0,
  metadataId = 1;
const fixtureFetch = async (raw, init) => {
  const u = new URL(String(raw));
  if (u.hostname === 'sheets.googleapis.com') {
    const id = u.pathname.split('/')[3].split(':')[0];
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      bytes += String(init.body).length;
      for (const r of body.requests ?? []) {
        if (r.addSheet)
          sheetTabs.set(r.addSheet.properties.sheetId, {
            properties: r.addSheet.properties,
            spreadsheet: id,
            developerMetadata: [],
          });
        if (r.createDeveloperMetadata) {
          const m = r.createDeveloperMetadata.developerMetadata;
          sheetTabs.get(m.location.sheetId).developerMetadata.push({...m, metadataId: metadataId++});
        }
        if (r.updateDeveloperMetadata) {
          const wanted = r.updateDeveloperMetadata.dataFilters[0].developerMetadataLookup.metadataId;
          for (const tab of sheetTabs.values())
            for (const m of tab.developerMetadata)
              if (m.metadataId === wanted) Object.assign(m, r.updateDeveloperMetadata.developerMetadata);
        }
      }
      console.log(
        JSON.stringify({
          fixture: 'sheets_batch',
          spreadsheet: id,
          cells: body.requests?.find(r => r.updateCells)?.updateCells.rows.length,
          bytes,
        }),
      );
      return Response.json({spreadsheetId: id, replies: body.requests.map(() => ({}))});
    }
    return Response.json({
      spreadsheetId: id,
      properties: {title: id === 'syntheticSheetA' ? 'Client A spreadsheet' : 'Client B spreadsheet'},
      sheets: [...sheetTabs.values()].filter(s => s.spreadsheet === id),
    });
  }
  if (u.hostname === 'graph.facebook.com') {
    const account = u.pathname.includes('act_200') ? '200' : '100';
    if (!u.pathname.endsWith('/insights'))
      return Response.json({
        id: 'act_' + account,
        name: 'Synthetic client ' + account,
        currency: 'USD',
        timezone_name: 'America/New_York',
      });
    const range = JSON.parse(u.searchParams.get('time_range'));
    return Response.json({
      data: [
        {
          account_id: account,
          campaign_id: account + '01',
          campaign_name: 'Synthetic awareness',
          objective: 'OUTCOME_AWARENESS',
          date_start: range.since,
          date_stop: range.until,
          spend: '42.50',
          impressions: '10000',
          clicks: '85',
          reach: '8000',
          frequency: '1.25',
        },
      ],
    });
  }
  throw Error('Fixture blocked unexpected egress to ' + u.origin + u.pathname);
};
const transport = new NativeTransport(fixtureFetch, async () => {}),
  service = new MirrorService(new Registry(), store, transport, undefined, undefined, fixtureFetch);
store.putConnection(
  actor,
  {
    id: 'meta-fixture',
    tenantId: 'local',
    gateway: 'meta_native_action',
    accounts: ['100', '200'],
    enabled: true,
    label: 'Synthetic Meta login',
    scopes: ['ads_read'],
  },
  {accessToken: 'synthetic'},
);
store.putDocument('local', 'website_assets', 'meta-fixture', {
  groups: [
    {
      kind: 'ad_accounts',
      assets: [
        {id: '100', name: 'Client A advertising'},
        {id: '200', name: 'Client B advertising'},
      ],
    },
  ],
});
store.putConnection(
  actor,
  {
    id: 'sheets-fixture',
    tenantId: 'local',
    gateway: 'google_sheets_native_action',
    accounts: ['syntheticSheetA', 'syntheticSheetB'],
    enabled: true,
    label: 'Synthetic Sheets login',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  },
  {accessToken: 'synthetic'},
);
const app = createHttpApp(service, store, {
  website: {
    origin,
    masterKey: Buffer.alloc(32, 72).toString('base64'),
    adminPassword: 'synthetic-browser-password',
    fetcher: fixtureFetch,
    authEnv: {},
  },
});
const server = await listenForFetch(app, {port}),
  overview = new ReportingOverview(service, fixtureFetch),
  worker = new ReportWorker(
    store,
    async () => {
      throw Error('Unexpected legacy report');
    },
    (t, k, i) => overview.work(t, k, i),
  );
let running = false;
const timer = setInterval(async () => {
  if (running) return;
  running = true;
  try {
    overview.tick();
    await worker.once();
  } catch (e) {
    console.error(e);
  } finally {
    running = false;
  }
}, 500);
console.log('Synthetic reporting fixture: ' + origin + '/reporting-overview');
console.log('Administrator password (fixture only): synthetic-browser-password');
const close = () => {
  clearInterval(timer);
  server.close(() => {
    store.close();
    process.exit(0);
  });
  server.closeAllConnections();
};
process.on('SIGINT', close);
process.on('SIGTERM', close);

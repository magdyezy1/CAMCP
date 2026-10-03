// Retained-record UI fixture only. No provider launch or live report capture occurs.
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {createHttpApp} from '../../dist/server/http-app.js';
import {listenForFetch} from '../../dist/tests/http-listener.js';
import {creativePerformanceCases, seedCreativePerformance} from './creative-performance-data.mjs';
const port = Number(process.argv[2] ?? 43633),
  origin = 'http://127.0.0.1:' + port;
const masterKey = Buffer.alloc(32, 84).toString('base64'),
  store = new Store(':memory:', masterKey);
const actor = {tenantId: 'local', userId: 'fixture', role: 'admin'};
for (const spec of creativePerformanceCases) {
  const data = seedCreativePerformance(store, actor, spec);
  data.report.rows[1].conversion_value = '0';
  if (spec.platform === 'snapchat') {
    data.report.rows[0].reach = '2';
    data.report.rows[0].frequency = '1.230001';
    data.report.rows[1].reach = '0';
    data.report.rows[1].frequency = '0';
  }
  data.put('decision_report', data.reportId, data.report);
}
const fakeFetch = async () => {
  throw Error('Linked-performance fixture refuses every provider request');
};
const service = new MirrorService(new Registry(), store, new NativeTransport(fakeFetch), undefined, {
  allowWrites: true,
  requireBeforeState: true,
  maxBudgetChange: 0,
});
const server = await listenForFetch(
  createHttpApp(service, store, {
    website: {origin, masterKey, adminPassword: 'synthetic-browser-password', fetcher: fakeFetch, authEnv: {}},
  }),
  {port},
);
console.log('Synthetic linked-performance browser: ' + origin + '/media');
const close = () => {
  server.close(() => {
    store.close();
    process.exit(0);
  });
  server.closeAllConnections();
};
process.on('SIGINT', close);
process.on('SIGTERM', close);

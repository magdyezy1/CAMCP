// In-memory synthetic timing observations only. No live traffic, provider calls or owner-setting changes.
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {recordServiceTiming} from '../../dist/src/service-timings.js';
import {createHttpApp} from '../../dist/server/http-app.js';
import {listenForFetch} from '../../dist/tests/http-listener.js';
const port = Number(process.argv[2] ?? 43634),
  origin = 'http://127.0.0.1:' + port;
const masterKey = Buffer.alloc(32, 88).toString('base64'),
  store = new Store(':memory:', masterKey);
for (const [category, values] of [
  ['workspace', [2, 25, 100, 300]],
  ['media', [60001, 80000]],
  ['native_other', [25, 100, 500, 10000]],
])
  for (const [i, ms] of values.entries()) recordServiceTiming(store, 'local', category, ms, i !== 1);
const fakeFetch = async () => {
  throw Error('Synthetic timing fixture refuses every provider request');
};
const service = new MirrorService(new Registry(), store, new NativeTransport(fakeFetch));
const server = await listenForFetch(
  createHttpApp(service, store, {
    website: {origin, masterKey, adminPassword: 'synthetic-browser-password', fetcher: fakeFetch, authEnv: {}},
  }),
  {port},
);
console.log('Synthetic tool-timing browser: ' + origin + '/settings');
const close = () => {
  server.close(() => {
    store.close();
    process.exit(0);
  });
  server.closeAllConnections();
};
process.on('SIGINT', close);
process.on('SIGTERM', close);

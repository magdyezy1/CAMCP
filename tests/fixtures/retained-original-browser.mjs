// In-memory synthetic-only retention UI qualification. No provider request is allowed.
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {createHttpApp} from '../../dist/server/http-app.js';
import {listenForFetch} from '../../dist/tests/http-listener.js';
import {sha256} from '../../dist/src/security.js';
import {SOURCE_TTL_MS} from '../../dist/src/media-sources.js';
const port = Number(process.argv[2] ?? 43632),
  origin = 'http://127.0.0.1:' + port;
const masterKey = Buffer.alloc(32, 82).toString('base64'),
  store = new Store(':memory:', masterKey);
const actor = {tenantId: 'local', userId: 'fixture', role: 'admin'};
store.putConnection(
  actor,
  {
    id: 'meta-login',
    tenantId: 'local',
    gateway: 'meta_native_action',
    accounts: ['100'],
    writeAccounts: ['100'],
    enabled: true,
    scopes: [],
    label: 'Synthetic Meta login',
  },
  {accessToken: 'synthetic'},
);
const source = 'src-22222222-2222-2222-2222-222222222222',
  now = Date.now();
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
store.reserveMediaSource('local', source, now + SOURCE_TTL_MS);
store.stageMedia('local', source, png);
store.putDocument('local', 'media_source', source, {
  user_id: 'fixture',
  filename: 'Synthetic original 9007199254740993.png',
  state: 'complete',
  origin: 'upload',
  size: png.length,
  sha256: sha256(png),
  mime: 'image/png',
  kind: 'image',
  created_at: now,
  expires_at: now + SOURCE_TTL_MS,
  inspection: 'unavailable',
});
const fakeFetch = async () => {
  throw Error('Retention fixture refuses every provider request');
};
const service = new MirrorService(new Registry(), store, new NativeTransport(fakeFetch), undefined, {
  allowWrites: true,
  requireBeforeState: true,
  maxBudgetChange: 0,
});
const app = createHttpApp(service, store, {
  website: {origin, masterKey, adminPassword: 'synthetic-browser-password', fetcher: fakeFetch, authEnv: {}},
});
const server = await listenForFetch(app, {port});
console.log('Synthetic retained-original browser: ' + origin + '/media');
const close = () => {
  server.close(() => {
    store.close();
    process.exit(0);
  });
  server.closeAllConnections();
};
process.on('SIGINT', close);
process.on('SIGTERM', close);

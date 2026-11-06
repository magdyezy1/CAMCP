// AMCP's real HTTP application in a process of its own: a late decoder error that terminates a process terminates this
// one and not the test runner (tests/dependency-security-regressions.test.mjs). A synthetic in-memory store on loopback;
// no provider, Google service or network address is reachable from it.
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {createHttpApp} from '../../dist/server/http-app.js';

const origin = 'https://amcp.example',
  master = Buffer.alloc(32, 94).toString('base64'),
  store = new Store(':memory:', master),
  service = new MirrorService(new Registry(), store),
  app = createHttpApp(service, store, {
    publicOrigin: origin,
    website: {
      origin,
      masterKey: master,
      adminPassword: 'synthetic-fixture-admin-password',
      fetcher: async () => {
        throw Error('The fixture reaches no provider.');
      },
    },
    mcpModernProtocol: 'on',
  }),
  server = app.listen(0, '127.0.0.1', () => process.send({event: 'ready', port: server.address().port}));
process.on('message', message => {
  if (message !== 'stop') return;
  server.close(() => {
    store.close();
    process.disconnect();
  });
  server.closeAllConnections();
});

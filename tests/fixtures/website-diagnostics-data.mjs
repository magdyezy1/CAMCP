import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {createWebsite} from '../../dist/server/website.js';
import {createHttpApp} from '../../dist/server/http-app.js';
import {listenForFetch} from '../../dist/tests/http-listener.js';
export async function websiteDiagnosticFixture({throwLog = false, adminPassword, testPassword} = {}) {
  const key = Buffer.alloc(32, 202).toString('base64'),
    store = new Store(':memory:', key),
    actor = {tenantId: 'synthetic-website-diagnostics', userId: 'seed', role: 'admin'},
    logs = [];
  let nativeReads = 0,
    externalRequests = 0,
    app;
  const blocked = async () => {
    externalRequests++;
    throw Error('Owned website diagnostic fixture refuses egress');
  };
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async () => {
        nativeReads++;
        return blocked();
      },
      async () => {},
      30000,
      8 * 1024 * 1024,
      1000,
      1,
    ),
    undefined,
    {allowWrites: false},
  );
  const listener = await listenForFetch((req, res) => (app ? app(req, res) : res.writeHead(503).end()));
  const origin = 'http://127.0.0.1:' + listener.address().port,
    options = {
      origin,
      masterKey: key,
      tenantId: actor.tenantId,
      adminPassword,
      testPassword,
      authEnv: {},
      fetcher: blocked,
    };
  const {web, accounts} = createWebsite(store, options, false, service),
    user = accounts.newUser('Synthetic diagnostic owner', null, null, true);
  store.db
    .prepare('INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,?,?)')
    .run(actor.tenantId, user.id, 'owner', Date.now());
  const session = accounts.session(user, actor.tenantId);
  app = createHttpApp(service, store, {
    website: options,
    log: entry => {
      if (throwLog) throw Error('Synthetic logger unavailable');
      logs.push(entry);
    },
    clock: () => 1791187200000,
  });
  return {
    origin,
    store,
    service,
    actor,
    logs,
    cookie: {name: web.cookieName, value: session.id, url: origin},
    counts: () => ({nativeReads, externalRequests}),
    evidenceCounts: () => ({
      reports: store.documents(actor.tenantId, 'decision_report').length,
      plans: store.documents(actor.tenantId, 'campaign_plan').length,
      reviews: store.documents(actor.tenantId, 'write_review').length,
      oauth_progress: store.documents(actor.tenantId, 'oauth_progress').length,
    }),
    close: async () => {
      listener.closeAllConnections();
      await new Promise((resolve, reject) => listener.close(error => (error ? reject(error) : resolve())));
      store.close();
    },
  };
}

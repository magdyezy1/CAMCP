import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {createWebsite} from '../../dist/server/website.js';
import {createHttpApp} from '../../dist/server/http-app.js';
import {listenForFetch} from '../../dist/tests/http-listener.js';
import {snapchatAssetUsageFixture} from './snapchat-asset-usage-data.mjs';
import {wooSourceFixture} from './woocommerce-source-data.mjs';
import {catalogComparisonData, catalogComparisonInput} from './catalog-comparison-data.mjs';

/** Owned in-memory website. Every provider response is synthetic; all other egress is refused. */
export async function browserWorkflowSite(kind) {
  assert.ok(['empty', 'snapchat', 'woocommerce', 'catalog'].includes(kind), 'Select a fixed synthetic browser fixture');
  const cleanup = [],
    native = [];
  let refused = 0,
    writes = 0,
    fixture,
    keyByte = 149;
  const blocked = async () => {
    refused++;
    throw Error('Synthetic browser fixture refuses external requests');
  };
  if (kind === 'snapchat') {
    keyByte = 147;
    fixture = snapchatAssetUsageFixture(
      {after: callback => cleanup.push(callback)},
      {asset: {uploaded_sha256: 'e'.repeat(64)}},
    );
  } else if (kind === 'woocommerce') {
    keyByte = 41;
    fixture = wooSourceFixture();
    cleanup.push(fixture.close);
  } else {
    const actor = {tenantId: 'synthetic-browser-' + kind, userId: 'fixture', role: 'admin'},
      store = new Store(':memory:', Buffer.alloc(32, keyByte).toString('base64')),
      data = catalogComparisonData();
    cleanup.push(() => store.close());
    const transport =
      kind === 'catalog'
        ? async (raw, init) => {
            const url = new URL(String(raw));
            if (init.method !== 'GET') writes++;
            assert.equal(init.method, 'GET', 'Browser fixture refuses provider writes');
            assert.equal(url.origin, 'https://graph.facebook.com');
            native.push({method: init.method, path: url.pathname});
            return Response.json(data.response(url));
          }
        : blocked;
    fixture = {
      store,
      actor,
      service: new MirrorService(new Registry(), store, new NativeTransport(transport), undefined, {
        allowWrites: false,
      }),
    };
    if (kind === 'catalog')
      store.putConnection(
        actor,
        {
          id: catalogComparisonInput.connection_id,
          tenantId: actor.tenantId,
          gateway: catalogComparisonInput.gateway,
          accounts: [catalogComparisonInput.account_id],
          writeAccounts: [],
          enabled: true,
          label: 'Synthetic catalog destination',
          scopes: ['ads_read'],
        },
        {accessToken: 'synthetic-browser-catalog'},
      );
  }
  let app;
  const listener = await listenForFetch((req, res) => {
    if (app) app(req, res);
    else res.writeHead(503).end();
  });
  const origin = 'http://127.0.0.1:' + listener.address().port,
    options = {
      origin,
      masterKey: Buffer.alloc(32, keyByte).toString('base64'),
      tenantId: fixture.actor.tenantId,
      authEnv: {},
      fetcher: blocked,
    },
    {web, accounts} = createWebsite(fixture.store, options, false, fixture.service),
    user = accounts.newUser('Synthetic browser reader', null, null, true),
    role = kind === 'empty' ? 'owner' : 'viewer';
  fixture.store.db
    .prepare('INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,?,?)')
    .run(fixture.actor.tenantId, user.id, role, Date.now());
  const session = accounts.session(user, fixture.actor.tenantId);
  app = createHttpApp(fixture.service, fixture.store, {website: options});
  const csv =
    'retailer_id,name,price,currency,image_url\n' +
    catalogComparisonInput.products
      .map(product => [product.retailer_id, product.name, product.price, product.currency, product.image_url].join(','))
      .join('\n') +
    '\n';
  return {
    origin,
    cookie: {name: web.cookieName, value: session.id, url: origin},
    csv: Buffer.from(csv),
    counts: () => ({nativeReads: fixture.requests?.length ?? fixture.calls?.length ?? native.length, refused, writes}),
    close: async () => {
      listener.closeAllConnections();
      await new Promise((resolve, reject) => listener.close(error => (error ? reject(error) : resolve())));
      for (const callback of cleanup.reverse()) await callback();
    },
  };
}

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
import {wooVariationsFixture} from './woocommerce-variations-data.mjs';
import {catalogComparisonData, catalogComparisonInput} from './catalog-comparison-data.mjs';

/** Owned in-memory website. Every provider response is synthetic; all other egress is refused. */
export async function browserWorkflowSite(kind) {
  assert.ok(
    ['empty', 'snapchat', 'woocommerce', 'woocommerce-variations', 'catalog', 'catalog-groups'].includes(kind),
    'Select a fixed synthetic browser fixture',
  );
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
  } else if (kind === 'woocommerce' || kind === 'woocommerce-variations') {
    keyByte = 41;
    fixture = kind === 'woocommerce' ? wooSourceFixture() : wooVariationsFixture();
    cleanup.push(fixture.close);
    if (kind === 'woocommerce-variations')
      fixture.store.putConnection(
        {...fixture.actor, role: 'admin'},
        {
          id: 'meta-login',
          tenantId: fixture.actor.tenantId,
          gateway: 'meta_native_action',
          accounts: ['123'],
          enabled: true,
          label: 'Synthetic Meta destination',
          scopes: [],
        },
        {accessToken: 'synthetic-browser-meta'},
      );
  } else {
    const actor = {tenantId: 'synthetic-browser-' + kind, userId: 'fixture', role: 'admin'},
      store = new Store(':memory:', Buffer.alloc(32, keyByte).toString('base64')),
      data = catalogComparisonData(
        kind === 'catalog-groups'
          ? {
              ...catalogComparisonInput,
              products: catalogComparisonInput.products.map((product, i) => ({
                ...product,
                ...(i === 0 ? {price: '0012.34'} : {}),
                retailer_product_group_id: 'GROUP-' + String(i + 1).padStart(3, '0'),
              })),
            }
          : undefined,
      );
    if (kind === 'catalog-groups') {
      data.products.get('002').retailer_product_group_id = 'OLD-GROUP';
      delete data.products.get('004').retailer_product_group_id;
    }
    cleanup.push(() => store.close());
    const transport =
      kind === 'catalog' || kind === 'catalog-groups'
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
    if (kind === 'catalog' || kind === 'catalog-groups')
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
    'retailer_id,name,price,currency,image_url' +
    (kind === 'catalog-groups' ? ',retailer_product_group_id' : '') +
    '\n' +
    catalogComparisonInput.products
      .map((product, i) =>
        [
          product.retailer_id,
          product.name,
          kind === 'catalog-groups' && i === 0 ? '0012.34' : product.price,
          product.currency,
          product.image_url,
          ...(kind === 'catalog-groups' ? ['GROUP-' + String(i + 1).padStart(3, '0')] : []),
        ].join(','),
      )
      .join('\n') +
    '\n';
  return {
    origin,
    cookie: {name: web.cookieName, value: session.id, url: origin},
    csv: Buffer.from(csv),
    supplierCSV: Buffer.from(
      'SKU,Title,Source price,Currency,Image,Parent group,Private notes\n' +
        catalogComparisonInput.products
          .map((product, i) =>
            [
              product.retailer_id,
              product.name,
              i === 0 ? '0012.34' : product.price,
              product.currency,
              product.image_url,
              'GROUP-' + String(i + 1).padStart(3, '0'),
              'UNSELECTED-PRIVATE-SUPPLIER',
            ].join(','),
          )
          .join('\n') +
        '\n',
    ),
    counts: () => ({nativeReads: fixture.requests?.length ?? fixture.calls?.length ?? native.length, refused, writes}),
    close: async () => {
      listener.closeAllConnections();
      await new Promise((resolve, reject) => listener.close(error => (error ? reject(error) : resolve())));
      for (const callback of cleanup.reverse()) await callback();
    },
  };
}

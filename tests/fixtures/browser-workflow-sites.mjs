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
import {measurementEventReport, measurementEventFixtureConnection} from './measurement-events-data.mjs';
import {retainedEvidence, evidenceId, evidenceConnection} from './retained-evidence-data.mjs';
import {googleKeywordFixture} from './google-keyword-evidence-data.mjs';
import {googleDeviceFixture} from './google-device-evidence-data.mjs';
import {providerCaptureRefusalFixture, providerRefusalMessages} from './provider-capture-refusal-data.mjs';

/** Owned in-memory website. Every provider response is synthetic; all other egress is refused. */
export async function browserWorkflowSite(kind) {
  assert.ok(
    [
      'empty',
      'snapchat',
      'woocommerce',
      'woocommerce-variations',
      'catalog',
      'catalog-groups',
      'measurement-events',
      'retained-evidence',
      'google-keyword',
      'google-keyword-error',
      'google-keyword-stale',
      'google-device',
      'provider-refusal-meta',
      'provider-refusal-linkedin',
      'provider-refusal-tiktok',
      'provider-refusal-snapchat',
    ].includes(kind),
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
  } else if (kind.startsWith('provider-refusal-')) {
    fixture = providerCaptureRefusalFixture(kind.slice('provider-refusal-'.length));
    keyByte = fixture.keyByte;
    cleanup.push(fixture.close);
  } else if (kind === 'google-device') {
    keyByte = 165;
    fixture = googleDeviceFixture();
    cleanup.push(fixture.close);
  } else if (['google-keyword', 'google-keyword-error', 'google-keyword-stale'].includes(kind)) {
    keyByte = 163;
    fixture = googleKeywordFixture();
    if (kind !== 'google-keyword')
      fixture.edit((body, data, count) => {
        const phase = ((count - 1) % 7) + 1;
        assert.equal(/ FROM customer(?: |$)/.test(body.query), [1, 4, 7].includes(phase));
        if (phase === 2) {
          const invalid = structuredClone(data);
          invalid.results[0].adGroupCriterion.keyword.matchType = 'UNKNOWN';
          return invalid;
        }
        return data;
      });
    cleanup.push(fixture.close);
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
      kind === 'measurement-events'
        ? async (raw, init) => {
            const url = new URL(String(raw));
            // The exact GA4 report POST is a read. All event senders and other paths are refused.
            if (
              url.origin !== 'https://analyticsdata.googleapis.com' ||
              url.pathname !== '/v1beta/properties/123:runRealtimeReport' ||
              init.method !== 'POST'
            ) {
              writes++;
              throw Error('Synthetic event fixture refuses provider effects and unqualified reads');
            }
            const body = JSON.parse(String(init.body));
            assert.equal(body.metrics[0].name, 'eventCount');
            assert.equal(body.limit, '1000');
            native.push({method: init.method, path: url.pathname});
            return Response.json(measurementEventReport());
          }
        : kind === 'catalog' || kind === 'catalog-groups'
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
    if (kind === 'measurement-events')
      store.putConnection(
        actor,
        {
          id: measurementEventFixtureConnection,
          tenantId: actor.tenantId,
          gateway: 'ga4_native_action',
          accounts: ['123'],
          writeAccounts: [],
          enabled: true,
          label: 'Synthetic GA4 aggregate reader',
          scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
        },
        {accessToken: 'synthetic-browser-event-read'},
      );
    if (kind === 'retained-evidence') {
      store.putConnection(
        actor,
        {
          id: evidenceConnection,
          tenantId: actor.tenantId,
          gateway: 'google_ads_native_action',
          accounts: ['123'],
          writeAccounts: [],
          enabled: true,
          label: 'Synthetic retained source',
          scopes: ['https://www.googleapis.com/auth/adwords'],
        },
        {accessToken: 'synthetic-browser-retained-read'},
      );
      store.putDocument(actor.tenantId, 'decision_report', evidenceId, retainedEvidence());
    }
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
    captureRefusal: kind.startsWith('provider-refusal-')
      ? {
          provider: kind.slice('provider-refusal-'.length),
          input: fixture.input,
          message: providerRefusalMessages[kind.slice('provider-refusal-'.length)],
        }
      : undefined,
    counts: () => ({nativeReads: fixture.requests?.length ?? fixture.calls?.length ?? native.length, refused, writes}),
    evidenceCounts: () => ({
      reports: fixture.store.documents(fixture.actor.tenantId, 'decision_report').length,
      plans: fixture.store.documents(fixture.actor.tenantId, 'campaign_plan').length,
      reviews: fixture.store.documents(fixture.actor.tenantId, 'write_review').length,
    }),
    close: async () => {
      listener.closeAllConnections();
      await new Promise((resolve, reject) => listener.close(error => (error ? reject(error) : resolve())));
      for (const callback of cleanup.reverse()) await callback();
    },
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {offerParkedProviders} from './helpers/parked-providers.mjs';

// Criteo is parked (ARC-01, P9): this suite exercises it, so it offers it like a
// deployment whose AMCP_PROVIDERS names it.
offerParkedProviders('criteo');

/**
 * Criteo Retail Media catalog requests and exports, API 2026-07 (pinned OpenAPI document, checked 2026-09-27).
 */
const gateway = 'criteo_native_action',
  prefix = '/2026-07/retail-media',
  registry = new Registry(),
  operation = 'criteo_catalog_ops';
const actor = {tenantId: 'criteo-catalogs', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const actions = {
  catalog: 'CATALOG_API_POST_API_V1_EXTERNAL_ACCOUNT_CATALOGS_BY_ACCOUNT_ID',
  sellers: 'CATALOG_POST_API_EXTERNAL_V1_ACCOUNT_CATALOGS_SELLERS_BY_ACCOUNT_ID',
  brandExport: 'CREATE_BRAND_CATALOG_EXPORT',
  sellerExport: 'CREATE_SELLER_CATALOG_EXPORT',
};
const read = ['RetailMedia_Accounts_Read', 'RetailMedia_Campaign_Read'],
  manage = [...read, 'RetailMedia_Campaign_Manage'];
function fixture(scopes = manage) {
  const store = new Store(':memory:', Buffer.alloc(32, 91).toString('base64'));
  store.putConnection(
    owner,
    {
      id: 'criteo',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Criteo',
      scopes,
    },
    {accessToken: 'synthetic'},
  );
  const catalogs = new Map();
  let writes = 0,
    next = 8001,
    mode = '';
  const calls = [];
  const status = (id, v2) => ({
    data: {
      id,
      type: v2 ? 'CatalogStatusV2' : 'CatalogStatus',
      attributes: {
        status: catalogs.get(id),
        createdAt: '2026-09-27T10:00:00Z',
        currency: v2 ? undefined : 'USD',
        fileSizeBytes: null,
        md5Checksum: null,
        message: null,
        rowCount: null,
      },
    },
    errors: [],
    warnings: [],
  });
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        method = init.method;
      calls.push({path: u.pathname, method});
      if (method === 'GET') {
        if (u.pathname === prefix + '/accounts')
          return Response.json({
            data: [
              {id: '123', type: 'RetailMediaAccount', attributes: {name: 'Account', type: 'demand', currency: 'USD'}},
            ],
            metadata: {currentPageIndex: 0, currentPageSize: 2, totalItemsAcrossAllPages: 1, totalPages: 1},
            errors: [],
            warnings: [],
          });
        const m = /^\/2026-07\/retail-media\/catalogs\/(\d+)\/(status|output)$/.exec(u.pathname);
        if (m && catalogs.has(m[1]))
          return m[2] === 'status'
            ? Response.json(status(m[1]))
            : new Response('{"id":"sku1"}\n', {headers: {'content-type': 'application/x-json-stream'}});
        return Response.json({errors: [{code: 'not-found', title: 'Not found'}]}, {status: 404});
      }
      writes++;
      const b = JSON.parse(String(init.body));
      const m =
        /^\/2026-07\/retail-media\/accounts\/123\/(catalogs|catalogs\/sellers|brand-catalog-export|seller-catalog-export)$/.exec(
          u.pathname,
        );
      if (method === 'POST' && m) {
        const id = String(next++);
        if (mode !== 'ignore') catalogs.set(id, mode === 'failure' ? 'failure' : 'pending');
        return Response.json({
          ...status(id, m[1].includes('export')),
          data: {
            ...status(id, m[1].includes('export')).data,
            attributes: {...status(id).data.attributes, status: mode === 'failure' ? 'failure' : 'pending'},
          },
        });
      }
      throw new Error('Unexpected write ' + method + ' ' + u.pathname + ' ' + JSON.stringify(b));
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    10000,
  );
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const prepare = (action, attributes, type) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          operation,
          arguments: {action, account_id: '123', payload: {data: {...(type ? {type} : {}), attributes}}},
        },
      },
      actor,
    );
  const native = (action, catalogId) =>
    service.call(gateway, {operation, arguments: {action, account_id: '123', params: {catalogId}}}, actor);
  const execute = p =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true},
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {
    store,
    calls,
    catalogs,
    prepare,
    native,
    execute,
    verify,
    writes: () => writes,
    mode: m => {
      mode = m;
    },
  };
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('catalog and seller catalog requests are created without spending confirmation and verify pending; their status is then readable natively', async () => {
  const f = fixture(read);
  try {
    const p = ok(
      await f.prepare(actions.catalog, {format: 'json-newline', brandIdFilter: ['1001', '1002']}, 'CatalogRequest'),
    );
    assert.equal(p.data.creative_impact.scope, 'catalog_request');
    assert.equal(p.data.creative_impact.may_affect_serving, false);
    f.catalogs.set('7999', 'success');
    assert.equal((await f.native('GET_CATALOG_STATUS', '7999')).error?.code, 'RESOURCE_SCOPE_REQUIRED');
    ok(await f.execute(p));
    assert.equal(f.writes(), 1);
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes(), 1);
    ok(await f.native('GET_CATALOG_STATUS', '8001'));
    assert.equal((await f.native('GET_CATALOG_STATUS', '7999')).error?.code, 'RESOURCE_SCOPE_REQUIRED');
    const s = ok(
      await f.prepare(actions.sellers, {sellers: [{retailerId: '55', sellerId: 'seller-9'}]}, 'SellerCatalogRequest'),
    );
    ok(await f.execute(s));
    assert.equal(ok(await f.verify(s)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});

test('brand and seller exports need the manage permission and verify pending', async () => {
  const f = fixture();
  try {
    const b = ok(
      await f.prepare(actions.brandExport, {
        brandIdFilter: ['1001'],
        retailerIdFilter: [55],
        includeFields: ['ImageUrl', 'BrandName'],
        modifiedAfter: '2026-01-01T00:00:00Z',
      }),
    );
    ok(await f.execute(b));
    assert.equal(ok(await f.verify(b)).data.status, 'verified');
    const s = ok(
      await f.prepare(actions.sellerExport, {
        sellers: [{retailerId: '55', sellerId: 'seller-9'}],
        includeFields: ['Description'],
      }),
    );
    ok(await f.execute(s));
    assert.equal(ok(await f.verify(s)).data.status, 'verified');
  } finally {
    f.store.close();
  }
  const g = fixture(read);
  try {
    assert.equal((await g.prepare(actions.brandExport, {brandIdFilter: ['1001']})).error?.code, 'INSUFFICIENT_SCOPE');
    assert.equal(g.writes(), 0);
  } finally {
    g.store.close();
  }
});

test('malformed catalog requests are refused before any request', async () => {
  const cases = [
    ['unknown field', actions.catalog, {format: 'json-newline', sellers: []}, 'CatalogRequest'],
    ['other format', actions.catalog, {format: 'csv'}, 'CatalogRequest'],
    ['missing type', actions.catalog, {format: 'json-newline'}, undefined],
    ['text brand', actions.catalog, {brandIdFilter: ['acme']}, 'CatalogRequest'],
    ['repeated brand', actions.catalog, {brandIdFilter: ['1001', '1001']}, 'CatalogRequest'],
    ['empty brand list', actions.catalog, {brandIdFilter: []}, 'CatalogRequest'],
    ['no sellers', actions.sellers, {}, 'SellerCatalogRequest'],
    ['malformed seller', actions.sellers, {sellers: [{retailerId: 'x', sellerId: 's'}]}, 'SellerCatalogRequest'],
    ['zero retailer', actions.brandExport, {retailerIdFilter: [0]}],
    ['unknown field value', actions.brandExport, {includeFields: ['Unknown']}],
    ['future date', actions.sellerExport, {modifiedAfter: '2099-01-01T00:00:00Z'}],
    ['date without time', actions.sellerExport, {modifiedAfter: '2026-01-01'}],
  ];
  for (const [label, action, attributes, type] of cases) {
    const f = fixture();
    try {
      const r = await f.prepare(action, attributes, type);
      assert.equal(r.error?.code, 'INVALID_CRITEO_CATALOG_REQUEST', label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
});

test('a failed request is a failure never resubmitted, an ignored request is not verified, the models match the pinned document and the ledger lists the four writes', async () => {
  const f = fixture();
  try {
    f.mode('failure');
    const p = ok(await f.prepare(actions.catalog, {format: 'json-newline'}, 'CatalogRequest'));
    assert.equal((await f.execute(p)).success, false);
    assert.equal((await f.execute(p)).success, false);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    g.mode('ignore');
    const p = ok(await g.prepare(actions.brandExport, {brandIdFilter: ['1001']}));
    ok(await g.execute(p));
    assert.notEqual(ok(await g.verify(p)).data.status, 'verified');
  } finally {
    g.store.close();
  }
  const d = JSON.parse(readFileSync('.mirror/VENDOR/criteo-retail-2026-07.json', 'utf8')),
    doc = d.document ?? d,
    S = doc.components.schemas;
  assert.deepEqual(Object.keys(S.ExternalCatalogRequest.properties).sort(), ['brandIdFilter', 'format']);
  assert.deepEqual(S.SellerCatalogRequest.required, ['sellers']);
  assert.deepEqual(Object.keys(S.BrandCatalogRequestV2.properties).sort(), [
    'brandIdFilter',
    'includeFields',
    'modifiedAfter',
    'retailerIdFilter',
  ]);
  assert.deepEqual(S.ExternalCatalogStatus.properties.status.enum, [
    'unknown',
    'pending',
    'success',
    'failure',
    'expired',
  ]);
  for (const action of Object.values(actions)) {
    const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.action === action);
    assert.equal(rows.length, 1, action);
    assert.equal(rows[0].status, 'reviewed_write_family', action);
    assert.equal(rows[0].family, 'criteo_catalog_requests', action);
  }
});

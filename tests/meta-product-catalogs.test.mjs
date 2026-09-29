import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Meta product catalogs, opened by the owner on 2026-09-29. Meta's references (read 2026-09-29): "Business Owned Product
 * Catalogs" (create: name required, vertical default commerce, da_display_settings) and "Product Catalog" (update: name,
 * da_display_settings, default_image_url, fallback_image_url; delete: "If the catalog has live product sets, the
 * deletion will be blocked by default").
 */
const gateway = 'meta_native_action',
  registry = new Registry(),
  actor = {tenantId: 'meta-product-catalogs', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const display = {carousel_ad: {transformation_type: 'background_padding'}, single_ad: {transformation_type: 'none'}};
function fixture({scopes = ['ads_management', 'catalog_management']} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 48).toString('base64'));
  store.putConnection(
    owner,
    {
      id: 'm',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Meta',
      scopes,
    },
    {accessToken: 'synthetic'},
  );
  const catalogs = new Map([
    [
      '555',
      {id: '555', name: 'Riyadh shop', vertical: 'commerce', business: {id: '900'}, product_count: 40, feed_count: 1},
    ],
    ['556', {id: '556', name: 'Partner shop', vertical: 'commerce', business: {id: '901'}, product_count: 3}],
    [
      '557',
      {id: '557', name: 'Old shop', vertical: 'commerce', business: {id: '900'}, product_count: 0, feed_count: 0},
    ],
  ]);
  const sets = {555: [{id: '7001', name: 'All'}], 557: []},
    feeds = {555: [{id: '6001', name: 'Daily'}], 557: []};
  const calls = [];
  let writes = 0;
  const gone = () =>
    Response.json({error: {message: 'Unsupported get request.', code: 100, error_subcode: 33}}, {status: 400});
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        path = u.pathname,
        method = init.method;
      const raw = Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
      const b = Object.fromEntries(
        Object.entries(raw).map(([k, v]) => {
          try {
            return [k, JSON.parse(v)];
          } catch {
            return [k, v];
          }
        }),
      );
      calls.push({method, path, query: Object.fromEntries(u.searchParams), body: b});
      if (method === 'GET') {
        if (path === '/v26.0/act_123') return Response.json({id: 'act_123', business: {id: '900'}});
        let m = /^\/v26\.0\/(\d+)\/(product_sets|product_feeds)$/.exec(path);
        if (m) return Response.json({data: (m[2] === 'product_sets' ? sets : feeds)[m[1]] ?? []});
        m = /^\/v26\.0\/(\d+)$/.exec(path);
        if (m && catalogs.has(m[1])) {
          const c = catalogs.get(m[1]);
          // Meta reads fallback_image_url back as a list.
          return Response.json({...c, ...(c.fallback_image_url ? {fallback_image_url: [c.fallback_image_url]} : {})});
        }
        return gone();
      }
      writes++;
      if (method === 'POST' && path === '/v26.0/900/owned_product_catalogs') {
        const id = String(580 + writes);
        catalogs.set(id, {id, vertical: 'commerce', business: {id: '900'}, product_count: 0, ...b});
        return Response.json({id});
      }
      const m = /^\/v26\.0\/(\d+)$/.exec(path);
      if (method === 'POST' && m && catalogs.has(m[1])) {
        Object.assign(catalogs.get(m[1]), b);
        return Response.json({success: true});
      }
      if (method === 'DELETE' && m && catalogs.has(m[1])) {
        catalogs.delete(m[1]);
        return Response.json({success: true});
      }
      throw Error('Unexpected write ' + method + ' ' + path);
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    100,
  );
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const prepare = (action, params, payload) =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action, account_id: '123', params, ...(payload ? {payload} : {})}},
      actor,
    );
  const create = (payload, business = '900') =>
    prepare('meta_business_id_owned_product_catalogs_create', {business_id: business}, payload);
  const update = (catalog, payload) =>
    prepare('meta_product_catalog_id_update', {product_catalog_id: catalog}, payload);
  const remove = (catalog, payload) =>
    prepare('meta_product_catalog_id_delete', {product_catalog_id: catalog}, payload);
  const execute = p =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true},
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, catalogs, create, update, remove, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 1200));
  return r;
};
const refused = (r, code) => assert.equal(r.error?.code, code, JSON.stringify(r).slice(0, 800));

test("a commerce catalog is created under the ad account's business and read back", async () => {
  const f = fixture();
  try {
    const p = ok(await f.create({name: 'Jeddah shop', da_display_settings: display}));
    assert.equal(p.data.creative_impact.creating.vertical, 'commerce');
    ok(await f.execute(p));
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    refused(await f.create({name: 'Elsewhere'}, '901'), 'STATE_TARGET_MISMATCH');
  } finally {
    f.store.close();
  }
});

test('shapes and credentials are refused before any request; the permissions are named', async () => {
  const f = fixture();
  try {
    for (const payload of [
      {name: 'X', vertical: 'hotels'},
      {name: 'X', partner_integration: {external_access_token: 'secret', external_merchant_id: 'm'}},
      {name: 'X', store_catalog_settings: {page_id: '1'}},
      {
        name: 'X',
        da_display_settings: {carousel_ad: {transformation_type: 'stretch'}, single_ad: {transformation_type: 'none'}},
      },
      {name: ''},
    ])
      assert.equal((await f.create(payload)).success, false, JSON.stringify(payload));
    const partner = await f.update('555', {partner_integration: {external_access_token: 'secret'}});
    assert.match(partner.error.message, /credentials never pass through AMCP/);
    assert.doesNotMatch(JSON.stringify(partner), /secret/);
    const force = await f.remove('555', {allow_delete_catalog_with_live_product_set: true});
    refused(force, 'INVALID_META_PRODUCT_CATALOG');
    assert.match(force.error.message, /never sends allow_delete_catalog_with_live_product_set/);
    refused(
      await f.update('555', {default_image_url: 'http://shop.example.test/d.jpg'}),
      'INVALID_META_PRODUCT_CATALOG',
    );
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
  const bare = fixture({scopes: ['ads_management']});
  try {
    refused(await bare.create({name: 'X'}), 'INSUFFICIENT_SCOPE');
  } finally {
    bare.store.close();
  }
});

test('a catalog of the business is updated and read back; other businesses are out of scope', async () => {
  const f = fixture();
  try {
    const p = ok(
      await f.update('555', {
        name: 'Riyadh shop KSA',
        fallback_image_url: 'https://shop.example.test/fallback.jpg',
        da_display_settings: display,
      }),
    );
    assert.equal(p.data.creative_impact.before.name, 'Riyadh shop');
    assert.deepEqual(p.data.creative_impact.after.fallback_image_url, ['https://shop.example.test/fallback.jpg']);
    ok(await f.execute(p));
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    refused(await f.update('555', {name: 'Riyadh shop KSA'}), 'INVALID_META_PRODUCT_CATALOG');
    refused(await f.update('556', {name: 'Mine'}), 'STATE_TARGET_MISMATCH');
    refused(await f.update('999', {name: 'Ghost'}), 'STATE_NOT_FOUND');
  } finally {
    f.store.close();
  }
});

test("a deletion lists the catalog's sets and feeds, leaves Meta's live-set block in place and reads back gone", async () => {
  const f = fixture();
  try {
    const p = ok(await f.remove('555'));
    const impact = p.data.creative_impact;
    assert.deepEqual(impact.product_sets, [{id: '7001', name: 'All'}]);
    assert.deepEqual(impact.feeds, [{id: '6001', name: 'Daily'}]);
    assert.match(impact.warning, /other ad accounts of it may use it.*never overrides that block/);
    ok(await f.execute(p));
    assert.deepEqual(f.calls.find(c => c.method === 'DELETE').body, {});
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    refused(await f.remove('556'), 'STATE_TARGET_MISMATCH');
    assert.deepEqual(
      actionContracts(registry)
        .filter(r => r.family === 'meta_product_catalogs')
        .map(r => r.action)
        .sort(),
      [
        'meta_business_id_owned_product_catalogs_create',
        'meta_product_catalog_id_delete',
        'meta_product_catalog_id_update',
      ],
    );
  } finally {
    f.store.close();
  }
});

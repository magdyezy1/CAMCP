import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Creating and renaming TikTok pixels (request fields from TikTok's official Business API SDK, tiktok/tiktok-business-api-sdk
 * `pixel_create.yml` and `pixel_update.yml`; the pixel list as "Get pixels" documents it, checked 2026-09-26).
 */
const TIKTOK = '39393939-3939-4393-9393-393939393939',
  gateway = 'tiktok_native_action',
  account = '123',
  registry = new Registry();
const actor = {tenantId: 'tiktok-pixels', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 99).toString('base64');
const owned = {ownership_status: true, asset_relation_status: 'OWNER'};
function fixture(mode = '') {
  const store = new Store(':memory:', key);
  store.putConnection(
    owner,
    {
      id: TIKTOK,
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic TikTok',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const pixels = [
    {pixel_id: '7001', pixel_name: 'Store pixel', pixel_code: 'CABC1', asset_ownership: owned},
    {pixel_id: '7002', pixel_name: 'Blog pixel', pixel_code: 'CABC2', asset_ownership: owned},
    {
      pixel_id: '7003',
      pixel_name: 'Partner pixel',
      pixel_code: 'CABC3',
      asset_ownership: {ownership_status: false, asset_relation_status: 'SHARED'},
    },
  ];
  let next = 7100,
    writes = 0,
    n = 0;
  const requests = [];
  const ok = data => Response.json({code: 0, message: 'OK', request_id: 'r' + ++n, data});
  const transport = new NativeTransport(async (raw, init = {}) => {
    const u = new URL(String(raw)),
      path = u.pathname.replace(/^\/open_api/, ''),
      method = init.method ?? 'GET',
      q = k => u.searchParams.get(k);
    requests.push(method + ' ' + path + (q('page') ? ' p' + q('page') : ''));
    if (method === 'GET') {
      assert.equal(q('advertiser_id'), account);
      if (path !== '/v1.3/pixel/list/') throw new Error('Unexpected TikTok read ' + path);
      const page = Number(q('page') || 1),
        served = 2,
        total = mode === 'endless' ? 99 : Math.ceil(pixels.length / served);
      return ok({
        pixels: pixels.slice((page - 1) * served, page * served),
        page_info: {page, page_size: served, total_number: pixels.length, total_page: total},
      });
    }
    const b = JSON.parse(init.body);
    writes++;
    if (mode === 'error')
      return Response.json({code: 40002, message: 'Pixel name is invalid', request_id: 'r' + ++n, data: {}});
    if (path === '/v1.3/pixel/create/') {
      const id = String(next++);
      if (mode !== 'ignore')
        pixels.push({pixel_id: id, pixel_name: b.pixel_name, pixel_code: 'C' + id, asset_ownership: owned});
      return ok(mode === 'noid' ? {} : {pixel_id: id});
    }
    if (path === '/v1.3/pixel/update/') {
      const p = pixels.find(x => x.pixel_id === b.pixel_id);
      if (mode !== 'ignore') p.pixel_name = b.pixel_name;
      return ok({});
    }
    throw new Error('Unexpected TikTok request ' + method + ' ' + path);
  });
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const prepare = (action, payload) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        connection_id: TIKTOK,
        arguments: {action, account_id: account, payload: {advertiser_id: account, ...payload}},
      },
      actor,
    );
  const execute = p =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true},
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, pixels, requests, prepare, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('a new pixel is created after every page of pixels is read, and verifies by its new name', async () => {
  for (const mode of ['', 'noid']) {
    const f = fixture(mode);
    try {
      const p = ok(
        await f.prepare('tiktok_pixel_create', {pixel_name: 'Checkout pixel', pixel_category: 'ONLINE_STORE'}),
      );
      assert.equal(p.data.creative_impact.scope, 'pixel');
      assert.equal(p.data.creative_impact.existing_pixels, 3);
      assert.deepEqual(
        f.requests.filter(r => r.startsWith('GET')),
        ['GET /v1.3/pixel/list/ p1', 'GET /v1.3/pixel/list/ p2'],
      );
      ok(await f.execute(p));
      const v = ok(await f.verify(p));
      assert.equal(v.data.status, 'verified', mode + ': ' + JSON.stringify(v).slice(0, 900));
      assert.equal((await f.execute(p)).data.replayed, true);
      assert.equal(f.writes(), 1);
    } finally {
      f.store.close();
    }
  }
});

test('an owned pixel is renamed and verifies; shared, unknown and unchanged pixels are refused after reading', async () => {
  const f = fixture();
  try {
    const p = ok(await f.prepare('tiktok_pixel_update', {pixel_id: '7002', pixel_name: 'Content pixel'}));
    assert.equal(p.data.creative_impact.operation, 'rename');
    assert.equal(p.data.creative_impact.pixel.pixel_name, 'Blog pixel');
    ok(await f.execute(p));
    assert.equal(f.pixels[1].pixel_name, 'Content pixel');
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    for (const [payload, code] of [
      [{pixel_id: '7003', pixel_name: 'Mine now'}, 'STATE_TARGET_MISMATCH'],
      [{pixel_id: '7999', pixel_name: 'Ghost'}, 'STATE_NOT_FOUND'],
      [{pixel_id: '7001', pixel_name: 'Store pixel'}, 'INVALID_TIKTOK_PIXEL'],
    ])
      assert.equal((await f.prepare('tiktok_pixel_update', payload)).error?.code, code, JSON.stringify(payload));
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('duplicate names and unbounded pixel lists are refused after reading', async () => {
  const f = fixture();
  try {
    const r = await f.prepare('tiktok_pixel_create', {pixel_name: 'store PIXEL'});
    assert.equal(r.error?.code, 'CONFIGURATION_EXISTS', JSON.stringify(r).slice(0, 400));
    assert.equal(r.error.details.pixel_id, '7001');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
  const g = fixture('endless');
  try {
    assert.equal(
      (await g.prepare('tiktok_pixel_create', {pixel_name: 'Checkout pixel'})).error?.code,
      'INCOMPLETE_STATE',
    );
    assert.equal(g.writes(), 0);
  } finally {
    g.store.close();
  }
});

test('malformed requests are refused before any request', async () => {
  for (const [label, action, payload] of [
    ['empty name', 'tiktok_pixel_create', {pixel_name: '  '}],
    ['unknown category', 'tiktok_pixel_create', {pixel_name: 'A', pixel_category: 'SHOP'}],
    ['partner name', 'tiktok_pixel_create', {pixel_name: 'A', partner_name: 'Shopify'}],
    ['other advertiser', 'tiktok_pixel_create', {pixel_name: 'A', advertiser_id: '999'}],
    [
      'advanced matching',
      'tiktok_pixel_update',
      {pixel_id: '7001', pixel_name: 'A', advanced_matching_fields: {email: true}},
    ],
    ['missing pixel', 'tiktok_pixel_update', {pixel_name: 'A'}],
    ['non-numeric pixel', 'tiktok_pixel_update', {pixel_id: 'abc', pixel_name: 'A'}],
  ]) {
    const f = fixture();
    try {
      const r = await f.prepare(action, payload);
      assert.equal(r.success, false, label);
      assert.equal(f.requests.length, 0, label + ': ' + JSON.stringify(r).slice(0, 300));
    } finally {
      f.store.close();
    }
  }
});

test('a TikTok error is never resubmitted, an ignored change is not verified, and the ledger lists both writes', async () => {
  const f = fixture('error');
  try {
    const p = ok(await f.prepare('tiktok_pixel_create', {pixel_name: 'Checkout pixel'}));
    assert.equal((await f.execute(p)).success, false);
    assert.equal((await f.execute(p)).success, false);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
  for (const [action, payload] of [
    ['tiktok_pixel_create', {pixel_name: 'Checkout pixel'}],
    ['tiktok_pixel_update', {pixel_id: '7002', pixel_name: 'Content pixel'}],
  ]) {
    const g = fixture('ignore');
    try {
      const p = ok(await g.prepare(action, payload));
      ok(await g.execute(p));
      assert.notEqual(ok(await g.verify(p)).data.status, 'verified', action);
    } finally {
      g.store.close();
    }
  }
  const rows = actionContracts(registry).filter(
    r => r.gateway === gateway && ['tiktok_pixel_create', 'tiktok_pixel_update'].includes(r.action),
  );
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.status, 'reviewed_write_family', row.action);
    assert.equal(row.family, 'tiktok_pixels');
  }
});

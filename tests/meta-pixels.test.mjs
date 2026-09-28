import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Creating and renaming Meta pixels of an ad account (Marketing API v25.0 "Ad Account Adspixels" and "Ad Pixel",
 * checked 2026-09-27).
 */
const gateway = 'meta_native_action',
  registry = new Registry();
const actor = {tenantId: 'meta-pixels', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const actions = {create: 'meta_ad_account_id_adspixels_create', rename: 'meta_pixel_id_update'};
function fixture(mode = '', scopes = ['ads_management']) {
  const store = new Store(':memory:', Buffer.alloc(32, 101).toString('base64')),
    calls = [];
  let writes = 0,
    next = 705;
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
  const pixels = new Map([
    ['701', {name: 'Store pixel', owner_business: {id: '1001'}}],
    ['702', {name: 'Agency pixel', owner_business: {id: '9009'}}],
    ['703', {name: 'Unclaimed pixel'}],
  ]);
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        path = u.pathname,
        method = init.method;
      calls.push({path, method, query: Object.fromEntries(u.searchParams)});
      if (method === 'GET') {
        if (path === '/v25.0/act_123') {
          assert.equal(u.searchParams.get('fields'), 'id,business');
          return Response.json({id: 'act_123', business: {id: '1001', name: 'Brand'}});
        }
        if (path === '/v25.0/act_123/adspixels') {
          // Two pixels a page, so the review follows the cursor.
          const rows = [...pixels].map(([id, x]) => ({id, ...x})),
            start = u.searchParams.get('after') === 'c2' ? 2 : 0,
            page = rows.slice(start, start + 2),
            more = start + 2 < rows.length;
          return Response.json({
            data: page,
            paging: {
              cursors: {before: 'c0', after: more ? 'c2' : 'end'},
              ...(more ? {next: 'https://graph.facebook.com/v25.0/act_123/adspixels?after=c2'} : {}),
            },
          });
        }
        throw new Error('Unexpected read ' + path);
      }
      writes++;
      const body = Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
      if (mode === 'exists')
        return Response.json({error: {message: 'A pixel already exists for this account', code: 6200}}, {status: 400});
      if (path === '/v25.0/act_123/adspixels') {
        const id = String(next++);
        if (mode !== 'ignore') pixels.set(id, {name: body.name, owner_business: {id: '1001'}});
        return Response.json({id});
      }
      const m = /^\/v25\.0\/(\d+)$/.exec(path);
      if (m && pixels.has(m[1])) {
        if (mode !== 'ignore') pixels.get(m[1]).name = body.name;
        return Response.json({success: true});
      }
      throw new Error('Unexpected write ' + path);
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
  const prepare = (action, params, payload, extra = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {action, account_id: '123', params, ...(payload === undefined ? {} : {payload}), ...extra},
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
  return {store, calls, pixels, prepare, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('a pixel is created and pixels of the business and an unclaimed one are renamed; each verifies and a replay sends nothing', async () => {
  const f = fixture();
  try {
    const c = ok(await f.prepare(actions.create, {ad_account_id: 'act_123'}, {name: 'Web conversions'}));
    assert.equal(c.data.creative_impact.listed_pixels, 3);
    assert.ok(
      f.calls.some(x => x.query.after === 'c2'),
      'the pixel list is paged',
    );
    ok(await f.execute(c));
    assert.equal(f.pixels.get('705').name, 'Web conversions');
    assert.equal(ok(await f.verify(c)).data.status, 'verified');
    assert.equal((await f.execute(c)).data.replayed, true);
    assert.equal(f.writes(), 1);
    for (const id of ['701', '703']) {
      const r = ok(await f.prepare(actions.rename, {pixel_id: id}, {name: 'Renamed ' + id}));
      assert.equal(r.data.creative_impact.pixel.id, id);
      ok(await f.execute(r));
      assert.equal(f.pixels.get(id).name, 'Renamed ' + id);
      assert.equal(ok(await f.verify(r)).data.status, 'verified');
    }
    assert.equal(f.writes(), 3);
  } finally {
    f.store.close();
  }
});

test('customer-data settings and malformed names are refused before any request; pixels of other businesses, unknown pixels and unchanged names after reading', async () => {
  const cases = [
    ['advanced matching', actions.rename, {pixel_id: '701'}, {name: 'X', enable_automatic_matching: true}],
    ['matching fields', actions.rename, {pixel_id: '701'}, {automatic_matching_fields: ['em']}],
    ['data use', actions.rename, {pixel_id: '701'}, {data_use_setting: 'ANALYTICS_ONLY'}],
    [
      'first-party cookies',
      actions.rename,
      {pixel_id: '701'},
      {first_party_cookie_status: 'FIRST_PARTY_COOKIE_DISABLED'},
    ],
    ['101 characters', actions.create, {ad_account_id: 'act_123'}, {name: 'x'.repeat(101)}],
    ['a trailing space', actions.create, {ad_account_id: 'act_123'}, {name: 'Pixel '}],
    ['no name', actions.create, {ad_account_id: 'act_123'}, {}],
  ];
  for (const [label, action, params, payload] of cases) {
    const f = fixture();
    try {
      const r = await f.prepare(action, params, payload);
      assert.equal(r.error?.code, 'INVALID_META_PIXEL', label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    assert.equal(
      (await f.prepare(actions.rename, {pixel_id: '702'}, {name: 'Mine now'})).error?.code,
      'STATE_TARGET_MISMATCH',
    );
    assert.equal((await f.prepare(actions.rename, {pixel_id: '799'}, {name: 'Ghost'})).error?.code, 'STATE_NOT_FOUND');
    assert.equal(
      (await f.prepare(actions.rename, {pixel_id: '701'}, {name: 'Store pixel'})).error?.code,
      'INVALID_META_PIXEL',
    );
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
  const g = fixture('', ['ads_read']);
  try {
    assert.equal(
      (await g.prepare(actions.rename, {pixel_id: '701'}, {name: 'Renamed'})).error?.code,
      'INSUFFICIENT_SCOPE',
    );
  } finally {
    g.store.close();
  }
});

test('a refused creation is never resubmitted, an ignored change is not verified, and the ledger lists both rows', async () => {
  const e = fixture('exists');
  try {
    const p = ok(await e.prepare(actions.create, {ad_account_id: 'act_123'}, {name: 'Second pixel'}));
    assert.equal((await e.execute(p)).success, false);
    assert.equal((await e.execute(p)).success, false);
    assert.equal(e.writes(), 1);
  } finally {
    e.store.close();
  }
  const g = fixture('ignore');
  try {
    const r = ok(await g.prepare(actions.rename, {pixel_id: '701'}, {name: 'Renamed'}));
    ok(await g.execute(r));
    assert.notEqual(ok(await g.verify(r)).data.status, 'verified');
    const c = ok(await g.prepare(actions.create, {ad_account_id: 'act_123'}, {name: 'Lost pixel'}));
    ok(await g.execute(c));
    assert.notEqual(ok(await g.verify(c)).data.status, 'verified');
  } finally {
    g.store.close();
  }
  const rows = actionContracts(registry).filter(r => r.gateway === gateway);
  for (const action of Object.values(actions)) {
    const row = rows.find(r => r.action === action);
    assert.equal(row?.status, 'reviewed_write_family', action);
    assert.equal(row.family, 'meta_pixels', action);
  }
});

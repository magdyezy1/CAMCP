import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Renaming and deleting TikTok custom conversions (API for Business v1.3, checked 2026-09-27). Both requests name only the
 * conversion, so the review finds its pixel among the advertiser's pixels (20 per page).
 */
const TIKTOK = '33333333-3333-4333-8333-333333333334',
  gateway = 'tiktok_native_action',
  account = '123',
  registry = new Registry();
const actions = {update: 'tiktok_custom_conversion_update', remove: 'tiktok_custom_conversion_delete'};
const actor = {tenantId: 'tiktok-conversion-edits', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 92).toString('base64');
function fixture(mode = '') {
  const store = new Store(':memory:', key),
    connection = {
      id: TIKTOK,
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic TikTok',
      scopes: [],
    };
  store.putConnection(owner, connection, {accessToken: 'synthetic'});
  // The server pages pixels two at a time, so the conversion of pixel 720 is found only on the second page.
  const pixels = ['700', '705', '720'];
  const conversions = new Map([
    ['9001', {pixel: '700', name: 'Checkout over 50', description: 'Big baskets', optimization_event: 'SHOPPING'}],
    ['9002', {pixel: '720', name: 'Signup email', description: '', optimization_event: 'ON_WEB_REGISTER'}],
    ['9003', {pixel: '705', name: 'Used conversion', description: '', optimization_event: 'SHOPPING'}],
  ]);
  const adgroups = [
    {adgroup_id: '301', adgroup_name: 'Optimizes 9003', custom_conversion_id: '9003'},
    {adgroup_id: '302', adgroup_name: 'Plain'},
  ];
  let writes = 0,
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
      const page = Number(q('page')),
        size = Number(q('page_size'));
      if (path === '/v1.3/pixel/list/') {
        const served = 2,
          rows = pixels
            .slice((page - 1) * served, page * served)
            .map(pixel_id => ({pixel_id, pixel_name: 'Pixel ' + pixel_id, pixel_code: 'C' + pixel_id}));
        return ok({
          pixels: rows,
          page_info: {
            page,
            page_size: served,
            total_number: pixels.length,
            total_page: Math.ceil(pixels.length / served),
          },
        });
      }
      if (path === '/v1.3/custom_conversion/list/') {
        assert.equal(q('event_source_type'), 'PIXEL');
        const list = [...conversions]
          .filter(([, c]) => c.pixel === q('event_source_id'))
          .map(([id, c]) => ({
            custom_conversion_id: id,
            event_source_type: 'PIXEL',
            event_source_id: c.pixel,
            name: c.name,
            description: c.description,
            optimization_event: c.optimization_event,
            activity_status: 'ACTIVE',
          }));
        return ok({list, page_info: {page, page_size: size, total_number: list.length, total_page: 1}});
      }
      if (path === '/v1.3/adgroup/get/')
        return ok({
          list: adgroups.map(g => ({advertiser_id: account, ...g})),
          page_info: {page, page_size: size, total_number: adgroups.length, total_page: 1},
        });
      throw new Error('Unexpected TikTok read ' + path);
    }
    const b = JSON.parse(init.body);
    writes++;
    if (mode === 'error')
      return Response.json({code: 40002, message: 'Duplicate name', request_id: 'r' + ++n, data: {}});
    if (path === '/v1.3/custom_conversion/update/') {
      if (mode !== 'ignore') {
        const c = conversions.get(b.custom_conversion_id);
        if (b.name !== undefined) c.name = b.name;
        if (b.description !== undefined) c.description = b.description;
      }
      return ok({});
    }
    if (path === '/v1.3/custom_conversion/delete/') {
      if (mode !== 'ignore') conversions.delete(b.custom_conversion_id);
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
  return {store, conversions, requests, prepare, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('a conversion found on the second pixel page is renamed and one is re-described, each verified; an unused one is deleted and verifies gone; a replay sends nothing', async () => {
  const f = fixture();
  try {
    const u = ok(await f.prepare(actions.update, {custom_conversion_id: '9002', name: 'Signup any method'}));
    assert.ok(f.requests.includes('GET /v1.3/pixel/list/ p2'), 'the pixel list is paged');
    assert.equal(u.data.creative_impact.conversion.pixel_id, '720');
    ok(await f.execute(u));
    assert.equal(f.conversions.get('9002').name, 'Signup any method');
    assert.equal(ok(await f.verify(u)).data.status, 'verified');
    assert.equal((await f.execute(u)).data.replayed, true);
    assert.equal(f.writes(), 1);
    const d = ok(await f.prepare(actions.update, {custom_conversion_id: '9001', description: 'Baskets over 50'}));
    ok(await f.execute(d));
    assert.equal(ok(await f.verify(d)).data.status, 'verified');
    const r = ok(await f.prepare(actions.remove, {custom_conversion_id: '9001'}));
    assert.equal(r.data.creative_impact.conversion.name, 'Checkout over 50');
    ok(await f.execute(r));
    assert.equal(f.conversions.has('9001'), false);
    assert.equal(ok(await f.verify(r)).data.status, 'verified');
    assert.equal(f.writes(), 3);
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    saveSpendPolicy(g.store, owner, {gateway, account_id: account, confirmed: true, policy: {allow_deletion: false}});
    assert.equal(
      (await g.prepare(actions.remove, {custom_conversion_id: '9001'})).error?.code,
      'POLICY_DELETION_FORBIDDEN',
    );
    ok(await g.prepare(actions.update, {custom_conversion_id: '9001', name: 'Still fine'}));
  } finally {
    g.store.close();
  }
});

test('malformed edits are refused before any request; unknown, taken, unchanged and used conversions after reading', async () => {
  const cases = [
    ['another advertiser', {advertiser_id: '999', custom_conversion_id: '9001', name: 'X y'}],
    ['a non-numeric id', {custom_conversion_id: 'abc', name: 'X y'}],
    ['nothing to change', {custom_conversion_id: '9001'}],
    ['a name starting with a digit', {custom_conversion_id: '9001', name: '1st checkout'}],
    ['a standard event name', {custom_conversion_id: '9001', name: 'Add to Cart'}],
    ['a long name', {custom_conversion_id: '9001', name: 'N' + 'x'.repeat(50)}],
    ['a rule change', {custom_conversion_id: '9001', rules: []}],
    ['emoji in the description', {custom_conversion_id: '9001', description: 'Great 🎉'}],
  ];
  for (const [label, payload] of cases) {
    const f = fixture();
    try {
      const r = await f.prepare(actions.update, payload);
      assert.ok(
        ['INVALID_TIKTOK_CUSTOM_CONVERSION_EDIT', 'ACCOUNT_SCOPE_MISMATCH'].includes(r.error?.code),
        label + ': ' + JSON.stringify(r).slice(0, 300),
      );
      assert.equal(f.requests.length, 0, label);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    assert.equal(
      (await f.prepare(actions.update, {custom_conversion_id: '9999', name: 'Unknown'})).error?.code,
      'STATE_NOT_FOUND',
    );
    assert.equal(
      (await f.prepare(actions.update, {custom_conversion_id: '9001', name: 'Signup email'})).error?.code,
      'CONFIGURATION_EXISTS',
    );
    assert.equal(
      (
        await f.prepare(actions.update, {
          custom_conversion_id: '9001',
          name: 'Checkout over 50',
          description: 'Big baskets',
        })
      ).error?.code,
      'INVALID_TIKTOK_CUSTOM_CONVERSION_EDIT',
    );
    const used = await f.prepare(actions.remove, {custom_conversion_id: '9003'});
    assert.equal(used.error?.code, 'CUSTOM_CONVERSION_IN_USE');
    assert.deepEqual(used.error.details.adgroups, ['301']);
    assert.equal((await f.prepare(actions.remove, {custom_conversion_id: '9999'})).error?.code, 'STATE_NOT_FOUND');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('an error reply is never resubmitted, ignored edits are not verified, and the ledger lists both writes', async () => {
  const e = fixture('error');
  try {
    const p = ok(await e.prepare(actions.update, {custom_conversion_id: '9001', name: 'New name'}));
    assert.equal((await e.execute(p)).success, false);
    assert.equal((await e.execute(p)).success, false);
    assert.equal(e.writes(), 1);
  } finally {
    e.store.close();
  }
  const g = fixture('ignore');
  try {
    for (const p of [
      ok(await g.prepare(actions.update, {custom_conversion_id: '9001', name: 'New name'})),
      ok(await g.prepare(actions.remove, {custom_conversion_id: '9002'})),
    ]) {
      ok(await g.execute(p));
      assert.notEqual(ok(await g.verify(p)).data.status, 'verified');
    }
  } finally {
    g.store.close();
  }
  for (const action of Object.values(actions)) {
    const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.action === action);
    assert.equal(rows.length, 1, action);
    assert.equal(rows[0].status, 'reviewed_write_family', action);
    assert.equal(rows[0].family, 'tiktok_custom_conversion_edits', action);
  }
});

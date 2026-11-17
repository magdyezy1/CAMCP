import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * Deleting TikTok saved audiences and custom identities (API for Business v1.3, checked 2026-09-27).
 */
const TIKTOK = '34343434-3434-4343-8343-343434343434',
  gateway = 'tiktok_native_action',
  account = '123',
  registry = new Registry();
const actions = {audience: 'tiktok_dmp_saved_audience_delete', identity: 'tiktok_identity_delete'};
const actor = {tenantId: 'tiktok-deletions', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 93).toString('base64');
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
  const audiences = new Map([
    ['501', {saved_audience_name: 'Women 25-34'}],
    ['502', {saved_audience_name: 'Gamers'}],
    ['503', {saved_audience_name: 'Used by ad group'}],
  ]);
  // Identities are served two per page, so the second page must be read.
  const identities = new Map([
    ['id-a', {display_name: 'Brand A', identity_type: 'CUSTOMIZED_USER'}],
    ['id-b', {display_name: 'Brand B', identity_type: 'CUSTOMIZED_USER'}],
    ['id-used', {display_name: 'Brand used', identity_type: 'CUSTOMIZED_USER'}],
  ]);
  const adgroups = [{adgroup_id: '301', saved_audience_id: '503'}, {adgroup_id: '302'}],
    ads = [
      {ad_id: '401', identity_id: 'id-used', identity_type: 'CUSTOMIZED_USER'},
      {ad_id: '402', identity_id: 'id-b', identity_type: 'TT_USER'},
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
      const page = Number(q('page') || 1),
        size = Number(q('page_size') || 20);
      if (path === '/v1.3/dmp/saved_audience/list/') {
        const ids = JSON.parse(q('saved_audience_ids'));
        return ok({
          saved_audiences: [...audiences]
            .filter(([id]) => ids.includes(id))
            .map(([saved_audience_id, a]) => ({saved_audience_id, ...a, gender: 'GENDER_UNLIMITED'})),
          page_info: {page: 1, page_size: 20, total_number: ids.length, total_page: 1},
        });
      }
      if (path === '/v1.3/identity/get/') {
        assert.equal(q('identity_type'), 'CUSTOMIZED_USER');
        const served = 2,
          rows = [...identities]
            .slice((page - 1) * served, page * served)
            .map(([identity_id, i]) => ({identity_id, ...i}));
        return ok({
          identity_list: rows,
          page_info: {
            page,
            page_size: served,
            total_number: identities.size,
            total_page: Math.ceil(identities.size / served),
          },
        });
      }
      if (path === '/v1.3/adgroup/get/')
        return ok({
          list: adgroups.map(g => ({advertiser_id: account, ...g})),
          page_info: {page, page_size: size, total_number: adgroups.length, total_page: 1},
        });
      if (path === '/v1.3/ad/get/')
        return ok({
          list: ads.map(a => ({advertiser_id: account, ...a})),
          page_info: {page, page_size: size, total_number: ads.length, total_page: 1},
        });
      throw new Error('Unexpected TikTok read ' + path);
    }
    const b = JSON.parse(init.body);
    writes++;
    if (mode === 'error') return Response.json({code: 40002, message: 'In use', request_id: 'r' + ++n, data: {}});
    if (path === '/v1.3/dmp/saved_audience/delete/') {
      if (mode !== 'ignore') for (const id of b.saved_audience_ids) audiences.delete(id);
      return ok({});
    }
    if (path === '/v1.3/identity/delete/') {
      if (mode !== 'ignore') identities.delete(b.identity_id);
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
  return {store, audiences, identities, requests, prepare, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('unused saved audiences and an unused custom identity found on the second page are deleted and verify gone; a replay sends nothing; owner deletion rules apply', async () => {
  const f = fixture();
  try {
    const a = ok(await f.prepare(actions.audience, {saved_audience_ids: ['502', '501']}));
    assert.equal(a.data.creative_impact.scope, 'saved_audiences');
    assert.equal(a.data.creative_impact.deleting.length, 2);
    ok(await f.execute(a));
    assert.equal(f.audiences.size, 1);
    assert.equal(ok(await f.verify(a)).data.status, 'verified');
    assert.equal((await f.execute(a)).data.replayed, true);
    assert.equal(f.writes(), 1);
    const i = ok(await f.prepare(actions.identity, {identity_id: 'id-b', identity_type: 'CUSTOMIZED_USER'}));
    assert.ok(f.requests.includes('GET /v1.3/identity/get/ p2'), 'the identity list is paged');
    ok(await f.execute(i));
    assert.equal(f.identities.has('id-b'), false);
    assert.equal(ok(await f.verify(i)).data.status, 'verified');
    assert.equal(f.writes(), 2);
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    saveSpendPolicy(g.store, owner, {gateway, account_id: account, confirmed: true, policy: {allow_deletion: false}});
    assert.equal(
      (await g.prepare(actions.audience, {saved_audience_ids: ['501']})).error?.code,
      'POLICY_DELETION_FORBIDDEN',
    );
  } finally {
    g.store.close();
  }
});

test('malformed deletions are refused before any request; unknown and used audiences and identities after reading', async () => {
  const cases = [
    ['another advertiser', actions.audience, {advertiser_id: '999', saved_audience_ids: ['501']}],
    ['empty list', actions.audience, {saved_audience_ids: []}],
    ['an ID twice', actions.audience, {saved_audience_ids: ['501', '501']}],
    ['101 audiences', actions.audience, {saved_audience_ids: Array.from({length: 101}, (_, i) => String(1000 + i))}],
    ['a TikTok account identity', actions.identity, {identity_id: 'id-a', identity_type: 'TT_USER'}],
    ['another field', actions.identity, {identity_id: 'id-a', identity_type: 'CUSTOMIZED_USER', display_name: 'X'}],
  ];
  for (const [label, action, payload] of cases) {
    const f = fixture();
    try {
      const r = await f.prepare(action, payload);
      assert.ok(
        ['INVALID_TIKTOK_DELETION', 'ACCOUNT_SCOPE_MISMATCH'].includes(r.error?.code),
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
      (await f.prepare(actions.audience, {saved_audience_ids: ['501', '599']})).error?.code,
      'STATE_NOT_FOUND',
    );
    const used = await f.prepare(actions.audience, {saved_audience_ids: ['503']});
    assert.equal(used.error?.code, 'AUDIENCE_IN_USE');
    assert.deepEqual(used.error.details.in_use, {'503': ['301']});
    assert.equal(
      (await f.prepare(actions.identity, {identity_id: 'id-zzz', identity_type: 'CUSTOMIZED_USER'})).error?.code,
      'STATE_NOT_FOUND',
    );
    const busy = await f.prepare(actions.identity, {identity_id: 'id-used', identity_type: 'CUSTOMIZED_USER'});
    assert.equal(busy.error?.code, 'IDENTITY_IN_USE');
    assert.deepEqual(busy.error.details.in_use, {'id-used': ['401']});
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('an error reply is never resubmitted, ignored deletions are not verified, and the ledger lists both writes', async () => {
  const e = fixture('error');
  try {
    const p = ok(await e.prepare(actions.audience, {saved_audience_ids: ['501']}));
    assertRefused(await e.execute(p), 'PLATFORM_ERROR');
    // r25-m2-refusal (Q16): code 40002 with no data in an HTTP 200 answer is a refusal TikTok’s return-code table defines, so the
    // review is rejected and its key retired (WRITE_REJECTED), not uncertain. It is still never sent again.
    assertRefused(await e.execute(p), 'WRITE_REJECTED');
    assert.equal(e.writes(), 1);
  } finally {
    e.store.close();
  }
  const g = fixture('ignore');
  try {
    for (const p of [
      ok(await g.prepare(actions.audience, {saved_audience_ids: ['501']})),
      ok(await g.prepare(actions.identity, {identity_id: 'id-a', identity_type: 'CUSTOMIZED_USER'})),
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
    assert.equal(rows[0].family, 'tiktok_deletions', action);
  }
});

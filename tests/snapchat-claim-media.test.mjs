import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Claiming organic Snaps into an ad account, Snap's "Claim Media" page (read 2026-09-30): POST
 * /v1/adaccounts/{ad_account_id}/claim_media_by_snap_reference?snap_id={snap_id} answers a media_entity_id; "Callers must
 * have permissions to both the target ad account and Snap"; GET /v1/media/{media_id} shows the media and its
 * media_status (READY, or PENDING_UPLOAD).
 */
const gateway = 'snapchat_native_action',
  registry = new Registry(),
  actor = {tenantId: 'snap-claim', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const ACCT = 'acct-claim',
  SNAP = 'W7_EDlXWTBiXAEEniNoMPwAAYZXJwdnd1YWloAYu1RnTVAYu1RnRGAAAAAQ';
function fixture({claimedInto = ACCT} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 93).toString('base64')),
    calls = [];
  let writes = 0;
  store.putConnection(
    owner,
    {
      id: 'snap',
      tenantId: actor.tenantId,
      gateway,
      accounts: [ACCT],
      writeAccounts: [ACCT],
      enabled: true,
      label: 'Synthetic Snapchat',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const media = new Map();
  const transport = new NativeTransport(async (url, init) => {
    const u = new URL(String(url)),
      path = u.pathname,
      method = init?.method ?? 'GET';
    calls.push({
      path,
      method,
      query: Object.fromEntries(u.searchParams),
      body: init?.body ? String(init.body) : undefined,
    });
    if (method === 'GET' && path === '/v1/adaccounts/' + ACCT)
      return Response.json({
        request_status: 'SUCCESS',
        adaccounts: [{sub_request_status: 'SUCCESS', adaccount: {id: ACCT, organization_id: 'org-1', name: 'Brand'}}],
      });
    const m = /^\/v1\/media\/([\w-]+)$/.exec(path);
    if (method === 'GET' && m)
      return media.has(m[1])
        ? Response.json({request_status: 'SUCCESS', media: [{sub_request_status: 'SUCCESS', media: media.get(m[1])}]})
        : Response.json({request_status: 'ERROR', debug_message: 'Not found'}, {status: 404});
    if (method === 'POST' && path === '/v1/adaccounts/' + ACCT + '/claim_media_by_snap_reference') {
      writes++;
      const id = 'claimed-' + writes;
      media.set(id, {id, ad_account_id: claimedInto, type: 'VIDEO', media_status: 'PENDING_UPLOAD', name: 'Snap'});
      return Response.json({request_status: 'SUCCESS', request_id: 'r' + writes, media_entity_id: id});
    }
    throw new Error('Unexpected ' + method + ' ' + path);
  });
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const prepare = (action, args) =>
    service.call('amcp_write', {action: 'prepare', gateway, arguments: {action, account_id: ACCT, ...args}}, actor);
  const execute = p =>
    service.call('amcp_write', {action: 'execute', review_id: p.data.review_id, confirmed: true}, actor);
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, prepare, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success ?? true, true, JSON.stringify(r).slice(0, 1500));
  assert.equal(r.error, undefined, JSON.stringify(r).slice(0, 1500));
  return r;
};
const byQuery = {params: {ad_account_id: ACCT, snap_id: SNAP}},
  byBag = {params: {ad_account_id: ACCT}, query: {snap_id: SNAP}};

test('a Snap is claimed into the selected ad account and its new media is read back', async () => {
  const f = fixture();
  const p = ok(await f.prepare('snapchat_adaccounts_ad_account_id_claim_media_by_snap_reference_create', byQuery));
  const impact = JSON.stringify(p.data.creative_impact);
  assert.match(impact, /media library/);
  assert.match(impact, /Nothing serves/);
  ok(await f.execute(p));
  const post = f.calls.find(c => c.method === 'POST');
  assert.deepEqual(post.query, {snap_id: SNAP});
  const v = ok(await f.verify(p));
  assert.equal(v.data.status, 'verified');
  // The same route under its second catalog name.
  const q = ok(await f.prepare('snapchat_adaccounts_ad_account_id_claim_media_by_snap_reference_create_2', byBag));
  ok(await f.execute(q));
  assert.equal(f.writes(), 2);
});

test('only a Snap ID, only the selected account; media claimed elsewhere does not verify', async () => {
  const f = fixture();
  const action = 'snapchat_adaccounts_ad_account_id_claim_media_by_snap_reference_create';
  const second = 'snapchat_adaccounts_ad_account_id_claim_media_by_snap_reference_create_2';
  for (const [name, args] of [
    [action, {params: {ad_account_id: ACCT, snap_id: 'bad id!'}}],
    [second, {params: {ad_account_id: ACCT}}],
    [action, {...byQuery, payload: {name: 'x'}}],
    [second, {params: {ad_account_id: ACCT}, query: {snap_id: SNAP, other: '1'}}],
  ]) {
    const r = await f.prepare(name, args);
    assert.equal(r.error?.code, 'INVALID_SNAPCHAT_CLAIM_MEDIA', JSON.stringify(r).slice(0, 600));
  }
  assert.equal(f.writes(), 0);
  const g = fixture({claimedInto: 'someone-else'});
  const p = ok(await g.prepare(action, byQuery));
  ok(await g.execute(p));
  assert.notEqual((await g.verify(p)).data?.status, 'verified');
});

test('the ledger records the family and the reasons of the remaining Snapchat candidates', () => {
  const rows = actionContracts(registry);
  const row = action => rows.find(r => r.gateway === gateway && r.action === action);
  for (const action of [
    'snapchat_adaccounts_ad_account_id_claim_media_by_snap_reference_create',
    'snapchat_adaccounts_ad_account_id_claim_media_by_snap_reference_create_2',
  ]) {
    assert.equal(row(action)?.status, 'reviewed_write_family', action);
    assert.equal(row(action).family, 'snapchat_claim_media', action);
  }
  for (const [action, reason] of [
    ['snapchat_adaccounts_ad_account_id_claim_media_by_ad_code_create', /businessapi\.snapchat\.com/],
    ['snapchat_adaccounts_ad_account_id_creative_elements_create', /no way to read one/],
    ['snapchat_adaccounts_ad_account_id_interaction_zones_create', /at least four creative element/],
    ['snapchat_adsquads_ad_squad_id_ad_squad_ui_render_data_create', /no request body/],
  ]) {
    assert.equal(row(action)?.status, 'blocked_write', action);
    assert.match(row(action).reason, reason, action);
  }
});

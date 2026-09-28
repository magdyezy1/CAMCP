import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Snapchat media copy between ad accounts of one organization, Ads API "Media" (Copy Media, checked 2026-09-27).
 */
const gateway = 'snapchat_native_action',
  registry = new Registry(),
  action = 'snapchat_adaccounts_ad_account_id_media_copy_create';
const actor = {tenantId: 'snap-copy', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const DEST = 'dest-acct',
  SRC = 'src-acct',
  OTHER = 'other-org-acct',
  UNBOUND = 'unbound-acct';
function fixture(mode = '') {
  const store = new Store(':memory:', Buffer.alloc(32, 91).toString('base64')),
    calls = [];
  let writes = 0,
    next = 1;
  store.putConnection(
    owner,
    {
      id: 'snap',
      tenantId: actor.tenantId,
      gateway,
      accounts: [DEST, SRC, OTHER],
      writeAccounts: [DEST],
      enabled: true,
      label: 'Synthetic Snapchat',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const accounts = {[DEST]: 'org-1', [SRC]: 'org-1', [OTHER]: 'org-2', [UNBOUND]: 'org-1'};
  const media = new Map([
    ['m-img', {ad_account_id: SRC, name: 'Hero image', type: 'IMAGE', media_status: 'READY'}],
    ['m-vid', {ad_account_id: SRC, name: 'Hero video', type: 'VIDEO', media_status: 'READY'}],
    ['m-pending', {ad_account_id: SRC, name: 'Uploading', type: 'VIDEO', media_status: 'PENDING_UPLOAD'}],
    ['m-lens', {ad_account_id: SRC, name: 'Lens', type: 'LENS_PACKAGE', media_status: 'READY'}],
    ['m-other', {ad_account_id: OTHER, name: 'Other org', type: 'IMAGE', media_status: 'READY'}],
  ]);
  const transport = new NativeTransport(async (url, init) => {
    const u = new URL(String(url)),
      path = u.pathname,
      method = init?.method ?? 'GET',
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({path, method, body});
    let m = /^\/v1\/adaccounts\/([\w-]+)$/.exec(path);
    if (method === 'GET' && m)
      return accounts[m[1]]
        ? Response.json({
            request_status: 'SUCCESS',
            adaccounts: [
              {sub_request_status: 'SUCCESS', adaccount: {id: m[1], organization_id: accounts[m[1]], name: m[1]}},
            ],
          })
        : Response.json({request_status: 'ERROR'}, {status: 404});
    m = /^\/v1\/media\/([\w-]+)$/.exec(path);
    if (method === 'GET' && m) {
      const v = media.get(m[1]);
      return v
        ? Response.json({
            request_status: 'SUCCESS',
            media: [
              {sub_request_status: 'SUCCESS', media: {id: m[1], ...v, download_link: 'https://example.test/' + m[1]}},
            ],
          })
        : Response.json({request_status: 'ERROR', debug_message: 'Not found'}, {status: 404});
    }
    if (method === 'POST' && path === '/v1/adaccounts/' + DEST + '/media_copy') {
      writes++;
      return Response.json({
        request_status: 'SUCCESS',
        request_id: 'r1',
        media: body.media_copy.map((c, i) => {
          if (mode === 'partial' && i === 1)
            return {sub_request_status: 'ERROR', sub_request_error_reason: 'Invalid media'};
          const src = media.get(c.source_media_id),
            id = 'copy-' + next++;
          if (mode !== 'ignore')
            media.set(id, {...src, ad_account_id: DEST, ...(mode === 'renamed' ? {name: 'Different'} : {})});
          return {
            sub_request_status: 'SUCCESS',
            media: {id, ad_account_id: DEST, name: src.name, type: src.type, media_status: 'READY'},
          };
        }),
      });
    }
    throw new Error('Unexpected ' + method + ' ' + path);
  });
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const prepare = copies =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {action, account_id: DEST, path_params: {ad_account_id: DEST}, payload: {media_copy: copies}},
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
  return {
    store,
    calls,
    media,
    prepare,
    execute,
    verify,
    writes: () => writes,
    owns: id => store.ownsResource(store.resolveConnection(actor, gateway, DEST, 'snap'), DEST, 'media/' + id),
  };
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};
const copy = (id, account = SRC) => ({source_media_id: id, source_ad_account_id: account});

test('an image and a video are copied once into the selected ad account, verify under their new IDs and become usable there', async () => {
  const f = fixture();
  try {
    const p = ok(await f.prepare([copy('m-img'), copy('m-vid')])),
      impact = p.data.creative_impact;
    assert.equal(impact.scope, 'media_copy');
    assert.deepEqual(
      impact.copies.map(c => c.name),
      ['Hero image', 'Hero video'],
    );
    assert.equal(impact.may_affect_serving, false);
    ok(await f.execute(p));
    assert.equal(f.writes(), 1);
    assert.equal(f.owns('copy-1'), true);
    assert.equal(f.owns('copy-2'), true);
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('malformed copies are refused before any request', async () => {
  const cases = [
    ['no copies', []],
    ['21 copies', Array.from({length: 21}, (_, i) => copy('m-' + i))],
    ['same account', [copy('m-img', DEST)]],
    ['repeated media', [copy('m-img'), copy('m-img')]],
    ['unknown field', [{...copy('m-img'), destination_ad_account_id: DEST}]],
    ['missing account', [{source_media_id: 'm-img'}]],
  ];
  for (const [label, copies] of cases) {
    const f = fixture();
    try {
      const r = await f.prepare(copies);
      assert.equal(r.error?.code, 'INVALID_SNAPCHAT_MEDIA_COPY', label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
});

test('other organizations, unbound accounts, foreign, pending and Lens media are refused after reading, without writes', async () => {
  const f = fixture();
  try {
    assert.match((await f.prepare([copy('m-other', OTHER)])).error?.message ?? '', /organization/);
    assert.equal((await f.prepare([copy('m-img', UNBOUND)])).success, false);
    assert.equal((await f.prepare([copy('m-other', SRC)])).error?.code, 'STATE_TARGET_MISMATCH');
    assert.match((await f.prepare([copy('m-pending')])).error?.message ?? '', /READY/);
    assert.match((await f.prepare([copy('m-lens')])).error?.message ?? '', /images and videos/);
    assert.equal((await f.prepare([copy('m-none')])).error?.code, 'STATE_TARGET_MISMATCH');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('a partial copy is a failure that is never resubmitted, and a copy that differs from its source is not verified', async () => {
  const partial = fixture('partial');
  try {
    const p = ok(await partial.prepare([copy('m-img'), copy('m-vid')]));
    assert.equal((await partial.execute(p)).success, false);
    assert.equal((await partial.execute(p)).success, false);
    assert.equal(partial.writes(), 1);
  } finally {
    partial.store.close();
  }
  const renamed = fixture('renamed');
  try {
    const p = ok(await renamed.prepare([copy('m-img')]));
    ok(await renamed.execute(p));
    assert.notEqual(ok(await renamed.verify(p)).data.status, 'verified');
  } finally {
    renamed.store.close();
  }
});

test('the ledger lists the media copy route in the family', () => {
  const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.action === action);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'reviewed_write_family');
  assert.equal(rows[0].family, 'snapchat_media_copy');
});

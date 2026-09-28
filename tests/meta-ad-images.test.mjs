import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Deleting ad images from a Meta ad account library (Marketing API v25.0 "Ad Image" reference, checked 2026-09-27).
 */
const gateway = 'meta_native_action',
  registry = new Registry(),
  action = 'meta_ad_account_id_adimages_delete';
const actor = {tenantId: 'meta-ad-images', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const h = n => String(n).repeat(32).slice(0, 32);
function fixture(mode = '') {
  const store = new Store(':memory:', Buffer.alloc(32, 85).toString('base64')),
    calls = [];
  let writes = 0;
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
      scopes: ['ads_management'],
    },
    {accessToken: 'synthetic'},
  );
  // Image b is used by a creative; Meta refuses to delete it.
  const images = new Map([
    [h('a'), {id: '5001', name: 'hero.png', status: 'ACTIVE', account_id: '123'}],
    [h('b'), {id: '5002', name: 'used.png', status: 'ACTIVE', account_id: '123', used: true}],
    [h('c'), {id: '5003', name: 'old.png', status: 'DELETED', account_id: '123'}],
  ]);
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        path = u.pathname,
        method = init.method;
      calls.push({path, method, query: Object.fromEntries(u.searchParams)});
      if (path !== '/v25.0/act_123/adimages') throw new Error('Unexpected ' + method + ' ' + path);
      if (method === 'GET') {
        const hashes = JSON.parse(u.searchParams.get('hashes') ?? '[]');
        return Response.json({
          data: hashes
            .filter(x => images.has(x))
            .map(x => {
              const {used, ...i} = images.get(x);
              return {hash: x, ...i};
            }),
        });
      }
      writes++;
      const hash = u.searchParams.get('hash') ?? Object.fromEntries(new URLSearchParams(String(init.body ?? ''))).hash;
      if (images.get(hash)?.used)
        return Response.json(
          {error: {message: 'Image is being used by an ad creative and cannot be deleted.', code: 100}},
          {status: 400},
        );
      if (mode !== 'ignore') {
        if (mode === 'drop') images.delete(hash);
        else images.get(hash).status = 'DELETED';
      }
      return Response.json({success: true});
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
  const prepare = (hash, extra = {}) =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action, account_id: '123', params: {hash, ...extra}}},
      actor,
    );
  const execute = p =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true},
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, images, prepare, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('an unused image is deleted and verifies as DELETED or gone; a replay sends nothing; owner deletion rules apply', async () => {
  const f = fixture();
  try {
    const p = ok(await f.prepare(h('a')));
    assert.equal(p.data.creative_impact.scope, 'ad_image');
    assert.equal(p.data.creative_impact.image.name, 'hero.png');
    ok(await f.execute(p));
    assert.equal(f.images.get(h('a')).status, 'DELETED');
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
  const g = fixture('drop');
  try {
    const p = ok(await g.prepare(h('a')));
    ok(await g.execute(p));
    assert.equal(ok(await g.verify(p)).data.status, 'verified');
  } finally {
    g.store.close();
  }
  const o = fixture();
  try {
    saveSpendPolicy(o.store, owner, {gateway, account_id: '123', confirmed: true, policy: {allow_deletion: false}});
    assert.equal((await o.prepare(h('a'))).error?.code, 'POLICY_DELETION_FORBIDDEN');
  } finally {
    o.store.close();
  }
});

test('malformed hashes are refused before any request; unknown and deleted images after reading', async () => {
  for (const [label, hash, extra] of [
    ['short hash', 'abc', {}],
    ['uppercase hash', h('A'), {}],
    ['image_id', h('a'), {image_id: '5001'}],
  ]) {
    const f = fixture();
    try {
      const r = await f.prepare(hash, extra);
      assert.equal(r.success, false, label);
      assert.equal(f.calls.length, 0, label + ': ' + JSON.stringify(r).slice(0, 300));
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    assert.equal((await f.prepare(h('9'))).error?.code, 'STATE_NOT_FOUND');
    assert.match((await f.prepare(h('c'))).error?.message ?? '', /already deleted/);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('Meta refusing an image in use is a failure never resubmitted, an ignored deletion is not verified, and the ledger lists the write', async () => {
  const f = fixture();
  try {
    const p = ok(await f.prepare(h('b')));
    assert.equal((await f.execute(p)).success, false);
    assert.equal((await f.execute(p)).success, false);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
  const g = fixture('ignore');
  try {
    const p = ok(await g.prepare(h('a')));
    ok(await g.execute(p));
    assert.notEqual(ok(await g.verify(p)).data.status, 'verified');
  } finally {
    g.store.close();
  }
  const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.action === action);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'reviewed_write_family');
  assert.equal(rows[0].family, 'meta_ad_images');
});

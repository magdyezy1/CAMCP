import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {scopeKey} from '../dist/src/security.js';

/**
 * WRT-04 Stage A for media (owner decision D12): an upload refused after its claim but before the first upload
 * request left AMCP was recorded as uncertain and its staged file removed, so the reviewed upload could never run.
 * It now releases the claim, keeps the staged file and runs once the cause clears. A lost upload response stays
 * uncertain as before.
 */
const owner = {tenantId: 'media-not-sent', userId: 'owner', role: 'admin'},
  png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 84).toString('base64'));
  store.putConnection(
    owner,
    {
      id: 'm',
      tenantId: owner.tenantId,
      gateway: 'meta_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Meta',
      scopes: ['ads_management'],
    },
    {accessToken: 'synthetic'},
  );
  const uploads = [],
    hooks = {};
  let reads = 0;
  const transport = new NativeTransport(async (raw, init = {}) => {
    const path = new URL(String(raw)).pathname,
      method = init.method ?? 'GET';
    if (method === 'GET') {
      reads++;
      hooks.onRead?.(reads);
      if (path.endsWith('/adimages')) return Response.json({data: [{hash: 'hash456'}]});
      return Response.json({id: 'act_123', account_status: 1, currency: 'USD', name: 'Account'});
    }
    if (method === 'POST' && path === '/v26.0/act_123/adimages') {
      uploads.push(path);
      if (hooks.failUpload) throw new TypeError('synthetic lost response');
      return Response.json({images: {image: {hash: 'hash456'}}});
    }
    throw new Error('Unexpected synthetic Meta request: ' + method + ' ' + path);
  });
  const source = async () => new Response(new Uint8Array(png), {headers: {'Content-Type': 'application/octet-stream'}});
  const service = new MirrorService(
    new Registry(),
    store,
    transport,
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
    source,
  );
  const call = input => service.call('amcp_media', input, owner);
  const prepare = () =>
    call({
      action: 'prepare',
      platform: 'meta',
      account_id: '123',
      drive_url: 'https://drive.google.com/file/d/abcdefghijklmno/view?usp=sharing',
      name: 'Reviewed media',
    });
  const execute = review => call({action: 'execute', review_id: review, idempotency_key: review, confirmed: true});
  const claim = key =>
    store.db.prepare('SELECT state FROM idempotency WHERE tenant_id=? AND key=?').get(owner.tenantId, key);
  const staged = () => store.db.prepare('SELECT count(*) AS n FROM media_staging').get().n;
  const audit = () => store.audit(owner.tenantId, 1000).map(row => JSON.parse(row.event));
  return {store, transport, uploads, hooks, prepare, execute, claim, staged, audit, close: () => store.close()};
}

test('a media upload refused by a cooldown before its first request is released and runs after it clears', async () => {
  const f = fixture();
  try {
    const prepared = await f.prepare();
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 800));
    const id = prepared.data.review_id;
    // The execute's own state read starts a provider cooldown: the upload is refused before it is sent.
    f.hooks.onRead = () => {
      f.transport.cooldowns.set(scopeKey(owner.tenantId, 'meta_native_action'), performance.now() + 60000);
      f.hooks.onRead = undefined;
    };
    const refused = await f.execute(id);
    assert.equal(refused.error?.code, 'PLATFORM_RATE_LIMIT', JSON.stringify(refused).slice(0, 800));
    assert.equal(refused.error.details.submission, 'not_sent');
    assert.equal(f.uploads.length, 0);
    assert.equal(f.claim(id), undefined, 'the claim is released');
    assert.equal(f.staged(), 1, 'the reviewed file stays staged');
    assert.ok(f.audit().some(e => e.event === 'write_not_sent' && e.code === 'PLATFORM_RATE_LIMIT'));
    assert.equal(
      f.audit().some(e => e.event === 'media_upload_incomplete'),
      false,
    );
    f.transport.cooldowns.clear();
    const done = await f.execute(id);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 800));
    assert.equal(f.uploads.length, 1);
    assert.equal(f.claim(id).state, 'complete');
  } finally {
    f.close();
  }
});

test('a media upload whose response was lost stays uncertain and is never sent again', async () => {
  const f = fixture();
  try {
    const id = (await f.prepare()).data.review_id;
    f.hooks.failUpload = true;
    const lost = await f.execute(id);
    assert.equal(lost.success, false);
    assert.notEqual(lost.error.details?.submission, 'not_sent');
    assert.equal(f.uploads.length, 1);
    assert.equal(f.claim(id).state, 'uncertain');
    f.hooks.failUpload = false;
    const again = await f.execute(id);
    assert.equal(again.error.code, 'WRITE_OUTCOME_UNCERTAIN');
    assert.equal(f.uploads.length, 1);
  } finally {
    f.close();
  }
});

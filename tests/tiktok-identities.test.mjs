import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

/**
 * TikTok custom identities (API for Business v1.3, checked 2026-09-26): create a CUSTOMIZED_USER identity with a
 * display name and an optional square avatar from the advertiser's asset library. Identity info reads back the
 * display name and type but reports the avatar only as a derived URL. Deletion stays blocked.
 */
const TIKTOK = '55555555-5555-4555-8555-555555555555',
  gateway = 'tiktok_native_action',
  account = '123';
const actor = {tenantId: 'tiktok-identities', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 63).toString('base64');
function fixture({
  images = {'ad-site/avatar': [200, 200], 'ad-site/wide': [750, 422]},
  readName,
  readInfo = i => i,
} = {}) {
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
  store.putConnection(admin, connection, {accessToken: 'synthetic'});
  const identities = new Map(),
    requests = [],
    writes = [];
  let n = 0,
    mode = '';
  const ok = data => Response.json({code: 0, message: 'OK', request_id: 'r' + ++n, data});
  const transport = new NativeTransport(async (raw, init = {}) => {
    const url = new URL(String(raw)),
      path = url.pathname.replace(/^\/open_api/, ''),
      method = init.method ?? 'GET';
    requests.push(method + ' ' + path);
    if (method === 'GET' && path === '/v1.3/advertiser/info/')
      return ok({list: [{advertiser_id: account, name: 'Synthetic advertiser'}]});
    if (method === 'GET' && path === '/v1.3/file/image/ad/info/') {
      const ids = JSON.parse(url.searchParams.get('image_ids'));
      // image_url is signed and changes on every read; it must not count as a configuration change.
      return ok({
        list: ids
          .filter(id => images[id])
          .map(id => ({
            image_id: id,
            width: images[id][0],
            height: images[id][1],
            format: 'png',
            signature: 'md5-' + id,
            image_url: 'https://p16.example.test/' + id + '?x-expires=' + Date.now() + '&n=' + n,
          })),
      });
    }
    if (method === 'POST' && path === '/v1.3/identity/create/') {
      writes.push(path);
      const b = JSON.parse(init.body),
        id = '70000000000000' + (identities.size + 1);
      identities.set(id, {
        identity_id: id,
        identity_type: 'CUSTOMIZED_USER',
        display_name: b.display_name,
        profile_image_url: 'https://p16.example.test/avatar/' + id,
      });
      if (mode === 'lost') throw new Error('Synthetic accepted response lost');
      return mode === 'write_error'
        ? Response.json({code: 40002, message: 'Synthetic rejection', request_id: 'r' + ++n, data: {}})
        : ok(mode === 'empty_receipt' ? {} : {identity_id: id});
    }
    if (method === 'GET' && path === '/v1.3/identity/info/') {
      const i = identities.get(url.searchParams.get('identity_id'));
      assert.equal(url.searchParams.get('identity_type'), 'CUSTOMIZED_USER');
      const info = i && readInfo({...i});
      return i
        ? ok(
            info
              ? {
                  identity_info: {
                    ...info,
                    ...(readName ? {display_name: readName} : {}),
                    can_push_video: false,
                    can_pull_video: false,
                  },
                }
              : {},
          )
        : Response.json({code: 40002, message: 'Not found', data: {}});
    }
    throw new Error('Unexpected TikTok request ' + method + ' ' + path);
  });
  const start = () =>
    new MirrorService(new Registry(), store, transport, undefined, {
      allowWrites: true,
      requireBeforeState: true,
      maxBudgetChange: 0,
    });
  let service = start();
  const call = (tool, input) => service.call(tool, input, actor);
  const prepare = payload =>
    call('amcp_write', {
      action: 'prepare',
      gateway,
      connection_id: TIKTOK,
      arguments: {action: 'tiktok_identity_create', account_id: account, payload},
    });
  const execute = id => call('amcp_write', {action: 'execute', review_id: id, idempotency_key: id, confirmed: true});
  const verify = id => call('amcp_campaign', {action: 'verify', review_id: id});
  return {
    store,
    requests,
    writes,
    call,
    prepare,
    execute,
    verify,
    mode: v => {
      mode = v;
    },
    restart: () => {
      service = start();
    },
  };
}

test('identity creation is a reviewed TikTok family; deletion is reviewed by the deletions family', async () => {
  const f = fixture();
  try {
    const inspected = await f.call('amcp_write', {
      action: 'inspect',
      gateway,
      connection_id: TIKTOK,
      arguments: {action: 'tiktok_identity_create', account_id: account, payload: {display_name: 'Brand'}},
    });
    assert.equal(inspected.data.review_contract_supported, true, JSON.stringify(inspected));
    const status = Object.fromEntries(
      (await f.call('amcp_workspace', {action: 'contracts', gateway, search: 'identity', limit: 100})).data.actions.map(
        r => [r.action, r.status],
      ),
    );
    assert.equal(status.tiktok_identity_create, 'reviewed_write_family');
    assert.equal(status.tiktok_identity_delete, 'reviewed_write_family');
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('documented identity rules are enforced before any provider request', async () => {
  const f = fixture();
  try {
    for (const [name, payload] of Object.entries({
      'missing name': {},
      'empty name': {display_name: '  '},
      'name over 100': {display_name: 'x'.repeat(101)},
      'numeric name': {display_name: 5},
      'identity type': {display_name: 'Brand', identity_type: 'TT_USER'},
      'profile url': {display_name: 'Brand', profile_image_url: 'https://example.test/a.png'},
      'image with space': {display_name: 'Brand', image_uri: 'ad site/avatar'},
      'numeric image': {display_name: 'Brand', image_uri: 7},
    })) {
      const r = await f.prepare(payload);
      assert.equal(
        r.error?.code,
        'INVALID_TIKTOK_IDENTITY',
        name + ': ' + JSON.stringify(r.error ?? r.data).slice(0, 300),
      );
    }
    assert.equal(
      (await f.prepare({display_name: 'x'.repeat(100)})).success,
      true,
      '100 characters is the documented maximum',
    );
    assert.deepEqual(f.requests, ['GET /v1.3/advertiser/info/'], 'only the accepted request read state');
  } finally {
    f.store.close();
  }
});

test('an identity without an avatar is created once and verifies from identity info', async () => {
  const f = fixture();
  try {
    const p = await f.prepare({display_name: 'Ritz Residences'});
    assert.equal(p.success, true, JSON.stringify(p));
    assert.deepEqual(
      p.data.state_reads.map(r => r.path),
      ['/v1.3/advertiser/info/'],
    );
    assert.equal(p.data.creative_impact.avatar, null);
    const done = await f.execute(p.data.review_id);
    assert.equal(done.success, true, JSON.stringify(done));
    const verified = await f.verify(p.data.review_id);
    assert.equal(verified.data.status, 'verified', JSON.stringify(verified));
    assert.deepEqual(verified.data.checks[0].checked_fields, ['identity_id', 'identity_type', 'display_name']);
    assert.equal(verified.data.checks[0].unobservable_fields, undefined);
    assert.equal((await f.execute(p.data.review_id)).data.replayed, true);
    assert.deepEqual(f.writes, ['/v1.3/identity/create/']);
  } finally {
    f.store.close();
  }
});

test('a square avatar from the library is read twice, and verification names it unobservable', async () => {
  const f = fixture();
  try {
    const p = await f.prepare({display_name: 'Ritz Residences', image_uri: 'ad-site/avatar'});
    assert.equal(p.success, true, JSON.stringify(p));
    assert.deepEqual(
      p.data.state_reads.map(r => r.path),
      ['/v1.3/advertiser/info/', '/v1.3/file/image/ad/info/'],
    );
    assert.deepEqual(p.data.creative_impact.avatar, {image_id: 'ad-site/avatar', width: 200, height: 200});
    const done = await f.execute(p.data.review_id);
    assert.equal(done.success, true, 'a re-signed image_url is not a state change: ' + JSON.stringify(done));
    assert.equal(f.requests.filter(r => r === 'GET /v1.3/file/image/ad/info/').length, 2);
    const verified = await f.verify(p.data.review_id);
    assert.equal(verified.data.status, 'verified', JSON.stringify(verified));
    assert.deepEqual(verified.data.checks[0].unobservable_fields, ['image_uri']);
  } finally {
    f.store.close();
  }
});

test('an avatar outside the library or not square is refused before any write', async () => {
  const f = fixture();
  try {
    const missing = await f.prepare({display_name: 'Brand', image_uri: 'ad-site/elsewhere'});
    assert.equal(missing.error.code, 'STATE_TARGET_MISMATCH', JSON.stringify(missing));
    const wide = await f.prepare({display_name: 'Brand', image_uri: 'ad-site/wide'});
    assert.equal(wide.error.code, 'INVALID_TIKTOK_IDENTITY', JSON.stringify(wide));
    assert.match(wide.error.message, /750×422/);
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

test('an identity that reads back with another display name stays inconclusive', async () => {
  const f = fixture({readName: 'Edited elsewhere'});
  try {
    const p = await f.prepare({display_name: 'Ritz Residences'});
    await f.execute(p.data.review_id);
    const verified = await f.verify(p.data.review_id);
    assert.equal(verified.data.status, 'inconclusive', JSON.stringify(verified));
    assert.deepEqual(verified.data.checks[0].changed_fields, ['/display_name']);
  } finally {
    f.store.close();
  }
});

test('identity info that is missing or names another identity is not verification evidence', async () => {
  // A malformed read fails outright; another identity is retried as read-after-write lag and stays inconclusive.
  for (const [option, status, code] of [
    [{readInfo: () => undefined}, 'unverified', 'STATE_READ_FAILED'],
    [{readInfo: i => ({...i, identity_id: '7999'})}, 'inconclusive', 'VERIFICATION_INCONCLUSIVE'],
  ]) {
    const f = fixture(option);
    try {
      const p = await f.prepare({display_name: 'Brand'});
      assert.equal((await f.execute(p.data.review_id)).success, true);
      const verified = await f.verify(p.data.review_id);
      assert.equal(verified.data.status, status, JSON.stringify(verified));
      assert.equal(verified.data.checks[0].code, code);
    } finally {
      f.store.close();
    }
  }
});

test('rejected, empty or lost identity receipts never submit a second identity', async () => {
  for (const mode of ['write_error', 'empty_receipt', 'lost']) {
    const f = fixture();
    try {
      const p = await f.prepare({display_name: 'Brand'});
      assert.equal(p.success, true, mode);
      // A TikTok-declared error is reported as such once; its outcome is then held as uncertain, never retried.
      const [first, again] = {
        write_error: ['PLATFORM_ERROR', 'WRITE_OUTCOME_UNCERTAIN'],
        empty_receipt: ['WRITE_PARTIAL_OR_FAILED', 'WRITE_PARTIAL_OR_FAILED'],
        lost: ['WRITE_OUTCOME_UNCERTAIN', 'WRITE_OUTCOME_UNCERTAIN'],
      }[mode];
      f.mode(mode);
      assert.equal((await f.execute(p.data.review_id)).error?.code, first, mode);
      f.mode('');
      assert.equal((await f.execute(p.data.review_id)).error?.code, again, mode);
      assert.equal(f.writes.length, 1, mode);
      assert.notEqual((await f.verify(p.data.review_id)).data?.status, 'verified', mode);
    } finally {
      f.store.close();
    }
  }
});

test('identity claims survive concurrent execution and restart; a lost receipt stays uncertain', async () => {
  const f = fixture();
  try {
    const p = await f.prepare({display_name: 'Brand'});
    const results = await Promise.all([f.execute(p.data.review_id), f.execute(p.data.review_id)]);
    assert.ok(results.some(r => r.success));
    assert.equal(f.writes.length, 1);
    f.restart();
    assert.equal((await f.execute(p.data.review_id)).data.replayed, true);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    const p = await g.prepare({display_name: 'Brand'});
    g.mode('lost');
    assert.equal((await g.execute(p.data.review_id)).success, false);
    g.mode('');
    g.restart();
    assert.equal((await g.execute(p.data.review_id)).error.code, 'WRITE_OUTCOME_UNCERTAIN');
    assert.equal(g.writes.length, 1);
  } finally {
    g.store.close();
  }
});

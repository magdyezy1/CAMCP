import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Snapchat chunked media upload, Ads API "Media" (Upload large media files, checked 2026-09-27): files over 32 MB are sent with
 * multipart-upload-v2 INIT, one ADD per part (at most 32 MB each, at most 32 parts) and FINALIZE, all as multipart forms.
 */
const gateway = 'snapchat_native_action',
  registry = new Registry();
const actor = {tenantId: 'snapchat-chunks', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const link = 'https://drive.google.com/file/d/abcdefghijklmno/view?usp=sharing';
const mp4 = size => {
  const b = Buffer.alloc(size, 7);
  Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom')]).copy(b, 0);
  return b;
};
const sha = b => createHash('sha256').update(b).digest('hex');
const part = 16 * 1024 * 1024;
function fixture(file, mode = '') {
  const store = new Store(':memory:', Buffer.alloc(32, 87).toString('base64')),
    calls = [];
  let downloads = 0;
  const parts = new Map();
  store.putConnection(
    owner,
    {
      id: 'snap',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Snapchat',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const media = new Map([['m-9', {status: 'PENDING_UPLOAD'}]]);
  const transport = new NativeTransport(async (url, init) => {
    const u = new URL(String(url)),
      path = u.pathname,
      method = init?.method ?? 'GET',
      body = init?.body,
      form = body instanceof FormData ? body : undefined,
      action = u.searchParams.get('action');
    calls.push({
      path,
      method,
      action,
      form: form
        ? Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : '<blob>']))
        : undefined,
      type: new Headers(init?.headers).get('content-type'),
    });
    if (method === 'GET' && path === '/v1/adaccounts/123')
      return Response.json({
        request_status: 'SUCCESS',
        adaccounts: [{sub_request_status: 'SUCCESS', adaccount: {id: '123', name: 'Account'}}],
      });
    const read = /^\/v1\/media\/([\w-]+)$/.exec(path);
    if (method === 'GET' && read && media.has(read[1]))
      return Response.json({
        request_status: 'SUCCESS',
        media: [
          {
            sub_request_status: 'SUCCESS',
            media: {id: read[1], ad_account_id: '123', media_status: media.get(read[1]).status},
          },
        ],
      });
    if (method === 'POST' && path === '/v1/adaccounts/123/media') {
      media.set('m-1', {status: 'PENDING_UPLOAD'});
      return Response.json({
        request_status: 'SUCCESS',
        media: [{sub_request_status: 'SUCCESS', media: {id: 'm-1', ad_account_id: '123'}}],
      });
    }
    const simple = /^\/v1\/media\/([\w-]+)\/upload$/.exec(path);
    if (method === 'POST' && simple) {
      media.get(simple[1]).status = 'READY';
      return Response.json({
        request_status: 'SUCCESS',
        result: {id: simple[1], ad_account_id: '123', media_status: 'READY'},
      });
    }
    const chunk = /^\/(?:us\/)?v1\/media\/([\w-]+)\/multipart-upload-v2$/.exec(path);
    if (method === 'POST' && chunk && action === 'INIT') {
      assert.equal(form.get('file'), null);
      const id = chunk[1],
        other = mode === 'other_media' ? 'm-2' : id;
      return Response.json({
        request_status: 'SUCCESS',
        request_id: 'r-init',
        upload_id: 'u-1',
        add_path: '/us/v1/media/' + other + '/multipart-upload-v2?action=ADD',
        finalize_path: '/v1/media/' + other + '/multipart-upload-v2?action=FINALIZE',
      });
    }
    if (method === 'POST' && chunk && action === 'ADD') {
      assert.equal(form.get('upload_id'), 'u-1');
      const n = form.get('part_number');
      if (mode === 'lost_part' && n === '2') throw new Error('Lost part response');
      parts.set(n, Buffer.from(await form.get('file').arrayBuffer()));
      return Response.json({request_status: 'SUCCESS', request_id: 'r-add-' + n});
    }
    if (method === 'POST' && chunk && action === 'FINALIZE') {
      assert.equal(form.get('upload_id'), 'u-1');
      const joined = Buffer.concat([...parts.keys()].sort((a, b) => a - b).map(k => parts.get(k)));
      assert.equal(sha(joined), sha(file));
      media.get(chunk[1]).status = 'READY';
      return Response.json({
        request_status: 'SUCCESS',
        request_id: 'r-fin',
        result: {
          id: chunk[1],
          ad_account_id: '123',
          type: 'VIDEO',
          media_status: 'READY',
          file_name: form.get('file_name') ?? 'x',
        },
      });
    }
    throw new Error('Unexpected ' + method + ' ' + path + ' ' + action);
  });
  const source = async (input, init) => {
    downloads++;
    assert.equal(new URL(String(input)).hostname, 'drive.usercontent.google.com');
    assert.equal(init?.redirect, 'manual');
    return new Response(new Uint8Array(file), {headers: {'Content-Type': 'application/octet-stream'}});
  };
  const service = new MirrorService(
    registry,
    store,
    transport,
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
    source,
  );
  const call = input => service.call('amcp_media', input, actor);
  const prepare = (extra = {}) =>
    call({
      action: 'prepare',
      platform: 'snapchat',
      account_id: '123',
      drive_url: link,
      name: 'Reviewed video',
      ...extra,
    });
  const execute = p =>
    call({action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true});
  return {
    store,
    service,
    calls,
    parts,
    media,
    call,
    prepare,
    execute,
    downloads: () => downloads,
    own: id => store.rememberResource(store.resolveConnection(actor, gateway, '123', 'snap'), '123', 'media/' + id),
    close: () => store.close(),
  };
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('a video over 32 MB is uploaded once in 16 MiB parts with INIT, ADD and FINALIZE forms and is ready', async () => {
  const file = mp4(33_000_000),
    f = fixture(file);
  try {
    const p = ok(await f.prepare());
    assert.equal(p.data.request.size, 33_000_000);
    const out = ok(await f.execute(p));
    assert.equal(out.data.snapchat_media_id, 'm-1');
    assert.equal(out.data.ready, true);
    assert.equal(out.data.processing_status, 'READY');
    const [init] = f.calls.filter(c => c.action === 'INIT'),
      adds = f.calls.filter(c => c.action === 'ADD'),
      [fin] = f.calls.filter(c => c.action === 'FINALIZE');
    assert.deepEqual(init.form, {file_name: 'Reviewed video.mp4', file_size: '33000000', number_of_parts: '2'});
    assert.equal(init.path, '/v1/media/m-1/multipart-upload-v2');
    assert.match(init.type ?? 'multipart/form-data', /multipart\/form-data/);
    assert.deepEqual(
      adds.map(c => [c.path, c.form.part_number, c.form.file]),
      [
        ['/us/v1/media/m-1/multipart-upload-v2', '1', '<blob>'],
        ['/us/v1/media/m-1/multipart-upload-v2', '2', '<blob>'],
      ],
    );
    assert.equal(f.parts.get('1').length, part);
    assert.equal(f.parts.get('2').length, 33_000_000 - part);
    assert.deepEqual(fin.form, {upload_id: 'u-1'});
    assert.equal(
      f.calls.some(c => c.path.endsWith('/upload')),
      false,
    );
    const count = f.calls.length;
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.calls.length, count);
  } finally {
    f.close();
  }
});

test('a video of exactly 32,000,000 bytes keeps the simple upload', async () => {
  const f = fixture(mp4(32_000_000));
  try {
    const p = ok(await f.prepare());
    ok(await f.execute(p));
    assert.deepEqual(
      f.calls.filter(c => c.method === 'POST').map(c => c.path),
      ['/v1/adaccounts/123/media', '/v1/media/m-1/upload'],
    );
  } finally {
    f.close();
  }
});

test('the native chunked INIT route prepares a reviewed import into an owned media allocation; raw ADD stays blocked', async () => {
  const file = mp4(33_000_000),
    f = fixture(file);
  try {
    const init = (media_id, extra = {}) =>
      f.service.call(
        'amcp_write',
        {
          action: 'prepare',
          gateway,
          arguments: {
            action: 'snapchat_media_multipart_upload_init',
            account_id: '123',
            params: {media_id},
            payload: {url: link, name: 'Reviewed video', ...extra},
          },
        },
        actor,
      );
    const unowned = await init('m-9');
    assert.equal(unowned.success, false);
    assert.equal(f.downloads(), 0);
    f.own('m-9');
    const p = ok(await init('m-9'));
    assert.equal(p.data.request.existing_media_id, 'm-9');
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
    const out = ok(await f.service.call(p.data.next_call.tool, p.data.next_call.arguments, actor));
    assert.equal(out.data.snapchat_media_id, 'm-9');
    assert.deepEqual(
      f.calls.filter(c => c.method === 'POST').map(c => c.action),
      ['INIT', 'ADD', 'ADD', 'FINALIZE'],
    );
    assert.equal(f.media.get('m-9').status, 'READY');
    const add = await f.service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          action: 'snapchat_media_multipart_upload_add',
          account_id: '123',
          params: {media_id: 'm-9'},
          payload: {url: link},
        },
      },
      actor,
    );
    assert.equal(add.success, false);
    assert.equal(add.error.code, 'WRITE_CONTRACT_UNAVAILABLE');
  } finally {
    f.close();
  }
});

test('paths for another media stop before any part is sent, and a lost part is never retried or finalized', async () => {
  const file = mp4(33_000_000);
  const other = fixture(file, 'other_media');
  try {
    const p = ok(await other.prepare()),
      out = await other.execute(p);
    assert.equal(out.error?.code, 'MEDIA_RESPONSE_INVALID');
    assert.equal(out.error.details.media_id, 'm-1');
    assert.equal(out.error.details.retry_safe, false);
    assert.equal(
      other.calls.some(c => c.action === 'ADD'),
      false,
    );
    assert.equal((await other.execute(p)).error?.code, 'WRITE_OUTCOME_UNCERTAIN');
  } finally {
    other.close();
  }
  const lost = fixture(file, 'lost_part');
  try {
    const p = ok(await lost.prepare()),
      out = await lost.execute(p);
    assert.equal(out.success, false);
    assert.equal(out.error.details.parts_confirmed, 1);
    assert.equal(out.error.details.retry_safe, false);
    assert.equal(
      lost.calls.some(c => c.action === 'FINALIZE'),
      false,
    );
    const count = lost.calls.length;
    assert.equal((await lost.execute(p)).error?.code, 'WRITE_OUTCOME_UNCERTAIN');
    assert.equal(lost.calls.length, count);
    const recovery = ok(await lost.call({action: 'recovery', review_id: p.data.review_id}));
    assert.equal(recovery.data.resume_available, false);
    assert.equal(recovery.data.progress.parts_confirmed, 1);
  } finally {
    lost.close();
  }
});

test('field-only multipart forms are refused outside the Snapchat chunked upload before any request', async () => {
  let calls = 0;
  const transport = new NativeTransport(async () => {
    calls++;
    return Response.json({});
  });
  const connection = {
    id: 'c',
    tenantId: 't',
    gateway,
    accounts: ['123'],
    writeAccounts: ['123'],
    enabled: true,
    label: 'x',
    scopes: [],
  };
  const plan = (path, action) => ({
    gateway,
    accountId: '123',
    action: 'AMCP_REVIEWED_MEDIA',
    method: 'POST',
    path,
    query: action ? {action} : {},
    headers: {},
    body: {upload_id: 'u-1'},
    readOnly: false,
    destructive: false,
    requiresConfirmation: false,
    evidence: 'test',
    warnings: [],
  });
  const fields = {format: 'fields', field: '', bytes: Buffer.alloc(0), filename: 'x.mp4', mime: 'video/mp4'};
  for (const [path, action] of [
    ['/v1/media/m-1/upload', undefined],
    ['/v1/media/m-1/multipart-upload-v2', 'ADD'],
    ['/v1/adaccounts/123/media', undefined],
  ])
    await assert.rejects(
      transport.request(plan(path, action), connection, {accessToken: 'synthetic'}, fields),
      e => e.code === 'INVALID_UPLOAD',
    );
  await assert.rejects(
    transport.request(
      {...plan('/v1/media/m-1/multipart-upload-v2', 'INIT'), gateway: 'tiktok_native_action'},
      {...connection, gateway: 'tiktok_native_action'},
      {accessToken: 'synthetic'},
      fields,
    ),
    e => e.code === 'INVALID_UPLOAD',
  );
  assert.equal(calls, 0);
});

test('the ledger routes the chunked upload to the media workflow; raw ADD and FINALIZE steps name it and stay refused', () => {
  const rows = actionContracts(registry).filter(r => r.gateway === gateway && /multipart_upload/.test(r.action));
  const by = Object.fromEntries(rows.map(r => [r.action, r]));
  for (const a of [
    'snapchat_media_multipart_upload',
    'snapchat_media_multipart_upload_init',
    'snapchat_media_media_id_multipart_upload_v2_upload_3',
  ])
    assert.equal(by[a].status, 'media_workflow', a);
  // F-58: amcp_media sends INIT, each ADD and FINALIZE itself; a raw step has no upload to continue.
  for (const a of [
    'snapchat_media_multipart_upload_add',
    'snapchat_media_multipart_upload_finalize',
    'snapchat_media_media_id_multipart_upload_v2_upload',
    'snapchat_media_media_id_multipart_upload_v2_upload_2',
  ]) {
    assert.equal(by[a].status, 'media_workflow', a);
    assert.match(by[a].reason, /chunked upload amcp_media performs itself.*is not accepted/, a);
  }
  // A public profile's upload is not part of it.
  assert.equal(by.snapchat_public_profiles_profile_id_media_media_id_multipart_upload_upload.status, 'blocked_write');
});

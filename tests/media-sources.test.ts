import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {MediaSources, SOURCE_CHUNK_BYTES} from '../src/media-sources.js';
import {downloadMediaLink, mediaLinkUrl, publicAddress, type LinkRequest} from '../src/media-link.js';
import {runMediaProcess, ffprobeJson} from '../src/media-variants.js';
import {mediaType} from '../src/drive-media.js';
import {mediaFileInput} from '../src/media-routing.js';
import {createHttpApp} from '../server/http-app.js';
import {listenForFetch} from './http-listener.js';
import {WebStore} from '../server/web-store.js';
import {sha256} from '../src/security.js';
import type {Actor, JsonObject} from '../src/types.js';

const key = Buffer.alloc(32, 23).toString('base64'),
  operator: Actor = {tenantId: 't', userId: 'u', role: 'operator'},
  colleague: Actor = {tenantId: 't', userId: 'v', role: 'operator'},
  admin: Actor = {tenantId: 't', userId: 'w', role: 'admin'},
  reader: Actor = {tenantId: 't', userId: 'r', role: 'reader'},
  png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );

/** Uploads `bytes` in parts and completes the upload. */
async function upload(sources: MediaSources, actor: Actor, bytes: Buffer, filename = 'creative.png') {
  const started = sources.begin(actor, {filename, size: bytes.length, type: ''});
  for (let index = 0; index < started.chunks; index++)
    sources.put(
      actor,
      started.source_id,
      index,
      bytes.subarray(index * SOURCE_CHUNK_BYTES, (index + 1) * SOURCE_CHUNK_BYTES),
    );
  return sources.complete(actor, started.source_id);
}
async function ffmpegOrSkip(t: TestContext) {
  try {
    await runMediaProcess(process.env.AMCP_FFMPEG_PATH ?? 'ffmpeg', ['-version']);
    await runMediaProcess(process.env.AMCP_FFPROBE_PATH ?? 'ffprobe', ['-version']);
    return true;
  } catch (e) {
    if (process.env.AMCP_REQUIRE_FFMPEG === 'true') throw e;
    t.skip('FFmpeg is required in release CI and Docker; this local host has no configured FFmpeg.');
    return false;
  }
}
/** A test picture made by FFmpeg, `width` × `height`, as PNG or JPEG. */
async function picture(width: number, height: number, format: 'png' | 'jpeg') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amcp-media-test-')),
    file = path.join(dir, format === 'png' ? 'picture.png' : 'picture.jpg');
  try {
    await runMediaProcess(process.env.AMCP_FFMPEG_PATH ?? 'ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=${width}x${height}:duration=1`,
      '-frames:v',
      '1',
      ...(format === 'png' ? ['-c:v', 'png'] : ['-c:v', 'mjpeg', '-q:v', '3', '-pix_fmt', 'yuvj420p']),
      file,
    ]);
    return await fs.readFile(file);
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
}
/** Width and height of media bytes, read by ffprobe. */
async function dimensions(bytes: Buffer) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amcp-media-test-')),
    type = mediaType(bytes),
    file = path.join(dir, 'probe.' + type.extension);
  try {
    await fs.writeFile(file, bytes);
    const video = (await ffprobeJson(file, type)).streams.find((s: JsonObject) => s.codec_type === 'video');
    return {width: video.width, height: video.height, mime: type.mime};
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
}

test('uploaded files have their own staging quota: four per workspace, eight in all, apart from reviews', () => {
  const store = new Store(':memory:', key);
  try {
    const id = () => 'src-' + crypto.randomUUID(),
      later = Date.now() + 60000;
    for (let i = 0; i < 4; i++) store.reserveMediaSource('a', id(), later);
    assert.throws(() => store.reserveMediaSource('a', id(), later), {code: 'MEDIA_STAGING_FULL'});
    // Reviews still have their two places in the same workspace.
    store.reserveMedia('a', 'review-1', later);
    store.reserveMedia('a', 'review-2', later);
    assert.throws(() => store.reserveMedia('a', 'review-3', later), {code: 'MEDIA_STAGING_FULL'});
    for (let i = 0; i < 4; i++) store.reserveMediaSource('b', id(), later);
    assert.throws(() => store.reserveMediaSource('c', id(), later), {code: 'MEDIA_STAGING_FULL', status: 429});
    assert.throws(() => store.reserveMediaSource('c', 'src-not-a-uuid', later), {code: 'MEDIA_STAGING_INVALID'});
    assert.throws(() => store.reserveMedia('c', id(), later), {code: 'MEDIA_STAGING_INVALID'});
  } finally {
    store.close();
  }
});

test('an upload completes only with every part, each full-sized but the last, and keeps its bytes encrypted', () => {
  const store = new Store(':memory:', key);
  try {
    const id = 'src-' + crypto.randomUUID(),
      file = randomBytes(2500);
    store.reserveMediaSource('t', id, Date.now() + 60000);
    assert.throws(() => store.putMediaChunk('t', id, 0, Buffer.alloc(0), 1000), {code: 'MEDIA_STAGING_INVALID'});
    assert.throws(() => store.putMediaChunk('t', id, 0, Buffer.alloc(1001), 1000), {code: 'MEDIA_STAGING_INVALID'});
    assert.throws(() => store.putMediaChunk('t', id, 1e9, Buffer.alloc(10), 1000), {code: 'MEDIA_STAGING_INVALID'});
    store.putMediaChunk('t', id, 0, file.subarray(0, 1000), 1000);
    store.putMediaChunk('t', id, 2, file.subarray(2000), 1000);
    assert.throws(() => store.finalizeMediaChunks('t', id, {chunks: 3, size: 2500, chunkBytes: 1000}), {
      code: 'MEDIA_UPLOAD_INCOMPLETE',
      details: {missing_chunk: 1},
    });
    store.putMediaChunk('t', id, 1, file.subarray(1000, 1500), 1000);
    assert.throws(() => store.finalizeMediaChunks('t', id, {chunks: 3, size: 2500, chunkBytes: 1000}), {
      code: 'MEDIA_UPLOAD_INCOMPLETE',
      details: {incomplete_chunk: 1},
    });
    // A part sent again replaces itself.
    store.putMediaChunk('t', id, 1, file.subarray(1000, 2000), 1000);
    assert.equal(store.finalizeMediaChunks('t', id, {chunks: 3, size: 2500, chunkBytes: 1000}), sha256(file));
    assert.deepEqual(store.stagedMedia('t', id), file);
    assert.deepEqual(store.stagedMediaChunk('t', id, 1), file.subarray(1000, 2000));
    assert.throws(() => store.putMediaChunk('t', id, 0, file.subarray(0, 1000), 1000), {code: 'MEDIA_UPLOAD_COMPLETE'});
    const stored = store.db.prepare('SELECT secret FROM media_chunks WHERE tenant_id=? AND id=?').all('t', id);
    assert.equal(stored.length, 3);
    for (const row of stored) assert.equal(String(row.secret).includes(file.subarray(0, 16).toString('base64')), false);
    // Another workspace cannot read it.
    assert.throws(() => store.stagedMedia('other', id), {code: 'REVIEW_EXPIRED'});
  } finally {
    store.close();
  }
});

test('an upload belongs to its member: readers cannot upload, colleagues cannot use it, administrators can', async () => {
  const store = new Store(':memory:', key);
  try {
    const sources = new MediaSources(store, true);
    assert.throws(() => sources.begin(reader, {size: 10}), {code: 'FORBIDDEN'});
    assert.throws(() => new MediaSources(store, false).begin(operator, {size: 10}), {code: 'LIVE_WRITES_DISABLED'});
    assert.throws(() => sources.begin(operator, {size: 0}), {code: 'INVALID_MEDIA_UPLOAD'});
    assert.throws(() => sources.begin(operator, {size: 10, type: 'image/gif'}), {code: 'MEDIA_TYPE_UNSUPPORTED'});
    const done = await upload(sources, operator, png, '../../etc/creative\u0000.png');
    assert.equal(done.state, 'complete');
    assert.equal(done.filename, 'creative.png');
    assert.equal(done.mime, 'image/png');
    assert.equal(done.sha256, sha256(png));
    assert.deepEqual(sources.file(operator, done.source_id).bytes, png);
    assert.deepEqual(sources.file(admin, done.source_id).bytes, png);
    assert.throws(() => sources.file(colleague, done.source_id), {code: 'FORBIDDEN'});
    assert.deepEqual(
      sources.list(colleague).map(s => s.source_id),
      [],
    );
    assert.deepEqual(
      sources.list(admin).map(s => s.source_id),
      [done.source_id],
    );
    assert.equal((await sources.complete(operator, done.source_id)).state, 'complete');
    assert.deepEqual(sources.remove(operator, done.source_id), {source_id: done.source_id, removed: true});
    assert.throws(() => sources.file(operator, done.source_id), {code: 'MEDIA_SOURCE_NOT_FOUND'});
    assert.throws(() => sources.file(operator, 'src-../../x'), {code: 'INVALID_MEDIA_SOURCE'});
    const events = store.db
      .prepare('SELECT event FROM audit')
      .all()
      .map(r => JSON.parse(String(r.event)).event);
    assert.ok(events.includes('media_source_added') && events.includes('media_source_removed'));
  } finally {
    store.close();
  }
});

test('an upload refuses parts of the wrong length, completes once whole (a missing part can follow) and never keeps a non-media file', async () => {
  const store = new Store(':memory:', key);
  try {
    const sources = new MediaSources(store, true),
      file = Buffer.concat([png, randomBytes(SOURCE_CHUNK_BYTES)]),
      started = sources.begin(operator, {filename: 'big.png', size: file.length});
    assert.equal(started.chunks, 2);
    assert.throws(() => sources.put(operator, started.source_id, 0, file.subarray(0, 100)), {
      code: 'INVALID_MEDIA_UPLOAD',
    });
    assert.throws(() => sources.put(operator, started.source_id, 2, file.subarray(0, 100)), {
      code: 'INVALID_MEDIA_UPLOAD',
    });
    sources.put(operator, started.source_id, 0, file.subarray(0, SOURCE_CHUNK_BYTES));
    await assert.rejects(sources.complete(operator, started.source_id), {
      code: 'MEDIA_UPLOAD_INCOMPLETE',
      details: {
        received_chunks: 1,
        expected_chunks: 2,
        received_bytes: SOURCE_CHUNK_BYTES,
        expected_bytes: file.length,
      },
    });
    assert.throws(() => sources.file(operator, started.source_id), {code: 'MEDIA_UPLOAD_INCOMPLETE'});
    // A missing part is sent afterwards; nothing already received is sent again.
    sources.put(operator, started.source_id, 1, file.subarray(SOURCE_CHUNK_BYTES));
    assert.equal((await sources.complete(operator, started.source_id)).sha256, sha256(file));
    assert.deepEqual(sources.file(operator, started.source_id).bytes, file);
    const text = Buffer.from('<html>not an image</html>'),
      other = sources.begin(operator, {size: text.length});
    sources.put(operator, other.source_id, 0, text);
    await assert.rejects(sources.complete(operator, other.source_id), {code: 'MEDIA_TYPE_UNSUPPORTED'});
    // A file that is not media is not kept.
    assert.throws(() => sources.file(operator, other.source_id), {code: 'MEDIA_SOURCE_NOT_FOUND'});
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM media_staging WHERE id=?').get(other.source_id)!.n, 0);
  } finally {
    store.close();
  }
});

test('a public link resolves only to public addresses, stays HTTPS through redirects and must return media', async () => {
  for (const [address, expected] of [
    ['93.184.216.34', true],
    ['2606:4700::1111', true],
    ['10.1.2.3', false],
    ['127.0.0.1', false],
    ['169.254.169.254', false],
    ['100.64.0.1', false],
    ['172.31.255.255', false],
    ['192.168.0.1', false],
    ['0.0.0.0', false],
    ['224.0.0.1', false],
    ['::1', false],
    ['fd12:3456::1', false],
    ['fe80::1', false],
    ['::ffff:127.0.0.1', false],
    ['64:ff9b::a00:1', false],
    ['2002:c0a8:101::1', false],
    ['2001:db8::1', false],
  ] as const)
    assert.equal(publicAddress(address), expected, address);
  for (const link of [
    'http://cdn.example.com/a.png',
    'https://127.0.0.1/a.png',
    'https://[::1]/a.png',
    'https://2130706433/a.png',
    'https://localhost/a.png',
    'https://user:secret@cdn.example.com/a.png',
    'https://cdn.example.com:8443/a.png',
    'https://drive.google.com/file/d/abcdefghijk/view',
    'not a link',
  ])
    assert.throws(() => mediaLinkUrl(link), {code: 'INVALID_MEDIA_LINK'}, link);
  // The real HTTPS transport: a host resolving to a private address is refused before any connection.
  for (const addresses of [
    [{address: '127.0.0.1', family: 4}],
    [{address: '169.254.169.254', family: 4}],
    [
      {address: '93.184.216.34', family: 4},
      {address: '10.0.0.5', family: 4},
    ],
    [{address: 'fd00::1', family: 6}],
  ])
    await assert.rejects(downloadMediaLink('https://cdn.example.com/a.png', {resolve: async () => addresses}), {
      code: 'MEDIA_LINK_BLOCKED',
    });
  const hops: string[] = [],
    request =
      (reply: (url: URL) => Response): LinkRequest =>
      async url => {
        hops.push(url.href);
        return reply(url);
      };
  await assert.rejects(
    downloadMediaLink('https://cdn.example.com/a.png', {
      request: request(() => new Response(null, {status: 302, headers: {location: 'http://cdn.example.com/b.png'}})),
    }),
    {code: 'INVALID_MEDIA_LINK'},
  );
  hops.length = 0;
  await assert.rejects(
    downloadMediaLink('https://cdn.example.com/a.png', {
      request: request(u => new Response(null, {status: 302, headers: {location: u.href + 'x'}})),
    }),
    {code: 'MEDIA_DOWNLOAD_FAILED'},
  );
  assert.equal(hops.length, 4);
  await assert.rejects(
    downloadMediaLink('https://cdn.example.com/a.png', {request: request(() => new Response('no', {status: 403}))}),
    {code: 'MEDIA_LINK_UNAVAILABLE', details: {http_status: 403}},
  );
  await assert.rejects(
    downloadMediaLink('https://cdn.example.com/a.png', {
      request: request(() => new Response('<html>sign in</html>', {headers: {'content-type': 'text/html'}})),
    }),
    {code: 'MEDIA_TYPE_UNSUPPORTED'},
  );
  const got = await downloadMediaLink('https://cdn.example.com/a.png?token=secret-token', {
    request: request(u =>
      u.pathname === '/a.png'
        ? new Response(null, {status: 301, headers: {location: 'https://media.example.net/final.png'}})
        : new Response(png),
    ),
  });
  assert.deepEqual(got.bytes, png);
  assert.equal(got.host, 'media.example.net');
});

test('a link import becomes an upload that records the host only, never the link', async () => {
  const store = new Store(':memory:', key);
  try {
    const sources = new MediaSources(store, true, async () => new Response(png)),
      done = await sources.importLink(operator, 'https://cdn.example.com/banner.png?token=secret-token');
    assert.equal(done.origin, 'link');
    assert.equal(done.link_host, 'cdn.example.com');
    assert.equal(done.filename, 'banner.png');
    assert.deepEqual(sources.file(operator, done.source_id).bytes, png);
    const stored = JSON.stringify(store.db.prepare('SELECT data FROM documents').all()),
      audit = JSON.stringify(store.db.prepare('SELECT event FROM audit').all());
    assert.equal(stored.includes('secret-token'), false);
    assert.equal(audit.includes('secret-token'), false);
    // The shared media byte budget is released afterwards.
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM media_admissions').get()!.n, 0);
    await assert.rejects(
      new MediaSources(store, true, async () => new Response('x', {status: 404})).importLink(
        operator,
        'https://cdn.example.com/missing.png',
      ),
      {code: 'MEDIA_LINK_UNAVAILABLE'},
    );
    assert.equal(sources.list(operator).length, 1);
  } finally {
    store.close();
  }
});

/** A LinkedIn and TikTok advertising API stand-in that keeps the bytes each upload sends. */
function platforms(linkRequest?: LinkRequest) {
  const uploads: {platform: string; bytes: Buffer}[] = [];
  const transport = new NativeTransport((async (input, init) => {
    const url = new URL(String(input)),
      method = init?.method ?? 'GET',
      body = init?.body;
    if (url.hostname === 'www.linkedin.com' && method === 'PUT') {
      uploads.push({platform: 'linkedin', bytes: Buffer.from(body as Uint8Array)});
      return new Response(null, {status: 201});
    }
    if (url.pathname === '/rest/adAccounts/123') return Response.json({id: 123, name: 'Account'});
    if (url.pathname === '/rest/images' && url.searchParams.get('action') === 'initializeUpload')
      return Response.json({
        value: {image: 'urn:li:image:456', uploadUrl: 'https://www.linkedin.com/dms-uploads/456/image'},
      });
    if (url.pathname.startsWith('/rest/images/'))
      return Response.json({id: 'urn:li:image:456', owner: 'urn:li:sponsoredAccount:123', status: 'AVAILABLE'});
    if (url.pathname.endsWith('/advertiser/info/'))
      return Response.json({code: 0, data: {list: [{advertiser_id: '123', name: 'Account'}]}});
    if (url.pathname.endsWith('/file/image/ad/upload/') && body instanceof FormData) {
      uploads.push({
        platform: 'tiktok',
        bytes: Buffer.from(await (body.get('image_file') as Blob).arrayBuffer()),
      });
      return Response.json({code: 0, data: {image_id: 'ad-site/456'}});
    }
    if (url.pathname.endsWith('/file/image/ad/info/'))
      return Response.json({code: 0, data: {list: [{image_id: 'ad-site/456'}]}});
    throw Error('Unexpected request ' + method + ' ' + url.pathname);
  }) as typeof fetch);
  const store = new Store(':memory:', key);
  for (const [gateway, id] of [
    ['linkedin_native_action', 'li'],
    ['tiktok_native_action', 'tt'],
  ] as const)
    store.putConnection(
      {...operator, role: 'admin'},
      {
        id,
        tenantId: 't',
        gateway,
        accounts: ['123'],
        writeAccounts: ['123'],
        label: 'Synthetic',
        enabled: true,
        scopes: [],
      },
      {accessToken: 'synthetic'},
    );
  const service = new MirrorService(
    new Registry(),
    store,
    transport,
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
    undefined,
    linkRequest,
  );
  return {store, service, uploads, sources: service.mediaSources()};
}

test('fit_to_platform scales 4500 × 4500 to 1080 × 1080 for LinkedIn, and execute uploads exactly the reviewed file', async t => {
  if (!(await ffmpegOrSkip(t))) return;
  const f = platforms();
  try {
    const source = await upload(f.sources, operator, await picture(4500, 4500, 'jpeg'), 'square.jpg');
    assert.equal(source.width, 4500);
    assert.equal(source.inspection, 'complete');
    assert.match(String(source.thumbnail_url), /^\/api\/media\/sources\/src-[0-9a-f-]+\/thumbnail$/);
    const plain = await f.service.call(
      'amcp_media',
      {action: 'prepare', platform: 'linkedin', account_id: '123', source_id: source.source_id},
      operator,
    );
    assert.equal(plain.success, true, JSON.stringify(plain));
    assert.equal(plain.data.request.transform, undefined);
    const prepared = await f.service.call(
      'amcp_media',
      {
        action: 'prepare',
        platform: 'linkedin',
        account_id: '123',
        source_id: source.source_id,
        fit_to_platform: true,
      },
      operator,
    );
    assert.equal(prepared.success, true, JSON.stringify(prepared));
    const request = prepared.data.request;
    assert.deepEqual(request.origin, {kind: 'upload', source_id: source.source_id, filename: 'square.jpg'});
    assert.deepEqual(
      {from: request.transform.from.width + '×' + request.transform.from.height, to: request.transform.to},
      {from: '4500×4500', to: {width: 1080, height: 1080, bytes: request.size, mime: 'image/jpeg'}},
    );
    assert.match(request.transform.reasons[0], /4500 × 4500 to 1080 × 1080/);
    const executed = await f.service.call(
      'amcp_media',
      {action: 'execute', review_id: prepared.data.review_id, confirmed: true},
      operator,
    );
    assert.equal(executed.success, true, JSON.stringify(executed));
    const sent = f.uploads.find(u => u.platform === 'linkedin')!.bytes;
    assert.equal(sha256(sent), request.sha256);
    assert.deepEqual(await dimensions(sent), {width: 1080, height: 1080, mime: 'image/jpeg'});
    const receipt = f.store.document('t', 'workspace_asset', prepared.data.review_id);
    assert.equal(receipt.source, 'amcp_upload');
  } finally {
    f.store.close();
  }
});

test('fit_to_platform scales 4500 × 8000 to 1080 × 1920 for TikTok and says why', async t => {
  if (!(await ffmpegOrSkip(t))) return;
  const f = platforms();
  try {
    const source = await upload(f.sources, operator, await picture(4500, 8000, 'png'), 'tall.png'),
      prepared = await f.service.call(
        'amcp_media',
        {action: 'prepare', platform: 'tiktok', account_id: '123', source_id: source.source_id, fit_to_platform: true},
        operator,
      );
    assert.equal(prepared.success, true, JSON.stringify(prepared));
    assert.equal(prepared.data.request.transform.to.width, 1080);
    assert.equal(prepared.data.request.transform.to.height, 1920);
    assert.equal(prepared.data.request.transform.to.bytes <= 5 * 1024 * 1024, true);
    assert.deepEqual(await dimensions(f.store.stagedMedia('t', prepared.data.review_id)), {
      width: 1080,
      height: 1920,
      mime: prepared.data.request.mime,
    });
  } finally {
    f.store.close();
  }
});

test('prepare names one file, and a refusal a fit would solve says so', async t => {
  if (!(await ffmpegOrSkip(t))) return;
  const f = platforms();
  try {
    const source = await upload(f.sources, operator, png),
      both = await f.service.call(
        'amcp_media',
        {
          action: 'prepare',
          platform: 'tiktok',
          account_id: '123',
          source_id: source.source_id,
          drive_url: 'https://drive.google.com/file/d/abcdefghijklmno/view',
        },
        operator,
      );
    assert.equal(both.success, false);
    assert.equal(both.error.code, 'INVALID_ARGUMENT');
    assert.deepEqual(both.error.details.files_named, ['source_id', 'drive_url']);
    // Random pixels do not compress: 1080 × 1920 is 6.2 MB as PNG, above TikTok's 5 MiB.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amcp-media-test-'));
    let noisy: Buffer;
    try {
      await fs.writeFile(path.join(dir, 'noise.rgb'), randomBytes(1080 * 1920 * 3));
      await runMediaProcess(process.env.AMCP_FFMPEG_PATH ?? 'ffmpeg', [
        '-v',
        'error',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-s',
        '1080x1920',
        '-i',
        path.join(dir, 'noise.rgb'),
        '-frames:v',
        '1',
        '-c:v',
        'png',
        path.join(dir, 'noise.png'),
      ]);
      noisy = await fs.readFile(path.join(dir, 'noise.png'));
    } finally {
      await fs.rm(dir, {recursive: true, force: true});
    }
    const heavy = await upload(f.sources, operator, noisy, 'noise.png'),
      refused = await f.service.call(
        'amcp_media',
        {action: 'prepare', platform: 'tiktok', account_id: '123', source_id: heavy.source_id},
        operator,
      );
    assert.equal(refused.error.code, 'MEDIA_TOO_LARGE');
    assert.match(refused.error.message, /fit_to_platform:true/);
    const fitted = await f.service.call(
      'amcp_media',
      {action: 'prepare', platform: 'tiktok', account_id: '123', source_id: heavy.source_id, fit_to_platform: true},
      operator,
    );
    assert.equal(fitted.success, true, JSON.stringify(fitted));
    assert.equal(fitted.data.request.mime, 'image/jpeg');
    assert.match(fitted.data.request.transform.reasons.join(' '), /PNG to JPEG to fit the 5 MiB image limit of TikTok/);
  } finally {
    f.store.close();
  }
});

test('plan shows what each account would receive without staging or calling a platform; prepare holds to it', async t => {
  if (!(await ffmpegOrSkip(t))) return;
  const f = platforms();
  try {
    const source = await upload(f.sources, operator, await picture(4500, 4500, 'jpeg'), 'square.jpg'),
      staged = () => f.store.db.prepare("SELECT count(*) AS n FROM media_staging WHERE id NOT LIKE 'src-%'").get()!.n;
    const planned = await f.service.call(
      'amcp_media',
      {
        action: 'plan',
        source_id: source.source_id,
        fit_to_platform: true,
        destinations: [
          {platform: 'linkedin', account_id: '123'},
          {platform: 'tiktok', account_id: '123'},
          {platform: 'meta', account_id: '123'},
        ],
      },
      operator,
    );
    assert.equal(planned.success, true, JSON.stringify(planned));
    const [linkedin, tiktok, meta] = planned.data.destinations;
    assert.equal(linkedin.ready, true);
    assert.deepEqual([linkedin.file.width, linkedin.file.height, linkedin.file.mime], [1080, 1080, 'image/jpeg']);
    // One conversion serves platforms with the same limits; each review names its own platform.
    assert.equal(tiktok.file.sha256, linkedin.file.sha256);
    assert.match(linkedin.transform.reasons[0], /4500 × 4500 to 1080 × 1080/);
    // Meta has no connection in this workspace: that destination is not ready, and says why.
    assert.equal(meta.ready, false);
    assert.equal(meta.error.code, 'CONNECTION_REQUIRED');
    assert.equal(staged(), 0);
    assert.equal(f.uploads.length, 0);
    const prepared = await f.service.call(
      'amcp_media',
      {
        action: 'prepare',
        platform: 'linkedin',
        account_id: '123',
        source_id: source.source_id,
        fit_to_platform: true,
        expected_sha256: linkedin.file.sha256,
      },
      operator,
    );
    assert.equal(prepared.success, true, JSON.stringify(prepared));
    assert.equal(prepared.data.request.sha256, linkedin.file.sha256);
    const different = await f.service.call(
      'amcp_media',
      {
        action: 'prepare',
        platform: 'tiktok',
        account_id: '123',
        source_id: source.source_id,
        expected_sha256: linkedin.file.sha256,
      },
      operator,
    );
    assert.equal(different.success, false);
    assert.equal(different.error.code, 'MEDIA_CHANGED');
    assert.equal(different.error.details.actual_sha256, source.sha256);
    assert.equal(staged(), 1);
    // Planning uses the upload as prepare would: a member who cannot use it cannot plan with it.
    const refused = await f.service.call(
      'amcp_media',
      {action: 'plan', source_id: source.source_id, destinations: [{platform: 'tiktok', account_id: '123'}]},
      reader,
    );
    assert.equal(refused.error.code, 'FORBIDDEN');
  } finally {
    f.store.close();
  }
});

test('native upload actions and platform_media_upload take any public link, not only Google Drive', async () => {
  const f = platforms(async url => {
    assert.equal(url.hostname, 'cdn.example.com');
    return new Response(png);
  });
  try {
    assert.deepEqual(mediaFileInput('https://drive.google.com/file/d/abcdefghijklmno/view'), {
      drive_url: 'https://drive.google.com/file/d/abcdefghijklmno/view',
    });
    assert.deepEqual(mediaFileInput('https://cdn.example.com/a.png'), {source_url: 'https://cdn.example.com/a.png'});
    assert.throws(() => mediaFileInput('http://10.0.0.1/a.png'), {code: 'INVALID_MEDIA_LINK'});
    assert.throws(() => mediaFileInput('https://drive.google.com/drive/folders/abc'), {code: 'INVALID_DRIVE_LINK'});
    const args = {action: 'tiktok_image_upload', account_id: '123', payload: {url: 'https://cdn.example.com/a.png'}},
      preview = await f.service.call('tiktok_native_action', args, operator);
    assert.equal(preview.data.dry_run, true);
    assert.deepEqual(preview.data.request.source_url, 'https://cdn.example.com/a.png');
    const linked = await f.service.call('tiktok_native_action', {...args, dry_run: false}, operator);
    assert.equal(linked.success, true, JSON.stringify(linked));
    assert.deepEqual(linked.data.request.origin, {kind: 'link', host: 'cdn.example.com'});
    const workflow = await f.service.call(
      'amcp_native_action',
      {
        operation: 'platform_media_upload',
        arguments: {
          action: 'UPLOAD_FROM_URL',
          platform: 'tiktok',
          account_id: '123',
          url: 'https://cdn.example.com/a.png',
          dry_run: false,
        },
      },
      operator,
    );
    assert.equal(workflow.success, true, JSON.stringify(workflow));
    assert.deepEqual(workflow.data.request.origin, {kind: 'link', host: 'cdn.example.com'});
  } finally {
    f.store.close();
  }
});

test('the website takes an upload in parts behind the session and CSRF token; test accounts cannot upload', async () => {
  const master = Buffer.alloc(32, 29).toString('base64'),
    password = 'synthetic-test-password-only',
    origin = 'https://amcp.shop',
    store = new Store(':memory:', master),
    service = new MirrorService(new Registry(), store, undefined, undefined, {
      allowWrites: true,
      requireBeforeState: true,
      maxBudgetChange: 0,
    }),
    listener = await listenForFetch(
      createHttpApp(service, store, {website: {origin, masterKey: master, adminPassword: password}}),
    ),
    base = 'http://127.0.0.1:' + (listener.address() as {port: number}).port;
  const send = async (url: string, init: RequestInit = {}) => {
    const response = await fetch(base + url, {...init, headers: {Origin: origin, ...init.headers}});
    return {status: response.status, body: await response.text(), type: response.headers.get('content-type')};
  };
  try {
    const login = await fetch(base + '/api/session', {
        method: 'POST',
        headers: {Origin: origin, 'Content-Type': 'application/json'},
        body: JSON.stringify({password}),
      }),
      cookie = login.headers.get('set-cookie')!.split(';')[0]!,
      csrf = (await login.json()).csrf,
      json = {'Content-Type': 'application/json', Cookie: cookie, 'X-AMCP-CSRF': csrf},
      file = Buffer.concat([png, randomBytes(SOURCE_CHUNK_BYTES + 10)]);
    const noCsrf = await send('/api/media/sources', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Cookie: cookie},
      body: JSON.stringify({size: file.length}),
    });
    assert.equal(noCsrf.status, 403);
    const started = await send('/api/media/sources', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({filename: 'creative.png', size: file.length, type: 'image/png'}),
    });
    assert.equal(started.status, 201, started.body);
    const {source_id: id, chunks} = JSON.parse(started.body);
    assert.equal(chunks, 2);
    const part = (index: number, bytes: Buffer, headers: Record<string, string> = {}) =>
      send('/api/media/sources/' + id + '/parts/' + index, {
        method: 'PUT',
        headers: {'Content-Type': 'application/octet-stream', Cookie: cookie, 'X-AMCP-CSRF': csrf, ...headers},
        body: new Uint8Array(bytes),
      });
    assert.equal((await part(0, file.subarray(0, 1000))).status, 400);
    assert.equal((await part(0, file.subarray(0, SOURCE_CHUNK_BYTES), {'Content-Type': 'text/plain'})).status, 415);
    assert.equal((await part(0, file.subarray(0, SOURCE_CHUNK_BYTES), {'X-AMCP-CSRF': 'wrong'})).status, 403);
    assert.equal((await part(0, file.subarray(0, SOURCE_CHUNK_BYTES))).status, 200);
    assert.equal((await part(1, file.subarray(SOURCE_CHUNK_BYTES))).status, 200);
    const completed = await send('/api/media/sources/' + id + '/complete', {method: 'POST', headers: json});
    assert.equal(completed.status, 200, completed.body);
    assert.equal(JSON.parse(completed.body).sha256, sha256(file));
    const listed = await send('/api/media/sources', {headers: {Cookie: cookie}});
    assert.deepEqual(
      JSON.parse(listed.body).sources.map((s: JsonObject) => s.source_id),
      [id],
    );
    const removed = await send('/api/media/sources/' + id, {method: 'DELETE', headers: json});
    assert.equal(removed.status, 200);
    assert.equal((await send('/api/media/sources/' + id + '/complete', {method: 'POST', headers: json})).status, 404);
    // A reviewer test account cannot reach the upload routes at all.
    const web = new WebStore(store, {origin, masterKey: master, adminPassword: password}),
      test = web.createSession({tenantId: 'review', userId: 'workspace-test', role: 'admin', testAccount: true});
    const refused = await send('/api/media/sources', {
      method: 'POST',
      headers: {...json, Cookie: web.cookie(test.id).split(';')[0]!, 'X-AMCP-CSRF': test.csrf},
      body: JSON.stringify({size: 10}),
    });
    assert.equal(refused.status, 403);
    assert.match(refused.body, /TEST_ACCOUNT_SCOPE/);
  } finally {
    const closed = new Promise<void>(r => listener.close(() => r()));
    listener.closeAllConnections();
    await closed;
    store.close();
  }
});

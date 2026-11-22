// MED-04 B (review 2026-10-08): a receipt names where its bytes came from and keeps the original's SHA-256. `source()`
// labelled every source_id as an upload, so a link or Drive import pushed by source_id was recorded as `amcp_upload`,
// and no review or receipt kept the original's hash, size or type: once the original expired, nothing linked a fitted
// or variant upload to the file it was made from, and the library could not group one original's uploads.
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {MediaSources, SOURCE_TTL_MS} from '../src/media-sources.js';
import {receiptSource} from '../src/media-upload.js';
import {ffmpegPath, runMediaProcess} from '../src/media-variants.js';
import {sha256, stable} from '../src/security.js';
import type {Actor, JsonObject} from '../src/types.js';
import {removeTestDirectoryAsync} from './temp.js';

const key = Buffer.alloc(32, 47).toString('base64'),
  owner: Actor = {tenantId: 't', userId: 'owner', role: 'admin'},
  operator: Actor = {tenantId: 't', userId: 'uploader', role: 'operator'};

/** A one-pixel PNG; each `variety` is another file (bytes after IEND), so each has its own SHA-256. */
function png(variety = 0) {
  const base = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
  return variety ? Buffer.concat([base, Buffer.from('variety-' + variety, 'latin1')]) : base;
}
/** A completed upload or import record with its bytes staged, as media-sources.ts leaves one. */
function staged(store: Store, origin: 'upload' | 'link' | 'drive', bytes = png()) {
  store.ensureTenant(operator.tenantId);
  const id = 'src-' + randomUUID(),
    now = Date.now();
  store.reserveMediaSource(operator.tenantId, id, now + SOURCE_TTL_MS);
  store.stageMedia(operator.tenantId, id, bytes);
  store.putDocument(operator.tenantId, 'media_source', id, {
    user_id: operator.userId,
    filename: 'original-' + origin + '.png',
    origin,
    ...(origin === 'link' ? {link_host: 'cdn.example.com'} : {}),
    ...(origin === 'drive' ? {drive: {connection_id: 'drive', file_id: 'file-1', folder_id: null}} : {}),
    state: 'complete',
    size: bytes.length,
    mime: 'image/png',
    kind: 'image',
    sha256: sha256(bytes),
    created_at: now,
    expires_at: now + SOURCE_TTL_MS,
    inspection: 'unavailable',
  });
  return id;
}
/** A service whose Meta accounts 101 and 102 accept image uploads and answer availability checks. */
function fixture() {
  const store = new Store(':memory:', key);
  store.putConnection(
    owner,
    {
      id: 'meta',
      tenantId: 't',
      gateway: 'meta_native_action',
      accounts: ['101', '102'],
      writeAccounts: ['101', '102'],
      label: 'Synthetic',
      enabled: true,
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const available = new Set<string>();
  let uploads = 0;
  const transport = new NativeTransport((async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)),
      method = init?.method ?? 'GET';
    if (method === 'GET' && url.pathname.endsWith('/adimages'))
      return Response.json({
        data: [...available]
          .filter(h => String(url.searchParams.get('hashes') ?? '').includes(h))
          .map(hash => ({hash})),
      });
    if (method === 'GET' && /\/act_\d+$/.test(url.pathname))
      return Response.json({id: url.pathname.split('/').pop(), account_status: 1, currency: 'USD'});
    if (method === 'POST' && url.pathname.endsWith('/adimages')) {
      const hash = 'synthetic_hash_' + ++uploads;
      available.add(hash);
      return Response.json({images: {one: {hash}}});
    }
    throw Error('Unexpected provider request ' + method + ' ' + url.pathname);
  }) as typeof fetch);
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const media = async (input: JsonObject, actor = operator) => service.call('amcp_media', input, actor);
  /** Prepares and executes one upload; returns its review request and receipt. */
  const push = async (file: JsonObject, account = '101') => {
    const prepared = await media({action: 'prepare', platform: 'meta', account_id: account, ...file});
    assert.equal(prepared.success, true, JSON.stringify(prepared.error));
    const executed = await media({action: 'execute', review_id: prepared.data.review_id, confirmed: true});
    assert.equal(executed.success, true, JSON.stringify(executed.error));
    return {
      request: prepared.data.request as JsonObject,
      receipt: store.document('t', 'workspace_asset', prepared.data.review_id),
      review_id: prepared.data.review_id as string,
    };
  };
  return {store, service, media, push, sources: new MediaSources(store, true)};
}

test('website, link, Drive and retained sources each keep their documented label and the original SHA-256', async () => {
  const f = fixture();
  try {
    const cases: [string, 'upload' | 'link' | 'drive', string, string][] = [
      ['website upload', 'upload', 'website_upload', 'amcp_upload'],
      ['link import', 'link', 'link_import', 'link_import'],
      ['Drive import', 'drive', 'drive_import', 'server_drive_import'],
    ];
    for (const [label, origin, kind, source] of cases) {
      const bytes = png(cases.findIndex(c => c[1] === origin) + 1),
        id = staged(f.store, origin, bytes),
        {request, receipt} = await f.push({source_id: id});
      assert.equal(request.origin.kind, kind, label);
      assert.equal(request.origin.source_id, id, label);
      assert.equal(request.origin.original_sha256, sha256(bytes), label);
      assert.equal(request.origin.original_size, bytes.length, label);
      assert.equal(request.origin.original_mime, 'image/png', label);
      // Before MED-04 every source_id was recorded as a website upload.
      assert.equal(receipt.source, source, label);
      assert.equal(receipt.original_sha256, sha256(bytes), label);
    }
    // The link import keeps its host (never the link); an owner-retained copy of it is labelled as retained.
    const linked = staged(f.store, 'link', png(9)),
      retained = f.sources.retain(owner, linked, {confirmed: true, expected_sha256: sha256(png(9))}),
      {request, receipt} = await f.push({source_id: retained.source_id});
    assert.deepEqual(request.origin, {
      kind: 'retained_original',
      source_id: retained.source_id,
      filename: 'original-link.png',
      original_sha256: sha256(png(9)),
      original_size: png(9).length,
      original_mime: 'image/png',
      link_host: 'cdn.example.com',
      imported_from: 'link_import',
      original_source_id: linked,
    });
    assert.equal(receipt.source, 'retained_original');
    assert.equal(receipt.original_sha256, sha256(png(9)));
    // Receipt labels of reviews prepared before MED-04 stay as they were.
    assert.equal(receiptSource({origin: {kind: 'upload', source_id: 'src-x', filename: 'x.png'}}), 'amcp_upload');
    assert.equal(receiptSource({origin: {kind: 'link', host: 'cdn.example.com'}}), 'link_import');
    assert.equal(receiptSource({}), 'server_drive_import');
  } finally {
    f.store.close();
  }
});

test('a review prepared before MED-04 keeps its fingerprint and label, and executes unchanged', async () => {
  const f = fixture();
  try {
    const id = staged(f.store, 'upload'),
      prepared = await f.media({action: 'prepare', platform: 'meta', account_id: '101', source_id: id});
    assert.equal(prepared.success, true, JSON.stringify(prepared.error));
    // Rewrite it as the previous release stored it: the old origin shape, fingerprinted as it was then.
    const review = f.store.document('t', 'media_review', prepared.data.review_id),
      {id: _id, revision: _revision, ...stored} = review,
      plan = {...stored.plan, origin: {kind: 'upload', source_id: id, filename: 'original-upload.png'}},
      fingerprint = sha256(stable({tenant: 't', user: operator.userId, plan}));
    f.store.putDocument('t', 'media_review', prepared.data.review_id, {...stored, plan, fingerprint});
    const executed = await f.media({action: 'execute', review_id: prepared.data.review_id, confirmed: true});
    assert.equal(executed.success, true, JSON.stringify(executed.error));
    const receipt = f.store.document('t', 'workspace_asset', prepared.data.review_id);
    assert.equal(receipt.source, 'amcp_upload');
    assert.equal(receipt.original_sha256, undefined);
  } finally {
    f.store.close();
  }
});

test('the library groups the receipts of one original across accounts, and refuses a malformed hash', async () => {
  const f = fixture();
  try {
    const original = staged(f.store, 'link', png(3)),
      other = staged(f.store, 'link', png(4));
    const first = await f.push({source_id: original}, '101'),
      second = await f.push({source_id: original}, '102'),
      unrelated = await f.push({source_id: other}, '101');
    const same = await f.media({action: 'library', original_sha256: sha256(png(3))});
    assert.equal(same.success, true, JSON.stringify(same.error));
    assert.deepEqual(
      (same.data.assets as JsonObject[]).map(a => [a.asset_id, a.account_id, a.original_sha256]).sort(),
      [
        [first.review_id, '101', sha256(png(3))],
        [second.review_id, '102', sha256(png(3))],
      ].sort(),
    );
    assert.equal(same.data.filters.original_sha256, sha256(png(3)));
    const all = await f.media({action: 'library'});
    assert.equal((all.data.assets as JsonObject[]).length, 3);
    // Without the filter the binding (and every earlier cursor) is unchanged.
    assert.equal('original_sha256' in all.data.filters, false);
    const asset = await f.media({action: 'asset', asset_id: unrelated.review_id});
    assert.equal(asset.data.original_sha256, sha256(png(4)));
    assert.equal(asset.data.source_kind, 'link_import');
    const malformed = await f.media({action: 'library', original_sha256: 'ABC'});
    assert.equal(malformed.success, false);
    assert.equal(malformed.error.code, 'INVALID_ARGUMENT');
  } finally {
    f.store.close();
  }
});

async function ffmpegOrSkip(t: TestContext) {
  try {
    await runMediaProcess(ffmpegPath(), ['-version']);
    await runMediaProcess(process.env.AMCP_FFPROBE_PATH ?? 'ffprobe', ['-version']);
    return true;
  } catch (e) {
    if (process.env.AMCP_REQUIRE_FFMPEG === 'true') throw e;
    t.skip('FFmpeg is required in release CI and Docker; this local host has no configured FFmpeg.');
    return false;
  }
}

test('a fitted upload and a variant upload still name the original they were made from', async t => {
  if (!(await ffmpegOrSkip(t))) return;
  const f = fixture(),
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amcp-lineage-'));
  try {
    const file = path.join(dir, 'large.png');
    await runMediaProcess(ffmpegPath(), [
      ...['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=2400x1600:duration=1'],
      ...['-frames:v', '1', file],
    ]);
    const large = await fs.readFile(file),
      id = staged(f.store, 'link', large),
      fitted = await f.push({source_id: id, fit_to_platform: true});
    assert.notEqual(fitted.request.sha256, sha256(large), 'the uploaded file is the fitted copy');
    assert.equal(fitted.request.origin.original_sha256, sha256(large));
    assert.equal(fitted.receipt.original_sha256, sha256(large));
    const variant = await f.media({action: 'variant', source_id: id, preset: 'square', fit: 'contain'});
    assert.equal(variant.success, true, JSON.stringify(variant.error));
    const viaVariant = await f.push({variant_id: variant.data.variant_id}, '102');
    assert.deepEqual(viaVariant.request.origin.variant, {
      variant_id: variant.data.variant_id,
      preset: 'square',
      fit: 'contain',
      source_sha256: sha256(large),
    });
    assert.equal(viaVariant.request.origin.kind, 'link_import');
    assert.equal(viaVariant.receipt.source, 'link_import');
    assert.equal(viaVariant.receipt.original_sha256, sha256(large));
    // Both uploads group under their one original in the library.
    const same = await f.media({action: 'library', original_sha256: sha256(large)});
    assert.equal((same.data.assets as JsonObject[]).length, 2);
    assert.deepEqual(
      (same.data.assets as JsonObject[]).map(a => a.variant_preset ?? null).sort(),
      [null, 'square'].sort(),
    );
  } finally {
    f.store.close();
    await removeTestDirectoryAsync(dir, 'amcp-lineage-');
  }
});

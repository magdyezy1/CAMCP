import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../dist/src/store.js';
import {MediaSources} from '../dist/src/media-sources.js';
import {
  WEBSITE_UPLOAD_TTL_MS,
  MEDIA_CLEANUP_INTERVAL_MS,
  withWebsiteUploadDeadline,
  mediaProcessingDeadline,
} from '../dist/src/media-retention.js';
import {runMediaProcess, withMediaFile} from '../dist/src/media-variants.js';
import {RetainedMedia} from '../dist/src/retained-media.js';
import {sha256} from '../dist/src/security.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {createEncryptedBackup, restoreEncryptedBackup} from '../dist/src/backup.js';
import {removeTestDirectoryAsync} from '../dist/tests/temp.js';

const key = Buffer.alloc(32, 155).toString('base64'),
  actor = {tenantId: 'media-deadline', userId: 'owner', role: 'admin'},
  png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
function source(store, origin = 'upload', owner = actor) {
  const id = 'src-' + randomUUID(),
    now = Date.now();
  store.ensureTenant(owner.tenantId);
  store.reserveMediaSource(owner.tenantId, id, now + WEBSITE_UPLOAD_TTL_MS);
  store.stageMedia(owner.tenantId, id, png);
  store.putDocument(owner.tenantId, 'media_source', id, {
    user_id: owner.userId,
    filename: 'deadline.png',
    origin,
    state: 'complete',
    size: png.length,
    mime: 'image/png',
    kind: 'image',
    sha256: sha256(png),
    created_at: now,
    expires_at: now + WEBSITE_UPLOAD_TTL_MS,
    inspection: 'unavailable',
    thumbnail: store.sealValue(owner.tenantId, 'media-thumbnail', id, {jpeg: png.toString('base64')}),
  });
  return id;
}
function service(store) {
  const requests = [];
  store.putConnection(
    actor,
    {
      id: 'meta',
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['100'],
      writeAccounts: ['100'],
      label: 'Synthetic upload account',
      enabled: true,
      scopes: ['ads_management'],
    },
    {accessToken: 'synthetic'},
  );
  const mirror = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      requests.push({url: String(url), method: init?.method});
      assert.equal(init?.method, 'GET', 'Deadline fixture never uploads to a provider');
      return Response.json({id: 'act_100', name: 'Synthetic', currency: 'USD', timezone_name: 'UTC'});
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  return {mirror, requests};
}
test('website uploads cannot gain durable retention and access expires exactly at the original 30-minute boundary', t => {
  let now = 1900000000000;
  t.mock.method(Date, 'now', () => now);
  const store = new Store(':memory:', key),
    sources = new MediaSources(store, true),
    id = source(store);
  try {
    const deadline = now + WEBSITE_UPLOAD_TTL_MS,
      visible = sources.list(actor)[0];
    assert.equal(visible.can_retain, false);
    assert.equal(visible.retention.lifetime_minutes, 30);
    assert.throws(() => sources.retain(actor, id, {confirmed: true, expected_sha256: sha256(png)}), {
      code: 'MEDIA_RETENTION_DISABLED',
    });
    now = deadline - 1;
    assert.deepEqual(sources.file(actor, id).bytes, png);
    // Even a legacy or edited expiry cannot extend a computer upload.
    store.putDocument(actor.tenantId, 'media_source', id, {
      ...store.document(actor.tenantId, 'media_source', id),
      expires_at: deadline + 86400000,
    });
    now = deadline;
    assert.throws(() => sources.file(actor, id), {code: 'MEDIA_SOURCE_NOT_FOUND'});
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM media_chunks').get().n, 0);
    assert.equal(sources.list(actor).length, 0);
  } finally {
    store.close();
  }
});
test('independent timer erases expired encrypted source chunks, thumbnails and legacy retained upload copies without worker jobs', t => {
  t.mock.timers.enable({apis: ['setInterval', 'Date'], now: 1900000000000});
  const store = new Store(':memory:', key),
    sources = new MediaSources(store, true),
    id = source(store, 'link');
  try {
    const retained = sources.retain(actor, id, {confirmed: true, expected_sha256: sha256(png)});
    for (const [kind, identity] of [
      ['media_source', id],
      ['retained_media_source', retained.source_id],
    ]) {
      const row = store.document(actor.tenantId, kind, identity);
      store.putDocument(actor.tenantId, kind, identity, {...row, origin: 'upload'});
    }
    const deadline = Date.now() + WEBSITE_UPLOAD_TTL_MS;
    assert.equal(sources.list(actor).find(row => row.retained).expires_at, new Date(deadline).toISOString());
    t.mock.timers.tick(WEBSITE_UPLOAD_TTL_MS - 1);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM media_chunks').get().n, 1);
    t.mock.timers.tick(1);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM media_chunks').get().n, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM retained_media_chunks').get().n, 0);
    assert.equal(store.documents(actor.tenantId, 'media_source').length, 0);
    assert.equal(store.documents(actor.tenantId, 'retained_media_source').length, 0);
    assert.equal(store.mediaCleanupHealth.cleanup_interval_ms, MEDIA_CLEANUP_INTERVAL_MS);
    assert.equal(store.mediaCleanupHealth.last_success_at, deadline);
    assert.equal(store.db.prepare('PRAGMA secure_delete').get().secure_delete, 1);
  } finally {
    store.close();
  }
});
test('legacy upload cleanup isolates matching retained IDs in other tenants and preserves metadata receipts', t => {
  let now = 1900000000000;
  t.mock.method(Date, 'now', () => now);
  const store = new Store(':memory:', key),
    sources = new MediaSources(store, true),
    other = {...actor, tenantId: 'independent-media-tenant', userId: 'other-owner'};
  try {
    const first = source(store, 'link'),
      retained = sources.retain(actor, first, {confirmed: true, expected_sha256: sha256(png)}),
      metadata = store.document(actor.tenantId, 'retained_media_source', retained.source_id),
      second = source(store, 'drive', other);
    store.putDocument(actor.tenantId, 'retained_media_source', retained.source_id, {...metadata, origin: 'upload'});
    new RetainedMedia(store).copy(
      other.tenantId,
      second,
      retained.source_id,
      {size: png.length, sha256: sha256(png)},
      head => assert.deepEqual(head, png),
    );
    store.putDocument(other.tenantId, 'retained_media_source', retained.source_id, {
      ...metadata,
      user_id: other.userId,
      origin: 'drive',
      thumbnail: undefined,
    });
    store.putDocument(actor.tenantId, 'workspace_asset', retained.source_id, {media_id: 'KEEP_PROVIDER_RECEIPT'});
    now += WEBSITE_UPLOAD_TTL_MS;
    store.cleanupTransient();
    assert.throws(() => sources.file(actor, retained.source_id), {code: 'MEDIA_SOURCE_NOT_FOUND'});
    assert.deepEqual(sources.file(other, retained.source_id).bytes, png);
    assert.equal(
      store.document(actor.tenantId, 'workspace_asset', retained.source_id).media_id,
      'KEEP_PROVIDER_RECEIPT',
    );
    assert.equal(
      store.db.prepare('SELECT count(*) AS n FROM retained_media_chunks WHERE tenant_id=?').get(actor.tenantId).n,
      0,
    );
    assert.equal(
      store.db.prepare('SELECT count(*) AS n FROM retained_media_chunks WHERE tenant_id=?').get(other.tenantId).n,
      1,
    );
  } finally {
    store.close();
  }
});

test('processing deadlines stay inside their async request and nested media work cannot extend them', async () => {
  const deadline = Date.now() + 60000;
  let release;
  const gate = new Promise(resolve => (release = resolve)),
    scoped = withWebsiteUploadDeadline(deadline, async () => {
      assert.equal(mediaProcessingDeadline(), deadline);
      await gate;
      await withWebsiteUploadDeadline(deadline + 60000, async () => assert.equal(mediaProcessingDeadline(), deadline));
      await withWebsiteUploadDeadline(undefined, async () => assert.equal(mediaProcessingDeadline(), deadline));
      await withWebsiteUploadDeadline(deadline - 1000, async () =>
        assert.equal(mediaProcessingDeadline(), deadline - 1000),
      );
      assert.equal(mediaProcessingDeadline(), deadline);
    });
  assert.equal(mediaProcessingDeadline(), undefined);
  await withWebsiteUploadDeadline(undefined, async () => assert.equal(mediaProcessingDeadline(), undefined));
  release();
  await scoped;
  assert.equal(mediaProcessingDeadline(), undefined);
  let entered = false;
  await assert.rejects(
    withWebsiteUploadDeadline(Date.now() - 1, async () => (entered = true)),
    {code: 'MEDIA_SOURCE_NOT_FOUND'},
  );
  assert.equal(entered, false);
});

test('a processor holding a local upload file closes at its absolute expiry before its temporary directory is removed', async () => {
  const deadline = Date.now() + 1000,
    started = performance.now();
  let directory;
  await assert.rejects(
    withWebsiteUploadDeadline(deadline, () =>
      withMediaFile(png, 'Synthetic processing test', async (input, temporary) => {
        directory = temporary;
        return runMediaProcess(
          process.execPath,
          ['-e', "require('node:fs').openSync(process.argv[1], 'r');setInterval(() => {}, 1000)", input],
          15000,
        );
      }),
    ),
    {code: 'MEDIA_SOURCE_NOT_FOUND'},
  );
  assert.ok(
    performance.now() - started < 7000,
    'Original expiry must stop the process before its normal 15-second timeout',
  );
  assert.ok(directory);
  await assert.rejects(fs.stat(directory), {code: 'ENOENT'});
});

test('a fresh media review near expiry inherits the original deadline and cannot execute beyond it', async t => {
  let now = 1900000000000;
  t.mock.method(Date, 'now', () => now);
  const store = new Store(':memory:', key),
    id = source(store),
    f = service(store),
    deadline = now + WEBSITE_UPLOAD_TTL_MS;
  try {
    now = deadline - 60000;
    const prepared = await f.mirror.call(
      'amcp_media',
      {
        action: 'prepare',
        source_id: id,
        platform: 'meta',
        account_id: '100',
        connection_id: 'meta',
        fit_to_platform: false,
      },
      actor,
    );
    assert.equal(prepared.success, true, JSON.stringify(prepared));
    const review = store.document(actor.tenantId, 'media_review', prepared.data.review_id);
    assert.equal(review.expires_at, deadline);
    assert.equal(review.plan.upload_expires_at, deadline);
    assert.equal(
      store.db.prepare('SELECT expires_at FROM media_staging WHERE id=?').get(prepared.data.review_id).expires_at,
      deadline,
    );
    const before = f.requests.length;
    now = deadline;
    const refused = await f.mirror.call(
      'amcp_media',
      {
        action: 'execute',
        review_id: prepared.data.review_id,
        confirmed: true,
        idempotency_key: prepared.data.review_id,
      },
      actor,
    );
    assert.equal(refused.success, false);
    assert.equal(refused.error.code, 'REVIEW_EXPIRED');
    assert.equal(f.requests.length, before);
    store.cleanupTransient();
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM media_chunks').get().n, 0);
    assert.equal(store.documents(actor.tenantId, 'media_review').length, 1, 'Metadata review history is retained');
  } finally {
    store.close();
  }
});
test(
  'a real FFmpeg variant and a review of that variant keep the original upload deadline',
  {skip: process.env.AMCP_REQUIRE_FFMPEG !== 'true' && !process.env.AMCP_FFMPEG_PATH},
  async t => {
    let now = 1900000000000;
    t.mock.method(Date, 'now', () => now);
    const store = new Store(':memory:', key),
      id = source(store),
      f = service(store),
      deadline = now + WEBSITE_UPLOAD_TTL_MS;
    try {
      now = deadline - 60000;
      const converted = await f.mirror.call(
        'amcp_media',
        {action: 'variant', source_id: id, preset: 'square', fit: 'contain'},
        actor,
      );
      assert.equal(converted.success, true, JSON.stringify(converted));
      assert.equal(converted.data.expires_at, deadline);
      assert.equal(converted.data.upload_expires_at, deadline);
      assert.equal(converted.data.width, 1080);
      const prepared = await f.mirror.call(
        'amcp_media',
        {
          action: 'prepare',
          variant_id: converted.data.id,
          platform: 'meta',
          account_id: '100',
          connection_id: 'meta',
          fit_to_platform: false,
        },
        actor,
      );
      assert.equal(prepared.success, true, JSON.stringify(prepared));
      assert.equal(store.document(actor.tenantId, 'media_review', prepared.data.review_id).expires_at, deadline);
      const before = f.requests.length;
      now = deadline;
      const refused = await f.mirror.call(
        'amcp_media',
        {action: 'prepare', variant_id: converted.data.id, platform: 'meta', account_id: '100', connection_id: 'meta'},
        actor,
      );
      assert.equal(refused.success, false);
      assert.equal(refused.error.code, 'REVIEW_EXPIRED');
      assert.equal(f.requests.length, before);
      store.cleanupTransient();
      assert.equal(store.db.prepare('SELECT count(*) AS n FROM media_chunks').get().n, 0);
      assert.equal(store.documents(actor.tenantId, 'media_variant').length, 0);
    } finally {
      store.close();
    }
  },
);
test('restart cleanup caps historical review/variant copies, removes expired originals, and preserves provider receipts', async t => {
  let now = 1900000000000;
  t.mock.method(Date, 'now', () => now);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amcp-media-deadline-restart-')),
    file = path.join(directory, 'state.sqlite');
  let store = new Store(file, key);
  try {
    const id = source(store),
      deadline = now + WEBSITE_UPLOAD_TTL_MS;
    for (const kind of ['media_review', 'media_variant']) {
      const copy = randomUUID();
      store.reserveMedia(actor.tenantId, copy, deadline + 300000);
      store.stageMedia(actor.tenantId, copy, png);
      store.putDocument(actor.tenantId, kind, copy, {
        expires_at: deadline + 300000,
        ...(kind === 'media_review'
          ? {plan: {origin: {kind: 'upload', source_id: id}}}
          : {origin: {kind: 'upload', source_id: id}}),
      });
    }
    store.putDocument(actor.tenantId, 'workspace_asset', 'provider-receipt', {
      platform: 'meta',
      account_id: '100',
      media_id: 'KEEP_PROVIDER_ID',
      sha256: sha256(png),
    });
    store.close();
    now = deadline;
    store = new Store(file, key);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM media_chunks').get().n, 0);
    assert.equal(store.documents(actor.tenantId, 'media_variant').length, 0);
    assert.equal(store.document(actor.tenantId, 'workspace_asset', 'provider-receipt').media_id, 'KEEP_PROVIDER_ID');
    assert.equal(store.documents(actor.tenantId, 'media_review')[0].expires_at, deadline);
  } finally {
    store.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('amcp-media-deadline-restart-'));
    await removeTestDirectoryAsync(directory, 'amcp-media-deadline-restart-');
  }
});
test('new encrypted backups exclude temporary media and legacy retained uploads while preserving separately imported originals', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amcp-media-deadline-backup-')),
    store = new Store(':memory:', key);
  let restored;
  try {
    const sources = new MediaSources(store, true),
      uploaded = source(store),
      imported = source(store, 'drive'),
      durable = sources.retain(actor, imported, {confirmed: true, expected_sha256: sha256(png)});
    const legacy = source(store, 'link'),
      retained = sources.retain(actor, legacy, {confirmed: true, expected_sha256: sha256(png)});
    store.putDocument(actor.tenantId, 'retained_media_source', retained.source_id, {
      ...store.document(actor.tenantId, 'retained_media_source', retained.source_id),
      origin: 'upload',
    });
    const backup = path.join(directory, 'safe.amcp'),
      destination = path.join(directory, 'restored.sqlite');
    await createEncryptedBackup(store, backup, key);
    assert.deepEqual(sources.file(actor, uploaded).bytes, png, 'Backup leaves the running source untouched');
    await restoreEncryptedBackup(backup, destination, key);
    restored = new Store(destination, key);
    assert.equal(restored.db.prepare('SELECT count(*) AS n FROM media_chunks').get().n, 0);
    assert.equal(restored.documents(actor.tenantId, 'media_source').length, 0);
    assert.deepEqual(new MediaSources(restored, true).file(actor, durable.source_id).bytes, png);
    assert.throws(() => new MediaSources(restored, true).file(actor, retained.source_id), {
      code: 'MEDIA_SOURCE_NOT_FOUND',
    });
  } finally {
    restored?.close();
    store.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('amcp-media-deadline-backup-'));
    await removeTestDirectoryAsync(directory, 'amcp-media-deadline-backup-');
  }
});

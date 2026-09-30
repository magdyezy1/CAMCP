import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../dist/src/store.js';
import {MediaSources, SOURCE_CHUNK_BYTES} from '../dist/src/media-sources.js';
import {MirrorError} from '../dist/src/errors.js';
import {sha256, SecretBox, scopeKey} from '../dist/src/security.js';
import {removeTestDirectory} from '../dist/tests/temp.js';

const key = Buffer.alloc(32, 76).toString('base64'),
  actor = {tenantId: 't', userId: 'u', role: 'operator'},
  png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
function start(store) {
  const sources = new MediaSources(store, true),
    upload = sources.begin(actor, {filename: 'synthetic.png', size: png.length, type: 'image/png'});
  sources.put(actor, upload.source_id, 0, png);
  return {sources, id: upload.source_id, expected: {chunks: 1, size: png.length, chunkBytes: SOURCE_CHUNK_BYTES}};
}

test('media completion resumes after a restart between manifest finalization and inspection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'amcp-source-recovery-')),
    database = join(directory, 'store.sqlite');
  let store = new Store(database, key);
  try {
    const f = start(store);
    store.finalizeMediaChunks('t', f.id, f.expected);
    assert.equal(store.document('t', 'media_source', f.id).state, 'receiving');
    store.close();
    store = new Store(database, key);
    const sources = new MediaSources(store, true);
    assert.throws(() => sources.put(actor, f.id, 0, png), {code: 'MEDIA_UPLOAD_COMPLETE'});
    const result = await sources.complete(actor, f.id);
    assert.equal(result.state, 'complete');
    assert.equal(result.sha256, sha256(png));
    assert.deepEqual(sources.file(actor, f.id).bytes, png);
  } finally {
    store.close();
    removeTestDirectory(directory, 'amcp-source-recovery-');
  }
});

for (const mutation of ['actor', 'removed', 'expired'])
  test('media completion checks ' + mutation + ' again after asynchronous inspection', async () => {
    const store = new Store(':memory:', key);
    try {
      const f = start(store);
      // Control the asynchronous inspection boundary without invoking a provider or spawning FFmpeg.
      f.sources.inspect = async () => {
        if (mutation === 'actor')
          store.bindActorCheck(actor, () => {
            throw new MirrorError('UNAUTHORIZED', 'Synthetic actor withdrawal.', {}, 401);
          });
        if (mutation === 'removed') f.sources.remove(actor, f.id);
        if (mutation === 'expired') store.db.prepare('UPDATE media_staging SET expires_at=0 WHERE id=?').run(f.id);
        return {inspection: 'unavailable'};
      };
      await assert.rejects(
        () => f.sources.complete(actor, f.id),
        e => ['UNAUTHORIZED', 'MEDIA_SOURCE_NOT_FOUND', 'REVIEW_EXPIRED'].includes(e.code),
      );
      assert.equal(store.documents('t', 'media_source').length, 0);
      assert.equal(
        store.db
          .prepare("SELECT COUNT(*) AS n FROM audit WHERE json_extract(event,'$.event')='media_source_added'")
          .get().n,
        0,
      );
    } finally {
      store.close();
    }
  });

test('concurrent completion cannot inspect or discard another completion in progress', async () => {
  const store = new Store(':memory:', key);
  let release;
  try {
    const f = start(store),
      gate = new Promise(resolve => {
        release = resolve;
      });
    let inspections = 0;
    f.sources.inspect = async () => {
      inspections++;
      await gate;
      return {inspection: 'unavailable'};
    };
    const pending = f.sources.complete(actor, f.id);
    await assert.rejects(
      () => f.sources.complete(actor, f.id),
      e => e.code === 'MEDIA_SOURCE_BUSY' && e.retryable,
    );
    assert.equal(inspections, 1);
    release();
    assert.equal((await pending).state, 'complete');
    assert.deepEqual(f.sources.file(actor, f.id).bytes, png);
  } finally {
    release?.();
    store.close();
  }
});

test('resuming a finalized manifest rejects changed integrity evidence and discards the upload', async () => {
  const store = new Store(':memory:', key);
  try {
    const f = start(store);
    store.finalizeMediaChunks('t', f.id, f.expected);
    const changed = new SecretBox(key).seal(
      {chunks: 1, size: png.length, sha256: '0'.repeat(64)},
      scopeKey('t', 'media', f.id),
    );
    store.db.prepare('UPDATE media_staging SET secret=? WHERE tenant_id=? AND id=?').run(changed, 't', f.id);
    await assert.rejects(() => f.sources.complete(actor, f.id), {code: 'MEDIA_STAGING_INVALID'});
    assert.equal(store.documents('t', 'media_source').length, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM media_staging').get().n, 0);
  } finally {
    store.close();
  }
});

test('a stale completion cannot discard staging held by a replacement completion', async () => {
  const store = new Store(':memory:', key);
  try {
    const f = start(store);
    f.sources.inspect = async () => {
      store.db.prepare('UPDATE service_locks SET owner=? WHERE key=?').run('replacement', 'media-source:t:' + f.id);
      store.bindActorCheck(actor, () => {
        throw new MirrorError('UNAUTHORIZED', 'Synthetic withdrawal.', {}, 401);
      });
      return {inspection: 'unavailable'};
    };
    await assert.rejects(() => f.sources.complete(actor, f.id));
    assert.equal(store.stagedMediaManifest('t', f.id).sha256, sha256(png));
    assert.equal(store.document('t', 'media_source', f.id).state, 'receiving');
  } finally {
    store.close();
  }
});

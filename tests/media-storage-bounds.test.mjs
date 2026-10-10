// OPS-01: bounded SQLite media staging. Synthetic bytes on owned temporary databases only; no provider or account.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes, randomUUID} from 'node:crypto';
import {Store, STORAGE_LOW_MESSAGE} from '../dist/src/store.js';
import {MediaSources} from '../dist/src/media-sources.js';
import {RetainedMedia} from '../dist/src/retained-media.js';
import {
  MEDIA_CHUNK_BYTES,
  encodedChunkBytes,
  encodedMediaBytes,
  storageAdmissionRequirement,
  storageFloorBytes,
  storageSpace,
} from '../dist/src/media-storage.js';
import {MAX_MEDIA_BYTES} from '../dist/src/drive-media.js';
import {sha256} from '../dist/src/security.js';
import {removeTestDirectory} from '../dist/tests/temp.js';
import {runMediaStorageBenchmark, mediaStorageProblems} from '../tools/benchmark-media-storage.mjs';

const key = Buffer.alloc(32, 93).toString('base64'),
  tenant = 'media-storage-fixture',
  operator = {tenantId: tenant, userId: 'uploader', role: 'operator'},
  mib = 1024 * 1024;
function withFormat(format, run) {
  const prior = process.env.AMCP_MEDIA_CHUNK_FORMAT;
  process.env.AMCP_MEDIA_CHUNK_FORMAT = format;
  try {
    return run();
  } finally {
    if (prior === undefined) delete process.env.AMCP_MEDIA_CHUNK_FORMAT;
    else process.env.AMCP_MEDIA_CHUNK_FORMAT = prior;
  }
}
function fileStore(prefix = 'amcp-media-storage-fixture-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
    store = new Store(path.join(directory, 'fixture.sqlite'), key);
  return {
    store,
    close() {
      store.close();
      removeTestDirectory(directory, prefix);
    },
  };
}
function reserve(store, id = randomUUID()) {
  store.ensureTenant(tenant);
  store.reserveMedia(tenant, id, Date.now() + 300000);
  return id;
}
const chunkCount = store => Number(store.db.prepare('SELECT count(*) AS n FROM media_chunks').get().n);

test('encoded sizes match the measured double-base64 amplification and the compact v2 overhead', () => {
  // The scratch measurement of the candidate build stored 32 MiB as 59,652,816 characters.
  assert.equal(encodedMediaBytes(32 * mib, 'v1'), 59652816);
  assert.equal(encodedChunkBytes(MEDIA_CHUNK_BYTES, 'v2'), MEDIA_CHUNK_BYTES + 29);
  assert.ok(encodedMediaBytes(MAX_MEDIA_BYTES, 'v2') / MAX_MEDIA_BYTES < 1.0001);
  assert.equal(encodedMediaBytes(0), 0);
  assert.equal(storageFloorBytes(500 * mib, undefined), 256 * mib);
  assert.equal(storageFloorBytes(5 * 1024 * mib, undefined), 512 * mib);
  assert.equal(storageFloorBytes(500 * 1024 * mib, undefined), 1024 * mib);
  assert.equal(storageFloorBytes(500 * mib, '64'), 64 * mib);
  assert.equal(storageFloorBytes(500 * mib, 'not-a-number'), 256 * mib);
  assert.equal(storageAdmissionRequirement(10 * mib, 500 * mib, 'v2'), 2 * (10 * mib + 3 * 29) + 256 * mib);
  assert.equal(
    storageSpace(undefined, () => ({bavail: 1, bsize: 1, blocks: 1})),
    undefined,
  );
  assert.equal(
    storageSpace('x', () => {
      throw Error('statfs unavailable');
    }),
    undefined,
  );
  assert.deepEqual(
    storageSpace('x', () => ({bavail: 2n, bsize: 4096n, blocks: 10n})),
    {
      free_bytes: 8192,
      total_bytes: 40960,
    },
  );
});

test('benchmark: a 32 MiB staging peaks within 1.15x its encoded size and deletion logs at most two chunks (both formats)', async () => {
  // Regression for OPS-01: one staging transaction doubled the encoded size in the WAL, and one deletion statement
  // with secure_delete=ON logged the whole file again. Bounded per-chunk statements keep both near one chunk.
  for (const format of ['v1', 'v2']) {
    const run = await runMediaStorageBenchmark({rawMiB: 32, format});
    assert.deepEqual(mediaStorageProblems(run), [], JSON.stringify(run));
    assert.ok(run.staging.wal_peak_bytes <= 1.05 * encodedChunkBytes(MEDIA_CHUNK_BYTES, format), JSON.stringify(run));
    assert.equal(run.maintenance_checkpoint.truncated, true);
    assert.equal(run.maintenance_checkpoint.after.wal, 0);
    assert.equal(run.pragmas.secure_delete, 1);
    assert.equal(run.pragmas.journal_size_limit, 64 * mib);
    if (format === 'v2') assert.ok(run.stored_ratio <= 1.05 && run.database_growth_ratio <= 1.05);
    else assert.ok(run.stored_ratio > 1.7, 'v1 stays the documented legacy amplification');
  }
});

test('v2 chunks are raw encrypted BLOBs, and v1 chunks written before the change stay readable', () => {
  const store = new Store(':memory:', key);
  try {
    const legacy = reserve(store),
      current = reserve(store),
      bytes = randomBytes(MEDIA_CHUNK_BYTES + 1000);
    withFormat('v1', () => store.stageMedia(tenant, legacy, bytes));
    store.stageMedia(tenant, current, bytes);
    const rows = id =>
      store.db
        .prepare('SELECT typeof(secret) AS type,secret FROM media_chunks WHERE id=? ORDER BY chunk_index')
        .all(id);
    assert.deepEqual(
      rows(legacy).map(r => r.type),
      ['text', 'text'],
    );
    assert.deepEqual(
      rows(current).map(r => r.type),
      ['blob', 'blob'],
    );
    for (const row of rows(current)) {
      assert.equal(row.secret[0], 2, 'format byte');
      assert.equal(Buffer.from(row.secret).includes(bytes.subarray(0, 32)), false, 'no plaintext');
    }
    assert.ok(rows(current)[0].secret.length === MEDIA_CHUNK_BYTES + 29);
    assert.deepEqual(store.stagedMedia(tenant, legacy), bytes);
    assert.deepEqual(store.stagedMedia(tenant, current), bytes);
    assert.deepEqual(store.stagedMediaChunk(tenant, legacy, 1), bytes.subarray(MEDIA_CHUNK_BYTES));
    // A chunk sealed for one file or position never opens as another: the scope binds tenant, id and index.
    const [first, second] = rows(current);
    store.db.prepare('UPDATE media_chunks SET secret=? WHERE id=? AND chunk_index=1').run(first.secret, current);
    assert.throws(() => store.stagedMedia(tenant, current), {code: 'SECRET_DECRYPT_FAILED'});
    store.db.prepare('UPDATE media_chunks SET secret=? WHERE id=? AND chunk_index=1').run(second.secret, current);
    assert.deepEqual(store.stagedMedia(tenant, current), bytes);
    // An oversized chunk is refused before decryption.
    store.db
      .prepare('UPDATE media_chunks SET secret=? WHERE id=? AND chunk_index=1')
      .run(Buffer.alloc(MEDIA_CHUNK_BYTES + 30, 2), current);
    assert.throws(() => store.stagedMedia(tenant, current), {code: 'MEDIA_STAGING_INVALID'});
  } finally {
    store.close();
  }
});

test('retained copies use v2 chunks, keep reading v1 copies, and erase chunks after the manifest', () => {
  const store = new Store(':memory:', key);
  try {
    const retained = new RetainedMedia(store),
      bytes = randomBytes(5000),
      copy = format =>
        withFormat(format, () => {
          const source = 'src-' + randomUUID(),
            id = 'lib-' + randomUUID();
          store.ensureTenant(tenant);
          store.reserveMediaSource(tenant, source, Date.now() + 300000);
          store.stageMedia(tenant, source, bytes);
          retained.copy(tenant, source, id, {size: bytes.length, sha256: sha256(bytes)}, () => {});
          assert.equal(
            store.db.prepare('SELECT typeof(secret) AS t FROM retained_media_chunks WHERE id=?').get(id).t,
            format === 'v1' ? 'text' : 'blob',
          );
          return id;
        });
    const legacy = copy('v1'),
      current = copy('v2');
    assert.deepEqual(retained.read(tenant, legacy), bytes);
    assert.deepEqual(retained.read(tenant, current), bytes);
    // Inside a transaction the manifest goes first and the chunks wait, unreadable, for the commit.
    store.transaction(() => {
      retained.remove(tenant, current);
      assert.equal(store.db.prepare('SELECT count(*) AS n FROM retained_media_chunks WHERE id=?').get(current).n, 1);
      assert.throws(() => retained.read(tenant, current), {code: 'MEDIA_SOURCE_NOT_FOUND'});
    });
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM retained_media_chunks WHERE id=?').get(current).n, 0);
    assert.deepEqual(retained.read(tenant, legacy), bytes);
  } finally {
    store.close();
  }
});

test('an interrupted staging is never readable as complete and its chunks are erased after expiry', t => {
  const store = new Store(':memory:', key);
  try {
    const id = reserve(store),
      bytes = randomBytes(3 * MEDIA_CHUNK_BYTES);
    store.stageMedia(tenant, id, bytes.subarray(0, 100));
    assert.equal(store.stagedMedia(tenant, id).length, 100);
    // Restaging withdraws the old manifest before writing; a failure part-way leaves no readable file.
    let calls = 0;
    const seal = store.sealStagedChunk.bind(store);
    store.sealStagedChunk = (...args) => {
      if (++calls === 2) throw Object.assign(Error('synthetic interruption'), {code: 'SYNTHETIC_INTERRUPTION'});
      return seal(...args);
    };
    assert.throws(() => store.stageMedia(tenant, id, bytes), {code: 'SYNTHETIC_INTERRUPTION'});
    delete store.sealStagedChunk;
    assert.equal(chunkCount(store), 1, 'the first chunk of the interrupted staging was committed on its own');
    assert.throws(() => store.stagedMedia(tenant, id), {code: 'REVIEW_EXPIRED'});
    assert.throws(() => store.stagedMediaChunk(tenant, id, 0), {code: 'REVIEW_EXPIRED'});
    const now = Date.now();
    t.mock.method(Date, 'now', () => now + 300001);
    store.cleanupTransient();
    assert.equal(chunkCount(store), 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM media_staging').get().n, 0);
  } finally {
    store.close();
  }
});

test('removal withdraws the manifest first; orphaned chunks from a crash are erased by maintenance', () => {
  const store = new Store(':memory:', key);
  try {
    const id = reserve(store),
      bytes = randomBytes(2 * MEDIA_CHUNK_BYTES);
    store.stageMedia(tenant, id, bytes);
    store.transaction(() => {
      store.removeStagedMedia(tenant, id);
      assert.equal(chunkCount(store), 2, 'chunks wait for the commit');
      assert.throws(() => store.stagedMediaChunk(tenant, id, 0), {code: 'REVIEW_EXPIRED'});
    });
    assert.equal(chunkCount(store), 0);
    // A crash between manifest removal and chunk erasure leaves unreadable chunks behind.
    const crashed = reserve(store);
    store.stageMedia(tenant, crashed, bytes.subarray(0, 10));
    store.db.prepare('DELETE FROM media_staging WHERE id=?').run(crashed);
    assert.equal(chunkCount(store), 1);
    store.cleanupTransient();
    assert.equal(chunkCount(store), 0);
    assert.equal(store.mediaCleanupHealth.error_code, undefined);
  } finally {
    store.close();
  }
});

test('the maintenance checkpoint truncates the log after deletions, waits for running jobs and never blocks', () => {
  const f = fileStore();
  try {
    const {store} = f,
      wal = store.db.location() + '-wal',
      id = reserve(store);
    store.stageMedia(tenant, id, randomBytes(2 * MEDIA_CHUNK_BYTES));
    assert.equal(store.checkpointAfterDeletes(), false, 'nothing was deleted yet');
    store.removeStagedMedia(tenant, id);
    assert.ok(fs.statSync(wal).size > 0);
    const job = store.enqueue(tenant, 'report_overview', {});
    const leased = store.leaseJob(60000);
    assert.equal(leased.id, job);
    assert.equal(store.checkpointAfterDeletes(), false, 'a running job defers the checkpoint');
    store.finishJob(job, leased.lease_token, {});
    // Another connection holding a read snapshot makes the truncation busy; the store does not wait for it.
    const reader = new store.db.constructor(store.db.location());
    try {
      reader.exec('BEGIN');
      reader.prepare('SELECT count(*) FROM jobs').get();
      const started = performance.now();
      assert.equal(store.checkpointAfterDeletes(), false);
      assert.ok(performance.now() - started < 1000);
      assert.equal(store.db.prepare('PRAGMA busy_timeout').get().timeout, 5000, 'busy timeout restored');
      reader.exec('COMMIT');
    } finally {
      reader.close();
    }
    assert.equal(store.checkpointAfterDeletes(), true);
    assert.equal(fs.statSync(wal).size, 0);
    assert.equal(store.checkpointAfterDeletes(), false, 'one truncation per batch of deletions');
  } finally {
    f.close();
  }
});

test('media admission refuses retryably when free space is low and never refuses when space is unknown', () => {
  const f = fileStore();
  try {
    const {store} = f,
      sources = new MediaSources(store, true);
    store.ensureTenant(tenant);
    const total = 10 * 1024 * mib,
      floor = storageFloorBytes(total),
      need = size => storageAdmissionRequirement(size, total);
    let free = need(MAX_MEDIA_BYTES) + 1;
    store.statfs = () => ({bavail: free, bsize: 1, blocks: total});
    // Enough room: a website upload of known size and an import of unknown size are both admitted.
    const begun = sources.begin(operator, {size: 1000, filename: 'a.png', type: 'image/png'});
    assert.equal(begun.state, 'receiving');
    store.reserveMediaSource(tenant, 'src-' + randomUUID(), Date.now() + 60000);
    // Low room for an unknown size, but enough for the declared small upload.
    free = need(1000) + 1;
    assert.throws(
      () => store.reserveMediaSource(tenant, 'src-' + randomUUID(), Date.now() + 60000),
      e => {
        assert.equal(e.code, 'STORAGE_LOW');
        assert.equal(e.status, 503);
        assert.equal(e.retryable, true);
        assert.equal(e.message, STORAGE_LOW_MESSAGE);
        assert.deepEqual(e.details, {retry_after_ms: 60000});
        return true;
      },
    );
    assert.equal(sources.begin(operator, {size: 1000, filename: 'b.png', type: 'image/png'}).state, 'receiving');
    free = floor;
    assert.throws(() => sources.begin(operator, {size: 1000, filename: 'c.png', type: 'image/png'}), {
      code: 'STORAGE_LOW',
    });
    const review = reserve(store);
    assert.throws(() => store.stageMedia(tenant, review, randomBytes(1000)), {code: 'STORAGE_LOW'});
    assert.equal(chunkCount(store), 0, 'nothing was written before the refusal');
    assert.throws(() => store.assertRetainedMediaCapacity(tenant, 1000), {code: 'STORAGE_LOW'});
    // The floor is configurable for unusual hosts.
    process.env.AMCP_STORAGE_FLOOR_MB = '0';
    try {
      store.stageMedia(tenant, review, randomBytes(1000));
    } finally {
      delete process.env.AMCP_STORAGE_FLOOR_MB;
    }
    store.removeStagedMedia(tenant, review);
    // An unreadable or implausible statfs result is "unknown" and never refuses.
    store.statfs = () => {
      throw Object.assign(Error('statfs unsupported'), {code: 'ENOSYS'});
    };
    const unknown = reserve(store);
    store.stageMedia(tenant, unknown, randomBytes(1000));
    store.removeStagedMedia(tenant, unknown);
    store.statfs = () => ({bavail: 10, bsize: 1, blocks: 1});
    store.stageMedia(tenant, reserve(store), randomBytes(1000));
    assert.equal(store.storageSpace(), undefined);
  } finally {
    f.close();
  }
  const memory = new Store(':memory:', key);
  try {
    memory.statfs = () => ({bavail: 0, bsize: 1, blocks: 1});
    assert.equal(memory.storageSpace(), undefined, 'an in-memory database has no volume to measure');
    memory.stageMedia(tenant, reserve(memory), randomBytes(1000));
  } finally {
    memory.close();
  }
});

test('the storage refusal has an Arabic translation for the website', () => {
  const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
  assert.equal(typeof catalog[STORAGE_LOW_MESSAGE], 'string');
  assert.match(catalog[STORAGE_LOW_MESSAGE], /AMCP/);
});

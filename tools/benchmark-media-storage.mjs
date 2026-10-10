import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Store} from '../dist/src/store.js';
import {MEDIA_CHUNK_BYTES, encodedChunkBytes, encodedMediaBytes} from '../dist/src/media-storage.js';
import {removeTestDirectory} from '../dist/tests/temp.js';

/**
 * Media staging storage bounds (OPS-01), measured on an owned temporary WAL database with synthetic random bytes.
 * Never accepts a database path or loads deployed configuration. Reports, for one staged file:
 * - staging peak: database plus write-ahead log growth, sampled after every staging transaction, against the encoded
 *   (stored) size of the file;
 * - stored size: the encrypted chunk bytes and the checkpointed database growth, against the raw size;
 * - deletion log peak: the write-ahead log written by removing the file with secure_delete=ON, in chunks (the log file
 *   only grows until a truncating checkpoint and stays under the 64 MiB size limit, so its size afterwards is the peak);
 * - the database, log and free-list sizes after removal, and after the maintenance checkpoint.
 */
export const mediaStorageBounds = {staging_peak_ratio: 1.15, deletion_wal_chunks: 2, v2_stored_ratio: 1.05};
export async function runMediaStorageBenchmark({rawMiB = 32, format = 'v2'} = {}) {
  if (!Number.isInteger(rawMiB) || rawMiB < 1 || rawMiB > 128 || !['v1', 'v2'].includes(format))
    throw Error('Invalid bounded synthetic workload');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-media-storage-benchmark-')),
    database = path.join(directory, 'fixture.sqlite'),
    prior = process.env.AMCP_MEDIA_CHUNK_FORMAT,
    raw = rawMiB * 1024 * 1024;
  process.env.AMCP_MEDIA_CHUNK_FORMAT = format;
  let store;
  try {
    store = new Store(database, Buffer.alloc(32, 91).toString('base64'));
    const db = store.db,
      size = file => (fs.existsSync(file) ? fs.statSync(file).size : 0),
      sizes = () => ({database: size(database), wal: size(database + '-wal')}),
      tenant = 'media-storage-benchmark',
      id = randomUUID();
    store.ensureTenant(tenant);
    store.reserveMedia(tenant, id, Date.now() + 300000);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const before = sizes();
    let peak = 0,
      walPeak = 0;
    const transaction = store.transaction.bind(store);
    store.transaction = fn => {
      const result = transaction(fn),
        now = sizes();
      peak = Math.max(peak, now.database + now.wal - before.database - before.wal);
      walPeak = Math.max(walPeak, now.wal);
      return result;
    };
    const bytes = randomBytes(raw),
      started = performance.now();
    store.stageMedia(tenant, id, bytes);
    const stagingMs = performance.now() - started;
    store.transaction = transaction;
    if (!store.stagedMedia(tenant, id).equals(bytes)) throw Error('Staged bytes did not read back exactly');
    const stored = Number(db.prepare('SELECT coalesce(sum(length(secret)),0) AS n FROM media_chunks').get().n),
      staged = sizes();
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const checkpointed = sizes(),
      encoded = encodedMediaBytes(raw, format),
      chunk = encodedChunkBytes(MEDIA_CHUNK_BYTES, format);
    const removeStarted = performance.now();
    store.removeStagedMedia(tenant, id);
    const removeMs = performance.now() - removeStarted,
      removed = sizes(),
      remaining = Number(db.prepare('SELECT count(*) AS n FROM media_chunks').get().n),
      freelist = Number(db.prepare('PRAGMA freelist_count').get().freelist_count),
      pageSize = Number(db.prepare('PRAGMA page_size').get().page_size),
      truncated = store.checkpointAfterDeletes(),
      maintained = sizes();
    return {
      format,
      raw_bytes: raw,
      encoded_bytes: encoded,
      stored_chunk_bytes: stored,
      stored_ratio: stored / raw,
      database_growth_ratio: (checkpointed.database - before.database) / raw,
      staging: {
        peak_growth_bytes: peak,
        peak_ratio_to_encoded: peak / encoded,
        wal_peak_bytes: walPeak,
        after: staged,
        duration_ms: Math.round(stagingMs),
      },
      deletion: {
        wal_peak_bytes: removed.wal,
        wal_peak_chunks: removed.wal / chunk,
        remaining_chunks: remaining,
        after: removed,
        freelist_bytes: freelist * pageSize,
        duration_ms: Math.round(removeMs),
      },
      maintenance_checkpoint: {truncated, after: maintained},
      pragmas: {
        secure_delete: db.prepare('PRAGMA secure_delete').get().secure_delete,
        journal_size_limit: db.prepare('PRAGMA journal_size_limit').get().journal_size_limit,
      },
    };
  } finally {
    if (prior === undefined) delete process.env.AMCP_MEDIA_CHUNK_FORMAT;
    else process.env.AMCP_MEDIA_CHUNK_FORMAT = prior;
    store?.close();
    removeTestDirectory(directory, 'amcp-media-storage-benchmark-');
  }
}
/** Problems against the OPS-01 acceptance bounds; empty when the run meets them. */
export function mediaStorageProblems(run) {
  const problems = [];
  if (run.staging.peak_ratio_to_encoded > mediaStorageBounds.staging_peak_ratio)
    problems.push(run.format + ': staging peak ' + run.staging.peak_ratio_to_encoded.toFixed(3) + 'x the encoded size');
  if (run.deletion.wal_peak_chunks > mediaStorageBounds.deletion_wal_chunks)
    problems.push(run.format + ': deletion log peak ' + run.deletion.wal_peak_chunks.toFixed(2) + ' chunks');
  if (run.deletion.remaining_chunks) problems.push(run.format + ': chunks remained after removal');
  if (run.format === 'v2' && Math.max(run.stored_ratio, run.database_growth_ratio) > mediaStorageBounds.v2_stored_ratio)
    problems.push('v2: stored size ' + Math.max(run.stored_ratio, run.database_growth_ratio).toFixed(3) + 'x raw');
  return problems;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2),
    check = args.includes('--check');
  if (args.some(a => a !== '--check')) throw Error('Usage: node tools/benchmark-media-storage.mjs [--check]');
  const runs = [];
  for (const format of ['v1', 'v2']) runs.push(await runMediaStorageBenchmark({rawMiB: 32, format}));
  const problems = runs.flatMap(mediaStorageProblems);
  console.log(
    JSON.stringify(
      {
        benchmark: 'media-staging-storage',
        created_at: new Date().toISOString(),
        synthetic: true,
        bounds: mediaStorageBounds,
        runs,
        problems,
        qualification:
          'One 32 MiB synthetic file staged and removed on an owned temporary WAL database with secure_delete=ON. Local file-system measurement only; no deployed volume, provider or production database. Railway volume metrics stay an owner observation.',
      },
      null,
      2,
    ),
  );
  if (check && problems.length) process.exit(1);
}

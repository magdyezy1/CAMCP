import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import type {Store} from './store.js';
import type {JsonObject} from './types.js';
import {storageFloorBytes} from './media-storage.js';
import {MEDIA_CLEANUP_INTERVAL_MS} from './media-retention.js';
import {recentSqliteFailures} from './sqlite-diagnostics.js';
import {readBuildRecord} from './release-status.js';
import {ffmpegPath} from './media-variants.js';

/**
 * Where the database lives, as the production start-up guard established it (OPS-03): on a verified persistent mount,
 * or knowingly on ephemeral storage. Absent when no guard ran (local and test runtimes).
 */
export type StorageVolume = {
  persistent: boolean;
  mount: string | null;
  reason: string;
  /** The volume marker check at start: `changed` means the database or its volume was replaced. */
  marker?: 'stamped' | 'verified' | 'changed' | 'unavailable';
};
export type StorageState = 'ok' | 'low' | 'full' | 'not_persistent' | 'unknown';
/** Below this many free bytes SQLite cannot grow its files; the volume is treated as full. */
export const STORAGE_FULL_FREE_BYTES = 1024 * 1024;
/**
 * The storage state health reports (OPS-02): `full` when the volume has (almost) no free bytes or a committed write
 * failed for lack of space, `not_persistent` on knowingly ephemeral storage, `low` below the media admission floor,
 * `unknown` when free space cannot be read (an in-memory database, or a failed statfs).
 */
export function storageState(store: Store, writeFull = false): StorageState {
  let space;
  try {
    space = store.storageSpace();
  } catch {
    space = undefined;
  }
  if (writeFull || (space && space.free_bytes < STORAGE_FULL_FREE_BYTES)) return 'full';
  if (store.volume?.persistent === false) return 'not_persistent';
  if (!space) return 'unknown';
  return space.free_bytes < storageFloorBytes(space.total_bytes) ? 'low' : 'ok';
}
/** Media expiry is stale when its last success is older than four cleanup intervals (one minute). */
export function mediaRetentionState(health: {last_success_at: number}, now = Date.now()): 'ok' | 'stale' {
  return now - health.last_success_at > 4 * MEDIA_CLEANUP_INTERVAL_MS ? 'stale' : 'ok';
}
const fileBytes = (file: string) => {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
};
const pragma = (store: Store, name: string) => {
  const row = store.db.prepare('PRAGMA ' + name).get() as JsonObject | undefined;
  return Number(row ? Object.values(row)[0] : NaN);
};
/** Owner-only storage figures: volume, database, write-ahead log and free list sizes, and the admission floor. */
export function storageDetails(store: Store): JsonObject {
  let space;
  try {
    space = store.storageSpace();
  } catch {
    space = undefined;
  }
  const file = store.db.location(),
    pageSize = pragma(store, 'page_size');
  return {
    state: storageState(store),
    db_dir_free_bytes: space?.free_bytes ?? null,
    db_dir_total_bytes: space?.total_bytes ?? null,
    db_bytes: file ? fileBytes(file) : null,
    wal_bytes: file ? fileBytes(file + '-wal') : null,
    freelist_bytes: pragma(store, 'freelist_count') * pageSize,
    page_size: pageSize,
    admission_floor_bytes: space ? storageFloorBytes(space.total_bytes) : null,
    mount: store.volume ?? null,
    media_retention: {...store.mediaCleanupHealth, state: mediaRetentionState(store.mediaCleanupHealth)},
  };
}
let ffmpegVersion: string | undefined;
/** The configured FFmpeg's version line, read once per process; 'unavailable' when it does not run. */
function ffmpeg(): string {
  if (ffmpegVersion === undefined)
    try {
      const first = execFileSync(ffmpegPath(), ['-hide_banner', '-version'], {
        timeout: 3000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 1024 * 1024,
      })
        .toString()
        .split('\n')[0]!;
      ffmpegVersion = /^ffmpeg version (\S{1,80})/.exec(first)?.[1] ?? 'unknown';
    } catch {
      ffmpegVersion = 'unavailable';
    }
  return ffmpegVersion;
}
/** Release, runtime and schema identity plus recent SQLite failures, for owner health and the support bundle. */
export function runtimeDiagnostics(store: Store): JsonObject {
  const release = readBuildRecord(process.cwd());
  let schema: number | null = null;
  try {
    schema = Number((store.db.prepare('SELECT version FROM schema_version').get() as JsonObject).version);
  } catch {}
  return {
    release: release
      ? {sha256: release.sha256, files: release.files, source_revision: release.source_revision}
      : {status: 'unavailable'},
    node: process.version,
    sqlite: String((store.db.prepare('SELECT sqlite_version() AS v').get() as JsonObject).v),
    ffmpeg: ffmpeg(),
    uptime_seconds: Math.floor(process.uptime()),
    schema_version: schema,
    transaction_busy_retries: store.transactionBusyRetries,
    sqlite_failures: recentSqliteFailures(),
  };
}

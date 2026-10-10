import fs from 'node:fs';
import type {Store} from './store.js';
import type {JsonObject} from './types.js';
import {storageFloorBytes} from './media-storage.js';
import {MEDIA_CLEANUP_INTERVAL_MS} from './media-retention.js';
import {recentSqliteFailures} from './sqlite-diagnostics.js';
import {readBuildRecord} from './release-status.js';
import {startMediaProcessorProbe} from './runtime-toolchain.js';
import {eventLoopDelay} from './runtime-metrics.js';
import {READER_VERSION, migrationLedgerSummary} from './schema-migrations.js';

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
let ffmpegProbe: Promise<string> | undefined;
/**
 * The configured FFmpeg's version, read once per process and asynchronously: a synchronous probe blocked the shared
 * HTTP event loop for up to three seconds the first time owner health or the support bundle ran. It is the same cached
 * startup probe /versionz and owner health's media_processor report (QA-01), so one `ffmpeg -version` runs per process;
 * it resolves to 'unavailable' when FFmpeg does not run.
 */
export function startFfmpegVersionProbe(): Promise<string> {
  ffmpegProbe ??= startMediaProcessorProbe().then(
    probe =>
      (ffmpegVersion =
        probe.status === 'available'
          ? (/^ffmpeg version (\S{1,80})/.exec(probe.version)?.[1] ?? 'unknown')
          : 'unavailable'),
    () => (ffmpegVersion = 'unavailable'),
  );
  return ffmpegProbe;
}
/** The FFmpeg version once the probe has finished; 'checking' while it runs (never blocks the event loop). */
function ffmpeg(): string {
  if (ffmpegVersion === undefined) void startFfmpegVersionProbe();
  return ffmpegVersion ?? 'checking';
}
/**
 * The metadata-only runtime identity a long-running process logs at start once its bounded FFmpeg probe settles
 * (OPS-08): release identity, Node, SQLite and FFmpeg versions, and what the schema bootstrap found and recorded. The
 * HTTP server adds it to `http_listening`; the standalone worker writes it as `runtime_started`.
 */
export function runtimeIdentity(store: Store, ffmpegVersion: string): JsonObject {
  const release = readBuildRecord(process.cwd()),
    bootstrap = store.bootstrap;
  let sqlite = 'unavailable';
  try {
    // The store may already be closed when a fast shutdown overtakes the FFmpeg probe.
    sqlite = String((store.db.prepare('SELECT sqlite_version() AS v').get() as JsonObject).v);
  } catch {}
  return {
    release: release ? {sha256: release.sha256, source_revision: release.source_revision} : null,
    node: process.version,
    sqlite,
    ffmpeg: ffmpegVersion,
    schema_version: bootstrap.schema_version,
    min_reader_version: bootstrap.min_reader_version,
    reader_version: bootstrap.reader_version,
    schema_compatibility: bootstrap.compatibility,
    migration_ms: bootstrap.migration_ms,
    migrations_applied: bootstrap.migrations_applied,
  };
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
    // OPS-08: the schema ledger and what this start's bootstrap did (step IDs and durations, never SQL).
    schema_ledger: {
      ...migrationLedgerSummary(store.db),
      min_reader_version: store.bootstrap?.min_reader_version ?? null,
      reader_version: READER_VERSION,
      migration_ms: store.bootstrap?.migration_ms ?? null,
      applied_at_start: store.bootstrap?.migrations_applied ?? [],
    },
    transaction_busy_retries: store.transactionBusyRetries,
    sqlite_failures: recentSqliteFailures(),
    // OPS-08: this process's event-loop delay percentiles (null when no monitor runs, as in stdio MCP).
    event_loop: eventLoopDelay(),
  };
}

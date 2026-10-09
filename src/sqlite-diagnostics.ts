import {MirrorError} from './errors.js';
/** SQLite's numeric result codes identify a failure without exposing query text or native arguments. */
const names: Record<number, string> = {
  1: 'SQLITE_ERROR',
  2: 'SQLITE_INTERNAL',
  3: 'SQLITE_PERM',
  4: 'SQLITE_ABORT',
  5: 'SQLITE_BUSY',
  6: 'SQLITE_LOCKED',
  7: 'SQLITE_NOMEM',
  8: 'SQLITE_READONLY',
  9: 'SQLITE_INTERRUPT',
  10: 'SQLITE_IOERR',
  11: 'SQLITE_CORRUPT',
  12: 'SQLITE_NOTFOUND',
  13: 'SQLITE_FULL',
  14: 'SQLITE_CANTOPEN',
  15: 'SQLITE_PROTOCOL',
  16: 'SQLITE_EMPTY',
  17: 'SQLITE_SCHEMA',
  18: 'SQLITE_TOOBIG',
  19: 'SQLITE_CONSTRAINT',
  20: 'SQLITE_MISMATCH',
  21: 'SQLITE_MISUSE',
  22: 'SQLITE_NOLFS',
  23: 'SQLITE_AUTH',
  24: 'SQLITE_FORMAT',
  25: 'SQLITE_RANGE',
  26: 'SQLITE_NOTADB',
  27: 'SQLITE_NOTICE',
  28: 'SQLITE_WARNING',
};
export type SqliteDiagnostic = {result_code: number; primary_code: number; name: string};
export function sqliteDiagnostic(error: unknown): SqliteDiagnostic | undefined {
  if (!(error instanceof Error)) return;
  const candidate = error as Error & {code?: unknown; errcode?: unknown};
  if (
    candidate.code !== 'ERR_SQLITE_ERROR' ||
    typeof candidate.errcode !== 'number' ||
    !Number.isSafeInteger(candidate.errcode) ||
    candidate.errcode < 1 ||
    candidate.errcode > 0x7fffffff
  )
    return;
  const primary = candidate.errcode & 255,
    name = names[primary];
  if (!name) return;
  return {result_code: candidate.errcode, primary_code: primary, name};
}
/** English source text of the refusal when the database volume is full; the website shows its Arabic translation. */
export const STORAGE_FULL_MESSAGE =
  'AMCP storage is full. The deployment administrator must restore capacity before sign-in or saving can continue.';
export const DATABASE_BUSY_MESSAGE =
  'The AMCP database was busy and this request did not finish. Retry a read after a short wait; for a write, inspect its receipt before anything else and never resubmit it.';
/**
 * The AMCP refusal for a genuine SQLite capacity or contention failure (OPS-02): primary code 13 is STORAGE_FULL
 * (503), 5 and 6 are DATABASE_BUSY (503; only a read may be retried, so it is not marked retryable). Any other error,
 * including every AMCP refusal, returns undefined and keeps its own handling.
 */
export function sqliteRefusal(error: unknown): MirrorError | undefined {
  const database = sqliteDiagnostic(error);
  if (database?.primary_code === 13) return new MirrorError('STORAGE_FULL', STORAGE_FULL_MESSAGE, {}, 503);
  if (database?.primary_code === 5 || database?.primary_code === 6)
    return new MirrorError('DATABASE_BUSY', DATABASE_BUSY_MESSAGE, {read_retry_safe: true}, 503);
  return;
}
export type SqliteFailureSurface = 'mcp' | 'http' | 'worker' | 'maintenance' | 'health';
export type SqliteFailureEntry = {
  name: string;
  result_code: number;
  surface: SqliteFailureSurface;
  first_at: number;
  at: number;
  count: number;
};
const failureLimit = 20,
  failures = new Map<string, SqliteFailureEntry>();
/**
 * Remembers a SQLite failure in a process-local ring of at most 20 kinds (by surface and result code), for owner
 * health and the support bundle: numeric codes, counts and times only, never messages, SQL or arguments.
 * Returns the diagnostic when the error was a SQLite failure.
 */
export function recordSqliteFailure(
  error: unknown,
  surface: SqliteFailureSurface,
  now = Date.now(),
): SqliteDiagnostic | undefined {
  const database = sqliteDiagnostic(error);
  if (!database) return;
  const key = surface + ':' + database.result_code,
    prior = failures.get(key);
  failures.delete(key);
  failures.set(key, {
    name: database.name,
    result_code: database.result_code,
    surface,
    first_at: prior?.first_at ?? now,
    at: now,
    count: Math.min(Number.MAX_SAFE_INTEGER, (prior?.count ?? 0) + 1),
  });
  while (failures.size > failureLimit) failures.delete(failures.keys().next().value!);
  return database;
}
/** The remembered SQLite failures, most recent first. */
export function recentSqliteFailures(): SqliteFailureEntry[] {
  return [...failures.values()].reverse().map(entry => ({...entry}));
}
/** Tests only: forgets the process-local failure ring. */
export function clearSqliteFailures() {
  failures.clear();
}

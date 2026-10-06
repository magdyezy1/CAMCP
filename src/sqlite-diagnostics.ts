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

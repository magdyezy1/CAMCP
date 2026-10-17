import type {Store} from './store.js';

/**
 * The /mcp request buckets (SEC-02, server/mcp-limits.ts) in the store layer (ARC-02): one row per hashed actor key,
 * shared by every process that uses the database. The schema ledger creates the table (store-0016); before, the
 * limiter created it on its first admitted request, which an older release still does with this same definition.
 */
export const mcpRateLimitsSQL =
  'CREATE TABLE IF NOT EXISTS amcp_mcp_rate_limits(key TEXT PRIMARY KEY,tokens REAL NOT NULL,updated_at INTEGER NOT NULL)';
/** Deletes the buckets last charged before `before`: idle long enough to be full again, they carry no information. */
export function pruneRateBuckets(store: Store, before: number) {
  store.sql().prepare('DELETE FROM amcp_mcp_rate_limits WHERE updated_at<?').run(before);
}
/** One actor's bucket, or undefined when it has none (a full bucket). */
export function rateBucket(store: Store, key: string): {tokens: number; updated_at: number} | undefined {
  return store.sql().prepare('SELECT tokens,updated_at FROM amcp_mcp_rate_limits WHERE key=?').get(key) as
    {tokens: number; updated_at: number} | undefined;
}
/** Records the tokens an actor's bucket holds after a charge at `at`. */
export function saveRateBucket(store: Store, key: string, tokens: number, at: number) {
  store
    .sql()
    .prepare(
      'INSERT INTO amcp_mcp_rate_limits VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET tokens=excluded.tokens,updated_at=excluded.updated_at',
    )
    .run(key, tokens, at);
}

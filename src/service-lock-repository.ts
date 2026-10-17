import type {Store} from './store.js';
import type {JsonObject} from './types.js';

/**
 * Reads of the service locks a long-running step holds (Store.acquireLock), in the store layer (ARC-02). They moved
 * here verbatim from src/google-sheets.ts, src/google-business-sync.ts and src/measurement-connection-sync.ts.
 */
/** The lock's holder and expiry, or undefined when nobody holds it. */
export function lockLease(store: Store, key: string): JsonObject | undefined {
  return store.sql().prepare('SELECT owner,expires_at FROM service_locks WHERE key=?').get(key) as
    JsonObject | undefined;
}
/** Whether `owner` still holds the lock at `now`. */
export function holdsLock(store: Store, key: string, owner: string, now = Date.now()): boolean {
  return !!store
    .sql()
    .prepare('SELECT key FROM service_locks WHERE key=? AND owner=? AND expires_at>?')
    .get(key, owner, now);
}

import type {Store} from '../src/store.js';

/**
 * The website's attempt counters (`amcp_login_limits`: sign-in, two-step and AI-client registration limits) in the
 * store layer (ARC-02). The statements moved here verbatim from server/mcp-oauth.ts. A counter is keyed by the hash of
 * what it limits (an address or an account) and ends at `until_at`; no statement reads a person's data.
 */
/** Deletes the counters that ended by `now`. */
export function expireLoginLimits(store: Store, now: number) {
  store.sql().prepare('DELETE FROM amcp_login_limits WHERE until_at<=?').run(now);
}
/** A counter's attempts and end, or undefined when it has none. */
export function loginLimit(store: Store, key: string): {attempts: number; until_at: number} | undefined {
  return store.sql().prepare('SELECT attempts,until_at FROM amcp_login_limits WHERE key=?').get(key) as
    {attempts: number; until_at: number} | undefined;
}
/** Counts one attempt: a new counter ending at `until`, or one more attempt on the existing counter. */
export function countLoginAttempt(store: Store, key: string, until: number) {
  store
    .sql()
    .prepare('INSERT INTO amcp_login_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1')
    .run(key, until);
}
/** Gives one counted attempt back (an attempt that did not complete). */
export function returnLoginAttempt(store: Store, key: string) {
  store.sql().prepare('UPDATE amcp_login_limits SET attempts=attempts-1 WHERE key=? AND attempts>0').run(key);
}

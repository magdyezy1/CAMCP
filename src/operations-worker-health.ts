import type {Store} from './store.js';
import {heartbeatBytes, heartbeatSnapshot, observationLimit} from './worker-health-repository.js';

const staleAfterMs = 90000;

/** Shared process liveness only. Account, workspace, provider, job, identity and payload metadata are never projected. */
export function operationsWorkerHealth(store: Store, now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000)
    throw TypeError('Invalid worker observation clock');
  const result = heartbeatSnapshot(store, now, now - staleAfterMs),
    rows = JSON.parse(result.rows) as {at: number; state: 'idle' | 'working'}[];
  return {
    version: 1,
    at: now,
    status:
      result.active_records > 0
        ? 'active'
        : result.unavailable_records > 0
          ? result.observed_records > 0
            ? 'uncertain'
            : 'unavailable'
          : result.observed_records > 0
            ? 'stale'
            : 'not_observed',
    total_heartbeat_records: result.total_records,
    observed_records: result.observed_records,
    active_records: result.active_records,
    unavailable_records: result.unavailable_records,
    observation_limit: observationLimit,
    heartbeat_byte_limit: heartbeatBytes,
    stale_after_ms: staleAfterMs,
    has_more: result.observed_records > rows.length,
    observations: rows.map(row => ({state: row.state, age_ms: now - row.at, stale: now - row.at > staleAfterMs})),
    scope:
      'Shared process liveness, observed in one SQLite snapshot. At most 100 recent valid heartbeat observations are shown; aggregate counts cover all stored process heartbeats. Missing, malformed, oversized, duplicate-key or future observations do not establish health. Workspace queue progression, capacity, provider acceptance and delivery remain separate.',
  };
}

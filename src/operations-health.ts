import {Store} from './store.js';
import type {JsonObject} from './types.js';
import {serviceTimings} from './service-timings.js';
import {operationsWorkerHealth} from './operations-worker-health.js';
import {runtimeDiagnostics, storageDetails} from './storage-health.js';
import {workerStageHealth} from './worker-loop.js';
import {providerQuotaHealth, quotaPolicyFromEnv} from './provider-quota.js';
/** A workspace's newest job errors; the jobs_tenant_updated index serves it in order without a sort (OPS-08). */
export const recentJobErrorsSQL =
  "SELECT id,kind,json_extract(error,'$.code') AS code,updated_at FROM jobs WHERE tenant_id=? AND error IS NOT NULL ORDER BY updated_at DESC LIMIT 30";
/**
 * Aggregate diagnostics only; no request payloads, source URLs, tokens or actor bindings. Storage, release, runtime
 * and recent SQLite failure codes (OPS-02) describe the deployment and are shown to workspace owners only.
 */
export function operationsHealth(store: Store, tenant: string) {
  const now = Date.now(),
    queue = store.db
      .prepare(
        "SELECT kind,state,count(*) AS count,min(available_at) AS due FROM jobs WHERE tenant_id=? AND state IN ('queued','running') GROUP BY kind,state",
      )
      .all(tenant) as JsonObject[],
    errors = store.db.prepare(recentJobErrorsSQL).all(tenant),
    media = store.db
      .prepare(
        "SELECT count(*) AS active_operations,coalesce(sum(bytes),0) AS reserved_bytes FROM media_admissions WHERE tenant_id=? AND expires_at>? AND id NOT LIKE 'wait:%'",
      )
      .get(tenant, now),
    // The shared media budget this workspace's operations draw on (MED-02): limits and the deployment total only.
    limits = store.mediaAdmissionLimits,
    shared = store.db
      .prepare(
        "SELECT count(*) AS deployment_operations,coalesce(sum(bytes),0) AS deployment_reserved_bytes FROM media_admissions WHERE expires_at>? AND id NOT LIKE 'wait:%'",
      )
      .get(now),
    staged = store.db
      .prepare('SELECT count(*) AS staged_reviews,min(expires_at) AS next_expiry FROM media_staging WHERE tenant_id=?')
      .get(tenant);
  return {
    version: 1,
    at: now,
    providers: store.documents(tenant, 'provider_metrics'),
    // Daily requests per hashed provider app identity, and the quota mode and profiles (OPS-08).
    provider_quota: providerQuotaHealth(store.db, tenant, (store.quotaPolicy ??= quotaPolicyFromEnv(process.env)), now),
    timings: serviceTimings(store, tenant, now),
    // This process's worker stages (OPS-07); null when no worker loop runs in the process answering.
    worker: {...operationsWorkerHealth(store, now), stages: workerStageHealth(now)},
    queue: queue.map(q => ({
      kind: q.kind,
      state: q.state,
      count: q.count,
      oldest_due_age_ms: Math.max(0, now - q.due),
    })),
    media: {
      ...media,
      ...staged,
      ...shared,
      limit_bytes: limits.limit_bytes,
      operation_slots: limits.operations,
      workspace_operation_slots: limits.tenant_operations,
      // This workspace's refusals, released unfinished uploads and measured transfers in this process since it started.
      events_since_start: store.mediaCounters(tenant),
    },
    storage: storageDetails(store),
    runtime: runtimeDiagnostics(store),
    recent_errors: errors,
    scope:
      'Current workspace queue, errors and media counts; process worker liveness and the shared media budget totals are shared.',
    objectives: {
      duplicate_uncertain_mutations: 0,
      schedule_start_delay_target_ms: 300000,
      status: 'Proposed targets, capacity and operational SLO require owner acceptance.',
    },
  };
}

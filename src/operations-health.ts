import {Store} from './store.js';
import {serviceTimings} from './service-timings.js';
import {operationsWorkerHealth} from './operations-worker-health.js';
import {runtimeDiagnostics, storageDetails} from './storage-health.js';
import {workerStageHealth} from './worker-loop.js';
import {quotaPolicyFromEnv} from './provider-quota.js';
import {
  deploymentMediaReservations,
  jobQueueAges,
  mediaReservations,
  providerQuota,
  recentJobErrors,
  stagedMedia,
} from './owner-health-repository.js';
// The statements are in the store layer (src/owner-health-repository.ts, ARC-02).
export {recentJobErrorsSQL} from './owner-health-repository.js';

/**
 * Aggregate diagnostics only; no request payloads, source URLs, tokens or actor bindings. Storage, release, runtime
 * and recent SQLite failure codes (OPS-02) describe the deployment and are shown to workspace owners only.
 */
export function operationsHealth(store: Store, tenant: string) {
  const now = Date.now(),
    queue = jobQueueAges(store, tenant),
    errors = recentJobErrors(store, tenant),
    media = mediaReservations(store, tenant, now),
    // The shared media budget this workspace's operations draw on (MED-02): limits and the deployment total only.
    limits = store.mediaAdmissionLimits,
    shared = deploymentMediaReservations(store, now),
    staged = stagedMedia(store, tenant);
  return {
    version: 1,
    at: now,
    providers: store.documents(tenant, 'provider_metrics'),
    // Daily requests per hashed provider app identity, and the quota mode and profiles (OPS-08).
    provider_quota: providerQuota(store, tenant, (store.quotaPolicy ??= quotaPolicyFromEnv(process.env)), now),
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

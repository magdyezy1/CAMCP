import {randomUUID} from 'node:crypto';

/**
 * Job lease recovery bounds (OPS-07). Lease recovery was designed for dead workers; these bounds keep a job that itself
 * kills or stalls its worker from being dispatched forever.
 */
/** Identifies this process on every lease it takes, so an expiry seen after a restart is attributed to a crash. */
export const WORKER_BOOT_ID = randomUUID();
/** Lease expiries after which a job fails with LEASE_EXPIRY_LIMIT, unless its kind sets its own limit. */
export const LEASE_EXPIRY_LIMIT = 5;
const kindLimits: Readonly<Record<string, number>> = Object.freeze({});
export const leaseExpiryLimit = (kind: string) => kindLimits[kind] ?? LEASE_EXPIRY_LIMIT;
/**
 * Attempts a report snapshot, file export or Sheets export job gets. The worker runs the job again after a retryable
 * error until this many attempts have been made; the last one is told so (`__last_attempt`), and a snapshot then
 * records the failing unit and finishes partial instead of being lost.
 */
export const REPORT_JOB_ATTEMPT_LIMIT = 8;
/** Expiries of leases taken by another process boot (a crash or restart) after which the job is set aside. */
export const CRASH_EXPIRY_LIMIT = 2;
/**
 * How recent another boot's worker heartbeat must be for that boot to count as alive. A working worker heartbeats every
 * 15 s with its boot ID, so a lease of a live process (a second `npm run worker`, or an embedded worker next to it)
 * that expires is a slow or stalled job, not a crash, and never counts toward CRASH_EXPIRY_LIMIT.
 */
export const WORKER_BOOT_ALIVE_MS = 90000;
/**
 * When an expired job may run again. The first expiry is the case lease recovery exists for (a dead worker), so the
 * job is available at once; each further expiry waits 5 s, 10 s, 20 s and so on, at most five minutes.
 */
export function leaseExpiryDelay(expiries: number): number {
  return expiries <= 1 ? 0 : Math.min(300000, 5000 * 2 ** (expiries - 2));
}
export const LEASE_EXPIRED_MESSAGE =
  'The worker lease expired before this job finished. It runs again automatically after a pause.';
export const LEASE_EXPIRY_LIMIT_MESSAGE =
  'This job lost its worker lease too many times and was stopped. Inspect it, then resume it explicitly.';
export const LEASE_CRASH_QUARANTINE_MESSAGE =
  'The worker process stopped twice while running this job, so it was set aside. Inspect it, then resume it explicitly.';
export const JOB_SHUTDOWN_MESSAGE = 'The worker stopped for a restart. This job runs again shortly.';
/**
 * Kinds that only read from providers (their local results and checkpoints are rewritten safely). A shutdown returns
 * them to the queue at once without counting the attempt. Every other kind may be mid-mutation and is left to settle.
 */
export const RELEASABLE_JOB_KINDS: ReadonlySet<string> = new Set([
  'report',
  'report_overview',
  'report_file_export',
  'write_verification',
  // DEC-02 outcome review: a guided capture and a local comparison; a rerun captures again.
  'allocation_outcome',
  // R2.5 M2: the automatic check of an uncertain write reads the provider and sends nothing, so a rerun reads again.
  'write_reconcile',
]);

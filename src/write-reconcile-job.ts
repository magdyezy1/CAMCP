import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {deleteQueuedReviewJobs, jobAttempts, rescheduleQueuedReviewJob, writeClaim} from './job-repository.js';
import {reconcileDelayMs, recordStoppedCheck} from './write-reconciliation.js';
import {pendingUncertainMs} from './write-records.js';

/**
 * The worker job that checks an uncertain write by reads alone (R2.5 M2, L5-05 and L3-13; owner 2026-11-15: "fail closed on
 * uncertain writes, then reconcile them automatically"). A write that ends uncertain has one, for its claim time plus
 * the reconcile delay (60 s): the provider may still be applying the request before that. The job runs today's read-only
 * reconciliation (src/write-reconciliation.ts) as the person who executed the write, stores what it found for `status`
 * and the website, and, while that is not decisive, is queued again under a growing cooldown up to a bounded number of
 * attempts. It never sends a write, never resends one, and never changes the review: a person still accepts "applied"
 * (accept_applied) or prepares a new review.
 *
 * A write that a crash or a deploy leaves `pending` never reaches the code that ends a write uncertain, and the person it
 * runs as exists only in the process that executes the write. So the job is queued with the claim, as a watch (lead review
 * S3-4): due when the pending claim would count as uncertain (pendingUncertainMs, 10 minutes), deleted in the transaction that
 * settles the write (completed, rejected or released unsent), and moved up to claim + 60 s when the write ends uncertain.
 * A write whose process died is then checked by the worker, at ten minutes, like any other uncertain write.
 */
export const writeReconcileKind = 'write_reconcile';

const claimedAt = (store: Store, tenant: string, reviewId: string) =>
  Number(writeClaim(store, tenant, reviewId)?.created_at) || Date.now();

/**
 * Watches the write `reviewId` whose claim was just taken: queues its automatic check for when the claim would count as
 * uncertain. `actorBinding` is the person it runs as (bindJobActor). Call it in the transaction that takes the claim.
 */
export function watchWrite(store: Store, tenant: string, reviewId: string, actorBinding: string): string {
  const claimed = claimedAt(store, tenant, reviewId);
  return store.enqueue(
    tenant,
    writeReconcileKind,
    {review_id: reviewId, actor_binding: actorBinding, claimed_at: claimed},
    claimed + pendingUncertainMs,
  );
}

/** Ends the watch of a write that settled without being uncertain; a check that is already running is left to finish. */
export function unwatchWrite(store: Store, tenant: string, reviewId: string) {
  deleteQueuedReviewJobs(store, tenant, writeReconcileKind, reviewId);
}

/**
 * Queues the automatic check of the uncertain write `reviewId`, for its claim time plus the reconcile delay: the watch
 * that its claim queued is moved up, and a check is queued afresh only when none is waiting (it already ran, or none was
 * queued). `actorBinding` is the person it runs as (bindJobActor).
 */
export function queueReconcile(store: Store, tenant: string, reviewId: string, actorBinding: string) {
  const claimed = claimedAt(store, tenant, reviewId),
    due = claimed + reconcileDelayMs();
  if (rescheduleQueuedReviewJob(store, tenant, writeReconcileKind, reviewId, due)) return;
  store.enqueue(
    tenant,
    writeReconcileKind,
    {review_id: reviewId, actor_binding: actorBinding, claimed_at: claimed},
    due,
  );
}

/** The refusals that mean the person who executed the write can no longer act: their access, login or account. */
const accessLost =
  /^(?:ACCOUNT_ACCESS_REVOKED|MEMBERSHIP_REVOKED|UNAUTHORIZED|FORBIDDEN|JOB_REAUTHORIZATION_REQUIRED|OWNER_LOGIN_REQUIRED|ENCRYPTION_REQUIRED|CONNECTION_REQUIRED|CONNECTION_AUTHORITY_CHANGED|CONNECTOR_READ_ONLY)$/;

/**
 * One turn of the job. `check` is the reconciler's `automatic` (src/write-reconciliation.ts). A lost lease is the worker's
 * to handle; any other refusal of the check (the person's access is gone, or the check cannot be made) is recorded for
 * `status` and ends the job: no read was made, and trying again would meet the same refusal.
 */
export async function reconcileJob(
  store: Store,
  tenant: string,
  input: JsonObject,
  leaseCheck: () => void,
  check: (actor: Actor, reviewId: string, attempt: number) => Promise<JsonObject>,
): Promise<JsonObject> {
  const reviewId = String(input.review_id),
    attempt = Number(jobAttempts(store, tenant, String(input.__job_id))?.attempts ?? 1);
  try {
    const actor = store.restoreJobActor(tenant, reviewId, input.actor_binding);
    store.bindActorCheck(actor, leaseCheck);
    return await check(actor, reviewId, attempt);
  } catch (e) {
    if (!(e instanceof MirrorError) || e.code === 'STALE_JOB_LEASE') throw e;
    const reason = accessLost.test(e.code) ? 'access_lost' : 'check_failed';
    recordStoppedCheck(store, tenant, reviewId, attempt, reason, e.code);
    return {review_id: reviewId, status: 'stopped', reason, attempts: attempt};
  }
}

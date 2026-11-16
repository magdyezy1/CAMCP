import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {jobAttempts, writeClaim} from './job-repository.js';
import {reconcileDelayMs, recordStoppedCheck} from './write-reconciliation.js';

/**
 * The worker job that checks an uncertain write by reads alone (R2.5 M2, L5-05 and L3-13; owner 2026-11-15: "fail closed on
 * uncertain writes, then reconcile them automatically"). A write that ends uncertain queues one, for its claim time plus
 * the reconcile delay (60 s): the provider may still be applying the request before that. The job runs today's read-only
 * reconciliation (src/write-reconciliation.ts) as the person who executed the write, stores what it found for `status`
 * and the website, and, while that is not decisive, is queued again under a growing cooldown up to a bounded number of
 * attempts. It never sends a write, never resends one, and never changes the review: a person still accepts "applied"
 * (accept_applied) or prepares a new review.
 */
export const writeReconcileKind = 'write_reconcile';

/** Queues the automatic check of the uncertain write `reviewId`; `actorBinding` is the person it runs as (bindJobActor). */
export function queueReconcile(store: Store, tenant: string, reviewId: string, actorBinding: string): string {
  const claimed = Number(writeClaim(store, tenant, reviewId)?.created_at) || Date.now();
  return store.enqueue(
    tenant,
    writeReconcileKind,
    {review_id: reviewId, actor_binding: actorBinding, claimed_at: claimed},
    claimed + reconcileDelayMs(),
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

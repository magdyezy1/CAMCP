import {randomUUID} from 'node:crypto';
import {MirrorError} from './errors.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {setJobInput} from './job-repository.js';

/**
 * Server-side runs of an approved upload plan (MED-03 B). The website's creative push used to run in the open tab: it
 * awaited prepare and a synchronous execute per row, so leaving the page stopped the remaining rows and lost their
 * status, and a long row could outlast an edge proxy's response timeout while the server finished it. Now the push is
 * saved as a plan of independent media uploads, approved once (plan_hash and summary_hash), and `amcp_campaign
 * run_background` queues it for the worker, which runs it exactly as `run` does: each upload is still a frozen review
 * with its own idempotency key, executed once under the plan's approval. The page only polls the plan.
 *
 * AMCP_SERVER_PUSH=false is the rollback switch: run_background is refused and the website drives each row itself
 * (prepare, execute_async and job polling), as before this change.
 */
export const BACKGROUND_RUN_KIND = 'campaign_run';
export const serverPushEnabled = () => process.env.AMCP_SERVER_PUSH !== 'false';
/** One worker turn runs steps for about this long, then yields between steps so other work and a restart get a turn. */
export const BACKGROUND_TURN_MS = 20000;
/** A background run that keeps yielding stops after this many turns; it can be queued again from the plan. */
export const BACKGROUND_TURN_LIMIT = 500;
const CONTINUES = 'CAMPAIGN_RUN_CONTINUES';
/** Step states in which an upload still has work to do in the run (not settled, failed, uncertain or processing). */
const runnable = ['pending', 'review_ready', 'executing'];

/** A plan of independent uploads: every step a media upload with no predecessor, so none waits for another. */
export function independentUploads(run: JsonObject): boolean {
  return (
    Array.isArray(run.steps) &&
    run.steps.length > 0 &&
    run.steps.every(
      (s: JsonObject) =>
        s?.kind === 'media' && s.arguments?.action !== 'prepare_library' && !(s.depends_on?.length > 0),
    )
  );
}
/** The next upload of such a plan the run can move: one left executing (resumed first), then a ready review, then pending. */
export function nextUpload(run: JsonObject): JsonObject | undefined {
  for (const status of runnable) {
    const step = run.steps.find((s: JsonObject) => s.status === status);
    if (step) return step;
  }
  return undefined;
}
/** A yield between steps: not a failure, the worker queues the same run again after `delay` (see worker.ts). */
const continues = (delay: number, reason: string) =>
  new MirrorError(
    CONTINUES,
    'The background run of this plan continues shortly.',
    {retry_after_ms: delay, reason},
    409,
    true,
  );
/**
 * The delay before a yielded background run continues, or undefined for any other outcome (the job then fails). A run
 * past its turn limit is refused by its next turn with BACKGROUND_RUN_TURN_LIMIT, so it never fails as "continues".
 */
export function backgroundRunContinuation(job: JsonObject, e: unknown): number | undefined {
  if (job.kind !== BACKGROUND_RUN_KIND || !(e instanceof MirrorError) || e.code !== CONTINUES) return undefined;
  return Math.max(1000, Math.min(60000, Number(e.details.retry_after_ms) || 1000));
}
/** How long the per-person lock of a background run lasts; it is renewed while a turn runs, even inside one long step. */
const LOCK_MS = 120000,
  LOCK_RENEW_MS = 30000;
/**
 * Queues the background run of an approved plan for `actor`, bound to them like a scheduled report: the worker restores
 * this person and stops if their access ends. Returns the job id.
 */
export function enqueueBackgroundRun(store: Store, actor: Actor, planId: string): string {
  return store.transaction(() => {
    store.assertActorActive(actor);
    const id = store.enqueue(actor.tenantId, BACKGROUND_RUN_KIND, {plan_id: planId});
    setJobInput(
      store,
      id,
      JSON.stringify({plan_id: planId, authority: {version: 1, binding: store.bindJobActor(actor, 'job:' + id)}}),
    );
    return id;
  });
}
/** What the plan's background run is doing, for its view: queued, running (a turn yielded counts), complete or failed. */
export function backgroundRunView(store: Store, tenant: string, run: JsonObject): JsonObject | undefined {
  const job = run.background?.job_id;
  if (typeof job !== 'string') return undefined;
  let row: JsonObject;
  try {
    row = store.job(tenant, job);
  } catch (e) {
    if (e instanceof MirrorError && e.code === 'NOT_FOUND') return {job_id: job, state: 'unknown'};
    throw e;
  }
  const yielded = row.state === 'queued' && row.error?.code === CONTINUES;
  return {
    job_id: job,
    state: yielded ? 'running' : row.state,
    queued_at: run.background.queued_at ?? null,
    ...(row.state === 'failed' && row.error ? {error: {code: row.error.code, message: row.error.message}} : {}),
    ...(row.state === 'complete' && row.result ? {result: row.result} : {}),
  };
}
/**
 * One worker turn of a background plan run: `run` until the plan has no upload left to move, a person is needed, or
 * the turn's time is up (it then yields between steps and continues). A person runs one background plan at a time, so
 * the workspace never holds more than one staged review for them. Busy media capacity waits instead of failing.
 */
export async function backgroundRunTurn(
  store: Store,
  call: (tool: string, input: JsonObject, actor: Actor) => Promise<JsonObject>,
  tenant: string,
  input: JsonObject,
  leaseCheck: () => void,
): Promise<JsonObject> {
  if (input.authority?.version !== 1 || typeof input.plan_id !== 'string')
    throw new MirrorError(
      'JOB_REAUTHORIZATION_REQUIRED',
      'This background plan run has no verified creator. Run the plan again from its page.',
      {},
      403,
    );
  const actor = store.restoreJobActor(tenant, 'job:' + input.__job_id, input.authority.binding);
  store.bindActorCheck(actor, leaseCheck);
  if (typeof input.__job_id === 'string' && Number(store.job(tenant, input.__job_id).attempts) > BACKGROUND_TURN_LIMIT)
    throw new MirrorError(
      'BACKGROUND_RUN_TURN_LIMIT',
      'The background run of this plan stopped after many turns without finishing. Open the plan and run it again.',
      {plan_id: input.plan_id, turns: BACKGROUND_TURN_LIMIT},
    );
  const lock = 'campaign-background:' + tenant + ':' + actor.userId,
    owner = randomUUID();
  if (!store.acquireLock(lock, owner, LOCK_MS)) throw continues(5000, 'another_background_run');
  // One upload can take longer than the lock (a large video): the lock is renewed while the turn runs, and a lock lost
  // to another run stops this one at its next check, before anything else is prepared or sent.
  let lost = false;
  const renew = setInterval(() => {
    try {
      if (!store.renewLock(lock, owner, LOCK_MS)) lost = true;
    } catch {
      lost = true;
    }
  }, LOCK_RENEW_MS);
  renew.unref?.();
  const held = () => {
    if (lost || !store.renewLock(lock, owner, LOCK_MS))
      throw new MirrorError('STALE_JOB_LEASE', 'Another background run of this person took over.', {}, 409);
  };
  store.bindActorCheck(actor, () => {
    if (lost) throw new MirrorError('STALE_JOB_LEASE', 'Another background run of this person took over.', {}, 409);
  });
  const started = Date.now(),
    plan = () => store.document(tenant, 'campaign_run', input.plan_id),
    summary = (stopped: string) => {
      const steps = plan().steps as JsonObject[],
        count = (states: string[]) => steps.filter(s => states.includes(s.status)).length;
      return {
        plan_id: input.plan_id,
        stopped,
        steps: steps.length,
        settled: count(['verified', 'verified_with_acceptance', 'complete']),
        processing: count(['processing']),
        attention: count(['failed', 'uncertain', 'mismatch']),
        remaining: count(runnable),
      };
    };
  try {
    for (;;) {
      leaseCheck();
      held();
      const out = await call('amcp_campaign', {action: 'run', id: input.plan_id}, actor);
      held();
      if (!out.success) {
        if (out.error?.retryable === true) throw continues(Number(out.error.details?.retry_after_ms) || 5000, 'busy');
        throw new MirrorError(out.error?.code ?? 'CAMPAIGN_RUN_FAILED', out.error?.message ?? 'The plan run failed.', {
          plan_id: input.plan_id,
        });
      }
      // A plan its preflight blocked returns the blocked view, not a run: a person amends it first.
      const stopped = out.data?.blocked === true ? 'blocked' : String(out.data?.run?.stopped ?? 'unknown');
      if (stopped === 'complete') return summary(stopped);
      const left = summary(stopped);
      // Nothing left to move: the rest needs a person (failed or uncertain rows) or the provider (processing).
      if (!left.remaining) return left;
      if (stopped === 'not_sent') throw continues(Number(out.data?.run?.retry_after_ms) || 5000, 'not_sent');
      if (['time', 'limit'].includes(stopped)) {
        if (Date.now() - started < BACKGROUND_TURN_MS) continue;
        throw continues(1000, 'turn');
      }
      // A spending, cap or creative acknowledgement, a blocked plan or a lost approval: a person continues it.
      return left;
    }
  } finally {
    clearInterval(renew);
    store.releaseLock(lock, owner);
  }
}

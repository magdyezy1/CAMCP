import {randomUUID} from 'node:crypto';
import {Store} from './store.js';
import {resolveReportConfig} from './reporting.js';
import {MirrorError} from './errors.js';
import type {Actor, JsonObject} from './types.js';
import {assertReportingConfigCredentials} from './report-query-access.js';
import {
  dueScheduleTenants,
  dueSchedules,
  failSchedule,
  followingOccurrence,
  jitteredRetryDelay,
  reevaluatedOccurrence,
  sheetsSettleRecheck,
} from './scheduled-work.js';
import {RELEASABLE_JOB_KINDS, REPORT_JOB_ATTEMPT_LIMIT, WORKER_BOOT_ID} from './job-leases.js';
import {backgroundRunContinuation} from './campaign-background.js';
import {writeReconcileKind} from './write-reconcile-job.js';
import {workerJobLease} from './job-repository.js';
/** What a shutdown did with the job this worker was running (OPS-07). */
export type WorkerDrain = {released: string[]; settling: string[]};
/** How a leased job ended in this worker (OPS-08). */
export type JobOutcome = 'complete' | 'retry_scheduled' | 'failed' | 'released' | 'lease_lost';
export type JobEvent =
  | {level: 'info'; event: 'job_started'; job_id: string; kind: string; attempt: number; at: string}
  | {
      level: 'info' | 'warn' | 'error';
      event: 'job_finished';
      job_id: string;
      kind: string;
      attempt: number;
      duration_ms: number;
      outcome: JobOutcome;
      code: string | null;
      at: string;
    };
const jobCode = (code: unknown) => (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : null);
/**
 * When a queued media upload met transient contention before any claim (another media operation, another executor of
 * the same review, or a busy processor), the delay before it runs again: the server's retry_after_ms with jitter, so
 * queued uploads do not all return at once. Undefined (fail the job) once a claim exists, for any other error, or when
 * the retry would start after the review expires (MED-02).
 */
export function mediaContentionRetry(job: JsonObject, e: unknown, now = Date.now(), random = Math.random) {
  if (
    job.kind !== 'media_upload' ||
    !(e instanceof MirrorError) ||
    !e.retryable ||
    e.details.claimed !== false ||
    !['MEDIA_MEMORY_BUSY', 'MEDIA_UPLOAD_BUSY', 'MEDIA_PROCESSOR_BUSY'].includes(e.code)
  )
    return undefined;
  const expires = Number(e.details.review_expires_at ?? job.input?.review_expires_at),
    base = Math.min(60000, Math.max(1000, Number(e.details.retry_after_ms) || 5000)),
    delay = base + Math.floor(random() * Math.min(base, 3000));
  return Number.isSafeInteger(expires) && now + delay < expires ? delay : undefined;
}
export class ReportWorker {
  readonly workerId = randomUUID();
  private lastCleanup = 0;
  private draining = false;
  private current?: {job: JsonObject; released: boolean};
  /**
   * Runs inside the release transaction for a job returned to the queue at shutdown, so its own bookkeeping (for
   * example a report's collection budget) stops charging time while the process is down.
   */
  onRelease?: (tenant: string, kind: string, input: JsonObject) => void;
  /**
   * Receives one `job_started` and one `job_finished` line per leased job (OPS-08): job ID, kind, attempt, and on
   * finish the duration, outcome and error code. Metadata only: never the input, result, workspace, message or details.
   */
  onJobEvent?: (entry: JobEvent) => void;
  private jobEvent(entry: JobEvent) {
    try {
      this.onJobEvent?.(entry);
    } catch {
      // Diagnostic delivery never changes a job's outcome.
    }
  }
  heartbeat(state = 'idle') {
    try {
      // The boot ID lets lease expiry tell a live process's stalled job from a crashed one (OPS-07); it is never shown.
      this.store.serviceRepo('worker_heartbeat').put(this.workerId, {
        at: Date.now(),
        state,
        boot: WORKER_BOOT_ID,
      });
      if (Date.now() - this.lastCleanup > 60000) {
        this.store.cleanupTransient();
        this.lastCleanup = Date.now();
      }
      return true;
    } catch (error) {
      // Health observations are optional. Contention must neither abort a finished job
      // nor prevent its independent lease renewal. The next cycle tries health again;
      // unreported observations retain their old timestamp and can become stale.
      const sqlite = error as {code?: unknown; errcode?: unknown};
      if (sqlite?.code === 'ERR_SQLITE_ERROR' && typeof sqlite.errcode === 'number' && (sqlite.errcode & 255) === 5)
        return false;
      throw error;
    }
  }

  constructor(
    readonly store: Store,
    readonly execute: (tenantId: string, config: JsonObject, actor?: Actor) => Promise<unknown>,
    readonly auxiliary?: (tenant: string, kind: string, input: JsonObject) => Promise<unknown>,
  ) {}
  tickSchedules() {
    const at = Date.now();
    // Only the workspaces the global due index names (OPS-08); each is then selected exactly as before.
    for (const tenant of dueScheduleTenants(this.store, 'reporting_schedule', at))
      for (const schedule of dueSchedules(this.store, tenant, 'reporting_schedule', at)) {
        try {
          if (schedule.next_run_reevaluate) {
            // A clock re-evaluation is not an occurrence: search again without queuing a run.
            this.store.transaction(() => {
              const current = this.store.document(tenant, 'reporting_schedule', schedule.id);
              if (current.revision !== schedule.revision || !current.is_active) return;
              const {id, revision, ...data} = current;
              this.store.putDocument(
                tenant,
                'reporting_schedule',
                id,
                {...data, ...reevaluatedOccurrence(current)},
                revision,
              );
            });
            continue;
          }
          // EXP-02: the following occurrence is computed first; an unresolved one never drops or pauses this run.
          const following = followingOccurrence(schedule);
          this.store.enqueueSchedule(tenant, schedule.id, schedule.revision, following.next_run_at, following);
        } catch (e) {
          const error = e instanceof MirrorError ? {code: e.code, message: e.message} : {code: 'SCHEDULER_ERROR'};
          if (e instanceof MirrorError && !e.retryable)
            failSchedule(this.store, tenant, 'reporting_schedule', schedule, error);
          this.store.appendAudit(tenant, 'scheduler/' + schedule.id, {event: 'schedule_failed', error});
        }
      }
  }
  /**
   * Graceful shutdown (OPS-07): take no new lease and return a running read-only job to the queue at once, without
   * counting its attempt; the running execution then stops at its next lease check. A job that may be mid-mutation is
   * never interrupted: it is reported as settling, and the caller waits for it within its grace period.
   */
  drain(): WorkerDrain {
    this.draining = true;
    const current = this.current;
    if (!current || current.released) return {released: [], settling: []};
    const {job} = current,
      kind = String(job.kind);
    if (!RELEASABLE_JOB_KINDS.has(kind)) return {released: [], settling: [kind]};
    try {
      current.released = this.store.releaseJob(job.id, job.lease_token, () =>
        this.onRelease?.(job.tenant_id, kind, job.input),
      );
    } catch {
      current.released = false;
    }
    return current.released ? {released: [kind], settling: []} : {released: [], settling: [kind]};
  }
  async once(): Promise<boolean> {
    if (this.draining) return false;
    this.heartbeat();
    this.tickSchedules();
    if (this.draining) return false;
    const job = this.store.leaseJob(60000);
    if (!job) return false;
    const current = (this.current = {job, released: false}),
      started = performance.now(),
      identity = {job_id: String(job.id), kind: String(job.kind), attempt: Number(job.attempts)};
    let outcome: JobOutcome = 'complete',
      code: string | null = null;
    this.jobEvent({level: 'info', event: 'job_started', ...identity, at: new Date().toISOString()});
    this.heartbeat('working');
    let lostLease = false;
    const heartbeat = setInterval(() => {
      try {
        this.heartbeat('working');
        this.store.renewJob(job.id, job.lease_token);
      } catch {
        lostLease = true;
      }
    }, 15000);
    heartbeat.unref();
    try {
      if (job.kind !== 'report' && !this.auxiliary)
        throw new MirrorError('UNKNOWN_JOB_KIND', 'No worker is registered for this job kind.');
      let actor: Actor | undefined;
      if (job.kind === 'report') {
        if (job.input.authority?.version !== 1)
          throw new MirrorError(
            'JOB_REAUTHORIZATION_REQUIRED',
            'This legacy report has no verified creator. Explicitly execute it again with current access.',
            {},
            403,
          );
        actor = this.store.restoreJobActor(job.tenant_id, 'job:' + job.id, job.input.authority.binding);
        this.store.bindActorCheck(actor, () => {
          const current = workerJobLease(this.store, job.id) as JsonObject;
          if (
            lostLease ||
            !current ||
            current.state !== 'running' ||
            current.lease_token !== job.lease_token ||
            current.lease_until <= Date.now()
          )
            throw new MirrorError('STALE_JOB_LEASE', 'This worker no longer owns the report.', {}, 409);
        });
      }
      if (job.kind === 'report') assertReportingConfigCredentials(job.input.query_config);
      const result =
        job.kind === 'report'
          ? await this.execute(job.tenant_id, resolveReportConfig(job.input.query_config), actor)
          : await this.auxiliary!(job.tenant_id, job.kind, {
              ...job.input,
              __job_id: job.id,
              __lease_token: job.lease_token,
              // A report job on its last attempt records a retryable unit failure and finishes partial (F-L5-03).
              __last_attempt: job.attempts >= REPORT_JOB_ATTEMPT_LIMIT,
            });
      if (actor) this.store.assertActorActive(actor);
      if (!lostLease) {
        const verification = result as JsonObject;
        if (job.kind === 'write_verification' && ['pending', 'inconclusive'].includes(verification?.status)) {
          const error = {
            code: job.attempts < 12 ? 'VERIFICATION_PENDING' : 'VERIFICATION_POLL_LIMIT',
            message:
              job.attempts < 12
                ? 'Provider configuration is not yet verified; retrying reads only.'
                : 'Automatic read-back reached its bounded poll limit. Continue amcp_campaign verify using the original review.',
            details: {review_id: job.input.review_id, status: verification.status, automatic_retry_of_mutation: false},
          };
          if (job.attempts < 12)
            this.store.retryJob(job.id, job.lease_token, error, Math.min(300000, 5000 * 2 ** job.attempts));
          else this.store.failJob(job.id, job.lease_token, error);
          outcome = job.attempts < 12 ? 'retry_scheduled' : 'failed';
          code = error.code;
        } else if (job.kind === 'write_verification' && verification?.status === 'failed') {
          this.store.failJob(job.id, job.lease_token, {
            code: 'VERIFICATION_FAILED',
            message:
              'The provider reported failure of the created job. Retain the original receipt; do not repeat its mutation.',
            details: {review_id: job.input.review_id},
          });
          outcome = 'failed';
          code = 'VERIFICATION_FAILED';
        } else if (job.kind === writeReconcileKind && Number((result as JsonObject)?.retry_after_ms) > 0) {
          // R2.5 M2: an automatic check of an uncertain write that settled nothing looks again after its cooldown. The
          // job's own turn decided how long (src/write-reconciliation.ts); it only reads, so retrying it sends nothing. A turn
          // that read nothing, because every read was refused before it was sent, is no attempt (lead re-review N6).
          this.store.retryJob(
            job.id,
            job.lease_token,
            {
              code: 'RECONCILE_UNSETTLED',
              message: 'The uncertain write is not settled yet; AMCP reads the provider again after a pause.',
              details: {review_id: job.input.review_id, automatic_retry_of_mutation: false},
            },
            Number((result as JsonObject).retry_after_ms),
            (result as JsonObject).attempt_counted !== false,
          );
          outcome = 'retry_scheduled';
          code = 'RECONCILE_UNSETTLED';
        } else this.store.finishJob(job.id, job.lease_token, result);
      } else outcome = 'lease_lost';
    } catch (e) {
      const error =
        e instanceof MirrorError
          ? {code: e.code, message: e.message, details: e.details}
          : {code: 'REPORT_FAILED', message: 'Report execution failed.'};
      code = error.code;
      outcome = 'failed';
      // A background plan run that yielded between steps (MED-03 B) is not a failure: it continues after the delay.
      const continuation = backgroundRunContinuation(job, e);
      if (!lostLease)
        try {
          const mediaDelay = mediaContentionRetry(job, e) ?? continuation;
          if (mediaDelay !== undefined) {
            this.store.retryJob(job.id, job.lease_token, error, mediaDelay);
            outcome = 'retry_scheduled';
          } else if (
            e instanceof MirrorError &&
            e.retryable &&
            ['report_overview', 'sheets_export', 'report_file_export'].includes(job.kind) &&
            (job.attempts < REPORT_JOB_ATTEMPT_LIMIT ||
              (job.kind === 'report_overview' && e.code === 'REPORT_COLLECTION_YIELD') ||
              sheetsSettleRecheck(job.kind, e))
          ) {
            this.store.retryJob(
              job.id,
              job.lease_token,
              error,
              job.kind === 'sheets_export'
                ? jitteredRetryDelay(job.attempts, e.details.retry_after_ms)
                : Number(e.details.retry_after_ms ?? Math.min(300000, 5000 * 2 ** job.attempts)),
              // A snapshot turn that settled a period or a source (progress_saved) starts the attempts again: they are for turns
              // in a row that settle nothing, so a report of many days or accounts, each waiting on its provider's report,
              // is never failed by how many it has (r25-mf-jobs 3, F2). Each such turn settles one more of a finite list.
              job.kind === 'report_overview' && e.details.progress_saved === true ? 'reset' : true,
            );
            outcome = 'retry_scheduled';
          } else this.store.failJob(job.id, job.lease_token, error);
        } catch {
          lostLease = true;
        }
      if (lostLease) outcome = 'lease_lost';
      // A job released at shutdown already went back to the queue; its interrupted execution is not a failure.
      if (!current.released && (continuation === undefined || lostLease))
        this.store.appendAudit(job.tenant_id, job.id, {
          event: lostLease ? 'report_lease_lost' : 'report_failed',
          error,
        });
    } finally {
      clearInterval(heartbeat);
      if (this.current === current) this.current = undefined;
      if (current.released) outcome = 'released';
      this.jobEvent({
        level: outcome === 'failed' ? 'error' : outcome === 'lease_lost' ? 'warn' : 'info',
        event: 'job_finished',
        ...identity,
        duration_ms: Math.max(0, Math.round(performance.now() - started)),
        outcome,
        code: jobCode(code),
        at: new Date().toISOString(),
      });
      this.heartbeat();
    }
    return true;
  }
}

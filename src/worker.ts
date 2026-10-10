import {randomUUID} from 'node:crypto';
import {Store} from './store.js';
import {resolveReportConfig} from './reporting.js';
import {MirrorError} from './errors.js';
import type {Actor, JsonObject} from './types.js';
import {assertReportingConfigCredentials} from './report-query-access.js';
import {
  dueSchedules,
  failSchedule,
  followingOccurrence,
  jitteredRetryDelay,
  reevaluatedOccurrence,
} from './scheduled-work.js';
import {RELEASABLE_JOB_KINDS, WORKER_BOOT_ID} from './job-leases.js';
/** What a shutdown did with the job this worker was running (OPS-07). */
export type WorkerDrain = {released: string[]; settling: string[]};
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
  heartbeat(state = 'idle') {
    try {
      // The boot ID lets lease expiry tell a live process's stalled job from a crashed one (OPS-07); it is never shown.
      this.store.putDocument('__service_limits__', 'worker_heartbeat', this.workerId, {
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
    for (const tenant of this.store.listTenants())
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
    const current = (this.current = {job, released: false});
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
          const current = this.store.db
            .prepare('SELECT state,lease_token,lease_until FROM jobs WHERE id=?')
            .get(job.id) as JsonObject;
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
        } else if (job.kind === 'write_verification' && verification?.status === 'failed')
          this.store.failJob(job.id, job.lease_token, {
            code: 'VERIFICATION_FAILED',
            message:
              'The provider reported failure of the created job. Retain the original receipt; do not repeat its mutation.',
            details: {review_id: job.input.review_id},
          });
        else this.store.finishJob(job.id, job.lease_token, result);
      }
    } catch (e) {
      const error =
        e instanceof MirrorError
          ? {code: e.code, message: e.message, details: e.details}
          : {code: 'REPORT_FAILED', message: 'Report execution failed.'};
      if (!lostLease)
        try {
          if (
            e instanceof MirrorError &&
            e.retryable &&
            ['report_overview', 'sheets_export', 'report_file_export'].includes(job.kind) &&
            (job.attempts < 8 || (job.kind === 'report_overview' && e.code === 'REPORT_COLLECTION_YIELD'))
          )
            this.store.retryJob(
              job.id,
              job.lease_token,
              error,
              job.kind === 'sheets_export'
                ? jitteredRetryDelay(job.attempts, e.details.retry_after_ms)
                : Number(e.details.retry_after_ms ?? Math.min(300000, 5000 * 2 ** job.attempts)),
            );
          else this.store.failJob(job.id, job.lease_token, error);
        } catch {
          lostLease = true;
        }
      // A job released at shutdown already went back to the queue; its interrupted execution is not a failure.
      if (!current.released)
        this.store.appendAudit(job.tenant_id, job.id, {
          event: lostLease ? 'report_lease_lost' : 'report_failed',
          error,
        });
    } finally {
      clearInterval(heartbeat);
      if (this.current === current) this.current = undefined;
      this.heartbeat();
    }
    return true;
  }
}

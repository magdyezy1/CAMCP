import {randomUUID} from 'node:crypto';
import {Store} from './store.js';
import {nextSchedule, resolveReportConfig} from './reporting.js';
import {MirrorError} from './errors.js';
import type {Actor, JsonObject} from './types.js';
import {assertReportingConfigCredentials} from './report-query-access.js';
import {dueSchedules, failSchedule} from './scheduled-work.js';
export class ReportWorker {
  readonly workerId = randomUUID();
  private lastCleanup = 0;
  heartbeat(state = 'idle') {
    this.store.putDocument('__service_limits__', 'worker_heartbeat', this.workerId, {at: Date.now(), state});
    if (Date.now() - this.lastCleanup > 60000) {
      this.store.cleanupTransient();
      this.lastCleanup = Date.now();
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
          this.store.enqueueSchedule(tenant, schedule.id, schedule.revision, nextSchedule(schedule));
        } catch (e) {
          const error = e instanceof MirrorError ? {code: e.code, message: e.message} : {code: 'SCHEDULER_ERROR'};
          if (e instanceof MirrorError && !e.retryable)
            failSchedule(this.store, tenant, 'reporting_schedule', schedule, error);
          this.store.appendAudit(tenant, 'scheduler/' + schedule.id, {event: 'schedule_failed', error});
        }
      }
  }
  async once(): Promise<boolean> {
    this.heartbeat();
    this.tickSchedules();
    const job = this.store.leaseJob(60000);
    if (!job) return false;
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
              Number(e.details.retry_after_ms ?? Math.min(300000, 5000 * 2 ** job.attempts)),
            );
          else this.store.failJob(job.id, job.lease_token, error);
        } catch {
          lostLease = true;
        }
      this.store.appendAudit(job.tenant_id, job.id, {event: lostLease ? 'report_lease_lost' : 'report_failed', error});
    } finally {
      clearInterval(heartbeat);
      this.heartbeat();
    }
    return true;
  }
}

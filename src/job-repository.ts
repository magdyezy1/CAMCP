import type {Store} from './store.js';
import type {JsonObject} from './types.js';

/**
 * Job and write-claim statements that modules outside the store need (ARC-02): reporting and delivery jobs, their
 * leases and attempts, and whether a write claim exists. They moved here verbatim from src/reporting-overview.ts,
 * src/report-library.ts, src/report-file-delivery.ts, src/owner-operations.ts, src/report-runs.ts,
 * src/criteo-report-jobs.ts and src/write-records.ts. Every statement is bound to one workspace.
 */
const deliveryKinds = "('report_overview','sheets_export','report_file_export')";

/** How many Overview, Sheets and report file jobs of a workspace are queued or running (the queue bound is 100). */
export function activeReportJobCount(store: Store, tenant: string): number {
  return (
    store
      .sql()
      .prepare(
        `SELECT count(*) AS n FROM jobs WHERE tenant_id=? AND kind IN ${deliveryKinds} AND state IN ('queued','running')`,
      )
      .get(tenant) as JsonObject
  ).n;
}
/** Cancels a queued or running job, ending its lease. */
export function cancelJob(store: Store, tenant: string, id: string, now = Date.now()) {
  store
    .sql()
    .prepare(
      "UPDATE jobs SET state='cancelled',lease_until=NULL,lease_token=NULL,updated_at=? WHERE tenant_id=? AND id=? AND state IN ('queued','running')",
    )
    .run(now, tenant, id);
}
/** Queues a failed or cancelled reporting job again from its first attempt, with its lease-expiry counts reset. */
export function retryJob(store: Store, tenant: string, id: string, now = Date.now()) {
  store
    .sql()
    .prepare(
      "UPDATE jobs SET state='queued',attempts=0,lease_expiries=0,crash_expiries=0,error=NULL,available_at=?,updated_at=? WHERE tenant_id=? AND id=?",
    )
    .run(now, now, tenant, id);
}
/** Queues a job again from its first attempt and ends any lease (a Sheets resend). */
export function requeueJob(store: Store, tenant: string, id: string, now = Date.now()) {
  store
    .sql()
    .prepare(
      "UPDATE jobs SET state='queued',attempts=0,error=NULL,available_at=?,lease_until=NULL,lease_token=NULL,updated_at=? WHERE tenant_id=? AND id=?",
    )
    .run(now, now, tenant, id);
}
/** Cancels the queued Sheets export jobs of one export. */
export function cancelQueuedSheetsExports(store: Store, tenant: string, exportId: string, now = Date.now()) {
  store
    .sql()
    .prepare(
      "UPDATE jobs SET state='cancelled',lease_until=NULL,lease_token=NULL,updated_at=? WHERE tenant_id=? AND kind='sheets_export' AND state='queued' AND json_extract(input,'$.export_id')=?",
    )
    .run(now, tenant, exportId);
}
/** Cancels the queued or running Overview, Sheets and report file jobs of one snapshot. */
export function cancelReportJobs(store: Store, tenant: string, reportId: string, now = Date.now()) {
  store
    .sql()
    .prepare(
      `UPDATE jobs SET state='cancelled',lease_until=NULL,lease_token=NULL,updated_at=? WHERE tenant_id=? AND kind IN ${deliveryKinds} AND json_extract(input,'$.report_id')=? AND state IN ('queued','running')`,
    )
    .run(now, tenant, reportId);
}
/** Deletes every Overview, Sheets and report file job of one snapshot (the snapshot is deleted). */
export function deleteReportJobs(store: Store, tenant: string, reportId: string) {
  store
    .sql()
    .prepare(`DELETE FROM jobs WHERE tenant_id=? AND kind IN ${deliveryKinds} AND json_extract(input,'$.report_id')=?`)
    .run(tenant, reportId);
}
/** A job's attempts, or undefined when it does not exist. */
export function jobAttempts(store: Store, tenant: string, id: string): JsonObject | undefined {
  return store.sql().prepare('SELECT attempts FROM jobs WHERE tenant_id=? AND id=?').get(tenant, id) as
    JsonObject | undefined;
}
/** A job's state, or undefined when it does not exist. */
export function jobState(store: Store, tenant: string, id: string): JsonObject | undefined {
  return store.sql().prepare('SELECT state FROM jobs WHERE tenant_id=? AND id=?').get(tenant, id) as
    JsonObject | undefined;
}
/** A job's kind, or undefined when it does not exist. */
export function jobKind(store: Store, tenant: string, id: string): JsonObject | undefined {
  return store.sql().prepare('SELECT kind FROM jobs WHERE tenant_id=? AND id=?').get(tenant, id) as
    JsonObject | undefined;
}
/** A job's lease (state, token and expiry), or undefined when it does not exist. */
export function jobLease(store: Store, tenant: string, id: string): JsonObject | undefined {
  return store
    .sql()
    .prepare('SELECT state,lease_token,lease_until FROM jobs WHERE tenant_id=? AND id=?')
    .get(tenant, id) as JsonObject | undefined;
}
/** A job's lease (state, token and expiry) by its id alone, for the worker that holds it, or undefined. */
export function workerJobLease(store: Store, id: string): JsonObject | undefined {
  return store.sql().prepare('SELECT state,lease_token,lease_until FROM jobs WHERE id=?').get(id) as
    JsonObject | undefined;
}
/** Replaces a just-queued job's input (to bind its actor once its id exists). */
export function setJobInput(store: Store, id: string, input: string) {
  store.sql().prepare('UPDATE jobs SET input=? WHERE id=?').run(input, id);
}
/** A workspace's job counts by kind and state. */
export function jobCounts(store: Store, tenant: string): JsonObject[] {
  return store
    .sql()
    .prepare('SELECT kind,state,count(*) AS count FROM jobs WHERE tenant_id=? GROUP BY kind,state')
    .all(tenant) as JsonObject[];
}
/** A workspace's job counts by kind and state, with the oldest due time and the last update of each. */
export function jobQueue(store: Store, tenant: string): JsonObject[] {
  return store
    .sql()
    .prepare(
      'SELECT kind,state,count(*) AS count,min(available_at) AS oldest_due,max(updated_at) AS last_update FROM jobs WHERE tenant_id=? GROUP BY kind,state',
    )
    .all(tenant) as JsonObject[];
}
/** The write claim of an idempotency key (its state, result and creation time), or undefined when none was taken. */
export function writeClaim(store: Store, tenant: string, key: string): JsonObject | undefined {
  return store
    .sql()
    .prepare('SELECT state,result,created_at FROM idempotency WHERE tenant_id=? AND key=?')
    .get(tenant, key) as JsonObject | undefined;
}
/**
 * The moment a completed claim settled, for the guard against creating twice (R2.5 M3, dupstep round 2, lead review S2-1 b). A claim
 * completes when its write is answered, and then it settled when it was taken (`created_at`) or a moment after. One completed by
 * accepting an uncertain create as applied (src/write-reconciliation.ts) did not settle then: its result says `reconciled: true` and
 * `reconciled_at`, the moment of the acceptance, which can be long after the claim was taken. Dated by the claim alone, an uncertain
 * create accepted as applied more than ten minutes after it was sent was invisible to the guard, and an identical create prepared
 * after the acceptance carried no warning. A result that is not that (no JSON, no `reconciled: true`, a time that is not an integer)
 * leaves the claim's own time. The text is looked for first, so a result is parsed only when it could say so.
 */
const settledAt = `max(created_at, coalesce(CASE WHEN instr(result,'reconciled_at')>0 THEN
    CASE WHEN json_valid(result) THEN
      CASE WHEN json_type(result,'$.reconciled')='true' AND json_type(result,'$.reconciled_at')='integer'
        THEN json_extract(result,'$.reconciled_at') END
    END
  END, 0))`;
/**
 * The write claims of a workspace that are not settled (pending or uncertain), and those that completed since `since`
 * (state, result, key, creation time), oldest first: what a prepare compares an identical create with (R2.5 M2, L5-06).
 * The unsettled are few by nature; the completed are bounded to the newest 200 by the time they settled (`settledAt`), and each
 * keeps the time its claim was taken: the lookups date the provider's objects by it.
 */
export function openWriteClaims(store: Store, tenant: string, since: number): JsonObject[] {
  const unsettled = store
    .sql()
    .prepare(
      "SELECT key,state,result,created_at FROM idempotency WHERE tenant_id=? AND state IN ('pending','uncertain') ORDER BY created_at",
    )
    .all(tenant) as JsonObject[];
  const completed = store
    .sql()
    .prepare(
      `SELECT key,state,result,created_at FROM (SELECT key,state,result,created_at,${settledAt} AS settled_at FROM idempotency WHERE tenant_id=? AND state='complete') WHERE settled_at>? ORDER BY settled_at DESC LIMIT 200`,
    )
    .all(tenant, since) as JsonObject[];
  return [...unsettled, ...completed.reverse()];
}
/**
 * The completed write claims of a workspace, other than `exceptKey`, whose stored result mentions any of `needles` (R2.5 M2, lead
 * re-review N1): their keys and results. Nothing is cut by count or by age. Only the claims that name one of the IDs under
 * consideration are read, by a substring search of the stored text, so a workspace of any size costs one scan of its results.
 */
export function completedClaimsMentioning(
  store: Store,
  tenant: string,
  exceptKey: string,
  needles: string[],
): JsonObject[] {
  const rows = new Map<string, JsonObject>(),
    wanted = needles.filter(needle => needle.length > 0);
  for (let i = 0; i < wanted.length; i += 50) {
    const chunk = wanted.slice(i, i + 50);
    const found = store
      .sql()
      .prepare(
        "SELECT key,result FROM idempotency WHERE tenant_id=? AND state='complete' AND key<>? AND result IS NOT NULL AND (" +
          chunk.map(() => 'instr(result,?)>0').join(' OR ') +
          ')',
      )
      .all(tenant, exceptKey, ...chunk) as JsonObject[];
    for (const row of found) rows.set(String(row.key), row);
  }
  return [...rows.values()];
}
/** The write claim of an idempotency key with the fingerprint it was taken for (state, result, fingerprint). */
export function writeClaimFingerprint(store: Store, tenant: string, key: string): JsonObject | undefined {
  return store
    .sql()
    .prepare('SELECT state,result,fingerprint FROM idempotency WHERE tenant_id=? AND key=?')
    .get(tenant, key) as JsonObject | undefined;
}
/** Moves the queued jobs of `kind` that name `reviewId` to `availableAt`; returns whether there was one (R2.5 M2, S3-4). */
export function rescheduleQueuedReviewJob(
  store: Store,
  tenant: string,
  kind: string,
  reviewId: string,
  availableAt: number,
): boolean {
  return (
    Number(
      store
        .sql()
        .prepare(
          "UPDATE jobs SET available_at=?,updated_at=? WHERE tenant_id=? AND kind=? AND state='queued' AND json_extract(input,'$.review_id')=?",
        )
        .run(availableAt, Date.now(), tenant, kind, reviewId).changes,
    ) > 0
  );
}
/** Deletes the queued jobs of `kind` that name `reviewId`; one that is running is left to finish (R2.5 M2, S3-4). */
export function deleteQueuedReviewJobs(store: Store, tenant: string, kind: string, reviewId: string) {
  store
    .sql()
    .prepare("DELETE FROM jobs WHERE tenant_id=? AND kind=? AND state='queued' AND json_extract(input,'$.review_id')=?")
    .run(tenant, kind, reviewId);
}
/** Cancels a queued or running job, ending its lease (its update time is left as it was). */
export function cancelJobLease(store: Store, tenant: string, id: string) {
  store
    .sql()
    .prepare(
      "UPDATE jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE tenant_id=? AND id=? AND state IN ('queued','running')",
    )
    .run(tenant, id);
}
/** Whether a write claim was taken for an idempotency key. */
export function writeClaimed(store: Store, tenant: string, key: string): boolean {
  return !!store.sql().prepare('SELECT 1 FROM idempotency WHERE tenant_id=? AND key=?').get(tenant, key);
}

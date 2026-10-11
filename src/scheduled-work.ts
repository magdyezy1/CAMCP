import type {Store} from './store.js';
import type {JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {nextScheduleDetail, scheduleDstPolicy} from './schedule-clock.js';

/** Logged when a worker starts: schedule clocks depend on the runtime's time-zone database (Node ICU). */
export function workerClockEvent() {
  return {
    event: 'worker_clock',
    tz_version: process.versions.tz ?? null,
    icu_version: process.versions.icu ?? null,
    dst_policy: scheduleDstPolicy(),
    at: new Date().toISOString(),
  };
}

/** Re-evaluation delay when no following local occurrence is found (shorter than every bounded search window). */
export const scheduleReevaluateMs = 6 * 3600000;
/**
 * EXP-02: the occurrence after a due run is computed before that run is queued, and failing to find it never drops
 * the due run or pauses the schedule. An unresolved search keeps the schedule active, records a visible warning and
 * re-evaluates later; that re-evaluation is not itself an occurrence.
 */
export function followingOccurrence(
  schedule: JsonObject,
  at = Date.now(),
  detail: typeof nextScheduleDetail = nextScheduleDetail,
): JsonObject {
  try {
    const next = detail(schedule, at);
    return {
      next_run_at: next.at,
      next_run_dst_shifted: next.dst_shifted,
      next_run_reevaluate: false,
      schedule_warning: null,
    };
  } catch (e) {
    if (!(e instanceof MirrorError) || e.code !== 'SCHEDULE_UNRESOLVED') throw e;
    return {
      next_run_at: at + scheduleReevaluateMs,
      next_run_dst_shifted: false,
      next_run_reevaluate: true,
      schedule_warning: {
        code: 'SCHEDULE_UNRESOLVED',
        message:
          'No following local clock time was found. The schedule stays active and AMCP checks its clock again in 6 hours.',
        at,
      },
    };
  }
}
/** A due re-evaluation searches again from now, keeping the last real occurrence for repeated-hour checks. */
export function reevaluatedOccurrence(schedule: JsonObject, at = Date.now()): JsonObject {
  return followingOccurrence({...schedule, next_run_at: schedule.last_occurrence_at ?? undefined}, at);
}

export type ScheduleKind = 'reporting_schedule' | 'overview_schedule';
const kinds: ScheduleKind[] = ['reporting_schedule', 'overview_schedule'];
// Match JSON/JavaScript truthiness, including older string/integer declarations. Dates are a
// coarse numeric prefilter; the original JavaScript predicate below remains authoritative.
const active =
  "json_extract(data,'$.is_active') IS NOT NULL AND json_extract(data,'$.is_active')<>0 AND json_extract(data,'$.is_active')<>''";
/** The kinds the worker runs on a clock, and the SQL condition that selects an active one (restore quarantine). */
export const scheduleKinds: readonly ScheduleKind[] = kinds,
  activeScheduleSQL = active;
const deadline = "coalesce(CAST(json_extract(data,'$.next_run_at') AS REAL),0)";
export const scheduleIndexSQL = kinds
  .map(
    kind =>
      `CREATE INDEX IF NOT EXISTS ${kind}_due ON documents(tenant_id,${deadline},id) WHERE kind='${kind}' AND ${active}`,
  )
  .join(';');
export const dueScheduleSQL: Record<ScheduleKind, string> = Object.fromEntries(
  kinds.map(kind => [
    kind,
    `SELECT id,data,revision FROM documents WHERE tenant_id=? AND kind='${kind}' AND ${active} AND ${deadline}<=? ORDER BY id`,
  ]),
) as Record<ScheduleKind, string>;

/**
 * OPS-08 tenant-count sweep: a selection pass that asks every workspace grows with the workspace count (the recorded
 * measurement, with its date and machine, is the one in docs/OPERATIONS.md beside `benchmark-schedules.mjs --sweep`,
 * which repeats it), so one global partial index by deadline names the workspaces with
 * a due schedule of a kind and the worker asks only those. Per-workspace selection, its order and every authority
 * check stay as they were; the coarse prefilter may name a workspace whose schedules the exact predicate then skips.
 */
export const scheduleGlobalIndexSQL = kinds
  .map(
    kind =>
      `CREATE INDEX IF NOT EXISTS ${kind}_due_global ON documents(${deadline},tenant_id) WHERE kind='${kind}' AND ${active}`,
  )
  .join(';');
export const dueTenantSQL: Record<ScheduleKind, string> = Object.fromEntries(
  kinds.map(kind => [
    kind,
    // INDEXED BY: otherwise the planner may walk every workspace through the per-workspace index, the cost removed here.
    `SELECT DISTINCT tenant_id FROM documents INDEXED BY ${kind}_due_global WHERE kind='${kind}' AND ${active} AND ${deadline}<=? AND EXISTS(SELECT 1 FROM tenants WHERE tenants.id=documents.tenant_id) ORDER BY tenant_id`,
  ]),
) as Record<ScheduleKind, string>;
/** The workspaces, in workspace ID order (as `listTenants`), that may have a due schedule of `kind`. */
export function dueScheduleTenants(store: Store, kind: ScheduleKind, at = Date.now()): string[] {
  return (store.db.prepare(dueTenantSQL[kind]).all(at) as {tenant_id: string}[]).map(row => row.tenant_id);
}

/** Worker-internal selection only. No authority is derived from the index; enqueue rechecks the original actor/revision. */
export function dueSchedules(store: Store, tenant: string, kind: ScheduleKind, at = Date.now()): JsonObject[] {
  return (store.db.prepare(dueScheduleSQL[kind]).all(tenant, at) as JsonObject[])
    .map(row => ({...JSON.parse(row.data), id: row.id, revision: row.revision}))
    .filter(schedule => schedule.is_active && schedule.next_run_at <= at);
}

/**
 * Truncated exponential backoff (5 s doubling, at most 5 minutes) plus up to 1,000 ms of jitter, so shared-quota
 * retries from many tenants do not land on the same instant. A provider/settle hint replaces the exponential part.
 */
/**
 * A Sheets export re-checking an unconfirmed delivery inside its settle window (EXP-01 review): such a re-check does not
 * count against the job's eight attempts, so the identical resend after the window is always reached even when earlier
 * attempts went to EXPORT_BUSY, rate limits or 5xx. The window is fixed when the batch was sent, so this is bounded.
 */
export function sheetsSettleRecheck(kind: unknown, e: unknown, now = Date.now()): boolean {
  return (
    kind === 'sheets_export' &&
    e instanceof MirrorError &&
    e.code === 'SHEETS_OUTCOME_UNKNOWN' &&
    Number(e.details?.settle_until) > now
  );
}
export function jitteredRetryDelay(attempts: number, hintMs?: unknown, random: () => number = Math.random): number {
  const hint = Number(hintMs),
    base = hintMs !== undefined && Number.isFinite(hint) && hint >= 0 ? hint : Math.min(300000, 5000 * 2 ** attempts);
  return Math.round(base) + Math.floor(Math.min(0.999, Math.max(0, random())) * 1000);
}

/**
 * EXP-03 E: consecutive non-retryable delivery failures (authorization, ownership or an unresolved destination) that
 * pause a schedule. AMCP_SCHEDULE_DELIVERY_PAUSE_AFTER sets N (default 3); 0 keeps failing schedules active.
 */
export const scheduleDeliveryPauseAfter = () => {
  const n = Number(process.env.AMCP_SCHEDULE_DELIVERY_PAUSE_AFTER ?? 3);
  return Number.isInteger(n) && n >= 0 && n <= 100 ? n : 3;
};
export const deliveryPauseMessage =
  'Paused after repeated failed deliveries. Fix the destination or access shown in the last delivery, then resume.';
/**
 * Records the delivery outcome of a scheduled snapshot on its schedule: queued, retrying, complete, superseded,
 * skipped or failed. Only the schedule revision that produced the snapshot is changed, and an older occurrence never
 * replaces a newer one's outcome. A terminal success resets the failure count.
 */
export function recordScheduleDelivery(
  store: Store,
  tenant: string,
  report: JsonObject,
  delivery: {
    state: string;
    error_code?: string | null;
    blocking?: boolean;
    export_id?: string | null;
    job_id?: string | null;
    retry_available?: boolean;
  },
) {
  if (!report.schedule_id) return false;
  return store.transaction(() => {
    let current: JsonObject;
    try {
      current = store.document(tenant, 'overview_schedule', report.schedule_id);
    } catch (e) {
      if (e instanceof MirrorError && e.code === 'NOT_FOUND') return false;
      throw e;
    }
    if ((current.definition_version ?? 0) !== (report.schedule_version ?? 0)) return false;
    if (Number(current.last_delivery?.captured_at ?? -Infinity) > Number(report.captured_at ?? 0)) return false;
    const previous = Number(current.consecutive_delivery_failures ?? 0),
      failures =
        delivery.state === 'failed' && delivery.blocking
          ? previous + 1
          : ['complete', 'superseded'].includes(delivery.state)
            ? 0
            : previous;
    const {id, revision, ...data} = current;
    store.putDocument(
      tenant,
      'overview_schedule',
      id,
      {
        ...data,
        last_delivery: {
          state: delivery.state,
          at: Date.now(),
          report_id: report.id,
          captured_at: report.captured_at ?? null,
          export_id: delivery.export_id ?? null,
          job_id: delivery.job_id ?? null,
          error_code: delivery.error_code ?? null,
          retry_available: delivery.retry_available === true,
        },
        consecutive_delivery_failures: failures,
      },
      revision,
    );
    const limit = scheduleDeliveryPauseAfter();
    if (delivery.state === 'failed' && delivery.blocking && limit > 0 && failures >= limit && data.is_active)
      failSchedule(store, tenant, 'overview_schedule', store.document(tenant, 'overview_schedule', id), {
        code: 'SCHEDULE_DELIVERY_FAILED',
        message: deliveryPauseMessage,
        reason: 'delivery',
        delivery_error_code: delivery.error_code ?? null,
        consecutive_failures: failures,
      });
    return true;
  });
}

/** A failed old attempt may pause only that exact revision, never a subsequent edit or a deleted schedule. */
export function failSchedule(
  store: Store,
  tenant: string,
  kind: ScheduleKind,
  snapshot: JsonObject,
  error: JsonObject,
): boolean {
  return store.transaction(() => {
    let current: JsonObject;
    try {
      current = store.document(tenant, kind, snapshot.id);
    } catch (e) {
      if (e instanceof MirrorError && e.code === 'NOT_FOUND') return false;
      throw e;
    }
    if (current.revision !== snapshot.revision) return false;
    store.putDocument(tenant, kind, snapshot.id, {...current, is_active: false, error}, snapshot.revision);
    return true;
  });
}

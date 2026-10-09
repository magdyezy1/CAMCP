import type {Store} from './store.js';
import type {JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {nextScheduleDetail, scheduleDstPolicy} from './reporting.js';

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
export function jitteredRetryDelay(attempts: number, hintMs?: unknown, random: () => number = Math.random): number {
  const hint = Number(hintMs),
    base = hintMs !== undefined && Number.isFinite(hint) && hint >= 0 ? hint : Math.min(300000, 5000 * 2 ** attempts);
  return Math.round(base) + Math.floor(Math.min(0.999, Math.max(0, random())) * 1000);
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

import type {JsonObject} from './types.js';
import {MirrorError} from './errors.js';

/**
 * D13 policy for nonexistent local times (spring-forward gaps): shift_forward (default) runs at the first valid time
 * after the change, reading the wall time with the pre-transition offset (00:30 in a 00:00→01:00 gap runs at 01:30).
 * AMCP_SCHEDULE_DST_POLICY=skip is the rollback: the occurrence is skipped, still with widened look-ahead.
 */
export const scheduleDstPolicy = () => (process.env.AMCP_SCHEDULE_DST_POLICY === 'skip' ? 'skip' : 'shift_forward');
export function nextSchedule(schedule: JsonObject, after = Date.now()): number {
  return nextScheduleDetail(schedule, after).at;
}
/** The next occurrence and whether a daylight-saving gap shifted it forward from its nominal local time. */
export function nextScheduleDetail(schedule: JsonObject, after = Date.now()): {at: number; dst_shifted: boolean} {
  const config = schedule.schedule_config ?? {},
    kind = schedule.schedule_kind;
  if (
    !['hourly', 'daily', 'weekly', 'monthly'].includes(kind) ||
    !Number.isInteger(config.minute ?? 0) ||
    (config.minute ?? 0) < 0 ||
    (config.minute ?? 0) > 59 ||
    !Number.isInteger(config.hour ?? 0) ||
    (config.hour ?? 0) < 0 ||
    (config.hour ?? 0) > 23 ||
    (kind === 'weekly' && (!Number.isInteger(config.weekday) || config.weekday < 0 || config.weekday > 6)) ||
    (kind === 'monthly' && (!Number.isInteger(config.day ?? 1) || (config.day ?? 1) < 1 || (config.day ?? 1) > 31))
  )
    throw new MirrorError(
      'INVALID_SCHEDULE',
      'Use minute 0-59, hour 0-23, weekday 0-6 (Sunday=0), and monthly day 1-31. Shorter months use their last day.',
    );
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: schedule.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    throw new MirrorError('INVALID_TIMEZONE', 'Provide an IANA timezone.');
  }
  const parts = (at: number) => Object.fromEntries(format.formatToParts(at).map(p => [p.type, p.value])),
    p = parts(after),
    firstDay = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day));
  const previous =
    schedule.next_run_at !== undefined && schedule.next_run_at <= after
      ? format.format(schedule.next_run_at)
      : undefined;
  const shift = scheduleDstPolicy() === 'shift_forward',
    local = (q: JsonObject) =>
      Date.UTC(Number(q.year), Number(q.month) - 1, Number(q.day), Number(q.hour), Number(q.minute));
  // Look far enough ahead that a skipped or shifted day still finds the following occurrence (EXP-02).
  for (let day = 0; day <= (kind === 'monthly' ? 93 : kind === 'weekly' ? 15 : 2); day++) {
    const date = new Date(firstDay + day * 86400000),
      y = date.getUTCFullYear(),
      m = date.getUTCMonth(),
      d = date.getUTCDate();
    if (
      (kind === 'weekly' && date.getUTCDay() !== config.weekday) ||
      (kind === 'monthly' && d !== Math.min(config.day ?? 1, new Date(Date.UTC(y, m + 1, 0)).getUTCDate()))
    )
      continue;
    const candidates: {at: number; shifted: boolean}[] = [];
    for (const hour of kind === 'hourly' ? Array.from({length: 24}, (_, i) => i) : [config.hour ?? 0]) {
      const wall = Date.UTC(y, m, d, hour, config.minute ?? 0),
        offsets = new Set<number>();
      for (const delta of [-86400000, 0, 86400000]) {
        const at = wall + delta;
        offsets.add(local(parts(at)) - at);
      }
      let exists = false;
      for (const offset of offsets) {
        const at = wall - offset;
        if (local(parts(at)) !== wall) continue;
        exists = true;
        if (at > after && format.format(at) !== previous) candidates.push({at, shifted: false});
      }
      if (exists || !shift) continue;
      // The wall time falls in a gap: the pre-transition (smaller) offset gives the first valid local time after it.
      const at = wall - Math.min(...offsets);
      if (local(parts(at)) > wall && at > after && format.format(at) !== previous) candidates.push({at, shifted: true});
    }
    if (candidates.length) {
      const at = Math.min(...candidates.map(c => c.at));
      return {at, dst_shifted: !candidates.some(c => c.at === at && !c.shifted)};
    }
  }
  throw new MirrorError(
    'SCHEDULE_UNRESOLVED',
    'No valid local schedule occurrence was found within the bounded calendar search.',
  );
}
/**
 * Clock fields for a saved, resumed or re-evaluated schedule (EXP-02). A pending re-evaluation time is not an
 * occurrence, so the last real occurrence guards the repeated-hour check; any earlier warning is cleared.
 */
export function scheduleClockFields(schedule: JsonObject, after = Date.now()): JsonObject {
  const next = nextScheduleDetail(
    schedule.next_run_reevaluate ? {...schedule, next_run_at: schedule.last_occurrence_at ?? undefined} : schedule,
    after,
  );
  return {
    next_run_at: next.at,
    next_run_dst_shifted: next.dst_shifted,
    next_run_reevaluate: false,
    schedule_warning: null,
  };
}

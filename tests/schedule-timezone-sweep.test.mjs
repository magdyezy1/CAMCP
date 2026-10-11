// QA-02 property sweep (hand-rolled, no dependency): every IANA zone the runtime knows, over 2026 and 2027. For each
// daylight-saving or offset transition the sweep finds, daily, weekly and monthly schedules placed in the gap or in the
// repeated hour must resolve without a pause (no SCHEDULE_UNRESOLVED) and without an unscheduled skip:
//   - gap (spring forward): the occurrence runs on its own local day at the first valid time, the wall time read with
//     the pre-transition offset (owner decision D13, src/schedule-clock.ts), and is reported dst_shifted;
//   - overlap (fall back): the occurrence runs once, at its first instance, and the next one is a day later.
// Before EXP-02 a weekly gap occurrence threw SCHEDULE_UNRESOLVED and a monthly one skipped a whole month.
import test from 'node:test';
import assert from 'node:assert/strict';
import {nextScheduleDetail} from '../dist/src/schedule-clock.js';

const minute = 60000,
  hour = 60 * minute,
  day = 24 * hour,
  from = Date.UTC(2026, 0, 1),
  until = Date.UTC(2028, 0, 1);

/** Offset (local minus UTC, in ms) of `zone` at `at`, read from the runtime's own time-zone data. */
function offsetReader(zone) {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  });
  return at => {
    const p = Object.fromEntries(format.formatToParts(at).map(x => [x.type, Number(x.value)]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(at / minute) * minute;
  };
}
/** Every instant in [from, until) where the zone's offset changes, to the minute, with the offsets around it. */
export function transitions(zone, start = from, end = until) {
  const offset = offsetReader(zone),
    found = [];
  for (let t = start; t < end; t += day) {
    const before = offset(t),
      after = offset(t + day);
    if (before === after) continue;
    let lo = t,
      hi = t + day;
    while (hi - lo > minute) {
      const mid = lo + Math.floor((hi - lo) / 2 / minute) * minute;
      if (offset(mid) === before) lo = mid;
      else hi = mid;
    }
    found.push({at: hi, before, after: offset(hi)});
  }
  return found;
}
/** Local calendar fields of a UTC instant shifted by `offset`. */
const local = (at, offset) => {
  const d = new Date(at + offset);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth(),
    d: d.getUTCDate(),
    weekday: d.getUTCDay(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
};
const resolve = (zone, kind, wall, after, extra = {}) =>
  nextScheduleDetail(
    {
      schedule_kind: kind,
      timezone: zone,
      schedule_config: {
        hour: wall.hour,
        minute: wall.minute,
        ...(kind === 'weekly' ? {weekday: wall.weekday} : {}),
        ...(kind === 'monthly' ? {day: wall.d} : {}),
      },
      ...extra,
    },
    after,
  );
const lookBehind = {daily: 12 * hour, weekly: 3 * day, monthly: 20 * day};

const zones = Intl.supportedValuesOf('timeZone');
const sweep = zones.map(zone => ({zone, changes: transitions(zone)}));

test('the sweep reads real transitions: New York, Cairo and Lord Howe change in 2026 and 2027', () => {
  const of = zone => sweep.find(s => s.zone === zone)?.changes ?? [];
  assert.equal(of('America/New_York').length, 4);
  assert.deepEqual(
    of('America/New_York').map(c => new Date(c.at).toISOString()),
    ['2026-03-08T07:00:00.000Z', '2026-11-01T06:00:00.000Z', '2027-03-14T07:00:00.000Z', '2027-11-07T06:00:00.000Z'],
  );
  // Cairo's spring change is at local midnight (00:00 -> 01:00), so a 00:30 schedule falls in the gap.
  assert.ok(of('Africa/Cairo').some(c => c.after > c.before && local(c.at, c.before).hour === 0));
  // Lord Howe moves by 30 minutes.
  assert.ok(of('Australia/Lord_Howe').some(c => Math.abs(c.after - c.before) === 30 * minute));
  assert.ok(sweep.filter(s => s.changes.length).length >= 60, 'zones with a transition');
});

test('fixed clocks: New York 2026-03-08 02:30 weekly, daily and monthly run at 03:30 EDT the same day', () => {
  for (const [kind, config, after] of [
    ['weekly', {weekday: 0}, Date.parse('2026-03-02T00:00:00Z')],
    ['daily', {}, Date.parse('2026-03-07T12:00:00Z')],
    ['monthly', {day: 8}, Date.parse('2026-02-15T00:00:00Z')],
  ]) {
    const next = nextScheduleDetail(
      {schedule_kind: kind, timezone: 'America/New_York', schedule_config: {hour: 2, minute: 30, ...config}},
      after,
    );
    assert.equal(new Date(next.at).toISOString(), '2026-03-08T07:30:00.000Z', kind);
    assert.equal(next.dst_shifted, true, kind);
  }
});

test('every zone, 2026-2027: a schedule in a gap runs on its own day at the first valid time, never paused or skipped', () => {
  const problems = [];
  let checked = 0;
  for (const {zone, changes} of sweep)
    for (const change of changes.filter(c => c.after > c.before)) {
      const gap = change.after - change.before,
        // The first minute of the gap and its middle (rounded to a minute).
        offsets = [...new Set([0, Math.floor(gap / 2 / minute) * minute])];
      for (const into of offsets) {
        const wall = local(change.at + into, change.before);
        for (const kind of ['daily', 'weekly', 'monthly']) {
          checked++;
          try {
            const next = resolve(zone, kind, wall, change.at - lookBehind[kind]);
            if (next.at !== change.at + into || next.dst_shifted !== true)
              problems.push({zone, kind, wall, expected: change.at + into, got: next});
          } catch (e) {
            problems.push({zone, kind, wall, error: e.code ?? e.message});
          }
        }
      }
    }
  assert.deepEqual(problems.slice(0, 10), [], problems.length + ' of ' + checked + ' gap occurrences');
  assert.ok(checked >= 300, 'gap occurrences checked: ' + checked);
});

test('every zone, 2026-2027: a schedule in a repeated hour runs once, at its first instance', () => {
  const problems = [];
  let checked = 0;
  for (const {zone, changes} of sweep)
    for (const change of changes.filter(c => c.after < c.before)) {
      // The first local minute that occurs twice: it is first reached at change.at - (before - after).
      const first = change.at - (change.before - change.after),
        wall = local(first, change.before);
      for (const kind of ['daily', 'weekly', 'monthly']) {
        checked++;
        try {
          const next = resolve(zone, kind, wall, first - lookBehind[kind]);
          if (next.at !== first || next.dst_shifted) {
            problems.push({zone, kind, wall, expected: first, got: next});
            continue;
          }
          // The repeated instance (at change.at, the same wall time under the later offset) must not run again.
          const again = resolve(zone, kind, wall, next.at, {next_run_at: next.at});
          if (again.at - next.at < 20 * hour) problems.push({zone, kind, wall, repeated: again.at, first: next.at});
        } catch (e) {
          problems.push({zone, kind, wall, error: e.code ?? e.message});
        }
      }
    }
  assert.deepEqual(problems.slice(0, 10), [], problems.length + ' of ' + checked + ' repeated-hour occurrences');
  assert.ok(checked >= 300, 'repeated-hour occurrences checked: ' + checked);
});

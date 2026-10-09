// EXP-02 / D13: schedule clocks shift a nonexistent local time forward (spring gap) and run a repeated time once
// (autumn overlap). Table-driven over seven zones and every schedule kind for 400 simulated days; synthetic only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ReportingService, nextScheduleDetail, scheduleClockFields} from '../src/reporting.js';
import {
  followingOccurrence,
  reevaluatedOccurrence,
  scheduleReevaluateMs,
  workerClockEvent,
} from '../src/scheduled-work.js';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {ReportingOverview} from '../src/reporting-overview.js';
import {ReportWorker} from '../src/worker.js';
import {saveWorkbookSchedule, workbookSchedule} from '../src/workbook-schedules.js';
import {operationsPage} from '../src/operations-feed.js';
import {MirrorError} from '../src/errors.js';
import type {Actor, JsonObject} from '../src/types.js';

const zones = [
  'Africa/Cairo',
  'Asia/Beirut',
  'America/Santiago',
  'America/Asuncion',
  'America/New_York',
  'Europe/London',
  'Australia/Lord_Howe',
];
const start = Date.parse('2026-01-01T00:00:00Z'),
  end = start + 400 * 86400000,
  clocks: [number, number][] = [
    [0, 0],
    [0, 30],
    [1, 30],
    [2, 15],
    [2, 30],
    [23, 30],
  ],
  weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const clockCache = new Map<string, (at: number) => JsonObject>();
const localClock = (zone: string) => clockCache.get(zone) ?? clockCache.set(zone, makeClock(zone)).get(zone)!;
const makeClock = (zone: string) => {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  return (at: number) => {
    const p = Object.fromEntries(format.formatToParts(at).map(x => [x.type, x.value]));
    return {
      date: `${p.year}-${p.month}-${p.day}`,
      month: `${p.year}-${p.month}`,
      day: Number(p.day),
      hour: Number(p.hour),
      minute: Number(p.minute),
      weekday: p.weekday,
    };
  };
};
function simulate(schedule: JsonObject, from = start, to = end) {
  const out: {at: number; dst_shifted: boolean}[] = [];
  let after = from,
    current = {...schedule};
  for (let i = 0; i < 20000; i++) {
    const next = nextScheduleDetail(current, after);
    if (next.at > to) break;
    out.push(next);
    current = {...schedule, next_run_at: next.at};
    after = next.at;
  }
  return out;
}
const addDays = (date: string, days: number) =>
  new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
const nextMonth = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};
// A shifted occurrence keeps its local date and lands at most one hour after the nominal (nonexistent) time.
function assertClock(zone: string, occurrence: {at: number; dst_shifted: boolean}, hour: number, minute: number) {
  const l = localClock(zone)(occurrence.at),
    nominal = hour * 60 + minute,
    actual = l.hour * 60 + l.minute;
  if (!occurrence.dst_shifted) assert.equal(actual, nominal, `${zone} ${l.date} keeps its clock time`);
  else {
    assert.ok(actual > nominal && actual - nominal <= 60, `${zone} ${l.date} shifts forward by the gap`);
    // The nominal wall time truly does not exist on that date.
    for (let at = occurrence.at - 2 * 3600000; at <= occurrence.at + 3600000; at += 60000) {
      const probe = localClock(zone)(at);
      assert.ok(!(probe.date === l.date && probe.hour === hour && probe.minute === minute), `${zone} gap time`);
    }
  }
}

test('daily schedules run exactly once on every local date across gaps and overlaps', () => {
  for (const zone of zones)
    for (const [hour, minute] of clocks) {
      const occurrences = simulate({timezone: zone, schedule_kind: 'daily', schedule_config: {hour, minute}});
      assert.ok(occurrences.length >= 399, `${zone} ${hour}:${minute} ran ${occurrences.length} times`);
      const clock = localClock(zone);
      for (let i = 0; i < occurrences.length; i++) {
        assertClock(zone, occurrences[i]!, hour, minute);
        if (i)
          assert.equal(
            clock(occurrences[i]!.at).date,
            addDays(clock(occurrences[i - 1]!.at).date, 1),
            `${zone} ${hour}:${minute} has one run per local date`,
          );
      }
    }
});

test('weekly schedules run exactly once every local week on their weekday', () => {
  for (const zone of zones)
    for (let weekday = 0; weekday < 7; weekday++)
      for (const [hour, minute] of [clocks[0]!, clocks[1]!, clocks[4]!]) {
        const occurrences = simulate({
            timezone: zone,
            schedule_kind: 'weekly',
            schedule_config: {hour, minute, weekday},
          }),
          clock = localClock(zone);
        assert.ok(occurrences.length >= 56, `${zone} weekday ${weekday} ran ${occurrences.length} times`);
        for (let i = 0; i < occurrences.length; i++) {
          assertClock(zone, occurrences[i]!, hour, minute);
          assert.equal(clock(occurrences[i]!.at).weekday, weekdays[weekday]);
          if (i) assert.equal(clock(occurrences[i]!.at).date, addDays(clock(occurrences[i - 1]!.at).date, 7));
        }
      }
});

test('monthly schedules run exactly once every local month, clamping short months', () => {
  for (const zone of zones)
    for (const day of [1, 6, 8, 24, 29, 31])
      for (const [hour, minute] of [clocks[0]!, clocks[1]!, clocks[4]!]) {
        const occurrences = simulate({timezone: zone, schedule_kind: 'monthly', schedule_config: {hour, minute, day}}),
          clock = localClock(zone);
        assert.ok(occurrences.length >= 13);
        for (let i = 0; i < occurrences.length; i++) {
          const l = clock(occurrences[i]!.at),
            [y, m] = l.month.split('-').map(Number);
          assertClock(zone, occurrences[i]!, hour, minute);
          assert.equal(l.day, Math.min(day, new Date(Date.UTC(y!, m!, 0)).getUTCDate()));
          if (i) assert.equal(l.month, nextMonth(clock(occurrences[i - 1]!.at).month));
        }
      }
});

test('hourly schedules run once in every existing local hour around each offset change', () => {
  for (const zone of zones) {
    const clock = localClock(zone),
      offset = (at: number) => {
        const l = clock(at);
        return Date.UTC(Number(l.date.slice(0, 4)), Number(l.date.slice(5, 7)) - 1, l.day, l.hour, l.minute) - at;
      };
    const changes: number[] = [];
    for (let at = start; at < end; at += 1800000) if (offset(at) !== offset(at + 1800000)) changes.push(at);
    for (const change of changes)
      for (const minute of [0, 15, 30, 45]) {
        const from = change - 2 * 86400000,
          to = change + 2 * 86400000,
          occurrences = simulate({timezone: zone, schedule_kind: 'hourly', schedule_config: {minute}}, from, to),
          keys = occurrences.map(o => {
            const l = clock(o.at);
            return l.date + 'T' + l.hour;
          });
        assert.equal(new Set(keys).size, keys.length, `${zone} :${minute} runs once per local hour`);
        const existing = new Set<string>();
        for (let at = occurrences[0]!.at; at <= occurrences.at(-1)!.at; at += 900000) {
          const l = clock(at);
          existing.add(l.date + 'T' + l.hour);
        }
        assert.deepEqual(
          [...existing].filter(k => !keys.includes(k)),
          [],
          `${zone} :${minute} misses no hour`,
        );
      }
  }
});

test('the reproduced Cairo, Beirut and April 2027 gaps shift forward instead of throwing', () => {
  const cairo = {timezone: 'Africa/Cairo', schedule_kind: 'weekly', schedule_config: {hour: 0, minute: 30, weekday: 5}};
  // Computed at the last valid weekly run before Egypt's 24 April 2026 change (the tick that used to pause).
  let next = nextScheduleDetail(
    {...cairo, next_run_at: Date.parse('2026-04-16T22:30:00Z')},
    Date.parse('2026-04-16T22:30:05Z'),
  );
  assert.deepEqual(next, {at: Date.parse('2026-04-23T22:30:00Z'), dst_shifted: true});
  assert.equal(localClock('Africa/Cairo')(next.at).hour, 1);
  // The deployed acceptance preview: April 2027 shows a shifted 01:30 occurrence.
  next = nextScheduleDetail(cairo, Date.parse('2027-04-24T00:00:00Z'));
  assert.deepEqual(next, {at: Date.parse('2027-04-29T22:30:00Z'), dst_shifted: true});
  next = nextScheduleDetail(
    {timezone: 'Asia/Beirut', schedule_kind: 'weekly', schedule_config: {hour: 0, minute: 0, weekday: 0}},
    Date.parse('2026-03-22T00:00:00Z'),
  );
  assert.deepEqual(next, {at: Date.parse('2026-03-28T22:00:00Z'), dst_shifted: true});
  // The rollback policy skips the gap, still without throwing.
  process.env.AMCP_SCHEDULE_DST_POLICY = 'skip';
  try {
    assert.deepEqual(nextScheduleDetail(cairo, Date.parse('2026-04-17T00:00:00Z')), {
      at: Date.parse('2026-04-30T21:30:00Z'),
      dst_shifted: false,
    });
  } finally {
    delete process.env.AMCP_SCHEDULE_DST_POLICY;
  }
});

test('an unresolved following occurrence keeps the schedule active and re-evaluates later', () => {
  const unresolved = () => {
    throw new MirrorError('SCHEDULE_UNRESOLVED', 'Synthetic unresolved clock.');
  };
  const at = Date.parse('2026-04-16T22:30:05Z'),
    following = followingOccurrence({timezone: 'UTC'}, at, unresolved);
  assert.equal(following.next_run_reevaluate, true);
  assert.equal(following.next_run_at, at + scheduleReevaluateMs);
  assert.equal(following.schedule_warning.code, 'SCHEDULE_UNRESOLVED');
  assert.throws(
    () =>
      followingOccurrence({timezone: 'UTC'}, at, () => {
        throw new MirrorError('INVALID_TIMEZONE', 'Synthetic invalid clock.');
      }),
    {code: 'INVALID_TIMEZONE'},
  );
  const resolved = reevaluatedOccurrence(
    {
      timezone: 'Africa/Cairo',
      schedule_kind: 'daily',
      schedule_config: {hour: 9, minute: 0},
      last_occurrence_at: Date.parse('2026-04-16T07:00:00Z'),
    },
    at,
  );
  assert.deepEqual(resolved, {
    next_run_at: Date.parse('2026-04-17T07:00:00Z'),
    next_run_dst_shifted: false,
    next_run_reevaluate: false,
    schedule_warning: null,
  });
  // Saving or resuming recomputes the clock from the last real occurrence and clears the warning.
  assert.deepEqual(
    scheduleClockFields(
      {
        timezone: 'Africa/Cairo',
        schedule_kind: 'weekly',
        schedule_config: {hour: 0, minute: 30, weekday: 5},
        next_run_reevaluate: true,
        next_run_at: Date.parse('2026-04-17T04:00:00Z'),
        last_occurrence_at: Date.parse('2026-04-16T22:30:00Z'),
        schedule_warning: {code: 'SCHEDULE_UNRESOLVED'},
      },
      Date.parse('2026-04-17T00:00:00Z'),
    ),
    {
      next_run_at: Date.parse('2026-04-23T22:30:00Z'),
      next_run_dst_shifted: true,
      next_run_reevaluate: false,
      schedule_warning: null,
    },
  );
  const event = workerClockEvent();
  assert.equal(event.event, 'worker_clock');
  assert.equal(event.tz_version, process.versions.tz ?? null);
  assert.equal(event.dst_policy, 'shift_forward');
});

const actor: Actor = {tenantId: 't', userId: 'u', role: 'admin'};
async function withClock<T>(at: number, fn: () => T | Promise<T>) {
  const realNow = Date.now;
  Date.now = () => at;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

test('the overview tick at the last run before a gap queues the due run and stays active', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 91).toString('base64'));
  try {
    store.ensureTenant('t');
    const base: JsonObject = {
      name: 'Synthetic weekly overview',
      is_active: true,
      timezone: 'Africa/Cairo',
      schedule_kind: 'weekly',
      schedule_config: {hour: 0, minute: 30, weekday: 5},
      config: {sources: [], date_range: {since: '2026-04-01', until: '2026-04-07'}},
      destination_id: null,
      definition_version: 1,
      actor_binding: store.bindJobActor(actor, 'weekly'),
    };
    store.putDocument('t', 'overview_schedule', 'weekly', {...base, next_run_at: Date.parse('2026-04-16T22:30:00Z')});
    const overview = new ReportingOverview(new MirrorService(new Registry(), store));
    // The local preview (no provider request) marks the shifted occurrence.
    store.putConnection(
      actor,
      {
        id: 'meta',
        tenantId: 't',
        gateway: 'meta_native_action',
        enabled: true,
        accounts: ['123'],
        scopes: ['ads_read'],
        label: 'Synthetic Meta',
      },
      {accessToken: 'synthetic'},
    );
    const preview = await withClock(Date.parse('2026-04-17T00:00:00Z'), () =>
      overview.handle(
        {
          action: 'preview_schedule',
          schedule: {
            timezone: 'Africa/Cairo',
            schedule_kind: 'weekly',
            schedule_config: {hour: 0, minute: 30, weekday: 5},
          },
          config: {
            name: 'Synthetic',
            sources: [{platform: 'meta', account_id: '123', connection_id: 'meta'}],
            date_range: {preset: 'last_complete_days', days: 7, timezone: 'Africa/Cairo'},
          },
        },
        actor,
      ),
    );
    assert.equal(preview.network_requests, 0);
    assert.equal(preview.occurrences[0].delivery_at, '2026-04-23T22:30:00.000Z');
    assert.equal(preview.occurrences[0].dst_shifted, true);
    assert.equal(preview.occurrences[1].dst_shifted, undefined);
    await withClock(Date.parse('2026-04-16T22:30:05Z'), () => overview.tick());
    let s = store.document('t', 'overview_schedule', 'weekly');
    assert.equal(s.is_active, true);
    assert.equal(s.error, null);
    assert.equal(s.next_run_at, Date.parse('2026-04-23T22:30:00Z'));
    assert.equal(s.next_run_dst_shifted, true);
    assert.equal(s.last_occurrence_at, Date.parse('2026-04-16T22:30:00Z'));
    assert.equal(store.documents('t', 'overview_report').length, 1);
    assert.equal((store.db.prepare('SELECT count(*) AS n FROM jobs').get() as JsonObject).n, 1);
    // The shifted run itself is queued at 01:30 local and the schedule keeps going.
    await withClock(Date.parse('2026-04-23T22:30:05Z'), () => overview.tick());
    s = store.document('t', 'overview_schedule', 'weekly');
    assert.equal(s.is_active, true);
    assert.equal(s.next_run_at, Date.parse('2026-04-30T21:30:00Z'));
    assert.equal(s.next_run_dst_shifted, false);
    assert.equal(store.documents('t', 'overview_report').length, 2);
    // A re-evaluation entry is not an occurrence: it only resolves the clock again.
    store.putDocument(
      't',
      'overview_schedule',
      'weekly',
      {
        ...s,
        next_run_at: Date.parse('2026-05-01T00:00:00Z'),
        next_run_reevaluate: true,
        schedule_warning: {code: 'SCHEDULE_UNRESOLVED', message: 'Synthetic.'},
        last_occurrence_at: Date.parse('2026-04-23T22:30:00Z'),
      },
      s.revision,
    );
    await withClock(Date.parse('2026-05-01T00:00:05Z'), () => overview.tick());
    s = store.document('t', 'overview_schedule', 'weekly');
    assert.equal(store.documents('t', 'overview_report').length, 2);
    assert.equal(s.next_run_reevaluate, false);
    assert.equal(s.schedule_warning, null);
    assert.equal(s.next_run_at, Date.parse('2026-05-07T21:30:00Z'));
  } finally {
    store.close();
  }
});

test('the workbook tick at the last run before a gap queues the due run and stays active', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 92).toString('base64'));
  try {
    store.putConnection(
      actor,
      {
        id: 'schedule-google',
        tenantId: 't',
        gateway: 'google_ads_native_action',
        accounts: ['111'],
        enabled: true,
        label: 'Synthetic',
        scopes: [],
      },
      {accessToken: 'synthetic'},
    );
    const reporting = new ReportingService(store);
    const binding = reporting.handle('bind_reporting_workbook', {spreadsheet_id: 'test', dry_run: false}, actor) as any;
    const query = reporting.handle(
      'create_reporting_query',
      {
        workbook_binding_id: binding.id,
        name: 'R',
        query_config: {platform: 'google', account_id: '111', connection_id: 'schedule-google'},
        dry_run: false,
      },
      actor,
    ) as any;
    const schedule = reporting.handle(
      'create_reporting_schedule',
      {
        workbook_binding_id: binding.id,
        name: 'Weekly',
        timezone: 'Africa/Cairo',
        schedule_kind: 'weekly',
        schedule_config: {hour: 0, minute: 30, weekday: 5, query_id: query.id},
        dry_run: false,
      },
      actor,
    ) as any;
    const doc = store.document('t', 'reporting_schedule', schedule.id);
    store.putDocument(
      't',
      'reporting_schedule',
      schedule.id,
      {...doc, next_run_at: Date.parse('2026-04-16T22:30:00Z')},
      doc.revision,
    );
    const worker = new ReportWorker(store, async () => ({rows: []})),
      before = (store.db.prepare("SELECT count(*) AS n FROM jobs WHERE kind='report'").get() as JsonObject).n;
    await withClock(Date.parse('2026-04-16T22:30:05Z'), () => worker.tickSchedules());
    const s = store.document('t', 'reporting_schedule', schedule.id);
    assert.equal(s.is_active, true);
    assert.equal(s.error ?? null, null);
    assert.equal(s.next_run_at, Date.parse('2026-04-23T22:30:00Z'));
    assert.equal(s.next_run_dst_shifted, true);
    assert.equal(
      (store.db.prepare("SELECT count(*) AS n FROM jobs WHERE kind='report'").get() as JsonObject).n,
      before + 1,
    );
    // The workbook clock preview marks the shifted occurrence (local preview, no network).
    const preview = await withClock(Date.parse('2026-04-17T00:00:00Z'), () =>
      workbookSchedule(store, actor, schedule.id),
    );
    assert.equal(preview.state, 'active');
    assert.equal(preview.network_requests, 0);
    assert.equal(preview.occurrences[0], Date.parse('2026-04-23T22:30:00Z'));
    assert.deepEqual(preview.dst_shifted, [true, false, false]);
    // A schedule paused by the old code (SCHEDULE_UNRESOLVED) is an Operations attention item and recovers on resume.
    const paused = store.document('t', 'reporting_schedule', schedule.id);
    store.putDocument(
      't',
      'reporting_schedule',
      schedule.id,
      {
        ...paused,
        is_active: false,
        error: {code: 'SCHEDULE_UNRESOLVED', message: 'Synthetic legacy pause.'},
        schedule_warning: {code: 'SCHEDULE_UNRESOLVED', message: 'Synthetic.'},
        next_run_reevaluate: true,
      },
      paused.revision,
    );
    const feed = operationsPage(store, actor, {kind: 'workbook_schedule', state: 'attention'}, true);
    assert.deepEqual(
      feed.operations.map((o: JsonObject) => [o.id, o.state, o.error_code]),
      [[schedule.id, 'failed', 'SCHEDULE_UNRESOLVED']],
    );
    const resumed = await withClock(Date.parse('2026-04-17T00:00:00Z'), () => {
      const current = workbookSchedule(store, actor, schedule.id);
      return saveWorkbookSchedule(store, actor, {
        id: schedule.id,
        schedule_version: current.schedule_version,
        active: true,
        confirmed: true,
        schedule: {name: 'Weekly', timezone: 'Africa/Cairo', schedule_kind: 'weekly', hour: 0, minute: 30, weekday: 5},
      });
    });
    assert.equal(resumed.state, 'active');
    assert.equal(resumed.error_code, undefined);
    const saved = store.document('t', 'reporting_schedule', schedule.id);
    assert.equal(saved.next_run_at, Date.parse('2026-04-23T22:30:00Z'));
    assert.equal(saved.next_run_dst_shifted, true);
    assert.equal(saved.schedule_warning, null);
    assert.equal(saved.next_run_reevaluate, false);
  } finally {
    store.close();
  }
});

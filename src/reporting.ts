import {randomUUID} from 'node:crypto';
import type {Actor, JsonObject} from './types.js';
import {Store} from './store.js';
import {MirrorError} from './errors.js';
export const reportingOperations = new Set([
  'bind_reporting_workbook',
  'create_reporting_query',
  'update_reporting_query',
  'create_reporting_schedule',
  'update_reporting_schedule',
  'save_workbook_preferences',
  'execute_reporting_run',
  'get_reporting_run',
  'get_reporting_run_status',
  'get_reporting_bootstrap',
  'get_reporting_workbook_bootstrap',
  'get_reporting_storage_overview',
  'list_reporting_templates',
]);
export function nextSchedule(schedule: JsonObject, after = Date.now()): number {
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
  for (let day = 0; day <= (kind === 'monthly' ? 63 : 8); day++) {
    const date = new Date(firstDay + day * 86400000),
      y = date.getUTCFullYear(),
      m = date.getUTCMonth(),
      d = date.getUTCDate();
    if (
      (kind === 'weekly' && date.getUTCDay() !== config.weekday) ||
      (kind === 'monthly' && d !== Math.min(config.day ?? 1, new Date(Date.UTC(y, m + 1, 0)).getUTCDate()))
    )
      continue;
    const candidates: number[] = [];
    for (const hour of kind === 'hourly' ? Array.from({length: 24}, (_, i) => i) : [config.hour ?? 0]) {
      const wall = Date.UTC(y, m, d, hour, config.minute ?? 0),
        offsets = new Set<number>();
      for (const delta of [-86400000, 0, 86400000]) {
        const at = wall + delta,
          q = parts(at);
        offsets.add(
          Date.UTC(Number(q.year), Number(q.month) - 1, Number(q.day), Number(q.hour), Number(q.minute)) - at,
        );
      }
      for (const offset of offsets) {
        const at = wall - offset,
          q = parts(at);
        if (
          at > after &&
          Number(q.year) === y &&
          Number(q.month) === m + 1 &&
          Number(q.day) === d &&
          Number(q.hour) === hour &&
          Number(q.minute) === (config.minute ?? 0) &&
          format.format(at) !== previous
        )
          candidates.push(at);
      }
    }
    if (candidates.length) return Math.min(...candidates);
  }
  throw new MirrorError(
    'SCHEDULE_UNRESOLVED',
    'No valid local schedule occurrence was found within the bounded calendar search.',
  );
}
export function resolveReportConfig(config: JsonObject, now = Date.now()): JsonObject {
  const result = structuredClone(config),
    range = result.date_range;
  if (!range?.preset) return result;
  if (
    range.offset_days !== undefined &&
    (!Number.isInteger(range.offset_days) || range.offset_days < 0 || range.offset_days > 90)
  )
    throw new MirrorError('INVALID_ROLLING_WINDOW', 'Skip 0–90 recent days to allow conversion reporting to mature.');
  if (
    !['last_complete_days', 'last_complete_week', 'last_complete_month'].includes(range.preset) ||
    (range.preset === 'last_complete_days' && (!Number.isInteger(range.days) || range.days < 1 || range.days > 366)) ||
    typeof range.timezone !== 'string'
  )
    throw new MirrorError(
      'INVALID_ROLLING_WINDOW',
      'Choose last_complete_days (1–366 days), last_complete_week or last_complete_month with an IANA timezone.',
    );
  if (range.preset !== 'last_complete_days' && (range.offset_days ?? 0) !== 0)
    throw new MirrorError('INVALID_ROLLING_WINDOW', 'Calendar week/month windows do not use a recent-day offset.');
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: range.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
  } catch {
    throw new MirrorError('INVALID_TIMEZONE', 'Rolling windows require an explicit IANA timezone.');
  }
  const part = (kind: string) => Number(parts.find(p => p.type === kind)!.value),
    today = Date.UTC(part('year'), part('month') - 1, part('day'));
  let since: number, until: number;
  if (range.preset === 'last_complete_month') {
    since = Date.UTC(part('year'), part('month') - 2, 1);
    until = Date.UTC(part('year'), part('month') - 1, 1) - 86400000;
  } else if (range.preset === 'last_complete_week') {
    const monday = today - ((new Date(today).getUTCDay() + 6) % 7) * 86400000;
    since = monday - 7 * 86400000;
    until = monday - 86400000;
  } else {
    since = today - (range.days + (range.offset_days ?? 0)) * 86400000;
    until = today - (1 + (range.offset_days ?? 0)) * 86400000;
  }
  result.date_range = {
    since: new Date(since).toISOString().slice(0, 10),
    until: new Date(until).toISOString().slice(0, 10),
  };
  return result;
}
export class ReportingService {
  constructor(readonly store: Store) {}
  prepareRun(actor: Actor, queryId: string): string {
    const query = this.store.document(actor.tenantId, 'reporting_query', queryId);
    return this.store.enqueueReport(
      actor,
      {query_id: queryId, query_revision: query.revision, query_config: query.query_config},
      Number.MAX_SAFE_INTEGER,
    );
  }
  handle(operation: string, args: JsonObject, actor: Actor): unknown {
    this.store.assertActorActive(actor);
    const tenant = actor.tenantId;
    if (operation === 'list_reporting_templates')
      return [
        {
          id: '00000000-0000-4000-8000-000000000001',
          name: 'Campaign performance',
          output: 'local JSON and CSV',
          required: ['platform', 'account_id', 'date_range'],
          evidence: 'INDEPENDENT_DESIGN',
        },
      ];
    if (['get_reporting_run', 'get_reporting_run_status'].includes(operation))
      return this.store.job(tenant, args.run_id);
    if (
      ['get_reporting_bootstrap', 'get_reporting_workbook_bootstrap', 'get_reporting_storage_overview'].includes(
        operation,
      )
    )
      return {
        workspace_id: tenant,
        workbooks: this.store
          .documents(tenant, 'workbook')
          .filter(w => !args.spreadsheet_id || w.spreadsheet_id === args.spreadsheet_id),
        queries: this.store.documents(tenant, 'reporting_query'),
        schedules: this.store
          .documents(tenant, 'reporting_schedule')
          .map(({actor_binding, ...publicSchedule}) => publicSchedule),
        destination: 'local',
        google_sheets_connected: false,
        external_writes: false,
      };
    if (actor.role === 'reader' && args.dry_run === false)
      throw new MirrorError('FORBIDDEN', 'Reader role cannot change reporting configuration or enqueue jobs.', {}, 403);
    if (operation === 'execute_reporting_run') {
      const job = this.store.job(tenant, args.run_id);
      if (job.kind !== 'report') throw new MirrorError('INVALID_REPORT_RUN', 'The job is not a reporting run.');
      if (args.dry_run !== false) return {dry_run: true, executed: false, run_id: args.run_id, input: job.input};
      this.store.resumeReport(actor, args.run_id);
      return {run_id: args.run_id, state: this.store.job(tenant, args.run_id).state};
    }
    const kind = operation.includes('schedule')
      ? 'reporting_schedule'
      : operation.includes('query')
        ? 'reporting_query'
        : 'workbook';
    const oldId = args.query_id ?? args.schedule_id ?? args.workbook_binding_id;
    let previous: JsonObject | undefined;
    if (operation.startsWith('update_') || operation === 'save_workbook_preferences')
      previous = this.store.document(tenant, kind, String(oldId));
    if (args.workbook_binding_id && kind !== 'workbook')
      this.store.document(tenant, 'workbook', args.workbook_binding_id);
    if (operation === 'bind_reporting_workbook')
      previous = this.store.documents(tenant, 'workbook').find(w => w.spreadsheet_id === args.spreadsheet_id);
    const id = previous?.id ?? randomUUID(),
      {dry_run, ...changes} = args;
    const value: JsonObject = {...previous, ...changes, updated_at: new Date().toISOString()};
    delete value.id;
    delete value.revision;
    if (kind === 'reporting_schedule') {
      if (value.destination_id)
        throw new MirrorError(
          'DESTINATION_UNAVAILABLE',
          'This worker currently stores report outputs locally; external destinations require a separately configured adapter.',
        );
      const queryId = value.schedule_config?.query_id;
      if (typeof queryId !== 'string')
        throw new MirrorError('REPORT_QUERY_REQUIRED', 'schedule_config.query_id must identify a saved query.');
      const query = this.store.document(tenant, 'reporting_query', queryId);
      if (query.workbook_binding_id !== value.workbook_binding_id)
        throw new MirrorError('REPORT_BINDING_MISMATCH', 'Query and schedule must use the same workbook binding.');
      value.is_active ??= true;
      value.next_run_at = nextSchedule(value);
    }
    if (args.dry_run !== false) {
      const {actor_binding, ...payload} = value;
      return {dry_run: true, executed: false, kind, id, payload, destination: 'local'};
    }
    return this.store.transaction(() => {
      this.store.ensureTenant(tenant);
      if (kind === 'reporting_schedule') {
        value.actor_binding = this.store.bindJobActor(actor, 'reporting-schedule:' + id);
        value.authority_version = 1;
        value.error = null;
      }
      const result = this.store.putDocument(tenant, kind, id, value, previous?.revision);
      this.store.appendAudit(tenant, 'reporting/' + id, {
        event: operation,
        id,
        revision: result.revision,
        actor: actor.userId,
      });
      return {
        ...result,
        ...(kind === 'workbook'
          ? {workbook_binding_id: id}
          : kind === 'reporting_query'
            ? {query_id: id, prepared_run_id: this.prepareRun(actor, id)}
            : {schedule_id: id}),
        destination: 'local',
        external_writes: false,
      };
    });
  }
}

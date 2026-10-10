import {randomUUID} from 'node:crypto';
import type {Actor, JsonObject} from './types.js';
import {Store} from './store.js';
import {MirrorError} from './errors.js';
import {reportRunStatus} from './report-runs.js';
import {
  reportingBootstrap,
  reportingQueryScope,
  reportingQueryRecord,
  reportQueryRecordLimit,
  reportingWorkbookAccess,
  validateReportingConfig,
  redactReportingRecord,
  assertReportingConfigCredentials,
} from './report-query-access.js';
import {bad, fingerprint, noSecrets} from './workspace-core.js';
import {redact} from './security.js';
import {reportRange} from './report-native.js';
import {reportingBindingMove, moveWorkbookSchedules} from './report-query-rebinding.js';
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
/**
 * Rolling windows resolve at one frozen instant. `source_timezone:"report"` (the default) resolves every source in
 * the window's IANA timezone. `source_timezone:"account"` (owner policy P6) additionally records the rule, so each
 * source resolves the same instant in its own reporting time zone when it is collected.
 */
export function resolveReportConfig(config: JsonObject, now = Date.now()): JsonObject {
  const result = structuredClone(config),
    range = result.date_range;
  if (range?.source_timezone !== undefined && (!range.preset || !['report', 'account'].includes(range.source_timezone)))
    throw new MirrorError(
      'INVALID_ROLLING_WINDOW',
      'Resolve a rolling window in the report timezone ("report") or in each source account timezone ("account").',
    );
  if (!range?.preset) return result;
  result.date_range = resolveRollingWindow(range, now);
  if (range.source_timezone === 'account')
    result.date_range_rule = {
      preset: range.preset,
      ...(range.days === undefined ? {} : {days: range.days}),
      ...(range.offset_days === undefined ? {} : {offset_days: range.offset_days}),
      timezone: range.timezone,
      source_timezone: 'account',
      resolved_at: now,
    };
  return result;
}
/** The inclusive dates of a rolling window at `now`, as seen in `timezone`. */
export function resolveRollingWindow(
  range: JsonObject,
  now: number,
  timezone: string = range.timezone,
): {since: string; until: string} {
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
      timeZone: timezone,
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
  return {
    since: new Date(since).toISOString().slice(0, 10),
    until: new Date(until).toISOString().slice(0, 10),
  };
}
export class ReportingService {
  constructor(readonly store: Store) {}
  prepareRun(actor: Actor, queryId: string): string {
    const query = this.store.document(actor.tenantId, 'reporting_query', queryId);
    assertReportingConfigCredentials(query.query_config);
    return this.store.enqueueReport(
      actor,
      {query_id: queryId, query_revision: query.revision, query_name: query.name, query_config: query.query_config},
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
    if (operation === 'get_reporting_run_status') return reportRunStatus(this.store, actor, args.run_id);
    if (operation === 'get_reporting_run') {
      reportRunStatus(this.store, actor, args.run_id);
      return redactReportingRecord(this.store.job(tenant, args.run_id));
    }
    if (
      ['get_reporting_bootstrap', 'get_reporting_workbook_bootstrap', 'get_reporting_storage_overview'].includes(
        operation,
      )
    )
      return reportingBootstrap(this.store, actor, args);
    if (actor.role === 'reader' && args.dry_run === false)
      throw new MirrorError('FORBIDDEN', 'Reader role cannot change reporting configuration or enqueue jobs.', {}, 403);
    if (operation === 'execute_reporting_run') {
      reportRunStatus(this.store, actor, args.run_id);
      const job = this.store.job(tenant, args.run_id);
      if (job.kind !== 'report') throw new MirrorError('INVALID_REPORT_RUN', 'The job is not a reporting run.');
      if (args.dry_run !== false)
        return redactReportingRecord({dry_run: true, executed: false, run_id: args.run_id, input: job.input});
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
    if (operation.startsWith('update_') || operation === 'save_workbook_preferences') {
      if (kind === 'reporting_query') previous = reportingQueryRecord(this.store, actor, oldId);
      else if (kind === 'workbook') previous = reportingWorkbookAccess(this.store, actor, String(oldId));
      else {
        const p = this.store.db
          .prepare(
            "SELECT length(CAST(data AS BLOB)) AS bytes,json_extract(data,'$.schedule_config.query_id') AS query_id FROM documents WHERE tenant_id=? AND kind='reporting_schedule' AND id=?",
          )
          .get(tenant, String(oldId)) as JsonObject | undefined;
        if (!p) throw new MirrorError('NOT_FOUND', 'Reporting schedule not found.', {}, 404);
        reportingQueryScope(this.store, actor, p.query_id);
        if (p.bytes > 65536)
          bad('This legacy schedule exceeds the 64 KiB settings limit.', 'REPORT_SCHEDULE_TOO_LARGE');
        previous = this.store.document(tenant, kind, String(oldId));
      }
    }
    if (args.workbook_binding_id && kind !== 'workbook')
      reportingWorkbookAccess(this.store, actor, args.workbook_binding_id);
    if (operation === 'bind_reporting_workbook') {
      const existing = this.store.db
        .prepare(
          "SELECT id FROM documents WHERE tenant_id=? AND kind='workbook' AND json_extract(data,'$.spreadsheet_id')=? ORDER BY id LIMIT 1",
        )
        .get(tenant, args.spreadsheet_id) as JsonObject | undefined;
      if (existing) previous = reportingWorkbookAccess(this.store, actor, existing.id);
    }
    const id = previous?.id ?? randomUUID(),
      {dry_run, ...changes} = args;
    noSecrets(changes);
    if (fingerprint(changes) !== fingerprint(redact(changes)))
      bad('Store credentials in Connections, not reporting settings.');
    const value: JsonObject = {...previous, ...changes, updated_at: new Date().toISOString()};
    const bound = () => {
      if (
        Buffer.byteLength(JSON.stringify(value)) + 512 >
        (kind === 'reporting_query' ? reportQueryRecordLimit : 65536)
      )
        bad('Reporting settings exceed the bounded record limit.', 'REPORT_SETTINGS_TOO_LARGE');
    };
    if (!previous) value.created_by = actor.ownerUserId ?? actor.userId;
    delete value.id;
    delete value.revision;
    if (kind === 'reporting_query') {
      validateReportingConfig(this.store, actor, value.query_config);
      const resolved = resolveReportConfig(value.query_config);
      if (!value.query_config.gateway && resolved.date_range) reportRange(resolved.date_range);
      reportingWorkbookAccess(this.store, actor, value.workbook_binding_id);
      if (previous?.workbook_binding_id !== value.workbook_binding_id) {
        const count = this.store.db
          .prepare(
            "SELECT count(*) AS n FROM documents WHERE tenant_id=? AND kind='reporting_query' AND json_extract(data,'$.workbook_binding_id')=?",
          )
          .get(tenant, value.workbook_binding_id) as JsonObject;
        if (count.n >= 500)
          bad('A workbook binding supports at most 500 attached queries.', 'REPORT_BINDING_QUERY_LIMIT');
      }
    }
    if (kind === 'reporting_schedule') {
      if (value.destination_id)
        throw new MirrorError(
          'DESTINATION_UNAVAILABLE',
          'This worker currently stores report outputs locally; external destinations require a separately configured adapter.',
        );
      const queryId = value.schedule_config?.query_id;
      if (typeof queryId !== 'string')
        throw new MirrorError('REPORT_QUERY_REQUIRED', 'schedule_config.query_id must identify a saved query.');
      const query = reportingQueryRecord(this.store, actor, queryId);
      if (query.workbook_binding_id !== value.workbook_binding_id)
        throw new MirrorError('REPORT_BINDING_MISMATCH', 'Query and schedule must use the same workbook binding.');
      value.is_active ??= true;
      Object.assign(value, scheduleClockFields(value));
    }
    bound();
    const bindingMove =
      kind === 'reporting_query' && previous && previous.workbook_binding_id !== value.workbook_binding_id
        ? reportingBindingMove(this.store, actor, id, value.workbook_binding_id)
        : undefined;
    if (args.dry_run !== false) {
      const {actor_binding, ...payload} = value;
      return {
        dry_run: true,
        executed: false,
        kind,
        id,
        payload: redactReportingRecord(payload),
        destination: 'local',
        ...(bindingMove
          ? {schedules_to_rebind: bindingMove.schedules_to_rebind, schedules_to_pause: bindingMove.schedules_to_pause}
          : {}),
      };
    }
    return this.store.transaction(() => {
      this.store.ensureTenant(tenant);
      if (
        bindingMove &&
        reportingBindingMove(this.store, actor, id, value.workbook_binding_id).rebinding_version !==
          bindingMove.rebinding_version
      )
        bad('The query, associations or schedules changed. Review the move again.', 'STALE_REPORT_REBINDING');
      if (kind === 'reporting_schedule') {
        value.actor_binding = this.store.bindJobActor(actor, 'reporting-schedule:' + id);
        value.authority_version = 1;
        value.error = null;
      }
      bound();
      const result = this.store.putDocument(tenant, kind, id, value, previous?.revision);
      if (bindingMove) moveWorkbookSchedules(this.store, actor, bindingMove);
      const schedules_paused = bindingMove
        ? bindingMove.schedules_to_pause
        : kind === 'reporting_query' &&
            previous &&
            fingerprint(previous.query_config) !== fingerprint(value.query_config)
          ? Number(
              this.store.db
                .prepare(
                  "UPDATE documents SET data=json_set(data,'$.is_active',json('false'),'$.error',NULL,'$.pause_reason','query_definition_changed','$.updated_at',?),revision=revision+1 WHERE tenant_id=? AND kind='reporting_schedule' AND json_extract(data,'$.schedule_config.query_id')=? AND json_extract(data,'$.is_active')=1",
                )
                .run(new Date().toISOString(), tenant, id).changes,
            )
          : 0;
      this.store.appendAudit(tenant, 'reporting/' + id, {
        event: operation,
        id,
        revision: result.revision,
        actor: actor.userId,
        ...(bindingMove
          ? {
              from_binding_id: bindingMove.source.id,
              to_binding_id: bindingMove.target.id,
              schedules_rebound: bindingMove.schedules_to_rebind,
              schedules_paused,
            }
          : {}),
      });
      const {actor_binding, ...publicResult} = result as JsonObject;
      return {
        ...redactReportingRecord(publicResult),
        ...(kind === 'workbook'
          ? {workbook_binding_id: id}
          : kind === 'reporting_query'
            ? {
                query_id: id,
                prepared_run_id: this.prepareRun(actor, id),
                schedules_paused,
                ...(bindingMove ? {schedules_rebound: bindingMove.schedules_to_rebind} : {}),
              }
            : {schedule_id: id}),
        destination: 'local',
        external_writes: false,
      };
    });
  }
}

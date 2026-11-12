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
import {redactCredentialShapes} from './security.js';
import {reportRange} from './report-periods.js';
import {fixedReportTimezones} from './report-windows.js';
import {reportingBindingMove, moveWorkbookSchedules} from './report-query-rebinding.js';
import {bindingQueryCount, pauseQuerySchedules, scheduleSize, workbookOfSpreadsheet} from './workbook-repository.js';
// The schedule clock lives in its own module so that the reviewed-write path (store -> scheduled-work) does not load
// the reporting service; it is re-exported here for existing importers.
export {nextSchedule, nextScheduleDetail, scheduleClockFields, scheduleDstPolicy} from './schedule-clock.js';
import {scheduleClockFields} from './schedule-clock.js';
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
 * Rolling windows resolve at one frozen instant. By default every source resolves in the window's IANA timezone,
 * except a source whose platform fixes its report day (`fixedReportTimezones`), which resolves in that zone: a window
 * that ended in the report zone can still be in progress there. `source_timezone:"report"` resolves every source in
 * the window's timezone. `source_timezone:"account"` (owner policy P6) resolves every source in its own reporting
 * time zone. A policy that varies by source records the rule, so each source resolves the same instant in its own zone
 * when it is collected.
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
  const policy =
    range.source_timezone ??
    (Array.isArray(result.sources) &&
    result.sources.some((source: JsonObject) => Object.hasOwn(fixedReportTimezones, source?.platform))
      ? 'provider_fixed'
      : 'report');
  if (policy !== 'report')
    result.date_range_rule = {
      preset: range.preset,
      ...(range.days === undefined ? {} : {days: range.days}),
      ...(range.offset_days === undefined ? {} : {offset_days: range.offset_days}),
      timezone: range.timezone,
      source_timezone: policy,
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
        const p = scheduleSize(this.store, tenant, String(oldId));
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
      const existing = workbookOfSpreadsheet(this.store, tenant, args.spreadsheet_id);
      if (existing) previous = reportingWorkbookAccess(this.store, actor, existing.id);
    }
    const id = previous?.id ?? randomUUID(),
      {dry_run, ...changes} = args;
    // EXP-04: a schedule's move to Reporting overview (its move record and the pause reason it set) is AMCP's own
    // state; a legacy settings update never writes it, so it cannot mark a moved schedule as not moved.
    if (kind === 'reporting_schedule') {
      delete changes.overview_migration;
      delete changes.pause_reason;
    }
    noSecrets(changes);
    // Only credential-shaped content is refused (Ruling 10); redact() also hides prose, and is what is shown.
    if (fingerprint(changes) !== fingerprint(redactCredentialShapes(changes)))
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
        if (bindingQueryCount(this.store, tenant, value.workbook_binding_id) >= 500)
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
      // EXP-04: a schedule moved to Reporting overview stays paused here until the move is undone, so the local and the
      // Overview schedule never run together (saveWorkbookSchedule refuses the same on the website).
      if (previous?.overview_migration?.state === 'migrated' && value.is_active !== false)
        throw new MirrorError(
          'WORKBOOK_SCHEDULE_MIGRATED',
          'This schedule moved to Reporting overview. Undo the move before enabling it here again.',
          {},
          409,
        );
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
          ? pauseQuerySchedules(this.store, tenant, id, new Date().toISOString())
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

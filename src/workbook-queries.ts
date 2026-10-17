import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {bad, fingerprint, validate, writer} from './workspace-core.js';
import {
  reportingQueryScope,
  validateReportingConfig,
  reportingWorkbookAccess,
  reportQueryRecordLimit,
  redactReportingConfig,
} from './report-query-access.js';
import {ReportingService, resolveReportConfig} from './reporting.js';
import {reportRange} from './report-periods.js';
import {reportingBindingMove} from './report-query-rebinding.js';
import {activeQueryScheduleCount, querySchedules} from './workbook-repository.js';

export function workbookQuery(store: Store, actor: Actor, id: unknown) {
  const p = reportingQueryScope(store, actor, id);
  if (p.bytes > reportQueryRecordLimit)
    bad('This legacy query exceeds the 72 KiB record limit.', 'REPORT_QUERY_TOO_LARGE');
  const query = store.document(actor.tenantId, 'reporting_query', p.id);
  if (Buffer.byteLength(JSON.stringify(query.query_config)) > 65536)
    bad('This legacy query exceeds the 64 KiB editor limit.', 'REPORT_QUERY_TOO_LARGE');
  const schedules = querySchedules(store, actor.tenantId, p.id);
  const version = fingerprint({id: p.id, revision: p.revision, scope: p.scope, schedules});
  return {
    id: p.id,
    record_kind: 'workbook_query',
    name: query.name,
    revision: p.revision,
    ...p.scope,
    workbook_binding_id: query.workbook_binding_id,
    query_config: redactReportingConfig(query.query_config),
    query_version: version,
    configuration_redacted: fingerprint(query.query_config) !== fingerprint(redactReportingConfig(query.query_config)),
    schedules: schedules.slice(0, 100).map(s => ({
      id: s.id,
      active: !!s.active,
      website_path: '/operations?workbook_schedule_id=' + encodeURIComponent(s.id),
    })),
    schedules_truncated: schedules.length > 100,
    can_edit: actor.role !== 'reader',
    network_requests: 0,
    website_path: '/operations?query_id=' + encodeURIComponent(p.id),
    next_call: {tool: 'amcp_workspace', arguments: {action: 'report_query', id: p.id}},
  };
}
export function previewWorkbookQuery(store: Store, actor: Actor, input: JsonObject) {
  const current = workbookQuery(store, actor, input.id);
  if (current.query_version !== input.query_version)
    bad('The query or its schedules changed. Refresh before editing.', 'STALE_REPORT_QUERY');
  if (current.schedules_truncated)
    bad('This editor supports up to 100 schedules per saved query.', 'REPORT_QUERY_SCHEDULE_LIMIT');
  reportingWorkbookAccess(store, actor, current.workbook_binding_id);
  validate(input.query, ['name', 'query_config'], 66560, 'query setting');
  if (typeof input.query.name !== 'string' || !input.query.name.trim() || input.query.name.length > 120)
    bad('Name the saved query in 1–120 characters.');
  const scope = validateReportingConfig(store, actor, input.query.query_config);
  const resolved = resolveReportConfig(input.query.query_config);
  if (!input.query.query_config.gateway && resolved.date_range) reportRange(resolved.date_range);
  if (
    scope.gateway !== current.gateway ||
    scope.account_id !== current.account_id ||
    scope.connection_id !== current.connection_id
  )
    bad('Create a separate query to change its account, provider or connection.', 'REPORT_QUERY_SCOPE_CHANGED');
  const definitionChanged =
    fingerprint(input.query.query_config) !==
    fingerprint(store.document(actor.tenantId, 'reporting_query', current.id).query_config);
  return {
    id: current.id,
    record_kind: 'workbook_query_preview',
    query_version: current.query_version,
    query: input.query,
    changes: ['name', 'query_config'].filter(
      k => fingerprint(current[k as keyof typeof current]) !== fingerprint(input.query[k]),
    ),
    schedules_to_pause: definitionChanged ? activeQueryScheduleCount(store, actor.tenantId, current.id) : 0,
    meaning:
      'Save a local query revision and one prepared, unsubmitted report run. Definition changes pause its active schedules for separate review/resume. Existing queued and completed runs retain their original configuration.',
    network_requests: 0,
  };
}
export function saveWorkbookQuery(store: Store, actor: Actor, input: JsonObject) {
  writer(store, actor);
  if (input.confirmed !== true) bad('Confirm the revised query and affected schedules.', 'CONFIRMATION_REQUIRED');
  return store.transaction(() => {
    const preview = previewWorkbookQuery(store, actor, input);
    const result = new ReportingService(store).handle(
      'update_reporting_query',
      {query_id: input.id, ...preview.query, dry_run: false},
      actor,
    ) as JsonObject;
    return {
      ...workbookQuery(store, actor, input.id),
      prepared_run_id: result.prepared_run_id,
      schedules_paused: result.schedules_paused,
    };
  });
}

export function previewWorkbookQueryMove(store: Store, actor: Actor, input: JsonObject) {
  const query = workbookQuery(store, actor, input.id);
  if (query.query_version !== input.query_version)
    bad('The query or its schedules changed. Refresh before moving it.', 'STALE_REPORT_QUERY');
  const move = reportingBindingMove(store, actor, query.id, input.target_binding_id);
  return {
    ...move,
    record_kind: 'workbook_query_move_preview',
    query_version: query.query_version,
    query_name: query.name,
    gateway: query.gateway,
    account_id: query.account_id,
    connection_id: query.connection_id,
    existing_runs_unchanged: true,
    external_access_verified: false,
    network_requests: 0,
    external_writes: false,
    meaning:
      'Move this local saved query and all its schedules to the selected existing workbook association. Every linked schedule becomes paused for separate review/resume. Preserve query configuration, clock settings, actor bindings and existing runs. Prepare one unsubmitted local report. No external spreadsheet is accessed or changed.',
  };
}

export function moveWorkbookQuery(store: Store, actor: Actor, input: JsonObject) {
  writer(store, actor);
  if (input.confirmed !== true) bad('Confirm the workbook move and schedule pause.', 'CONFIRMATION_REQUIRED');
  return store.transaction(() => {
    const preview = previewWorkbookQueryMove(store, actor, input);
    if (input.rebinding_version !== preview.rebinding_version)
      bad('The query, associations or schedules changed. Review the move again.', 'STALE_REPORT_REBINDING');
    const result = new ReportingService(store).handle(
      'update_reporting_query',
      {
        query_id: preview.id,
        workbook_binding_id: preview.target.id,
        dry_run: false,
      },
      actor,
    ) as JsonObject;
    return {
      ...workbookQuery(store, actor, preview.id),
      prepared_run_id: result.prepared_run_id,
      schedules_rebound: result.schedules_rebound,
      schedules_paused: result.schedules_paused,
      external_access_verified: false,
      external_writes: false,
    };
  });
}

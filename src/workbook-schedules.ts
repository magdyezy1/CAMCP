import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {fingerprint, validate, writer} from './workspace-core.js';
import {nextScheduleDetail} from './reporting.js';
import {reportRunScope, reportRunStatus, reportScopeFieldsSQL} from './report-runs.js';

const text = (key: string, limit = 160) => `CASE WHEN json_type(d.data,'$.${key}')='text'
  AND length(json_extract(d.data,'$.${key}'))<=${limit} THEN json_extract(d.data,'$.${key}') END`;
const integer = (key: string) =>
  `CASE WHEN json_type(d.data,'$.${key}')='integer' THEN json_extract(d.data,'$.${key}') END`;
const timestamp = (key: string) => `coalesce(CASE WHEN json_type(d.data,'$.${key}')='integer'
  THEN json_extract(d.data,'$.${key}')
  ELSE cast(unixepoch(json_extract(d.data,'$.${key}'),'subsec')*1000 AS integer) END,0)`;
export const workbookScheduleFeedSQL = `SELECT d.id,'workbook_schedule' AS kind,d.revision,
  max(${timestamp('updated_at')},${timestamp('last_run_at')}) AS at,
  json_object('name',coalesce(${text('name', 200)},d.id),
    'state',CASE WHEN json_extract(d.data,'$.error.code') IS NOT NULL THEN 'failed'
      WHEN json_extract(d.data,'$.is_active')=1 AND json_extract(d.data,'$.schedule_warning.code') IS NOT NULL THEN 'attention'
      WHEN json_extract(d.data,'$.is_active')=1 THEN 'active' ELSE 'paused' END,
    'active',CASE WHEN json_extract(d.data,'$.is_active')=1 THEN 1 ELSE 0 END,
    'timezone',${text('timezone', 80)},'schedule_kind',${text('schedule_kind', 20)},
    'minute',${integer('schedule_config.minute')},'hour',${integer('schedule_config.hour')},
    'weekday',${integer('schedule_config.weekday')},'day',${integer('schedule_config.day')},
    'query_id',${text('schedule_config.query_id')},'query_revision',q.revision,
    'next_run_at',${integer('next_run_at')},'last_run_id',${text('last_run_id')},
    'error_code',substr(coalesce(json_extract(d.data,'$.error.code'),json_extract(d.data,'$.schedule_warning.code')),1,101),
    ${reportScopeFieldsSQL('q.data')}
  ) AS metadata
  FROM documents d LEFT JOIN documents q ON q.tenant_id=d.tenant_id AND q.kind='reporting_query'
    AND q.id=json_extract(d.data,'$.schedule_config.query_id')
  WHERE d.tenant_id=? AND d.kind='reporting_schedule'`;

/** A schedule's move to Reporting overview (EXP-04 D phase 2), without private fields; null when never moved. */
export const workbookMigrationProjection = (m: JsonObject | null | undefined) =>
  m && typeof m === 'object'
    ? {
        state: m.state === 'reverted' ? 'reverted' : 'migrated',
        overview_schedule_id: m.overview_schedule_id ?? null,
        overview_view_id: m.overview_view_id ?? null,
        destination_id: m.destination_id ?? null,
        migrated_at: m.migrated_at ?? null,
        reverted_at: m.reverted_at ?? null,
      }
    : null;
function migrationOf(store: Store, tenant: string, id: string) {
  const row = store.db
    .prepare(
      "SELECT json_extract(data,'$.overview_migration') AS m FROM documents WHERE tenant_id=? AND kind='reporting_schedule' AND id=?",
    )
    .get(tenant, id) as JsonObject | undefined;
  return workbookMigrationProjection(typeof row?.m === 'string' ? JSON.parse(row.m) : null);
}

/** The next three clock times; dst_shifted marks one moved forward out of a daylight-saving gap (EXP-02). */
function clockOccurrences(timezone: string, kind: string, calendar: JsonObject) {
  const occurrences: number[] = [],
    shifted: boolean[] = [];
  let at = Date.now();
  for (let i = 0; i < 3; i++) {
    const next = nextScheduleDetail(
      {timezone, schedule_kind: kind, schedule_config: calendar, ...(i ? {next_run_at: at} : {})},
      at,
    );
    at = next.at;
    occurrences.push(at);
    shifted.push(next.dst_shifted);
  }
  return {occurrences, dst_shifted: shifted};
}

export function workbookSchedule(store: Store, actor: Actor, id: unknown): JsonObject {
  store.assertActorActive(actor);
  if (typeof id !== 'string' || !id || id.length > 160)
    throw new MirrorError('INVALID_SCHEDULE', 'Choose an exact workbook schedule ID.');
  const row = store.db.prepare(workbookScheduleFeedSQL + ' AND d.id=?').get(actor.tenantId, id) as
    JsonObject | undefined;
  if (!row) throw new MirrorError('NOT_FOUND', 'Workbook schedule not found in this tenant.', {}, 404);
  const p = JSON.parse(row.metadata),
    scope = reportRunScope(store, actor, p);
  const calendar: JsonObject = {
    minute: p.minute ?? 0,
    hour: p.hour ?? 0,
    ...(p.weekday !== null ? {weekday: p.weekday} : {}),
    ...(p.day !== null ? {day: p.day} : {}),
  };
  let occurrences: number[] = [],
    dstShifted: boolean[] = [],
    previewError: string | null = null;
  try {
    if (typeof p.timezone !== 'string' || !p.timezone)
      throw new MirrorError('INVALID_TIMEZONE', 'An explicit IANA timezone is required.');
    ({occurrences, dst_shifted: dstShifted} = clockOccurrences(p.timezone, p.schedule_kind, calendar));
  } catch (e) {
    if (!(e instanceof MirrorError)) throw e;
    previewError = e.code;
  }
  let lastRun: JsonObject | null = null;
  if (p.last_run_id)
    try {
      const run = reportRunStatus(store, actor, p.last_run_id);
      lastRun = {id: run.id, state: run.state, website_path: run.website_path};
    } catch (e) {
      if (!(e instanceof MirrorError)) throw e;
    }
  const result: JsonObject = {
    id,
    record_kind: 'workbook_schedule',
    revision: row.revision,
    name: p.name,
    state: p.state,
    active: p.active === 1,
    ...scope,
    query_id: p.query_id,
    query_revision: p.query_revision,
    timezone: p.timezone,
    schedule_kind: p.schedule_kind,
    schedule: calendar,
    next_run_at: p.active === 1 ? p.next_run_at : null,
    updated_at: row.at,
    occurrences,
    dst_shifted: dstShifted,
    preview_error: previewError,
    last_run: lastRun,
    // EXP-04 D phase 2: a schedule moved to Reporting overview stays paused here until the move is undone.
    overview_migration: migrationOf(store, actor.tenantId, id),
    can_edit: actor.role !== 'reader',
    schedule_version: fingerprint({id, revision: row.revision, metadata: p, scope}),
    destination: 'local',
    external_writes: false,
    network_requests: 0,
    automatic_retry_of_mutation: false,
    website_path: '/operations?workbook_schedule_id=' + encodeURIComponent(id),
    meaning:
      'The next three times preview the schedule clock. Pausing stops future runs from being queued; existing runs keep their state and saved query. Resuming uses your current account access at the next future occurrence. The saved query controls report dates separately from this clock timezone. Rolling dates resolve when collection starts. Results stay in this workspace.',
  };
  if (typeof p.error_code === 'string' && /^[A-Z0-9_]{1,100}$/.test(p.error_code)) result.error_code = p.error_code;
  store.assertActorActive(actor);
  return result;
}

export function previewWorkbookSchedule(store: Store, actor: Actor, input: JsonObject): JsonObject {
  const current = workbookSchedule(store, actor, input.id);
  if (input.schedule_version !== current.schedule_version)
    throw new MirrorError(
      'STALE_REPORT_SCHEDULE',
      'The schedule or its query changed. Refresh and inspect its current revision before saving.',
      {},
      409,
    );
  const value = input.schedule;
  validate(value, ['name', 'timezone', 'schedule_kind', 'minute', 'hour', 'weekday', 'day'], 4096, 'schedule setting');
  if (
    typeof input.active !== 'boolean' ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.trim().length > 100 ||
    typeof value.timezone !== 'string' ||
    !value.timezone ||
    value.timezone.length > 80
  )
    throw new MirrorError(
      'INVALID_SCHEDULE',
      'Choose a name up to 100 characters, an explicit IANA timezone and an active or paused state.',
    );
  const schedule = {
    name: value.name.trim(),
    timezone: value.timezone,
    schedule_kind: value.schedule_kind,
    minute: value.minute ?? 0,
    hour: value.schedule_kind === 'hourly' ? 0 : (value.hour ?? 0),
    ...(value.schedule_kind === 'weekly' ? {weekday: value.weekday} : {}),
    ...(value.schedule_kind === 'monthly' ? {day: value.day ?? 1} : {}),
  };
  const {occurrences, dst_shifted} = clockOccurrences(schedule.timezone, schedule.schedule_kind, schedule);
  const before: JsonObject = {
    ...current.schedule,
    name: current.name,
    timezone: current.timezone,
    schedule_kind: current.schedule_kind,
    active: current.active,
  };
  const after: JsonObject = {...schedule, active: input.active};
  const changes = ['name', 'timezone', 'schedule_kind', 'minute', 'hour', 'weekday', 'day', 'active']
    .filter(field => (before[field] ?? null) !== (after[field] ?? null))
    .map(field => ({field, from: before[field] ?? null, to: after[field] ?? null}));
  store.assertActorActive(actor);
  return {
    id: current.id,
    schedule_version: current.schedule_version,
    revision: current.revision,
    query_id: current.query_id,
    query_revision: current.query_revision,
    gateway: current.gateway,
    account_id: current.account_id,
    connection_id: current.connection_id,
    active: input.active,
    schedule,
    occurrences,
    dst_shifted,
    changes,
    queued_runs_unchanged: true,
    destination: 'local',
    external_writes: false,
    network_requests: 0,
    meaning:
      'Preview only. Saving rechecks this schedule and query revision, then calculates the next future occurrence. Existing queued runs keep their state.',
  };
}

export function saveWorkbookSchedule(store: Store, actor: Actor, input: JsonObject) {
  return store.transaction(() => {
    writer(store, actor);
    const current = previewWorkbookSchedule(store, actor, input);
    if (input.confirmed !== true)
      throw new MirrorError(
        'CONFIRMATION_REQUIRED',
        'Confirm the clock settings and whether future reporting runs should be active.',
      );
    if (input.active && migrationOf(store, actor.tenantId, current.id)?.state === 'migrated')
      throw new MirrorError(
        'WORKBOOK_SCHEDULE_MIGRATED',
        'This schedule moved to Reporting overview. Undo the move before enabling it here again.',
        {},
        409,
      );
    const value = current.schedule;
    const config: JsonObject = {
      query_id: current.query_id,
      minute: value.minute ?? 0,
      hour: value.hour ?? 0,
      ...(value.schedule_kind === 'weekly' ? {weekday: value.weekday} : {}),
      ...(value.schedule_kind === 'monthly' ? {day: value.day ?? 1} : {}),
    };
    const next = current.occurrences[0];
    const old = store.document(actor.tenantId, 'reporting_schedule', current.id);
    const {id, revision, ...data} = old;
    const updated = {
      ...data,
      name: value.name.trim(),
      timezone: value.timezone,
      schedule_kind: value.schedule_kind,
      schedule_config: config,
      is_active: input.active,
      next_run_at: next,
      // A confirmed clock clears any earlier unresolved-clock warning (EXP-02).
      next_run_dst_shifted: current.dst_shifted[0] ?? false,
      next_run_reevaluate: false,
      schedule_warning: null,
      error: null,
      updated_at: new Date().toISOString(),
      ...(input.active
        ? {actor_binding: store.bindJobActor(actor, 'reporting-schedule:' + id), authority_version: 1}
        : {}),
    };
    store.putDocument(actor.tenantId, 'reporting_schedule', id, updated, revision);
    store.appendAudit(actor.tenantId, 'reporting/' + id, {
      event: 'workbook_schedule_saved',
      actor: actor.userId,
      revision: revision + 1,
      query_revision: current.query_revision,
      active: input.active,
    });
    return workbookSchedule(store, actor, id);
  });
}

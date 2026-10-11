import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {fingerprint, optional, writer} from './workspace-core.js';
import {workbookSchedule} from './workbook-schedules.js';
import {reportingQueryRecord, reportingWorkbookAccess} from './report-query-access.js';
import {reportDestination} from './report-file-delivery.js';
import {reportPlatforms} from './report-metrics.js';
import {scheduleClockFields} from './schedule-clock.js';
import {sha256} from './security.js';
import type {ReportLibrary} from './report-library.js';

/**
 * EXP-04 D phase 2: an explicit, reversible move of a local workbook schedule into Reporting overview (owner policy
 * P6, "converge workbook schedules into Overview destinations"). A workbook schedule keeps its results in AMCP; its
 * spreadsheet ID was never verified or written. The move converts the schedule's saved campaign query into an Overview
 * report with one source and the same clock, delivering to a Google Sheets report tab that Reporting overview already
 * bound for the workbook's own spreadsheet (bind_destination's authenticated read is the verification). It pauses the
 * local schedule in the same transaction, so the two never run together, and changes neither the saved query (its
 * revision stays) nor the local schedule's clock. Undo pauses the Overview schedule and restores the local schedule's
 * earlier state. No step makes a network request; the Overview schedule's later runs deliver as any Overview schedule.
 */
type Validate = (config: JsonObject, actor: Actor) => JsonObject;

/** The legacy campaign-report fields that have an exact Overview equivalent (compileReport's arguments). */
const convertible = new Set([
  'platform',
  'account_id',
  'connection_id',
  'date_range',
  'level',
  'granularity',
  'metrics',
]);
/** compileReport's granularity (day by default) and the Overview grain that returns the same rows. */
const grains: Record<string, string> = {day: 'daily', month: 'monthly', all: 'total'};
/** Why a schedule cannot move as it is; the website words each code (English and Arabic). */
const reasons: Record<string, string> = {
  native_request:
    'This saved query is a native provider request. Reporting overview collects campaign reports; recreate it there.',
  unsupported_fields: 'Reporting overview has no equivalent for these query settings.',
  entity_level:
    'Only campaign-level queries move automatically. Recreate ad set or ad detail in Reporting overview with its detail options.',
  granularity: 'Reporting overview groups by total, day, week or month; this query uses another grouping.',
  fixed_dates:
    'Scheduled Overview reports need a rolling window. This query uses fixed dates, so every run repeats the same days.',
  metrics: 'Use at most 30 native metric names, without query expressions.',
  report_settings: 'Reporting overview refused the converted report settings.',
  destination_required:
    'Choose a Google Sheets report tab bound to this workbook’s spreadsheet. Bind one in Reporting overview first.',
  destination_in_use: 'This report tab has another active schedule. Choose a separate report tab.',
  already_migrated: 'This schedule already moved to Reporting overview.',
};
const blocker = (code: string, extra: JsonObject = {}) => ({code, message: reasons[code]!, ...extra});

/** The converted Overview report, or the reasons the saved query has no exact Overview equivalent. */
export function overviewConfigFromWorkbook(
  query: JsonObject,
  name: string,
  scope: {account_id: string; connection_id: string},
): {config: JsonObject | null; blockers: JsonObject[]} {
  const q = query.query_config ?? {},
    blockers: JsonObject[] = [];
  if (q.gateway !== undefined) return {config: null, blockers: [blocker('native_request')]};
  const extra = Object.keys(q).filter(key => !convertible.has(key));
  if (extra.length) blockers.push(blocker('unsupported_fields', {fields: extra.sort().slice(0, 20)}));
  if (!reportPlatforms[q.platform]) blockers.push(blocker('unsupported_fields', {fields: ['platform']}));
  if (q.level !== undefined && q.level !== 'campaign') blockers.push(blocker('entity_level', {level: String(q.level)}));
  const grain = grains[q.granularity ?? 'day'];
  if (!grain) blockers.push(blocker('granularity', {granularity: String(q.granularity)}));
  if (!q.date_range?.preset) blockers.push(blocker('fixed_dates'));
  const metrics = q.metrics;
  if (
    metrics !== undefined &&
    (!Array.isArray(metrics) ||
      metrics.length > 30 ||
      metrics.some((m: unknown) => typeof m !== 'string' || !/^(metrics\.)?[A-Za-z][A-Za-z0-9_]{0,90}$/.test(m)))
  )
    blockers.push(blocker('metrics'));
  if (blockers.length) return {config: null, blockers};
  return {
    config: {
      name: name.trim().slice(0, 100),
      client_name: '',
      grain,
      sources: [
        {
          platform: q.platform,
          account_id: scope.account_id,
          connection_id: scope.connection_id,
          ...(metrics?.length ? {native_metrics: [...new Set(metrics as string[])]} : {}),
        },
      ],
      date_range: q.date_range,
    },
    blockers,
  };
}

/**
 * The dry run: the Overview report and schedule the move would create, the Sheets report tabs of the workbook's
 * spreadsheet the actor can use, and every reason it cannot move yet. Saves nothing and makes no network request.
 */
export function previewWorkbookMigration(store: Store, actor: Actor, input: JsonObject, validate: Validate) {
  const current = workbookSchedule(store, actor, input.id);
  const tenant = actor.tenantId,
    schedule = store.document(tenant, 'reporting_schedule', current.id),
    query = reportingQueryRecord(store, actor, current.query_id),
    binding = reportingWorkbookAccess(store, actor, query.workbook_binding_id, true),
    blockers: JsonObject[] = [];
  if (schedule.overview_migration?.state === 'migrated') blockers.push(blocker('already_migrated'));
  const converted = overviewConfigFromWorkbook(query, current.name, {
    account_id: current.account_id,
    connection_id: current.connection_id,
  });
  blockers.push(...converted.blockers);
  let config: JsonObject | null = null;
  if (converted.config)
    try {
      config = validate(converted.config, actor);
    } catch (e) {
      if (!(e instanceof MirrorError)) throw e;
      blockers.push(blocker('report_settings', {error_code: e.code, error_message: e.message}));
    }
  const schedules = store.documents(tenant, 'overview_schedule'),
    inUse = (id: string) => schedules.some(s => s.is_active && s.destination_id === id);
  // Report tabs of the workbook's own spreadsheet that this actor's Sheets login can still use.
  const destinations = store
    .documents(tenant, 'sheets_destination')
    .filter(d => d.spreadsheet_id === binding.spreadsheet_id)
    .flatMap(d => {
      try {
        reportDestination(store, actor, d.id);
      } catch (e) {
        if (!(e instanceof MirrorError)) throw e;
        return [];
      }
      return [{id: d.id, name: d.name ?? null, tab_name: d.tab_name ?? null, in_use: inUse(d.id)}];
    })
    .slice(0, 50);
  let destinationId: string | null = null;
  if (input.destination_id === undefined) blockers.push(blocker('destination_required'));
  else {
    const destination = reportDestination(store, actor, input.destination_id);
    if (destination.kind !== 'google_sheets' || destination.spreadsheet_id !== binding.spreadsheet_id)
      throw new MirrorError(
        'WORKBOOK_DESTINATION_MISMATCH',
        'Choose a Google Sheets report tab that Reporting overview bound for this workbook’s spreadsheet.',
        {spreadsheet_id: binding.spreadsheet_id},
      );
    destinationId = destination.id;
    if (inUse(destination.id)) blockers.push(blocker('destination_in_use'));
  }
  const clock = {
    schedule_kind: schedule.schedule_kind,
    schedule_config: {
      minute: schedule.schedule_config?.minute ?? 0,
      hour: schedule.schedule_config?.hour ?? 0,
      ...(schedule.schedule_config?.weekday !== undefined ? {weekday: schedule.schedule_config.weekday} : {}),
      ...(schedule.schedule_config?.day !== undefined ? {day: schedule.schedule_config.day} : {}),
    },
    timezone: schedule.timezone,
  };
  const migratable = blockers.length === 0;
  store.assertActorActive(actor);
  return {
    id: current.id,
    record_kind: 'workbook_migration_preview',
    schedule_version: current.schedule_version,
    query_id: current.query_id,
    query_revision: current.query_revision,
    workbook_binding_id: binding.id,
    spreadsheet_id: binding.spreadsheet_id,
    active: current.active,
    migratable,
    blockers,
    destinations,
    destination_id: destinationId,
    overview_report: config,
    overview_schedule: {...clock, active: current.active},
    move_version: migratable
      ? fingerprint({schedule_version: current.schedule_version, destination_id: destinationId, config, clock})
      : null,
    network_requests: 0,
    external_writes: false,
    meaning:
      'Dry run. Moving creates one Overview report and schedule with this clock, delivering to the chosen Google Sheets report tab, and pauses this local schedule in the same step. The saved query and its revision stay unchanged, and undo restores this schedule. Future Overview runs use your current access.',
  };
}

/** The confirmed move: creates the Overview report and schedule and pauses the local schedule, atomically. */
export function migrateWorkbookSchedule(
  store: Store,
  actor: Actor,
  input: JsonObject,
  validate: Validate,
  library: ReportLibrary,
) {
  writer(store, actor);
  return store.transaction(() => {
    const preview = previewWorkbookMigration(store, actor, input, validate);
    if (!preview.migratable)
      throw new MirrorError(
        'WORKBOOK_MIGRATION_UNSUPPORTED',
        'This workbook schedule cannot move to Reporting overview yet. Review the reasons in the preview.',
        {blockers: preview.blockers.map(b => b.code)},
        409,
      );
    if (input.move_version !== preview.move_version)
      throw new MirrorError(
        'STALE_WORKBOOK_MIGRATION',
        'The schedule, its query or the report tab changed. Preview the move to Reporting overview again.',
        {},
        409,
      );
    const tenant = actor.tenantId,
      schedule = store.document(tenant, 'reporting_schedule', preview.id),
      attempt = Number(schedule.overview_migration?.attempt ?? 0) + 1,
      created = library.schedule(actor, {
        config: preview.overview_report,
        schedule: {
          schedule_kind: preview.overview_schedule.schedule_kind,
          schedule_config: preview.overview_schedule.schedule_config,
          timezone: preview.overview_schedule.timezone,
          destination_id: preview.destination_id,
        },
        // One creation key per move, so a repeated request after a lost response finds the same schedule.
        idempotency_key: 'wbm' + sha256(tenant + ':' + preview.id + ':' + attempt).slice(0, 48),
      });
    // A paused local schedule moves as a paused Overview schedule; the owner resumes it there.
    if (!preview.active) library.changeSchedule(actor, {id: created.id, action: 'pause_schedule'});
    const {id, revision, ...data} = store.document(tenant, 'reporting_schedule', preview.id),
      migration = {
        state: 'migrated',
        attempt,
        overview_schedule_id: created.id,
        overview_view_id: created.view_id,
        destination_id: preview.destination_id,
        query_revision: preview.query_revision,
        was_active: preview.active,
        previous_pause_reason: data.pause_reason ?? null,
        migrated_at: Date.now(),
        migrated_by: actor.userId,
      };
    store.putDocument(
      tenant,
      'reporting_schedule',
      id,
      {
        ...data,
        is_active: false,
        pause_reason: 'migrated_to_overview',
        overview_migration: migration,
        updated_at: new Date().toISOString(),
      },
      revision,
    );
    store.appendAudit(tenant, 'reporting/' + id, {
      event: 'workbook_schedule_migrated',
      actor: actor.userId,
      query_id: preview.query_id,
      query_revision: preview.query_revision,
      overview_schedule_id: created.id,
      overview_view_id: created.view_id,
      destination_id: preview.destination_id,
      was_active: preview.active,
    });
    return {
      ...workbookSchedule(store, actor, id),
      overview_schedule_active: preview.active,
      overview_website_path: '/reporting-overview',
      external_writes: false,
      network_requests: 0,
    };
  });
}

/** Undo: pauses the Overview schedule the move created (its report and snapshots stay) and restores the local one. */
export function revertWorkbookMigration(store: Store, actor: Actor, input: JsonObject, library: ReportLibrary) {
  writer(store, actor);
  return store.transaction(() => {
    const current = workbookSchedule(store, actor, input.id),
      tenant = actor.tenantId,
      {id, revision, ...data} = store.document(tenant, 'reporting_schedule', current.id),
      migration = data.overview_migration;
    if (migration?.state !== 'migrated')
      throw new MirrorError(
        'WORKBOOK_MIGRATION_NOT_FOUND',
        'This workbook schedule was not moved to Reporting overview.',
        {},
        409,
      );
    const overview = optional(store, tenant, 'overview_schedule', String(migration.overview_schedule_id));
    if (overview?.is_active) library.changeSchedule(actor, {id: overview.id, action: 'pause_schedule'});
    // An active schedule becomes active again only while its saved query is the revision that moved; a query edited
    // since then stays paused for separate review, as a definition change pauses schedules (saveWorkbookQuery).
    const queryChanged = current.query_revision !== migration.query_revision,
      restore = migration.was_active === true && !queryChanged;
    store.putDocument(
      tenant,
      'reporting_schedule',
      id,
      {
        ...data,
        is_active: restore,
        pause_reason: restore
          ? null
          : queryChanged && migration.was_active
            ? 'query_definition_changed'
            : (migration.previous_pause_reason ?? null),
        overview_migration: {...migration, state: 'reverted', reverted_at: Date.now(), reverted_by: actor.userId},
        updated_at: new Date().toISOString(),
        ...(restore
          ? {
              ...scheduleClockFields({
                timezone: data.timezone,
                schedule_kind: data.schedule_kind,
                schedule_config: data.schedule_config,
              }),
              actor_binding: store.bindJobActor(actor, 'reporting-schedule:' + id),
              authority_version: 1,
              error: null,
            }
          : {}),
      },
      revision,
    );
    store.appendAudit(tenant, 'reporting/' + id, {
      event: 'workbook_migration_reverted',
      actor: actor.userId,
      overview_schedule_id: migration.overview_schedule_id,
      overview_schedule_paused: overview?.is_active === true,
      restored_active: restore,
      query_changed: queryChanged,
    });
    return {
      ...workbookSchedule(store, actor, id),
      overview_schedule_paused: overview?.is_active === true,
      restored_active: restore,
      query_changed: queryChanged,
      external_writes: false,
      network_requests: 0,
    };
  });
}

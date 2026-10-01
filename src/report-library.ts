import {randomUUID} from 'node:crypto';
import {Store} from './store.js';
import {MirrorError} from './errors.js';
import {nextSchedule} from './reporting.js';
import {sha256, stable} from './security.js';
import {reportDestination} from './report-file-delivery.js';
import type {Actor, JsonObject} from './types.js';

const optional = (store: Store, tenant: string, kind: string, id: string) => {
  try {
    return store.document(tenant, kind, id);
  } catch (e) {
    if (e instanceof MirrorError && e.code === 'NOT_FOUND') return undefined;
    throw e;
  }
};
export class ReportLibrary {
  constructor(
    readonly store: Store,
    readonly validate: (config: JsonObject, actor: Actor, template?: boolean) => JsonObject,
  ) {}
  private revision(input: JsonObject, record: JsonObject, required = true) {
    if ((required || input.expected_revision !== undefined) && input.expected_revision !== record.revision)
      throw new MirrorError(
        'REVISION_CONFLICT',
        'This report setup changed. Reload it before saving or deleting.',
        {revision: record.revision},
        409,
      );
  }
  private audit(actor: Actor, event: string, id: string) {
    this.store.appendAudit(actor.tenantId, 'report-library/' + id, {event, actor: actor.userId, id});
  }
  private destination(actor: Actor, id: unknown) {
    return reportDestination(this.store, actor, id);
  }
  private cancelRuns(tenant: string, scheduleId: string) {
    for (const r of this.store.documents(tenant, 'overview_report').filter(r => r.schedule_id === scheduleId))
      this.cancelReport(tenant, r.id);
  }
  private cancelReport(tenant: string, id: string) {
    this.store.db
      .prepare(
        "UPDATE jobs SET state='cancelled',lease_until=NULL,lease_token=NULL,updated_at=? WHERE tenant_id=? AND kind IN ('report_overview','sheets_export','report_file_export') AND json_extract(input,'$.report_id')=? AND state IN ('queued','running')",
      )
      .run(Date.now(), tenant, id);
    const r = optional(this.store, tenant, 'overview_report', id);
    if (r && ['queued', 'running'].includes(r.state))
      this.store.putDocument(tenant, 'overview_report', id, {...r, state: 'cancelled'});
  }
  save(actor: Actor, input: JsonObject, template = false) {
    return this.store.transaction(() => {
      const tenant = actor.tenantId,
        kind = template ? 'overview_template' : 'overview_view',
        old = input.id ? this.store.document(tenant, kind, String(input.id)) : undefined;
      if (old) this.revision(input, old);
      if (!old && this.store.documents(tenant, kind).length >= 100)
        throw new MirrorError('REPORT_LIMIT', 'Use at most 100 saved reports and 100 templates.');
      const raw = template
        ? {
            ...input.config,
            sources: [],
            client_name: '',
            source_defaults: {
              ...input.config?.source_defaults,
              ...Object.fromEntries(
                (input.config?.sources ?? []).map((s: JsonObject) => [
                  s.platform,
                  {
                    ...input.config?.source_defaults?.[s.platform],
                    ...(s.objective ? {objective: s.objective} : {}),
                    ...(s.native_metrics ? {native_metrics: s.native_metrics} : {}),
                  },
                ]),
              ),
            },
            targets: Object.fromEntries(
              Object.entries(input.config?.targets ?? {}).filter(([k]) =>
                [
                  'awareness',
                  'traffic',
                  'engagement',
                  'video_views',
                  'leads',
                  'sales',
                  'app_installs',
                  'unknown',
                ].includes(k),
              ),
            ),
          }
        : input.config;
      const config = this.validate(raw, actor, template),
        id = old?.id ?? randomUUID(),
        destinationId = template ? undefined : (input.destination_id ?? old?.destination_id);
      if (destinationId !== undefined) this.destination(actor, destinationId);
      if (old?.schedule_id) {
        const schedule = this.store.document(tenant, 'overview_schedule', old.schedule_id);
        if (!config.date_range.preset)
          throw new MirrorError(
            'ROLLING_WINDOW_REQUIRED',
            'A scheduled report needs a rolling/calendar window. Remove its schedule before using fixed dates.',
          );
        const destination = destinationId ?? schedule.destination_id;
        this.destination(actor, destination);
        if (
          schedule.is_active &&
          this.store
            .documents(tenant, 'overview_schedule')
            .some(other => other.id !== schedule.id && other.is_active && other.destination_id === destination)
        )
          throw new MirrorError(
            'DESTINATION_IN_USE',
            'This report tab has another active schedule. Choose a separate report tab.',
            {},
            409,
          );
        this.cancelRuns(tenant, schedule.id);
        this.store.putDocument(
          tenant,
          'overview_schedule',
          schedule.id,
          {
            ...schedule,
            config,
            name: config.name,
            destination_id: destination,
            definition_version: (schedule.definition_version ?? 0) + 1,
            actor_binding: this.store.bindJobActor(actor, schedule.id),
            error: null,
          },
          schedule.revision,
        );
      }
      this.store.putDocument(
        tenant,
        kind,
        id,
        {
          ...old,
          config,
          ...(destinationId ? {destination_id: destinationId} : {}),
          created_at: old?.created_at ?? Date.now(),
          updated_at: Date.now(),
        },
        old?.revision,
      );
      this.audit(actor, template ? 'report_template_saved' : 'report_definition_saved', id);
      return this.store.document(tenant, kind, id);
    });
  }
  schedule(actor: Actor, input: JsonObject, update = false) {
    return this.store.transaction(() => {
      const tenant = actor.tenantId,
        s = input.schedule;
      if (
        !s ||
        typeof s !== 'object' ||
        Array.isArray(s) ||
        !['hourly', 'daily', 'weekly', 'monthly'].includes(s.schedule_kind) ||
        typeof s.timezone !== 'string'
      )
        throw new MirrorError('INVALID_SCHEDULE', 'Choose frequency, timezone and a saved reporting destination.');
      const old = update ? this.store.document(tenant, 'overview_schedule', String(input.id)) : undefined;
      if (old) this.revision(input, old);
      const viewId = old?.view_id ?? input.view_id ?? (input.config ? undefined : input.id),
        view = viewId ? this.store.document(tenant, 'overview_view', String(viewId)) : undefined;
      if (view && !old && input.expected_revision !== undefined) this.revision(input, view);
      if (view && old && input.expected_view_revision !== undefined)
        this.revision({expected_revision: input.expected_view_revision}, view);
      const config = this.validate(input.config ?? view?.config ?? old?.config, actor);
      if (!config.date_range.preset)
        throw new MirrorError(
          'ROLLING_WINDOW_REQUIRED',
          'Scheduled reports need complete-day, calendar-week or calendar-month windows.',
        );
      this.destination(actor, s.destination_id);
      if (
        input.idempotency_key !== undefined &&
        (typeof input.idempotency_key !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(input.idempotency_key))
      )
        throw new MirrorError('INVALID_SCHEDULE', 'Use a stable schedule creation key.');
      const id = old?.id ?? (input.idempotency_key ? sha256('schedule:' + input.idempotency_key) : randomUUID()),
        settings = {
          name: config.name,
          config,
          schedule_kind: s.schedule_kind,
          schedule_config: s.schedule_config ?? {},
          timezone: s.timezone,
          destination_id: s.destination_id,
        },
        fingerprint = sha256(stable({...settings, view_id: view?.id ?? null}));
      if (!old) {
        if (optional(this.store, tenant, 'overview_schedule_deleted', id))
          throw new MirrorError(
            'SCHEDULE_DELETED',
            'This schedule was deleted; use a new creation key for a new report.',
          );
        const prior = optional(this.store, tenant, 'overview_schedule', id);
        if (prior) {
          const {client_name, grain, source_defaults, ...legacyConfig} = config,
            legacyFingerprint = sha256(JSON.stringify({...settings, config: legacyConfig}));
          const legacyMatch =
            !prior.fingerprint_version &&
            client_name === '' &&
            grain === 'total' &&
            !Object.keys(source_defaults).length &&
            prior.request_fingerprint === legacyFingerprint;
          if (prior.request_fingerprint !== fingerprint && !legacyMatch)
            throw new MirrorError('IDEMPOTENCY_CONFLICT', 'This key belongs to another scheduled report.');
          return {
            id,
            revision: prior.revision,
            view_id: prior.view_id,
            next_run_at: prior.next_run_at,
            is_active: prior.is_active,
          };
        }
        if (view?.schedule_id)
          throw new MirrorError(
            'REPORT_ALREADY_SCHEDULED',
            'Edit this report’s existing schedule or duplicate the report.',
          );
      }
      const all = this.store.documents(tenant, 'overview_schedule');
      if (!old && all.length >= 50) throw new MirrorError('SCHEDULE_LIMIT', 'Use at most 50 schedules per workspace.');
      if (all.some(other => other.id !== id && other.is_active && other.destination_id === s.destination_id))
        throw new MirrorError(
          'DESTINATION_IN_USE',
          'This report tab has another active schedule. Choose a separate report tab.',
          {},
          409,
        );
      if (!view && this.store.documents(tenant, 'overview_view').length >= 100)
        throw new MirrorError('REPORT_LIMIT', 'Use at most 100 saved reports.');
      const linkedView = view?.id ?? id,
        next = nextSchedule(settings);
      if (old) this.cancelRuns(tenant, id);
      this.store.putDocument(
        tenant,
        'overview_view',
        linkedView,
        {
          ...view,
          config,
          destination_id: s.destination_id,
          schedule_id: id,
          created_at: view?.created_at ?? Date.now(),
          updated_at: Date.now(),
        },
        view?.revision,
      );
      this.store.putDocument(
        tenant,
        'overview_schedule',
        id,
        {
          ...old,
          ...settings,
          is_active: old?.is_active ?? true,
          view_id: linkedView,
          request_fingerprint: old?.request_fingerprint ?? fingerprint,
          fingerprint_version: old ? old.fingerprint_version : 2,
          definition_version: (old?.definition_version ?? 0) + 1,
          actor_binding: this.store.bindJobActor(actor, id),
          created_at: old?.created_at ?? Date.now(),
          updated_at: Date.now(),
          next_run_at: next,
          error: null,
        },
        old?.revision,
      );
      this.audit(actor, old ? 'report_schedule_updated' : 'report_schedule_created', id);
      const saved = this.store.document(tenant, 'overview_schedule', id);
      return {id, revision: saved.revision, view_id: linkedView, next_run_at: next, is_active: saved.is_active};
    });
  }
  changeSchedule(actor: Actor, input: JsonObject, remove = false) {
    return this.store.transaction(() => {
      const tenant = actor.tenantId,
        s = this.store.document(tenant, 'overview_schedule', String(input.id));
      this.revision(input, s, remove);
      this.cancelRuns(tenant, s.id);
      if (remove) {
        this.store.db
          .prepare("DELETE FROM documents WHERE tenant_id=? AND kind='overview_schedule' AND id=?")
          .run(tenant, s.id);
        this.store.putDocument(tenant, 'overview_schedule_deleted', s.id, {deleted_at: Date.now()});
        const view = optional(this.store, tenant, 'overview_view', s.view_id);
        if (view) {
          const {schedule_id, ...rest} = view;
          this.store.putDocument(tenant, 'overview_view', view.id, {...rest, updated_at: Date.now()}, view.revision);
        }
        this.audit(actor, 'report_schedule_deleted', s.id);
        return {id: s.id, deleted: true};
      }
      const resume = input.action === 'resume_schedule';
      if (resume) {
        this.validate(s.config, actor);
        this.destination(actor, s.destination_id);
        if (
          this.store
            .documents(tenant, 'overview_schedule')
            .some(other => other.id !== s.id && other.is_active && other.destination_id === s.destination_id)
        )
          throw new MirrorError(
            'DESTINATION_IN_USE',
            'The selected report tab already has an active schedule.',
            {},
            409,
          );
      }
      const data = {
        ...s,
        updated_at: Date.now(),
        is_active: resume,
        definition_version: (s.definition_version ?? 0) + 1,
        ...(resume
          ? {next_run_at: nextSchedule(s), actor_binding: this.store.bindJobActor(actor, s.id), error: null}
          : {}),
      };
      this.store.putDocument(tenant, 'overview_schedule', s.id, data, s.revision);
      this.audit(actor, resume ? 'report_schedule_resumed' : 'report_schedule_paused', s.id);
      return {id: s.id, is_active: resume, next_run_at: data.next_run_at};
    });
  }
  delete(actor: Actor, input: JsonObject, kind: 'overview_view' | 'overview_template' | 'overview_report') {
    return this.store.transaction(() => {
      const tenant = actor.tenantId,
        r = this.store.document(tenant, kind, String(input.id));
      this.revision(input, r, kind !== 'overview_report');
      if (kind === 'overview_view' && r.schedule_id) {
        const s = this.store.document(tenant, 'overview_schedule', r.schedule_id);
        this.changeSchedule(actor, {id: s.id, expected_revision: s.revision}, true);
      }
      if (kind === 'overview_report') {
        this.store.deleteDocument(tenant, 'report_presentation', r.id);
        this.store.db
          .prepare(
            "DELETE FROM documents WHERE tenant_id=? AND kind='report_file' AND json_extract(data,'$.report_id')=?",
          )
          .run(tenant, r.id);
        this.cancelReport(tenant, r.id);
        for (const e of this.store.documents(tenant, 'overview_export').filter(e => e.report_id === r.id))
          this.store.db
            .prepare("DELETE FROM documents WHERE tenant_id=? AND kind='overview_export' AND id=?")
            .run(tenant, e.id);
        this.store.db
          .prepare(
            "DELETE FROM jobs WHERE tenant_id=? AND kind IN ('report_overview','sheets_export','report_file_export') AND json_extract(input,'$.report_id')=?",
          )
          .run(tenant, r.id);
      }
      this.store.db.prepare('DELETE FROM documents WHERE tenant_id=? AND kind=? AND id=?').run(tenant, kind, r.id);
      this.audit(actor, kind + '_deleted', r.id);
      return {id: r.id, deleted: true, external_spreadsheet_unchanged: true};
    });
  }
}

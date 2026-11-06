import {randomUUID} from 'node:crypto';
import {Store} from './store.js';
import {MirrorError} from './errors.js';
import {scheduleClockFields} from './reporting.js';
import {sha256, stable} from './security.js';
import {reportDestination} from './report-file-delivery.js';
import {currencyTargetKey} from './report-metrics.js';
import {deleteSettledDeliveries, hasUnconfirmedDelivery, writeDefinitionSidecar} from './report-repository.js';
import {cancelReportJobs, deleteReportJobs} from './job-repository.js';
import type {Actor, JsonObject} from './types.js';
import {
  overviewDefinitionConfig,
  overviewDefinitionForms,
  overviewSidecar,
  overviewSidecarCurrent,
  publicOverviewDefinition,
  upgradeOverviewV3Config,
  overviewConfigV4,
} from './overview-v4.js';
import {reportSource} from './report-sources.js';
import {
  registerObjectiveMigration,
  deleteObjectiveMigration,
  linkObjectiveMigration,
} from './report-definition-migration.js';

const definitionForms = (config: JsonObject) =>
  overviewDefinitionForms(config, platform => reportSource(platform)!.overview!);

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
    // legacyTargets: a stored definition re-checked without edits keeps target rules added after it was saved.
    readonly validate: (config: JsonObject, actor: Actor, template?: boolean, legacyTargets?: boolean) => JsonObject,
    // Whether the actor may read every source of a definition (ReportingOverview.access); throws when not.
    readonly access: (actor: Actor, config: JsonObject) => void = () => {},
  ) {}
  /**
   * Validate a stored definition as v4 while preserving its original rollback config. The caller owns the write, in the
   * transaction that read the record, and `migrated` says it must write the sidecar (overviewSidecar): there is none, or
   * it belongs to an older `config` (a rollback edited it). The migration is journalled here, so it commits or rolls back
   * with that write; the journal says which definition changed, since no revision does (F-L9-02).
   */
  prepareDefinition(
    actor: Actor,
    record: JsonObject,
    kind: 'overview_view' | 'overview_schedule' | 'overview_template',
  ) {
    const original = overviewDefinitionConfig(record),
      config = this.validate(
        upgradeOverviewV3Config(original, platform => reportSource(platform)?.overview),
        actor,
        kind === 'overview_template',
        true,
      ),
      migrated = !overviewSidecarCurrent(record);
    if (migrated) this.audit(actor, 'report_definition_migrated', record.id, {kind});
    if (kind !== 'overview_template') registerObjectiveMigration(this.store, actor.tenantId, record, kind);
    return {config, migrated};
  }
  /**
   * Upgrade a stored definition for a run or a resume: the sidecar is written beside the untouched v3 form. This is not
   * a person's edit, so it does not advance the revision the editor and the schedule dialog compare (F-L6-09).
   */
  migrateDefinition(
    actor: Actor,
    record: JsonObject,
    kind: 'overview_view' | 'overview_schedule' | 'overview_template',
  ) {
    const prepared = this.prepareDefinition(actor, record, kind);
    if (
      prepared.migrated &&
      !writeDefinitionSidecar(
        this.store,
        actor.tenantId,
        kind,
        record.id,
        record.revision,
        overviewSidecar(record, prepared.config),
      )
    )
      throw new MirrorError(
        'REVISION_CONFLICT',
        'This report setup changed. Reload it before saving or deleting.',
        {revision: this.store.document(actor.tenantId, kind, record.id).revision},
        409,
      );
    return prepared.config;
  }
  /**
   * Access limited to a client access set (SEC-08) changes, deletes or pauses only the saved reports, templates,
   * snapshots and schedules whose accounts it reaches; it never lists the others, and here it cannot alter one by ID.
   */
  private changeable(actor: Actor, record: JsonObject | undefined) {
    if (record && actor.accessSetId !== undefined)
      this.access(actor, overviewDefinitionConfig(record) ?? {sources: []});
  }
  private revision(input: JsonObject, record: JsonObject, required = true) {
    if ((required || input.expected_revision !== undefined) && input.expected_revision !== record.revision)
      throw new MirrorError(
        'REVISION_CONFLICT',
        'This report setup changed. Reload it before saving or deleting.',
        {revision: record.revision},
        409,
      );
  }
  private audit(actor: Actor, event: string, id: string, detail: JsonObject = {}) {
    this.store.appendAudit(actor.tenantId, 'report-library/' + id, {event, actor: actor.userId, id, ...detail});
  }
  private destination(actor: Actor, id: unknown) {
    return reportDestination(this.store, actor, id);
  }
  private cancelRuns(tenant: string, scheduleId: string) {
    for (const r of this.store.documents(tenant, 'overview_report').filter(r => r.schedule_id === scheduleId))
      this.cancelReport(tenant, r.id);
  }
  private cancelReport(tenant: string, id: string) {
    cancelReportJobs(this.store, tenant, id, Date.now());
    const r = optional(this.store, tenant, 'overview_report', id);
    if (r && ['queued', 'running'].includes(r.state))
      this.store.putDocument(tenant, 'overview_report', id, {...r, state: 'cancelled'});
  }
  save(actor: Actor, input: JsonObject, template = false) {
    return this.store.transaction(() => {
      const tenant = actor.tenantId,
        kind = template ? 'overview_template' : 'overview_view',
        old = input.id ? this.store.document(tenant, kind, String(input.id)) : undefined;
      this.changeable(actor, old);
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
                (input.config?.sources ?? []).map((s: JsonObject) => {
                  const defaults = {...input.config?.source_defaults?.[s.platform]};
                  if (s.level !== undefined || s.levels !== undefined) {
                    delete defaults.level;
                    delete defaults.levels;
                  }
                  return [
                    s.platform,
                    {
                      ...defaults,
                      ...(s.objective ? {objective: s.objective} : {}),
                      ...(s.objective_fallback !== undefined ? {objective_fallback: s.objective_fallback} : {}),
                      ...(s.native_metrics ? {native_metrics: s.native_metrics} : {}),
                      ...(s.level ? {level: s.level} : {}),
                      ...(s.levels ? {levels: s.levels} : {}),
                      ...(s.statuses ? {statuses: s.statuses} : {}),
                      ...(s.delivered_only !== undefined ? {delivered_only: s.delivered_only} : {}),
                      ...(s.report_options ? {report_options: s.report_options} : {}),
                    },
                  ];
                }),
              ),
            },
            // Templates are account-free: objective and objective:CURRENCY targets stay, campaign targets do not.
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
                ].includes(currencyTargetKey.exec(k)?.[1] ?? k),
              ),
            ),
          }
        : input.config;
      const modern =
          old && raw?.contract_version !== overviewConfigV4
            ? upgradeOverviewV3Config(raw, platform => reportSource(platform)?.overview)
            : raw,
        config = this.validate(modern, actor, template),
        id = old?.id ?? randomUUID(),
        destinationId = template ? undefined : (input.destination_id ?? old?.destination_id);
      if (old && !template) registerObjectiveMigration(this.store, tenant, old, 'overview_view');
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
            ...definitionForms(config),
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
          ...definitionForms(config),
          ...(destinationId ? {destination_id: destinationId} : {}),
          created_at: old?.created_at ?? Date.now(),
          updated_at: Date.now(),
        },
        old?.revision,
      );
      this.audit(actor, template ? 'report_template_saved' : 'report_definition_saved', id);
      return publicOverviewDefinition(this.store.document(tenant, kind, id));
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
      this.changeable(actor, old);
      if (old) this.revision(input, old);
      const viewId = old?.view_id ?? input.view_id ?? (!old && !input.config ? input.id : undefined),
        view = viewId ? this.store.document(tenant, 'overview_view', String(viewId)) : undefined;
      this.changeable(actor, view);
      if (view && !old && input.expected_revision !== undefined) this.revision(input, view);
      if (view && old && input.expected_view_revision !== undefined)
        this.revision({expected_revision: input.expected_view_revision}, view);
      const inherited = view ?? old,
        raw = input.config ?? (inherited ? overviewDefinitionConfig(inherited) : undefined),
        config = this.validate(
          inherited ? upgradeOverviewV3Config(raw, platform => reportSource(platform)?.overview) : raw,
          actor,
          false,
          input.config === undefined,
        ),
        forms =
          input.config === undefined && inherited && !overviewSidecarCurrent(inherited)
            ? {config: inherited.config, ...overviewSidecar(inherited, config)}
            : definitionForms(config);
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
          let formatMatch = false;
          // The creation fingerprint is the request's, so a retry normally equals it. Only a schedule stored in the v3
          // spelling (no current v4 form beside it) can be the same request written in the newer one; the projection
          // of a v4 definition is not a definition to validate. A prior that does not validate is not the request retried.
          if (prior.request_fingerprint !== fingerprint && !legacyMatch && !overviewSidecarCurrent(prior))
            try {
              const upgraded = this.validate(
                upgradeOverviewV3Config(prior.config, platform => reportSource(platform)?.overview),
                actor,
                false,
                true,
              );
              formatMatch =
                sha256(
                  stable({
                    name: upgraded.name,
                    config: upgraded,
                    schedule_kind: prior.schedule_kind,
                    schedule_config: prior.schedule_config ?? {},
                    timezone: prior.timezone,
                    destination_id: prior.destination_id,
                    view_id: prior.view_id ?? null,
                  }),
                ) === fingerprint;
            } catch (error) {
              if (!(error instanceof MirrorError)) throw error;
            }
          if (prior.request_fingerprint !== fingerprint && !legacyMatch && !formatMatch)
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
        clock = scheduleClockFields(settings),
        next = clock.next_run_at;
      if (view) registerObjectiveMigration(this.store, tenant, view, 'overview_view');
      if (old) {
        registerObjectiveMigration(this.store, tenant, old, 'overview_schedule');
        if (!old.view_id) linkObjectiveMigration(this.store, tenant, old.id, linkedView);
      }
      if (old) this.cancelRuns(tenant, id);
      this.store.putDocument(
        tenant,
        'overview_view',
        linkedView,
        {
          ...view,
          ...forms,
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
          ...forms,
          is_active: old?.is_active ?? true,
          view_id: linkedView,
          request_fingerprint: old?.request_fingerprint ?? fingerprint,
          fingerprint_version: old ? old.fingerprint_version : 2,
          definition_version: (old?.definition_version ?? 0) + 1,
          actor_binding: this.store.bindJobActor(actor, id),
          created_at: old?.created_at ?? Date.now(),
          updated_at: Date.now(),
          ...clock,
          error: null,
          consecutive_delivery_failures: 0,
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
      this.changeable(actor, s);
      this.revision(input, s, remove);
      this.cancelRuns(tenant, s.id);
      if (remove) {
        this.store.repo('overview_schedule', tenant).delete(s.id);
        deleteObjectiveMigration(this.store, tenant, 'overview_schedule', s.id);
        this.store.putDocument(tenant, 'overview_schedule_deleted', s.id, {deleted_at: Date.now()});
        const view = optional(this.store, tenant, 'overview_view', s.view_id);
        if (view) {
          const {schedule_id, ...rest} = view;
          this.store.putDocument(tenant, 'overview_view', view.id, {...rest, updated_at: Date.now()}, view.revision);
        }
        this.audit(actor, 'report_schedule_deleted', s.id);
        return {id: s.id, deleted: true};
      }
      const resume = input.action === 'resume_schedule',
        prepared = resume ? this.prepareDefinition(actor, s, 'overview_schedule') : undefined;
      if (resume) {
        const view = s.view_id ? optional(this.store, tenant, 'overview_view', s.view_id) : undefined;
        if (view) this.migrateDefinition(actor, view, 'overview_view');
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
      const data: JsonObject = {
        ...s,
        ...(prepared?.migrated ? overviewSidecar(s, prepared.config) : {}),
        updated_at: Date.now(),
        is_active: resume,
        definition_version: (s.definition_version ?? 0) + 1,
        ...(resume
          ? {
              ...scheduleClockFields(s),
              actor_binding: this.store.bindJobActor(actor, s.id),
              error: null,
              // A resumed schedule starts a new delivery-failure count (EXP-03 E).
              consecutive_delivery_failures: 0,
            }
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
      this.changeable(actor, r);
      this.revision(input, r, kind !== 'overview_report');
      if (kind === 'overview_view' && r.schedule_id) {
        const s = this.store.document(tenant, 'overview_schedule', r.schedule_id);
        this.changeSchedule(actor, {id: s.id, expected_revision: s.revision}, true);
      }
      if (kind === 'overview_report') {
        this.store.deleteDocument(tenant, 'report_presentation', r.id);
        this.store.repo('report_file', tenant).deleteBy('report_id', r.id);
        this.cancelReport(tenant, r.id);
        // Terminal Sheets receipts go with the snapshot. An unconfirmed one was released (audited) before this point;
        // an abandoned receipt stays until retention so a late application of its batch is still recognized.
        if (hasUnconfirmedDelivery(this.store, tenant, r.id))
          throw new MirrorError(
            'SHEETS_DELIVERY_UNRESOLVED',
            'This snapshot has an unconfirmed Google Sheets delivery. Release its report tab before deleting it.',
            {report_id: r.id},
            409,
          );
        deleteSettledDeliveries(this.store, tenant, r.id);
        const exports = this.store.repo('overview_export', tenant);
        for (const e of this.store.documents(tenant, 'overview_export').filter(e => e.report_id === r.id))
          exports.delete(e.id);
        deleteReportJobs(this.store, tenant, r.id);
      }
      this.store.deleteDocument(tenant, kind, r.id);
      if (kind === 'overview_view') deleteObjectiveMigration(this.store, tenant, kind, r.id);
      this.audit(actor, kind + '_deleted', r.id);
      return {id: r.id, deleted: true, external_spreadsheet_unchanged: true};
    });
  }
}

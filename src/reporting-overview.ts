import {fingerprint, formulaVersion, reportContractVersion} from './report-quality.js';
import {validateRecommendationContext} from './recommendation-context.js';
import {reportSummary} from './report-summary.js';
import {cleanupReports} from './owner-operations.js';
import {dueSchedules, failSchedule, followingOccurrence, reevaluatedOccurrence} from './scheduled-work.js';
import {randomUUID} from 'node:crypto';
import type {Actor, JsonObject} from './types.js';
import type {MirrorService} from './service.js';
import {MirrorError} from './errors.js';
import {tool, field, writer} from './workspace-core.js';
import {NativeCampaignReports, nativeMetricExamples, reportRange} from './report-native.js';
import {
  GoogleSheetsExports,
  sheetsGateway,
  assertReportExportable,
  abandonSheetsDelivery,
  assertSheetsSettled,
  deliveryProjection,
  sheetsDeliveriesForReport,
  unresolvedSheetsDelivery,
  unresolvedStates,
} from './google-sheets.js';
import {
  metricDefinitions,
  reportPlatforms,
  objectiveGroups,
  validateCustomMetrics,
  parseMetricFormula,
  calculateMetrics,
  campaignRecommendation,
  metricSources,
} from './report-metrics.js';
import {resolveReportConfig, nextScheduleDetail} from './reporting.js';
import {normalizeAccount} from './scope.js';
import {sha256} from './security.js';
import {reportSourceError} from './report-errors.js';
import {ReportLibrary} from './report-library.js';
import {ReportFileDelivery, reportDestination} from './report-file-delivery.js';
import {collectReportPeriods, reportGrains} from './report-periods.js';
import {ReportCollectionBudget, reportCollectionLimits} from './report-collection-budget.js';
import {evaluateMonitors} from './report-monitors.js';
import {overviewEntityLevels, overviewSourceLevel} from './overview-granularity.js';
import {
  reportPack,
  retainedPresentation,
  savePresentation,
  presentationProfiles,
  applyProfilePresentation,
} from './report-packs.js';
export const overviewTool = tool(
  'amcp_reporting_overview',
  'Use this for saved client reports across platforms and accounts, their schedules and Sheets or retained-file exports; to analyse one captured native report, use amcp_reporting. Cross-platform campaign, native ad-set/ad-group and ad reporting: bootstrap exposes entity_levels; each source optionally sets level:campaign/adset/ad. Qualified detail supports Google ad groups/ads, Meta ad sets/ads, TikTok auction ad groups/ads, Snapchat ad squads/ads and LinkedIn sponsored creatives; LinkedIn campaigns are its native middle level. Detailed sources require report_options:{complete_window:boolean, attribution:string} for Google/TikTok/LinkedIn; Meta instead requires result_action_type and explicit attribution_windows; Snapchat instead requires swipe_up_attribution_window and view_attribution_window, with exact campaign_id for ad squads. TikTok/Snapchat require complete_window:true and 1–31 closed days. Other providers retain qualified campaign/context rows. Detail retains exact native daily entity/parent identities, sums only additive metrics, keeps missing values unknown and refuses extra native_metrics; multi-day reach/frequency stay unknown. Entity detail is separate from date grouping. Existing campaign configurations keep their original shape. discover account/metric choices, create/edit/delete named client reports and reusable account-free templates, calculate custom arithmetic metrics, collect bounded total/daily/weekly/monthly native reports, inspect objective-aware recommendations, and export/schedule confirmed Google Sheets reports. Daily, weekly, monthly and hourly delivery schedules use independent report destinations. Definition edits/deletes require expected_revision; update_schedule also accepts expected_view_revision. pause_schedule pauses, remove_schedule deletes; delete_schedule remains a legacy pause alias. report_pack returns retained snapshot summaries, source evidence and authenticated PDF/XLSX download paths. save_presentation saves per-snapshot brand_name, accent_color, footer and standard/compact layout with confirmed:true and current presentation_revision (0 when absent). presentation_profiles lists compatible approved client branding for snapshot id with offset/limit. apply_profile_presentation requires profile_id, exact profile_revision, current presentation_revision and confirmed:true; it copies the approved branding without changing earlier snapshots when the profile changes. bind_file_destination requires confirmed:true, a stable idempotency_key and file_destination:{name,formats:[pdf,xlsx],presentation?:{brand_name,accent_color,footer,template}} with at least one format. It saves a local encrypted-file destination, without Sheets login or external recipients. export/schedule accept its destination_id. File jobs freeze branding and retained evidence, return authenticated download paths, and retry only missing formats. Each file is limited to 20 MiB and encrypted workspace storage to 256 MiB; snapshot deletion/retention removes files. Downloads recheck current source access. No advertising mutations. Sheets export jobs replace only an AMCP-owned tab; retries never append duplicate rows. An unconfirmed Sheets delivery blocks newer reports to its tab; its retry rechecks the tab marker and resends the identical batch only after a 10-minute settle window. resolve_delivery takes destination_id, optional delivery_id, resolution check|resend|abandon and confirmed:true: check rereads the marker, resend requeues that same report after the window, abandon releases the tab (audited); abandon also releases a tab with a conflicting marker. delete_report of a snapshot with an unconfirmed delivery needs resolution:abandon. Missing metrics remain null. GA4 and Search Console are measurement context.',
  [
    'bootstrap',
    'preview_schedule',
    'report_pack',
    'save_presentation',
    'presentation_profiles',
    'apply_profile_presentation',
    'save',
    'save_template',
    'delete_template',
    'delete_view',
    'delete_report',
    'update_schedule',
    'remove_schedule',
    'run',
    'get',
    'list',
    'export',
    'schedule',
    'pause_schedule',
    'delete_schedule',
    'resume_schedule',
    'retry',
    'cancel',
    'create_spreadsheet',
    'bind_destination',
    'bind_file_destination',
    'export_status',
    'resolve_delivery',
  ],
  {
    id: field.id,
    view_id: field.id,
    expected_revision: {type: 'integer', minimum: 1},
    expected_view_revision: {type: 'integer', minimum: 1},
    presentation_revision: {type: 'integer', minimum: 0},
    presentation: field.object,
    profile_id: field.id,
    profile_revision: {type: 'integer', minimum: 1},
    config: field.object,
    confirmed: field.bool,
    destination_id: field.id,
    file_destination: field.object,
    report_id: field.id,
    schedule: field.object,
    connection_id: field.id,
    spreadsheet_id: field.id,
    spreadsheet_url: {type: 'string', maxLength: 2048},
    tab_name: {type: 'string', maxLength: 80},
    name: {type: 'string'},
    idempotency_key: field.id,
    offset: {type: 'integer', minimum: 0},
    limit: {type: 'integer', minimum: 1, maximum: 500},
    delivery_id: field.id,
    resolution: {type: 'string', enum: ['check', 'resend', 'abandon']},
  },
);
const optional = (service: MirrorService, tenant: string, kind: string, id: string) => {
  try {
    return service.store.document(tenant, kind, id);
  } catch (e) {
    if (e instanceof MirrorError && e.code === 'NOT_FOUND') return undefined;
    throw e;
  }
};
const publicRecord = (r: JsonObject) => {
  const {actor_binding, checkpoints, collection_budget, ...visible} = r;
  if (!collection_budget) return visible;
  const {row_counts, active_since, ...usage} = collection_budget;
  return {...visible, collection_budget: usage};
};
export class ReportingOverview {
  readonly native: NativeCampaignReports;
  readonly sheets: GoogleSheetsExports;
  readonly library: ReportLibrary;
  readonly files: ReportFileDelivery;
  constructor(
    readonly service: MirrorService,
    fetcher: typeof fetch = fetch,
  ) {
    this.native = new NativeCampaignReports(service);
    this.sheets = new GoogleSheetsExports(service.store, fetcher);
    this.library = new ReportLibrary(service.store, (c, a, t) => this.config(c, a, t));
    this.files = new ReportFileDelivery(
      service.store,
      (a, c) => this.access(a, c),
      (t, id) => this.currentReport(t, id),
    );
  }
  config(input: JsonObject, actor: Actor, template = false): JsonObject {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      typeof input.name !== 'string' ||
      !input.name.trim() ||
      input.name.length > 100
    )
      throw new MirrorError('INVALID_REPORT', 'Name this report (1–100 characters).');
    if (!Array.isArray(input.sources) || (!template && !input.sources.length) || input.sources.length > 30)
      throw new MirrorError('REPORT_SOURCES_REQUIRED', 'Choose between 1 and 30 platform accounts.');
    const seen = new Set<string>();
    input = structuredClone(input);
    for (const s of input.sources) {
      if (!s || !reportPlatforms[s.platform] || typeof s.account_id !== 'string' || typeof s.connection_id !== 'string')
        throw new MirrorError('INVALID_REPORT_SOURCE', 'Choose a platform, connection and account.');
      s.account_id = normalizeAccount(reportPlatforms[s.platform]!.gateway, s.account_id);
      this.service.store.resolveConnection(actor, reportPlatforms[s.platform]!.gateway, s.account_id, s.connection_id);
      const key = s.platform + ':' + s.account_id.replace(/^act_/, '');
      if (seen.has(key))
        throw new MirrorError(
          'DUPLICATE_REPORT_ACCOUNT',
          'Select an account once, even if it has multiple connections.',
        );
      seen.add(key);
      if (s.objective !== undefined && !objectiveGroups.includes(s.objective))
        throw new MirrorError('INVALID_OBJECTIVE', 'Choose a supported objective.');
      if (
        s.native_metrics !== undefined &&
        (!Array.isArray(s.native_metrics) ||
          s.native_metrics.length > 30 ||
          s.native_metrics.some(
            (m: unknown) => typeof m !== 'string' || !/^(metrics\.)?[A-Za-z][A-Za-z0-9_]{0,90}$/.test(m),
          ))
      )
        throw new MirrorError('INVALID_NATIVE_METRICS', 'Use native metric names, without query expressions.');
      overviewSourceLevel(s);
    }
    if (input.client_name !== undefined && (typeof input.client_name !== 'string' || input.client_name.length > 100))
      throw new MirrorError('INVALID_REPORT', 'Use a client name of at most 100 characters.');
    if (input.grain !== undefined && !reportGrains.includes(input.grain))
      throw new MirrorError('INVALID_REPORT_GRAIN', 'Choose total, daily, weekly or monthly grouping.');
    const defaults = input.source_defaults ?? {};
    if (
      !defaults ||
      typeof defaults !== 'object' ||
      Array.isArray(defaults) ||
      Object.keys(defaults).some(p => !reportPlatforms[p])
    )
      throw new MirrorError('INVALID_REPORT_SOURCE', 'Template defaults must name supported reporting platforms.');
    for (const d of Object.values(defaults) as JsonObject[])
      if (
        !d ||
        typeof d !== 'object' ||
        Array.isArray(d) ||
        Object.keys(d).some(k => !['objective', 'native_metrics', 'level', 'report_options'].includes(k)) ||
        (d.objective !== undefined && !objectiveGroups.includes(d.objective)) ||
        (d.native_metrics !== undefined &&
          (!Array.isArray(d.native_metrics) ||
            d.native_metrics.length > 30 ||
            d.native_metrics.some(
              (m: unknown) => typeof m !== 'string' || !/^(metrics\.)?[A-Za-z][A-Za-z0-9_]{0,90}$/.test(m),
            )))
      )
        throw new MirrorError(
          'INVALID_REPORT_SOURCE',
          'Use objective and native metric names for template defaults, without account identities.',
        );
    for (const [platform, defaults] of Object.entries(input.source_defaults ?? {}))
      overviewSourceLevel({platform, ...(defaults as JsonObject)}, true);
    reportRange(resolveReportConfig({date_range: input.date_range}).date_range);
    if (
      input.objectives !== undefined &&
      (!Array.isArray(input.objectives) || input.objectives.some((o: unknown) => !objectiveGroups.includes(String(o))))
    )
      throw new MirrorError('INVALID_OBJECTIVE', 'Select valid objectives.');
    const nativeNames = new Set<string>();
    for (const m of input.custom_metrics ?? [])
      for (const d of parseMetricFormula(m.formula).dependencies)
        if (/^native_[a-z][a-zA-Z0-9_]{1,150}$/.test(d)) nativeNames.add(d);
    const custom = validateCustomMetrics(input.custom_metrics, [...nativeNames]),
      known = new Set([...Object.keys(metricDefinitions), ...custom.map(m => m.id)]);
    const metrics = input.metrics ?? ['spend', 'impressions', 'clicks', 'conversions', 'cpa', 'roas'];
    if (
      !Array.isArray(metrics) ||
      !metrics.length ||
      metrics.length > 80 ||
      metrics.some(
        (m: unknown) => typeof m !== 'string' || (!known.has(m) && !/^native_[a-z][a-zA-Z0-9_]{1,150}$/.test(m)),
      )
    )
      throw new MirrorError('INVALID_METRICS', 'Select valid common, native or custom metrics.');
    const policies = input.targets ?? {};
    if (!policies || typeof policies !== 'object' || Array.isArray(policies) || Object.keys(policies).length > 500)
      throw new MirrorError('INVALID_TARGET', 'Use objective or campaign target settings.');
    for (const p of Object.values(policies) as JsonObject[]) {
      if (p && typeof p === 'object') validateRecommendationContext(p, known);
      if (
        !p ||
        typeof p !== 'object' ||
        typeof p.target !== 'number' ||
        !Number.isFinite(p.target) ||
        p.target <= 0 ||
        typeof p.currency !== 'string' ||
        !/^[A-Z]{3}$/.test(p.currency) ||
        (p.kpi !== undefined && !known.has(p.kpi) && p.kpi !== 'cost_per_engagement') ||
        (p.direction !== undefined && !['higher', 'lower'].includes(p.direction)) ||
        (p.minimum_results !== undefined &&
          (!Number.isInteger(p.minimum_results) || p.minimum_results < 1 || p.minimum_results > 1000000)) ||
        (p.conversion_lag_days !== undefined &&
          (!Number.isInteger(p.conversion_lag_days) || p.conversion_lag_days < 0 || p.conversion_lag_days > 90)) ||
        (p.maximum_change_percent !== undefined &&
          (typeof p.maximum_change_percent !== 'number' ||
            p.maximum_change_percent < 1 ||
            p.maximum_change_percent > 20)) ||
        (p.result_metric !== undefined && !known.has(p.result_metric))
      )
        throw new MirrorError(
          'INVALID_TARGET',
          'Targets need a positive value, ISO currency, valid KPI and sensible sample/lag limits.',
        );
    }
    if (input.partial_delivery !== undefined && !['allow_marked', 'complete_only'].includes(input.partial_delivery))
      throw new MirrorError('INVALID_REPORT', 'Choose marked partial delivery or complete reports only.');
    return {
      formula_version: formulaVersion,
      formula_fingerprint: fingerprint(custom),
      source_contract_version: reportContractVersion,
      partial_delivery: input.partial_delivery ?? 'allow_marked',
      name: input.name.trim(),
      client_name: (input.client_name ?? '').trim(),
      grain: input.grain ?? 'total',
      sources: structuredClone(input.sources),
      source_defaults: defaults,
      date_range: input.date_range,
      metrics: [...new Set(metrics)],
      custom_metrics: custom,
      targets: policies,
      objectives: input.objectives ?? [],
      version: 1,
    };
  }
  access(actor: Actor, config: JsonObject) {
    this.service.store.assertActorActive(actor);
    for (const s of config.sources)
      this.service.store.resolveConnection(actor, reportPlatforms[s.platform]!.gateway, s.account_id, s.connection_id);
  }
  queue(actor: Actor, config: JsonObject, destinationId?: string, scheduleId?: string, at = Date.now()) {
    const store = this.service.store;
    this.access(actor, config);
    if (
      (
        store.db
          .prepare(
            "SELECT count(*) AS n FROM jobs WHERE tenant_id=? AND kind IN ('report_overview','sheets_export','report_file_export') AND state IN ('queued','running')",
          )
          .get(actor.tenantId) as JsonObject
      ).n >= 100
    )
      throw new MirrorError('REPORT_QUEUE_FULL', 'This workspace already has 100 active reporting jobs.');
    const id = randomUUID();
    config = resolveReportConfig(config, at);
    store.putDocument(actor.tenantId, 'overview_report', id, {
      config,
      state: 'queued',
      captured_at: at,
      created_at: Date.now(),
      rows: [],
      sources: [],
      actor_binding: store.bindJobActor(actor, id),
      destination_id: destinationId ?? null,
      schedule_id: scheduleId ?? null,
      schedule_version: scheduleId
        ? (store.document(actor.tenantId, 'overview_schedule', scheduleId).definition_version ?? 0)
        : null,
      checkpoints: {},
    });
    const jobId = store.enqueue(actor.tenantId, 'report_overview', {report_id: id});
    store.putDocument(actor.tenantId, 'overview_report', id, {
      ...store.document(actor.tenantId, 'overview_report', id),
      job_id: jobId,
    });
    return {id, job_id: jobId, state: 'queued'};
  }
  async handle(input: JsonObject, actor: Actor): Promise<JsonObject> {
    const store = this.service.store,
      tenant = actor.tenantId;
    store.assertActorActive(actor);
    if (input.action === 'bootstrap') {
      const connections = store.listConnections(tenant);
      return {
        platforms: Object.entries(reportPlatforms).map(([id, p]) => ({
          id,
          ...p,
          native_metrics: nativeMetricExamples[id] ?? [],
          entity_levels: overviewEntityLevels[id] ?? [
            {id: 'campaign', label: 'Campaign / resource', native_type: 'campaign_or_resource'},
          ],
          accounts: connections
            .filter(c => c.gateway === p.gateway && c.enabled)
            .flatMap(c => {
              const kind = id === 'ga4' ? 'properties' : id === 'gsc' ? 'sites' : 'ad_accounts',
                assets = (optional(this.service, tenant, 'website_assets', c.id)?.groups ?? [])
                  .filter((g: JsonObject) => g.kind === kind)
                  .flatMap((g: JsonObject) => g.assets ?? []);
              return c.accounts.map(account => ({
                account_id: account,
                connection_id: c.id,
                label: assets.find((a: JsonObject) => String(a.id).replace(/^act_/, '') === account)?.name ?? account,
                connection_label: c.label,
              }));
            }),
        })),
        metrics: metricDefinitions,
        metric_sources: metricSources,
        objectives: objectiveGroups,
        views: store.documents(tenant, 'overview_view').map(publicRecord),
        templates: store.documents(tenant, 'overview_template').map(publicRecord),
        schedules: store.documents(tenant, 'overview_schedule').map(publicRecord),
        destinations: store.documents(tenant, 'sheets_destination').map(d => ({
          ...d,
          unresolved_delivery: deliveryProjection(unresolvedSheetsDelivery(store, tenant, d.id)),
        })),
        file_destinations: store.documents(tenant, 'report_file_destination'),
        sheets_connections: connections
          .filter(c => c.gateway === sheetsGateway)
          .map(c => ({
            id: c.id,
            label: c.label,
            enabled: c.enabled,
            accounts: c.accounts,
            url_binding_supported: c.scopes.includes('https://www.googleapis.com/auth/spreadsheets'),
          })),
        recommendations:
          'Advisory decisions require objective, target, sufficient data, attribution and currency. No automatic advertising changes.',
        native_metrics_help:
          'Common fields and native numeric fields returned by the provider are retained. Additional native field names can be requested. Compatibility and metric-count limits are enforced by each provider.',
        collection_limits: reportCollectionLimits,
      };
    }
    if (input.action === 'preview_schedule') {
      const schedule = input.id ? store.document(tenant, 'overview_schedule', String(input.id)) : input.schedule;
      if (!schedule) throw new MirrorError('INVALID_SCHEDULE', 'Supply a saved schedule or schedule settings.');
      const config = this.config(input.config ?? schedule.config, actor);
      if (!config.date_range.preset)
        throw new MirrorError('ROLLING_WINDOW_REQUIRED', 'Preview a rolling report window.');
      const occurrences: JsonObject[] = [];
      let after = Date.now();
      for (let i = 0; i < 3; i++) {
        const {at, dst_shifted} = nextScheduleDetail({...schedule, ...(i ? {next_run_at: after} : {})}, after);
        const resolved = resolveReportConfig(config, at);
        occurrences.push({
          delivery_at: new Date(at).toISOString(),
          delivery_timezone: schedule.timezone,
          window_timezone: config.date_range.timezone,
          date_range: resolved.date_range,
          // A nonexistent local time (daylight-saving gap) runs at the first valid time after it.
          ...(dst_shifted ? {dst_shifted: true} : {}),
        });
        after = at;
      }
      return {network_requests: 0, occurrences, destination_id: schedule.destination_id ?? null};
    }
    if (input.action === 'export_status') {
      const e = store.document(tenant, 'overview_export', String(input.id)),
        r = store.document(tenant, 'overview_report', e.report_id);
      this.access(actor, r.config);
      const job = store.job(tenant, e.job_id);
      return {
        ...publicRecord(e),
        state: job.state,
        job: {id: job.id, state: job.state, error: job.error, attempts: job.attempts, available_at: job.available_at},
      };
    }
    if (input.action === 'list') {
      const offset = input.offset ?? 0,
        limit = input.limit ?? 50;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new MirrorError('INVALID_PAGE', 'Use an offset >= 0 and 1–100 report snapshots.');
      const candidates = store.db
        .prepare(
          "SELECT id,revision,json_remove(data,'$.rows','$.checkpoints','$.actor_binding','$.collection_budget.row_counts') AS data,json_array_length(data,'$.rows') AS row_count FROM documents WHERE tenant_id=? AND kind='overview_report' ORDER BY json_extract(data,'$.created_at') DESC,id LIMIT 500 OFFSET ?",
        )
        .all(tenant, offset) as JsonObject[];
      const reports: JsonObject[] = [];
      let scanned = 0;
      for (const candidate of candidates) {
        scanned++;
        const record = {
          ...JSON.parse(candidate.data),
          id: candidate.id,
          revision: candidate.revision,
          row_count: candidate.row_count,
        };
        try {
          this.access(actor, record.config);
        } catch {
          continue;
        }
        reports.push(publicRecord(record));
        if (reports.length >= limit) break;
      }
      const hasMore = scanned < candidates.length || candidates.length === 500;
      return {
        reports,
        offset,
        has_more: hasMore,
        next_offset: hasMore ? offset + scanned : null,
      };
    }
    if (
      ['report_pack', 'save_presentation', 'presentation_profiles', 'apply_profile_presentation'].includes(input.action)
    ) {
      const report = store.document(tenant, 'overview_report', String(input.id));
      this.access(actor, report.config);
      if (input.action === 'presentation_profiles') return presentationProfiles(store, actor, report, input);
      if (input.action === 'apply_profile_presentation') {
        reportPack(report);
        applyProfilePresentation(store, actor, report, input);
      }
      if (input.action === 'save_presentation') {
        reportPack(report);
        savePresentation(store, actor, report.id, input);
      }
      return reportPack(report, retainedPresentation(store, tenant, report.id));
    }
    if (input.action === 'get') {
      const r = store.document(tenant, 'overview_report', String(input.id));
      this.access(actor, r.config);
      const offset = input.offset ?? 0,
        limit = input.limit ?? 100;
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500)
        throw new MirrorError('INVALID_PAGE', 'Use an offset and limit of 1–500 rows.');
      const job = store.job(tenant, r.job_id);
      return {
        ...publicRecord(r),
        rows: r.rows.slice(offset, offset + limit),
        row_count: r.rows.length,
        offset,
        has_more: offset + limit < r.rows.length,
        exports: store
          .documents(tenant, 'overview_export')
          .filter(e => e.report_id === r.id)
          .map(e => ({
            ...publicRecord(e),
            state: store.job(tenant, e.job_id).state,
            error: store.job(tenant, e.job_id).error,
          })),
        // Metadata-only Sheets delivery receipts (manual and scheduled), including unconfirmed ones and their recovery.
        sheets_deliveries: sheetsDeliveriesForReport(store, tenant, r.id, [
          ...unresolvedStates,
          'complete',
          'rejected',
          'abandoned',
        ]).map(deliveryProjection),
        job: {state: job.state, attempts: job.attempts, error: job.error, available_at: job.available_at},
      };
    }
    if (input.action === 'create_spreadsheet') return this.sheets.create(actor, input);
    if (input.action === 'bind_destination') return this.sheets.bind(actor, input);
    writer(store, actor);
    if (input.confirmed !== true)
      throw new MirrorError('CONFIRMATION_REQUIRED', 'Confirm this reporting configuration, run or export.');
    if (input.action === 'save' || input.action === 'save_template')
      return this.library.save(actor, input, input.action === 'save_template');
    if (input.action === 'resolve_delivery') return this.resolveDelivery(actor, input);
    if (input.action === 'delete_report') this.releaseReportDeliveries(actor, String(input.id), input.resolution);
    if (['delete_view', 'delete_template', 'delete_report'].includes(input.action))
      return this.library.delete(
        actor,
        input,
        (
          {
            delete_view: 'overview_view',
            delete_template: 'overview_template',
            delete_report: 'overview_report',
          } as const
        )[input.action as 'delete_view' | 'delete_template' | 'delete_report'],
      );
    if (input.action === 'bind_file_destination') return this.files.bind(actor, input);
    if (input.action === 'update_schedule') return this.library.schedule(actor, input, true);
    if (input.action === 'remove_schedule') return this.library.changeSchedule(actor, input, true);
    if (input.action === 'run') {
      const config = this.config(
        input.config ?? store.document(tenant, 'overview_view', String(input.id)).config,
        actor,
      );
      return store.transaction(() => this.queue(actor, config));
    }
    if (input.action === 'export') {
      const report = store.document(tenant, 'overview_report', String(input.report_id));
      this.access(actor, report.config);
      assertReportExportable(report);
      const destination = reportDestination(store, actor, input.destination_id);
      if (destination.kind === 'report_files') return this.files.queue(actor, report, destination.id);
      const id = sha256(report.id + ':' + input.destination_id),
        prior = optional(this.service, tenant, 'overview_export', id);
      if (prior) return {...publicRecord(prior), state: store.job(tenant, prior.job_id).state};
      return store.transaction(() => {
        const jobId = store.enqueue(tenant, 'sheets_export', {report_id: report.id, export_id: id});
        store.putDocument(tenant, 'overview_export', id, {
          report_id: report.id,
          destination_id: input.destination_id,
          job_id: jobId,
          actor_binding: store.bindJobActor(actor, id),
          state: 'queued',
        });
        return {id, job_id: jobId, state: 'queued'};
      });
    }
    if (input.action === 'schedule') return this.schedule(actor, input);
    if (input.action === 'resume_schedule' || input.action === 'pause_schedule' || input.action === 'delete_schedule')
      return this.library.changeSchedule(actor, input);

    if (input.action === 'retry' || input.action === 'cancel') {
      const job = store.job(tenant, String(input.id));
      if (!['report_overview', 'sheets_export', 'report_file_export'].includes(job.kind))
        throw new MirrorError('INVALID_JOB_KIND', 'Use the dedicated recovery flow for advertising writes.');
      const r = store.document(tenant, 'overview_report', job.input.report_id);
      this.access(actor, r.config);
      if (input.action === 'cancel') {
        store.db
          .prepare(
            "UPDATE jobs SET state='cancelled',lease_until=NULL,lease_token=NULL,updated_at=? WHERE tenant_id=? AND id=? AND state IN ('queued','running')",
          )
          .run(Date.now(), tenant, job.id);
        if (job.kind === 'report_overview')
          store.putDocument(tenant, 'overview_report', r.id, {...r, state: 'cancelled'});
        return {
          id: job.id,
          state: store.job(tenant, job.id).state,
          message: 'No further requests will start. A request already sent may finish.',
        };
      }
      if (!['failed', 'cancelled'].includes(job.state))
        throw new MirrorError('JOB_NOT_RETRYABLE', 'Only failed or cancelled reporting jobs can be retried.');
      if (job.kind === 'report_overview' && r.schedule_id) {
        const schedule = optional(this.service, tenant, 'overview_schedule', r.schedule_id);
        if (!schedule?.is_active || (schedule.definition_version ?? 0) !== (r.schedule_version ?? 0))
          throw new MirrorError(
            'REPORT_DEFINITION_CHANGED',
            'This schedule was changed, paused or deleted. Pull a new report from its current setup.',
          );
      }
      if (job.kind === 'report_overview')
        store.putDocument(tenant, 'overview_report', r.id, {
          ...r,
          state: 'queued',
          actor_binding: store.bindJobActor(actor, r.id),
        });
      else {
        const e = store.document(tenant, 'overview_export', job.input.export_id);
        store.putDocument(tenant, 'overview_export', e.id, {
          ...e,
          actor_binding: store.bindJobActor(actor, e.id),
          state: 'queued',
        });
      }
      store.db
        .prepare(
          "UPDATE jobs SET state='queued',attempts=0,error=NULL,available_at=?,updated_at=? WHERE tenant_id=? AND id=?",
        )
        .run(Date.now(), Date.now(), tenant, job.id);
      return {id: job.id, state: 'queued'};
    }
    throw new MirrorError('INVALID_ARGUMENT', 'Unknown reporting overview action.');
  }
  private schedule(actor: Actor, input: JsonObject) {
    return this.library.schedule(actor, input);
  }
  /**
   * Exit paths for an unconfirmed Sheets delivery (EXP-01): check rereads the tab marker; resend requeues the same
   * report's identical batch after the settle window; abandon is the audited "release tab". Without an unconfirmed
   * delivery, abandon releases a tab whose marker conflicts with AMCP's last confirmed delivery.
   */
  private async resolveDelivery(actor: Actor, input: JsonObject) {
    const store = this.service.store,
      tenant = actor.tenantId;
    if (typeof input.destination_id !== 'string' || !['check', 'resend', 'abandon'].includes(input.resolution))
      throw new MirrorError('INVALID_ARGUMENT', 'Choose a Sheets destination and resolution check, resend or abandon.');
    const destination = store.document(tenant, 'sheets_destination', input.destination_id),
      delivery =
        input.delivery_id !== undefined
          ? optional(this.service, tenant, 'sheets_delivery', String(input.delivery_id))
          : unresolvedSheetsDelivery(store, tenant, destination.id);
    if (input.delivery_id !== undefined && delivery?.destination_id !== destination.id)
      throw new MirrorError('NOT_FOUND', 'Delivery not found for this destination.', {}, 404);
    const report = delivery ? optional(this.service, tenant, 'overview_report', delivery.report_id) : undefined;
    if (report) this.access(actor, report.config);
    if (!delivery) {
      if (input.resolution !== 'abandon')
        throw new MirrorError(
          'NOTHING_TO_RESOLVE',
          'This tab has no unconfirmed delivery. It is ready for the next export.',
          {destination_id: destination.id},
          409,
        );
      return this.sheets.releaseDestination(actor, destination.id);
    }
    if (input.resolution === 'check') return this.sheets.checkDelivery(actor, destination.id, delivery.id);
    if (!unresolvedStates.includes(delivery.state))
      return {state: delivery.state, delivery: deliveryProjection(delivery)};
    if (input.resolution === 'abandon') {
      const abandoned = abandonSheetsDelivery(store, actor, delivery, 'operator_release');
      // The released report's queued retries stop; a running attempt cannot hold the destination lock any more.
      store.db
        .prepare(
          "UPDATE jobs SET state='cancelled',lease_until=NULL,lease_token=NULL,updated_at=? WHERE tenant_id=? AND kind='sheets_export' AND state='queued' AND json_extract(input,'$.export_id')=?",
        )
        .run(Date.now(), tenant, sha256(delivery.report_id + ':' + destination.id));
      return {state: 'abandoned', destination_id: destination.id, delivery: deliveryProjection(abandoned)};
    }
    if (!report)
      throw new MirrorError(
        'REPORT_NOT_FOUND',
        'The original report of this delivery was deleted. Release the tab instead.',
        {delivery_id: delivery.id, destination_id: destination.id},
        409,
      );
    assertSheetsSettled(delivery);
    const exportId = sha256(report.id + ':' + destination.id);
    return store.transaction(() => {
      const current = store.document(tenant, 'sheets_delivery', delivery.id);
      if (!unresolvedStates.includes(current.state) || current.sent_at !== delivery.sent_at)
        throw new MirrorError(
          'DELIVERY_CHANGED',
          'This delivery changed while you reviewed it. Refresh its status first.',
          {state: current.state},
          409,
        );
      const prior = optional(this.service, tenant, 'overview_export', exportId),
        job = prior
          ? store.db.prepare('SELECT state FROM jobs WHERE tenant_id=? AND id=?').get(tenant, prior.job_id)
          : null;
      if ((job as JsonObject | undefined)?.state === 'running')
        throw new MirrorError(
          'EXPORT_BUSY',
          'This report is being delivered now. Check its status again.',
          {retry_after_ms: 5000},
          503,
          true,
        );
      const {id: _, revision, ...history} = current,
        now = Date.now();
      store.putDocument(tenant, 'sheets_delivery', delivery.id, {
        ...history,
        resend_authorized_by: actor.userId,
        resend_authorized_at: now,
      });
      let jobId: string;
      if (prior && job) {
        jobId = prior.job_id;
        store.db
          .prepare(
            "UPDATE jobs SET state='queued',attempts=0,error=NULL,available_at=?,lease_until=NULL,lease_token=NULL,updated_at=? WHERE tenant_id=? AND id=?",
          )
          .run(now, now, tenant, jobId);
      } else jobId = store.enqueue(tenant, 'sheets_export', {report_id: report.id, export_id: exportId});
      store.putDocument(tenant, 'overview_export', exportId, {
        ...(prior ? publicRecord(prior) : {}),
        report_id: report.id,
        destination_id: destination.id,
        job_id: jobId,
        actor_binding: store.bindJobActor(actor, exportId),
        state: 'queued',
      });
      store.appendAudit(tenant, 'export/' + report.id, {
        event: 'google_sheets_delivery_resend_authorized',
        delivery_id: delivery.id,
        report_id: report.id,
        destination_id: destination.id,
        actor: actor.userId,
        unconfirmed_since: current.sent_at ?? null,
        vendor_writes: 0,
      });
      return {
        id: exportId,
        job_id: jobId,
        state: 'queued',
        delivery: deliveryProjection(store.document(tenant, 'sheets_delivery', delivery.id)),
      };
    });
  }
  /** Deleting a snapshot must not strand its destination: an unconfirmed delivery is released (audited) first. */
  private releaseReportDeliveries(actor: Actor, reportId: string, resolution: unknown) {
    const store = this.service.store,
      pending = sheetsDeliveriesForReport(store, actor.tenantId, reportId);
    if (!pending.length) return;
    if (resolution !== 'abandon')
      throw new MirrorError(
        'SHEETS_DELIVERY_UNRESOLVED',
        'This snapshot has an unconfirmed Google Sheets delivery. Confirm releasing its report tab to delete it.',
        {
          report_id: reportId,
          delivery_id: pending[0].id,
          destination_id: pending[0].destination_id,
          unconfirmed_since: pending[0].sent_at ?? null,
          resolution_required: 'abandon',
        },
        409,
      );
    for (const delivery of pending) abandonSheetsDelivery(store, actor, delivery, 'report_deleted');
  }
  private currentReport(tenant: string, id: string) {
    const r = this.service.store.document(tenant, 'overview_report', id);
    if (r.state === 'cancelled') throw new MirrorError('JOB_CANCELLED', 'Report cancelled.');
    if (r.schedule_id) {
      const schedule = this.service.store.document(tenant, 'overview_schedule', r.schedule_id);
      if (!schedule.is_active || (schedule.definition_version ?? 0) !== (r.schedule_version ?? 0))
        throw new MirrorError('JOB_CANCELLED', 'The report schedule was edited, paused or removed.');
    }
    return r;
  }
  tick() {
    const store = this.service.store;
    const owner = randomUUID();
    if (store.acquireLock('report-retention', owner, 3600000)) cleanupReports(store);
    const at = Date.now();
    for (const tenant of store.listTenants())
      for (const s of dueSchedules(store, tenant, 'overview_schedule', at))
        try {
          store.transaction(() => {
            const current = store.document(tenant, 'overview_schedule', s.id);
            if (current.revision !== s.revision) return;
            // A clock re-evaluation is not an occurrence: search the clock again without queuing a run.
            if (s.next_run_reevaluate) {
              store.putDocument(tenant, 'overview_schedule', s.id, {...s, ...reevaluatedOccurrence(s)}, s.revision);
              return;
            }
            // EXP-02: the following occurrence is computed first and can never roll back or pause this due run.
            const following = followingOccurrence(s),
              actor = store.restoreJobActor(tenant, s.id, s.actor_binding),
              run = this.queue(actor, s.config, s.destination_id, s.id, s.next_run_at);
            store.putDocument(
              tenant,
              'overview_schedule',
              s.id,
              {
                ...s,
                ...following,
                last_occurrence_at: s.next_run_at,
                last_report_id: run.id,
                last_run_at: Date.now(),
                error: null,
              },
              s.revision,
            );
          });
        } catch (e) {
          failSchedule(
            store,
            tenant,
            'overview_schedule',
            s,
            e instanceof MirrorError
              ? {code: e.code, message: e.message}
              : {code: 'SCHEDULE_FAILED', message: 'The schedule could not run.'},
          );
        }
  }
  async work(tenant: string, kind: string, input: JsonObject) {
    const store = this.service.store;
    const leaseCheck = () => {
      if (!input.__job_id) return;
      const row = store.db
        .prepare('SELECT state,lease_token,lease_until FROM jobs WHERE tenant_id=? AND id=?')
        .get(tenant, input.__job_id) as JsonObject | undefined;
      if (!row || row.state !== 'running' || row.lease_token !== input.__lease_token || row.lease_until <= Date.now())
        throw new MirrorError('STALE_JOB_LEASE', 'This worker no longer owns the report/export job.', {}, 409);
    };
    leaseCheck();
    if (kind === 'report_file_export') return this.files.work(tenant, input, leaseCheck);
    if (kind === 'media_upload') {
      const review = store.document(tenant, 'media_review', input.review_id),
        actor = store.restoreJobActor(tenant, 'media-job:' + input.review_id, review.actor_binding);
      store.bindActorCheck(actor, leaseCheck);
      const result = await this.service.call(
        'amcp_media',
        {action: 'execute', review_id: input.review_id, idempotency_key: input.review_id, confirmed: true},
        actor,
      );
      if (!result.success) throw new MirrorError(result.error.code, result.error.message, result.error.details);
      return result.data;
    }
    if (kind === 'sheets_export') {
      const e = store.document(tenant, 'overview_export', input.export_id),
        actor = store.restoreJobActor(tenant, e.id, e.actor_binding),
        r = store.document(tenant, 'overview_report', input.report_id);
      store.bindActorCheck(actor, leaseCheck);
      this.access(actor, r.config);
      const result = await this.sheets.write(actor, e.destination_id, r, () => {
        this.currentReport(tenant, r.id);
        this.access(actor, r.config);
      });
      store.putDocument(tenant, 'overview_export', e.id, {...e, ...result, completed_at: Date.now()});
      return result;
    }
    if (kind !== 'report_overview') return this.service.verificationJob(tenant, kind, input);
    let r = store.document(tenant, 'overview_report', input.report_id);
    const actor = store.restoreJobActor(tenant, r.id, r.actor_binding),
      access = () => {
        this.currentReport(tenant, r.id);
        this.access(actor, r.config);
      };
    store.bindActorCheck(actor, () => {
      leaseCheck();
      this.currentReport(tenant, r.id);
    });
    access();
    if (!r.collection_budget && Object.keys(r.checkpoints ?? {}).length) {
      const error = {
        code: 'REPORT_RESTART_REQUIRED',
        message:
          'This older snapshot has no whole-job collection counters. Its retained checkpoints are preserved; start a new snapshot from the saved definition.',
      };
      store.putDocument(tenant, 'overview_report', r.id, {...r, state: 'failed', error});
      throw new MirrorError(error.code, error.message);
    }
    if (
      r.config.source_contract_version !== reportContractVersion &&
      r.config.sources.some((s: JsonObject) => s.platform === 'linkedin')
    ) {
      if (r.collection_budget || Object.keys(r.checkpoints ?? {}).length) {
        const error = {
          code: 'REPORT_RESTART_REQUIRED',
          message:
            'This older LinkedIn snapshot contains collection state from an earlier evidence contract. Its retained evidence is preserved; start a new snapshot from the saved definition.',
        };
        store.putDocument(tenant, 'overview_report', r.id, {...r, state: 'failed', error});
        throw new MirrorError(error.code, error.message);
      }
      r = {...r, config: {...r.config, source_contract_version: reportContractVersion}};
      store.putDocument(tenant, 'overview_report', r.id, r);
    }
    store.journal(tenant, r.id, 'collecting', {report_id: r.id});
    store.putDocument(tenant, 'overview_report', r.id, {...r, state: 'running'});
    const results: JsonObject[] = [];
    let retry: MirrorError | undefined;
    const budget = new ReportCollectionBudget(r.collection_budget, fingerprint(r.config), state => {
      leaseCheck();
      const current = store.document(tenant, 'overview_report', r.id);
      store.putDocument(tenant, 'overview_report', r.id, {...current, collection_budget: state});
    });
    try {
      for (let i = 0; i < r.config.sources.length; i++) {
        access();
        const source = r.config.sources[i],
          key = String(i),
          checkpoint = r.checkpoints?.[key] ?? {};
        if (checkpoint.result) {
          results.push(checkpoint.result);
          continue;
        }
        try {
          const captured = await budget.run(() =>
            collectReportPeriods(
              source,
              r.config.date_range,
              r.config.grain ?? 'total',
              checkpoint,
              async (range, native, save) => {
                budget.nextPeriod();
                const value = await this.native.collect(source, range, actor, native, save);
                budget.rows(key + ':' + range.since + ':' + range.until, value.rows.length);
                return value;
              },
              v => {
                access();
                const current = store.document(tenant, 'overview_report', r.id);
                store.putDocument(tenant, 'overview_report', r.id, {
                  ...current,
                  checkpoints: {...current.checkpoints, [key]: v},
                });
              },
            ),
          );
          access();
          const result = {...captured, source};
          results.push(result);
          r = store.document(tenant, 'overview_report', r.id);
          store.putDocument(tenant, 'overview_report', r.id, {...r, checkpoints: {...r.checkpoints, [key]: {result}}});
          if (captured.collection_limit) {
            const limited = new MirrorError(
              'REPORT_COLLECTION_LIMIT',
              'Collection stopped at the whole-job limit. Narrow the accounts, date window or grouping for a new run.',
            );
            for (const pending of r.config.sources.slice(i + 1))
              results.push({source: pending, rows: [], complete: false, error: reportSourceError(limited, pending)});
            break;
          }
        } catch (e) {
          const diagnostic = reportSourceError(e, source);
          results.push({source, rows: [], complete: false, error: diagnostic});
          if (e instanceof MirrorError && ['REPORT_COLLECTION_LIMIT', 'REPORT_BUDGET_INVALID'].includes(e.code)) {
            for (const pending of r.config.sources.slice(i + 1))
              results.push({source: pending, rows: [], complete: false, error: reportSourceError(e, pending)});
            break;
          }
          if (e instanceof MirrorError && e.retryable) {
            retry = new MirrorError(
              e.code,
              diagnostic.message,
              {
                source: diagnostic,
                ...(e.details.retry_after_ms === undefined ? {} : {retry_after_ms: e.details.retry_after_ms}),
              },
              e.status,
              true,
            );
            break;
          }
        }
      }
    } finally {
      budget.close();
    }
    if (retry) {
      r = store.document(tenant, 'overview_report', r.id);
      store.putDocument(tenant, 'overview_report', r.id, {
        ...r,
        sources: results.map(({rows, metadata, ...data}) => ({...data, row_count: rows.length})),
      });
      throw retry;
    }
    r = store.document(tenant, 'overview_report', r.id);
    access();
    const rows: JsonObject[] = [],
      nativeFields = new Set<string>();
    for (const source of results)
      for (const row of source.rows)
        for (const k of Object.keys(row.metrics)) if (k.startsWith('native_')) nativeFields.add(k);
    // Keep native dependencies accepted by config even when no row reports them. Missing fields evaluate to null;
    // the observed native field inventory must not turn an empty or sparse provider response into a formula error.
    const nativeDependencies = r.config.custom_metrics
      .flatMap((m: JsonObject) => parseMetricFormula(m.formula).dependencies)
      .filter((d: string) => /^native_[a-z][a-zA-Z0-9_]{1,150}$/.test(d));
    const custom = validateCustomMetrics(r.config.custom_metrics, [...nativeFields, ...nativeDependencies]);
    for (const result of results) {
      const seen = new Set<string>();
      for (const row of result.rows) {
        const source = result.source,
          key = [
            source.platform,
            source.account_id,
            ...(row.entity_level ? [row.entity_level] : []),
            row.entity_id ?? row.campaign_id,
          ].join(':'),
          period = row.report_period ?? r.config.date_range,
          context = row.period_context ?? result,
          rowKey = key + ':' + period.since + ':' + period.until;
        if (seen.has(rowKey))
          throw new MirrorError(
            row.entity_level ? 'DUPLICATE_ENTITY_ROWS' : 'DUPLICATE_CAMPAIGN_ROWS',
            row.entity_level
              ? 'The native report contains duplicate entity rows in the same reporting period.'
              : 'The native report contains multiple rows for one campaign. Narrow the report to a campaign total.',
          );
        seen.add(rowKey);
        const objective = source.objective ?? row.objective_group,
          {period_context, report_period, ...nativeRow} = row,
          record = {
            ...nativeRow,
            row_key: rowKey,
            grain: r.config.grain ?? 'total',
            campaign_key: key,
            ...(row.entity_level ? {entity_key: key} : {}),
            platform: source.platform,
            account_id: source.account_id,
            connection_id: source.connection_id,
            currency: row.currency ?? context.currency,
            timezone: context.timezone,
            objective_group: objective,
            objective_source: source.objective ? 'user confirmed' : 'provider',
            date_from: period.since,
            date_to: period.until,
            source_kind: result.source_kind,
            quality: context.quality ?? {version: 0, status: 'unknown'},
            lineage: context.lineage ?? [],
            query_fingerprint: context.query_fingerprint ?? null,
            formula_version: r.config.formula_version ?? 'legacy-unversioned',
            attribution: context.attribution,
            result_definition: context.result_definition,
            complete: result.complete,
            captured_at: result.captured_at,
            metrics: calculateMetrics(row.metrics, custom),
          };
        if (r.config.objectives.length && !r.config.objectives.includes(objective)) continue;
        rows.push({...record, recommendation: campaignRecommendation(record, r.config.targets)});
      }
    }
    const sourceRowCount = results.reduce((n, s) => n + s.rows.length, 0),
      filteredRowCount = sourceRowCount - rows.length;
    const failures = results.filter(s => s.error),
      sources = results.map(({rows: sourceRows, metadata, ...data}) => ({
        ...data,
        row_count: sourceRows.length,
        visible_row_count: rows.filter(
          row =>
            row.platform === data.source.platform &&
            row.account_id === data.source.account_id &&
            row.connection_id === data.source.connection_id,
        ).length,
      })),
      state =
        failures.length === results.length
          ? 'failed'
          : failures.length || results.some(s => !s.complete)
            ? 'partial'
            : 'complete',
      record = {
        ...r,
        state,
        rows,
        sources,
        source_row_count: sourceRowCount,
        filtered_row_count: filteredRowCount,
        empty_reason:
          rows.length || failures.length === results.length
            ? null
            : sourceRowCount
              ? 'objective_filter'
              : 'no_provider_rows',
        completed_at: Date.now(),
        summary: reportSummary(rows, custom),
        native_metrics: [...nativeFields],
        row_count: rows.length,
      };
    store.putDocument(tenant, 'overview_report', r.id, record);
    evaluateMonitors(store, actor, r.id);
    store.journal(tenant, r.id, state === 'failed' ? 'failed' : 'responded', {report_id: r.id, rows: rows.length});
    if (state === 'failed') {
      const reason = failures
        .map(
          s =>
            `${reportPlatforms[s.source.platform]!.name} ${s.source.account_id}: ${s.error.provider?.code ?? s.error.code}`,
        )
        .join('; ');
      throw new MirrorError('REPORT_SOURCES_FAILED', 'None of the selected sources returned a report. ' + reason, {
        sources: failures.map(s => s.error),
      });
    }
    if (r.destination_id) {
      const destination = rows.length ? reportDestination(store, actor, r.destination_id) : null;
      const result = rows.length
        ? destination?.kind === 'report_files'
          ? state === 'partial' && r.config.partial_delivery === 'complete_only'
            ? {
                state: 'skipped',
                reason: 'PARTIAL_DELIVERY_BLOCKED',
                message: 'The snapshot is partial. Its complete-only delivery setting keeps existing files unchanged.',
              }
            : this.files.queue(actor, {...record, id: r.id}, r.destination_id)
          : await this.sheets.write(actor, r.destination_id, {...record, id: r.id}, access)
        : {
            state: 'skipped',
            reason: 'EMPTY_REPORT',
            message: 'No rows to export. Existing files and spreadsheet tabs were left unchanged.',
          };
      store.putDocument(tenant, 'overview_report', r.id, {...record, export: result});
    }
    return {report_id: r.id, state, row_count: rows.length};
  }
}

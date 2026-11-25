import {fingerprint, formulaVersion, reportContractVersion} from './report-quality.js';
import {validateRecommendationContext} from './recommendation-context.js';
import {cleanupReports} from './owner-operations.js';
import {
  dueScheduleTenants,
  dueSchedules,
  failSchedule,
  followingOccurrence,
  recordScheduleDelivery,
  reevaluatedOccurrence,
  sheetsSettleRecheck,
} from './scheduled-work.js';
import {randomUUID} from 'node:crypto';
import type {Actor, JsonObject} from './types.js';
import type {MirrorService} from './service.js';
import type {Store} from './store.js';
import {MirrorError} from './errors.js';
import {reportPollAfterMs} from './workflow-outcomes.js';
import {BACKGROUND_RUN_KIND, backgroundRunTurn} from './campaign-background.js';
import {tool, field, writer} from './workspace-core.js';
import {NativeCampaignReports, nativeMetricExamples, reportRange, type AccountLookupCache} from './report-native.js';
import {assertCollectionEstimate, nativeDailyCollection, sourceRequestModel} from './report-request-estimate.js';
import type {GoogleSheetsExports} from './google-sheets.js';
import {assertReportExportable} from './report-table.js';
import {sheetsDelivery} from './provider-workflows.js';
import {providerById} from './provider-adapters.js';
import {
  metricDefinitions,
  reportMetricDefinitionsV4,
  reportPlatforms,
  objectiveGroups,
  validateCustomMetrics,
  parseMetricFormula,
  metricSources,
  kpiDirection,
  currencyTargetKey,
} from './report-metrics.js';
import {resolveReportConfig, resolveRollingWindow, nextScheduleDetail} from './reporting.js';
import {fixedReportTimezones, reportWindowState, sourceReportTimezone} from './report-windows.js';
import {normalizeAccount} from './scope.js';
import {sha256} from './security.js';
import {optionalClientView} from './client-scope.js';
import {recordWithinAccess} from './access-sets.js';
import {reportSourceError} from './report-errors.js';
import {validateObjectiveFields, objectiveFallbackGroups} from './report-objectives.js';
import {reportSource} from './report-sources.js';
import {
  overviewConfigLimits,
  overviewConfigSchema,
  overviewFilterProperties,
  overviewIncludeFlags,
} from './report-tool-schema.js';
import {filterActive, rowFilters, rowMatches, snapshotFilters} from './report-read-filters.js';
import {cursorBinding, decodeOffsetCursor, encodeOffsetCursor, invalidCursor} from './page-cursor.js';
import {clientView} from './client-scope.js';
import {ReportLibrary} from './report-library.js';
import {migrateWorkbookSchedule, previewWorkbookMigration, revertWorkbookMigration} from './workbook-migration.js';
import {ReportFileDelivery, reportDestination} from './report-file-delivery.js';
import {collectNativeDaily, collectReportPeriods, reportGrains} from './report-periods.js';
import {ReportCollectionBudget, reportCollectionLimits} from './report-collection-budget.js';
import {ReportParts, reportBudgetState, reportBudgetView} from './report-checkpoints.js';
import {
  comparisonCandidates,
  recentFinishedSnapshots,
  recentSnapshotSources,
  snapshotPage,
  snapshotSnapchatCampaigns,
} from './report-repository.js';
import {
  activeReportJobCount,
  cancelJob,
  cancelQueuedSheetsExports,
  jobAttempts,
  jobLease,
  jobState,
  requeueJob,
  retryJob,
  writeClaimed,
} from './job-repository.js';
import {quotaExhausted} from './provider-quota.js';
import {REPORT_JOB_ATTEMPT_LIMIT} from './job-leases.js';
import {evaluateMonitors} from './report-monitors.js';
import {compareSnapshots, comparisonEligibility, comparisonReasons, previousEqualWindow} from './report-compare.js';
import {allocationOutcomeJob, allocationOutcomeKind} from './allocation-outcome.js';
import {writeReconcileKind} from './write-reconcile-job.js';
import {operationsWorkerHealth} from './operations-worker-health.js';
import {overviewEntityLevels, overviewSourceLevel} from './overview-granularity.js';
import {
  overviewConfigV4,
  normalizeOverviewV4Source,
  expandOverviewV4Sources,
  overviewV4Scope,
  overviewV4Sources,
  projectOverviewV4Charts,
  projectOverviewV4Rows,
  projectOverviewV4Sources,
  projectOverviewV4Summaries,
  overviewDefinitionConfig,
  overviewSidecar,
  overviewRollbackSafe,
  publicOverviewDefinition,
  overviewV4ScopeContract,
  overviewV4ScopeIdLimit,
  overviewV4Rules,
} from './overview-v4.js';
import {applyScopedRollups} from './report-scope-rollups.js';
import {calculateSnapshot, duplicateRowsError, snapshotOutcome} from './report-row-assembly.js';
import {reportChartsOrNone} from './report-charts.js';
import {chartKindIds, chartKinds} from './report-chart-spec.js';
import {ensureNoticeRecord, settleNotices, spendNotices} from './report-definition-migration.js';
export {objectiveMigrationNotice} from './report-definition-migration.js';
import {
  reportPack,
  retainedPresentation,
  savePresentation,
  presentationProfiles,
  applyProfilePresentation,
} from './report-packs.js';
// Wave 4c round 6 (w4c-arc6-reporting): the Sheets delivery is the provider workflows registry's, and the Sheets
// gateway its adapter's, so this shared module imports no provider module.
const {
  unresolvedStates,
  unresolvedSheetsDelivery,
  sheetsDeliveriesForReport,
  deliveryProjection,
  assertSheetsSettled,
  abandonSheetsDelivery,
} = sheetsDelivery;
const sheetsGateway = providerById('sheets')!.gateway;
export const overviewPollAfterMs = reportPollAfterMs;
export const overviewTool = tool(
  'amcp_reporting_overview',
  'Use this for saved client reports across platforms and accounts, their schedules and Sheets or retained-file exports; to analyse one captured native report, use amcp_reporting. It reads native reports and saves AMCP records; it never changes an advertising account. Start with bootstrap: the accounts you may use, each platform’s levels, option names and defaults (platforms[].entity_levels and platforms[].reporting_v4), metrics, objectives, and your saved reports (views), templates, schedules and destinations. Unset source options take the defaults it lists. run queues a bounded native snapshot of a saved report (id) or a config and returns estimated_requests, a next_call and poll_after_ms; poll get (1–500 rows a page) until it is final; get narrows its rows by platform, level, entity or query, list narrows the snapshots by client, platform or state, and a narrowed read continues by its next_cursor. Recommendations are advisory, frozen at capture, valid for 48 hours and held back for partial or insufficient data. compare reads two retained snapshots and sends no provider request; report_pack gives summaries, evidence and PDF/XLSX downloads. export replaces only an AMCP-owned Google Sheets tab (retries never append duplicate rows) or writes retained files; schedule creates a recurring delivery of a saved report. Every action that saves, deletes, runs, exports, schedules, retries, cancels or resolves a delivery needs confirmed:true and the operator role (create_spreadsheet: admin); editing or deleting a saved report, template or schedule also needs its expected_revision. Missing metrics stay null. Each action’s arguments, limits and rules: this tool with action:"help" and topic:<action>; the workflow guide: amcp_workspace {action:"help",topic:"guides/reporting-overview"}.',
  [
    'help',
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
    'preview_workbook_move',
    'move_workbook_schedule',
    'undo_workbook_move',
    'compare',
    'compare_candidates',
  ],
  {
    topic: {type: 'string', maxLength: 300},
    id: field.id,
    baseline_id: field.id,
    compare: {type: 'string', enum: ['previous_period']},
    view_id: field.id,
    expected_revision: {type: 'integer', minimum: 1},
    expected_view_revision: {type: 'integer', minimum: 1},
    presentation_revision: {type: 'integer', minimum: 0},
    presentation: field.object,
    profile_id: field.id,
    profile_revision: {type: 'integer', minimum: 1},
    config: overviewConfigSchema(),
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
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 500,
      description: '1–100 for list actions; get and compare up to 500; see action help.',
    },
    include: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(overviewIncludeFlags.map(flag => [flag, field.bool])),
    },
    ...overviewFilterProperties(),
    delivery_id: field.id,
    resolution: {type: 'string', enum: ['check', 'resend', 'abandon']},
    move_version: field.id,
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
const recordWithBudget = (r: JsonObject, budget: JsonObject | undefined) => {
  const {actor_binding, checkpoints, collection_budget, ...visible} = r;
  if (!budget) return visible;
  const {row_counts, active_since, ...usage} = budget;
  return {...visible, collection_budget: usage};
};
const publicRecord = (r: JsonObject) => recordWithBudget(r, r.collection_budget);
/** A saved report, template or schedule as a client reads it: one form of the definition, never both (F-L6-05). */
const publicDefinition = (r: JsonObject) => publicRecord(publicOverviewDefinition(r));
/**
 * Whether a saved report, template or schedule is listed to this actor, as bootstrap lists them (SEC-08): every one
 * without a client access set; with one, only a record each of whose sources resolves within the set. The website's
 * workspace search (WEB-09, server/workspace-search.ts) lists saved reports by this same rule.
 */
export function overviewRecordListed(store: Store, actor: Actor, record: JsonObject): boolean {
  if (actor.accessSetId === undefined) return true;
  try {
    store.assertActorActive(actor);
    for (const s of (overviewDefinitionConfig(record) ?? {sources: []}).sources)
      store.resolveConnection(actor, reportPlatforms[s.platform]!.gateway, s.account_id, s.connection_id);
    return true;
  } catch (e) {
    if (e instanceof MirrorError) return false;
    throw e;
  }
}
/** A report snapshot with its collection counters read from wherever they are kept (OPS-08 split layout). */
const publicReport = (store: Store, tenant: string, r: JsonObject) =>
  recordWithBudget(r, reportBudgetView(store, tenant, r));
/**
 * EXP-03 A: what happened at the destination. A complete job that wrote nothing (a newer snapshot already holds the
 * tab, or the delivery policy skipped it) reports that outcome; `state` keeps the job state for existing clients.
 */
export const exportOutcome = (e: JsonObject, job: JsonObject) =>
  job.state === 'complete' && ['superseded', 'skipped'].includes(e.state) ? e.state : job.state;
/** Failures that repeat identically on every retry; their jobs offer no Retry (EXP-03 C). */
export const deterministicJobErrors = new Set([
  // AMCP_SHEETS_AUTO_RESEND=off: the operator's resend (resolve_delivery) requeues the job, not Retry.
  'SHEETS_RESEND_CONFIRMATION_REQUIRED',
  'PARTIAL_DELIVERY_BLOCKED',
  'DESTINATION_OWNED_BY_OTHER_REPORT',
  'SHEETS_DELIVERY_ABANDONED',
  'IDEMPOTENCY_CONFLICT',
  'EMPTY_REPORT',
  'REPORT_NOT_READY',
  'EXPORT_TOO_LARGE',
  'REPORT_DEFINITION_CHANGED',
  'REPORT_RESTART_REQUIRED',
  'REPORT_FILE_SOURCE_CHANGED',
  'INVALID_FILE_EXPORT',
  'JOB_CANCELLED',
]);
export const jobRetryAvailable = (job: JsonObject) =>
  job.state === 'cancelled' || (job.state === 'failed' && !deterministicJobErrors.has(job.error?.code));
/**
 * A Sheets export that failed on a tab whose delivery marker conflicts with AMCP's records (SHEETS_MARKER_MISMATCH, or
 * SHEET_OWNERSHIP_CONFLICT with conflicting markers) fails the same way on every retry until the tab is released.
 * Retry is offered again once the tab was released after the failure (EXP-03 review).
 */
const releaseFirstErrors = new Set(['SHEETS_MARKER_MISMATCH', 'SHEET_OWNERSHIP_CONFLICT']);
const jobProjection = (job: JsonObject) => ({
  id: job.id,
  state: job.state,
  error: job.error,
  attempts: job.attempts,
  available_at: job.available_at,
  retry_available: jobRetryAvailable(job),
});
/** Complete-only snapshots are refused before any job exists, for files and Sheets alike (EXP-03 C). */
function assertDeliveryPolicy(report: JsonObject) {
  if (report.state === 'partial' && report.config?.partial_delivery === 'complete_only')
    throw new MirrorError(
      'PARTIAL_DELIVERY_BLOCKED',
      'This report delivers complete snapshots only. Review its failed or limited sources; no export was created and the destination is unchanged.',
      {report_id: report.id},
      409,
    );
}
const linkedinEvidenceContracts = ['campaign-source-v3', reportContractVersion];
/** A source whose retained collection state belonged to an earlier platform contract is collected again (F-L5-16). */
const sourceRestartedWarning =
  'This source was collected again from its start, because the collection state kept for it belonged to an earlier platform contract.';
/** A collected snapshot is never collected or re-stamped again (EXP-03 D). */
const finishedSnapshot = (r: JsonObject) =>
  ['complete', 'partial'].includes(r.state) && typeof r.completed_at === 'number';
const platformContracts = (config: JsonObject): Record<string, string> => ({
  ...Object.fromEntries(
    config.sources.flatMap((source: JsonObject) => {
      const stamp = reportSource(source.platform)?.contract?.stamp;
      return stamp ? [[source.platform, stamp]] : [];
    }),
  ),
  ...(config.contract_version === overviewConfigV4 ? {overview_config: overviewConfigV4} : {}),
});
/** Rollback switches (EXP-03): ownership refusal (B) and the separate scheduled Sheets delivery job (D). */
export const destinationOwnershipEnforced = () => process.env.AMCP_SHEETS_DESTINATION_OWNERSHIP !== 'off';
export const scheduledSheetsInline = () => process.env.AMCP_SCHEDULED_SHEETS_DELIVERY === 'inline';
const accountSet = (config: JsonObject) =>
  [
    ...new Set(
      (config?.sources ?? []).map(
        (s: JsonObject) => String(s.platform) + ':' + String(s.account_id ?? '').replace(/^act_/, ''),
      ),
    ),
  ].sort() as string[];
/**
 * EXP-03 B: the report that owns a Google Sheets tab. An active schedule owns its tab; otherwise every saved report
 * that delivers to it does. An unowned tab accepts any snapshot.
 */
export function destinationOwners(
  store: Store,
  tenant: string,
  destinationId: string,
  // Bootstrap passes the loaded records once for all destinations.
  records = {schedules: store.documents(tenant, 'overview_schedule'), views: store.documents(tenant, 'overview_view')},
) {
  const schedule = records.schedules.find(s => s.is_active && s.destination_id === destinationId);
  const owners = schedule
    ? [{kind: 'schedule', schedule_id: schedule.id, view_id: schedule.view_id ?? null, config: schedule.config}]
    : records.views
        .filter(v => v.destination_id === destinationId)
        .map(v => ({kind: 'view', schedule_id: v.schedule_id ?? null, view_id: v.id, config: v.config}));
  return owners.map(o => ({
    kind: o.kind,
    schedule_id: o.schedule_id,
    view_id: o.view_id,
    name: String(o.config?.name ?? ''),
    client_name: String(o.config?.client_name ?? ''),
    accounts: accountSet(o.config),
  }));
}
/** A snapshot may use an owned tab when it comes from the owning schedule or report, or covers the same accounts. */
export function ownsDestination(report: JsonObject, owners: JsonObject[]) {
  if (!owners.length) return true;
  const accounts = JSON.stringify(accountSet(report.config));
  return owners.some(
    o =>
      (o.schedule_id && report.schedule_id === o.schedule_id) ||
      (o.view_id && report.view_id === o.view_id) ||
      JSON.stringify(o.accounts) === accounts,
  );
}
export class ReportingOverview {
  readonly native: NativeCampaignReports;
  readonly sheets: GoogleSheetsExports;
  readonly library: ReportLibrary;
  readonly files: ReportFileDelivery;
  /** What the last failed tick of each schedule that stayed on was (its occurrence and error code), so tick records it once. */
  private readonly tickFailures = new Map<string, string>();
  constructor(
    readonly service: MirrorService,
    fetcher: typeof fetch = fetch,
  ) {
    this.native = new NativeCampaignReports(service);
    this.sheets = sheetsDelivery.exports(service.store, fetcher);
    this.library = new ReportLibrary(
      service.store,
      (c, a, t, legacy) => this.config(c, a, t, legacy),
      (a, c) => this.access(a, c),
    );
    this.files = new ReportFileDelivery(
      service.store,
      (a, c) => this.access(a, c),
      (t, id) => this.currentReport(t, id),
      (tenant, report) => spendNotices(service.store, tenant, report),
    );
  }
  config(input: JsonObject, actor: Actor, template = false, legacyTargets = false): JsonObject {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      typeof input.name !== 'string' ||
      !input.name.trim() ||
      input.name.length > overviewConfigLimits.name
    )
      throw new MirrorError('INVALID_REPORT', 'Name this report (1–100 characters).');
    if (
      !Array.isArray(input.sources) ||
      (!template && !input.sources.length) ||
      input.sources.length > overviewConfigLimits.sources
    )
      throw new MirrorError('REPORT_SOURCES_REQUIRED', 'Choose between 1 and 30 platform accounts.');
    const seen = new Set<string>();
    input = structuredClone(input);
    // Explicit v4 during staged integration; old snapshots and legacy execution retain their existing boundary.
    const v4 =
      input.contract_version === overviewConfigV4 ||
      input.sources.some((source: JsonObject) => source?.levels !== undefined) ||
      Object.values(input.source_defaults ?? {}).some((source: any) => source?.levels !== undefined);
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
      validateObjectiveFields(s);
      if (v4) {
        Object.assign(s, normalizeOverviewV4Source(s, reportSource(s.platform)!.overview!));
        delete s.objective;
      } else delete s.reporting_contract;
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
      Object.keys(defaults).some(p => !Object.hasOwn(reportPlatforms, p))
    )
      throw new MirrorError('INVALID_REPORT_SOURCE', 'Template defaults must name supported reporting platforms.');
    for (const d of Object.values(defaults) as JsonObject[]) {
      if (
        !d ||
        typeof d !== 'object' ||
        Array.isArray(d) ||
        Object.keys(d).some(
          k =>
            ![
              'objective',
              'objective_fallback',
              'native_metrics',
              'level',
              'report_options',
              ...(v4 ? ['levels', 'statuses', 'delivered_only'] : []),
            ].includes(k),
        ) ||
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
      validateObjectiveFields(d);
    }
    for (const [platform, value] of Object.entries(defaults)) {
      if (v4) {
        const normalized = normalizeOverviewV4Source(
            {platform, ...(value as JsonObject)},
            reportSource(platform)!.overview!,
          ),
          fields = [
            'objective_fallback',
            'native_metrics',
            'level',
            'levels',
            'report_options',
            'statuses',
            'delivered_only',
          ];
        defaults[platform] = Object.fromEntries(
          fields.filter(key => normalized[key] !== undefined).map(key => [key, normalized[key]]),
        );
      } else overviewSourceLevel({platform, ...(value as JsonObject)}, true);
    }
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
    const custom = validateCustomMetrics(input.custom_metrics, [
        ...nativeNames,
        ...(v4 ? ['primary_result', 'cost_per_result'] : []),
      ]),
      known = new Set([
        ...Object.keys(metricDefinitions),
        ...custom.map(m => m.id),
        ...(v4 ? ['primary_result', 'cost_per_result'] : []),
      ]);
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
    for (const [key, p] of Object.entries(policies) as [string, JsonObject][]) {
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
      // DEC-01: a currency-specific objective target is keyed "<objective>:<CURRENCY>" and must use that currency.
      const currencyKey = currencyTargetKey.exec(key);
      if (currencyKey && (!objectiveGroups.includes(currencyKey[1]!) || p.currency !== currencyKey[2]))
        throw new MirrorError(
          'INVALID_TARGET',
          'Key a currency target as objective:CURRENCY, for example sales:SAR, with the same target currency.',
          {field: 'targets.' + key},
        );
      // DEC-01: a KPI without a derivable direction (custom, native or additive metric) must declare one. A saved
      // definition that predates this rule still runs, and its recommendations return needs_review until edited.
      if (!legacyTargets && p.kpi !== undefined && p.direction === undefined && !kpiDirection(p.kpi))
        throw new MirrorError(
          'INVALID_TARGET',
          'Set direction to higher or lower for this KPI; its better direction cannot be derived.',
          {field: 'targets.' + key + '.direction', kpi: p.kpi},
        );
      if (
        p.minimum_spend !== undefined &&
        (typeof p.minimum_spend !== 'number' || !Number.isFinite(p.minimum_spend) || p.minimum_spend < 0)
      )
        throw new MirrorError('INVALID_TARGET', 'Use a nonnegative minimum spend in the target currency.', {
          field: 'targets.' + key + '.minimum_spend',
        });
    }
    if (input.partial_delivery !== undefined && !['allow_marked', 'complete_only'].includes(input.partial_delivery))
      throw new MirrorError('INVALID_REPORT', 'Choose marked partial delivery or complete reports only.');
    // V2-EXP-01: which charts the report leaves out. A setting of the current form only, kept in the v4 definition (the
    // form the build before V2 reads has none), and stored the way it is meant: sorted, without repeats, absent when empty.
    let charts: JsonObject | undefined;
    if (input.charts !== undefined) {
      const setting = input.charts;
      if (!v4)
        throw new MirrorError(
          'INVALID_REPORT',
          'Chart settings belong to the current report form: send contract_version overview-config-v4.',
        );
      if (
        !setting ||
        typeof setting !== 'object' ||
        Array.isArray(setting) ||
        Object.keys(setting).some(key => key !== 'disabled') ||
        !Array.isArray(setting.disabled) ||
        setting.disabled.some((kind: unknown) => typeof kind !== 'string' || !chartKindIds.includes(kind))
      )
        throw new MirrorError('INVALID_REPORT', 'Use charts.disabled with chart kinds from the list in bootstrap.', {
          chart_kinds: chartKindIds,
        });
      const disabled = [...new Set<string>(setting.disabled)].sort();
      if (disabled.length) charts = {disabled};
    }
    return {
      ...(v4 ? {contract_version: overviewConfigV4} : {}),
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
      ...(charts ? {charts} : {}),
      version: 1,
    };
  }
  access(actor: Actor, config: JsonObject) {
    this.service.store.assertActorActive(actor);
    for (const s of config.sources)
      this.service.store.resolveConnection(actor, reportPlatforms[s.platform]!.gateway, s.account_id, s.connection_id);
  }
  /**
   * RPT-07: the campaigns of the newest finished snapshot (among the 50 newest) with a campaign-level Snapchat source
   * for this login and account, offered as parent choices for ad-squad detail. Only snapshots the actor can read are
   * used; nothing is read from the provider, and a choice still passes the collector's exact parent checks.
   */
  private parentCampaigns(actor: Actor, connectionId: string, account: string) {
    const store = this.service.store,
      tenant = actor.tenantId,
      uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const candidates = recentFinishedSnapshots(store, tenant);
    for (const candidate of candidates) {
      let config: JsonObject;
      try {
        config = JSON.parse(String(candidate.config));
        if (
          !Array.isArray(config?.sources) ||
          !config.sources.some(
            (s: JsonObject) =>
              s?.platform === 'snapchat' &&
              s.connection_id === connectionId &&
              String(s.account_id) === account &&
              (s.level ?? 'campaign') === 'campaign',
          )
        )
          continue;
        this.access(actor, config);
      } catch {
        continue;
      }
      const campaigns = new Map<string, string | null>();
      for (const row of snapshotSnapchatCampaigns(store, tenant, candidate.id, connectionId, account))
        if (typeof row.id === 'string' && uuid.test(row.id) && !campaigns.has(row.id))
          campaigns.set(row.id, typeof row.name === 'string' ? row.name.slice(0, 200) : null);
      if (!campaigns.size) continue;
      return {
        snapshot_id: candidate.id,
        completed_at: Number(candidate.completed_at),
        campaigns: [...campaigns].slice(0, 200).map(([id, name]) => ({id, name})),
      };
    }
    return null;
  }
  queue(
    actor: Actor,
    config: JsonObject,
    destinationId?: string,
    scheduleId?: string,
    at = Date.now(),
    viewId?: string,
    // RPT-07: the comparison link of a previous-period pair.
    extra: JsonObject = {},
  ) {
    const store = this.service.store;
    this.access(actor, config);
    // Retryable: the queue drains as its jobs finish (r25-mf-jobs 2), so a schedule that meets it is tried again.
    if (activeReportJobCount(store, actor.tenantId) >= 100)
      throw new MirrorError(
        'REPORT_QUEUE_FULL',
        'This workspace already has 100 active reporting jobs.',
        {},
        400,
        true,
      );
    const id = randomUUID();
    // A new snapshot has no collection state, so it always starts under the current source contract (RPT-03), even
    // when a schedule or saved report was defined under an older one.
    config = {...resolveReportConfig(config, at), source_contract_version: reportContractVersion};
    // RPT-03: a configuration whose minimum request count exceeds the whole-job budget is refused before any egress.
    const estimate = assertCollectionEstimate(config);
    const platform_contracts = platformContracts(config);
    // The notes a snapshot carries are decided when it is recorded. Here the saved report's notice record is made if it is
    // new, which reads History once; a later run finds it and reads nothing (F-L6-07).
    ensureNoticeRecord(store, actor.tenantId, viewId, scheduleId);
    store.putDocument(actor.tenantId, 'overview_report', id, {
      config,
      platform_contracts,
      estimated_requests: estimate.estimated_requests,
      state: 'queued',
      captured_at: at,
      created_at: Date.now(),
      rows: [],
      sources: [],
      actor_binding: store.bindJobActor(actor, id),
      destination_id: destinationId ?? null,
      schedule_id: scheduleId ?? null,
      // The saved report a run comes from; it lets that report's own snapshots use its owned tab (EXP-03 B).
      view_id: viewId ?? null,
      schedule_version: scheduleId
        ? (store.document(actor.tenantId, 'overview_schedule', scheduleId).definition_version ?? 0)
        : null,
      checkpoints: {},
      ...extra,
      ...(config.contract_version === overviewConfigV4 ? {scope_contract: overviewV4ScopeContract} : {}),
    });
    const jobId = store.enqueue(actor.tenantId, 'report_overview', {report_id: id});
    store.putDocument(actor.tenantId, 'overview_report', id, {
      ...store.document(actor.tenantId, 'overview_report', id),
      job_id: jobId,
    });
    return {
      id,
      job_id: jobId,
      state: 'queued',
      estimated_requests: estimate.estimated_requests,
      next_call: {tool: overviewTool.name, arguments: {action: 'get', id, limit: 1}},
      poll_after_ms: overviewPollAfterMs,
    };
  }
  async handle(input: JsonObject, actor: Actor): Promise<JsonObject> {
    const store = this.service.store,
      tenant = actor.tenantId;
    store.assertActorActive(actor);
    if (input.action === 'bootstrap') {
      // Accounts within current access (SEC-08: a client access set narrows them); profile_id, the working client,
      // narrows them further to the accounts that client profile binds. Neither grants anything.
      const client = optionalClientView(store, actor, input.profile_id),
        connections = store.connectionsFor(actor),
        ofClient = (gateway: string, account: string, connection: string) =>
          !client || client.has(gateway, account, connection),
        // A credential limited to a client access set sees only saved reports and schedules within it.
        reachable = (record: JsonObject) => overviewRecordListed(store, actor, record),
        ownerRecords = {
          schedules: store.documents(tenant, 'overview_schedule').filter(reachable),
          views: store.documents(tenant, 'overview_view').filter(reachable),
        },
        templates = store.documents(tenant, 'overview_template').filter(reachable);
      return {
        platforms: Object.entries(reportPlatforms).map(([id, p]) => ({
          id,
          ...p,
          native_metrics: nativeMetricExamples[id] ?? [],
          // The rules of a source of this platform, from its report source (src/overview-v4.ts overviewV4Rules): the one
          // shape the website and an MCP client read.
          reporting_v4: {
            ...overviewV4Rules(reportSource(id)?.overview),
            requires_complete_window_declaration: reportSource(id)?.requiresCompleteWindowDeclaration === true,
          },
          request_model: sourceRequestModel(id),
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
              return c.accounts
                .filter(account => ofClient(c.gateway, account, c.id))
                .map(account => ({
                  account_id: account,
                  connection_id: c.id,
                  label: assets.find((a: JsonObject) => String(a.id).replace(/^act_/, '') === account)?.name ?? account,
                  connection_label: c.label,
                  // RPT-07: Snapchat ad-squad detail names its exact parent campaign; offer the retained ones.
                  ...(id === 'snapchat' ? {parent_campaigns: this.parentCampaigns(actor, c.id, account)} : {}),
                }));
            }),
        })),
        ...(client ? {client: {profile_id: client.profile_id, name: client.name}} : {}),
        metrics: metricDefinitions,
        metrics_v4: reportMetricDefinitionsV4,
        metric_sources: metricSources,
        objectives: objectiveGroups,
        objective_fallback_groups: objectiveFallbackGroups,
        // V2-EXP-01: the charts a report can switch off (config.charts.disabled), so the editor keeps no list of its own.
        chart_kinds: chartKinds,
        views: ownerRecords.views.map(publicDefinition),
        templates: templates.map(publicDefinition),
        schedules: ownerRecords.schedules.map(publicDefinition),
        // How many stored definitions stop on the build before V2 (Work-here) if production is rolled back (F-L10-11).
        rollback: {
          unsafe_definitions: [...ownerRecords.views, ...templates, ...ownerRecords.schedules].filter(
            record => !overviewRollbackSafe(record),
          ).length,
        },
        destinations: store
          .documents(tenant, 'sheets_destination')
          // A report tab of a spreadsheet outside a client access set stays out, as reportDestination refuses it.
          .filter(
            d =>
              actor.accessSetId === undefined ||
              recordWithinAccess(actor, connections, {connection_id: d.connection_id, account_id: d.spreadsheet_id}),
          )
          .map(d => ({
            ...d,
            unresolved_delivery: deliveryProjection(unresolvedSheetsDelivery(store, tenant, d.id)),
            // The owning report(s) of the tab and the capture time of the snapshot it holds (EXP-03 A/B).
            last_captured_at: d.last_captured_at ?? null,
            last_report_id: d.last_report_id ?? null,
            owners: destinationOwnershipEnforced() ? destinationOwners(store, tenant, d.id, ownerRecords) : [],
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
        // What a definition may hold: the sources it names and the native IDs of each scope list (the input schema’s limits).
        config_limits: {sources: overviewConfigLimits.sources, ids_per_scope: overviewV4ScopeIdLimit},
      };
    }
    if (input.action === 'preview_schedule') {
      const schedule = input.id ? store.document(tenant, 'overview_schedule', String(input.id)) : input.schedule;
      if (!schedule) throw new MirrorError('INVALID_SCHEDULE', 'Supply a saved schedule or schedule settings.');
      const config = this.config(
        input.config ?? overviewDefinitionConfig(schedule),
        actor,
        false,
        input.config === undefined,
      );
      if (!config.date_range.preset)
        throw new MirrorError('ROLLING_WINDOW_REQUIRED', 'Preview a rolling report window.');
      const occurrences: JsonObject[] = [],
        observed = this.observedTimezones(tenant);
      let after = Date.now();
      for (let i = 0; i < 3; i++) {
        const {at, dst_shifted} = nextScheduleDetail({...schedule, ...(i ? {next_run_at: after} : {})}, after);
        const resolved = resolveReportConfig(config, at);
        occurrences.push({
          delivery_at: new Date(at).toISOString(),
          delivery_timezone: schedule.timezone,
          window_timezone: config.date_range.timezone,
          source_timezone: resolved.date_range_rule?.source_timezone ?? config.date_range.source_timezone ?? 'report',
          date_range: resolved.date_range,
          // RPT-02: when each source's window closes in its own day boundary; open sources make the snapshot partial.
          sources: config.sources.map((s: JsonObject) => {
            const fixed = fixedReportTimezones[s.platform],
              zone = fixed ?? observed.get(s.platform + ':' + s.account_id) ?? null,
              dates =
                resolved.date_range_rule && zone && (fixed || resolved.date_range_rule.source_timezone === 'account')
                  ? resolveRollingWindow(resolved.date_range_rule, at, zone)
                  : resolved.date_range,
              state = reportWindowState(dates, zone, at);
            return {
              platform: s.platform,
              account_id: s.account_id,
              timezone: zone,
              timezone_basis: fixed ? 'provider_fixed' : zone ? 'last_observed' : 'unknown',
              date_range: dates,
              window_closes_at: state.closes_at,
              open_at_delivery: state.open,
            };
          }),
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
      const job = store.job(tenant, e.job_id),
        releaseRequired = this.releaseRequired(tenant, job, e.destination_id),
        retryAvailable = jobRetryAvailable(job) && !releaseRequired;
      return {
        ...publicRecord(e),
        state: job.state,
        outcome: exportOutcome(e, job),
        retry_available: retryAvailable,
        ...(releaseRequired ? {release_required: true} : {}),
        job: jobProjection(job),
        ...(['queued', 'running'].includes(job.state)
          ? {
              next_call: {tool: overviewTool.name, arguments: {action: 'export_status', id: e.id}},
              poll_after_ms: overviewPollAfterMs,
            }
          : job.state === 'failed' && retryAvailable
            ? {
                next_call: {
                  tool: overviewTool.name,
                  arguments: {action: 'retry', id: job.id},
                  add_after_user_approval: {confirmed: true},
                },
              }
            : {}),
      };
    }
    if (input.action === 'list') {
      const requested = input.offset ?? 0,
        limit = input.limit ?? 50;
      if (!Number.isSafeInteger(requested) || requested < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new MirrorError('INVALID_PAGE', 'Use an offset >= 0 and 1–100 report snapshots.');
      // V2-MCP-02: client, platform and state narrow the snapshots the caller may already read, and only those.
      const filters = snapshotFilters(input),
        filtered = filterActive(filters),
        working = filters.client === undefined ? undefined : clientView(store, actor, filters.client),
        start = this.readStart(actor, input, filtered, {action: 'list', limit, ...filters}, 'overview list'),
        offset = start.offset;
      // RPT-05: the whole-window summary (with its sparkline series) is returned by get, not by every list page.
      const candidates = snapshotPage(store, tenant, offset);
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
        // Only after the access check, so a filter never reads or reveals a snapshot the caller may not.
        const sources: JsonObject[] = Array.isArray(record.config?.sources) ? record.config.sources : [];
        if (
          (filters.state !== undefined && record.state !== filters.state) ||
          (filters.platform !== undefined && !sources.some(source => source.platform === filters.platform)) ||
          (working &&
            !sources.every(source =>
              working.has(reportPlatforms[source.platform]?.gateway, source.account_id, source.connection_id),
            ))
        )
          continue;
        reports.push(publicReport(store, tenant, record));
        if (reports.length >= limit) break;
      }
      const hasMore = scanned < candidates.length || candidates.length === 500;
      if (!filtered)
        return {
          reports,
          offset,
          has_more: hasMore,
          next_offset: hasMore ? offset + scanned : null,
        };
      // A narrowed list continues by a cursor bound to the caller and to every argument of the read.
      const cursor = hasMore ? encodeOffsetCursor(start.binding!, offset + scanned) : null;
      return {
        reports,
        offset,
        has_more: hasMore,
        next_offset: null,
        next_cursor: cursor,
        ...(cursor
          ? {next_call: {tool: overviewTool.name, arguments: {action: 'list', limit, ...filters, cursor}}}
          : {}),
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
      if (
        input.include !== undefined &&
        (!input.include ||
          typeof input.include !== 'object' ||
          Array.isArray(input.include) ||
          Object.entries(input.include).some(
            ([key, value]) => !overviewIncludeFlags.includes(key) || typeof value !== 'boolean',
          ))
      )
        throw new MirrorError('INVALID_REPORT', 'Use native, lineage and charts include flags set to true or false.');
      const r = store.document(tenant, 'overview_report', String(input.id));
      this.access(actor, r.config);
      const requested = input.offset ?? 0,
        limit = input.limit ?? 100;
      if (!Number.isInteger(requested) || requested < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500)
        throw new MirrorError('INVALID_PAGE', 'Use an offset and limit of 1–500 rows.');
      // V2-MCP-02: platform, level, entity and query narrow the rows of a snapshot the caller may already read.
      const filters = rowFilters(input),
        filtered = filterActive(filters),
        start = this.readStart(
          actor,
          input,
          filtered,
          {
            action: 'get',
            id: String(input.id),
            limit,
            include: Object.fromEntries(overviewIncludeFlags.map(flag => [flag, input.include?.[flag] === true])),
            ...filters,
          },
          'overview get',
        ),
        offset = start.offset,
        matched: JsonObject[] = filtered ? r.rows.filter((row: JsonObject) => rowMatches(row, filters)) : r.rows,
        more = offset + limit < matched.length,
        cursor = filtered && more ? encodeOffsetCursor(start.binding!, offset + limit) : null;
      const job = store.job(tenant, r.job_id),
        now = Date.now(),
        active = ['queued', 'running'].includes(job.state),
        // V2-EXP-01: the charts are stored with the snapshot and returned when asked for (include: {charts: true}): a
        // plain get of a three-level report stays under a third of the bytes of the three single-level gets it replaces.
        {charts: _stored, ...visible} = publicReport(store, tenant, r);
      return {
        ...visible,
        ...projectOverviewV4Summaries(r),
        ...(input.include?.charts === true ? projectOverviewV4Charts(r, this.chartBaseline(actor, r)) : {}),
        rows: projectOverviewV4Rows(r, matched.slice(offset, offset + limit), input.include),
        sources: projectOverviewV4Sources(r, input.include),
        row_count: r.rows.length,
        // The paging fields every AMCP list carries (MCP-07): total, has_more and next_offset while it is true.
        total: matched.length,
        offset,
        has_more: more,
        // A narrowed read has no offset to misapply: it continues by its cursor, bound to the caller and every argument.
        next_offset: !filtered && more ? offset + limit : null,
        ...(filtered
          ? {
              matched_row_count: matched.length,
              filter: filters,
              next_cursor: cursor,
              ...(cursor
                ? {
                    next_call: {
                      tool: overviewTool.name,
                      arguments: {
                        action: 'get',
                        id: String(input.id),
                        limit,
                        ...(input.include === undefined ? {} : {include: input.include}),
                        ...filters,
                        cursor,
                      },
                    },
                  }
                : {}),
            }
          : {}),
        exports: store
          .documents(tenant, 'overview_export')
          .filter(e => e.report_id === r.id)
          .map(e => {
            const exportJob = store.job(tenant, e.job_id);
            return {
              ...publicRecord(e),
              state: exportJob.state,
              outcome: exportOutcome(e, exportJob),
              error: exportJob.error,
              retry_available:
                jobRetryAvailable(exportJob) && !this.releaseRequired(tenant, exportJob, e.destination_id),
              ...(this.releaseRequired(tenant, exportJob, e.destination_id) ? {release_required: true} : {}),
            };
          }),
        // Metadata-only Sheets delivery receipts (manual and scheduled), including unconfirmed ones and their recovery.
        sheets_deliveries: sheetsDeliveriesForReport(store, tenant, r.id, [
          ...unresolvedStates,
          'complete',
          'rejected',
          'abandoned',
        ]).map(deliveryProjection),
        job: {
          state: job.state,
          attempts: job.attempts,
          error: job.error,
          available_at: job.available_at,
          retry_available: jobRetryAvailable(job),
          // RPT-05 stall signal: how long an active run waited before a worker started it (until now while it still
          // waits), and whether any worker process has sent a recent heartbeat. Process liveness only, no identity.
          ...(active
            ? {
                queued_at: job.created_at,
                started_at: r.started_at ?? null,
                queued_ms: Math.max(0, (r.started_at ?? now) - job.created_at),
                worker_recent: operationsWorkerHealth(store, now).status === 'active',
              }
            : {}),
        },
      };
    }
    if (input.action === 'compare' || input.action === 'compare_candidates') return this.compare(actor, input);
    if (input.action === 'create_spreadsheet') return this.sheets.create(actor, input);
    if (input.action === 'bind_destination') return this.sheets.bind(actor, input);
    // EXP-04 D phase 2: the explicit, reversible move of a local workbook schedule into an Overview schedule.
    if (input.action === 'preview_workbook_move')
      return previewWorkbookMigration(store, actor, input, (c, a) => this.config(c, a));
    writer(store, actor);
    if (input.confirmed !== true)
      throw new MirrorError('CONFIRMATION_REQUIRED', 'Confirm this reporting configuration, run or export.');
    if (input.action === 'save' || input.action === 'save_template')
      return this.library.save(actor, input, input.action === 'save_template');
    if (input.action === 'resolve_delivery') return this.resolveDelivery(actor, input);
    if (input.action === 'move_workbook_schedule')
      return migrateWorkbookSchedule(store, actor, input, (c, a) => this.config(c, a), this.library);
    if (input.action === 'undo_workbook_move') return revertWorkbookMigration(store, actor, input, this.library);
    if (input.action === 'delete_report')
      // Releasing an unconfirmed delivery and deleting the snapshot commit together: a refused delete releases nothing.
      return store.transaction(() => {
        this.releaseReportDeliveries(actor, String(input.id), input.resolution);
        return this.library.delete(actor, input, 'overview_report');
      });
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
      // A saved definition runs as saved; target rules added later apply when it is edited (DEC-01).
      if (input.compare !== undefined && input.compare !== 'previous_period')
        throw new MirrorError('INVALID_REPORT', 'Use compare: previous_period, or omit it.');
      return store.transaction(() => {
        const view = input.config == null ? store.document(tenant, 'overview_view', String(input.id)) : undefined,
          config = view
            ? this.library.migrateDefinition(actor, view, 'overview_view')
            : this.config(input.config, actor);
        const run =
          input.compare === 'previous_period'
            ? this.queueComparison(actor, config, view?.id)
            : this.queue(actor, config, undefined, undefined, Date.now(), view?.id);
        return view ? {...run, view_revision: store.document(tenant, 'overview_view', view.id).revision} : run;
      });
    }
    if (input.action === 'export') {
      const report = store.document(tenant, 'overview_report', String(input.report_id));
      this.access(actor, report.config);
      assertReportExportable(report);
      const destination = reportDestination(store, actor, input.destination_id);
      if (destination.kind === 'report_files') return this.files.queue(actor, report, destination.id);
      // EXP-03 C: the complete-only policy refuses here, before any job exists.
      assertDeliveryPolicy(report);
      this.assertDestinationOwner(tenant, report, destination.id);
      return this.queueSheetsExport(actor, report, destination.id, 'manual');
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
        cancelJob(store, tenant, job.id, Date.now());
        if (job.kind === 'report_overview')
          store.putDocument(tenant, 'overview_report', r.id, {...r, state: 'cancelled'});
        return {
          id: job.id,
          report_id: r.id,
          state: store.job(tenant, job.id).state,
          message: 'No further requests will start. A request already sent may finish.',
        };
      }
      if (!['failed', 'cancelled'].includes(job.state))
        throw new MirrorError('JOB_NOT_RETRYABLE', 'Only failed or cancelled reporting jobs can be retried.');
      if (!jobRetryAvailable(job))
        throw new MirrorError(
          'JOB_NOT_RETRYABLE',
          'This failure repeats on every retry. Change the report, its delivery policy or destination, then run or export it again.',
          {error_code: job.error?.code ?? null},
          409,
        );
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
          // EXP-03 D: a finished snapshot stays finished; its retry only completes the delivery, without provider reads.
          ...(finishedSnapshot(r) ? {} : {state: 'queued'}),
          actor_binding: store.bindJobActor(actor, r.id),
        });
      else {
        const e = store.document(tenant, 'overview_export', job.input.export_id);
        if (this.releaseRequired(tenant, job, e.destination_id))
          throw new MirrorError(
            'SHEETS_RELEASE_REQUIRED',
            'This report tab’s delivery marker differs from AMCP’s records, so a retry would fail the same way. Release the tab from the report’s delivery history first, then retry.',
            {error_code: job.error?.code ?? null, destination_id: e.destination_id, release_available: true},
            409,
          );
        store.putDocument(tenant, 'overview_export', e.id, {
          ...e,
          actor_binding: store.bindJobActor(actor, e.id),
          state: 'queued',
        });
      }
      retryJob(store, tenant, job.id, Date.now());
      const exportId = typeof job.input.export_id === 'string' ? job.input.export_id : null;
      return {
        id: job.id,
        report_id: r.id,
        state: 'queued',
        ...(exportId ? {export_id: exportId} : {}),
        next_call: {
          tool: overviewTool.name,
          arguments: exportId ? {action: 'export_status', id: exportId} : {action: 'get', id: r.id, limit: 1},
        },
        poll_after_ms: overviewPollAfterMs,
      };
    }
    throw new MirrorError('INVALID_ARGUMENT', 'Unknown reporting overview action.');
  }
  private schedule(actor: Actor, input: JsonObject) {
    return this.library.schedule(actor, input);
  }
  /**
   * Where a read starts and what continues it (V2-MCP-02). An unfiltered read pages by `offset`, as it always has. A
   * filtered read pages by a cursor sealed to the caller (tenant, person, role, credential) and to every argument of the
   * read (`bound`), so the continuation of one read can never be applied to another: a changed argument, another caller
   * or an `offset` beside the cursor is refused (INVALID_CURSOR), and so is an `offset` on a filtered read.
   */
  private readStart(actor: Actor, input: JsonObject, filtered: boolean, bound: JsonObject, what: string) {
    if (!filtered && input.cursor === undefined) return {offset: input.offset ?? 0, binding: undefined};
    const binding = cursorBinding(this.service.store, actor, bound);
    if (input.cursor !== undefined) {
      if (input.offset !== undefined) throw invalidCursor(what);
      return {offset: decodeOffsetCursor(input.cursor, binding, what), binding};
    }
    if (input.offset !== undefined && input.offset !== 0)
      throw new MirrorError(
        'INVALID_PAGE',
        'Continue a filtered read with the next_cursor it returned; an offset belongs to an unfiltered read.',
        {field: 'offset'},
      );
    return {offset: 0, binding};
  }
  /** Whether a failed Sheets export needs its tab released before a retry can succeed (see releaseFirstErrors). */
  private releaseRequired(tenant: string, job: JsonObject, destinationId: unknown): boolean {
    if (job.kind !== 'sheets_export' || job.state !== 'failed' || !releaseFirstErrors.has(job.error?.code))
      return false;
    if (job.error?.details?.release_available !== true) return false;
    const d =
      typeof destinationId === 'string' ? optional(this.service, tenant, 'sheets_destination', destinationId) : null;
    return !(Number(d?.marker_release?.released_at) >= Number(job.updated_at));
  }
  /** Source time zones seen in the newest retained snapshots, for network-free schedule previews. */
  private observedTimezones(tenant: string): Map<string, string> {
    const zones = new Map<string, string>();
    const rows = recentSnapshotSources(this.service.store, tenant);
    for (const row of rows) {
      let sources: unknown;
      try {
        sources = JSON.parse(row.sources ?? '[]');
      } catch {
        continue;
      }
      for (const s of Array.isArray(sources) ? sources : []) {
        const key = s?.source?.platform + ':' + s?.source?.account_id;
        if (typeof s?.timezone === 'string' && !zones.has(key)) zones.set(key, s.timezone);
      }
    }
    return zones;
  }
  /**
   * Owner policy P6: the frozen instant in the source's own zone. `date_range.source_timezone` "account" does so for
   * every source (one bounded account read where the zone is not fixed); by default only a source whose platform fixes
   * its report day does, which needs no read.
   */
  private async sourceWindow(config: JsonObject, source: JsonObject, actor: Actor) {
    const rule = config.date_range_rule,
      fixed = fixedReportTimezones[source.platform] !== undefined;
    if (!rule || (rule.source_timezone !== 'account' && !fixed)) return {dates: config.date_range};
    const timezone = await sourceReportTimezone(this.service, source, actor);
    // RPT-07: the baseline of a previous-period pair resolves the same rule, then takes the equal window before it.
    const previous = config.comparison_window === 'previous_equal';
    return timezone
      ? {
          dates: previous
            ? previousEqualWindow(resolveRollingWindow(rule, rule.resolved_at, timezone))
            : resolveRollingWindow(rule, rule.resolved_at, timezone),
          resolution: {
            basis: rule.source_timezone === 'account' ? 'account_timezone' : 'provider_fixed_timezone',
            timezone,
            ...(previous ? {window: 'previous_equal'} : {}),
          },
        }
      : {dates: config.date_range, resolution: {basis: 'report_timezone', timezone: rule.timezone}};
  }
  /**
   * RPT-07: a run with compare:"previous_period" queues two linked snapshots of the same definition: the current window
   * and the equal-length window that ends the day before it. Each is an ordinary snapshot with its own whole-job
   * collection budget and estimate check, so the pair never exceeds the limits of a single run per job; the queue
   * limit counts both, and both are refused together.
   */
  private queueComparison(actor: Actor, config: JsonObject, viewId?: string) {
    const store = this.service.store,
      tenant = actor.tenantId,
      at = Date.now(),
      resolved = resolveReportConfig(config, at),
      window = previousEqualWindow(reportRange(resolved.date_range)),
      baselineConfig = {
        ...resolved,
        date_range: window,
        ...(resolved.date_range_rule ? {comparison_window: 'previous_equal'} : {}),
      };
    const baseline = this.queue(actor, baselineConfig, undefined, undefined, at, viewId, {
        comparison: {role: 'baseline', window: 'previous_equal'},
      }),
      current = this.queue(actor, resolved, undefined, undefined, at, viewId, {
        comparison: {role: 'current', baseline_id: baseline.id, window: 'previous_equal'},
      });
    store.putDocument(tenant, 'overview_report', baseline.id, {
      ...store.document(tenant, 'overview_report', baseline.id),
      comparison: {role: 'baseline', current_id: current.id, window: 'previous_equal'},
    });
    return {
      ...current,
      comparison: {
        window: 'previous_equal',
        baseline_id: baseline.id,
        baseline_job_id: baseline.job_id,
        baseline_date_range: window,
        estimated_requests_total: current.estimated_requests + baseline.estimated_requests,
      },
    };
  }
  /**
   * RPT-07: `compare` compares a snapshot with a retained baseline (`baseline_id`, or the snapshot's previous-period
   * pair); `compare_candidates` lists retained snapshots with whether each may be its baseline and why not. Both are
   * reads of retained snapshots: no provider request and no saved change.
   */
  private compare(actor: Actor, input: JsonObject) {
    const store = this.service.store,
      tenant = actor.tenantId,
      current = store.document(tenant, 'overview_report', String(input.id));
    this.access(actor, current.config);
    if (input.action === 'compare_candidates') {
      const offset = input.offset ?? 0,
        limit = input.limit ?? 50;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new MirrorError('INVALID_PAGE', 'Use an offset >= 0 and 1–100 candidate snapshots.');
      const candidates = comparisonCandidates(store, tenant, current.id, offset);
      const out: JsonObject[] = [];
      let scanned = 0;
      for (const candidate of candidates) {
        scanned++;
        const record = {...JSON.parse(candidate.data), id: candidate.id};
        try {
          this.access(actor, record.config);
        } catch {
          continue;
        }
        const eligibility = comparisonEligibility(current, record);
        out.push({
          id: record.id,
          name: record.config?.name ?? null,
          state: record.state,
          grain: record.config?.grain ?? 'total',
          date_range: record.config?.date_range ?? null,
          created_at: record.created_at ?? null,
          same_view: !!current.view_id && record.view_id === current.view_id,
          paired: current.comparison?.baseline_id === record.id,
          eligible: eligibility.eligible,
          reasons: eligibility.reasons.map(code => ({code, message: comparisonReasons[code]})),
        });
        if (out.length >= limit) break;
      }
      const hasMore = scanned < candidates.length || candidates.length === 500;
      return {
        id: current.id,
        paired_baseline_id: current.comparison?.baseline_id ?? null,
        candidates: out,
        offset,
        has_more: hasMore,
        next_offset: hasMore ? offset + scanned : null,
        network_requests: 0,
      };
    }
    const baselineId = input.baseline_id ?? current.comparison?.baseline_id;
    if (typeof baselineId !== 'string')
      throw new MirrorError(
        'REPORT_BASELINE_REQUIRED',
        'Choose a retained snapshot to compare with (compare_candidates lists them), or run the report with compare: previous_period.',
      );
    const baseline = store.document(tenant, 'overview_report', baselineId);
    this.access(actor, baseline.config);
    if (!finishedSnapshot(baseline) || !finishedSnapshot(current))
      throw new MirrorError(
        'REPORT_NOT_READY',
        'Both snapshots must finish collecting before they can be compared.',
        {current_state: current.state, baseline_state: baseline.state},
        409,
      );
    return {
      ...compareSnapshots(current, baseline, {offset: input.offset, limit: input.limit}),
      paired: baselineId === current.comparison?.baseline_id,
    };
  }
  /**
   * V2-EXP-01: the baseline a snapshot's key figures are compared with when the report is read: the snapshot linked by
   * `compare: previous_period`, if this actor may read it. A read of two retained snapshots, no provider request. Absent
   * when the snapshot has no key figures, no link, or a baseline the actor cannot reach: the figures then show no change.
   */
  private chartBaseline(actor: Actor, report: JsonObject): JsonObject | undefined {
    const id = report.comparison?.baseline_id;
    if (typeof id !== 'string' || !report.charts?.some((chart: JsonObject) => chart.kind === 'kpi')) return undefined;
    try {
      const baseline = this.service.store.document(actor.tenantId, 'overview_report', id);
      this.access(actor, baseline.config);
      return baseline;
    } catch (error) {
      if (error instanceof MirrorError) return undefined;
      throw error;
    }
  }
  /** EXP-03 B: an export cannot replace another report's owned tab (rollback: AMCP_SHEETS_DESTINATION_OWNERSHIP=off). */
  private assertDestinationOwner(tenant: string, report: JsonObject, destinationId: string) {
    if (!destinationOwnershipEnforced()) return;
    const owners = destinationOwners(this.service.store, tenant, destinationId);
    if (ownsDestination(report, owners)) return;
    throw new MirrorError(
      'DESTINATION_OWNED_BY_OTHER_REPORT',
      'This report tab belongs to another report with different accounts. Export this snapshot to a new tab instead; the tab was left unchanged.',
      {
        destination_id: destinationId,
        owner_kind: owners[0]!.kind,
        owner_name: owners[0]!.name,
        owner_client_name: owners[0]!.client_name,
      },
      409,
    );
  }
  /** One Sheets export record and job per snapshot and tab, shared by manual and scheduled delivery (EXP-03 D). */
  queueSheetsExport(actor: Actor, report: JsonObject, destinationId: string, origin: 'manual' | 'schedule') {
    const store = this.service.store,
      tenant = actor.tenantId,
      id = sha256(report.id + ':' + destinationId);
    return store.transaction(() => {
      const prior = optional(this.service, tenant, 'overview_export', id);
      if (prior) {
        const job = store.job(tenant, prior.job_id);
        return {...publicRecord(prior), state: job.state, outcome: exportOutcome(prior, job)};
      }
      const jobId = store.enqueue(tenant, 'sheets_export', {report_id: report.id, export_id: id});
      store.putDocument(tenant, 'overview_export', id, {
        report_id: report.id,
        destination_id: destinationId,
        job_id: jobId,
        actor_binding: store.bindJobActor(actor, id),
        state: 'queued',
        origin,
        created_at: Date.now(),
      });
      // The report it exports, so a handoff opens the report rather than the export (MCP-09).
      return {id, report_id: report.id, job_id: jobId, state: 'queued'};
    });
  }
  /**
   * Delivery after collection (EXP-03 C/D): skip by policy, or queue a separate delivery job. A failing destination
   * leaves the collected snapshot complete; its outcome is recorded on the snapshot and on its schedule.
   * AMCP_SCHEDULED_SHEETS_DELIVERY=inline restores writing Sheets inside the collection job.
   */
  private async deliverSnapshot(actor: Actor, report: JsonObject, access: () => void): Promise<JsonObject> {
    const store = this.service.store,
      tenant = actor.tenantId,
      skipped = (reason: string, message: string) => ({state: 'skipped', reason, message});
    let result: JsonObject;
    if (!report.rows.length)
      result = skipped('EMPTY_REPORT', 'No rows to export. Existing files and spreadsheet tabs were left unchanged.');
    else {
      let destination: JsonObject;
      try {
        destination = reportDestination(store, actor, report.destination_id);
      } catch (e) {
        // A lost lease or a cancelled schedule stops the job itself; only a destination failure is a delivery outcome.
        if (
          !(e instanceof MirrorError) ||
          scheduledSheetsInline() ||
          ['STALE_JOB_LEASE', 'JOB_CANCELLED'].includes(e.code)
        )
          throw e;
        result = {
          state: 'failed',
          reason: e.code,
          message: 'The saved destination is unavailable. Reconnect it or choose another destination.',
        };
        recordScheduleDelivery(store, tenant, report, {state: 'failed', error_code: e.code, blocking: !e.retryable});
        return result;
      }
      if (report.state === 'partial' && report.config.partial_delivery === 'complete_only')
        result = skipped(
          'PARTIAL_DELIVERY_BLOCKED',
          destination.kind === 'report_files'
            ? 'The snapshot is partial. Its complete-only delivery setting keeps existing files unchanged.'
            : 'The snapshot is partial. Its complete-only delivery setting keeps the report tab unchanged.',
        );
      else if (destination.kind === 'report_files') result = this.files.queue(actor, report, destination.id);
      else if (scheduledSheetsInline()) {
        try {
          result = await this.sheets.write(actor, destination.id, report, access);
        } catch (e) {
          this.deliveryFailed(tenant, report, e);
          throw e;
        }
        if (result.state === 'complete') spendNotices(store, tenant, report);
      } else result = this.queueSheetsExport(actor, report, destination.id, 'schedule');
    }
    recordScheduleDelivery(store, tenant, report, {
      state: result.state === 'delivered' ? 'complete' : (result.state ?? 'queued'),
      error_code: result.reason ?? null,
      export_id: result.id ?? null,
      job_id: result.job_id ?? null,
    });
    return result;
  }
  /** A delivery failure on the snapshot's own scheduled destination is projected onto that schedule (EXP-03 E). */
  private deliveryFailed(tenant: string, report: JsonObject, e: unknown, attempts = 1, jobId?: string) {
    if (e instanceof MirrorError && ['STALE_JOB_LEASE', 'JOB_CANCELLED'].includes(e.code)) return;
    const retryable = e instanceof MirrorError && e.retryable;
    recordScheduleDelivery(this.service.store, tenant, report, {
      state:
        retryable && (attempts < REPORT_JOB_ATTEMPT_LIMIT || sheetsSettleRecheck('sheets_export', e))
          ? 'retrying'
          : 'failed',
      error_code: e instanceof MirrorError ? e.code : 'DELIVERY_FAILED',
      blocking: e instanceof MirrorError && !e.retryable,
      job_id: jobId ?? null,
      retry_available: !(e instanceof MirrorError && deterministicJobErrors.has(e.code)),
    });
  }
  private async deliveryJob(tenant: string, kind: string, input: JsonObject, leaseCheck: () => void) {
    const store = this.service.store,
      e = store.document(tenant, 'overview_export', input.export_id),
      report = optional(this.service, tenant, 'overview_report', e.report_id),
      scheduled = report?.schedule_id && report.destination_id === e.destination_id ? report : undefined;
    try {
      const result =
        kind === 'report_file_export'
          ? await this.files.work(tenant, input, leaseCheck)
          : await this.sheetsExport(tenant, input, leaseCheck);
      if (scheduled)
        recordScheduleDelivery(store, tenant, scheduled, {
          state: result.state === 'delivered' ? 'complete' : result.state,
          export_id: e.id,
          job_id: e.job_id,
        });
      return result;
    } catch (error) {
      if (scheduled) {
        const job = input.__job_id ? jobAttempts(store, tenant, input.__job_id) : undefined;
        this.deliveryFailed(tenant, scheduled, error, Number(job?.attempts ?? 1), e.job_id);
      }
      throw error;
    }
  }
  private async sheetsExport(tenant: string, input: JsonObject, leaseCheck: () => void) {
    const store = this.service.store,
      e = store.document(tenant, 'overview_export', input.export_id),
      actor = store.restoreJobActor(tenant, e.id, e.actor_binding),
      r = store.document(tenant, 'overview_report', input.report_id);
    store.bindActorCheck(actor, leaseCheck);
    this.access(actor, r.config);
    // Rechecked when the job runs: a tab claimed by another report after this export was queued stays protected.
    this.assertDestinationOwner(tenant, r, e.destination_id);
    const result = await this.sheets.write(actor, e.destination_id, r, () => {
      this.reportCurrent(tenant, r.id);
      this.access(actor, r.config);
    });
    store.transaction(() => {
      store.putDocument(tenant, 'overview_export', e.id, {...e, ...result, completed_at: Date.now()});
      // A tab that was written (not one a newer snapshot already holds) carries the snapshot's notes to the client.
      if (result.state === 'complete') spendNotices(store, tenant, r);
    });
    return result;
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
      cancelQueuedSheetsExports(store, tenant, sha256(delivery.report_id + ':' + destination.id), Date.now());
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
        job = prior ? jobState(store, tenant, prior.job_id) : null;
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
        requeueJob(store, tenant, jobId, now);
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
  /**
   * What ends a job that works for a report: the report cancelled, or made by a schedule that was then paused, edited or
   * removed. `r` holds the three fields these stand on (`state`, `schedule_id`, `schedule_version`).
   */
  private assertCurrent(tenant: string, r: JsonObject) {
    if (r.state === 'cancelled') throw new MirrorError('JOB_CANCELLED', 'Report cancelled.');
    if (r.schedule_id) {
      const schedule = this.service.store.document(tenant, 'overview_schedule', r.schedule_id);
      if (!schedule.is_active || (schedule.definition_version ?? 0) !== (r.schedule_version ?? 0))
        throw new MirrorError('JOB_CANCELLED', 'The report schedule was edited, paused or removed.');
    }
  }
  /** The report a job works for, read whole (the delivery of its files needs its rows) and checked current. */
  private currentReport(tenant: string, id: string) {
    const r = this.service.store.document(tenant, 'overview_report', id);
    this.assertCurrent(tenant, r);
    return r;
  }
  /**
   * The same check for a guard that has no use for the report, which is every actor check a job makes while it runs: it
   * reads the three fields the check stands on, fresh each time, and not the whole stored snapshot, which holds every
   * row of the report and took 0.8 s to parse at the 25,000-row ceiling, five times in the tail of a job (NF-1b).
   */
  private reportCurrent(tenant: string, id: string) {
    this.assertCurrent(
      tenant,
      this.service.store.documentFields(tenant, 'overview_report', id, ['state', 'schedule_id', 'schedule_version']),
    );
  }
  tick() {
    const store = this.service.store;
    const owner = randomUUID();
    if (store.acquireLock('report-retention', owner, 3600000)) cleanupReports(store);
    const at = Date.now();
    // Only the workspaces the global due index names (OPS-08); each is then selected exactly as before.
    for (const tenant of dueScheduleTenants(store, 'overview_schedule', at))
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
              prepared = this.library.prepareDefinition(actor, s, 'overview_schedule');
            if (s.view_id) {
              const view = optional(this.service, tenant, 'overview_view', s.view_id);
              if (view) this.library.migrateDefinition(actor, view, 'overview_view');
            }
            const run = this.queue(actor, prepared.config, s.destination_id, s.id, s.next_run_at, s.view_id);
            store.putDocument(
              tenant,
              'overview_schedule',
              s.id,
              {
                ...s,
                ...(prepared.migrated ? overviewSidecar(s, prepared.config) : {}),
                ...following,
                last_occurrence_at: s.next_run_at,
                last_report_id: run.id,
                last_run_at: Date.now(),
                error: null,
              },
              s.revision,
            );
          });
          this.tickFailures.delete(s.id);
        } catch (e) {
          const error =
            e instanceof MirrorError
              ? {code: e.code, message: e.message}
              : {code: 'SCHEDULE_FAILED', message: 'The schedule could not run.'};
          // The rule of the reporting scheduler (src/worker.ts tickSchedules, r25-mf-jobs 2): only an error that no retry
          // changes turns a schedule off. A full queue, a busy database or any other failure leaves it on: the transaction
          // rolled back, so it is still due and the next tick tries it again.
          const stop = e instanceof MirrorError && !e.retryable;
          if (stop) failSchedule(store, tenant, 'overview_schedule', s, error);
          // A failure that goes on is recorded once, not on every tick. shortcut: this memory is the process's, so a restart
          // records a schedule that is still failing once more; upgrade it if that is ever noisy.
          const seen = s.next_run_at + ':' + error.code;
          if (stop || this.tickFailures.get(s.id) !== seen)
            try {
              store.appendAudit(tenant, 'scheduler/' + s.id, {event: 'schedule_failed', error, will_retry: !stop});
              this.tickFailures.set(s.id, seen);
            } catch {
              // The store that could not queue the run may not take the record either; the next tick records it.
            }
        }
  }
  /**
   * A report returned to the queue at shutdown (OPS-07) charges its collection budget up to now and none of the
   * downtime after it, as the budget already does after a clean stop. Runs inside the release transaction.
   */
  releaseJob(tenant: string, kind: string, input: JsonObject) {
    if (kind !== 'report_overview' || typeof input.report_id !== 'string') return;
    const store = this.service.store;
    let r: JsonObject;
    try {
      r = store.document(tenant, 'overview_report', input.report_id);
    } catch {
      return;
    }
    // Split counters (OPS-08) are charged in their own document; a legacy report keeps its inline counters.
    if (new ReportParts(store, tenant, r).releaseBudget()) return;
    const budget = r.collection_budget;
    if (!budget || !Number.isFinite(budget.active_since) || !Number.isFinite(budget.elapsed_ms)) return;
    store.putDocument(tenant, 'overview_report', r.id, {
      ...r,
      collection_budget: {
        ...budget,
        elapsed_ms: budget.elapsed_ms + Math.max(0, Date.now() - budget.active_since),
        active_since: null,
      },
    });
  }
  async work(tenant: string, kind: string, input: JsonObject) {
    const store = this.service.store;
    const leaseCheck = () => {
      if (!input.__job_id) return;
      const row = jobLease(store, tenant, input.__job_id);
      if (!row || row.state !== 'running' || row.lease_token !== input.__lease_token || row.lease_until <= Date.now())
        throw new MirrorError('STALE_JOB_LEASE', 'This worker no longer owns the report/export job.', {}, 409);
    };
    leaseCheck();
    if (kind === 'report_file_export' || kind === 'sheets_export')
      return this.deliveryJob(tenant, kind, input, leaseCheck);
    if (kind === 'media_upload') {
      const review = store.document(tenant, 'media_review', input.review_id),
        actor = store.restoreJobActor(tenant, 'media-job:' + input.review_id, review.actor_binding);
      store.bindActorCheck(actor, leaseCheck);
      const result = await this.service.call(
        'amcp_media',
        {action: 'execute', review_id: input.review_id, idempotency_key: input.review_id, confirmed: true},
        actor,
      );
      if (!result.success) {
        // Contention before any claim sent nothing, so the worker may retry it until the review expires (MED-02).
        // Once a claim exists the upload is never retried: its outcome is reconciled from its receipt.
        const claimed = writeClaimed(store, tenant, input.review_id),
          contention = ['MEDIA_MEMORY_BUSY', 'MEDIA_UPLOAD_BUSY', 'MEDIA_PROCESSOR_BUSY'].includes(result.error.code);
        throw new MirrorError(
          result.error.code,
          result.error.message,
          {...result.error.details, review_expires_at: review.expires_at, claimed},
          409,
          result.error.retryable === true && contention && !claimed,
        );
      }
      return result.data;
    }
    // An approved plan of media uploads run on the server (MED-03 B), one worker turn at a time.
    if (kind === BACKGROUND_RUN_KIND)
      return backgroundRunTurn(
        store,
        (tool, args, actor) => this.service.call(tool, args, actor),
        tenant,
        input,
        leaseCheck,
      );
    // DEC-02: the outcome review of a verified allocation plan, once its window has closed (read-only).
    if (kind === allocationOutcomeKind)
      return allocationOutcomeJob(
        store,
        (tool, args, actor) => this.service.call(tool, args, actor),
        tenant,
        input,
        leaseCheck,
      );
    // R2.5 M2: an uncertain write's automatic read-only check (src/write-reconcile-job.ts).
    if (kind === writeReconcileKind) return this.service.reconcileWriteJob(tenant, input, leaseCheck);
    if (kind !== 'report_overview') return this.service.verificationJob(tenant, kind, input);
    try {
      return await this.snapshot(tenant, input, leaseCheck);
    } catch (e) {
      this.abandonSnapshot(tenant, input, e);
      throw e;
    }
  }
  /**
   * A report that its job abandons is failed with the reason, not left queued or running (F-L5-04). Not when the job is
   * run again (the worker retries a retryable error until the last attempt, and a collection yield always), when this
   * worker lost the job or the report was cancelled, or when the report is already a finished snapshot: a failed
   * delivery does not undo a collected snapshot.
   */
  private abandonSnapshot(tenant: string, input: JsonObject, e: unknown) {
    if (
      e instanceof MirrorError &&
      (['STALE_JOB_LEASE', 'JOB_CANCELLED'].includes(e.code) ||
        (e.retryable && (input.__last_attempt !== true || e.code === 'REPORT_COLLECTION_YIELD')))
    )
      return;
    const store = this.service.store;
    try {
      const current = store.document(tenant, 'overview_report', input.report_id);
      if (current.state === 'failed' || current.state === 'cancelled' || finishedSnapshot(current)) return;
      store.putDocument(tenant, 'overview_report', current.id, {
        ...current,
        state: 'failed',
        error:
          e instanceof MirrorError
            ? {code: e.code, message: e.message}
            : {code: 'REPORT_FAILED', message: 'Report execution failed.'},
      });
    } catch {
      // The report is gone or the store is busy: the job's own failure stands.
    }
  }
  /** One report snapshot job: collects every unit of every source, assembles the rows and saves the snapshot. */
  private async snapshot(tenant: string, input: JsonObject, leaseCheck: () => void) {
    const store = this.service.store;
    const lastAttempt = input.__last_attempt === true;
    let r = store.document(tenant, 'overview_report', input.report_id);
    const actor = store.restoreJobActor(tenant, r.id, r.actor_binding),
      access = () => {
        this.reportCurrent(tenant, r.id);
        this.access(actor, r.config);
      };
    store.bindActorCheck(actor, () => {
      leaseCheck();
      this.reportCurrent(tenant, r.id);
    });
    access();
    if (finishedSnapshot(r)) {
      // EXP-03 D: re-entry (a retry or a lost lease) never collects again or re-stamps completed_at, which the file
      // integrity hash covers; it only completes a delivery that did not start.
      if (r.destination_id && !r.export) {
        const exported = await this.deliverSnapshot(actor, r, access);
        store.putDocument(tenant, 'overview_report', r.id, {
          ...store.document(tenant, 'overview_report', r.id),
          export: exported,
        });
      }
      return {report_id: r.id, state: r.state, row_count: r.rows.length};
    }
    if (!r.collection_budget && Object.keys(r.checkpoints ?? {}).length) {
      const error = {
        code: 'REPORT_RESTART_REQUIRED',
        message:
          'This older snapshot has no whole-job collection counters. Its retained checkpoints are preserved; start a new snapshot from the saved definition.',
      };
      store.putDocument(tenant, 'overview_report', r.id, {...r, state: 'failed', error});
      throw new MirrorError(error.code, error.message);
    }
    // LinkedIn collection state from before its evidence contract (campaign-source-v3) cannot be resumed. The v4 bump
    // (RPT-03 native daily segmentation) did not change LinkedIn evidence, so v3 state stays resumable.
    if (
      !linkedinEvidenceContracts.includes(r.config.source_contract_version) &&
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
    const contracts = platformContracts(r.config),
      scopeRollups = r.config.contract_version === overviewConfigV4 && r.scope_contract === overviewV4ScopeContract,
      executionSources = expandOverviewV4Sources(r.config, scopeRollups),
      retainedParts = new ReportParts(store, tenant, r);
    if (
      scopeRollups &&
      executionSources.some(
        (_source: JsonObject, i: number) =>
          retainedParts.source(String(i), r.checkpoints?.[String(i)]).result?.scope?.filtering === 'after_collection',
      )
    ) {
      const refusal = new MirrorError(
        'REPORT_RESTART_REQUIRED',
        'The retained scope was already filtered by an earlier report pipeline. Start a new snapshot; its existing evidence is preserved.',
      );
      store.putDocument(tenant, 'overview_report', r.id, {
        ...r,
        state: 'failed',
        error: {code: refusal.code, message: refusal.message},
      });
      throw refusal;
    }
    // State kept under another platform contract cannot be resumed: its rows mean something else now. Nobody is there to
    // start a scheduled run again, so each such source is collected again from its start, and says so. The whole-job
    // counters keep what the job already spent (the budget is not refunded), and the source is marked on the report so a
    // retry after an interruption still carries the warning.
    const stale = executionSources.flatMap((source: JsonObject, i: number) =>
      contracts[source.platform] &&
      r.platform_contracts?.[source.platform] !== contracts[source.platform] &&
      Object.keys(retainedParts.source(String(i), r.checkpoints?.[String(i)])).length > 0
        ? [String(i)]
        : [],
    );
    if (stale.length) {
      for (const key of stale) retainedParts.drop(key);
      r = {
        ...r,
        checkpoints: Object.fromEntries(Object.entries(r.checkpoints ?? {}).filter(([key]) => !stale.includes(key))),
        restarted_sources: [...new Set<string>([...(r.restarted_sources ?? []), ...stale])],
      };
      store.putDocument(tenant, 'overview_report', r.id, r);
    }
    if (fingerprint(r.platform_contracts ?? {}) !== fingerprint(contracts)) {
      r = {...r, platform_contracts: contracts};
      store.putDocument(tenant, 'overview_report', r.id, r);
    }
    // OPS-08: under an enforced shared app quota, a run (scheduled or not) whose issuer is already spent for today is
    // deferred before it starts, retryable after the daily reset, instead of stopping at its first provider request.
    for (const source of r.config.sources) {
      const refusal = store.issuerAdmission(tenant, source.connection_id);
      if (refusal) throw quotaExhausted(refusal);
    }
    store.journal(tenant, r.id, 'collecting', {report_id: r.id});
    // RPT-05: the first time a worker starts this run (kept across retries) ends its queued time.
    store.putDocument(tenant, 'overview_report', r.id, {
      ...r,
      state: 'running',
      started_at: r.started_at ?? Date.now(),
    });
    let results: JsonObject[] = [];
    const sourceLookups = new Map<string, AccountLookupCache>();
    let retry: MirrorError | undefined;
    // OPS-08: counters and checkpoints are saved in their own small documents, so a save no longer rewrites the whole
    // report; a report started by an older release resumes from its inline counters and checkpoints.
    const parts = new ReportParts(store, tenant, r),
      budget = new ReportCollectionBudget(reportBudgetState(store, tenant, r), fingerprint(r.config), state => {
        leaseCheck();
        parts.saveBudget(state);
      });
    try {
      for (let i = 0; i < executionSources.length; i++) {
        access();
        const source = executionSources[i]!,
          key = String(i),
          checkpoint = parts.source(key, r.checkpoints?.[key]);
        if (checkpoint.result) {
          results.push(checkpoint.result);
          continue;
        }
        try {
          const captured = await budget.run(async () => {
            const window = await this.sourceWindow(r.config, source, actor),
              grain = r.config.grain ?? 'total',
              // RPT-03: one account read per source per job, verified again after a multi-period collection.
              lookupKey = String(source.source_ref ?? key),
              lookup: AccountLookupCache = sourceLookups.get(lookupKey) ?? {};
            sourceLookups.set(lookupKey, lookup);
            // OPS-08: progress is saved in the source's own checkpoint documents, never by rewriting the report.
            const saveCheckpoint = (v: JsonObject) => {
              access();
              parts.save(key, v);
            };
            const periods = (state: JsonObject) =>
              collectReportPeriods(
                source,
                window.dates,
                grain,
                state,
                async (range, native, save) => {
                  budget.nextPeriod();
                  const value = await this.native.collect(source, range, actor, native, save, lookup);
                  budget.rows(key + ':' + range.since + ':' + range.until, value.rows.length);
                  return value;
                },
                saveCheckpoint,
              );
            // Snapshots created under the v4 contract collect Google and Meta days natively segmented; older
            // snapshots keep the per-period path on resume.
            const collected =
              grain === 'daily' && nativeDailyCollection(r.config, source)
                ? await collectNativeDaily(
                    source,
                    window.dates,
                    checkpoint,
                    async () => {
                      budget.nextPeriod();
                      const days = await this.native.collectDaily(source, window.dates, actor, lookup);
                      for (const day of days)
                        budget.rows(key + ':' + day.date_range.since + ':' + day.date_range.until, day.rows.length);
                      return days;
                    },
                    saveCheckpoint,
                    periods,
                  )
                : await periods(checkpoint);
            if (grain !== 'total' && lookup.data) {
              const verified = await this.native.verifyAccount(source, actor, lookup);
              if (verified) collected.lineage = [...(collected.lineage ?? []), verified];
            }
            return window.resolution ? {...collected, window_resolution: window.resolution} : collected;
          });
          access();
          const result: JsonObject = {...captured, source};
          if (r.restarted_sources?.includes(key))
            result.warnings = [...(result.warnings ?? []), sourceRestartedWarning];
          if (r.config.contract_version === overviewConfigV4 && !scopeRollups) {
            const scoped = overviewV4Scope(source, result.rows, reportSource(source.platform)?.overview);
            result.rows = scoped.rows;
            result.scope = scoped.scope;
            result.quality = {...result.quality, scope: scoped.scope};
            if (scoped.scope.excluded_unknown_rows) result.complete = false;
          }
          // A repeated entity fails this unit, before it is saved as complete (a scope that rolls up checks the rows it
          // keeps in applyScopedRollups, once it has scoped them).
          if (!scopeRollups) {
            const repeated = duplicateRowsError(result, r.config.date_range);
            if (repeated) throw repeated;
          }
          results.push(result);
          parts.complete(key, result);
          if (captured.collection_limit) {
            const limited = new MirrorError(
              'REPORT_COLLECTION_LIMIT',
              'Collection stopped at the whole-job limit. Narrow the accounts, date window or grouping for a new run.',
            );
            for (const pending of executionSources.slice(i + 1))
              results.push({source: pending, rows: [], complete: false, error: reportSourceError(limited, pending)});
            break;
          }
        } catch (e) {
          const diagnostic = reportSourceError(e, source);
          results.push({source, rows: [], complete: false, error: diagnostic});
          if (e instanceof MirrorError && ['REPORT_COLLECTION_LIMIT', 'REPORT_BUDGET_INVALID'].includes(e.code)) {
            for (const pending of executionSources.slice(i + 1))
              results.push({source: pending, rows: [], complete: false, error: reportSourceError(e, pending)});
            break;
          }
          // The last attempt has no later one: a retryable error fails the unit, the other units still run and the snapshot
          // finishes partial. A collection yield is saved progress, so the worker runs the job again at any attempt.
          if (e instanceof MirrorError && e.retryable && (!lastAttempt || e.code === 'REPORT_COLLECTION_YIELD')) {
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
      if (scopeRollups)
        results = applyScopedRollups(
          results,
          platform => reportSource(platform)!.overview!,
          budget,
          packet => duplicateRowsError(packet, r.config.date_range),
        );
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
    const {nativeFields, rows, summary, windowSummary} = await calculateSnapshot(results, r.config);
    const outcome = snapshotOutcome(results, rows, r.config),
      {state, failures} = outcome,
      // V2-EXP-01: the charts are computed here, once, and stored with the snapshot. They add to the rows and never fail a
      // report: one that cannot be computed is left out and audited.
      charts = reportChartsOrNone(
        {config: r.config, state, rows, summary, window_summary: windowSummary},
        {
          platformNames: Object.fromEntries(
            Object.entries(reportPlatforms).map(([id, platform]) => [id, platform.name]),
          ),
        },
        error =>
          store.appendAudit(tenant, 'report-overview/' + r.id, {
            event: 'report_charts_unavailable',
            report_id: r.id,
            code: error instanceof MirrorError ? error.code : 'CHART_COMPUTATION_FAILED',
          }),
      ),
      sources =
        r.config.contract_version === overviewConfigV4
          ? overviewV4Sources(results, rows, r.config.sources)
          : results.map(({rows: sourceRows, metadata, ...data}) => ({
              ...data,
              row_count: sourceRows.length,
              visible_row_count: rows.filter(
                row =>
                  row.platform === data.source.platform &&
                  row.account_id === data.source.account_id &&
                  row.connection_id === data.source.connection_id,
              ).length,
            })),
      record = {
        ...r,
        state,
        rows,
        sources,
        ...outcome.counts,
        empty_reason: outcome.emptyReason,
        completed_at: Date.now(),
        summary,
        ...(windowSummary ? {window_summary: windowSummary} : {}),
        // Named even when absent, so charts an earlier finish of this snapshot stored never outlive a recomputation.
        charts,
        native_metrics: [...nativeFields],
        row_count: rows.length,
      };
    store.transaction(() => {
      const notices = settleNotices(store, tenant, record);
      if (notices.length) Object.assign(record, {notices});
      store.putDocument(tenant, 'overview_report', r.id, record);
    });
    // The monitors evaluate the record this job has just written, which is in memory, not a read of it back from the store
    // (five parses of the whole snapshot, NF-1b); their actor and connection checks are made against the store as before.
    evaluateMonitors(store, actor, r.id, record);
    store.journal(tenant, r.id, state === 'failed' ? 'failed' : 'responded', {report_id: r.id, rows: rows.length});
    if (state === 'failed') {
      const reason = failures
        .map(
          ({unit, error}) =>
            `${reportPlatforms[unit.source.platform]!.name} ${unit.source.account_id}: ${error.provider?.code ?? error.code}`,
        )
        .join('; ');
      throw new MirrorError('REPORT_SOURCES_FAILED', 'None of the selected sources returned a report. ' + reason, {
        sources: failures.map(({error}) => error),
      });
    }
    if (r.destination_id) {
      const result = await this.deliverSnapshot(actor, {...record, id: r.id}, access);
      store.putDocument(tenant, 'overview_report', r.id, {
        ...store.document(tenant, 'overview_report', r.id),
        export: result,
      });
    }
    return {report_id: r.id, state, row_count: rows.length};
  }
}

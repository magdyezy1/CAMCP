import {fingerprint, reportContractVersion} from './report-quality.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import type {MirrorService} from './service.js';
import {MirrorError} from './errors.js';
import {accountPlan, accountMetadata, accountCurrency, accountTimezone} from './account-metadata.js';
import {reportPlatforms, metricNumber, objectiveGroup} from './report-metrics.js';
import {
  assembleDetailedOverview,
  campaignAttributionProfile,
  captureDetailedEvidence,
  collectDetailedOverview,
  overviewSourceLevel,
  readDetailedParents,
} from './overview-granularity.js';
import {nativeDetailResult} from './overview-native-detail.js';
import {markReportWindow} from './report-windows.js';
import {reportSource, reportSourceList} from './report-sources.js';
import type {
  AccountLookupCache,
  DetailCollector,
  DetailParents,
  ReportCollection,
  ReportSource,
  ReportSourceRow,
} from './report-source.js';
import {reportRange} from './report-periods.js';
import {unavailableReportResult, type ReportResultContext} from './report-results.js';
import {parseProviderDecimal, providerDecimalText, metricRoundingRecord} from './provider-decimal.js';
import {detailParentKind, detailParents} from './overview-parents.js';
import {overviewV4Activity} from './overview-v4.js';

/** The v4 boundary calls only the registered source; no provider result facts live in this shared adapter. */
export function nativeReportResult(platform: string, raw: JsonObject, context: ReportResultContext) {
  return reportSource(platform)?.readResult?.(raw, context) ?? unavailableReportResult('unsupported_goal');
}

/** Native metrics the Overview suggests per platform, from each platform's report source (ARC-04 stage F). */
export const nativeMetricExamples: Record<string, string[]> = Object.fromEntries(
  reportSourceList.map(source => [source.platform, [...source.nativeMetricExamples]]),
);
const bad = (message: string) => {
  throw new MirrorError('INVALID_REPORT_SOURCE', message);
};
// The report date range lives in src/report-periods.ts (ARC-04 stage F); this module keeps exporting it.
export {reportRange};
// The warnings of a platform's collection live with its report source (ARC-04 stage F); this module keeps exporting
// them, through the report source registry.
export {
  linkedinCampaignsUnavailableWarning,
  redditValueUnitWarning,
  tiktokEventsUnavailableWarning,
} from './report-sources.js';
const value = (v: unknown, divisor = 1) => {
  const n = metricNumber(v);
  return n === null ? null : n / divisor;
};
/**
 * RPT-04: identity and context keys never become metrics. Identifiers and names are excluded by suffix (a numeric ID
 * or a numeric-looking name must never be summed); dates, currencies and time zones only by exact key, so requested
 * metrics such as `conversionsByConversionDate` or `costInLocalCurrency` are kept.
 */
const identityKey = /(^|_)(ids?|name|urn)$/i;
const contextKeys = new Set([
  'date',
  'day',
  'date_start',
  'date_stop',
  'start_date',
  'end_date',
  'stat_time_day',
  'stat_time_hour',
  'currency',
  'currency_code',
  'account_currency',
  'timezone',
  'time_zone',
  'timezone_name',
  'account_timezone',
  'date_range',
  'time_range',
  'entity_metadata',
  'status_evidence',
]);
const snake = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
/** A native field path in one spelling: `metrics.allConversions`, `metrics_all_conversions` → `metrics_all_conversions`. */
const nativeFieldName = (k: string) => snake(k.replace(/[^a-zA-Z0-9_]/g, '_')).replace(/_+/g, '_');
/**
 * The response container a requested field may leave out: TikTok and Google metrics sit under `metrics`, Snapchat
 * stats under `stats` (TikTok `reach` is returned as `metrics.reach`). No other prefix or suffix is accepted.
 */
const nativeMetricContainers: Record<string, string> = Object.fromEntries(
  reportSourceList.flatMap(source =>
    source.nativeMetricContainer ? [[source.platform, source.nativeMetricContainer] as [string, string]] : [],
  ),
);
/** The paths of action arrays ({action_type, value} entries), whose metrics carry the action type after the path. */
function nativeActionPaths(data: unknown, prefix: string, out: Set<string>, depth = 0) {
  if (depth > 4 || !data || typeof data !== 'object' || Array.isArray(data)) return;
  for (const [k, v] of Object.entries(data)) {
    const key = (prefix ? prefix + '_' : '') + k;
    if (Array.isArray(v)) {
      if (v.some(a => a && typeof a === 'object' && typeof a.action_type === 'string')) out.add(nativeFieldName(key));
    } else if (v && typeof v === 'object') nativeActionPaths(v, key, out, depth + 1);
  }
}
/**
 * Requested native metrics that no returned row carried as a numeric field (RPT-04: warn instead of a silent null).
 * A field counts as returned only under its own name: the exact key numericNative produced, the same key inside the
 * platform's metrics container, or an action array of that name. `clicks` is not returned by `inline_link_clicks`.
 */
export function missingNativeMetrics(platform: string, requested: string[], rows: JsonObject[]): string[] {
  if (!rows.length || reportSource(platform)?.nativeMetricCheck === false) return [];
  const prefix = 'native_' + platform + '_',
    container = nativeMetricContainers[platform],
    produced = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row.metrics ?? {}))
      if (key.startsWith(prefix)) produced.add(nativeFieldName(key.slice(prefix.length)));
    nativeActionPaths(row.native, '', produced);
  }
  return requested.filter(name => {
    const wanted = nativeFieldName(name);
    return !produced.has(wanted) && !(container && produced.has(container + '_' + wanted));
  });
}
function numericNative(
  platform: string,
  data: JsonObject,
  prefix = '',
  output: JsonObject = {},
  depth = 0,
  exact = false,
): JsonObject {
  if (depth > 4) return output;
  const keepNull = reportSource(platform)?.nullNativeMetrics === true;
  for (const [k, v] of Object.entries(data)) {
    const key = (prefix ? prefix + '_' : '') + k;
    const s = snake(k);
    if (identityKey.test(s) || contextKeys.has(s)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) numericNative(platform, v, key, output, depth + 1, exact);
    else if (Array.isArray(v)) {
      for (const a of v)
        if (a && typeof a === 'object' && typeof a.action_type === 'string')
          output['native_' + platform + '_' + (key + '_' + a.action_type).replace(/[^a-zA-Z0-9_]/g, '_')] =
            exact && a.value !== undefined && a.value !== null && a.value !== '-' && a.value !== '--'
              ? providerDecimalText(a.value, {field: key})
              : metricNumber(a.value);
    } else if (keepNull && v === null) output['native_' + platform + '_' + key.replace(/[^a-zA-Z0-9_]/g, '_')] = null;
    else if (typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)))
      output['native_' + platform + '_' + key.replace(/[^a-zA-Z0-9_]/g, '_')] = exact
        ? providerDecimalText(v, {field: key})
        : metricNumber(v);
  }
  return output;
}
/**
 * One native report row in the shared shape: the platform's report source (src/report-sources.ts) reads its identity
 * and shared metrics; every native numeric field is kept as `native_<platform>_<path>`, and the row must carry a safe
 * identifier.
 */
export function normalizeNativeRow(platform: string, raw: JsonObject): JsonObject {
  const omitted = new Set<string>(),
    row: ReportSourceRow = reportSource(platform)?.normalize(raw, {
      value,
      field: (key: string, divisor = 1) => value(raw[key], divisor),
      omitted,
    }) ?? {id: undefined, metrics: {}};
  return nativeRowEnvelope(raw, row, omitted, {...row.metrics, ...numericNative(platform, raw)});
}
function nativeRowEnvelope(
  raw: JsonObject,
  row: ReportSourceRow,
  omitted: Set<string>,
  metrics: JsonObject,
): JsonObject {
  const {id, name, objective, currency} = row;
  if (id === undefined || id === null || (typeof id === 'number' && !Number.isSafeInteger(id)))
    throw new MirrorError(
      'REPORT_ID_MISSING',
      'The provider report did not include a safe campaign/resource identifier.',
      {},
      502,
    );
  return {
    campaign_id: String(id),
    campaign_name: String(name ?? id),
    objective: objective ?? 'unknown',
    objective_group: row.objectiveGroup ?? objectiveGroup(objective),
    currency: currency ?? null,
    metrics,
    ...(omitted.size ? {omitted_as_zero: [...omitted].sort()} : {}),
    ...(row.resultDefinition ? {result_definition: row.resultDefinition} : {}),
    ...(row.mixedResult ? {mixed_result_definition: true} : {}),
    ...(row.resultsByObjective ? {results_by_objective: row.resultsByObjective} : {}),
    ...(row.otherResults ? {other_results: row.otherResults} : {}),
    ...(row.objectiveUnread ? {objective_unread: row.objectiveUnread} : {}),
    native: raw,
  };
}

function exactNativeValues(platform: string, raw: JsonObject) {
  const omitted = new Set<string>(),
    read = (value: unknown, divisor = 1) =>
      value === undefined || value === null || (typeof value === 'string' && ['', '-', '--'].includes(value.trim()))
        ? null
        : providerDecimalText(typeof value === 'string' ? value.trim() : value, {field: 'native_metric', divisor}),
    exact = reportSource(platform)?.normalize(raw, {
      value: read,
      field: (key, divisor) => read(raw[key], divisor),
      omitted,
    }) ?? {id: undefined, metrics: {}};
  return {exact, omitted};
}
/** Detailed readers use the same provider-owned field/unit normalization before their retained totals are rounded. */
function nativeDeliveryActivity(platform: string, raw: JsonObject): boolean | null {
  const source = reportSource(platform)!;
  if (source.readActivity) return source.readActivity(raw);
  return overviewV4Activity(
    exactNativeValues(platform, raw).exact.metrics,
    reportSource(platform)!.overview!.delivery_metrics,
  );
}

/** Exact v4 campaign values. Provider normalization still owns names/units; float display values never supply totals. */
export function normalizeNativeRowV4(
  platform: string,
  raw: JsonObject,
  rounding: Record<string, number> = {},
): JsonObject {
  const {exact, omitted} = exactNativeValues(platform, raw),
    metrics = Object.fromEntries(
      Object.entries(exact.metrics).map(([key, value]) => {
        if (value === undefined || value === null) return [key, null];
        if (['reach', 'frequency', 'position'].includes(key)) return [key, providerDecimalText(value, {field: key})];
        const parsed = parseProviderDecimal(value, {field: key});
        if (parsed.rounded) rounding[key] = (rounding[key] ?? 0) + 1;
        const fraction = (parsed.scaled % 1000000000n).toString().padStart(9, '0').replace(/0+$/, '');
        return [key, (parsed.scaled / 1000000000n).toString() + (fraction ? '.' + fraction : '')];
      }),
    );
  const additive = Object.fromEntries(
      Object.entries(metrics).filter(([key]) => !['reach', 'frequency', 'position'].includes(key)),
    ),
    status = reportSource(platform)?.readStatus?.(raw, {level: 'campaign'});
  return {
    ...nativeRowEnvelope(raw, exact, omitted, {...metrics, ...numericNative(platform, raw, '', {}, 0, true)}),
    ...(status ? {status: status.status} : {}),
    native: {
      ...raw,
      ...(status ? {status_evidence: status} : {}),
      delivery_activity: reportSource(platform)!.readActivity
        ? reportSource(platform)!.readActivity!(raw)
        : overviewV4Activity(exact.metrics, reportSource(platform)!.overview!.delivery_metrics),
      exact_totals: additive,
    },
  };
}
// The per-source per-job lookup cache is part of the report source contract (src/report-source.ts, ARC-04 stage F).
export type {AccountLookupCache};
/**
 * Campaign-level sources whose provider segments one request by day (RPT-03, contract campaign-source-v4): the report
 * sources that declare their daily segmentation, in registry order.
 */
export const nativeDailyPlatforms: readonly string[] = reportSourceList
  .filter(source => source.daily)
  .map(source => source.platform);
export const nativeDailySegmentation = (source: JsonObject) =>
  nativeDailyPlatforms.includes(source.platform) && overviewSourceLevel(source).id === 'campaign';
/** Whether a platform's account is read before collection (a source declares `accountLookup: false` otherwise). */
const accountLookupPlatforms = (platform: string) => reportSource(platform)?.accountLookup !== false;
export class NativeCampaignReports {
  constructor(readonly service: MirrorService) {}
  /** RPT-02: a period whose last day has not ended in the source time zone is partial and marked `open_window`. */
  async collect(
    source: JsonObject,
    dates: JsonObject,
    actor: Actor,
    checkpoint: JsonObject = {},
    save: (v: JsonObject) => void = () => {},
    lookup?: AccountLookupCache,
  ): Promise<JsonObject> {
    return markReportWindow(await this.collectSource(source, dates, actor, checkpoint, save, lookup), Date.now());
  }
  /**
   * RPT-03 native daily segmentation: one natively day-segmented request (Google `segments.date`, Meta
   * `time_increment=1`) split into one result per calendar day. A single-day row is what a per-day query returns,
   * reach and frequency included. Each day keeps its own open-window state.
   */
  async collectDaily(
    source: JsonObject,
    dates: JsonObject,
    actor: Actor,
    lookup?: AccountLookupCache,
  ): Promise<JsonObject[]> {
    if (!nativeDailySegmentation(source)) bad('This source does not support native daily segmentation.');
    const result = await this.collectSource(source, dates, actor, {}, () => {}, lookup, 'daily'),
      days = new Map<string, JsonObject[]>(),
      daily = reportSource(source.platform)?.daily;
    for (const day of eachDay(result.date_range)) days.set(day, []);
    for (const row of result.rows) {
      const day = daily ? daily.day(row.native) : row.native?.date_start;
      if (typeof day !== 'string' || !days.has(day) || (daily?.endsOn && !daily.endsOn(row.native, day)))
        throw new MirrorError(
          'REPORT_DATE_MISMATCH',
          'The provider returned a daily row outside the requested days.',
          {requested: result.date_range},
          502,
        );
      days.get(day)!.push(row);
    }
    const now = Date.now();
    return [...days].map(([day, rows]) =>
      markReportWindow({...result, date_range: {since: day, until: day}, rows, native_daily: true}, now),
    );
  }
  /** Re-reads the account once after a multi-period collection and refuses a changed currency or time zone. */
  async verifyAccount(source: JsonObject, actor: Actor, lookup: AccountLookupCache): Promise<JsonObject | undefined> {
    const platform = reportPlatforms[source.platform];
    if (!platform || !lookup.data || !accountLookupPlatforms(source.platform)) return undefined;
    const account = String(source.account_id),
      plan = accountPlan(platform.gateway, account),
      out = (await this.service.runPlan(
        plan,
        {connection_id: String(source.connection_id), aggregate_pages: false, max_pages: 25},
        actor,
      )) as JsonObject;
    if (out.dry_run || out.success !== true || !out.data || typeof out.data !== 'object')
      throw new MirrorError('REPORT_RESPONSE_INVALID', 'The reporting request did not return provider data.', {}, 502);
    const before = {
        currency: accountCurrency(platform.gateway, lookup.data),
        timezone: accountTimezone(platform.gateway, lookup.data),
      },
      after = {
        currency: accountCurrency(platform.gateway, out.data),
        timezone: accountTimezone(platform.gateway, out.data),
      };
    if (before.currency !== after.currency || before.timezone !== after.timezone)
      throw new MirrorError(
        'REPORT_ACCOUNT_CHANGED',
        'The account currency or time zone changed while this report was collected. Run the report again.',
        {before, after},
        409,
      );
    return {
      stage: 'account_verify',
      method: plan.method,
      path: plan.path,
      origin: plan.origin ?? null,
      api_version: plan.path.match(/\/(v?\d+(?:\.\d+)?(?:beta)?)(?:\/|$)/)?.[1] ?? 'native',
      query_fingerprint: fingerprint({method: plan.method, path: plan.path, query: plan.query, body: plan.body}),
      response_fingerprint: fingerprint(out.data),
      captured_at: Date.now(),
    };
  }
  private async collectSource(
    source: JsonObject,
    dates: JsonObject,
    actor: Actor,
    checkpoint: JsonObject,
    save: (v: JsonObject) => void,
    lookup?: AccountLookupCache,
    segment?: 'daily',
  ): Promise<JsonObject> {
    const p = source.platform,
      entityLevel = overviewSourceLevel(source),
      platform = reportPlatforms[p],
      // The platform's report source (ARC-04 stage F): its facts and its collection.
      reports = reportSource(p);
    if (!platform || !reports) bad('Unsupported reporting platform.');
    const gateway = platform!.gateway,
      account = String(source.account_id),
      connection = String(source.connection_id),
      range = reportRange(dates),
      extra = source.native_metrics ?? [];
    if (!nativeMetricNames(extra, reports!)) bad('Native metrics must be provider field names (at most 30).');
    this.service.store.resolveConnection(actor, gateway, account, connection);
    reports!.validateRange?.(source, range);
    const lineage: JsonObject[] = [],
      {run, plan} = reportReadPath(this.service, actor, gateway, account, connection, reports!, lineage);
    // RPT-07: the detail levels of a source with native detail (Microsoft, Reddit, Apple) reuse its own reports.
    const detail = entityLevel.id === 'campaign' ? undefined : entityLevel.id;
    // One period's collection state: the account lookup sets the account facts, then the source collects into it.
    const c: ReportCollection = {
      source,
      account,
      connection,
      range,
      extra,
      segment,
      detail,
      checkpoint,
      save,
      lookup,
      actor,
      store: this.service.store,
      lineage,
      run,
      plan,
      attributionProfile: () => campaignAttributionProfile(source),
      metadata: {},
      currency: null,
      timezone: null,
      raw: [],
      warnings: [],
      attribution: 'provider configured',
      resultDefinition: 'unknown',
      complete: true,
      collectionComplete: true,
      // Source-specific context fields returned with the result (for example X campaigns with no reported activity).
      context: {},
      // RPT-02 scope limits: what a source covers by design. They are disclosed, not counted as incompleteness.
      scopeLimitations: [],
      quality: {version: 1, pages_collected: true, measurement_complete: null},
      detailRows: undefined,
      detailRounding: {},
    };
    if (accountLookupPlatforms(p)) await lookupAccount(c, gateway, run);
    if (detail && !reports!.nativeDetail) {
      const scoped = (campaignId?: string) =>
          campaignId === undefined ? source : {...source, campaign_id: campaignId},
        activity = (raw: JsonObject) => nativeDeliveryActivity(p, raw),
        read = (campaignId?: string) =>
          collectDetailedOverview(
            this.service,
            scoped(campaignId),
            range,
            actor,
            c.metadata,
            c.currency,
            c.timezone,
            lookup,
            reports!.objectives,
            reports!.readResult,
            reports!.readStatus,
            activity,
          );
      // V2-RPT-07: the same read in its phases, for a source that expands a population (Snapchat's ad squads).
      const collect: DetailCollector = Object.assign(read, {
        capture: (campaignId: string | undefined, span: {since: string; until: string}, shared: AccountLookupCache) =>
          captureDetailedEvidence(this.service, scoped(campaignId), span, actor, c.currency, c.timezone, shared),
        parents: (captures: JsonObject[], shared: AccountLookupCache) =>
          readDetailedParents(this.service, source, actor, captures, shared),
        assemble: (campaignId: string | undefined, captured: JsonObject, parents: DetailParents) =>
          assembleDetailedOverview(
            scoped(campaignId),
            range,
            c.metadata,
            c.currency,
            c.timezone,
            reports!.objectives,
            reports!.readResult,
            reports!.readStatus,
            activity,
            captured,
            parents,
          ),
      });
      return source.reporting_contract === 'overview-config-v4' && reports!.collectOverviewDetail
        ? reports!.collectOverviewDetail(c, collect)
        : collect();
    }
    // The platform's own requests, paging and parsing (ARC-04 stage F), with the shared read path and state.
    await reports!.collect(c);
    if (c.raw.length > 10000)
      throw new MirrorError('REPORT_ROW_LIMIT', 'Report exceeds 10,000 rows. Narrow the date range or accounts.');
    this.service.store.assertActorActive(actor);
    this.service.store.resolveConnection(actor, gateway, account, connection);
    if (detail)
      return nativeDetailResult(source, c.detailRows!, c.raw, {
        lineage,
        metadata: c.metadata,
        currency: c.currency,
        timezone: c.timezone,
        range,
        providerComplete: c.complete,
        resultDefinition: c.resultDefinition,
        warnings: c.warnings,
        context: c.context,
        rounding: c.detailRounding,
        objectives: reports!.objectives,
        resultReader: reports!.readResult,
        statusReader: reports!.readStatus,
        activityReader: raw => nativeDeliveryActivity(p, raw),
      });
    const result = campaignResult(p, platform!.kind, c);
    if (
      source.reporting_contract === 'overview-config-v4' &&
      detailParentKind(p, 'campaign', false, source.reporting_contract)
    ) {
      const cache = lookup ?? {},
        metadata = await detailParents(
          this.service,
          source,
          'campaign',
          result.rows.map((row: JsonObject) => row.campaign_id),
          actor,
          ((cache.detailParentsByLevel ??= {}).campaign ??= {parents: {}, lineage: []}),
        );
      result.rows = result.rows.map((row: JsonObject) => {
        const entity = metadata.parents[row.campaign_id]?.entity_metadata,
          status = reports!.readStatus?.(row.native, {level: 'campaign', metadata: entity});
        return {
          ...row,
          ...(status
            ? {status: status.status, native: {...row.native, entity_metadata: entity, status_evidence: status}}
            : {}),
        };
      });
      result.lineage.push(...metadata.lineage);
      result.warnings.push(...metadata.warnings);
      result.query_fingerprint = fingerprint(result.lineage.map((entry: JsonObject) => entry.query_fingerprint));
      result.captured_at = Date.now();
    }
    this.service.store.assertActorActive(actor);
    this.service.store.resolveConnection(actor, gateway, account, connection);
    return result;
  }
}
/** RPT-04: requested native metrics are provider field names (or the source's own metric paths), at most 30. */
function nativeMetricNames(extra: unknown, reports: ReportSource): boolean {
  return (
    Array.isArray(extra) &&
    extra.length <= 30 &&
    !extra.some(
      x => typeof x !== 'string' || !(/^[A-Za-z][A-Za-z0-9_]{0,90}$/.test(x) || !!reports.nativeMetricName?.test(x)),
    )
  );
}
/**
 * The read path of one source's report requests. `run` reads a request through MirrorService.runPlan and returns its
 * provider data: a dry run, an unsuccessful or truncated read, or a provider error envelope is refused, every refusal
 * names the request, and each read's lineage is recorded. `plan` builds the source's read-only report requests.
 */
function reportReadPath(
  service: MirrorService,
  actor: Actor,
  gateway: string,
  account: string,
  connection: string,
  reports: ReportSource,
  lineage: JsonObject[],
): Pick<ReportCollection, 'run' | 'plan'> {
  const run = async (plan: CompiledRequest, aggregate = true, stage = 'campaign_report') => {
    try {
      const out = (await service.runPlan(
        plan,
        {connection_id: connection, aggregate_pages: aggregate, max_pages: 25},
        actor,
      )) as JsonObject;
      if (out.dry_run || out.success !== true || !out.data || typeof out.data !== 'object')
        throw new MirrorError(
          'REPORT_RESPONSE_INVALID',
          'The reporting request did not return provider data.',
          {},
          502,
        );
      if (out.truncated)
        throw new MirrorError(
          'INCOMPLETE_REPORT',
          'Report reached a pagination limit. Split the date range or accounts.',
        );
      const d = out.data;
      if (d?.error || (d?.code !== undefined && Number(d.code) !== 0) || d?.request_status === 'ERROR')
        throw new MirrorError('PROVIDER_REPORT_FAILED', 'The provider rejected this report.', {upstream: d}, 502);
      lineage.push({
        stage,
        method: plan.method,
        path: plan.path,
        origin: plan.origin ?? null,
        api_version:
          (reports.versionHeader ? plan.headers?.[reports.versionHeader] : undefined) ??
          plan.path.match(/\/(v?\d+(?:\.\d+)?(?:beta)?)(?:\/|$)/)?.[1] ??
          'native',
        query_fingerprint: fingerprint({method: plan.method, path: plan.path, query: plan.query, body: plan.body}),
        response_fingerprint: fingerprint(d),
        captured_at: Date.now(),
      });
      return d as JsonObject;
    } catch (e) {
      if (e instanceof MirrorError)
        throw new MirrorError(
          e.code,
          e.localization?.key ?? e.message,
          {...e.details, report_request: {stage, method: plan.method, path: plan.path}},
          e.status,
          e.retryable,
          e.localization?.values,
        );
      throw e;
    }
  };
  const plan = (path: string, query: JsonObject = {}, body?: JsonObject, origin?: string): CompiledRequest => ({
    gateway,
    accountId: account,
    action: 'AMCP_CAMPAIGN_REPORT',
    method: body ? 'POST' : 'GET',
    path,
    query,
    body,
    origin,
    // The source's own request headers (LinkedIn's versioning headers, ARC-04 stage F); none by default.
    headers: reports.requestHeaders?.() ?? {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    evidence: 'Native campaign report, bounded account scope',
    warnings: [],
  });
  return {run, plan};
}
/**
 * RPT-03: the account read before collection, once per source and job: later periods reuse the job's first read
 * (lineage marks it `cached`). It sets the collection's account metadata, currency and time zone.
 */
async function lookupAccount(c: ReportCollection, gateway: string, run: ReportCollection['run']) {
  let d: JsonObject;
  if (c.lookup?.data) {
    d = c.lookup.data;
    c.lineage.push({...c.lookup.lineage, cached: true});
  } else {
    d = await run(accountPlan(gateway, c.account), false, 'account_lookup');
    if (c.lookup) Object.assign(c.lookup, {data: d, lineage: c.lineage.at(-1)});
  }
  c.metadata = accountMetadata(gateway, d);
  c.currency = accountCurrency(gateway, d);
  c.timezone = accountTimezone(gateway, d);
}
/** One collected campaign-level period: the normalized rows, the missing-metric warnings and the source's state. */
function campaignResult(p: string, kind: string, c: ReportCollection): JsonObject {
  const v4 = c.source.reporting_contract === 'overview-config-v4',
    rounding: Record<string, number> = {},
    rows = c.raw.map(r => {
      const row = v4 ? normalizeNativeRowV4(p, r, rounding) : normalizeNativeRow(p, r);
      if (v4) {
        const resolved = nativeReportResult(p, r, {
          level: c.source.level ?? 'campaign',
          range: c.range,
          objective: row.objective,
          report_options: c.source.report_options,
        });
        const {result, ...context} = resolved;
        row.result = result;
        row.result_context = context;
        if (Array.isArray(r.amcp_result_groups)) row.result_groups = r.amcp_result_groups;
      }
      return row;
    });
  const rounded = metricRoundingRecord(rounding);
  if (rounded) c.quality.metric_rounding = rounded;
  // The window declaration a source requires (requiresCompleteWindowDeclaration) belongs to the detail levels, whose
  // collectors hold the source partial without it. A campaign-level source has never needed one, in v3 or in v4, so an
  // upgraded v3 campaign report is complete as it was (F-L6-02); the declaration is only recorded.
  if (v4) c.quality.reporting_window_declared_complete = c.source.report_options.complete_window;
  for (const name of missingNativeMetrics(p, c.extra, rows))
    c.warnings.push(
      'Requested native metric ' +
        name +
        ' was not returned as a number; formulas that use it stay unavailable. Check the field name for this provider.',
    );
  return {
    contract_version: reportContractVersion,
    quality: c.scopeLimitations.length ? {...c.quality, scope_limitations: c.scopeLimitations} : c.quality,
    lineage: c.lineage,
    query_fingerprint: fingerprint(c.lineage.map(l => l.query_fingerprint)),
    rows,
    account_name: c.metadata.name ?? c.metadata.displayName ?? null,
    date_range: c.range,
    metadata: c.metadata,
    currency: c.currency,
    timezone: c.timezone,
    complete: c.complete,
    collection_complete: c.collectionComplete,
    ...c.context,
    ...(c.scopeLimitations.length ? {scope_limitations: c.scopeLimitations} : {}),
    attribution: c.attribution,
    result_definition: c.resultDefinition,
    warnings: c.warnings,
    source_kind: kind,
    captured_at: Date.now(),
  };
}
const nextDay = (date: string) => new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);
const eachDay = (range: {since: string; until: string}) => {
  const days: string[] = [];
  for (let day = range.since; day <= range.until; day = nextDay(day)) days.push(day);
  return days;
};

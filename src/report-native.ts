import {fingerprint, reportContractVersion, ga4Quality, summarizeGA4Quality} from './report-quality.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import type {MirrorService} from './service.js';
import {MirrorError} from './errors.js';
import {accountPlan, accountMetadata, accountCurrency, accountTimezone} from './account-metadata.js';
import {reportPlatforms, metricNumber, objectiveGroup} from './report-metrics.js';
import {campaignAttributionProfile, overviewSourceLevel, collectDetailedOverview} from './overview-granularity.js';
import {optionalReadRefused} from './overview-parents.js';
import {
  nativeDetailLookupLimit,
  nativeDetailLookupLimitedWarning,
  nativeDetailPlatforms,
  nativeDetailResult,
  redditDetail,
} from './overview-native-detail.js';
import {markReportWindow} from './report-windows.js';
import {reportSource, reportSourceList} from './report-sources.js';
import {reportList, type AccountLookupCache, type ReportCollection, type ReportSourceRow} from './report-source.js';
import {reportRange} from './report-periods.js';

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
export {linkedinCampaignsUnavailableWarning, tiktokEventsUnavailableWarning} from './report-sources.js';
/**
 * ACC-06 interim: AMCP reads Reddit's CONVERSION_PURCHASE_TOTAL_VALUE as cents (redditConversionValueDivisor) while
 * SPEND is in micros; no primary field reference or closed-week read against the Reddit UI confirms that unit yet, so a
 * report that reads it says so until the authorized check is recorded (docs/acceptance/READ-ACCEPTANCE.md).
 */
export const redditValueUnitWarning =
  'Reddit conversion value and ROAS are unverified: AMCP reads CONVERSION_PURCHASE_TOTAL_VALUE as cents (divided by 100), a unit not yet checked against Reddit. Compare them with Reddit Ads Manager before relying on them.';
const list = reportList;
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
const gscRowLimit = 10000;
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
  if (!rows.length || ['x', 'apple'].includes(platform)) return [];
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
): JsonObject {
  if (depth > 4) return output;
  for (const [k, v] of Object.entries(data)) {
    const key = (prefix ? prefix + '_' : '') + k;
    const s = snake(k);
    if (identityKey.test(s) || contextKeys.has(s)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) numericNative(platform, v, key, output, depth + 1);
    else if (Array.isArray(v)) {
      for (const a of v)
        if (a && typeof a === 'object' && typeof a.action_type === 'string')
          output['native_' + platform + '_' + (key + '_' + a.action_type).replace(/[^a-zA-Z0-9_]/g, '_')] =
            metricNumber(a.value);
    } else if (platform === 'ga4' && v === null)
      output['native_' + platform + '_' + key.replace(/[^a-zA-Z0-9_]/g, '_')] = null;
    else if (typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)))
      output['native_' + platform + '_' + key.replace(/[^a-zA-Z0-9_]/g, '_')] = metricNumber(v);
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
    objective_group: objectiveGroup(objective),
    currency: currency ?? null,
    metrics: {...row.metrics, ...numericNative(platform, raw)},
    ...(omitted.size ? {omitted_as_zero: [...omitted].sort()} : {}),
    ...(row.resultDefinition ? {result_definition: row.resultDefinition} : {}),
    ...(row.mixedResult ? {mixed_result_definition: true} : {}),
    native: raw,
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
const accountLookupPlatforms = (platform: string) => !['ga4', 'gsc', 'apple'].includes(platform);
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
      // The platform's report source (ARC-04 stage F): its facts, and its collection once it has moved there.
      reports = reportSource(p);
    if (!platform) bad('Unsupported reporting platform.');
    const account = String(source.account_id),
      connection = String(source.connection_id),
      range = reportRange(dates),
      extra = source.native_metrics ?? [];
    if (
      !Array.isArray(extra) ||
      extra.length > 30 ||
      extra.some(
        x => typeof x !== 'string' || !(/^[A-Za-z][A-Za-z0-9_]{0,90}$/.test(x) || !!reports?.nativeMetricName?.test(x)),
      )
    )
      bad('Native metrics must be provider field names (at most 30).');
    this.service.store.resolveConnection(actor, platform!.gateway, account, connection);
    const lineage: JsonObject[] = [];
    const qualityPages: JsonObject[] = [];
    let quality: JsonObject = {version: 1, pages_collected: true, measurement_complete: null};
    const run = async (plan: CompiledRequest, aggregate = true, stage = 'campaign_report') => {
      try {
        const out = (await this.service.runPlan(
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
            plan.headers?.['LinkedIn-Version'] ??
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
            e.message,
            {...e.details, report_request: {stage, method: plan.method, path: plan.path}},
            e.status,
            e.retryable,
          );
        throw e;
      }
    };
    const plan = (path: string, query: JsonObject = {}, body?: JsonObject, origin?: string): CompiledRequest => ({
      gateway: platform!.gateway,
      accountId: account,
      action: 'AMCP_CAMPAIGN_REPORT',
      method: body ? 'POST' : 'GET',
      path,
      query,
      body,
      origin,
      // The source's own request headers (LinkedIn's versioning headers, ARC-04 stage F); none by default.
      headers: reports?.requestHeaders?.() ?? {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      evidence: 'Native campaign report, bounded account scope',
      warnings: [],
    });
    let metadata: JsonObject = {},
      currency: string | null = null,
      timezone: string | null = null,
      raw: JsonObject[] = [],
      warnings: string[] = [],
      attribution = 'provider configured',
      resultDefinition = 'unknown',
      complete = true,
      collectionComplete = true;
    // Source-specific context fields returned with the result (for example X campaigns with no reported activity).
    const context: JsonObject = {};
    // RPT-02 scope limits: what a source covers by design. They are disclosed, not counted as incompleteness.
    const scopeLimitations: string[] = [];
    if (accountLookupPlatforms(p)) {
      let d: JsonObject;
      if (lookup?.data) {
        d = lookup.data;
        lineage.push({...lookup.lineage, cached: true});
      } else {
        d = await run(accountPlan(platform!.gateway, account), false, 'account_lookup');
        if (lookup) Object.assign(lookup, {data: d, lineage: lineage.at(-1)});
      }
      metadata = accountMetadata(platform!.gateway, d);
      currency = accountCurrency(platform!.gateway, d);
      timezone = accountTimezone(platform!.gateway, d);
    }
    // RPT-07: Microsoft, Reddit and Apple detail levels reuse their native report paths below.
    const detail = entityLevel.id === 'campaign' ? undefined : entityLevel.id;
    if (detail && !nativeDetailPlatforms.includes(p))
      return collectDetailedOverview(this.service, source, range, actor, metadata, currency, timezone, lookup);
    const detailRounding: Record<string, number> = {};
    let detailRows: {rows: JsonObject[]; parents: Record<string, JsonObject>} | undefined;
    if (reports?.collect) {
      // The platform's own requests, paging and parsing (ARC-04 stage F), with the shared read path and state.
      const collection: ReportCollection = {
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
        metadata,
        currency,
        timezone,
        raw,
        warnings,
        attribution,
        resultDefinition,
        complete,
        collectionComplete,
        context,
        scopeLimitations,
        quality,
        detailRows,
        detailRounding,
      };
      await reports.collect(collection);
      ({metadata, currency, timezone, raw, attribution, resultDefinition, complete, collectionComplete, quality} =
        collection);
      detailRows = collection.detailRows;
    } else if (p === 'reddit') {
      timezone = 'UTC';
      const d = await run(
        plan(
          '/api/v3/ad_accounts/' + account + '/reports',
          {},
          {
            data: {
              starts_at: range.since + 'T00:00:00Z',
              ends_at: nextDay(range.until) + 'T00:00:00Z',
              fields: [...new Set(['SPEND', 'IMPRESSIONS', 'CLICKS', ...extra])],
              // RPT-07: ad group and ad levels break down by their parents too (Reddit allows up to three).
              breakdowns:
                detail === 'adset'
                  ? ['CAMPAIGN_ID', 'AD_GROUP_ID']
                  : detail === 'ad'
                    ? ['CAMPAIGN_ID', 'AD_GROUP_ID', 'AD_ID']
                    : ['CAMPAIGN_ID'],
            },
          },
        ),
      );
      raw = list(d.data?.metrics ?? []);
      const campaigns = list((await run(plan('/api/v3/ad_accounts/' + account + '/campaigns'))).data ?? []);
      if (detail) {
        // Current names from the account's own ad group and ad lists (200 IDs per request, bounded); the report rows
        // already name the parents, and a listed record that disagrees refuses the source.
        const lists = {campaigns, adGroups: [] as JsonObject[], ads: [] as JsonObject[]},
          wanted = (key: string) =>
            [...new Set(raw.map(r => String(r[key] ?? '')))].filter(id => /^[1-9][0-9]{0,31}$/.test(id));
        const named = async (kind: 'ad_groups' | 'ads', ids: string[]) => {
          if (ids.length > nativeDetailLookupLimit) warnings.push(nativeDetailLookupLimitedWarning);
          const out: JsonObject[] = [];
          for (let at = 0; at < Math.min(ids.length, nativeDetailLookupLimit); at += 200) {
            const batch = ids.slice(at, Math.min(at + 200, nativeDetailLookupLimit));
            const rows = list(
              (
                await run(
                  plan('/api/v3/ad_accounts/' + account + '/' + kind, {id: batch.join(','), 'page.size': 200}),
                  true,
                  'detail_names',
                )
              ).data ?? [],
            );
            if (rows.some(r => !batch.includes(String(r.id))))
              throw new MirrorError('REPORT_SHAPE_CHANGED', 'Reddit returned an unrequested entity.', {}, 502);
            out.push(...rows);
          }
          return out;
        };
        try {
          lists.adGroups = await named('ad_groups', wanted('ad_group_id'));
          if (detail === 'ad') lists.ads = await named('ads', wanted('ad_id'));
        } catch (e) {
          // As for Apple: only a provider refusal keeps IDs; AMCP access refusals and malformed lists fail the source.
          if (!optionalReadRefused(e)) throw e;
          lists.adGroups = lists.ads = [];
          warnings.push(
            'Reddit ad group and ad names could not be read, so rows show IDs; parents still come from the report.',
          );
        }
        detailRows = redditDetail(detail, raw, lists, account, detailRounding);
      }
      raw = raw.map(r => ({
        ...r,
        campaign_name: campaigns.find(c => c.id === r.campaign_id)?.name,
        objective: campaigns.find(c => c.id === r.campaign_id)?.objective,
      }));
      warnings.push(
        'Reddit report dates are UTC; monetary conversion values and spend retain their distinct native units in source fields.',
      );
      // ACC-06 interim: the conversion value unit is unverified until the authorized closed-week check is done.
      if (extra.includes('CONVERSION_PURCHASE_TOTAL_VALUE')) warnings.push(redditValueUnitWarning);
      // The result definition stays 'unknown' on purpose (ACC-06): no primary Reddit reference states which purchases
      // and attribution windows these fields count, so sales recommendations keep asking for review (report-metrics).
      // The closed-week check that settles the value unit also names the definition.
    } else if (p === 'ga4') {
      metadata = await run(
        plan('/v1beta/properties/' + account, {}, undefined, 'https://analyticsadmin.googleapis.com'),
        false,
      );
      currency = metadata.currencyCode ?? null;
      timezone = metadata.timeZone ?? null;
      const metrics = [...new Set(['sessions', 'totalUsers', 'keyEvents', 'totalRevenue', ...extra])];
      if (metrics.length > 10)
        bad(
          'GA4 allows at most 10 metrics per request. Create separate saved reports for incompatible or additional metrics.',
        );
      const page = async (dimensions: string[], names: string[]) => {
        const out: {dims: string[]; metrics: JsonObject}[] = [];
        for (let offset = 0; offset < 10000; offset += 1000) {
          const d = await run(
            plan(
              '/v1beta/properties/' + account + ':runReport',
              {},
              {
                dateRanges: [{startDate: range.since, endDate: range.until}],
                dimensions: dimensions.map(name => ({name})),
                metrics: names.map(name => ({name})),
                offset: String(offset),
                limit: '1000',
                keepEmptyRows: true,
                returnPropertyQuota: true,
              },
            ),
            false,
          );
          qualityPages.push(ga4Quality(d.metadata ?? {}, dimensions, offset));
          const restricted = new Set(
            (d.metadata?.schemaRestrictionResponse?.activeMetricRestrictions ?? []).map(
              (v: JsonObject) => v.metricName,
            ),
          );
          const rows = list(d.rows ?? []);
          out.push(
            ...rows.map(r => ({
              dims: list(r.dimensionValues ?? []).map(v => String(v.value ?? '')),
              metrics: Object.fromEntries(
                list(d.metricHeaders ?? []).map((h: JsonObject, i: number) => [
                  String(h.name),
                  restricted.has(h.name) ? null : (r.metricValues as JsonObject[] | undefined)?.[i]?.value,
                ]),
              ),
            })),
          );
          if (d.metadata?.dataLossFromOtherRow || d.metadata?.subjectToThresholding) complete = false;
          if (offset + rows.length >= Number(d.rowCount ?? rows.length)) break;
          if (!rows.length || offset === 9000)
            throw new MirrorError('INCOMPLETE_REPORT', 'GA4 report exceeded the row limit.');
        }
        return out;
      };
      // Metrics come from an ID-only report so GA4 aggregates them itself. One campaign ID can carry
      // several campaign names -- a rename mid-flight, or inconsistent utm_campaign casing -- and
      // summing those rows here would double count users and corrupt ratio metrics such as
      // engagementRate and bounceRate. The name is resolved from a separate sessions-only report.
      const totals = await page(['sessionCampaignId'], metrics),
        labels = await page(['sessionCampaignId', 'sessionCampaignName'], ['sessions']);
      const best = new Map<string, {name: string; sessions: number}>(),
        variants = new Map<string, Set<string>>();
      for (const row of labels) {
        const id = row.dims[0] ?? '',
          name = row.dims[1] ?? '',
          sessions = Number(row.metrics.sessions ?? 0);
        if (!variants.has(id)) variants.set(id, new Set());
        variants.get(id)!.add(name);
        const top = best.get(id);
        if (!top || sessions > top.sessions) best.set(id, {name, sessions});
      }
      // sessionCampaignId can come from manual tagging or linked advertising integrations. (other)
      // is GA4's cardinality overflow bucket. Neither is one campaign, so neither inherits a name.
      const unattributed = (id: string) => !id || id === '(not set)' || id === '(other)';
      const drifted = [...variants].filter(([id, names]) => !unattributed(id) && names.size > 1).map(([id]) => id);
      raw = totals.map(row => {
        const id = row.dims[0] ?? '';
        return {
          campaign_id: unattributed(id) ? id || '(not set)' : id,
          campaign_name: unattributed(id) ? id || '(not set)' : (best.get(id)?.name ?? id),
          ...row.metrics,
        };
      });
      if (totals.some(row => unattributed(row.dims[0] ?? ''))) {
        // Owner policy P6: sessions without a campaign ID limit attribution scope; they do not make GA4 incomplete.
        // Sampling, thresholding, (other)-row data loss, restrictions and truncation still do (summarizeGA4Quality).
        scopeLimitations.push('ga4_unattributed_sessions');
        warnings.push(
          'GA4 returned unassigned or aggregated session campaign IDs. Check linked advertising integrations, tagging and attribution; missing utm_id is only one possible cause.',
        );
      }
      if (drifted.length)
        warnings.push(
          drifted.length +
            ' GA4 campaign ID' +
            (drifted.length === 1 ? '' : 's') +
            ' appeared under more than one campaign name in this range (' +
            drifted.slice(0, 5).join(', ') +
            '). The name with the most sessions is shown; metrics were aggregated by ID at the provider.',
        );
      quality = summarizeGA4Quality(qualityPages);
      if (!quality.measurement_complete) complete = false;
      for (const row of raw) for (const metric of quality.restricted_metrics) row[metric] = null;
      if (quality.sampled) warnings.push('GA4 sampled this report; sampling counts are retained in source quality.');
      if (quality.restricted_metrics.length)
        warnings.push(
          'GA4 access restrictions make these metrics unavailable: ' + quality.restricted_metrics.join(', '),
        );
      if (quality.thresholded || quality.data_loss)
        warnings.push('GA4 thresholding or high-cardinality aggregation limits this report.');
      if (quality.empty_reasons.length)
        warnings.push('GA4 empty response reasons: ' + quality.empty_reasons.join('; '));
      if (quality.truncated)
        warnings.push(
          'GA4 left data out of this report (' +
            quality.truncation_types.join(', ') +
            "); the truncated dates and GA4's explanation are in source quality.",
        );
      resultDefinition =
        'GA4 key events attributed to session campaign ID from manual tagging or linked advertising integrations';
    } else if (p === 'gsc') {
      timezone = 'America/Los_Angeles';
      const d = await run(
        plan(
          '/webmasters/v3/sites/' + encodeURIComponent(account) + '/searchAnalytics/query',
          {},
          {
            startDate: range.since,
            endDate: range.until,
            dimensions: ['page'],
            // RPT-04: request no more rows than one source may hold, so a large site keeps its top pages.
            rowLimit: gscRowLimit,
            startRow: 0,
            dataState: 'final',
          },
        ),
        false,
      );
      raw = list(d.rows ?? []);
      if (raw.length >= gscRowLimit) {
        raw = raw.slice(0, gscRowLimit);
        complete = false;
        collectionComplete = false;
        warnings.push(
          'Search Console returned the 10,000-row request limit; lower-ranked pages are not included, so this organic context is partial.',
        );
      }
      // Owner policy P6: top-row coverage with privacy omissions is the scope of this organic source, not a failure.
      scopeLimitations.push('search_console_top_rows');
      warnings.push(
        'Search Console reports pages, not paid campaigns, and returns top rows with privacy omissions. This is organic context, not a reconciled advertising total.',
      );
    }
    if (raw.length > 10000)
      throw new MirrorError('REPORT_ROW_LIMIT', 'Report exceeds 10,000 rows. Narrow the date range or accounts.');
    this.service.store.assertActorActive(actor);
    this.service.store.resolveConnection(actor, platform!.gateway, account, connection);
    if (detail)
      return nativeDetailResult(source, detailRows!, raw, {
        lineage,
        metadata,
        currency,
        timezone,
        range,
        providerComplete: complete,
        resultDefinition,
        warnings,
        context,
        rounding: detailRounding,
      });
    const rows = raw.map(r => normalizeNativeRow(p, r));
    for (const name of missingNativeMetrics(p, extra, rows))
      warnings.push(
        'Requested native metric ' +
          name +
          ' was not returned as a number; formulas that use it stay unavailable. Check the field name for this provider.',
      );
    return {
      contract_version: reportContractVersion,
      quality: scopeLimitations.length ? {...quality, scope_limitations: scopeLimitations} : quality,
      lineage,
      query_fingerprint: fingerprint(lineage.map(l => l.query_fingerprint)),
      rows,
      account_name: metadata.name ?? metadata.displayName ?? null,
      date_range: range,
      metadata,
      currency,
      timezone,
      complete,
      collection_complete: collectionComplete,
      ...context,
      ...(scopeLimitations.length ? {scope_limitations: scopeLimitations} : {}),
      attribution,
      result_definition: resultDefinition,
      warnings,
      source_kind: platform!.kind,
      captured_at: Date.now(),
    };
  }
}
const nextDay = (date: string) => new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);
const eachDay = (range: {since: string; until: string}) => {
  const days: string[] = [];
  for (let day = range.since; day <= range.until; day = nextDay(day)) days.push(day);
  return days;
};

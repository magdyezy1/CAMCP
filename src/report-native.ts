import {fingerprint, reportContractVersion, ga4Quality, summarizeGA4Quality} from './report-quality.js';
import {linkedinVersion} from './linkedin-version.js';
import {
  xCampaignObjectives,
  xCampaignReport,
  xObjectivesMixedWarning,
  xObjectivesUnavailableWarning,
} from './x-campaign-report.js';
import {xActiveEntities, xActiveEntitiesMode, xActiveSet} from './x-active-entities.js';
import {metaCampaignRows} from './meta-report.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import type {MirrorService} from './service.js';
import {MirrorError} from './errors.js';
import {accountPlan, accountMetadata, accountCurrency, accountTimezone} from './workspace.js';
import {compileMicrosoft} from './microsoft-native.js';
import {reportPlatforms, metricNumber, objectiveGroup} from './report-metrics.js';
import {zonedMidnight} from './workflows.js';
import {googleAdsCustomers} from './google-version.js';
import {metaPrefix} from './meta-version.js';
import {metaWindowsOrdered} from './meta-attribution-windows.js';
import {linkedInCampaignMetadata, linkedInCampaignPeriod} from './linkedin-reporting.js';
import {campaignAttributionProfile, overviewSourceLevel, collectDetailedOverview} from './overview-granularity.js';
import {detailParentsUnavailableWarning, optionalReadRefused, type DetailParentCache} from './overview-parents.js';
import {
  appleDetail,
  microsoftDetail,
  nativeDetailLookupLimit,
  nativeDetailLookupLimitedWarning,
  nativeDetailPlatforms,
  nativeDetailResult,
  redditDetail,
} from './overview-native-detail.js';
import {markReportWindow} from './report-windows.js';
import {
  assertMicrosoftWindowClosed,
  microsoftCompleteData,
  microsoftFallbackReportTimeZone,
  microsoftFallbackWarning,
  microsoftReportZone,
} from './microsoft-timezones.js';

export const nativeMetricExamples: Record<string, string[]> = {
  google: [
    'metrics.all_conversions',
    'metrics.all_conversions_value',
    'metrics.interactions',
    'metrics.video_views',
    'metrics.engagements',
    'metrics.view_through_conversions',
  ],
  meta: [
    'inline_link_clicks',
    'outbound_clicks',
    'unique_clicks',
    'video_play_actions',
    'video_p25_watched_actions',
    'video_p50_watched_actions',
    'video_p75_watched_actions',
    'video_p100_watched_actions',
    'cost_per_action_type',
  ],
  tiktok: [
    'reach',
    'frequency',
    'video_play_actions',
    'video_watched_2s',
    'video_watched_6s',
    'video_views_p100',
    'likes',
    'comments',
    'shares',
    'follows',
    'total_purchase',
    'total_purchase_value',
  ],
  snapchat: [
    'video_views',
    'view_completion',
    'conversion_purchases',
    'conversion_purchases_value',
    'conversion_sign_ups',
    'total_installs',
  ],
  linkedin: [
    'videoViews',
    'videoCompletions',
    'likes',
    'comments',
    'shares',
    'externalWebsiteConversions',
    'externalWebsitePostClickConversions',
    'externalWebsitePostViewConversions',
    'conversionValueInLocalCurrency',
    'oneClickLeads',
  ],
  x: ['VIDEO', 'WEB_CONVERSION', 'MOBILE_CONVERSION'],
  microsoft: [
    'AllConversions',
    'AllRevenue',
    'Assists',
    'ViewThroughConversions',
    'QualityScore',
    'PhoneCalls',
    'ImpressionSharePercent',
  ],
  apple: [],
  reddit: [
    'VIDEO_STARTED',
    'VIDEO_VIEWABLE_IMPRESSIONS',
    'CONVERSION_PURCHASE_TOTAL_ITEMS',
    'CONVERSION_PURCHASE_TOTAL_VALUE',
  ],
  ga4: [
    'engagedSessions',
    'engagementRate',
    'bounceRate',
    'screenPageViews',
    'averageSessionDuration',
    'eventCount',
    'ecommercePurchases',
    'purchaseRevenue',
  ],
  gsc: [],
};
const bad = (message: string) => {
  throw new MirrorError('INVALID_REPORT_SOURCE', message);
};
/** RPT-04: TikTok campaign reporting reads `AUCTION_CAMPAIGN` data only. */
const tiktokAuctionOnlyWarning =
  'TikTok campaign reporting covers auction campaigns only (AUCTION_CAMPAIGN); Reach & Frequency and other reserved campaigns are not included.';
export function reportRange(range: JsonObject) {
  if (
    !range ||
    !['since', 'until'].every(
      k =>
        typeof range[k] === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(range[k]) &&
        Number.isFinite(Date.parse(range[k])) &&
        new Date(range[k]).toISOString().slice(0, 10) === range[k],
    ) ||
    range.since > range.until ||
    Date.parse(range.until) - Date.parse(range.since) > 365 * 86400000
  )
    bad('Choose a valid inclusive date range of at most 366 days.');
  return range as {since: string; until: string};
}
const list = (v: unknown): JsonObject[] => {
  if (!Array.isArray(v) || v.some(x => !x || typeof x !== 'object' || Array.isArray(x)))
    throw new MirrorError('REPORT_SHAPE_CHANGED', 'The provider returned an unexpected report collection.', {}, 502);
  return v;
};
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
const nativeMetricContainers: Record<string, string> = {google: 'metrics', tiktok: 'metrics', snapchat: 'stats'};
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
export function normalizeNativeRow(platform: string, raw: JsonObject): JsonObject {
  let id: any,
    name: any,
    objective: any,
    metrics: JsonObject = {},
    currency: any = null,
    resultDefinition: string | undefined,
    mixedResult = false;
  const p = platform,
    n = (k: string, d = 1) => value(raw[k], d),
    omitted = new Set<string>();
  if (p === 'google') {
    id = raw.campaign?.id;
    name = raw.campaign?.name;
    objective = null;
    currency = raw.customer?.currencyCode;
    const m = raw.metrics ?? {};
    metrics = {
      spend: value(m.costMicros, 1e6),
      impressions: value(m.impressions),
      clicks: value(m.clicks),
      conversions: value(m.conversions),
      conversion_value: value(m.conversionsValue),
      video_views: value(m.videoViews),
      engagements: value(m.engagements),
    };
  }
  if (p === 'meta') {
    id = raw.campaign_id;
    name = raw.campaign_name;
    objective = raw.objective;
    // RPT-04 (owner policy P6): Meta omits zero-valued action entries. A delivered row (impressions above 0) from a
    // complete page counts an absent requested action as 0 and names it in `omitted_as_zero`; a row without delivery
    // keeps it unknown.
    const delivered = (metricNumber(raw.impressions) ?? 0) > 0;
    const action = (metric: string, keys: string[], field = 'actions') => {
      const a = raw[field];
      if (Array.isArray(a))
        for (const key of keys) {
          const found = a.find((v: JsonObject) => v?.action_type === key);
          if (found) return value(found.value);
        }
      if (delivered && (a === undefined || Array.isArray(a))) {
        omitted.add(metric);
        return 0;
      }
      return null;
    };
    const leads = action('leads', ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead']),
      purchases = action('purchases', ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase']),
      installs = action('installs', ['mobile_app_install', 'app_install']),
      result: [number | null, string] | undefined =
        objectiveGroup(objective) === 'leads'
          ? [leads, 'leads']
          : objectiveGroup(objective) === 'app_installs'
            ? [installs, 'installs']
            : objectiveGroup(objective) === 'sales'
              ? [purchases, 'purchases']
              : undefined;
    if (result && omitted.has(result[1])) omitted.add('conversions');
    metrics = {
      spend: n('spend'),
      impressions: n('impressions'),
      clicks: n('clicks'),
      reach: n('reach'),
      frequency: n('frequency'),
      leads,
      purchases,
      installs,
      conversions: result ? result[0] : null,
      conversion_value: action(
        'conversion_value',
        ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase'],
        'action_values',
      ),
      video_views: action('video_views', ['video_view']),
      engagements: action('engagements', ['post_engagement']),
    };
  }
  if (p === 'tiktok') {
    id = raw.dimensions?.campaign_id;
    const m = raw.metrics ?? {};
    name = m.campaign_name;
    objective = raw.objective_type;
    // RPT-04: the result definition names the campaign's ad group optimization events; mixed events are held.
    const events: string[] = Array.isArray(raw.optimization_events) ? raw.optimization_events : [];
    if (events.length === 1) resultDefinition = 'TikTok conversions for optimization event ' + events[0];
    else if (events.length > 1) {
      resultDefinition = 'TikTok conversions mixing optimization events: ' + events.join(', ');
      mixedResult = true;
    }
    metrics = {
      spend: value(m.spend),
      impressions: value(m.impressions),
      clicks: value(m.clicks),
      conversions: value(m.conversion),
      reach: value(m.reach),
      frequency: value(m.frequency),
      video_views: value(m.video_play_actions),
      video_completions: value(m.video_views_p100),
      purchases: value(m.total_purchase),
      conversion_value: value(m.total_purchase_value),
    };
  }
  if (p === 'snapchat') {
    id = raw.id;
    name = raw.name;
    objective = raw.objective;
    const m = raw.stats ?? {};
    metrics = {
      spend: value(m.spend, 1e6),
      impressions: value(m.impressions),
      clicks: value(m.swipes),
      purchases: value(m.conversion_purchases),
      conversion_value: value(m.conversion_purchases_value, 1e6),
      leads: value(m.conversion_sign_ups),
      installs: value(m.total_installs),
      video_views: value(m.video_views),
      video_completions: value(m.view_completion),
    };
    metrics.conversions =
      objectiveGroup(objective) === 'app_installs'
        ? metrics.installs
        : objectiveGroup(objective) === 'leads'
          ? metrics.leads
          : objectiveGroup(objective) === 'sales'
            ? metrics.purchases
            : null;
  }
  if (p === 'linkedin') {
    id = raw.pivotValues?.[0]?.split(':').at(-1);
    name = raw.name;
    objective = raw.objectiveType;
    metrics = {
      spend: n('costInLocalCurrency'),
      impressions: n('impressions'),
      clicks: n('clicks'),
      conversions: n('externalWebsiteConversions'),
      conversion_value: n('conversionValueInLocalCurrency'),
      leads: n('oneClickLeads'),
      video_views: n('videoViews'),
      video_completions: n('videoCompletions'),
    };
  }
  if (p === 'x') {
    id = raw.id;
    name = raw.name;
    objective = raw.objective;
    metrics = raw.metrics ?? {};
  }
  if (p === 'microsoft') {
    id = raw.CampaignId;
    name = raw.CampaignName;
    currency = raw.CurrencyCode;
    metrics = {
      spend: n('Spend'),
      impressions: n('Impressions'),
      clicks: n('Clicks'),
      conversions: n('Conversions'),
      conversion_value: n('Revenue'),
    };
  }
  if (p === 'apple') {
    id = raw.metadata?.id;
    name = raw.metadata?.name;
    objective = 'APP_INSTALLS';
    const m = raw.totalMetrics;
    if (!m || typeof m !== 'object' || Array.isArray(m))
      throw new MirrorError('REPORT_SHAPE_CHANGED', 'Apple v1 report row is missing totalMetrics.', {}, 502);
    currency = m.localSpend?.currency;
    metrics = {
      spend: value(m.localSpend?.amount),
      impressions: value(m.impressions),
      clicks: value(m.taps),
      installs: value(m.totalInstalls),
      conversions: value(m.totalInstalls),
    };
  }
  if (p === 'reddit') {
    id = raw.campaign_id ?? raw.CAMPAIGN_ID;
    name = raw.campaign_name;
    objective = raw.objective;
    metrics = {
      spend: value(raw.SPEND ?? raw.spend, 1e6),
      impressions: value(raw.IMPRESSIONS ?? raw.impressions),
      clicks: value(raw.CLICKS ?? raw.clicks),
      purchases: value(raw.CONVERSION_PURCHASE_TOTAL_ITEMS ?? raw.conversion_purchase_total_items),
      conversion_value: value(raw.CONVERSION_PURCHASE_TOTAL_VALUE ?? raw.conversion_purchase_total_value, 100),
    };
  }
  if (p === 'ga4') {
    id = raw.campaign_id;
    name = raw.campaign_name;
    metrics = {
      sessions: n('sessions'),
      users: n('totalUsers'),
      conversions: n('keyEvents'),
      conversion_value: n('totalRevenue'),
      purchases: n('ecommercePurchases'),
    };
  }
  if (p === 'gsc') {
    id = raw.keys?.[0] ?? 'site';
    name = id;
    metrics = {clicks: n('clicks'), impressions: n('impressions'), position: n('position')};
  }
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
    metrics: {...metrics, ...numericNative(platform, raw)},
    ...(omitted.size ? {omitted_as_zero: [...omitted].sort()} : {}),
    ...(resultDefinition ? {result_definition: resultDefinition} : {}),
    ...(mixedResult ? {mixed_result_definition: true} : {}),
    native: raw,
  };
}
/**
 * RPT-03: one account lookup per source per job. Later periods reuse the first read (lineage marks it `cached`), and
 * `verifyAccount` re-reads once after collection so a currency or time-zone change during a long run is still caught.
 */
export interface AccountLookupCache {
  data?: JsonObject;
  lineage?: JsonObject;
  /**
   * RPT-04: TikTok ad group optimization events per campaign, read once per source per job like the account lookup
   * (not once per period). `unavailable` records a non-retryable failure of this optional read.
   */
  tiktokEvents?: {events: Record<string, string[]>; lineage?: JsonObject; unavailable?: boolean};
  /**
   * RPT-07: current LinkedIn campaign names and objectives by URN, read once per source per job for the URNs reported
   * so far (later periods read only new URNs). `unavailable` records a non-retryable refusal of this optional read.
   */
  linkedinCampaigns?: {campaigns: Record<string, JsonObject>; lineage: JsonObject[]; unavailable?: boolean};
  /** RPT-07: native parents of detailed entities, read once per entity per source per job (overview-parents.ts). */
  detailParents?: DetailParentCache;
}
/** Shown when LinkedIn refused the campaign metadata read, so rows keep campaign IDs and unknown objectives. */
export const linkedinCampaignsUnavailableWarning =
  'LinkedIn campaign names and objectives could not be read, so rows show campaign IDs and objectives stay unknown unless confirmed in report settings.';
/** Shown when TikTok's ad group read failed, so result definitions fall back to the generic one. */
export const tiktokEventsUnavailableWarning =
  'TikTok ad group optimization events could not be read, so conversions use one generic result definition and campaigns optimizing for different events are not told apart.';
/** Campaign-level sources whose provider segments one request by day (RPT-03, contract campaign-source-v4). */
export const nativeDailyPlatforms: readonly string[] = ['google', 'meta'];
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
      days = new Map<string, JsonObject[]>();
    for (const day of eachDay(result.date_range)) days.set(day, []);
    for (const row of result.rows) {
      const day = source.platform === 'google' ? row.native?.segments?.date : row.native?.date_start;
      if (
        typeof day !== 'string' ||
        !days.has(day) ||
        (source.platform === 'meta' && row.native?.date_stop !== undefined && row.native.date_stop !== day)
      )
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
      platform = reportPlatforms[p];
    if (!platform) bad('Unsupported reporting platform.');
    const account = String(source.account_id),
      connection = String(source.connection_id),
      range = reportRange(dates),
      extra = source.native_metrics ?? [];
    if (
      !Array.isArray(extra) ||
      extra.length > 30 ||
      extra.some(
        x =>
          typeof x !== 'string' ||
          !(/^[A-Za-z][A-Za-z0-9_]{0,90}$/.test(x) || (p === 'google' && /^metrics\.[a-z][a-z0-9_]{0,80}$/.test(x))),
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
      headers: p === 'linkedin' ? {'LinkedIn-Version': linkedinVersion(), 'X-Restli-Protocol-Version': '2.0.0'} : {},
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
    if (p === 'google') {
      const fields = [
        ...new Set([
          'campaign.id',
          'campaign.name',
          'campaign.status',
          'campaign.advertising_channel_type',
          'customer.currency_code',
          'metrics.cost_micros',
          'metrics.impressions',
          'metrics.clicks',
          'metrics.conversions',
          'metrics.conversions_value',
          ...(segment === 'daily' ? ['segments.date'] : []),
          ...extra,
        ]),
      ];
      raw = list(
        (
          await run(
            plan(
              googleAdsCustomers + account + '/googleAds:search',
              {},
              {
                query: `SELECT ${fields.join(', ')} FROM campaign WHERE segments.date BETWEEN '${range.since}' AND '${range.until}'`,
              },
            ),
          )
        ).results ?? [],
      );
      resultDefinition = 'Google primary conversions (conversions column; interaction date)';
    } else if (p === 'meta') {
      // RPT-04: an optional campaign-level attribution profile uses the detailed preset's explicit windows.
      const profile = campaignAttributionProfile(source),
        windows = profile ? metaWindowsOrdered(profile.attribution_windows) : undefined;
      raw = metaCampaignRows(
        await run(
          plan(metaPrefix + 'act_' + account + '/insights', {
            level: 'campaign',
            time_range: rangeToMeta(range),
            fields: [
              ...new Set([
                'account_id',
                'account_name',
                'date_start',
                'date_stop',
                'campaign_id',
                'campaign_name',
                'objective',
                'spend',
                'impressions',
                'clicks',
                'reach',
                'frequency',
                'actions',
                'action_values',
                ...extra,
              ]),
            ].join(','),
            limit: 500,
            ...(windows
              ? {
                  action_report_time: 'impression',
                  action_attribution_windows: windows,
                  use_account_attribution_setting: false,
                  use_unified_attribution_setting: false,
                }
              : {use_unified_attribution_setting: true}),
            ...(segment === 'daily' ? {time_increment: 1} : {}),
          }),
        ),
        account,
        range,
      );
      attribution = windows
        ? 'Meta ' + windows.join(' + ') + '; impression time'
        : 'ad set unified attribution setting';
      resultDefinition = 'Objective-mapped lead, purchase or app-install action; aliases are not summed';
    } else if (p === 'tiktok') {
      const d = await run(
        plan('/v1.3/report/integrated/get/', {
          advertiser_id: account,
          report_type: 'BASIC',
          data_level: 'AUCTION_CAMPAIGN',
          dimensions: ['campaign_id'],
          metrics: [...new Set(['campaign_name', 'spend', 'impressions', 'clicks', 'conversion', ...extra])],
          start_date: range.since,
          end_date: range.until,
          page: 1,
          page_size: 1000,
        }),
      );
      raw = list(d.data?.list ?? []);
      const inventory = list(
        (await run(plan('/v1.3/campaign/get/', {advertiser_id: account, page: 1, page_size: 1000}))).data?.list ?? [],
      );
      // RPT-04: TikTok's `conversion` follows each ad group's optimization event. One bounded ad group inventory read
      // per source and job (cached across periods, like the account lookup) names the events per campaign, so
      // summaries never add conversions of different events into one result. The read is optional: a non-retryable
      // failure (a refusal, or more pages than the bound) keeps the source with the generic result definition and a
      // warning; a retryable one retries the job.
      let adgroupEvents = lookup?.tiktokEvents;
      if (adgroupEvents?.lineage) lineage.push({...adgroupEvents.lineage, cached: true});
      if (!adgroupEvents) {
        try {
          const adgroups = list(
            (
              await run(
                plan('/v1.3/adgroup/get/', {advertiser_id: account, page: 1, page_size: 1000}),
                true,
                'adgroups',
              )
            ).data?.list ?? [],
          );
          const events = new Map<string, Set<string>>();
          for (const group of adgroups) {
            const campaign = String(group.campaign_id ?? '');
            if (!campaign) continue;
            const event =
              [group.optimization_goal, group.optimization_event]
                .filter(v => typeof v === 'string' && /^[A-Za-z0-9_.]{1,80}$/.test(v))
                .join(' / ') || 'unknown';
            events.set(campaign, (events.get(campaign) ?? new Set()).add(event));
          }
          adgroupEvents = {
            events: Object.fromEntries([...events].map(([campaign, set]) => [campaign, [...set].sort()])),
            lineage: lineage.at(-1),
          };
        } catch (e) {
          if (!(e instanceof MirrorError) || e.retryable) throw e;
          adgroupEvents = {events: {}, unavailable: true};
        }
        if (lookup) lookup.tiktokEvents = adgroupEvents;
      }
      if (adgroupEvents.unavailable) warnings.push(tiktokEventsUnavailableWarning);
      const campaignEvents = adgroupEvents.events;
      raw = raw.map(r => ({
        ...r,
        objective_type: inventory.find(c => String(c.campaign_id) === String(r.dimensions?.campaign_id))
          ?.objective_type,
        optimization_events: Object.hasOwn(campaignEvents, String(r.dimensions?.campaign_id))
          ? campaignEvents[String(r.dimensions?.campaign_id)]
          : [],
      }));
      resultDefinition = 'TikTok conversion metric for the selected optimization goal';
      warnings.push(tiktokAuctionOnlyWarning);
    } else if (p === 'snapchat') {
      if (!timezone) bad('Snapchat account timezone is required.');
      // RPT-04: an optional campaign-level attribution profile uses the detailed preset's windows and conversion time.
      const profile = campaignAttributionProfile(source),
        swipe = profile?.swipe_up_attribution_window ?? '28_DAY',
        view = profile?.view_attribution_window ?? '1_DAY';
      const start = new Date(zonedMidnight(range.since, timezone!, true)).toISOString(),
        end = new Date(zonedMidnight(nextDay(range.until), timezone!, true)).toISOString();
      const d = await run(
        plan('/v1/adaccounts/' + account + '/stats', {
          granularity: 'TOTAL',
          breakdown: 'campaign',
          start_time: start,
          end_time: end,
          fields: [
            ...new Set([
              'spend',
              'impressions',
              'swipes',
              'conversion_purchases',
              'conversion_purchases_value',
              'conversion_sign_ups',
              'total_installs',
              'video_views',
              'view_completion',
              ...extra,
            ]),
          ].join(','),
          swipe_up_attribution_window: swipe,
          view_attribution_window: view,
          ...(profile ? {action_report_time: 'conversion', conversion_source_types: 'total'} : {}),
          omit_empty: false,
        }),
      );
      raw = list(d.total_stats ?? []).flatMap(r => list(r.total_stat?.breakdown_stats?.campaign ?? []));
      const campaigns = list((await run(plan('/v1/adaccounts/' + account + '/campaigns'))).campaigns ?? []).map(
        r => r.campaign,
      );
      raw = raw.map(r => ({
        ...r,
        name: campaigns.find(c => c.id === r.id)?.name,
        objective: campaigns.find(c => c.id === r.id)?.objective,
      }));
      attribution = profile
        ? 'Snapchat ' + swipe + ' swipe / ' + view + ' view; conversion time; total sources'
        : '28-day swipe / 1-day view';
      resultDefinition = 'Objective-specific purchases, sign-ups or installs when explicitly requested';
    } else if (p === 'linkedin') {
      timezone = 'UTC';
      if (String(metadata.id ?? '') !== account)
        throw new MirrorError('REPORT_ACCOUNT_MISMATCH', 'LinkedIn returned a different or missing account ID.');
      if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))
        throw new MirrorError('REPORT_CURRENCY_MISMATCH', 'LinkedIn did not return a valid native account currency.');
      const date = (s: string) => {
        const [year, month, day] = s.split('-').map(Number);
        return `(year:${year},month:${month},day:${day})`;
      };
      const fields = [
        ...new Set(['impressions', 'clicks', 'costInLocalCurrency', 'externalWebsiteConversions', ...extra]),
      ];
      if (fields.length > 18) bad('LinkedIn permits at most 18 selected metrics with campaign identifiers.');
      const d = await run(
        plan('/rest/adAnalytics', {
          q: 'analytics',
          pivot: 'CAMPAIGN',
          accounts: 'List(urn:li:sponsoredAccount:' + account + ')',
          dateRange: `(start:${date(range.since)},end:${date(range.until)})`,
          timeGranularity: 'ALL',
          fields: ['pivotValues', 'dateRange', ...fields].join(','),
        }),
        false,
      );
      raw = linkedInCampaignPeriod(d, range);
      // RPT-07: names and objectives of the reported campaigns, read from the account's own campaigns after the
      // analytics response (cached per job; a later period reads only campaigns not seen before).
      const known = lookup?.linkedinCampaigns ?? {campaigns: {}, lineage: []};
      for (const entry of known.lineage) lineage.push({...entry, cached: true});
      const missing = known.unavailable
        ? []
        : raw.map(r => String(r.pivotValues[0])).filter(urn => !Object.hasOwn(known.campaigns, urn));
      if (missing.length)
        try {
          const before = lineage.length,
            read = await linkedInCampaignMetadata(account, missing, query =>
              run(plan('/rest/adAccounts/' + account + '/adCampaigns', query), false, 'campaign_metadata'),
            );
          known.lineage.push(...lineage.slice(before));
          for (const urn of missing) known.campaigns[urn] = read.campaigns[urn] ?? {name: null, objective_type: null};
        } catch (e) {
          // Only a provider refusal of this optional read keeps IDs. A foreign account, malformed or partial metadata,
          // a retryable failure, or a revoked connection, changed login or scope refusal fails the source.
          if (!optionalReadRefused(e)) throw e;
          known.unavailable = true;
        }
      if (lookup) lookup.linkedinCampaigns = known;
      if (known.unavailable) warnings.push(linkedinCampaignsUnavailableWarning);
      raw = raw.map(r => {
        const campaign = known.campaigns[String(r.pivotValues[0])];
        return {
          ...r,
          ...(campaign?.name ? {name: campaign.name} : {}),
          ...(campaign?.objective_type ? {objectiveType: campaign.objective_type} : {}),
        };
      });
      attribution = 'unknown';
      resultDefinition = 'Attributed external website conversions';
      warnings.push(
        known.unavailable
          ? 'LinkedIn conversion-rule attribution windows are not independently verified. Campaign objectives should be confirmed in report settings.'
          : 'LinkedIn conversion-rule attribution windows are not independently verified; the verified-window preset is linkedin_campaign_conversion. Campaign names and objectives are current campaign metadata, not the values at delivery time.',
      );
    } else if (p === 'x') {
      if (!timezone) bad('X account timezone is required.');
      const inventory =
        checkpoint.x_inventory ??
        list((await run(plan('/12/accounts/' + account + '/campaigns', {count: 1000, with_deleted: true}))).data ?? []);
      const start = zonedMidnight(range.since, timezone!),
        end = zonedMidnight(nextDay(range.until), timezone!),
        mode = xActiveEntitiesMode();
      // RPT-03: the inventory names campaigns; X active entities decide which campaigns and windows are requested.
      let active = xActiveSet(checkpoint.x_active),
        fallback = checkpoint.x_active_fallback === true;
      if (mode !== 'off' && !active && !fallback)
        try {
          active = await xActiveEntities(start, end, q =>
            run(plan('/12/stats/accounts/' + account + '/active_entities', q), false, 'active_entities'),
          );
        } catch (e) {
          // A rejected read keeps the bounded inventory path (fails closed above 100 requests); a malformed or
          // partial response is never narrowed and fails the source.
          if (!(e instanceof MirrorError) || e.retryable || ![400, 404, 422].includes(e.status)) throw e;
          fallback = true;
        }
      if (fallback)
        warnings.push(
          'X refused the active-entities read; every listed campaign was requested instead (at most 100 analytics requests).',
        );
      // RPT-07: objectives come from the account's line items (one bounded read, kept with the checkpoint so a resumed
      // run uses the same answer). A refused or oversized read keeps objectives unknown with a warning.
      let objectives: JsonObject | undefined = checkpoint.x_objectives;
      if (!objectives)
        try {
          objectives = xCampaignObjectives(
            inventory,
            list(
              (
                await run(
                  plan('/12/accounts/' + account + '/line_items', {count: 1000, with_deleted: true}),
                  true,
                  'line_item_objectives',
                )
              ).data ?? [],
            ),
          );
        } catch (e) {
          // Only a provider refusal (HTTP 400/403/404) or a line item collection above the page bound
          // (INCOMPLETE_REPORT) keeps objectives unknown. A malformed line item, a retryable failure, or a removed
          // connection, changed login or scope refusal fails the source, as for the LinkedIn campaign metadata read.
          if (!(e instanceof MirrorError && e.code === 'INCOMPLETE_REPORT' && !e.retryable) && !optionalReadRefused(e))
            throw e;
          objectives = {unavailable: true, campaigns: {}};
        }
      if (objectives.unavailable) warnings.push(xObjectivesUnavailableWarning);
      else if (Object.values(objectives.campaigns ?? {}).includes(null)) warnings.push(xObjectivesMixedWarning);
      const state = {
        x_inventory: inventory,
        ...(active ? {x_active: active} : {}),
        ...(fallback ? {x_active_fallback: true} : {}),
        x_objectives: objectives,
      };
      if (
        !checkpoint.x_inventory ||
        (active && !checkpoint.x_active) ||
        (fallback && !checkpoint.x_active_fallback) ||
        !checkpoint.x_objectives
      )
        save(state);
      const report = await xCampaignReport(
        inventory,
        start,
        end,
        extra,
        q => run(plan('/12/stats/accounts/' + account, q), false),
        {
          checkpoint: checkpoint.x_report,
          save: x_report => save({...state, x_report}),
          ...(active ? {active, windows: mode === 'on'} : {}),
        },
      );
      raw = report.rows.map(row => ({...row, objective: objectives!.campaigns?.[row.id] ?? row.objective}));
      complete = report.complete;
      collectionComplete = report.complete;
      context.no_activity_count = report.no_activity_count;
      warnings.push(...report.warnings);
    } else if (p === 'microsoft') {
      // RPT-04 (owner policy P6): report days follow the account time zone. A checkpoint from an earlier London-zone
      // run keeps its own zone, so a resumed report is never re-labelled.
      const zone =
        checkpoint.report_id && checkpoint.report_time_zone === undefined
          ? microsoftReportZone(microsoftFallbackReportTimeZone)
          : microsoftReportZone(checkpoint.report_time_zone ?? timezone);
      timezone = zone.timezone;
      const date = (s: string) => {
        const [Year, Month, Day] = s.split('-').map(Number);
        return {Year, Month, Day};
      };
      let reportId = checkpoint.report_id;
      if (!reportId) {
        assertMicrosoftWindowClosed(range, zone.timezone);
        const d = await microsoftCompleteData(() =>
          run(
            compileMicrosoft({
              action: 'SubmitGenerateReport',
              account_id: account,
              payload: {
                ReportRequest: {
                  // RPT-07: ad group and ad levels use the native performance reports that name their parents.
                  Type:
                    detail === 'adset'
                      ? 'AdGroupPerformanceReportRequest'
                      : detail === 'ad'
                        ? 'AdPerformanceReportRequest'
                        : 'CampaignPerformanceReportRequest',
                  Aggregation: 'Summary',
                  Format: 'Csv',
                  ReportName:
                    detail === 'adset'
                      ? 'AMCP ad group overview'
                      : detail === 'ad'
                        ? 'AMCP ad overview'
                        : 'AMCP campaign overview',
                  ReturnOnlyCompleteData: true,
                  Columns: [
                    ...new Set([
                      'AccountId',
                      'CampaignId',
                      'CampaignName',
                      ...(detail ? ['AdGroupId', 'AdGroupName'] : []),
                      ...(detail === 'ad' ? ['AdId', 'AdTitle'] : []),
                      'CurrencyCode',
                      'Spend',
                      'Impressions',
                      'Clicks',
                      'Conversions',
                      'Revenue',
                      ...extra,
                    ]),
                  ],
                  Scope: {AccountIds: [account]},
                  Time: {
                    CustomDateRangeStart: date(range.since),
                    CustomDateRangeEnd: date(range.until),
                    ReportTimeZone: zone.report_time_zone,
                  },
                },
              },
            }),
            false,
          ),
        );
        reportId = d.ReportRequestId;
        save({report_id: reportId, report_time_zone: zone.report_time_zone});
      }
      let offset = 0;
      for (let page = 0; page < 100; page++) {
        const d = await microsoftCompleteData(() =>
          run(
            compileMicrosoft({
              action: 'PollGenerateReport',
              account_id: account,
              payload: {ReportRequestId: reportId},
              download_report: true,
              offset,
              limit: 100,
            }),
            false,
          ),
        );
        if (d.ReportRequestStatus?.Status === 'Pending' || d.status === 'Pending')
          throw new MirrorError(
            'REPORT_PENDING',
            'Microsoft is preparing the report.',
            {retry_after_ms: 30000, report_id: reportId},
            503,
            true,
          );
        if (!d.download_complete)
          throw new MirrorError('REPORT_DOWNLOAD_FAILED', 'Microsoft report is not complete.', {}, 502);
        raw.push(...list(d.rows));
        if (d.potentially_incomplete !== false) complete = false;
        if (!d.has_more) break;
        offset += d.rows.length;
        if (!d.rows.length || page === 99)
          throw new MirrorError('INCOMPLETE_REPORT', 'Microsoft report exceeded the row limit.');
      }
      resultDefinition = 'Microsoft conversions included in the Conversions column';
      context.report_time_zone = zone.report_time_zone;
      if (zone.fallback) warnings.push(microsoftFallbackWarning);
      if (detail) detailRows = microsoftDetail(detail, account, currency, raw, detailRounding);
    } else if (p === 'apple') {
      const m = await run({...plan('/v1/ad-accounts/' + account), origin: 'https://api.ads.apple.com'}, false);
      metadata = m.result ?? m;
      currency = metadata.currency ?? null;
      timezone = 'UTC';
      if (detail) {
        // RPT-07: one bounded ad group or ad report page, then the account's own records for exact parents.
        const entity = detail === 'ad' ? 'ads' : 'adgroups',
          apple = (path: string, body: JsonObject, action: string, stage?: string) =>
            run({...plan(path, {}, body, 'https://api.ads.apple.com'), action}, false, stage);
        const d = await apple(
          '/v1/reports/apps/' + entity + '/query',
          {
            timeRange: {start: range.since, end: range.until, timeZone: 'UTC'},
            pagination: {offset: 0, pageSize: 1000},
            options: {},
          },
          'apple_ads_v1_reports_apps_' + entity,
        );
        raw = list(d.result?.rows ?? []);
        const total = d.pagination?.totalResults ?? d.result?.pagination?.totalResults;
        if (raw.length >= 1000 || (total !== undefined && Number(total) !== raw.length))
          throw new MirrorError(
            'INCOMPLETE_REPORT',
            'Report reached a pagination limit. Split the date range or accounts.',
          );
        // Apple IDs are JSON numbers; only safe integers can be requested and matched exactly.
        const safeId = (id: string) => /^[1-9][0-9]{0,15}$/.test(id) && Number.isSafeInteger(Number(id)),
          lists = {campaigns: [] as JsonObject[], adGroups: [] as JsonObject[], ads: [] as JsonObject[]},
          ids = [...new Set(raw.map(r => String(r.metadata?.id ?? '')))].filter(safeId);
        if (ids.length > nativeDetailLookupLimit) warnings.push(nativeDetailLookupLimitedWarning);
        const query = async (kind: 'campaigns' | 'adgroups' | 'ads', wanted: string[]) => {
          if (!wanted.length) return [];
          const rows = list(
            (
              await apple(
                '/v1/' + kind + '/query',
                {
                  filters: [{field: 'id', operator: 'IN', value: wanted.map(Number)}],
                  pagination: {offset: 0, pageSize: 1000},
                },
                'apple_ads_v1_' + kind + '_query',
                'detail_parents',
              )
            ).result ?? [],
          );
          if (rows.length > wanted.length || rows.some(r => !wanted.includes(String(r.id))))
            throw new MirrorError(
              'REPORT_SHAPE_CHANGED',
              'Apple returned an unrequested or repeated parent record.',
              {},
              502,
            );
          return rows;
        };
        const parentIds = (rows: JsonObject[], key: string) =>
          [...new Set(rows.map(r => String(r[key] ?? '')))].filter(safeId);
        try {
          const wanted = ids.slice(0, nativeDetailLookupLimit);
          if (detail === 'ad') lists.ads = await query('ads', wanted);
          lists.adGroups = await query('adgroups', detail === 'ad' ? parentIds(lists.ads, 'adGroupId') : wanted);
          lists.campaigns = await query('campaigns', [
            ...new Set([...parentIds(lists.adGroups, 'campaignId'), ...parentIds(lists.ads, 'campaignId')]),
          ]);
        } catch (e) {
          // Only a provider refusal of these reads keeps the rows with unknown parents (as for other detail levels).
          if (!optionalReadRefused(e)) throw e;
          lists.campaigns = lists.adGroups = lists.ads = [];
          warnings.push(detailParentsUnavailableWarning);
        }
        resultDefinition = 'Apple total attributed installs (tap + view); totalMetrics';
        detailRows = appleDetail(detail, raw, lists, currency, detailRounding);
      } else {
        const d = await run({
          ...plan(
            '/v1/reports/apps/campaigns/query',
            {},
            {
              timeRange: {start: range.since, end: range.until, timeZone: 'UTC'},
              pagination: {offset: 0, pageSize: 100},
              options: {},
            },
            'https://api.ads.apple.com',
          ),
          action: 'apple_ads_v1_reports_apps_campaigns',
        });
        raw = list(d.result?.rows ?? d.result ?? []);
        resultDefinition = 'Apple total attributed installs (tap + view); totalMetrics';
        if (extra.length)
          warnings.push(
            'Apple report returns native metric columns; arbitrary field selection is not supported by this endpoint.',
          );
      }
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
const rangeToMeta = (r: {since: string; until: string}) => ({since: r.since, until: r.until});

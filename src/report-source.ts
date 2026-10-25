import {MirrorError} from './errors.js';
import type {DetailParentCache} from './overview-parents.js';
import type {Store} from './store.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';

/**
 * The report-source contract (ARC-04 stage F): what one reporting platform declares about its native campaign reports.
 * src/report-sources.ts registers one source per platform; src/report-native.ts normalizes every row through its
 * platform's source instead of a platform if-chain, and keeps the shared parts: the identity check, the native metric
 * copy, the omitted-as-zero and result-definition fields, and the row envelope. A source's `collect` reads one period
 * of its report (its request plans, paging and response parsing) through the collection the shared collector gives it,
 * which keeps every shared check: the native metric names, the connection before and after, the account lookup and its
 * cache, the read path of each request (runPlan, with its refusals and lineage), the row bound and the result envelope.
 * A leaf: it imports only types and the error class.
 */
export interface ReportRowReader {
  /** A metric of the row: the number a provider value holds (metricNumber), divided by `divisor`, or null. */
  value(v: unknown, divisor?: number): number | null;
  /** The metric at a top-level key of the row, as `value` reads it. */
  field(key: string, divisor?: number): number | null;
  /**
   * The requested metrics a delivered row left out and that count as zero (Meta omits zero-valued actions, RPT-04);
   * the row names them in `omitted_as_zero`.
   */
  readonly omitted: Set<string>;
}

/** What a source reads from one native row: its identity and the shared metrics. */
export interface ReportSourceRow {
  id: unknown;
  name?: unknown;
  /** The native objective; the row says `unknown` without one. */
  objective?: unknown;
  /** The currency the row reports in, when the row carries it (Google Ads, Microsoft Advertising, Apple Ads). */
  currency?: unknown;
  metrics: JsonObject;
  /** What the platform's conversions count, when the row knows (TikTok optimization events). */
  resultDefinition?: string;
  /** True when the row's conversions mix result definitions (TikTok campaigns with several optimization events). */
  mixedResult?: boolean;
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

/**
 * One period of one source's collection (ARC-04 stage F): what the shared collector gives a source's `collect`, and the
 * state the source sets for the result envelope. The collector checked the native metric names and the connection and
 * read the account (sources with an account lookup) before; it checks the row bound, the actor and the connection again
 * after, and builds the result from this state.
 */
export interface ReportCollection {
  /** The report source as configured: platform, account, connection, level, report options, native metrics. */
  readonly source: JsonObject;
  readonly account: string;
  /** The connection ID of the source. */
  readonly connection: string;
  readonly range: {since: string; until: string};
  /** The requested native metrics. */
  readonly extra: string[];
  /** `daily` for one natively day-segmented request (collectDaily). */
  readonly segment?: 'daily';
  /** The level a native detail source reports (`adset` or `ad`); undefined for campaigns. */
  readonly detail?: string;
  /** The period's checkpoint, and how the collection saves one (X inventories and windows, Microsoft report jobs). */
  readonly checkpoint: JsonObject;
  save(value: JsonObject): void;
  /** The job's per-source cache (the account lookup, TikTok events, LinkedIn campaigns). */
  readonly lookup?: AccountLookupCache;
  readonly actor: Actor;
  readonly store: Store;
  /** The source's request lineage so far (the account lookup first), which `run` extends. */
  readonly lineage: JsonObject[];
  /**
   * Reads one request through the read path (MirrorService.runPlan) and returns its provider data: a dry run, an
   * unsuccessful or truncated read, or a provider error envelope is refused, and the request's lineage is recorded.
   */
  run(plan: CompiledRequest, aggregate?: boolean, stage?: string): Promise<JsonObject>;
  /** A read-only report request of the source's gateway and account (a POST when it has a body). */
  plan(path: string, query?: JsonObject, body?: JsonObject, origin?: string): CompiledRequest;
  /** The validated campaign-level attribution profile of the source (Meta, Snapchat; RPT-04), or undefined. */
  attributionProfile(): JsonObject | undefined;
  // What the collection sets for the result.
  metadata: JsonObject;
  currency: string | null;
  timezone: string | null;
  raw: JsonObject[];
  readonly warnings: string[];
  attribution: string;
  resultDefinition: string;
  complete: boolean;
  collectionComplete: boolean;
  /** Source-specific fields returned with the result (X campaigns without activity, Microsoft's report time zone). */
  readonly context: JsonObject;
  /** RPT-02 scope limits: what the source covers by design. They are disclosed, not counted as incompleteness. */
  readonly scopeLimitations: string[];
  quality: JsonObject;
  /** The native detail rows of an ad group or ad level (RPT-07: Microsoft, Reddit, Apple) and their parents. */
  detailRows?: {rows: JsonObject[]; parents: Record<string, JsonObject>};
  /** Rounded native decimals of the detail rows, by metric (owner decision D10). */
  readonly detailRounding: Record<string, number>;
}

/** Native daily segmentation (RPT-03): the day a native row of one day-segmented request belongs to. */
export interface DailySegmentation {
  day(native: JsonObject | undefined): unknown;
  /** Whether a row that names its last day ends on `day` (Meta's date_stop); every row does when absent. */
  endsOn?(native: JsonObject | undefined, day: string): boolean;
}

/**
 * A platform's guided reporting (amcp_reporting's capture presets and their evidence, ARC-04 stage F): what the shared
 * guided modules (src/report-breakdowns.ts and the modules above it) ask the platform instead of naming it.
 */
export interface GuidedReporting {
  /**
   * RPT-07 P1 dimension packs: the native breakdown dimensions of the platform's guided captures, by mapping key
   * (`native_age`...), in the order they are listed, each with the check of the documented native values it accepts.
   */
  readonly dimensions?: Readonly<Record<string, (value: unknown) => boolean>>;
}

export interface ReportSource {
  /** The reporting platform ID (`google`, `meta`, ...), as report sources and reportPlatforms name it. */
  readonly platform: string;
  /** Native metrics the Overview suggests for this platform's sources. */
  readonly nativeMetricExamples: readonly string[];
  /**
   * The response container a requested native metric may sit in without being named (Google Ads and TikTok `metrics`,
   * Snapchat `stats`); no other prefix or suffix is accepted.
   */
  readonly nativeMetricContainer?: string;
  /** Requested native metric names the source accepts beyond plain field names (Google Ads' `metrics.` paths). */
  readonly nativeMetricName?: RegExp;
  /** False for sources that read no account before collection (GA4, Search Console, Apple Ads). */
  readonly accountLookup?: false;
  /** Whether the source's own reports collect its ad group and ad levels (RPT-07: Microsoft, Reddit, Apple). */
  readonly nativeDetail?: true;
  /**
   * False when requested native metrics are not checked against the returned rows (RPT-04): X and Apple Ads rows carry
   * their metrics in their own shapes, so a missing field is not reported there.
   */
  readonly nativeMetricCheck?: false;
  /** True when a native null is kept as a null metric (GA4 marks access-restricted metrics null) instead of dropped. */
  readonly nullNativeMetrics?: true;
  /** The request header whose value names the API version in lineage (LinkedIn-Version); else the path's version. */
  readonly versionHeader?: string;
  /**
   * RPT-03: the fewest data requests one period of a campaign-level source needs, beyond the account lookup (the
   * request estimate made before any egress; pages beyond the first, retries and polls are not counted).
   */
  readonly minimumRequestsPerPeriod: number;
  /**
   * RPT-02: the report day boundary the source's collector fixes, independent of account metadata (LinkedIn, Apple Ads
   * and Reddit report in UTC, Search Console in Pacific time); the account time zone otherwise.
   */
  readonly fixedTimezone?: string;
  /**
   * RPT-02: how the source's report time zone is read without collecting its report (a rolling window in the account
   * zone): the request, when it is not the account read, and the zone of its response, when that is not the account
   * time zone (GA4 reads its property; Microsoft maps the account zone to its report zone).
   */
  readonly timezoneRead?: {
    plan?(gateway: string, account: string): CompiledRequest;
    zone?(data: JsonObject, gateway: string): unknown;
  };
  /**
   * PRV-04: a provider rule change that will refuse saved native report queries of this platform (Reddit's 2026-12-08
   * breakdown rules): the problems of one saved query's configuration (none when it is unaffected), and the warning the
   * reporting bootstrap shows for the query and its schedules.
   */
  readonly savedQueryRules?: {
    problems(config: unknown): string[];
    warning(queryId: string, problems: string[], scheduleIds: string[]): JsonObject;
  };
  /** One natively day-segmented request split by day (RPT-03: Google Ads, Meta). */
  readonly daily?: DailySegmentation;
  /** The platform's guided reporting (Google, Meta); none when it has no guided capture facts. */
  readonly guided?: GuidedReporting;
  /** The headers of the source's report requests (LinkedIn's versioning headers); none when absent. */
  requestHeaders?(): Record<string, string>;
  /** Collects one period of the source's native report into `collection`. */
  collect(collection: ReportCollection): Promise<void>;
  /** Reads one native campaign report row. */
  normalize(raw: JsonObject, row: ReportRowReader): ReportSourceRow;
}

/** A provider collection of report rows, refused unless every item is an object. */
export const reportList = (v: unknown): JsonObject[] => {
  if (!Array.isArray(v) || v.some(x => !x || typeof x !== 'object' || Array.isArray(x)))
    throw new MirrorError('REPORT_SHAPE_CHANGED', 'The provider returned an unexpected report collection.', {}, 502);
  return v;
};
/** Refuses a report source that cannot be collected as configured. */
export const invalidReportSource = (message: string) => {
  throw new MirrorError('INVALID_REPORT_SOURCE', message);
};
/** RPT-07: refuses a mapped breakdown value that is not a documented native value of the capture's gateway. */
export const undocumentedBreakdownValue = (dimension: string): never => {
  throw new MirrorError(
    'REPORT_SHAPE_CHANGED',
    'The provider returned a breakdown value this report type does not document.',
    {dimension},
  );
};
/** The calendar day after an ISO date. */
export const nextDay = (date: string) => new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);

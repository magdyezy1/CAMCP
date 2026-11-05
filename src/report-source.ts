import {MirrorError} from './errors.js';
import type {ObjectiveTable} from './report-objectives.js';
import type {ReportResultContext, ReportResultRules, ResolvedReportResult} from './report-results.js';
import type {OverviewV4Capabilities} from './overview-v4.js';
import type {ReportStatusReader} from './report-status.js';
import type {DetailParentCache} from './overview-parents.js';
import type {Store} from './store.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import type {ToolCall} from './workspace-core.js';

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
  value(v: unknown, divisor?: number): number | string | null;
  /** The metric at a top-level key of the row, as `value` reads it. */
  field(key: string, divisor?: number): number | string | null;
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
  /** A source's explicit native group, when it cannot be inferred from one objective (a mixed group). */
  objectiveGroup?: string;
  /** The currency the row reports in, when the row carries it (Google Ads, Microsoft Advertising, Apple Ads). */
  currency?: unknown;
  metrics: JsonObject;
  /** What the platform's conversions count, when the row knows (TikTok optimization events). */
  resultDefinition?: string;
  /** True when the row's conversions mix result definitions (TikTok campaigns with several optimization events). */
  mixedResult?: boolean;
  /** Different native objectives keep separate additive results instead of one combined conversions number. */
  resultsByObjective?: JsonObject[];
}

/**
 * RPT-03: one account lookup per source per job. Later periods reuse the first read (lineage marks it `cached`), and
 * `verifyAccount` re-reads once after collection so a currency or time-zone change during a long run is still caught.
 */
export interface AccountLookupCache {
  /** TikTok refused its optional STATUS_ALL report filter; later periods use the same fallback. */
  tiktokStatusFilter?: 'refused';
  data?: JsonObject;
  lineage?: JsonObject;
  /**
   * RPT-04: TikTok ad group optimization events per campaign, read once per source per job like the account lookup
   * (not once per period). `unavailable` records a non-retryable failure of this optional read.
   */
  tiktokEvents?: {
    events: Record<string, string[]>;
    groups?: Record<string, JsonObject>;
    lineage?: JsonObject;
    unavailable?: boolean;
  };
  /**
   * RPT-07: current LinkedIn campaign names and objectives by URN, read once per source per job for the URNs reported
   * so far (later periods read only new URNs). `unavailable` records a non-retryable refusal of this optional read.
   */
  linkedinCampaigns?: {
    campaigns: Record<string, JsonObject>;
    lineage: JsonObject[];
    unavailable?: boolean;
    limited?: boolean;
  };
  /** LinkedIn group and creative metadata, under the same per-source authorization as campaign metadata. */
  linkedinGroups?: {
    groups: Record<string, JsonObject>;
    lineage: JsonObject[];
    unavailable?: boolean;
    limited?: boolean;
  };
  linkedinCreatives?: {
    creatives: Record<string, JsonObject>;
    lineage: JsonObject[];
    unavailable?: boolean;
    limited?: boolean;
  };
  /** RPT-07: native parents of detailed entities, read once per entity per source per job (overview-parents.ts). */
  detailParents?: DetailParentCache;
  detailParentsByLevel?: Record<string, DetailParentCache>;
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

/** What a guided capture's collector is given (src/decision-reporting.ts capture, ARC-01 reporting). */
export interface GuidedCaptureContext {
  readonly store: Store;
  readonly call: ToolCall;
  readonly actor: Actor;
  /** The native read's arguments, bound to the capture's account and connection and never a dry run. */
  readonly args: JsonObject;
  /** The capture's validated declared semantics. */
  readonly semantics: JsonObject;
  /** The preset the capture collects. */
  readonly preset: string;
  /** Overview may retain partial collections; evidence captures always require a whole collection. */
  readonly allowPartial?: true;
  /** Trusted internal Overview mode; never inferred from a public capture's native arguments. */
  readonly overviewV4?: true;
  /** The Overview job's per-source cache; it carries provider read decisions across periods. */
  readonly lookup?: AccountLookupCache;
  /** The preset's row checks (validatePresetRows), for a collector that checks its rows before its last read. */
  validateRows(rows: JsonObject[]): void;
}

export interface GuidedCollectionState {
  complete: boolean;
  declared: number | null;
  returned: number;
  warnings: string[];
}

/** What a platform's guided collector read: the provider read the capture maps, its pages, its account evidence. */
export interface GuidedCapture {
  readonly source: JsonObject;
  readonly sourcePages: unknown;
  readonly nativeAccountEvidence?: JsonObject;
  readonly collection?: GuidedCollectionState;
  /** Checks the actor, the connection and its authorization again, before the capture is retained. */
  assertCurrent(): void;
}

/**
 * RPT-07: a capture's conversion rules, read in its authorization bracket after its native report (LinkedIn's campaign
 * × conversion preset): the rules' account currency, which the capture compares with the declared one, the join of the
 * reported conversions to their rules' windows, and the rules' provenance.
 */
export interface GuidedConversionRules {
  readonly currency: unknown;
  join(conversions: string[]): JsonObject;
  provenance(): JsonObject;
}

/**
 * A native dimension a capture's mapping may retain that one platform documents (Google's devices and geography,
 * LinkedIn's conversion rules): whether a mapped value is one the capture keeps and, for a dimension other mapped
 * dimensions of a row must agree with (Google's geographic resource), whether they do. The capture keeps the refusal.
 */
export interface GuidedDimension {
  valid(value: unknown, capture: JsonObject): boolean;
  agrees?(row: JsonObject): boolean;
}

/**
 * A platform's guided reporting (amcp_reporting's capture presets and their evidence, ARC-04 stage F): what the shared
 * guided modules (src/report-breakdowns.ts and the modules above it) ask the platform instead of naming it.
 */
export interface GuidedReporting {
  /**
   * The platform's collection of a capture of one of its presets (ARC-01 reporting): complete native pages bracketed
   * by account and authorization checks, in place of one read through the gateway. The capture keeps every shared
   * check of the read it returns.
   */
  collect?(context: GuidedCaptureContext): Promise<GuidedCapture>;
  /** How the collector read the evidence, retained as its source_collection (`google_search_pages`...). */
  readonly sourceCollection?: string;
  /** True when the collector checks the native rows before its last read (LinkedIn), so the capture does not again. */
  readonly collectorChecksRows?: true;
  /** The provenance a capture of `preset` with its generated `request` retains as semantics_source (capture_preset). */
  semanticsSource?(preset: string, request: JsonObject): string;
  /** RPT-04: a delivered row's absent selected action counts as zero (Meta omits zero-valued action entries). */
  readonly omittedAsZero?: true;
  /** A documented native dash means unavailable, never a zero metric (TikTok). */
  readonly dashAsUnknown?: true;
  /** Native date formats a mapping may name for the report date, each with its parse of a native date. */
  readonly dateFormats?: Readonly<Record<string, (value: unknown) => unknown>>;
  /** The native dimensions a mapping may retain that this platform documents, by mapping key. */
  readonly dimensionChecks?: Readonly<Record<string, GuidedDimension>>;
  /** RPT-07: the preset whose capture joins its conversions to their rules, and the rules' read. */
  readonly conversionRules?: {
    readonly preset: string;
    read(
      context: Pick<GuidedCaptureContext, 'store' | 'call' | 'actor'>,
      capture: {gateway: string; account_id: string; connection_id: string},
    ): Promise<GuidedConversionRules>;
  };
  /**
   * RPT-07 P1 dimension packs: the native breakdown dimensions of the platform's guided captures, by mapping key
   * (`native_age`...), in the order they are listed, each with the check of the documented native values it accepts.
   */
  readonly dimensions?: Readonly<Record<string, (value: unknown) => boolean>>;
  /**
   * The platform's capture presets, as amcp_reporting capture_presets lists them (src/report-presets.ts lists the
   * platforms' presets in the registry's guided order, src/report-sources.ts guidedReportSources).
   */
  readonly presets?: readonly JsonObject[];
  /** The prefix every one of the platform's preset IDs starts with (`linkedin_`), by which a capture names its preset. */
  readonly presetPrefix?: string;
  /** Whether a capture of `preset` takes a parent campaign filter (Snapchat's parent-scoped presets); none when absent. */
  campaignFilter?(preset: JsonObject): boolean;
  /**
   * The native capture one of the platform's presets defines (capture_preset): the gateway, account and connection,
   * the native read's arguments, the declared semantics, the rows pointer and the field mapping, over the validated
   * reporting window `range`. It refuses what the preset does not accept, after the shared checks.
   */
  presetRequest?(
    preset: JsonObject,
    input: JsonObject,
    range: {since: string; until: string},
    context?: {overviewV4?: true},
  ): JsonObject;
  /** Checks the native rows of a capture of one of the platform's presets before they are mapped (LinkedIn, Meta). */
  validateRows?(preset: string, input: JsonObject, rows: JsonObject[]): void;
  /**
   * DEC-01: the allocation model of the platform's guided evidence (amcp_reporting allocation_candidates, allocation
   * and its calibration, src/report-allocation.ts): the preset whose retained evidence it models, the check of that
   * evidence's native source (it refuses; LinkedIn, Snapchat), and whether a retained row's entity ID is one of the
   * platform's native IDs.
   */
  readonly allocation?: {
    readonly preset: string;
    evidence?(report: JsonObject): void;
    entity(id: unknown): boolean;
  };
  // Wave 4c round 6 (w4c-arc6-reporting).
  /**
   * DEC-02: the native budget draft of an allocation preview of that model (amcp_reporting allocation_plan,
   * src/allocation-plan.ts), declared exactly when `allocation` is.
   */
  readonly allocationDraft?: AllocationDraft;
}

export interface ReportSource {
  /** Provider-owned levels and option defaults for the v4 boundary and bootstrap. */
  readonly overview?: OverviewV4Capabilities;
  readonly requiresCompleteWindowDeclaration?: true;
  /** A platform's collection semantics, stamped on snapshots independently of saved definitions. */
  readonly contract?: {readonly stamp: string; readonly notice?: {readonly id: string; readonly message: string}};
  /** Native objective values and conservative mappings owned by this reporting platform. */
  readonly objectives?: ObjectiveTable;
  /** V4 result semantics declared by this provider for shared readers and bootstrap. */
  readonly resultRules?: ReportResultRules;
  /** Objective/goal-led exact results for the v4 boundary; legacy row normalization is unchanged. */
  readResult?(raw: JsonObject, context: ReportResultContext): ResolvedReportResult;
  /** Current native configured status, distinct from delivery observed during the report's date window. */
  readonly readStatus?: ReportStatusReader;
  /** Activity from native source units when a provider collector aggregates before normalized metric rounding. */
  readActivity?(raw: JsonObject): boolean | null;
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
  /** Legacy lower bound, or the v4 first-page baseline including the source's nonempty metadata reads. */
  requestsPerPeriod?(
    level: string,
    contract?: string,
    context?: {source: JsonObject; range: {since: string; until: string}},
  ): number;
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
  /** The platform's guided reporting (Google, Snapchat, TikTok, LinkedIn, Meta); none without guided captures. */
  readonly guided?: GuidedReporting;
  /** The headers of the source's report requests (LinkedIn's versioning headers); none when absent. */
  requestHeaders?(): Record<string, string>;
  /** Provider window limits, checked before the account lookup makes any provider request. */
  validateRange?(source: JsonObject, range: {since: string; until: string}): void;
  /** Provider-owned v4 population expansion that retains the qualified single-parent detail collector. */
  collectOverviewDetail?(
    collection: ReportCollection,
    collectParent: (campaignId?: string) => Promise<JsonObject>,
  ): Promise<JsonObject>;
  /** Collects one period of the source's native report into `collection`. */
  collect(collection: ReportCollection): Promise<void>;
  /** Reads one native campaign report row. */
  normalize(raw: JsonObject, row: ReportRowReader): ReportSourceRow;
  // Wave 4c round 6 (w4c-arc6-reporting).
  /**
   * RPT-07: the native parent reads of the source's detailed Overview rows whose report response carries no parents
   * (TikTok's ad groups and ads, Snapchat's ads, LinkedIn's creatives), which src/overview-parents.ts runs.
   */
  readonly detailParents?: DetailParentReader;
}

/** Shared declaration shape; providers supply the native names, levels, extra options and any validation. */
export function overviewCapabilities(
  levels: OverviewV4Capabilities['levels'],
  defaults: JsonObject = {},
  optionNames: string[] = [],
  validateOptions?: OverviewV4Capabilities['validateOptions'],
  legacy?: OverviewV4Capabilities['legacy'],
): OverviewV4Capabilities {
  return {
    levels,
    delivery_metrics: ['spend', 'impressions', 'clicks'],
    supported_statuses: ['active', 'paused', 'archived', 'all'],
    status_basis: 'current_configuration',
    defaults: {attribution: 'unknown', complete_window: null, ...defaults},
    option_names: [...new Set(['attribution', 'complete_window', ...Object.keys(defaults), ...optionNames])],
    ...(validateOptions ? {validateOptions} : {}),
    ...(legacy ? {legacy} : {}),
  };
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

// Wave 4c round 6 (w4c-arc6-reporting): a platform's native budget draft of its allocation model.
/** The current native budgets of an allocation's entities, as a platform's budget reader returns them (DEC-02). */
export interface AllocationBudgets {
  targets: JsonObject[];
  source_references?: JsonObject[];
  daily_budget_limits?: JsonObject;
  search_budget_lost?: JsonObject;
}

/**
 * DEC-02 (ARC-01 reporting): a platform's native budget draft of an allocation preview. src/allocation-plan.ts keeps
 * the conversion, the shared checks, their order and refusals, the preview and draft records and the source binding,
 * and asks the draft of the report's platform only for what it named the platform for: the budget reader, the source
 * fields a binding keeps, the platform's own checks of a converted daily budget, and each target's native update with
 * its wording.
 */
export interface AllocationDraft {
  /**
   * The current native budgets of the entities `ids` under an allocation source (a preview's source or a draft's
   * binding). `pricing` is false where the preview already priced the platform's daily limits; `window` is the
   * evidence period, which only the preview gives.
   */
  budgets(
    store: Store,
    call: ToolCall,
    actor: Actor,
    source: JsonObject,
    ids: string[],
    pricing: boolean,
    window?: {since: string; until: string},
  ): Promise<AllocationBudgets>;
  /** The source fields the platform binds from its report (LinkedIn's API version, Snapchat's parent campaign). */
  source?(report: JsonObject): JsonObject;
  /** Whether the report no longer matches a source field the binding keeps (Snapchat's parent campaign). */
  sourceChanged?(report: JsonObject, binding: JsonObject): boolean;
  /**
   * The platform's minor units per unit of `currency`, for budgets counted in whole units of a pinned offset (Meta).
   * It refuses a currency without one, before any read.
   */
  minorUnits?(currency: string): number;
  /** The platform's own checks of a converted daily budget in micros (LinkedIn's stated limits, Snapchat's minimum). */
  daily?(daily: bigint, target: {entity_id: unknown; currency: string; limits?: JsonObject}): void;
  /** The platform's native name of a target (LinkedIn's current campaign name); the report's when it gives none. */
  name?(native: JsonObject): unknown;
  /** True when the draft's daily budgets are average daily budgets (Google Ads). */
  readonly averageDaily?: true;
  /** How a draft step's description names its entity (`Campaign `, `Ad squad `). */
  readonly entity: string;
  /** What a step's description adds after its entity ID (Meta's spending ad set). */
  owner?(target: JsonObject): string;
  /** What a step's description adds after its amount (Meta's minor units). */
  nativeAmount?(target: JsonObject): string;
  /** The native update of one target: the arguments of its draft step. */
  step(binding: JsonObject, target: JsonObject): JsonObject;
  /** What the preview means. */
  readonly meaning: string;
  /** True for the one draft of a binding that names no gateway (Google Ads', which qualified first). */
  readonly fallback?: true;
}

// Wave 4c round 6 (w4c-arc6-reporting): a platform's native parent reads of detailed Overview rows (RPT-07), and the
// optional-read rules its collection shares with them, which src/overview-parents.ts re-exports from here.

/** What src/overview-parents.ts gives a platform's parent reads of one source; it keeps every check and refusal. */
export interface DetailParentReads {
  readonly reportingContract?: string;
  /** The source's native account. */
  readonly account: string;
  /** One read of the platform's catalog action under the source's connection (its checks and lineage are shared). */
  read(action: string, path: string, query: JsonObject, body?: JsonObject): Promise<JsonObject>;
  /** Records a detailed entity's native parents; a second, different record of the entity refuses the source. */
  record(id: string, parents: JsonObject): void;
  /** Refuses the source: the response is malformed or incomplete (REPORT_SHAPE_CHANGED). */
  shape(message: string): never;
  /** Refuses the source: a parent of another account, or a changed hierarchy (REPORT_ACCOUNT_MISMATCH). */
  foreign(message: string): never;
  /** The provider refused the read in its response, so the rows keep unknown parents (DETAIL_PARENTS_REFUSED). */
  refused(message: string): never;
  /** A parent's name as the rows keep it: a text of at most 1000 characters, else null. */
  name(value: unknown): string | null;
}

/** RPT-07: how a platform reads the native parents of detailed rows whose report response carries none. */
export interface DetailParentReader {
  readonly unavailableWarning?: string;
  readonly limitedWarning?: string;
  /** A source's proven legacy refusal envelope inside HTTP 200; other unmapped body failures still fail. */
  readonly bodyRefused?: (error: MirrorError) => boolean;
  /** The parent read a detailed level needs (`scoped`: the source names one campaign), or undefined for none. */
  kind(level: string, scoped: boolean, contract?: string): string | undefined;
  /** The headers of each read (LinkedIn's version and finder headers); none when absent. */
  headers?(): Record<string, string>;
  /** Reads the parents of the entities `ids` of `kind` and records each one it finds. */
  read(kind: string, ids: string[], reads: DetailParentReads): Promise<void>;
}

/** `values` in consecutive batches of at most `size`. */
export const inBatches = <T>(values: T[], size: number) =>
  Array.from({length: Math.ceil(values.length / size)}, (_, i) => values.slice(i * size, i * size + size));

export const detailParentsUnavailableWarning =
  'Native parents could not be read for this source, so its rows show entity IDs without parent campaigns or ad groups.';
/** AMCP's own access and binding refusals: they fail the source, since only the provider can refuse an optional read. */
export const accessRefusalCodes: ReadonlySet<string> = new Set([
  'CONNECTION_REQUIRED',
  'CONNECTION_AUTHORITY_CHANGED',
  'RESOURCE_SCOPE_REQUIRED',
  'ACCOUNT_SCOPE_MISMATCH',
  'ACCOUNT_REQUIRED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'MEMBERSHIP_REVOKED',
  'ACCOUNT_ACCESS_REVOKED',
]);
/**
 * Whether `e` is a provider refusal (HTTP 400, 403 or 404) of an optional metadata read (names, objectives, parents),
 * after which the rows stay with unknown values and a warning. A malformed or partial response (REPORT_*), a retryable
 * failure, or a removed connection, changed login or scope refusal (accessRefusalCodes) fails the source instead.
 */
export function optionalReadRefused(e: unknown): e is MirrorError {
  return (
    e instanceof MirrorError &&
    !e.retryable &&
    !e.code.startsWith('REPORT_') &&
    e.details.layer !== 'credential' &&
    !accessRefusalCodes.has(e.code) &&
    [400, 403, 404].includes(e.status)
  );
}

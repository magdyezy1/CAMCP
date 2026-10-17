import type {JsonObject} from './types.js';

/**
 * The report-source contract (ARC-04 stage F): what one reporting platform declares about its native campaign report
 * rows. src/report-sources.ts registers one source per platform; src/report-native.ts normalizes every row through
 * its platform's source instead of a platform if-chain, and keeps the shared parts: the identity check, the native
 * metric copy, the omitted-as-zero and result-definition fields, and the row envelope. Collection (the request plans
 * and response parsing of each platform) still lives in src/report-native.ts.
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
  /** Reads one native campaign report row. */
  normalize(raw: JsonObject, row: ReportRowReader): ReportSourceRow;
}

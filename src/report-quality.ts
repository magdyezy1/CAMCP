import {sha256, stable} from './security.js';
import type {JsonObject} from './types.js';
import {metricSources} from './report-metrics.js';

export const reportContractVersion = 'campaign-source-v3';
export const formulaVersion = 'arithmetic-v1';
export const fingerprint = (value: unknown) => sha256(stable(value));

/** Measurement quality is independent from successfully collecting all response pages. */
export function ga4Quality(metadata: JsonObject, dimensions: string[], offset: number): JsonObject {
  const samples = (Array.isArray(metadata.samplingMetadatas) ? metadata.samplingMetadatas : []).map(
    (s: JsonObject) => ({
      samples_read_count: String(s.samplesReadCount ?? ''),
      sampling_space_size: String(s.samplingSpaceSize ?? ''),
    }),
  );
  const restrictions = (
    Array.isArray(metadata.schemaRestrictionResponse?.activeMetricRestrictions)
      ? metadata.schemaRestrictionResponse.activeMetricRestrictions
      : []
  ).map((r: JsonObject) => ({
    metric_name: String(r.metricName ?? ''),
    restricted_types: Array.isArray(r.restrictedMetricTypes) ? r.restrictedMetricTypes.map(String) : [],
  }));
  // GA4 names the limits that cut data out of a report: retention, attribution windows, Google Ads' 36 months.
  const text = (v: unknown) => (typeof v === 'string' ? v : null);
  const truncation = (Array.isArray(metadata.dataTruncationReasons) ? metadata.dataTruncationReasons : [])
    .filter((r: unknown) => r && typeof r === 'object' && typeof (r as JsonObject).dataTruncationType === 'string')
    .map((r: JsonObject) => ({
      type: r.dataTruncationType,
      date: text(r.dataTruncationDate),
      date_ranges: (Array.isArray(r.dataTruncationDateRanges) ? r.dataTruncationDateRanges : []).map(
        (d: JsonObject) => ({start_date: text(d?.startDate), end_date: text(d?.endDate)}),
      ),
      message: text(r.dataTruncationMessage),
    }));
  return {
    dimensions,
    offset,
    samples,
    restrictions,
    truncation,
    thresholded: metadata.subjectToThresholding === true,
    data_loss: metadata.dataLossFromOtherRow === true,
    empty_reason: typeof metadata.emptyReason === 'string' ? metadata.emptyReason : null,
    currency: metadata.currencyCode ?? null,
    timezone: metadata.timeZone ?? null,
  };
}
export function summarizeGA4Quality(pages: JsonObject[]): JsonObject {
  const invalid_sampling = pages.some(p =>
    p.samples.some(
      (s: JsonObject) =>
        !/^\d{1,20}$/.test(s.samples_read_count) ||
        !/^\d{1,20}$/.test(s.sampling_space_size) ||
        BigInt(s.samples_read_count) > BigInt(s.sampling_space_size),
    ),
  );
  const sampled =
    invalid_sampling ||
    pages.some(p => p.samples.some((s: JsonObject) => BigInt(s.samples_read_count) < BigInt(s.sampling_space_size)));
  const restricted_metrics = [
    ...new Set<string>(pages.flatMap(p => p.restrictions.map((r: JsonObject) => r.metric_name))),
  ];
  const thresholded = pages.some(p => p.thresholded),
    data_loss = pages.some(p => p.data_loss),
    empty_reasons = [...new Set(pages.map(p => p.empty_reason).filter(Boolean))],
    truncation_types = [...new Set<string>(pages.flatMap(p => (p.truncation ?? []).map((t: JsonObject) => t.type)))];
  return {
    version: 1,
    pages_collected: true,
    sampled,
    invalid_sampling,
    restricted_metrics,
    thresholded,
    data_loss,
    empty_reasons,
    truncated: truncation_types.length > 0,
    truncation_types,
    measurement_complete:
      !sampled &&
      !restricted_metrics.length &&
      !thresholded &&
      !data_loss &&
      !empty_reasons.length &&
      !truncation_types.length,
    pages,
  };
}

export function compactQuality(q: JsonObject = {version: 0, status: 'unknown'}): JsonObject {
  const {pages, ...summary} = q,
    samples = (pages ?? []).flatMap((p: JsonObject) => p.samples ?? []);
  let worst: JsonObject | undefined;
  for (const s of samples)
    if (
      /^\d{1,20}$/.test(s.samples_read_count) &&
      /^\d{1,20}$/.test(s.sampling_space_size) &&
      BigInt(s.sampling_space_size) > 0 &&
      (!worst ||
        BigInt(s.samples_read_count) * BigInt(worst.sampling_space_size) <
          BigInt(worst.samples_read_count) * BigInt(s.sampling_space_size))
    )
      worst = s;
  return {
    ...summary,
    ...(pages
      ? {page_count: pages.length, worst_sampling_counts: worst ?? null, full_quality_fingerprint: fingerprint(q)}
      : {}),
  };
}
export function reportEvidence(report: JsonObject) {
  const platforms = [...new Set<string>((report.config?.sources ?? []).map((s: JsonObject) => s.platform))];
  return {
    version: 1,
    report_id: report.id,
    config: report.config,
    state: report.state,
    captured_at: report.captured_at,
    completed_at: report.completed_at,
    sources: report.sources,
    source_contract_version: report.config?.source_contract_version ?? 'legacy-unversioned',
    // What each shared metric means on each platform of the report (report-metrics.ts).
    metric_sources: Object.fromEntries(platforms.filter(p => metricSources[p]).map(p => [p, metricSources[p]])),
    untrusted_provider_content: true,
  };
}

/** Kept in CSV and Sheets even when a failed source has no campaign rows. */
export function exportSourceStatus(report: JsonObject): JsonObject {
  return {
    version: 1,
    report_id: report.id ?? null,
    state: report.state,
    selected_sources: (report.config?.sources ?? []).map((selected: JsonObject) => {
      const found = (report.sources ?? []).find((s: JsonObject) =>
        ['platform', 'connection_id', 'account_id'].every(k => s.source?.[k] === selected[k]),
      );
      return {
        platform: selected.platform,
        connection_id: selected.connection_id,
        account_id: selected.account_id,
        status: !found ? 'unknown' : found.error ? 'failed' : found.complete ? 'complete' : 'partial',
        row_count: found?.row_count ?? null,
        ...(found?.periods
          ? {
              period_count: found.periods.length,
              failed_period_count: found.period_errors?.length ?? 0,
              period_evidence: 'Download source evidence for per-period dates and errors.',
            }
          : {}),
        error: found?.error
          ? {code: found.error.code, message_excerpt: String(found.error.message ?? '').slice(0, 140)}
          : null,
        warning_count: found?.warnings?.length ?? 0,
        quality_fingerprint: found?.quality ? fingerprint(found.quality) : null,
        api_versions: [...new Set((found?.lineage ?? []).map((l: JsonObject) => l.api_version))],
        query_fingerprint: found?.query_fingerprint ?? null,
        lineage_fingerprint: found?.lineage ? fingerprint(found.lineage) : null,
      };
    }),
  };
}

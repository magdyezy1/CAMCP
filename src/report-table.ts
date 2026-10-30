import {exportSourceStatus, compactQuality} from './report-quality.js';
import {exportedRecommendation} from './report-metrics.js';
import {MirrorError} from './errors.js';
import {csvField} from './csv-safety.js';
import type {JsonObject} from './types.js';

/**
 * The report table every export of a saved report uses: the Google Sheets tab (src/google-sheets.ts, which re-exports
 * these), the CSV download and the Excel and PDF artifacts (src/report-artifacts.ts). It names no provider (ARC-01).
 */
export function assertReportExportable(report: JsonObject) {
  if (!['complete', 'partial'].includes(report.state))
    throw new MirrorError('REPORT_NOT_READY', 'Wait for a successful report before exporting.', {}, 409);
  if (!Array.isArray(report.rows) || !report.rows.length)
    throw new MirrorError(
      'EMPTY_REPORT',
      'There are no campaign rows to export. Check the account, reporting year and objective filters, then pull the report again.',
      {date_range: report.config?.date_range},
      409,
    );
}
const isoTime = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : null;
/**
 * What a row's recommendation rests on (EXP-04 C): its period, as-of time, validity, confidence and limitations. A row
 * without a recommendation has no basis (empty cell).
 */
export function recommendationBasis(row: JsonObject): string {
  if (!row.recommendation || typeof row.recommendation !== 'object' || Array.isArray(row.recommendation)) return '';
  const r: JsonObject = row.recommendation,
    e: JsonObject = r.evidence ?? {},
    asOf = isoTime(r.as_of),
    validUntil = isoTime(r.valid_until),
    parts = [
      r.basis === 'entity_window' && e.date_from && e.date_to
        ? `Based on the entity's whole window ${e.date_from} to ${e.date_to}; every period row of the entity shares it.`
        : 'Based on this row.',
      asOf ? `As of ${asOf}${validUntil ? `; valid until ${validUntil}` : ''}.` : '',
      typeof r.confidence === 'string' ? `Confidence: ${r.confidence}.` : '',
      ...(Array.isArray(r.limitations) ? r.limitations.filter((l: unknown) => typeof l === 'string') : []),
      'Advisory only; AMCP never applies it automatically.',
    ];
  return parts.filter(Boolean).join(' ');
}
/** The metric columns of a report table: selected metrics, then custom metrics, each once. */
export function reportTableFields(report: JsonObject): string[] {
  const keys = report.config.metrics ?? ['spend', 'impressions', 'clicks', 'conversions', 'cpa', 'roas'];
  return [...new Set<string>([...keys, ...(report.config.custom_metrics ?? []).map((m: JsonObject) => m.id)])];
}
/**
 * `now` decides whether frozen recommendations are still current or render as expired (DEC-01). `version` is the
 * Sheets tab contract the table follows; CSV and Excel use the current one.
 */
export function reportTable(report: JsonObject, now = Date.now(), version: 1 | 2 = 2) {
  const status = JSON.stringify(exportSourceStatus(report));
  const fields = reportTableFields(report);
  const detailed = report.rows.some((row: JsonObject) => row.entity_level && row.entity_level !== 'campaign');
  const values: any[][] = [
    [
      'Platform',
      'Account ID',
      'Campaign ID',
      'Campaign',
      'Objective',
      'Currency',
      'Timezone',
      'Date from',
      'Date to',
      ...(detailed
        ? ['Entity level', 'Native entity type', 'Entity ID', 'Entity', 'Ad set / ad group ID', 'Ad set / ad group']
        : []),
      ...fields,
      'Recommendation',
      'Reason',
      'Attribution',
      'Primary result',
      'Complete',
      'Captured at',
      'Report ID',
      'Report state',
      'Source status JSON',
      'Source quality JSON',
      'Query fingerprint',
      'Formula version',
      'Formula fingerprint',
      ...(version >= 2 ? ['Recommendation basis'] : []),
    ],
  ];
  for (const r of report.rows)
    values.push([
      r.platform,
      r.account_id,
      r.campaign_id,
      r.campaign_name,
      r.objective_group,
      r.currency ?? '',
      r.timezone ?? '',
      r.date_from,
      r.date_to,
      ...(detailed
        ? [
            r.entity_level ?? 'campaign',
            r.native_entity_type ?? 'campaign_or_resource',
            r.entity_id ?? r.campaign_id,
            r.entity_name ?? r.campaign_name,
            r.parent_ids?.adset_id ?? '',
            r.parent_ids?.adset_name ?? '',
          ]
        : []),
      ...fields.map(k => r.metrics[k] ?? ''),
      ...(advice => [advice.decision, advice.reason])(exportedRecommendation(r, now)),
      r.attribution,
      r.result_definition,
      r.complete ? 'Yes' : 'No',
      new Date(r.captured_at).toISOString(),
      report.id ?? '',
      report.state,
      values.length === 1 ? status : '',
      JSON.stringify(compactQuality(r.quality)),
      r.query_fingerprint ?? '',
      report.config.formula_version ?? 'legacy-unversioned',
      report.config.formula_fingerprint ?? '',
      ...(version >= 2 ? [recommendationBasis(r)] : []),
    ]);
  if (values.some(row => row.some(v => typeof v === 'string' && v.length > 48000)))
    throw new MirrorError(
      'EXPORT_CELL_TOO_LARGE',
      'A cell exceeds the export limit. Download the report evidence separately and narrow the report.',
    );
  return values;
}
export function exportCsv(report: JsonObject) {
  assertReportExportable(report);
  return (
    '﻿' +
    reportTable(report)
      .map(row => row.map(csvField).join(','))
      .join('\r\n')
  );
}

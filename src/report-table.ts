import {exportSourceStatus, compactQuality} from './report-quality.js';
import {exportedRecommendation, reportPlatforms} from './report-metrics.js';
import {MirrorError} from './errors.js';
import {csvDecimalField, csvField} from './csv-safety.js';
import type {JsonObject} from './types.js';
import {reportRollupLabel} from './report-scope-rollups.js';
import {overviewConfigV4} from './overview-v4.js';
import {reportCoverageHelp, reportCoverageLines} from './report-coverage-notes.js';
import {artifactLocale} from './report-localization.js';

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
/** Authored notices belong to the new snapshot's delivery; retained v3 table layouts remain unchanged. */
export function reportNoticeMessages(report: JsonObject): string[] {
  if (report.config?.contract_version !== overviewConfigV4) return [];
  return (report.notices ?? [])
    .map((notice: JsonObject) => notice.message)
    .filter((value: unknown) => typeof value === 'string');
}
/**
 * The coverage of a v4 report in table form (F-L5-01, N8): for each row, which of its figures were calculated from fewer
 * units than it has (a row built from several days that lack one reads "spend: 1 of 2 measurements", not a bare "1"), and
 * after the data rows one note per summary that is short, in the report's language. The note rows keep every metric cell
 * empty and put their words in the campaign column, so a column of numbers stays a column of numbers. Other reports have
 * no `metrics_coverage` and get neither.
 */
function coverageOfTable(report: JsonObject, fields: string[], presentation: JsonObject) {
  const locale = artifactLocale(presentation),
    custom = new Set<string>((report.config.custom_metrics ?? []).map((metric: JsonObject) => metric.id)),
    name = (metric: string) => locale.metric(metric, custom),
    lines = (source: JsonObject) => reportCoverageLines(source, fields, locale.language, name),
    perRow: string[][] = report.rows.map(lines),
    // A grouped report totals each account and level over its whole window, which is the sum of the column; the others
    // total each group of rows.
    totals: JsonObject[] = (Array.isArray(report.window_summary) ? report.window_summary : report.summary) ?? [],
    perSummary = totals.map(summary => ({summary, lines: lines(summary)})).filter(item => item.lines.length);
  return {
    covered: perRow.some(item => item.length),
    perRow,
    notes: perSummary,
    help: perSummary.length ? reportCoverageHelp(locale.language) : '',
    marker: locale.text('Coverage note'),
    // A total rolled up from the selected children of a parent says so in its note (F-L5-11).
    aggregation: (summary: JsonObject): string =>
      summary.aggregation?.label ? locale.text(summary.aggregation.label) : '',
  };
}
/**
 * `now` decides whether frozen recommendations are still current or render as expired (DEC-01). `version` is the
 * Sheets tab contract the table follows; CSV and Excel use the current one. `presentation` picks the language of the
 * coverage words (Excel only; CSV and Sheets are English).
 */
export function reportTable(report: JsonObject, now = Date.now(), version: 1 | 2 = 2, presentation: JsonObject = {}) {
  const status = JSON.stringify(exportSourceStatus(report));
  const fields = reportTableFields(report);
  const detailed = report.rows.some((row: JsonObject) => row.entity_level && row.entity_level !== 'campaign');
  const rolled = report.rows.some((row: JsonObject) => row.aggregation?.kind === 'rolled_up');
  const notices = reportNoticeMessages(report);
  const coverage =
    version >= 2 && report.config?.contract_version === overviewConfigV4
      ? coverageOfTable(report, fields, presentation)
      : undefined;
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
      ...(coverage?.covered ? ['Coverage'] : []),
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
      ...(rolled ? ['Aggregation'] : []),
      ...(notices.length ? ['Report notices'] : []),
    ],
  ];
  for (const [rowIndex, r] of (report.rows as JsonObject[]).entries())
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
      ...(coverage?.covered ? [coverage.perRow[rowIndex]!.join('; ')] : []),
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
      ...(rolled ? [reportRollupLabel(r)] : []),
      ...(notices.length ? [values.length === 1 ? notices.join('\n') : ''] : []),
    ]);
  if (coverage?.notes.length) {
    // One note row per short summary, then what "n of m" means. Every cell is empty but the marker, the identity of the
    // group and the words, which sit in the campaign column.
    const header: string[] = values[0]!,
      at = (name: string) => header.indexOf(name),
      note = (summary: JsonObject | undefined, text: string) => {
        const cells: unknown[] = header.map(() => '');
        cells[at('Platform')] = coverage.marker;
        if (summary) {
          cells[at('Account ID')] = summary.account_id ?? '';
          cells[at('Currency')] = summary.currency ?? '';
          cells[at('Timezone')] = summary.timezone ?? '';
          cells[at('Date from')] = summary.date_from ?? '';
          cells[at('Date to')] = summary.date_to ?? '';
          if (detailed) {
            cells[at('Entity level')] = summary.entity_level ?? 'campaign';
            cells[at('Native entity type')] = summary.native_entity_type ?? 'campaign_or_resource';
          }
        }
        cells[at('Campaign')] = text;
        return cells;
      };
    for (const {summary, lines} of coverage.notes)
      values.push(
        note(
          summary,
          [reportPlatforms[summary.platform]?.name ?? summary.platform, coverage.aggregation(summary), lines.join('; ')]
            .filter(Boolean)
            .join(' | '),
        ),
      );
    values.push(note(undefined, coverage.help));
  }
  if (values.some(row => row.some(v => typeof v === 'string' && v.length > 48000)))
    throw new MirrorError(
      'EXPORT_CELL_TOO_LARGE',
      'A cell exceeds the export limit. Download the report evidence separately and narrow the report.',
    );
  return values;
}
export function exportCsv(report: JsonObject) {
  assertReportExportable(report);
  // The metric columns follow the fixed ones: nine, and six more when the table lists entity levels (F-L9-04).
  const first =
      9 + (report.rows.some((row: JsonObject) => row.entity_level && row.entity_level !== 'campaign') ? 6 : 0),
    metrics = reportTableFields(report).length;
  return (
    '﻿' +
    reportTable(report)
      .map(row =>
        row
          .map((cell, index) => (index >= first && index < first + metrics ? csvDecimalField(cell) : csvField(cell)))
          .join(','),
      )
      .join('\r\n')
  );
}

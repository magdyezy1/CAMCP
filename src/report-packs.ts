import {bad, fingerprint} from './workspace-core.js';
import type {JsonObject} from './types.js';
/** A presentation of an existing snapshot. No fresh queries, currency conversion or extra aggregation. */
export function reportPack(report: JsonObject) {
  if (!['complete', 'partial'].includes(report.state))
    bad('Create a report pack from a finished snapshot.', 'REPORT_NOT_READY');
  return {
    version: 1,
    snapshot_id: report.id,
    title: report.config.name,
    client_name: report.config.client_name ?? '',
    state: report.state,
    created_at: report.completed_at,
    date_range: report.config.date_range,
    grain: report.config.grain ?? 'total',
    row_count: report.rows.length,
    summary: report.summary ?? [],
    custom_metrics: report.config.custom_metrics ?? [],
    source_hash: fingerprint({rows: report.rows, config: report.config}),
    sources: (report.sources ?? []).map((s: JsonObject) => ({
      platform: s.source?.platform,
      account_id: s.source?.account_id,
      complete: s.complete,
      row_count: s.row_count,
      error: s.error ? {code: s.error.code, message: s.error.message} : null,
      attribution: s.attribution,
      result_definition: s.result_definition,
      query_fingerprint: s.query_fingerprint,
    })),
    csv_path: '/api/reporting-overview/' + encodeURIComponent(report.id) + '.csv',
    evidence_path: '/api/reporting-overview/' + encodeURIComponent(report.id) + '.metadata.json',
    limitations: [
      'Account currencies, timezones, attribution and conversion definitions remain separate.',
      'Reach and frequency are not summed. Calculated ratios come from compatible additive totals.',
      'Recommendations are advisory; a separate review is required for advertising changes.',
    ],
    network_requests: 0,
  };
}

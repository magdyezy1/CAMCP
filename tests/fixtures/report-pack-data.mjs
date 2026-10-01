import {reportSummary} from '../../dist/src/report-summary.js';
export function packFixture() {
  const config = {
    name: 'Weekly performance',
    client_name: 'Synthetic client',
    date_range: {since: '2026-09-01', until: '2026-09-07'},
    grain: 'total',
    metrics: ['spend', 'impressions', 'clicks', 'conversions', 'cpa'],
    custom_metrics: [],
    sources: [{platform: 'meta', account_id: '00100', connection_id: 'meta'}],
  };
  const rows = ['USD', 'SAR'].map((currency, i) => ({
    platform: 'meta',
    account_id: '00100',
    connection_id: 'meta',
    campaign_id: '0000' + i,
    campaign_name: i ? 'رمضان' : '=1+1',
    objective_group: 'sales',
    currency,
    timezone: 'Asia/Riyadh',
    date_from: config.date_range.since,
    date_to: config.date_range.until,
    metrics: {spend: 12.5 + i, impressions: 100, clicks: 2, conversions: i ? null : 1, cpa: i ? null : 12.5},
    recommendation: {decision: 'hold', reason: 'Synthetic evidence'},
    attribution: '7-day click',
    result_definition: 'purchase',
    captured_at: Date.UTC(2026, 8, 8),
    complete: !i,
  }));
  return {
    id: 'synthetic-pack',
    config,
    state: 'partial',
    completed_at: Date.UTC(2026, 8, 8),
    rows,
    summary: reportSummary(rows),
    sources: [
      {
        source: config.sources[0],
        complete: false,
        row_count: 2,
        attribution: '7-day click',
        result_definition: 'purchase',
        error: {code: 'INCOMPLETE_EVIDENCE', message: 'Synthetic missing period'},
        query_fingerprint: 'synthetic-query',
      },
    ],
  };
}

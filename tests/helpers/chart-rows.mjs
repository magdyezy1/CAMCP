// Assembled report rows and the parts of a finished v4 snapshot, in the shapes src/report-charts.ts reads: no provider, no
// worker. `chartRow` is one row of a snapshot (after row assembly), `parts` is what the finish step hands the chart module.
import {reportCharts} from '../../dist/src/report-charts.js';
import {chartsWithChange} from '../../dist/src/report-chart-change.js';
import {reportSummary} from '../../dist/src/report-summary.js';

export const leadsDefinition = {
  id: 'meta:leads',
  metric: 'leads',
  label: 'Leads',
  native_metric: 'actions.lead',
  aggregation: 'sum',
  unit: 'number',
};
export const purchaseDefinition = {
  id: 'meta:purchase',
  metric: 'purchases',
  label: 'Purchases',
  native_metric: 'actions.purchase',
  aggregation: 'sum',
  unit: 'number',
};
export const valueDefinition = {
  id: 'google:value',
  metric: 'conversion_value',
  label: 'Conversion value',
  native_metric: 'metrics.conversions_value',
  aggregation: 'sum',
  unit: 'currency',
};

/**
 * One assembled campaign row (or, with `more.entity_level`, one entity row). `spend` and `result` are decimal text or
 * null; `more` overrides any field.
 */
export function chartRow(id, spend, result = '2', more = {}) {
  const {definition = leadsDefinition, entity_level, platform = 'meta', account_id = '100', ...rest} = more,
    detail = entity_level && entity_level !== 'campaign',
    key = [platform, account_id, ...(detail ? [entity_level] : []), id].join(':'),
    cost =
      spend !== null && result !== null && result !== '0' && definition.unit !== 'currency'
        ? String(Number(spend) / Number(result))
        : null;
  return {
    platform,
    account_id,
    connection_id: 'login',
    currency: 'USD',
    timezone: 'UTC',
    attribution: 'Synthetic click window',
    campaign_id: detail ? 'c1' : id,
    campaign_name: detail ? 'Campaign c1' : 'Campaign ' + id,
    campaign_key: key,
    ...(detail
      ? {entity_level, entity_id: id, entity_name: 'Entity ' + id, entity_key: key, native_entity_type: entity_level}
      : {}),
    objective: 'OUTCOME_LEADS',
    objective_group: 'leads',
    date_from: '2026-09-01',
    date_to: '2026-09-30',
    grain: 'total',
    complete: true,
    status: 'active',
    result_definition: definition.label,
    metrics: {
      spend,
      impressions: '1000',
      clicks: '10',
      primary_result: result,
      cost_per_result: cost,
    },
    metrics_coverage: {
      spend: {known_rows: spend === null ? 0 : 1, total_rows: 1, basis: 'report_rows', report_rows: 1},
      primary_result: {known_rows: result === null ? 0 : 1, total_rows: 1, basis: 'report_rows', report_rows: 1},
    },
    result: {
      metric: definition.metric,
      label: definition.label,
      value: result,
      cost_per_result: cost,
      definition_id: definition.id,
    },
    result_context: {definition, source: 'mapped', cost_source: 'derived', unavailable_reason: null, rounding: {}},
    recommendation: {decision: 'observe'},
    ...rest,
  };
}

/** The config a v4 snapshot freezes. */
export const chartConfig = (more = {}) => ({
  contract_version: 'overview-config-v4',
  name: 'Synthetic',
  grain: 'total',
  sources: [{platform: 'meta', account_id: '100', connection_id: 'login', levels: ['campaign']}],
  date_range: {since: '2026-09-01', until: '2026-09-30'},
  metrics: ['spend', 'impressions', 'clicks', 'primary_result', 'cost_per_result'],
  custom_metrics: [],
  objectives: [],
  targets: {},
  ...more,
});

/** The parts of a finished snapshot `reportCharts` reads. */
export const parts = (rows, more = {}) => ({
  config: chartConfig(more.config),
  state: more.state ?? 'complete',
  rows,
  summary: more.summary ?? [],
  window_summary: more.window_summary,
});

export const names = {meta: 'Meta', google: 'Google Ads', tiktok: 'TikTok'};

// ----- the key figures, and their change since the previous period -----
export const thisWeek = {since: '2026-09-08', until: '2026-09-14'};
export const lastWeek = {since: '2026-09-01', until: '2026-09-07'};
/** A campaign row with ten impressions for each unit of spend and five clicks. */
export const money = (id, spend, more = {}) =>
  chartRow(id, spend, '1', {
    metrics: {spend, impressions: spend === null ? null : String(Number(spend) * 10), clicks: '5'},
    ...more,
  });
/** A retained snapshot of a window: its rows are for that window, as the comparison requires. */
export const snapshotOf = (id, rows, range, completedAt) => ({
  id,
  state: 'complete',
  completed_at: completedAt,
  config: parts(rows, {config: {date_range: range}}).config,
  rows: rows.map(row => ({...row, date_from: range.since, date_to: range.until})),
});
/**
 * The key figures of `currentRows` as the finish step computes them (they need the summaries), and, given the rows of the
 * previous period, with their change read as `get` reads it.
 */
export function keyFigures(currentRows, baselineRows) {
  const specs = reportCharts(
    {...parts(currentRows), summary: reportSummary(currentRows, [], true)},
    {platformNames: names},
  ).filter(spec => spec.kind === 'kpi');
  return baselineRows
    ? chartsWithChange(
        specs,
        snapshotOf('cur', currentRows, thisWeek, 2),
        snapshotOf('base', baselineRows, lastWeek, 1),
      )
    : specs;
}

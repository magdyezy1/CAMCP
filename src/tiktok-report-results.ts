import {
  groupReportResults,
  resolveReportResult,
  unavailableReportResult,
  type ReportResultContext,
} from './report-results.js';
import type {JsonObject} from './types.js';

/** BASIC reports expose native result at ad-group/ad level, never at campaign level (TikTok supported metrics). */
export function tiktokNativeResult(raw: JsonObject, context: ReportResultContext) {
  if (context.level === 'campaign') return unavailableReportResult('missing_metric');
  const goal = context.goal ?? raw.optimization_goal,
    event = context.event ?? raw.optimization_event;
  if (typeof goal !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(goal)) return unavailableReportResult('missing_goal');
  const nativeEvent = typeof event === 'string' && /^[A-Za-z0-9_.]{1,80}$/.test(event) ? event : null,
    // Reach is never additive. Future/unpinned goals retain their native row value but acquire no invented total.
    additive =
      ['CLICK', 'CLICKS', 'INSTALL', 'APP_INSTALL', 'CONVERT', 'VIDEO_VIEW', 'LEAD_GENERATION'].includes(goal) &&
      (goal !== 'CONVERT' || nativeEvent !== null),
    metrics = raw.metrics ?? {};
  return resolveReportResult(
    {
      id: 'tiktok:' + goal + ':' + (nativeEvent ?? 'unspecified'),
      metric: 'result',
      label: 'TikTok result',
      native_metric: 'metrics.result',
      aggregation: additive ? 'sum' : 'non_additive',
      unit: 'number',
    },
    {value: metrics.result, spend: metrics.spend, cost_per_result: metrics.cost_per_result},
    'provider',
  );
}

/** Native ad-group rows from one campaign/window. Callers must supply the verified native goal for each row. */
export function tiktokCampaignResultGroups(
  rows: {raw: JsonObject; goal: unknown; event?: unknown}[],
  context: ReportResultContext & {currency: string | null; scope: string},
) {
  return groupReportResults(
    rows.map(row => {
      const resolved = tiktokNativeResult(row.raw, {...context, level: 'adset', goal: row.goal, event: row.event});
      return {
        resolved,
        currency: context.currency,
        scope: context.scope,
        // Use the exact normalized native spend; the result resolver has already checked its precision and unit.
        spend:
          row.raw.metrics?.spend === undefined || row.raw.metrics?.spend === null || row.raw.metrics?.spend === '-'
            ? null
            : String(row.raw.metrics.spend),
      };
    }),
  );
}

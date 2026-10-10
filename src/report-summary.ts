import {calculateMetrics, metricDefinitions} from './report-metrics.js';
import type {JsonObject} from './types.js';

/** Additive totals of a group of rows; non-additive metrics (reach, frequency, users) stay null. */
function additiveValues(group: JsonObject[]) {
  const values: JsonObject = {};
  for (const [key, definition] of Object.entries(metricDefinitions)) {
    if (definition.formula) continue;
    values[key] =
      definition.aggregation === 'sum' && group.every(r => typeof r.metrics[key] === 'number')
        ? group.reduce((n, r) => n + r.metrics[key], 0)
        : null;
  }
  return values;
}
/** The most recent periods a window summary keeps for its sparkline. */
export const windowSeriesLimit = 400;
/**
 * RPT-05: one summary per account, currency, timezone, objective and measurement definition over the whole window,
 * keyed without dates. Additive metrics are totalled across every period (reach and frequency are never summed),
 * decisions are counted once per entity (grouped rows share their entity-window recommendation), and `series` holds
 * the spend of each period (by its first day), oldest first, for a sparkline. Grouped (daily, weekly, monthly) snapshots store it as
 * `window_summary`.
 */
export function reportWindowSummary(rows: JsonObject[], custom: JsonObject[] = []): JsonObject[] {
  const groups = new Map<string, JsonObject[]>();
  for (const row of rows) {
    const key = JSON.stringify([
      row.platform,
      row.account_id,
      row.currency,
      row.timezone,
      row.objective_group,
      row.result_definition,
      row.attribution,
      row.entity_level ?? 'campaign',
      row.native_entity_type ?? null,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map(group => {
    const first = group[0]!,
      periods = new Map<string, JsonObject[]>(),
      entities = new Map<string, JsonObject>();
    for (const row of group) {
      const period = row.date_from + '/' + row.date_to;
      periods.set(period, [...(periods.get(period) ?? []), row]);
      const entity = String(row.entity_key ?? row.campaign_key ?? row.entity_id ?? row.campaign_id);
      if (!entities.has(entity)) entities.set(entity, row);
    }
    const ordered = [...periods.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      values = additiveValues(group),
      omitted: Record<string, number> = {};
    for (const row of group)
      for (const key of Array.isArray(row.omitted_as_zero) ? row.omitted_as_zero : [])
        if (typeof values[key] === 'number') omitted[key] = (omitted[key] ?? 0) + 1;
    return {
      platform: first.platform,
      account_id: first.account_id,
      currency: first.currency,
      timezone: first.timezone,
      objective_group: first.objective_group,
      result_definition: first.result_definition,
      attribution: first.attribution,
      date_from: ordered[0]![1][0]!.date_from,
      date_to: ordered.at(-1)![1][0]!.date_to,
      period_count: periods.size,
      ...(first.entity_level ? {entity_level: first.entity_level, native_entity_type: first.native_entity_type} : {}),
      entity_count: entities.size,
      complete: group.every(r => r.complete),
      metrics: calculateMetrics(values, custom),
      ...(Object.keys(omitted).length ? {omitted_as_zero: omitted} : {}),
      decisions: [...entities.values()].reduce((counts: JsonObject, r) => {
        const k = r.recommendation?.decision ?? 'unknown';
        counts[k] = (counts[k] ?? 0) + 1;
        return counts;
      }, {}),
      series: ordered
        .slice(-windowSeriesLimit)
        .map(([, rows]) => ({date_from: rows[0]!.date_from, spend: additiveValues(rows).spend})),
    };
  });
}
/** Sum only additive columns within one account, currency and result definition. */
export function reportSummary(rows: JsonObject[], custom: JsonObject[] = []): JsonObject[] {
  const groups = new Map<string, JsonObject[]>();
  for (const row of rows) {
    const key = JSON.stringify([
      row.platform,
      row.account_id,
      row.currency,
      row.timezone,
      row.objective_group,
      row.result_definition,
      row.attribution,
      row.date_from,
      row.date_to,
      row.entity_level ?? 'campaign',
      row.native_entity_type ?? null,
    ]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => {
    const first = group[0]!,
      values = additiveValues(group),
      omitted: Record<string, number> = {};
    // RPT-04: how many summed rows count a provider-omitted value as 0, per metric.
    for (const row of group)
      for (const key of Array.isArray(row.omitted_as_zero) ? row.omitted_as_zero : [])
        if (typeof values[key] === 'number') omitted[key] = (omitted[key] ?? 0) + 1;
    return {
      platform: first.platform,
      account_id: first.account_id,
      currency: first.currency,
      timezone: first.timezone,
      objective_group: first.objective_group,
      date_from: first.date_from,
      date_to: first.date_to,
      result_definition: first.result_definition,
      attribution: first.attribution,
      ...(first.entity_level
        ? {entity_level: first.entity_level, native_entity_type: first.native_entity_type, entity_count: group.length}
        : {campaign_count: group.length}),
      complete: group.every(r => r.complete),
      metrics: calculateMetrics(values, custom),
      ...(Object.keys(omitted).length ? {omitted_as_zero: omitted} : {}),
      decisions: group.reduce((counts: JsonObject, r) => {
        const k = r.recommendation.decision;
        counts[k] = (counts[k] ?? 0) + 1;
        return counts;
      }, {}),
    };
  });
}

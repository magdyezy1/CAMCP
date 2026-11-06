import {fingerprint} from './report-quality.js';
import {MirrorError} from './errors.js';
import {reportSource} from './report-sources.js';
import {resolveObjective, unusedObjectiveOverrides, type ResolvedObjective} from './report-objectives.js';
import {reportMetricsSummaryV4} from './report-summary.js';
import {calculateMetricsV4} from './report-math-v4.js';
import {assignRecommendationsV4, recommendationV4} from './report-advice-v4.js';
import {
  calculateMetrics,
  campaignRecommendation,
  metricDefinitions,
  parseMetricFormula,
  validateCustomMetrics,
  windowRecommendations,
} from './report-metrics.js';
import {overviewConfigV4} from './overview-v4.js';
import {levelFailure} from './report-level-reconciliation.js';
import type {JsonObject} from './types.js';

/**
 * Report row assembly (target 3.1): the collected packets of one snapshot become its report rows. Pure functions of
 * the packets and the frozen definition, so they run without a worker, a store or a provider; `work()` keeps job
 * control only.
 */

/** Every native metric (`native_*`) a row of the collected packets reports. */
export function reportNativeFields(results: JsonObject[]): Set<string> {
  const fields = new Set<string>();
  for (const result of results)
    for (const row of result.rows)
      for (const key of Object.keys(row.metrics)) if (key.startsWith('native_')) fields.add(key);
  return fields;
}

/**
 * The definition's custom metrics, validated. Native dependencies the definition accepted stay valid when no row
 * reports them: missing fields evaluate to null, and the observed field inventory must not turn an empty or sparse
 * provider response into a formula error.
 */
export function reportCustomMetrics(config: JsonObject, nativeFields: Iterable<string>): JsonObject[] {
  const nativeDependencies = config.custom_metrics
    .flatMap((m: JsonObject) => parseMetricFormula(m.formula).dependencies)
    .filter((d: string) => /^native_[a-z][a-zA-Z0-9_]{1,150}$/.test(d));
  return validateCustomMetrics(config.custom_metrics, [
    ...nativeFields,
    ...nativeDependencies,
    ...(config.contract_version === overviewConfigV4 ? ['primary_result', 'cost_per_result'] : []),
  ]);
}

/**
 * Who a row is and when it is for: the entity key, the reporting period and the frame it was collected in, and the key
 * that must be unique within one packet (a rolled-up row is also told apart by its currency, zone and attribution).
 */
function rowIdentity(result: JsonObject, row: JsonObject, defaultRange: JsonObject) {
  const source = result.source,
    key = [
      source.platform,
      source.account_id,
      ...(row.entity_level ? [row.entity_level] : []),
      row.entity_id ?? row.campaign_id,
    ].join(':'),
    period = row.report_period ?? result.date_range ?? defaultRange,
    context = row.period_context ?? result,
    rowKey =
      key +
      ':' +
      period.since +
      ':' +
      period.until +
      (row.aggregation?.kind === 'rolled_up'
        ? ':' +
          fingerprint({
            currency: row.currency ?? context.currency,
            timezone: context.timezone,
            attribution: context.attribution,
          })
        : '');
  return {key, period, context, rowKey};
}
const duplicateRows = (row: JsonObject) =>
  new MirrorError(
    row.entity_level ? 'DUPLICATE_ENTITY_ROWS' : 'DUPLICATE_CAMPAIGN_ROWS',
    row.entity_level
      ? 'The native report contains duplicate entity rows in the same reporting period.'
      : 'The native report contains multiple rows for one campaign. Narrow the report to a campaign total.',
  );
/**
 * The refusal for a packet whose rows repeat an entity in one reporting period, or undefined. A repeated row would be
 * summed twice, so the packet fails as a unit (F-L5-04) before anything is derived from it or saved as complete.
 */
export function duplicateRowsError(result: JsonObject, defaultRange: JsonObject): MirrorError | undefined {
  const seen = new Set<string>();
  for (const row of result.rows) {
    const {rowKey} = rowIdentity(result, row, defaultRange);
    if (seen.has(rowKey)) return duplicateRows(row);
    seen.add(rowKey);
  }
  return undefined;
}

/**
 * The report rows of every requested packet, in packet order. A packet that supports a scope rollup contributes no
 * rows of its own. Throws a duplicate-row error when one packet repeats an entity in one reporting period; the job
 * fails such a packet as a unit before it gets here (duplicateRowsError), so this is only the last guard.
 */
export function assembleReportRows(results: JsonObject[], config: JsonObject, custom: JsonObject[]): JsonObject[] {
  const v4 = config.contract_version === overviewConfigV4,
    rows: JsonObject[] = [];
  for (const result of results) {
    if (result.source.scope_supporting) continue;
    const seen = new Set<string>();
    for (const row of result.rows) {
      const source = result.source,
        {key, period, context, rowKey} = rowIdentity(result, row, config.date_range);
      if (seen.has(rowKey)) throw duplicateRows(row);
      seen.add(rowKey);
      const resolvedObjective = rowObjective(source, row),
        objective = resolvedObjective.group,
        {period_context, report_period, objective_unread, ...nativeRow} = row,
        record: JsonObject = {
          ...nativeRow,
          ...(v4 ? {source_ref: source.source_ref} : {}),
          row_key: rowKey,
          grain: config.grain ?? 'total',
          campaign_key: key,
          ...(row.entity_level ? {entity_key: key} : {}),
          platform: source.platform,
          account_id: source.account_id,
          connection_id: source.connection_id,
          currency: row.currency ?? context.currency,
          timezone: context.timezone,
          objective: resolvedObjective.native ?? 'unknown',
          objective_group: objective,
          objective_source: resolvedObjective.source,
          objective_reason: resolvedObjective.reason,
          date_from: period.since,
          date_to: period.until,
          source_kind: result.source_kind,
          // RPT-04: values the provider omitted on a delivered row count as 0 and stay named in quality (exports).
          quality: {
            ...(context.quality ?? {version: 0, status: 'unknown'}),
            ...(row.omitted_as_zero?.length ? {omitted_as_zero: row.omitted_as_zero} : {}),
          },
          ...(v4 ? {} : {lineage: context.lineage ?? []}),
          query_fingerprint: context.query_fingerprint ?? null,
          formula_version: config.formula_version ?? 'legacy-unversioned',
          attribution: context.attribution,
          // RPT-04: a row-level definition (TikTok optimization events) splits summaries by result.
          result_definition: row.result_definition ?? context.result_definition,
          complete: result.complete,
          captured_at: result.captured_at,
          metrics: v4
            ? calculateMetricsV4(
                {
                  ...row.metrics,
                  primary_result: row.result?.value ?? null,
                  cost_per_result: row.result?.cost_per_result ?? null,
                },
                custom,
              ).metrics
            : calculateMetrics(row.metrics, custom),
        };
      if (v4) {
        // A row with no resolved result keeps the definition its provider gave it (TikTok names the optimization
        // events a campaign mixes), so unlike rows never share one 'unknown' summary. Only a row with neither is unknown.
        record.result_definition = row.result?.label ?? row.result_definition ?? 'unknown';
        const normalized = reportMetricsSummaryV4([record], custom);
        for (const [name, value] of Object.entries(normalized.metrics))
          if (
            metricDefinitions[name]?.aggregation === 'sum' ||
            metricDefinitions[name]?.formula ||
            !Object.hasOwn(metricDefinitions, name)
          )
            record.metrics[name] = value;
        record.metrics_coverage = normalized.metrics_coverage;
        if (normalized.metric_calculation_rounding)
          record.quality.metric_calculation_rounding = normalized.metric_calculation_rounding;
      }
      if (config.objectives.length && !config.objectives.includes(objective)) continue;
      rows.push({
        ...record,
        recommendation: v4
          ? recommendationV4(record, config.targets, custom)
          : campaignRecommendation(record, config.targets),
      });
    }
  }
  noteUnusedObjectiveOverrides(results);
  // DEC-01: grouped periods share one entity-window recommendation instead of per-period small-sample advice.
  if (v4) assignRecommendationsV4(rows, config.targets, custom, (config.grain ?? 'total') !== 'total');
  else if ((config.grain ?? 'total') !== 'total') windowRecommendations(rows, config.targets, custom);
  return rows;
}

/**
 * The outcome of a collected snapshot, from the requested units only (F-L5-18). A unit that supports a scope rollup is
 * read to measure a requested level; it is never a level of the report. So a requested level fails when its own
 * collection failed or when the level it is measured through did (levelFailure), and the report is failed only when
 * every requested level failed, partial when some did or any is incomplete. An empty report says why only when nothing
 * failed to explain it: a failed collection is never reported as a source filter that matched nothing.
 */
export function snapshotOutcome(results: JsonObject[], rows: JsonObject[], config: JsonObject) {
  const v4 = config.contract_version === overviewConfigV4,
    requested = results.filter(packet => !packet.source.scope_supporting),
    failures = requested.flatMap(unit => {
      const error = levelFailure(unit, results);
      return error ? [{unit, error}] : [];
    }),
    scopedRowCount = requested.reduce((n, s) => n + s.rows.length, 0),
    sourceRowCount = requested.reduce(
      (n, s) => n + (v4 ? (s.scope?.returned_rows ?? s.rows.length) : s.rows.length),
      0,
    ),
    scopeInputRowCount = requested.reduce(
      (n, s) => n + (s.scope?.input_rows ?? s.scope?.returned_rows ?? s.rows.length),
      0,
    ),
    derivedRows = requested.reduce((n, s) => n + (s.scope?.rollup?.derived_rows ?? 0), 0),
    state: 'complete' | 'partial' | 'failed' =
      failures.length === requested.length
        ? 'failed'
        : failures.length || requested.some(s => !s.complete)
          ? 'partial'
          : 'complete';
  return {
    state,
    failures,
    emptyReason:
      rows.length || state === 'failed'
        ? null
        : v4 && (sourceRowCount || scopeInputRowCount) && !scopedRowCount
          ? 'scope_filter'
          : scopeInputRowCount
            ? 'objective_filter'
            : 'no_provider_rows',
    /** The row counters the snapshot record carries. */
    counts: {
      source_row_count: sourceRowCount,
      filtered_row_count: scopeInputRowCount - rows.length,
      ...(v4
        ? {
            scoped_row_count: scopedRowCount,
            scope_filtered_row_count: scopeInputRowCount - scopedRowCount,
            objective_filtered_row_count: scopedRowCount - rows.length,
            ...(requested.some(packet => packet.scope?.rollup)
              ? {
                  scope_input_row_count: scopeInputRowCount,
                  derived_row_count: derivedRows,
                  supporting_row_count: results
                    .filter(packet => packet.source.scope_supporting)
                    .reduce((n, packet) => n + (packet.scope?.returned_rows ?? packet.rows.length), 0),
                }
              : {}),
          }
        : {}),
    },
  };
}

/**
 * A row's objective is resolved once. A detail row, and a row rolled up from its parent's, record the resolution made
 * with the parent's raw evidence (`objective_source`); the evidence left on the row itself cannot repeat it. A campaign
 * row records none and is resolved here.
 */
function rowObjective(source: JsonObject, row: JsonObject): ResolvedObjective {
  if (row.objective_source !== undefined)
    return {
      native: row.objective === 'unknown' ? null : row.objective,
      group: row.objective_group,
      source: row.objective_source,
      reason: row.objective_reason ?? null,
    };
  return resolveObjective({
    platform: source.platform,
    table: reportSource(source.platform)?.objectives,
    native: row.objective,
    campaignId: row.campaign_id,
    mappedInputs: row.native?.daily_rows?.[0] ?? row.native,
    overrides: source.objective_overrides,
    legacy: source.objective,
    fallback: source.objective_fallback,
    unread: row.objective_unread,
  });
}

/**
 * Overrides belong to a source, not to one of its level packets: a campaign matched at any level is a match, and an
 * unmatched one is reported once, as a warning on the source's first packet (this adds that warning to the packet).
 */
function noteUnusedObjectiveOverrides(results: JsonObject[]) {
  const packetsOfSource = new Map<unknown, JsonObject[]>();
  for (const result of results) {
    if (result.error) continue;
    const key = result.source.source_ref ?? result;
    packetsOfSource.set(key, [...(packetsOfSource.get(key) ?? []), result]);
  }
  for (const packets of packetsOfSource.values()) {
    const warning = unusedObjectiveOverrides(
      packets[0]!.source,
      packets.flatMap(packet => packet.rows),
    );
    if (warning) packets[0]!.warnings.push(warning);
  }
}

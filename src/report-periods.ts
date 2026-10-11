import {MirrorError} from './errors.js';
import {reportRange} from './report-native.js';
import {fingerprint} from './report-quality.js';
import {reportSourceError} from './report-errors.js';
import {mergeMetricRounding} from './provider-decimal.js';
import type {JsonObject} from './types.js';

export const reportGrains = ['total', 'daily', 'weekly', 'monthly'];
export function reportPeriods(range: JsonObject, grain = 'total'): {since: string; until: string}[] {
  const r = reportRange(range);
  if (!reportGrains.includes(grain))
    throw new MirrorError('INVALID_REPORT_GRAIN', 'Choose total, daily, weekly or monthly data grouping.');
  if (grain === 'total') return [r];
  const periods: {since: string; until: string}[] = [],
    end = Date.parse(r.until),
    iso = (n: number) => new Date(n).toISOString().slice(0, 10);
  for (let at = Date.parse(r.since); at <= end;) {
    const d = new Date(at);
    let stop = at;
    if (grain === 'weekly') stop = at + (6 - ((d.getUTCDay() + 6) % 7)) * 86400000;
    if (grain === 'monthly') stop = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0);
    stop = Math.min(end, stop);
    periods.push({since: iso(at), until: iso(stop)});
    at = stop + 86400000;
  }
  return periods;
}

/** Query each native calendar period directly, so reach/ratios are not summed from daily values. */
export async function collectReportPeriods(
  source: JsonObject,
  dates: JsonObject,
  grain: string,
  checkpoint: JsonObject,
  collect: (range: JsonObject, checkpoint: JsonObject, save: (value: JsonObject) => void) => Promise<JsonObject>,
  save: (value: JsonObject) => void,
): Promise<JsonObject> {
  if (grain === 'total') return collect(dates, checkpoint, save);
  const periods = reportPeriods(dates, grain),
    definition = fingerprint({source, dates, grain});
  if (checkpoint.definition && checkpoint.definition !== definition)
    throw new MirrorError(
      'REPORT_DEFINITION_CHANGED',
      'The saved report periods do not match the frozen report. Start a new run.',
    );
  const state: JsonObject = {definition, periods: checkpoint.periods ?? {}},
    results: JsonObject[] = [];
  let rowCount = 0;
  for (let i = 0; i < periods.length; i++) {
    const range = periods[i]!,
      key = String(i),
      prior = state.periods[key] ?? {};
    let result = prior.result;
    if (!result)
      try {
        result = await collect(range, prior.native ?? {}, native => {
          state.periods[key] = {native};
          save(state);
        });
        state.periods[key] = {result};
        save(state);
      } catch (e) {
        if (e instanceof MirrorError && e.retryable) throw e;
        if (
          e instanceof MirrorError &&
          [
            'STALE_JOB_LEASE',
            'JOB_CANCELLED',
            'MEMBERSHIP_REVOKED',
            'ACCOUNT_ACCESS_REVOKED',
            'REPORT_BUDGET_INVALID',
          ].includes(e.code)
        )
          throw e;
        result = {rows: [], complete: false, date_range: range, error: reportSourceError(e, source), warnings: []};
        state.periods[key] = {result};
        save(state);
        if (e instanceof MirrorError && e.code === 'REPORT_COLLECTION_LIMIT') {
          // Keep earlier completed periods readable. Mark the remaining coverage explicitly without issuing more
          // requests or pretending that uncollected periods contain zero performance.
          for (let pending = i; pending < periods.length; pending++)
            results.push({...result, date_range: periods[pending]});
          break;
        }
      }
    rowCount += result.rows.length;
    if (rowCount > 10000)
      throw new MirrorError(
        'REPORT_ROW_LIMIT',
        'The source exceeds 10,000 rows across its periods. Narrow the dates or accounts.',
      );
    results.push({...result, date_range: range});
  }
  return mergeReportPeriods(dates, periods, results);
}

/** Provider rejections of a day-segmented request that the per-period path may still answer (RPT-03 fallback). */
const segmentationRefused = (e: unknown) =>
  e instanceof MirrorError &&
  !e.retryable &&
  ((e.code === 'UPSTREAM_ERROR' && [400, 413, 422].includes(e.status)) || e.code === 'PROVIDER_REPORT_FAILED');
/**
 * RPT-03 (contract campaign-source-v4): a daily source is collected with one natively day-segmented request instead of
 * one request per day. The checkpoint definition names the collection mode, so a resumed run never mixes modes. A
 * provider that refuses the segmented request (for example "reduce the amount of data") falls back to per-day queries,
 * as does a checkpoint written by that fallback.
 */
export async function collectNativeDaily(
  source: JsonObject,
  dates: JsonObject,
  checkpoint: JsonObject,
  collect: () => Promise<JsonObject[]>,
  save: (value: JsonObject) => void,
  legacy: (checkpoint: JsonObject) => Promise<JsonObject>,
): Promise<JsonObject> {
  const periods = reportPeriods(dates, 'daily'),
    definition = fingerprint({source, dates, grain: 'daily', collection: 'native_daily_v1'});
  if (checkpoint.definition && checkpoint.definition !== definition) return legacy(checkpoint);
  let days: JsonObject[] | undefined = checkpoint.days;
  if (!days) {
    try {
      days = await collect();
    } catch (e) {
      if (!segmentationRefused(e)) throw e;
      const fallback = await legacy({});
      return {
        ...fallback,
        warnings: [
          ...fallback.warnings,
          'The provider refused one day-segmented request, so each day was requested separately.',
        ],
      };
    }
    if (days.length !== periods.length || days.some((d, i) => d.date_range?.since !== periods[i]!.since))
      throw new MirrorError('REPORT_DATE_MISMATCH', 'The daily split does not match the requested days.', {}, 502);
    if (days.reduce((n, d) => n + d.rows.length, 0) > 10000)
      throw new MirrorError(
        'REPORT_ROW_LIMIT',
        'The source exceeds 10,000 rows across its periods. Narrow the dates or accounts.',
      );
    save({definition, days});
  }
  return {...mergeReportPeriods(dates, periods, days), collection_mode: 'native_daily'};
}

/** Combines per-period results into one source result (shared by per-period and natively segmented collection). */
export function mergeReportPeriods(
  dates: JsonObject,
  periods: {since: string; until: string}[],
  results: JsonObject[],
): JsonObject {
  const successful = results.filter(r => !r.error),
    first = successful[0];
  if (!first)
    throw new MirrorError(
      'REPORT_PERIODS_FAILED',
      'Every calendar period failed for this source.',
      {periods: results.map((r, i) => ({date_range: periods[i], error: r.error}))},
      502,
    );
  const context = (r: JsonObject) => {
    const {rows, metadata, ...data} = r;
    return data;
  };
  const errors = results.filter(r => r.error),
    contexts = results.map(context);
  const quality: JsonObject = {
    ...first.quality,
    period_count: results.length,
    failed_period_count: errors.length,
    sampled: results.some(r => r.quality?.sampled),
    thresholded: results.some(r => r.quality?.thresholded),
    data_loss: results.some(r => r.quality?.data_loss),
    invalid_sampling: results.some(r => r.quality?.invalid_sampling),
    empty_reasons: [...new Set(results.flatMap(r => r.quality?.empty_reasons ?? []))],
    truncated: results.some(r => r.quality?.truncated),
    truncation_types: [...new Set(results.flatMap(r => r.quality?.truncation_types ?? []))],
    restricted_metrics: [...new Set(results.flatMap(r => r.quality?.restricted_metrics ?? []))],
    // Tri-state: any known incomplete period is false, all known complete is true, anything unknown stays unknown.
    measurement_complete: results.some(r => r.quality?.measurement_complete === false)
      ? false
      : results.every(r => r.quality?.measurement_complete === true)
        ? true
        : null,
    pages: results.flatMap(r => r.quality?.pages ?? []),
  };
  const rounding = mergeMetricRounding(results.map(r => r.quality?.metric_rounding));
  if (rounding) quality.metric_rounding = rounding;
  else delete quality.metric_rounding;
  // RPT-02: an in-progress period keeps the source open; scope limits are reported, not treated as incompleteness.
  const open = results.filter(r => r.open_window === true),
    scope = [...new Set<string>(results.flatMap(r => r.scope_limitations ?? []))];
  delete quality.open_window;
  delete quality.window_closes_at;
  delete quality.window_timezone_basis;
  delete quality.scope_limitations;
  if (open.length)
    Object.assign(quality, {
      open_window: true,
      window_closes_at: open.at(-1)!.quality?.window_closes_at ?? null,
      window_timezone_basis: open.at(-1)!.quality?.window_timezone_basis ?? null,
    });
  if (scope.length) quality.scope_limitations = scope;
  const {open_window, scope_limitations, ...firstContext} = context(first);
  return {
    ...firstContext,
    quality,
    date_range: dates,
    complete: results.every(r => r.complete),
    collection_complete: results.every(r => !r.error && r.collection_complete !== false),
    ...(open.length ? {open_window: true} : {}),
    ...(scope.length ? {scope_limitations: scope} : {}),
    periods: contexts,
    period_errors: errors.map(context),
    collection_limit: errors.some(r => r.error?.code === 'REPORT_COLLECTION_LIMIT'),
    warnings: [
      ...new Set(results.flatMap(r => r.warnings ?? [])),
      ...(errors.length
        ? [
            errors.length +
              ' calendar period(s) failed. Their dates and errors are retained; totals and recommendations have incomplete coverage.',
          ]
        : []),
    ],
    // Days split from one segmented request share its lineage; each request is listed once.
    lineage: [
      ...new Map(
        results.flatMap(r => r.lineage ?? []).map((l: JsonObject) => [JSON.stringify(l), l] as const),
      ).values(),
    ],
    query_fingerprint: fingerprint(results.map(r => r.query_fingerprint ?? null)),
    rows: results.flatMap((r, i) =>
      r.rows.map((row: JsonObject) => ({...row, report_period: periods[i], period_context: context(r)})),
    ),
  };
}

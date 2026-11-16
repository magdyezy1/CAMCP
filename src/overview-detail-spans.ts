import {mergeMetricRounding} from './provider-decimal.js';
import {fingerprint} from './report-quality.js';
import type {JsonObject} from './types.js';

/**
 * A provider that reads a window in daily rows takes a long window in spans (Snapchat reads at most 31 closed days at a
 * time): the inclusive calendar range cut into consecutive spans of at most `days` days. The cut is by calendar day, so
 * it does not depend on the account time zone.
 */
export function windowSpans(range: {since: string; until: string}, days: number): {since: string; until: string}[] {
  const day = 86400000,
    end = Date.parse(range.until),
    iso = (at: number) => new Date(at).toISOString().slice(0, 10),
    spans: {since: string; until: string}[] = [];
  for (let at = Date.parse(range.since); at <= end; at += days * day)
    spans.push({since: iso(at), until: iso(Math.min(end, at + (days - 1) * day))});
  return spans;
}

/**
 * The capture of a whole window from the captures of its consecutive spans, read for one parent. Daily rows add exactly,
 * so the rows, native rows, pages and account checks of the spans are the window's; a single span is returned as it is.
 */
export function mergeCaptures(captures: JsonObject[], range: {since: string; until: string}): JsonObject {
  const [first, ...rest] = captures;
  if (!first) throw new RangeError('A window has at least one span.');
  if (!rest.length) return first;
  const rounding = mergeMetricRounding(captures.map(capture => capture.semantics?.metric_rounding)),
    {totals: _totals, coverage: _coverage, ...kept} = first;
  return {
    ...kept,
    semantics: {
      ...first.semantics,
      date_from: range.since,
      date_to: range.until,
      ...(rounding ? {metric_rounding: rounding} : {}),
    },
    source_request: captures.map(capture => capture.source_request),
    source_hash: fingerprint(captures.map(capture => capture.source_hash)),
    source_pages: captures.flatMap(capture => capture.source_pages ?? []),
    native_account_evidence: first.native_account_evidence && {
      ...first.native_account_evidence,
      checks: captures.flatMap(capture => capture.native_account_evidence?.checks ?? []),
    },
    ...(captures.some(capture => capture.collection)
      ? {
          collection: {
            ...first.collection,
            complete: captures.every(capture => capture.collection?.complete !== false),
            // The reasons of every span are the window's, once each: a later span that is not complete is the one that says why
            // (r12-fix, the lead's ruling on item 1, decision 2, 2026-11-16).
            warnings: [...new Set(captures.flatMap(capture => capture.collection?.warnings ?? []))],
          },
        }
      : {}),
    captured_at: Math.min(...captures.map(capture => capture.captured_at)),
    rows: captures.flatMap(capture => capture.rows),
    native_rows: captures.flatMap(capture => capture.native_rows),
  };
}

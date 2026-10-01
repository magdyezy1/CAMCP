import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';

// LinkedIn Reporting and Metrics Available, li-lms-2026-09, checked 2026-10-01:
// adAnalytics has no pagination, a 15,000-element ceiling, and UTC inclusive dates.
// A missing paging.total is normal. Empty data does not distinguish no activity from denied reporting access.
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
export function linkedInAnalyticsRows(value: unknown): JsonObject[] {
  if (!object(value) || !Array.isArray(value.elements))
    throw new MirrorError('REPORT_SHAPE_CHANGED', 'LinkedIn did not return an analytics row collection.');
  const rows = value.elements,
    p = value.paging;
  if (
    rows.length >= 15000 ||
    value.truncated === true ||
    value.has_more === true ||
    value.metadata?.nextPageToken ||
    (p !== undefined &&
      (!object(p) ||
        (p.start !== undefined && p.start !== 0) ||
        (p.count !== undefined && (!Number.isSafeInteger(p.count) || p.count < 0)) ||
        (p.total !== undefined && (!Number.isSafeInteger(p.total) || p.total !== rows.length)) ||
        (p.links !== undefined &&
          (!Array.isArray(p.links) || p.links.some((link: unknown) => !object(link) || link.rel === 'next'))) ||
        p.next ||
        p.next_link))
  )
    throw new MirrorError(
      'REPORT_INCOMPLETE',
      'LinkedIn analytics is incomplete or at its response limit. Narrow the date window; this endpoint cannot be paginated.',
    );
  return rows;
}
export function linkedInReportDate(value: unknown): string {
  if (
    !object(value) ||
    !['year', 'month', 'day'].every(k => Number.isSafeInteger(value[k])) ||
    value.year < 1000 ||
    value.year > 9999 ||
    value.month < 1 ||
    value.month > 12 ||
    value.day < 1 ||
    value.day > 31
  )
    throw new MirrorError('REPORT_DATE_MISMATCH', 'LinkedIn returned an invalid UTC date.');
  const date = `${value.year}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
  if (new Date(date).toISOString().slice(0, 10) !== date)
    throw new MirrorError('REPORT_DATE_MISMATCH', 'LinkedIn returned an invalid UTC calendar date.');
  return date;
}
export function linkedInDailyRange(since: string, until: string) {
  const now = new Date(),
    today = now.toISOString().slice(0, 10);
  // First day of the following month is a conservative edge of the six-month daily retention window.
  const oldest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1)).toISOString().slice(0, 10);
  if (since < oldest || until > today)
    throw new MirrorError(
      'INVALID_DATE_RANGE',
      'LinkedIn daily evidence must be within the current month and previous five calendar months, through today in UTC.',
    );
}

/** ALL grain must describe exactly the requested period, including older requests the provider may round. */
export function linkedInCampaignPeriod(value: unknown, range: {since: string; until: string}): JsonObject[] {
  const rows = linkedInAnalyticsRows(value),
    seen = new Set<string>();
  if (!rows.length)
    throw new MirrorError(
      'REPORT_EMPTY_AMBIGUOUS',
      'LinkedIn returned no rows. No activity and missing reporting access cannot be distinguished.',
    );
  for (const row of rows) {
    if (
      !object(row) ||
      !Array.isArray(row.pivotValues) ||
      row.pivotValues.length !== 1 ||
      typeof row.pivotValues[0] !== 'string' ||
      !/^urn:li:sponsoredCampaign:[1-9][0-9]{0,31}$/.test(row.pivotValues[0])
    )
      throw new MirrorError('REPORT_SHAPE_CHANGED', 'LinkedIn did not return a single native campaign pivot.');
    if (
      linkedInReportDate(row.dateRange?.start) !== range.since ||
      linkedInReportDate(row.dateRange?.end) !== range.until
    )
      throw new MirrorError(
        'REPORT_DATE_MISMATCH',
        'LinkedIn returned dates outside the requested period. Older daily dates may be rounded; select whole calendar months or a recent window.',
      );
    if (seen.has(row.pivotValues[0]))
      throw new MirrorError(
        'REPORT_DUPLICATE_ROWS',
        'LinkedIn returned duplicate campaign totals for the requested period.',
      );
    seen.add(row.pivotValues[0]);
  }
  return rows;
}

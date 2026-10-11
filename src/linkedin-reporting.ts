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

/**
 * RPT-07: current names and objectives of the reported LinkedIn campaigns. The analytics response carries only URNs, so
 * the Overview reads the account's own campaigns by ID (search finder, at most 100 per request) after the analytics read.
 * A campaign of another advertising account refuses the source; a campaign LinkedIn does not return keeps its ID and an
 * unknown objective. Names and objectives are current metadata, not the values at delivery time.
 */
export async function linkedInCampaignMetadata(
  account: string,
  urns: string[],
  read: (query: JsonObject) => Promise<unknown>,
): Promise<{campaigns: Record<string, JsonObject>; unmatched: number}> {
  const owner = 'urn:li:sponsoredAccount:' + account,
    wanted = [...new Set(urns)],
    campaigns: Record<string, JsonObject> = {};
  let unmatched = 0;
  if (wanted.length > 2000)
    throw new MirrorError('REPORT_COLLECTION_LIMIT', 'Narrow the LinkedIn report to at most 2000 campaigns.');
  for (const urn of wanted)
    if (!/^urn:li:sponsoredCampaign:[1-9][0-9]{0,31}$/.test(urn))
      throw new MirrorError('REPORT_SHAPE_CHANGED', 'LinkedIn did not return a native campaign URN.');
  for (let start = 0; start < wanted.length; start += 100) {
    const batch = wanted.slice(start, start + 100),
      data = await read({q: 'search', search: {id: {values: batch}}, pageSize: 100});
    if (
      !object(data) ||
      !Array.isArray(data.elements) ||
      data.elements.length > batch.length ||
      (data.metadata !== undefined && (!object(data.metadata) || data.metadata.nextPageToken)) ||
      data.paging?.links?.some?.((link: JsonObject) => link?.rel === 'next')
    )
      throw new MirrorError('REPORT_INCOMPLETE', 'LinkedIn returned incomplete campaign metadata.');
    for (const element of data.elements) {
      if (!object(element)) throw new MirrorError('REPORT_SHAPE_CHANGED', 'LinkedIn returned malformed campaign metadata.');
      if (element.account !== owner)
        throw new MirrorError(
          'REPORT_ACCOUNT_MISMATCH',
          'LinkedIn returned campaign metadata from another advertising account. The report was not saved.',
        );
      const id =
        typeof element.id === 'number' && Number.isSafeInteger(element.id) && element.id > 0
          ? String(element.id)
          : typeof element.id === 'string' && /^[1-9][0-9]{0,31}$/.test(element.id)
            ? element.id
            : undefined;
      const urn = id && 'urn:li:sponsoredCampaign:' + id;
      // An inexact or unrequested identity is never matched to a reported row.
      if (!urn || !batch.includes(urn) || campaigns[urn]) {
        unmatched++;
        continue;
      }
      campaigns[urn] = {
        name: typeof element.name === 'string' && element.name.length <= 1000 ? element.name : null,
        objective_type:
          typeof element.objectiveType === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(element.objectiveType)
            ? element.objectiveType
            : null,
      };
    }
  }
  return {campaigns, unmatched};
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

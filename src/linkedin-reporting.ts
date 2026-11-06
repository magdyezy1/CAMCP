import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {linkedinVersion} from './linkedin-version.js';
import {parseProviderDecimal} from './provider-decimal.js';

// LinkedIn Reporting and Metrics Available, li-lms-2026-09, checked 2026-10-01:
// adAnalytics has no pagination, a 15,000-element ceiling, and UTC inclusive dates.
// A missing paging.total is normal. Empty data does not distinguish no activity from denied reporting access.
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
export const linkedInElementCap = 15000;
const incompleteMessage =
  'LinkedIn analytics is incomplete or at its response limit. Narrow the date window; this endpoint cannot be paginated.';
export function linkedInAnalyticsRows(value: unknown, allowCap = false): JsonObject[] {
  if (!object(value) || !Array.isArray(value.elements))
    throw new MirrorError('REPORT_SHAPE_CHANGED', 'LinkedIn did not return an analytics row collection.');
  const rows = value.elements,
    p = value.paging;
  if (
    (!allowCap && rows.length >= linkedInElementCap) ||
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
    throw new MirrorError('REPORT_INCOMPLETE', incompleteMessage);
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
  const oldest = linkedInCreativeOldestDay(now);
  if (since < oldest || until > today)
    throw new MirrorError(
      'INVALID_DATE_RANGE',
      'LinkedIn daily evidence must be within the current month and previous five calendar months, through today in UTC.',
    );
}

export const linkedInCreativeOldestDay = (now: Date): string =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1)).toISOString().slice(0, 10);
export const linkedInSingleDayCapWarning =
  'LinkedIn returned 15,000 rows for one day, its response limit; rows beyond it are missing.';
export const linkedInSplitBudgetWarning = 'LinkedIn’s split request limit was reached; some periods are missing.';
export const linkedInRetainedRowsWarning =
  'AMCP retained the first 10,000 LinkedIn entities; entities beyond that bound are missing.';
export const linkedInSplitCoverageWarning =
  'LinkedIn did not return every entity in every split period; totals for those entities are unknown.';
export const linkedInSplitMetricsWarning =
  'LinkedIn metrics without an additive rule are unavailable after splitting the window.';
export const linkedInSplitReachWarning = 'LinkedIn’s 15,000-row limit split this window, so reach is unavailable.';
const additiveFields = new Set([
  'impressions',
  'clicks',
  'costInLocalCurrency',
  'landingPageClicks',
  'videoViews',
  'videoCompletions',
  'oneClickLeads',
  'qualifiedLeads',
  'externalWebsiteConversions',
  'externalWebsitePostClickConversions',
  'externalWebsitePostViewConversions',
  'talentLeads',
  'conversionValueInLocalCurrency',
  'likes',
  'comments',
  'shares',
  'sends',
]);
/** A count the provider states as zero, however it spells it ("0", 0, "0.0"); a missing or unreadable count is not zero. */
const statesZero = (value: unknown) =>
  (typeof value === 'number' || typeof value === 'string') && /^0+(?:\.0+)?$/.test(String(value).trim());
/**
 * D3: LinkedIn leaves the cost out of a row that states zero impressions and zero clicks, which then counts as zero
 * spend (marked omitted_as_zero); any other absent cost stays unknown. Every reader applies this one rule.
 */
export const linkedInCostOmitted = (row: JsonObject): boolean =>
  row.costInLocalCurrency === undefined && statesZero(row.impressions) && statesZero(row.clicks);
const decimalText = (value: bigint) => {
  const fraction = (value % 1000000000n).toString().padStart(9, '0').replace(/0+$/, '');
  return (value / 1000000000n).toString() + (fraction ? '.' + fraction : '');
};
/** The Overview can subdivide a capped window; evidence captures still call the strict reader above. */
export async function linkedInSplitRead(
  range: {since: string; until: string},
  read: (r: {since: string; until: string}) => Promise<JsonObject[]>,
  budget = 32,
): Promise<{
  rows: JsonObject[];
  split: boolean;
  partial: string | null;
  rounding?: Record<string, number>;
  limited?: boolean;
  unavailable?: boolean;
}> {
  const pending = [range],
    grouped = new Map<string, {row: JsonObject; count: number; fields: Map<string, {sum: bigint; known: number}>}>(),
    rounding: Record<string, number> = {};
  let used = 0,
    leaves = 0,
    split = false,
    limited = false,
    unavailable = false,
    partial: string | null = null;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > 32)
    throw new MirrorError('INVALID_ARGUMENT', 'LinkedIn split requests need a budget from 1 to 32.');
  while (pending.length) {
    const r = pending.shift()!;
    used++;
    const rows = await read(r),
      days = (Date.parse(r.until) - Date.parse(r.since)) / 86400000 + 1;
    if (!Array.isArray(rows) || rows.some(row => !object(row)))
      throw new MirrorError('REPORT_SHAPE_CHANGED', 'LinkedIn did not return an analytics row collection.');
    if (rows.length >= linkedInElementCap) {
      if (days <= 1) partial ??= linkedInSingleDayCapWarning;
      // Reserve one read for every pending half before spending two more on this half.
      else if (used + pending.length + 2 > budget) partial = linkedInSplitBudgetWarning;
      else {
        split = true;
        const middle = Date.parse(r.since) + Math.floor(days / 2) * 86400000;
        pending.push(
          {since: r.since, until: new Date(middle - 86400000).toISOString().slice(0, 10)},
          {since: new Date(middle).toISOString().slice(0, 10), until: r.until},
        );
        continue;
      }
    }
    if (!split) {
      limited = rows.length > 10000;
      return {rows: rows.slice(0, 10000), split, partial, ...(limited ? {limited} : {})};
    }
    leaves++;
    const seen = new Set<string>();
    for (const row of rows) {
      if (!Array.isArray(row.pivotValues) || row.pivotValues.length !== 1 || typeof row.pivotValues[0] !== 'string')
        throw new MirrorError('REPORT_SHAPE_CHANGED', 'LinkedIn did not return the requested native entity pivot.');
      const key = row.pivotValues[0];
      if (seen.has(key))
        throw new MirrorError(
          'REPORT_DUPLICATE_ROWS',
          'LinkedIn returned duplicate campaign totals for the requested period.',
        );
      seen.add(key);
      let group = grouped.get(key);
      if (!group) {
        if (grouped.size >= 10000) {
          limited = true;
          continue;
        }
        group = {row: {pivotValues: row.pivotValues}, count: 0, fields: new Map()};
        grouped.set(key, group);
      }
      group.count++;
      const costOmitted = linkedInCostOmitted(row);
      if (costOmitted) group.row.omitted_as_zero = ['spend'];
      for (const field of new Set([...Object.keys(row), ...(costOmitted ? ['costInLocalCurrency'] : [])])) {
        if (['pivotValues', 'dateRange', 'omitted_as_zero'].includes(field)) continue;
        if (!additiveFields.has(field)) {
          group.row[field] = null;
          if (field !== 'approximateMemberReach') unavailable = true;
          continue;
        }
        const sum = group.fields.get(field) ?? {sum: 0n, known: 0};
        group.fields.set(field, sum);
        const value = costOmitted && field === 'costInLocalCurrency' ? '0' : row[field];
        if (value === null || value === undefined || value === '' || value === '--') continue;
        const parsed = parseProviderDecimal(typeof value === 'string' ? value.trim() : value, {field});
        sum.sum += parsed.scaled;
        sum.known++;
        if (parsed.rounded) rounding[field] = (rounding[field] ?? 0) + 1;
      }
    }
  }
  // A window that reached the cap, yet whose every part came back empty, is a contradictory answer, not an empty report.
  if (!grouped.size) throw new MirrorError('REPORT_INCOMPLETE', incompleteMessage);
  const nativeDate = (s: string) => {
    const [year, month, day] = s.split('-').map(Number);
    return {year, month, day};
  };
  const rows = [...grouped.values()].map(group => {
    const out: JsonObject = {
      ...group.row,
      dateRange: {start: nativeDate(range.since), end: nativeDate(range.until)},
      approximateMemberReach: null,
    };
    if (group.count !== leaves) partial ??= linkedInSplitCoverageWarning;
    for (const [field, total] of group.fields) out[field] = total.known === leaves ? decimalText(total.sum) : null;
    return out;
  });
  return {rows, split, partial, rounding, limited, unavailable};
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
  overviewV4 = false,
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
      if (!object(element))
        throw new MirrorError('REPORT_SHAPE_CHANGED', 'LinkedIn returned malformed campaign metadata.');
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
        if (overviewV4) throw new MirrorError('REPORT_INCOMPLETE', 'LinkedIn returned incomplete campaign metadata.');
        unmatched++;
        continue;
      }
      campaigns[urn] = {
        name: typeof element.name === 'string' && element.name.length <= 1000 ? element.name : null,
        objective_type:
          typeof element.objectiveType === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(element.objectiveType)
            ? element.objectiveType
            : null,
        campaign_group:
          typeof element.campaignGroup === 'string' &&
          /^urn:li:sponsoredCampaignGroup:[1-9][0-9]{0,31}$/.test(element.campaignGroup)
            ? element.campaignGroup
            : null,
        ...(overviewV4
          ? {
              campaign_type:
                typeof element.type === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(element.type) ? element.type : null,
              status:
                typeof element.status === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(element.status)
                  ? element.status
                  : null,
            }
          : {}),
      };
    }
  }
  return {campaigns, unmatched};
}

/** Current metadata of reported groups, from the account-owned search finder (li-lms-2026-10). */
export async function linkedInCampaignGroupMetadata(
  account: string,
  urns: string[],
  read: (plan: CompiledRequest) => Promise<JsonObject>,
): Promise<Record<string, {name: string | null; objective_type: string | null; status: string | null}>> {
  const wanted = [...new Set(urns)],
    groups: Record<string, {name: string | null; objective_type: string | null; status: string | null}> = {};
  if (wanted.length > 2000)
    throw new MirrorError('REPORT_COLLECTION_LIMIT', 'Narrow the LinkedIn report to at most 2000 campaign groups.');
  for (const urn of wanted)
    if (!/^urn:li:sponsoredCampaignGroup:[1-9][0-9]{0,31}$/.test(urn))
      throw new MirrorError('REPORT_SHAPE_CHANGED', 'LinkedIn did not return a native campaign group URN.');
  for (let start = 0; start < wanted.length; start += 100) {
    const batch = wanted.slice(start, start + 100),
      data = await read({
        gateway: 'linkedin_native_action',
        accountId: account,
        action: 'AMCP_CAMPAIGN_REPORT',
        method: 'GET',
        path: '/rest/adAccounts/' + account + '/adCampaignGroups',
        query: {q: 'search', search: {id: {values: batch}}, pageSize: 100},
        headers: {'LinkedIn-Version': linkedinVersion(), 'X-Restli-Protocol-Version': '2.0.0'},
        readOnly: true,
        destructive: false,
        requiresConfirmation: false,
        evidence: 'Native campaign report, bounded account scope',
        warnings: [],
      });
    if (
      !object(data) ||
      !Array.isArray(data.elements) ||
      data.elements.length > batch.length ||
      (data.metadata !== undefined && (!object(data.metadata) || data.metadata.nextPageToken)) ||
      data.paging?.links?.some?.((link: JsonObject) => link?.rel === 'next')
    )
      throw new MirrorError('REPORT_INCOMPLETE', 'LinkedIn returned incomplete campaign group metadata.');
    for (const element of data.elements) {
      if (!object(element))
        throw new MirrorError('REPORT_SHAPE_CHANGED', 'LinkedIn returned malformed campaign group metadata.');
      if (element.account !== 'urn:li:sponsoredAccount:' + account)
        throw new MirrorError(
          'REPORT_ACCOUNT_MISMATCH',
          'LinkedIn returned campaign group metadata from another advertising account. The report was not saved.',
        );
      const id =
        typeof element.id === 'number' && Number.isSafeInteger(element.id) && element.id > 0
          ? String(element.id)
          : typeof element.id === 'string' && /^[1-9][0-9]{0,31}$/.test(element.id)
            ? element.id
            : undefined;
      const urn = id && 'urn:li:sponsoredCampaignGroup:' + id;
      if (!urn || !batch.includes(urn) || Object.hasOwn(groups, urn))
        throw new MirrorError(
          'REPORT_SHAPE_CHANGED',
          'LinkedIn returned unrequested or repeated campaign group metadata.',
        );
      groups[urn] = {
        name:
          typeof element.name === 'string' && element.name.length > 0 && element.name.length <= 1000
            ? element.name
            : null,
        objective_type:
          typeof element.objectiveType === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(element.objectiveType)
            ? element.objectiveType
            : null,
        status:
          typeof element.status === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(element.status) ? element.status : null,
      };
    }
  }
  return groups;
}

/**
 * ALL grain must describe exactly the requested period, including older requests the provider may round. An empty
 * response is ambiguous (no activity, or no reporting access), unless `allowEmpty`: a part of a window that already
 * proved access by reaching the response cap.
 */
export function linkedInCampaignPeriod(
  value: unknown,
  range: {since: string; until: string},
  pivot = 'CAMPAIGN',
  allowCap = false,
  allowEmpty = false,
): JsonObject[] {
  const rows = linkedInAnalyticsRows(value, allowCap),
    seen = new Set<string>();
  if (!rows.length && !allowEmpty)
    throw new MirrorError(
      'REPORT_EMPTY_AMBIGUOUS',
      'LinkedIn returned no rows for {from}–{to}. Check that the account delivered in those dates.',
      {},
      400,
      false,
      {from: range.since, to: range.until},
    );
  for (const row of rows) {
    if (
      !object(row) ||
      !Array.isArray(row.pivotValues) ||
      row.pivotValues.length !== 1 ||
      typeof row.pivotValues[0] !== 'string' ||
      !new RegExp(
        '^urn:li:' +
          (
            {
              CAMPAIGN_GROUP: 'sponsoredCampaignGroup',
              CAMPAIGN: 'sponsoredCampaign',
              CREATIVE: 'sponsoredCreative',
            } as Record<string, string>
          )[pivot] +
          ':[1-9][0-9]{0,31}$',
      ).test(row.pivotValues[0])
    ) {
      if (pivot === 'CAMPAIGN')
        throw new MirrorError('REPORT_SHAPE_CHANGED', 'LinkedIn did not return a single native campaign pivot.');
      throw new MirrorError('REPORT_SHAPE_CHANGED', 'LinkedIn did not return the requested native entity pivot.');
    }
    if (
      linkedInReportDate(row.dateRange?.start) !== range.since ||
      linkedInReportDate(row.dateRange?.end) !== range.until
    )
      throw new MirrorError(
        'REPORT_DATE_MISMATCH',
        'LinkedIn returned dates {first}–{last} for {from}–{to}. With whole-period rows LinkedIn rounds dates older than six months to whole months; choose whole calendar months or a recent window.',
        {},
        400,
        false,
        {
          first: linkedInReportDate(row.dateRange?.start),
          last: linkedInReportDate(row.dateRange?.end),
          from: range.since,
          to: range.until,
        },
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

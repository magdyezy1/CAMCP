import {MirrorError} from './errors.js';
import {sha256, stable} from './security.js';
import {parseProviderDecimal} from './provider-decimal.js';
import type {CompiledRequest, JsonObject} from './types.js';

const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const incomplete = (message: string): never => {
  throw new MirrorError('REPORT_INCOMPLETE', message, {}, 502);
};
export const tiktokIntegratedReport = (plan: CompiledRequest) =>
  plan.gateway === 'tiktok_native_action' && plan.method === 'GET' && plan.path === '/v1.3/report/integrated/get/';

export type TikTokPageRule =
  | 'page_info_missing'
  | 'page_not_echoed'
  | 'total_not_integer'
  | 'page_longer_than_size'
  | 'more_rows_than_declared'
  | 'total_changed'
  | 'duplicate_tuple'
  | 'fewer_rows_than_declared'
  | 'total_page_basis_mismatch'
  | 'totals_mismatch'
  | 'empty_report';
export interface TikTokPageFacts {
  page: number | null;
  page_size: number | null;
  total_number: number | null;
  total_page: number | null;
  list_length: number;
  rule: TikTokPageRule;
}
export interface TikTokPage {
  rows: JsonObject[];
  total: number;
  pages: number;
  facts: TikTokPageFacts | null;
}
export const tiktokPageCountMessage = 'TikTok returned missing or inconsistent native report page counts.';
export const tiktokTotalsMismatchMessage = 'TikTok’s totals differ from the rows returned.';
export const tiktokTotalsMatchWarning =
  'TikTok’s page counts disagreed with its rows; its totals match, so the collection is complete.';
export const tiktokTotalsGapTemplate = 'TikTok’s totals differ from the rows returned: {gaps}.';

/** Native counts bound collection; a short page alone does not prove that the whole report is incomplete. */
export function tiktokPageCheck(
  data: unknown,
  request: {page: number; size: number},
  seen: {total: number | null; returned: number},
): TikTokPage {
  if (!object(data) || !Array.isArray(data.list))
    return incomplete('TikTok returned partial or unknown report completion metadata.');
  const rows = data.list as JsonObject[],
    info = object(data.page_info) ? data.page_info : {},
    integer = (value: unknown): number | null => (Number.isSafeInteger(value) ? (value as number) : null),
    facts = (rule: TikTokPageRule): TikTokPageFacts => ({
      page: integer(info.page),
      page_size: integer(info.page_size),
      total_number: integer(info.total_number),
      total_page: integer(info.total_page),
      list_length: rows.length,
      rule,
    }),
    refuse = (rule: TikTokPageRule): never => {
      throw new MirrorError('REPORT_INCOMPLETE', tiktokPageCountMessage, {page_facts: facts(rule)}, 502);
    };
  // TikTok documents no values for an empty report (wave-5 provider documentation, T3), so the first page of a
  // collection with no rows whose counts say there is nothing (total absent or 0, pages absent, 0 or 1) is an empty
  // report whatever its page and page_size say: absent, zero or another integer. Rows, a total above zero, several
  // declared pages, or page fields that are not integers are not defaulted: they still have to echo the request.
  const optionalCount = (value: unknown) =>
      value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0),
    emptyReport =
      seen.total === null &&
      seen.returned === 0 &&
      rows.length === 0 &&
      (data.page_info === undefined || object(data.page_info)) &&
      (info.total_number === undefined || info.total_number === 0) &&
      (info.total_page === undefined || info.total_page === 0 || info.total_page === 1) &&
      optionalCount(info.page) &&
      optionalCount(info.page_size);
  if (!emptyReport && !object(data.page_info)) refuse('page_info_missing');
  if (
    !Number.isSafeInteger(request.page) ||
    request.page < 1 ||
    !Number.isSafeInteger(request.size) ||
    request.size < 1 ||
    (!emptyReport && (info.page !== request.page || info.page_size !== request.size))
  )
    refuse('page_not_echoed');
  for (const key of ['total_number', 'total_page'])
    if (info[key] !== undefined && (!Number.isSafeInteger(info[key]) || info[key] < 0)) refuse('total_not_integer');
  if (info.total_number === undefined && rows.length) refuse('total_not_integer');
  const total = info.total_number ?? 0,
    expectedPages = Math.ceil(total / request.size),
    pages = info.total_page ?? expectedPages;
  if (rows.length > request.size) refuse('page_longer_than_size');
  if (seen.total !== null && seen.total !== total) refuse('total_changed');
  if (seen.returned + rows.length > total) refuse('more_rows_than_declared');
  return {
    rows,
    total,
    pages,
    facts: total === 0 ? facts('empty_report') : pages !== expectedPages ? facts('total_page_basis_mismatch') : null,
  };
}
/** Compatibility wrapper for readers that also need the requested page and size. */
export function tiktokReportPageData(
  data: JsonObject,
  page: number,
  size: number,
  seen: {total: number | null; returned: number} = {total: null, returned: 0},
) {
  return {...tiktokPageCheck(data, {page, size}, seen), page, size};
}
export function tiktokCollectionCounts(declared: number, returned: number): {complete: boolean; warning?: string} {
  return returned === declared
    ? {complete: true}
    : {
        complete: false,
        warning:
          'TikTok declared ' +
          declared.toLocaleString('en-US') +
          ' rows and returned ' +
          returned.toLocaleString('en-US') +
          '.',
      };
}

/** Unavailable totals fall back to counts; native decimal text is compared without floating-point sums. */
export function tiktokTotalsCheck(
  rows: JsonObject[],
  totals: unknown,
  metrics: readonly string[],
): {verdict: 'match' | 'gap' | 'absent'; gaps: {metric: string; rows: string; total: string}[]} {
  const gaps: {metric: string; rows: string; total: string}[] = [];
  if (!object(totals)) return {verdict: 'absent', gaps};
  const value = (raw: unknown): bigint | null => {
    if (raw === null || raw === undefined || raw === '-') return null;
    try {
      return parseProviderDecimal(raw, {field: 'TikTok report total'}).scaled;
    } catch (error) {
      if (error instanceof MirrorError && ['REPORT_SHAPE_CHANGED', 'METRIC_PRECISION_LOSS'].includes(error.code))
        return null;
      throw error;
    }
  };
  const formatted = (units: bigint, money: boolean) => {
    if (money) {
      const cents = (units + 5000000n) / 10000000n;
      return (cents / 100n).toLocaleString('en-US') + '.' + (cents % 100n).toString().padStart(2, '0');
    }
    const fraction = (units % 1000000000n).toString().padStart(9, '0').replace(/0+$/, '');
    return (units / 1000000000n).toLocaleString('en-US') + (fraction ? '.' + fraction : '');
  };
  let compared = 0;
  for (const metric of new Set(metrics)) {
    if (!['spend', 'impressions', 'clicks', 'conversion'].includes(metric)) continue;
    const nativeTotal = value(totals[metric]);
    if (nativeTotal === null) continue;
    let sum = 0n,
      available = true;
    for (const row of rows) {
      const native = value(row.metrics?.[metric]);
      if (native === null) {
        available = false;
        break;
      }
      sum += native;
    }
    if (!available) continue;
    compared++;
    const difference = sum > nativeTotal ? sum - nativeTotal : nativeTotal - sum;
    // Spend is money, and a row's spend and the total are decimal text that TikTok rounds on its own (the rounding is
    // not documented), so each returned row may drift from the total by up to half a cent: the tolerance is 0.005 per
    // row, inclusive (the plan's rule, round 1 Task 5). It grows with the rows, so with 4,000 rows a missing 20.00 stays
    // inside it. That is accepted: impressions, clicks and conversions are counts without rounding and must match
    // exactly, and a real missing row moves them. The currency's own minor unit is not consulted.
    if (difference > (metric === 'spend' ? 5000000n * BigInt(rows.length) : 0n))
      gaps.push({metric, rows: formatted(sum, metric === 'spend'), total: formatted(nativeTotal, metric === 'spend')});
  }
  return {verdict: compared === 0 ? 'absent' : gaps.length ? 'gap' : 'match', gaps};
}

/** Both report paths apply the same completeness decision to each requested native window. */
export function tiktokCollectionCheck(
  rows: JsonObject[],
  declared: number,
  totals: unknown,
  metrics: readonly string[],
) {
  const counts = tiktokCollectionCounts(declared, rows.length),
    checked = tiktokTotalsCheck(rows, totals, metrics),
    // D2: whenever the rows fall short of the declared count the reader sees both counts, beside the totals sentence.
    short = counts.warning ? [counts.warning] : [];
  if (checked.verdict === 'match')
    return {
      complete: true,
      warnings: counts.complete ? [] : [tiktokTotalsMatchWarning, ...short],
      totals: checked.verdict,
    };
  if (checked.verdict === 'gap')
    return {
      complete: false,
      warnings: [
        tiktokTotalsGapTemplate.replace(
          '{gaps}',
          checked.gaps.map(gap => gap.metric + ' ' + gap.rows + ' of ' + gap.total).join('; '),
        ),
        ...short,
      ],
      totals: checked.verdict,
    };
  return {complete: counts.complete, warnings: short, totals: checked.verdict};
}
export function tiktokReportPage(
  response: unknown,
  query: JsonObject,
  seen: {total: number | null; returned: number} = {total: null, returned: 0},
) {
  if (
    !object(response) ||
    response.code !== 0 ||
    !object(response.data) ||
    [response, response.data].some(
      v =>
        v.error ||
        v.errors ||
        v.truncated ||
        ['next_cursor', 'next_page_token', 'nextPageToken', 'next', 'has_more', 'hasMore', 'paging', 'pagination'].some(
          key => v[key] !== undefined,
        ),
    )
  )
    return incomplete('TikTok returned partial or unknown report completion metadata.');
  return tiktokReportPageData(response.data, query.page ?? 1, query.page_size ?? 10, seen);
}
/** A requested native dimensional tuple, not its metric values, identifies a reporting row. */
export function tiktokReportGrain(query: JsonObject) {
  let dimensions = query.dimensions;
  if (typeof dimensions === 'string') {
    try {
      dimensions = JSON.parse(dimensions);
    } catch {
      dimensions = undefined;
    }
  }
  if (
    !Array.isArray(dimensions) ||
    !dimensions.length ||
    dimensions.some(v => typeof v !== 'string' || !v) ||
    new Set(dimensions).size !== dimensions.length
  )
    throw new MirrorError('REPORT_SHAPE_CHANGED', 'TikTok aggregation requires explicit unique native dimensions.');
  return [...dimensions].sort() as string[];
}
export function tiktokReportRowKey(row: unknown, dimensions: string[]) {
  if (
    !object(row) ||
    !object(row.dimensions) ||
    !object(row.metrics) ||
    Object.keys(row.dimensions).length !== dimensions.length ||
    dimensions.some(
      k =>
        !Object.hasOwn(row.dimensions, k) ||
        (row.dimensions[k] !== null &&
          typeof row.dimensions[k] !== 'string' &&
          !Number.isSafeInteger(row.dimensions[k])),
    )
  )
    throw new MirrorError('REPORT_SHAPE_CHANGED', 'TikTok returned a different or malformed native dimensional grain.');
  return sha256(stable(dimensions.map(key => (row.dimensions[key] === null ? null : String(row.dimensions[key])))));
}

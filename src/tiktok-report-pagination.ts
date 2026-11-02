import {MirrorError} from './errors.js';
import {sha256, stable} from './security.js';
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
  if (!object(data.page_info)) refuse('page_info_missing');
  if (
    !Number.isSafeInteger(request.page) ||
    request.page < 1 ||
    !Number.isSafeInteger(request.size) ||
    request.size < 1 ||
    info.page !== request.page ||
    info.page_size !== request.size
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

import type {CompiledRequest, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {stable} from './security.js';
import {linkedInAnalyticsRows} from './linkedin-reporting.js';
import {
  tiktokIntegratedReport,
  tiktokReportPage,
  tiktokReportGrain,
  tiktokReportRowKey,
} from './tiktok-report-pagination.js';
const obj = (v: unknown): JsonObject => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {});
export function nextPage(plan: CompiledRequest, response: unknown): CompiledRequest | null {
  const d = obj(response),
    data = obj(d.data);
  const next = structuredClone(plan);
  if (
    plan.gateway === 'apple_ads_native_action' &&
    plan.origin === 'https://api.ads.apple.com' &&
    plan.path.endsWith('/query')
  ) {
    const pagination = obj(d.pagination),
      body = obj(plan.body),
      requested = obj(body.pagination);
    const rows = Array.isArray(d.result) ? d.result : obj(d.result).rows;
    if (!Array.isArray(rows))
      throw new MirrorError('UNKNOWN_PAGINATION', 'Apple query response is missing its row collection.');
    const offset = requested.offset ?? 0,
      size = requested.pageSize ?? 100,
      total = pagination.totalCount;
    if (
      (pagination.offset !== undefined && pagination.offset !== offset) ||
      (pagination.pageSize !== undefined && (!Number.isSafeInteger(pagination.pageSize) || pagination.pageSize < 0)) ||
      (total !== undefined && (!Number.isSafeInteger(total) || total < 0)) ||
      rows.length > size
    )
      throw new MirrorError('UNKNOWN_PAGINATION', 'Apple returned inconsistent pagination metadata.');
    if ((total !== undefined && offset + rows.length >= total) || (total === undefined && rows.length < size))
      return null;
    if (!rows.length)
      throw new MirrorError('UNKNOWN_PAGINATION', 'Apple returned an empty page before its reported total.');
    next.body = {...body, pagination: {...requested, offset: offset + rows.length}};
    return next;
  }
  if (plan.gateway === 'meta_native_action') {
    if (!d.paging?.next) return null;
    const cursor = d.paging?.cursors?.after;
    if (!cursor) throw new MirrorError('UNKNOWN_PAGINATION', 'Meta advertises another page but supplies no cursor.');
    next.query.after = cursor;
    return next;
  }
  if (plan.gateway === 'tiktok_native_action') {
    if (tiktokIntegratedReport(plan)) {
      const page = tiktokReportPage(response, plan.query);
      if (page.page >= page.pages) return null;
      next.query.page = page.page + 1;
      return next;
    }
    const info = data.page_info ?? d.page_info;
    if (!info || Number(info.page) >= Number(info.total_page)) return null;
    next.query.page = Number(info.page) + 1;
    return next;
  }
  if (plan.gateway === 'snapchat_native_action') {
    const link = d.paging?.next_link ?? d.paging?.next;
    if (!link) return null;
    const url = new URL(link, 'https://adsapi.snapchat.com');
    if (url.origin !== 'https://adsapi.snapchat.com' || url.pathname !== plan.path)
      throw new MirrorError('UNSAFE_PAGINATION_LINK', 'Pagination link changed upstream scope.');
    const paginationKeys = new Set(['cursor', 'offset', 'page', 'page_token']);
    for (const [key, value] of url.searchParams) {
      if (paginationKeys.has(key)) {
        next.query[key] = value;
        continue;
      }
      const original = plan.query[key];
      if (original === undefined || String(original) !== value)
        throw new MirrorError('UNSAFE_PAGINATION_LINK', 'Pagination link changed account scope or report filters.', {
          parameter: key,
        });
    }
    // The server may omit invariant filters from its link; retain them verbatim.
    return next;
  }
  if (plan.gateway === 'x_ads_native_action') {
    const cursor = d.next_cursor ?? data.next_cursor;
    if (!cursor || cursor === '0') return null;
    next.query.cursor = cursor;
    return next;
  }
  if (plan.gateway === 'reddit_native_action') {
    const link = d.pagination?.next_url;
    if (!link) return null;
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      throw new MirrorError('UNSAFE_PAGINATION_LINK', 'Reddit pagination must supply a valid absolute URL.');
    }
    if (
      url.origin !== 'https://ads-api.reddit.com' ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== plan.path
    )
      throw new MirrorError('UNSAFE_PAGINATION_LINK', 'Reddit pagination changed upstream scope.');
    const keys = new Set<string>();
    for (const [key, value] of url.searchParams) {
      if (keys.has(key))
        throw new MirrorError('UNSAFE_PAGINATION_LINK', 'Reddit pagination contains duplicate parameters.');
      keys.add(key);
      if (key === 'page.token') {
        next.query[key] = value;
        continue;
      }
      if (plan.query[key] === undefined || String(plan.query[key]) !== value)
        throw new MirrorError(
          'UNSAFE_PAGINATION_LINK',
          'Reddit pagination changed account scope, page size or report filters.',
          {parameter: key},
        );
    }
    if (!keys.has('page.token'))
      throw new MirrorError('UNKNOWN_PAGINATION', 'Reddit supplied a next URL without a page token.');
    return next;
  }
  if (plan.gateway === 'linkedin_native_action') {
    if (plan.path === '/rest/adAnalytics') {
      linkedInAnalyticsRows(response);
      return null;
    }
    // Search and criteria finders page by cursor: the next page's pageToken is metadata.nextPageToken, and a page
    // without one is the last (Microsoft Learn, "Create and Manage Creatives", li-lms-2026-05). Older finders page by
    // start and count against paging.total.
    const token = obj(d.metadata).nextPageToken;
    if (token !== undefined && token !== null && (typeof token !== 'string' || !token))
      throw new MirrorError('UNKNOWN_PAGINATION', 'LinkedIn returned a malformed page cursor.');
    if (typeof token === 'string') {
      if (plan.query.start !== undefined)
        throw new MirrorError('UNKNOWN_PAGINATION', 'LinkedIn returned a page cursor for a read paged by offset.');
      next.query.pageToken = token;
      return next;
    }
    if (plan.query.pageSize !== undefined || plan.query.pageToken !== undefined) return null;
    const paging = d.paging;
    if (!paging || Number(paging.start) + Number(paging.count) >= Number(paging.total)) return null;
    next.query.start = Number(paging.start) + Number(paging.count);
    return next;
  }
  const token = d.nextPageToken ?? d.next_page_token ?? d.nextToken ?? data.nextToken;
  if (token) {
    const key =
      d.nextToken !== undefined || data.nextToken !== undefined
        ? 'nextToken'
        : plan.gateway === 'google_ads_native_action'
          ? 'page_token'
          : 'pageToken';
    if (plan.method === 'POST') next.body = {...obj(plan.body), [key]: token};
    else next.query[key] = token;
    return next;
  }
  return null;
}
function arraySlots(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return [prefix];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) =>
    Array.isArray(v) ? [prefix + '/' + k] : k === 'data' || k === 'result' ? arraySlots(v, prefix + '/' + k) : [],
  );
}
function at(root: any, path: string) {
  return path
    ? path
        .slice(1)
        .split('/')
        .reduce((v, k) => v?.[k], root)
    : root;
}
function put(root: any, path: string, value: any) {
  const parts = path.slice(1).split('/');
  const key = parts.pop()!;
  const parent = parts.reduce((v, k) => v[k], root);
  parent[key] = value;
}
export async function paginate(
  plan: CompiledRequest,
  fetchPage: (plan: CompiledRequest) => Promise<unknown>,
  maxPages = 25,
): Promise<{data: unknown; pages: number; truncated: boolean}> {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100)
    throw new MirrorError('INVALID_PAGE_LIMIT', 'max_pages must be between 1 and 100.');
  const tiktok = tiktokIntegratedReport(plan),
    dimensions = tiktok ? tiktokReportGrain(plan.query) : [],
    nativeRows = new Set<string>();
  if (tiktok && (plan.query.page ?? 1) !== 1)
    throw new MirrorError('REPORT_INCOMPLETE', 'Start a complete TikTok report collection at page one.');
  let expectedTotal: number | undefined;
  const verify = (request: CompiledRequest, response: unknown) => {
    if (!tiktok) return;
    const page = tiktokReportPage(response, request.query);
    if (expectedTotal !== undefined && page.total !== expectedTotal)
      throw new MirrorError('REPORT_INCOMPLETE', 'TikTok report counts changed during collection. Capture again.');
    expectedTotal = page.total;
    for (const row of page.rows) {
      const key = tiktokReportRowKey(row, dimensions);
      if (nativeRows.has(key))
        throw new MirrorError('REPORT_DUPLICATE_ROWS', 'TikTok repeated a native reporting dimension tuple.');
      nativeRows.add(key);
    }
  };
  const first = await fetchPage(plan);
  verify(plan, first);
  let merged = structuredClone(first);
  let current = plan;
  let response = first;
  let pages = 1;
  const seen = new Set([stable({path: plan.path, query: plan.query, body: plan.body})]);
  const slots = arraySlots(first);
  while (true) {
    const next = nextPage(current, response);
    if (!next) return {data: merged, pages, truncated: false};
    if (pages >= maxPages) return {data: merged, pages, truncated: true};
    const key = stable({path: next.path, query: next.query, body: next.body});
    if (seen.has(key)) throw new MirrorError('PAGINATION_LOOP', 'Platform repeated a page cursor.');
    seen.add(key);
    response = await fetchPage(next);
    verify(next, response);
    pages++;
    if (arraySlots(response).join('|') !== slots.join('|'))
      throw new MirrorError(
        'PAGINATION_SHAPE_CHANGED',
        'Row collections changed between pages; refusing to return a partial successful result.',
      );
    for (const slot of slots) {
      const a = at(merged, slot),
        b = at(response, slot);
      if (Array.isArray(a) && Array.isArray(b)) {
        if (slot === '') merged = [...a, ...b];
        else put(merged, slot, [...a, ...b]);
      }
    }
    current = next;
    if (Buffer.byteLength(JSON.stringify(merged)) > 64 * 1024 * 1024)
      throw new MirrorError('AGGREGATE_TOO_LARGE', 'Aggregated data exceeds 64 MiB; split the query.');
  }
}

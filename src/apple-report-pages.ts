import {MirrorError} from './errors.js';
import type {ReportCollection} from './report-source.js';
import type {JsonObject} from './types.js';

export const appleOrigin = 'https://api.ads.apple.com';

/**
 * What one Apple report or entity query reads, from Apple's own pages (docs/records/APPLE-ADS-PLATFORM-PINS-2026-11-06.md).
 * A report page holds at most 5000 rows and the campaign query at most 1000, so a page of 1000 is inside both. Ten such
 * pages hold the most rows a report keeps; the 25 pages bound the lists a server serves in shorter pages, and the
 * `IN` filter takes the largest list of IDs the report ever needs for one read (Apple states no limit for it).
 */
export const appleQueryBounds = Object.freeze({
  page_size: 1000,
  pages: 25,
  rows: 10000,
  ids_per_query: 1000,
  /** Campaigns whose ad group or ad reports one period reads, each as a report of its own. */
  campaigns: 100,
});

/** Apple IDs are JSON numbers; only safe integers can be requested and matched exactly. */
export const appleSafeId = (id: string) => /^[1-9][0-9]{0,15}$/.test(id) && Number.isSafeInteger(Number(id));

/** What the list holds, as a refusal names it. */
export type AppleList = 'campaigns' | 'ad groups' | 'ads';
export interface AppleQuery {
  /** A report pages by `offset` and `pageSize` and always states its total; an entity query states one when asked. */
  kind: 'report' | 'entities';
  list: AppleList;
  path: string;
  action: string;
  stage: string;
  /** The request body but its pagination, which the pages own. */
  body: JsonObject;
}

const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
function refuse(code: string, message: string, status: number, list: AppleList): never {
  throw new MirrorError(code, message, {}, status, false, {kind: list});
}
const tooMany = (list: AppleList): never =>
  refuse(
    'REPORT_COLLECTION_LIMIT',
    'Apple reported more than 10,000 {kind}, the most a report reads. Narrow the date range or scope the report by campaign IDs.',
    422,
    list,
  );
const inconsistent = (list: AppleList): never =>
  refuse(
    'REPORT_INCOMPLETE',
    'Apple returned inconsistent pagination while listing {kind}, so the list cannot be proven complete.',
    502,
    list,
  );

/**
 * One Apple list read to its end: the pages of a report or an entity query, each one provider request, bounded in pages
 * and rows and never shortened. Apple's pages show `pagination` beside `result`, with `totalCount` as its total; its
 * `pageSize` is the size asked in every endpoint example but the rows returned in QueryPaginationResult's, so it decides
 * nothing here. The next page starts at the rows received, the list ends when they reach the total (or, when none is
 * given, at an empty page), and a total that changes, an empty page before it, rows past it or an echo of another offset
 * refuses the whole list. `limit` is how many rows the caller can still take (a report's rows across its campaigns).
 */
export async function appleQueryPages(
  c: Pick<ReportCollection, 'run' | 'plan'>,
  query: AppleQuery,
  limit: number = appleQueryBounds.rows,
): Promise<{rows: JsonObject[]; pages: number; total: number | null}> {
  const rows: JsonObject[] = [];
  let total: number | undefined;
  for (let page = 1; page <= appleQueryBounds.pages; page++) {
    const offset = rows.length,
      data = await c.run(
        {
          ...c.plan(
            query.path,
            {},
            {
              ...query.body,
              pagination: {
                offset,
                pageSize: appleQueryBounds.page_size,
                ...(query.kind === 'entities' ? {fetchTotalCount: true} : {}),
              },
            },
            appleOrigin,
          ),
          action: query.action,
        },
        false,
        query.stage,
      );
    const listed = query.kind === 'report' ? (object(data.result) ? data.result.rows : undefined) : data.result;
    if (!Array.isArray(listed) || listed.some(row => !object(row)))
      refuse('REPORT_SHAPE_CHANGED', 'Apple returned {kind} in a shape AMCP cannot read.', 502, query.list);
    const info = data.pagination ?? {};
    if (
      !object(info) ||
      listed.length > appleQueryBounds.page_size ||
      (info.offset !== undefined && info.offset !== offset) ||
      (info.pageSize !== undefined && !(Number.isSafeInteger(info.pageSize) && info.pageSize >= 0)) ||
      (info.totalCount !== undefined && !(Number.isSafeInteger(info.totalCount) && info.totalCount >= 0))
    )
      inconsistent(query.list);
    if (info.totalCount === undefined ? total !== undefined : total !== undefined && info.totalCount !== total)
      refuse(
        'REPORT_INCOMPLETE',
        'Apple changed the total it reported for {kind} while the list was read, so the list cannot be proven complete.',
        502,
        query.list,
      );
    if (info.totalCount !== undefined) {
      const stated: number = info.totalCount;
      total = stated;
      if (stated > limit) tooMany(query.list);
    }
    rows.push(...(listed as JsonObject[]));
    if (rows.length > limit) tooMany(query.list);
    if (total === undefined) {
      if (!listed.length) return {rows, pages: page, total: null};
    } else if (rows.length > total) inconsistent(query.list);
    else if (rows.length === total) return {rows, pages: page, total};
    else if (!listed.length)
      refuse(
        'REPORT_INCOMPLETE',
        'Apple returned an empty page before the total it reported for {kind}, so the list cannot be proven complete.',
        502,
        query.list,
      );
  }
  return refuse(
    'REPORT_INCOMPLETE',
    'Apple listed {kind} over more than 25 pages, the most a report reads, so the list cannot be proven complete.',
    502,
    query.list,
  );
}
